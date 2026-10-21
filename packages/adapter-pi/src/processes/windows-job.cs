using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

// Launch suspended, assign before any user code runs, and never permit breakaway.
// The helper exclusively owns the job handle: helper death closes it and kills the tree.
public static class CorralOwnedJob {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  struct Startup {
    public int cb; public string reserved, desktop, title;
    public uint x, y, width, height, charsX, charsY, fill, flags;
    public ushort show, reservedSize; public IntPtr reservedBytes, stdin, stdout, stderr;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct ProcessInfo { public IntPtr process, thread; public uint pid, tid; }
  [StructLayout(LayoutKind.Sequential)]
  struct Limits {
    public long processTime, jobTime; public uint flags;
    public UIntPtr minWorkingSet, maxWorkingSet; public uint activeLimit;
    public UIntPtr affinity; public uint priority, scheduling;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct Io { public ulong reads, writes, other, readBytes, writeBytes, otherBytes; }
  [StructLayout(LayoutKind.Sequential)]
  struct ExtendedLimits {
    public Limits basic; public Io io;
    public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct Accounting {
    public long user, kernel, periodUser, periodKernel;
    public uint pageFaults, total, active, terminated;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct TcpRow {
    public uint state, localAddress, localPort, remoteAddress, remotePort, pid;
  }
  [DllImport("iphlpapi.dll", SetLastError=true)]
  static extern uint GetExtendedTcpTable(IntPtr table, ref uint size, bool order, uint family, uint kind, uint reserved);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits info, uint size);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, uint size, IntPtr length);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes,
    IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string cwd,
    ref Startup startup, out ProcessInfo process);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int which);
  [DllImport("kernel32.dll")] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);

  static string Quote(string value) {
    var result = new StringBuilder("\"");
    int slashes = 0;
    foreach (char ch in value) {
      if (ch == '\\') { slashes++; continue; }
      if (ch == '"') { result.Append('\\', slashes * 2 + 1); result.Append(ch); slashes = 0; continue; }
      result.Append('\\', slashes); slashes = 0; result.Append(ch);
    }
    result.Append('\\', slashes * 2); result.Append('"'); return result.ToString();
  }

  static int Port(uint networkPort) {
    return (int)(((networkPort & 255) << 8) | ((networkPort >> 8) & 255));
  }
  static bool OwnsConnection(IntPtr job, int port, int peerPort) {
    uint size = 0;
    GetExtendedTcpTable(IntPtr.Zero, ref size, false, 2, 5, 0);
    for (int retry = 0; retry < 3 && size > 0 && size < 4194304; retry++) {
      IntPtr buffer = Marshal.AllocHGlobal((int)size);
      try {
        uint result = GetExtendedTcpTable(buffer, ref size, false, 2, 5, 0);
        if (result == 122) continue;
        if (result != 0) return false;
        int count = Marshal.ReadInt32(buffer);
        int stride = Marshal.SizeOf(typeof(TcpRow));
        if (count < 0 || 4L + (long)count * stride > size) return false;
        for (int i = 0; i < count; i++) {
          var row = (TcpRow)Marshal.PtrToStructure(IntPtr.Add(buffer, 4 + i * stride), typeof(TcpRow));
          // Attest an already-established loopback connection, not a reusable listener port.
          if (row.state != 5 || row.localAddress != 0x0100007f ||
              row.remoteAddress != 0x0100007f || Port(row.localPort) != port ||
              Port(row.remotePort) != peerPort) continue;
          IntPtr process = OpenProcess(0x00101000, false, row.pid);
          if (process == IntPtr.Zero) continue;
          try {
            bool member;
            if (WaitForSingleObject(process, 0) == 258 &&
                IsProcessInJob(process, job, out member) && member &&
                WaitForSingleObject(process, 0) == 258) return true;
          } finally { CloseHandle(process); }
        }
        return false;
      } finally { Marshal.FreeHGlobal(buffer); }
    }
    return false;
  }
  static void ConnectionQuery(IntPtr job, string status) {
    try {
      string query = status + ".query";
      if (!File.Exists(query)) return;
      string[] fields = File.ReadAllText(query).Split('|');
      File.Delete(query);
      if (fields.Length != 3 || !System.Text.RegularExpressions.Regex.IsMatch(fields[0], "^[a-f0-9]{32}$")) return;
      int port, peerPort;
      if (!Int32.TryParse(fields[1], out port) || !Int32.TryParse(fields[2], out peerPort) ||
          port < 1 || port > 65535 || peerPort < 1 || peerPort > 65535) return;
      bool owned = OwnsConnection(job, port, peerPort);
      File.WriteAllText(status + ".connection",
        "{\"nonce\":\"" + fields[0] + "\",\"owned\":" + (owned ? "true" : "false") + "}");
    } catch { /* Missing or racing queries fail closed at the caller deadline. */ }
  }

  public static int Run(string executable, string[] args, string cwd, string status, uint ownerPid, long ownerCreationTime) {
    IntPtr job = IntPtr.Zero;
    IntPtr owner = IntPtr.Zero;
    ProcessInfo process = new ProcessInfo();
    bool assigned = false, confirmed = false;
    uint exit = 1;
    try {
      // Hold a kernel handle, not a reusable numeric PID, for the lifetime of ownership.
      owner = OpenProcess(0x00101000, false, ownerPid);
      if (owner == IntPtr.Zero || WaitForSingleObject(owner, 0) != 258)
        throw new InvalidOperationException("Process owner is unavailable");
      long created, exited, kernel, user;
      if (!GetProcessTimes(owner, out created, out exited, out kernel, out user) ||
          created != ownerCreationTime)
        throw new InvalidOperationException("Process owner identity changed");
      if (File.Exists(status + ".stop")) { confirmed = true; return 1; }
      job = CreateJobObject(IntPtr.Zero, null);
      if (job == IntPtr.Zero) throw new InvalidOperationException("Job creation failed");
      var limits = new ExtendedLimits();
      limits.basic.flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
      if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits)))
        throw new InvalidOperationException("Job limits failed");
      var startup = new Startup();
      startup.cb = Marshal.SizeOf(startup);
      startup.flags = 0x100;
      bool commandPrompt = String.Equals(Path.GetFileName(executable), "cmd.exe", StringComparison.OrdinalIgnoreCase);
      // CMD needs its own hidden console for a UTF-8 code page. CREATE_NO_WINDOW
      // supplies no console; chcp can then succeed without changing redirected OEM output.
      if (commandPrompt) { startup.flags |= 1; startup.show = 0; }
      startup.stdin = GetStdHandle(-10);
      startup.stdout = GetStdHandle(-11);
      startup.stderr = GetStdHandle(-12);
      // Streams pass through unchanged, including bidirectional JSON-RPC stdin.
      // The private control file is distinct from the application's protocol.
      if (!SetHandleInformation(startup.stdin, 1, 1) ||
            !SetHandleInformation(startup.stdout, 1, 1) ||
            !SetHandleInformation(startup.stderr, 1, 1))
          throw new InvalidOperationException("Process stream setup failed");
      var command = new StringBuilder(Quote(executable));
      if (commandPrompt &&
          args.Length == 4 && args[0] == "/d" && args[1] == "/s" && args[2] == "/c") {
        // cmd parses the /c tail itself; C-runtime backslash escaping corrupts quoted paths.
        command.Append(" /d /s /c \"").Append(args[3]).Append("\"");
      } else {
        foreach (string arg in args) command.Append(" ").Append(Quote(arg));
      }
      if (!CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, true,
            0x4 | (commandPrompt ? 0x10u : 0x08000000u), IntPtr.Zero, cwd, ref startup, out process))
          throw new InvalidOperationException("Process creation failed");
      if (!AssignProcessToJobObject(job, process.process))
        throw new InvalidOperationException("Process ownership failed");
      assigned = true;
      if (File.Exists(status + ".stop")) TerminateJobObject(job, 1);
      else if (ResumeThread(process.thread) == 0xffffffff)
        throw new InvalidOperationException("Process resume failed");
      else File.WriteAllText(status + ".started", process.pid.ToString());
      while (WaitForSingleObject(process.process, 50) == 258) {
        ConnectionQuery(job, status);
        if (File.Exists(status + ".stop") || WaitForSingleObject(owner, 0) != 258) {
          TerminateJobObject(job, 1); break;
        }
      }
      // A successfully exited leader can leave descendants behind. They still belong to us.
      TerminateJobObject(job, 1);
      for (int i = 0; i < 100; i++) {
        Accounting accounting;
        if (!QueryInformationJobObject(job, 1, out accounting,
            (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero)) break;
        if (accounting.active == 0) { confirmed = true; break; }
        Thread.Sleep(30);
      }
      GetExitCodeProcess(process.process, out exit);
    } catch {
      // Failure before assignment must also terminate the suspended child.
      if (!assigned && process.process != IntPtr.Zero) TerminateProcess(process.process, 1);
      if (job != IntPtr.Zero) TerminateJobObject(job, 1);
      throw;
    } finally {
      if (process.thread != IntPtr.Zero) CloseHandle(process.thread);
      if (process.process != IntPtr.Zero) CloseHandle(process.process);
      if (job != IntPtr.Zero) CloseHandle(job);
      if (owner != IntPtr.Zero) CloseHandle(owner);
      File.WriteAllText(status, "{\"cleanupConfirmed\":" +
        (confirmed ? "true" : "false") + ",\"exitCode\":" + exit + "}");
    }
    return unchecked((int)exit);
  }
}

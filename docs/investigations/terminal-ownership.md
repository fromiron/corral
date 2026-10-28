# Terminal ownership investigation

## Scope and result

Issue #121 reports a terminal that became uncertain immediately after creation, with no output and unconfirmed cleanup. This investigation does not claim reproduction of that original host event or resolution of every uncertain terminal. The original process identity and host diagnostics were not available.

A deterministic counterexample in `apps/server/test/pty-runtime.test.ts` reproduces the same durable protection when PTY creation succeeds but process-identity capture throws. The launch path then attempts to kill the child, but cannot prove that the whole OS session is gone. The operation and writer stay uncertain. Explicit Stop and a fresh runtime loaded from the receipt preserve that ownership. This is a demonstrated code path, not proof that it caused the original incident.

The UI distinguishes active terminal ownership, uncertain terminal termination and another Run. Structured owner ID, session ID and state travel through the command receipt, HTTP error and saved session entry, so the uncertain guidance survives reopening without deriving its cause from English text. Legacy records without structured diagnostics retain their original fallback. The controls link opens the owning session and terminal; an unsuccessful Stop attempt remains explicit. Diagnostic details preserve the original error and owner ID. The code no longer replaces a known cleanup error with an unconditional assertion that the host stopped.

## Verified boundaries

- Injected identity-capture failure: one spawn, one kill attempt, no unproven cleanup or writer release; a new writer remains refused after Stop and simulated restart.
- Injected active/uncertain admission through the actual HTTP server: structured ownership survives a rejected start and session-entry persistence, without invoking Stop or starting a Run.
- Identified uncertain processes: the existing explicit cleanup/reconciliation test releases only after cleanup confirms success. Repeating creation never spawns a replacement process.
- Linux PTY integration: actual shell writes remain in the disposable working copy; fixed readers retain their prior snapshot; original files remain unchanged. Leaderless background job groups are cleaned up with ownership checks.
- Linux Chromium keyboard burst: an actual pre-dispatch 429 preserves 1,106 ASCII payload characters in order, resumes subsequent input, and keeps the terminal usable. UTF-8 frame merging is tested separately at the queue boundary; native IME input is not claimed. The running tab indicator disappears after Stop, and stopped-output guidance remains correct after a server restart.
- Linux Chromium with the real local server and PTY: create a working copy, start `sleep 120`, reject a conversation request, open terminal controls, explicitly stop, and resend successfully with scripted model responses. Active Run preflight and post-Run terminal availability are covered in the same focused browser regression.

## Remaining uncertainty

The synchronous capture failure is injectable; its original OS-level trigger has not been reproduced. PID reuse, unreadable process records and missing ownership proof remain protected. No blind release, automatic force cleanup, or deletion workaround was added. A terminal without a captured identity can still require host-level investigation; reconnecting the browser cannot provide missing identity evidence.

Sidebar/project attention cannot infer live ownership from a historical refused request: it would stay blocked after a successful Stop. An authoritative live ownership aggregate is outside this bounded investigation. Original-event recurrence, actual host reboot, non-Linux cleanup, installed desktop builds and paid model providers were not tested.

# Corral native process implementation evidence

Date: 2026-10-20 (Asia/Tokyo). Environment: Windows x64, Node 24.19.0, the changing `feat/desktop-capabilities` working tree. This records implementation and executed checks, not production or cross-platform certification.

## Implemented path

`run_command` passes through the Coordinator permission/effect path, then `WorkspaceService.planCommand/runCommand`. The broker pins the managed worktree, current Git tree, canonical directory identity, selected shell executable bytes, arguments, environment template and command text. It rechecks that identity under the operation mutex immediately before recording and starting the operation. Trusted repository and active writer reservation are required; the Coordinator additionally enforces trusted-native, role and review-only restrictions.

The command runs in the real managed worktree. Its post-command tree is recorded and changes are marked as observed external changes, rather than fabricated file-broker writes. Operation identity and result are persisted in `command_operations`. Duplicate requests return the existing operation. Restart converts unfinished operations to uncertain; it does not replay commands or acquire termination authority from a reused numeric PID.

Service mode returns a running receipt after native startup is observed. It retains the Run's writer reservation while releasing the operation mutex, allowing the same Run to edit and rebuild. Pause, cancellation and terminal Run transitions await service cleanup. A cancellation epoch blocks launches that were still waiting for the operation mutex. Services in this implementation last at most for their owning Run; retaining one beyond the Run requires an additional explicit product flow.

The session file panel displays command text, running/history state, exit code, bounded output and cleanup confirmation. The stop action reads the server's resulting report. Clicking stop is not itself evidence of termination.

## OS ownership

On Windows, the reviewed PowerShell/C# helper creates the target suspended, assigns it to a Job Object before resuming it, does not permit breakaway, and sets kill-on-job-close. It confirms zero active Job processes before reporting cleanup. The parent pins its kernel creation FILETIME while alive; the helper verifies that creation identity before using the parent HANDLE. This also covers PID reuse while the helper is compiling. The original HANDLE then controls host-death cleanup. Helper death closes the Job handle and terminates its children; absence of its final accounting report remains unconfirmed.

PowerShell, pwsh, CMD and Git Bash were exercised on this Windows host. CMD source uses a private UTF-8 batch and hidden console; model/tool descriptions specify batch syntax. The separate `.cmd`/`.bat` launcher preserves literal arguments for ordinary npm/pnpm-style forwarding shims. It rejects argument forms that cannot be represented safely instead of interpolating them as command syntax. Native executables keep their ordinary argv path.

For service previews, the proxy first connects without sending request bytes. Windows ownership attestation matches the established loopback TCP connection, then checks the owning process's kernel handle against the exact Job. Trust is not inferred from a listener port number or parent PID. Linux has a `/proc` socket-inode/process-group check; that branch was not executed on this Windows host. macOS connection attestation remains unavailable and fails closed.

**Trust boundary:** these are ownership and cleanup controls for Corral-managed commands, checks, language servers, MCP servers and browser trees. They are not an OS filesystem/network sandbox. Arbitrary trusted-native extension code can access Node APIs outside these managed helpers. Host capacity reservations do not prove that such unmanaged extension descendants are Job-owned. Strict and trusted-native remain distinct.

## Executed evidence

These batches overlap and must not be added into a claimed total:

| Checks | Observed result |
|---|---|
| `process-runtime.test.ts` + `command-broker.test.ts` | 11 passed after service-mode integration: real mutation/diff, approval and stale-plan refusal, deduplication/restart, cancellation, descendants, helper/host crash, established connection ownership, service editing and stop/start race |
| `verification-runner.test.ts` | 7 passed, including a real timeout with `cleanupConfirmed: true`; cancellation waits for bounded native startup cleanup |
| `process-runtime-capacity.test.ts` | 8 passed: startup reserves capacity, duplicates consume no extra slot, confirmed termination releases and uncertainty retains |
| Initial shared host gate + `lsp-transport.test.ts` | 2 shared-gate and 11 LSP checks passed; subsequent SDK/MCP IPC expansion has separate final integration evidence |
| Canonical SDK/MCP host-capacity expansion | 6 real checks passed: the host and two SDK workers share twelve execution-group slots; foreign releases and duplicate grants cannot free another reservation; unknown cleanup remains busy and confirmed normal closure becomes idle |
| `windows-command.test.ts` | 6 real Windows checks passed: installed `npx.cmd --version`, `.cmd`/`.bat` forwarding, literal quotes/metacharacters/percent/Unicode, absent injection marker, native multiline arguments and raw multiline CMD; every launched Job confirmed cleanup |
| Final native owner/argv regression batch | `process-owner-identity.test.ts`, `process-runtime.test.ts`, `windows-command.test.ts`: 14 passed after the parent creation-identity guard. A matching PID with an incorrect creation identity did not start the target. |
| Cold combined native regression after source freeze | 13 files, **64 passed / 3 platform skips**, 108.54 seconds with `--maxWorkers=2`. Includes command broker/runtime, both capacity layers, owner identity, LSP, registered checks, project clone/materials, preview, browser, Windows argv and SDK/MCP IPC capacity. No helper source changed during this batch. |
| Full file-broker and Auto-baseline regression | `files.test.ts` + `auto-baseline.test.ts`: **47 passed**, 95.81 seconds with `--maxWorkers=2`, starting 2026-10-20 23:59:53 JST. Includes real LSP scope/pinning, 52-checkpoint retention, original/index preservation, check approval, cancellation and file-write evidence. |
| SDK and parent-question lifecycle regression | `sdk-adapter.test.ts`, `parent-question.test.ts`, `pending-tool-exit.test.ts`, `channel-lifecycle.test.ts`, `codemode-lifecycle.test.ts`: **76 passed**, 8.47 seconds with `--maxWorkers=2`, starting 2026-10-21 00:40:23 JST. Includes both native MCP success/error results and empty durable-worker leases after settlement. |
| Installed-shell Unicode regression | PowerShell, pwsh, CMD and Git Bash emitted Korean text, executed a script path containing spaces and preserved exit code 9 |
| OAuth HTTP MCP probe and real worker regressions | 15 passed, 4 platform skips; a concurrent capacity change required updating the separate channel lifecycle unit fixture to model asynchronous absence readback |

The OAuth probe failure was a real Windows shutdown bug: authorization and tool discovery completed, but immediate `process.exit(0)` during HTTP/IPC teardown triggered a native libuv assertion and exit `0xC0000409`. Normal completion now flushes the final frame, disconnects the IPC channel and lets close callbacks drain, with an unreferenced bounded exit guard for lingering trusted-extension timers. The host still requires a normal exit and confirmed cleanup. Temporary stage/error diagnostics used to isolate the problem were removed.

The file-broker rerun corrected two test-budget mismatches without changing product deadlines or assertions: the file's outer integration limit was five seconds despite multi-process Git/checkpoint operations, and its real Windows LSP fixture allowed only one second including native helper startup. The fixture now allows ten seconds and the file uses a bounded thirty-second outer limit. The unchanged 52-checkpoint test took 9.91 seconds; the automatic-check case took 5.52 seconds. Both LSP cases reached their intended pinned-result/scope assertions. The earlier hunk teardown `EPERM` followed a test timeout while asynchronous Git work could still hold its working directory; it did not recur when the same full suite completed normally. No cleanup retries or production process changes were used to suppress that failure.

The final broad regression also reached the SDK native-MCP test's five-second outer limit, followed by temporary-directory `EPERM`. That test sequentially probes one real MCP process, executes another through the SDK, and confirms both cleanup cycles; each protocol phase independently allows five seconds. Only this test's outer limit was changed to twenty seconds. Both protocol limits, error-result assertions and empty durable-worker checks remain unchanged. Isolated measurements completed the success/error variants in 2.50/1.99 seconds, so the broad-run delay was not reproduced and no pending-RPC defect was established. The five-file lifecycle rerun above passed without teardown errors; the adapter queue and production process code were not changed for this correction.

The final browser E2E, latest desktop packaging identity, canonical host-wide SDK/MCP capacity checks and `.cmd` compatibility results belong in the central [implementation record](../evaluation/Desktop-Capabilities-Implementation-Progress.md). Earlier package checks do not certify helper assets changed later.

An earlier broad run started at 23:29:27 while the native helper's configuration/signature was still changing. Its native startup failures are retained as a failed intermediate-artifact result; the cold frozen-source batch above is the applicable native regression verdict. Other failures in that broad run, such as CLI signal semantics or independent model availability, are not reclassified by the native batch.

Native source SHA-256 read after the cold batch (`packages/adapter-pi/src/processes/`):

| Source | SHA-256 |
|---|---|
| `windows-job.cs` | `1cdd326f22d425880c8f4d3dc545c29ca1b2b2254d7c32601479d8a87d8f8124` |
| `windows-job.ps1` | `8a0bcdb0135ae321939228b1fda75328dd73a9b4b7142668dc428fbe24748002` |
| `owned-process.ts` | `7194af83954fcaa8a7a84cf3c37f44ac7e1458c40354d7d08b6beda597b9796c` |
| `windows-command.ts` | `88d0cbc72a51262f2954d14483de83fdf6747a0839a659ce40e16b48f58da981` |

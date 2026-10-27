# Terminal ownership investigation

## Scope and result

Issue #121 reports a terminal that became uncertain immediately after creation, with no output and unconfirmed cleanup. This investigation does not claim reproduction of that original host event or resolution of every uncertain terminal. The original process identity and host diagnostics were not available.

A deterministic counterexample in `apps/server/test/pty-runtime.test.ts` reproduces the same durable protection when PTY creation succeeds but process-identity capture throws. The launch path then attempts to kill the child, but cannot prove that the whole OS session is gone. The operation and writer stay uncertain. Explicit Stop and a fresh runtime loaded from the receipt preserve that ownership. This is a demonstrated code path, not proof that it caused the original incident.

The UI now distinguishes terminal ownership from another Run, links to that terminal, and reports an unsuccessful Stop attempt. Diagnostic details preserve the original error and owner ID. The code no longer replaces a known cleanup error with an unconditional assertion that the host stopped.

## Verified boundaries

- Injected identity-capture failure: one spawn, one kill attempt, no unproven cleanup or writer release; a new writer remains refused after Stop and simulated restart.
- Identified uncertain processes: the existing explicit cleanup/reconciliation test releases only after cleanup confirms success. Repeating creation never spawns a replacement process.
- Linux PTY integration: actual shell writes remain in the disposable working copy; fixed readers retain their prior snapshot; original files remain unchanged. Leaderless background job groups are cleaned up with ownership checks.
- Linux Chromium with the real local server and PTY: create a working copy, start `sleep 120`, reject a conversation request, open terminal controls, explicitly stop, and resend successfully with scripted model responses. Active Run preflight and post-Run terminal availability are covered in the same focused browser regression.

## Remaining uncertainty

The synchronous capture failure is injectable; its original OS-level trigger has not been reproduced. PID reuse, unreadable process records and missing ownership proof remain protected. No blind release, automatic force cleanup, or deletion workaround was added. A terminal without a captured identity can still require host-level investigation; reconnecting the browser cannot provide missing identity evidence.

Sidebar/project attention cannot infer live ownership from a historical refused request: it would stay blocked after a successful Stop. An authoritative live ownership aggregate is outside this bounded investigation. Original-event recurrence, actual host reboot, non-Linux cleanup, installed desktop builds and paid model providers were not tested.

# PI-Desktop runtime port

Derived from vastsa/pi-desktop, commit 1a812ed7b84e0bd1b117080eb4e51c76eba35d48, LGPL version 3. Original copyright notices and LGPL terms apply.

Sources: packages/agent-runtime/src/stream-coalescer.ts, context-budget.ts, request-usage.ts, fixed-tool-declarations.ts, session-affinity.ts; packages/shared/src/message-stream.ts.

Corral changes: use Pi stream events instead of UI envelopes, reconstruct text/thinking/tool arguments at the receiver, bound buffered deltas, inject time/IDs, and connect policy and accounting through the host. Source files in src/ are the corresponding modified sources. No Cordis, Electron or Rust runtime is imported.

The server loads this package separately from its installed `@corral/pi-runtime-port` directory. Studio includes the environment-neutral budget module in its browser bundle. Desktop preparation compiles deployed TypeScript to JavaScript and places the complete application source, modified library source, lockfile, patches and build scripts under `runtime/corresponding-source/corral`; `manifest.json` records the source checksums. The browser bundle can therefore be rebuilt with a modified library. The server library can also be replaced with an interface-compatible JavaScript build.

Use Node 24.19.0 and pnpm 10.30.3. From the corresponding-source directory, initialize a local Git index if needed (`git init`, `git add .`), install with `pnpm install --frozen-lockfile`, install `tools/requirements.txt` in a Python environment and set `CORRAL_PYTHON` to that interpreter, then run `pnpm --filter @corral/studio build` and `pnpm --filter @corral/desktop prepare:runtime`. `pnpm --filter @corral/desktop package` builds an installer for the current platform. These steps include modified application/library sources without requiring access to the original developer's checkout. Modifications and reverse engineering for debugging this library are permitted. See LICENSE (LGPLv3), COPYING (GPLv3), and PORTING.md.

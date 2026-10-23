# Workbench terminal engines

Selected under CR-046 / ADR-040 for the existing host/Studio split. Registry stable tags and exact installed types were checked on 2026-10-21; no beta package was selected.

| Package | Exact version | License and copied notice | Owner / runtime |
|---|---|---|---|
| node-pty | 1.1.0 | MIT, `node-pty-LICENSE` | Microsoft, server/bundled Node sidecar only |
| @xterm/xterm | 6.0.0 | MIT, `xterm-LICENSE` | xterm.js maintainers, browser renderer |
| @xterm/addon-fit | 0.11.0 | MIT, `xterm-addon-fit-LICENSE` | xterm.js maintainers, browser geometry addon |

- Exact registry integrity, publication dates, engines/peer facts and consumers are in `docs/dependency-lock.json`. None declares a Node or React peer range. xterm and addon-fit were published from upstream commit `f447274f430fd22513f6adbf9862d19524471c04`.
- node-pty depends on node-addon-api 7.x (lock resolves 7.1.1). On this Linux x64 host the package builds with Node 24.19.0; its reviewed install scripts are allowed only for node-pty@1.1.0. Existing blocked dependency scripts remain blocked. Electron's `npmRebuild:false` is retained, because the sidecar uses the bundled Node instead of Electron's Node ABI.
- The Linux native binding is small relative to the 64.36 MB npm package, which also contains other platform binaries. Package size and actual installed load costs are separate facts; final runtime/package sizes belong in execution evidence. xterm's unpacked package is 5.92 MB; addon-fit 20.7 KB.
- Installed public entries: node-pty `lib/index.js` / `typings/node-pty.d.ts`; xterm `lib/xterm.mjs`, `typings/xterm.d.ts`, `css/xterm.css`; addon-fit `lib/addon-fit.mjs` / `typings/addon-fit.d.ts`. No headless, serialize, clipboard or web-links addon is added.
- The registry advisory query for these exact packages and node-addon-api 7.1.1 returned no known advisory on 2026-10-21. This is a dependency inventory, not a security guarantee.
- A PTY inherits host permissions; choosing a working-copy cwd is not a filesystem sandbox. Terminal content and OSC are untrusted. xterm 6 adds OSC52 support, so the consumer must explicitly control clipboard and link behavior; a terminal must not automatically execute URLs or commands.
- Linux native loading, shell input, 101x37 resize and exit are checked from the physical deployed server by `apps/desktop/scripts/check-runtime.mjs`. Non-Linux execution and installed-window behavior require their own platform evidence; Linux success does not establish them.

Official sources:

- https://github.com/microsoft/node-pty/blob/v1.1.0/README.md
- https://github.com/xtermjs/xterm.js/releases/tag/6.0.0
- https://xtermjs.org/docs/guides/using-addons/
- https://xtermjs.org/docs/guides/security/
- https://pnpm.io/10.x/settings#onlybuiltdependencies

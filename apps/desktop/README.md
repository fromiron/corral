# Corral desktop (Linux x64)

The desktop host serves Studio from its bundled loopback server. Renderer Node integration is
disabled; the isolated preload exposes only the named window, folder, workspace and HTTP(S)
link operations. The server, SQLite module, Pi child processes and ONNX worker all use the
bundled Node 24.19.0 runtime rather than Electron's Node ABI.

Build with Node **24.19.0** and pnpm **10.30.3**:

```sh
pnpm install
node apps/desktop/node_modules/electron/install.js
pnpm --filter @corral/studio build
pnpm --filter @corral/desktop prepare:runtime
pnpm --filter @corral/desktop dev
pnpm --filter @corral/desktop package
```

The AppImage is written to `apps/desktop/release/`. `prepare:runtime` deploys production server
dependencies, compiles the internal TypeScript exports and worker URLs, carries their assets
and licenses, and checks native module loading with the bundled Node. Source manifests must
remain byte-for-byte unchanged; deployment copies can otherwise share hard-linked inodes.
Electron's installer downloads its official binary; other dependency lifecycle scripts remain
blocked by the repository's pnpm policy.

Run the isolated smoke workflow with host Node and package managers removed from the app's `PATH`:

```sh
pnpm --filter @corral/desktop exec node scripts/smoke.ts
pnpm --filter @corral/desktop exec node scripts/smoke.ts release/Corral-0.1.0-x86_64.AppImage
```

The test creates temporary app data and runs a simulated team. It checks SQLite history,
route/draft/theme restoration, single-instance behavior, both active-run quit decisions,
server and renderer process failure/recovery, failed-startup retry, and opening an existing
workspace. Native dialogs use deterministic test answers; the actual app lifecycle is exercised. It never uses a person's
workspace, model credentials or paid model calls. An AppImage may need FUSE 2; environments
without FUSE can use its standard `--appimage-extract-and-run` mode.

The normal app workspace starts under Electron's per-user app data directory. Settings can
open an existing workspace explicitly; changing it does not copy, move or delete existing
data. There is one desktop instance per app data directory and a separate server ownership
lock per workspace. Active runs require confirmation before quit or workspace changes.
Interrupted runs are not resumed automatically. Git and the executables in user-configured
verification commands are installed separately.

This first artifact targets Linux x64. Windows/macOS, automatic updates, remote hosts and
background execution are outside CR-014.

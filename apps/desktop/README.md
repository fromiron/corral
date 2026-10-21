# Corral desktop

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

Artifacts are written to `apps/desktop/release/`. `prepare:runtime` deploys production server
dependencies offline into a physical hoisted tree, compiles the internal TypeScript exports
and worker URLs, carries their assets
and licenses, and checks native module loading with the bundled Node. Source manifests must
remain byte-for-byte unchanged; deployment copies can otherwise share hard-linked inodes.
Preparation and packaging reject symlinks/junctions so installed apps cannot refer back to
the build directory. Executable shims are used on every OS. Runtime checks verify actual
module/native-library paths and handshakes from both Pi worker implementations.
Electron's installer downloads its official binary; other dependency lifecycle scripts remain
blocked by the repository's pnpm policy.

Package on the target OS and architecture. The builder accepts Windows x64/arm64
(portable EXE and per-user NSIS installer), macOS x64/arm64 (DMG and ZIP), and Linux
x64/arm64 (AppImage). These are build targets, not a statement that every target has been
tested. `prepare:runtime` copies the host Node executable (`node.exe` on Windows), verifies
SQLite and ONNX with that executable, starts the compiled Pi SDK worker, and records OS,
architecture and Node version in `staging/runtime.json`. Packaging rejects a mismatching
host identity instead of shipping native libraries built for another OS.

`pnpm --filter @corral/desktop package --dir` creates an unpacked app for local validation.
The script accepts no cross-build target switches. Signing and notarization require the
release owner's credentials; an unsigned local build is not a signed release.

On Linux, run the existing isolated smoke workflow with host Node and package managers removed
from the app's `PATH`:

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

The native **Background** menu controls closing to tray, keeping the machine awake during
work, and whether paused/input-waiting work should also keep it awake. Closing to tray is
off by default; **Quit** still uses the active-work confirmation. These choices persist in
`desktop.json`. A missing OS tray disables closing to tray so a window cannot become
unreachable. The tray lists current runs from the Coordinator; opening one targets its exact
session/run and cancelling sends the regular revision-checked Coordinator command after
confirmation. Multiple running sessions share one app-suspension blocker, released when no
eligible work remains or on exit.

Shutdown asks the bundled server to finish its cleanup. If cleanup does not complete within
15 seconds, the desktop stays open and reports that fact; it does not kill only a Windows
parent and claim its descendants have stopped.

Updates use pinned `electron-updater` 6.8.9 (MIT), compatible with the existing builder 26
NSIS/AppImage/macOS targets and isolated from the server's Node ABI. It declares no Node or
Electron peer version constraint; desktop checks exercise Electron 44.4.5 and TypeScript.
[Official v26 updater documentation](https://www.electron.build/v26/docs/features/auto-update/)
describes the platform targets, generated metadata and explicit download/install APIs.

No feed is selected by default. A release owner can build against an existing HTTPS feed
with `CORRAL_UPDATE_URL`, optional `CORRAL_UPDATE_CHANNEL` (default `latest`), and, on Windows,
the exact `CORRAL_UPDATE_PUBLISHER` certificate publisher name. The wrapper passes these to
electron-builder's standard publish configuration but always uses `--publish never`.
The owner must sign and upload the release separately. Its update manifest must include
`corralSchemaVersions: ['0.1']` and `corralStorage: { minVersion, maxVersion }` describing the
actual supported SQLite `PRAGMA user_version` range. The sidecar reads the active database
version, and the desktop checks it before download eligibility and again before install.
Missing compatibility metadata is refused; API schema `0.1` alone is not storage compatibility.

Help exposes separate **Check for updates**, **Download**, and **Restart to apply** actions.
Background download, install-on-quit, downgrades and web installers are disabled. The standard
updater verifies download hashes and configured publisher signatures. Portable EXEs do not
offer NSIS updates. Before restarting, native windows stop accepting input, existing
before-unload handlers reject unsaved edits, and the server atomically refuses shutdown if
Run/Auto/scheduled work or a mutation request is in flight. No release feed/account was
supplied for live download/signature/install verification.

After the server has stopped accepting new work, it saves an online SQLite backup and
the workspace configuration under `.corral/update-backups/<id>/`, together with wire and
storage version metadata. A failed backup aborts the restart and restores admission.
**File → Show update backups** opens that directory. Recovery is an operator action:
quit Corral before restoring a compatible database/configuration backup. The updater
does not silently roll back workspace data.

Settings → Shortcuts edits the same command IDs used by the palette and native menu.
Bindings persist per browser/desktop surface; conflicts, reserved editing/OS keys and IME
composition are rejected. Capture temporarily suspends native accelerators. Reset restores
the default table.

Live voice requests microphone access only from the trusted Studio main frame. The native
dialog grants audio capture to that window and origin for its lifetime; camera, embedded
frames, the host manager and previews stay denied. The remote host has its own consent scope.
OS microphone privacy settings still apply. Native test runs use Chromium's synthetic device
rather than recording a person's microphone or opening a paid voice call.

CR-042 verification on Windows (2026-10-21 JST): desktop TypeScript, lint and all 36 desktop
tests pass, including the installed OpenSSH occupied-port/closed-loopback failure check.
Runtime preparation loaded SQLite and ONNX
and received the compiled Pi SDK worker's ready handshake with the bundled Node. The final
unpacked Windows app, with Studio `index-B97zDyHh.js`, passed `node scripts/native-smoke.ts`:
native folder selection/trust and a real Git working copy; UI team/session creation and a
simulated request; isolated interactive preview, script/CSS execution, denied external
navigation and lease revocation; shortcut remapping and reset; the isolated remote-host form;
close to tray and second-instance restoration; and restart with retained history, draft and
preferences. Quit also succeeded with the interactive preview still open. Synthetic audio
consent passed and camera access was denied. The test ran without host Node/pnpm in PATH.
The packaged process helper separately executed its adjacent PowerShell/C# assets, ran a
normal child and confirmed cancellation of both a leader and its grandchild.
These checks were repeated from an independent directory outside the checkout, with spaces
in its path and the staging directory unavailable. All 26,618 packaged runtime files matched
before and after execution, and every loaded native/module path stayed inside that copy.
The final portable EXE also bootstrapped Studio and quit normally with the same extracted
runtime fingerprint. Its extraction is slow here: a 180-second check timed out, and the
next measured attempt reached Studio after 245.5 seconds, including removal of the first
interrupted extraction. Use `release/win-unpacked/corral.exe` for immediate local access.

The local application is unsigned. NSIS installation and macOS runtime validation remain
separate release checks. The older Linux smoke script still contains Linux-specific process
inspection; it is not evidence of Windows testing. The Windows screenshot is
`release/native-smoke-windows.png`. Exact build identity, evidence and remaining limits are
recorded in [the delivery verification report](../../docs/plans/Desktop-Delivery-Verification.md).
Rebuild and rerun this smoke after changes to the bundled sources.

File/app previews opened from Studio use a separate ephemeral `WebContentsView` with no app
preload, Node integration or app cookie storage. The desktop resolves the session/lease through
its private sidecar IPC before opening it; credentials for the preview proxy never cross the
renderer bridge. HTTP and WebSocket requests are restricted to that lease's origin, popups and
device permissions are denied, and revocation or local-server shutdown closes the surface.
This browser boundary is not an OS sandbox for the developer's server process.

**File → Remote hosts…** registers an existing OpenSSH config alias and remote Corral port.
The same port must be free locally to preserve the server's Host/Origin checks. Supply the
remote server's bootstrap link for first authentication; it is redeemed in the isolated
network session and is not saved in the host registry or navigation history. Each registered
host opens in its own storage partition and has no local desktop preload. Removing it clears
that local partition, without deleting anything on the remote host.

Only direct key-authenticated SSH hosts with an already verified host key are supported.
ProxyCommand, ProxyJump, agent forwarding and extra forwarding rules are refused. Disconnecting
does not cancel remote work. No external host was contacted for implementation verification.
Remote previews use short-lived server-issued delegation tokens and forward only the owned
lease's exact loopback port. Tokens renew while the preview is open; expiry, revocation and
disconnect close the preview. The interactive view uses the same isolated browser policy as
local previews.

Pending request/command IDs and validated SSE events/cursors are journaled per host and run.
Reopening a host queries its authoritative receipt before offering an explicit retry; an
unconfirmed mutation is never automatically resubmitted. Real HTTP response-loss/recreation
tests cover this path. A successful connection and preview on an actual remote SSH host remain
unverified because no target host was supplied.

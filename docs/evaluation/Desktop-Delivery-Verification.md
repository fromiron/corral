# Corral desktop delivery verification

Environment: Windows x64, Node 24.19.0, Electron 44.4.5. Working branch:
`feat/desktop-capabilities`. These checks use isolated temporary workspaces. No production
workspace, provider credentials, paid call, external SSH host or release feed was used.

## Current CR-043 renderer refresh

The current Windows artifacts contain `index-DEI0pIX7.js` / `index-CqCuaHxa.css`.
The previous Studio directory and manifests were preserved, only Studio was refreshed,
and the normal `package --dir` followed by prepackaged portable/NSIS build completed.
All 26,212 non-Studio runtime files and `app.asar` remain byte-identical to CR-042.
The renderer's 406 files exactly match the final Studio distribution.

The real packaged Electron app passed the direct-chat flow through its ordinary UI:
Start chat with no saved Corral, send a request, observe a succeeded Run and result, reload,
then Quit and relaunch. Public server readback confirmed `session.corralId: null`, zero
saved Corrals and exactly one succeeded Run. History and an unsent draft survived restart;
both Quit operations closed the server listener and no renderer errors were observed.
The app used the product's explicit simulated model mode; this does not verify a paid
provider or model reasoning quality. Evidence is in `release/native-cr043-proof.json`,
`release/native-cr043-empty-chat.png` and `release/native-cr043-result.png`.

Both new EXEs were opened as archives without executing the installer. Their embedded
`app-64.7z` payloads are identical: 231,218,072 bytes, SHA-256
`eaa71312dd7331bc80793b0aad3dd89406cece76c52453c67a9c0fd0ca94956a`.
After extraction, all 26,690 files from the native-tested app remained byte-identical.
The only addition was the standard NSIS `resources/elevate.exe` helper added by installed
electron-builder's `CopyElevateHelper`. Its 107,520 bytes matched the installed vendor
binary exactly, SHA-256
`9b1fbf0c11c520ae714af8aa9af12cfd48503eedecd7398d8992ee94d1b4dc37`.
This installer helper does not change the tested application files; installation remains
unverified. The initial strict file-count comparison detected this one-file addition
before the explicit vendor-binary comparison passed.

The final unpacked app and extracted payload match across all **26,691 physical files**,
with zero links. The runtime alone contains **26,618 files / 653,980,559 bytes**, SHA-256
`00ae6fbb855e4e0734faf79dfede9801f0ebaa693fdd77723ef811ff74aebe5a`.
The full-app fingerprint is
`961edd5585512893f4b693c20bda9d85c9191e50f6e2173c2fe1bbe821331ed4`.

| Current unsigned artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `Corral-0.1.0-x64-portable.exe` | 231,593,937 | `af5b59ce8f0e4a0c5d097a3177ff435c49f293dc0e87c5dc80c4c0a03e4b8404` |
| `Corral-0.1.0-x64-setup.exe` | 231,837,347 | `5177940551116f160b4b5a3ea3fbe9634d1ec3f607313a23ed685226c809ad14` |

Use `release/win-unpacked/corral.exe` for the directly verified local entry point.
The new portable launcher's self-extraction/bootstrap was **not re-run** and the new NSIS
installer was **not installed**. The older portable bootstrap result below belongs only
to its old EXE hashes. The current native and archive evidence is recorded separately in
`release/delivery-manifest.json`, `release/runtime-files.json` and
`release/archive-cr043-proof.json`. Final process readback found zero packaged Corral
processes and zero owned packaged sidecars; the separate browser QA servers were untouched.
No additional temporary-directory cleanup was attempted.

## Implemented delivery path

- Host-native preparation deploys the production server and native dependencies, compiles
  internal TypeScript/worker exports, includes the Windows Job helper assets and bundles Node.
  Runtime preparation checks SQLite, ONNX and the compiled Pi SDK worker.
- Windows portable and per-user NSIS targets, macOS DMG/ZIP targets and Linux AppImage targets
  are explicit. Packaging refuses another OS/architecture's native runtime.
- Native tray, close-to-tray preferences and one activity-based suspension blocker use
  authoritative Coordinator state. Cancellation uses the current revision and normal command
  path. Unconfirmed cleanup retains ownership.
- Native previews resolve the authoritative lease through private IPC and run in an ephemeral
  WebContentsView partition without app cookies, preload or Node. HTTP/WS access and navigation
  stay within the lease. This is not an OS sandbox for the developer's server.
- Shortcut edits use the existing command IDs, persist per surface and update native menu
  accelerators. Capture/IME and reserved-key/conflict handling remain explicit.
- Updates require an explicitly configured HTTPS channel, compatible wire and SQLite versions
  and verified downloads. Before install, the host checks unsaved edits, gates new mutations,
  waits for idle work and saves a SQLite/configuration backup. No channel was invented.
- Remote hosts use installed OpenSSH, pinned known hosts, separate partitions and normal
  authentication. Preview delegation and response-loss/receipt/SSE recovery remain scoped
  to the original host. No uncertain mutation is automatically replayed.
- Microphone consent is audio-only, main-frame-only and scoped to the trusted local or remote
  Studio window. Preview and host-manager permissions remain denied.

## Findings from native verification

Native preview verification reached the ordinary folder picker, repository trust, working-copy
creation and file panel. The real native view executed its button and root-relative CSS,
had no app preload/cookies, rejected navigation to an unrelated owned loopback listener,
and closed after the Studio lease-close action. Shortcut remapping, the remote-host form,
tray hiding and a real second process restoring the window were also observed.

Opening a WebContentsView exposed a real quit defect: its parent BrowserWindow had never loaded
a document, so the unsaved-edit JavaScript probe never resolved. The host now skips empty
native chrome and bounds probes of loaded windows; an unresponsive loaded window is treated
as unsaved. This keeps the explicit discard/update-refusal behavior.

Review also found a partial-cleanup defect. AsyncDisposableStack forgets a rejected disposal
after it becomes disposed, and its final workspace-lock disposer could release ownership
despite an earlier failure. Cleanup now caches its outcome and releases the actual workspace
lock only after successful disposal. The sidecar quarantines incomplete cleanup and the
desktop displays it rather than reopening a partially disposed server.

The update idle gate also includes pending end snapshots, preparation and worktree leases:
a terminal Run alone does not prove its final checkpoint has finished.

The packaged Windows server runs detached with ignored standard streams. Its Git helper
originally omitted `windowsHide`, and ordinary folder/copy/Run operations stalled or advanced
very slowly in that context. An identical bundled-server reproduction exceeded 40 seconds
with the old helper; changing only `windowsHide: true` completed the same operation and
clean shutdown in about 10 seconds. The real Electron folder-picker/trust/copy/Send flow
then completed its Run in 2.4 seconds and quit cleanly. No worktree lease or execution
semantics were changed.

## CR-042 baseline verification (historical)

Desktop TypeScript and Biome checks pass. All 36 desktop tests across 10 files pass,
including the explicit installed-OpenSSH check against an occupied local forwarding port
and a closed loopback SSH port. That test verifies refusal without fallback; it does not
verify a successful external SSH connection.

The CR-042 eighth Studio bundle was `index-B97zDyHh.js` / `index-P0zuN5FL.css`.
Its unpacked Windows app passed the complete native smoke, serially after runtime preparation:

- Native folder selection, trust, real Git working-copy creation and an ordinary UI request
  reached a succeeded Run with persisted history.
- Synthetic microphone capture was granted after the native consent flow; camera was denied.
- The static iframe remained script-free. The native interactive preview executed its button
  and root-relative CSS, had an empty separate cookie jar and no app preload, rejected an
  unrelated loopback navigation without sending a request, and closed on lease revocation.
- Edited shortcuts updated native accelerators, survived restart and reset to their defaults.
- The remote-host form opened without the local app preload; the bootstrap field was masked.
- Closing to tray retained the host, an actual second app process restored it, and Quit/restart
  retained history, draft and background preferences. Final Quit succeeded with the preview open.

The exact bundled Node/process helper also passed a normal child and leader/grandchild
cancellation, confirmed every owned PID gone and repeated cleanup readback successfully.
Both native checks excluded host Node and package managers from PATH.

An additional artifact inventory then found 672 Windows dependency junctions pointing from
the unpacked app back into the staging directory. The native checks above prove the product
flow with that source, but do not establish standalone delivery. Packaging now uses modern
offline hoisted deployment with physical executable shims and rejects all linked entries
both during preparation and before packaging. The fresh runtime has 26,620 files and zero
links; actual native bindings, 570 loaded modules and both Pi workers pass containment checks.

**Independent-directory verification passed.** The entire app was copied outside the
checkout into a path containing spaces, and staging was moved out of reach for the whole
verification. The copied app passed runtime containment (570 loaded modules, SQLite/ONNX,
both Pi worker handshakes), real Windows process/descendant cleanup and the complete native
UI smoke described above. Staging was restored afterward. The copied runtime retained the
same hash before and after those operations:

`f9205c0da186f1627d037675112b007075f8e467f2757fa1b4a47323fdb8891b`

That manifest covers all **26,618 physical files / 653,974,404 bytes**. The only staging-to-app
differences were two empty third-party test markers omitted by electron-builder:
`server/node_modules/@fastify/ajv-compiler/test/.gitkeep` and
`server/node_modules/@fastify/static/test/static-pre-compressed/empty/.gitkeep`.
Both have zero bytes and SHA-256
`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
They contain no runtime code or data. Unpacked, relocated and final packaged runtime trees
are compared strictly after these two documented staging exclusions.

The verified `resources/app.asar` SHA-256 is
`DA490D227D4292D5AF2FD55FBD76716D625650098C19049AF923D16B2BB3750C`.
The final portable and per-user NSIS artifacts were built successfully from that exact
prepackaged tree. Both are unsigned:

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `Corral-0.1.0-x64-portable.exe` | 231,593,331 | `6562B183876124DA10787FDDAC4665AB74B8248F4568ACCBD6B52F5EA7E8A174` |
| `Corral-0.1.0-x64-setup.exe` | 231,836,744 | `9BCD0097B8EBE5D3514DD4E5ECF7ECF67B6BCABD03267380FAA49E70579385F5` |

The portable's first bounded bootstrap check timed out during self-extraction after
180 seconds, before an Electron child appeared. The launcher was consuming CPU, and no
bootstrap success was inferred.

The longer measurement **passed** with the same EXE: Electron became reachable at
215.951 seconds and Studio was visible at 245.5 seconds. This second attempt also removed
the interrupted first extraction, so it is not a clean first-boot benchmark. The extracted
26,618-file runtime matched the relocated/unpacked fingerprint exactly. Normal native Quit
closed the app PID and server listener; the portable launcher exited 0. Total verification
took 429.966 seconds, including full-tree hashing and shutdown, rather than only app startup.
Server startup and UI assertions were unchanged. Both the initial timeout and final PASS
are retained in `release/delivery-manifest-cr042.json`. These bootstrap outcomes apply
only to the CR-042 EXE hashes in the table above.

Use the verified unpacked `release/win-unpacked/corral.exe` for immediate local access.
Portable extraction is slow on this machine. NSIS installation has not been tested.

The historical complete runtime fingerprints are preserved in
`test-results/desktop-cr042-runtime-files.json`; `release/delivery-manifest-cr042.json`
records those artifact identities, representative server/core/helper hashes, exact
exclusions, verification outcomes and environment limits. The unqualified release manifests
describe the current CR-043 artifacts.

Final readback found zero packaged app processes and zero owned smoke sidecars; staging
was restored. The separate browser QA server is outside this native-process check.
Cleanup of the independent temporary app copy and retained diagnostic fixtures was
rejected by automatic approval review with “blocked by policy,” without a more detailed
reason. The packaging child's separate cleanup was also rejected. Those copies remain;
no alternative deletion was attempted.

The native smoke uses the real packaged app, server, SQLite, Git and UI. Only model responses
use the product's explicit mock mode. Native dialogs have deterministic answers. Microphone
checks use Chromium's synthetic device and do not record a person's audio. Local policy and
HTTP response-loss tests support the native checks; they do not verify an external SSH host,
signed release channel, actual voice provider or model decision quality.

NSIS installation, macOS execution/notarization, Linux execution of these new features,
real microphone privacy prompts, actual SSH success and live update download/signature/install
remain environment-specific verification limits.

## 2026-10-21 Linux candidate

`8349579` runtime의 Linux unpacked recovery smoke와 실제 AppImage native flow가 통과했다. 해시·환경·반례·검증 범위는 [품질 작업 실행 기록](Quality-Completion-2026-10-21.md)에 있다. 이전 Windows 수치나 미검증 NSIS/macOS 항목을 이 결과로 대체하지 않는다.

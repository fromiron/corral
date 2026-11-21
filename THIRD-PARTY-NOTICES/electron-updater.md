# electron-updater

- Version: 6.8.11, pinned runtime dependency of `@corral/desktop`.
- License: MIT; unmodified license text in `electron-updater-LICENSE`.
- Source: https://github.com/electron-userland/electron-builder/tree/master/packages/electron-updater
- Official integration documentation: https://www.electron.build/v26/docs/features/auto-update/
- Purpose: owner-configured NSIS/macOS/AppImage update discovery, integrity checks, download and explicit install.
- Runtime: Electron main process only, independent of the server Node ABI. The package declares no Node engines or peer dependencies. Corral pins Electron 44.11.4 and builder 26.18.0.
- No feed, signing credentials, publication or live installer download is configured by this dependency addition.

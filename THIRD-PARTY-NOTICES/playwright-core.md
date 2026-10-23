# Playwright Core

- Selected under CR-046 P26 for server-side Chromium debugging. `@corral/server` directly pins `playwright-core` 1.64.1, the stable version already resolved in this workspace. It reuses the maintained protocol client instead of adding a custom browser/CDP transport. Studio receives no browser automation dependency.
- Microsoft maintains the package under Apache-2.0. The installed distribution's unmodified `LICENSE`, `NOTICE` and bundled third-party notices are preserved as `playwright-core-LICENSE`, `playwright-core-NOTICE` and `playwright-core-ThirdPartyNotices.txt`.
- The registry stable tag, exact installed package and public TypeScript definitions were checked on 2026-10-23. Version 1.64.1 was published on 2026-10-14 from commit `cfe490d941f992655948eee8fd4fd94e1c4234bf`; integrity and registry metadata are recorded in `docs/dependency-lock.json`.
- Compatibility: Node >=20, no package or peer dependencies, no native addon. Corral uses Node 24.19.0. The package exports TypeScript declarations and ESM/CommonJS entries. These metadata checks do not establish every browser or operating-system combination.
- The registry unpacked size is 13,656,167 bytes; the existing local installation occupies approximately 14 MiB. This is server package size, not measured startup cost or a Studio bundle increase. `playwright-core` has no install script and bundles no browser binary. This addition used the existing offline store with lifecycle scripts disabled; it did not download or install a browser.
- The exact-version OSV query returned no known advisory on 2026-10-23. This is a dependency inventory, not a security guarantee. Debugging endpoints remain privileged; the caller must retain the approved isolated browser/process ownership and target checks, rather than attaching to a person's existing browser profile.
- `chromium.connectOverCDP` supports Chromium only and has lower fidelity than Playwright's own protocol. Browser launch arguments can affect compatibility; actual debugging behavior belongs in the P26 integration evidence.

Official sources:

- https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp
- https://github.com/microsoft/playwright/tree/v1.64.1
- https://registry.npmjs.org/playwright-core/1.64.1

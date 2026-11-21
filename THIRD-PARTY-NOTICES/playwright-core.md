# Playwright Core

- Selected under CR-046 P26 for server-side Chromium debugging. `@corral/server` directly pins `playwright-core` 1.65.1 to use its maintained protocol client. Studio's Playwright test runner uses the same version.
- Microsoft maintains the package under Apache-2.0. The installed distribution's unmodified `LICENSE`, `NOTICE` and bundled third-party notices are preserved as `playwright-core-LICENSE`, `playwright-core-NOTICE` and `playwright-core-ThirdPartyNotices.txt`.
- Version 1.65.1 was published on 2026-11-13 from commit `bbd948344ea9a60bf1e6f125c02ca99b2b51593b`. Integrity, engine requirements and registry metadata are recorded in `docs/dependency-lock.json`.
- Compatibility: Node >=20, no package or peer dependencies, no native addon. Corral pins its Node version in the root `.node-version` file. The package exports TypeScript declarations and ESM/CommonJS entries. These metadata checks do not establish every browser or operating-system combination.
- `playwright-core` has no install script and bundles no browser binary. Debugging endpoints are privileged. The caller verifies target identity and owns the isolated browser process.
- `chromium.connectOverCDP` supports Chromium only and has lower fidelity than Playwright's own protocol. Browser launch arguments can affect compatibility; actual debugging behavior belongs in the P26 integration evidence.

Official sources:

- https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp
- https://github.com/microsoft/playwright/tree/v1.65.1
- https://registry.npmjs.org/playwright-core/1.65.1

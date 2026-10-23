# Base UI

- CR-050 upgrades the existing `@base-ui/react` dependency from 1.4.1 to exact 1.9.0, matching the supplied kit's `@base-ui/react@^1.9.0` requirement. The kit's actual Select/Dropdown components need `Actions.close` and `preventUnmountOnClose`; installed 1.9.0 declarations expose both. Ordinary Dialog and Select are composed from kit components rather than retaining legacy shells.
- Registry and installed metadata checked on 2026-10-23: 1.9.0 is the current stable tag, published 2026-10-09. It includes TypeScript declarations at `index.d.ts`, supports Node >=14, and accepts React/React DOM 17, 18, or 19. Corral uses Node 24.19.0 and React 19.3.1. Date-fns, `@date-fns/tz`, and `@types/react` peers are explicitly optional; this migration does not add date-picker dependencies.
- `@base-ui/react` 1.9.0 and its updated `@base-ui/utils` 0.5.0 dependency use identical MIT license text, copyright 2019 Material-UI SAS, preserved unmodified in `base-ui-LICENSE`. Exact direct registry facts remain in `docs/dependency-lock.json`.
- The package unpacks to 10,377,319 bytes and includes the entire component distribution. That is not incremental browser download size. The final application build records bundle impact separately. Base UI has no vendor API, subscription cost, or native addon.
- An OSV exact-version query on 2026-10-23 returned no known advisory for `@base-ui/react` 1.9.0 and `@base-ui/utils` 0.5.0. Other existing dependencies were not re-audited. Installed declarations and peer ranges establish API availability; final component integration checks establish Corral runtime behavior.

Official sources:

- [Base UI 1.9.0 registry metadata](https://registry.npmjs.org/@base-ui/react/1.9.0)
- [Base UI source](https://github.com/mui/base-ui)
- [Base UI Select reference](https://base-ui.com/react/components/select)
- [OSV query API](https://google.github.io/osv.dev/api/)

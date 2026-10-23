# Motion

- Selected under CR-050 to use the supplied design kit's actual Sidebar and Motion components. The source kit requests `motion@^14.1.0`; Corral pins `motion` to `14.1.0` in `@corral/react`. Reimplementing the kit's animation primitives would add unnecessary code and drift.
- The lockfile resolves `framer-motion`, `motion-dom`, and `motion-utils` to `14.1.0`, reusing `tslib` `2.8.1`. All four Motion packages are MIT. `motion`, `motion-dom`, and `motion-utils` share the byte-identical copyright 2024 Motion B.V. notice in `motion-LICENSE`; `framer-motion-LICENSE` preserves copyright 2018 Framer B.V.
- Registry and installed metadata checked on 2026-10-23: selected release published 2026-10-09 from commit `e6bf03ead39cae7a2c5f8fe902ce8a9c1a9a22e8`; the registry's stable tag is `14.6.0`, published 2026-10-22. The chosen stable version matches the kit's minimum without an unrelated upgrade. Exact direct dependency facts are in `docs/dependency-lock.json`.
- TypeScript declarations ship with the package, including `motion/react`. React and React DOM 18/19 are accepted; Corral uses 19.3.1. The package has no declared Node engine requirement or native addon. Runtime compatibility is checked in the actual Corral build, not inferred from those ranges alone.
- This is a browser animation dependency with no vendor service, credentials, subscription, or API-call cost. Its npm unpacked size is 757,064 bytes; that is not browser download size. The application chunk measurement is recorded separately in the CR-050 evaluation. Reduced motion follows the user's OS setting.
- An OSV exact-version query on 2026-10-23 returned no known advisory for `motion`, `framer-motion`, `motion-dom`, and `motion-utils` 14.1.0 or reused `tslib` 2.8.1. The upstream security page lists no published advisory. This is a bounded dependency check, not a repository security audit.

Official sources:

- [Motion 14.1.0 registry metadata](https://registry.npmjs.org/motion/14.1.0)
- [Motion upstream security advisories](https://github.com/motiondivision/motion/security/advisories)
- [Motion bundle-size guidance](https://motion.dev/docs/react-reduce-bundle-size)
- [OSV query API](https://google.github.io/osv.dev/api/)

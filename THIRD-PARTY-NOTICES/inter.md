# Inter

- Bundled so the kit's `"Inter", system-ui, sans-serif` family and its `font-variation-settings` weights (`wght` 550/700 with `opsz`) render the same on every machine instead of falling back to a static system face. The only direct dependency is `@fontsource-variable/inter` 5.3.0 in `@corral/react`; it has no dependencies, no install scripts and no peer or engine requirements.
- The font files are licensed under the SIL Open Font License 1.1, copyright 2016 The Inter Project Authors (https://github.com/rsms/inter). The unmodified license text from the installed package is in `inter-LICENSE`. The font is bundled with the application, not sold by itself, and keeps its reserved name; Corral only declares it under the family name "Inter".
- Registry metadata checked on 2026-11-10: version 5.3.0 is the stable `latest` tag, published 2026-07-19 from commit `02b28c06b126c852a5b966b44aef777ca923f6f6` with npm provenance. The packaged font source is Inter v20 from Google Fonts. Exact registry facts are in `docs/dependency-lock.json`.
- `packages/react/src/fonts.css` declares the `standard` (wght and opsz axes) normal-style woff2 files for the latin, latin-ext, cyrillic, cyrillic-ext, greek, greek-ext and vietnamese subsets with their unicode ranges, so a subset downloads only when its characters appear. Italic and other files in the package are not referenced. Vite copies the referenced files into the Studio build, which the local server and the desktop app serve from the Studio origin under `font-src 'self'`; there is no remote font request. Hangul comes from the bundled Pretendard Variable face ([pretendard.md](pretendard.md)).
- The referenced latin subset is 72,920 bytes and latin-ext 133,336 bytes; these are package-file measurements, not the application's startup cost.
- An OSV exact-version query on 2026-11-10 returned no known advisory for `@fontsource-variable/inter` 5.3.0. This is a bounded dependency check, not a security audit.

Official sources:

- [Registry metadata for 5.3.0](https://registry.npmjs.org/@fontsource-variable/inter/5.3.0)
- [Fontsource Inter](https://fontsource.org/fonts/inter)
- [Inter project](https://github.com/rsms/inter)
- [SIL Open Font License 1.1](https://openfontlicense.org)
- [OSV query API](https://google.github.io/osv.dev/api/)

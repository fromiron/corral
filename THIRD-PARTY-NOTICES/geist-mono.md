# Geist Mono

- Bundled for one subset only: the box-drawing, scan-line and block characters (`U+23B8-23BD`, `U+2500-259F`) of the monospace family. The bundled JetBrains Mono subsets ([jetbrains-mono.md](jetbrains-mono.md)) hold none of them, so a directory tree or a box-drawn table would mix JetBrains Mono letters with whatever the system draws those characters in, and lose its columns. Geist Mono advances 0.6em, as JetBrains Mono does, so the two share one grid. It is second in `--font-mono` and draws nothing else. The only direct dependency is `@fontsource-variable/geist-mono` 5.3.0 in `@corral/react`; it has no dependencies, no install scripts and no peer or engine requirements.
- The font files are licensed under the SIL Open Font License 1.1, copyright 2024 The Geist Project Authors (https://github.com/vercel/geist-font). The unmodified license text from the installed package is in `geist-mono-LICENSE`. The font is bundled with the application, not sold by itself, and is used as the package ships it, under its own family name "Geist Mono".
- Registry metadata checked on 2026-11-29: version 5.3.0 is the stable `latest` tag, published 2026-07-19 from commit `02b28c06b126c852a5b966b44aef777ca923f6f6` with npm provenance. The packaged font source is Geist Mono v6 from Google Fonts. Exact registry facts are in `docs/dependency-lock.json`.
- `packages/react/src/fonts.css` declares one file, `files/geist-mono-symbols2-wght-normal.woff2` (one weight axis, 100 to 900). The package gives that subset the range `U+2000-2001, U+2004-2008, U+200A, U+23B8-23BD, U+2500-259F`; Corral declares it without the spaces, which JetBrains Mono draws. The Latin, Cyrillic and Vietnamese subsets, italics and other package files are not referenced. Vite copies the file into the Studio build, which the local server and the desktop app serve from the Studio origin under `font-src 'self'`; there is no remote font request. The Studio build keeps every `.woff2` a file, so this subset is not written into the stylesheet as a `data:` URL.
- The referenced file is 5,812 bytes; this is a package-file measurement, not the application's startup cost.
- An OSV exact-version query on 2026-11-29 returned no known advisory for `@fontsource-variable/geist-mono` 5.3.0. This is a bounded dependency check, not a security audit.

Official sources:

- [Registry metadata for 5.3.0](https://registry.npmjs.org/@fontsource-variable/geist-mono/5.3.0)
- [Fontsource Geist Mono](https://fontsource.org/fonts/geist-mono)
- [Geist project](https://github.com/vercel/geist-font)
- [SIL Open Font License 1.1](https://openfontlicense.org)
- [OSV query API](https://google.github.io/osv.dev/api/)

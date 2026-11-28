# JetBrains Mono

- Bundled so code, paths, diffs, the code editor and the terminal draw in one monospace face on every machine. The kit names no monospace font, and the system one differs from machine to machine. It is first in `--font-mono`, with its coding ligatures off. The only direct dependency is `@fontsource-variable/jetbrains-mono` 5.3.0 in `@corral/react`; it has no dependencies, no install scripts and no peer or engine requirements.
- The font files are licensed under the SIL Open Font License 1.1, copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono). The unmodified license text from the installed package is in `jetbrains-mono-LICENSE`. The font is bundled with the application, not sold by itself, and is used as the package ships it, under its own family name "JetBrains Mono".
- Registry metadata checked on 2026-11-29: version 5.3.0 is the stable `latest` tag, published 2026-07-19 from commit `02b28c06b126c852a5b966b44aef777ca923f6f6` with npm provenance. The packaged font source is JetBrains Mono v24 from Google Fonts. Exact registry facts are in `docs/dependency-lock.json`.
- `packages/react/src/fonts.css` declares the `wght` (one weight axis, 100 to 800) normal-style woff2 files for the latin, latin-ext, cyrillic, cyrillic-ext, greek and vietnamese subsets with their unicode ranges, so a subset downloads only when its characters appear. The code editor and the terminal load all six, and the Geist Mono subset, before they open, because they measure their columns once. Italic and other files in the package are not referenced. Vite copies the referenced files into the Studio build, which the local server and the desktop app serve from the Studio origin under `font-src 'self'`; there is no remote font request. The Studio build keeps every `.woff2` a file: the cyrillic-ext subset is smaller than Vite's inline limit and would otherwise be written into the stylesheet as a `data:` URL, which that policy refuses.
- The six subsets hold no box-drawing or block characters. Those come from one bundled Geist Mono subset of the same advance ([geist-mono.md](geist-mono.md)), second in the family list. Arrows, check marks, Hangul and other characters neither face holds fall through to the system families after them, which are the ones the monospace family had before the faces were bundled.
- The six referenced files are 86,244 bytes together: latin 40,404, latin-ext 15,196, cyrillic 12,108, greek 9,004, vietnamese 7,504 and cyrillic-ext 2,028. These are package-file measurements, not the application's startup cost.
- An OSV exact-version query on 2026-11-29 returned no known advisory for `@fontsource-variable/jetbrains-mono` 5.3.0. This is a bounded dependency check, not a security audit.

Official sources:

- [Registry metadata for 5.3.0](https://registry.npmjs.org/@fontsource-variable/jetbrains-mono/5.3.0)
- [Fontsource JetBrains Mono](https://fontsource.org/fonts/jetbrains-mono)
- [JetBrains Mono project](https://github.com/JetBrains/JetBrainsMono)
- [SIL Open Font License 1.1](https://openfontlicense.org)
- [OSV query API](https://google.github.io/osv.dev/api/)

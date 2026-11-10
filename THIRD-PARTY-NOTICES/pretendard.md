# Pretendard

- Bundled so Hangul in the kit's sans stack (`"Inter", "Pretendard Variable", system-ui, sans-serif`) takes its `font-variation-settings` weights (`wght` 550/700) on every machine. A static system Hangul font ignores those settings, so Korean headings and labels rendered at regular weight beside semibold or bold Latin. The only direct dependency is `pretendard` 1.3.9 in `@corral/react`; it has no dependencies, no install lifecycle scripts (its `subset` and `publish` scripts are maintainer scripts that do not run on install) and no peer or engine requirements.
- The font files are licensed under the SIL Open Font License 1.1, copyright 2021 Kil Hyung-jin, with Reserved Font Name Pretendard (https://github.com/orioncactus/pretendard). The unmodified license text from the installed package's `dist/LICENSE.txt` is in `pretendard-LICENSE`. The font is bundled with the application, not sold by itself, and is used unmodified under its own family name "Pretendard Variable".
- Registry metadata checked on 2026-11-11: version 1.3.9 is the stable `latest` tag, published 2023-11-05 from commit `5c41199ea0024a9e0b2cb31735265056e5472d76`, which is the repository's `v1.3.9` release tag. The registry entry carries a signature but no provenance attestation. The font's version string is 1.309. Exact registry facts are in `docs/dependency-lock.json`.
- `packages/react/src/fonts.css` declares one file, `dist/web/variable/woff2/PretendardVariable.woff2` (one `wght` axis from 45 to 930), with `unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3`, so only Hangul Jamo, compatibility Jamo and syllables use it; Latin, digits and punctuation stay on Inter. Static weights, dynamic subsets and other package files are not referenced. Vite copies the file into the Studio build, which the local server and the desktop app serve from the Studio origin under `font-src 'self'`; there is no remote font request.
- The referenced file is 2,057,688 bytes. The installed package is 97,653,151 bytes unpacked (1,826 files) in `node_modules`; only the one file is bundled.
- The package ships its license under `dist/`, not at its root, so the release inventory's top-level notice collection does not include it; this notice and `pretendard-LICENSE` carry it.
- An OSV exact-version query on 2026-11-11 returned no known advisory for `pretendard` 1.3.9. This is a bounded dependency check, not a security audit.

Official sources:

- [Registry metadata for 1.3.9](https://registry.npmjs.org/pretendard/1.3.9)
- [Pretendard project](https://github.com/orioncactus/pretendard)
- [Release v1.3.9](https://github.com/orioncactus/pretendard/releases/tag/v1.3.9)
- [SIL Open Font License 1.1](https://openfontlicense.org)
- [OSV query API](https://google.github.io/osv.dev/api/)

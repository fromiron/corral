# Monaco Editor

- Version: 0.57.0, exact runtime dependency of `@corral/studio`, selected under CR-046 / ADR-040.
- License: MIT; unmodified license in `monaco-editor-LICENSE`, bundled component notices in `monaco-editor-ThirdPartyNotices.txt`.
- Official release: https://github.com/microsoft/monaco-editor/releases/tag/v0.57.0
- Supported ESM entry points: https://github.com/microsoft/monaco-editor/blob/v0.57.0/CHANGELOG.md
- Public API: https://microsoft.github.io/monaco-editor/typedoc/interfaces/editor_editor_api.editor.ITextModel.html
- Purpose: lazy-loaded shared document editor with browser-owned views and a self-hosted worker. Existing React 19.3.1, Vite 8.3.4 and TypeScript 6.0.3 remain in place. No React wrapper, Dockview or terminal dependency is added here.
- Compatibility: no Node engines or peer dependencies are declared; no native addon or Electron ABI rebuild is needed. Exact registry facts are recorded in `docs/dependency-lock.json`; package metadata does not prove installed-app compatibility.
- Load cost: the initial qualification's whole-package entry generated a 4.60 MB main JS chunk and a 6.93 MB TypeScript worker. Studio loads the editor only after a document is opened, registers syntax definitions without language-server features, and does not include those language-service workers. Final app asset sizes belong in the execution evidence.
- Security inventory, 2026-10-21: bundled DOMPurify 3.4.15 has two low advisories, https://github.com/advisories/GHSA-p98j-92pf-mc4p and https://github.com/advisories/GHSA-6688-9rhm-gjv2 . Both require `IN_PLACE` sanitization. Review of this exact Monaco distribution found no `IN_PLACE` caller outside the vendored sanitizer; Monaco constructs string/fragment/trusted-output sanitization options. This is bounded reachability evidence, not a full security audit or a claim that the dependency has been patched. A dependency override alone cannot replace Monaco's vendored copy. Reassess on a Monaco update or sanitizer call-path change.
- The existing Studio CSP remains unchanged. Workers and editor assets are bundled locally; no CDN, `unsafe-eval` or `blob:` worker permission is added.

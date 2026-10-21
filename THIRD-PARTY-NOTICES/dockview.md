# Dockview

- Selected under CR-046 / ADR-040 for P10 in the existing React workbench. The only direct dependency is `dockview-react` 8.6.1; the lockfile also resolves its `dockview` and `dockview-core` dependencies to 8.6.1. No Enterprise package is included.
- All three packages use the same MIT license, copyright 2021 mathuo. Their installed license files are byte-identical; the unmodified text is in `dockview-LICENSE`.
- Registry stable tags and the official v8.6.1 release were checked on 2026-10-21. The packages were published on 2026-10-19 from commit `a9e3092fbd5c61aef69ca0922a86bf0be53cb891`. Exact direct-package registry facts are in `docs/dependency-lock.json`.
- Compatibility: `dockview-react` accepts React and React DOM 16.8, 17, 18 or 19; Corral uses 19.3.1. The packages declare no Node engine requirement and contain no native addon. The P01 fixture built with Node 24.19.0, Vite 8.3.4 and TypeScript 6.0.3; that does not establish every installed-app or operating-system combination.
- Public entries: `DockviewReact`, types and core APIs are exported from `dockview-react`; CSS is available at `dockview-react/dist/styles/dockview.css`. A second direct `dockview` dependency or a custom docking engine is unnecessary.
- The exact package distribution contains 20,007 bytes of minified React binding, 390,319 bytes of minified core and 159,552 bytes of CSS (gzip 4,820 / 90,074 / 12,611 bytes). These are package-file measurements, not final application chunks or incremental startup cost. Actual Studio build results belong in execution evidence.
- The OSV query for these three exact package versions returned no known advisory on 2026-10-21. This is a dependency inventory, not a security guarantee. No dependency install scripts were run for this addition.
- MIT functionality includes panel/group drag and drop, public move/focus APIs, resizing and layout serialization. Built-in spatial keyboard navigation, interactive keyboard docking and layout history require Enterprise; public types mentioning those options do not grant those features. Corral uses public APIs and its own accessible commands.
- Layout serialization describes view placement and panel references. Document text, process ownership, credentials and Run authority remain in their existing stores. Restoring a layout is not an authorization to execute or stop a process.

Official sources:

- https://github.com/dockview/dockview/releases/tag/v8.6.1
- https://dockview.dev/docs/overview/licence/
- https://dockview.dev/docs/advanced/focus-navigation/
- https://dockview.dev/docs/core/state/load/
- https://dockview.dev/docs/core/panels/rendering/

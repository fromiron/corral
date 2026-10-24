# CR-050 Design Kit Adoption

## Scope

- Tracking: C-177 / CRL-UX-009 / TC-DKIT-001-H,N.
- Work started on 2026-10-23; final checks continued on 2026-10-24 (Asia/Tokyo).
- Artifact: the working-tree changes above `a8cc3fa13da773691e19ef93c4d4b62c7cd076fb`; no release verdict.
- Request: adopt the supplied kit, normalize the implemented visual system in English [DESIGN.md](../../DESIGN.md), and keep verification focused. Follow-up approval requires kit components directly, then composition, and custom UI only when neither works, including both sidebars and `packages/react/src/components/`. Preserve behavior, data, and accessibility; retaining legacy appearance is not required.
- Environment: Linux, Node 24.19.0, pnpm 10.30.3, Vite 8.3.4, local Chromium demo and isolated server fixtures; no paid model calls. Implementation and the focused runtime/screenshot checks below are complete.

## Findings and applied changes

- **Observed:** the copied `design-kit/index` supplies canonical primitives; existing `ui` imports form a thin compatibility facade. Studio and domain components compose kit Accordion, Table, ChatMessage, InputGroup, Radio, Checkbox, Switch, Sidebar, and other applicable components. Native event/ref bridges and domain-specific graph, document, and execution logic preserve their existing behavior. Both sidebars use actual source components, and StatusBadge uses the kit's dot variant.
- **Measured:** copied `packages/react/src/design-kit/tokens.css` has SHA-256 `b96f55b7be7b8247946fa297d431fb486b83872a060b202182f08e67c03bb4d0`, matching the source file. Corral aliases and light-theme status/focus contrast adjustments live in `packages/react/src/theme.css`, leaving the copy intact.
- **Observed:** `DESIGN.md` is the canonical visual reference; the documentation map and current Workbench link to it instead of repeating visual values. CR-050 records which older visual rules it supersedes while preserving their interaction contracts.
- **Observed:** kit Sidebar/Motion imports introduce the exact direct dependency `motion@14.1.0`. [Dependency facts](../dependency-lock.json) and the [Motion notice](../../THIRD-PARTY-NOTICES/motion.md) record the source requirement, license, compatibility, maintenance, and cost. This is the kit's browser animation dependency; no external service is added.
- **Observed:** the existing Base UI dependency upgrades from 1.4.1 to exact 1.9.0, meeting the source kit's `^1.9.0` requirement. Installed Select/Menu declarations expose `Actions.close` and `preventUnmountOnClose`; date-fns peers remain optional. The [Base UI notice](../../THIRD-PARTY-NOTICES/base-ui.md) preserves compatibility/license evidence. Ordinary Dialog and Select compose the actual kit components.

- **Observed (2026-10-24 follow-up):** 69 native text inputs and textareas in settings, harness, meeting and file panels used the local `settings-field` / `fill-control` styling. They now use the kit `Input` and `Textarea` bridges, and the `settings-field` CSS is removed. The request composer, command palette and schema question choices keep native elements (documented exceptions). `design.test.ts` guards this. Biome's `noLabelWithoutControl` treats `Input`, `Textarea` and `Select` as controls. All 44 native checkboxes became kit `Switch` (settings and options, 24) or the new `Checkbox` bridge (selections and confirmations, 20): a single kit `CheckboxItem` in its own `CheckboxGroup`, because the kit row needs a group and has no disabled state. Both kit components take a plain-text label, so descriptions moved beside them and the long Markdown-agent-import confirmation was split into a sentence plus a short label (copy changed). Playwright specs for the Switch conversions now query `switch`. Server-backed E2E specs were not run.

- **Observed (2026-10-24 follow-up):** the conversation work log now composes the copied kit `ThinkingSteps` (source unchanged except a controlled `ThinkingStepDetails`, see the kit README). `RunMessage.density.test.tsx` covers the header disclosure, the active step and the lazily mounted transcript; the demo chat showed the header, five completed steps and a transcript opened from its fold.

- **Observed (2026-10-24 follow-up):** seven hand-tinted warning boxes (composer attention, run card action, blocked intent, two models-not-ready notices, the narrow decision-waiting bar and the native-extension caution) now compose the copied kit `Banner`. `design.test.ts` rejects the hand-made banner tint. The attention banner also names its cause (unknown effect, unconfirmed usage, unconfirmed stop).

## Verification

| Check | Result and evidence | Boundary |
|---|---|---|
| Token provenance | **Measured:** source and copied token SHA-256 match | Corral adaptation is separate from the source copy |
| `pnpm deps:check`, Node 24.19.0 | **Measured: PASS**, exact direct versions, installed license/metadata, Node and peer compatibility | Not a browser or release check |
| OSV exact-version queries, 2026-10-23 | **Measured:** no advisory returned for motion/framer-motion/motion-dom/motion-utils 14.1.0, tslib 2.8.1, @base-ui/react 1.9.0, or @base-ui/utils 0.5.0 | Only introduced/upgraded packages and the Motion chain were queried |
| React and Studio typechecks | **Measured: PASS**, `/tmp/corral-design-kit-react-types-verified.log`, `/tmp/corral-design-kit-types-verified.log` | Package types, not complete runtime coverage |
| Studio production build | **Measured: PASS**, `/tmp/corral-design-kit-build-verified.log`, 2.11s | Existing large-chunk and ineffective ReviewPage dynamic-import warnings remain |
| Focused unit checks | **Measured: PASS**, 62 tests / 11 files; `/tmp/corral-design-kit-unit-final.log` | Selected changed controls, theme and preserved behavior |
| DockWorkbench regression after accessibility correction | **Measured: PASS**, 12 tests; `/tmp/corral-dock-keyboard-green.log` | Close action, Delete/middle-click protection and existing docking behavior |
| Final theme, narrow-navigation and settings E2E | **Measured: PASS**, TC-DKIT-001-H,N, DW-08 and DW-02/03; `/tmp/corral-design-kit-e2e-verified.log` | Explicit themes/scrim, reduced motion, keyboard focus, narrow overflow, settings/working draft; DW-02 serious/critical axe violations: 0 |
| Composer conflict/recovery E2E | **Measured: PASS**, TC-COMPOSER-001-N; `/tmp/corral-design-kit-menu-verified.log` | Keyboard nested menus, Escape, conflict message and draft preservation; same test rerun after targeting its actual conflict alert |
| `pnpm contracts:check` | **Measured: PASS** | Generated contract consistency |
| Final screenshots and actual Select dismissal | **Observed/Measured: PASS**, project/session and settings layouts reviewed; final dark, light and 390px settings captures regenerated. Selecting a theme closes the popup (`aria-expanded=false`, zero options) with no new `preventUnmountOnClose` error | Dev server restarted with `--force`; optimized metadata confirms Base UI 1.9, replacing stale 1.4 cache. No source change was needed |

The build's shared `design-kit-D_G3Bhup.js` chunk is 578.71 kB minified / 186.65 kB gzip; the router chunk is 2,489.27 / 699.84 kB, and the index CSS is 158.58 / 25.72 kB. These are final chunk sizes, not net growth. The design-kit chunk includes shared kit and dependency code, not isolated Motion. Existing warnings were recorded without expanding this migration into bundle optimization. Log paths are temporary local evidence, not files required to build or test Corral.

### Interim checks before the final canonical kit integration

- **Measured:** the post-token production build completed. Eight focused E2E tests produced seven passes and one failure: an Input rendered at 38px beside a 36px Button. The shared Input was corrected to 34px content plus 2px borders (compact: 26 + 2 = 28px; coarse pointer: 42 + 2 = 44px). The failing regression is retained for the final run.
- **Observed:** the user reported composer edge clipping and a foggy dark overlay. The composer update uses one surface host with 4px paint clearance; geometric inspection confirmed the clearance. The Dialog overlay now follows the kit's black scrim at 40% light / 80% dark without blur. The final UI checks must include these later changes.
- **Measured:** the first 15-test E2E run had nine passes and six failures; the six-test rerun had four passes and two failures. These are separate runs, not added test totals. Stale component selectors and equivalent scrim color serialization were corrected. The DW-02 axe check exposed sidebar timestamp contrast, list-decoration semantics, and nested interactive content in Dockview. The code fixes preserve semantic lists, selected metadata contrast, a kit close action and Delete/middle-click close guards. DW-02 then passed with its accessibility assertions active.
- **Measured:** the final five-test run passed the four theme/navigation/settings cases. Its composer case failed only because the unscoped alert locator matched both Dockview's live region and the actual save-conflict message. Scoping the assertion to the conflict message retained the behavior check; the same test then passed in 3.2s. No failing behavioral assertion was deleted or weakened.

These intermediate failures explain the corrections. The final targeted outcomes are listed separately above; no combined all-tests or release result is claimed.

## Unknowns and rollback

The complete release gate, other operating systems, native IME, screen-reader testing, and every domain workflow are outside this focused migration check. The measured final chunks are not a before/after performance benchmark or a net bundle-growth measurement.

To undo the migration, revert the CR-050 source, dependency, design, and tracking changes together after review; retain unrelated work. Do not delete historical evidence or restore the complete working tree indiscriminately.

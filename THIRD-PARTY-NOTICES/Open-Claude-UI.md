# Open Claude UI

Adapted interface patterns from [Caho1/open-claude-ui](https://github.com/Caho1/open-claude-ui) at commit `4045ce76afdcb7dccef1b7e6417b04c4c6046e9c`.

The upstream project is a third-party reimplementation. It is not Claude's official source, and its README is not an independent safety or quality finding. The MIT license below is the license of that repository. It is not a warranty over Corral's product, brand, or review process.

## MIT license

Copyright (c) 2026 Caho1

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## What was adapted

| Upstream file | Use | Corral | Tests |
| --- | --- | --- | --- |
| `code-examples/ModelSwitcherWithTokenGauge.tsx` | code adaptation of the circular gauge, segmented bar, and summary/detail split | `apps/studio/src/workbench/widgets/ChatWidgets.tsx` (`ContextGauge`, `SegmentBar`, `ContextUsageChip`) | TC-WIDGET-002 |
| `code-examples/ThinkingAccordion.tsx` | pattern reference for a short activity header and disclosure | `ComposerPlan` in the same file | TC-WIDGET-001 |
| `code-examples/StatusIndicators.tsx` | code adaptation of QuietDotsWave's staggered activity rhythm | `QuietActivity` in the same file and `corral-quiet-wave` in `apps/studio/src/index.css`; static with reduced motion | TC-WIDGET-001 |
| `code-examples/ChatComposerChin.tsx` | pattern reference for a shallow companion sharing the composer surface; moved above the input for the accepted WorkPlan contract | `ComposerPlan`, `ComposerDock` and the shared composer outline in `SessionPage.tsx` | TC-WIDGET-001 |
| `code-examples/ContainerResponsiveBar.tsx` | pattern reference for container-width adaptation; current user correction places desktop widgets in the upper-right card | `WorkbenchLayout` named container and `.session-summary-slot` / `.session-widget-access` in `apps/studio/src/index.css` | TC-WIDGET-001, `e2e/chat-surface.spec.ts` |
| `code-examples/useClaudeScrollPinning.ts` | pattern reference only. Corral keeps `ChatView`'s existing scroll owner | `ChatView.tsx` restores entry ID/offset on viewport changes and follows the end only while opted in | TC-WIDGET-001, `e2e/chat-surface.spec.ts` |

The integrated tests are `apps/studio/e2e/server/chat-widgets.spec.ts` (actual request,
Coordinator plan updates, context details, retained manual disclosure, one event subscription,
scoped decisions, and narrow columns) and `apps/studio/e2e/chat-surface.spec.ts`
(scroll ownership, input identity, result selection and response focus).

## Removed or changed

- Fixed Claude model lists, a 200k window, sample token values, and summing input, output, and cache tokens are not used. The gauge is display-only and does not replace Corral's model control.
- A live thinking state no longer forces the disclosure open or blocks the toggle. Preference is `auto`, `open`, or `closed`. Collapsed plan text is not mounted, so it leaves the keyboard and accessibility tree. Private reasoning text is not requested.
- Header controls are buttons with `aria-expanded`, not clickable divs.
- Sample retry, local queue storage, and the upstream send shortcut are not included.
- Upstream CSS variables, Claude branding, and the upstream Tailwind setup are not loaded. Motion uses Corral's existing reduced-motion rule.
- No new font, audio, Electron code, or package was added.

The existing T3 UI notice was removed in commit `ec5e244` before this work. This change does not restore that file.

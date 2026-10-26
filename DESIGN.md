---
name: Corral Neutral
colors:
  primary: "#171717"
  secondary: "rgb(0 0 0 / 8%)"
  muted-foreground: "#737373"
  surface: "#FAFAFA"
  on-surface: "#171717"
  error: "#B91C1C"
  focus: "#2563EB"
themes:
  dark:
    primary: "#F5F5F5"
    secondary: "rgb(255 255 255 / 25%)"
    muted-foreground: "#B8B8B8"
    surface: "#171717"
    on-surface: "#F5F5F5"
    error: "#FCA5A5"
    focus: "#6B97FF"
typography:
  body-md:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: 13px
    lineHeight: 20px
    fontWeight: 400
  body-compact:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: 12px
    lineHeight: 18px
    fontWeight: 400
rounded:
  sm: 4px
  md: 8px
  lg: 12px
---

# Design System

## Overview

Corral is a dense workspace for conversations, agent teams and development tasks. Use the supplied design kit's neutral surfaces, restrained controls and composable components to make the work prominent. Preserve the existing navigation, D&D canvas, Reins controls, settings, editor and recovery paths.

The purpose of adopting the kit is to improve the design. Preserve functionality, user data and accessibility, not the old appearance. Let the kit's composition, spacing, typography and surfaces replace inconsistent local styling.

## Kit-first Composition

Use this order for every interface change:

1. Use an existing `design-kit` component directly.
2. Compose existing `design-kit` components.
3. Add implementation only when neither can express the actual product requirement. Record the missing capability and keep the addition within that boundary.

`packages/react/src/design-kit` owns reusable UI. Components under `packages/react/src/components` compose it with Corral data and commands. The old `ui` paths are compatibility exports, not a second visual system. Do not copy old appearance classes onto kit controls to recreate the former design. API adapters may preserve events, refs, labels or controlled state; they must not introduce an independent visual language.

This document is the current design contract. The front matter describes the default light palette and its dark counterpart; runtime CSS is authoritative for rendering.

## Source and Ownership

- [Copied kit tokens](packages/react/src/design-kit/tokens.css): the original palette, eight surface/shadow levels and six type roles.
- [Corral theme](packages/react/src/theme.css): semantic aliases, control geometry, contrast adjustments, focus, reduced motion and platform integration.
- [Shared components](packages/react/src/design-kit/index.ts): the canonical public API, exported as `@corral/react/design-kit`. Compose these before adding local markup or styles; `ui` paths only reexport compatibility names.
- [Source provenance](packages/react/src/design-kit/README.md): copied and adapted files, compatibility decisions and source fingerprint.

The design kit is copied into this repository. Building Corral does not read another project's folder. New UI should use the canonical roles below. Compatibility aliases remain only to keep existing graph, editor and workbench consumers on the same values; they are not another palette.

## Colors

| Role | Light | Dark | Use |
|---|---|---|---|
| `background` / `surface-1` | #FAFAFA | #171717 | Workspace floor |
| `surface-2` | #FCFCFC | #1E1E1E | Sidebar and grouped settings |
| `card` / `surface-3` | #FFFFFF | #252525 | Focused field surface; popup level above a page-level context |
| `surface-4` | #FFFFFF | #2C2C2C | Explicit raised work surfaces |
| `surface-5` | #FFFFFF | #333333 | Dialog level above a page-level context |
| `foreground` / `primary` | #171717 | #F5F5F5 | Main text and primary button fill |
| `secondary` / `tint` | Black at 8% | White at 25% | Secondary button fill over the current surface |
| `muted-foreground` | #737373 | #B8B8B8 | Secondary text and metadata |
| `muted` | #F4F4F5 | #1E1E1E | Quiet backgrounds, never text |
| `accent` | #E5E5E5 | #525252 | Neutral interactive emphasis, never a brand color |
| `selected` | #D4D4D4 | #525252 | Selected item background |
| `destructive` | #B91C1C | #FCA5A5 | Error text, icons and destructive actions |
| `success` | #166534 | #86EFAC | Successful state with a text or icon cue |
| `warning` | #92400E | #FCD34D | Warning state with an explanation |
| `info` | #1D4ED8 | #93C5FD | Informational state |
| `focus-ring` | #2563EB | #6B97FF | Keyboard focus |

`border` mixes 12% foreground into transparency. `hover`, `active`, `tint` and `tint-hover` are surface-relative overlays from the kit. Dialogs use the kit's black scrim: 40% in light mode and 80% in dark mode through `dialog-scrim`. Never use the dark theme's white interactive overlay as a page mask. Do not substitute the muted background token for secondary text. Primary actions use foreground on background; focus blue is not a second CTA style.

The light status and focus values are deliberate Corral adjustments: the source kit's lighter status colors are unsuitable for small text on light surfaces. Dark secondary text is #B8B8B8 so it remains readable on the kit's elevated popup surfaces, including surface 8 (4.61:1 on #484848). Keep `destructive-contrast` for text on a filled error surface. Ordinary text targets at least 4.5:1 contrast; large text and essential control indicators target at least 3:1. Validate actual foreground/background pairs, including selected and highlighted states; the base palette ratio is not a full-screen contrast result.

Theme choice supports light, dark and system. `light-dark()` resolves the palette; explicit `.light` and `.dark` scopes also select the matching overlay/shadow recipes. Monaco and xterm receive resolved sRGB colors through the shared theme-color helper because they parse their own colors.

## Typography

Use the kit's six semantic roles. Font family is `Inter, system-ui, sans-serif`; the supplied kit includes no font files, so Inter is used only where available and the system font is the fallback. Do not add a remote font request implicitly. Code, paths, diffs and the terminal retain a monospace family.

| Role | Size / line height | Typical use |
|---|---|---|
| `display` | 28 / 34px | Occasional page introductions |
| `title` | 16 / 22px | Page and section titles |
| `subtitle` | 14 / 20px | Card headings and prominent labels |
| `body` | 13 / 20px | Controls and ordinary UI text |
| `caption` | 12 / 16px | Secondary labels and metadata |
| `micro` | 11 / 14px | Sparse status annotations |

Compact controls use the kit's 12 / 18px body scale. Headings use medium or semibold weight; body text uses regular weight. Do not uppercase every section label. Long conversation output retains the established 15 / 28px reader role as an explicit reading-density exception. Preserve Korean and English labels without clipping or forced single-line paragraphs.

## Layout, Spacing and Shape

Use one workspace grammar: sidebar, top bar, task content and contextual panels. Settings remain an overlay on the current work. Do not change task ownership or introduce a second navigation system as part of visual styling.

A session's dock has no toolbar row of its own. Each area's header holds its pane controls: an open-pane menu, a pane-actions menu for layout, area, size and split, and a close action for the active pane. A pane opens in its own area (conversation in the main area, terminal, tasks and checks below, the rest beside it), so a control never covers the conversation it was opened from. A new layout opens only the conversation and the panes its replies link to. Page-level display preferences, such as conversation density, belong in the page menu rather than above the content. Links that open beside the conversation share the side-panel mark.

Use Tailwind's existing 4px spacing unit: 4–8px for related controls, 12–16px within components, and 24px between sections. Let the page own outer padding; avoid stacking page padding with another full-size wrapper. Preserve the established 640px settings and 1024px sidebar boundaries, task-specific workbench container queries, and the 46rem conversation measure. Narrow layouts must keep primary actions and recovery controls reachable.

Controls use an 8px radius; panels and popup containers use 12px. A menu item inset 4px inside a 12px popup uses 8px corners. Independent inputs inside a card keep their own 8px radius; do not treat them as concentric surfaces. Compact badges and keycaps may use 4px. Avatars, status dots and explicitly pill-shaped chips remain circular exceptions.

The source kit keeps all eight elevation levels. Menus rise two levels and dialogs four levels above their context, capped at level 8; nested menus can therefore use levels 6–8. Use the source component's surface and shadow recipes rather than assigning another fixed background at the call site. Do not add decorative gradients, glows or independent shadow recipes. Media overlays may retain their dark scrim so controls remain readable over arbitrary images.

## Components

| Component | Contract |
|---|---|
| `Button` | Compose the kit's press surface and label. Use `primary`, `secondary`, `tertiary` or `ghost`. Default controls are 36px; compact controls are 28px. Icon buttons keep accessible names. |
| `Input`, `Textarea`, `Select` | Use the shared field wrappers with persistent labels, error association and visible focus. Keep native editing and existing controlled-selection behavior. |
| `Banner` | Status messages in the flow of the page: attention needed, blocked requests, models not ready, a decision waiting on a narrow run, and cautions. Compose `BannerTitle` and `BannerActions` with kit Buttons; a router link renders through Button's `render`. A banner whose message another live region already announces uses `role="note"`. Banners mount with their condition, without the kit's appear animation, so their text never empties while collapsing. |
| Overview widgets | Cards that float in the empty margin right of the centered conversation and stay put while it scrolls. They never split the view or move the conversation; they show while the view is at least 75rem wide and are otherwise opened from the composer's Overview button. The container query measures the view, not the window. Each figure is a compact kit `Card` titled with an icon and caption, in a fixed order, shown only when it has something to say. A widget with a detail is the trigger of a kit `Popover` that opens beside it; Results and Changes navigate instead. Wrap the Card in the trigger, because Card keeps `onClick` for its stretched overlay, and lay out the title row inside `CardTitle`, whose hidden copy shares its grid cell. |
| `ThinkingSteps` | The conversation's work log: the header folds a step per execution, a running execution is the active step, and each step's nested fold mounts its transcript on first open. |
| `Switch`, `Checkbox` | `Switch` for a setting or option that applies directly. `Checkbox` composes one `CheckboxItem` in its own `CheckboxGroup` for a selection or confirmation; a flat list of choices composes `CheckboxGroup` directly. Both take a plain-text label, so put descriptions beside them. Native checkboxes are not used; schema question choices remain the documented exception. |
| `Card` | Compose Header, Title, Description, Content, Action and Footer slots only when the content needs them. Cards are transparent by default; a surface or boundary must express grouping or selection. |
| `Sidebar` | Compose the copied kit's Provider, Header, Content, Footer, Group and Menu primitives. Use its SearchField and WorkspaceTile for the app sidebar. Keep Corral's routes, virtualized sessions, collapse state and resize ownership. |
| Settings navigation | Use the kit's settings-dialog composition: 13rem grouped icon sidebar with its own title, scrolling section content, close action, and a narrow-screen section selector. |
| `Dialog` | Rise four surface levels above the current context, capped at level 8, with the source shadow and scrim. Preserve close controls, focus trapping/return, unsaved-change handling and narrow-screen scrolling. |
| `Menu`, `Popover`, select popup | Rise two surface levels above the current context, capped at level 8; use a 12px container and 8px inset items. Preserve keyboard navigation, selection, Escape and focus return. |
| Disclosure | Native `<details>` keeps its toggle state, find-in-page and nested folds. The shared theme gives its summary the kit Accordion trigger's look: a trailing chevron that turns when open, muted until hovered or open, control radius. A summary that draws its own marker uses `list-none`. |
| Chip select | `Select variant="chip"` is compact and hugs its value, for choices that sit among compact buttons such as the composer row or the top bar. |
| `Badge`, status and tooltip | Use semantic status roles and concise content. Color supplements text or an accessible name. Tooltips never replace a required label. |
| `ScrollArea` | Keep existing virtualized scrolling, keyboard access, edge fades and stored positions; use the kit's scrollbar treatment. |

Use one primary action per decision context when there is a clear next step. Related actions use secondary or tertiary treatment; low-emphasis actions use ghost. Navigation stays a link. Destructive and media controls are explicit semantic exceptions to the four ordinary treatments.

Legacy Button `default` maps to `primary`, `outline`/`glass` to `tertiary`, and `sm`/`xs` to `compact`. Existing consumers may continue to function, but new code uses the canonical names. `surface`, `raised`, `line`, `text` and `on-accent` are compatibility aliases for background, card, border, foreground and primary-foreground. Use `muted-foreground` for former muted text and `primary` for former green emphasis.

Corral uses Base UI 1.9.0 and Motion 14.1.0, pinned from the kit's declared ranges, with Lucide icons and the kit's shape, size, surface and hover helpers. `DesignKitProvider` applies user-preferred reduced motion at the app and Storybook roots. Next.js routing, PDF support and alternate icon libraries are not imported. Adopt an additional kit component when a real screen needs it, checking its dependencies and interactions first.

Selection inside a list uses the `secondary` Button treatment on the chosen row and `ghost` on the others, with `aria-pressed` or `aria-current`; segmented tabs use the same pair. Corral-specific exceptions are functional, not alternative designs: graph handles and drag geometry, revision-bound Reins/approval commands, virtualized timelines and file/search rows, listbox options inside the request input, sanitized Markdown and isolated artifact previews, and schema question choices whose native disabled fieldset, form name/value and option descriptions are not expressed by the supplied CheckboxItem API. Their surrounding controls and content still compose the kit. Input/Textarea bridges preserve native events, refs and external labels where the kit's string-value InputField API cannot substitute directly.

## Motion and Accessibility

Keep short color, press and disclosure transitions. The button press surface may contract without scaling its text. Respect `prefers-reduced-motion`; no task, error or selected state may depend on animation. Keep forced-color focus indicators and coarse-pointer target support. Preserve keyboard, IME, labels, form errors and the user's current working context.

Avoid unnecessary supplementary labels and explanatory text. Let the layout speak for itself. Remove text that merely repeats what the layout already communicates, while preserving necessary form labels and control names. For example, if a search field already has a "Search" button beside it, you may visually hide a redundant label, but you must preserve the field's accessible name in the code. A clean interface and screen reader support are compatible.

## Do's and Don'ts

- Do compose shared kit components and use semantic tokens for their intended roles.
- Do preserve meaningful status, selected, disabled and recovery states.
- Do keep the source snapshot and Corral adjustments visibly separate.
- Don't introduce a local palette, arbitrary control radius or another primary-button style.
- Don't duplicate descriptions that the layout already makes clear.
- Don't delete accessible names, keyboard behavior or failure-path tests for visual simplicity.
- Don't pin tests to incidental class strings, one exact shadow or repeated pixel measurements. Keep focused interaction, contrast, theme and reflow checks.

## Change and Verification

This is a copy-in migration, not an automatic subscription to the source project. Review source updates against the public component API and this document. Remove compatibility aliases only after their callers are migrated.

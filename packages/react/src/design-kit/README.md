# Design kit source

The user supplied the local `design_kit` project and explicitly authorized copying it into Corral on 2026-10-23. The copied kit determines component appearance and interaction. Corral keeps its product behavior, data boundaries and accessibility; it does not keep a second visual system.

## Canonical entry and source graph

[index.ts](index.ts), exported as `@corral/react/design-kit`, is the canonical product entry. `packages/react/src/ui/*` contains compatibility reexports only. The source tree contains 59 imported component/helper files, including the extracted `WorkspaceTile` and the adapted text-only `ChatMessage`.

- `sidebar.tsx` composes `sidebar-core.tsx`, `sidebar-menu.tsx`, source Button, Tooltip, ScrollArea and shared shape, size, surface, icon, hover and spring helpers. `search-field.tsx` composes SidebarInput.
- Source Card, Badge, Table, InputGroup/InputField, CheckboxGroup, RadioGroup, Switch and Accordion provide product compositions. Card's Next.js Link is a native anchor in Corral.
- Source Tabs, TabsList, TabItem and TabPanel use the existing Base UI Tabs primitive and kit size, shape, surface, spring and fluid-hover helpers. Their component and prop types are exported directly, with no adapter or new dependency.
- Source Slider uses the existing Base UI Slider primitive, Motion and kit shape, size, font-weight and spring helpers. The supplied compact size omits step dots by default; the comfortable default pips variant renders each step.
- Source Dialog, Select and Dropdown own their popup surfaces, nested elevation, layout and motion. MenuItem, dropdown search/submenu helpers and popup helpers complete their graph.
- `ui-provider.tsx`, exported as `DesignKitProvider`, supplies Motion's OS reduced-motion policy and the kit's shape, size and Lucide icon contexts. Corral wraps its app entry with this provider.
- Sidebar integrations use the source shell, labeled groups, nested menu and resize rail. Corral retains routing, drawer and preference state, passing `persist={false}` and `shortcut={null}` to avoid a second owner of application state. The provider exposes controlled width updates and bounds; the rail forwards localized accessible labels and keyboard resizing.

`tokens.css` remains a verbatim copy of `design_kit/styles/tokens.css`, SHA-256 `c227a3aad1d7e861ea6993e4f39d8acfcb10cde3a15bd710fda840fa68febcfd`. Only this CSS snapshot skips formatting. Corral semantic and contrast adjustments live in [theme.css](../theme.css).

## Source adaptations

All imports use package-relative paths instead of the original `@/` alias. TypeScript formatting and import ordering follow Corral. Source timing, hover behavior and spacing remain authoritative.

- Proven wrapped array indices and two-element merge pairs have TypeScript assertions required by `noUncheckedIndexedAccess`. They add no runtime behavior. A radio equality lookup uses `indexOf`.
- Decorative SVGs are marked hidden; narrow lint explanations retain native keyboard scrolling, pointer-gap forwarding to existing operable controls, fixed logo tuple keys, div separator refs and optional cookie persistence. Two redundant source fragments remain unchanged.
- Elevated's default shadow follows the raise (`1 + offset`, capped at the surface level), not the nesting depth: a card nested in a card keeps a top-level card's shadow while its background still steps up, as the source's popups already did with `shadowLevel={3}`. This change was made here and mirrored into the source.
- ToolCallCard has a `row` variant: a group lists its calls as flat rows on a rail under the tool stack instead of raised cards, and a call shown alone keeps its card. This change was made here and mirrored into the source.
- SidebarMenu re-measures when a row's own inline style changes, so a virtualized host that moves rows without resizing them keeps the active and hover backgrounds on the moved row.
- SidebarMenu wraps its decorative hover, active and focus layers in a hidden, boxless list item. This keeps the `ul` structure valid without changing the overlay coordinate system or keyboard rows.
- Button's content container fills the control and inherits its flex alignment so multi-part labels and trailing counts remain correctly arranged. The compatibility bridge supports Base UI render functions and composed refs; source icon/label components retain their own defaults. Destructive actions and media overlays add only their required semantic contrast.
- Dialog exposes actual Base UI change details to consumers before changing state or starting an exit, and respects `details.cancel()`. This preserves settings' nested-popup Escape and IME guards. It also forwards `initialFocus` and `finalFocus` to the primitive.
- Select accepts controlled `open`/`onOpenChange`, supplied display labels, a React-node leading slot/placeholder and popup alignment. Its original selection acknowledgement and animation remain intact. The options bridge uses kit groups and separators for labeled groups and descriptive choices. Descriptions wrap inside content-sized rows in a viewport-bounded popup; plain choices keep their original density. Original-index keys preserve repeated option values.
- MenuItem accepts `labelContent` for existing JSX labels while retaining a text label for typeahead. The Menu bridge composes source rows with Base UI action/radio/checkbox/link behavior and assigns source row indices across groups and fragments.
- `agent-primitives` marks its status glyphs hidden (the status word carries the meaning) and keeps narrow lint explanations for labels set only with an image or progressbar role and for repeatable, static tool-mark keys. Corral passes its own localized status words as labels; the kit's six states choose only the glyph and colour. Inline marks (avatar tiles, tool stacks) take the next surface's background with only the first shadow step's hairline; this change was made here and mirrored into the source.
- AgentTree adds what the run's execution tree needs and the source lacks: `selectedId`/`onSelect` with a stretched card button and `aria-selected` treeitems (selection drawn with `--emphasis`), a per-node `statusLabel`, `detail` slot and `cardProps`, `selectable: false` for a run root, localized `labels` (including the elapsed-time format), cost shown only when some node has one, and needs-you/failed lists without action buttons when `onResolve` is omitted. The card header wraps its status badge when the identity and localized status cannot fit together, in both wide and narrow trees. `summaryExcluded` keeps organizational Run and Loop groups out of agent counts and action summaries. Its treeitems keep a narrow lint explanation because the card button takes focus.
- AgentLanes adds a fixed window (`startAt` with `now`, or with `endAt` so a replay sweeps one window; ticks counted from the start, no fading edge, and the `now` marker placed at the current time while a span is live) for a recorded run, hand-offs that can land mid-span (`toAt`) and, when two overlapping spans hand off at nearly the same moment, turn as rounded elbows in pixels (a trunk beside the span that starts or ends there, shared by simultaneous hand-offs) with a settled stroke in the muted foreground, `selectedTaskId`/`onSelectTask` so a span selects its execution (`aria-pressed`, outlined with `--emphasis`) instead of opening the popover, separate tracks for overlapping spans of one lane (the lane grows to fit them), per-span `statusLabel`, `waits` bands and `buttonProps`, a hand-off `fromAt` with a `data-handoff` hook, and localized `labels`. Live-span and window-caption text use the foreground role for contrast on their tinted fills; the live fill and edge retain the emphasis accent. Iteration callbacks became loops and repeatable static keys keep narrow lint explanations.
- PlanVsActual shows actuals only when no step has a planned start and duration: plan ghosts, forecast bars, the Plan/ETA markers, the overrun band, the verdict badge and the legend are left out, and Cost appears only when a cost is given. It adds localized `labels`, per-step `statusLabel` and `rowProps`, a generated title id instead of the fixed `pva-title`, and finer axis steps for runs of a few seconds. Its list rows keep narrow lint explanations for the source's focusable ARIA list.
- Popup `data-slot` hooks remain available for contextual dismissal, focus and responsive integration. ScrollArea accepts `viewportTabIndex` for existing keyboard navigation.
- ThinkingStepDetails accepts controlled `open`/`onOpenChange`, so the work log mounts an execution transcript only after its fold first opens. Source Step/Details/Sources parts compose observed model requests, tool groups and agent activity; ordinary response text remains in the answer stream. Its timing, layout and other parts remain the source's.
- Tabs retains the source's default segmented appearance, spacing, selected/hover/focus layers, animation and keyboard behavior. Its only adaptations are relative import paths, Corral formatting/import order and a narrow lint explanation that preserves remeasurement when tab children change. No runtime or type-assertion changes were needed.
- TabsSubtle keeps the source's text tabs, hover and selected layers, spring timing and keyboard behavior. Its adaptations are relative imports, Corral formatting/import order, a `Map.values()` loop for the element registry and narrow lint explanations that preserve remeasurement when tab children change.
- Slider retains the supplied styles, spacing, hover, spring timing, defaults and runtime branches. Its adaptations are relative imports, formatting, narrow lint explanations for the existing pointer/keyboard layering and spring synchronization, and erased tuple/index assertions for proven nonempty values, clamped step indices and ResizeObserver entries under `noUncheckedIndexedAccess`.
- ChatMessage imports its text/body/action slots without the unused `File[]` thumbnail branch. Corral's existing authorized artifact preview remains responsible for attachments; no PDF package or external worker is introduced.

- InputMessage keeps the source input surface, content sizing, toolbar and submit animation. `renderInput`, `inputRef`, `contentSlot`, `renderAction` and submit availability labels let the application own slash/reference menus, IME, draft history, attachments and command delivery. The host disables the source automatic queue and shortcut handlers. FileThumbnail keeps local image and generic-file previews without a PDF dependency or remote worker.
- ModelPicker retains the source chip, model rows, short settings row, conditional horizontal Effort tabs, footer text and motion. Base UI owns portal, focus and dismissal. Typed reasoning choices and host labels preserve actual policies and disabled or missing selections; an empty placeholder describes simulation without replacing a saved missing profile. The effort tabs use the foreground token for accessible contrast. Comparative ratings are omitted unless complete measured values are supplied.
- AgentSteering accepts controlled composer, plan, activity and header-action slots, localized labels and actual directive receipt states. Its original plan rows are extracted as `AgentSteeringPlan` with optional title wrapping and accessible status labels, so the existing host plan controller can retain disclosure, owner selection and full-list access. Its optional activity height bound keeps the single composer outside a named keyboard-scrollable activity region on short screens. Corral supplies its existing single composer and command controller. Unsupported instant interruption, directive removal and per-agent pause actions are absent.
- ToolCallCard/ToolCallGroup add waiting and stopped states using the source status glyphs, so an unfinished tool does not animate as running during an approval wait, pause or cancellation. Expanded code uses the foreground token for punctuation contrast; the source grouping, disclosure and code layout remain intact.
- AgentHandoff presents one observed agent pair at a time with factual relationship labels and selectable executions. It does not infer an ordered pipeline from unrelated agents. DecisionTree supports read-only recorded selections, explicit unknown branches and evidence details; inspection cannot invoke a workflow decision or choose a default branch.

## Narrow API bridges

[adapters](adapters) is part of this design kit, not another component library. Button, Badge, Card, Tooltip, Dialog, Select, Menu and ScrollArea compose the copied components. Former visual variant names map onto kit roles; ordinary controls do not reproduce their old rendering.

The following needs have no matching source contract:

- `Input` preserves native input events, input refs, external labels and file inputs. Source InputField instead owns a controlled string value and a container ref. `Textarea` has no standalone counterpart in the supplied kit. These small native controls use the source field hover/focus states and type/shape tokens; their border stays inside the 36px/28px height, and coarse-pointer settings retain 44px targets.
- Generic `Popover` is absent from the source catalog. Its bridge composes Base UI positioning with source Elevated, and a stable `keepMounted` content container preserves the request-options draft. It retains no separate popup visual skin.
- General horizontal/vertical separators and loading skeletons have no standalone source equivalent. Their small primitives consume kit tokens. Inline actions compose source Button.
- Virtualized scroll fades, scroll chaining and hidden scrollbar options preserve product scrolling behavior while using the source ScrollArea and scrollbar appearance.

## Dependencies and verification boundary

The source dependency versions are Base UI 1.9.0 and Motion 14.1.0, alongside Corral's React 19, Tailwind 4 and Lucide. The [Motion npm metadata](https://registry.npmjs.org/motion/14.1.0) declares MIT and React/React DOM 18 or 19 support. The [official MotionConfig contract](https://motion.dev/docs/react-motion-config) documents `reducedMotion="user"`. No alternate icon families, Next.js or PDF dependencies are imported. Dependency records and notices are maintained separately.

Source fingerprints identify copied files and adaptations. Type checks, browser checks and integrated product validation are separate from this provenance record.

## Source fingerprints

Source hashes cover original complete files. The workspace-header hash identifies the file containing the extracted WorkspaceTile; the local hash covers its imported function and imports. ChatMessage's local hash reflects the omitted thumbnail branch. Local hashes record the source after the adaptations above; compatibility bridges and exports are Corral-owned and are not presented as verbatim upstream files.

| Original kit file | Local file | Source SHA-256 | Local SHA-256 |
| --- | --- | --- | --- |
| `components/agent/agent-lanes.tsx` | `components/agent/agent-lanes.tsx` | `1fbc52d64a08481961e4e622d2587946489f36d88e9f8e742a29976989bcfd11` | `abb3377167879f12c2c3fcea169410c00846d0a2bb62d5d91275b0e148c8b6c0` |
| `components/agent/plan-vs-actual.tsx` | `components/agent/plan-vs-actual.tsx` | `f28381dbb228320d029e19d838d034982f92a69d9f92767d7f452efebfdc9be7` | `c7b897f7697cafd259ef7745fa2a0e92a69a31d79a24df59542a323bd09b437a` |
| `components/agent/agent-primitives.tsx` | `components/agent/agent-primitives.tsx` | `2787dab4f79ef2d035158415827e39e42fac9da69851f56c2f91ba5b3dd90efd` | `34a36d31312e446db8806dd9130cfac77fcd7a34203582ab2939db6a652cc3bd` |
| `components/agent/agent-tree.tsx` | `components/agent/agent-tree.tsx` | `b8f3d09ff2f99e360a6c7f2f7bcc346b6ce7a880744050805e04dd4cd69af4af` | `43b2e7120b1acfc294496461c678a9a88029b7050b39f5cacaba2932e948f192` |
| `components/sidebar-app/search-field.tsx` | `components/sidebar-app/search-field.tsx` | `c261fce992cfc8641ca28f5397c9ab63e3f28322d52c01c3bf2559fb6fff9f29` | `0ef8a8eeab34687e095c8630154696cd4b3481074a40058f60455be6ac7a22fa` |
| `components/sidebar-app/workspace-header.tsx` | `components/sidebar-app/workspace-tile.tsx` | `e7c3c4577040cdc64e918c44501aa6580020ef793fc5f022c4f17c63bd48091b` | `043736f783133a69eb4aca94ea98ecbdc71bf59c6b7a8af1d9603b26c6a4bb9a` |
| `components/ui/accordion.tsx` | `components/ui/accordion.tsx` | `28690991b74c84976a1201faada86cc5fa0d9c995d91cee5a2ddcb91589fd427` | `0f29cbfe850db6e2297663cd0bae3fc146f71f81274b3589f708ef256bfda4e1` |
| `components/ui/badge.tsx` | `components/ui/badge.tsx` | `8109fc79fa47e1f66f6987a739d6de2ed5d16b0161a2ee7614e8b2f1ece14b70` | `5ff028aa5b8b37ca4b782a703b992b7319b1058b1ac68eed2a4f7e66d57370e8` |
| `components/ui/banner.tsx` | `components/ui/banner.tsx` | `8a995885f7b1fd5f15dbb32e73b10f5a4961fa7dbe8b6a7c24eec867713c23ae` | `ff9e3bc12d2e6cee13fb52d1f684ed86583457ca13b8b80a8d32c20f21eb7521` |
| `components/ui/button.tsx` | `components/ui/button.tsx` | `d09e67f41be651a64a86178223607ecdb9cb7ad61ea295f650b64e1c18e5fb33` | `d8dd3a41f4bf0af4124fcb9c0ad9fd1409110704f6fd54cf3a22664304b94706` |
| `components/ui/card.tsx` | `components/ui/card.tsx` | `7aa2702e060abd9982428bc0f1e419682721ee61985ed4cb1380bd6bbee66001` | `ef24b2d02a5cdf7234ea37d7feb8688c91f476a478dd534795cd2c635d15c2a9` |
| `components/ui/chat-message.tsx` | `components/ui/chat-message.tsx` | `f1e3db162d72a50fb810a5945d12d61e940437274c3c22e3377002a95cc9e6f5` | `80f785d194f2bb6b90eae52653324141126dac1bff3b0b732c2bd7224e859bbd` |
| `components/ui/checkbox-group.tsx` | `components/ui/checkbox-group.tsx` | `9e78ce7f55a689da31403ddd3dee0ef097a891a378db6c1e4482e7f7b95d1ba3` | `fdbb487723c64277172112311258e5ae3aca2cfc8243e42d34d314398bc0cd8d` |
| `components/ui/dialog.tsx` | `components/ui/dialog.tsx` | `48e3c42bd3814c9be06d28d338512af0cf7f70bbfbb841ce1df046f77fac16c9` | `cd660609a698c145aca84da37d2627898ac4a87d3d06a8c15dcc0aed68ce6aa1` |
| `components/ui/dropdown-search.tsx` | `components/ui/dropdown-search.tsx` | `e84b0aa1573284376c4b00b9670dc548271be9261bfd4862d049e15ee491cbc8` | `fb5f44f978072076d4c6339334dd76812e8f22db81abd6f62a3afde7ac5d9aad` |
| `components/ui/dropdown-sub.tsx` | `components/ui/dropdown-sub.tsx` | `ac4ec9c8ab047dbc4c8b4d9acd749027704b5493bff8a381cbba0fdb3e0719b5` | `1f54483cdb71151b1c4b1e49f23339eb722ddf90414670333cbe46d39f9abb82` |
| `components/ui/dropdown.tsx` | `components/ui/dropdown.tsx` | `d26c8e87075305483d06436d69e753c818a49e7c4666f254a41f9c55dd3fcce4` | `41ebc16a2a316c0fdf0e7a5a8a21374d6e10f570279fe9828e39f0182a97a8f1` |
| `components/ui/fluid-hover-highlight.tsx` | `components/ui/fluid-hover-highlight.tsx` | `e92be34e383a5487d86c0b967060008fe5284c1ca709da60f51b47db4512b94d` | `4fcf7b52773adeaeb3ecbf6a661d11c7b7e976635ab6d394dee724fd06a3516d` |
| `components/ui/input-group.tsx` | `components/ui/input-group.tsx` | `bad1b6da764ece21ac63543f777b06d50f3bf94eb17398414561393f14aaf855` | `a0b126477800b0828b45fc864cee7a736dea2a53df45d2373e6844a13d6074b7` |
| `components/ui/menu-item.tsx` | `components/ui/menu-item.tsx` | `5a337943930b35162d398f5cc96b41c46ec6c97e40b96bcaf50c38f1c2f841f4` | `3c7a2a885a3112e5cda39b8120939ff6d77e045a1300cd7aeac287fb9e88076e` |
| `components/ui/radio-group.tsx` | `components/ui/radio-group.tsx` | `f297a47b6112eb2fca0262ef6e693789726ac143384239413cf0192c7129ef0d` | `af91b2b862f9f4cb6cbf7b2b3d679baf3c33f8bc41b321c6e41744603b85eec0` |
| `components/ui/scroll-area.tsx` | `components/ui/scroll-area.tsx` | `e70d864c77e91e885c546cd9c56f5566f3058f701b4f1f730e5c5ed2c004e9cd` | `54864c042eb48601de005948b10534b4231a3f00fe0afe574a97069af5630b39` |
| `components/ui/select.tsx` | `components/ui/select.tsx` | `55dc23ed45a321fe958bb7e27544484c50ab3381e9662d25778d2ac2d29cca10` | `6c4b0b7da81cccd8906ff1e9d9a28adc33df2da3abb75b076defeed927ee6021` |
| `components/ui/sidebar-core.tsx` | `components/ui/sidebar-core.tsx` | `ba1f2c38e2322ff5cef679e3984e57182298978c85bd98554e9b41fbce5eff38` | `26b3351d1cd7b1e74da0704a2d7ff2b61851d732f2579211260224c0b2089fd7` |
| `components/ui/sidebar-menu.tsx` | `components/ui/sidebar-menu.tsx` | `1bd627a1d98d6506eded990d973a60f4864d3b4a2dc970886a891dedea13204b` | `edba359852eb3aba52d86d6e5d060b78c65c667870b4988fa9dbe7cfa9e9a119` |
| `components/ui/sidebar.tsx` | `components/ui/sidebar.tsx` | `77e0d9e8c40d9bab7522924c2ea8ae9e58393e9e655eb216777b1428be047af0` | `2f0348b2193740e5e1bb71640076122fe25f082fb57e0393d948f96d9270df37` |
| `components/ui/slider.tsx` | `components/ui/slider.tsx` | `02aeebcf96caef2d9cb07647bf410d7b7d8de84a53b173d2f511fd5c85352a23` | `a7a9f1a7f68f538235f996e225749c6540aceef443f06380efcb3ca5337ea5c2` |
| `components/ui/switch.tsx` | `components/ui/switch.tsx` | `68a0fe3e5dd5b30cf21633df824577794ccec67f14f38b8da8b307371b77ebb6` | `672bb716a5270c05906c877562fb4a07fff632d6500e237259a7cb127c3b91ab` |
| `components/ui/table.tsx` | `components/ui/table.tsx` | `0d9426933db7f73c5e7e6579532f1abe1668430892f5b604a24dd34c7b254c51` | `5b63c7b9f9eee8115475558e81aa80ccc0432c826f15bc186e4a61d8fe43b8ab` |
| `components/ui/tabs.tsx` | `components/ui/tabs.tsx` | `03bb6312d0bf95d4f2a9d6441da73c997714562f2c435e77cb51f9a23a381418` | `f311464ec7ab1cb6da0db7c462330fafabcb7ae6559974342644ef3d505be462` |
| `components/ui/tabs-subtle.tsx` | `components/ui/tabs-subtle.tsx` | `33b690831bb70016cffa08dcd413b1437904e7653e414490563955b0b13a1811` | `8021809eff7993c656c15f669e947d9644223afacf724afc46343e8295127052` |
| `components/ui/thinking-steps.tsx` | `components/ui/thinking-steps.tsx` | `8ffe24780dcbfdfa2aa408fb93f50393ff90300f84ec4c4fdac2f53d6f2dfc8d` | `df1fc89a2883924decca6755c565f1546015bde20d45ec2c5b621c5a64369015` |
| `components/ui/tooltip.tsx` | `components/ui/tooltip.tsx` | `ea1e26286b1230db898fef838ef14b8fd4572f84ef50e97bdd481000d57eb21e` | `2b049b7777a3aef7803b5b3e795b01830a11e4707059634f11aab424ee200bf9` |
| `lib/agent-format.ts` | `lib/agent-format.ts` | `c3904e443ac33ba176c2814e71bafbe6d8aa110f0fb2b79cb1a2d7669a032533` | `10cc9fde0f24c3ff6fedfff65676cfea38c20e00d9af0738126242f5d221170b` |
| `lib/agent-logos.tsx` | `lib/agent-logos.tsx` | `a2e567430ca9e37a9207293b513925d1bc8e6c842d9a552e93232d82c7935031` | `d8801c98e97c798686cabc0c0a34e3dcaba361e3071da15f71d4af6c44199a26` |
| `lib/elevated.tsx` | `lib/elevated.tsx` | `04a8060e7c81f2db701f0e3aa1c092740677c7c966da4978ecbb6ecfad831aaa` | `8f50d46a91cd8140968b7a995878b88970cb24cc6f5f38b7edd31d88744d36cd` |
| `lib/focus.ts` | `lib/focus.ts` | `0f371db5adeee47d4ce63db46ede9738c4658f6cf8d5218bf746decf238fbfa5` | `4f813aa1dd686a49d36c0758ba144211fc4e09ea849aa9595926f4fbf138b6fc` |
| `lib/font-weight.ts` | `lib/font-weight.ts` | `b9ed69148ccb3fa30e559418ea9ee1c1e0037389ee177aaacd9d17db0b3d0c46` | `b9ed69148ccb3fa30e559418ea9ee1c1e0037389ee177aaacd9d17db0b3d0c46` |
| `lib/icon-context.tsx` | `lib/icon-context.tsx` | `ffc750f1a404375681a6ed162df394cf6f0aefa92324f4d4c6300ee0488c6ec2` | `c7cbdee16e1bb2fae67278088874c1a15239fc72fa04cdf0180d2f8797e224ec` |
| `lib/omit.ts` | `lib/omit.ts` | `f79dd83821abfbaff48594c13028acb4831526a960293625908cc96e6d4e0195` | `58d407c87801f34b0fcd774ab6c54964a10012c5abb3b98173c4a1bff39a62e8` |
| `lib/popup.ts` | `lib/popup.ts` | `a7f2d12608fe32444f5eadb5fa787c90f4ebb3946e5687f1cad1c1e7ad9a183c` | `17c51c15cfd8c1eb19f1c385ec6cd0ae50b3223f4fcce4c914e28fbb1c6dd70e` |
| `lib/shape-context.tsx` | `lib/shape-context.tsx` | `ab5ff71f50965f56013640c067cf7a56d6ee6e117a091a38b49206d50ff1c632` | `e0be8b3d1c3b732524cbd4741c031da6b1644d419d947b8312c1674ca30af1fc` |
| `lib/size-context.tsx` | `lib/size-context.tsx` | `171715c3314189738f5dadc780821bf33d88269dce27d41862c101e532add6a8` | `d3c6fdbd04f878b7b4f8ab1e0a8d657aed2427c6bd47dcfc7df9f2c1a9fb421c` |
| `lib/springs.ts` | `lib/springs.ts` | `63950cb7e1f9b02eddd2a2afc03c7112e34a874865b8992f640417e9401a5145` | `9ec543541d61c58428f64e0c2ef7b3d698f20c5c8af78f707999d8ce8cbae6cd` |
| `lib/surface-classes.ts` | `lib/surface-classes.ts` | `9fb593b880876fd3fb32f660902a25fa32bbdba935e394ed64e276cff17cb64a` | `78ad952e13b47778a79a39c725eefa78ac0f21217d0ae6edaca54aa1c65591d9` |
| `lib/surface-context.tsx` | `lib/surface-context.tsx` | `1b907ce4803cfdabedeb03d55cf0d68e89f0af01c60d71dd307f39dda6ca4111` | `27fe608413775adca8f3b5fc02c1e90cc990826d969428916e79b69d7ae55798` |
| `lib/type-scale.ts` | `lib/type-scale.ts` | `6859ef24794d647aca3b52f0b364e0e276dec4b0b626b1170e734450a14bc4e9` | `6838252f94b0915eab51d3fe1b44a3d26228f44155aaf9541ebb32636e78c3cb` |
| `lib/ui-provider.tsx` | `lib/ui-provider.tsx` | `67cee54246ce25787342815fded88e9a4c43491ecb807d74be31a07314fbcdcb` | `974aacea8678e35842e0aa3484f9180c3876b7db7b6804d3cc5269c097a10f73` |
| `lib/utils.ts` | `lib/utils.ts` | `a8c801f2b8c1043387a2819eb98ae953177abb986dc91d81f8f1a433a9aeea78` | `f22d09aef40e4b265bc0233edd387f05bbc33cd63f1d05aa5ac5e359570ea5f7` |
| `hooks/use-fluid-hover.ts` | `hooks/use-fluid-hover.ts` | `733a91d9d2fe955b02d7d0f09ea5eaa0ce4d3df2898e84b00b0f69d4fc8f79c1` | `57d0f6f656b61ec69bbc6ddc5b5b3db1d7c1f72408c1d265a1baaa1d221547e3` |
| `hooks/use-keyboard-nav-gate.ts` | `hooks/use-keyboard-nav-gate.ts` | `cb9eb2aee06f158d4504589e17e2a3970b6b9c13dbc3b576e264c9e80cce8416` | `04079436cf40727321f099f54a13f47721f71e74c79d01649f9472c10f984a6e` |
| `hooks/use-merge-split.tsx` | `hooks/use-merge-split.tsx` | `8682fb689788cd01694d1470c18a3397589e12d1916c73d8d87365883cf23e7b` | `2acbdfb68ce8e91205f1a04fca42fbe617752f296643f69d65833b830796a9e8` |
| `hooks/use-touch-primary.tsx` | `hooks/use-touch-primary.tsx` | `b8083bab321fa67a285d35a6ed5f0e5cb68eef706c7d33f0c992dad5e3945e4e` | `e523fdcf4062422735c93f727e9cd89417cf08313cf35a727702e1dd4e1339f1` |
| `hooks/use-now.ts` | `hooks/use-now.ts` | `90d99f3382c55ba79277be776e3cb55a37d745e7daf699f663fb5fb4f40737c6` | `9eefdc52d4b7b3955726631276547b1bbb04157416b172a1d7552d248eaab199` |

| `components/agent/agent-handoff.tsx` | `components/agent/agent-handoff.tsx` | `f5d59982e3fe201273a3f3f8c688b12a6751211779a7c32475c1f47e5691d729` | `c59f8eecad08e43a268a2f6d5cf68a572ebd5a90ca7849f3420880fa2322dd68` |

| `components/agent/agent-steering.tsx` | `components/agent/agent-steering.tsx` | `1165b5bc851c52339289d38c217394be65a50169d1b151755b74d5304b96e60c` | `c53498be6a2026a5a6ec3b4b65507f20510189202f95ddc71defd899bfa16d6d` |

| `components/agent/decision-tree.tsx` | `components/agent/decision-tree.tsx` | `84e3db63cf9e0cae2f60bdb0ae8d5ee1fc6e2ec474100b5a30eeeeb0c126bf12` | `45dfb23f04cefb542288c4543cfb0fb0e4397c75ac55cebbd5b8b561ac730efb` |

| `components/agent/model-picker.tsx` | `components/agent/model-picker.tsx` | `900d1a0c043838c3da8f96de73e1ecccd871fbf96f4b1b0b7d981582e355d1de` | `264b1d6f2d66f996eb3bb0954a2aaee750c5228d9062812fc9208e3505af191d` |

| `components/agent/tool-call-card.tsx` | `components/agent/tool-call-card.tsx` | `d4977b1f860a939ff10d71f4b8b1cb68b574a25b427c87e19820fd966cf42d16` | `e746b066db8b8843bfd7771740e098de9e804c703e9607d7c6520a26924ddbb1` |

| `components/ui/input-message.tsx` | `components/ui/input-message.tsx` | `a3d34f34dd98919b828244324e53167978bd63f3aad727e1eb2f85f01a59d15b` | `2ac9009b91c568d576fbbf1865b492168ef76f56855d0ee5d6d1c924aa4acb04` |

| `components/ui/file-thumbnail.tsx` | `components/ui/file-thumbnail.tsx` | `6c59cb759becc33e6f318cc31e3c533fb02b96ab79fc3bbc035e4f35c1a2be74` | `b553ae97fca9b6079b83e6ff985f2dfb6293c3386ca4f3b133ed558e4657c672` |

The supplied kit has no source license or notice file; no license has been inferred. Existing dependency licenses and notices remain in place. [DESIGN.md](../../../../DESIGN.md) owns the active design rules and adoption mappings. Future kit updates refresh these fingerprints and run the affected integration checks.

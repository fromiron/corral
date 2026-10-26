# Design kit source

The user supplied the local `design_kit` project and explicitly authorized copying it into Corral on 2026-10-23. The copied kit determines component appearance and interaction. Corral keeps its product behavior, data boundaries and accessibility; it does not keep a second visual system.

## Canonical entry and source graph

[index.ts](index.ts), exported as `@corral/react/design-kit`, is the canonical product entry. `packages/react/src/ui/*` contains compatibility reexports only. The source tree contains 43 imported component/helper files, including the extracted `WorkspaceTile` and the adapted text-only `ChatMessage`.

- `sidebar.tsx` composes `sidebar-core.tsx`, `sidebar-menu.tsx`, source Button, Tooltip, ScrollArea and shared shape, size, surface, icon, hover and spring helpers. `search-field.tsx` composes SidebarInput.
- Source Card, Badge, Table, InputGroup/InputField, CheckboxGroup, RadioGroup, Switch and Accordion provide product compositions. Card's Next.js Link is a native anchor in Corral.
- Source Dialog, Select and Dropdown own their popup surfaces, nested elevation, layout and motion. MenuItem, dropdown search/submenu helpers and popup helpers complete their graph.
- `ui-provider.tsx`, exported as `DesignKitProvider`, supplies Motion's OS reduced-motion policy and the kit's shape, size and Lucide icon contexts. Corral wraps its app entry with this provider.
- Sidebar integrations retain routing, resize, drawer and preference state. They pass `persist={false}` and `shortcut={null}` to avoid a second owner of application state.

`tokens.css` remains a verbatim copy of `design_kit/styles/tokens.css`, SHA-256 `b96f55b7be7b8247946fa297d431fb486b83872a060b202182f08e67c03bb4d0`. Only this CSS snapshot skips formatting. Corral semantic and contrast adjustments live in [theme.css](../theme.css).

## Source adaptations

All imports use package-relative paths instead of the original `@/` alias. TypeScript formatting and import ordering follow Corral. Source timing, hover behavior and spacing remain authoritative.

- Proven wrapped array indices and two-element merge pairs have TypeScript assertions required by `noUncheckedIndexedAccess`. They add no runtime behavior. A radio equality lookup uses `indexOf`.
- Decorative SVGs are marked hidden; narrow lint explanations retain native keyboard scrolling, pointer-gap forwarding to existing operable controls, fixed logo tuple keys, div separator refs and optional cookie persistence. Two redundant source fragments remain unchanged.
- SidebarMenu wraps its decorative hover, active and focus layers in a hidden, boxless list item. This keeps the `ul` structure valid without changing the overlay coordinate system or keyboard rows.
- Button's content container fills the control and inherits its flex alignment so multi-part labels and trailing counts remain correctly arranged. The compatibility bridge supports Base UI render functions and composed refs; source icon/label components retain their own defaults. Destructive actions and media overlays add only their required semantic contrast.
- Dialog exposes actual Base UI change details to consumers before changing state or starting an exit, and respects `details.cancel()`. This preserves settings' nested-popup Escape and IME guards. It also forwards `initialFocus` and `finalFocus` to the primitive.
- Select accepts controlled `open`/`onOpenChange`, supplied display labels, a React-node leading slot/placeholder and popup alignment. Its original selection acknowledgement and animation remain intact. The options bridge uses kit groups and separators for labeled groups and descriptive choices. Descriptions wrap inside content-sized rows in a viewport-bounded popup; plain choices keep their original density. Original-index keys preserve repeated option values.
- MenuItem accepts `labelContent` for existing JSX labels while retaining a text label for typeahead. The Menu bridge composes source rows with Base UI action/radio/checkbox/link behavior and assigns source row indices across groups and fragments.
- Popup `data-slot` hooks remain available for contextual dismissal, focus and responsive integration. ScrollArea accepts `viewportTabIndex` for existing keyboard navigation.
- ThinkingStepDetails accepts controlled `open`/`onOpenChange`, so the work log mounts an execution transcript only after its fold first opens. Its timing, layout and other parts remain the source's.
- ChatMessage imports its text/body/action slots without the unused `File[]` thumbnail branch. Corral's existing authorized artifact preview remains responsible for attachments; no PDF package or external worker is introduced.

## Narrow API bridges

[adapters](adapters) is part of this design kit, not another component library. Button, Badge, Card, Tooltip, Dialog, Select, Menu and ScrollArea compose the copied components. Former visual variant names map onto kit roles; ordinary controls do not reproduce their old rendering.

The following needs have no matching source contract:

- `Input` preserves native input events, input refs, external labels and file inputs. Source InputField instead owns a controlled string value and a container ref. `Textarea` has no standalone counterpart in the supplied kit. These small native controls use the source field hover/focus states and type/shape tokens; their border stays inside the 36px/28px height, and coarse-pointer settings retain 44px targets.
- Generic `Popover` is absent from the source catalog. Its bridge composes Base UI positioning with source Elevated, and a stable `keepMounted` content container preserves the request-options draft. It retains no separate popup visual skin.
- General horizontal/vertical separators and loading skeletons have no standalone source equivalent. Their small primitives consume kit tokens. Inline actions compose source Button.
- Virtualized scroll fades, scroll chaining and hidden scrollbar options preserve product scrolling behavior while using the source ScrollArea and scrollbar appearance.

## Dependencies and verification boundary

The source dependency versions are Base UI 1.9.0 and Motion 14.1.0, alongside Corral's React 19, Tailwind 4 and Lucide. The [Motion npm metadata](https://registry.npmjs.org/motion/14.1.0) declares MIT and React/React DOM 18 or 19 support. The [official MotionConfig contract](https://motion.dev/docs/react-motion-config) documents `reducedMotion="user"`. No alternate icon families, Next.js or PDF dependencies are imported. Dependency records and notices are maintained separately.

The imported source and bridges pass the React package typecheck. Browser results and the bounded integrated checks are separate from these source fingerprints.

## Source fingerprints

Source hashes cover original complete files. The workspace-header hash identifies the file containing the extracted WorkspaceTile; the local hash covers its imported function and imports. ChatMessage's local hash reflects the omitted thumbnail branch. Local hashes record the source after the adaptations above; compatibility bridges and exports are Corral-owned and are not presented as verbatim upstream files.

| Original kit file | Local file | Source SHA-256 | Local SHA-256 |
| --- | --- | --- | --- |
| `components/sidebar-app/search-field.tsx` | `components/sidebar-app/search-field.tsx` | `c261fce992cfc8641ca28f5397c9ab63e3f28322d52c01c3bf2559fb6fff9f29` | `0ef8a8eeab34687e095c8630154696cd4b3481074a40058f60455be6ac7a22fa` |
| `components/sidebar-app/workspace-header.tsx` | `components/sidebar-app/workspace-tile.tsx` | `b0a11e2c1a76e93beafce0cc7fa1008ae910917ee4d776c4703de86e311600c1` | `95fa0fb9d4af781b9769e912ec01c4c965aadde9556a1a95a6ef59b8ca6d7add` |
| `components/ui/accordion.tsx` | `components/ui/accordion.tsx` | `df243622f1cdd6da26146313cb9d4077830b039d575740b5a442b3552daf0ce7` | `e5268aa2e9d731054a3f8ed1ba2bcffb52fc1c17c620ded9beb93f7768a51eb6` |
| `components/ui/badge.tsx` | `components/ui/badge.tsx` | `8109fc79fa47e1f66f6987a739d6de2ed5d16b0161a2ee7614e8b2f1ece14b70` | `5ff028aa5b8b37ca4b782a703b992b7319b1058b1ac68eed2a4f7e66d57370e8` |
| `components/ui/banner.tsx` | `components/ui/banner.tsx` | `228c8aef29f45b1df6e1309a5cab6bc3c8c6e544d13fc735f695cb828a871f58` | `3bfd57e867f90e052295664c7d6d9ea82352e212b54b8abea740ab616368cde9` |
| `components/ui/button.tsx` | `components/ui/button.tsx` | `7b04016d46ec44492ff60e59678ee7e0b86de1cebafb6911df5626498f7f1d64` | `a9499332557c4bfac819539ad8228407cc2ca5eb842364a50ff08be69e0a0022` |
| `components/ui/card.tsx` | `components/ui/card.tsx` | `9dc46d2a73d0074c74c9ec80f0445aaf9ff68b8858b2d06cf9d483b7b1d1a173` | `ba72aa78cc726d3a72ce894a399b9a010d172a12313ed3f061a854d5cd7cc032` |
| `components/ui/chat-message.tsx` | `components/ui/chat-message.tsx` | `d730eaf53c185da8f51fc329654839b31af9c90a3e54ea16d8799b9ce3d65079` | `72c3c1f4f9209e0acb28e67389bddae69be4c962a37e0470371024de9a60df31` |
| `components/ui/checkbox-group.tsx` | `components/ui/checkbox-group.tsx` | `5395b5fc2bae74b1f466c2ed46c4cb236ac4507a3931db0738a5a66764ec1f39` | `3661313ff94a10140a87c7fdd995f2687f24f9557503c3d789c73525bd3931e1` |
| `components/ui/dialog.tsx` | `components/ui/dialog.tsx` | `48e3c42bd3814c9be06d28d338512af0cf7f70bbfbb841ce1df046f77fac16c9` | `cd660609a698c145aca84da37d2627898ac4a87d3d06a8c15dcc0aed68ce6aa1` |
| `components/ui/dropdown-search.tsx` | `components/ui/dropdown-search.tsx` | `14fd6131a36d783c48fa02af16252a23bdcddd0a19e3a910e20a856bf93d02cf` | `36de74aa5d05e1a9b328e0d3b9a0027203bc329be0912b6ecdfdd853d99a8d52` |
| `components/ui/dropdown-sub.tsx` | `components/ui/dropdown-sub.tsx` | `ac4ec9c8ab047dbc4c8b4d9acd749027704b5493bff8a381cbba0fdb3e0719b5` | `1f54483cdb71151b1c4b1e49f23339eb722ddf90414670333cbe46d39f9abb82` |
| `components/ui/dropdown.tsx` | `components/ui/dropdown.tsx` | `a78c5b7e5fd0aa9d40df325e5b3e6c415488b4f7932b007bda41f09c01f69e95` | `4f1ff79a7a9192f6e6159df069a864de2f560d97cd78764d38aea46c81ec0713` |
| `components/ui/fluid-hover-highlight.tsx` | `components/ui/fluid-hover-highlight.tsx` | `f6aa00612bccbb18961540cda250338aa9611d9ad6936fe6da9fc05e6939a83a` | `ea592a09bb4daeef076fc22d5c251f09a1f21196971770595f516c9bd1446580` |
| `components/ui/input-group.tsx` | `components/ui/input-group.tsx` | `bad1b6da764ece21ac63543f777b06d50f3bf94eb17398414561393f14aaf855` | `a0b126477800b0828b45fc864cee7a736dea2a53df45d2373e6844a13d6074b7` |
| `components/ui/menu-item.tsx` | `components/ui/menu-item.tsx` | `433911dc282bf1255accfc46bdbdbb35d2ade9591430253fca2d7e19a12597c1` | `1b2d515e82e067126520d14b943106c8a079e40109e5ce471d2c24309d03fb56` |
| `components/ui/radio-group.tsx` | `components/ui/radio-group.tsx` | `69b142efafd6bd0e7278bbbd58b62ac8b9bcfdfeac94d8ce93b6ddf2a2aa30d7` | `fc0d945c2b02b8b764310b43bc84a26c835dcc1acda44b5a6378810b4a65fcca` |
| `components/ui/scroll-area.tsx` | `components/ui/scroll-area.tsx` | `8e04e8e711896d122bbf7517cde94c25972e8538df03578df2effcb086b0d468` | `1c3a03cde8a5a8100f46ea28c7ab778f8901d728cac42f4839a341249a7853ed` |
| `components/ui/select.tsx` | `components/ui/select.tsx` | `0639a8319667cb95a0394013de342d2415a29630664339e4027c3fd5da206868` | `bd8921dfa26a1183c80d262bb07f1509feb21302a0ce6e4f08b6c48e742a3549` |
| `components/ui/sidebar-core.tsx` | `components/ui/sidebar-core.tsx` | `400b652251c76523e986a4cb63ccd24c1a6aec711272b2450130a36c6eba2ee1` | `5f2a8fb41a32244608c4a158e02af9b1e9601debe98a1ba23b964e4c47d8994c` |
| `components/ui/sidebar-menu.tsx` | `components/ui/sidebar-menu.tsx` | `133ccab25657a153b4590e7808bffad03ff6ddb005c7e10d2b480c3ecde859d0` | `dd83e2cb06fa0f376bf7f1343f34eb97098f9cc6db47a8c97a425298c591898b` |
| `components/ui/sidebar.tsx` | `components/ui/sidebar.tsx` | `402bd8d5b593460bd00d116758fdc7d7491bd6109bfec5c4cfc173fa807fd469` | `c0efb309a5ce51ffd39a5fbdf1749b833fa16ebaf134ab2f4a7169c59e20ec6d` |
| `components/ui/switch.tsx` | `components/ui/switch.tsx` | `7dc6ea276d9a3160bb831c81011dd5b1c32d458574370e447591adeff0387dc6` | `81042dff28be44a31707045d87915653d822335a38c78c7e42514c6f8a90334a` |
| `components/ui/table.tsx` | `components/ui/table.tsx` | `06c8f0ff67776454b3d4b1ab85d2782606f8324c386baf2211e73db70eab785f` | `dc9a729696e6ca5845afe5807493c59da55cae78d00f5198e4ca6643253d9e08` |
| `components/ui/thinking-steps.tsx` | `components/ui/thinking-steps.tsx` | `394e5188ff0e1b2d143d3268aae6a5632d29bf934213c273c8fe58ad50388ee3` | `9b341706508f5de0a5db61cc69182c7583b6b4c3a73cf4ec18d8febd6e4ed67e` |
| `components/ui/tooltip.tsx` | `components/ui/tooltip.tsx` | `bd7e0fef5ebff19d31a20ed49dd08750608996b28fd42fb7808038932b17005b` | `262302c99f0552c3ae7a45f30030c4eac8f22078955c10abeb9d0e500e1f6d30` |
| `lib/elevated.tsx` | `lib/elevated.tsx` | `96ffaa93dc22fc2e23b208d47c359d05a70c072c936c28f5a69f728d17fd11ec` | `fa96d671a249c20a560245668168fbad26fc07d17da5de294f9436757a921102` |
| `lib/font-weight.ts` | `lib/font-weight.ts` | `b9ed69148ccb3fa30e559418ea9ee1c1e0037389ee177aaacd9d17db0b3d0c46` | `b9ed69148ccb3fa30e559418ea9ee1c1e0037389ee177aaacd9d17db0b3d0c46` |
| `lib/icon-context.tsx` | `lib/icon-context.tsx` | `ffc750f1a404375681a6ed162df394cf6f0aefa92324f4d4c6300ee0488c6ec2` | `c7cbdee16e1bb2fae67278088874c1a15239fc72fa04cdf0180d2f8797e224ec` |
| `lib/omit.ts` | `lib/omit.ts` | `f79dd83821abfbaff48594c13028acb4831526a960293625908cc96e6d4e0195` | `58d407c87801f34b0fcd774ab6c54964a10012c5abb3b98173c4a1bff39a62e8` |
| `lib/popup.ts` | `lib/popup.ts` | `a7f2d12608fe32444f5eadb5fa787c90f4ebb3946e5687f1cad1c1e7ad9a183c` | `17c51c15cfd8c1eb19f1c385ec6cd0ae50b3223f4fcce4c914e28fbb1c6dd70e` |
| `lib/shape-context.tsx` | `lib/shape-context.tsx` | `afadceadc23a8b23615503943cb14868a6815e48c67668535afbc839a6c5b9fc` | `dc6edddcffc3f6b3542085cb16430b3bb4e84f62c167d379a0aa42f8e6f8cfba` |
| `lib/size-context.tsx` | `lib/size-context.tsx` | `171715c3314189738f5dadc780821bf33d88269dce27d41862c101e532add6a8` | `d3c6fdbd04f878b7b4f8ab1e0a8d657aed2427c6bd47dcfc7df9f2c1a9fb421c` |
| `lib/springs.ts` | `lib/springs.ts` | `63f37a9b692d9fcbb806f36774973259ccfe47854cfc1ef278a3c9159e1af65f` | `4962fec75e920a0b993e241854f55c9d0d4360461a7fdd42a4aae5b40166f78b` |
| `lib/surface-classes.ts` | `lib/surface-classes.ts` | `9fb593b880876fd3fb32f660902a25fa32bbdba935e394ed64e276cff17cb64a` | `78ad952e13b47778a79a39c725eefa78ac0f21217d0ae6edaca54aa1c65591d9` |
| `lib/surface-context.tsx` | `lib/surface-context.tsx` | `1b907ce4803cfdabedeb03d55cf0d68e89f0af01c60d71dd307f39dda6ca4111` | `27fe608413775adca8f3b5fc02c1e90cc990826d969428916e79b69d7ae55798` |
| `lib/type-scale.ts` | `lib/type-scale.ts` | `6859ef24794d647aca3b52f0b364e0e276dec4b0b626b1170e734450a14bc4e9` | `6838252f94b0915eab51d3fe1b44a3d26228f44155aaf9541ebb32636e78c3cb` |
| `lib/ui-provider.tsx` | `lib/ui-provider.tsx` | `67cee54246ce25787342815fded88e9a4c43491ecb807d74be31a07314fbcdcb` | `974aacea8678e35842e0aa3484f9180c3876b7db7b6804d3cc5269c097a10f73` |
| `lib/utils.ts` | `lib/utils.ts` | `a8c801f2b8c1043387a2819eb98ae953177abb986dc91d81f8f1a433a9aeea78` | `f22d09aef40e4b265bc0233edd387f05bbc33cd63f1d05aa5ac5e359570ea5f7` |
| `hooks/use-fluid-hover.ts` | `hooks/use-fluid-hover.ts` | `733a91d9d2fe955b02d7d0f09ea5eaa0ce4d3df2898e84b00b0f69d4fc8f79c1` | `57d0f6f656b61ec69bbc6ddc5b5b3db1d7c1f72408c1d265a1baaa1d221547e3` |
| `hooks/use-keyboard-nav-gate.ts` | `hooks/use-keyboard-nav-gate.ts` | `cb9eb2aee06f158d4504589e17e2a3970b6b9c13dbc3b576e264c9e80cce8416` | `04079436cf40727321f099f54a13f47721f71e74c79d01649f9472c10f984a6e` |
| `hooks/use-merge-split.tsx` | `hooks/use-merge-split.tsx` | `bcbfa99752cd515f98e0640578f3cf44385820345ae5453e03e34b5b9cdae37c` | `05a2c9b4a34ff3dd1e26dd362a60bd3a993f8daa05f9b73881ff7539cef162de` |
| `hooks/use-touch-primary.tsx` | `hooks/use-touch-primary.tsx` | `b8083bab321fa67a285d35a6ed5f0e5cb68eef706c7d33f0c992dad5e3945e4e` | `e523fdcf4062422735c93f727e9cd89417cf08313cf35a727702e1dd4e1339f1` |

The supplied kit has no source license or notice file; no license has been inferred. Existing dependency licenses and notices remain in place. [DESIGN.md](../../../../DESIGN.md) owns the active design rules and adoption mappings. Future kit updates refresh these fingerprints and run the affected integration checks.

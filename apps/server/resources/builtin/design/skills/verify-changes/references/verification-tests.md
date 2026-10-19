# Verification tests

Use these tests as structured questions rather than aesthetic absolutes. Mark
untested conditions as `unknown`.

Read only the tests that apply to the declared scope. In targeted
verification, run the tests the change affects and record the others as
`out-of-scope`; in release verification, classify every baseline test.

## 1. Deletion test

For every removable section, component, sentence, image, animation, and token:

1. remove or hide it in a reversible branch;
2. repeat the primary task;
3. identify any lost evidence, context, state, identity, or access cue;
4. retain it only when the loss is material.

A vague preference such as “it feels premium” is not sufficient evidence by
itself. Record the specific communication or business requirement.

## 2. Substitution test

Temporarily replace the subject's name with an unrelated product or
organization. Flag copy, imagery, or structure that remains equally plausible.

This is a specificity heuristic, not proof of AI generation. Some conventional
language is necessary; judge whether it still conveys decision-relevant facts.

## 3. Semantic or unstyled-structure test

Inspect the document order and accessible structure without relying on visual
position, color, shape, or animation. Confirm:

- headings form a meaningful hierarchy;
- lists and tables represent actual relationships;
- controls have persistent names;
- links describe their destination or purpose in context;
- status and errors are programmatically available;
- source order remains understandable.

Disabling all CSS is a useful diagnostic, but it is not itself a standards
requirement or a complete semantic test.

## 4. Glance-hierarchy test

At a brief glance or with the page visually blurred, verify that the primary
identity, task, and next action remain distinguishable. Do not use this test to
judge text readability, semantics, or accessibility.

## 5. Primary-task test

Execute the declared primary task from entry to success. Record:

- starting state;
- required actions;
- decision points;
- errors and recovery;
- completion evidence;
- unnecessary detours.

A five-second impression test may assess initial orientation, but it cannot
prove task success.

## 6. Growth test

Model a realistic larger state, such as ten times more posts, projects,
products, filters, error cases, or navigation items. Confirm the existing
schema and dominant layout grammar still work, or document a deliberate
boundary.

## 7. Reflow test

At the project's target accessibility baseline, verify that content and
functionality reflow without loss or unintended two-dimensional scrolling,
except where two-dimensional presentation is essential. Record viewport, zoom,
text-size, browser, and exceptions.

## 8. Keyboard and focus test

Use the keyboard to operate every interactive path in scope. Confirm:

- all required controls are reachable and operable;
- focus order follows the task;
- focus remains visible and is not obscured;
- no keyboard trap exists;
- overlays return focus appropriately;
- hover-only content has an equivalent path.

## 9. Reduced-motion test

Enable the platform's reduced-motion preference and exercise every retained
motion pattern. Remove, reduce, or replace nonessential movement while
preserving state and task feedback.

## 10. Provenance test

Trace every material customer name, quote, metric, award, result, price,
capability, case study, screenshot, and image to an approved source. Mark
expiry-sensitive facts and confidential or prohibited material.

A generated or mock image may be used when clearly disclosed for illustration;
it must not be presented as proof that a real product capability exists.

## 11. Assistive-technology sampling

Where required by the project, sample supported screen-reader and other
assistive-technology paths. Record software, version, browser, input, task, and
result. Do not generalize a single successful path into complete conformance.

## 12. Before-and-after comparison

Compare task steps, required information, failure recovery, accessibility
signals, visual variants, content volume, and page weight when those metrics
are available. Prefer measurable differences, but preserve qualitative
observations with clear evidence labels.

## 13. Nested-radius coherence test

When rounded surfaces are nested or their radius, padding, gap, border, or
surface treatment changed:

1. classify each pair as a shared contour, independent component, or pill or
   circle;
2. for a shared contour, repeat the declared one-step semantic-token check or
   measured concentric-offset calculation;
3. compare before and after screenshots at representative viewports;
4. confirm that the change did not clip focus, content, targets, or states;
5. record exceptions and their communication evidence.

Do not pass this check from a token count alone. Mark it not applicable only
when no nested rounded relationship exists in scope.

## 14. Semantic spacing and responsive container test

When spacing tokens, page padding, width constraints, or responsive layout
changed:

1. identify the project's spacing scale, breakpoints, and container tokens;
2. classify changed values as content gap, section gap, container padding, or a
   documented exception;
3. compare representative wide and narrow viewports;
4. verify that grouping and task order remain clear while overflow and
   desktop-sized empty regions are avoided;
5. confirm that an explicit container owns each page-edge and width constraint;
6. record any raw or one-off values and the reason they remain.

Do not require a universal spacing scale, breakpoint, or pixel value. Mark
missing responsive evidence as `unknown`.

## 15. Typography context test

When typography roles, fonts, letter spacing, line height, or text measures
changed:

1. record the actual typeface and fallback, script and language, size, weight,
   role, letter spacing, line height, and line length;
2. compare the implementation with project-owned typography tokens;
3. render representative single- and multi-line content at target viewports;
4. inspect clipping, overlap, wrapping, fallback substitution, and reading
   density with explicit evidence;
5. run applicable text-resize and user-applied text-spacing accessibility tests
   separately.

Do not use another design system's letter-spacing or line-height table as a
universal pass/fail threshold. A difference without project or rendered
evidence is not a defect.

## 16. Token proposal artifact test

When a shared token system or token documentation page was proposed:

1. verify that every semantic token maps to declared primitive tokens or an
   explicit responsive, language, or theme mapping;
2. confirm that exact proposed names and values, current-to-proposed mappings,
   retained exceptions, evidence, and adoption status are present;
3. trace every normalized numeric proposal to inspected project or rendered
   evidence and reject a convenient scale invented only to fill the page; in a
   new-system proposal, confirm that each new value is labeled a design
   hypothesis with a rationale and that undecided contexts stay open;
4. reject unresolved template placeholders; use an explicit `unknown` entry
   when evidence is missing;
5. confirm that the single HTML artifact has no external runtime dependencies
   or network requests;
6. inspect headings, table captions, keyboard focus, wide and narrow reflow,
   reduced motion, and print output;
7. confirm that the artifact labels recommendations as proposals rather than
   adopted project standards, and design hypotheses as hypotheses rather than
   existing values or measurements;
8. confirm that the proposal files were requested; an audit alone does not
   require them.

Do not approve the artifact merely because its token tables are complete.
Rendered specimens and project-owner adoption remain separate requirements.

## 17. Affordance-mapping test

When visual treatment or interaction behavior changed:

1. inventory repeated visual treatments and their locations;
2. record the role a user is likely to perceive from each treatment;
3. operate or inspect the actual behavior through keyboard, pointer, and touch
   paths that are in scope;
4. flag inert content that appears operable and materially different actions
   that create the same false expectation;
5. verify state, accessible name, role, and feedback separately;
6. record evidence-backed exceptions.

Do not require every action to look different. Compatible behavior and priority
should reuse a shared treatment.

## 18. Action-hierarchy test

For each decision context that changed:

1. state the user decision and task stage;
2. identify the primary action when a default next step exists;
3. list secondary and destructive actions;
4. when no primary exists or actions are genuinely equal, record the product
   evidence and reason;
5. compare visual prominence, source order, focus order, and accessible names;
6. run the glance-hierarchy and primary-task tests on the group.

Do not treat a whole page as one decision context when it contains independent
records or tool groups.

## 19. Action-visibility and disclosure test

For every primary, frequent, recovery, destructive, or otherwise important
action that changed:

1. classify it as persistent, contextual, disclosed, or unavailable;
2. count the steps and conditions needed to reach it;
3. inspect available-space and responsive evidence;
4. record the reason for disclosure or hiding;
5. verify an adequate discoverable path where one is required;
6. test keyboard, touch, zoom, and error-recovery access;
7. label frequency or importance as inferred unless supported by research,
   analytics, or product requirements.

Existence inside an overflow menu is not by itself a pass or a failure.

## 20. Grouping-cue test

When containers, borders, cards, alignment, or spacing changed:

1. state the relationship being communicated;
2. inventory proximity, alignment, similarity, and container cues before and
   after;
3. remove the strongest cue reversibly and repeat the scan, task, growth, and
   reflow tests;
4. retain a container when it communicates a boundary, state, interaction,
   repeated record, error scope, or another task need;
5. confirm source order, focus, and hit areas remain correct.

A borderless result does not pass when the relationship becomes ambiguous.

## 21. Design-system lifecycle and adoption test

When a design-system migration or adoption plan is in scope:

1. inventory current components, tokens, exceptions, and representative live
   usages;
2. identify authoritative surfaces and owners by contract dimension;
3. inspect the contribution, review, versioning, changelog, and consumer
   communication paths;
4. trace each legacy component or token to a target, status, owner, exception,
   and migration note;
5. verify that old and new systems may coexist only under explicit bounded
   rules;
6. confirm a roadmap and measurable deprecation gate exist;
7. sample one consumer migration and verify the target component's current
   behavior and accessibility rather than assuming the migration repairs it.

Do not require a central team, ambassador program, or a single migration
strategy. Require reviewable ownership and convergence.

# Component contract rules

## Project ownership first

Use the project's established design library, documentation, code, tokens,
platform constraints, and decision records before consulting an external design
system. External systems can supply questions and documentation patterns; they
do not establish this project's variants, dimensions, names, behavior, or
organizational model.

Record one source-of-truth declaration:

- authoritative surface;
- location;
- accountable owner;
- contribution or change process;
- deprecation path;
- review trigger.

When the project intentionally shares authority, define which surface owns each
dimension instead of writing only `shared`.

## Purpose and selection

A component needs:

- a task or communication purpose;
- conditions for using it;
- conditions for selecting another component;
- priority relative to adjacent actions or information;
- composition rules when repeated or nested.

Do not create a variant only to reproduce a visual difference. A variant should
communicate priority, state, content type, behavior, platform need, or identity.

## Anatomy

For every part record:

- name;
- `required`, `optional`, or `conditional`;
- semantic or interaction role;
- dependency on another part;
- content constraints;
- evidence state.

A part is not optional merely because a design tool property can hide it.
Determine whether the user's task, accessible name, status, or recovery depends
on it.

## State coverage

Define applicable states from behavior rather than from a universal checklist.
For each applicable state record:

- trigger;
- visual change;
- behavioral change;
- accessible representation or announcement;
- exit or recovery path;
- evidence source;
- pass, fail, or unknown.

Pointer hover does not replace focus-visible. Color does not replace text,
shape, semantics, or status messaging when those are required. A disabled state
needs a reason and an alternative path when the user still must complete the
task.

## Content and localization

Test representative content, not only ideal labels:

- shortest and longest supported labels;
- multiple scripts and language expansion;
- multiline wrapping;
- truncation and full-value access;
- empty and missing values;
- helper, error, status, and limit text;
- dates, numbers, currencies, and bidirectional text when relevant.

Write content rules as constraints and examples. Do not silently solve overflow
by reducing text below the accessibility baseline or removing necessary
information.

## Responsive and input behavior

Record what changes at each project-relevant condition:

- width or container;
- input modality;
- orientation;
- zoom or text enlargement;
- reduced motion;
- contrast or theme preference;
- virtual keyboard or safe area when relevant.

Responsive behavior may change layout, order, density, width, or presentation.
It must preserve the primary task, meaningful order, status, and recovery.

## Semantic color and iconography

Use project semantic token names rather than raw values when a token exists.
Record theme mappings and required contrast separately.

For icons record:

- semantic name and meaning;
- source family;
- style and optical treatment;
- size role and interactive target;
- text alternative or accessible name;
- whether the icon is decorative, supporting, or the sole label.

When an icon and text form one label or control, inspect their optical weight,
baseline, spacing, and state treatment together. Do not force arithmetic equality
when the glyph's visual mass requires optical correction.

Do not copy another system's color scale, icon grid, stroke, or dimensions as a
universal rule. Use its documentation structure only when it helps the project
state its own contract.

## Design-code parity

Use these statuses per inspected surface:

- `aligned`;
- `drift`;
- `unknown`;
- `not-inspected`.

Compare behavior and content, not only visual similarity. Examples of material
drift include:

- design has a loading state but code does not;
- documentation allows an icon-only action but accessible naming is undefined;
- code exposes a variant absent from documentation;
- live usage overrides tokens or composition rules;
- design and code disagree on required or optional anatomy;
- responsive order differs and changes meaning;
- design presents one primary action while code gives multiple actions equal
  prominence;
- an overflow policy exists in documentation but live usage hides a required
  action through a different path.

## Exceptions and identity anchors

Consistency is a shared default, not a ban on authorship or brand expression.
Keep a distinctive choice when it has a supported identity, content, or task
role and does not break interaction or accessibility.

Every exception needs:

- decision;
- evidence-backed reason;
- task, brand, or identity value;
- owner;
- status;
- review trigger, such as a new theme, platform, component version, or repeated
  exception.

Repeated exceptions are evidence that the contract or token system may need
revision.

## Recommendation order

Prefer:

1. restore missing behavior, meaning, feedback, access, or recovery;
2. correct misleading affordances and essential action discoverability;
3. align required states across design, documentation, and code;
4. resolve content and responsive failures;
5. establish action priority within each real decision context;
6. map raw values to existing semantic tokens;
7. remove unnecessary grouping layers and consolidate variants with no distinct
   role;
8. document lifecycle, migration, ownership, and justified exceptions;
9. deprecate obsolete APIs or visual variants through a bounded migration path.

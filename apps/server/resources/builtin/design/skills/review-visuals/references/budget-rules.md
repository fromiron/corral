# Budget rules and exceptions

## Contents

- [Why count variants](#why-count-variants)
- [What counts as a layout grammar](#what-counts-as-a-layout-grammar)
- [Spacing roles and responsive relationships](#spacing-roles-and-responsive-relationships)
- [Responsive container ownership](#responsive-container-ownership)
- [Type roles and typography context](#type-roles-and-typography-context)
- [Color](#color)
- [Iconography and icon–text pairing](#iconography-and-icon–text-pairing)
- [Surfaces, radii, and shadows](#surfaces-radii-and-shadows)
- [Nested radius coherence](#nested-radius-coherence)
- [CT styles and action priority](#cta-styles-and-action-priority)
- [Grouping cues](#grouping-cues)
- [Motion patterns](#motion-patterns)
- [Decorative image families](#decorative-image-families)
- [Legitimate exceptions](#legitimate-exceptions)

## Why count variants

A small rule set makes relationships easier to perceive and makes the system
easier to maintain. The count is useful because gratuitous variants often hide
weak hierarchy or template-driven design.

## What counts as a layout grammar

Count a layout grammar when content organization changes, not merely when the
number of columns changes responsively.

Examples:

- chronological rows;
- card grid;
- editorial list;
- masonry gallery;
- bento mosaic;
- full-screen slides.

A responsive one-column version of the same project index is not a new grammar.

## Spacing roles and responsive relationships

Inventory the project's primitive spacing scale before judging raw values.
Classify each use by its communication role:

- `content-gap`: internal relationships within a component or content group;
- `section-gap`: separation between major page or flow regions;
- `container-padding`: the page edge and primary content boundary;
- documented exception: a measured interaction, data, brand, or accessibility
  need that does not fit the shared scale.

Prefer project semantic tokens over repeated raw values. Merge aliases that
perform the same role, and require a reason for one-off values. A 4/8 scale is
a common implementation choice, not a universal requirement.

Compare the roles at representative project breakpoints. Larger section gaps
and container padding may contract on narrow screens, while small control and
content gaps may remain stable. Judge whether grouping, scanning, targets, and
task flow survive; do not require every token to shrink.

## Responsive container ownership

Prefer a clear owner for page padding and width constraints. An outer container
often owns responsive padding and min/max width while inner content uses the
available space. Treat this as a maintainable default, not an absolute: forms,
readable text measures, data tables, media, and specialized controls may need
their own bounds.

Use the project's breakpoints and container tokens. Flag overflow, clipped
content, unreachable two-dimensional regions, or fixed desktop whitespace on
narrow screens. Do not import another system's breakpoint, minimum height, or
container dimensions as a pass/fail threshold.

## Type roles and typography context

Count semantic roles, not every font-size token. Typical roles:

- display or page title;
- section heading;
- body;
- metadata or caption;
- code or data;
- control label.

More roles may be justified in a complex application, but near-identical roles
should be merged.

For each role in scope, record the actual typeface and fallback stack, script
and language, size, weight, letter spacing, line height, line length, and
rendered use. Letter spacing and line height interact with the font's metrics,
weight, size, script, and content; no single numeric range is universally
correct.

Compare typography with the project's declared tokens and representative
multi-line rendering. Flag:

- the same semantic role drifting across unrelated settings;
- a declared token not matching the implementation;
- clipping, overlap, broken wrapping, or truncated glyphs;
- directly observed reading density or openness that impairs the task;
- a responsive or fallback-font substitution that breaks the intended role.

Do not flag a setting merely because it differs from a third-party typography
table. Test user-applied text spacing for loss of content or functionality as a
separate accessibility requirement; those tolerance checks do not prescribe
ideal default typography.

## Color

An accent color is a non-neutral color used for emphasis or identity. Status,
data-series, and validation colors should be inventoried separately because
they carry meaning.

Never reduce a color system by making states indistinguishable.

## Iconography and icon–text pairing

Inventory icon roles, source families, stroke and fill styles, raw bounds,
and interactive targets when icons create material variant. Similar semantic
roles should use a coherent icon language, but optical correction may change
the raw size or offset of a specific glyph.

When an icon and text form one label or control, inspect the pair rather than
the numbers in isolation:

- does the icon's visual mass match the text role without dominating or
  disappearing;
- do their baseline and gap preserve one readable unit;
- do hover, focus, selected, disabled, and error states remain coherent across
  both parts;
- is the icon decorative, supporting, or the sole label, and is that accessibility
  role explicit?

Do not require arithmetic equality between font size and icon bounds. Use the
actual typeface, weight, icon family, optical size, script, language, and
rendered result.

## Surfaces, radii, and shadows

A surface style is a recurring combination of background, border, elevation,
and treatment. Count functionally equivalent cards as one even when their
content differs.

Merge tiny token differences that have no observable purpose.

## Nested radius coherence

Radius-token count and radius relationships answer different questions. A
system can use one token everywhere and still create awkward nested contours.

Classify each nested rounded pair before judging it:

- `shared-contour`: the child surface visually follows the parent's corner;
- `independent`: the child is a separate control or component whose shape does
  not continue the parent contour;
- `pill-or-circle`: the shape communicates a pill, avatar, dot, or other
  intentionally circular form.

For a shared contour, prefer the next smaller semantic radius token on the
inner surface. Do not import another design system's pixel values as universal
defaults; use the project's declared token order.

When the two curves are intended to be parallel and computed pixel values are
available, check:

```text
expected inner radius = max(0, outer radius - inset)
```

Here `inset` is the measured distance between the compared outer and inner
contours, including relevant padding, gap, and border effects. Use a documented
tolerance for subpixel or rendering differences; the bundled checker defaults
to 1 CSS pixel. Use this concentric-offset rule only for contours intended to
track each other, not for every nested component.

Flag directly observed or measured shared contours when:

- the inner and outer surfaces repeat the same rounded token;
- the inner radius is greater than or equal to a rounded outer radius;
- the declared semantic step is not one level inward;
- a concentric pair exceeds its declared tolerance.

Treat screenshot-only uncertainty as observed or inferred rather than measured.
An unknown nesting scope, inferred mismatch, or documented exception requires
review. Radius awkwardness is not proof of AI authorship and is not a release
hard failure unless it also clips focus, content, targets, or another required
accessibility signal.

## CTA styles and action priority

Count visual treatments, not labels. A primary CTA can have many text labels
throughout a product while remaining one shared style.

Do not confuse style count with action hierarchy. A system may correctly use
one primary-button style and still present Follow, Message, Save, and Publish
as equally prominent inside one decision context. Conversely, different contexts
can each have a clear primary action without creating additional primary-button
styles.

Declare action priority per decision context. Prefer one primary action when
at default next step exists; record the evidence-backed reason for multiple or
no primary actions. Do not make every link a button. Use native link
affordances for navigation.

## Grouping cues

For each material relationship, inventory the available cues:

- `proximity`;
- `alignment`;
- `similarity`;
- `container`.

Use the lightest sufficient cue or combination. A container is stronger and
more expensive than spacing or alignment, but it is appropriate when it
means state, interaction, ownership, error scope, repeated record, or another
task-relevant boundary.

Remove a container reversibly and repeat the scan, growth, reflow, source-order,
focus, and primary-task tests. Do not assume a borderless result is simpler if
the relationship becomes ambiguous.

## Motion patterns

Count distinct motion behaviors such as:

- state fade;
- directional panel transition;
- scale feedback;
- shared-element movement;
- parallax;
- scroll reveal.

Different durations of the same state transition are not necessarily separate
patterns, but inconsistent durations should still be normalized.

## Decorative image families

A family is a repeated visual motif that does not itself provide product,
project, process, person, place, or data evidence.

Examples:

- glowing spheres;
- abstract 3D ribbons;
- generic futuristic dashboards;
- unrelated gradient landscapes.

Authentic project images are not decorative families merely because they are
visually expressive.

## Legitimate exceptions

Possible exceptions include:

- a publication with distinct editorial sections;
- multilingual type requirements;
- a data visualization with categorical color;
- a complex application with many necessary states;
- an established brand system;
- an expressive portfolio where the visual work is the content.

The exception must explain what information or identity would be lost.

# Audit rubric

Score the artifact on a 100-point quality scale. Higher is better.

## 1. Content grounding — 20

Full credit requires:

- claims trace to supplied evidence;
- prices, dates, outcomes, clients, quotes, and capabilities are attributable;
- missing facts remain missing;
- headings and sections exist because users need them.

Deduct for interchangeable claims, invented proof, or template sections with
no real content.

## 2. Task and information structure — 15

Full credit requires:

- the primary user task is identifiable;
- content order supports that task;
- one dominant structural grammar is apparent;
- navigation and responsive order remain coherent.

Deduct for competing page grammars, duplicate sections, or organizational
structure that ignores user tasks.

## 3. Visual entropy control — 15

Full credit requires:

- visual variants have jobs;
- type, color, surfaces, radii, shadows, and motion form a small system;
- shared nested contours use a coherent inward radius relationship;
- exceptions are intentional and documented.

Deduct for gratuitous variants or default card, gradient, glow, and bento
patterns. Also deduct when nested rounded surfaces repeat the same token or
produce a directly observed or measured contour mismatch without a documented
communication reason.

## 4. Typography, spacing, and alignment — 15

Full credit requires:

- hierarchy is readable;
- typography roles are consistent with project tokens;
- letter spacing and line height are evaluated for the actual font, fallback,
  script, language, size, weight, line length, and rendered use;
- content gaps, section gaps, and container padding express clear relationships;
- responsive spacing and container changes preserve grouping and avoid
  overflow or desktop-sized empty regions;
- alignment expresses relationships;
- whitespace is structural rather than theatrical.

Deduct for weak hierarchy compensated by effects, tiny faint text, unexplained
one-off spacing, fixed desktop whitespace on narrow screens, or directly
observed typography failures such as clipping, collision, broken wrapping, or
impaired reading. Do not deduct solely because values differ from another
design system's breakpoint, spacing, letter-spacing, or line-height table.

## 5. Component necessity — 10

Full credit requires:

- each component represents a real boundary, state, or interaction;
- identical meanings use identical components;
- CTAs are consolidated.

Deduct for card-everything, pill-everything, duplicate CTA treatments,
unnecessary layers of rounded containers, or components that disappear without
information loss.

## 6. Image relevance and authenticity — 10

Full credit requires:

- images show actual work, product, process, people, place, or data;
- mockups are disclosed;
- alternatives are available where required.

Deduct for filler imagery, repeated decorative scenes, fake product evidence,
or images that compete with the artifact itself.

## 7. Accessibility — 10

Full credit requires evidence for contrast, semantics, keyboard operation,
visible focus, reflow, labels, alternatives, errors, and target usability as
applicable.

Unknown checks may receive at most half of the category maximum and never full
credit. A screenshot alone cannot establish full conformance.

## 8. Motion and interaction restraint — 5

Full credit requires:

- every retained motion has a functional purpose;
- scrolling is user-controlled;
- nonessential motion can be reduced;
- static equivalents preserve meaning.

## Verdict

- 85–100: pass
- 70–84: revise
- 50–69: redesign
- 0–49: high slop risk
- any project hard failure: blocked

Only `observed` or `measured` evidence may create a project hard failure.
Record inferred or unknown risks as findings until direct evidence is available.

The derived slop-risk score is `100 - quality_score`.

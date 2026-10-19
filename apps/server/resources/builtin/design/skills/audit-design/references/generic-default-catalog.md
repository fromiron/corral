# Generic-default pattern catalog

Recurring observable patterns that make an artifact read as template-driven
output rather than as a specific person, product, or institution.

Each entry was derived by contrasting common template and generated-page output
with recurring choices in the curated minimal corpus recorded in
`docs/source-notes.md` (Dead Simple Sites). The corpus observations are
inferences from a curated sample, not universal laws. The template-side
defaults are a maintainer heuristic, not a systematically sampled corpus;
treat the catalog as reviewable guidance rather than a research-backed finding.

## Rules for use

- Record only the directly visible visual or structural cue as `observed`,
  always with its location. A cue is never authorship evidence.
- Record the interpretation of a cue—its cause, justification, authenticity, or
  correspondence with the real product—separately as `measured`, `inferred`, or
  `unknown` according to the supplied evidence. Do not promote a composite
  pattern to `observed` as a whole.
- Judgments such as "no record schema", "no identity", "substitution-proof",
  "does not match the product", "synthetic person", "wrong priority", or
  "unjustifiably hidden" are interpretations. They require supplied evidence or
  an explicit inference statement; without either, record them as `unknown`.
- A match is a review prompt. The artifact's own task, content, and brand can
  justify any pattern below; require the justification, not the removal.
- Multiple matches raise slop risk because they indicate interchangeable
  defaults, not because they indicate a specific tool.

Example split:

```text
Observed:
- The hero contains a dashboard image presented as a product screen
  (hero, right column).

Unknown:
- Whether the image matches real product capability could not be verified
  without product access.
```

## Layout and structure

Route remediation to `plan-structure`.

- **Interchangeable landing checklist.** Centered hero with an oversized
  benefit headline, one subline, and two buttons; then a three-feature card
  row, a logo strip, a testimonial band, a pricing trio, and a closing CTA
  banner—regardless of what the product is. Corpus contrast: the curated sites
  open with identity and the actual work or offer in the first screen, and
  sections exist only where real content exists.
- **Bento mosaic without a record schema.** Mixed-size rounded tiles whose sizes
  encode no priority, category, or state. Corpus contrast: repeated records
  share one stable schema (rows, lists, or a uniform index).
- **Card grid for every content type.** Writing, projects, contact, and metadata
  all wrapped in identical rounded cards. Corpus contrast: headings, lists, and
  plain links carry most structure; containers mark real boundaries.
- **Eyebrow–headline–subtext stack on every section.** A small uppercase label,
  a large centered headline, and one muted paragraph repeated as the only
  sectioning device.

## Visual system

Route remediation to `review-visuals`.

- **Violet–indigo gradient identity.** Purple-blue gradient accents, gradient
  text headlines, glow or blur halos, and glassmorphism panels used together
  without a brand reason. Corpus contrast: color is used as a single accent
  with a job, or not at all.
- **Uniform large radius everywhere.** One large rounded token applied to every
  surface, including nested surfaces that repeat the same token on a shared
  contour.
- **Decorative icon triads.** Icon, short title, and a two-line generic blurb
  repeated three or four times as the default explanation unit.
- **Typography without identity.** A default display face at uniform weights
  where hierarchy comes only from size jumps. Corpus contrast: the curated
  sites typically derive identity from few typefaces with strongly
  differentiated roles, not from added surfaces or effects.

## Interaction and action governance

Route remediation to `review-components` using its interaction-governance
extension. Record the visible cue separately from the inferred user impact.

- **Button-like inert content.** Static metadata, decorative icons, or labels
  use the same filled surface, hover treatment, or control shape as an operable
  action. The visual cue is observable; whether users interpret it as operable
  remains inferred or unknown until tested.
- **Competing primary actions.** Multiple adjacent actions use the same highest
  prominence inside one apparent decision context, while no supplied product
  rule establishes equal priority. Independent records or tool groups are not
  one decision context merely because they share a screen.
- **Important action hidden by default.** A primary, frequent, or recovery
  action appears only after opening an overflow menu or another disclosure,
  despite supplied evidence of available space or a requirement for direct
  access. The importance, frequency, space constraint, and adequacy of another
  path require separate evidence.
- **Color-only selected navigation.** Current destination or selection is
  indicated only by color even though the same icon shape and absent label make
  the state ambiguous. Route the accessibility requirement separately to
  `check-accessibility`.

These patterns are not blanket bans on shared button styles, overflow menus,
multiple actions, or icon-only controls. Require a decision-context contract,
actual behavior, accessible representation, and evidence-backed exception.

## Copy shape

Route remediation to `edit-copy` with a grounded inventory.

- **Substitution-proof benefit headline.** The headline remains equally
  plausible for an unrelated competitor.
- **"It's not just X, it's Y."** Contrast framing that adds no verifiable
  content.
- **Rule-of-three adjective triads.** "Fast, simple, and powerful" patterns
  where no adjective is tied to a mechanism or measurement.
- **"Whether you're A, B, or C."** Audience enumeration that commits to no
  audience.
- **Watchlist phrases.** See the `edit-copy` phrase watchlist for
  per-language generic vocabulary.
- **Voice or locale drift.** Register, terminology, or action wording changes
  across a product flow or its localized versions without a task-based reason.

## Imagery

Route remediation to `verify-content`.

- **Abstract 3D filler.** Glowing spheres, ribbons, and gradient landscapes that
  provide no product, project, process, person, place, or data evidence.
- **Generic dashboard mockups.** Interface imagery that does not correspond to
  the actual product; a hard-failure candidate when presented as real
  capability.
- **Synthetic stock people.** Portraits presented as customers or team members
  without attribution. Corpus contrast: images in the curated corpus are
  predominantly the actual work.

## Motion

Route remediation to `review-motion`.

- **Scroll reveal on every section.** Entrance animation as a default rather
  than as feedback or causality.
- **Infinite logo marquee.** Continuous motion carrying static information.
- **Typing-effect headline and count-up numbers.** Motion that delays or
  dramatizes text without adding meaning.
- **Parallax decoration.** Background drift unrelated to user action or spatial
  continuity.

## Corpus contrast summary

Recurring choices observed across the curated minimal corpus (inferred from a
curated sample; label accordingly):

- one dominant, usually text-led structure per page, often single column;
- identity carried by typography, real work, and a restrained accent, not by
  surface effects;
- native link affordances and few button styles;
- images that are evidence of work rather than decoration;
- little or no nonessential motion;
- short, factual copy with names, dates, and concrete offers.

Matching this summary is not the goal; the goal is that every retained element
has a job the artifact's own content can justify.

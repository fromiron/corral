# Token proposal

Read this file only when the user asks for token definitions or a proposal
page, or explicitly chooses that deliverable. An audit that ends with findings
does not need it. Run the commands below from the `review-visuals` skill
directory.

The page presents the applicable Color, Typography, Spacing, Layout, and
Radius foundations in one self-contained HTML file.

## Evidence gates

Normalizing an existing system (`"mode": "normalize"`, the
default): inspect the project's source tokens, CSS or theme values, computed
styles, representative content, and rendered viewports before filling numeric
proposals. If that evidence is unavailable, stop numeric design work, request
or locate it, and provide only a name-and-role scaffold with values marked
`unknown`. Do not invent a convenient scale merely to complete the page.

New system (`"mode": "new-system"`): when the user asks for a new system and
the project has no tokens for the scope, a value may be a design hypothesis.
Mark it `"basis": "hypothesis"` with a `rationale` tied to the stated
requirements, content, brand, or platform. Keep values the project already
supplied, such as an approved brand color, as observed with evidence. The
validator rejects hypotheses in normalize mode and hypotheses without a
rationale. Render the proposal and run its checks before reporting any result
as measured.

Guided proposals (`"approach": "guided"`) record the user's answers in
`preferences` and link each value they shaped with `based_on`. An exact value
from an answer is observed, with the answer as its evidence; a value chosen
from a direction is a design hypothesis. Follow
[token-questions.md](token-questions.md) for the questions and the mapping.

## Decide the tokens

1. Inventory current names, raw values, usage frequency, responsive mappings,
   aliases, and exceptions before proposing a scale.
2. Extend the project's naming convention when one exists. Otherwise propose a
   consistent namespace and show its parts, for example category and step for
   primitives and category and role for semantic tokens.
3. Propose primitive tokens as single reusable values without component
   meaning. Do not give a primitive per-breakpoint values.
4. Propose semantic tokens by role, such as text primary, content gap, section
   gap, container padding, page title, card corner, or pill corner. Map each
   semantic token to primitives per context: `default`, a breakpoint, a
   language, or a theme such as `light` and `dark`.
5. Record current-to-proposed mappings, merged and renamed aliases, deletions,
   retained exceptions, rationale, evidence, and adoption status. Label
   unverified recommendations as `proposed` or `unknown`, never as existing
   standards.
6. In normalize mode, derive values by clustering the project's current system
   and testing the rendered result. In new-system mode, derive each hypothesis
   from the stated requirements, content, and platform, then render and test
   it. Do not copy Codeit or another system's numbers, token names, or
   branding unless the project explicitly adopts that system.
7. For color, keep status, data, and validation colors separate from accents
   and declare the background each text or status color must meet, with the
   required contrast ratio. Write color values as hex, `rgb()`, `rgba()`, or
   `oklch()`. Use the project's notation when one exists, otherwise the
   notation the user gave, otherwise hex. The validator computes contrast for
   all four; it composites translucent text over its background, leaves
   contrast against a translucent background unknown, and uses the
   sRGB-mapped color for an `oklch()` value outside sRGB. Other notations,
   such as `hsl()` or color names, get no contrast check.
8. For typography, propose letter spacing and line height separately for the
   actual font, fallback, script, language, size, weight, and role. Do not
   extrapolate one font's values across unrelated roles.

## Build the page

Prefer the data path, which keeps the page consistent and checkable:

1. Write the proposal as JSON matching
   [assets/token-proposal.schema.json](../assets/token-proposal.schema.json);
   [assets/token-proposal-example.json](../assets/token-proposal-example.json)
   shows every field of a normalize proposal, and
   [assets/token-proposal-new-system-example.json](../assets/token-proposal-new-system-example.json)
   shows design hypotheses in a new-system proposal, and
   [assets/token-proposal-guided-example.json](../assets/token-proposal-guided-example.json)
   shows a guided proposal with recorded answers. Set `language` to the
   reader's language (`en`, `ko`, or `ja` chrome is bundled) and write titles,
   roles, and notes in that language.
2. Validate it. The validator rejects observed values without evidence,
   hypotheses without a rationale or outside new-system mode, references to
   undefined primitives, CSS values that could inject rules or load resources,
   and computable contrast below the declared minimum:

   ```bash
   python scripts/validate_token_proposal.py proposal.json
   ```

3. Render the page from the validated JSON. The renderer reuses the
   template's stylesheet and localized chrome, omits foundations that are not
   in scope, and refuses invalid input:

   ```bash
   python scripts/render_token_proposal.py proposal.json --output design-token-proposal.html
   ```

4. Open the page at a wide viewport and at about 375 CSS px. Confirm that
   previews draw the proposed values, each color row shows a swatch and lists
   its hex, `rgb()`, and `oklch()` notations, unknown values show the unknown
   marker, design hypotheses start with "Newly chosen" (새로 정한 값,
   新たに決めた値), the page does not scroll
   horizontally, and tables scroll only inside their own regions. Fix the
   data, not the generated markup, then render again.
5. Check the final file and report the output path, unknown values, design
   hypotheses, and open decisions:

   ```bash
   python scripts/validate_token_proposal.py proposal.json --html design-token-proposal.html
   ```

Without Python, copy
[assets/token-proposal-template.html](../assets/token-proposal-template.html),
replace or explicitly resolve every placeholder, duplicate rows, ramp steps,
and frames as needed, delete out-of-scope sections from both the page and its
navigation, and state that the deterministic checks were not run.

The page must keep: the status badge and `data-proposal-status="proposed"`;
previews drawn from the proposed values (color ramps and pairs, type
specimens, spacing bars, radius corners, container frames); one column per
mapping context; the unknown marker instead of guessed values; the
"Newly chosen" prefix on design hypotheses; the changes and
decisions sections; semantic headings, table captions, keyboard-scrollable
table regions, visible focus, reflow, reduced-motion behavior, and print
readability; and no network requests. The template's own chrome follows the
default budget in `SKILL.md`; do not add decorative gradients, glows, or
shadows to it.

When the user requested the files, write them where the user asked, or to an
established project documentation or artifact directory; otherwise write
`design-token-proposal.html` to the project root and report the path. The
artifact is a review proposal, not evidence that the project has adopted the
tokens.

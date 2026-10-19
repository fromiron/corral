# Guided token questions

Read this file only for a guided token proposal: the user chose the guided
approach, asked to be asked, or stated some preferences and left others open.
An AI proposal does not need it. Run the commands below from the
`review-visuals` skill directory.

[assets/token-questions.json](../assets/token-questions.json) is the single
source for the questions, option IDs, and wording in English, Korean, and
Japanese. Do not reword the options or add new ones; ask in the user's
language.

## Ask

1. Inspect first. Read the request, any brief, and any project tokens before
   asking. Drop a core question when the request or the evidence already
   answers it, and record that answer as a preference. When normalizing an
   existing system, ask only about directions without project evidence, such
   as `theme` when the project has no dark tokens. A question never reopens a
   value observed in the project.
2. Ask the remaining core questions together in one message:

   ```bash
   python scripts/token_questions.py --language ko --skip theme
   ```

   Send the printed text as it is. Without Python, build the same message from
   the question bank: the intro and the answer hint, then each question
   numbered, its options lettered A–D in bank order, and its custom hint. If
   the client offers a structured multiple-choice question tool, you may use it
   with the same questions and options instead. Every core question has at most
   four options, ending with "let the AI choose", so it fits such tools. Do not
   depend on any single client's tool.
3. Ask at most one round of follow-up questions, and only when a follow-up's
   `when` condition in the bank applies:

   ```bash
   python scripts/token_questions.py --language ko --stage follow-up --only brand-color-value
   ```

4. Ask nothing else. Infer spacing density and type scale from the content and
   platform, and record them as design hypotheses.

## Record the answers

Record the approach and each answer in the proposal.
[assets/token-proposal-guided-example.json](../assets/token-proposal-guided-example.json)
shows a complete guided proposal.

```json
"approach": "guided",
"preferences": [
  {"question": "color-family", "choice": "custom", "detail": "#0f766e"},
  {"question": "theme", "choice": "both"},
  {"question": "type-style", "choice": "delegate"},
  {"question": "corner-style", "choice": "subtle"}
]
```

- `choice` is an option ID from the bank, `custom` with the user's own words in
  `detail`, or `delegate` when the user let the AI choose.
- An answer that names an exact value, such as a brand color, gives an observed
  value: `"basis": "observed"`, evidence such as "User answer (color-family)",
  and `"based_on": ["color-family"]`.
- An answer that sets a direction, such as blue or slightly rounded, leads to
  values you choose: `"basis": "hypothesis"`, a `rationale` that names the
  direction, and `"based_on"` with the question ID.
- A delegated question is your decision, not the user's. Do not cite it in
  `based_on`; give its values a rationale as in an AI proposal.
- A question the user did not answer has no preference. Leave an unanswered
  `theme` as an open decision and map a single context. For the other
  questions, choose as for a delegated question and say in the decisions that
  the question was not answered.

## Map answers to values

A direction constrains a choice; it does not fix a number. Choose values from
the content, platform, and accessibility baseline, render them, and explain
each in its rationale.

- `color-family`: build the accent ramp in that family. Keep status colors for
  errors, warnings, and success separate from the accent, even when the family
  is warm. Keep a supplied brand color as observed and derive steps around it.
- `theme`: `light` maps color semantic tokens for light screens only; `dark`
  includes a `dark` context; `both` maps every color semantic token for `light`
  and `dark`, using `unknown` where a value is not derived yet; `delegate`
  chooses from the platform and content and explains why.
- `type-style`: `system` uses system font stacks. `sans` and `serif` need a
  family that covers every content language and script. For a named font,
  check script coverage and licensing, and keep them as open decisions when
  they are unknown.
- `corner-style`: sets the control radius. Shared nested contours still step
  inward, and independent components, pills, and circles keep their own
  classification.

## Limits that answers do not change

- Contrast minimums. When a chosen color fails against its background, adjust
  its lightness, keep the family, and record the reason in the decisions.
- Proposal status. An answer does not make a value an adopted project
  standard.
- Existing values. In normalize mode, record an answer that changes an
  observed value in `changes`, with the user's answer as evidence.

The validator checks that preferences use question bank IDs, that `based_on`
points only to recorded answers that were not delegated, and that the color
contexts match the `theme` answer.

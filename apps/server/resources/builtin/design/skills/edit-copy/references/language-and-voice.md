# Language and voice

Use this reference when naturalness, tone, translation, or more than one locale
is in scope. Read only the relevant language sections unless comparing locales.

## What the sources can decide

Official and maintained writing guides support decisions about clarity,
grammar, usage, and reader comprehension. They do not define the product's
personality. The product's explicit style guide and approved copy take
precedence unless they conflict with meaning, evidence, safety, law, or
accessibility.

Do not infer whether a person or model wrote copy from tone, structure, or
vocabulary.

## Build a product voice profile

Use enough approved examples to distinguish a pattern from a one-off. Record:

- formality and politeness;
- preferred person, pronouns, and relationship to the reader;
- sentence length, fragments, and rhythm;
- call-to-action verbs and label patterns;
- product terminology and technical vocabulary;
- humor, metaphor, emphasis, and punctuation.

If the evidence is sparse or inconsistent, correct objective errors and offer
tone changes as suggestions. Do not invent a unified house style.

## Multilingual and internationalized copy

- Review every supplied locale in its own language before comparing locales.
- Preserve meaning, task, terminology, and action priority; do not require a
  word-for-word match or identical sentence shape.
- Let formality, honorifics, segmentation, and idiom follow the target locale
  and approved product voice.
- Flag likely truncation or expansion pressure as an interface constraint. Do
  not shorten away required meaning without a verified space limit.
- Keep a shared product identity without making every language sound translated
  from the default locale.
- Match each canonical message key to its locale-catalog entries. Confirm that
  the entries preserve the same meaning and action; flag missing, duplicated,
  or misaligned keys.
- Keep message keys unchanged. Preserve placeholder names, markup boundaries,
  escape sequences, and ICU or equivalent message syntax; placeholders may move
  with target-language grammar but must not disappear or change identity.
- Keep plural, gender, and select branches complete. Review the copy inside each
  branch without collapsing distinct runtime meanings.
- Leave date, time, number, currency, and unit formatting to the locale-aware
  formatter identified by the product. If ownership is unknown, flag it instead
  of hard-coding the source locale's format.

## Decision labels

- **Correct:** grammar, spelling, mistranslation, ambiguity, broken locale
  convention, inconsistent terminology, or conflict with an explicit product
  rule.
- **Suggest:** rhythm, warmth, formality, humor, emphasis, or another defensible
  style choice.
- **Keep:** an intentional phrase that fits the product even when a general
  guide would choose plainer wording.

## English

Primary public guidance:

- [Digital.gov: Principles of plain language](https://digital.gov/guides/plain-language/principles)
- [GOV.UK: Use clear language](https://guidance.publishing.service.gov.uk/writing-to-gov-uk-standards/writing-guidelines/clear-language/)

These sources support writing for the actual audience, making the main point
easy to find, using familiar terms, preferring active voice when it clarifies
the actor, and keeping sentences focused. Plain English is not a demand to
remove technical terms that the audience needs.

Maintained product-writing examples:

- [Google developer documentation: Voice and tone](https://developers.google.com/style/tone)
- [Microsoft Writing Style Guide: Brand voice](https://learn.microsoft.com/en-us/style-guide/brand-voice-above-all-simple-human)

Use these as examples of adapting tone to context, not as house styles to copy.
Check for padded transitions, hidden actors, nominalizations, stacked nouns,
cliches, repeated sentence openings, unnecessary formality, and contractions
that do not match the product.

## Korean

Primary public guidance:

- [국립국어원: 쉬운 공공언어 쓰기 길잡이](https://www.korean.go.kr/front/etcData/etcDataView.do?etc_seq=399&mn_id=62)

Use the guide for natural sentence order, shorter focused sentences, clear
actors when omission causes ambiguity, and restraint with excessive passive
forms and noun chains. Check particles, spacing, translated word order,
unnecessary nominalization, terminology, and consistency among 합니다체,
해요체, commands, and fragments. A concise product label does not need to read
like public administration prose.

## Japanese

Primary guidance for public and administrative documents:

- [文化庁: 公用文作成の考え方（建議）](https://www.bunka.go.jp/seisaku/kokugo_nihongo/kokugo_shisaku/94336802.html)

Audience-specific guidance:

- [出入国在留管理庁・文化庁: 在留支援のためのやさしい日本語ガイドライン](https://www.bunka.go.jp/seisaku/kokugo_nihongo/kyoiku/pdf/92484001_01.pdf)

Use the public-document guidance to focus information on the reader and
document type, keep sentences focused, and remove needless repetition. Check
long noun strings, passive or causative wording, literal translation,
particles, punctuation, terminology, and consistency between です・ます調,
だ・である調, commands, and short labels. Use the second guide only when the
audience and task call for やさしい日本語, such as information for foreign
residents; it is not a default style for Japanese product copy.

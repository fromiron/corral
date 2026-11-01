# Phase2 natural meeting data

`ami_response_data.py` prepares a separate **observed-response selection** proxy from the pinned AMI manual archive. A human adjacency annotation links an elicitation to a later response. The participant(s) who produced those linked responses form eligible alternatives for one next responder. This does not establish intended addressees, mandatory participation by everyone, or general Corral dispatch correctness.

AMI's dialogue-act manual treats uncertainty as the respondent being unsure or unable to supply the elicited information. It is not an annotator-confidence score, so `apt_3` remains a valid observed-response relation. Support, objection and partial support also count as responses. [Official AMI annotation manual, Describing Relationships](https://groups.inf.ed.ac.uk/ami/corpus/Guidelines/dialogue_acts_manual_1.0.pdf#page=25).

## Frozen preparation rules

- Exclude every team exposed by the phase1 AMI diagnostic. Keep all sessions from a fresh team in one partition.
- Use human-linked responses from another registered speaker, with known role metadata, starting after the source utterance ends and at most60 seconds later. Keep short follow-up questions.
- Use only already-completed acts ending before the current elicitation starts. Merge consecutive visible acts by speaker and then keep the last12 speaker runs. Preserve constituent act IDs/times for auditing. A visible run may be a completed prefix of an ongoing spoken turn; later continuation text is not added.
- Treat the current speaker as the user. Participant names are recorded anonymized speaker codes A–D, with the recorded roles. The metadata does not supply personal display names; spoken personal names may therefore remain unresolved.
- Human dialogue-act/relation labels and later response text are absent from model inputs. Future response IDs/times appear only in the private supervision audit.
- Quarantine current utterances containing conservative group-response or silence-language flags. Without additional review, an observed linked response cannot override an explicit all/none product instruction. These flags are not a production intent classifier.
- Quarantine cross-team exact-input duplicates. Audit near duplicates separately before fitting; hygiene vectors are never model features.

The initial frozen corpus contains2182English rows from27fresh teams: F959/11teams, C246/3, P244/3 and H733/10. The seed is41. There are396multiple-responder alternative sets and315questions of at most3words. Eight late links were removed and25source cases were quarantined for group-response-language review. This natural source is entirely English; the multilingual mixture of any later combined training run must be reported independently.

Raw records and immutable manifests live outside Git. The generator stores source/license hashes, split membership, file hashes, filtering counts and its exact source snapshot. `near_duplicate_audit.py` adds a read-only cross-team audit against the frozen manifest. None of these tools trains or scores a model.

## Source and limitations

The [AMI manual annotations](https://groups.inf.ed.ac.uk/ami/download/) are distributed under [CC BY4.0](https://groups.inf.ed.ac.uk/ami/corpus/license.shtml). The archive used here has SHA256 `b56e5babb2496b8795deeeda7e71178d7fbc9963f94276cf2a3f4b56ebbc9f9d`. Preserve attribution and the description of these transformations when distributing derived data or artifacts.

The corpus covers English scenario meetings with fixed team roles. Gaze, gesture and prosody are unavailable in these inputs; public-corpus pretraining overlap is unknown. An unlinked participant is not proven inappropriate. The observed-response proxy supplies no normative silence, all-reply or exclusion labels, so those behaviors require separate supervision and controlled checks. Phase1 H remains exposed regression evidence and never becomes fitting data. Existing synthetic F may be retained as a separately identified component.

The fresh controlled-holdout proposal is in [controlled_holdout_plan.md](controlled_holdout_plan.md). It reserves new construction families before any generated relational fitting examples; it contains no generated or scored holdout instances.

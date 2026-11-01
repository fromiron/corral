# Rule-derived controlled meeting corpus

This research corpus measures normative recipient instructions separately from AMI's
observed-response proxy. Each symbolic family belongs to exactly one partition:
16 fitting, eight calibration, eight policy, and twelve fresh final families.
Each family has twenty variants: twelve Korean, five English, and three Japanese.
Names, participant IDs, roster order, factual values, and translations never create
new independent groups. The fixed seed is 41.

The fitting/calibration/policy catalogue contains static comparisons, set predicates,
and directed relations. It has no mutable responsibility, cancellation, completion,
commitment, speaking-order, recusal, topic-responsibility, alias-update, correction,
freshness, clarification-owner, or closure transition. The twelve final mechanisms
are reserved in [controlled_holdout_plan.md](controlled_holdout_plan.md) and are
constructed independently. No previous final scene is an input to either generator.

A symbolic interpreter computes labels before language generation. Every fact and
protocol needed by the interpreter is supplied as an already-completed turn. The
current message states the recipient predicate and whether one alternative, the
entire selected set, everyone except a set, or silence is requested. An empty match
requires silence when the visible instruction says so. Excluded IDs denote explicit
prohibitions, never inferred irrelevance. A one-mode target with several IDs accepts
any one of those IDs and does not demand all of them.

Each family has two contrasting symbolic states. GPT-6.1 Sol with explicit high
reasoning realizes these in three languages, giving six base scenes in one call.
It may realize only the supplied facts and question, without changing speakers,
participant IDs/names, event order, or symbolic labels. Independent Hive high sees
only the six visible scenes, without symbolic facts, oracle labels, predictions,
worker answers, or performance data. Its independently assigned labels must match
the mechanical oracle. Only then are twenty name/ID/roster-order variants expanded.
Roster sizes of two, four, and six occur across families; a family keeps its valid
base roster size. Every translated state and every expanded variant retains the
same family. A family qualifies only when all six base scenes pass structural and
semantic verification. Failed families remain in the ledger; variants are not
silently removed to improve acceptance.

Freeze symbolic packets, family membership, source hashes, and the generation plan
before calls. The total initial budget is 44 author and 44 reviewer invocations;
at most eight additional realization attempts may be declared for invalid or known
terminal failures, retaining all previous evidence. Unknown calls are not retried.
All raw prompts, completions, labels, receipts, and manifests are private. Public
progress contains counts and hashes. Fresh final instances are not shared with
fitting agents or opened for model/policy selection before candidate freeze.

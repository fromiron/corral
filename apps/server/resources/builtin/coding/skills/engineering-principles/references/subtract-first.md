# Subtract first

**Rule.** Take out what is no longer needed before putting anything new in.

**Why.** Every line that stays has to be read, kept working and worked around. New code written beside leftovers takes on their shape.

**In practice**

- Before the main work, scan the area for leftovers: functions nothing calls, settings that only ever hold one value, a check an earlier layer has already made, pass-through wrappers, names that point at things since deleted.
- Delete them as a separate step and confirm the checks still pass. Then begin.
- When a rule keeps collecting exceptions, ask whether the rule itself can go.
- Where the same choice is made twice, keep one and let the other read its result.

**You skipped it when** the new condition sits next to one that can never be true, or there are now two helpers for one job.

**Take care.** Not seeing a caller is not proof that there is none. Search by text as well as by symbol, including configuration and documentation, and report what you searched.

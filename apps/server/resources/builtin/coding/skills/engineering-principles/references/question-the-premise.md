# Question the premise

**Rule.** After two failed attempts that share an assumption, test the assumption before making a third.

**In practice**

- Find what both attempts took for granted and write it as a claim that can be wrong: "the callback fires after the data loads", "this field is always set by then".
- Devise the cheapest observation that settles it: print the value, add an assertion, run once and look.
- Make that observation now.
- If the claim is false, everything built on it goes, including changes that seemed harmless on their own.

**It applies when** each attempt shifts the symptom without curing it, you are adjusting the same idea again, or you can argue convincingly that the last attempt ought to have worked.

**For requests too.** When the reported problem will not reproduce, or the requested change would not cure it, present that finding before building anything.

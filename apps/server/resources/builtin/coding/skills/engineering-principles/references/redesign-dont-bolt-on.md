# Redesign, don't bolt on

**Rule.** Fit a new requirement into the design as though it had always been part of it.

**In practice**

- Phrase the requirement as something the system does in general: "orders can be paid in instalments", not "handle the instalment case".
- Imagine starting the module today with that sentence in the brief. Note what would be different from what exists.
- That list of differences is the job. If it is short, do it now. If it is long, show it and propose an order, instead of covering the gap with a switch.
- In staged work, spend effort on stages that survive. Scaffolding built only to make a halfway state look finished is written once and deleted once, for nothing.

**You skipped it when** an argument exists that a single call site passes, a condition mentions a specific customer, date or ticket number, or two functions differ by a few lines and are kept in parallel.

**Leave it alone when** the requirement is narrow and has an end date. Then keep the exception small, name it for what it is, and note when it can go.

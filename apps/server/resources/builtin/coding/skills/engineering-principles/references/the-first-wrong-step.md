# The first wrong step

**Rule.** Repair a fault at the point where the system first went astray. The place where it finally fell over is usually somewhere else.

**In practice**

- Make the failure happen on demand before touching the code.
- From the visible failure, work backwards one cause at a time. Stop when you reach code that made a wrong decision. If you are unsure what a value was, print it; do not deduce it.
- Decide whether the input or state that set it off is one the system is supposed to accept. If it is, the failing code must cope with it. If it is not, something earlier let it through, and that is the fault.
- Having found the fault, search for its relatives. The same mistake is often made wherever the same pattern was copied.

**Disguises.** A null check at the crash site, a retry loop, an empty catch block, a value forced into range, a fallback default, a reset that throws state away. Each removes the symptom. Each is correct only if the condition it absorbs is a normal one.

**Afterwards.** If the cause took hours to find, suggest what would have exposed it in minutes, such as a log line or an assertion that is always on.

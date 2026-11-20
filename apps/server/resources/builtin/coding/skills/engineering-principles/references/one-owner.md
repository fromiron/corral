# One owner

**Rule.** One writer for each piece of state. One route to each outcome. As little as possible for a caller to know.

**In practice**

- For every value that changes, be able to point at the single function or module allowed to change it. If you find a second, make it ask the first.
- When work is split between workers, split what they write too: one target each, combined afterwards. A lock is for the case where one shared target cannot be avoided.
- Resist a second way in "for convenience". It becomes a second behavior to maintain.
- A caller should need the function's name, its inputs and its result. Required call order, set-up steps and mode flags are the module's own business.

**You skipped it when** a value is cached in two places and they drift, calling things in the wrong order fails silently, or one bug needed the same patch in three files.

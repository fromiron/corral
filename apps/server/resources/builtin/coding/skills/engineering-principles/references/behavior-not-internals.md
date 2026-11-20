# Behavior, not internals

**Rule.** Write the test from the caller's side. If no caller could tell the difference, the test should not either.

**Counts:** anything that crosses the module's edge.

**Does not count:** anything that stays inside.

**Procedure.** The failing-test-first skill. A record made before a restructure captures today's behavior instead; see the behavior-pin skill.

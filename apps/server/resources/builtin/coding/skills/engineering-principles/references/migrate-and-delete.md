# Migrate and delete

**Rule.** When one internal interface replaces another, switch all the callers and remove the old one together.

**Why.** While both exist, every later change has to consider both, and new code keeps arriving on the old one.

**In practice**

- Find every user of the old interface: code, tests, scripts, configuration, and mentions in text.
- Switch them all. Then remove the old interface along with its tests and its documentation.
- Do not keep an adapter for code you are free to edit. An adapter kept "for now" has no natural end.
- If the switch is too large for one change, divide it by groups of callers and finish each group completely. Say what is left, and remove the old interface with the last group.

**You skipped it when** something marked deprecated gains a new caller, a wrapper translates between the old and new forms, or a switch chooses between two implementations and is never retired.

**A real boundary.** Users you cannot edit (published packages, stored data, another team's service) are different. There, version the interface and state how long the old version will live.

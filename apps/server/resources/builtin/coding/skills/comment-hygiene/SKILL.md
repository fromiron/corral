---
name: comment-hygiene
description: "Removes code comments that restate the code and keeps only those that say what the code cannot, checking that each kept one is still true. Use when cleaning up a diff before review, when reviewing comments in changed code, or when a file carries more commentary than it needs."
license: MIT
---

# Comment hygiene

A comment costs something every time the file is read, and it goes out of date without anyone noticing. So the default is removal. A comment has to earn its place.

## Three grounds for keeping a comment

A comment stays only on one of these grounds.

1. **Its reader cannot see the code.** A description of what a public function promises, what it requires and how it fails, written for callers outside the module.
2. **It records a fact that lives outside the code.** A limit set by a protocol, a platform, a regulation or another system's defect, with the specifics: which system, which version, which limit. Or a pointer to where a decision was written down: an issue, a specification section, a decision record.
3. **Something other than a person reads it.** A notice the law requires, such as a license header. A directive for a tool, such as a lint suppression or a generator marker. A suppression keeps its reason beside it.

Everything else goes, whatever it looks like: code that was commented out, a history of who changed what, a to-do with no owner and no tracked item, a note to the reviewer, a line that narrates the next line, a reassurance with no reason ("this is safe", "should never happen"), a divider.

## Steps

1. **Fix the scope.** The changed lines by default. Widen to the file or the module only when asked.
2. **Put each comment in scope to the three grounds.** No ground, no comment.
3. **Check the ones that pass.** Is the outside fact true today? Look up the rule a suppression names. Open the link. If you cannot confirm it, remove the comment and list it as a flag. The ask-the-record skill covers how to check.
4. **Read an apology for confusing code as a defect report.** When a comment exists only because the project's own code is hard to follow, the code is at fault. Name the symbol and suggest the rename or the reshape. Remove the comment.
5. **Remove the rest.**

## Rules

- Change comments only. Behavior, names and structure stay as they are.
- A removed comment does not come back in a shorter form.
- Leave comments alone in code you were not asked to touch.
- If you are not allowed to change files, report the same lists and edit nothing.

## Hand back

- Files touched, with the number of comments removed and kept.
- Each kept comment, the ground it stands on and what you checked.
- Flags: outside facts you could not confirm, and symbols whose code needed a comment to be understood.

---
name: comment-hygiene
description: "Removes code comments that restate the code and keeps only those that say what the code cannot, checking that each kept one is still true. Use when cleaning up a diff before review, when reviewing comments in changed code, or when a file carries more commentary than it needs."
license: MIT
---

# Comment hygiene

A comment costs something every time the file is read, and it goes out of date without anyone noticing. So the default is removal. A comment stays only when it tells the reader something the code and its names cannot.

## What stays

1. **A contract for outside callers.** What a public function promises, what it requires and what it does on failure, where callers cannot see the body.
2. **A constraint from outside the code.** A rule imposed by a protocol, a platform, a regulation or another system's bug, written with specifics: which system, which version, which limit.
3. **A pointer to a decision.** Where the reasoning is recorded: an issue, a specification section, a decision record.
4. **A notice the law requires.** Licence and copyright headers.
5. **A directive a tool reads.** Lint suppressions, type hints in comments, generator markers. Keep the reason beside a suppression.

## What goes

- Narration of what the next line does.
- Banners and dividers.
- Code that has been commented out.
- History: who changed what and when. Version control has it.
- Notes addressed to a reviewer.
- A to-do with no owner and no tracked item.
- Reassurance with no reason attached: "this is safe", "should never happen".

## Steps

1. **Fix the scope.** The changed lines by default. Widen to the file or module only if asked.
2. **Sort every comment in scope** into the lists above.
3. **Test the ones that stay.** Is the constraint real today? Look up the rule a suppression names. Open the link. If you cannot confirm it, remove the comment and list it as a flag. The ask-the-record skill covers how to check.
4. **Treat an explanation of surprising code as a signal.** When a comment exists only because the code is confusing, the code is the problem. Name the symbol and suggest the rename or reshape. Do not swap in a shorter comment.
5. **Remove the rest.**

## Rules

- Change comments only. Behaviour, names and structure stay as they are.
- Do not condense a removed comment into a new one.
- Do not delete a comment in code you were not asked to touch.
- If you are not allowed to change files, report the same lists instead of editing.

## Hand back

- Files touched, with a count of comments removed and kept.
- Each kept comment, with the category it falls under and what you checked.
- Flags: claims you could not confirm, and code that needed its comment because it is unclear.

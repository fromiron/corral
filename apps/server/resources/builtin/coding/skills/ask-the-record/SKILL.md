---
name: ask-the-record
description: "Explains the reasons behind existing code or decisions from what was written down at the time, and keeps quoted reasons apart from its own deductions. Use when asked why something is the way it is, why an option was chosen or rejected, when a behavior changed, or what a threshold is based on."
license: MIT
---

# Ask the record

Code shows what was decided. It rarely shows why. The reason, if it survives, is in what people wrote when they made the change. Look there before you reason from how the code looks.

## Steps

1. **Pin down the subject.** The exact line, value, rule or decision the question is about.
2. **Find when it appeared and each time it changed.** If you can run commands, use the version history for that line or file. If you cannot, use what is in the tree: change logs, specifications, decision records, comments, test names.
3. **Read what the authors wrote.** The message on each change, the description of the request it came in with, the discussion attached to it, the document it cites.
4. **Follow each reference one hop.** An issue number, a link, a ticket, a named incident. Open it. If you cannot open it, say so; do not describe what it probably contains.
5. **Build a timeline.** One row per change: date, what changed, the reason given, where that reason is written.
6. **Sort what you have into three piles.**
   - Stated: a source says it. Quote the line or give its location.
   - Deduced: the sources point to it and none says it. Mark it as your deduction and name what it rests on.
   - Unanswered: the record is silent.
7. **Check whether the reason still holds.** The constraint may have gone: the library was upgraded, the customer left, the limit was raised. Say what you checked.

## Rules

- Do not rebuild a rationale from the shape of the code and present it as the reason.
- Do not cite a source you did not open.
- A commit that only moved or reformatted the line is not where it began. Keep going back.
- When two sources disagree, show both and say which is later.
- Do not change files.

## Hand back

- **Short answer.** Two or three sentences, with its label: stated, deduced or unanswered.
- **Timeline.** The rows from step 5.
- **Sources.** Each one you opened, and each you could not.
- **Deductions.** Listed apart from what the record states.
- **Gaps.** What nobody wrote down, and who or what could fill each one in.

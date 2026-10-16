# Commit attribution

Claude commit and PR attribution is disabled in `.claude/settings.json`.
The `prepare-commit-msg` hook removes known AI co-author lines and preserves
human co-authors, body text, and line endings. PR bodies are not processed by Git hooks.

Enable in each clone (requires Python 3):

```sh
git config --local core.hooksPath .githooks
.githooks/prepare-commit-msg --self-test
```

Check for an existing `core.hooksPath` before enabling so other hooks are preserved.
The hook also runs with `git commit --no-verify`; overriding `core.hooksPath`
or creating commits through an API can bypass it.

---
description: Remove the tool calls and results from this conversation, keep the messages
argument-hint: "[tools] [keep N] [preview]"
allowed-tools: Bash(supercompact:*)
---

Shrink the conversation we are in right now.

Arguments given: `$ARGUMENTS`

`tools` adds `--tools`. A number after `keep` becomes `--keep-last N`.
`preview` adds `--preview` and writes nothing. `copy` drops `--in-place`, which
writes a new session instead.

```
supercompact --in-place [--tools] [--keep-last N] [--preview]
```

Report three things:

1. before and after, in tokens
2. the id of the backup
3. the `cd … && claude --resume …` line, and that the id is unchanged

Do not summarise the conversation. Do not run other commands.

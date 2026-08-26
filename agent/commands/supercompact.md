---
description: Rewrite this conversation down to the words we exchanged, keeping it resumable
argument-hint: "[tools] [keep N] [preview]"
allowed-tools: Bash(supercompact:*)
---

Rewrite the conversation we are in right now.

Arguments given: `$ARGUMENTS`

Read them as flags. `tools` adds `--tools`. A number after `keep` becomes
`--keep-last N`. `preview` adds `--preview` and writes nothing. `copy` drops
`--in-place` so a new session is written instead.

```
supercompact --in-place [--tools] [--keep-last N] [--preview]
```

Then tell me, in three lines or fewer:

1. before and after, in tokens
2. the id of the full copy it wrote first
3. the `cd … && claude --resume …` line, and that it is the same id I already have

Do not summarise the conversation yourself and do not run any other command.

---
name: supercompact
description: Remove tool calls and tool results from a Claude Code session and keep the messages. Use when context is running low, or when the user asks to supercompact or shrink a conversation.
---

# supercompact

## Show the user their own number first

```sh
supercompact measure
```

Reads every session on the machine. Writes nothing. Takes a few seconds.

## Shrink the session you are in

```sh
supercompact --in-place
```

Options: `--tools` keeps one line per call. `--keep-last 10` and
`--keep-tools 5 --unique-tools` keep recent state unchanged.

A running session does not re-read its own file, so this takes effect on
resume. Print the resume line the command gives you. The session id does not
change.

## Show the cost first

```sh
supercompact --preview --keep-last 10
```

## Another session

```sh
supercompact list
supercompact 4f2a1c3d --tools
```

## What to report back

1. before and after, in tokens
2. the id of the backup
3. the resume line, and that the id is unchanged

Do not summarise the conversation. Do not run other commands.

## If the command is missing

```sh
npm install -g supercompact
```

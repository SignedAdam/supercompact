---
name: supercompact
description: Rewrite a Claude Code session down to the words that were actually exchanged, keeping it resumable. Use when context is running out, or when the user asks to supercompact, shrink, or clean-fork a conversation.
---

# supercompact

`supercompact` rewrites a session so it holds what the two of you said and none
of the tool traffic. The result is a real session that `claude --resume` opens.

Nothing is summarised. Every word either side typed survives.

## Show the user their own number first

```sh
npx supercompact measure
```

Five seconds, writes nothing, and reads the token counts the API reported on
each turn. It is the honest way to open the conversation, because it says what
this would be worth on their machine rather than on anyone else's.

## Rewrite the session you are in

```sh
supercompact --in-place
```

Add `--tools` to keep one line per call saying what ran. Add `--keep-last 10` or
`--keep-tools 5 --unique-tools` to bring the most recent state back untouched.

Say this plainly afterwards: a live session never re-reads its own file, so
nothing shrinks until it is resumed. Print the `claude --resume` line and let
the user move when they are ready. The id does not change.

## Cost it before doing it

```sh
supercompact --preview --keep-last 10
```

Writes nothing. Prints what the session weighs now, what it would weigh after,
and how much of that is what was asked to be kept.

## Another session

```sh
supercompact list
supercompact 4f2a1c3d --tools
```

## What to tell the user

1. before and after, in tokens
2. the id and name of the full copy it wrote first
3. that this window still holds the old conversation, and the resume line

Do not summarise the conversation yourself and do not run anything else.

## If the command is missing

```sh
npm install -g supercompact
```

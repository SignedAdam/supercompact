# supercompact

Reduce your Claude Code session context by 95%.

95% of your session is tool calls and tool results.

## Try it without installing

```
npx supercompact measure
```

It reads every session in `~/.claude/projects` and writes nothing. Here is what
it prints on my own machine:

```
  3266 sessions, 364.0M tokens of context

  removed                   228.9M    63%  ████████████████··········
  starting context          111.5M    31%  ████████··················
  kept verbatim              23.7M     6%  ██························

  removed is tool calls and their results.
  starting context is your MCP tools, skills, CLAUDE.md files and so on.
  kept verbatim is every message you and Claude sent.

  your last 3 sessions

  session                                    now     after  starting  removed
  a4abe3a1-d4e9-4c99-823d-2d7d947564ce      255k       86k       58k      66%
  fda42bf1-66b1-496b-9913-cc0173ececa1       37k       37k       35k       0%
  47fba1c4-36ff-4282-a992-473ede0c8660      755k      316k       50k      58%

  after is what the session weighs once it has been supercompacted.

  Your newest session starts with 58k already loaded. (You should fix this btw)

  435 of your sessions passed 200k tokens. The middle one drops by 87%.
  Your heaviest session held 1.0M tokens. 3k of it was the two of you talking.

  Context sizes are the numbers the API reported on each turn, not an estimate.
  The keep options hold some tool results back, and the preview prices them.

  Try it on this machine:  npx supercompact --preview
```

## Install

```
npm install -g supercompact
```

## Commands

```
supercompact                 copy the current session, stripped
supercompact <id>            copy that session
supercompact --in-place      rewrite it, same id and name
supercompact --preview       token cost, writes nothing
supercompact measure         the split across all your sessions
supercompact list            recent sessions
```

## Options

```
--tools            one line per tool call, no output
--keep-last N      keep the last N messages unchanged
--keep-tools N     keep the newest N tool results
--unique-tools     a repeated call counts once
--json             machine-readable output
--limit N          how many sessions list shows
--project-dir P    look in P instead of the current directory
```

MIT

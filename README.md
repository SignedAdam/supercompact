# supercompact

Reduce your Claude Code session context by 95%.

95% of your session is tool calls and tool results.

## Try it without installing

```
npx supercompact measure
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

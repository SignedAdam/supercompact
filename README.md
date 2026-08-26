# supercompact

Removes tool calls and tool results from a Claude Code session. Keeps the
messages. The session still resumes.

95% of a session is tool calls and results.

## Try it

```
npx supercompact measure
```

Reads every session on the machine. Writes nothing.

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
supercompact measure         the split across all sessions
supercompact list            recent sessions
```

`<id>` is the first few characters of a session id.

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

## Notes

Copying is the default and does not change the original. `--in-place` writes a
backup first.

A running session does not re-read its own file. `--in-place` takes effect on
resume. The command prints the resume line.

`measure` excludes images and the five newest tool results. Context sizes are
the token counts the API reports on each turn.

No dependencies, no network calls, Node 18 or newer. macOS and Linux. Windows
paths are untested.

## Build

```
npm install
npm run check
```

MIT.

```
███████╗██╗   ██╗██████╗ ███████╗██████╗
██╔════╝██║   ██║██╔══██╗██╔════╝██╔══██╗
███████╗██║   ██║██████╔╝█████╗  ██████╔╝
╚════██║██║   ██║██╔═══╝ ██╔══╝  ██╔══██╗
███████║╚██████╔╝██║     ███████╗██║  ██║
╚══════╝ ╚═════╝ ╚═╝     ╚══════╝╚═╝  ╚═╝
 ██████╗ ██████╗ ███╗   ███╗██████╗  █████╗  ██████╗████████╗
██╔════╝██╔═══██╗████╗ ████║██╔══██╗██╔══██╗██╔════╝╚══██╔══╝
██║     ██║   ██║██╔████╔██║██████╔╝███████║██║        ██║
██║     ██║   ██║██║╚██╔╝██║██╔═══╝ ██╔══██║██║        ██║
╚██████╗╚██████╔╝██║ ╚═╝ ██║██║     ██║  ██║╚██████╗   ██║
 ╚═════╝ ╚═════╝ ╚═╝     ╚═╝╚═╝     ╚═╝  ╚═╝ ╚═════╝   ╚═╝

╭────────────────────────────────────────────────────────────────╮
│ a4abe3a1   274k tokens   before supercompact                   │
├────────────────────────────────────────────────────────────────┤
│ tool traffic      ████████████████████           68%           │
│ starting context  ██████                         21%           │
│ you and Claude    ███                            11%           │
╰────────────────────────────────────────────────────────────────╯
                                 │
                                 ▼
╭────────────────────────────────────────────────────────────────╮
│ a4abe3a1    87k tokens   same id, same resume                  │
│ every message kept character for character · no model used     │
╰────────────────────────────────────────────────────────────────╯
```

[![npm](https://img.shields.io/npm/v/supercompact?style=for-the-badge&color=C8FF00&labelColor=000000&label=NPM)](https://www.npmjs.com/package/supercompact)
[![checks](https://img.shields.io/github/actions/workflow/status/SignedAdam/supercompact/check.yml?branch=main&style=for-the-badge&color=C8FF00&labelColor=000000&label=48%20CHECKS)](https://github.com/SignedAdam/supercompact/actions/workflows/check.yml)
[![node](https://img.shields.io/node/v/supercompact?style=for-the-badge&color=C8FF00&labelColor=000000&label=NODE)](https://nodejs.org)
[![dependencies](https://img.shields.io/badge/RUNTIME%20DEPS-0-C8FF00?style=for-the-badge&labelColor=000000)](package.json)
[![license](https://img.shields.io/npm/l/supercompact?style=for-the-badge&color=C8FF00&labelColor=000000&label=LICENSE)](LICENSE)

Up to 95% of the tokens in a heavy Claude Code session are tool traffic. `supercompact` strips that traffic out of the transcript on disk and gives you back the context window.

Every human message stays. Every assistant response stays. There is no model summarising your conversation and no loss of detail. You keep everything you agreed on, lose the machine's scratch work, and resume the session right where you left off.

Run this first. It reads your local sessions, calculates the token split across your history, and writes nothing:

```bash
npx supercompact measure
```

```
  3289 sessions, 365.5M tokens of context

  removed                   229.3M    63%  ████████████████··········
  starting context          112.3M    31%  ████████··················
  kept verbatim              24.0M     7%  ██························

  removed is tool calls and their results.
  starting context is your MCP tools, skills, CLAUDE.md files and so on.
  kept verbatim is every message you and Claude sent.

  your last 3 sessions

  session                                    now     after  starting  removed
  a4abe3a1-d4e9-4c99-823d-2d7d947564ce      274k       87k       58k      68%
  a8feeb50-76ad-424d-b150-df1e9185373d      998k      613k       49k      39%
  0f729543-99e5-4e56-8d31-ef3bcd0a2b47      563k      179k       51k      68%

  after is what the session weighs once it has been supercompacted.

  Your newest session starts with 58k already loaded. (You should fix this btw)

  436 of your sessions passed 200k tokens. The middle one drops by 87%.
  Your heaviest session held 1.0M tokens. 3k of it was the two of you talking.

  Context sizes are the numbers the API reported on each turn, not an estimate.
  The keep options hold some tool results back, and the preview prices them.

  Try it on this machine:  npx supercompact --preview
```

## Never throw away a session

Tool traffic is almost everything in a Claude Code transcript. Files read, shell commands, test runs, and build logs account for up to 95 percent of the variable tokens in a working session. The actual conversation is a fraction of the file.

When a session gets heavy, the standard move is to abandon it and start over. You throw away the history, re-explain the architecture from scratch, and waste time catching the agent back up.

I built this so sessions never have to die. When you strip the tool noise, the session stops being disposable. You keep the agreements, the architectural decisions, and the conclusions the agent reached. The evidence is gone, but the context stays.

## How this differs from `/compact`

Claude Code has a built-in `/compact` command. That command sends your conversation to a model and asks for a summary. The original wording is replaced with a paraphrase, and detail is lost.

`supercompact` does not use a model. It executes a direct rewrite of the JSONL session file on disk. Every human message and every assistant response stays character for character.

## Usage

Install globally or run it with `npx`.

```bash
npm install -g supercompact
```

By default, `supercompact` creates a new session file and leaves your original transcript untouched:

```bash
supercompact
```

```
kept 724 messages from you and 774 from Claude
  was  3.4 MB, 233 tool calls
  now  1.3 MB, about 180k tokens

  new session  1f4df052-7cea-4af3-97fc-e990d7dd707c
  resume it    cd '/Users/sauel/dev/agents' && claude --resume 1f4df052-7cea-4af3-97fc-e990d7dd707c

  0f729543 was not touched.
```

To rewrite the current session under its existing ID and name:

```bash
supercompact --in-place
```

`--in-place` writes a full backup copy of the original file before modifying anything. It also leaves the trailing entries alone so an active turn continues working.

Claude Code loads transcripts when it starts up. It does not monitor the file for changes while running. Resume the session to load the stripped state:

```bash
claude --resume <id>
```

To check the token reduction without writing anything:

```bash
supercompact --preview
```

## Reference

### Commands

```
supercompact                 copy the current session, stripped
supercompact <id>            copy that session
supercompact --in-place      rewrite it, same id and name
supercompact --preview       token cost, writes nothing
supercompact measure         the split across all your sessions
supercompact list            recent sessions
supercompact help            show the help
supercompact version         print the version
```

### Options

```
--tools            keep one line per tool call and drop the output
--keep-last N      keep the newest N messages unchanged
--keep-tools N     keep the newest N tool results
--unique-tools     with --keep-tools, repeated identical calls count once
--preview          print the token savings without writing any files
--in-place         rewrite the session file instead of making a copy
--json             output machine-readable JSON
--limit N          number of sessions to display with list
--project-dir P    look in project directory P instead of current directory
```

`<id>` is the first few characters of a session id, which `list` prints.

## Inside Claude Code

The repo includes a slash command and an agent skill under `agent/`. To install them:

```bash
cp agent/commands/supercompact.md ~/.claude/commands/
cp -r agent/skills/supercompact ~/.claude/skills/
```

Run `/supercompact` inside a session to shrink the active transcript in place:

```
/supercompact [tools] [keep N] [preview]
```

- `tools` keeps the tool call names and removes the output.
- `keep 10` leaves the last 10 messages unchanged.
- `preview` calculates the savings without writing anything.
- `copy` writes a new session instead of modifying the active file.

The skill lets Claude Code measure its own transcript and strip tool traffic autonomously when asked.

## Details

- Node.js 18 or higher. Tested on Node 18 and 22 in CI.
- Zero runtime dependencies.
- 48 tests run against throwaway session trees in CI on macOS and Ubuntu.
- Windows is untested.
- MIT license. Author Adam Albastov. Source code on [GitHub](https://github.com/SignedAdam/supercompact).

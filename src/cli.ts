#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';

import { head, Transcript } from './transcript.js';
import { fork, inPlace, messageCount, type Options, type Result } from './rewrite.js';
import { stampUsage, startingContext, tokensInJsonl } from './estimate.js';
import { after, buildPreview, type Step } from './preview.js';
import {
  heavyContext,
  heavyMedianShare,
  measure,
  medianShare,
  pooledShare,
  reclaimableTotal,
  sessionsPast,
} from './measure.js';
import * as store from './store.js';

const version = '1.0.0';

// Every option the tool accepts. Anything else is a typo, and a typo that is
// ignored without a word is worse than one that stops: --keep-tool 5 would
// quietly keep nothing at all.
const known = new Set([
  'tools',
  'keep-last',
  'keep-tools',
  'unique-tools',
  'preview',
  'in-place',
  'json',
  'project-dir',
  'limit',
  'help',
  'version',
]);

// Only these take the next word as their value, so a stray word after one stays
// a positional argument.
const valued = new Set(['keep-last', 'keep-tools', 'project-dir', 'limit']);

interface Args {
  positional: string[];
  switches: Set<string>;
  values: Map<string, string>;
}

function parse(raw: string[]): Args {
  const args: Args = { positional: [], switches: new Set(), values: new Map() };
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i]!;
    if (!item.startsWith('--')) {
      args.positional.push(item);
      continue;
    }
    const name = item.slice(2);
    const equals = name.indexOf('=');
    if (equals >= 0) {
      args.values.set(name.slice(0, equals), name.slice(equals + 1));
      args.switches.add(name.slice(0, equals));
      continue;
    }
    if (valued.has(name) && i + 1 < raw.length) {
      args.values.set(name, raw[++i]!);
      args.switches.add(name);
      continue;
    }
    args.switches.add(name);
  }

  for (const name of args.switches) {
    if (!known.has(name)) fail(`no such option: --${name}`);
  }
  for (const name of ['keep-last', 'keep-tools', 'limit']) {
    const raw = args.values.get(name);
    if (raw === undefined) continue;
    if (!/^\d+$/.test(raw)) fail(`--${name} wants a whole number, not "${raw}"`);
  }
  return args;
}

const has = (args: Args, name: string): boolean =>
  args.switches.has(name) || args.values.has(name);
const value = (args: Args, name: string): string => args.values.get(name) ?? '';
const number = (args: Args, name: string): number => Number(args.values.get(name) ?? 0);

function fail(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

// ── formatting ──────────────────────────────────────────────────────────────

function size(bytes: number): string {
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function tokens(n: number): string {
  // 999,600 rounds to 1000k, which nobody writes. It becomes 1.0M instead.
  if (n >= 999_500) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max) + '…' : flat;
}

function quote(text: string): string {
  return `'${text.replace(/'/g, `'"'"'`)}'`;
}

function bar(share: number, width: number): string {
  const filled = Math.min(width, Math.max(0, Math.round(share * width)));
  return '█'.repeat(filled) + '·'.repeat(width - filled);
}

function percent(share: number): string {
  const value = share * 100;
  const text = value > 0 && value < 1 ? value.toFixed(1) : String(Math.round(value));
  return `${text}%`.padStart(5);
}

// ── the session being acted on ──────────────────────────────────────────────

function open(args: Args): { transcript: Transcript; cwd: string } {
  const here = value(args, 'project-dir') || process.cwd();
  let path: string;
  try {
    const handle = args.positional[0];
    path = handle === undefined ? store.current(here) : store.find(handle);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  const transcript = new Transcript(path);
  const cwd = transcript.cwd;
  if (cwd === '') fail(`cannot tell which directory ${transcript.id.slice(0, 8)} belongs to`);
  return { transcript, cwd };
}

function options(args: Args): Options {
  return {
    toolLines: has(args, 'tools'),
    keep: {
      lastMessages: number(args, 'keep-last'),
      toolCalls: number(args, 'keep-tools'),
      unique: has(args, 'unique-tools'),
    },
  };
}

function currentTitle(transcript: Transcript): string {
  const title = store.titleOf(transcript.id, transcript.directory);
  if (title !== '') return title;
  const prompt = transcript.firstPrompt;
  return prompt === '' ? 'session' : oneLine(prompt, 48);
}

/** (SC1) the first time, (SC2) the next. In front rather than behind, so it
 * survives the truncation every session list does. */
function nextTitle(current: string): string {
  const match = /^\(SC(\d+)\)\s*/.exec(current);
  if (match === null) return '(SC1) ' + current;
  return `(SC${Number(match[1]) + 1}) ` + current.slice(match[0].length);
}

function heldNote(result: Result): string {
  const parts: string[] = [];
  if (result.toolLines > 0) parts.push(`${result.toolLines} tool lines`);
  if (result.keptCalls > 0) parts.push(`${result.keptCalls} tool results kept whole`);
  return parts.length === 0 ? '' : ', ' + parts.join(', ');
}

/** How many neighbouring sessions to look at before giving up. */
const neighboursToRead = 6;

/** How much of a neighbouring file the opening request is found in. */
const headBytes = 1_000_000;

/** The starting context for a session, read from the session itself where that
 * is possible and from its most recent neighbour where it is not.
 *
 * A long session that was resumed carries no short request to read from. The
 * figure also moves with the CLAUDE.md stack rather than being fixed, so a
 * neighbour in the same project is the closest thing to hand. The newest one
 * rather than the middle one, because the harness config drifts and the most
 * recent reading is nearest to what the next session will pay. */
function startingContextFor(transcript: Transcript): number {
  const own = startingContext(transcript.entries);
  if (own > 0) return own;
  return startingContextNear(transcript.directory, transcript.path);
}

/** The newest session beside this one that can answer the question. */
function startingContextNear(dir: string, exclude: string): number {
  const neighbours = store
    .sessionFilesIn(dir)
    .filter((path) => path !== exclude)
    .sort((a, b) => store.modified(b) - store.modified(a))
    .slice(0, neighboursToRead);

  for (const path of neighbours) {
    try {
      const reading = startingContext(head(path, headBytes));
      if (reading > 0) return reading;
    } catch {
      // a neighbour that will not open is not a reason to stop
    }
  }
  return 0;
}

// ── commands ────────────────────────────────────────────────────────────────

function runCopy(args: Args): void {
  const { transcript, cwd } = open(args);
  const result = fork(transcript, options(args));
  if (result.jsonl === '') fail(`${transcript.id.slice(0, 8)} has no dialogue to keep`);

  // Claude Code reads this back when the session opens. The transcript alone is
  // not what it will weigh, because the starting context is paid again.
  const count = tokensInJsonl(result.jsonl) + startingContextFor(transcript);
  const title = nextTitle(currentTitle(transcript));
  const path = store.write({
    jsonl: stampUsage(result.jsonl, count),
    sessionId: result.sessionId,
    cwd,
    title,
    firstPrompt: transcript.firstPrompt,
    messages: messageCount(result),
    gitBranch: transcript.gitBranch,
  });

  const resume = `cd ${quote(cwd)} && claude --resume ${result.sessionId}`;
  const before = transcript.counts();

  if (has(args, 'json')) {
    print({
      mode: 'copy',
      sessionId: result.sessionId,
      filePath: path,
      title,
      messages: messageCount(result),
      toolLines: result.toolLines,
      toolResultsKept: result.keptCalls,
      bytes: store.sizeOf(path),
      tokens: count,
      tokensAreEstimate: true,
      resumeCommand: resume,
      from: { sessionId: transcript.id, bytes: transcript.bytes, toolCalls: before.calls },
    });
    return;
  }

  say(`kept ${result.users} messages from you and ${result.assistants} from Claude`);
  say(`  was  ${size(transcript.bytes)}, ${before.calls} tool calls`);
  say(`  now  ${size(store.sizeOf(path))}, about ${tokens(count)} tokens${heldNote(result)}`);
  say('');
  say(`  new session  ${result.sessionId}`);
  say(`  resume it    ${resume}`);
  say('');
  say(`  ${transcript.id.slice(0, 8)} was not touched.`);
}

function runInPlace(args: Args): void {
  const { transcript, cwd } = open(args);

  // The copy goes first. If it cannot be written, the original is never
  // touched and the run stops here with the reason.
  const copyId = randomUUID();
  const copyTitle = `${currentTitle(transcript)} copy_${store.stamp()}`;
  try {
    store.write({
      jsonl: readFileSync(transcript.path, 'utf8').split(transcript.id).join(copyId),
      sessionId: copyId,
      cwd,
      title: copyTitle,
      firstPrompt: transcript.firstPrompt,
      messages: 0,
      gitBranch: transcript.gitBranch,
    });
  } catch (error) {
    fail(`could not write the safekeeping copy, so nothing was changed: ${String(error)}`);
  }

  const result = inPlace(transcript, options(args));
  if (result.jsonl === '') fail(`${transcript.id.slice(0, 8)} has no dialogue to keep`);

  // Claude Code reads this back when the session opens. The transcript alone is
  // not what it will weigh, because the starting context is paid again.
  const count = tokensInJsonl(result.jsonl) + startingContextFor(transcript);
  try {
    store.replace(transcript.path, stampUsage(result.jsonl, count));
  } catch (error) {
    fail(`the rewrite failed and the session is unchanged. The copy is ${copyId}: ${String(error)}`);
  }

  const title = nextTitle(currentTitle(transcript));
  store.rename(transcript.id, transcript.directory, title);

  const afterBytes = store.sizeOf(transcript.path);
  const resume = `cd ${quote(cwd)} && claude --resume ${transcript.id}`;

  if (has(args, 'json')) {
    print({
      mode: 'in-place',
      sessionId: transcript.id,
      title,
      copySessionId: copyId,
      copyTitle,
      messages: messageCount(result),
      toolLines: result.toolLines,
      toolResultsKept: result.keptCalls,
      preservedEntries: result.preservedTail,
      bytesBefore: transcript.bytes,
      bytesAfter: afterBytes,
      tokens: count,
      tokensAreEstimate: true,
      resumeCommand: resume,
    });
    return;
  }

  say(`rewrote ${transcript.id.slice(0, 8)} in place, same id and same name`);
  say(`  was  ${size(transcript.bytes)}`);
  say(
    `  now  ${size(afterBytes)}, about ${tokens(count)} tokens, ` +
      `${messageCount(result)} messages${heldNote(result)}`,
  );
  say(`  the last ${result.preservedTail} entries were left alone so this turn still works`);
  say('');
  say(`  full copy  ${copyId}`);
  say(`             ${copyTitle}`);
  say('');
  say('  This window still holds the old conversation. It shrinks when you resume:');
  say(`  ${resume}`);
}

function runPreview(args: Args): void {
  const { transcript } = open(args);
  const opts = options(args);
  const preview = buildPreview(transcript);
  const starting = startingContextFor(transcript);
  // The before side is what the API charged, and that carries the starting
  // context. Leaving it off the after side would report the gap between the two
  // as a saving.
  const kept = after(preview, opts.toolLines, opts.keep);
  const total = kept + starting;
  const saved = Math.max(0, preview.now - total);
  const share = preview.now > 0 ? (saved / preview.now) * 100 : 0;
  const held = kept - preview.dialogue - (opts.toolLines ? preview.toolLines : 0);

  if (has(args, 'json')) {
    print({
      sessionId: transcript.id,
      tokensAreEstimate: true,
      startingContext: starting,
      now: {
        tokens: preview.now,
        reported: preview.nowReported,
        bytes: preview.bytes,
        messages: preview.messages,
        toolCalls: preview.calls,
      },
      after: { tokens: total, transcript: kept, heldBack: held },
      saved: { tokens: saved, percent: Math.round(share * 10) / 10 },
      asked: {
        tools: opts.toolLines,
        keepLast: opts.keep.lastMessages,
        keepTools: opts.keep.toolCalls,
        unique: opts.keep.unique,
      },
      // Every option priced on its own, so a menu can add up any combination
      // without calling this again.
      costs: {
        dialogue: preview.dialogue,
        toolLines: preview.toolLines,
        keepLast: preview.lastMessages,
        keepTools: preview.toolCalls,
        keepUniqueTools: preview.uniqueCalls,
      },
    });
    return;
  }

  const source = preview.nowReported ? 'as the API reported it' : 'estimated';
  say(`${transcript.id.slice(0, 8)}, ${size(preview.bytes)}, ${preview.messages} messages`);
  say(`  now    ${tokens(preview.now)} tokens (${source})`);
  say(
    `  after  about ${tokens(total)} tokens` +
      (held > 0 ? `, ${tokens(held)} of it held back on purpose` : ''),
  );
  say(`  saved  about ${tokens(saved)} tokens, ${Math.round(share)} percent`);
  if (starting > 0) {
    say(
      `  ${tokens(starting)} of the after figure is the starting context, ` +
        'which no rewrite removes.',
    );
  }
  say('');
  say('  what each option costs:');
  say(`    dialogue only      ${tokens(preview.dialogue)}`);
  say(`    one line per call  ${tokens(preview.toolLines)}`);
  say(`    --keep-last        ${ladderLine(preview.lastMessages)}`);
  say(`    --keep-tools       ${ladderLine(preview.toolCalls)}`);
  say(`    with --unique      ${ladderLine(preview.uniqueCalls)}`);
  say('');
  say('  Nothing was written.');
}

function ladderLine(steps: Step[]): string {
  return steps.map((step) => `${step.n}: ${tokens(step.tokens)}`).join('   ');
}

/** Past this, the starting context is large enough that it is costing the
 * person real room in every session they open. */
const bloatedStartingContext = 25_000;

/** How many of the newest sessions get a line of their own. */
const recentSessions = 3;

async function runMeasure(args: Args): Promise<void> {
  const paths = store.allSessionFiles();
  if (paths.length === 0) fail(`no sessions found under ${store.root()}`);

  const quiet = has(args, 'json') || !process.stderr.isTTY;
  const m = await measure(paths, quiet ? undefined : (done) => {
    process.stderr.write(`\rreading ${done} of ${paths.length} sessions`);
  });
  if (!quiet) process.stderr.write('\r[K');

  if (m.sessions === 0) {
    fail(`none of the ${paths.length} session files has reported a context size yet`);
  }

  const reclaim = reclaimableTotal(m);
  const pooled = pooledShare(m);
  const median = medianShare(m);
  const dialogueShare = m.context === 0 ? 0 : m.dialogue / m.context;
  const startingShare = m.context === 0 ? 0 : m.starting / m.context;
  const heavyMedian = heavyMedianShare(m);
  // A session with no short request of its own reads nothing, and showing that
  // as a zero would count the starting context as removed. These few are worth
  // asking a neighbour about.
  const recent = [...m.sizes]
    .sort((a, b) => store.modified(b.path) - store.modified(a.path))
    .slice(0, recentSessions)
    .map((size) => {
      const room = Math.max(0, size.context - size.dialogue);
      const starting =
        size.starting > 0
          ? size.starting
          : Math.min(startingContextNear(dirname(size.path), size.path), room);
      const id = basename(size.path).replace(/\.jsonl$/, '');
      return {
        id,
        name: store.titleOf(id, dirname(size.path)) || id.slice(0, 8),
        context: size.context,
        starting,
        kept: size.dialogue,
        removed: Math.max(0, room - starting),
      };
    });

  if (has(args, 'json')) {
    print({
      sessions: m.sessions,
      filesSeen: paths.length,
      contextTokens: m.context,
      dialogueTokens: m.dialogue,
      reclaimableTokens: reclaim,
      startingContextTokens: m.starting,
      reclaimable: {
        pooled: Math.round(pooled * 1000) / 10,
        median: Math.round(median * 1000) / 10,
      },
      recent: recent.map((row) => ({
        session: row.id,
        title: row.name,
        contextTokens: row.context,
        removedTokens: row.removed,
        startingContextTokens: row.starting,
        keptTokens: row.kept,
      })),
      filledUp: {
        overTokens: heavyContext,
        sessions: m.heavyShares.length,
        median: Math.round(heavyMedian * 1000) / 10,
      },
      sessionsPast90: sessionsPast(m, 0.9),
      sessionsPast95: sessionsPast(m, 0.95),
      heaviest:
        m.heaviest === undefined
          ? null
          : {
              session: basename(m.heaviest.path).replace(/\.jsonl$/, ''),
              contextTokens: m.heaviest.context,
              dialogueTokens: m.heaviest.dialogue,
            },
    });
    return;
  }

  say('');
  say(`  ${m.sessions} sessions, ${tokens(m.context)} tokens of context`);
  say('');
  say(
    `  removed                 ${tokens(reclaim).padStart(8)}  ${percent(pooled)}  ` +
      bar(pooled, 26),
  );
  say(
    `  starting context        ${tokens(m.starting).padStart(8)}  ${percent(startingShare)}  ` +
      bar(startingShare, 26),
  );
  say(
    `  kept verbatim           ${tokens(m.dialogue).padStart(8)}  ${percent(dialogueShare)}  ` +
      bar(dialogueShare, 26),
  );
  say('');
  say('  removed is tool calls and their results.');
  say('  starting context is your MCP tools, skills, CLAUDE.md files and so on.');
  say('  kept verbatim is every message you and Claude sent.');
  if (recent.length > 0) {
    say('');
    say('  your last 3 sessions');
    say('');
    say(
      '  ' +
        'current context'.padStart(17) +
        'after supercompaction'.padStart(23) +
        'starting context'.padStart(18) +
        'removed'.padStart(10),
    );
    for (const row of recent) {
      const share = row.context === 0 ? 0 : row.removed / row.context;
      // The full id, because the next thing someone does with it is paste it
      // into a command.
      say(`  ${row.id}`);
      say(
        '  ' +
          tokens(row.context).padStart(17) +
          tokens(row.starting + row.kept).padStart(23) +
          tokens(row.starting).padStart(18) +
          percent(share).padStart(10),
      );
    }
    const newest = recent[0];
    if (newest !== undefined && newest.starting > bloatedStartingContext) {
      say('');
      say(
        `  Your newest session starts with ${tokens(newest.starting)} already loaded. ` +
          '(You should fix this btw)',
      );
    }
  }
  say('');
  say(
    `  ${m.heavyShares.length} of your sessions passed ${tokens(heavyContext)} tokens. ` +
      `The middle one drops by ${percent(heavyMedian).trim()}.`,
  );
  if (m.heaviest !== undefined) {
    say(
      `  Your heaviest session held ${tokens(m.heaviest.context)} tokens. ` +
        `${tokens(m.heaviest.dialogue)} of it was the two of you talking.`,
    );
  }
  say('');
  say('  Context sizes are the numbers the API reported on each turn, not an estimate.');
  say('  The keep options hold some tool results back, and the preview prices them.');
  say('');
  say('  Try it on this machine:  npx supercompact --preview');
  say('');
}

function runList(args: Args): void {
  const limit = number(args, 'limit') || 20;
  const paths = store
    .allSessionFiles()
    .sort((a, b) => store.modified(b) - store.modified(a));

  let shown = 0;
  for (const path of paths) {
    if (shown >= limit) break;
    let transcript: Transcript;
    try {
      transcript = new Transcript(path);
    } catch {
      continue;
    }
    const counts = transcript.counts();
    if (counts.users === 0) continue;

    const title =
      store.titleOf(transcript.id, transcript.directory) || transcript.firstPrompt || 'untitled';
    say(`[${transcript.id.slice(0, 8)}]  ${oneLine(title, 64)}`);
    say(
      `  ${counts.users} from you, ${counts.assistants} from Claude, ` +
        `${counts.calls} tool calls, ${size(transcript.bytes)}, ${ago(store.modified(path))}`,
    );
    if (transcript.cwd !== '') say(`  ${transcript.cwd}`);
    say('');
    shown++;
  }

  if (shown === 0) say(`no sessions found under ${store.root()}`);
}

function ago(at: number): string {
  const seconds = (Date.now() - at) / 1000;
  if (seconds < 90) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

function say(line: string): void {
  process.stdout.write(line + '\n');
}

function print(payload: unknown): void {
  say(JSON.stringify(payload, null, 2));
}

// ── entry ───────────────────────────────────────────────────────────────────

const help = `supercompact — keep the conversation, drop everything the machine fetched

USAGE
  npx supercompact measure             how much of your context is not conversation
  supercompact [<session>] [options]   rewrite a session down to its dialogue
  supercompact list [--limit N]        recent sessions
  supercompact help

  <session> is the first few characters of a session id, from \`list\`.
  With no session it acts on the one running in this directory.

WHAT IT KEEPS
  Everything you typed and everything Claude said back, word for word.
  Nothing is summarised.

WHAT IT DROPS
  Tool calls and their output: files read, commands run, pages fetched,
  screenshots taken. That is where the room comes from.

OPTIONS
  --tools             One line per tool call saying what ran, never what
                      it returned
  --keep-last N       Leave the last N messages exactly as they are, tool
                      output included
  --keep-tools N      Give the newest N tool calls their full output
  --unique-tools      A call that repeats counts once against --keep-tools
  --preview           Print what it would cost. Writes nothing.
  --in-place          Rewrite this session instead of copying it, keeping its
                      id and its name. A full copy is written first.
  --json              Machine-readable output
  --project-dir PATH  Look for the running session in PATH instead of here
  --limit N           How many sessions \`list\` shows (default 20)

SAFETY
  Copying is the default and never touches the original. --in-place writes a
  full copy before it changes anything, and leaves the turn in progress alone
  so a session that is still running can carry on.

AFTER IT RUNS
  A live session never re-reads its own file, so nothing shrinks until you
  resume it. The command prints how.
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const first = argv[0];

  if (first === 'measure') return runMeasure(parse(argv.slice(1)));
  if (first === 'list') return runList(parse(argv.slice(1)));
  if (first === 'help' || first === '--help' || first === '-h') return say(help.trimEnd());
  if (first === 'version' || first === '--version') return say(`supercompact ${version}`);

  const args = parse(argv);
  if (has(args, 'preview')) return runPreview(args);
  if (has(args, 'in-place')) return runInPlace(args);
  return runCopy(args);
}

await main();

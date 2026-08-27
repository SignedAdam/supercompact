// How much of a context window is the conversation, and how much of the rest
// can actually be given back.
//
// Nothing here is estimated on the heavy side. Every assistant turn carries the
// token count the API itself reported for that request, so the size of the
// context is a measured fact rather than a guess. Walk the file, add up the
// words both sides actually said, and compare the two at the turn where the
// context was largest.
//
// What is removed here is what the tool removes with no options given: every
// tool call, every tool result, and the images inside them. The keep options
// hold some of that back, and a session rewritten with them is larger by
// exactly the amount the preview prices.

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

import { assistantText, promptText } from './dialogue.js';
import { charsPerToken, StartingContext } from './estimate.js';
import { isRecord } from './transcript.js';

/** A line this long is always tool output and never anything anyone said. */
const skipLinesOver = 120_000;

/** Below this a session never filled anything up and says nothing useful about
 * a context window. */
export const minimumContext = 20_000;

/** An example worth printing comes from a session someone worked in. */
const exampleContext = 100_000;

/** A session that never got big says little about a tool for sessions that did.
 * Below this, most of the context is the starting context, and no rewrite gives
 * that back. */
export const heavyContext = 200_000;

export interface SessionSize {
  path: string;
  context: number;
  dialogue: number;
  /** The system prompt, the tool schemas and the CLAUDE.md files. Paid again by
   * every session, so no rewrite gives it back. */
  starting: number;
}

export function reclaimable(size: SessionSize): number {
  return Math.max(0, size.context - size.dialogue - size.starting);
}

export interface Measurement {
  sessions: number;
  context: number;
  dialogue: number;
  starting: number;
  /** Every session that reported a size, so a caller can pick out its own. */
  sizes: SessionSize[];
  /** Per session, the share of its own context that could be given back. */
  shares: number[];
  /** The same, for the sessions that actually filled up. */
  heavyShares: number[];
  heaviest?: SessionSize;
}

export function reclaimableTotal(m: Measurement): number {
  return Math.max(0, m.context - m.dialogue - m.starting);
}

export function pooledShare(m: Measurement): number {
  return m.context === 0 ? 0 : reclaimableTotal(m) / m.context;
}

export function medianShare(m: Measurement): number {
  if (m.shares.length === 0) return 0;
  return m.shares[Math.floor(m.shares.length / 2)] ?? 0;
}

/** The middle session among those that filled up, which is the only group the
 * tool is for. */
export function heavyMedianShare(m: Measurement): number {
  if (m.heavyShares.length === 0) return 0;
  return m.heavyShares[Math.floor(m.heavyShares.length / 2)] ?? 0;
}

/** How many sessions could give back at least this share of their context. */
export function sessionsPast(m: Measurement, share: number): number {
  return m.shares.filter((value) => value >= share).length;
}

export async function measure(
  paths: string[],
  onProgress?: (done: number) => void,
): Promise<Measurement> {
  const m: Measurement = {
    sessions: 0,
    context: 0,
    dialogue: 0,
    starting: 0,
    sizes: [],
    shares: [],
    heavyShares: [],
  };

  // Reading is the slow part and the files are independent, so a handful are
  // in flight at once.
  const width = 8;
  let next = 0;
  let done = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= paths.length) return;
      const path = paths[index]!;
      let size: SessionSize | undefined;
      try {
        size = await measureOne(path);
      } catch {
        size = undefined;
      }
      done++;
      if (onProgress && done % 200 === 0) onProgress(done);
      if (size === undefined) continue;

      m.sessions++;
      m.context += size.context;
      m.dialogue += size.dialogue;
      m.starting += size.starting;
      m.sizes.push(size);
      if (
        size.context >= exampleContext &&
        size.dialogue > 0 &&
        (m.heaviest === undefined || size.context > m.heaviest.context)
      ) {
        m.heaviest = size;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(width, paths.length) }, worker));

  // A session whose opening request was too large to trust reports a starting
  // context of 0, and subtracting nothing would score it as almost entirely
  // reclaimable. No session gives back all of its context, so stand in the
  // middle of the figures we do trust rather than publish an impossible share.
  const known = m.sizes.filter((size) => size.starting > 0).map((size) => size.starting);
  known.sort((a, b) => a - b);
  const typical = known.length === 0 ? 0 : known[Math.floor(known.length / 2)]!;

  for (const size of m.sizes) {
    const starting = size.starting > 0 ? size.starting : typical;
    const room = Math.max(0, size.context - size.dialogue - starting);
    const share = size.context === 0 ? 0 : room / size.context;
    m.shares.push(share);
    if (size.context >= heavyContext) m.heavyShares.push(share);
  }

  m.shares.sort((a, b) => a - b);
  m.heavyShares.sort((a, b) => a - b);
  return m;
}

/** The turn where a session's context was largest, how much of it had been said
 * out loud by then, and how much of it the session was carrying before either
 * of them had said anything. */
export async function measureOne(path: string): Promise<SessionSize | undefined> {
  let spoken = 0;
  const starting = new StartingContext();
  let best: { context: number; dialogue: number } | undefined;

  const lines = createInterface({
    input: createReadStream(path),
    crlfDelay: Infinity,
  });

  for await (const line of lines) {
    // A line this long is a screenshot or a very large file read. Parsing it
    // costs more than the rest of the file put together, so it is priced from
    // the outside instead.
    if (line.length > skipLinesOver) {
      starting.carriedTokens(Math.round(line.length / charsPerToken));
      continue;
    }

    // A substring test on the compact form is what makes measure fast enough to
    // walk thousands of files, but a pretty-printed session would slip past it
    // and be reported as having no sizes at all, so allow the space too.
    const isUser = line.includes('"type":"user"') || line.includes('"type": "user"');
    const isAssistant =
      !isUser &&
      (line.includes('"type":"assistant"') || line.includes('"type": "assistant"'));
    if (!isUser && !isAssistant) continue;

    if (isUser && line.includes('"tool_result"')) {
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(record)) continue;
      const message = record.message;
      if (!isRecord(message)) continue;
      starting.carried(message.content);
      continue;
    }

    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(record)) continue;
    if (record.isSidechain === true) continue;
    const message = record.message;
    if (!isRecord(message)) continue;

    if (record.type === 'user') {
      const text = promptText(message.content);
      if (text !== undefined) spoken += text.length / charsPerToken;
      starting.carried(message.content);
      continue;
    }
    if (record.type !== 'assistant') continue;

    spoken += assistantText(message.content).length / charsPerToken;

    // A session this tool rewrote carries a stamped estimate. Reading that back
    // would be measuring our own arithmetic.
    if (record.usageIsEstimate === true) {
      starting.carried(message.content);
      continue;
    }
    const usage = message.usage;
    if (!isRecord(usage)) {
      starting.carried(message.content);
      continue;
    }
    const context =
      count(usage.input_tokens) +
      count(usage.cache_read_input_tokens) +
      count(usage.cache_creation_input_tokens);
    starting.request(context);
    starting.carried(message.content);
    if (best === undefined || context > best.context) {
      best = { context, dialogue: Math.min(Math.trunc(spoken), context) };
    }
  }

  if (best === undefined || best.context < minimumContext) return undefined;

  const room = Math.max(0, best.context - best.dialogue);
  return {
    path,
    context: best.context,
    dialogue: best.dialogue,
    starting: Math.min(starting.value, room),
  };
}

function count(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

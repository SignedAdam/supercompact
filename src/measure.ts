// How much of a context window is the conversation, and how much of the rest
// can actually be given back.
//
// Nothing here is estimated on the heavy side. Every assistant turn carries the
// token count the API itself reported for that request, so the size of the
// context is a measured fact rather than a guess. Walk the file, add up the
// words both sides actually said, and compare the two at the turn where the
// context was largest.
//
// The figure this reports is deliberately the floor. Two things that could be
// counted as recoverable are held back instead:
//
//   images         a screenshot may be the only reason a turn made sense
//   recent calls   whatever was just read or run is state you are standing in
//
// Both are recoverable in practice, and the tool will drop them if asked. They
// are excluded here so the number cannot be argued down.

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

import { assistantText, promptText } from './dialogue.js';
import { charsPerToken, imageTokens, tokensInContent } from './estimate.js';
import { isRecord } from './transcript.js';

/** A line this long is always tool output and never anything anyone said. */
const skipLinesOver = 120_000;

/** Below this a session never filled anything up and says nothing useful about
 * a context window. */
export const minimumContext = 20_000;

/** An example worth printing comes from a session someone worked in. */
const exampleContext = 100_000;

/** How many of the newest tool results are treated as state worth keeping. */
export const recentCallsHeldBack = 5;

export interface SessionSize {
  path: string;
  context: number;
  dialogue: number;
  /** Images and the newest few tool results, left out of the reclaimable side. */
  heldBack: number;
}

export function reclaimable(size: SessionSize): number {
  return Math.max(0, size.context - size.dialogue - size.heldBack);
}

export interface Measurement {
  sessions: number;
  context: number;
  dialogue: number;
  heldBack: number;
  /** Per session, the share of its own context that could be given back. */
  shares: number[];
  heaviest?: SessionSize;
}

export function reclaimableTotal(m: Measurement): number {
  return Math.max(0, m.context - m.dialogue - m.heldBack);
}

export function pooledShare(m: Measurement): number {
  return m.context === 0 ? 0 : reclaimableTotal(m) / m.context;
}

export function medianShare(m: Measurement): number {
  if (m.shares.length === 0) return 0;
  return m.shares[Math.floor(m.shares.length / 2)] ?? 0;
}

/** How many sessions could give back at least this share of their context. */
export function sessionsPast(m: Measurement, share: number): number {
  return m.shares.filter((value) => value >= share).length;
}

export async function measure(
  paths: string[],
  onProgress?: (done: number) => void,
): Promise<Measurement> {
  const m: Measurement = { sessions: 0, context: 0, dialogue: 0, heldBack: 0, shares: [] };

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
      m.heldBack += size.heldBack;
      m.shares.push(reclaimable(size) / size.context);
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
  m.shares.sort((a, b) => a - b);
  return m;
}

/** The turn where a session's context was largest, how much of it had been said
 * out loud by then, and how much of the remainder is being left alone. */
export async function measureOne(path: string): Promise<SessionSize | undefined> {
  let spoken = 0;
  let images = 0;
  const recent: number[] = [];
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
      const shots = countImages(line);
      if (shots > 0) images += shots * imageTokens(sizeOfImage(line));
      recent.push(Math.round(line.length / charsPerToken));
      if (recent.length > recentCallsHeldBack) recent.shift();
      continue;
    }

    const isUser = line.includes('"type":"user"');
    const isAssistant = !isUser && line.includes('"type":"assistant"');
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
      recent.push(tokensInContent(message.content));
      if (recent.length > recentCallsHeldBack) recent.shift();
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
      continue;
    }
    if (record.type !== 'assistant') continue;

    spoken += assistantText(message.content).length / charsPerToken;

    // A session this tool rewrote carries a stamped estimate. Reading that back
    // would be measuring our own arithmetic.
    if (record.usageIsEstimate === true) continue;
    const usage = message.usage;
    if (!isRecord(usage)) continue;
    const context =
      count(usage.input_tokens) +
      count(usage.cache_read_input_tokens) +
      count(usage.cache_creation_input_tokens);
    if (best === undefined || context > best.context) {
      best = { context, dialogue: Math.min(Math.trunc(spoken), context) };
    }
  }

  if (best === undefined || best.context < minimumContext) return undefined;

  const held = images + recent.reduce((total, tokens) => total + tokens, 0);
  return {
    path,
    context: best.context,
    dialogue: best.dialogue,
    heldBack: Math.min(held, Math.max(0, best.context - best.dialogue)),
  };
}

function countImages(line: string): number {
  const matches = line.match(/"type":"image"/g);
  return matches === null ? 0 : matches.length;
}

function sizeOfImage(line: string): [number, number] | undefined {
  const match = /\((\d{2,5})x(\d{2,5})/.exec(line.slice(0, 4000));
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2])];
}

function count(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

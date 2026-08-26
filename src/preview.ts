// What a rewrite would cost, worked out without writing anything.
//
// A menu that asks this on every click cannot wait for the file to be rebuilt
// each time, so nothing is rebuilt. One pass prices each option on its own and
// the caller adds up whichever ones are switched on.

import { promptText, signature, stripNoise, summarize } from './dialogue.js';
import { tokensInContent, tokensInText } from './estimate.js';
import type { Keep } from './keep.js';
import { isRecord, type Transcript } from './transcript.js';

export interface Step {
  n: number;
  tokens: number;
}

export interface Preview {
  /** What the session weighs. Reported by the API where the transcript carries
   * it, estimated only when it does not. */
  now: number;
  nowReported: boolean;
  bytes: number;

  /** Dialogue alone is what a rewrite with no options keeps. */
  dialogue: number;
  /** What one line per call would add. */
  toolLines: number;

  lastMessages: Step[];
  toolCalls: Step[];
  uniqueCalls: Step[];

  messages: number;
  calls: number;
}

export const messageLadder = [2, 5, 10, 20, 40];
export const toolLadder = [1, 3, 5, 10, 20];

export function after(preview: Preview, withToolLines: boolean, keep: Keep): number {
  let total = preview.dialogue;
  if (withToolLines) total += preview.toolLines;
  total += costAt(preview.lastMessages, keep.lastMessages);
  total += costAt(keep.unique ? preview.uniqueCalls : preview.toolCalls, keep.toolCalls);
  return total;
}

/** The N a caller asks for may sit between two rungs. The rung at or below it
 * is the honest answer. */
export function costAt(steps: Step[], n: number): number {
  if (n <= 0 || steps.length === 0) return 0;
  let best = 0;
  for (const step of steps) if (step.n <= n) best = step.tokens;
  return best === 0 ? (steps[0]?.tokens ?? 0) : best;
}

export function buildPreview(transcript: Transcript): Preview {
  const preview: Preview = {
    now: 0,
    nowReported: false,
    bytes: transcript.bytes,
    dialogue: 0,
    toolLines: 0,
    lastMessages: [],
    toolCalls: [],
    uniqueCalls: [],
    messages: 0,
    calls: 0,
  };

  const calls: { id: string; sig: string; tokens: number }[] = [];
  const answers = new Map<string, number>();
  const messages: number[] = [];
  const extras = new Map<number, number>();
  let reported = 0;

  const addExtra = (index: number, tokens: number): void => {
    extras.set(index, (extras.get(index) ?? 0) + tokens);
  };

  for (const entry of transcript.entries) {
    const message = entry.message;
    if (message === undefined) continue;

    if (entry.type === 'assistant' && entry.data.usageIsEstimate !== true) {
      const usage = message.usage;
      if (isRecord(usage)) {
        const held =
          num(usage.input_tokens) +
          num(usage.cache_read_input_tokens) +
          num(usage.cache_creation_input_tokens);
        if (held > 0) reported = held;
      }
    }

    if (entry.type === 'user') {
      const text = promptText(entry.content);
      if (text !== undefined) {
        preview.dialogue += tokensInText(stripNoise(text));
        // An image pasted into a prompt is dropped by a plain rewrite and kept
        // by the window, so it is priced with the window, not the dialogue.
        const pasted = entry.blocks.filter((block) => block.type === 'image').length;
        if (pasted > 0) addExtra(entry.index, pasted * 1500);
        messages.push(entry.index);
        preview.messages++;
        continue;
      }
      for (const block of entry.blocks) {
        if (block.type !== 'tool_result') continue;
        const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
        const tokens = tokensInContent([block]);
        answers.set(id, tokens);
        addExtra(entry.index, tokens);
      }
      continue;
    }

    if (entry.type !== 'assistant') continue;

    messages.push(entry.index);
    preview.messages++;
    for (const block of entry.blocks) {
      if (block.type === 'text') {
        preview.dialogue += tokensInText(typeof block.text === 'string' ? block.text : '');
      } else if (block.type === 'tool_use') {
        const id = typeof block.id === 'string' ? block.id : '';
        if (id === '') continue;
        preview.toolLines += tokensInText(summarize(block));
        const tokens = tokensInContent([block]);
        preview.calls++;
        calls.push({ id, sig: signature(block), tokens });
        addExtra(entry.index, tokens);
      }
    }
  }

  if (reported > 0) {
    preview.now = reported;
    preview.nowReported = true;
  } else {
    let total = preview.dialogue + preview.toolLines;
    for (const tokens of extras.values()) total += tokens;
    preview.now = total;
  }

  preview.lastMessages = messageLadder.map((n) => {
    const start = messages[Math.max(0, messages.length - n)];
    let tokens = 0;
    if (start !== undefined) {
      for (const [index, value] of extras) if (index >= start) tokens += value;
    }
    return { n, tokens };
  });

  const newestFirst = [...calls].reverse();
  preview.toolCalls = ladder(newestFirst, answers, false);
  preview.uniqueCalls = ladder(newestFirst, answers, true);
  return preview;
}

function ladder(
  newestFirst: { id: string; sig: string; tokens: number }[],
  answers: Map<string, number>,
  unique: boolean,
): Step[] {
  let running = 0;
  let taken = 0;
  const seen = new Set<string>();
  const byCount = new Map<number, number>();
  const ceiling = Math.max(...toolLadder);

  for (const call of newestFirst) {
    const answer = answers.get(call.id);
    if (answer === undefined) continue;
    if (unique) {
      if (seen.has(call.sig)) continue;
      seen.add(call.sig);
    }
    running += answer + call.tokens;
    taken++;
    if (toolLadder.includes(taken)) byCount.set(taken, running);
    if (taken >= ceiling) break;
  }

  let last = 0;
  return toolLadder.map((n) => {
    last = byCount.get(n) ?? last;
    return { n, tokens: last };
  });
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

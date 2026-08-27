// Token arithmetic, and the one place a session records how big it is.
//
// Claude Code, the context reading in the status line and any warning hook all
// size a session from the usage block on an assistant message. A rewrite that
// strips those and stops leaves every one of them with nothing to read, so the
// new size goes back on before the file is written.

import { decode, encode, isRecord, type Entry } from './transcript.js';

/** A character rate, not a tokenizer. Anthropic ships no offline tokenizer, so
 * anything derived from this is called an estimate wherever a person sees it. */
export const charsPerToken = 3.7;

export function tokensInText(text: string): number {
  return Math.round(text.length / charsPerToken);
}

/** Prices a message body, following tool results into whatever they carried. */
export function tokensInContent(content: unknown): number {
  if (typeof content === 'string') return tokensInText(content);
  if (!Array.isArray(content)) return 0;

  let total = 0;
  let size: [number, number] | undefined;
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === 'text') {
      const text = typeof block.text === 'string' ? block.text : '';
      size ??= imageSize(text);
      total += tokensInText(text);
    } else if (block.type === 'image') {
      total += imageTokens(size);
    } else if (block.type === 'tool_result') {
      total += tokensInContent(block.content);
    }
  }
  return total;
}

export function tokensInJsonl(jsonl: string): number {
  let total = 0;
  for (const line of jsonl.split('\n')) {
    if (line === '') continue;
    const record = decode(line);
    if (record === undefined) continue;
    if (record.type !== 'user' && record.type !== 'assistant') continue;
    const message = record.message;
    if (!isRecord(message)) continue;
    total += tokensInContent(message.content);
  }
  return total;
}

/** Anthropic's own sizing: width times height over 750. A tool result usually
 * prints the dimensions on the line above the data, which is cheaper to read
 * than the base64 and much closer to the truth than its length. */
export function imageTokens(size: [number, number] | undefined): number {
  if (size === undefined) return 1500;
  return Math.min(Math.max(Math.floor((size[0] * size[1]) / 750), 200), 2400);
}

function imageSize(text: string): [number, number] | undefined {
  const match = /\((\d{2,5})x(\d{2,5})/.exec(text);
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2])];
}

/** Below this figure a request never carried a real starting context, so it is
 * something else and not worth reading. */
const leastReportedRequest = 5_000;

/** The subtraction below stays sound only while the transcript in front of the
 * request is short. Past this the character rate has drifted too far. */
const mostTranscriptInFront = 25_000;

/** Above this the session is being charged for a history the file does not
 * contain, which is what a resumed session looks like from the inside. */
const mostStartingContext = 150_000;

/** What a request carried, rather than what a person said.
 *
 * `tokensInContent` prices a message for a reader, so it passes over thinking
 * and over the arguments a tool was called with. The subtraction in
 * `startingContext` cannot pass over anything, because the figure it subtracts
 * from is what the API charged for the whole request. */
export function tokensAsCharged(content: unknown): number {
  if (typeof content === 'string') return tokensInText(content);
  if (!Array.isArray(content)) return 0;

  let total = 0;
  let size: [number, number] | undefined;
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === 'text') {
      const text = typeof block.text === 'string' ? block.text : '';
      size ??= imageSize(text);
      total += tokensInText(text);
    } else if (block.type === 'thinking') {
      total += tokensInText(typeof block.thinking === 'string' ? block.thinking : '');
    } else if (block.type === 'tool_use') {
      total += tokensInText(JSON.stringify(block.input ?? {}));
    } else if (block.type === 'image') {
      total += imageTokens(size);
    } else if (block.type === 'tool_result') {
      total += tokensAsCharged(block.content);
    }
  }
  return total;
}

/** The context a session carries before anyone has typed anything: the system
 * prompt, the tool schemas, the CLAUDE.md files, the memory index and the skill
 * listing. No rewrite removes any of it, and it is paid again every time the
 * session opens, so a projection that leaves it out reads far below what the
 * window will show.
 *
 * Nothing in the file states the figure. It is the difference between what the
 * API charged for a request and the weight of the transcript in front of that
 * request. That subtraction is only sound early: the character rate undercounts
 * JSON and tool output, the error grows with the transcript, and a long file
 * hands back its own estimator error along with the answer. Reading it while
 * the transcript is still short keeps that error out of it.
 *
 * Returns 0 when the session has no request worth reading. That is the honest
 * answer, and every caller treats it as one. */
export function startingContext(entries: Entry[]): number {
  let inFront = 0;
  for (const entry of entries) {
    if (entry.type !== 'user' && entry.type !== 'assistant') continue;
    const message = entry.message;
    if (message === undefined) continue;

    // A figure this tool stamped is its own arithmetic rather than something
    // the API charged, so subtracting a transcript from it proves nothing.
    if (entry.type === 'assistant' && entry.data.usageIsEstimate !== true) {
      const usage = message.usage;
      if (isRecord(usage)) {
        const reported =
          asNumber(usage.input_tokens) +
          asNumber(usage.cache_read_input_tokens) +
          asNumber(usage.cache_creation_input_tokens);
        if (reported >= leastReportedRequest && inFront < mostTranscriptInFront) {
          const starting = reported - inFront;
          return starting > 0 && starting <= mostStartingContext ? starting : 0;
        }
      }
    }
    inFront += tokensAsCharged(message.content);
  }
  return 0;
}

function asNumber(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

/** Writes the new size onto the last assistant message. */
export function stampUsage(jsonl: string, tokens: number): string {
  const lines = jsonl.replace(/\n+$/, '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const record = decode(lines[i]!);
    if (record === undefined || record.type !== 'assistant') continue;
    const message = record.message;
    if (!isRecord(message)) continue;
    message.usage = {
      input_tokens: tokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 0,
    };
    record.message = message;
    record.usageIsEstimate = true;
    lines[i] = encode(record);
    return lines.join('\n') + '\n';
  }
  return jsonl;
}

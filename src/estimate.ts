// Token arithmetic, and the one place a session records how big it is.
//
// Claude Code, the context reading in the status line and any warning hook all
// size a session from the usage block on an assistant message. A rewrite that
// strips those and stops leaves every one of them with nothing to read, so the
// new size goes back on before the file is written.

import { decode, encode, isRecord } from './transcript.js';

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

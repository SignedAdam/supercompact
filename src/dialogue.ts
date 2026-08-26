// Telling apart the two things a session file holds: what people said, and what
// the machine fetched.

import { isRecord } from './transcript.js';

/** The words in a user turn, whether Claude Code stored them as a plain string
 * or as content blocks.
 *
 * A prompt with a pasted image arrives as blocks, so reading only the string
 * form silently loses every prompt that had a screenshot in it. Tool results
 * wear the same shape and are not prompts. */
export function promptText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;

  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === 'tool_result') return undefined;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.length > 0 ? parts.join('\n') : undefined;
}

/** What an assistant turn said, ignoring the calls it made. */
export function assistantText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('\n');
}

// Claude Code files its own runtime chatter under the user's name, wrapped in
// tags. Nobody typed any of it, so none of it is dialogue.
const noise =
  /<(system-reminder|local-command-caveat|command-stdout|command-stderr)\b[^>]*>[\s\S]*?<\/\1>/g;

export function stripNoise(text: string): string {
  return text.replace(noise, '').replace(/\n{3,}/g, '\n\n').trim();
}

const maxValueChars = 120;
const maxParamsChars = 240;

/** A call written out as a sentence, so a rewritten session still shows what
 * was done without carrying what came back.
 *
 *     You used tool Bash(command: npm test, description: Run the tests) */
export function summarize(block: { [key: string]: unknown }): string {
  const name = typeof block.name === 'string' ? block.name : '';
  if (name === '') return '';

  const input = block.input;
  if (!isRecord(input) || Object.keys(input).length === 0) return `You used tool ${name}`;

  const parts: string[] = [];
  for (const key of Object.keys(input).sort()) {
    const value = describe(input[key]);
    if (value === '') continue;
    parts.push(`${key}: ${value}`);
  }
  if (parts.length === 0) return `You used tool ${name}`;

  let params = parts.join(', ');
  if (params.length > maxParamsChars) params = params.slice(0, maxParamsChars) + '…';
  return `You used tool ${name}(${params})`;
}

function describe(value: unknown): string {
  if (typeof value === 'string') {
    const flat = value.replace(/\n/g, ' ');
    return flat.length > maxValueChars ? flat.slice(0, maxValueChars) + '…' : flat;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.length} items]`;
  if (isRecord(value)) return `{${Object.keys(value).length} keys}`;
  return '';
}

/** Two calls are the same call when the tool and its arguments match. */
export function signature(block: { [key: string]: unknown }): string {
  const name = typeof block.name === 'string' ? block.name : 'tool';
  try {
    return name + '(' + JSON.stringify(block.input).slice(0, 400) + ')';
  } catch {
    return name;
  }
}

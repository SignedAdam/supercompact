// A Claude Code session is a JSONL file. Every line is one record: a message,
// or one of the bookkeeping records Claude Code keeps alongside them. Almost
// all of the bytes are tool traffic.

import { readFileSync, statSync } from 'node:fs';
import { basename, dirname } from 'node:path';

export type Record_ = { [key: string]: unknown };
export type Block = { [key: string]: unknown };

/** One line, kept as both raw text and parsed form.
 *
 * The raw text matters. A line that is copied rather than rewritten has to go
 * back to disk exactly as it came, and re-encoding a parsed object does not
 * promise that. */
export class Entry {
  constructor(
    readonly index: number,
    readonly raw: string,
    readonly data: Record_,
  ) {}

  get type(): string {
    return typeof this.data.type === 'string' ? this.data.type : '';
  }

  get uuid(): string {
    return typeof this.data.uuid === 'string' ? this.data.uuid : '';
  }

  get message(): Record_ | undefined {
    const message = this.data.message;
    return isRecord(message) ? message : undefined;
  }

  get content(): unknown {
    return this.message?.content;
  }

  /** The content blocks of a message, empty when the content is a plain string. */
  get blocks(): Block[] {
    const content = this.content;
    return Array.isArray(content) ? content.filter(isRecord) : [];
  }

  private flag(name: string): boolean {
    return this.data[name] === true;
  }

  get isSidechain(): boolean {
    return this.flag('isSidechain');
  }
  get isCompactSummary(): boolean {
    return this.flag('isCompactSummary');
  }
  get isTranscriptOnly(): boolean {
    return this.flag('isVisibleInTranscriptOnly');
  }
  get isApiError(): boolean {
    return this.flag('isApiErrorMessage');
  }
}

export class Transcript {
  readonly id: string;
  readonly entries: Entry[] = [];
  readonly bytes: number;

  constructor(readonly path: string) {
    this.id = basename(path).replace(/\.jsonl$/, '');
    this.bytes = statSync(path).size;

    const text = readFileSync(path, 'utf8');
    let index = 0;
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      let data: Record_ = {};
      try {
        const parsed: unknown = JSON.parse(line);
        // A line that will not parse is still a line. It keeps its place so
        // the ones around it keep theirs.
        if (isRecord(parsed)) data = parsed;
      } catch {
        // leave it empty
      }
      this.entries.push(new Entry(index++, line, data));
    }
  }

  /** Where this session lives, which is also where a copy of it has to go for
   * `claude --resume` to find it. */
  get directory(): string {
    return dirname(this.path);
  }

  /** The working directory the session was recorded in. `claude --resume` only
   * finds a session when it runs from there. */
  get cwd(): string {
    for (const entry of this.entries) {
      const cwd = entry.data.cwd;
      if (typeof cwd === 'string' && cwd !== '') return cwd;
    }
    return '';
  }

  get gitBranch(): string {
    for (const entry of this.entries) {
      const branch = entry.data.gitBranch;
      if (typeof branch === 'string' && branch !== '') return branch;
    }
    return '';
  }

  /** The first thing the person actually typed, used for naming. */
  get firstPrompt(): string {
    for (const entry of this.entries) {
      if (entry.type !== 'user') continue;
      if (entry.isSidechain || entry.isCompactSummary || entry.isTranscriptOnly) continue;
      const text = promptText(entry.content);
      if (text === undefined) continue;
      const clean = stripNoise(text);
      if (clean !== '') return clean;
    }
    return '';
  }

  counts(): { users: number; assistants: number; calls: number } {
    let users = 0;
    let assistants = 0;
    let calls = 0;
    for (const entry of this.entries) {
      if (entry.type === 'user') {
        if (promptText(entry.content) !== undefined) users++;
      } else if (entry.type === 'assistant') {
        assistants++;
        for (const block of entry.blocks) if (block.type === 'tool_use') calls++;
      }
    }
    return { users, assistants, calls };
  }
}

export function isRecord(value: unknown): value is Record_ {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function decode(line: string): Record_ | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function encode(record: Record_): string {
  return JSON.stringify(record);
}

// Imported after the class so the module reads top down.
import { promptText, stripNoise } from './dialogue.js';

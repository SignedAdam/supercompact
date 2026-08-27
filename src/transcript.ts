// A Claude Code session is a JSONL file. Every line is one record: a message,
// or one of the bookkeeping records Claude Code keeps alongside them. Almost
// all of the bytes are tool traffic.

import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { basename, dirname } from 'node:path';

export type Record_ = { [key: string]: unknown };
export type Block = { [key: string]: unknown };

/** Claude Code turns a working directory into a folder name by replacing both
 * slashes and dots with dashes, so /Users/a/.config lands at -Users-a--config.
 * Both the store and the cwd lookup depend on this, so it lives in one place. */
export function folderFor(cwd: string): string {
  return cwd.replace(/\//g, '-').replace(/\./g, '-');
}

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
  readonly entries: Entry[];
  readonly bytes: number;

  constructor(readonly path: string) {
    this.id = basename(path).replace(/\.jsonl$/, '');
    this.bytes = statSync(path).size;
    this.entries = parse(readFileSync(path, 'utf8'));
  }

  /** Where this session lives, which is also where a copy of it has to go for
   * `claude --resume` to find it. */
  get directory(): string {
    return dirname(this.path);
  }

  /** The working directory the session was recorded in. `claude --resume` only
   * finds a session when it runs from there.
   *
   * The first record is the wrong place to read this from. A session started in
   * a git worktree carries the parent repository as its opening cwd, so trusting
   * the first record files the copy under the wrong project and prints a resume
   * line that cannot work. The directory the file already sits in is the answer
   * Claude Code itself uses, so prefer whichever recorded cwd maps onto it. */
  get cwd(): string {
    const folder = basename(this.directory);
    let first = '';
    for (const entry of this.entries) {
      const cwd = entry.data.cwd;
      if (typeof cwd !== 'string' || cwd === '') continue;
      if (folderFor(cwd) === folder) return cwd;
      if (first === '') first = cwd;
    }
    return first;
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

function parse(text: string): Entry[] {
  const entries: Entry[] = [];
  let index = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let data: Record_ = {};
    try {
      const parsed: unknown = JSON.parse(line);
      // A line that will not parse is still a line. It keeps its place so the
      // ones around it keep theirs.
      if (isRecord(parsed)) data = parsed;
    } catch {
      // leave it empty
    }
    entries.push(new Entry(index++, line, data));
  }
  return entries;
}

/** The opening entries of a session, without reading the rest of the file.
 *
 * These files run to tens of megabytes, and a caller that only wants the first
 * few requests should not pay for all of it. A line the slice cuts in half is
 * dropped, because half a line is not a record. */
export function head(path: string, bytes: number): Entry[] {
  const file = openSync(path, 'r');
  let text: string;
  try {
    const buffer = Buffer.alloc(bytes);
    const read = readSync(file, buffer, 0, bytes, 0);
    text = buffer.subarray(0, read).toString('utf8');
    if (read === bytes) {
      const lastBreak = text.lastIndexOf('\n');
      text = lastBreak === -1 ? '' : text.slice(0, lastBreak);
    }
  } finally {
    closeSync(file);
  }
  return parse(text);
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

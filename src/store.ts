// Where Claude Code keeps its sessions, and how to add one it will accept.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { Transcript, decode, encode, isRecord, type Record_ } from './transcript.js';

/** SUPERCOMPACT_ROOT points every read and write somewhere else, which is how
 * the checks run without going near real sessions. */
export function root(): string {
  const override = process.env.SUPERCOMPACT_ROOT;
  if (override !== undefined && override !== '') return override;
  return join(homedir(), '.claude', 'projects');
}

/** Claude Code turns a working directory into a folder name by replacing both
 * slashes and dots with dashes, so /Users/a/.config lands at -Users-a--config. */
export function directoryFor(cwd: string): string {
  return join(root(), cwd.replace(/\//g, '-').replace(/\./g, '-'));
}

export function allSessionFiles(): string[] {
  const out: string[] = [];
  let projects: string[];
  try {
    projects = readdirSync(root());
  } catch {
    return out;
  }
  for (const project of projects) {
    const dir = join(root(), project);
    let files: string[];
    try {
      if (!statSync(dir).isDirectory()) continue;
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of files) if (file.endsWith('.jsonl')) out.push(join(dir, file));
  }
  return out;
}

export function sessionFilesFor(cwd: string): string[] {
  return sessionFilesIn(directoryFor(cwd));
}

export function sessionFilesIn(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((file) => file.endsWith('.jsonl'))
      .map((file) => join(dir, file));
  } catch {
    return [];
  }
}

export function modified(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

export function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** Finds a session by the first characters of its id. */
export function find(handle: string): string {
  const needle = handle.toLowerCase();
  const matches = allSessionFiles().filter((path) =>
    basename(path).toLowerCase().startsWith(needle),
  );
  if (matches.length === 0) throw new Error(`no session matching "${handle}"`);
  if (matches.length > 1) {
    const ids = matches.map((path) => basename(path).slice(0, 8));
    throw new Error(`"${handle}" matches ${matches.length} sessions: ${ids.join(', ')}`);
  }
  return matches[0]!;
}

/** The session running in this directory.
 *
 * Claude Code names the running session in the environment. Without that the
 * newest file wins, which is wrong whenever a background job in the same
 * project is writing more recently than the session that called us. */
export function current(cwd: string): string {
  const named = process.env.CLAUDE_CODE_SESSION_ID;
  if (named !== undefined && named !== '') {
    try {
      return find(named);
    } catch {
      // fall through to the newest file
    }
  }

  let newest = '';
  let newestAt = 0;
  for (const path of sessionFilesFor(cwd)) {
    const at = modified(path);
    if (newest !== '' && at <= newestAt) continue;
    try {
      if (new Transcript(path).counts().users === 0) continue;
    } catch {
      continue;
    }
    newest = path;
    newestAt = at;
  }
  if (newest === '') throw new Error(`no Claude Code sessions found for ${cwd}`);
  return newest;
}

/** Puts a new session where Claude Code will find it and tells the index it
 * exists, so it shows up in the resume picker. */
export function write(options: {
  jsonl: string;
  sessionId: string;
  cwd: string;
  title: string;
  firstPrompt: string;
  messages: number;
  gitBranch: string;
}): string {
  const dir = directoryFor(options.cwd);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, options.sessionId + '.jsonl');
  replace(path, options.jsonl);
  upsertIndex(dir, options);
  return path;
}

/** Writes through a temporary file in the same directory and then moves it into
 * place. A half-written session file is a lost session.
 *
 * A session holds private conversation, so it is written owner-only, which is
 * what Claude Code does. Replacing a file keeps whatever mode it already had. */
export function replace(path: string, contents: string): void {
  const temp = join(dirname(path), `.supercompact-${randomUUID()}.tmp`);
  let mode = 0o600;
  try {
    mode = statSync(path).mode & 0o777;
  } catch {
    // a new file gets the owner-only default
  }
  try {
    writeFileSync(temp, contents, { mode });
    renameSync(temp, path);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // nothing to clean up
    }
    throw new Error(`cannot write ${path}: ${String(error)}`);
  }
}

function indexPath(dir: string): string {
  return join(dir, 'sessions-index.json');
}

function readIndex(dir: string): { index: Record_; entries: Record_[] } {
  try {
    const parsed: unknown = JSON.parse(readFileSync(indexPath(dir), 'utf8'));
    if (isRecord(parsed)) {
      const entries = Array.isArray(parsed.entries) ? parsed.entries.filter(isRecord) : [];
      return { index: parsed, entries };
    }
  } catch {
    // a missing or unreadable index is written fresh
  }
  return { index: { version: 1 }, entries: [] };
}

function saveIndex(dir: string, index: Record_, entries: Record_[]): void {
  index.entries = entries;
  try {
    writeFileSync(indexPath(dir), JSON.stringify(index, null, 2), { mode: 0o600 });
  } catch {
    // the index is a convenience, not the session
  }
}

function upsertIndex(
  dir: string,
  options: {
    sessionId: string;
    cwd: string;
    title: string;
    firstPrompt: string;
    messages: number;
    gitBranch: string;
  },
): void {
  const { index, entries } = readIndex(dir);
  index.originalPath ??= options.cwd;
  const now = new Date().toISOString().replace(/(\.\d{3})\d*Z$/, '$1Z');

  const entry: Record_ = {
    sessionId: options.sessionId,
    fullPath: join(dir, options.sessionId + '.jsonl'),
    fileMtime: Date.now(),
    summary: options.title,
    messageCount: options.messages,
    created: now,
    modified: now,
    gitBranch: options.gitBranch,
    projectPath: options.cwd,
    isSidechain: false,
  };
  if (options.firstPrompt !== '') entry.firstPrompt = options.firstPrompt;

  saveIndex(
    dir,
    index,
    [...entries.filter((existing) => existing.sessionId !== options.sessionId), entry],
  );
}

export function titleOf(sessionId: string, dir: string): string {
  const { entries } = readIndex(dir);
  for (const entry of entries) {
    if (entry.sessionId !== sessionId) continue;
    if (typeof entry.summary === 'string') return entry.summary;
  }
  return '';
}

/** Changes what a session is called, in the index and in the file.
 *
 * A session Claude Code has not indexed yet gets an entry rather than being
 * skipped, so the new name shows up in the resume picker either way. */
export function rename(sessionId: string, dir: string, title: string): void {
  const { index, entries } = readIndex(dir);
  const now = new Date().toISOString().replace(/(\.\d{3})\d*Z$/, '$1Z');

  const existing = entries.find((entry) => entry.sessionId === sessionId);
  if (existing) {
    existing.summary = title;
    existing.modified = now;
  } else {
    entries.push({
      sessionId,
      fullPath: join(dir, sessionId + '.jsonl'),
      fileMtime: Date.now(),
      summary: title,
      created: now,
      modified: now,
      isSidechain: false,
    });
  }
  saveIndex(dir, index, entries);

  const path = join(dir, sessionId + '.jsonl');
  if (!existsSync(path)) return;
  const record: Record_ = {
    type: 'custom-title',
    sessionId,
    customTitle: title,
    timestamp: now,
  };
  const lines = readFileSync(path, 'utf8').replace(/\n+$/, '').split('\n');
  const at = lines.findIndex((line) => decode(line)?.type === 'custom-title');
  if (at >= 0) lines[at] = encode(record);
  else lines.unshift(encode(record));
  replace(path, lines.join('\n') + '\n');
}

export function stamp(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
  );
}

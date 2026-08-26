import { randomUUID } from 'node:crypto';

import type { Entry, Record_, Transcript } from './transcript.js';
import { decode, encode, isRecord } from './transcript.js';
import { promptText, stripNoise, summarize } from './dialogue.js';
import { inWindow, keepIsEmpty, noKeep, plan, type Keep, type Selection } from './keep.js';

export interface Options {
  /** One line per call saying what ran, never what returned. */
  toolLines: boolean;
  keep: Keep;
}

export const defaultOptions: Options = { toolLines: false, keep: noKeep };

export interface Result {
  jsonl: string;
  sessionId: string;
  users: number;
  assistants: number;
  toolLines: number;
  keptCalls: number;
  dropped: number;
  preservedTail: number;
}

function emptyResult(sessionId = ''): Result {
  return {
    jsonl: '',
    sessionId,
    users: 0,
    assistants: 0,
    toolLines: 0,
    keptCalls: 0,
    dropped: 0,
    preservedTail: 0,
  };
}

export function messageCount(result: Result): number {
  return result.users + result.assistants;
}

/** Collects the rewritten lines and keeps the parent chain honest. */
class Builder {
  lines: string[] = [];
  parent: string | null = null;
  written = new Set<string>();
  notes: string[] = [];

  constructor(readonly result: Result) {}

  emit(record: Record_, uuid: string): boolean {
    this.lines.push(encode(record));
    if (uuid !== '') {
      this.parent = uuid;
      this.written.add(uuid);
    }
    return true;
  }

  /** Notes about dropped calls ride at the end of a message that is already
   * going out. That is the only safe place for them when a call was kept: the
   * API reads the message straight after a tool_use and wants the answer. */
  attachNotes(record: Record_): boolean {
    if (this.notes.length === 0) return false;
    const message = record.message;
    if (!isRecord(message) || !Array.isArray(message.content)) return false;
    message.content = [...message.content, { type: 'text', text: this.notes.join('\n') }];
    record.message = message;
    this.result.toolLines += this.notes.length;
    this.notes = [];
    return true;
  }

  /** Notes as their own turn. Safe only when no kept call is waiting. */
  flushNotes(source: Record_, sessionId: string): void {
    if (this.notes.length === 0) return;
    const uuid = randomUUID();
    const record: Record_ = {
      type: 'user',
      uuid,
      parentUuid: this.parent,
      message: { role: 'user', content: this.notes.join('\n') },
    };
    for (const key of ['sessionId', 'timestamp', 'cwd', 'gitBranch', 'version', 'userType']) {
      if (source[key] !== undefined) record[key] = source[key];
    }
    if (sessionId !== '') record.sessionId = sessionId;
    this.emit(record, uuid);
    this.result.toolLines += this.notes.length;
    this.notes = [];
  }

  finish(): Result {
    if (this.lines.length > 0) this.result.jsonl = this.lines.join('\n') + '\n';
    return this.result;
  }
}

/** Separates what an assistant turn said from the calls it made, keeping any
 * call the selection asked for. */
function splitAssistant(
  entry: Entry,
  selection: Selection,
  toolLines: boolean,
): { blocks: unknown[]; notes: string[]; keptCall: boolean } {
  const blocks: unknown[] = [];
  const notes: string[] = [];
  let keptCall = false;

  for (const block of entry.blocks) {
    if (block.type === 'text') {
      const text = typeof block.text === 'string' ? block.text : '';
      if (text.trim() !== '') blocks.push(block);
    } else if (block.type === 'tool_use') {
      const id = typeof block.id === 'string' ? block.id : '';
      if (selection.calls.has(id)) {
        blocks.push(block);
        keptCall = true;
      } else if (toolLines) {
        const note = summarize(block);
        if (note !== '') notes.push(note);
      }
    }
  }
  return { blocks, notes, keptCall };
}

/** A turn of tool results, trimmed to the ones chosen to survive. */
function keptResults(entry: Entry, selection: Selection): unknown[] {
  if (selection.calls.size === 0) return [];
  return entry.blocks.filter(
    (block) =>
      block.type === 'tool_result' &&
      typeof block.tool_use_id === 'string' &&
      selection.calls.has(block.tool_use_id),
  );
}

/** Builds a new session from an old one: the words both sides said, and nothing
 * else unless it was asked for.
 *
 * Every entry gets a fresh uuid and the chain is rebuilt in order, so the
 * result stands on its own and the original is never opened for writing. */
export function fork(transcript: Transcript, options: Options = defaultOptions): Result {
  const selection = plan(transcript, options.keep);
  const sessionId = randomUUID();
  const b = new Builder(emptyResult(sessionId));

  for (const entry of transcript.entries) {
    if (entry.type !== 'user' && entry.type !== 'assistant') continue;
    if (entry.isSidechain) continue;

    if (inWindow(selection, entry.index)) {
      const record: Record_ = { ...entry.data };
      const uuid = randomUUID();
      record.uuid = uuid;
      record.parentUuid = b.parent;
      record.sessionId = sessionId;
      const message = isRecord(record.message) ? { ...record.message } : undefined;
      if (message) {
        delete message.usage;
        record.message = message;
      }
      b.attachNotes(record);
      b.emit(record, uuid);
      if (entry.type === 'assistant') b.result.assistants++;
      else if (promptText(entry.content) !== undefined) b.result.users++;
      else b.result.keptCalls++;
      continue;
    }

    if (entry.type === 'user') {
      const kept = keptResults(entry, selection);
      if (kept.length > 0) {
        const record: Record_ = { ...entry.data };
        const uuid = randomUUID();
        record.uuid = uuid;
        record.parentUuid = b.parent;
        record.sessionId = sessionId;
        record.message = { ...(entry.message ?? {}), content: kept };
        b.attachNotes(record);
        b.emit(record, uuid);
        b.result.keptCalls += kept.length;
        continue;
      }
      b.flushNotes(entry.data, sessionId);

      if (entry.isCompactSummary || entry.isTranscriptOnly) continue;
      const raw = promptText(entry.content);
      if (raw === undefined) continue;
      const text = stripNoise(raw);
      if (text === '') continue;

      const record: Record_ = { ...entry.data };
      const uuid = randomUUID();
      record.uuid = uuid;
      record.parentUuid = b.parent;
      record.sessionId = sessionId;
      record.message = { ...(entry.message ?? {}), role: 'user', content: text };
      b.emit(record, uuid);
      b.result.users++;
      continue;
    }

    b.flushNotes(entry.data, sessionId);
    if (entry.isApiError) continue;

    const { blocks, notes, keptCall } = splitAssistant(entry, selection, options.toolLines);
    if (blocks.length === 0) {
      b.notes = notes;
      b.flushNotes(entry.data, sessionId);
      continue;
    }

    const record: Record_ = { ...entry.data };
    const uuid = randomUUID();
    record.uuid = uuid;
    record.parentUuid = b.parent;
    record.sessionId = sessionId;
    const message: Record_ = { ...(entry.message ?? {}), content: blocks };
    if (!keptCall && message.stop_reason === 'tool_use') message.stop_reason = 'end_turn';
    delete message.usage;
    delete message.id;
    delete message.stop_details;
    delete record.requestId;
    record.message = message;
    b.emit(record, uuid);
    b.result.assistants++;

    b.notes = notes;
    if (!keptCall) b.flushNotes(entry.data, sessionId);
  }

  return b.finish();
}

/** Rewrites a session's own file, so it keeps its id and its name.
 *
 * A running Claude Code process holds the end of this file in memory and will
 * append to it, chaining whatever it writes next to the last uuid it saw. So
 * the turn in progress goes back untouched and every entry that survives keeps
 * its original uuid. Break that and the next line written points at an entry
 * that no longer exists, which collapses the history on resume. */
export function inPlace(transcript: Transcript, options: Options = defaultOptions): Result {
  const selection = plan(transcript, options.keep);
  let tailStart = tailBoundary(transcript);
  if (selection.from !== undefined && selection.from < tailStart) tailStart = selection.from;

  const b = new Builder(emptyResult(transcript.id));

  for (const entry of transcript.entries) {
    if (entry.index >= tailStart) {
      b.result.preservedTail++;
      const record = decode(entry.raw);
      if (record === undefined) {
        b.lines.push(entry.raw);
        continue;
      }
      // A rewound conversation branches, so an entry near the end can be the
      // child of something far earlier. Any parent that did not survive is
      // re-pointed, not just the first one.
      const parent = record.parentUuid;
      if (typeof parent !== 'string' || !b.written.has(parent)) record.parentUuid = b.parent;
      b.attachNotes(record);
      stripUsage(record);
      b.emit(record, typeof record.uuid === 'string' ? record.uuid : '');
      continue;
    }

    if (entry.type === 'user') {
      const kept = keptResults(entry, selection);
      if (kept.length > 0 && entry.uuid !== '') {
        const record: Record_ = { ...entry.data };
        record.parentUuid = b.parent;
        record.message = { ...(entry.message ?? {}), content: kept };
        b.attachNotes(record);
        b.emit(record, entry.uuid);
        b.result.keptCalls += kept.length;
        continue;
      }
      b.flushNotes(entry.data, '');

      if (entry.isCompactSummary || entry.isTranscriptOnly || entry.uuid === '') {
        b.result.dropped++;
        continue;
      }
      const raw = promptText(entry.content);
      if (raw === undefined) {
        b.result.dropped++;
        continue;
      }
      const text = stripNoise(raw);
      if (text === '') {
        b.result.dropped++;
        continue;
      }
      const record: Record_ = { ...entry.data };
      record.parentUuid = b.parent;
      record.message = { ...(entry.message ?? {}), content: text };
      b.emit(record, entry.uuid);
      b.result.users++;
      continue;
    }

    if (entry.type !== 'assistant') {
      b.result.dropped++;
      continue;
    }

    b.flushNotes(entry.data, '');
    if (entry.isApiError || entry.uuid === '') {
      b.result.dropped++;
      continue;
    }

    const { blocks, notes, keptCall } = splitAssistant(entry, selection, options.toolLines);
    if (blocks.length === 0) {
      b.result.dropped++;
      b.notes = notes;
      b.flushNotes(entry.data, '');
      continue;
    }

    const record: Record_ = { ...entry.data };
    record.parentUuid = b.parent;
    const message: Record_ = { ...(entry.message ?? {}), content: blocks };
    if (!keptCall && message.stop_reason === 'tool_use') message.stop_reason = 'end_turn';
    delete message.usage;
    delete message.stop_details;
    delete record.requestId;
    record.message = message;
    b.emit(record, entry.uuid);
    b.result.assistants++;

    b.notes = notes;
    if (!keptCall) b.flushNotes(entry.data, '');
  }

  return b.finish();
}

/** The last thing the person typed. Everything after it belongs to the turn the
 * caller is standing in and goes back untouched.
 *
 * A prompt carrying a pasted image is stored as blocks rather than a string.
 * Miss that and the boundary slides back to the last plain-text prompt, which
 * can drag an entire unattended run of screenshots into the preserved part. */
function tailBoundary(transcript: Transcript): number {
  for (let i = transcript.entries.length - 1; i >= 0; i--) {
    const entry = transcript.entries[i]!;
    if (entry.type !== 'user' || entry.isCompactSummary || entry.isTranscriptOnly) continue;
    if (promptText(entry.content) !== undefined) return entry.index;
  }
  return Math.max(0, transcript.entries.length - 1);
}

/** The preserved tail keeps its uuids, which is what lets a live session go on
 * writing, but its usage blocks describe the session as it was before the
 * rewrite. Left alone they report the old size forever. */
function stripUsage(record: Record_): void {
  if (record.type !== 'assistant') return;
  const message = record.message;
  if (!isRecord(message)) return;
  delete message.usage;
  delete message.stop_details;
  record.message = message;
  delete record.requestId;
}

export { keepIsEmpty };

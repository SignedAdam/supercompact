// What survives untouched.
//
// Dialogue alone is cheap, and it also throws away the state the session was
// standing in: the file it just read, the page it was just looking at. These
// hold part of that back.

import type { Transcript } from './transcript.js';
import { promptText } from './dialogue.js';
import { signature } from './dialogue.js';

export interface Keep {
  /** The last N messages stay exactly as they are, tool output included. */
  lastMessages: number;
  /** The newest N calls keep their full output, wherever they are. */
  toolCalls: number;
  /** A call that repeats counts once against toolCalls. */
  unique: boolean;
}

export const noKeep: Keep = { lastMessages: 0, toolCalls: 0, unique: false };

export function keepIsEmpty(keep: Keep): boolean {
  return keep.lastMessages <= 0 && keep.toolCalls <= 0;
}

export interface Selection {
  /** The entry index where copying byte for byte begins, or undefined. */
  from?: number;
  /** tool_use ids whose call and result both survive. */
  calls: Set<string>;
  picked: number;
}

export function inWindow(selection: Selection, index: number): boolean {
  return selection.from !== undefined && index >= selection.from;
}

export function plan(transcript: Transcript, keep: Keep): Selection {
  const selection: Selection = { calls: new Set(), picked: 0 };
  if (keepIsEmpty(keep)) return selection;

  const messages: number[] = [];
  const calls: { index: number; id: string; sig: string }[] = [];
  const answered = new Set<string>();

  for (const entry of transcript.entries) {
    if (entry.type === 'user') {
      if (promptText(entry.content) !== undefined) {
        messages.push(entry.index);
        continue;
      }
      for (const block of entry.blocks) {
        if (block.type !== 'tool_result') continue;
        if (typeof block.tool_use_id === 'string') answered.add(block.tool_use_id);
      }
    } else if (entry.type === 'assistant') {
      messages.push(entry.index);
      for (const block of entry.blocks) {
        if (block.type !== 'tool_use') continue;
        if (typeof block.id === 'string') {
          calls.push({ index: entry.index, id: block.id, sig: signature(block) });
        }
      }
    }
  }

  if (keep.lastMessages > 0 && messages.length > 0) {
    selection.from = messages[Math.max(0, messages.length - keep.lastMessages)];
  }

  // A kept call needs the answer that went with it. A tool_use with nothing
  // replying to it makes the API refuse the whole conversation, so a call
  // nobody answered is never chosen.
  if (keep.toolCalls > 0) {
    const seen = new Set<string>();
    for (let i = calls.length - 1; i >= 0; i--) {
      const call = calls[i]!;
      if (inWindow(selection, call.index)) continue;
      if (!answered.has(call.id)) continue;
      if (keep.unique) {
        if (seen.has(call.sig)) continue;
        seen.add(call.sig);
      }
      selection.calls.add(call.id);
      selection.picked++;
      if (selection.picked >= keep.toolCalls) break;
    }
  }

  for (const call of calls) {
    if (inWindow(selection, call.index)) selection.calls.add(call.id);
  }
  return selection;
}

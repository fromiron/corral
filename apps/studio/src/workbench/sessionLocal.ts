import { clearSessionDraft } from './sessionDraft.ts';

const handoffPrefix = (sessionId: string) => `corral:meeting-handoff:${sessionId}:`;
const recordsKey = (sessionId: string) => `corral:meeting-records:v1:${sessionId}`;

function storageKeys(match: (key: string) => boolean) {
  const keys: string[] = [];
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key && match(key)) keys.push(key);
    }
  } catch {
    return [];
  }
  return keys;
}

export function sessionHandoffDraftCount(sessionId: string) {
  return storageKeys(
    (key) => key.startsWith(handoffPrefix(sessionId)) && Boolean(localStorage.getItem(key)),
  ).length;
}

/** Composer text, handoff drafts and the meeting-records flag for a deleted session. */
export function clearDeletedSessionLocal(sessionId: string) {
  clearSessionDraft(sessionId);
  for (const key of storageKeys(
    (item) => item.startsWith(handoffPrefix(sessionId)) || item === recordsKey(sessionId),
  )) {
    try {
      localStorage.removeItem(key);
    } catch {
      // A refused write cannot put the deleted session back.
    }
  }
}

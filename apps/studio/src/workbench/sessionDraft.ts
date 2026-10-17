const key = (sessionId: string) => `corral:session-draft:${sessionId}`;

export function readDraft(sessionId: string) {
  try {
    return window.localStorage.getItem(key(sessionId)) ?? '';
  } catch {
    return '';
  }
}

export function writeDraft(sessionId: string, text: string) {
  try {
    if (text) window.localStorage.setItem(key(sessionId), text);
    else window.localStorage.removeItem(key(sessionId));
  } catch {
    // The draft remains usable in the current page when storage is unavailable.
  }
}

// The project's "new conversation" details (name, purpose, team, completion criteria),
// remembered in this browser until a conversation starts with them.

export interface NewSessionDraft {
  title: string;
  objective: string;
  /** A saved Corral's id, `template:<id>` for a suggested team, or '' for auto. */
  corralId: string;
  /** Completion criteria as typed, one per line; trimmed and filtered only when sent. */
  criteria: string;
}

export const EMPTY_DRAFT: NewSessionDraft = {
  title: '',
  objective: '',
  corralId: '',
  criteria: '',
};

export const newSessionDraftKey = (projectId: string) => `corral:new-session:v1:${projectId}`;

/** Picks the team for the project's next conversation, keeping everything else typed. */
export function chooseNewSessionTeam(projectId: string, corralId: string) {
  const key = newSessionDraftKey(projectId);
  try {
    const saved = JSON.parse(window.localStorage.getItem(key) ?? 'null') as Partial<
      Record<keyof NewSessionDraft, unknown>
    > | null;
    const text = (value: unknown) => (typeof value === 'string' ? value : '');
    const draft: NewSessionDraft = {
      title: text(saved?.title),
      objective: text(saved?.objective),
      corralId,
      criteria: text(saved?.criteria),
    };
    window.localStorage.setItem(key, JSON.stringify(draft));
  } catch {
    // Without storage the project page opens with the team unchosen.
  }
}

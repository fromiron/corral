// The project's "new conversation" details (name, purpose, team), remembered in this browser
// until a conversation starts with them.

export interface NewSessionDraft {
  title: string;
  objective: string;
  /** A saved Corral's id, `template:<id>` for a suggested team, or '' for auto. */
  corralId: string;
}

export const newSessionDraftKey = (projectId: string) => `corral:new-session:v1:${projectId}`;

/** Picks the team for the project's next conversation, keeping the name and purpose typed. */
export function chooseNewSessionTeam(projectId: string, corralId: string) {
  const key = newSessionDraftKey(projectId);
  try {
    const saved = JSON.parse(window.localStorage.getItem(key) ?? 'null') as Partial<
      Record<keyof NewSessionDraft, unknown>
    > | null;
    const draft: NewSessionDraft = {
      title: typeof saved?.title === 'string' ? saved.title : '',
      objective: typeof saved?.objective === 'string' ? saved.objective : '',
      corralId,
    };
    window.localStorage.setItem(key, JSON.stringify(draft));
  } catch {
    // Without storage the project page opens with the team unchosen.
  }
}

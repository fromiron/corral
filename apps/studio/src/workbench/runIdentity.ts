import type { CorralDefinition } from '@corral/contracts';
import type { RunSummary, WorkSession } from '@corral/core';

export interface RunIdentity {
  name: string | null;
  sessionName: string | null;
  number: number | null;
}

const summary = (text: string | undefined) =>
  text?.trim().split(/\r?\n/, 1)[0]?.slice(0, 120) || null;
const sessionFor = (run: RunSummary, sessions: readonly WorkSession[]) =>
  sessions.find((session) => session.sessionId === run.sessionId);
const requestFor = (run: RunSummary, session: WorkSession | undefined) =>
  session?.entries.find((entry) => entry.runId === run.runId && entry.intent !== 'steer');

/** Session context is current; the request and run definition are immutable execution evidence. */
export function runIdentity(
  run: RunSummary,
  runs: readonly RunSummary[],
  sessions: readonly WorkSession[],
  definition?: CorralDefinition | null,
  includeRequest = true,
): RunIdentity {
  const session = sessionFor(run, sessions);
  const siblings = run.sessionId
    ? runs
        .filter((item) => item.sessionId === run.sessionId)
        .toReversed()
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    : [];
  const number = siblings.findIndex((item) => item.runId === run.runId) + 1;
  return {
    name:
      (includeRequest
        ? (summary(requestFor(run, session)?.text) ?? summary(definition?.input.brief))
        : summary(session?.title)) ??
      summary(definition?.sourceTeam?.name) ??
      summary(definition?.name) ??
      summary(session?.title),
    sessionName: summary(session?.title),
    number: number || null,
  };
}

export function runIdentityText(
  identity: RunIdentity,
  unnamed: string,
  numbered: (number: number) => string,
) {
  return [
    identity.sessionName !== identity.name ? identity.sessionName : null,
    identity.number ? numbered(identity.number) : null,
    identity.name ?? unnamed,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Only missing request labels need the pinned run definition, never the team's current revision. */
export async function loadRunIdentities(
  shown: readonly RunSummary[],
  all: readonly RunSummary[],
  sessions: readonly WorkSession[],
  getDefinition: (runId: string) => Promise<CorralDefinition | null>,
  includeRequest = true,
): Promise<Record<string, RunIdentity>> {
  return Object.fromEntries(
    await Promise.all(
      shown.map(async (run) => {
        const session = sessionFor(run, sessions);
        const knownName = includeRequest
          ? summary(requestFor(run, session)?.text)
          : summary(session?.title);
        const definition = knownName ? null : await getDefinition(run.runId).catch(() => null);
        return [run.runId, runIdentity(run, all, sessions, definition, includeRequest)];
      }),
    ),
  );
}

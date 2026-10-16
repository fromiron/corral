import {
  type CorralSummary,
  DEFAULT_PROJECT_ID,
  type ProjectSummary,
  type RunSummary,
} from '@corral/core';
import { useSyncExternalStore } from 'react';

// The project Studio is working in (CR-010). Pages that know theirs (a project, a Corral, a
// run) set it; the header shows it, and `/` returns to it. Remembered per browser only: it is
// a view preference, not a fact about any run.

const KEY = 'corral:last-project';
const listeners = new Set<() => void>();
let current: string = readStored();
// Bumped whenever projects are created, renamed or archived, so lists reload.
let version = 0;

function readStored(): string {
  try {
    return window.localStorage.getItem(KEY) || DEFAULT_PROJECT_ID;
  } catch {
    return DEFAULT_PROJECT_ID;
  }
}

function emit() {
  for (const listener of listeners) listener();
}

export function setCurrentProject(projectId: string) {
  if (projectId === current) return;
  current = projectId;
  try {
    window.localStorage.setItem(KEY, projectId);
  } catch {
    // Not remembered across reloads; the page still works.
  }
  emit();
}

export function currentProject(): string {
  return current;
}

export function projectsChanged() {
  version++;
  emit();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useCurrentProject(): string {
  return useSyncExternalStore(subscribe, () => current);
}

export function useProjectsVersion(): number {
  return useSyncExternalStore(subscribe, () => version);
}

/** A run's project: as recorded at start, else its Corral's (in-browser runs), else default. */
export function projectOfRun(run: RunSummary, corrals: CorralSummary[]): string {
  return (
    run.projectId ??
    corrals.find((c) => c.corralId === run.corralId)?.projectId ??
    DEFAULT_PROJECT_ID
  );
}

/** The default project has no stored name; it is named in the reader's language. */
export function projectName(
  project: Pick<ProjectSummary, 'projectId' | 'name'> | undefined,
  defaultName: string,
): string {
  if (!project) return defaultName;
  return (
    project.name || (project.projectId === DEFAULT_PROJECT_ID ? defaultName : project.projectId)
  );
}

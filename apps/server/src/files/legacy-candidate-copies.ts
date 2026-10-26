import { existsSync } from 'node:fs';
import type { Db } from '@corral/storage-sqlite';
import { checkGitEnvironment, git } from './git.ts';

/**
 * CR-056: Ultra (CR-031, CR-048) is removed. Candidate copies its runs left stay until their
 * session's working copy is removed, and then go with it. Nothing creates new ones.
 */
export async function removeLegacyCandidateCopies(
  db: Db,
  sessionId: string,
  repository: string,
): Promise<void> {
  const copies = db
    .prepare(
      "SELECT run_id, candidate_id, worktree_path FROM candidate_worktrees WHERE session_id=? AND state!='removed'",
    )
    .all(sessionId) as { run_id: string; candidate_id: string; worktree_path: string }[];
  for (const copy of copies) {
    if (existsSync(copy.worktree_path))
      await git(repository, ['worktree', 'remove', '--force', copy.worktree_path], {
        env: await checkGitEnvironment(repository),
      });
    db.prepare(
      "UPDATE candidate_worktrees SET state='removed' WHERE run_id=? AND candidate_id=?",
    ).run(copy.run_id, copy.candidate_id);
  }
  if (copies.length) await git(repository, ['worktree', 'prune']);
}

import Database from 'better-sqlite3';

/** Hold a separate SQLite file lock without blocking reads or transactions in the run database. */
export function acquireDatabaseLock(path: string): () => void {
  let db: Database.Database | undefined;
  try {
    db = new Database(path, { timeout: 0 });
    db.exec('BEGIN EXCLUSIVE');
  } catch (error) {
    db?.close();
    const busy = error instanceof Database.SqliteError && error.code === 'SQLITE_BUSY';
    throw new Error(
      busy
        ? 'workspace is already owned by another server'
        : 'workspace ownership could not be acquired',
    );
  }
  const owner = db;
  // Closing (including process death) releases the OS lock; never unlink a lock another owner may hold.
  return () => {
    if (owner.open) owner.close();
  };
}

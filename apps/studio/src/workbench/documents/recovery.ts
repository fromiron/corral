import { canonicalJson, DocumentCommand, WorkspaceTarget } from '@corral/contracts';
import { z } from 'zod';

export type SaveCommand = Extract<DocumentCommand, { kind: 'save' }>;
export type RecoveryScope = Pick<WorkspaceTarget, 'hostId' | 'projectId' | 'sessionId'>;
export interface RecoveryDraft {
  version: 1;
  id: string;
  clientId: string;
  documentKey: string;
  target: WorkspaceTarget;
  path: string;
  text: string;
  baseText: string;
  baseHash: string | null;
  editVersion: number;
  pendingSave: SaveCommand | null;
  formatBlocked: boolean;
  updatedAt: number;
}

export interface RecoveryStorage {
  list(documentKey: string): Promise<RecoveryDraft[]>;
  listSession(scope: RecoveryScope): Promise<RecoveryDraft[]>;
  write(draft: RecoveryDraft): Promise<void>;
  /** Delete exactly the inspected revision, preserving a newer draft from another view. */
  remove(draft: RecoveryDraft): Promise<void>;
}

const Draft = z.object({
  version: z.literal(1),
  id: z.string(),
  clientId: z.string(),
  documentKey: z.string(),
  target: WorkspaceTarget,
  path: z.string(),
  text: z.string(),
  baseText: z.string(),
  baseHash: z.string().nullable(),
  editVersion: z.int().min(0),
  pendingSave: z
    .custom<SaveCommand>((value) => {
      const parsed = DocumentCommand.safeParse(value);
      return parsed.success && parsed.data.kind === 'save';
    })
    .nullable(),
  formatBlocked: z.boolean(),
  updatedAt: z.number(),
});

/** Draft bodies stay in this browser; transaction completion is the persistence acknowledgement. */
export function indexedDbRecovery(factory = globalThis.indexedDB): RecoveryStorage {
  let opening: Promise<IDBDatabase> | undefined;
  const database = () => {
    if (!opening) {
      opening = new Promise<IDBDatabase>((resolve, reject) => {
        if (!factory) return reject(new Error('Document recovery storage is unavailable'));
        const request = factory.open('corral-document-recovery', 2);
        request.onupgradeneeded = (event) => {
          if (event.oldVersion < 1)
            request.result
              .createObjectStore('drafts', { keyPath: 'id' })
              .createIndex('documentKey', 'documentKey');
          request.transaction
            ?.objectStore('drafts')
            .createIndex('session', ['target.hostId', 'target.projectId', 'target.sessionId']);
        };
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          request.result.onversionchange = () => {
            request.result.close();
            opening = undefined;
          };
          resolve(request.result);
        };
      }).catch((error) => {
        opening = undefined;
        throw error;
      });
    }
    return opening;
  };
  const readIndex = async (index: string, key: IDBValidKey): Promise<RecoveryDraft[]> => {
    const db = await database();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('drafts', 'readonly');
      const request = transaction.objectStore('drafts').index(index).getAll(key);
      transaction.oncomplete = () =>
        resolve(
          (request.result as unknown[]).flatMap((value) => {
            const parsed = Draft.safeParse(value);
            return parsed.success ? [parsed.data] : [];
          }),
        );
      transaction.onerror = transaction.onabort = () =>
        reject(transaction.error ?? new Error('Document recovery read failed'));
    });
  };
  return {
    list: (key) => readIndex('documentKey', key),
    listSession: (scope) => readIndex('session', [scope.hostId, scope.projectId, scope.sessionId]),
    async write(draft) {
      const db = await database();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction('drafts', 'readwrite');
        transaction.objectStore('drafts').put(draft);
        transaction.oncomplete = () => resolve();
        transaction.onerror = transaction.onabort = () =>
          reject(transaction.error ?? new Error('Document recovery write failed'));
      });
    },
    async remove(draft) {
      const db = await database();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction('drafts', 'readwrite');
        const rows = transaction.objectStore('drafts');
        const request = rows.get(draft.id);
        request.onsuccess = () => {
          // Another renderer may have edited the candidate since it was displayed.
          if (request.result && canonicalJson(request.result) === canonicalJson(draft))
            rows.delete(draft.id);
        };
        transaction.oncomplete = () => resolve();
        transaction.onerror = transaction.onabort = () =>
          reject(transaction.error ?? new Error('Document recovery deletion failed'));
      });
    },
  };
}

import {
  CanvasLayout,
  type Clock,
  type CorralDefinition,
  CorralDefinitionDraft,
  type NodeLayout,
} from '@corral/contracts';
import { z } from 'zod';
import { canonicalJson } from '../canonical-json.ts';
import { definitionHash } from '../definition-hash.ts';

// Saved Corrals (C-009). Definition and layout are versioned separately: moving nodes bumps
// only layoutRevision; changing what runs bumps definitionRevision (CRL-CAN-002, INV-12).
// Work in progress may be saved: records hold the draft schema, runs compile the strict one.
// The browser uses this over localStorage until the local server replaces it (P2, PUT /corrals).

export interface CorralRecord {
  corralId: string;
  name: string;
  definition: CorralDefinition;
  definitionRevision: number;
  definitionHash: string;
  layout: CanvasLayout;
  layoutRevision: number;
  updatedAt: string;
}

export interface CorralSummary {
  corralId: string;
  name: string;
  definitionRevision: number;
  layoutRevision: number;
  nodeCount: number;
  updatedAt: string;
}

export interface SaveRequest {
  definition: CorralDefinition;
  layout: { nodes: Record<string, NodeLayout>; viewport: CanvasLayout['viewport'] };
  /** null creates a new Corral; otherwise the revision this edit started from. */
  expectedDefinitionRevision: number | null;
}

export type SaveResult =
  | { ok: true; record: CorralRecord; changed: { definition: boolean; layout: boolean } }
  | {
      ok: false;
      error: 'revision_conflict' | 'not_found' | 'storage_unavailable';
      message: string;
    };

export interface CorralRepository {
  list(): Promise<CorralSummary[]>;
  get(corralId: string): Promise<CorralRecord | null>;
  save(request: SaveRequest): Promise<SaveResult>;
  duplicate(corralId: string, name: string): Promise<SaveResult>;
  remove(corralId: string): Promise<void>;
}

/** The subset of Web Storage this repository needs; tests pass a Map-backed store. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const PREFIX = 'corral:v1:';
const INDEX_KEY = `${PREFIX}index`;
const recordKey = (corralId: string) => `${PREFIX}corral:${corralId}`;

const StoredRecord = z.strictObject({
  corralId: z.string().min(1),
  name: z.string(),
  definition: CorralDefinitionDraft,
  definitionRevision: z.int().min(1),
  definitionHash: z.string(),
  layout: CanvasLayout,
  layoutRevision: z.int().min(1),
  updatedAt: z.string(),
});

export function createKeyValueCorralRepository(
  store: KeyValueStore,
  options: { clock: Clock; newCorralId: () => string },
): CorralRepository {
  const readIndex = (): string[] => {
    const raw = store.getItem(INDEX_KEY);
    if (!raw) return [];
    const parsed = z.array(z.string()).safeParse(safeJson(raw));
    if (!parsed.success) throw new Error('The saved Corral list cannot be read.');
    return parsed.data;
  };
  const read = (corralId: string): CorralRecord | null => {
    const raw = store.getItem(recordKey(corralId));
    if (raw === null) return null;
    const parsed = StoredRecord.safeParse(safeJson(raw));
    if (!parsed.success) throw new Error(`Saved Corral ${corralId} cannot be read.`);
    return parsed.data;
  };
  const write = (record: CorralRecord): SaveResult | null => {
    try {
      store.setItem(recordKey(record.corralId), JSON.stringify(record));
      const index = readIndex();
      if (!index.includes(record.corralId))
        store.setItem(INDEX_KEY, JSON.stringify([...index, record.corralId]));
      return null;
    } catch (error) {
      return {
        ok: false,
        error: 'storage_unavailable',
        message: `Could not save: ${String(error)}`,
      };
    }
  };

  const create = (
    definition: CorralDefinition,
    layout: SaveRequest['layout'],
    corralId: string,
  ): SaveResult => {
    const owned = { ...definition, id: corralId };
    const record: CorralRecord = {
      corralId,
      name: owned.name,
      definition: owned,
      definitionRevision: 1,
      definitionHash: definitionHash(owned),
      layout: { schemaVersion: '0.1', corralId, layoutRevision: 1, ...layout },
      layoutRevision: 1,
      updatedAt: options.clock.nowIso(),
    };
    return write(record) ?? { ok: true, record, changed: { definition: true, layout: true } };
  };

  return {
    async list() {
      return readIndex()
        .map(read)
        .filter((r): r is CorralRecord => r !== null)
        .map((r) => ({
          corralId: r.corralId,
          name: r.name,
          definitionRevision: r.definitionRevision,
          layoutRevision: r.layoutRevision,
          nodeCount: r.definition.nodes.length,
          updatedAt: r.updatedAt,
        }))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.name.localeCompare(b.name));
    },

    async get(corralId) {
      return read(corralId);
    },

    async save(request) {
      if (request.expectedDefinitionRevision === null) {
        // A new Corral always gets its own id, even when imported from a file.
        return create(request.definition, request.layout, options.newCorralId());
      }
      const current = read(request.definition.id);
      if (!current)
        return {
          ok: false,
          error: 'not_found',
          message: `Corral ${request.definition.id} does not exist.`,
        };
      if (current.definitionRevision !== request.expectedDefinitionRevision) {
        return {
          ok: false,
          error: 'revision_conflict',
          message: `This Corral was saved elsewhere (revision ${current.definitionRevision}). Reload before saving.`,
        };
      }
      const hash = definitionHash(request.definition);
      const definitionChanged = hash !== current.definitionHash;
      const layoutChanged =
        canonicalJson({ nodes: request.layout.nodes, viewport: request.layout.viewport }) !==
        canonicalJson({ nodes: current.layout.nodes, viewport: current.layout.viewport });
      if (!definitionChanged && !layoutChanged) {
        return { ok: true, record: current, changed: { definition: false, layout: false } };
      }
      const definitionRevision = current.definitionRevision + (definitionChanged ? 1 : 0);
      const layoutRevision = current.layoutRevision + (layoutChanged ? 1 : 0);
      const record: CorralRecord = {
        ...current,
        name: request.definition.name,
        definition: request.definition,
        definitionRevision,
        definitionHash: hash,
        layout: { ...current.layout, ...request.layout, layoutRevision },
        layoutRevision,
        updatedAt: options.clock.nowIso(),
      };
      return (
        write(record) ?? {
          ok: true,
          record,
          changed: { definition: definitionChanged, layout: layoutChanged },
        }
      );
    },

    async duplicate(corralId, name) {
      const source = read(corralId);
      if (!source)
        return { ok: false, error: 'not_found', message: `Corral ${corralId} does not exist.` };
      return create(
        { ...source.definition, name },
        { nodes: source.layout.nodes, viewport: source.layout.viewport },
        options.newCorralId(),
      );
    },

    async remove(corralId) {
      store.removeItem(recordKey(corralId));
      store.setItem(INDEX_KEY, JSON.stringify(readIndex().filter((id) => id !== corralId)));
    },
  };
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

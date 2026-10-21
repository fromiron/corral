import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTextAttachment } from '@corral/core';

export interface ProjectMaterial {
  id: string;
  projectId: string;
  kind: 'instructions' | 'memory';
  name: string;
  revision: number;
  text: string;
  deleted?: boolean;
}

/** Append-only document versions; request attachments contain immutable text and its hash. */
export class ProjectMaterials {
  private readonly path: string;
  private versions: ProjectMaterial[];
  private operations: Record<string, { hash: string; revision: string }> = {};
  constructor(root: string) {
    mkdirSync(root, { recursive: true });
    this.path = join(root, 'materials.json');
    const saved = existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : [];
    this.versions = Array.isArray(saved) ? saved : saved.versions;
    this.operations = Array.isArray(saved) ? {} : saved.operations;
  }
  private persist(next: ProjectMaterial[]) {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify({ versions: next, operations: this.operations }), {
      mode: 0o600,
    });
    renameSync(temporary, this.path);
    this.versions = next;
  }
  list(projectId: string) {
    const latest = new Map<string, ProjectMaterial>();
    for (const item of this.versions) if (item.projectId === projectId) latest.set(item.id, item);
    return [...latest.values()].filter((item) => !item.deleted);
  }
  snapshot(kind: ProjectMaterial['kind']) {
    const projects = [...new Set(this.versions.map((item) => item.projectId))];
    return {
      revision: this.revision(kind),
      value: {
        documents: projects
          .flatMap((id) => this.list(id))
          .filter((item) => item.kind === kind)
          .map(({ id, projectId, name, text }) => ({ id, projectId, name, text })),
      },
    };
  }
  receipt(kind: ProjectMaterial['kind'], operationId: string) {
    const operation = this.operations[`${kind}:${operationId}`];
    return operation ? { revision: operation.revision } : null;
  }
  private revision(kind: ProjectMaterial['kind'], versions = this.versions) {
    const current = new Map<string, ProjectMaterial>();
    for (const item of versions) current.set(`${item.projectId}:${item.id}`, item);
    return createHash('sha256')
      .update(JSON.stringify([...current.values()].filter((item) => item.kind === kind)))
      .digest('hex');
  }
  /** Settings imports append versions, preserving every request snapshot. */
  replaceKind(
    kind: ProjectMaterial['kind'],
    documents: { id: string; projectId: string; name: string; text: string }[],
    expectedRevision: string,
    operationId: string,
  ) {
    const key = `${kind}:${operationId}`;
    const hash = createHash('sha256').update(JSON.stringify(documents)).digest('hex');
    const operation = this.operations[key];
    if (operation) {
      if (operation.hash !== hash)
        throw new Error('The operation ID was reused with different documents.');
      return { revision: operation.revision };
    }
    if (expectedRevision !== this.revision(kind))
      throw new Error('The documents changed. Preview the import again.');
    const current = new Map<string, ProjectMaterial>();
    for (const item of this.versions) current.set(`${item.projectId}:${item.id}`, item);
    const keys = new Set<string>();
    for (const document of documents) {
      const key = `${document.projectId}:${document.id}`;
      if (keys.has(key)) throw new Error('Duplicate document identity.');
      keys.add(key);
      createTextAttachment(document.name, 'text/markdown', document.text);
      if (current.has(key) && current.get(key)?.kind !== kind)
        throw new Error('Document identity belongs to another material kind.');
    }
    const next = [...this.versions];
    for (const [key, item] of current) {
      if (item.kind === kind && !item.deleted && !keys.has(key))
        next.push({ ...item, revision: item.revision + 1, deleted: true });
    }
    for (const document of documents) {
      const previous = current.get(`${document.projectId}:${document.id}`);
      if (
        previous &&
        !previous.deleted &&
        previous.name === document.name &&
        previous.text === document.text
      )
        continue;
      next.push({ ...document, kind, revision: (previous?.revision ?? 0) + 1 });
    }
    const revision = this.revision(kind, next);
    this.operations[key] = { hash, revision };
    try {
      this.persist(next);
    } catch (error) {
      delete this.operations[key];
      throw error;
    }
    return { revision };
  }
  save(
    projectId: string,
    input: {
      id?: string;
      kind: ProjectMaterial['kind'];
      name: string;
      text: string;
      expectedRevision?: number;
    },
  ) {
    const previous = input.id
      ? this.list(projectId).find((item) => item.id === input.id)
      : undefined;
    if (input.id && (!previous || previous.revision !== input.expectedRevision))
      throw new Error('The document changed. Reload before saving.');
    const name = input.name.trim();
    createTextAttachment(name, 'text/markdown', input.text);
    const item: ProjectMaterial = {
      id: previous?.id ?? `material_${randomUUID()}`,
      projectId,
      kind: input.kind,
      name,
      text: input.text,
      revision: (previous?.revision ?? 0) + 1,
    };
    this.persist([...this.versions, item]);
    return item;
  }
  remove(projectId: string, id: string, expectedRevision: number) {
    const previous = this.list(projectId).find((item) => item.id === id);
    if (!previous || previous.revision !== expectedRevision)
      throw new Error('The document changed. Reload before removing.');
    this.persist([
      ...this.versions,
      { ...previous, revision: previous.revision + 1, deleted: true },
    ]);
  }
  attachment(projectId: string, id: string, revision: number) {
    const item = this.versions.find(
      (item) => item.projectId === projectId && item.id === id && item.revision === revision,
    );
    if (!item || item.deleted) throw new Error('This document version does not exist.');
    return createTextAttachment(
      `${item.name.slice(0, 90)} (v${revision}).md`,
      'text/markdown',
      item.text,
    );
  }
}

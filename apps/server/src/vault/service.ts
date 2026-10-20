import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from '@corral/contracts';
import { z } from 'zod';
import { bindingFields } from './binding-fields.ts';
import { decryptVault, encryptVault, type VaultEnvelope } from './crypto.ts';
import {
  VAULT_DOMAINS,
  type VaultDocument,
  type VaultDomain,
  type VaultDomainAdapter,
  type VaultDomainSnapshot,
} from './types.ts';

export const PortableApplication = z.strictObject({
  version: z.literal(1),
  theme: z.enum(['system', 'light', 'dark']),
  locale: z.enum(['en', 'ko']),
  sendKey: z.enum(['enter', 'mod-enter']),
  notify: z.boolean(),
  shortcuts: z
    .partialRecord(
      z.enum([
        'palette',
        'help',
        'session.new',
        'session.jump',
        'view.sidebar',
        'view.panel',
        'composer.focus',
        'settings',
        'nav.back',
        'nav.forward',
        'run.stop',
      ]),
      z.strictObject({
        key: z.string().regex(/^(?:[a-z0-9,./[\]]|Digit)$/i),
        mod: z.literal(true),
        shift: z.boolean().optional(),
        alt: z.boolean().optional(),
      }),
    )
    .optional(),
});
export type PortableApplication = z.infer<typeof PortableApplication>;
export const vaultRevision = (value: unknown) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');
export type VaultBindings = Partial<Record<VaultDomain, Record<string, string>>>;
type Adapters = Partial<Record<VaultDomain, VaultDomainAdapter>>;
interface Preview {
  created: number;
  bindings: VaultBindings;
  source: VaultDocument;
  before: Partial<Record<VaultDomain, VaultDomainSnapshot>>;
  after: Partial<Record<VaultDomain, unknown>>;
}
interface Journal {
  id: string;
  status: 'applying' | 'pending_client_apply' | 'committed' | 'rollback_needed' | 'rolled_back';
  bindings: VaultBindings;
  selected: VaultDomain[];
  before: Partial<Record<VaultDomain, VaultDomainSnapshot>>;
  after: Partial<Record<VaultDomain, unknown>>;
  completed: Partial<Record<VaultDomain, string>>;
  applying?: VaultDomain;
  recovering?: boolean;
}
export class VaultService {
  private readonly directory: string;
  private readonly adapters: (bindings: VaultBindings) => Adapters;
  private readonly now: () => number;
  private readonly id: () => string;
  private readonly previews = new Map<string, Preview>();
  private busy = false;
  constructor(options: {
    directory: string;
    adapters: (bindings: VaultBindings) => Adapters;
    now?: () => number;
    id?: () => string;
  }) {
    this.directory = options.directory;
    this.adapters = options.adapters;
    this.now = options.now ?? Date.now;
    this.id = options.id ?? randomUUID;
  }
  private get file() {
    return join(this.directory, 'apply-journal.json');
  }
  state() {
    if (!existsSync(this.file)) return { status: 'idle', id: null };
    const record = JSON.parse(readFileSync(this.file, 'utf8'));
    return { status: String(record.status), id: String(record.id) };
  }
  available(bindings: VaultBindings = {}) {
    const adapters = this.adapters(bindings);
    return VAULT_DOMAINS.map((domain) => ({
      domain,
      available: domain === 'application' || Boolean(adapters[domain]),
    }));
  }
  async capture(
    domains: VaultDomain[],
    password: string,
    application: PortableApplication,
    bindings: VaultBindings = {},
    includeSecrets: string[] = [],
  ) {
    const adapters = this.adapters(bindings);
    const captured: VaultDocument['domains'] = {};
    for (const domain of new Set(domains)) {
      if (domain === 'application') {
        const value = PortableApplication.parse(application);
        captured.application = { revision: vaultRevision(value), value };
      } else {
        const adapter = adapters[domain];
        if (!adapter) throw new Error(`${domain}: select its required local binding first.`);
        captured[domain] = await adapter.capture({ purpose: 'export', includeSecrets });
      }
    }
    return encryptVault(
      { version: 1, createdAt: new Date(this.now()).toISOString(), domains: captured },
      password,
    );
  }
  async preview(
    envelope: unknown,
    password: string,
    application: PortableApplication,
    bindings: VaultBindings = {},
  ) {
    const source = await decryptVault(envelope, password);
    const adapters = this.adapters(bindings);
    const before: Preview['before'] = {};
    const after: Preview['after'] = {};
    const entries = [];
    for (const domain of VAULT_DOMAINS) {
      const snapshot = source.domains[domain];
      if (!snapshot) continue;
      try {
        let warnings: string[] = [];
        if (domain === 'application') {
          const current = PortableApplication.parse(application);
          before.application = { revision: vaultRevision(current), value: current };
          const imported = PortableApplication.parse(snapshot.value);
          after.application = {
            ...imported,
            ...(imported.shortcuts === undefined && current.shortcuts !== undefined
              ? { shortcuts: current.shortcuts }
              : {}),
          };
          warnings = [
            'Applies theme, language, send key, notifications and supported shortcut overrides in this browser only.',
          ];
        } else {
          const adapter = adapters[domain];
          if (!adapter) throw new Error('Choose its local binding before previewing this domain.');
          const preview = await adapter.preview(snapshot.value, bindings[domain] ?? {});
          before[domain] = await adapter.capture({ purpose: 'rollback' });
          after[domain] = preview.value;
          warnings = preview.warnings;
        }
        entries.push({
          domain,
          available: true,
          changed: vaultRevision(before[domain]?.value) !== vaultRevision(after[domain]),
          warnings,
          fields: bindingFields(domain, snapshot.value),
        });
      } catch (error) {
        entries.push({
          domain,
          available: false,
          changed: false,
          warnings: [error instanceof Error ? error.message : 'Domain preview failed.'],
          fields: bindingFields(domain, snapshot.value),
        });
      }
    }
    for (const [id, preview] of this.previews)
      if (this.now() - preview.created > 600000) this.previews.delete(id);
    const oldest = this.previews.keys().next().value;
    if (this.previews.size >= 5 && oldest) this.previews.delete(oldest);
    const previewId = this.id();
    this.previews.set(previewId, { created: this.now(), bindings, source, before, after });
    return { previewId, entries };
  }
  private async save(journal: Journal, password: string) {
    const encrypted = await encryptVault(
      {
        version: 1,
        createdAt: new Date(this.now()).toISOString(),
        domains: { application: { revision: 'apply-journal-v1', value: journal } },
      },
      password,
    );
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.tmp`;
    writeFileSync(
      temporary,
      JSON.stringify({ id: journal.id, status: journal.status, encrypted }),
      { mode: 0o600 },
    );
    renameSync(temporary, this.file);
  }
  private async load(password: string): Promise<Journal> {
    const raw = JSON.parse(readFileSync(this.file, 'utf8'));
    const document = await decryptVault(raw.encrypted, password);
    const snapshot = document.domains.application;
    if (snapshot?.revision !== 'apply-journal-v1') throw new Error('Invalid apply journal.');
    const journal = snapshot.value as Journal;
    if (journal.id !== raw.id || journal.status !== raw.status)
      throw new Error('Apply journal metadata changed.');
    return journal;
  }
  async apply(previewId: string, selected: VaultDomain[], password: string) {
    if (this.busy) throw new Error('A vault operation is already in progress.');
    this.busy = true;
    try {
      const state = this.state();
      if (!['idle', 'committed', 'rolled_back'].includes(state.status))
        throw new Error('Recover the pending vault application first.');
      const preview = this.previews.get(previewId);
      if (!preview || this.now() - preview.created > 600000)
        throw new Error('Preview expired. Preview the vault again.');
      if (
        !selected.length ||
        new Set(selected).size !== selected.length ||
        selected.some((domain) => !Object.hasOwn(preview.after, domain))
      )
        throw new Error('Select available domains from this preview.');
      const adapters = this.adapters(preview.bindings);
      const journal: Journal = {
        id: this.id(),
        status: 'applying',
        bindings: preview.bindings,
        selected,
        before: Object.fromEntries(selected.map((domain) => [domain, preview.before[domain]])),
        after: Object.fromEntries(selected.map((domain) => [domain, preview.after[domain]])),
        completed: {},
      };
      await this.save(journal, password);
      try {
        for (const domain of selected) {
          if (domain === 'application') continue;
          const adapter = adapters[domain];
          const before = journal.before[domain];
          if (!adapter || !before) throw new Error(`${domain}: adapter is unavailable.`);
          const current = await adapter.capture();
          if (current.revision !== before.revision)
            throw new Error(`${domain}: settings changed since the preview.`);
          journal.applying = domain;
          await this.save(journal, password);
          const result = await adapter.apply(
            journal.after[domain],
            before.revision,
            `${journal.id}:${domain}`,
          );
          journal.completed[domain] = result.revision;
          delete journal.applying;
          await this.save(journal, password);
        }
        journal.status = selected.includes('application') ? 'pending_client_apply' : 'committed';
        await this.save(journal, password);
        this.previews.delete(previewId);
        return this.result(journal);
      } catch (error) {
        journal.status = 'rollback_needed';
        await this.save(journal, password);
        throw new Error(
          `Vault application stopped; recover it before another apply. ${error instanceof Error ? error.message : ''}`,
        );
      }
    } finally {
      this.busy = false;
    }
  }
  private result(journal: Journal) {
    return {
      id: journal.id,
      status: journal.status,
      ...(journal.status === 'pending_client_apply'
        ? {
            application: {
              expectedRevision: journal.before.application?.revision,
              target: PortableApplication.parse(journal.after.application),
            },
          }
        : {}),
    };
  }
  async pending(password: string) {
    const journal = await this.load(password);
    if (journal.status !== 'pending_client_apply')
      throw new Error(
        'No browser preference apply is pending. Use rollback to recover a stopped server apply.',
      );
    return this.result(journal);
  }
  async acknowledge(id: string, password: string, application: PortableApplication) {
    if (this.busy) throw new Error('A vault operation is already in progress.');
    this.busy = true;
    try {
      const journal = await this.load(password);
      if (journal.id !== id || journal.status !== 'pending_client_apply')
        throw new Error('No matching browser apply is pending.');
      const current = PortableApplication.parse(application);
      if (vaultRevision(current) !== vaultRevision(journal.after.application))
        throw new Error('Browser preference readback does not match the vault.');
      journal.status = journal.recovering ? 'rolled_back' : 'committed';
      await this.save(journal, password);
      return this.result(journal);
    } finally {
      this.busy = false;
    }
  }
  async rollback(password: string) {
    if (this.busy) throw new Error('A vault operation is already in progress.');
    this.busy = true;
    try {
      const journal = await this.load(password);
      if (journal.recovering && journal.status === 'pending_client_apply')
        return this.result(journal);
      const adapters = this.adapters(journal.bindings);
      if (!['applying', 'rollback_needed', 'pending_client_apply'].includes(journal.status))
        throw new Error('No application needs recovery.');
      for (const domain of [...journal.selected].reverse()) {
        if (domain === 'application') continue;
        if (!journal.completed[domain] && journal.applying !== domain) continue;
        const adapter = adapters[domain];
        const before = journal.before[domain];
        if (!adapter || !before) throw new Error(`${domain}: recovery adapter is unavailable.`);
        const current = await adapter.capture();
        const rollbackId = `${journal.id}:rollback:${domain}`;
        const restored = await adapter.receipt?.(rollbackId);
        if (restored) {
          if (current.revision !== restored.revision)
            throw new Error(`${domain}: settings changed after the recorded recovery.`);
          if (restored.state === 'partial')
            await adapter.restore(before, restored.revision, rollbackId);
          delete journal.completed[domain];
          if (journal.applying === domain) delete journal.applying;
          await this.save(journal, password);
          continue;
        }
        if (current.revision === before.revision) continue;
        const expected =
          journal.completed[domain] ??
          (journal.applying === domain
            ? (await adapter.receipt?.(`${journal.id}:${domain}`))?.revision
            : undefined);
        if (!expected || current.revision !== expected)
          throw new Error(
            `${domain}: outcome or revision is uncertain; inspect this domain before recovery.`,
          );
        await adapter.restore(before, expected, rollbackId);
        delete journal.completed[domain];
        if (journal.applying === domain) delete journal.applying;
        await this.save(journal, password);
      }
      if (journal.selected.includes('application')) {
        // The browser may have applied preferences before its acknowledgement was lost.
        const old = journal.before.application;
        const imported = journal.after.application;
        journal.before.application = { revision: vaultRevision(imported), value: imported };
        journal.after.application = old?.value;
        journal.status = 'pending_client_apply';
        journal.recovering = true;
      } else journal.status = 'rolled_back';
      await this.save(journal, password);
      return this.result(journal);
    } finally {
      this.busy = false;
    }
  }
}
export type { VaultEnvelope };

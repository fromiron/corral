import { SITE_PERMISSIONS, type SitePermission, webOrigin } from './browser-policy.ts';

/** Where the browser tab keeps its small files; main writes them atomically. */
export interface BrowserFiles {
  read(name: string): string | null;
  write(name: string, text: string): void;
  remove(name: string): void;
}

type Sites = Map<string, Map<SitePermission, boolean>>;

/**
 * A project's remembered permission answers, per site (origin) and permission. Electron keeps
 * none, so Corral does, beside the project's browser storage and cleared with it.
 */
export class SitePermissionStore {
  private readonly files: BrowserFiles;
  private readonly name: string;
  private sites: Sites | null = null;

  constructor(files: BrowserFiles, name: string) {
    this.files = files;
    this.name = name;
  }

  private load(): Sites {
    if (this.sites) return this.sites;
    const sites: Sites = new Map();
    try {
      const value = JSON.parse(this.files.read(this.name) ?? 'null');
      if (value?.version === 1 && value.sites && typeof value.sites === 'object')
        for (const [origin, answers] of Object.entries(value.sites)) {
          if (webOrigin(origin) !== origin || !answers || typeof answers !== 'object') continue;
          const kept = new Map<SitePermission, boolean>();
          for (const permission of SITE_PERMISSIONS) {
            const allow = (answers as Record<string, unknown>)[permission];
            if (typeof allow === 'boolean') kept.set(permission, allow);
          }
          if (kept.size) sites.set(origin, kept);
        }
    } catch {
      // A damaged file holds no answers; the next answer replaces it.
    }
    this.sites = sites;
    return sites;
  }

  private save() {
    const sites = this.load();
    if (!sites.size) {
      this.files.remove(this.name);
      return;
    }
    this.files.write(
      this.name,
      JSON.stringify({
        version: 1,
        sites: Object.fromEntries(
          [...sites].map(([origin, answers]) => [origin, Object.fromEntries(answers)]),
        ),
      }),
    );
  }

  get(origin: string, permission: SitePermission): boolean | undefined {
    return this.load().get(origin)?.get(permission);
  }

  set(origin: string, permission: SitePermission, allow: boolean) {
    const sites = this.load();
    const answers = sites.get(origin) ?? new Map<SitePermission, boolean>();
    answers.set(permission, allow);
    sites.set(origin, answers);
    this.save();
  }

  list(origin: string): { permission: SitePermission; allow: boolean }[] {
    const answers = this.load().get(origin);
    return SITE_PERMISSIONS.filter((permission) => answers?.has(permission)).map((permission) => ({
      permission,
      allow: answers?.get(permission) === true,
    }));
  }

  forget(origin: string, permission: SitePermission) {
    const sites = this.load();
    const answers = sites.get(origin);
    if (!answers?.delete(permission)) return;
    if (!answers.size) sites.delete(origin);
    this.save();
  }

  clear() {
    this.sites = new Map();
    this.files.remove(this.name);
  }
}

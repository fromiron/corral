import { createHash } from 'node:crypto';
import { canonicalJson, ProjectToolConfig } from '@corral/contracts';
import { FakeClock } from '@corral/testkit';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type Db,
  MIGRATIONS,
  migrate,
  openDatabase,
  SqliteProjectToolStore,
} from '../src/index.ts';

const databases: Db[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
const config = {
  checks: [{ id: 'typecheck', name: 'Types', argv: ['node', 'check.mjs'], timeoutMs: 10000 }],
  lspServers: [
    {
      id: 'ts',
      name: 'TypeScript',
      argv: ['typescript-language-server', '--stdio'],
      languageIds: ['typescript'],
      fileExtensions: ['.ts'],
      timeoutMs: 10000,
    },
  ],
};
function setup() {
  const db = openDatabase(':memory:');
  databases.push(db);
  return { db, store: new SqliteProjectToolStore(db, new FakeClock()) };
}

describe('pinned project execution configuration', () => {
  it('[TC-HAR-016-N] adding MCP trust preserves earlier check and language server approvals',()=>{
    const db=new Database(':memory:');databases.push(db);
    for(const migration of MIGRATIONS.slice(0,9)) db.exec(migration.sql);
    db.pragma('user_version = 9');
    db.prepare("INSERT INTO project_tool_trust VALUES ('project','check','test',?,'2026-10-18T00:00:00.000Z')").run('a'.repeat(64));
    migrate(db);
    const store=new SqliteProjectToolStore(db,new FakeClock());
    expect(store.trust({projectId:'project',kind:'check',id:'test',fingerprint:'a'.repeat(64)})).toBe('2026-10-18T00:00:00.000Z');
    expect(()=>store.setTrust({projectId:'project',kind:'mcp',id:'test',fingerprint:'a'.repeat(64)},true)).not.toThrow();
  });
  it('[TC-HAR-016-H] pins MCP endpoint and OAuth scope without changing old configuration hashes',()=>{
    const {store}=setup();
    const original=store.save('project',0,config);
    const mcp={id:'docs',name:'Docs',transport:'http' as const,url:'https://example.invalid/mcp',exposure:'direct' as const,timeoutMs:10000,auth:{kind:'oauth' as const,credentialRef:'docs_login',scope:'read:docs'}};
    const saved=store.save('project',1,{...config,mcpServers:[mcp]});
    expect(store.get('project',1)).toEqual(original);
    expect(saved.mcpServers).toEqual([mcp]);
    const target={projectId:'project',kind:'mcp' as const,id:'docs',fingerprint:'f'.repeat(64)};
    store.setTrust(target,true);expect(store.trust(target)).not.toBeNull();
    expect(store.trust({...target,kind:'lsp'})).toBeNull();
    expect(store.save('project',2,{...config,mcpServers:[{...mcp,auth:{...mcp.auth,scope:'write:docs'}}]}).hash).not.toBe(saved.hash);
    for(const server of [{...mcp,id:'collision-name'},{...mcp,url:'http://remote.invalid/mcp'},{...mcp,auth:{kind:'bearer',token:'inline-secret'}},{...mcp,url:'https://user:secret@example.invalid/mcp'}])
      expect(ProjectToolConfig.safeParse({...config,mcpServers:[server]}).success).toBe(false);
  });
  it('[TC-HAR-012-H] preserves exact revisions and computes canonical content hashes', () => {
    const { db, store } = setup();
    expect(store.latest('project')).toBeNull();
    const first = store.save('project', 0, config);
    const next = store.save('project', 1, { ...config, checks: [] });
    expect(first.hash).toBe(createHash('sha256').update(canonicalJson(config)).digest('hex'));
    expect(next.revision).toBe(2);
    expect(next.hash).not.toBe(first.hash);
    const reopened = new SqliteProjectToolStore(db, new FakeClock());
    expect(reopened.get('project', 1)).toEqual(first);
    expect(reopened.latest('project')).toEqual(next);
    expect(reopened.get('another', 1)).toBeNull();
  });

  it('[TC-HAR-012-N] rejects stale saves, malformed commands, duplicate IDs and SQL mutation', () => {
    const { db, store } = setup();
    store.save('project', 0, config);
    expect(() => store.save('project', 0, config)).toThrow(/revision/);
    for (const checks of [
      [{ ...config.checks[0], argv: [] }],
      [{ ...config.checks[0], argv: ['node\0'] }],
      [config.checks[0], config.checks[0]],
    ]) {
      expect(ProjectToolConfig.safeParse({ ...config, checks }).success).toBe(false);
    }
    expect(
      ProjectToolConfig.safeParse({
        ...config,
        lspServers: [{ ...config.lspServers[0], fileExtensions: ['../ts'] }],
      }).success,
    ).toBe(false);
    expect(() => db.exec("UPDATE project_tool_revisions SET config_json = '{}'")).toThrow(
      /immutable/,
    );
    expect(() => db.exec('DELETE FROM project_tool_revisions')).toThrow(/immutable/);
    expect(store.latest('project')?.revision).toBe(1);
  });

  it('[TC-HAR-013-N] trust cannot leak across project, tool kind, ID or changed fingerprint and can be revoked', () => {
    const { store } = setup();
    const fingerprint = 'a'.repeat(64);
    const target = { projectId: 'project', kind: 'check' as const, id: 'typecheck', fingerprint };
    expect(store.trust(target)).toBeNull();
    store.setTrust(target, true);
    expect(store.trust(target)).not.toBeNull();
    for (const other of [
      { ...target, projectId: 'other' },
      { ...target, kind: 'lsp' as const },
      { ...target, id: 'other' },
      { ...target, fingerprint: 'b'.repeat(64) },
    ])
      expect(store.trust(other)).toBeNull();
    store.setTrust(target, false);
    expect(store.trust(target)).toBeNull();
  });

  it('[TC-HAR-012-H] migrates existing check definitions without granting automatic execution trust', () => {
    const db = new Database(':memory:');
    databases.push(db);
    for (const migration of MIGRATIONS.slice(0, 7)) db.exec(migration.sql);
    db.pragma('user_version = 7');
    db.prepare(
      `INSERT INTO projects (id, name, description, revision, created_at, updated_at) VALUES ('project', 'Project', '', 1, ?, ?)`,
    ).run('2026-10-18T00:00:00.000Z', '2026-10-18T00:00:00.000Z');
    db.prepare(
      `INSERT INTO workspace_bindings (id, project_id, root_path, is_git, trusted, verify_json, created_at, updated_at) VALUES ('binding', 'project', '/unread/project', 1, 1, ?, ?, ?)`,
    ).run(JSON.stringify(config.checks), '2026-10-18T00:00:00.000Z', '2026-10-18T00:00:00.000Z');
    migrate(db);
    const store = new SqliteProjectToolStore(db, new FakeClock());
    expect(store.latest('project')).toMatchObject({
      revision: 1,
      checks: config.checks,
      lspServers: [],
    });
    expect(
      (db.prepare('SELECT count(*) AS n FROM project_tool_trust').get() as { n: number }).n,
    ).toBe(0);
    migrate(db);
    expect(store.latest('project')?.revision).toBe(1);
  });
});

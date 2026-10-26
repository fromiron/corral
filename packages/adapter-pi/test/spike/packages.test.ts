import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { DefaultPackageManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spikeSession } from './sdk-session.ts';

// S6: installing Pi packages with Pi's own package manager into a
// Corral-owned agent folder. Needs the npm registry, so it runs only with
// CORRAL_SPIKE_NETWORK=1 (never in CI).

const network = process.env.CORRAL_SPIKE_NETWORK === '1';
const PONYTAIL = 'npm:@dietrichgebert/ponytail@5.3.2';

function treeHash(dir: string): string {
  const hash = createHash('sha256');
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const path = join(d, name);
      if (statSync(path).isDirectory()) walk(path);
      else hash.update(relative(dir, path)).update(readFileSync(path));
    }
  };
  walk(dir);
  return hash.digest('hex').slice(0, 16);
}

function manager(agentDir: string, cwd: string) {
  const settingsManager = SettingsManager.inMemory({
    npmCommand: ['npm', '--ignore-scripts'],
  } as never);
  return new DefaultPackageManager({ cwd, agentDir, settingsManager });
}

describe.skipIf(!network)('S6: packages into a Corral agent folder', () => {
  let root = '';
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'corral-har-s6-'));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('npm --ignore-scripts keeps a package postinstall from running', async () => {
    const pkg = join(root, 'scripted');
    mkdirSync(pkg);
    writeFileSync(
      join(pkg, 'package.json'),
      JSON.stringify({
        name: 'corral-spike-scripted',
        version: '1.0.0',
        keywords: ['pi-package'],
        scripts: { postinstall: "node -e \"require('fs').writeFileSync('POSTINSTALL_RAN','1')\"" },
        pi: { skills: ['./skills'] },
      }),
    );
    mkdirSync(join(pkg, 'skills/x'), { recursive: true });
    writeFileSync(join(pkg, 'skills/x/SKILL.md'), '---\nname: x\ndescription: X.\n---\nX\n');
    const tgz = execFileSync('npm', ['pack', '--silent', '--pack-destination', root], { cwd: pkg })
      .toString()
      .trim();
    const agentDir = join(root, 'agent-scripted');
    const pm = manager(agentDir, root);
    await pm.install(`npm:${join(root, tgz)}`);
    const find = (name: string) => execFileSync('find', [agentDir, '-name', name]).toString();
    // Installed (plain npm would also have written the marker; checked by hand, see report).
    expect(find('corral-spike-scripted')).not.toBe('');
    expect(find('POSTINSTALL_RAN')).toBe('');
  }, 120_000);

  it('installs the original Ponytail reproducibly and loads it only into the bound session', async () => {
    const realConfig = join(homedir(), '.config/ponytail');
    const realConfigBefore = existsSync(realConfig);
    const dirs = ['a', 'b'].map((n) => join(root, `agent-${n}`));
    const paths: string[] = [];
    for (const agentDir of dirs) {
      const pm = manager(agentDir, root);
      await pm.install(PONYTAIL);
      const path = pm.getInstalledPath(PONYTAIL, 'user');
      if (!path) throw new Error('not installed');
      paths.push(path);
    }
    expect(treeHash(paths[0] as string)).toBe(treeHash(paths[1] as string));

    const pkg = paths[0] as string;
    const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')) as {
      pi: { extensions: string[]; skills: string[] };
    };
    // D8: config home pointed at a folder of this run, not the person's own.
    const configHome = join(root, 'config-home');
    const saved = {
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    };
    process.env.XDG_CONFIG_HOME = configHome;
    process.env.CLAUDE_CONFIG_DIR = join(configHome, 'claude');
    try {
      const run = await spikeSession({
        responses: [fauxAssistantMessage('Done.')],
        extensionPaths: manifest.pi.extensions.map((p) => join(pkg, p)),
        skillPaths: manifest.pi.skills.map((p) => join(pkg, p)),
      });
      try {
        expect(run.resourceLoader.getExtensions().errors).toEqual([]);
        await run.session.prompt('/ponytail ultra');
        await run.session.prompt('Write the function.');
        const request = run.log.requests.at(-1)?.systemPrompt ?? '';
        expect(request.toLowerCase()).toContain('ponytail');
        console.log('ponytail request system prompt bytes', request.length);
      } finally {
        run.dispose();
      }
    } finally {
      process.env.XDG_CONFIG_HOME = saved.XDG_CONFIG_HOME;
      process.env.CLAUDE_CONFIG_DIR = saved.CLAUDE_CONFIG_DIR;
      if (saved.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
      if (saved.CLAUDE_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    }
    expect(existsSync(realConfig)).toBe(realConfigBefore);
  }, 180_000);
});

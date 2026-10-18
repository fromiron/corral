import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { PackageInspection, PinnedPackageSource, ResourcePath } from '@corral/contracts';
import {
  DefaultPackageManager,
  loadSkills,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { z } from 'zod';
import { processPort } from './worker-process.ts';

const port = processPort();
const directory = process.env.CORRAL_WORKER_DIR;
if (!directory || process.env.HOME !== directory)
  throw new Error('isolated package worker required');
let started = false;
port.onFrame((raw) => {
  if (started) {
    port.kill();
    return;
  }
  started = true;
  void (async () => {
    try {
      const request = z
        .discriminatedUnion('type', [
          z.strictObject({ type: z.literal('inspect'), directory: z.string().min(1) }),
          z.strictObject({
            type: z.literal('install'),
            directory: z.string().min(1),
            source: PinnedPackageSource,
          }),
        ])
        .parse(raw);
      const root = resolve(request.directory);
      const agentDir = request.type === 'install' ? root : join(directory, 'agent');
      const settingsManager = SettingsManager.inMemory({ npmCommand: ['npm', '--ignore-scripts'] });
      const manager = new DefaultPackageManager({ cwd: root, agentDir, settingsManager });
      let packageRoot = root;
      if (request.type === 'install') {
        await manager.install(request.source);
        const installed = manager.getInstalledPath(request.source, 'user');
        if (!installed) throw new Error('package not installed');
        const location = relative(root, installed);
        if (
          !location ||
          isAbsolute(location) ||
          location === '..' ||
          location.startsWith(`..${sep}`)
        )
          throw new Error('package installed outside quarantine');
        packageRoot = installed;
      }
      const paths = await manager.resolveExtensionSources([packageRoot], { temporary: true });
      const local = (path: string) => ResourcePath.parse(relative(root, path).split(sep).join('/'));
      const extensions: string[] = [];
      const visited = new Set<string>();
      const collect = async (path: string) => {
        const rel = relative(root, path);
        if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`))
          throw new Error('extension outside package');
        if (visited.has(path)) throw new Error('extension entry cycle');
        visited.add(path);
        if (statSync(path).isFile()) {
          extensions.push(local(path));
          return;
        }
        const nested = await manager.resolveExtensionSources([path], { temporary: true });
        const entries = nested.extensions.filter((e) => e.enabled).map((e) => e.path);
        if (entries.length === 1 && entries[0] === path) {
          const index = ['index.ts', 'index.js'].map((name) => join(path, name)).find(existsSync);
          if (!index) throw new Error('extension directory has no entry');
          extensions.push(local(index));
        } else for (const entry of entries) await collect(entry);
      };
      const standaloneSkill = existsSync(join(packageRoot, 'SKILL.md'));
      if (!standaloneSkill)
        for (const extension of paths.extensions.filter((e) => e.enabled))
          await collect(extension.path);
      const skills = loadSkills({
        cwd: root,
        agentDir,
        skillPaths: standaloneSkill
          ? [packageRoot]
          : paths.skills.filter((e) => e.enabled).map((e) => e.path),
        includeDefaults: false,
      });
      if (skills.diagnostics.some((d) => d.type !== 'warning')) throw new Error('invalid skills');
      const manifestPath = join(packageRoot, 'package.json');
      const manifest = existsSync(manifestPath)
        ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>)
        : {};
      const inspection = PackageInspection.parse({
        name: manifest.name ?? 'local-resources',
        version: manifest.version ?? 'local',
        license: typeof manifest.license === 'string' ? manifest.license : null,
        packagePath: packageRoot === root ? null : local(packageRoot),
        extensions: [...new Set(extensions)],
        skills: skills.skills.map((skill) => ({
          name: skill.name,
          description: skill.description,
          entry: local(skill.filePath),
        })),
      });
      port.send({ type: 'inspected', inspection });
    } catch {
      port.send({ type: 'failed' });
    } finally {
      port.kill();
    }
  })();
});
port.send({ type: 'ready' });

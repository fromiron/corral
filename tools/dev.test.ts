import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bootstrapToken,
  demoArgs,
  demoEnv,
  initialLiveLog,
  liveServerArgs,
  liveStudioArgs,
  liveStudioEnv,
  parseDevArgs,
  pushText,
  reduceLiveLog,
  SERVER_ORIGIN,
  STUDIO_ORIGIN,
} from './dev.ts';

const token = 'abc_DEF-123';
const serverLink = `  ${SERVER_ORIGIN}/#bootstrap=${token}`;
const intro =
  'Corral is running. Open this link to start a session (reusable until this server stops):';

test('pnpm dev stays on the simulated studio unless --live is set', () => {
  assert.deepEqual(parseDevArgs([]), { help: false, live: false, studioArgs: [] });
  assert.deepEqual(parseDevArgs(['--port', '5174']), {
    help: false,
    live: false,
    studioArgs: ['--port', '5174'],
  });
  assert.deepEqual(parseDevArgs(['--', '--live']), { help: false, live: true, studioArgs: [] });
  assert.deepEqual(parseDevArgs(['--help', '--live']), { help: true, live: false, studioArgs: [] });
  assert.throws(() => parseDevArgs(['--live', '--port', '1']), /no extra arguments/);
});

test('a leftover server address does not turn the simulated dev server into the live proxy', () => {
  const env = demoEnv({ CORRAL_SERVER: SERVER_ORIGIN, PATH: '/bin' });
  assert.equal(env.CORRAL_SERVER, undefined);
  assert.equal(env.PATH, '/bin');
  assert.equal(liveStudioEnv({ PATH: '/bin' }).CORRAL_SERVER, SERVER_ORIGIN);
});

test('the demo command forwards vite arguments and the live command does not build studio', () => {
  assert.deepEqual(demoArgs([]), ['--filter', '@corral/studio', 'dev']);
  assert.deepEqual(demoArgs(['--host']), ['--filter', '@corral/studio', 'dev', '--', '--host']);
  const server = liveServerArgs('/work/corral');
  assert.deepEqual(server, [
    'apps/server/src/main.ts',
    '--workspace',
    '/work/corral',
    '--port',
    '4317',
    '--allow-origin',
    STUDIO_ORIGIN,
    '--mock-delay',
    '0',
  ]);
  assert.equal(server.includes('--no-live'), false);
  assert.equal(server.includes('--static'), false);
  assert.deepEqual(liveStudioArgs(), [
    '--filter',
    '@corral/studio',
    'exec',
    'vite',
    '--port',
    '5173',
    '--strictPort',
  ]);
});

test('the session link opens Vite, which is the origin the server allows', () => {
  assert.equal(bootstrapToken(serverLink), token);
  assert.equal(bootstrapToken('listening on 4317'), null);
  let state = initialLiveLog;
  const seen: string[] = [];
  for (const [source, line] of [
    ['server', 'server ready'],
    ['server', intro],
    ['server', serverLink],
    ['studio', `  ➜  Local:   ${STUDIO_ORIGIN}/`],
  ] as const) {
    const next = reduceLiveLog(state, source, line);
    state = next.state;
    seen.push(...next.lines);
  }
  assert.equal(
    seen.some((line) => line.includes('127.0.0.1:4317')),
    false,
  );
  assert.deepEqual(seen, [
    'server ready',
    `  ➜  Local:   ${STUDIO_ORIGIN}/`,
    intro,
    `  ${STUDIO_ORIGIN}/#bootstrap=${token}`,
  ]);
});

test('the session link waits until both the server token and Vite are ready', () => {
  const ready = reduceLiveLog(initialLiveLog, 'studio', `Local: ${STUDIO_ORIGIN}/`);
  assert.equal(ready.state.announced, false);
  const linked = reduceLiveLog(ready.state, 'server', serverLink);
  assert.equal(linked.state.announced, true);
  assert.equal(linked.lines.at(-1), `  ${STUDIO_ORIGIN}/#bootstrap=${token}`);
  const again = reduceLiveLog(linked.state, 'studio', 'hmr update');
  assert.deepEqual(again.lines, ['hmr update']);
});

test('a split server log still yields the bootstrap token', () => {
  const lines: string[] = [];
  let pending = pushText('', `noise\n  ${SERVER_ORIGIN}/#boot`, (line) => lines.push(line));
  pending = pushText(pending, `strap=${token}\n`, (line) => lines.push(line));
  assert.equal(pending, '');
  assert.deepEqual(lines, ['noise', `  ${SERVER_ORIGIN}/#bootstrap=${token}`]);
  const found = reduceLiveLog({ ...initialLiveLog, studioReady: true }, 'server', lines[1] ?? '');
  assert.equal(found.state.token, token);
});

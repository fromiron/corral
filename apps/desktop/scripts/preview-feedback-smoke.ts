import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron, expect, type Page } from '@playwright/test';

// One real Desktop feedback loop: a managed preview started from the work tab opens as the
// session panel's browser tab, and one page note on it goes out with the sidecar's mock mode,
// which never calls a provider. The explicit document save at the end is fixture input, not a
// claim that a model edited code.
const desktop = resolve(import.meta.dirname, '..');
const data = mkdtempSync(join(tmpdir(), 'corral-p20-smoke-'));
const original = join(data, 'preview-repository');
mkdirSync(original);
const probe = createServer();
await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
const address = probe.address();
assert(address && typeof address === 'object');
const port = address.port;
await new Promise<void>((done, reject) => probe.close((error) => (error ? reject(error) : done())));
writeFileSync(
  join(original, 'package.json'),
  JSON.stringify({
    name: 'corral-preview-feedback-fixture',
    private: true,
    scripts: { dev: 'node server.cjs' },
  }),
);
writeFileSync(join(original, 'headline.txt'), 'P20 preview before feedback');
writeFileSync(
  join(original, 'style.css'),
  'body{margin:40px;background:#f7f8f5;font:18px system-ui}h1{color:rgb(20,90,65)}button{padding:12px 24px;font:inherit}',
);
writeFileSync(
  join(original, 'index.html'),
  `<!doctype html><html lang="en"><head><link rel="stylesheet" href="/style.css"><title>P20 owned preview</title></head><body><h1 id="headline">P20 preview before feedback</h1><button id="add">Add</button><p id="count">Count: 0</p><script>
let count=0;document.querySelector('#add').onclick=()=>document.querySelector('#count').textContent='Count: '+(++count);
setInterval(()=>fetch('/headline.txt',{cache:'no-store'}).then(r=>r.text()).then(text=>document.querySelector('#headline').textContent=text),250);
</script></body></html>`,
);
writeFileSync(
  join(original, 'server.cjs'),
  `const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const files={'/':['index.html','text/html'],'/style.css':['style.css','text/css'],'/headline.txt':['headline.txt','text/plain']};
http.createServer((req,res)=>{const file=files[new URL(req.url,'http://localhost').pathname];if(!file){res.writeHead(404);res.end();return;}res.writeHead(200,{'Content-Type':file[1],'Cache-Control':'no-store'});res.end(fs.readFileSync(path.join(__dirname,file[0])));}).listen(${port},'127.0.0.1',()=>console.log('P20_READY'));
`,
);
const git = (...args: string[]) =>
  execFileSync(
    'git',
    [
      '-c',
      'user.name=P20 fixture',
      '-c',
      'user.email=p20@example.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    {
      cwd: original,
      stdio: 'ignore',
      timeout: 10000,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      },
    },
  );
git('init', '-q', '-b', 'main');
git('add', '.');
git('commit', '-qm', 'Preview feedback fixture');
const env: Record<string, string> = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  ),
);
delete env.ELECTRON_RUN_AS_NODE;
env.LANG = 'en_US.UTF-8';
const application = await _electron.launch({
  ...(process.argv[2] ? { executablePath: resolve(process.argv[2]) } : {}),
  args: [desktop, `--data-dir=${data}`, '--mock-only', '--lang=en-US'],
  env,
  timeout: 30000,
});
const NOTE = 'Make this heading say the preview took the feedback.';
let page: Page | undefined;
let overlay: Page | undefined;
let stage = 'startup';
let sessionId = '';
let failed = true;
const rendererErrors: string[] = [];

interface Reference {
  kind: string;
  name?: string;
  mime?: string;
  text?: string;
  provenance?: {
    kind: string;
    leaseId?: string;
    url?: string;
    sourceRevision?: null;
    screenshotHash?: string;
    target?: { sessionId?: string };
  };
}

async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  assert(page);
  // Electron owns the Studio cookie partition; APIRequestContext does not share that jar.
  const response = await page.evaluate(
    async ({ path, method, body }) => {
      const session = await fetch('/api/v1/session', { signal: AbortSignal.timeout(10000) });
      const { csrfToken } = (await session.json()) as { csrfToken: string };
      const reply = await fetch(`/api/v1${path}`, {
        method,
        headers: {
          'x-corral-csrf': csrfToken,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15000),
      });
      return {
        ok: reply.ok,
        status: reply.status,
        body: reply.status === 204 ? undefined : await reply.json(),
      };
    },
    { path, method, body },
  );
  assert(response.ok, `${method} ${path}: HTTP ${response.status}`);
  return response.body as T;
}
function phase(value: string) {
  stage = value;
  console.log(`P20: ${value}`);
}
/** A WebContentsView's own page, as Playwright lists it. */
async function pageWhere(found: (url: string) => boolean) {
  await expect
    .poll(
      () =>
        application
          .context()
          .pages()
          .some((candidate) => found(candidate.url())),
      { timeout: 10000 },
    )
    .toBe(true);
  const view = application
    .context()
    .pages()
    .find((candidate) => found(candidate.url()));
  assert(view, 'The actual WebContentsView page is required');
  view.setDefaultTimeout(10000);
  return view;
}
try {
  page = await application.firstWindow({ timeout: 30000 });
  page.setDefaultTimeout(10000);
  page.setDefaultNavigationTimeout(15000);
  page.on('pageerror', (error) => rendererErrors.push(error.message));
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//, { timeout: 30000 });
  await expect(page.getByTestId('app-sidebar')).toBeVisible();
  if (await page.getByRole('button', { name: '설정', exact: true }).isVisible()) {
    await page.getByRole('button', { name: '설정', exact: true }).click();
    await page.getByRole('combobox', { name: '언어', exact: true }).click();
    await page.getByRole('option', { name: 'English', exact: true }).click();
    await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  }

  phase('isolated fixture setup');
  const definition = JSON.parse(
    readFileSync(resolve(desktop, '../../examples/eval/single-agent.corral.json'), 'utf8'),
  );
  definition.id = 'p20_feedback_team';
  definition.name = 'Preview feedback fixture';
  const team = await api<{ record: { corralId: string } }>('/corrals', 'POST', {
    definition,
    projectId: 'default',
  });
  await api('/projects/default/workspace', 'PUT', { path: original });
  await api('/projects/default/workspace', 'PATCH', { trusted: true });
  const created = await api<{ session: { sessionId: string } }>('/sessions', 'POST', {
    projectId: 'default',
    title: 'Preview feedback core',
    corralId: team.record.corralId,
  });
  sessionId = created.session.sessionId;
  await api(`/sessions/${sessionId}/worktree`, 'POST');

  phase('preview started from the work tab');
  await page.goto(`${new URL(page.url()).origin}/sessions/${sessionId}?panel=tools`);
  await expect(page.getByTestId('workbench-tasks')).toBeVisible();
  await page.getByRole('button', { name: 'Run dev', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop dev', exact: true })).toBeVisible();
  const tasks = await api<{ tasks: { operationId: string; state: string }[] }>(
    `/sessions/${sessionId}/worktree/tasks`,
  );
  const task = tasks.tasks.find((item) => item.state === 'running');
  assert(task);
  await expect
    .poll(
      async () =>
        (
          await api<{ text: string }>(
            `/sessions/${sessionId}/worktree/tasks/${task.operationId}/output?offset=0`,
          )
        ).text,
      { timeout: 15000 },
    )
    .toContain('P20_READY');
  // The work tab's own tabs: the service preview is on Preview.
  const toolsTabs = page.getByRole('tablist', { name: 'Tasks', exact: true });
  await toolsTabs.getByRole('tab', { name: 'Preview', exact: true }).click();
  await page.getByRole('spinbutton', { name: 'Port', exact: true }).fill(String(port));
  const opening = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `/api/v1/sessions/${sessionId}/previews`,
    { timeout: 15000 },
  );
  await page.getByRole('button', { name: 'Open interactive preview', exact: true }).click();
  const opened = await opening;
  assert(opened.ok(), `Preview start failed: HTTP ${opened.status()}`);
  const lease = (await opened.json()) as { leaseId: string; url: string; state: string };
  assert.equal(lease.state, 'ready');
  const leaseAt = new URL(lease.url);

  phase('the preview opens as the session panel browser tab');
  const preview = await pageWhere((url) => url === lease.url);
  // The page is a view inside the app's own window, not a window of its own.
  const placement = await application.evaluate(({ BrowserWindow }, url) => {
    const windows = BrowserWindow.getAllWindows();
    return {
      windows: windows.length,
      inside: windows.some((window) =>
        window.contentView.children.some((child) => {
          const contents = (child as Electron.WebContentsView).webContents;
          return contents && !contents.isDestroyed() && contents.getURL() === url;
        }),
      ),
    };
  }, lease.url);
  assert.equal(placement.windows, 1, 'The preview opened no window of its own');
  assert(placement.inside, "The preview is a view in the app's window");
  const addressField = page.getByRole('textbox', { name: 'Address', exact: true });
  await expect(addressField).toBeVisible();
  await expect(addressField).toHaveAttribute('readonly', '');
  await expect
    .poll(async () => (await addressField.inputValue()).startsWith(leaseAt.origin))
    .toBe(true);

  phase('actual preview CSS, JavaScript and isolation');
  await expect(preview.getByRole('heading', { name: 'P20 preview before feedback' })).toHaveCSS(
    'color',
    'rgb(20, 90, 65)',
  );
  await preview.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(preview.getByText('Count: 1', { exact: true })).toBeVisible();
  assert.equal(
    await preview.evaluate(
      () => 'corralDesktop' in window || 'corralRemote' in window || 'require' in window,
    ),
    false,
  );
  const isolated = await application.evaluate(
    async ({ webContents }, urls) => {
      const all = webContents.getAllWebContents();
      const studio = all.find((contents) => contents.getURL() === urls.studio);
      const preview = all.find((contents) => contents.getURL() === urls.preview);
      if (!studio || !preview) return false;
      return (
        studio.session !== preview.session && (await preview.session.cookies.get({})).length === 0
      );
    },
    { studio: page.url(), preview: lease.url },
  );
  assert(isolated, 'Preview has its own empty cookie jar');
  await preview.screenshot({ path: '/tmp/corral-p20-preview.png' });

  phase('annotate on, one element picked, one note written');
  const annotate = page.getByRole('button', { name: 'Annotate', exact: true });
  await annotate.click();
  await expect(annotate).toHaveAttribute('aria-pressed', 'true');
  overlay = await pageWhere((url) => url.startsWith('corral-overlay://overlay/'));
  overlay.on('pageerror', (error) => rendererErrors.push(`overlay: ${error.message}`));
  await expect(overlay.locator('[data-annotate="surface"]')).toHaveCount(1);
  const heading = await preview
    .getByRole('heading', { name: 'P20 preview before feedback' })
    .boundingBox();
  assert(heading);
  // The overlay lies over the page at the page's own scale: a click on it picks what is under it.
  await overlay.mouse.click(heading.x + heading.width / 2, heading.y + heading.height / 2);
  const noteField = overlay.getByRole('textbox', { name: /^Note on / });
  await expect(noteField).toBeVisible();
  await noteField.fill(NOTE);
  // The mock model takes no image input, so the note goes as text.
  const screenshot = overlay.getByRole('button', { name: 'Include screenshot', exact: true });
  await expect(screenshot).toHaveAttribute('aria-pressed', 'true');
  await screenshot.click();
  await expect(screenshot).toHaveAttribute('aria-pressed', 'false');
  await overlay.screenshot({ path: '/tmp/corral-p20-note.png' });

  phase('the note arrives with preview provenance');
  const sending = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/v1/runs/auto',
    { timeout: 15000 },
  );
  await overlay.getByRole('button', { name: 'Send', exact: true }).click();
  const sent = await sending;
  const request = sent.request().postDataJSON() as {
    mode?: string;
    sessionId?: string;
    brief?: string;
    references?: Reference[];
  };
  assert.equal(request.mode, 'mock');
  assert.equal(request.sessionId, sessionId);
  assert.equal(request.brief, NOTE);
  const references = request.references ?? [];
  assert.equal(references.filter((item) => item.kind === 'image_attachment').length, 0);
  const notes = references.filter((item) => item.kind === 'text_attachment');
  assert.equal(notes.length, 1, 'The note is the one text attachment of the request');
  const [attachment] = notes;
  assert.equal(attachment?.name, 'annotation.json');
  assert.equal(attachment?.mime, 'application/json');
  const provenance = attachment?.provenance;
  assert.equal(provenance?.kind, 'preview');
  assert.equal(provenance?.leaseId, lease.leaseId);
  assert.equal(provenance?.url, `${leaseAt.origin}${leaseAt.pathname}`);
  assert.equal(provenance?.sourceRevision, null);
  assert.equal(provenance?.screenshotHash, undefined);
  assert.equal(provenance?.target?.sessionId, sessionId);
  const annotation = JSON.parse(attachment?.text ?? '{}') as {
    page?: { kind?: string; origin?: string };
    note?: string;
    element?: { tag?: string };
  };
  assert.equal(annotation.page?.kind, 'preview');
  assert.equal(annotation.page?.origin, leaseAt.origin);
  assert.equal(annotation.note, NOTE);
  assert.equal(annotation.element?.tag, 'h1');

  phase('one text-only mock Run starts from the note');
  const run = (await sent.json()) as {
    runId: string | null;
    receipt?: { error?: { code?: string } };
  };
  assert(
    sent.ok() && run.runId,
    `The note's request was refused: HTTP ${sent.status()} ${run.receipt?.error?.code ?? ''}`,
  );
  await expect(noteField).toHaveCount(0);
  await expect(overlay.locator('[data-annotate="announcer"]')).toHaveText('Note sent');
  await expect
    .poll(
      async () =>
        (await api<{ runId: string; status: string }[]>('/runs')).find(
          (item) => item.runId === run.runId,
        )?.status,
      { timeout: 15000 },
    )
    .toBe('succeeded');

  phase('explicit file save updates the same live preview');
  const document = await api<{ target: Record<string, unknown>; version: { sha256: string } }>(
    `/sessions/${sessionId}/worktree/document?path=headline.txt`,
  );
  const saved = await api<{ state: string }>(`/sessions/${sessionId}/worktree/documents`, 'POST', {
    operationId: 'p20_save_headline',
    kind: 'save',
    target: document.target,
    path: 'headline.txt',
    baseHash: document.version.sha256,
    editVersion: 1,
    text: 'P20 preview after feedback',
  });
  assert.equal(saved.state, 'succeeded');
  await expect(preview.getByRole('heading', { name: 'P20 preview after feedback' })).toBeVisible();
  assert.equal(preview.url(), lease.url);
  assert.equal(readFileSync(join(original, 'headline.txt'), 'utf8'), 'P20 preview before feedback');
  await preview.screenshot({ path: '/tmp/corral-p20-updated.png' });
  assert.deepEqual(rendererErrors, []);
  failed = false;
  console.log(
    'P20 core preview feedback smoke passed: the preview opened as a browser tab; one page note went with preview provenance in one text-only mock Run. Screenshots: /tmp/corral-p20-{preview,note,updated}.png',
  );
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: '/tmp/corral-p20-failure.png' }).catch(() => {});
    const controls = await page
      .locator('button,[role=dialog],[role=alert]')
      .allTextContents()
      .catch(() => []);
    // Why a note was not sent is said on the overlay, not on the app page.
    const note =
      overlay && !overlay.isClosed()
        ? await overlay
            .locator('[data-annotate="failure"], [data-annotate="announcer"]')
            .allTextContents()
            .catch(() => [])
        : [];
    writeFileSync(
      '/tmp/corral-p20-failure.json',
      JSON.stringify({ stage, controls, note, rendererErrors }, null, 2),
      { mode: 0o600 },
    );
  }
  console.error(`P20 failed at: ${stage}`);
  throw error;
} finally {
  if (page && sessionId && !page.isClosed()) {
    const tasks = await api<{ tasks: { operationId: string; state: string }[] }>(
      `/sessions/${sessionId}/worktree/tasks`,
    ).catch(() => ({ tasks: [] }));
    for (const task of tasks.tasks.filter((item) => item.state === 'running'))
      await api(`/sessions/${sessionId}/worktree/tasks/${task.operationId}/stop`, 'POST').catch(
        () => {},
      );
  }
  await application
    .evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    })
    .catch(() => {});
  await application.close().catch(() => {});
  if (failed && process.env.CORRAL_P20_RETAIN_FAILED === '1')
    console.log(`Retained isolated fixture: ${data}`);
  else rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

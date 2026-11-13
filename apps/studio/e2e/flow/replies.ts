import { createTextAttachment } from '@corral/core';
import type { Page } from '@playwright/test';
import { expect, type Harness } from '../server/harness.ts';
import { newConversation, requestBox } from '../workbench.ts';
import { waitForStill } from './probe.ts';

// Conversations with replies to quote, for the flows of docs/specs/features/reply-citation.md:
// a reply from a scripted response, requests around it that never ran, and messages sent with
// quotes of it. The person's own moves (drags, clicks, keys, wheels) stay in each test.

export const FIRST = 'The quick brown fox jumps over the lazy dog.';
export const SECOND = 'A second paragraph holds another passage worth quoting.';

export interface Reply {
  sessionId: string;
  runId: string;
  modelCallId: string;
  /** The reply body's text, which a quote's offsets count in. */
  drawn: string;
}

/** Runs' states, oldest first. */
export const runStates = (corral: Harness) =>
  [...corral.server.coordinator.listRuns()]
    .map((run) => corral.server.coordinator.getSnapshot(run.runId).projection.status)
    .reverse()
    .join(',');

/**
 * A new conversation with one reply to `request`: the next scripted response. `before` requests
 * that never ran come first, `later` ones after it.
 */
export async function conversation(
  page: Page,
  corral: Harness,
  later: number,
  { before = 0, request = 'Tell me about the fox' } = {},
): Promise<Reply> {
  await corral.open('/projects/default');
  await newConversation(page);
  const sessionId = new URL(page.url()).pathname.split('/').at(-1) as string;
  if (before) {
    await requests(page, sessionId, before, 'Earlier request');
    await expect(page.locator('[data-chat-item]').last()).toContainText(
      `Earlier request ${before}.`,
    );
  }
  const ran = [...corral.server.coordinator.listRuns()].length;
  await requestBox(page).fill(request);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const run = () => [...corral.server.coordinator.listRuns()].reverse()[ran];
  await expect
    .poll(
      () => {
        const found = run();
        return found ? corral.server.coordinator.getSnapshot(found.runId).projection.status : null;
      },
      { timeout: 30_000 },
    )
    .toBe('succeeded');
  const runId = run()?.runId as string;
  // The run's answer, once drawn in full: the words a quote of it counts in.
  const body = page.locator(`[data-reply-body][data-run-id="${runId}"]`).last();
  await expect(body).toBeVisible();
  await expect(page.getByTestId('live-text')).toHaveCount(0);
  await waitForStill(page);
  const modelCallId = (await body.getAttribute('data-model-call-id')) as string;
  const drawn = (await body.textContent()) ?? '';
  if (later) await requests(page, sessionId, later);
  return { sessionId, runId, modelCallId, drawn };
}

/** Requests that never ran, long enough to wrap; `queued` ones run. */
export const requests = (
  page: Page,
  sessionId: string,
  count: number,
  label = 'Later request',
  state: 'refused' | 'queued' = 'refused',
) =>
  page.evaluate(
    async ({ id, count, label, state }) => {
      const { csrfToken } = await (await fetch('/api/v1/session')).json();
      for (let index = 0; index < count; index += 1) {
        const response = await fetch(`/api/v1/sessions/${id}/entries`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-corral-csrf': csrfToken },
          body: JSON.stringify({
            intent: 'next',
            text: `${label} ${index + 1}. ${'Long enough to wrap over several lines. '.repeat(4)}`,
            state,
          }),
        });
        if (!response.ok) throw new Error(`entry: ${response.status}`);
      }
    },
    { id: sessionId, count, label, state },
  );

/** A quote of `text` at `at` in the drawn reply, as the toolbar takes one. */
export const quoteOf = (
  reply: Reply,
  text: string,
  at: number,
  over: Partial<{ runId: string; modelCallId: string }> = {},
) =>
  createTextAttachment('quote.txt', 'text/plain', text, {
    kind: 'reply',
    runId: over.runId ?? reply.runId,
    modelCallId: over.modelCallId ?? reply.modelCallId,
    start: at,
    end: at + text.length,
    prefix: reply.drawn.slice(Math.max(0, at - 32), at),
    suffix: reply.drawn.slice(at + text.length, at + text.length + 32),
  });

/** A message that never ran, sent with `attachments`. */
export const sendEntry = (page: Page, sessionId: string, text: string, attachments: unknown[]) =>
  page.evaluate(
    async ({ id, text, attachments }) => {
      const { csrfToken } = await (await fetch('/api/v1/session')).json();
      const response = await fetch(`/api/v1/sessions/${id}/entries`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-corral-csrf': csrfToken },
        body: JSON.stringify({ intent: 'next', text, state: 'refused', attachments }),
      });
      if (!response.ok) throw new Error(`entry: ${response.status}`);
    },
    { id: sessionId, text, attachments },
  );

/** A message "About the passage" sent with a quote of `text` at `at` in the drawn reply. */
export const sendQuote = (
  page: Page,
  reply: Reply,
  text: string,
  at: number,
  over: Partial<{ runId: string; modelCallId: string }> = {},
) => sendEntry(page, reply.sessionId, 'About the passage', [quoteOf(reply, text, at, over)]);

/** The sent chips of the message that says `text`. */
export const sentChip = (page: Page, text = 'About the passage') =>
  page
    .locator('[data-chat-item]')
    .filter({ hasText: text })
    .getByRole('button', { name: /^Go to the quoted passage/ });

export const NOT_FOUND = "Couldn't find the passage in the reply";

/** Keeps what each quote put in the request box, for `quoted` to read. */
export const keepQuotes = (page: Page) =>
  page.evaluate(() => {
    const kept: { text: string; provenance: unknown }[] = [];
    (window as unknown as { __quotes: typeof kept }).__quotes = kept;
    window.addEventListener(
      'corral:composer-attach',
      (event) =>
        kept.push(
          JSON.parse(
            JSON.stringify((event as CustomEvent<{ attachment: unknown }>).detail.attachment),
          ),
        ),
      true,
    );
  });
export const quoted = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __quotes: { text: string; provenance: Record<string, unknown> }[] })
        .__quotes,
  );

/**
 * Screen points at the start of `from` and the end of `to` in reply body `body` (the
 * `occurrence`th of each), where a hand puts the pointer to drag over them.
 */
export const wordPoints = (page: Page, body: number, from: string, to: string) =>
  page
    .locator('[data-reply-body]')
    .nth(body)
    .evaluate(
      (node, { from, to }) => {
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        const texts: Text[] = [];
        for (let text = walker.nextNode(); text; text = walker.nextNode()) texts.push(text as Text);
        const a = texts.find((text) => text.data.includes(from));
        const b = texts.filter((text) => text.data.includes(to)).at(-1);
        if (!a || !b) throw new Error(`no ${from} or ${to} in the reply`);
        const char = (text: Text, at: number) => {
          const range = document.createRange();
          range.setStart(text, at);
          range.setEnd(text, at + 1);
          return range.getBoundingClientRect();
        };
        const start = char(a, a.data.indexOf(from));
        const end = char(b, b.data.indexOf(to) + to.length - 1);
        return {
          from: { x: start.left + 1, y: start.top + start.height / 2 },
          to: { x: end.right - 1, y: end.top + end.height / 2 },
        };
      },
      { from, to },
    );

/** Drags over `from` to `to` in reply body `body` with the mouse. */
export async function drag(page: Page, body: number, from: string, to: string) {
  const at = await wordPoints(page, body, from, to);
  await page.mouse.move(at.from.x, at.from.y);
  await page.mouse.down();
  await page.mouse.move(at.to.x, at.to.y, { steps: 8 });
  await page.mouse.up();
}

export const selected = (page: Page) =>
  page.evaluate(() => document.getSelection()?.toString() ?? '');

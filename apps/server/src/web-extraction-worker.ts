import { parentPort, workerData } from 'node:worker_threads';
import { type DefaultTreeAdapterTypes, parse } from 'parse5';

type Node = DefaultTreeAdapterTypes.Node;
const skip = new Set([
  'script',
  'style',
  'template',
  'noscript',
  'svg',
  'math',
  'iframe',
  'object',
  'embed',
  'canvas',
  'nav',
  'form',
  'button',
  'input',
  'select',
  'textarea',
]);
const blocks = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'br',
  'dd',
  'div',
  'dl',
  'dt',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tr',
  'ul',
]);
const attr = (node: Node, name: string) =>
  'attrs' in node ? node.attrs.find((item) => item.name === name)?.value : undefined;
const hidden = (node: Node) =>
  'tagName' in node &&
  (skip.has(node.tagName) ||
    attr(node, 'hidden') !== undefined ||
    attr(node, 'aria-hidden') === 'true' ||
    /display\s*:\s*none|visibility\s*:\s*hidden/i.test(attr(node, 'style') ?? ''));
const children = (node: Node): Node[] => ('childNodes' in node ? node.childNodes : []);
const date = (value: string | undefined): string | null =>
  value && /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value) && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;

try {
  if (typeof workerData !== 'string' || Buffer.byteLength(workerData) > 1024 * 1024)
    throw new Error('input limit');
  const document = parse(workerData, { scriptingEnabled: false });
  const stack: Node[] = [document],
    nodes: Node[] = [];
  while (stack.length) {
    const node = stack.pop()!;
    if (hidden(node)) continue;
    if (nodes.length >= 30000) throw new Error('node limit');
    nodes.push(node);
    stack.push(...children(node).toReversed());
  }
  const textOf = (root: Node) => {
    const pending: (Node | string)[] = [root],
      parts: string[] = [];
    while (pending.length) {
      const node = pending.pop()!;
      if (typeof node === 'string') {
        parts.push(node);
        continue;
      }
      if (hidden(node)) continue;
      if (node.nodeName === '#text' && 'value' in node) {
        parts.push(node.value);
        continue;
      }
      const block = 'tagName' in node && blocks.has(node.tagName);
      if (block) parts.push('\n');
      pending.push(...(block ? ['\n'] : []), ...children(node).toReversed());
    }
    return parts
      .join('')
      .replace(/[\t\f\v ]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  };
  const title = nodes.find((node) => 'tagName' in node && node.tagName === 'title');
  const root =
    nodes.find((node) => 'tagName' in node && node.tagName === 'article') ??
    nodes.find(
      (node) => 'tagName' in node && (node.tagName === 'main' || attr(node, 'role') === 'main'),
    ) ??
    nodes.find((node) => 'tagName' in node && node.tagName === 'body');
  if (!root) throw new Error('no body');
  const meta = (keys: string[]) =>
    nodes.find(
      (node) =>
        'tagName' in node &&
        node.tagName === 'meta' &&
        keys.includes((attr(node, 'property') ?? attr(node, 'name') ?? '').toLowerCase()),
    );
  const published = meta(['article:published_time', 'datepublished', 'date']),
    modified = meta(['article:modified_time', 'datemodified']);
  const text = textOf(root);
  if (!text || Buffer.byteLength(text) > 1024 * 1024) throw new Error('text limit');
  parentPort!.postMessage({
    title: title ? textOf(title).slice(0, 200) : '',
    text,
    publishedAt: published ? date(attr(published, 'content')) : null,
    modifiedAt: modified ? date(attr(modified, 'content')) : null,
  });
} catch {
  parentPort!.postMessage({ error: 'extraction_failed' });
}

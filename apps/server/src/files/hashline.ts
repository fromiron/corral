import { createHash } from 'node:crypto';

// v1 intentionally supports concrete line coordinates, not inferred blocks
// or persistent registers. Every coordinate addresses the original read snapshot.
// This module performs no IO; the broker must apply its plan under its write lease,
// capability checks and operation journal, rechecking beforeSha256 at commit time.
const MAX_BYTES = 1024 * 1024;
const MAX_OPS_BYTES = 256 * 1024;
const MAX_OPS = 200;
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

export type HashlineScope = {
  hostId: string;
  runId: string;
  executionId: string;
  attempt: number;
};
export type HashlineEvidence = {
  version: 1;
  path: string;
  scope: HashlineScope;
  sha256: string;
  tag: string;
  encoding: 'utf-8';
  bom: boolean;
  eol: 'lf' | 'crlf' | 'mixed';
  finalNewline: boolean;
  totalLines: number;
  /** Only complete, actually delivered lines belong here. */
  ranges: { start: number; end: number }[];
};
export class HashlineError extends Error {
  readonly code: 'SCHEMA_INVALID' | 'REVISION_CONFLICT' | 'CAPABILITY_DENIED' | 'LIMIT_REACHED';
  constructor(code: HashlineError['code'], message: string) {
    super(message);
    this.name = 'HashlineError';
    this.code = code;
  }
}
const invalid = (message: string): never => {
  throw new HashlineError('SCHEMA_INVALID', message);
};

function relativePath(path: string) {
  if (!path || /[\0\r\n\\:]/.test(path) || path.startsWith('/'))
    invalid('Hashline requires a relative path with / separators');
  const parts = path.split('/');
  if (
    parts.some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git') ||
    parts[0]?.toLowerCase() === '.corral'
  )
    invalid('Hashline path must name an ordinary file within the working copy');
  return path;
}
type Line = { text: string; ending: string };
function inspect(bytes: Uint8Array) {
  if (bytes.byteLength > MAX_BYTES)
    throw new HashlineError('LIMIT_REACHED', 'Hashline files are at most 1 MiB');
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (decoded.includes('\0')) throw new Error('binary');
  } catch {
    throw new HashlineError('CAPABILITY_DENIED', 'Hashline requires valid UTF-8 text without NUL');
  }
  const bom = decoded.startsWith('\ufeff');
  const text = bom ? decoded.slice(1) : decoded;
  const lines: Line[] = [];
  let start = 0;
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '\n') continue;
    const isCrlf = i > start && text[i - 1] === '\r';
    lines.push({ text: text.slice(start, isCrlf ? i - 1 : i), ending: isCrlf ? '\r\n' : '\n' });
    if (isCrlf) crlf++;
    else lf++;
    start = i + 1;
  }
  if (start < text.length) lines.push({ text: text.slice(start), ending: '' });
  const finalNewline = text.endsWith('\n');
  const normalized =
    lines.map((line) => line.text.replace(/[ \t\r]+$/g, '')).join('\n') +
    (finalNewline ? '\n' : '');
  return {
    lines,
    bom,
    finalNewline,
    sha256: sha256(bytes),
    tag: sha256(normalized).slice(-4).toUpperCase(),
    eol: (crlf && lf ? 'mixed' : crlf ? 'crlf' : 'lf') as HashlineEvidence['eol'],
    preferredEnding: crlf > lf ? '\r\n' : '\n',
  };
}
function sameScope(a: HashlineScope, b: HashlineScope) {
  return (
    a.hostId === b.hostId &&
    a.runId === b.runId &&
    a.executionId === b.executionId &&
    a.attempt === b.attempt
  );
}
function coalesce(ranges: HashlineEvidence['ranges']) {
  const sorted = ranges.map((r) => ({ ...r })).sort((a, b) => a.start - b.start);
  const out: HashlineEvidence['ranges'] = [];
  for (const next of sorted) {
    const last = out.at(-1);
    if (last && next.start <= last.end + 1) last.end = Math.max(last.end, next.end);
    else out.push(next);
  }
  return out;
}
/** Call only after delivering both reads. A revision or ownership change resets evidence. */
export function mergeHashlineEvidence(
  previous: HashlineEvidence | undefined,
  next: HashlineEvidence,
): HashlineEvidence {
  if (
    !previous ||
    previous.path !== next.path ||
    previous.sha256 !== next.sha256 ||
    !sameScope(previous.scope, next.scope)
  )
    return { ...next, scope: { ...next.scope }, ranges: next.ranges.map((r) => ({ ...r })) };
  return {
    ...next,
    scope: { ...next.scope },
    ranges: coalesce([...previous.ranges, ...next.ranges]),
  };
}

export function readHashline(input: {
  bytes: Uint8Array;
  path: string;
  scope: HashlineScope;
  /** 1-based, inclusive; only complete lines are displayed. */
  offset?: number;
  limit?: number;
  /** Optional serialized-text cap; never truncates or grants a partial line. */
  maxOutputBytes?: number;
}) {
  const path = relativePath(input.path);
  const file = inspect(input.bytes);
  const offset = input.offset ?? 1;
  const limit = input.limit ?? Math.max(1, file.lines.length);
  if (
    !Number.isSafeInteger(offset) ||
    offset < 1 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    offset > Math.max(1, file.lines.length)
  )
    invalid('read offset and limit must select existing lines');
  let end = Math.min(file.lines.length, offset + limit - 1);
  if (input.maxOutputBytes !== undefined) {
    if (!Number.isSafeInteger(input.maxOutputBytes) || input.maxOutputBytes < 1)
      invalid('maxOutputBytes must be positive');
    let size = Buffer.byteLength(JSON.stringify(`[${path}#${file.tag}]`), 'utf8');
    for (let index = offset - 1; index < end; index++) {
      const row = `\n${index + 1}:${file.lines[index]?.text}`;
      size += Buffer.byteLength(JSON.stringify(row), 'utf8') - 2;
      if (size > input.maxOutputBytes) {
        if (index === offset - 1)
          throw new HashlineError(
            'LIMIT_REACHED',
            'a complete Hashline row exceeds the output limit; no read evidence was granted',
          );
        end = index;
        break;
      }
    }
  }
  const ranges = end >= offset ? [{ start: offset, end }] : [];
  const evidence: HashlineEvidence = {
    version: 1,
    path,
    scope: { ...input.scope },
    sha256: file.sha256,
    tag: file.tag,
    encoding: 'utf-8',
    bom: file.bom,
    eol: file.eol,
    finalNewline: file.finalNewline,
    totalLines: file.lines.length,
    ranges,
  };
  const body = file.lines
    .slice(offset - 1, end)
    .map((line, index) => `${offset + index}:${line.text}`)
    .join('\n');
  return {
    version: 1 as const,
    path,
    tag: file.tag,
    sha256: file.sha256,
    text: `[${path}#${file.tag}]${body ? `\n${body}` : ''}`,
    startLine: ranges.length ? offset : 0,
    endLine: end,
    totalLines: file.lines.length,
    truncated: end < file.lines.length,
    ...(end < file.lines.length ? { nextOffset: end + 1 } : {}),
    evidence,
  };
}

type Locator =
  | { kind: 'range'; start: number; end: number }
  | { kind: 'before' | 'after'; line: number }
  | { kind: 'end' };
export type HashlineOp =
  | { kind: 'PUT'; locator: Locator; lines: string[] }
  | { kind: 'CUT'; start: number; end: number }
  | { kind: 'REM' }
  | { kind: 'MV'; to: string };
function lineNumber(raw: string) {
  const n = Number(raw);
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(n))
    invalid('line numbers must be positive safe integers');
  return n;
}
function locator(raw: string): Locator {
  if (raw === '>$') return { kind: 'end' };
  if (raw.startsWith('<') || raw.startsWith('>'))
    return { kind: raw[0] === '<' ? 'before' : 'after', line: lineNumber(raw.slice(1)) };
  const range = /^([1-9]\d*)\.=([1-9]\d*)$/.exec(raw);
  if (!range)
    return invalid('use N.=M, <N, >N or >$; block locators and registers are not supported in v1');
  const start = lineNumber(range[1] as string);
  const end = lineNumber(range[2] as string);
  if (end < start) invalid('line range is reversed');
  return { kind: 'range', start, end };
}

/** Parses without changing any evidence or register state. */
export function parseHashlineOps(
  source: string,
  expected?: { path: string; tag: string },
): HashlineOp[] {
  if (Buffer.byteLength(source, 'utf8') > MAX_OPS_BYTES)
    throw new HashlineError('LIMIT_REACHED', 'Hashline ops are at most 256 KiB');
  if (source.includes('\0')) invalid('Hashline ops may not contain NUL');
  const rows = source.replace(/\r\n/g, '\n').split('\n');
  const first = rows[0] ?? '';
  if (first.startsWith('[')) {
    const header = /^\[(.+)#([0-9a-f]{4})\]$/i.exec(first);
    if (
      !header ||
      !expected ||
      header[1] !== expected.path ||
      header[2]?.toUpperCase() !== expected.tag.toUpperCase()
    )
      invalid('ops section header must match path and tag');
    rows.shift();
  }
  const ops: HashlineOp[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as string;
    if (!row.trim()) continue;
    const put = /^PUT ([^\s]+):$/.exec(row);
    const cut = /^CUT ([^\s]+)$/.exec(row);
    if (put) {
      const where = locator(put[1] as string);
      const lines: string[] = [];
      while (rows[i + 1]?.startsWith('+')) lines.push((rows[++i] as string).slice(1));
      if (!lines.length) invalid('PUT requires at least one + body row; use CUT to delete');
      ops.push({ kind: 'PUT', locator: where, lines });
    } else if (cut) {
      const where = locator(cut[1] as string);
      if (where.kind !== 'range') return invalid('CUT requires an inclusive N.=M range');
      ops.push({ kind: 'CUT', start: where.start, end: where.end });
    } else if (row === 'REM') {
      ops.push({ kind: 'REM' });
    } else if (row.startsWith('MV ')) {
      let to = row.slice(3).trim();
      if (to.startsWith('"') || to.startsWith("'")) {
        if (!to.endsWith(to[0] as string) || to.length < 3)
          invalid('invalid quoted MV destination');
        to = to.slice(1, -1);
      }
      ops.push({ kind: 'MV', to: relativePath(to) });
    } else invalid('expected PUT locator: with + rows, CUT N.=M, REM or MV destination');
    if (ops.length > MAX_OPS)
      throw new HashlineError('LIMIT_REACHED', 'Hashline allows at most 200 operations');
  }
  if (!ops.length) invalid('Hashline ops must not be empty');
  if (ops.length > 1 && ops.some((op) => op.kind === 'REM' || op.kind === 'MV'))
    invalid('REM and MV must each be the sole operation; use a separate call after re-reading');
  return ops;
}

type PlanMetadata = {
  version: 1;
  path: string;
  beforeSha256: string;
  tag: string;
  ops: HashlineOp['kind'][];
  firstChangedLine?: number;
};
export type HashlinePlan =
  | (PlanMetadata & { kind: 'write'; bytes: Buffer; sha256: string })
  | (PlanMetadata & { kind: 'delete' })
  | (PlanMetadata & { kind: 'move'; to: string; sha256: string });

export function applyHashline(input: {
  bytes: Uint8Array;
  path: string;
  scope: HashlineScope;
  /** Trusted broker state, never tool-supplied evidence. */
  evidence: HashlineEvidence | undefined;
  tag: string;
  ops: string;
}): HashlinePlan {
  const path = relativePath(input.path);
  const evidence = input.evidence;
  if (!evidence)
    throw new HashlineError('REVISION_CONFLICT', 'read this file with Hashline before editing');
  if (evidence.version !== 1 || evidence.path !== path || !sameScope(evidence.scope, input.scope))
    throw new HashlineError(
      'REVISION_CONFLICT',
      'Hashline read belongs to another path or execution scope',
    );
  const file = inspect(input.bytes);
  if (file.sha256 !== evidence.sha256)
    throw new HashlineError(
      'REVISION_CONFLICT',
      'file bytes changed since the read; read the file again',
    );
  if (
    !/^[0-9a-f]{4}$/i.test(input.tag) ||
    input.tag.toUpperCase() !== file.tag ||
    evidence.tag !== file.tag
  )
    throw new HashlineError('REVISION_CONFLICT', 'Hashline tag does not match the latest read');
  const ops = parseHashlineOps(input.ops, { path, tag: file.tag });
  const metadata: PlanMetadata = {
    version: 1,
    path,
    beforeSha256: file.sha256,
    tag: file.tag,
    ops: ops.map((op) => op.kind),
  };
  const visible = (start: number, end = start) => {
    if (end < start) return;
    if (!coalesce(evidence.ranges).some((range) => range.start <= start && range.end >= end))
      throw new HashlineError(
        'REVISION_CONFLICT',
        'referenced lines were not displayed; read the complete range before editing',
      );
  };
  const one = ops[0];
  if (one?.kind === 'REM' || one?.kind === 'MV') {
    visible(1, file.lines.length);
    if (one.kind === 'REM') return { ...metadata, kind: 'delete' };
    if (one.to === path) invalid('MV destination must differ from source');
    return { ...metadata, kind: 'move', to: one.to, sha256: file.sha256 };
  }

  const deletes = new Set<number>();
  const inserts = new Map<number, Line[]>();
  const within = (n: number) => {
    if (n < 1 || n > file.lines.length) invalid('line coordinate is outside the read file');
  };
  const remove = (start: number, end: number) => {
    within(start);
    within(end);
    visible(start, end);
    for (let line = start; line <= end; line++) {
      if (deletes.has(line)) invalid('overlapping changed line ranges');
      deletes.add(line);
    }
  };
  const insert = (at: number, body: string[]) => {
    if (inserts.has(at)) invalid('multiple insertions at the same original coordinate');
    inserts.set(
      at,
      body.map((text) => ({ text, ending: file.preferredEnding })),
    );
  };
  for (const op of ops) {
    if (op.kind === 'CUT') remove(op.start, op.end);
    if (op.kind !== 'PUT') continue;
    const where = op.locator;
    if (where.kind === 'range') {
      remove(where.start, where.end);
      insert(where.start - 1, op.lines);
    } else if (where.kind === 'end') {
      // Even head/tail insertion requires fresh bytes and a displayed anchor.
      if (file.lines.length) visible(file.lines.length);
      insert(file.lines.length, op.lines);
    } else {
      if (!(file.lines.length === 0 && where.kind === 'before' && where.line === 1)) {
        within(where.line);
        visible(where.line);
      }
      insert(where.kind === 'before' ? where.line - 1 : where.line, op.lines);
    }
  }
  const out: Line[] = [];
  for (let index = 0; index <= file.lines.length; index++) {
    for (const line of inserts.get(index) ?? []) out.push(line);
    if (index < file.lines.length && !deletes.has(index + 1))
      out.push({ ...(file.lines[index] as Line) });
  }
  const text =
    (file.bom ? '\ufeff' : '') +
    out
      .map((line, index) => {
        const last = index === out.length - 1;
        return line.text + (last && !file.finalNewline ? '' : line.ending || file.preferredEnding);
      })
      .join('');
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > MAX_BYTES)
    throw new HashlineError('LIMIT_REACHED', 'Hashline result exceeds 1 MiB');
  if (sha256(bytes) === file.sha256) invalid('Hashline operations produced no change');
  const after = inspect(bytes);
  const changed = [...deletes, ...Array.from(inserts.keys(), (index) => index + 1)];
  return {
    ...metadata,
    kind: 'write',
    bytes,
    sha256: after.sha256,
    tag: after.tag,
    firstChangedLine: changed.reduce((first, line) => Math.min(first, line), Infinity),
  };
}

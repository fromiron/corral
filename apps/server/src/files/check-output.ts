import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type { VerificationReport } from '@corral/contracts';

/** Redact complete bounded lines before retaining head/tail, including split UTF-8/tokens. */
export class CheckOutput {
  private readonly digest = createHash('sha256');
  private bytes = 0;
  private head = '';
  private tail = '';
  private keptBytes = 0;
  private truncated = false;
  private readonly streams = new Map<
    string,
    { decoder: StringDecoder; line: string; oversized: boolean }
  >();
  private readonly paths: string[];
  constructor(paths: string[]) {
    this.paths = paths.filter(Boolean).sort((a, b) => b.length - a.length);
  }

  add(source: string, chunk: Buffer) {
    this.bytes += chunk.length;
    this.digest.update(chunk);
    const stream = this.streams.get(source) ?? {
      decoder: new StringDecoder('utf8'),
      line: '',
      oversized: false,
    };
    this.streams.set(source, stream);
    const parts = stream.decoder.write(chunk).split('\n');
    for (let i = 0; i < parts.length; i++) {
      if (!stream.oversized) {
        stream.line += parts[i];
        if (Buffer.byteLength(stream.line) > 8192) {
          stream.oversized = true;
          stream.line = '';
          this.truncated = true;
        }
      }
      if (i < parts.length - 1) {
        this.keep(stream.oversized ? '[oversized line omitted]\n' : `${stream.line}\n`);
        stream.line = '';
        stream.oversized = false;
      }
    }
  }

  private keep(raw: string) {
    const text = redactToolText(raw, this.paths);
    const bytes = Buffer.from(text);
    const headRemaining = Math.max(0, 16384 - Buffer.byteLength(this.head));
    this.head += bytes.subarray(0, headRemaining).toString('utf8');
    const rest = bytes.subarray(headRemaining);
    if (rest.length)
      this.tail = Buffer.concat([Buffer.from(this.tail), rest])
        .subarray(-16384)
        .toString('utf8');
    this.keptBytes += bytes.length;
    if (this.keptBytes > 32768) this.truncated = true;
  }

  finish(): VerificationReport['output'] {
    for (const stream of this.streams.values()) {
      if (stream.oversized) this.keep('[oversized line omitted]\n');
      else if (stream.line) this.keep(stream.line + stream.decoder.end());
    }
    return {
      text: this.head + (this.keptBytes > 32768 ? '\n[output omitted]\n' : '') + this.tail,
      bytes: this.bytes,
      hash: this.digest.digest('hex'),
      truncated: this.truncated,
    };
  }
}

export function redactToolText(raw: string, paths: string[]) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI terminal escapes from check output
  let text = raw.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
  for (const path of paths) text = text.split(path).join('[workspace]');
  text = text
    .replace(/(bearer\s+)[\w.+/=-]+/gi, '$1[redacted]')
    .replace(/\b(?:sk-|rt-|eyJ)[\w.-]{8,}/g, '[redacted]')
    .replace(
      /\b[\w-]*(?:token|secret|password|api[_-]?key)[\w-]*\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/gi,
      '[credential redacted]',
    )
    .replace(/(?:[A-Za-z]:\\|(?<![:/\w])\/)(?:[^\s:<>"'|]+[\\/])*[^\s:<>"'|]*/g, '[path]');
  return text;
}

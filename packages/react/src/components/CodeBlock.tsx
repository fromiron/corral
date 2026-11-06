import { Children, isValidElement, type ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import { CopyTextButton } from './CopyTextButton.tsx';

const LANGUAGES = new Set([
  'js',
  'javascript',
  'jsx',
  'ts',
  'typescript',
  'tsx',
  'json',
  'py',
  'python',
  'sh',
  'bash',
  'shell',
  'css',
  'sql',
  'java',
  'c',
  'cpp',
  'go',
  'rust',
]);
// A small lexical aid, not a parser: unknown languages retain escaped plain source.
// One linear pass and React text nodes keep incomplete streaming fences safe.
const KEYWORDS = new Set(
  'const let var function return if else for while class import from export async await new throw try catch def print True False None true false null undefined public private static void int string select SELECT FROM WHERE'.split(
    ' ',
  ),
);
function highlighted(text: string, language: string): ReactNode {
  if (!LANGUAGES.has(language.toLowerCase()) || text.length > 100_000) return text;
  const parts: ReactNode[] = [];
  let cursor = 0,
    plain = 0;
  while (cursor < text.length) {
    const start = cursor;
    const char = text[cursor];
    let color: string | undefined;
    if (text.startsWith('//', cursor) || char === '#') {
      const end = text.indexOf('\n', cursor);
      cursor = end < 0 ? text.length : end;
      color = 'text-muted-foreground';
    } else if (text.startsWith('/*', cursor)) {
      const end = text.indexOf('*/', cursor + 2);
      cursor = end < 0 ? text.length : end + 2;
      color = 'text-muted-foreground';
    } else if (char === '"' || char === "'" || char === '`') {
      cursor++;
      while (cursor < text.length) {
        if (text[cursor] === '\\') cursor = Math.min(cursor + 2, text.length);
        else if (text[cursor++] === char) break;
      }
      color = 'text-success';
    } else if (char && /[0-9]/.test(char)) {
      while (cursor < text.length && /[0-9.]/.test(text[cursor] ?? '')) cursor++;
      color = 'text-warning';
    } else if (char && /[A-Za-z_$]/.test(char)) {
      while (cursor < text.length && /[A-Za-z0-9_$]/.test(text[cursor] ?? '')) cursor++;
      if (KEYWORDS.has(text.slice(start, cursor))) color = 'font-semibold text-primary';
    } else cursor++;
    if (color) {
      if (plain < start) parts.push(text.slice(plain, start));
      parts.push(
        <span key={start} className={color}>
          {text.slice(start, cursor)}
        </span>,
      );
      plain = cursor;
    }
  }
  if (plain < text.length) parts.push(text.slice(plain));
  return parts;
}
export function CodeBlock({ children }: { children: ReactNode }) {
  const t = useTranslations('MessageBody');
  const child = Children.toArray(children)[0];
  if (!isValidElement<{ children?: ReactNode; className?: string }>(child))
    return <pre>{children}</pre>;
  const text = String(child.props.children ?? '');
  const language = /(?:^|\s)language-([^\s]+)/.exec(child.props.className ?? '')?.[1] ?? '';
  return (
    <div className="my-3 min-w-0 overflow-hidden rounded-lg border border-border">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1 text-xs text-muted-foreground">
        <span data-code-language>{language || t('plainText')}</span>
        <CopyTextButton text={text} code />
      </div>
      <pre className="!m-0 max-w-full overflow-x-auto !rounded-none !border-0">
        <code className={child.props.className}>{highlighted(text, language)}</code>
      </pre>
    </div>
  );
}

import { useMemo } from 'react';
import Markdown, { type Components, defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useTranslations } from 'use-intl';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../design-kit/index.ts';
import { CodeBlock } from './CodeBlock.tsx';

// Model output as Markdown, never as HTML. Raw HTML in the text is
// dropped within Markdown; complete HTML documents stay readable as escaped source. Links
// keep safe schemes, and remote images are named instead of loaded to prevent tracking.

const SAFE_SCHEMES = /^(https?:|mailto:)/i;

function safeUrl(url: string): string {
  const cleaned = defaultUrlTransform(url);
  return cleaned && SAFE_SCHEMES.test(cleaned) ? cleaned : '';
}

type Translate = ReturnType<typeof useTranslations<'Markdown'>>;
const markdownComponents = (t: Translate): Components => ({
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  a: ({ href, children }) =>
    href ? (
      <a href={href} target="_blank" rel="noopener noreferrer" className="underline">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  img: ({ alt, src }) => {
    const host = (() => {
      try {
        return src ? new URL(src).host : '';
      } catch {
        return '';
      }
    })();
    return (
      <span className="rounded fill-control px-1 text-caption text-muted-foreground">
        {t('imageNotLoaded', { alt: alt || t('image'), host: host || '—' })}
      </span>
    );
  },
  table: ({ children }) => (
    <div className="max-w-full overflow-x-auto">
      <Table size="compact">{children}</Table>
    </div>
  ),
  thead: ({ children }) => <TableHeader>{children}</TableHeader>,
  tbody: ({ children }) => <TableBody>{children}</TableBody>,
  tr: ({ children }) => <TableRow>{children}</TableRow>,
  th: ({ children }) => <TableHead>{children}</TableHead>,
  td: ({ children }) => <TableCell>{children}</TableCell>,
});

/**
 * `reader` is the Results view's larger type; `compact` fits side panels; `chat` is a
 * conversation answer: the kit's chat text size in the foreground color, with reading leading.
 */
export function SafeMarkdown({
  text,
  size = 'compact',
}: {
  text: string;
  size?: 'compact' | 'reader' | 'chat';
}) {
  const t = useTranslations('Markdown');
  const reader = size === 'reader';
  // The same components every render: new ones would draw a code block, a table or a link
  // anew each time the reply renders, and a passage chosen in it would be lost.
  const components = useMemo(() => markdownComponents(t), [t]);
  if (/^\s*(?:<!doctype\s+html\b|<html\b)/i.test(text)) {
    return (
      <div className="typeset typeset-compact min-w-0 max-w-full">
        <CodeBlock>
          <code className="language-html">{text}</code>
        </CodeBlock>
      </div>
    );
  }
  return (
    <div
      className={`corral-markdown typeset min-w-0 max-w-full wrap-anywhere ${reader ? '[--typeset-body:var(--text-reader)] [--typeset-body-leading:var(--text-reader--line-height)]' : size === 'chat' ? 'text-foreground [--typeset-body:var(--fs-subtitle)] [--typeset-body-leading:var(--lh-title)]' : 'typeset-compact'}`}
    >
      <Markdown skipHtml remarkPlugins={[remarkGfm]} urlTransform={safeUrl} components={components}>
        {text}
      </Markdown>
    </div>
  );
}

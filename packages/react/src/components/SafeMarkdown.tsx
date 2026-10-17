import Markdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useTranslations } from 'use-intl';

// Model output as Markdown, never as HTML (Spec §10.2, C-025). Raw HTML in the text is
// dropped within Markdown; complete HTML documents stay readable as escaped source. Links
// keep safe schemes, and remote images are named instead of loaded to prevent tracking.

const SAFE_SCHEMES = /^(https?:|mailto:)/i;

function safeUrl(url: string): string {
  const cleaned = defaultUrlTransform(url);
  return cleaned && SAFE_SCHEMES.test(cleaned) ? cleaned : '';
}

/** `reader` is the Results view's larger type (CR-009); `compact` fits side panels. */
export function SafeMarkdown({
  text,
  size = 'compact',
}: {
  text: string;
  size?: 'compact' | 'reader';
}) {
  const t = useTranslations('Markdown');
  const reader = size === 'reader';
  if (/^\s*(?:<!doctype\s+html\b|<html\b)/i.test(text)) {
    return (
      <pre className="max-w-full overflow-auto rounded border border-line bg-surface p-2 text-xs">
        <code>{text}</code>
      </pre>
    );
  }
  return (
    <div
      className={`corral-markdown flex min-w-0 max-w-full flex-col wrap-anywhere ${reader ? 'gap-3 text-reader leading-7' : 'gap-2 text-sm leading-relaxed'}`}
    >
      <Markdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        urlTransform={safeUrl}
        components={{
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
              <span className="rounded border border-line px-1 text-xs text-muted">
                {t('imageNotLoaded', { alt: alt || t('image'), host: host || '—' })}
              </span>
            );
          },
          h1: ({ children }) => (
            <h1 className={`${reader ? 'mt-2 text-2xl' : 'text-base'} font-semibold`}>
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className={`${reader ? 'mt-2 text-xl' : 'text-sm'} font-semibold`}>{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className={`${reader ? 'text-lg' : 'text-sm'} font-semibold`}>{children}</h3>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-line pl-3 text-muted">{children}</blockquote>
          ),
          hr: () => <hr className="border-line" />,
          table: ({ children }) => (
            <div className="max-w-full overflow-auto">
              <table className="border-collapse text-left">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-line bg-surface px-2 py-1 font-semibold">{children}</th>
          ),
          td: ({ children }) => <td className="border border-line px-2 py-1">{children}</td>,
          ul: ({ children }) => <ul className="list-disc pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal pl-5">{children}</ol>,
          code: ({ children }) => (
            <code className={`rounded bg-surface px-1 font-mono ${reader ? 'text-ui' : 'text-xs'}`}>
              {children}
            </code>
          ),
          pre: ({ children }) => (
            <pre
              className={`max-w-full overflow-auto rounded border border-line bg-surface p-2 ${reader ? 'text-ui' : 'text-xs'}`}
            >
              {children}
            </pre>
          ),
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}

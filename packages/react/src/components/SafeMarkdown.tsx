import Markdown, { defaultUrlTransform } from 'react-markdown';
import { useTranslations } from 'use-intl';

// Model output as Markdown, never as HTML (Spec §10.2, C-025). Raw HTML in the text is
// dropped, links keep only safe schemes and open without referrer, and images are not
// loaded: a remote image could track the reader, so it is named instead.

const SAFE_SCHEMES = /^(https?:|mailto:)/i;

function safeUrl(url: string): string {
  const cleaned = defaultUrlTransform(url);
  return cleaned && SAFE_SCHEMES.test(cleaned) ? cleaned : '';
}

export function SafeMarkdown({ text }: { text: string }) {
  const t = useTranslations('Markdown');
  return (
    <div className="corral-markdown flex flex-col gap-2 text-sm leading-relaxed">
      <Markdown
        skipHtml
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
          h1: ({ children }) => <h1 className="text-base font-semibold">{children}</h1>,
          h2: ({ children }) => <h2 className="text-sm font-semibold">{children}</h2>,
          ul: ({ children }) => <ul className="list-disc pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal pl-5">{children}</ol>,
          code: ({ children }) => (
            <code className="rounded bg-surface px-1 font-mono text-xs">{children}</code>
          ),
          pre: ({ children }) => (
            <pre className="overflow-auto rounded border border-line bg-surface p-2 text-xs">
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

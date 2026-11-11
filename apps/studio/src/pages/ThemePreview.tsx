import { Button, cn, LiveDot } from '@corral/react/design-kit';
import { CircleAlert, CircleCheck, Info, TriangleAlert } from '@corral/react/icons';
import type { CSSProperties, ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import type { Palette, PaletteBase, SyntaxColor } from '../workbench/themes/palette.ts';
import { paletteTokens } from '../workbench/themes/tokens.ts';

/**
 * A subtree drawn in one theme whatever the app shows now: a named theme's tokens from the theme
 * function, under the kit's scope for its base, or the kit's own light or dark palette.
 */
function PaletteScope({
  palette,
  base,
  className,
  children,
}: {
  palette: Palette | null;
  base: PaletteBase;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      data-palette-scope={base}
      className={cn(base, className)}
      style={palette ? (paletteTokens(palette) as CSSProperties) : undefined}
    >
      {children}
    </div>
  );
}

/** One code token: its text and the syntax role that colors it (none for punctuation). */
type Token = readonly [
  string,
  'comment' | 'keyword' | 'variable' | 'number' | 'function' | 'string' | null,
];

const CODE: readonly (readonly Token[])[] = [
  [['// short names', 'comment']],
  [
    ['const', 'keyword'],
    [' max ', 'variable'],
    ['= ', null],
    ['40', 'number'],
  ],
  [
    ['label', 'function'],
    ['(', null],
    ['"ok"', 'string'],
    [')', null],
  ],
];

const SYNTAX_FILL: Record<NonNullable<Token[1]>, CSSProperties> = {
  comment: { fill: 'var(--syntax-comment)' },
  keyword: { fill: 'var(--syntax-keyword)' },
  variable: { fill: 'var(--syntax-variable)' },
  number: { fill: 'var(--syntax-number)' },
  function: { fill: 'var(--syntax-function)' },
  string: { fill: 'var(--syntax-string)' },
};

/** The four status hues, in the order a run reads them. */
const STATUS_FILLS = ['fill-success', 'fill-warning', 'fill-destructive', 'fill-info'] as const;

/**
 * The app in miniature, in the tokens of the scope around it: the floor with the sidebar (a chosen
 * row, a live mark in the emphasis), the raised work surface with a title and its metadata, a few
 * lines of code in the syntax colors, and the four status hues as a quiet run of marks.
 */
function ThumbnailArt() {
  return (
    <svg
      viewBox="0 0 160 100"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden
      className="block size-full"
    >
      <rect width="160" height="100" className="fill-surface-1" />
      {/* The sidebar, on the floor. */}
      <rect x="8" y="9" width="7" height="7" rx="2" className="fill-foreground" />
      <rect x="18" y="11" width="16" height="3" rx="1.5" className="fill-foreground" />
      <rect x="10" y="27" width="20" height="2.6" rx="1.3" className="fill-muted-foreground" />
      <rect x="5" y="33" width="36" height="9" rx="2.5" className="fill-selected" />
      <rect x="10" y="36.2" width="24" height="2.6" rx="1.3" className="fill-foreground" />
      <rect x="10" y="46.2" width="15" height="2.6" rx="1.3" className="fill-muted-foreground" />
      <circle cx="35.5" cy="47.5" r="1.7" className="fill-emphasis" />
      <rect x="10" y="55.4" width="22" height="2.6" rx="1.3" className="fill-muted-foreground" />
      {/* The work surface beside it. */}
      <rect
        x="46"
        y="6"
        width="124"
        height="104"
        rx="5"
        className="fill-surface-2 stroke-border"
        strokeWidth="0.75"
      />
      <rect x="55" y="15" width="40" height="3.6" rx="1.8" className="fill-foreground" />
      <rect x="55" y="22.5" width="62" height="2.6" rx="1.3" className="fill-muted-foreground" />
      <rect
        x="53"
        y="31"
        width="100"
        height="33"
        rx="3"
        className="fill-surface-1 stroke-border"
        strokeWidth="0.6"
      />
      <text x="58" y="40.5" fontSize="6.2" className="font-mono">
        {CODE.map((line, row) => (
          <tspan
            // biome-ignore lint/suspicious/noArrayIndexKey: The sample's lines never move.
            key={row}
            x="58"
            dy={row === 0 ? 0 : 8.6}
          >
            {line.map(([text, role], index) => (
              <tspan
                // biome-ignore lint/suspicious/noArrayIndexKey: The sample's tokens never move.
                key={index}
                className={role ? undefined : 'fill-foreground'}
                style={role ? SYNTAX_FILL[role] : undefined}
              >
                {text}
              </tspan>
            ))}
          </tspan>
        ))}
      </text>
      {STATUS_FILLS.map((fill, index) => (
        <g key={fill} transform={`translate(${55 + index * 20} 72)`}>
          <circle cx="1.8" cy="1.8" r="1.8" className={fill} />
          <rect x="6" y="0.5" width="9" height="2.6" rx="1.3" className="fill-muted-foreground" />
        </g>
      ))}
      {/* A run in progress: the emphasis over a track in the border role. */}
      <rect x="55" y="83" width="96" height="2.4" rx="1.2" className="fill-border" />
      <rect x="55" y="83" width="56" height="2.4" rx="1.2" className="fill-emphasis" />
    </svg>
  );
}

/** A theme's card picture: the app drawn in that theme alone. */
export function ThemeThumbnail({
  palette,
  base,
}: {
  /** A named theme, or null for the kit's own light or dark. */
  palette: Palette | null;
  base: PaletteBase;
}) {
  return (
    <PaletteScope palette={palette} base={base} className="size-full">
      <ThumbnailArt />
    </PaletteScope>
  );
}

/** System: the kit's light and dark, each drawing its half of one picture. */
export function SystemThumbnail() {
  return (
    <div className="relative size-full">
      <PaletteScope
        palette={null}
        base="light"
        className="absolute inset-0 [clip-path:polygon(0_0,58%_0,42%_100%,0_100%)]"
      >
        <ThumbnailArt />
      </PaletteScope>
      <PaletteScope
        palette={null}
        base="dark"
        className="absolute inset-0 [clip-path:polygon(58%_0,100%_0,100%_100%,42%_100%)]"
      >
        <ThumbnailArt />
      </PaletteScope>
    </div>
  );
}

type Role = SyntaxColor | null;
/** A few lines that use every syntax role; the comment is the only translated part. */
function codeLines(comment: string): (readonly [string, Role])[][] {
  return [
    [[`// ${comment}`, 'comment']],
    [
      ['const', 'keyword'],
      [' ', null],
      ['max', 'variable'],
      [': ', null],
      ['Size', 'type'],
      [' = ', null],
      ['40', 'number'],
      [';', null],
    ],
    [
      ['if', 'keyword'],
      [' (', null],
      ['name', 'variable'],
      ['.', null],
      ['length', 'variable'],
      [' > ', null],
      ['max', 'variable'],
      [')', null],
    ],
    [
      ['  ', null],
      ['label', 'function'],
      ['(', null],
      ['name', 'variable'],
      [', ', null],
      ['"…"', 'string'],
      [', ', null],
      ['true', 'constant'],
      [');', null],
    ],
  ];
}

/** The prompt in ANSI blue and green, as most shells draw it. */
const PROMPT: readonly (readonly [string, number])[] = [
  ['~/notes', 4],
  [' $ ', 2],
];

/**
 * The editor's sample: the app in miniature, in the draft, which the root tokens hold while the
 * editor is open. The sidebar on the floor with its chosen row and a live mark, then the raised
 * work surface with body and secondary text, the four status hues and the emphasis by name, a
 * code block, the terminal's sixteen colors and a primary and a secondary button. The terminal
 * colors have no token, so they come in as values. It is one picture to assistive technology.
 */
export function ThemeSample({ terminal }: { terminal: readonly string[] }) {
  const t = useTranslations('Themes');
  const rows = [t('sampleRows.first'), t('sampleRows.second'), t('sampleRows.third')];
  const marks: [ReactNode, string, string][] = [
    [
      <CircleCheck key="success" aria-hidden className="size-3.5" />,
      'text-success',
      t('ui.success'),
    ],
    [
      <TriangleAlert key="warning" aria-hidden className="size-3.5" />,
      'text-warning',
      t('ui.warning'),
    ],
    [
      <CircleAlert key="error" aria-hidden className="size-3.5" />,
      'text-destructive',
      t('ui.error'),
    ],
    [<Info key="info" aria-hidden className="size-3.5" />, 'text-info', t('ui.info')],
  ];
  return (
    <figure
      role="img"
      aria-label={t('sample')}
      data-theme-sample
      className="m-0 flex min-w-0 overflow-hidden rounded-xl border border-border bg-surface-1"
    >
      {/* Nothing in the picture is a control: the buttons are drawn, not pressed. */}
      <div inert className="flex min-w-0 flex-1">
        <div className="flex w-[30%] max-w-36 shrink-0 flex-col gap-0.5 py-3 pr-1 pl-2">
          <div className="mb-2 flex h-5 items-center gap-1.5 px-1.5">
            <span className="size-3 shrink-0 rounded-sm bg-foreground" />
            <span className="h-1.5 w-9 rounded-full bg-muted-foreground" />
          </div>
          {rows.map((row, index) => (
            <div
              key={row}
              data-sample-selected={index === 1 || undefined}
              className={cn(
                'flex h-7 min-w-0 items-center gap-1.5 rounded-lg px-1.5 text-caption',
                index === 1 ? 'bg-selected text-foreground' : 'text-muted-foreground',
              )}
            >
              <span className="min-w-0 flex-1 truncate">{row}</span>
              {index === 2 ? <LiveDot live={false} /> : null}
            </div>
          ))}
        </div>
        <div className="my-1.5 mr-1.5 flex min-w-0 flex-1 flex-col gap-3 rounded-lg border border-border bg-surface-2 p-3">
          <div className="flex flex-col gap-0.5">
            <p className="m-0 text-body text-foreground">{t('sampleBody')}</p>
            <p className="m-0 text-caption text-muted-foreground">{t('sampleMuted')}</p>
          </div>
          <p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption">
            {marks.map(([icon, tone, word]) => (
              <span key={word} className={cn('inline-flex items-center gap-1', tone)}>
                {icon}
                {word}
              </span>
            ))}
            <span className="inline-flex items-center gap-1.5 text-emphasis">
              <LiveDot live={false} className="size-2" />
              {t('ui.emphasis')}
            </span>
          </p>
          <pre className="m-0 min-w-0 overflow-hidden rounded-lg border border-border bg-surface-1 px-2.5 py-2 font-mono text-caption whitespace-pre text-foreground">
            <code>
              {codeLines(t('sampleComment')).map((line, row) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: The sample's lines never move.
                <span key={row} className="block">
                  {line.map(([text, role], index) => (
                    <span
                      // biome-ignore lint/suspicious/noArrayIndexKey: The sample's tokens never move.
                      key={index}
                      style={role ? { color: `var(--syntax-${role})` } : undefined}
                    >
                      {text}
                    </span>
                  ))}
                </span>
              ))}
            </code>
          </pre>
          <div className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-border bg-surface-1 px-2.5 py-2 font-mono text-caption">
            <span className="whitespace-pre">
              {PROMPT.map(([text, index]) => (
                <span key={text} style={{ color: terminal[index] }}>
                  {text}
                </span>
              ))}
              <span className="text-foreground">colors</span>
            </span>
            {[0, 8].map((start) => (
              <span key={start} className="grid grid-cols-8 gap-1">
                {terminal.slice(start, start + 8).map((color, index) => (
                  <span
                    // biome-ignore lint/suspicious/noArrayIndexKey: ANSI colors are identified by position.
                    key={index}
                    data-terminal-color={start + index}
                    className="h-2.5 rounded-xs"
                    style={{ backgroundColor: color }}
                  />
                ))}
              </span>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="compact" tabIndex={-1}>
              {t('samplePrimary')}
            </Button>
            <Button size="compact" variant="secondary" tabIndex={-1}>
              {t('sampleSecondary')}
            </Button>
          </div>
        </div>
      </div>
    </figure>
  );
}

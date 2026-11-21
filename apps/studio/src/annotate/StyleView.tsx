// The style view beside the note (features/browser-annotate.md 스타일 바꿔 보기): the picked
// element's properties in their groups, each starting from its computed value; a value changes
// the element on the page at once, a changed row can be reset, and colour and length rows offer
// the page's own tokens. A narrow page area gets it as a bottom sheet under the note.
import {
  Button,
  ColorTile,
  Elevated,
  Input,
  Popover,
  PopoverPopup,
  PopoverTrigger,
  Select,
  SizeScope,
  Tooltip,
} from '@corral/react/design-kit';
import { ChevronDown, Undo2 } from '@corral/react/icons';
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import type { AnnotateTokens, StyleProperty } from '../../../desktop/src/annotate-bridge.ts';

export const STYLE_GROUPS: readonly {
  key: 'text' | 'color' | 'spacing' | 'layout';
  properties: readonly StyleProperty[];
}[] = [
  {
    key: 'text',
    properties: ['font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-align'],
  },
  {
    key: 'color',
    properties: [
      'color',
      'background-color',
      'border-color',
      'border-width',
      'border-style',
      'border-radius',
      'opacity',
    ],
  },
  { key: 'spacing', properties: ['margin', 'padding'] },
  { key: 'layout', properties: ['display', 'width', 'height', 'position'] },
];

/** The properties with set values: a list to choose from. */
const CHOICES: Partial<Record<StyleProperty, readonly string[]>> = {
  'font-weight': ['100', '200', '300', '400', '500', '600', '700', '800', '900'],
  'text-align': ['start', 'end', 'left', 'right', 'center', 'justify'],
  'border-style': [
    'none',
    'hidden',
    'dotted',
    'dashed',
    'solid',
    'double',
    'groove',
    'ridge',
    'inset',
    'outset',
  ],
  display: [
    'block',
    'inline',
    'inline-block',
    'flex',
    'inline-flex',
    'grid',
    'inline-grid',
    'flow-root',
    'contents',
    'none',
  ],
  position: ['static', 'relative', 'absolute', 'fixed', 'sticky'],
};

const COLORS: ReadonlySet<StyleProperty> = new Set(['color', 'background-color', 'border-color']);
const LENGTHS: ReadonlySet<StyleProperty> = new Set([
  'font-size',
  'line-height',
  'letter-spacing',
  'border-width',
  'border-radius',
  'margin',
  'padding',
  'width',
  'height',
]);

/**
 * A value as a swatch in the overlay. A page's own variable means nothing here (the overlay's
 * own tokens would answer it), so a token shows its value as the page reported it, and anything
 * else that leans on a variable shows no colour.
 */
function swatchOf(value: string, tokens: AnnotateTokens): string {
  const named = /^var\(\s*(--[\w-]+)\s*\)$/.exec(value.trim());
  const resolved = named
    ? (tokens.colors.find((token) => token.name === named[1])?.value ?? '')
    : value;
  return /var\(/i.test(resolved) ? 'transparent' : resolved || 'transparent';
}

export interface StyleRowView {
  value: string;
  /** Its value differs from the first one, or Corral's rule for it is on the page. */
  touched: boolean;
  /** Why the last value wasn't put on the page. */
  problem: string | null;
}

export function StyleView({
  id,
  label,
  place,
  tokens,
  rows,
  locked,
  onChange,
  onReset,
  onResetAll,
  onClose,
}: {
  id: string;
  label: string;
  place: { x: number; y: number; width: number; height: number; sheet: boolean };
  tokens: AnnotateTokens;
  rows: Record<StyleProperty, StyleRowView>;
  /** Sending, adding, or its answer was lost: nothing changes. */
  locked: boolean;
  onChange(property: StyleProperty, value: string): void;
  onReset(property: StyleProperty): void;
  onResetAll(): void;
  /** Escape: the view closes; what it put on the page stays. */
  onClose(): void;
}) {
  const t = useTranslations('Annotate.styleView');
  const view = useRef<HTMLElement>(null);
  const touched = Object.values(rows).some((row) => row.touched);

  // Into the view as it opens, unless the person has gone back to the note's text meanwhile.
  useEffect(() => {
    const from = document.activeElement;
    if (from && from !== document.body && !from.closest('[data-annotate="style-toggle"]')) return;
    view.current?.querySelector<HTMLElement>('input, [role="combobox"]')?.focus();
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // The kit's lists and popovers keep their own Escape; this one closes the view.
    if (event.key !== 'Escape' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };

  return (
    <section
      ref={view}
      id={id}
      data-annotate="style"
      data-sheet={place.sheet}
      aria-label={t('title', { label })}
      onKeyDown={onKeyDown}
      style={{
        left: `${place.x}px`,
        top: `${place.y}px`,
        width: `${place.width}px`,
        ...(place.sheet ? { height: `${place.height}px` } : { maxHeight: `${place.height}px` }),
      }}
      className={`absolute left-0 top-0 flex flex-col ${place.sheet ? 'annotate-sheet' : 'annotate-grow'}`}
    >
      {/* Its edge holds over any page, like the note's. */}
      <Elevated
        offset={2}
        className={`flex min-h-0 flex-1 flex-col text-body text-foreground ring-1 ring-border ${place.sheet ? 'rounded-t-xl' : 'rounded-xl'}`}
      >
        {/* The note's own controls are compact; its style view is a part of it. */}
        <SizeScope size="compact">
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain p-2">
            {STYLE_GROUPS.map((group) => (
              <Group key={group.key} title={t(`groups.${group.key}`)}>
                {group.properties.map((property) => (
                  <Row
                    key={property}
                    property={property}
                    row={rows[property]}
                    tokens={tokens}
                    locked={locked}
                    onChange={onChange}
                    onReset={onReset}
                  />
                ))}
              </Group>
            ))}
          </div>
          <div className="flex justify-end border-t border-border p-1.5">
            <Button variant="ghost" disabled={!touched || locked} onClick={onResetAll}>
              {t('resetAll')}
            </Button>
          </div>
        </SizeScope>
      </Elevated>
    </section>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  const heading = useId();
  return (
    <section aria-labelledby={heading} className="flex flex-col gap-1">
      <h3 id={heading} className="px-1 text-caption text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Row({
  property,
  row,
  tokens,
  locked,
  onChange,
  onReset,
}: {
  property: StyleProperty;
  row: StyleRowView;
  tokens: AnnotateTokens;
  locked: boolean;
  onChange(property: StyleProperty, value: string): void;
  onReset(property: StyleProperty): void;
}) {
  const t = useTranslations('Annotate.styleView');
  const field = useId();
  const changed = useId();
  const problem = useId();
  const choices = CHOICES[property];
  const color = COLORS.has(property);
  const list = color ? tokens.colors : LENGTHS.has(property) ? tokens.lengths : [];
  const described = [row.touched ? changed : '', row.problem ? problem : '']
    .filter(Boolean)
    .join(' ');
  return (
    <div className="grid grid-cols-[7.5rem_minmax(0,1fr)] items-center gap-x-2 gap-y-0.5 px-1">
      <span className="flex min-w-0 items-center gap-1.5">
        <span
          aria-hidden="true"
          className={`size-1.5 shrink-0 rounded-full ${row.touched ? 'bg-emphasis forced-colors:bg-[Highlight]' : ''}`}
        />
        {choices ? (
          <span className="truncate font-mono text-caption">{property}</span>
        ) : (
          <label htmlFor={field} className="truncate font-mono text-caption">
            {property}
          </label>
        )}
        {row.touched && (
          <span id={changed} className="sr-only">
            {t('changed')}
          </span>
        )}
      </span>
      <div className="flex min-w-0 items-center gap-0.5">
        {choices ? (
          <div className="min-w-0 flex-1">
            <Select
              label={property}
              describedBy={described || undefined}
              value={row.value}
              disabled={locked}
              options={[...new Set([...choices, row.value])].map((value) => ({
                value,
                label: value,
              }))}
              onValueChange={(value) => onChange(property, value)}
              className="w-full min-w-0"
            />
          </div>
        ) : (
          <Input
            id={field}
            font="mono"
            value={row.value}
            maxLength={200}
            disabled={locked}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={row.problem !== null || undefined}
            aria-describedby={described || undefined}
            onChange={(event) => onChange(property, event.currentTarget.value)}
            className="min-w-0 flex-1"
          />
        )}
        {/* After the value: its tokens, behind the colour's swatch or a chevron; every row's
            value starts and ends at the same edges, with or without them. */}
        {list.length > 0 ? (
          <Tokens
            property={property}
            tokens={list}
            swatches={color ? tokens : null}
            locked={locked}
            onPick={(name) => onChange(property, `var(${name})`)}
            trigger={color ? <Swatch color={swatchOf(row.value, tokens)} /> : <ChevronDown />}
          />
        ) : color ? (
          <span className="flex size-7 shrink-0 items-center justify-center">
            <Swatch color={swatchOf(row.value, tokens)} />
          </span>
        ) : (
          <span aria-hidden="true" className="size-7 shrink-0" />
        )}
        {row.touched ? (
          <Tooltip escapeThrough content={t('reset', { property })}>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('reset', { property })}
              disabled={locked}
              onClick={() => onReset(property)}
              className="text-muted-foreground"
            >
              <Undo2 />
            </Button>
          </Tooltip>
        ) : (
          // Its place stays, so the row's input doesn't move when it comes.
          <span aria-hidden="true" className="size-7 shrink-0" />
        )}
      </div>
      {row.problem && (
        <p id={problem} className="col-start-2 text-caption text-destructive">
          {row.problem}
        </p>
      )}
    </div>
  );
}

/** A colour as the overlay can show it, over a checker for a see-through one. */
function Swatch({ color }: { color: string }) {
  return (
    <span data-annotate="swatch" className="flex">
      <ColorTile color={color} size={18} />
    </span>
  );
}

/** The page's tokens of the row's kind, by name, with a search. */
function Tokens({
  property,
  tokens,
  swatches,
  locked,
  onPick,
  trigger,
}: {
  property: StyleProperty;
  tokens: readonly { name: string; value: string }[];
  /** A colour row's tokens show their colours. */
  swatches: AnnotateTokens | null;
  locked: boolean;
  onPick(name: string): void;
  trigger: ReactNode;
}) {
  const t = useTranslations('Annotate.styleView');
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const sorted = [...tokens].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? sorted.filter((token) => token.name.toLowerCase().includes(needle))
    : sorted;
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery('');
      }}
    >
      <Tooltip escapeThrough content={t('tokens', { property })}>
        <PopoverTrigger
          disabled={locked}
          aria-label={t('tokens', { property })}
          render={<Button variant="ghost" size="icon" className="text-muted-foreground" />}
        >
          {trigger}
        </PopoverTrigger>
      </Tooltip>
      <PopoverPopup
        width="sm"
        padding="compact"
        align="end"
        aria-label={t('tokens', { property })}
        className="ring-1 ring-border"
      >
        {/* The view's compact size reaches its popup through the portal. */}
        <div className="flex flex-col gap-1">
          <Input
            type="search"
            value={query}
            aria-label={t('searchTokens')}
            placeholder={t('searchTokens')}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
          {shown.length === 0 ? (
            <p className="px-2 py-1.5 text-caption text-muted-foreground">{t('noTokenMatch')}</p>
          ) : (
            <ul className="flex max-h-60 flex-col overflow-y-auto">
              {shown.map((token) => (
                <li key={token.name}>
                  <Button
                    variant="ghost"
                    data-annotate="token"
                    data-name={token.name}
                    aria-label={token.name}
                    onClick={() => {
                      onPick(token.name);
                      setOpen(false);
                      setQuery('');
                    }}
                    className="w-full min-w-0 justify-start gap-2"
                  >
                    {swatches && <ColorTile color={swatchOf(token.value, swatches)} size={14} />}
                    <bdi className="truncate font-mono text-caption">{token.name}</bdi>
                    <bdi className="ml-auto truncate font-mono text-caption text-muted-foreground">
                      {token.value}
                    </bdi>
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

import {
  Button,
  ColorField,
  ColorTile,
  cn,
  fontWeights,
  Input,
  LiveDot,
  Select,
  Tooltip,
} from '@corral/react/design-kit';
import { ArrowLeft, CircleAlert, CircleCheck, Info, TriangleAlert } from '@corral/react/icons';
import {
  type KeyboardEvent,
  type ReactNode,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import { useSettingsForm } from '../workbench/SettingsLifecycle.tsx';
import { chooseAppearance, endPreview, previewPalette } from '../workbench/themes/appearance.ts';
import { contrastRatio, isHexColor } from '../workbench/themes/color.ts';
import {
  PALETTE_NAME_MAX,
  type Palette,
  type PaletteBase,
  personalPaletteId,
  SYNTAX_COLORS,
  type SyntaxColor,
  UI_COLORS,
  type UiColor,
} from '../workbench/themes/palette.ts';
import {
  addPersonalTheme,
  personalThemes,
  type ThemeSaveError,
  updatePersonalTheme,
} from '../workbench/themes/storage.ts';
import { SettingsScroll } from './SettingsScroll.tsx';

/** What the editor opens on: a copy that is not saved yet, or a saved personal theme. */
export type ThemeEditorTarget =
  | { kind: 'new'; palette: Palette }
  | { kind: 'edit'; id: string; palette: Palette };

/** ANSI 0–15, by the names the catalog gives them. */
const ANSI = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] as const;

type AnsiIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15;
type ColorKey = `ui.${UiColor}` | `syntax.${SyntaxColor}` | `terminal.${AnsiIndex}`;
type Colors = Readonly<Record<ColorKey, string>>;

const GROUPS: readonly { id: 'ui' | 'syntax' | 'terminal'; keys: readonly ColorKey[] }[] = [
  { id: 'ui', keys: UI_COLORS.map((color) => `ui.${color}` as const) },
  { id: 'syntax', keys: SYNTAX_COLORS.map((color) => `syntax.${color}` as const) },
  { id: 'terminal', keys: ANSI.map((_, index) => `terminal.${index}` as ColorKey) },
];
const KEYS: readonly ColorKey[] = GROUPS.flatMap((group) => group.keys);

/** The UI colors drawn as text, whose contrast with the background the editor shows. */
const TEXT_COLORS: ReadonlySet<ColorKey> = new Set([
  'ui.foreground',
  'ui.muted',
  'ui.emphasis',
  'ui.error',
  'ui.success',
  'ui.warning',
  'ui.info',
]);
const LOW_CONTRAST = 4.5;
const HEX_FORMAT = '#rrggbb';

function colorsOf(palette: Palette): Colors {
  return Object.fromEntries([
    ...UI_COLORS.map((color) => [`ui.${color}`, palette.ui[color]]),
    ...SYNTAX_COLORS.map((color) => [`syntax.${color}`, palette.syntax[color]]),
    ...palette.terminal.map((color, index) => [`terminal.${index}`, color]),
  ]) as Colors;
}

function paletteOf(name: string, base: PaletteBase, colors: Colors): Palette {
  return {
    name,
    base,
    ui: Object.fromEntries(UI_COLORS.map((color) => [color, colors[`ui.${color}`]])) as Record<
      UiColor,
      string
    >,
    syntax: Object.fromEntries(
      SYNTAX_COLORS.map((color) => [color, colors[`syntax.${color}`]]),
    ) as Record<SyntaxColor, string>,
    terminal: ANSI.map((_, index) => colors[`terminal.${index as AnsiIndex}`]),
  };
}

function labelKey(key: ColorKey): string {
  const [group, color] = key.split('.') as [string, string];
  return group === 'terminal' ? `terminal.${ANSI[Number(color)]}` : key;
}

/**
 * The personal theme editor, in place of Settings › General while it is open
 * (docs/specs/features/themes.md, 개인 테마). Every change is drawn across the app at once as a
 * draft; nothing is stored until Save. Cancel, Escape, closing settings and leaving the section
 * all go through the settings dialog's unsaved-changes prompt when something changed, and the
 * draft never outlives the editor.
 */
export function ThemeEditor({
  target,
  onClose,
}: {
  target: ThemeEditorTarget;
  onClose: () => void;
}) {
  const t = useTranslations('Themes');
  const d = useTranslations('Desktop');
  const ids = useId();
  const fieldId = (key: ColorKey | 'name') => `${ids}-${key.replace('.', '-')}`;
  const titleId = `${ids}-title`;
  const initial = useMemo(() => colorsOf(target.palette), [target]);
  const [name, setName] = useState(target.palette.name);
  const [base, setBase] = useState<PaletteBase>(target.palette.base);
  const [colors, setColors] = useState<Colors>(initial);
  const [texts, setTexts] = useState<Colors>(initial);
  const [marked, setMarked] = useState<ReadonlySet<ColorKey>>(new Set());
  const [nameInvalid, setNameInvalid] = useState<'length' | 'taken' | null>(null);
  const [failure, setFailure] = useState<ThemeSaveError | null>(null);
  const savedId = useRef(target.kind === 'edit' ? target.id : null);
  const nameField = useRef<HTMLInputElement>(null);

  // The name is not part of what is drawn, so typing it never repaints the app.
  const preview = useMemo(
    () => paletteOf(target.palette.name, base, colors),
    [target.palette.name, base, colors],
  );
  useLayoutEffect(() => previewPalette(preview), [preview]);
  // Whatever closes the editor (save, cancel, leaving settings) takes the draft off the screen.
  useLayoutEffect(() => () => endPreview(), []);
  useLayoutEffect(() => nameField.current?.focus(), []);

  const dirty =
    name !== target.palette.name ||
    base !== target.palette.base ||
    KEYS.some((key) => colors[key] !== initial[key] || texts[key].toLowerCase() !== colors[key]);

  function persist(): boolean {
    const invalid = KEYS.filter((key) => !isHexColor(texts[key]));
    if (invalid.length) {
      setMarked(new Set(invalid));
      document.getElementById(fieldId(invalid[0] as ColorKey))?.focus();
      return false;
    }
    const trimmed = name.trim();
    const length = [...trimmed].length;
    if (length < 1 || length > PALETTE_NAME_MAX) {
      setNameInvalid('length');
      nameField.current?.focus();
      return false;
    }
    // Two personal themes with one name could not be told apart in the Appearance list.
    if (
      personalThemes
        .getState()
        .some((theme) => theme.id !== savedId.current && theme.palette.name === trimmed)
    ) {
      setNameInvalid('taken');
      nameField.current?.focus();
      return false;
    }
    const palette = paletteOf(trimmed, base, colors);
    const result = savedId.current
      ? updatePersonalTheme(savedId.current, palette)
      : addPersonalTheme(palette);
    if (!result.ok) {
      setFailure(result.error);
      return false;
    }
    savedId.current = result.theme.id;
    setFailure(null);
    // The draft gives way to the saved theme, which is now the applied one.
    endPreview();
    chooseAppearance(personalPaletteId(result.theme.id));
    return true;
  }

  const confirmLeave = useSettingsForm({ dirty, save: async () => persist() });
  async function cancel() {
    if (!(await confirmLeave())) return;
    endPreview();
    onClose();
  }

  function typeColor(key: ColorKey, text: string) {
    setTexts((previous) => ({ ...previous, [key]: text }));
    if (!isHexColor(text)) return;
    setColors((previous) => ({ ...previous, [key]: text.toLowerCase() }));
    unmark(key);
  }
  function pickColor(key: ColorKey, color: string) {
    setTexts((previous) => ({ ...previous, [key]: color }));
    setColors((previous) => ({ ...previous, [key]: color }));
    unmark(key);
  }
  function leaveColor(key: ColorKey) {
    const text = texts[key];
    if (isHexColor(text)) setTexts((previous) => ({ ...previous, [key]: text.toLowerCase() }));
    else setMarked((previous) => new Set(previous).add(key));
  }
  function unmark(key: ColorKey) {
    setMarked((previous) => {
      if (!previous.has(key)) return previous;
      const next = new Set(previous);
      next.delete(key);
      return next;
    });
  }

  function onEscape(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing) return;
    // A popup inside the editor closes itself first.
    if (
      event.target instanceof Element &&
      event.target.closest(
        '[data-slot="select-popup"], [data-slot="menu-popup"], [data-slot="popover-popup"]',
      )
    )
      return;
    event.preventDefault();
    // The settings dialog would close on the same key; this Escape belongs to the editor.
    event.stopPropagation();
    void cancel();
  }

  const background = colors['ui.background'];
  return (
    // Escape from any of the editor's controls cancels it, as its Cancel button does.
    <main
      data-theme-editor
      aria-labelledby={titleId}
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={onEscape}
    >
      <div className="mx-auto flex w-full max-w-5xl shrink-0 items-center gap-2 px-6 pb-3">
        <Tooltip content={t('cancel')}>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('cancel')}
            onClick={() => void cancel()}
          >
            <ArrowLeft />
          </Button>
        </Tooltip>
        <h3
          id={titleId}
          className="min-w-0 flex-1 text-subtitle text-foreground"
          style={{ fontVariationSettings: fontWeights.semibold }}
        >
          {t(target.kind === 'new' ? 'newTheme' : 'editTheme')}
        </h3>
        <Button
          onClick={() => {
            if (persist()) onClose();
          }}
        >
          {t('save')}
        </Button>
      </div>
      {failure ? (
        <p role="alert" className="mx-auto w-full max-w-5xl px-6 pb-3 text-body text-destructive">
          {failure === 'missing' ? t('saveMissing') : t('saveFailed')}
        </p>
      ) : null}
      <SettingsScroll className="min-h-0 flex-1">
        {/* The scroll area turns its direct child into a block on touch screens; the content
            keeps its own column below it. */}
        <div>
          <div className="settings-content">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex min-w-0 flex-col gap-1">
                <label htmlFor={fieldId('name')} className="text-body text-muted-foreground">
                  {t('name')}
                </label>
                <Input
                  ref={nameField}
                  id={fieldId('name')}
                  value={name}
                  aria-invalid={nameInvalid ? true : undefined}
                  aria-describedby={nameInvalid ? `${fieldId('name')}-error` : undefined}
                  onChange={(event) => {
                    setName(event.target.value);
                    setNameInvalid(null);
                  }}
                />
                {nameInvalid ? (
                  <p id={`${fieldId('name')}-error`} className="text-caption text-destructive">
                    {nameInvalid === 'taken'
                      ? t('nameTaken')
                      : t('nameInvalid', { max: PALETTE_NAME_MAX })}
                  </p>
                ) : null}
              </div>
              <div className="flex min-w-0 flex-col gap-1">
                <span aria-hidden className="text-body text-muted-foreground">
                  {t('base')}
                </span>
                <Select<PaletteBase>
                  label={t('base')}
                  value={base}
                  onValueChange={setBase}
                  className="w-full justify-between"
                  options={[
                    { value: 'light', label: d('light') },
                    { value: 'dark', label: d('dark') },
                  ]}
                />
              </div>
            </div>
            <ThemeSample palette={preview} />
            {GROUPS.map((group) => (
              <fieldset key={group.id} className="flex min-w-0 flex-col">
                <legend
                  className="mb-3 text-caption text-muted-foreground"
                  style={{ fontVariationSettings: fontWeights.semibold }}
                >
                  {t(`groups.${group.id}`)}
                </legend>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-x-4 gap-y-3">
                  {group.keys.map((key) => (
                    <ColorRow
                      key={key}
                      id={fieldId(key)}
                      label={t(labelKey(key))}
                      text={texts[key]}
                      color={colors[key]}
                      invalid={marked.has(key)}
                      contrast={
                        TEXT_COLORS.has(key) ? contrastRatio(colors[key], background) : undefined
                      }
                      onText={(text) => typeColor(key, text)}
                      onPick={(color) => pickColor(key, color)}
                      onLeave={() => leaveColor(key)}
                    />
                  ))}
                </div>
              </fieldset>
            ))}
          </div>
        </div>
      </SettingsScroll>
    </main>
  );
}

function ColorRow({
  id,
  label,
  text,
  color,
  invalid,
  contrast,
  onText,
  onPick,
  onLeave,
}: {
  id: string;
  label: string;
  text: string;
  color: string;
  invalid: boolean;
  contrast: number | undefined;
  onText: (text: string) => void;
  onPick: (color: string) => void;
  onLeave: () => void;
}) {
  const t = useTranslations('Themes');
  const format = useFormatter();
  const described = [invalid ? `${id}-error` : null, contrast === undefined ? null : `${id}-ratio`]
    .filter(Boolean)
    .join(' ');
  // Shown down to the tenth, never rounded up past the 4.5:1 line.
  const ratio = contrast === undefined ? 0 : Math.floor(contrast * 10) / 10;
  const low = contrast !== undefined && contrast < LOW_CONTRAST;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-2">
        <label htmlFor={id} className="text-body text-muted-foreground">
          {label}
        </label>
        {contrast === undefined ? null : (
          <span
            id={`${id}-ratio`}
            data-low-contrast={low || undefined}
            // A low mark stays readable even when the color being judged is the secondary text.
            className={cn(
              'inline-flex items-center gap-1 text-caption tabular-nums',
              low ? 'text-foreground' : 'text-muted-foreground',
            )}
          >
            <span className="sr-only">{t('contrast')}</span>
            {low ? <TriangleAlert aria-hidden className="size-3 text-warning" /> : null}
            {t('ratio', {
              ratio: format.number(ratio, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
            })}
            {low ? <span>{t('low')}</span> : null}
          </span>
        )}
      </div>
      <ColorField
        id={id}
        text={text}
        color={color}
        invalid={invalid}
        pickerLabel={t('pick', { name: label })}
        describedBy={described || undefined}
        onTextChange={onText}
        onColorChange={onPick}
        onBlur={onLeave}
      />
      {invalid ? (
        <p id={`${id}-error`} className="text-caption text-destructive">
          {t('hexInvalid', { format: HEX_FORMAT })}
        </p>
      ) : null}
    </div>
  );
}

type Role = SyntaxColor | null;
/** A few lines that use every syntax role; the comment is the only translated part. */
function codeLines(comment: string): (readonly [string, Role])[][] {
  return [
    [
      ['// ', 'comment'],
      [comment, 'comment'],
    ],
    [
      ['const', 'keyword'],
      [' ', null],
      ['limit', 'variable'],
      [' = ', null],
      ['40', 'number'],
      [', ', null],
      ['strict', 'variable'],
      [' = ', null],
      ['true', 'constant'],
      [';', null],
    ],
    [
      ['function', 'keyword'],
      [' ', null],
      ['label', 'function'],
      ['(', null],
      ['name', 'variable'],
      [': ', null],
      ['string', 'type'],
      [') {', null],
    ],
    [
      ['  ', null],
      ['return', 'keyword'],
      [' ', null],
      ['name', 'variable'],
      ['.', null],
      ['slice', 'function'],
      ['(', null],
      ['0', 'number'],
      [', ', null],
      ['limit', 'variable'],
      [') || ', null],
      ['"-"', 'string'],
      [';', null],
    ],
    [['}', null]],
  ];
}

/**
 * The draft on the floor it will sit on: body and secondary text, the four status marks and the
 * emphasis, code in the syntax colors and the sixteen terminal colors. It reads the root tokens,
 * which hold the draft while the editor is open; the terminal colors have no token.
 */
function ThemeSample({ palette }: { palette: Palette }) {
  const t = useTranslations('Themes');
  const marks: [ReactNode, string][] = [
    [<CircleAlert key="error" aria-hidden className="size-4" />, 'text-destructive'],
    [<CircleCheck key="success" aria-hidden className="size-4" />, 'text-success'],
    [<TriangleAlert key="warning" aria-hidden className="size-4" />, 'text-warning'],
    [<Info key="info" aria-hidden className="size-4" />, 'text-info'],
    [<LiveDot key="emphasis" live={false} className="size-2" />, 'text-emphasis'],
  ];
  return (
    <figure
      role="img"
      aria-label={t('sample')}
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-surface-1 p-4"
    >
      <p className="text-body text-foreground">{t('sampleBody')}</p>
      <p className="text-body text-muted-foreground">{t('sampleMuted')}</p>
      <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-body">
        {marks.map(([mark, tone], index) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: A fixed list of five marks.
            key={index}
            className={cn('inline-flex items-center gap-1', tone)}
          >
            {mark}
            Aa
          </span>
        ))}
      </p>
      <pre className="min-w-0 font-mono text-caption whitespace-pre-wrap text-foreground">
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
      <div className="grid grid-cols-8 gap-1">
        {palette.terminal.map((color, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: ANSI colors are identified by position.
          <span key={index} data-terminal-color={index} className="flex">
            <ColorTile color={color} style={{ width: '100%', height: 16 }} />
          </span>
        ))}
      </div>
    </figure>
  );
}

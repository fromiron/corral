import {
  Button,
  ColorPickerPopover,
  type ColorPickerSwatch,
  ColorTile,
  cn,
  focusRing,
  fontWeights,
  Input,
  Select,
  Tooltip,
} from '@corral/react/design-kit';
import { ArrowLeft, TriangleAlert } from '@corral/react/icons';
import {
  type ComponentProps,
  type KeyboardEvent,
  type ReactElement,
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
import { contrastRatio } from '../workbench/themes/color.ts';
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
import { legibleText } from '../workbench/themes/tokens.ts';
import { SettingsScroll } from './SettingsScroll.tsx';
import { ThemeSample } from './ThemePreview.tsx';

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

const UI_KEYS: readonly ColorKey[] = UI_COLORS.map((color) => `ui.${color}` as const);
const SYNTAX_KEYS: readonly ColorKey[] = SYNTAX_COLORS.map((color) => `syntax.${color}` as const);
const TERMINAL_KEYS: readonly ColorKey[] = ANSI.map((_, index) => `terminal.${index}` as ColorKey);
const KEYS: readonly ColorKey[] = [...UI_KEYS, ...SYNTAX_KEYS, ...TERMINAL_KEYS];

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
 * (docs/specs/features/themes.md, 개인 테마). The sample of the app in the draft sits beside the
 * colors (above them on a narrow screen); each color is a tile that opens the kit color picker.
 * Every change is drawn across the app at once as a draft; nothing is stored until Save. Cancel,
 * Escape, closing settings and leaving the section all go through the settings dialog's
 * unsaved-changes prompt when something changed, and the draft never outlives the editor.
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
  const format = useFormatter();
  const ids = useId();
  const fieldId = (key: ColorKey | 'name') => `${ids}-${key.replace('.', '-')}`;
  const titleId = `${ids}-title`;
  const initial = useMemo(() => colorsOf(target.palette), [target]);
  const [name, setName] = useState(target.palette.name);
  const [base, setBase] = useState<PaletteBase>(target.palette.base);
  const [colors, setColors] = useState<Colors>(initial);
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
    KEYS.some((key) => colors[key] !== initial[key]);

  function persist(): boolean {
    const trimmed = name.trim();
    const length = [...trimmed].length;
    if (length < 1 || length > PALETTE_NAME_MAX) {
      setNameInvalid('length');
      nameField.current?.focus();
      return false;
    }
    // Two personal themes with one name could not be told apart in the Appearance gallery.
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

  function onEscape(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing) return;
    // A popup inside the editor closes itself first.
    if (
      event.target instanceof Element &&
      event.target.closest(
        '[data-slot="select-popup"], [data-slot="menu-popup"], [data-slot="popover-popup"], [data-slot="color-picker-popup"]',
      )
    )
      return;
    event.preventDefault();
    // The settings dialog would close on the same key; this Escape belongs to the editor.
    event.stopPropagation();
    void cancel();
  }

  const label = (key: ColorKey) => t(labelKey(key));
  // Every color of the draft once, so a related color is one press away in any picker.
  const swatches = useMemo<ColorPickerSwatch[]>(() => {
    const seen = new Set<string>();
    return KEYS.flatMap((key) => {
      const color = colors[key];
      if (seen.has(color)) return [];
      seen.add(color);
      return [{ color, label: t(labelKey(key)) }];
    });
  }, [colors, t]);
  const pickerLabels = {
    area: t('area'),
    hue: t('hue'),
    hex: t('hex'),
    eyedropper: t('eyedropper'),
    invalid: t('hexInvalid', { format: HEX_FORMAT }),
  };
  // Marks that judge the draft are drawn in a color that reads on it, whatever it is.
  const legible = useMemo(() => legibleText(preview), [preview]);
  const background = colors['ui.background'];
  const contrastOf = (key: ColorKey) =>
    TEXT_COLORS.has(key) ? contrastRatio(colors[key], background) : undefined;
  // Shown down to the tenth, never rounded up past the 4.5:1 line.
  const ratio = (contrast: number) =>
    t('ratio', {
      ratio: format.number(Math.floor(contrast * 10) / 10, {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      }),
    });

  function picker(key: ColorKey, trigger: ReactElement) {
    const contrast = contrastOf(key);
    return (
      <ColorPickerPopover
        key={key}
        trigger={trigger}
        popupLabel={label(key)}
        value={colors[key]}
        onValueChange={(hex) =>
          setColors((previous) =>
            previous[key] === hex.toLowerCase()
              ? previous
              : { ...previous, [key]: hex.toLowerCase() },
          )
        }
        swatches={swatches}
        labels={pickerLabels}
      >
        {contrast === undefined ? null : (
          <p
            data-contrast
            className="m-0 flex min-h-7 flex-wrap items-center gap-x-2 gap-y-1 text-caption"
            style={{ color: legible }}
          >
            {/* The color as text on the background, which is what the ratio judges. */}
            <span
              aria-hidden
              className="inline-flex h-6 items-center rounded-md border border-border px-1.5 text-body"
              style={{
                backgroundColor: background,
                color: colors[key],
                fontVariationSettings: fontWeights.semibold,
              }}
            >
              Aa
            </span>
            <span>{t('contrast')}</span>
            <span className="tabular-nums">{ratio(contrast)}</span>
            {contrast < LOW_CONTRAST ? (
              <span className="inline-flex items-center gap-1">
                <TriangleAlert aria-hidden className="size-3" />
                {t('low')}
              </span>
            ) : null}
          </p>
        )}
      </ColorPickerPopover>
    );
  }

  function chip(key: ColorKey) {
    const contrast = contrastOf(key);
    const low = contrast !== undefined && contrast < LOW_CONTRAST;
    const id = fieldId(key);
    return picker(
      key,
      <ColorChip
        data-color-tile={key}
        name={label(key)}
        color={colors[key]}
        valueId={`${id}-value`}
        mark={
          low ? (
            <span
              id={`${id}-contrast`}
              data-low-contrast
              className="inline-flex items-center gap-1 text-caption"
              style={{ color: legible }}
            >
              <TriangleAlert aria-hidden className="size-3 shrink-0" />
              <span className="tabular-nums">{ratio(contrast)}</span>
              <span>{t('low')}</span>
            </span>
          ) : undefined
        }
        aria-describedby={low ? `${id}-value ${id}-contrast` : `${id}-value`}
      />,
    );
  }

  return (
    // Escape from any of the editor's controls cancels it, as its back button does.
    <main
      data-theme-editor
      aria-labelledby={titleId}
      className="@container/editor flex min-h-0 flex-1 flex-col"
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
            <div className="grid gap-6 @min-[40rem]/editor:grid-cols-[minmax(0,8fr)_minmax(0,7fr)] @min-[40rem]/editor:items-start">
              {/* The theme's name and base over its sample, which stays in view beside the
                  colors while they scroll. */}
              <div className="flex min-w-0 flex-col gap-4 @min-[40rem]/editor:sticky @min-[40rem]/editor:top-0">
                <div className="flex flex-wrap items-start gap-3">
                  <div className="flex min-w-0 flex-1 basis-40 flex-col gap-1">
                    <label htmlFor={fieldId('name')} className="text-caption text-muted-foreground">
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
                      <p
                        id={`${fieldId('name')}-error`}
                        className="m-0 text-caption text-destructive"
                      >
                        {nameInvalid === 'taken'
                          ? t('nameTaken')
                          : t('nameInvalid', { max: PALETTE_NAME_MAX })}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 flex-col gap-1">
                    <span aria-hidden className="text-caption text-muted-foreground">
                      {t('base')}
                    </span>
                    <Select<PaletteBase>
                      label={t('base')}
                      value={base}
                      onValueChange={setBase}
                      options={[
                        { value: 'light', label: d('light') },
                        { value: 'dark', label: d('dark') },
                      ]}
                    />
                  </div>
                </div>
                <ThemeSample terminal={preview.terminal} />
              </div>
              <div className="flex min-w-0 flex-col gap-6">
                <ColorGroup id={`${ids}-ui`} label={t('groups.ui')}>
                  <div className="-mx-1.5 grid grid-cols-[repeat(auto-fill,minmax(min(9.5rem,100%),1fr))] gap-1">
                    {UI_KEYS.map(chip)}
                  </div>
                </ColorGroup>
                <ColorGroup id={`${ids}-syntax`} label={t('groups.syntax')}>
                  <div className="-mx-1.5 grid grid-cols-[repeat(auto-fill,minmax(min(9.5rem,100%),1fr))] gap-1">
                    {SYNTAX_KEYS.map(chip)}
                  </div>
                </ColorGroup>
                <ColorGroup id={`${ids}-terminal`} label={t('groups.terminal')}>
                  {/* The eight colors, then their bright forms under them. */}
                  {[0, 8].map((start) => (
                    <div
                      key={start}
                      data-terminal-row={start === 0 ? 'normal' : 'bright'}
                      className="-mx-1.5 grid grid-cols-8 gap-1"
                    >
                      {TERMINAL_KEYS.slice(start, start + 8).map((key) =>
                        picker(
                          key,
                          <TerminalChip
                            data-color-tile={key}
                            name={label(key)}
                            color={colors[key]}
                            valueId={`${fieldId(key)}-value`}
                            aria-describedby={`${fieldId(key)}-value`}
                          />,
                        ),
                      )}
                    </div>
                  ))}
                </ColorGroup>
              </div>
            </div>
          </div>
        </div>
      </SettingsScroll>
    </main>
  );
}

function ColorGroup({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: The tiles are buttons, not form fields.
    <div role="group" aria-labelledby={id} className="flex min-w-0 flex-col gap-1">
      <h4
        id={id}
        className="m-0 pb-1 text-caption text-muted-foreground"
        style={{ fontVariationSettings: fontWeights.semibold }}
      >
        {label}
      </h4>
      {children}
    </div>
  );
}

type ChipProps = ComponentProps<'button'> & {
  name: string;
  color: string;
  /** The id of the value's text, which the chip's description reads. */
  valueId: string;
};

/**
 * One color: its swatch, its name and its value, pressed to open the picker (the popover trigger
 * props arrive through `props`). A low contrast mark sits under the value.
 */
function ColorChip({
  name,
  color,
  valueId,
  mark,
  className,
  ...props
}: ChipProps & { mark?: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={name}
      {...props}
      className={cn(
        'flex min-w-0 cursor-pointer items-center gap-2.5 rounded-xl p-1.5 text-left transition-colors duration-(--duration-fast) hover:bg-hover data-[popup-open]:bg-hover',
        focusRing,
        className,
      )}
    >
      <ColorTile color={color} size={32} />
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-body text-foreground">{name}</span>
        <span id={valueId} className="text-caption text-muted-foreground tabular-nums uppercase">
          {color}
        </span>
        {mark}
      </span>
    </button>
  );
}

/** A terminal color: a swatch alone, named by its tooltip and its accessible name. */
function TerminalChip({ name, color, valueId, className, ...props }: ChipProps) {
  return (
    <Tooltip content={name}>
      <button
        type="button"
        aria-label={name}
        {...props}
        className={cn(
          'flex min-w-0 cursor-pointer rounded-xl p-1.5 transition-colors duration-(--duration-fast) hover:bg-hover data-[popup-open]:bg-hover',
          focusRing,
          className,
        )}
      >
        <ColorTile color={color} style={{ width: '100%', height: 'auto', aspectRatio: '1' }} />
        <span id={valueId} className="sr-only">
          {color}
        </span>
      </button>
    </Tooltip>
  );
}

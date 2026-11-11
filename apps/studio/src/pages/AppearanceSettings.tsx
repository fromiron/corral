import {
  Button,
  Dialog,
  DialogDescription,
  DialogPopup,
  DialogTitle,
  fontWeights,
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
  PreviewCard,
  PreviewCardButton,
  PreviewCardGrid,
  PreviewCardGroup,
} from '@corral/react/design-kit';
import { Ellipsis, Plus } from '@corral/react/icons';
import { type ReactNode, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { usePreferences } from '../workbench/preferences.ts';
import {
  type Appearance,
  appearanceOf,
  appliedAppearance,
  applyAppearance,
  chooseAppearance,
  deletePersonalTheme,
} from '../workbench/themes/appearance.ts';
import { BUILTIN_THEMES } from '../workbench/themes/builtin.ts';
import { defaultPalette } from '../workbench/themes/default.ts';
import { serializeTheme, themeFileName } from '../workbench/themes/json.ts';
import {
  builtinPaletteId,
  PALETTE_NAME_MAX,
  type Palette,
  personalPaletteId,
  TERMINAL_COLOR_COUNT,
} from '../workbench/themes/palette.ts';
import {
  importPersonalTheme,
  numberedName,
  PERSONAL_THEME_LIMIT,
  type PersonalTheme,
  type ThemeSaveError,
  usePersonalThemes,
} from '../workbench/themes/storage.ts';
import type { ThemeEditorTarget } from './ThemeEditor.tsx';
import { SystemThumbnail, ThemeThumbnail } from './ThemePreview.tsx';

/** Where focus lands when the gallery is shown again: the New theme tile, or a personal card. */
export type ThemeListFocus = { kind: 'new' } | { kind: 'card'; id: string };

type ImportError = ThemeSaveError | 'unreadable';

const DEFAULTS = ['system', 'light', 'dark'] as const;

function download(palette: Palette) {
  const url = URL.createObjectURL(
    new Blob([serializeTheme(palette)], { type: 'application/json' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = themeFileName(palette.name);
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A group's name inside the gallery (the kit's section label, one level under Appearance). */
function GroupLabel({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h4
      id={id}
      className="m-0 text-caption text-muted-foreground"
      style={{ fontVariationSettings: fontWeights.semibold }}
    >
      {children}
    </h4>
  );
}

/**
 * Settings › General's Appearance: one choice among cards, each a picture of the app in that
 * theme (docs/specs/features/themes.md). System, light and dark come first, then the built-in
 * themes, then this device's personal themes, which carry a menu (edit, export, delete) and end
 * with the New theme tile; Import sits beside their label. Editing opens the editor in place of
 * General.
 */
export function AppearanceSettings({
  onEdit,
  focus,
  onFocused,
}: {
  onEdit: (target: ThemeEditorTarget, opener: ThemeListFocus) => void;
  /** Focus to restore once the gallery is back (the editor's opener). */
  focus?: ThemeListFocus | null;
  onFocused?: () => void;
}) {
  const t = useTranslations('Desktop');
  const tt = useTranslations('Themes');
  const prefs = usePreferences();
  const personal = usePersonalThemes();
  const ids = useId();
  const gallery = useRef<HTMLElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const [pendingFocus, setPendingFocus] = useState<ThemeListFocus | null>(focus ?? null);
  const [importError, setImportError] = useState<ImportError | null>(null);
  const [deleting, setDeleting] = useState<PersonalTheme | null>(null);
  const [deleteFailed, setDeleteFailed] = useState(false);
  const afterDelete = useRef<ThemeListFocus | null>(null);
  const full = personal.length >= PERSONAL_THEME_LIMIT;
  const headingId = `${ids}-appearance`;
  const builtinId = `${ids}-builtin`;
  const personalId = `${ids}-personal`;
  const limitId = `${ids}-limit`;
  const errorId = `${ids}-import-error`;
  const values = useMemo(
    () => [
      ...DEFAULTS,
      ...BUILTIN_THEMES.map((theme) => builtinPaletteId(theme.id)),
      ...personal.map((theme) => personalPaletteId(theme.id)),
    ],
    [personal],
  );
  const firstPersonal = DEFAULTS.length + BUILTIN_THEMES.length;

  const target = (where: ThemeListFocus) =>
    gallery.current?.querySelector<HTMLElement>(
      where.kind === 'card'
        ? `[data-preview-card-radio][data-value="${personalPaletteId(where.id)}"]`
        : '[data-theme-new]',
    ) ?? gallery.current?.querySelector<HTMLElement>('[data-theme-new]');

  // biome-ignore lint/correctness/useExhaustiveDependencies: Runs once per focus request; the lookup and callback read the current render.
  useLayoutEffect(() => {
    if (!pendingFocus) return;
    const element = target(pendingFocus);
    element?.focus();
    setPendingFocus(null);
    onFocused?.();
    // A dialog or menu that just closed hands focus back once it is gone; take it again if it
    // went nowhere (its opener left with the editor or the deleted card).
    setTimeout(() => {
      const active = document.activeElement;
      if (element?.isConnected && (!active || active === document.body)) element.focus();
    }, 0);
  }, [pendingFocus]);

  function newTheme() {
    if (full) return;
    setImportError(null);
    const { palette, dark } = appliedAppearance.getState();
    const sourceName = palette?.name ?? t(dark ? 'dark' : 'light');
    const source = palette ?? defaultPalette(sourceName, dark ? 'dark' : 'light');
    // Never the source's own name, nor one the Appearance choice already shows.
    const taken = [
      sourceName,
      t('system'),
      t('light'),
      t('dark'),
      ...BUILTIN_THEMES.map((theme) => theme.palette.name),
      ...personal.map((theme) => theme.palette.name),
    ];
    onEdit(
      { kind: 'new', palette: { ...source, name: numberedName(sourceName, taken) } },
      { kind: 'new' },
    );
  }

  async function importFile(chosen: File) {
    setImportError(null);
    let result: Awaited<ReturnType<typeof importPersonalTheme>>;
    try {
      result = await importPersonalTheme(chosen);
    } catch {
      setImportError('unreadable');
      return;
    }
    if (!result.ok) setImportError(result.error);
    else setPendingFocus({ kind: 'card', id: result.theme.id });
  }

  function remove(theme: PersonalTheme) {
    const index = personal.findIndex((each) => each.id === theme.id);
    const neighbour = personal[index + 1] ?? personal[index - 1];
    const result = deletePersonalTheme(theme.id);
    if (!result.ok && result.error === 'storage') {
      setDeleteFailed(true);
      return;
    }
    // Back to the light or dark of its base at once, wherever settings was opened.
    applyAppearance();
    afterDelete.current = neighbour ? { kind: 'card', id: neighbour.id } : { kind: 'new' };
    setPendingFocus(afterDelete.current);
    setDeleting(null);
  }

  const importDescription = [full ? limitId : null, importError ? errorId : null]
    .filter(Boolean)
    .join(' ');
  return (
    <>
      <section
        ref={gallery}
        data-appearance
        aria-labelledby={headingId}
        className="flex flex-col gap-4 border-b border-border pt-1 pb-6"
      >
        <h3 id={headingId} className="m-0 text-body text-foreground">
          {t('appearance')}
        </h3>
        <PreviewCardGroup
          value={appearanceOf(prefs)}
          values={values}
          onValueChange={(choice) => chooseAppearance(choice as Appearance)}
          aria-labelledby={headingId}
          className="-mx-1 gap-6"
        >
          <PreviewCardGrid>
            {DEFAULTS.map((choice, index) => (
              <PreviewCard
                key={choice}
                index={index}
                value={choice}
                label={t(choice)}
                preview={
                  choice === 'system' ? (
                    <SystemThumbnail />
                  ) : (
                    <ThemeThumbnail palette={null} base={choice} />
                  )
                }
              />
            ))}
          </PreviewCardGrid>
          {/* biome-ignore lint/a11y/useSemanticElements: A fieldset cannot sit inside the radio group's element. */}
          <div role="group" aria-labelledby={builtinId} className="flex flex-col gap-2">
            <div className="flex min-h-7 items-center px-1">
              <GroupLabel id={builtinId}>{t('builtinThemes')}</GroupLabel>
            </div>
            <PreviewCardGrid>
              {BUILTIN_THEMES.map((theme, index) => (
                <PreviewCard
                  key={theme.id}
                  index={DEFAULTS.length + index}
                  value={builtinPaletteId(theme.id)}
                  // Theme names are proper names, shown as they are in every language.
                  label={theme.palette.name}
                  preview={<ThemeThumbnail palette={theme.palette} base={theme.palette.base} />}
                />
              ))}
            </PreviewCardGrid>
          </div>
          {/* biome-ignore lint/a11y/useSemanticElements: A fieldset cannot sit inside the radio group's element. */}
          <div
            role="group"
            aria-labelledby={personalId}
            data-personal-themes
            className="flex flex-col gap-2"
          >
            <div className="flex min-h-7 flex-wrap items-center justify-between gap-x-4 gap-y-1 px-1">
              <GroupLabel id={personalId}>{t('personalThemes')}</GroupLabel>
              <Button
                variant="ghost"
                size="compact"
                aria-disabled={full || undefined}
                aria-describedby={importDescription || undefined}
                className="-mr-1 aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
                onClick={() => {
                  if (!full) file.current?.click();
                }}
              >
                {tt('import')}
              </Button>
              <input
                ref={file}
                type="file"
                accept=".json,application/json"
                hidden
                tabIndex={-1}
                onChange={(event) => {
                  const chosen = event.target.files?.[0];
                  event.target.value = '';
                  if (chosen) void importFile(chosen);
                }}
              />
            </div>
            {importError ? (
              <p id={errorId} role="alert" className="m-0 px-1 text-body text-destructive">
                {importReason(tt, importError)}
              </p>
            ) : null}
            <PreviewCardGrid>
              {personal.map((theme, index) => (
                <PreviewCard
                  key={theme.id}
                  index={firstPersonal + index}
                  value={personalPaletteId(theme.id)}
                  label={theme.palette.name}
                  preview={<ThemeThumbnail palette={theme.palette} base={theme.palette.base} />}
                  action={
                    <Menu>
                      <MenuTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon-compact"
                            aria-label={tt('actionsNamed', { name: theme.palette.name })}
                          />
                        }
                      >
                        <Ellipsis />
                      </MenuTrigger>
                      <MenuPopup align="end" className="w-44">
                        <MenuItem
                          onClick={() => {
                            setImportError(null);
                            onEdit(
                              { kind: 'edit', id: theme.id, palette: theme.palette },
                              { kind: 'card', id: theme.id },
                            );
                          }}
                        >
                          {tt('edit')}
                        </MenuItem>
                        <MenuItem onClick={() => download(theme.palette)}>{tt('export')}</MenuItem>
                        <MenuSeparator />
                        <MenuItem
                          onClick={() => {
                            afterDelete.current = null;
                            setDeleteFailed(false);
                            setDeleting(theme);
                          }}
                        >
                          {tt('delete')}
                        </MenuItem>
                      </MenuPopup>
                    </Menu>
                  }
                />
              ))}
              <PreviewCardButton
                index={firstPersonal + personal.length}
                data-theme-new
                label={tt('newTheme')}
                // At the cap the tile says why, where a new theme would have gone.
                icon={
                  full ? (
                    <span
                      id={limitId}
                      className="px-3 text-center text-caption text-muted-foreground"
                    >
                      {tt('limit', { limit: PERSONAL_THEME_LIMIT })}
                    </span>
                  ) : (
                    <Plus aria-hidden className="size-5" strokeWidth={1.5} />
                  )
                }
                aria-disabled={full || undefined}
                aria-describedby={full ? limitId : undefined}
                onClick={newTheme}
              />
            </PreviewCardGrid>
          </div>
        </PreviewCardGroup>
      </section>
      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      >
        <DialogPopup
          className="flex flex-col gap-4 p-6"
          showCloseButton={false}
          bottomStickOnMobile={false}
          finalFocus={() => (afterDelete.current ? (target(afterDelete.current) ?? true) : true)}
        >
          <DialogTitle>{tt('deleteTitle', { name: deleting?.palette.name ?? '' })}</DialogTitle>
          <DialogDescription>{tt('deleteBody')}</DialogDescription>
          {deleteFailed ? (
            <p role="alert" className="text-body text-destructive">
              {tt('deleteFailed')}
            </p>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="tertiary" onClick={() => setDeleting(null)}>
              {tt('cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (deleting) remove(deleting);
              }}
            >
              {tt('delete')}
            </Button>
          </div>
        </DialogPopup>
      </Dialog>
    </>
  );
}

/** The kind of problem, never the file's own text. */
function importReason(t: ReturnType<typeof useTranslations>, error: ImportError): string {
  switch (error) {
    case 'too-large':
      return t('importError.too-large');
    case 'fields':
      return t('importError.fields');
    case 'name':
      return t('importError.name', { max: PALETTE_NAME_MAX });
    case 'base':
      return t('importError.base', { light: 'light', dark: 'dark' });
    case 'color':
      return t('importError.color', { format: '#rrggbb' });
    case 'terminal':
      return t('importError.terminal', { count: TERMINAL_COLOR_COUNT });
    case 'limit':
      return t('importError.limit', { limit: PERSONAL_THEME_LIMIT });
    case 'storage':
      return t('importError.storage');
    case 'unreadable':
      return t('importError.unreadable');
    default:
      // not-json, not-object, version (and an id that went missing, which a file cannot cause).
      return t('importError.not-theme');
  }
}

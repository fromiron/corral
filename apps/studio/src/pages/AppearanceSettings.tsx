import {
  Button,
  Dialog,
  DialogDescription,
  DialogPopup,
  DialogTitle,
  Select,
  Tooltip,
} from '@corral/react/design-kit';
import { Download, Pencil, Trash2 } from '@corral/react/icons';
import { useId, useLayoutEffect, useRef, useState } from 'react';
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

/** Where focus lands when the list is shown again: New theme, or a row's Edit. */
export type ThemeListFocus = { kind: 'new' } | { kind: 'row'; id: string };

type ImportError = ThemeSaveError | 'unreadable';

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

/**
 * Settings › General's Appearance choice and, under it, the personal themes of this device
 * (docs/specs/features/themes.md, 개인 테마): New theme and Import in the list head, then a row
 * per theme with edit, export and delete. Editing opens the editor in place of General.
 */
export function AppearanceSettings({
  onEdit,
  focus,
  onFocused,
}: {
  onEdit: (target: ThemeEditorTarget, opener: ThemeListFocus) => void;
  /** Focus to restore once the list is back (the editor's opener). */
  focus?: ThemeListFocus | null;
  onFocused?: () => void;
}) {
  const t = useTranslations('Desktop');
  const tt = useTranslations('Themes');
  const prefs = usePreferences();
  const personal = usePersonalThemes();
  const ids = useId();
  const list = useRef<HTMLElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const [pendingFocus, setPendingFocus] = useState<ThemeListFocus | null>(focus ?? null);
  const [importError, setImportError] = useState<ImportError | null>(null);
  const [deleting, setDeleting] = useState<PersonalTheme | null>(null);
  const [deleteFailed, setDeleteFailed] = useState(false);
  const afterDelete = useRef<ThemeListFocus | null>(null);
  const full = personal.length >= PERSONAL_THEME_LIMIT;
  const limitId = `${ids}-limit`;
  const errorId = `${ids}-import-error`;

  const target = (where: ThemeListFocus) =>
    list.current?.querySelector<HTMLElement>(
      where.kind === 'row' ? `[data-theme-edit="${where.id}"]` : '[data-theme-new]',
    ) ?? list.current?.querySelector<HTMLElement>('[data-theme-new]');

  // biome-ignore lint/correctness/useExhaustiveDependencies: Runs once per focus request; the lookup and callback read the current render.
  useLayoutEffect(() => {
    if (!pendingFocus) return;
    const element = target(pendingFocus);
    element?.focus();
    setPendingFocus(null);
    onFocused?.();
    // A dialog that just closed hands focus back once it is gone; take it again if it went
    // nowhere (its opener left with the editor or the deleted row).
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
      {
        kind: 'new',
      },
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
    else setPendingFocus({ kind: 'row', id: result.theme.id });
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
    afterDelete.current = neighbour ? { kind: 'row', id: neighbour.id } : { kind: 'new' };
    setPendingFocus(afterDelete.current);
    setDeleting(null);
  }

  const importDescription = [full ? limitId : null, importError ? errorId : null]
    .filter(Boolean)
    .join(' ');
  return (
    <>
      <section className="settings-row">
        <div>
          <h3>{t('appearance')}</h3>
        </div>
        <Select<Appearance>
          label={t('appearance')}
          value={appearanceOf(prefs)}
          onValueChange={(choice) => chooseAppearance(choice)}
          options={[
            ...(['system', 'light', 'dark'] as const).map((value) => ({
              value,
              label: t(value),
            })),
            // Theme names are proper names, shown as they are in every language.
            ...BUILTIN_THEMES.map((theme) => ({
              value: builtinPaletteId(theme.id),
              label: theme.palette.name,
              group: t('builtinThemes'),
            })),
            ...personal.map((theme) => ({
              value: personalPaletteId(theme.id),
              label: theme.palette.name,
              group: t('personalThemes'),
            })),
          ]}
        />
      </section>
      <section
        ref={list}
        data-personal-themes
        aria-labelledby={`${ids}-heading`}
        className="settings-row flex-col items-stretch gap-3"
      >
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
          <h3 id={`${ids}-heading`}>{t('personalThemes')}</h3>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="tertiary"
              aria-disabled={full || undefined}
              aria-describedby={importDescription || undefined}
              className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
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
            <Button
              variant="secondary"
              data-theme-new
              aria-disabled={full || undefined}
              aria-describedby={full ? limitId : undefined}
              className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
              onClick={newTheme}
            >
              {tt('newTheme')}
            </Button>
          </div>
        </div>
        {full ? (
          <p id={limitId} className="text-body text-muted-foreground">
            {tt('limit', { limit: PERSONAL_THEME_LIMIT })}
          </p>
        ) : null}
        {importError ? (
          <p id={errorId} role="alert" className="text-body text-destructive">
            {importReason(tt, importError)}
          </p>
        ) : null}
        {personal.length ? (
          <ul className="settings-list divide-y divide-border">
            {personal.map((theme) => (
              <li key={theme.id} className="flex min-w-0 items-center gap-1 py-1 pr-1 pl-4">
                <span className="min-w-0 flex-1 text-body break-words text-foreground">
                  {theme.palette.name}
                </span>
                <Tooltip content={tt('edit')}>
                  <Button
                    variant="ghost"
                    size="icon"
                    data-theme-edit={theme.id}
                    aria-label={tt('editNamed', { name: theme.palette.name })}
                    onClick={() => {
                      setImportError(null);
                      onEdit(
                        { kind: 'edit', id: theme.id, palette: theme.palette },
                        { kind: 'row', id: theme.id },
                      );
                    }}
                  >
                    <Pencil />
                  </Button>
                </Tooltip>
                <Tooltip content={tt('export')}>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={tt('exportNamed', { name: theme.palette.name })}
                    onClick={() => download(theme.palette)}
                  >
                    <Download />
                  </Button>
                </Tooltip>
                <Tooltip content={tt('delete')}>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={tt('deleteNamed', { name: theme.palette.name })}
                    onClick={() => {
                      afterDelete.current = null;
                      setDeleteFailed(false);
                      setDeleting(theme);
                    }}
                  >
                    <Trash2 />
                  </Button>
                </Tooltip>
              </li>
            ))}
          </ul>
        ) : null}
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

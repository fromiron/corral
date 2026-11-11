import {
  ApiError,
  type ModelConfig,
  type ModelProfileView,
  type ProfileConfig,
} from '@corral/client';
import { type ProfileContextResolution, SCHEMA_VERSION } from '@corral/contracts';
import { parseWorkspaceConfig } from '@corral/core';
import { ModelSelect, providerMark } from '@corral/react';
import {
  Button,
  Collapse,
  DisclosureChevron,
  Input,
  InputField,
  InputGroup,
  KitButton,
  type ModelOption,
  Switch,
  Tooltip,
} from '@corral/react/design-kit';
import { Info, Plus, X } from '@corral/react/icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useServices } from '../services.tsx';
import { useModelSettingsRefresh } from '../workbench/modelSettings.tsx';
import { useSettingsForm, useSettingsTask } from '../workbench/SettingsLifecycle.tsx';
import { connectedModels, isIdentifier, modelKey, profileNameFor } from './modelConnections.ts';

/** A model the Connections tab asked to make into a profile; `nonce` makes each ask new. */
export interface ProfileRequest {
  provider: string;
  model: string;
  nonce: number;
}
/** A profile the Connections tab asked to show. */
export interface ProfileFocus {
  profileId: string;
  nonce: number;
}

const NUMBERS = ['contextWindow', 'reserveTokens', 'keepRecentTokens'] as const;
type NumberKey = (typeof NUMBERS)[number];

/** A profile while it is edited: its numbers as typed, its name following the model until typed. */
interface Row {
  uid: string;
  /** The profile as saved, for a row that was loaded; a new row has none. */
  original: ProfileConfig | null;
  id: string;
  /** The name was typed by hand, so choosing another model keeps it. */
  named: boolean;
  provider: string;
  model: string;
  contextWindow: string;
  reserveTokens: string;
  keepRecentTokens: string;
  workerIsolation: boolean;
  /** Fields this tab does not edit, kept as they were. */
  rest: Omit<
    ProfileConfig,
    'id' | 'provider' | 'model' | 'contextWindow' | 'compaction' | 'workerIsolation'
  >;
}

const uid = () => globalThis.crypto.randomUUID();

function rowOf(profile: ProfileConfig, reuse?: string): Row {
  const { id, provider, model, contextWindow, compaction, workerIsolation, ...rest } = profile;
  return {
    uid: reuse ?? uid(),
    original: profile,
    id,
    named: true,
    provider,
    model,
    contextWindow: contextWindow?.toString() ?? '',
    reserveTokens: compaction?.reserveTokens?.toString() ?? '',
    keepRecentTokens: compaction?.keepRecentTokens?.toString() ?? '',
    workerIsolation: workerIsolation === 'linux-bwrap',
    rest,
  };
}

/** A typed number, or why it is not one; blank leaves the value to the model. */
function parseNumber(text: string, key: NumberKey): number | undefined | 'invalid' {
  const value = text.trim();
  if (!value) return undefined;
  const n = Number(value);
  const max = key === 'contextWindow' ? 10_000_000 : Number.MAX_SAFE_INTEGER;
  const min = key === 'contextWindow' ? 1 : 0;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n < min || n > max) return 'invalid';
  return n;
}

/** The row as config, or null while its model is not chosen or a number does not read. */
function profileOf(row: Row): ProfileConfig | null {
  if (!row.model) return null;
  const [contextWindow, reserveTokens, keepRecentTokens] = NUMBERS.map((key) =>
    parseNumber(row[key], key),
  );
  if ([contextWindow, reserveTokens, keepRecentTokens].includes('invalid')) return null;
  return {
    ...row.rest,
    id: row.id.trim(),
    provider: row.provider,
    model: row.model,
    ...(contextWindow !== undefined ? { contextWindow: contextWindow as number } : {}),
    ...(reserveTokens !== undefined || keepRecentTokens !== undefined
      ? {
          compaction: {
            ...(reserveTokens !== undefined ? { reserveTokens: reserveTokens as number } : {}),
            ...(keepRecentTokens !== undefined
              ? { keepRecentTokens: keepRecentTokens as number }
              : {}),
          },
        }
      : {}),
    ...(row.workerIsolation ? { workerIsolation: 'linux-bwrap' as const } : {}),
  };
}

/** Equal values, whatever order their fields are in; an absent field and `undefined` are one. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => same(item, b[index]));
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const fields = (value: object) =>
    Object.entries(value).filter(([, item]) => item !== undefined) as [string, unknown][];
  const left = fields(a);
  const right = new Map(fields(b));
  return left.length === right.size && left.every(([key, item]) => same(item, right.get(key)));
}

/** A save refused because the profiles themselves changed elsewhere; `latest` is what is there. */
class ProfilesMoved extends Error {
  readonly latest: ModelConfig;
  constructor(latest: ModelConfig) {
    super('REVISION_CONFLICT');
    this.latest = latest;
  }
}

/** The server's refusal, split into each profile's own reasons and the rest. */
function refusalsOf(message: string, rows: Row[]) {
  const perRow: Record<string, string[]> = {};
  const rest: string[] = [];
  for (const part of message.split('; ')) {
    // The server names a profile by its place in what was sent.
    const at = /^modelProfiles\.(\d+)(?:\.[\w.]+)?:\s*(.*)$/s.exec(part);
    const row = at ? rows[Number(at[1])] : undefined;
    if (row && at) perRow[row.uid] = [...(perRow[row.uid] ?? []), at[2] ?? part];
    else rest.push(part);
  }
  return { perRow, rest };
}

/**
 * The Profiles tab: named profiles only, each a name, a model and its advanced settings.
 * Nothing saves until Save; Save and Cancel show only while something changed.
 */
export function ModelProfilesEditor({
  config,
  profiles,
  request,
  focus,
  onRequestHandled,
}: {
  config: ModelConfig;
  profiles: ModelProfileView[];
  request?: ProfileRequest | null;
  focus?: ProfileFocus | null;
  /** Called with a request's nonce once its profile is in the draft. */
  onRequestHandled?: (nonce: number) => void;
}) {
  const t = useTranslations('ProfileEditor');
  const tc = useTranslations('ProfileContext');
  const { models } = useServices();
  const refresh = useModelSettingsRefresh();
  const runTask = useSettingsTask('model-profiles');

  // The config this draft started from; a newer one replaces it only while nothing is edited.
  const [base, setBase] = useState(config);
  const [rows, setRows] = useState<Row[]>(() => config.modelProfiles.map((p) => rowOf(p)));
  const [picking, setPicking] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  // The profiles changed elsewhere; `latest` is the config read when the save was refused.
  const [conflict, setConflict] = useState<{ latest: ModelConfig | null } | null>(null);
  const [saving, setSaving] = useState(false);
  // The server's effective values for one draft, by the draft they describe.
  const [preview, setPreview] = useState<{
    key: string;
    value: Record<string, ProfileContextResolution>;
  } | null>(null);

  const chosen = rows.filter((row) => row.model);
  const draft = chosen.map(profileOf);
  const valid = draft.every(Boolean) && chosen.every((row) => !nameProblem(row));
  const removed = base.modelProfiles.filter(
    (profile) => !rows.some((row) => row.original?.id === profile.id),
  ).length;
  const changes =
    removed +
    chosen.filter((row, index) => !row.original || !same(draft[index], row.original)).length;
  const dirty = changes > 0;

  const reset = (next: ModelConfig) => {
    setBase(next);
    setRows((current) =>
      next.modelProfiles.map((profile) =>
        rowOf(profile, current.find((row) => row.id === profile.id)?.uid),
      ),
    );
    setRowErrors({});
    setError(null);
    setConflict(null);
    setPreview(null);
  };
  // The page's config revision last seen; a new one is taken while nothing is edited.
  const [seen, setSeen] = useState(config.revision);
  if (config.revision !== seen) {
    setSeen(config.revision);
    if (!dirty) reset(config);
  }

  function nameProblem(row: Row): string | null {
    if (row.original) return null;
    const name = row.id.trim();
    if (!isIdentifier(name)) return t('nameInvalid');
    if (rows.some((other) => other.uid !== row.uid && other.id.trim() === name))
      return t('nameTaken');
    return null;
  }

  // Effective values for the draft, from the server; only a draft that reads is sent.
  const draftKey = dirty && valid ? JSON.stringify(draft) : null;
  useEffect(() => {
    if (!models || !draftKey) return;
    const modelProfiles = JSON.parse(draftKey) as ProfileConfig[];
    const parsed = parseWorkspaceConfig({
      schemaVersion: SCHEMA_VERSION,
      modelProfiles,
      modelProviders: base.modelProviders,
    });
    if (!parsed.ok) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void models
        .previewConfig(
          { revision: base.revision, modelProfiles, modelProviders: base.modelProviders },
          controller.signal,
        )
        .then((result) => {
          if (!controller.signal.aborted)
            setPreview({ key: draftKey, value: result.effectiveProfiles });
        })
        .catch(() => {
          // A failed preview leaves no older one standing in for this draft.
          if (!controller.signal.aborted) setPreview(null);
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [draftKey, models, base]);
  /**
   * The effective values a row shows: the saved ones while nothing changed, the preview of this
   * very draft, or, until it arrives, the saved ones only for a row still as it was saved.
   */
  const resolutionOf = (row: Row): ProfileContextResolution | undefined => {
    const id = row.id.trim();
    if (!id) return undefined;
    if (!dirty) return base.effectiveProfiles?.[id];
    if (preview && preview.key === draftKey) return preview.value[id];
    const at = chosen.indexOf(row);
    const profile = at >= 0 ? draft[at] : null;
    return row.original && profile && same(profile, row.original)
      ? base.effectiveProfiles?.[id]
      : undefined;
  };

  // What a profile can point at: every model of a connected provider.
  const options = useMemo<ModelOption[]>(
    () =>
      connectedModels(profiles).map((model) => {
        const mark = providerMark(model.provider);
        return {
          id: model.key,
          name: model.name,
          description: '',
          group: model.providerName,
          keywords: `${model.modelId} ${model.providerName} ${model.provider}`,
          ...(mark ? { mark } : {}),
          markText: model.providerName,
        };
      }),
    [profiles],
  );
  const optionsFor = (row: Row): ModelOption[] => {
    const key = modelKey(row.provider, row.model);
    if (!row.model || options.some((option) => option.id === key)) return options;
    // A saved model no connection offers now: shown, by its known name, but not choosable.
    const known = profiles.find((p) => p.provider === row.provider && p.modelId === row.model);
    const mark = providerMark(row.provider);
    return [
      {
        id: key,
        name: known?.modelName ?? row.model,
        description: t('notConnected'),
        group: known?.providerName ?? row.provider,
        disabled: true,
        ...(mark ? { mark } : {}),
        markText: known?.providerName ?? row.provider,
      },
      ...options,
    ];
  };
  const update = (rowId: string, patch: (row: Row) => Partial<Row>) =>
    setRows((current) =>
      current.map((row) => (row.uid === rowId ? { ...row, ...patch(row) } : row)),
    );
  // Rows given a model in this event, before the state shows it (the list closes right after).
  const picked = useRef(new Set<string>());
  const choose = (rowId: string, key: string) => {
    const model = connectedModels(profiles).find((item) => item.key === key);
    if (!model) return;
    picked.current.add(rowId);
    setRows((current) =>
      current.map((row) =>
        row.uid !== rowId
          ? row
          : {
              ...row,
              provider: model.provider,
              model: model.modelId,
              ...(row.named
                ? {}
                : {
                    id: profileNameFor(
                      model.modelId,
                      current.filter((other) => other.uid !== rowId).map((other) => other.id),
                    ),
                  }),
            },
      ),
    );
  };
  const blank = (): Row => ({
    uid: uid(),
    original: null,
    id: '',
    named: false,
    provider: '',
    model: '',
    contextWindow: '',
    reserveTokens: '',
    keepRecentTokens: '',
    workerIsolation: false,
    rest: {},
  });
  // A row that goes away takes the focus with it; Add profile takes it instead.
  const addRef = useRef<HTMLButtonElement>(null);
  const refocus = () => requestAnimationFrame(() => addRef.current?.focus());
  const add = () => {
    const row = blank();
    setRows((current) => [...current, row]);
    setPicking(row.uid);
  };

  // A model the Connections tab sent: a new profile for it, named after it.
  const listRef = useRef<HTMLDivElement>(null);
  const handled = useRef<number | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Each request is acted on once, by its nonce.
  useEffect(() => {
    if (!request || handled.current === request.nonce) return;
    handled.current = request.nonce;
    const row = blank();
    setRows((current) => [
      ...current,
      {
        ...row,
        provider: request.provider,
        model: request.model,
        id: profileNameFor(
          request.model,
          current.map((other) => other.id),
        ),
      },
    ]);
    onRequestHandled?.(request.nonce);
    requestAnimationFrame(() => {
      const input = listRef.current?.querySelector<HTMLElement>(
        `[data-profile-row="${row.uid}"] input`,
      );
      input?.scrollIntoView({ block: 'nearest' });
      input?.focus();
    });
  }, [request?.nonce]);
  const focused = useRef<number | null>(null);
  useEffect(() => {
    if (!focus || focused.current === focus.nonce) return;
    focused.current = focus.nonce;
    requestAnimationFrame(() => {
      const target = listRef.current?.querySelector<HTMLElement>(
        `[data-profile-id="${CSS.escape(focus.profileId)}"] [data-slot="model-picker-trigger"]`,
      );
      target?.scrollIntoView({ block: 'center' });
      target?.focus();
    });
  }, [focus]);

  const save = async () => {
    if (!models || saving || !valid) return false;
    setSaving(true);
    setError(null);
    setRowErrors({});
    setConflict(null);
    // Endpoints saved elsewhere since this draft began are kept; profiles changed elsewhere are a
    // conflict the server reports.
    const onto = same(config.modelProfiles, base.modelProfiles) ? config : base;
    const modelProfiles = draft as ProfileConfig[];
    const sent = chosen;
    const send = (target: ModelConfig) =>
      models.saveConfig({
        revision: target.revision,
        modelProfiles,
        modelProviders: target.modelProviders,
      });
    const conflicted = (failure: unknown) =>
      failure instanceof ApiError && failure.code === 'REVISION_CONFLICT';
    let saved: ModelConfig;
    try {
      saved = await runTask(async () => {
        try {
          return await send(onto);
        } catch (failure) {
          if (!conflicted(failure)) throw failure;
          // Something else was saved since this draft began: read what is there now.
          const latest = await models.config();
          if (!same(latest.modelProfiles, base.modelProfiles)) throw new ProfilesMoved(latest);
          // Only the revision moved (effort routing, an endpoint): the edits go onto it.
          try {
            return await send(latest);
          } catch (again) {
            if (conflicted(again)) throw new ProfilesMoved(await models.config());
            throw again;
          }
        }
      });
    } catch (failure) {
      if (failure instanceof ProfilesMoved || conflicted(failure)) {
        setConflict({ latest: failure instanceof ProfilesMoved ? failure.latest : null });
        void refresh().catch(() => {});
      } else {
        const message = failure instanceof Error ? failure.message : String(failure);
        const { perRow, rest } = refusalsOf(message, sent);
        setRowErrors(
          Object.fromEntries(
            Object.entries(perRow).map(([uid, reasons]) => [
              uid,
              t('refused', { message: reasons.join('; ') }),
            ]),
          ),
        );
        // A reason the server gave, such as a model list still loading, is shown as it is.
        if (rest.length)
          setError(
            failure instanceof ApiError
              ? rest.join('; ')
              : t('refused', { message: rest.join('; ') }),
          );
      }
      return false;
    } finally {
      setSaving(false);
    }
    reset(saved);
    // The save is done; a list that fails to load after it does not undo that.
    await refresh().catch(() => {});
    return true;
  };
  const cancel = () => {
    reset(config);
    setPicking(null);
  };
  // Starting again takes the config read when the save was refused, not an older one.
  const reload = () => {
    reset(conflict?.latest ?? config);
    setPicking(null);
  };
  useSettingsForm({ dirty, pending: saving, save });

  return (
    <section aria-label={t('heading')} className="flex flex-col gap-3">
      <div className="flex min-h-9 items-center justify-end gap-3">
        <Button ref={addRef} variant="tertiary" size="compact" onClick={add} disabled={saving}>
          <Plus aria-hidden />
          {t('add')}
        </Button>
      </div>
      {rows.length === 0 ? (
        <p className="m-0 text-body text-muted-foreground">{t('empty')}</p>
      ) : null}
      <div ref={listRef} className="flex flex-col">
        {rows.map((row, index) => {
          const name = row.id.trim() || t('nameOf', { n: index + 1 });
          const resolution = resolutionOf(row);
          const policy = resolution?.policy ?? null;
          const expanded = open.has(row.uid);
          // A new row's name, once it has a model: an empty one is a problem too.
          const problem = row.id || row.model ? nameProblem(row) : null;
          const problemId = `${row.uid}-name-problem`;
          const fold = `${row.uid}-advanced`;
          const custom = Boolean(
            row.contextWindow || row.reserveTokens || row.keepRecentTokens || row.workerIsolation,
          );
          return (
            <div
              key={row.uid}
              data-profile-row={row.uid}
              data-profile-id={row.original?.id}
              className={index > 0 ? 'border-t border-border py-2' : 'py-2'}
            >
              {/* Narrow, the name takes its own line and the model field the full width under it. */}
              <div className="flex min-w-0 flex-wrap items-center gap-2 sm:flex-nowrap">
                {row.original ? (
                  <span className="min-w-0 basis-full truncate font-mono text-body text-foreground sm:w-44 sm:shrink-0 sm:basis-auto">
                    {row.id}
                  </span>
                ) : (
                  <Input
                    aria-label={t('nameOf', { n: index + 1 })}
                    aria-invalid={problem ? true : undefined}
                    aria-describedby={problem ? problemId : undefined}
                    value={row.id}
                    disabled={saving}
                    autoComplete="off"
                    spellCheck={false}
                    font="mono"
                    className="basis-full sm:w-44 sm:shrink-0 sm:basis-auto"
                    onChange={(event) =>
                      update(row.uid, () => ({ id: event.target.value, named: true }))
                    }
                  />
                )}
                <div className="min-w-0 flex-1">
                  <ModelSelect
                    label={t('modelOf', { profile: name })}
                    value={row.model ? modelKey(row.provider, row.model) : ''}
                    options={optionsFor(row)}
                    placeholder={t('addModel')}
                    missingLabel={t('notConnected')}
                    disabled={saving}
                    open={picking === row.uid}
                    onOpenChange={(next) => {
                      setPicking(next ? row.uid : null);
                      // Closing the list of a new row without a model adds nothing.
                      if (!next && !row.model && !picked.current.has(row.uid)) {
                        setRows((current) =>
                          current.filter((item) => item.uid !== row.uid || item.model),
                        );
                        refocus();
                      }
                    }}
                    onValueChange={(key) => choose(row.uid, key)}
                  />
                </div>
                <Button
                  variant="ghost"
                  size="icon-compact"
                  aria-label={t('advancedOf', { profile: name })}
                  aria-expanded={expanded}
                  aria-controls={fold}
                  className={custom ? 'text-foreground' : 'text-muted-foreground'}
                  onClick={() =>
                    setOpen((current) => {
                      const next = new Set(current);
                      if (next.has(row.uid)) next.delete(row.uid);
                      else next.add(row.uid);
                      return next;
                    })
                  }
                >
                  <DisclosureChevron open={expanded} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-compact"
                  aria-label={t('remove', { profile: name })}
                  className="text-muted-foreground"
                  disabled={saving}
                  onClick={() => {
                    setRows((current) => current.filter((item) => item.uid !== row.uid));
                    refocus();
                  }}
                >
                  <X aria-hidden />
                </Button>
              </div>
              {problem ? (
                <p id={problemId} className="m-0 pt-1 text-caption text-danger">
                  {problem}
                </p>
              ) : null}
              {rowErrors[row.uid] ? (
                <p role="alert" className="m-0 pt-1 text-caption text-danger">
                  {rowErrors[row.uid]}
                </p>
              ) : null}
              <Collapse open={expanded} hideWhenClosed>
                {/* biome-ignore lint/a11y/useSemanticElements: A fieldset's legend would repeat the toggle's name as visible text. */}
                <div
                  id={fold}
                  role="group"
                  aria-label={t('advancedOf', { profile: name })}
                  className="grid gap-3 pt-3"
                >
                  <InputGroup className="grid w-full gap-3 sm:grid-cols-3">
                    {NUMBERS.map((key, position) => {
                      const invalid = parseNumber(row[key], key) === 'invalid';
                      const warning =
                        policy && !invalid
                          ? policy.warnings.find(
                              (w) =>
                                (key === 'reserveTokens' && w === 'reserve_below_output') ||
                                (key === 'contextWindow' && w === 'above_model_limit'),
                            )
                          : undefined;
                      return (
                        <div
                          key={key}
                          data-field={key}
                          className="grid min-w-0 content-start gap-1"
                        >
                          <InputField
                            index={position}
                            label={t(key)}
                            value={row[key]}
                            disabled={saving}
                            inputMode="numeric"
                            autoComplete="off"
                            placeholder={
                              policy
                                ? t('effective', {
                                    value: policy[key],
                                    source: tc(`source.${policy.sources[key]}`),
                                  })
                                : t('inherit')
                            }
                            {...(invalid
                              ? {
                                  error: t(
                                    key === 'contextWindow'
                                      ? 'contextInvalid'
                                      : 'compactionInvalid',
                                  ),
                                }
                              : {})}
                            onChange={(value) => update(row.uid, () => ({ [key]: value }))}
                          />
                          {warning ? (
                            <p className="m-0 pl-2.5 text-caption text-warning">
                              {tc(`warning.${warning}`)}
                            </p>
                          ) : null}
                        </div>
                      );
                    })}
                  </InputGroup>
                  {policy?.warnings.includes('legacy_inconsistent') ? (
                    <p className="m-0 text-caption text-warning">
                      {tc('warning.legacy_inconsistent')}
                    </p>
                  ) : null}
                  {resolution?.errors.length ? (
                    <p className="m-0 text-caption text-danger">{resolution.errors.join(' ')}</p>
                  ) : null}
                  <div className="flex items-center gap-1">
                    <Switch
                      label={t('isolation')}
                      size="compact"
                      checked={row.workerIsolation}
                      disabled={saving}
                      onToggle={() =>
                        update(row.uid, (current) => ({
                          workerIsolation: !current.workerIsolation,
                        }))
                      }
                    />
                    <Tooltip content={t('isolationHint')} className="max-w-xs">
                      <Button
                        variant="ghost"
                        size="icon-compact"
                        aria-label={t('isolationAbout')}
                        className="text-muted-foreground"
                      >
                        <Info aria-hidden />
                      </Button>
                    </Tooltip>
                  </div>
                </div>
              </Collapse>
            </div>
          );
        })}
      </div>
      {dirty || conflict ? (
        <div
          data-save-bar=""
          className="sticky bottom-0 z-10 -mx-2 flex flex-wrap items-center justify-end gap-2 border-t border-border bg-background px-2 py-2"
        >
          {conflict ? (
            <p
              role="alert"
              className="m-0 mr-auto flex flex-wrap items-center gap-2 text-caption text-danger"
            >
              {t('conflict')}
              <Button variant="ghost" size="compact" onClick={reload}>
                {t('reload')}
              </Button>
            </p>
          ) : error ? (
            <p role="alert" className="m-0 mr-auto text-caption text-danger">
              {error}
            </p>
          ) : (
            <p className="m-0 mr-auto text-caption text-muted-foreground">
              {t('unsaved', { count: changes })}
            </p>
          )}
          <Button variant="tertiary" size="compact" disabled={saving} onClick={cancel}>
            {t('cancel')}
          </Button>
          <KitButton
            variant="primary"
            size="compact"
            loading={saving}
            disabled={!valid || !dirty}
            onClick={() => void save()}
          >
            {t('save')}
          </KitButton>
        </div>
      ) : null}
    </section>
  );
}

import { Button, Dialog, DialogDescription, DialogPopup, DialogTitle } from '@corral/react/ui';
import { Link, useBlocker, useRouterState } from '@tanstack/react-router';
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { useServices } from '../services.tsx';
import { createSettingsTasks } from './settingsTasks.ts';

type Form = { dirty: boolean; pending?: boolean; save?: () => Promise<boolean> };
type Entry = { current: Form };
type Prompt = { forms: Entry[]; resolve: (leave: boolean) => void };
const Context = createContext<{
  tasks: ReturnType<typeof createSettingsTasks>;
  forms: Set<Entry>;
  confirm: (only?: Entry[]) => Promise<boolean>;
  prompt: Prompt | null;
  finish: (leave: boolean) => void;
} | null>(null);

export function SettingsLifecycle({ children }: { children: ReactNode }) {
  const services = useServices();
  // biome-ignore lint/correctness/useExhaustiveDependencies: Operation ownership must change with the connected host services.
  const tasks = useMemo(() => createSettingsTasks(), [services]);
  const forms = useRef(new Set<Entry>()).current;
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const pending = useRef(false);
  const confirm = async (only?: Entry[]) => {
    const dirty = (only ?? [...forms]).filter(
      (entry) => entry.current.dirty && !entry.current.pending,
    );
    if (!dirty.length) return true;
    if (pending.current) return false;
    pending.current = true;
    return new Promise<boolean>((resolve) => setPrompt({ forms: dirty, resolve }));
  };
  const finish = (leave: boolean) => {
    prompt?.resolve(leave);
    pending.current = false;
    setPrompt(null);
  };
  useBlocker({
    shouldBlockFn: async ({ current, next }) => {
      // The project picker changes preview tools, not the server-owned profile draft.
      if (
        current.pathname === next.pathname &&
        (current.pathname === '/settings/harness' ||
          (current.search as Record<string, unknown>).settings === 'harness')
      ) {
        const {
          projectId: _a,
          settingsProject: _b,
          returnTo: _returnA,
          ...before
        } = current.search as Record<string, unknown>;
        const {
          projectId: _c,
          settingsProject: _d,
          returnTo: _returnB,
          ...after
        } = next.search as Record<string, unknown>;
        if (JSON.stringify(before) === JSON.stringify(after)) return false;
      }
      if (
        current.pathname === next.pathname &&
        JSON.stringify(current.search) === JSON.stringify(next.search)
      )
        return false;
      return !(await confirm());
    },
    enableBeforeUnload: () =>
      [...forms].some((entry) => entry.current.dirty || entry.current.pending) ||
      tasks.store.getState().operations.some((op) => op.state === 'pending'),
  });
  return <Context value={{ tasks, forms, confirm, prompt, finish }}>{children}</Context>;
}

export function useSettingsForm(form: Form) {
  const context = useContext(Context);
  const active = useRouterState({
    select: (state) =>
      state.location.pathname.startsWith('/settings') ||
      Boolean((state.location.search as Record<string, unknown>).settings),
  });
  const entry = useRef(form);
  entry.current = form;
  const forms = context?.forms;
  useEffect(() => {
    if (active) forms?.add(entry);
    return () => {
      forms?.delete(entry);
    };
  }, [forms, active]);
  return () => (context ? context.confirm([entry]) : Promise.resolve(true));
}

/** Register submitted work before starting it; closing its form does not cancel it. */
export function useSettingsTask(target: string) {
  const context = useContext(Context);
  const href = useRouterState({ select: (state) => state.location.href });
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  return async <T,>(action: () => Promise<T>): Promise<T> => {
    if (!context) return action();
    const value = await context.tasks.run(target, href, action);
    // The mounted form already shows its result. Retain a receipt only for detached work.
    if (active.current) context.tasks.dismiss(target);
    return value;
  };
}

export function SettingsLeavePrompt() {
  const context = useContext(Context);
  const t = useTranslations('SettingsDialog');
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const prompt = context?.prompt;
  useEffect(() => {
    if (!prompt) setFailed(false);
  }, [prompt]);
  if (!context || !prompt) return null;
  const canSave = prompt.forms.every((entry) => Boolean(entry.current.save));
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) context.finish(false);
      }}
    >
      <DialogPopup
        showCloseButton={false}
        className="flex flex-col gap-4 p-6"
        bottomStickOnMobile={false}
      >
        <DialogTitle>{t('unsaved')}</DialogTitle>
        <DialogDescription>{t(canSave ? 'unsavedHint' : 'explicitHint')}</DialogDescription>
        {failed ? (
          <p role="alert" className="text-sm text-danger">
            {t('saveFailed')}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {canSave ? (
            <Button
              disabled={saving}
              onClick={async () => {
                setSaving(true);
                setFailed(false);
                let saved = true;
                try {
                  for (const entry of prompt.forms)
                    if (entry.current.dirty && !(await entry.current.save?.())) {
                      saved = false;
                      break;
                    }
                } catch {
                  saved = false;
                }
                setSaving(false);
                if (saved) context.finish(true);
                else setFailed(true);
              }}
            >
              {t('saveLeave')}
            </Button>
          ) : null}
          <Button variant="outline" disabled={saving} onClick={() => context.finish(true)}>
            {t('discard')}
          </Button>
          <Button variant="ghost" disabled={saving} onClick={() => context.finish(false)}>
            {t('keepEditing')}
          </Button>
        </div>
      </DialogPopup>
    </Dialog>
  );
}

export function SettingsOperationStatus() {
  const context = useContext(Context);
  if (!context) return null;
  return <OperationStatus tasks={context.tasks} />;
}
function OperationStatus({ tasks }: { tasks: ReturnType<typeof createSettingsTasks> }) {
  const operations = useStore(tasks.store, (state) => state.operations);
  const t = useTranslations('SettingsDialog');
  if (!operations.length) return null;
  return (
    <div
      className="flex max-h-28 shrink-0 flex-col gap-1 overflow-auto border-b border-line bg-surface px-4 py-2 text-xs"
      aria-live="polite"
      data-testid="settings-operations"
    >
      {operations.map((op) => (
        <div key={op.target} className="flex flex-wrap items-center gap-2">
          <span>{t(op.state)}</span>
          <Link to={op.href} className="underline">
            {t('reviewTarget')}
          </Link>
          {op.state !== 'pending' ? (
            <Button size="sm" variant="ghost" onClick={() => tasks.dismiss(op.target)}>
              {t('dismiss')}
            </Button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/** Existing idempotency receipts survive closing a form; never use this for credentials. */
export function useSettingsCommand<T>(target: string) {
  const context = useContext(Context);
  const fallback = useRef<T | null>(null);
  return context?.tasks.command<T>(target) ?? fallback;
}

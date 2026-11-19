import type { InputBinding, OutputNode } from '@corral/contracts';
import { outputSources } from '@corral/core';
import { useId, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { Button, KitInputField, KitInputGroup, Select } from '../design-kit/index.ts';
import type { EditorStore } from '../editor/store.ts';
import { X } from '../ui/icons.ts';
import { patchNode, replaceOutputSource } from './commands.ts';

/** Each saved binding is a separate named result. Selection stays local until Apply. */
export function OutputSources({ editor, output }: { editor: EditorStore; output: OutputNode }) {
  const t = useTranslations('TeamEditor.results');
  const ti = useTranslations('Inspector');
  const rejected = useTranslations('TeamEditor.rejected');
  const pickerId = useId();
  const opener = useRef<HTMLButtonElement | null>(null);
  const draft = useStore(editor, (s) => s.draft);
  const sources = useMemo(() => outputSources(draft.definition, output.id), [draft, output.id]);
  const [editing, setEditing] = useState<InputBinding | 'new' | null>(null);
  const [source, setSource] = useState('');
  const [name, setName] = useState('');
  const adding = editing === 'new';
  const open = adding || (!!editing && output.inputBindings.includes(editing));
  const available = sources.some((n) => n.id === source);

  const edit = (binding: InputBinding | 'new', trigger: HTMLButtonElement) => {
    opener.current = trigger;
    setEditing(binding);
    setSource(binding === 'new' ? '' : (binding.sourceNodeId ?? ''));
    setName(binding === 'new' ? 'input' : binding.name);
  };
  const close = () => {
    setEditing(null);
    opener.current?.focus({ preventScroll: true });
  };
  const save = () => {
    const latest = editor.getState().draft;
    const node = latest.definition.nodes.find((n) => n.id === output.id);
    if (node?.type !== 'output' || !editing) return;
    if (editing === 'new') {
      if (!outputSources(latest.definition, node.id).some((n) => n.id === source) || !name.trim())
        return;
      editor.getState().applyDraft(
        patchNode(latest, node.id, {
          inputBindings: [
            ...node.inputBindings,
            { kind: 'task_output', name: name.trim(), sourceNodeId: source },
          ],
        }),
      );
    } else {
      const result = replaceOutputSource(
        latest,
        node.id,
        node.inputBindings.indexOf(editing),
        source,
      );
      if (!result.ok) return;
      editor.getState().applyDraft(result.draft);
    }
    close();
  };

  return (
    <fieldset className="grid gap-2 text-caption">
      <legend>{t('heading')}</legend>
      {output.inputBindings.map((binding, index) => {
        const producer = draft.definition.nodes.find((n) => n.id === binding.sourceNodeId);
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: imported bindings can have identical names; order is part of the definition.
          <div key={index} className="flex flex-wrap items-center gap-1.5">
            <span className="min-w-0 grow break-words">
              {binding.name} ·{' '}
              {producer?.label ?? binding.sourceNodeId ?? ti(`inputKinds.${binding.kind}`)}
            </span>
            {binding.kind === 'task_output' ? (
              <Button
                size="compact"
                variant="secondary"
                onClick={(event) => edit(binding, event.currentTarget)}
              >
                {output.inputBindings.length === 1
                  ? t('change')
                  : t('changeNamed', { name: binding.name })}
              </Button>
            ) : null}
            <Button
              size="icon-compact"
              variant="ghost"
              aria-label={ti('removeInput', { name: binding.name })}
              onClick={() =>
                editor.getState().applyDraft(
                  patchNode(draft, output.id, {
                    inputBindings: output.inputBindings.filter((_, i) => i !== index),
                  }),
                )
              }
            >
              <X />
            </Button>
          </div>
        );
      })}
      <Button
        className="justify-self-start"
        size="compact"
        variant="secondary"
        disabled={output.inputBindings.length >= 20}
        onClick={(event) => edit('new', event.currentTarget)}
      >
        {output.inputBindings.length ? t('add') : t('choose')}
      </Button>
      {open ? (
        <div className="grid gap-1.5">
          {adding ? (
            <KitInputGroup>
              <KitInputField index={0} label={ti('inputName')} value={name} onChange={setName} />
            </KitInputGroup>
          ) : null}
          <label htmlFor={pickerId}>{t('sourceFor', { name })}</label>
          <Select
            id={pickerId}
            label={t('sourceFor', { name })}
            value={source}
            onValueChange={setSource}
            options={sources.map((n) => ({ value: n.id, label: n.label }))}
            disabled={!sources.length}
          />
          {!sources.length ? <p className="text-muted-foreground">{t('noSources')}</p> : null}
          {sources.length > 0 && source && !available ? (
            <p role="status">{rejected('invalidResultSource')}</p>
          ) : null}
          <div className="flex gap-2">
            <Button size="compact" disabled={!name.trim() || !available} onClick={save}>
              {t('apply')}
            </Button>
            <Button size="compact" variant="secondary" onClick={close}>
              {t('cancel')}
            </Button>
          </div>
        </div>
      ) : null}
    </fieldset>
  );
}

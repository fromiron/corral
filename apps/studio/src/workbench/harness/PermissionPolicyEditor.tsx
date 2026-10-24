import type { ToolDescriptor, ToolPermissionPolicy } from '@corral/contracts';
import { toolDescriptorHash } from '@corral/core';
import { Button, Input, Select, Switch } from '@corral/react/design-kit';
import { useId } from 'react';
import { useTranslations } from 'use-intl';

export function PermissionPolicyEditor({
  value,
  tools,
  names,
  onChange,
}: {
  value: ToolPermissionPolicy | undefined;
  tools: ToolDescriptor[];
  names: string[];
  onChange(value: ToolPermissionPolicy | undefined): void;
}) {
  const t = useTranslations('Harness');
  const formId = useId();
  const rule = (index: number, changes: Partial<ToolPermissionPolicy['rules'][number]>) => {
    if (value)
      onChange({
        ...value,
        rules: value.rules.map((item, i) => (i === index ? { ...item, ...changes } : item)),
      });
  };
  return (
    <fieldset className="settings-surface flex flex-col gap-3">
      <legend className="text-sm font-medium">{t('permissionPolicy')}</legend>
      <p className="text-xs text-muted-foreground">{t('permissionPolicyHint')}</p>
      <Switch
        label={t('permissionEnabled')}
        checked={Boolean(value)}
        onToggle={() => onChange(value ? undefined : { default: 'ask', rules: [] })}
      />
      {value ? (
        <>
          <div className="flex flex-col gap-1 text-sm">
            <span>{t('permissionDefault')}</span>
            <Select
              label={t('permissionDefault')}
              value={value.default}
              onValueChange={(next) => onChange({ ...value, default: next })}
              options={[
                { value: 'ask', label: t('permissionAsk') },
                { value: 'deny', label: t('permissionDeny') },
              ]}
            />
          </div>
          {value.rules.map((item, index) => (
            <fieldset
              // biome-ignore lint/suspicious/noArrayIndexKey: Rules are an ordered, fully controlled editor with no local row state.
              key={index}
              className="flex flex-col gap-2 rounded-lg bg-surface p-3"
            >
              <legend className="text-xs">{t('permissionRule', { number: index + 1 })}</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="text-xs">
                  <p>{t('permissionTool')}</p>
                  <Select
                    label={t('permissionTool')}
                    value={item.tool}
                    placeholder={t('chooseOption')}
                    options={[...new Set([...names, item.tool])]
                      .filter(Boolean)
                      .map((name) => ({ value: name, label: name }))}
                    onValueChange={(name) => {
                      const descriptor = tools.find((tool) => tool.name === name);
                      rule(index, {
                        tool: name,
                        descriptorHash: descriptor ? toolDescriptorHash(descriptor) : undefined,
                      });
                    }}
                  />
                </div>
                <div className="text-xs">
                  <p>{t('permissionAction')}</p>
                  <Select
                    label={t('permissionAction')}
                    value={item.action}
                    onValueChange={(action) => rule(index, { action })}
                    options={[
                      { value: 'ask', label: t('permissionAsk') },
                      { value: 'deny', label: t('permissionDeny') },
                      { value: 'allow', label: t('permissionAllow') },
                    ]}
                  />
                </div>
              </div>
              <label
                className="flex flex-col gap-1 text-xs"
                htmlFor={`${formId}-${index}-descriptor`}
              >
                {t('permissionDescriptor')}
                <Input
                  id={`${formId}-${index}-descriptor`}
                  nativeInput
                  value={item.descriptorHash ?? ''}
                  maxLength={64}
                  onChange={(e) => rule(index, { descriptorHash: e.target.value || undefined })}
                />
              </label>
              <Switch
                label={t('permissionPath')}
                size="compact"
                checked={Boolean(item.path)}
                onToggle={() =>
                  rule(index, {
                    path: item.path ? undefined : { argument: 'path', prefix: 'src' },
                  })
                }
              />
              {item.path ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="text-xs" htmlFor={`${formId}-${index}-path-argument`}>
                    {t('permissionArgument')}
                    <Input
                      id={`${formId}-${index}-path-argument`}
                      nativeInput
                      value={item.path.argument}
                      onChange={(e) =>
                        rule(index, {
                          path: { argument: e.target.value, prefix: item.path?.prefix ?? '' },
                        })
                      }
                    />
                  </label>
                  <label className="text-xs" htmlFor={`${formId}-${index}-prefix`}>
                    {t('permissionPrefix')}
                    <Input
                      id={`${formId}-${index}-prefix`}
                      nativeInput
                      value={item.path.prefix}
                      onChange={(e) =>
                        rule(index, {
                          path: { argument: item.path?.argument ?? 'path', prefix: e.target.value },
                        })
                      }
                    />
                  </label>
                </div>
              ) : null}
              {Object.entries(item.arguments ?? {}).map(([key, expected]) => (
                <div key={key} className="flex flex-wrap items-end gap-2">
                  <label
                    className="text-xs"
                    htmlFor={`${formId}-${index}-condition-argument${key}`}
                  >
                    {t('permissionArgument')}
                    <Input
                      id={`${formId}-${index}-condition-argument${key}`}
                      nativeInput
                      defaultValue={key}
                      onBlur={(e) => {
                        if (
                          e.target.value !== key &&
                          Object.hasOwn(item.arguments ?? {}, e.target.value)
                        )
                          return;
                        rule(index, {
                          arguments: Object.fromEntries(
                            Object.entries(item.arguments ?? {}).map(([name, v]) => [
                              name === key ? e.target.value : name,
                              v,
                            ]),
                          ),
                        });
                      }}
                    />
                  </label>
                  <label className="text-xs" htmlFor={`${formId}-${index}-equals${key}`}>
                    {t('permissionEquals')}
                    <Input
                      id={`${formId}-${index}-equals${key}`}
                      nativeInput
                      value={expected === null ? 'null' : String(expected)}
                      type={typeof expected === 'number' ? 'number' : 'text'}
                      readOnly={typeof expected === 'boolean' || expected === null}
                      onChange={(e) =>
                        rule(index, {
                          arguments: {
                            ...item.arguments,
                            [key]:
                              typeof expected === 'number'
                                ? Number(e.target.value)
                                : e.target.value,
                          },
                        })
                      }
                    />
                  </label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="compact"
                    onClick={() =>
                      rule(index, {
                        arguments: Object.fromEntries(
                          Object.entries(item.arguments ?? {}).filter(([name]) => name !== key),
                        ),
                      })
                    }
                  >
                    {t('permissionRemoveCondition')}
                  </Button>
                </div>
              ))}
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="compact"
                  variant="tertiary"
                  disabled={Object.keys(item.arguments ?? {}).length >= 16}
                  onClick={() => {
                    let n = 1;
                    while (Object.hasOwn(item.arguments ?? {}, `argument_${n}`)) n += 1;
                    rule(index, { arguments: { ...item.arguments, [`argument_${n}`]: '' } });
                  }}
                >
                  {t('permissionAddCondition')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="compact"
                  onClick={() =>
                    onChange({ ...value, rules: value.rules.filter((_, i) => i !== index) })
                  }
                >
                  {t('permissionRemoveRule')}
                </Button>
              </div>
            </fieldset>
          ))}
          <Button
            type="button"
            size="compact"
            variant="tertiary"
            disabled={value.rules.length >= 64}
            onClick={() =>
              onChange({
                ...value,
                rules: [...value.rules, { tool: names[0] ?? '', action: 'ask' }],
              })
            }
          >
            {t('permissionAddRule')}
          </Button>
        </>
      ) : null}
    </fieldset>
  );
}

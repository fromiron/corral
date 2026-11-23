import type { RoleHarnessPreview } from '@corral/client';
import type {
  AgentRole,
  HarnessProfileView,
  RoleMcpToolProblem,
  RoleSkillProblem,
  RoleSkillRef,
} from '@corral/contracts';
import { TermHint, useStudioStores } from '@corral/react';
import { Button, fontWeights, Select } from '@corral/react/design-kit';
import { Link } from '@tanstack/react-router';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { HarnessPreviewView } from '../pages/harness/HarnessSettingsPage.tsx';
import { useServices } from '../services.tsx';
import { useSettingsNavigation } from './navigation.ts';

export function RoleHarnessProblem({
  problem,
  skills = [],
}: {
  problem: RoleSkillProblem;
  skills?: RoleSkillRef[];
}) {
  const t = useTranslations('Harness');
  return (
    <div role="alert" className="text-caption text-danger">
      {problem.reason === 'execution_policy_required' ? t('roleNeedsPolicy') : null}
      {problem.entries.length ? (
        <ul>
          {problem.entries.map((entry) => {
            const number =
              skills.findIndex(
                (ref) => ref.resourceHash === entry.resourceHash && ref.entry === entry.entry,
              ) + 1;
            return (
              <li key={`${entry.resourceHash}:${entry.entry}`}>
                {t(`roleSkillProblem.${entry.reason}`, { number })}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

export function McpPreviewProblem({ problem }: { problem: RoleMcpToolProblem }) {
  const t = useTranslations('TeamEditor.roleTools');
  return (
    <ul role="alert" className="grid gap-1 text-caption text-destructive">
      {problem.tools.map(({ name, serverId, reason }) => (
        <li key={`${serverId}:${name}`} className="break-words">
          {serverId} · {name.slice(`mcp__${serverId}__`.length)}: {t(`reason.${reason}`)}
        </li>
      ))}
    </ul>
  );
}

export function HarnessRoleSettings({
  role,
  nodeId,
  projectId,
}: {
  role: AgentRole;
  nodeId: string;
  projectId: string;
}) {
  const t = useTranslations('Harness'),
    r = useTranslations('Resources');
  const { harnesses: api } = useServices();
  const { editor } = useStudioStores();
  const navigation = useSettingsNavigation();
  const policyId = useId();
  const [profiles, setProfiles] = useState<HarnessProfileView[]>([]);
  const [preview, setPreview] = useState<RoleHarnessPreview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const selection = role.harness ? `${role.harness.profileId}:${role.harness.revision}` : '';
  const contextKey = JSON.stringify([
    projectId,
    nodeId,
    role.id,
    selection,
    role.skills,
    role.mcpTools,
  ]);
  const request = useRef(0);
  useEffect(() => {
    if (!api) return;
    let active = true;
    const refresh = () => {
      void api.profileManagement().then(
        (p) => active && setProfiles(p),
        () => active && setError(t('loadFailed')),
      );
    };
    refresh();
    window.addEventListener('focus', refresh);
    window.addEventListener('corral:harness-changed', refresh);
    return () => {
      active = false;
      window.removeEventListener('focus', refresh);
      window.removeEventListener('corral:harness-changed', refresh);
    };
  }, [api, t]);
  useEffect(() => {
    void contextKey;
    setPreview(null);
    setError('');
    setBusy(false);
    return () => {
      request.current += 1;
    };
  }, [contextKey]);
  if (!api) return null;
  return (
    <section className="flex flex-col gap-2 border-y border-line py-3">
      <div
        className="flex flex-col gap-1 text-caption"
        style={{ fontVariationSettings: fontWeights.semibold }}
      >
        {/* The editor's one place for the Harness term (glossary.md): after its label. */}
        <span className="flex items-center gap-1">
          <label htmlFor={policyId} data-role-policy-field>
            {t('heading')}
          </label>
          <TermHint term="harness" />
        </span>
        <Select
          id={policyId}
          label={t('heading')}
          value={selection}
          disabled={busy}
          options={[
            { value: '', label: t('basic') },
            ...(selection &&
            !profiles.some((profile) => `${profile.profileId}:${profile.revision}` === selection)
              ? [
                  {
                    value: selection,
                    label: `${role.harness?.profileId} · r${role.harness?.revision}`,
                  },
                ]
              : []),
            ...profiles
              .filter(
                (profile) =>
                  !profile.archivedAt || `${profile.profileId}:${profile.revision}` === selection,
              )
              .map((profile) => ({
                value: `${profile.profileId}:${profile.revision}`,
                label: `${profile.name} · r${profile.revision}${profile.archivedAt ? ` · ${r('archived')}` : ''}`,
              })),
          ]}
          onValueChange={(value) => {
            const profile = profiles.find(
              (profile) => `${profile.profileId}:${profile.revision}` === value,
            );
            editor.getState().updateNode(nodeId, {
              harness: profile
                ? { profileId: profile.profileId, revision: profile.revision }
                : null,
            });
          }}
        />
      </div>
      <Link
        {...navigation.link('harness', projectId)}
        className="text-caption text-primary underline"
        // Under the Harness label the link says what it does; its name keeps the whole.
        aria-label={t('manage')}
      >
        {t('manageShort')}
      </Link>
      {role.harness ? (
        <>
          <p className="text-caption text-muted-foreground">
            {t('pinned', { revision: role.harness.revision })}
          </p>
          {profiles.some(
            (profile) =>
              profile.profileId === role.harness?.profileId &&
              profile.revision > role.harness.revision,
          ) ? (
            <p className="text-caption text-warning">{r('profileOlder')}</p>
          ) : null}
        </>
      ) : null}
      {role.harness || role.skills || role.mcpTools?.length ? (
        <Button
          variant="tertiary"
          size="compact"
          disabled={busy}
          onClick={() => {
            const version = ++request.current;
            setBusy(true);
            setPreview(null);
            setError('');
            void api
              .preview(role, projectId)
              .then(
                (value) => {
                  if (version === request.current) setPreview(value);
                },
                () => {
                  if (version === request.current) setError(t('error'));
                },
              )
              .finally(() => {
                if (version === request.current) setBusy(false);
              });
          }}
        >
          {busy ? t('busy') : t('preview')}
        </Button>
      ) : null}
      {error ? (
        <p role="alert" className="text-caption text-danger">
          {error}
        </p>
      ) : null}
      {preview && !preview.snapshot && preview.problem ? (
        <RoleHarnessProblem problem={preview.problem} skills={role.skills} />
      ) : null}
      {preview && !preview.snapshot && preview.mcpProblem ? (
        <McpPreviewProblem problem={preview.mcpProblem} />
      ) : null}
      {preview?.snapshot ? (
        <>
          <p className="text-caption text-warning">
            {preview.snapshot.policy === 'trusted-native' ? t('nativeWarning') : ''}
          </p>
          <HarnessPreviewView preview={preview} />
        </>
      ) : null}
    </section>
  );
}

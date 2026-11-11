import type { ModelProfileView } from '@corral/client';
import type { HarnessBindingRef, ReasoningCapabilities, ReasoningPolicy } from '@corral/contracts';
import type { CorralSummary } from '@corral/core';
import { useEffect, useState } from 'react';
import { useServices } from '../services.tsx';
import { profileReady } from './modelReadiness.ts';

// UX-06: which model each profile means and whether it is connected, as the local server
// reports it. The in-browser demo has no profiles (its agents are simulated).

export interface ProfileInfo {
  profileId: string;
  /** A named profile, or a model of a connected provider (no profile needed). */
  source?: 'profile' | 'connection';
  provider?: string;
  providerName?: string;
  modelId?: string;
  modelName?: string | null;
  /** "OpenAI · gpt-5" */
  label: string;
  available: boolean;
  imageInput?: boolean | null;
  reasoningCapabilities?: ReasoningCapabilities | undefined;
}

const MODELS_CHANGED = 'corral:models-changed';

/** Tells open screens that sign-in or profiles changed (Settings › Models). */
export function modelsChanged() {
  window.dispatchEvent(new Event(MODELS_CHANGED));
}

export function useModelProfiles(): ProfileInfo[] | null {
  const { models } = useServices();
  const [profiles, setProfiles] = useState<ProfileInfo[] | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const again = () => setTick((n) => n + 1);
    window.addEventListener(MODELS_CHANGED, again);
    window.addEventListener('focus', again);
    return () => {
      window.removeEventListener(MODELS_CHANGED, again);
      window.removeEventListener('focus', again);
    };
  }, []);
  useEffect(() => {
    void tick;
    if (!models) return setProfiles(null);
    let live = true;
    models.profiles().then(
      (list: ModelProfileView[]) =>
        live &&
        setProfiles(
          list.map((p) => ({
            profileId: p.profileId,
            source: p.source,
            provider: p.provider,
            providerName: p.providerName,
            modelId: p.modelId,
            modelName: p.modelName,
            reasoningCapabilities: p.reasoningCapabilities,
            imageInput: p.imageInput,
            label: `${p.providerName} · ${p.modelName ?? p.modelId}`,
            available: profileReady(p),
          })),
        ),
      () => live && setProfiles(null),
    );
    return () => {
      live = false;
    };
  }, [models, tick]);
  return profiles;
}

export interface RoleModel {
  roleId: string;
  name: string;
  profileId: string;
  harness?: HarnessBindingRef;
  reasoning?: ReasoningPolicy;
}

/** The roles of a team and the model profile each one uses (saved revision). */
export function useTeamRoles(team: CorralSummary | null): RoleModel[] {
  const { repository } = useServices();
  const [roles, setRoles] = useState<RoleModel[]>([]);
  const revision = team ? `${team.corralId}:${team.definitionRevision}` : '';
  useEffect(() => {
    void revision;
    if (!team) return setRoles([]);
    let live = true;
    void repository.get(team.corralId).then(
      (record) =>
        live &&
        setRoles(
          record?.definition.roles.map((r) => ({
            roleId: r.id,
            name: r.name,
            profileId: r.modelProfile,
            ...(r.reasoning ? { reasoning: r.reasoning } : {}),
            ...(r.harness ? { harness: r.harness } : {}),
          })) ?? [],
        ),
      () => live && setRoles([]),
    );
    return () => {
      live = false;
    };
  }, [repository, team, revision]);
  return roles;
}

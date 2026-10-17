import type { ModelProfileView } from '@corral/client';
import type { HarnessBindingRef } from '@corral/contracts';
import type { CorralSummary } from '@corral/core';
import { useEffect, useState } from 'react';
import { useServices } from '../services.tsx';

// UX-06: which model each profile means and whether it is connected, as the local server
// reports it. The in-browser demo has no profiles (its agents are simulated).

export interface ProfileInfo {
  profileId: string;
  /** "OpenAI · gpt-5" */
  label: string;
  available: boolean;
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
            label: `${p.providerName} · ${p.modelName ?? p.modelId}`,
            // Ready to call: the model is known, a sign-in or key is set, and a subscription
            // sign-in may use this model.
            available:
              p.available &&
              p.method !== null &&
              !(p.method === 'oauth' && p.subscriptionSupported === false),
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

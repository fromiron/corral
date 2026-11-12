import { useEffect, useState } from 'react';
import { imageProfilesApi } from '../image-profiles-api.ts';
import { useServices } from '../services.tsx';

const CHANGED = 'corral:image-profiles-changed';

/** Tells an open team editor that an image profile was saved or removed. */
export function imageProfilesChanged() {
  window.dispatchEvent(new Event(CHANGED));
}

export interface SavedImageProfile {
  profileId: string;
  label: string;
}

/** Saved image profiles for the team editor. Null until the server answers, or outside server mode. */
export function useImageProfiles(): SavedImageProfile[] | null {
  const { mode } = useServices();
  const [profiles, setProfiles] = useState<SavedImageProfile[] | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const again = () => setTick((n) => n + 1);
    window.addEventListener(CHANGED, again);
    window.addEventListener('focus', again);
    return () => {
      window.removeEventListener(CHANGED, again);
      window.removeEventListener('focus', again);
    };
  }, []);
  useEffect(() => {
    void tick;
    if (mode !== 'server') return setProfiles(null);
    let live = true;
    imageProfilesApi.list().then(
      (view) =>
        live &&
        setProfiles(
          view.profiles.map((profile) => ({
            profileId: profile.profileId,
            label: `${profile.profileId} · ${profile.modelId}`,
          })),
        ),
      () => live && setProfiles(null),
    );
    return () => {
      live = false;
    };
  }, [mode, tick]);
  return profiles;
}

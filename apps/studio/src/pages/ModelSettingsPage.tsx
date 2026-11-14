import { Button, TabsSubtle, TabsSubtleItem } from '@corral/react/design-kit';
import { type ReactNode, useId, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useServices } from '../services.tsx';
import { ModelSettingsRefresh, useModelSettings } from '../workbench/modelSettings.tsx';
import { DecisionApiSettings } from './DecisionApiSettings.tsx';
import { EffortRoutingSettings } from './EffortRoutingSettings.tsx';
import { ImageProfileSettings } from './ImageProfileSettings.tsx';
import { LocalAiPanel } from './LocalAiPanel.tsx';
import { ModelConnections } from './ModelConnections.tsx';
import {
  ModelProfilesEditor,
  type ProfileFocus,
  type ProfileRequest,
} from './ModelProfilesEditor.tsx';
import { ModelUsagePanel } from './ModelUsagePanel.tsx';
import { SettingsLayout } from './SettingsPage.tsx';

/** The Models sub-views, in tab order. Each keeps its sections' ids for in-page links. */
const MODEL_TABS = ['connections', 'profiles', 'judgment', 'images', 'usage'] as const;

/**
 * /settings/models: the connections to model providers, the named profiles, local judgment,
 * images and usage. Sign-in happens on the provider's own page, opened by the person; no token
 * is ever sent here.
 */
export function ModelSettingsPage() {
  const t = useTranslations('Models');
  const { models, mode, live } = useServices();
  const { profiles, providers, catalog, config, refresh, error, loading, loaded } =
    useModelSettings(models);
  // A key saved or removed below changes which decision APIs the judgment can use.
  const [apiKeys, setApiKeys] = useState(0);
  const [tab, setTab] = useState(0);
  const idPrefix = `models-tabs-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  // A model made into a profile, or a profile opened, from the Connections tab.
  const [request, setRequest] = useState<ProfileRequest | null>(null);
  const [focus, setFocus] = useState<ProfileFocus | null>(null);
  const toProfiles = () => setTab(MODEL_TABS.indexOf('profiles'));
  // Every tab stays mounted while hidden, so an unsaved key, sign-in or profile edit survives a
  // tab change and the leave guard still sees it.
  const panels: Record<(typeof MODEL_TABS)[number], ReactNode> = {
    // Drawn once the lists are read, so the rows it starts with are not announced as new.
    connections: loaded ? (
      <ModelConnections
        providers={providers}
        catalog={catalog}
        profiles={profiles}
        config={config}
        onMakeProfile={(provider, model) => {
          setRequest({ provider, model, nonce: Date.now() });
          toProfiles();
        }}
        onOpenProfile={(profileId) => {
          setFocus({ profileId, nonce: Date.now() });
          toProfiles();
        }}
      />
    ) : null,
    profiles: (
      <div id="models-profiles" tabIndex={-1} className="outline-none">
        {config ? (
          <ModelProfilesEditor
            config={config}
            profiles={profiles}
            request={request}
            focus={focus}
            onRequestHandled={(nonce) =>
              setRequest((current) => (current?.nonce === nonce ? null : current))
            }
          />
        ) : null}
      </div>
    ),
    judgment: (
      <>
        <div id="models-local-ai" tabIndex={-1} className="outline-none">
          <LocalAiPanel />
        </div>
        <div id="models-effort-routing" tabIndex={-1} className="outline-none">
          <EffortRoutingSettings reloadKey={apiKeys} />
        </div>
        <div id="models-decision-apis" tabIndex={-1} className="outline-none">
          <DecisionApiSettings onChange={() => setApiKeys((count) => count + 1)} />
        </div>
      </>
    ),
    images: (
      <div id="models-images" tabIndex={-1} className="outline-none">
        <ImageProfileSettings modelProfiles={profiles} />
      </div>
    ),
    usage: <ModelUsagePanel active={tab === MODEL_TABS.indexOf('usage')} />,
  };

  return (
    <ModelSettingsRefresh value={refresh}>
      <SettingsLayout active="models">
        <main className="settings-content">
          {error ? (
            <p role="alert" className="text-danger">
              {t('loadFailed')}{' '}
              <Button onClick={() => void refresh().catch(() => {})}>{t('tryAgain')}</Button>
            </p>
          ) : null}
          {loading ? <p role="status">{t('loading')}</p> : null}
          {mode !== 'server' || !models ? (
            <p className="text-body text-muted-foreground">{t('browserOnly')}</p>
          ) : !live ? (
            <p className="text-body text-muted-foreground">{t('noLive')}</p>
          ) : (
            <>
              {/* Narrow, the strip scrolls; the kit's edge fade shows there is more beyond it. */}
              <TabsSubtle
                idPrefix={idPrefix}
                selectedIndex={tab}
                onSelect={setTab}
                aria-label={t('tabs.label')}
                className="scroll-fade-x"
              >
                {MODEL_TABS.map((id, index) => (
                  <TabsSubtleItem key={id} index={index} label={t(`tabs.${id}`)} />
                ))}
              </TabsSubtle>
              {MODEL_TABS.map((id, index) => (
                <div
                  key={id}
                  id={`${idPrefix}-panel-${index}`}
                  role="tabpanel"
                  aria-labelledby={`${idPrefix}-tab-${index}`}
                  hidden={tab !== index}
                  tabIndex={-1}
                  className="flex flex-col gap-6 outline-none"
                >
                  {panels[id]}
                </div>
              ))}
            </>
          )}
        </main>
      </SettingsLayout>
    </ModelSettingsRefresh>
  );
}

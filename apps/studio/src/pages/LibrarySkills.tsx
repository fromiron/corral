import { EmptyState } from '@corral/react/design-kit';
import { useTranslations } from 'use-intl';
import { useServices } from '../services.tsx';
import { SkillManager } from '../workbench/harness/SkillManager.tsx';
import { SettingsNavigationContext, useSettingsNavigation } from '../workbench/navigation.ts';

export function LibrarySkills({
  projectId,
  toolbar,
}: {
  projectId: string;
  toolbar: HTMLElement | null;
}) {
  const { harnesses } = useServices();
  const navigation = useSettingsNavigation();
  const t = useTranslations('Library.resources');
  if (!harnesses) return <EmptyState title={t('localOnly')} />;
  return (
    <SettingsNavigationContext.Provider
      value={{
        ...navigation,
        projectId,
        item: undefined,
        link: (section, target = projectId, item) => navigation.link(section, target, item),
      }}
    >
      <SkillManager api={harnesses} toolbar={toolbar} />
    </SettingsNavigationContext.Provider>
  );
}

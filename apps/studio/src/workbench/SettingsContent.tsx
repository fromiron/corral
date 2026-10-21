import { HarnessDefaultsPage } from '../pages/HarnessDefaultsPage.tsx';
import { HarnessSettingsPage } from '../pages/HarnessSettingsPage.tsx';
import { McpSettingsPage } from '../pages/McpSettingsPage.tsx';
import { ModelSettingsPage } from '../pages/ModelSettingsPage.tsx';
import { HookSettingsPage, SkillSettingsPage } from '../pages/ResourceSettingsPage.tsx';
import { SettingsPage } from '../pages/SettingsPage.tsx';
import { VaultSettingsPage } from '../pages/VaultSettingsPage.tsx';

/** The standalone routes and the workbench dialog use the same forms. */
export function SettingsContent({ section }: { section: string }) {
  switch (section) {
    case 'models':
      return <ModelSettingsPage />;
    case 'harness':
      return <HarnessSettingsPage />;
    case 'defaults':
      return <HarnessDefaultsPage scope="personal" />;
    case 'project-defaults':
      return <HarnessDefaultsPage scope="project" />;
    case 'skills':
      return <SkillSettingsPage />;
    case 'hooks':
      return <HookSettingsPage />;
    case 'mcp':
      return <McpSettingsPage />;
    case 'vault':
      return <VaultSettingsPage />;
    case 'workspace':
    case 'shortcuts':
    case 'about':
      return <SettingsPage section={section} />;
    default:
      return <SettingsPage section="general" />;
  }
}

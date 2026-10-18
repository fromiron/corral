import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { expect, it } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { RunRoleOverrides } from './RunRoleOverrides.tsx';

it('[TC-RSN-004-N] collapsed per-run settings do not mount hidden model and reasoning selectors', () => {
  const html = renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <RunRoleOverrides
        roles={[{ roleId: 'writer', name: 'Writer', profileId: 'luna' }]}
        profiles={null}
        value={{}}
        onChange={() => {}}
      />
    </IntlProvider>,
  );
  expect(html).toContain('Model and reasoning for this run');
  expect(html).not.toContain('role="combobox"');
});

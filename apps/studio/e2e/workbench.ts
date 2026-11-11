import { expect, type Page } from '@playwright/test';
import en from '../../../packages/react/src/messages/en.json' with { type: 'json' };

/** The labels the search helpers use, from a locale's message catalog (English by default). */
type SearchLabels = {
  Shell: { searchSessions: string };
  CommandPalette: {
    label: string;
    sessionSearch: string;
    searchText: string;
    searchTextEmpty: string;
  };
  SessionSearch: { title: string };
};

// Shared user-facing steps: start a chat directly, or explicitly choose a saved Corral.
// The team for the next turn is chosen from the composer's team chip. Teams and templates live
// in the library (/library/teams, /library/templates).

/**
 * Opens a library view from the sidebar's Library link. The link keeps the app loaded, as a
 * person moving around does (a browser demo's runs and its `?delay` last until a reload); a
 * window without the sidebar loads the view's address instead.
 */
export async function openLibrary(page: Page, view: 'Teams' | 'Templates' | 'Resources') {
  const link = page.getByTestId('app-sidebar').getByRole('link', { name: 'Library', exact: true });
  const opener = page.getByRole('button', { name: 'Show the sidebar', exact: true });
  await expect(link.or(opener).first()).toBeVisible({ timeout: 20_000 });
  if (await link.isVisible()) await link.click();
  else await page.goto(new URL(`/library/${view.toLowerCase()}`, page.url()).href);
  const tab = page
    .getByRole('tablist', { name: 'Library views', exact: true })
    // The Teams tab carries the number of saved teams.
    .getByRole('tab', { name: view === 'Teams' ? /^Teams( \d+)?$/ : view, exact: true });
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}

/** Opens the library's Teams view: for the named project, else the project opened last. */
export async function openLibraryTeams(page: Page, projectName?: string) {
  await openLibrary(page, 'Teams');
  if (!projectName) return;
  // The project filter shows once the library knows there is more than one project.
  const filter = page.getByRole('combobox', { name: 'Project', exact: true });
  const loaded = page.getByRole('main').getByRole('button', { name: 'New team', exact: true });
  await expect(filter.or(loaded).first()).toBeVisible();
  if (!(await filter.isVisible())) return;
  if ((await filter.innerText()).includes(projectName)) return;
  await filter.click();
  await page.getByRole('option', { name: projectName, exact: true }).click();
  await expect(filter).toContainText(projectName);
}

/** In the library's Teams view: makes an empty team and opens it in the editor. */
export async function newTeam(page: Page) {
  await page.getByRole('main').getByRole('button', { name: 'New team', exact: true }).click();
  await expect(page).toHaveURL(/\/corrals\/[^/]+\/edit$/);
}

/** The library's saved teams of the chosen project: the table's rows, each with its team. */
export const savedTeams = (page: Page) =>
  page
    .getByRole('table', { name: 'Saved teams', exact: true })
    .getByRole('row')
    .filter({ has: page.getByRole('button') });

/** In the library's Teams view: chooses a saved team, opening its details beside the list. */
export async function chooseTeam(page: Page, name: string) {
  await page
    .getByRole('table', { name: 'Saved teams', exact: true })
    .getByRole('button', { name, exact: true })
    .click();
  const detail = page.getByRole('region', { name: 'Team details', exact: true });
  await expect(detail.getByRole('heading', { name, exact: true })).toBeVisible();
  return detail;
}

/** From a project page: makes a Corral from a template and comes back to the project. */
export async function teamFromTemplate(page: Page, name = 'Single agent') {
  // `/` redirects to the project in the app; the project page is where this comes back to.
  await expect(page.getByRole('button', { name: 'New conversation', exact: true })).toBeVisible({
    timeout: 20_000,
  });
  const home = page.url();
  await openLibrary(page, 'Templates');
  await page.getByRole('button', { name: `Edit a copy of ${name}`, exact: true }).click();
  await page.getByRole('button', { name: 'Save copy and edit' }).click();
  await expect(page).toHaveURL(/\/edit$/);
  // Back through the library to the project, as a person would.
  for (let step = 0; step < 4 && page.url() !== home; step++) await page.goBack();
  await expect(page).toHaveURL(home);
  await expect(page.getByRole('button', { name: 'New conversation', exact: true })).toBeVisible();
}

/**
 * On a project page: starts an empty conversation from the page header (the sidebar's New
 * conversation link does the same for the project opened last).
 */
export async function newConversation(page: Page) {
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await expect(page).toHaveURL(/\/sessions\/session_/);
}

/** From any screen: the sidebar's New conversation starts one in the project opened last. */
export async function newConversationFromSidebar(page: Page) {
  await page
    .getByTestId('app-sidebar')
    .getByRole('link', { name: 'New conversation', exact: true })
    .click();
  await expect(page).toHaveURL(/\/sessions\/session_/);
}

/**
 * Opens a project's workspace: the named project, else the open one, from the top bar's path
 * (its project item is the menu that changes projects; its current entry goes home). A screen
 * outside any project names itself there instead, so the named project opens from the sidebar.
 */
export async function openProject(page: Page, name?: string) {
  const switcher = page
    .getByRole('navigation', { name: 'Current location', exact: true })
    .getByRole('button', { name: 'Go to project', exact: true });
  if (name && !(await switcher.isVisible()))
    await page.getByTestId('app-sidebar').getByRole('link', { name, exact: true }).first().click();
  else {
    await switcher.click();
    await (name
      ? page.getByRole('menuitemradio', { name, exact: true })
      : page.getByRole('menuitemradio', { checked: true })
    ).click();
  }
  await expect(page).toHaveURL(/\/projects\/[^/?#]+(?:[?#].*)?$/);
}

/** Opens All projects from the workspace menu at the top of the sidebar. */
export async function openAllProjects(page: Page) {
  await page
    .getByTestId('app-sidebar')
    .getByRole('button', { name: /^Corral menu · / })
    .click();
  await page.getByRole('menuitem', { name: 'All projects', exact: true }).click();
  await expect(page).toHaveURL(/\/projects(?:[?#].*)?$/);
}

/** Opens a project tab (Sessions, Runs, Environment, Instructions & memory) on a project page. */
export async function projectTab(page: Page, name: string) {
  const tab = page
    .getByRole('tablist', { name: 'Project views', exact: true })
    // A tab's name may carry its count (Sessions 3).
    .getByRole('tab', { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`) });
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}

/**
 * Opens the settings dialog over the current screen, optionally at a section (by its name in the
 * dialog's sidebar), and returns the dialog.
 */
export async function openSettings(page: Page, section?: string) {
  await page
    .getByTestId('app-sidebar')
    .getByRole('button', { name: 'Settings', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(dialog).toBeVisible();
  if (section) {
    await dialog
      .getByTestId('settings-sidebar')
      .getByRole('link', { name: section, exact: true })
      .click();
    await expect(
      dialog.getByRole('heading', { level: 2, name: section, exact: true }),
    ).toBeVisible();
  }
  return dialog;
}

/**
 * Opens the command palette from the sidebar's search field, which starts it on finding sessions,
 * and returns the palette and its field.
 */
export async function openSessionSearch(page: Page, m: SearchLabels = en) {
  await page
    .getByTestId('app-sidebar')
    .getByRole('textbox', { name: m.Shell.searchSessions, exact: true })
    .click();
  const palette = page.getByRole('dialog', { name: m.CommandPalette.label, exact: true });
  const input = palette.getByRole('combobox', {
    name: m.CommandPalette.sessionSearch,
    exact: true,
  });
  await expect(input).toBeFocused();
  return { palette, input };
}

/**
 * Opens the search of message and result text (server mode): the palette's last entry for what
 * was typed in it. Returns the search dialog.
 */
export async function openTextSearch(page: Page, query = '', m: SearchLabels = en) {
  const { palette, input } = await openSessionSearch(page, m);
  if (query) await input.fill(query);
  await palette
    .getByRole('option', {
      name: query
        ? m.CommandPalette.searchText.replace('{query}', query)
        : m.CommandPalette.searchTextEmpty,
    })
    .click();
  const dialog = page.getByRole('dialog', { name: m.SessionSearch.title, exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Folder linking, trust and the project's tools live in the settings dialog. */
export const openFolderSettings = (page: Page) => openSettings(page, 'Folders & tools');

/**
 * In Settings › Models: shows one of its tabs (Connections, Profiles, Local AI & judgment,
 * Images, Usage) and returns its panel.
 */
export async function modelSettingsTab(page: Page, name: string) {
  const tab = page
    .getByRole('tablist', { name: 'Model settings', exact: true })
    .getByRole('tab', { name, exact: true });
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  return page.getByRole('tabpanel', { name, exact: true });
}

/**
 * In Settings › Models: opens Add connection from the Connections tab and returns its dialog.
 * With `provider` (a name in its directory, such as `OpenAI` or `OpenAI-compatible address`),
 * picks it and returns the dialog on that provider's face, which is titled by its name.
 */
export async function addConnection(page: Page, provider?: string) {
  const panel = await modelSettingsTab(page, 'Connections');
  await panel.getByRole('button', { name: 'Add connection', exact: true }).click();
  const directory = page.getByRole('dialog', { name: 'Add connection', exact: true });
  await expect(
    directory.getByRole('textbox', { name: 'Search providers', exact: true }),
  ).toBeFocused();
  if (!provider) return directory;
  const escaped = provider.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // A row reads its name, then how it connects (and whether it is connected already).
  await directory
    .getByRole('group', { name: 'Providers', exact: true })
    .getByRole('button', { name: new RegExp(`^${escaped}(?: |$)`) })
    .click();
  const face = page.getByRole('dialog', { name: provider, exact: true });
  await expect(face).toBeVisible();
  return face;
}

/**
 * In Settings › Models: shows the Profiles tab and returns its list of named profiles, which is
 * edited in place (each row a name and a model; Save and Cancel show once something changed).
 */
export async function editModels(page: Page) {
  const panel = await modelSettingsTab(page, 'Profiles');
  const editor = panel.getByRole('region', { name: 'Profiles', exact: true });
  await expect(editor).toBeVisible();
  return editor;
}

/**
 * Chooses a model in a form's model field (a team role, a meeting participant, a run override,
 * the Markdown agent import): the field opens the searchable list of models, whose search takes
 * the focus, and the option is picked by its name (the model's name, then the profile's when it
 * differs, then Image input when that is confirmed). Returns once the list has closed.
 */
export async function chooseModel(page: Page, field: string, option: string | RegExp) {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await page.getByRole('button', { name: new RegExp(`^${escaped}: `) }).click();
  const list = page.getByRole('dialog', { name: field, exact: true });
  await expect(
    list.getByRole('combobox', { name: en.ModelSelect.search, exact: true }),
  ).toBeFocused();
  await list
    .getByRole(
      'option',
      typeof option === 'string' ? { name: option, exact: true } : { name: option },
    )
    .click();
  await expect(list).toBeHidden();
}

/** Closes the settings dialog and waits for it to leave. */
export async function closeSettings(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await dialog.getByRole('button', { name: 'Close settings', exact: true }).click();
  await expect(dialog).toBeHidden();
}

/**
 * On a project page: opens the dialog that sets a new conversation's name, purpose and team
 * before it starts (the header's New conversation menu), and returns it.
 */
export async function openConversationDetails(page: Page) {
  await page.getByRole('button', { name: 'More ways to start a conversation' }).click();
  await page.getByRole('menuitem', { name: /^Set name, purpose and team first/ }).click();
  const dialog = page.getByRole('dialog', { name: 'New conversation', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** On a project page: starts a session with this purpose and its first team. */
export async function startSession(page: Page, purpose: string) {
  await openConversationDetails(page);
  await page.getByRole('textbox', { name: 'Purpose' }).fill(purpose);
  // without a choice a session starts in auto mode; this helper keeps the first team.
  await page.getByRole('combobox', { name: 'Corral', exact: true }).click();
  await page.getByRole('option').nth(1).click();
  await page.getByRole('button', { name: 'Start chat' }).click();
  await expect(page).toHaveURL(/\/sessions\/session_/);
}

/** The mounted request box; hidden views are included for draft-preservation assertions. */
export const requestBox = (page: Page) =>
  page.getByRole('combobox', { name: 'Request', exact: true, includeHidden: true });

/** Chooses the team for the next turn from the composer's team chip. */
export async function selectSessionTeam(page: Page, name: string) {
  const picker = page
    .getByRole('region', { name: 'Request', exact: true })
    .getByRole('combobox', { name: 'Team', exact: true });
  await picker.click();
  await page.getByRole('option', { name: new RegExp(`^${name}`) }).click();
  await expect(picker).toContainText(name);
}

/** Runs a `/` command from the request box, keeping nothing else typed. */
export async function slash(page: Page, command: string) {
  const box = requestBox(page);
  await box.fill(`/${command}`);
  await expect(page.getByRole('listbox', { name: 'Commands' })).toBeVisible();
  await box.press('Enter');
}

/** Opens an existing session view, or its contextual file pane through the command palette. */
export async function panelTab(page: Page, name: string) {
  // Git, Checkpoints and Checks are sub-views of Changes, which opens on Review.
  if (['Review', 'Git', 'Checkpoints', 'Checks'].includes(name)) {
    await panelTab(page, 'Changes');
    const sub = page
      .getByRole('tablist', { name: 'Changes views', exact: true })
      .getByRole('tab', { name, exact: true });
    await sub.click();
    await expect(sub).toHaveAttribute('aria-selected', 'true');
    return;
  }
  const views = page.getByRole('tablist', { name: 'Session views', exact: true });
  // A top bar too narrow for the tabs folds them into one menu of the same name.
  const folded = page.getByRole('combobox', { name: 'Session views', exact: true });
  await expect(views.or(folded).first()).toBeVisible();
  const primary = name === 'Run' ? 'Runs' : name;
  if (['Conversation', 'Runs', 'Changes'].includes(primary)) {
    // The chosen view changes what the bar holds (a run view has no run pill), so the tabs may
    // fold or return once it opens: either way the bar names it as the current view.
    const chosen = folded
      .filter({ hasText: primary })
      .or(views.getByRole('tab', { name: primary, exact: true, selected: true }))
      .first();
    if (await folded.isVisible()) {
      await folded.click();
      // The menu always offers Conversation; once it is open, the wanted view is there or not.
      await expect(page.getByRole('option', { name: /^Conversation\b/ })).toBeVisible();
      // The Changes option may carry its count of changed files.
      const option = page.getByRole('option', { name: new RegExp(`^${primary}\\b`) });
      if (await option.count()) {
        await option.click();
        await expect(chosen).toBeVisible();
        return;
      }
      await page.keyboard.press('Escape');
    } else {
      const tab = views.getByRole('tab', { name: primary, exact: true });
      if (primary !== 'Changes' || (await tab.count())) {
        await tab.click();
        await expect(chosen).toBeVisible();
        return;
      }
    }
  }
  // File work may not have a primary tab until first opened. The palette is always reachable.
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await palette.getByRole('combobox', { name: 'Search commands' }).fill(`Open ${name}`);
  await palette
    .getByRole('option')
    .filter({ has: page.getByText(`Open ${name}`, { exact: true }) })
    .click();
}

/**
 * Chooses a run of the open session from the run segment of the top bar's path (run history),
 * where each run is named `#N · request`.
 */
export async function chooseRun(page: Page, number: number) {
  await page
    .getByRole('banner')
    .locator('button[aria-haspopup="menu"]')
    .filter({ hasText: /#\d+/ })
    .click();
  await page.getByRole('menuitemradio', { name: new RegExp(`#${number}\\b`) }).click();
}

/** Shows the run workspace's Results view: every version the run made. */
export async function showResults(page: Page) {
  await page
    .getByTestId('run-column')
    .getByRole('tablist', { name: 'Execution views' })
    .getByRole('tab', { name: 'Results', exact: true })
    .click();
  const view = page.getByTestId('run-column').locator('[data-run-workspace-view="results"]');
  await expect(view).toBeVisible();
  return view;
}

/**
 * Opens a final result from the workspace's Results view into the central document reader.
 */
export async function openResult(page: Page, name?: RegExp) {
  const view = await showResults(page);
  const final = view.getByRole('rowgroup', { name: 'Final results', exact: true });
  await (name ? final.getByRole('button', { name }) : final.getByRole('button').first()).click();
  await expect(page.getByTestId('run-document').getByTestId('run-results')).toBeVisible();
  await expect(page.getByTestId('run-side')).toBeHidden();
}

/**
 * The newest turn's run has succeeded: the composer names it as the last run. (The timeline
 * itself repeats the status in hidden kit copies, so its text is not a single target.)
 */
export function lastRunSucceeded(page: Page) {
  return page.getByRole('link', { name: /^Succeeded Last run/ });
}

/** The team editor's canvas and one of its steps. */
export const teamCanvas = (page: Page) => page.locator('[data-team-canvas]');
export const teamNode = (page: Page, nodeId: string) =>
  teamCanvas(page).locator(`[data-node="${nodeId}"]`).first();
/** The editor's settings sheet for the selection or the team. */
export const editorSettings = (page: Page) => page.getByRole('complementary', { name: 'Settings' });

/**
 * In a new team: an agent and an output after it. With the agent selected, the output is placed
 * after it and connected.
 */
export async function addAgentAndOutput(page: Page) {
  await page.getByRole('button', { name: 'Add Agent', exact: true }).click();
  await page.getByRole('button', { name: 'Add Output', exact: true }).click();
  await expect(teamCanvas(page).locator('[data-edge]')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'No problems', exact: true })).toBeVisible();
}

/** Renames the team in its settings sheet. */
export async function renameTeam(page: Page, name: string) {
  const settings = editorSettings(page);
  if (!(await settings.getByRole('heading', { name: 'Limits and criteria' }).isVisible()))
    await page.getByRole('button', { name: 'Limits and criteria', exact: true }).click();
  await settings.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
}

/**
 * The team editor after a save, as its head says it: Save is disabled, the screen-reader status
 * reads Saved, and no Unsaved changes mark shows; with `version`, the head names that version.
 */
export async function expectTeamSaved(page: Page, version?: number) {
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await expect(page.getByText('Saved', { exact: true })).toBeAttached();
  await expect(page.getByText('Unsaved changes', { exact: true })).toHaveCount(0);
  if (version !== undefined)
    await expect(page.getByTestId('revisions')).toHaveText(`Version ${version}`);
}

/** Opens the editor's test-run panel, which may already be open, and returns it. */
export async function openTestRun(page: Page) {
  const open = page.getByRole('button', { name: 'Test run', exact: true });
  const close = page.getByRole('button', { name: 'Close test run', exact: true });
  // The first page of a cold dev server can take a while.
  await expect(open.or(close)).toBeVisible({ timeout: 20_000 });
  if (await open.isVisible()) await open.click();
  const panel = page.getByRole('complementary', { name: 'Test run' });
  await expect(panel).toBeVisible();
  return panel;
}

/** Starts a test run from the editor's run panel. */
export async function startTestRun(page: Page) {
  const panel = await openTestRun(page);
  await panel.getByRole('button', { name: 'Run', exact: true }).click();
  return panel;
}

/**
 * Browser studio: imports `definition` in the library's Teams view, as a person imports a
 * .corral.json file, and opens it in the editor. `delay` paces the simulated replies of this
 * page load.
 */
export async function importTeam(page: Page, definition: unknown, delay?: number) {
  await page.goto(delay === undefined ? '/library/teams' : `/library/teams?delay=${delay}`);
  await page.locator('input[type=file]').setInputFiles({
    name: 'team.corral.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(definition)),
  });
  await expect(page).toHaveURL(/\/corrals\/[^/]+\/edit$/);
}

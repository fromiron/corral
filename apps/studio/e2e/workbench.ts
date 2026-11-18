import { expect, type Locator, type Page } from '@playwright/test';
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
    .getByRole('tab', { name: view === 'Teams' ? /^Corrals( \d+)?$/ : view, exact: true });
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}

/** Opens the library's Teams view: for the named project, else the project opened last. */
export async function openLibraryTeams(page: Page, projectName?: string) {
  await openLibrary(page, 'Teams');
  if (!projectName) return;
  // The project filter shows once the library knows there is more than one project.
  const filter = page.getByRole('combobox', { name: 'Project', exact: true });
  const loaded = page.getByRole('main').getByRole('button', { name: 'New Corral', exact: true });
  await expect(filter.or(loaded).first()).toBeVisible();
  if (!(await filter.isVisible())) return;
  if ((await filter.innerText()).includes(projectName)) return;
  await filter.click();
  await page.getByRole('option', { name: projectName, exact: true }).click();
  await expect(filter).toContainText(projectName);
}

/** In the library's Teams view: makes an empty team and opens it in the editor. */
export async function newTeam(page: Page) {
  await page.getByRole('main').getByRole('button', { name: 'New Corral', exact: true }).click();
  await expect(page).toHaveURL(/\/corrals\/[^/]+\/edit$/);
}

/** The library's saved teams of the chosen project: the table's rows, each with its team. */
export const savedTeams = (page: Page) =>
  page
    .getByRole('table', { name: 'Saved Corrals', exact: true })
    .getByRole('row')
    .filter({ has: page.getByRole('button') });

/** In the library's Teams view: chooses a saved team, opening its details beside the list. */
export async function chooseTeam(page: Page, name: string) {
  await page
    .getByRole('table', { name: 'Saved Corrals', exact: true })
    .getByRole('button', { name, exact: true })
    .click();
  const detail = page.getByRole('region', { name: 'Corral details', exact: true });
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
  await page.getByRole('menuitem', { name: /^Set name, purpose and Corral first/ }).click();
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
    .getByRole('combobox', { name: 'Corral', exact: true });
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

// The session screen (features/session-panel.md): the conversation is always on screen, and the
// panel beside it holds closable tabs (Files, Changes, Run #n, Results) with a "+" list. The
// panel is closed, beside, maximized, a drawer (no room) or withdrawn.

/** The panel beside the conversation: a region named Panel while it is on screen. */
export const sessionPanel = (page: Page) =>
  page.getByRole('region', { name: 'Panel', exact: true });

/** The panel's strip of open tabs. */
const panelStrip = (page: Page) =>
  sessionPanel(page).getByRole('tablist', { name: 'Panel tabs', exact: true });

/** One open tab of the panel by its name: Files, Changes, Results, Run #n (Run until known). */
export const panelTabNamed = (page: Page, name: string | RegExp) =>
  panelStrip(page).getByRole('tab', typeof name === 'string' ? { name, exact: true } : { name });

/** What the selected tab shows: the panel's tabpanel named after that tab. */
export const panelContent = (page: Page, name: string | RegExp) =>
  sessionPanel(page).getByRole(
    'tabpanel',
    typeof name === 'string' ? { name, exact: true } : { name },
  );

/** The top bar's panel toggle: pressed while the panel is on screen (beside, maximized, drawer). */
export const panelToggle = (page: Page) =>
  page.getByRole('banner').getByRole('button', { name: 'Show or hide the panel', exact: true });

const RUN_TAB = /^Run( #\d+)?$/;
/** The tab each item of the "+" list opens. */
const PLUS_TAB = { Files: 'Files', Changes: 'Changes', Runs: RUN_TAB, Results: 'Results' };

/** Waits until the panel's selected tab is the one named. */
async function tabSelected(page: Page, name: string | RegExp) {
  await expect(panelStrip(page).getByRole('tab', { selected: true })).toHaveAccessibleName(name);
}

/** A row of the run history: `#n · request`, or `Run #n` without one, then the run's state. */
const historyRow = (number: number) => new RegExp(`^(?:#${number} · |Run #${number}(?:, |$))`);

/**
 * Chooses from the "+" list's Runs (features/session-panel.md "+" 목록). With one run it opens
 * that run's tab. With more it lists every run, newest first, each named by its number and
 * request and its state, and the row chosen opens or selects that run's tab; without a number
 * the newest is chosen, the first row, numbered by how many runs there are.
 */
async function chooseFromRuns(page: Page, entry: Locator, run?: number) {
  await expect(entry).toBeVisible();
  const listed = (await entry.getAttribute('aria-haspopup')) !== null;
  await entry.click();
  let number = 1;
  if (listed) {
    const history = page.getByRole('menu', { name: 'Runs', exact: true });
    const rows = history.getByRole('menuitem');
    await expect(rows.first()).toBeVisible();
    const count = await rows.count();
    expect(count, 'a run history lists more than one run').toBeGreaterThan(1);
    await expect(rows.first()).toHaveAccessibleName(historyRow(count));
    number = run ?? count;
    await history.getByRole('menuitem', { name: historyRow(number) }).click();
  } else if (run !== undefined && run !== 1)
    throw new Error(`Run #${run} asked for, and the conversation has one run`);
  await tabSelected(page, `Run #${number}`);
}

/**
 * Opens a tab from the panel's "+" list: Files, Changes, Runs (one run's tab: `run` names it, the
 * newest without) or Results. A tab open already is selected. A panel not on screen is opened by
 * its toggle first; an open panel without tabs offers the same list in its body.
 */
export async function openPanelTab(
  page: Page,
  item: keyof typeof PLUS_TAB,
  { run }: { run?: number } = {},
) {
  const toggle = panelToggle(page);
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  const panel = sessionPanel(page);
  // The panel shows one of two things, never both: its open tabs, whose head holds the "+" after
  // the last tab, or no tabs, and then its body leads with the same list under one line.
  const head = panel
    .locator('[data-slot="tabs-closable"]')
    .filter({ has: page.getByRole('tablist', { name: 'Panel tabs', exact: true }) });
  const empty = panel.getByText('Nothing is open beside the conversation', { exact: true });
  await expect(head.or(empty)).toBeVisible();
  let entry: Locator;
  if (await head.isVisible()) {
    await head
      .locator('[data-slot="tabs-closable-trailing"]')
      .getByRole('button', { name: 'Open', exact: true })
      .click();
    entry = page.getByRole('menuitem', { name: item, exact: true });
  } else
    entry = empty.locator('..').getByRole('list').getByRole('button', { name: item, exact: true });
  if (item === 'Runs') return chooseFromRuns(page, entry, run);
  await entry.click();
  await tabSelected(page, PLUS_TAB[item]);
}

/**
 * Shows the folder tree: the tree column beside the selected document on a wide panel, else the
 * Files tab (features/session-panel.md 파일 탭과 트리 열).
 */
export async function showTree(page: Page) {
  const column = sessionPanel(page).getByRole('region', { name: 'Files', exact: true });
  if (await column.isVisible()) return;
  await selectPanelTab(page, 'Files');
}

/** Selects an open tab in the panel's strip. */
export async function selectPanelTab(page: Page, name: string | RegExp) {
  const tab = panelTabNamed(page, name);
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}

/**
 * Maximizes the panel with its head's button: the panel takes the work area and the conversation
 * is hidden behind it. A maximized panel is left as it is.
 */
export async function maximizePanel(page: Page) {
  const restore = sessionPanel(page).getByRole('button', { name: 'Restore panel', exact: true });
  if (!(await restore.isVisible()))
    await sessionPanel(page).getByRole('button', { name: 'Maximize panel', exact: true }).click();
  await expect(restore).toHaveAttribute('aria-pressed', 'true');
}

/** Restores a maximized panel beside the conversation with its head's button. */
export async function restorePanel(page: Page) {
  await sessionPanel(page).getByRole('button', { name: 'Restore panel', exact: true }).click();
  await expect(
    sessionPanel(page).getByRole('button', { name: 'Maximize panel', exact: true }),
  ).toHaveAttribute('aria-pressed', 'false');
}

/**
 * Closes the panel by its toggle, so the conversation has the work area to itself; the tabs stay
 * for the next open. A panel already off screen (closed, or withdrawn for want of room) is left.
 */
export async function closePanel(page: Page) {
  const toggle = panelToggle(page);
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute('aria-pressed')) === 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(sessionPanel(page)).toBeHidden();
}

/** The bottom dock under the conversation and the panel (session-panel.md 하단 도크). */
export const bottomDock = (page: Page) =>
  page.getByRole('region', { name: 'Bottom dock', exact: true });
/** The top bar's button that opens and closes the bottom dock. */
export const dockToggle = (page: Page) =>
  page.getByRole('button', { name: 'Bottom dock', exact: true });

/** Opens the bottom dock with its button; an open dock is left as it is. */
export async function openDock(page: Page) {
  const toggle = dockToggle(page);
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
}

/**
 * The terminal tab's screen on screen, in the panel or the bottom dock: one terminal, its ⋯ menu
 * and what is happening to it now. Its tab says its state.
 */
export const terminalScreen = (page: Page) => page.locator('[data-terminal-tab-screen]:visible');

/** Chooses one of the terminal screen's ⋯ actions (Refresh terminals, Release input, …). */
export async function terminalAction(page: Page, name: string | RegExp) {
  await terminalScreen(page).getByRole('button', { name: 'Terminal actions', exact: true }).click();
  await page.getByRole('menuitem', { name }).click();
}

/** The tab that holds each pane the palette opens; a terminal and the debugger have their own. */
const PANE_TAB: Record<string, string | RegExp> = {
  Files: 'Files',
  Terminal: /^Terminal \d+$/,
  Tasks: 'Tasks',
  Preview: 'Tasks',
  Debug: 'Debug',
  Changes: 'Changes',
  Git: 'Changes',
  Checks: 'Changes',
  Problems: 'Changes',
  Results: 'Results',
  Run: RUN_TAB,
};

/**
 * Opens a pane with the command palette's "Open …" (Files, Terminal, Tasks, Preview, Debug,
 * Changes, Git, Checks, Problems, Results, Run): the tab that holds it opens, or is selected, with
 * that pane in front. The palette is there whatever the panel's state, with or without a folder.
 * A terminal opens where its tab is (the panel or the bottom dock, made in the dock when it has
 * none); the debugger opens in the bottom dock. Preview is the Tasks tab with Preview in front.
 * Files beside an open document on a wide panel is the tree column, not a tab of the strip.
 */
export async function openPane(page: Page, name: keyof typeof PANE_TAB) {
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await palette.getByRole('combobox', { name: 'Search commands' }).fill(`Open ${name}`);
  await palette
    .getByRole('option')
    .filter({ has: page.getByText(`Open ${name}`, { exact: true }) })
    .click();
  await expect(palette).toBeHidden();
  const tab = PANE_TAB[name] as string | RegExp;
  if (name === 'Terminal') {
    await expect(terminalScreen(page)).toBeVisible();
    return;
  }
  if (name === 'Debug') {
    await expect(
      bottomDock(page)
        .getByRole('tablist', { name: 'Bottom dock tabs', exact: true })
        .getByRole('tab', { name: 'Debug', exact: true }),
    ).toHaveAttribute('aria-selected', 'true');
    return;
  }
  if (tab === 'Files') {
    // The Files tab selected, or the tree as the column beside the document selected instead.
    const column = sessionPanel(page).getByRole('region', { name: 'Files', exact: true });
    const selected = panelStrip(page).getByRole('tab', {
      name: 'Files',
      exact: true,
      selected: true,
    });
    await expect(selected.or(column)).toBeVisible();
    return;
  }
  await tabSelected(page, tab);
  if (tab === 'Tasks') {
    // The Tasks tab's own tabs: Tasks, or Preview in front.
    const inner = name === 'Preview' ? 'Preview' : 'Tasks';
    await expect(
      panelContent(page, 'Tasks')
        .getByRole('tablist', { name: 'Tasks', exact: true })
        .getByRole('tab', { name: inner, exact: true }),
    ).toHaveAttribute('aria-selected', 'true');
  } else if (tab === 'Changes') {
    // The Changes tab: its views (Review, Git, Checkpoints, Checks), or Problems in their place.
    // Changes alone names no view: one chosen there in the meantime stays.
    const changes = panelContent(page, 'Changes');
    const views = changes.getByRole('tablist', { name: 'Changes views', exact: true });
    const problems = changes.getByRole('region', { name: 'Problems', exact: true });
    if (name === 'Problems') {
      await expect(problems).toBeVisible();
      await expect(views).toBeHidden();
    } else {
      await expect(views).toBeVisible();
      await expect(problems).toBeHidden();
      if (name !== 'Changes')
        await expect(views.getByRole('tab', { name, exact: true })).toHaveAttribute(
          'aria-selected',
          'true',
        );
    }
  }
}

/** Opens the Changes tab from "+" and one of its views (Review, Git, Checkpoints, Checks). */
export async function openChangesView(page: Page, view: string) {
  await openPanelTab(page, 'Changes');
  const tab = panelContent(page, 'Changes')
    .getByRole('tablist', { name: 'Changes views', exact: true })
    .getByRole('tab', { name: view, exact: true });
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}

/**
 * Unfolds the review's file list and returns it. Narrower than its three columns, as in the panel
 * beside the conversation, the review opens on its first changed file with the list folded into
 * its head ("2 files"), and folds it again once a file is chosen.
 */
export async function showReviewFiles(page: Page) {
  const files = page.getByRole('navigation', { name: 'Review changes', exact: true });
  const fold = files.getByRole('button', { name: /^\d+ files?$/ });
  await expect(fold).toBeVisible();
  if ((await fold.getAttribute('aria-expanded')) !== 'true') await fold.click();
  await expect(fold).toHaveAttribute('aria-expanded', 'true');
  return files;
}

/** Shows the run workspace's Results view: every version the run made. */
export async function showResults(page: Page) {
  await page
    .getByTestId('run-column')
    .getByRole('tablist', { name: 'Run views' })
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
 * The composer's activity bar (features/composer-flow.md "활동 바"). It says the run's state in
 * words only while no run row on screen does, so tests read its state from its attributes:
 * `data-run` (the presence kind), `data-live` (the session's run is going), `data-line` (what
 * the closed line says: none, summary, role, target, waiting, disconnected).
 */
export const activityBar = (page: Page) => page.getByTestId('activity-bar');

/**
 * The activity bar's closed line: what it says on screen, without its folded panel or its
 * screen-reader announcements.
 */
export const activityLine = (page: Page) =>
  activityBar(page).locator('[data-activity-bar] > div').first();

/** The session's run is going: the activity bar speaks of a live run. */
export const runGoing = (page: Page) => page.locator('[data-testid="activity-bar"][data-live]');

/** Opens the activity bar's panel, where the roles, the Todo and the run controls are. */
export async function openActivity(page: Page) {
  const toggle = activityBar(page).locator('[data-activity-toggle]');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
}

/**
 * The run controls of the open activity bar, named Reins: on the bar's line when it has nothing
 * else to say, else the panel's last row.
 */
export const runControls = (page: Page) =>
  activityBar(page).getByRole('region', { name: 'Reins', exact: true });

/** Stop in Send's place: there while the run goes and nothing is written. */
export const sendPlaceStop = (page: Page) => page.getByTestId('composer-stop');

/**
 * Stops the session's run. Stop stands in one place (composer-flow.md "활동 바"): Send's place
 * while nothing is written, the open bar's Reins controls while something is. Stop asks first
 * only while two or more executions work; when it asks, this confirms.
 */
export async function stopRun(page: Page) {
  // Something written puts Stop among the open bar's controls. A box read just after a send may
  // still hold the sent words for a moment, so the press goes to whichever place has Stop then.
  if ((await requestBox(page).inputValue()).trim()) await openActivity(page);
  await sendPlaceStop(page)
    .or(runControls(page).getByRole('button', { name: 'Stop', exact: true }))
    .first()
    .click();
  const asked = await stopConfirmation(page)
    .waitFor({ state: 'visible', timeout: 2_000 })
    .then(() => true)
    .catch(() => false);
  if (asked) await confirmStop(page);
}

/**
 * The whole-run stop's confirmation: the composer's dialog, or a run tab head's popover, both
 * named Stop the run. Its own answer carries the stop's name too, so it is found inside it.
 */
export const stopConfirmation = (page: Page) =>
  page.getByRole('dialog', { name: 'Stop the run', exact: true });

/** Confirms the whole-run stop the screen is asking about. */
export async function confirmStop(page: Page) {
  await stopConfirmation(page).getByRole('button', { name: 'Stop the run', exact: true }).click();
}

/**
 * Records `count` refused requests in the session, long enough to wrap, so the conversation
 * scrolls and a card in it can leave the screen.
 */
export async function earlierRequests(page: Page, sessionId: string, count: number) {
  await page.evaluate(
    async ({ id, count }) => {
      const { csrfToken } = await (await fetch('/api/v1/session')).json();
      for (let index = 0; index < count; index += 1) {
        await fetch(`/api/v1/sessions/${id}/entries`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-corral-csrf': csrfToken },
          body: JSON.stringify({
            intent: 'next',
            text: `Earlier request ${index + 1}. ${'Long enough to wrap over lines. '.repeat(3)}`,
            state: 'refused',
          }),
        });
      }
    },
    { id: sessionId, count },
  );
}

/** The newest turn's run has succeeded and nothing runs: the activity bar's idle summary. */
export function lastRunSucceeded(page: Page) {
  return page.locator('[data-testid="activity-bar"][data-run="succeeded"]:not([data-live])');
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

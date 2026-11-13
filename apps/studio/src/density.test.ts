import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Interface density guard: Settings › General › Interface density reaches the session's tool
// panels (workbench.md). A kit control in a tool panel takes its size from the size scope; a
// fixed small size is kept only where the kit itself puts a small control inside a larger
// layout for that role, and each such place is named below with its reason.

const root = join(import.meta.dirname, '..', '..', '..');

/** The tool panels' source files, by panel family. */
const panels: Record<string, string[]> = {
  changes: [
    'apps/studio/src/workbench/SessionChangesPanel.tsx',
    'apps/studio/src/pages/ReviewPage.tsx',
    'apps/studio/src/workbench/GitPanel.tsx',
    'apps/studio/src/workbench/GitConflicts.tsx',
    'apps/studio/src/workbench/GitHunks.tsx',
    'apps/studio/src/workbench/GitSequence.tsx',
    'apps/studio/src/workbench/CheckpointPanel.tsx',
    'apps/studio/src/workbench/ChecksView.tsx',
    'apps/studio/src/workbench/HunkActions.tsx',
    'apps/studio/src/workbench/HunkNavigator.tsx',
    'apps/studio/src/workbench/ReviewCommentForm.tsx',
    'apps/studio/src/workbench/LineRangePopover.tsx',
    'apps/studio/src/pages/LspProposals.tsx',
    'apps/studio/src/workbench/EditProposalReview.tsx',
    'apps/studio/src/pages/FilesViews.tsx',
  ],
  files: [
    'apps/studio/src/workbench/FilePanel.tsx',
    'apps/studio/src/workbench/FileTree.tsx',
    'apps/studio/src/workbench/FilePreview.tsx',
    'apps/studio/src/workbench/DocumentPanel.tsx',
    'apps/studio/src/workbench/DocumentHeader.tsx',
    'apps/studio/src/workbench/DockDocumentPanel.tsx',
    'apps/studio/src/workbench/QuickOpen.tsx',
    'apps/studio/src/workbench/ContentSearch.tsx',
    'apps/studio/src/workbench/documents/WriterHeld.tsx',
    'apps/studio/src/workbench/language/RefactorActions.tsx',
    'apps/studio/src/workbench/LanguageSupport.tsx',
    'apps/studio/src/workbench/docking/DockTopBar.tsx',
    'apps/studio/src/workbench/docking/DockWorkbench.tsx',
  ],
  dock: [
    'apps/studio/src/workbench/WorkbenchToolsPanel.tsx',
    'apps/studio/src/workbench/TerminalPanel.tsx',
    'apps/studio/src/workbench/WorkbenchTasks.tsx',
    'apps/studio/src/workbench/DeploymentTasks.tsx',
    'apps/studio/src/workbench/PreviewView.tsx',
    'apps/studio/src/workbench/PreviewFeedback.tsx',
    'apps/studio/src/workbench/PreviewLeases.tsx',
    'apps/studio/src/workbench/ServicePreview.tsx',
    'apps/studio/src/workbench/ProblemsPanel.tsx',
    'apps/studio/src/workbench/debug/DebugControls.tsx',
    'apps/studio/src/workbench/WorktreeCommandPanel.tsx',
  ],
  runs: [
    'apps/studio/src/pages/RunPage.tsx',
    'apps/studio/src/workbench/RunTaskTimeline.tsx',
    'apps/studio/src/workbench/RunTimeChart.tsx',
    'apps/studio/src/workbench/RunStatusCards.tsx',
    'apps/studio/src/workbench/RunResultVersions.tsx',
    'apps/studio/src/workbench/RunBreakpoints.tsx',
    'apps/studio/src/workbench/RunHarnessOverrides.tsx',
    'apps/studio/src/workbench/ExecutionEvidence.tsx',
    'apps/studio/src/workbench/session/SessionPanels.tsx',
    'packages/react/src/components/RunView.tsx',
    'packages/react/src/components/RunResults.tsx',
    'packages/react/src/components/RunFlowView.tsx',
    'packages/react/src/components/Timeline.tsx',
    'packages/react/src/components/ReinsPanel.tsx',
    'packages/react/src/components/ExecutionSteering.tsx',
    'packages/react/src/components/ExecutionTranscript.tsx',
    'packages/react/src/components/RunControls.tsx',
    'packages/react/src/components/RunActions.tsx',
    'packages/react/src/components/RunAgentList.tsx',
    'packages/react/src/components/WorkPlanPanel.tsx',
    'packages/react/src/components/CommandReceipts.tsx',
    'packages/react/src/components/ApprovalPanel.tsx',
    'packages/react/src/components/InteractionPanel.tsx',
    'packages/react/src/components/RequestCard.tsx',
    'packages/react/src/components/QuestionsPanel.tsx',
    'packages/react/src/components/SettingsPatchPanel.tsx',
    'packages/react/src/components/UsageInspector.tsx',
    'packages/react/src/components/RunCanvas.tsx',
    'packages/react/src/components/GraphViewport.tsx',
  ],
  meeting: [
    'apps/studio/src/pages/MeetingPage.tsx',
    'apps/studio/src/workbench/session/composer/meeting.tsx',
    'apps/studio/src/workbench/MeetingRecords.tsx',
    'apps/studio/src/workbench/MeetingEvidence.tsx',
    'apps/studio/src/workbench/MeetingDecisions.tsx',
    'apps/studio/src/workbench/MeetingHandoff.tsx',
    'apps/studio/src/workbench/MeetingParticipants.tsx',
    'apps/studio/src/workbench/MeetingDiagnostics.tsx',
  ],
  conversation: [
    'apps/studio/src/workbench/session/Composer.tsx',
    'apps/studio/src/workbench/session/composer/ComposerNotices.tsx',
    'apps/studio/src/workbench/session/composer/ComposerTools.tsx',
    'apps/studio/src/workbench/session/composer/dialogs.tsx',
    'apps/studio/src/workbench/session/ComposerQueue.tsx',
    'apps/studio/src/workbench/session/ComposerStatus.tsx',
    'apps/studio/src/workbench/session/SessionEntries.tsx',
    'apps/studio/src/workbench/ChatView.tsx',
    'apps/studio/src/workbench/RunMessage.tsx',
    'apps/studio/src/workbench/TurnProcess.tsx',
    'apps/studio/src/workbench/RunRow.tsx',
    'apps/studio/src/workbench/MessageBranch.tsx',
    'apps/studio/src/workbench/RefusalHelp.tsx',
    'apps/studio/src/workbench/RunChanges.tsx',
    'apps/studio/src/workbench/TextAttachments.tsx',
    'apps/studio/src/workbench/ImageAttachments.tsx',
    'apps/studio/src/workbench/context/ContextAttachments.tsx',
    'apps/studio/src/workbench/widgets/ChatWidgets.tsx',
    'apps/studio/src/workbench/widgets/OverviewWidgets.tsx',
    'apps/studio/src/workbench/ArchivedSessionNotice.tsx',
    'apps/studio/src/workbench/WorkFolderNotice.tsx',
    'apps/studio/src/workbench/ProjectMaterials.tsx',
    'apps/studio/src/workbench/LiveVoice.tsx',
    'apps/studio/src/workbench/DevelopmentMode.tsx',
    'apps/studio/src/workbench/TerminalWriterNotice.tsx',
    'packages/react/src/components/CopyTextButton.tsx',
  ],
};

/**
 * The places that stay small on purpose, each with the kit recipe it follows. `near` is matched
 * against the control's own JSX element.
 */
const keptSmall: { file: string; near: RegExp }[] = [
  // A badge inside a menu row, as the kit puts badges inside buttons.
  { file: 'apps/studio/src/workbench/SessionChangesPanel.tsx', near: /<Badge size="sm"/ },
  // A file row's provenance badge: the kit DiffReview's file rows carry compact badges.
  { file: 'apps/studio/src/pages/ReviewPage.tsx', near: /provenance\./ },
  // The target chip in the quick open field: the kit CommandMenu keeps its field chips compact.
  { file: 'apps/studio/src/workbench/QuickOpen.tsx', near: /id=\{targetId\}/ },
  // The run header's actions and the run side panel's close: the kit AgentRun screen keeps its
  // header's Stop, Run options and side panel toggle, and its side panel's close, compact.
  { file: 'apps/studio/src/pages/RunPage.tsx', near: /'closeDetails'/ },
  { file: 'apps/studio/src/pages/RunPage.tsx', near: /ref=\{detailsButton\}/ },
  { file: 'apps/studio/src/pages/RunPage.tsx', near: /run-respond/ },
  { file: 'apps/studio/src/pages/RunPage.tsx', near: /onOpenExecution\(failedExecution\)/ },
  // An approval's decision row: the kit permission card and the kit AgentRun side panel's
  // approval card keep Reject and Approve compact.
  { file: 'packages/react/src/components/ApprovalPanel.tsx', near: /<SizeScope size="compact">/ },
  // A question's and an extension prompt's answer row: the same request card, so the same row.
  { file: 'packages/react/src/components/RequestCard.tsx', near: /<SizeScope size="compact">/ },
  // The approval card's subject chips sit in a line of caption text above that row; a chip
  // larger than the decision it leads to reads as the main action.
  { file: 'packages/react/src/components/ApprovalPanel.tsx', near: /onOpenArtifact\(id\)/ },
  // The meeting records panel's head, as the kit AgentRun side panel's head.
  { file: 'apps/studio/src/workbench/MeetingRecords.tsx', near: /onWiden/ },
  { file: 'apps/studio/src/workbench/MeetingRecords.tsx', near: /'closeRecords'/ },
  // Map zoom controls over the run graph, as the kit canvas screen's zoom controls.
  { file: 'packages/react/src/components/GraphViewport.tsx', near: /labels\.zoomIn/ },
  { file: 'packages/react/src/components/GraphViewport.tsx', near: /labels\.zoomOut/ },
  { file: 'packages/react/src/components/GraphViewport.tsx', near: /labels\.fit/ },
  // The meeting's top bar actions: the kit path bar keeps its actions compact.
  { file: 'apps/studio/src/pages/MeetingPage.tsx', near: /ref=\{recordsToggle\}/ },
  { file: 'apps/studio/src/pages/MeetingPage.tsx', near: /'sessionActions'/ },
  // The meeting composer's action row: the kit composer's slot controls are compact.
  { file: 'apps/studio/src/workbench/session/composer/meeting.tsx', near: /'attachmentActions'/ },
  {
    file: 'apps/studio/src/workbench/session/composer/meeting.tsx',
    near: /variant="tertiary" onClick=\{onStop\}/,
  },
  {
    file: 'apps/studio/src/workbench/session/composer/meeting.tsx',
    near: /size="compact"\s+variant="ghost"/,
  },
  // Narrow, Stop and the plan request are the kit composer's icon slot controls.
  {
    file: 'apps/studio/src/workbench/session/composer/meeting.tsx',
    near: /aria-label=\{t\('stopRound'\)\}/,
  },
  {
    file: 'apps/studio/src/workbench/session/composer/meeting.tsx',
    near: /aria-label=\{t\('summarise'\)\}/,
  },
  // An icon button inside a chip.
  { file: 'apps/studio/src/workbench/session/composer/meeting.tsx', near: /'removeEvidence'/ },
  {
    file: 'apps/studio/src/workbench/session/composer/ComposerNotices.tsx',
    near: /'removeReference'/,
  },
  { file: 'apps/studio/src/workbench/TextAttachments.tsx', near: /'removeQuote'/ },
  // The request composer's action row: the kit composer's slot controls are compact.
  {
    file: 'apps/studio/src/workbench/session/composer/ComposerTools.tsx',
    near: /'attachmentActions'/,
  },
  { file: 'apps/studio/src/workbench/session/composer/ComposerTools.tsx', near: /'workFolder'/ },
  { file: 'apps/studio/src/workbench/WorkFolderNotice.tsx', near: /working-copy-chip/ },
  { file: 'apps/studio/src/workbench/LiveVoice.tsx', near: /ref=\{trigger\}/ },
  // The copy button over a code block: an icon button inside a field.
  { file: 'packages/react/src/components/CopyTextButton.tsx', near: /code \?/ },
];

/**
 * Fixed kit sizes, also inside a size expression: the compact steps and their legacy names, and
 * the adapter Select's `sm`, which pins the default step.
 */
const fixedSize =
  /\bsize=(?:"|\{[^}]*')(?:compact|icon-compact|sm|xs|icon-sm|icon-xs|sm-multiline|icon-tiny|micro|icon-micro)(?:"|'[^}]*\})|useSize\('compact'\)|typeClasses\.compact/g;

/** The JSX element a match sits in, from its `<` to the `>` that closes the opening tag. */
function element(body: string, index: number): string {
  let start = body.lastIndexOf('<', index);
  while (start > 0 && !/[A-Za-z]/.test(body[start + 1] ?? ''))
    start = body.lastIndexOf('<', start - 1);
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < body.length; i++) {
    const c = body[i] as string;
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) return body.slice(start, i + 1);
  }
  return body.slice(start, index);
}

/** Markdown prose takes a reading size (chat, reader, compact), not a control size. */
const prose = /^<(?:SafeMarkdown|MessageBody)\b/;

function fixedSizes(file: string, body: string) {
  return [...body.matchAll(fixedSize)]
    .map((match) => ({
      file,
      line: body.slice(0, match.index).split('\n').length,
      size: match[0],
      element: match[0].startsWith('size') ? element(body, match.index) : match[0],
    }))
    .filter((place) => !prose.test(place.element));
}

const found = Object.values(panels)
  .flat()
  .flatMap((file) => fixedSizes(file, readFileSync(join(root, file), 'utf8')));
const kept = (place: { file: string; element: string }) =>
  keptSmall.find((entry) => entry.file === place.file && entry.near.test(place.element));

describe('interface density guard', () => {
  it('passes no fixed size to a tool panel control outside the named exceptions', () => {
    expect(
      found.filter((place) => !kept(place)).map((p) => `${p.file}:${p.line}: ${p.size}`),
    ).toEqual([]);
  });

  it('names each exception once, and every named exception still exists', () => {
    for (const entry of keptSmall)
      expect(
        found.filter((place) => place.file === entry.file && entry.near.test(place.element)),
        `${entry.file} ${entry.near}`,
      ).toHaveLength(1);
  });

  it('finds a fixed size on a multi-line element, in a render prop and in an expression', () => {
    const body = [
      '<Button',
      '  variant="ghost"',
      '  size="compact"',
      '  onClick={() => go(a > b)}',
      '>',
      '<MenuTrigger render={<Button size="icon-compact" aria-label={t("more")} />} />',
      "const label = useSize('compact').type;",
      "<Button size={code ? 'icon-compact' : 'icon'} />",
      '<Button size="icon" />',
      '<Select size="sm" />',
      "<SafeMarkdown text={text} size={sessionId ? 'chat' : 'compact'} />",
    ].join('\n');
    expect(fixedSizes('x.tsx', body).map((p) => [p.line, p.size, p.element])).toEqual([
      [
        3,
        'size="compact"',
        '<Button\n  variant="ghost"\n  size="compact"\n  onClick={() => go(a > b)}\n>',
      ],
      [6, 'size="icon-compact"', '<Button size="icon-compact" aria-label={t("more")} />'],
      [7, "useSize('compact')", "useSize('compact')"],
      [
        8,
        "size={code ? 'icon-compact' : 'icon'}",
        "<Button size={code ? 'icon-compact' : 'icon'} />",
      ],
      [10, 'size="sm"', '<Select size="sm" />'],
    ]);
  });
});

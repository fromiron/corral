import { type CheckPlan, type Receipt } from '@corral/contracts';
import { fireEvent, render, screen } from '@testing-library/react';
import { IntlProvider } from 'use-intl';
import { expect, it, vi } from 'vitest';
import { ApprovalPanel } from '../src/components/ApprovalPanel.tsx';
import messages from '../src/messages/en.json' with { type: 'json' };
import { projectionWith, sessionStore } from '../src/stories/fixtures.tsx';

const plan: CheckPlan={commandId:'types',name:'Type check',argv:['node','check.mjs'],timeoutMs:10000,configRevision:2,fingerprint:'a'.repeat(64),tree:'b'.repeat(40),trusted:false};
function setup(text: string | null) {
  const resolveApproval=vi.fn(async()=>({status:'applied'}) as Receipt);
  const session=sessionStore({
    projection:projectionWith({status:'awaiting_user',approvals:{approval_check:{approvalId:'approval_check',kind:'user_action',subjectVersionIds:['check_body'],criteriaVersionId:null,status:'pending',tool:{executionId:'exec_1',attemptNo:2,effectId:'effect_1',toolCallId:'tool_1',bodyRef:'check_body',fingerprint:plan.fingerprint,targetTree:plan.tree,deadline:'2099-10-18T00:00:00.000Z'}}}}),
    artifactTexts:{check_body:text},resolveApproval,
  });
  render(<IntlProvider locale="en" messages={messages} timeZone="UTC"><ApprovalPanel session={session} onOpenArtifact={()=>{}} /></IntlProvider>);
  return resolveApproval;
}
it('[TC-HAR-012-H] shows the exact check command, revision and fingerprint before one-time approval', async()=>{
  const decide=setup(JSON.stringify(plan));
  expect(await screen.findByText('node check.mjs')).toBeVisible();
  expect(screen.getByText(/Type check/)).toBeVisible();
  fireEvent.click(screen.getByRole('button',{name:'Run this check once'}));
  await vi.waitFor(()=>expect(decide).toHaveBeenCalledWith('approval_check','approve'));
});
it('[TC-HAR-012-N] missing or mismatched approval details cannot be approved blindly', async()=>{
  setup(JSON.stringify({...plan,fingerprint:'c'.repeat(64)}));
  expect(await screen.findByRole('button',{name:'Run this check once'})).toBeDisabled();
  expect(await screen.findByText('Check details could not be verified. Dismiss this request and try again.')).toBeVisible();
});

import {
  Button,
  cn,
  fontWeights,
  KitBadge,
  TabItem,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TabPanel,
  Tabs,
  TabsList,
  useShape,
} from '@corral/react/design-kit';
import { ArrowRight, Check, Globe, MessageSquare } from '@corral/react/icons';
import type { ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import { BROWSER_STEPS, type BrowserStep, SAMPLE_BROWSER } from './fixture.ts';
import { useSample } from './labels.ts';
import { Simulated, SimulatedResult, useRunName } from './parts.tsx';
import { SampleScreenshot } from './SampleScreenshot.tsx';
import { runBrowserStep, showBrowserStep, usePreview } from './store.ts';

// Browser QA preview: open a page, snapshot it, act, read the console, take a screenshot and
// attach it to a conversation. Every step is drawn from the fixture; nothing opens a page, and the
// attachment stays in this preview (the real composer is never touched).

export function BrowserQaPreview() {
  const t = useTranslations('FeaturePreview.browser');
  const { progress, step } = usePreview((state) => state.browser);
  return (
    <Tabs
      value={step}
      onValueChange={(value) => showBrowserStep(value as BrowserStep)}
      className="grid gap-6"
    >
      <div className="max-w-full overflow-x-auto">
        <TabsList aria-label={t('steps')}>
          {BROWSER_STEPS.map((item, index) => (
            <TabItem
              key={item}
              value={item}
              label={t(`step.${item}`)}
              disabled={index > progress}
              {...(index < progress ? { icon: Check } : {})}
            />
          ))}
        </TabsList>
      </div>
      {BROWSER_STEPS.map((item, index) => {
        const next = BROWSER_STEPS[index + 1];
        return (
          <TabPanel key={item} value={item} className="grid gap-4">
            <StepBody step={item} done={index < progress} />
            {next && index < progress ? (
              <div>
                <Button variant="primary" onClick={() => showBrowserStep(next)}>
                  {t('next', { step: t(`step.${next}`) })}
                  <ArrowRight aria-hidden />
                </Button>
              </div>
            ) : null}
          </TabPanel>
        );
      })}
    </Tabs>
  );
}

/** A step's action; once done, its simulated result in its place. */
function Run({ step, done, label }: { step: BrowserStep; done: boolean; label: string }) {
  if (done) return null;
  return (
    <div>
      <Button variant="secondary" onClick={() => runBrowserStep(step)}>
        {label}
      </Button>
    </div>
  );
}

function StepBody({ step, done }: { step: BrowserStep; done: boolean }) {
  switch (step) {
    case 'open':
      return <OpenStep done={done} />;
    case 'snapshot':
      return <SnapshotStep done={done} />;
    case 'act':
      return <ActStep done={done} />;
    case 'console':
      return <ConsoleStep done={done} />;
    case 'screenshot':
      return <ScreenshotStep done={done} />;
    case 'attach':
      return <AttachStep done={done} />;
  }
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1">
      <span className="text-caption text-muted-foreground">{label}</span>
      <div className="flex min-w-0 items-center gap-1.5 text-body text-foreground">{children}</div>
    </div>
  );
}

function OpenStep({ done }: { done: boolean }) {
  const t = useTranslations('FeaturePreview.browser');
  return (
    <>
      <Field label={t('address')}>
        <Globe aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <code className="min-w-0 font-mono [overflow-wrap:anywhere]">{SAMPLE_BROWSER.url}</code>
      </Field>
      <Run step="open" done={done} label={t('openPage')} />
      {done ? (
        <SimulatedResult>{t('opened', { title: SAMPLE_BROWSER.title })}</SimulatedResult>
      ) : null}
    </>
  );
}

function SnapshotStep({ done }: { done: boolean }) {
  const t = useTranslations('FeaturePreview.browser');
  if (!done) return <Run step="snapshot" done={done} label={t('takeSnapshot')} />;
  return (
    <>
      <SimulatedResult>
        {t('snapshotTaken', { count: SAMPLE_BROWSER.snapshot.length })}
      </SimulatedResult>
      <div className="max-w-full overflow-x-auto">
        <Table aria-label={t('snapshot')}>
          <TableHeader>
            <TableRow>
              <TableHead>{t('ref')}</TableHead>
              <TableHead>{t('role')}</TableHead>
              <TableHead>{t('name')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {SAMPLE_BROWSER.snapshot.map((node, index) => (
              <TableRow key={node.ref} index={index}>
                <TableCell>
                  <code className="font-mono">{node.ref}</code>
                </TableCell>
                <TableCell>
                  <code className="font-mono">{node.role}</code>
                </TableCell>
                <TableCell className="text-foreground">{node.name}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}

function ActStep({ done }: { done: boolean }) {
  const t = useTranslations('FeaturePreview.browser');
  const say = useSample();
  const target = (ref: string) => SAMPLE_BROWSER.snapshot.find((node) => node.ref === ref);
  return (
    <>
      {done ? (
        <SimulatedResult>
          {t('actionsRan', { count: SAMPLE_BROWSER.actions.length })}
        </SimulatedResult>
      ) : null}
      <div className="max-w-full overflow-x-auto">
        <Table aria-label={t('plan')} className="min-w-xl">
          <TableHeader>
            <TableRow>
              <TableHead>{t('action')}</TableHead>
              <TableHead>{t('target')}</TableHead>
              <TableHead>{t('result')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {SAMPLE_BROWSER.actions.map((action, index) => (
              <TableRow key={action.id} index={index}>
                <TableCell className="text-foreground">
                  {action.verb === 'fill'
                    ? t('verb.fill', { value: action.value })
                    : t('verb.click')}
                </TableCell>
                <TableCell>
                  <code className="font-mono">{action.ref}</code> {target(action.ref)?.name}
                </TableCell>
                {/* The step's summary above carries the one simulation mark for these rows. */}
                <TableCell>{done ? say(action.result) : null}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <Run step="act" done={done} label={t('runActions')} />
    </>
  );
}

function ConsoleStep({ done }: { done: boolean }) {
  const t = useTranslations('FeaturePreview.browser');
  if (!done) return <Run step="console" done={done} label={t('readConsole')} />;
  const count = (level: 'error' | 'warning') =>
    SAMPLE_BROWSER.console.filter((line) => line.level === level).length;
  return (
    <>
      <SimulatedResult>
        {t('consoleRead', { errors: count('error'), warnings: count('warning') })}
      </SimulatedResult>
      <div className="max-w-full overflow-x-auto">
        <Table aria-label={t('console')} className="min-w-xl">
          <TableHeader>
            <TableRow>
              <TableHead>{t('level')}</TableHead>
              <TableHead>{t('message')}</TableHead>
              <TableHead>{t('source')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {SAMPLE_BROWSER.console.map((line, index) => (
              <TableRow key={line.source} index={index}>
                <TableCell>
                  <KitBadge
                    variant="dot"
                    size="compact"
                    color={line.level === 'error' ? 'red' : 'amber'}
                  >
                    {t(`levels.${line.level}`)}
                  </KitBadge>
                </TableCell>
                <TableCell className="font-mono text-caption text-foreground">
                  {line.message}
                </TableCell>
                <TableCell>
                  <code className="font-mono text-caption">{line.source}</code>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}

function ScreenshotStep({ done }: { done: boolean }) {
  const t = useTranslations('FeaturePreview.browser');
  const shape = useShape();
  if (!done) return <Run step="screenshot" done={done} label={t('takeScreenshot')} />;
  const { name, width, height } = SAMPLE_BROWSER.screenshot;
  return (
    <figure className="m-0 grid max-w-3xl gap-2">
      <div className={cn('overflow-hidden border border-border', shape.container)}>
        <SampleScreenshot label={t('screenshot')} />
      </div>
      <figcaption>
        <SimulatedResult>{t('screenshotTaken', { name, width, height })}</SimulatedResult>
      </figcaption>
    </figure>
  );
}

function AttachStep({ done }: { done: boolean }) {
  const t = useTranslations('FeaturePreview.browser');
  const runName = useRunName();
  const shape = useShape();
  return (
    <>
      <Field label={t('conversation')}>
        <MessageSquare aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 [overflow-wrap:anywhere]">{runName(SAMPLE_BROWSER.linked)}</span>
      </Field>
      <div className="grid gap-1">
        <span className="text-caption text-muted-foreground">{t('attachment')}</span>
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <div className={cn('w-24 shrink-0 overflow-hidden border border-border', shape.item)}>
            <SampleScreenshot />
          </div>
          <span
            className="min-w-0 font-mono text-caption text-foreground [overflow-wrap:anywhere]"
            style={{ fontVariationSettings: fontWeights.normal }}
          >
            {SAMPLE_BROWSER.screenshot.name}
          </span>
          {done ? <Simulated>{t('attached')}</Simulated> : null}
        </div>
      </div>
      <Run step="attach" done={done} label={t('attach')} />
    </>
  );
}

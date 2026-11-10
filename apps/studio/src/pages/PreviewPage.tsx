import {
  Banner,
  BannerActions,
  BannerTitle,
  Button,
  fontWeights,
  Page,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@corral/react/design-kit';
import { ArrowLeft, Eye, LayoutGrid, RefreshCw } from '@corral/react/icons';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { BrowserQaPreview } from '../feature-preview/BrowserQaPreview.tsx';
import { PullReviewPreview } from '../feature-preview/PullReviewPreview.tsx';
import { resetPreviews, selectPull, usePreview } from '../feature-preview/store.ts';
import { TaskBoardPreview } from '../feature-preview/TaskBoardPreview.tsx';
import { workHref } from '../workbench/navigation.ts';
import { TopbarCrumb } from '../workbench/TopbarSlot.tsx';

// Feature previews: sample flows with no real calls (docs/specs/features/feature-preview.md).

export const PREVIEW_FEATURES = ['task-board', 'pr-review', 'browser-qa'] as const;
export type PreviewFeature = (typeof PREVIEW_FEATURES)[number];

/** A known preview, or undefined so the screen shows the list. */
export function previewFeature(value: unknown): PreviewFeature | undefined {
  return PREVIEW_FEATURES.find((feature) => feature === value);
}

export interface PreviewSearch {
  returnTo?: string;
}

export function validatePreviewSearch(search: Record<string, unknown>): PreviewSearch {
  const returnTo = workHref(search.returnTo);
  return returnTo ? { returnTo } : {};
}

/** The catalog key of each preview's name and summary. */
const FEATURE_KEY = {
  'task-board': 'taskBoard',
  'pr-review': 'prReview',
  'browser-qa': 'browserQa',
} as const satisfies Record<PreviewFeature, string>;

export function PreviewPage({ feature }: { feature?: string | undefined }) {
  const current = previewFeature(feature);
  const returnTo = workHref(
    useRouterState({
      select: (state) => (state.location.search as Record<string, unknown>).returnTo,
    }),
  );
  return (
    <main data-preview-feature={current} className="flex min-h-0 flex-1 flex-col">
      <SampleBanner feature={current} returnTo={returnTo} />
      <div className="min-h-0 flex-1">
        {current ? (
          <FeaturePreviewView feature={current} returnTo={returnTo} />
        ) : (
          <PreviewList returnTo={returnTo} />
        )}
      </div>
    </main>
  );
}

/** Sticks to the top of every preview screen, with Reset and the ways out. */
function SampleBanner({
  feature,
  returnTo,
}: {
  feature: PreviewFeature | undefined;
  returnTo: string | undefined;
}) {
  const t = useTranslations('FeaturePreview');
  const navigate = useNavigate();
  return (
    <Banner
      variant="fixed"
      role="note"
      size="compact"
      icon={Eye}
      className="border-b border-border"
      // Nothing scrolls under the bar, so it shows the surface it sits on (the kit inset beside
      // the sidebar) rather than the fixed bar's floor-coloured base.
      style={{ backgroundColor: 'transparent' }}
    >
      <BannerTitle>{t('sample')}</BannerTitle>
      <BannerActions>
        {feature ? (
          <>
            <Button variant="tertiary" size="compact" onClick={resetPreviews}>
              <RefreshCw aria-hidden />
              {t('reset')}
            </Button>
            <Button
              variant="ghost"
              size="compact"
              render={<Link to="/preview" search={returnTo ? { returnTo } : {}} />}
            >
              <LayoutGrid aria-hidden />
              {t('allPreviews')}
            </Button>
          </>
        ) : null}
        {returnTo ? (
          <Button variant="ghost" size="compact" onClick={() => void navigate({ href: returnTo })}>
            <ArrowLeft aria-hidden />
            {t('back')}
          </Button>
        ) : null}
      </BannerActions>
    </Banner>
  );
}

function PreviewList({ returnTo }: { returnTo: string | undefined }) {
  const t = useTranslations('FeaturePreview');
  return (
    <Page title={t('title')}>
      <Table aria-label={t('list')}>
        <TableHeader>
          <TableRow>
            <TableHead>{t('name')}</TableHead>
            <TableHead>
              <span className="sr-only">{t('actions')}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {PREVIEW_FEATURES.map((feature, index) => {
            const name = t(`feature.${FEATURE_KEY[feature]}`);
            return (
              <TableRow key={feature} index={index}>
                <TableCell>
                  <span className="block text-foreground">{name}</span>
                  <span className="block text-caption">{t(`summary.${FEATURE_KEY[feature]}`)}</span>
                </TableCell>
                <TableCell className="w-px text-right">
                  <Button
                    variant="ghost"
                    size="compact"
                    aria-label={t('openNamed', { name })}
                    render={
                      <Link
                        to="/preview/$feature"
                        params={{ feature }}
                        search={returnTo ? { returnTo } : {}}
                      />
                    }
                  >
                    {t('open')}
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Page>
  );
}

function FeaturePreviewView({
  feature,
  returnTo,
}: {
  feature: PreviewFeature;
  returnTo: string | undefined;
}) {
  const t = useTranslations('FeaturePreview');
  const navigate = useNavigate();
  // Reset starts the flow over: its view state and its clock with the store.
  const resets = usePreview((state) => state.resets);
  const name = t(`feature.${FEATURE_KEY[feature]}`);
  return (
    <>
      <TopbarCrumb>
        <span aria-hidden="true" className="text-muted-foreground">
          /
        </span>
        {/* The shell's crumb already marks the current page. */}
        <span
          className="min-w-0 truncate px-2 text-foreground"
          style={{ fontVariationSettings: fontWeights.semibold }}
        >
          {name}
        </span>
      </TopbarCrumb>
      <Page title={name} key={`${feature}:${resets}`}>
        {feature === 'task-board' ? (
          <TaskBoardPreview
            onOpenPull={(number) => {
              selectPull(number);
              void navigate({
                to: '/preview/$feature',
                params: { feature: 'pr-review' },
                search: returnTo ? { returnTo } : {},
              });
            }}
          />
        ) : feature === 'pr-review' ? (
          <PullReviewPreview />
        ) : (
          <BrowserQaPreview />
        )}
      </Page>
    </>
  );
}

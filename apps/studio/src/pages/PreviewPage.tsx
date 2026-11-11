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
import { resetPreviews, usePreview } from '../feature-preview/store.ts';
import { workHref } from '../workbench/navigation.ts';
import { TopbarCrumb } from '../workbench/TopbarSlot.tsx';

// Feature previews: sample flows with no real calls (docs/specs/features/feature-preview.md).

export const PREVIEW_FEATURES = ['pr-review', 'browser-qa'] as const;
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

/** The catalog key of each preview's name. */
const FEATURE_KEY = {
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
        {current ? <FeaturePreviewView feature={current} /> : <PreviewList returnTo={returnTo} />}
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
        {/* One column: its header is for the table's reader, not a label over the names. */}
        <TableHeader className="sr-only">
          <TableRow>
            <TableHead>{t('name')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {PREVIEW_FEATURES.map((feature, index) => (
            <TableRow key={feature} index={index}>
              <TableCell>
                {/* The row is the link: the name stretches over it for the pointer. */}
                <Link
                  to="/preview/$feature"
                  params={{ feature }}
                  search={returnTo ? { returnTo } : {}}
                  className="block w-full truncate rounded-sm text-foreground after:absolute after:inset-0 after:content-['']"
                >
                  {t(`feature.${FEATURE_KEY[feature]}`)}
                </Link>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Page>
  );
}

function FeaturePreviewView({ feature }: { feature: PreviewFeature }) {
  const t = useTranslations('FeaturePreview');
  // Reset starts the flow over: its view state with the store.
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
        {feature === 'pr-review' ? <PullReviewPreview /> : <BrowserQaPreview />}
      </Page>
    </>
  );
}

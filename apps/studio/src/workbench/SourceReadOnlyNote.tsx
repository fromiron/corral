import { Banner, BannerActions, BannerTitle, Button } from '@corral/react/design-kit';
import { Link } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';

export function SourceReadOnlyNote({ sessionId }: { sessionId: string }) {
  const tf = useTranslations('Files');
  return (
    <Banner status="info" role="note">
      <BannerTitle>{tf('noCopyReadOnly')}</BannerTitle>
      <BannerActions>
        <Button
          variant="tertiary"
          render={
            <Link to="/sessions/$sessionId" params={{ sessionId }} search={{ panel: 'changes' }} />
          }
        >
          {tf('makeCopyThere')}
        </Button>
      </BannerActions>
    </Banner>
  );
}

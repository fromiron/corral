import { Button } from '@corral/react/design-kit';
import { useTranslations } from 'use-intl';

/**
 * Links to the parts of a long settings page, so what the page manages is visible at its top
 * (#82 SET-S04). Each target keeps its own heading; focus moves to it for keyboard users.
 */
export function SectionIndex({ sections }: { sections: { id: string; label: string }[] }) {
  const t = useTranslations('Navigation');
  return (
    <nav aria-label={t('onThisPage')} className="flex flex-wrap items-center gap-1 text-xs">
      <span className="mr-1 text-muted-foreground">{t('onThisPage')}</span>
      {sections.map((section) => (
        <Button
          key={section.id}
          variant="ghost"
          size="compact"
          onClick={() => {
            const target = document.getElementById(section.id);
            target?.scrollIntoView({ block: 'start', behavior: 'smooth' });
            target?.focus({ preventScroll: true });
          }}
        >
          {section.label}
        </Button>
      ))}
    </nav>
  );
}

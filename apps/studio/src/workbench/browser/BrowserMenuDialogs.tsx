// What a browser tab's ⋯ opens for ordinary pages (features/browser-tab.md 머리, 권한, 저장소):
// the site's remembered permission answers, each with 잊기, and the question before clearing the
// project's browser data.
import {
  Button,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from '@corral/react/design-kit';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import type { BrowserBridge, SitePermission } from '../../../../desktop/src/browser-bridge.ts';
import { projectName } from '../../projects.ts';
import { useServices } from '../../services.tsx';
import { useModalConfirmation } from '../modalConfirmation.ts';

/** "사이트 권한": what this project's browser remembers for the site now open, to forget. */
export function SitePermissionsDialog({
  bridge,
  projectId,
  origin,
  onClose,
}: {
  bridge: BrowserBridge;
  projectId: string;
  /** The site now open; null closes the dialog. */
  origin: string | null;
  onClose: () => void;
}) {
  const t = useTranslations('Browser');
  const [answers, setAnswers] = useState<{ permission: SitePermission; allow: boolean }[] | null>(
    null,
  );
  useEffect(() => {
    if (!origin) return;
    let live = true;
    setAnswers(null);
    void bridge.sitePermissions(projectId, origin).then(
      (read) => {
        if (live) setAnswers(read);
      },
      () => {
        if (live) setAnswers([]);
      },
    );
    return () => {
      live = false;
    };
  }, [bridge, projectId, origin]);
  const forget = (permission: SitePermission) => {
    if (!origin) return;
    void bridge.forgetPermission(projectId, origin, permission).then(
      () => setAnswers((now) => now?.filter((answer) => answer.permission !== permission) ?? now),
      () => {},
    );
  };
  const host = origin ? hostOf(origin) : '';
  return (
    <Dialog
      open={origin !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="w-[min(95vw,420px)]">
        <DialogHeader>
          <DialogTitle>{t('sitePermissions')}</DialogTitle>
          <DialogDescription>{host}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {answers === null ? null : answers.length === 0 ? (
            <p className="text-body text-muted-foreground">{t('noPermissions')}</p>
          ) : (
            <ul className="flex flex-col">
              {answers.map((answer) => (
                <li key={answer.permission} className="flex min-h-9 items-center gap-3">
                  <span className="min-w-0 flex-1 text-body text-foreground">
                    {t(`permission.${answer.permission}`)}
                  </span>
                  <span className="text-caption text-muted-foreground">
                    {t(answer.allow ? 'allowed' : 'denied')}
                  </span>
                  <Button
                    variant="tertiary"
                    size="compact"
                    onClick={() => forget(answer.permission)}
                  >
                    {t('forget')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/**
 * "{프로젝트}의 브라우저 데이터를 지우시겠습니까?": 취소 then 지우기, the focus first on 취소. Clearing
 * empties the project's whole browser storage; the desktop reloads its open ordinary pages.
 */
export function ClearDataDialog({
  bridge,
  projectId,
  open,
  onClose,
}: {
  bridge: BrowserBridge;
  projectId: string;
  open: boolean;
  onClose: () => void;
}) {
  const t = useTranslations('Browser');
  const tp = useTranslations('Projects');
  const services = useServices();
  const cancel = useRef<HTMLButtonElement>(null);
  const [name, setName] = useState<string | null>(null);
  // While it asks, the app's shortcuts and actions are held back.
  useModalConfirmation(open);
  useEffect(() => {
    if (!open) return;
    let live = true;
    void services.repository.listProjects().then(
      (projects) => {
        if (live)
          setName(
            projectName(
              projects.find((project) => project.projectId === projectId),
              tp('defaultName'),
            ),
          );
      },
      () => {
        if (live) setName(tp('defaultName'));
      },
    );
    return () => {
      live = false;
    };
  }, [open, services, projectId, tp]);
  return (
    <Dialog
      open={open && name !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPopup initialFocus={cancel}>
        <DialogHeader>
          <DialogTitle>{t('clearTitle', { project: name ?? '' })}</DialogTitle>
          <DialogDescription>{t('clearBody')}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button ref={cancel} variant="tertiary" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              void bridge.clearProjectData(projectId).catch(() => {});
              onClose();
            }}
          >
            {t('clear')}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

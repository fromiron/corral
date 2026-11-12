import type { TextAttachment } from '@corral/contracts';
import type { CorralSummary } from '@corral/core';
import {
  Button,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  fontWeights,
} from '@corral/react/design-kit';
import { Link } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { useSettingsNavigation } from '../../navigation.ts';
import { ProjectMaterialPicker } from '../../ProjectMaterials.tsx';
import type { ProfileInfo, RoleModel } from '../../useModels.ts';

// The dialogs the composer opens: project materials, the models a request uses, and the
// confirmation before stopping a run.

/** Picks project materials as text attachments. */
export function MaterialsDialog({
  open,
  onOpenChange,
  epoch,
  projectId,
  value,
  onChange,
  onBusyChange,
  disabled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  epoch: number;
  projectId: string;
  value: TextAttachment[];
  onChange: (value: TextAttachment[]) => void;
  onBusyChange: (busy: boolean) => void;
  disabled: boolean;
}) {
  const materialMessages = useTranslations('Materials');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{materialMessages('attachPlaceholder')}</DialogTitle>
          <DialogDescription>{materialMessages('hint')}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {open ? (
            <ProjectMaterialPicker
              key={epoch}
              projectId={projectId}
              value={value}
              onChange={(next) => {
                onChange(next);
                onOpenChange(false);
              }}
              onBusyChange={onBusyChange}
              disabled={disabled}
            />
          ) : null}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

/** Which model each role uses, or the auto session's model. */
export function ModelsDialog({
  open,
  onOpenChange,
  runMode,
  team,
  roles,
  profiles,
  isAuto,
  missingTeam,
  autoModel,
  sessionId,
  serverMode,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  runMode: 'mock' | 'live';
  team: CorralSummary | null;
  roles: RoleModel[];
  profiles: ProfileInfo[] | null;
  isAuto: boolean;
  missingTeam: boolean;
  /** The auto session's model label. */
  autoModel: string;
  sessionId: string;
  serverMode: boolean;
}) {
  const t = useTranslations('Sessions');
  const tc = useTranslations('Composer');
  const navigation = useSettingsNavigation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{tc('models.title')}</DialogTitle>
          <DialogDescription>
            {runMode === 'live' ? tc('models.liveNote') : tc('models.mockNote')}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {team ? (
            <ModelAssignments roles={roles} profiles={profiles} />
          ) : (
            <p
              className="text-body text-muted-foreground"
              data-testid={isAuto ? 'auto-model' : undefined}
            >
              {missingTeam ? t('selectedTeamMissing') : `${t('autoHint')} ${autoModel}`}
            </p>
          )}
        </DialogPanel>
        <DialogFooter>
          {team ? (
            <Button
              variant="tertiary"
              render={
                <Link
                  to="/corrals/$corralId/edit"
                  params={{ corralId: team.corralId }}
                  search={{ fromSession: sessionId }}
                />
              }
            >
              {t('editTeam')}
            </Button>
          ) : null}
          {serverMode ? (
            <Button render={<Link {...navigation.link('models')} />}>
              {tc('models.settings')}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** Asks before cancelling the session's run. */
export function StopRunDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const tr = useTranslations('Reins');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{tr('cancelRun')}</DialogTitle>
          <DialogDescription>
            {tr('cancelRunExplain')} {tr('cancelNotSent')}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="tertiary" onClick={() => onOpenChange(false)}>
            {tr('keepRunning')}
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              onOpenChange(false);
              onConfirm();
            }}
          >
            {tr('confirmCancelRun')}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** Each role of the team, the model profile it uses, and whether that model is ready. */
function ModelAssignments({
  roles,
  profiles,
}: {
  roles: RoleModel[];
  profiles: ProfileInfo[] | null;
}) {
  const tc = useTranslations('Composer');
  if (!roles.length)
    return <p className="text-body text-muted-foreground">{tc('models.noTeam')}</p>;
  return (
    <ul className="flex flex-col divide-y divide-line/60 text-body" data-testid="model-assignments">
      {roles.map((role) => {
        const profile = profiles?.find((p) => p.profileId === role.profileId);
        const state = !profiles
          ? 'simulated'
          : !profile
            ? 'missing'
            : profile.available
              ? 'ready'
              : 'signin';
        return (
          <li key={role.roleId} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2">
            <span style={{ fontVariationSettings: fontWeights.semibold }}>{role.name}</span>
            <span className="font-mono text-caption text-muted-foreground">{role.profileId}</span>
            <span className="min-w-0 flex-1 text-caption text-muted-foreground">
              {profile?.label ?? ''}
            </span>
            <span
              className={`text-caption ${state === 'ready' ? 'text-success' : state === 'simulated' ? 'text-muted-foreground' : 'text-warning'}`}
            >
              {tc(`models.state.${state}`)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

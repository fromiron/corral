import { app, type BrowserWindow, dialog, type Session, type WebContents } from 'electron';
import { studioMicrophoneRequest } from './microphone-policy.ts';

/** Microphone consent belongs to one trusted Studio window/origin, never its previews. */
export function installStudioMicrophone(
  session: Session,
  current: () => { window: BrowserWindow | null | undefined; origin: string | null },
) {
  let consent: { contents: WebContents; origin: string } | undefined;
  const trusted = (contents: WebContents | null, requestingUrl: string | undefined) => {
    const target = current();
    return (
      !!contents &&
      !contents.isDestroyed() &&
      target.window?.webContents === contents &&
      !!target.origin &&
      studioMicrophoneRequest('media', contents.getURL(), target.origin, true, ['audio']) &&
      studioMicrophoneRequest('media', requestingUrl, target.origin, true, ['audio'])
    );
  };
  session.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    return (
      trusted(contents, details.requestingUrl ?? requestingOrigin) &&
      studioMicrophoneRequest(
        permission,
        details.requestingUrl ?? requestingOrigin,
        current().origin,
        details.isMainFrame,
        details.mediaType ? [details.mediaType] : undefined,
      ) &&
      consent?.contents === contents &&
      consent?.origin === current().origin
    );
  });
  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    const target = current();
    if (
      !trusted(contents, details.requestingUrl) ||
      !studioMicrophoneRequest(
        permission,
        details.requestingUrl,
        target.origin,
        details.isMainFrame,
        'mediaTypes' in details ? details.mediaTypes : undefined,
      ) ||
      !target.window ||
      !target.origin
    ) {
      callback(false);
      return;
    }
    if (consent?.contents === contents && consent.origin === target.origin) {
      callback(true);
      return;
    }
    const ko = app.getLocale().startsWith('ko');
    void dialog
      .showMessageBox(target.window, {
        type: 'question',
        title: ko ? '마이크 사용' : 'Microphone access',
        message: ko
          ? '이 Corral 창에서 마이크를 사용하도록 허용할까요?'
          : 'Allow this Corral window to use your microphone?',
        detail: ko
          ? '라이브 음성에서 선택한 연결로 오디오를 보냅니다. 통화를 끝내면 녹음을 중지합니다.'
          : 'Live voice sends audio through the connection you select. Ending the call stops recording.',
        buttons: ko ? ['허용하지 않음', '허용'] : ['Don’t allow', 'Allow'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      })
      .then(({ response }) => {
        const allowed =
          response === 1 &&
          current().origin === target.origin &&
          trusted(contents, details.requestingUrl);
        if (allowed) consent = { contents, origin: target.origin as string };
        callback(allowed);
      })
      .catch(() => callback(false));
  });
}

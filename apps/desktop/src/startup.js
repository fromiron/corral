const ko = navigator.language.startsWith('ko');
const labels = ko
  ? ['Corral 열기', '로컬 작업 공간을 여는 중…', '다시 시도', '다른 작업 공간 열기', '닫기']
  : [
      'Opening Corral',
      'Starting the local workspace…',
      'Try again',
      'Open another workspace',
      'Close',
    ];
for (const [i, id] of ['title', 'message', 'retry', 'open', 'close'].entries())
  document.getElementById(id).textContent = labels[i];
document.documentElement.lang = ko ? 'ko' : 'en';
document.getElementById('retry').onclick = () => window.corralDesktop.retry();
document.getElementById('open').onclick = () => window.corralDesktop.openWorkspace();
document.getElementById('close').onclick = () => window.corralDesktop.window('close');
async function update() {
  const info = await window.corralDesktop.info();
  if (info.cleanupFailed) {
    document.getElementById('title').textContent = ko
      ? '작업 정리가 완료되지 않았습니다'
      : 'Resource cleanup is incomplete';
    document.getElementById('message').textContent = ko
      ? '일부 자원의 종료를 확인하지 못했습니다. 이 앱은 소유권을 유지하며 작업 공간을 다시 열거나 전환하지 않습니다. 창을 닫아도 이 정리 상태는 유지됩니다.'
      : 'Some resources could not be stopped safely. This app retains ownership and will not reopen or switch workspaces. Closing this window does not resolve the cleanup failure.';
    document.getElementById('retry').disabled = true;
    document.getElementById('open').disabled = true;
    document.getElementById('actions').hidden = false;
    return;
  }
  if (info.status === 'failed') {
    document.getElementById('title').textContent = ko
      ? '작업 공간을 열지 못했습니다'
      : 'Could not open this workspace';
    document.getElementById('message').textContent = ko
      ? '다른 Corral이 사용 중이거나 접근할 수 없는 폴더일 수 있습니다. 실행 중이던 작업은 자동으로 다시 시작하지 않습니다.'
      : 'The folder may be in use or inaccessible. Interrupted runs are not resumed automatically.';
    document.getElementById('actions').hidden = false;
  }
}
void update();
setInterval(() => void update(), 1000);

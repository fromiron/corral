// The language chosen in Corral, passed by the window (#84); the system's when unknown.
const ko = (window.corralHosts?.lang ?? navigator.language).startsWith('ko');
const copy = ko
  ? {
      title: '원격 호스트',
      description:
        'SSH 설정에 등록한 호스트의 Corral에 연결합니다. 프로젝트와 자격 증명은 원격 호스트에 남습니다.',
      add: '호스트 추가 또는 다시 연결',
      name: '이름',
      alias: 'SSH 설정의 호스트 별칭',
      port: '원격 Corral 포트',
      bootstrap: '원격 시작 링크',
      bootstrapHelp:
        '원격 Corral 서버가 출력한 링크를 붙여 넣으세요. 링크는 한 번 사용하고 저장하지 않습니다.',
      save: '저장하고 연결',
      limits:
        '미리 확인한 호스트 키와 SSH 키 인증이 필요합니다. Corral과 미리보기의 포트가 로컬에서 비어 있어야 합니다. 파일과 실행은 원격 호스트에 속합니다. 연결을 끊어도 원격 실행은 계속됩니다.',
      connect: '연결',
      disconnect: '연결 끊기',
      remove: '등록 해제',
      waiting: '연결 중…',
      saved: '완료했습니다.',
      error: '요청을 완료하지 못했습니다.',
      empty: '등록된 호스트가 없습니다.',
    }
  : {
      connect: 'Connect',
      disconnect: 'Disconnect',
      remove: 'Remove',
      waiting: 'Connecting…',
      saved: 'Done.',
      error: 'Could not complete this request.',
      empty: 'No registered hosts.',
    };
document.documentElement.lang = ko ? 'ko' : 'en';
for (const element of document.querySelectorAll('[data-label]'))
  if (copy[element.dataset.label]) element.textContent = copy[element.dataset.label];
const status = document.getElementById('status');
const form = document.getElementById('form');
const hosts = document.getElementById('hosts');
const formState = () => [...form.querySelectorAll('input')].map((input) => input.value).join('\n');
let savedForm = formState();
window.addEventListener('beforeunload', (event) => {
  if (formState() !== savedForm) {
    event.preventDefault();
    event.returnValue = '';
  }
});
hosts.setAttribute('aria-label', ko ? '등록된 호스트' : 'Registered hosts');
let busy = false;
async function request(action, value) {
  if (busy) return;
  busy = true;
  status.textContent = action === 'connect' || action === 'register' ? copy.waiting : '';
  for (const button of document.querySelectorAll('button')) button.disabled = true;
  try {
    const result = await window.corralHosts.request(action, value);
    status.textContent = result.error || copy.saved;
    if (!result.error && action === 'register') {
      form.elements.bootstrapUrl.value = '';
      savedForm = formState();
    }
    await refresh();
  } catch {
    status.textContent = copy.error;
  } finally {
    busy = false;
    for (const button of document.querySelectorAll('button')) button.disabled = false;
  }
}
async function refresh() {
  const result = await window.corralHosts.request('list');
  if (result.error) {
    status.textContent = result.error;
    return;
  }
  if (result.notice) status.textContent = result.notice;
  hosts.replaceChildren();
  if (!result.hosts.length) {
    const item = document.createElement('li');
    item.textContent = copy.empty;
    hosts.append(item);
  }
  for (const host of result.hosts) {
    const item = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = `${host.name} · ${host.sshAlias}:${host.port}`;
    item.append(name);
    for (const action of [host.connected ? 'disconnect' : 'connect', 'remove']) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = copy[action];
      button.setAttribute('aria-label', `${host.name} · ${copy[action]}`);
      button.onclick = () => request(action, host.id);
      item.append(button);
    }
    hosts.append(item);
  }
}
form.addEventListener('submit', (event) => {
  event.preventDefault();
  const data = new FormData(form);
  const bootstrapUrl = String(data.get('bootstrapUrl')).trim();
  void request('register', {
    name: String(data.get('name')),
    sshAlias: String(data.get('sshAlias')),
    port: Number(data.get('port')),
    ...(bootstrapUrl ? { bootstrapUrl } : {}),
  });
});
window.addEventListener('focus', () => {
  if (!busy) void refresh();
});
void refresh();

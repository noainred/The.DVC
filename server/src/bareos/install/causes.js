/**
 * bareos/install/causes.js — 완전 설치 실패의 **원인 판정과 고치는 방법**(순수 · v2.844).
 *
 * 사용자 요청(2026-11-01): '실패하면 구체적으로 오류를 알려주고, 해당 내용을 수정해서 다시 시도할 수 있게' · '포탈에서 고치기' 채택.
 * 입력은 러너의 err 파일(cmd · code · cause · 출력 꼬리) 또는 중앙 단계 오류(code · message). 규칙에 맞으면 원인·근거·고치는 방법을,
 * 맞지 않으면 '원인 미분류' 와 출력 원문을 낸다 — **원인을 지어내지 않는다**(근거 줄 = 출력에서 실제로 맞은 줄).
 * fixes[].kind: 'portal'(포탈이 값·동작을 바꿔 그 단계부터 다시 — action 키) · 'server'(서버에서 직접 할 명령 — 복사용) · 'retry'(그대로 다시).
 * 자격증명 실패에는 자동 재시도 버튼을 두지 않는다(계정 잠금 — 루트 규칙).
 */

const MAX_OUT = 4000;

/** err 파일(러너) → { cmd, code, cause, output } */
export function parseErrFile(text) {
  const s = String(text || '');
  const i = s.indexOf('\n---\n');
  const head = i >= 0 ? s.slice(0, i) : s;
  const output = i >= 0 ? s.slice(i + 5) : '';
  const kv = Object.fromEntries(head.split('\n').map((l) => { const j = l.indexOf('='); return j > 0 ? [l.slice(0, j), l.slice(j + 1)] : null; }).filter(Boolean));
  const code = Number(kv.code);
  return { cmd: String(kv.cmd || '').slice(0, 200), code: Number.isFinite(code) ? code : null, cause: String(kv.cause || '').slice(0, 40), output: output.slice(-MAX_OUT) };
}

const R = (key, title, test, why, fixes) => ({ key, title, test, why, fixes });

/** 규칙 — 위에서부터 처음 맞은 것. test(e) → 근거 줄(문자열) 또는 null. */
const line = (re) => (e) => { const m = String(e.output || '').split('\n').find((l) => re.test(l)); return m ? m.trim().slice(0, 300) : null; };
const causeIs = (c) => (e) => (e.cause === c ? (String(e.output || '').split('\n').find((l) => l.trim()) || c).trim().slice(0, 300) : null);
const any = (...ts) => (e) => { for (const t of ts) { const r = t(e); if (r) return r; } return null; };

export const RULES = Object.freeze([
  R('ssh-auth', 'SSH 로그인 실패(저장된 계정)', (e) => (e.sshAuth ? (e.message || 'authentication failed').slice(0, 300) : null),
    '배포 등록부에 저장된 이 엣지의 SSH 비밀번호(또는 키)를 서버가 거부했습니다. 계정 잠금을 막으려고 자동으로 다시 시도하지 않습니다.',
    [{ kind: 'server', label: '배포 등록부의 SSH 계정을 고친 뒤 다시 시도', detail: '배포 › 엣지 노드에서 이 엣지의 root 비밀번호를 새로 저장하세요.' }]),
  R('busy', '같은 서버에서 다른 작업이 진행 중', causeIs('busy'),
    '같은 서버(또는 같은 Director)의 자동 설정 · 설정 변경 · 설치가 진행 중이라 시작하지 않았습니다(아무것도 바꾸지 않았습니다).',
    [{ kind: 'retry', label: '그 작업이 끝난 뒤 그대로 다시', detail: '' }]),
  R('running-jobs', 'Director 에 실행 중인 작업', causeIs('running-jobs'),
    '초기화는 실행 중인 백업·복원을 끊지 않으려고 시작하지 않았습니다(아무것도 지우지 않았습니다).',
    [{ kind: 'retry', label: '작업이 끝난 뒤 그대로 다시', detail: '진행 현황 탭에서 작업이 끝났는지 확인하세요.' }]),
  R('bundle-hash', '번들 파일이 손상됨', any(causeIs('bundle-hash'), causeIs('bundle-missing'), causeIs('bundle-broken')),
    '엣지 노드에 있는 번들의 sha256 이 포탈 값과 다르거나 파일이 없습니다(전송 중 끊김 · 디스크 오류).',
    [{ kind: 'portal', action: 'resend-bundle', label: '번들을 다시 보내고 1단계부터', detail: '포탈이 번들을 지우고 다시 전송합니다.' }]),
  R('pyvmomi-shadow', 'pyVmomi 판이 두 곳에 다름', any(causeIs('pyvmomi-shadow'), line(/Python 3\.10 or newer is required/)),
    '플러그인이 실제로 불러오는 pyVmomi 가 고른 판과 다릅니다 — Bareos 플러그인 경로(/usr/lib64/bareos/plugins)에 따로 깔린 사본이 먼저 불립니다. 9.x 면 Python 3.9 에서 플러그인이 시작하지 못합니다(문서 7.4 현장 기록).',
    [{ kind: 'portal', action: 'pyvmomi-fix', label: '플러그인 경로의 사본을 옮기고 2단계부터', detail: '지우지 않고 /var/lib/portal-bareos-install/moved/ 로 옮깁니다(되돌릴 수 있음).' },
      { kind: 'server', label: '직접 확인', commands: ['BPP=/usr/lib64/bareos/plugins', 'ls -d "$BPP"/pyVmomi* "$BPP"/pyvmomi* 2>/dev/null', 'PYTHONPATH="$BPP" python3 -c \'import pyVmomi, importlib.metadata as m; print(pyVmomi.__file__, m.version("pyvmomi"))\''] }]),
  R('dnf-lock', '다른 패키지 작업이 잠금을 쥐고 있음', line(/(another app is currently holding|Waiting for process with pid|rpmdb.*lock|Could not get lock|database is locked)/i),
    '같은 서버에서 다른 dnf/rpm 작업이 돌고 있어 설치하지 못했습니다(이 단계가 넣은 것은 되돌렸습니다).',
    [{ kind: 'retry', label: '잠시 뒤 그대로 다시', detail: '' }, { kind: 'server', label: '직접 확인', commands: ['ps -ef | grep -E "dnf|yum|rpm" | grep -v grep'] }]),
  R('disk-full', '디스크 공간 부족', line(/No space left on device|Disk Requirements|needs \d+ ?[MKG]B/i),
    '설치 · 풀기 · 볼륨 쓰기에 필요한 공간이 없습니다.',
    [{ kind: 'portal', action: 'edit-plan', label: '볼륨 경로·크기를 바꿔 그 단계부터', detail: '계획의 볼륨 경로(다른 디스크) 또는 볼륨 크기를 바꿉니다.' },
      { kind: 'server', label: '공간 확인', commands: ['df -h /var/lib /var /', 'du -sh /var/lib/portal-bareos-install/* 2>/dev/null'] }]),
  R('gpg', '패키지 서명 확인 실패', line(/(GPG check FAILED|NOKEY|public key .* is not installed|Signature verification failed|signature could not be verified)/i),
    'dnf 가 번들 RPM 의 서명을 확인하지 못했습니다(번들의 키와 패키지 서명 키가 다름). 서명을 끄고 설치하지 않습니다.',
    [{ kind: 'server', label: '키 확인', commands: ['ls /var/lib/portal-bareos-install/bundle/*/bareos-bundle/keys/', 'rpm -q gpg-pubkey --qf "%{NAME}-%{VERSION}-%{RELEASE} %{SUMMARY}\\n"'] }]),
  R('dnf-conflict', '패키지 의존성·충돌', line(/(conflicts with file from package|conflicting requests|nothing provides|cannot install the best candidate|Problem( \d+)?:|is filtered out by)/i),
    '번들 안의 패키지만으로 의존성을 풀지 못했거나, 이미 설치된 패키지와 파일이 겹칩니다(이 단계가 넣은 것은 되돌렸습니다).',
    [{ kind: 'server', label: '충돌 패키지 확인', commands: ['dnf --disablerepo="*" --enablerepo=portal-bareos-local install --assumeno bareos 2>&1 | tail -n 30'] }]),
  R('pg-init', 'PostgreSQL 초기화 실패', line(/(initdb|Data directory .* is not empty|directory .* exists but is not empty|could not connect to server|connection to server .* failed|database "bareos" already exists)/i),
    '카탈로그 DB 를 만들거나 접속하지 못했습니다.',
    [{ kind: 'server', label: 'PostgreSQL 상태 확인', commands: ['systemctl status postgresql --no-pager -l | tail -n 20', 'ls -la /var/lib/pgsql/data | head'] }]),
  R('selinux', 'SELinux 문맥 설정 실패', line(/(semanage|restorecon|SELinux policy is not managed|ValueError)/i),
    '볼륨 경로에 Bareos 저장 문맥을 주지 못했습니다(패키지 기본 경로가 아닐 때만 하는 작업).',
    [{ kind: 'portal', action: 'edit-plan', label: '볼륨 경로를 기본(/var/lib/bareos/storage)으로 바꿔 3단계부터', detail: '' },
      { kind: 'server', label: '직접 확인', commands: ['getenforce', 'semanage fcontext -l -C | grep -i bareos'] }]),
  R('service', '서비스가 시작되지 않음', any(causeIs('port'), line(/(Job for .* failed|Failed to start|start request repeated too quickly)/i)),
    'Bareos 데몬이 시작 직후 끝났거나 포트를 열지 않았습니다(설정 검사는 통과).',
    [{ kind: 'server', label: '서비스 로그 확인', commands: ['journalctl -u bareos-dir -u bareos-sd -u bareos-fd -n 60 --no-pager', 'ss -ltnp | grep -E ":(9101|9102|9103) "'] },
      { kind: 'retry', label: '확인 뒤 그대로 다시', detail: '' }]),
  R('config-test', 'Bareos 설정 검사 실패', any(causeIs('sd-conf'), line(/(Config error|ERROR TERMINATION|Could not open config|parse error)/i)),
    'bareos-dir/sd/fd -t 가 설정 오류를 보고했습니다.',
    [{ kind: 'server', label: '검사 다시 보기', commands: ['runuser -u bareos -- bareos-dir -t', 'runuser -u bareos -- bareos-sd -t', 'bareos-fd -t'] }]),
  R('conflict', '포탈이 만들지 않은 파일이 이미 있음', causeIs('conflict'),
    '덮어쓸 자리에 사람이 만든 파일(또는 심링크)이 있어 멈췄습니다 — 남의 파일은 덮어쓰지 않습니다.',
    [{ kind: 'server', label: '그 파일 확인', commands: ['head -n 3 <위 경로>'] }]),
  R('bconsole', 'bconsole 로 Director 에 붙지 못함', causeIs('bconsole'),
    'Director 는 떠 있지만 서버 안 bconsole 접속이 실패했습니다.',
    [{ kind: 'server', label: '직접 확인', commands: ['printf "version\\n" | bconsole', 'journalctl -u bareos-dir -n 40 --no-pager'] }]),
  R('edge-probe', '엣지 경유 연결 실패', (e) => (e.step === 6 ? (e.message || '').slice(0, 300) || 'probe 실패' : null),
    'Director 는 설치됐지만 엣지 포탈이 그 Director 에 붙지 못했습니다(엣지가 배정을 아직 못 받았거나 엣지 포탈이 꺼져 있음).',
    [{ kind: 'retry', label: '잠시 뒤 6단계 다시', detail: '엣지는 새 배정을 받으면 바로 다시 받습니다(최대 몇 분).' },
      { kind: 'server', label: '엣지 포탈 확인', commands: ['systemctl status vmware-portal --no-pager | head -n 5'] }]),
  R('director-step', 'Director 리소스 단계 실패', (e) => (e.step === 4 ? (e.message || '').slice(0, 300) : null),
    '자동 설정(Director 리소스)이 실패해 넣은 파일을 되돌렸습니다 — 아래 사유가 구체적인 원인입니다.',
    [{ kind: 'retry', label: '사유를 고친 뒤 4단계 다시', detail: '' }]),
  R('fd-step', 'FD 플러그인 단계 실패', (e) => (e.step === 5 ? (e.message || '').slice(0, 300) : null),
    'FD 설정(myself.conf)에 플러그인 줄을 넣지 못했습니다 — 아래 사유가 구체적인 원인입니다.',
    [{ kind: 'retry', label: '사유를 고친 뒤 5단계 다시', detail: '' }]),
  R('mapping-step', '매핑 저장 실패', (e) => (e.step === 7 ? (e.message || '').slice(0, 300) : null),
    '포탈 설정에 이 vCenter 의 매핑을 저장하지 못했습니다.', [{ kind: 'retry', label: '7단계 다시', detail: '' }]),
  R('runner-timeout', '원격 단계 시한 초과', causeIs('runner-timeout'),
    '엣지 노드의 설치 러너가 시한 안에 끝나지 않았거나, 엣지 노드에 계속 닿지 못했습니다(러너 유닛은 같은 시한에 끝납니다).',
    [{ kind: 'server', label: '러너 · 패키지 작업 확인', commands: ['systemctl status portal-bareos-install --no-pager | head -n 15', 'ps -ef | grep -E "dnf|rpm" | grep -v grep', 'tail -n 60 /var/lib/portal-bareos-install/run/*/run.log'] },
      { kind: 'retry', label: '확인 뒤 그 단계부터 다시', detail: '' }]),
  R('runner-died', '러너가 중간에 끝남', causeIs('runner-died'),
    '엣지 노드의 설치 러너가 상태를 남기지 않고 끝났습니다(서버 재부팅 · 강제 종료).',
    [{ kind: 'retry', label: '그 단계부터 다시', detail: '' }, { kind: 'server', label: '러너 로그', commands: ['journalctl -u portal-bareos-install -n 60 --no-pager', 'tail -n 60 /var/lib/portal-bareos-install/run/*/run.log'] }]),
]);

/**
 * 판정.
 * @param {{ step, cmd?, code?, cause?, output?, message?, sshAuth? }} e
 * @returns {{ key, title, why, evidence, fixes, unclassified: boolean }}
 */
export function classifyFailure(e = {}) {
  for (const r of RULES) {
    let ev = null;
    try { ev = r.test(e); } catch { ev = null; }
    if (ev) return { key: r.key, title: r.title, why: r.why, evidence: ev, fixes: r.fixes, unclassified: false };
  }
  return {
    key: 'unclassified', title: '원인 미분류', why: '아는 규칙에 맞지 않았습니다 — 원인을 추정하지 않고 출력 원문을 보입니다.',
    evidence: '', unclassified: true,
    fixes: [{ kind: 'retry', label: '원문을 확인한 뒤 그 단계부터 다시', detail: '' }, { kind: 'server', label: '러너 로그', commands: ['tail -n 80 /var/lib/portal-bareos-install/run/*/run.log'] }],
  };
}

/** 출력에서 비밀을 가린다(저장 SSH 비밀번호·콘솔 비밀번호 — 같은 글자가 있으면 그 줄을 통째로 뺀다). */
export function scrubOutput(text, secrets = []) {
  const ss = secrets.filter((s) => typeof s === 'string' && s.length >= 4);
  return String(text || '').split('\n').map((l) => (ss.some((s) => l.includes(s)) ? '(비밀과 같은 글자가 있어 이 줄을 싣지 않습니다)' : l))
    // 반증 L4: bareos-*-t 설정 오류 출력에 Password 줄 원문이 실릴 수 있다(SD · Director 비밀번호) — 값을 가린다
    .map((l) => l.replace(/(password\s*=\s*)("[^"]*"|\S+)/gi, '$1(가림)'))
    .join('\n').slice(-MAX_OUT);
}

/**
 * focusMonPrepText.js — 대상 · 키 탭의 **접속 자동 준비**(v3.18.0 · 시안 ⑲ · docs/design/focus-mon/README.md §22) 문구 · 판정(순수 — 시험 고정).
 *  · 까닭 이름은 서버(audit/prep.js PREP_CODES · PREP_FAILS · AUDIT_SKIPS · installCred CRED_STATES)와 1:1(서버 시험이 대조).
 *  · 판정은 응답 `/tools/focus-mon/prep` 의 행 값만 쓴다 — 키 로그인(login) · 준비 계정(cred) · 설치 계정(credInstall) · 같은 주소(hostShared) · 진행 중 작업(job).
 */
import { TEST_TEXT } from './focusMonText.js';

export const DASH = '—';

/** 준비에 쓸 계정 상태(서버 CRED_STATES + edge-unknown). */
export const PREP_CRED_TEXT = Object.freeze({
  ok: { tone: 'ok', label: '할 수 있음', hint: '' },
  feature: { tone: 'warn', label: '못 함 — 키에 ‘접속 준비’ 가 꺼짐', hint: '그 키의 ‘쓸 수 있는 기능’ 에서 ‘집중 모니터링 접속 준비(root)’ 를 켜면 됩니다(설정 › 보안 › 서버 접속(SSH · Windows) — 엣지 서버는 그 엣지 포탈에서).' },
  noentry: { tone: 'warn', label: '못 함 — 준비에 쓸 계정 없음', hint: 'SSH 공용 접속에 이 서버(같은 주소 · 포트)도, 이 법인의 공통 계정도 없습니다 — 엣지에서 root 로 쓰는 키를 그 엣지 포탈의 SSH 공용 접속에 한 번 등록하세요.' },
  ambig: { tone: 'warn', label: '고르면 됨 — 공통 계정이 여럿', hint: '‘접속 준비’ 를 켠 이 법인의 공통 계정이 둘 이상입니다 — 줄에서 계정을 고르세요.' },
  dup: { tone: 'warn', label: '못 함 — 같은 주소 서버가 둘', hint: 'SSH 공용 접속에 같은 주소 · 포트로 등록된 서버가 둘 이상이라 어느 자격인지 모릅니다.' },
  password: { tone: 'warn', label: '못 함 — 비밀번호 접속', hint: '찾은 SSH 공용 접속 자격이 비밀번호입니다 — 접속 준비는 키 계정만 씁니다.' },
  stopped: { tone: 'bad', label: '못 함 — 법인 키 사용 중지', hint: 'SSH 공용 접속에서 이 법인의 키 접속을 멈춰 두었습니다.' },
  folder: { tone: 'warn', label: '못 함 — 키 폴더 밖', hint: '찾은 키의 폴더(법인 · 서버)가 이 서버를 덮지 않습니다.' },
  'key-missing': { tone: 'warn', label: '못 함 — 키 · 계정 없음', hint: '참조한 키 · 공통 계정이 지워졌습니다.' },
  unreadable: { tone: 'bad', label: '모름 — 키 저장소를 못 읽음', hint: 'SSH 키 저장소 · 서버 등록부 · 사용 중지 상태 파일을 읽지 못했습니다.' },
  error: { tone: 'bad', label: '모름 — 해석 오류', hint: '' },
  'edge-unknown': { tone: 'off', label: '모름 — 엣지가 아직 알려 오지 않음', hint: '엣지 포탈이 이 판(3.18) 아래이거나 연결이 끊겼습니다(엣지는 1분마다 알려 옵니다). 옛 판이면 엣지를 올리세요.' },
});
export const prepCredText = (c) => PREP_CRED_TEXT[c?.state] || PREP_CRED_TEXT.error;

/** 준비 결과 까닭(서버 PREP_CODES). */
export const PREP_CODE_TEXT = Object.freeze({
  ok: '준비됨 — 키 로그인 확인',
  login: '공개키는 넣었지만 키 로그인 실패',
  cred: '준비에 쓸 계정이 정해지지 않음',
  'bad-acct': '수집 계정 이름이 규칙에 맞지 않음',
  'acct-root': '수집 계정이 root — 넣지 않음',
  'acct-prep': '수집 계정이 준비 계정 자신 — 넣지 않음',
  'no-key': '이 노드의 집중 모니터링 키가 없음',
  'conn-unknown': '이 접속의 주소 · 포트를 알 수 없음(SSH_CONNECTION)',
  'key-stopped': '같은 키가 연달아 거부돼 잠시 쓰지 않음',
  auth: '준비 계정의 키 로그인 거부',
  hostkey: '호스트키 승인 필요',
  unreachable: '접속하지 못함',
  timeout: '시한 안에 끝나지 않음',
  'sudo-password': 'sudo 가 비밀번호를 물음',
  'sudo-tty': 'sudo 가 터미널(tty)을 요구함',
  upload: '준비 파일을 올리지 못함(SFTP)',
  script: '준비 파일이 멈춤',
  'script-other': '준비 파일이 끝까지 돌지 못함',
  busy: '엣지에서 같은 서버의 작업이 아직 끝나지 않음',
  'queue-full': '엣지 대기열이 가득 참',
});
/** 준비 파일이 멈춘 까닭(서버 PREP_FAILS) — 멈춘 경우 대상 서버에서 바뀐 것이 없다(계정 만들기 뒤 단계는 계정만 생긴다). */
export const PREP_FAIL_TEXT = Object.freeze({
  args: '수집 계정 이름이 규칙에 맞지 않음',
  'not-root': 'root 로 돌지 않음',
  'acct-root': '수집 계정이 root(uid 0)',
  'sshd-missing': 'sshd 를 찾지 못함',
  'sshd-unread': 'sshd 설정을 읽지 못함(sshd -T)',
  'sshd-pubkey': 'sshd 의 공개키 로그인이 꺼져 있음',
  'sshd-akfile': 'authorized_keys 위치가 기본이 아님',
  'sshd-allow': 'sshd AllowUsers 에 이 계정이 없음',
  'sshd-deny': 'sshd DenyUsers 가 이 계정을 막음',
  'sshd-groups': 'sshd AllowGroups · DenyGroups 가 있음(판단하지 않고 멈춤)',
  'sshd-authmethods': 'sshd AuthenticationMethods 가 공개키만으로는 로그인을 허용하지 않음',
  'acct-create': '수집 계정을 만들지 못함',
  'acct-shell': '수집 계정의 셸이 nologin · false',
  'acct-home': '수집 계정의 홈 디렉터리가 없거나 이상함',
  'acct-sudo': '수집 계정이 이미 sudo 로 모든 명령을 할 수 있음(wheel · sudo 그룹 포함) — 넣지 않음',
  'key-symlink': '.ssh 또는 authorized_keys 가 심링크',
  'key-write': 'authorized_keys 에 쓰지 못함',
  'no-runuser': 'runuser 가 없음(그 계정 권한으로 쓸 수 없음)',
  other: '알 수 없는 까닭',
});
/** 고칠 곳(까닭별 한 줄). */
export const PREP_FIX_TEXT = Object.freeze({
  'sudo-password': '준비 계정에 비밀번호 없는 sudo(NOPASSWD)를 주거나 root 키를 등록하세요 — 또는 손으로 넣기.',
  'sudo-tty': 'sudoers 의 Defaults requiretty 를 그 계정에 풀거나 손으로 넣으세요.',
  auth: '그 서버의 준비 계정 authorized_keys 를 확인하세요 — 자동으로 다시 시도하지 않습니다.',
  'key-stopped': '같은 키가 연달아 거부됐습니다 — 키를 확인한 뒤 10분 뒤에 다시 누르세요.',
  hostkey: '설정 › 보안 › 장비 신뢰에서 그 서버의 호스트키를 승인하세요.',
  upload: '그 서버의 SSH 에 SFTP 가 꺼져 있을 수 있습니다 — 손으로 넣으세요.',
  'conn-unknown': '그 서버의 sshd 가 SSH_CONNECTION 을 주지 않습니다 — 손으로 넣으세요.',
  'acct-prep': '수집 계정을 일반 계정으로 등록을 고치세요 — root 로 갈 수 있는 계정에는 넣지 않습니다.',
  'no-key': '노드별 SSH 공개키 카드에서 키 상태를 확인하세요.',
  login: '홈 · .ssh 권한(StrictModes) · SELinux · PAM(만료 · access.conf)을 확인한 뒤 ‘다시 연결’ 을 누르세요.',
  'acct-root': '등록을 일반 계정으로 고치세요 — root 에는 넣지 않습니다.',
  script: '서버 담당자가 고칠 것(sshd 설정 · 계정) — 포탈은 바꾸지 않았습니다. 손으로 넣을 수도 있습니다.',
  scriptAfterAcct: '계정은 생겼습니다(그 뒤 단계에서 멈춤) — 까닭을 고친 뒤 다시 누르면 그 계정에 이어서 넣습니다.',
});
/** 디스크 점검을 함께 하지 않은 까닭(서버 AUDIT_SKIPS + 'skip'). */
export const AUDIT_SKIP_TEXT = Object.freeze({
  off: '고르지 않음', login: '키 로그인이 안 돼 건너뜀', cred: '설치 계정이 정해지지 않아 건너뜀', key: '그 키에 ‘설치’ 가 꺼져 있어 건너뜀', skip: '건너뜀', done: '이어서 설치함',
});
export const WARN_TEXT = Object.freeze({ 'home-perm': '홈 디렉터리를 그룹 · 다른 계정이 쓸 수 있음(StrictModes 가 거부할 수 있음)', passwd: '비밀번호 칸을 바꾸지 못함', chage: '만료 설정을 바꾸지 못함' });

/** 키 로그인(지금) 표시. */
export function loginText(l) {
  const k = l?.kind || null;
  if (!k) return { tone: 'off', label: '시험한 적 없음', sub: '등록만 한 서버' };
  if (k === 'ok' || k === 'os-unverified') return { tone: 'ok', label: '연결됨', sub: TEST_TEXT[k] || '' };
  if (k === 'auth' || k === 'auth-stopped') return { tone: 'bad', label: '키 로그인 거부', sub: '그 계정에 이 노드의 공개키가 없는 것으로 보임' };
  if (k === 'hostkey') return { tone: 'warn', label: '호스트키 승인 필요', sub: '설정 › 보안 › 장비 신뢰' };
  return { tone: 'warn', label: TEST_TEXT[k] || k, sub: '' };
}
/** 연결됨(할 일 없음)인가. */
export const loginOk = (l) => l?.kind === 'ok' || l?.kind === 'os-unverified';

/**
 * 한 행의 자동 준비 판정.
 * @returns {{settled:boolean, can:boolean, why:string|null, audit:{can:boolean, why:string|null}}}
 */
export function prepRowState(r, pick = null) {
  const settled = loginOk(r?.login);
  const c = r?.cred || { state: 'error' };
  let why = null;
  if (settled) why = null;
  else if (r?.job) why = '이미 작업이 진행 중';
  else if (String(r?.username || '') === 'root') why = '수집 계정이 root';
  else if (c.state === 'ok' && c.acct && c.acct === String(r?.username || '')) why = '수집 계정이 준비 계정 자신';
  else if (r?.login?.kind === 'hostkey') why = '호스트키 승인 먼저';
  else if (c.state === 'ambig') why = pick && (c.choices || []).some((x) => x.id === pick) ? null : '공통 계정을 고르지 않음';
  else if (c.state !== 'ok') why = prepCredText(c).label.replace(/^(못 함|모름|고르면 됨) — /, '');
  const can = !settled && !why;
  // 디스크 점검 함께 — 같은 키가 ‘설치’ 도 켰을 때(이름으로 견줌 — 노드가 키 id 로 다시 본다) · 같은 주소에 다른 수집 계정이 없을 때
  const ci = r?.credInstall || { state: 'error' };
  let awhy = null;
  if (!can) awhy = null;
  else if (r?.hostShared) awhy = '같은 주소에 다른 수집 계정 — 손으로 설치';
  // 반증 D7: 공통 계정을 고르는 행은 노드가 고른 계정으로 설치 계정을 다시 푼다 — 화면은 단정하지 않는다(maybe)
  else if (c.state === 'ambig' || ci.state === 'ambig') return { settled, can, why, audit: { can: true, maybe: true, why: '고른 계정의 키가 ‘설치’ 도 켰을 때만(노드가 판단)' } };
  else if (ci.state === 'feature') awhy = '그 키에 ‘설치’ 가 꺼져 있음';
  else if (ci.state !== 'ok') awhy = '설치 계정이 정해지지 않음';
  else if (c.state === 'ok' && ci.key && c.key && ci.key !== c.key) awhy = '설치에 다른 키를 씀 — 디스크 점검 탭에서';
  return { settled, can, why, audit: { can: can && !awhy, why: awhy } };
}

/** 마지막 준비 결과 표시. */
export function prepResultText(lp) {
  if (!lp) return null;
  const base = PREP_CODE_TEXT[lp.code] || lp.code;
  const why = lp.code === 'script' && lp.fail ? ` — ${PREP_FAIL_TEXT[lp.fail] || lp.fail}` : '';
  const did = [lp.created ? '계정 만듦' : lp.partial ? '계정은 생겼지만 홈을 만들지 못함' : lp.exists ? '계정은 있었음' : '',
    lp.added ? '공개키 넣음' : lp.have ? '같은 키가 이미 있음' : lp.differs ? '같은 키가 다른 옵션(주소 제한 등)으로 이미 있어 그대로 둠 — 바꾸려면 그 줄을 손으로 고치세요' : '',
    lp.from ? '주소 제한' : lp.fromAsked && !lp.added ? '주소 제한은 적용되지 않음(새 줄을 넣지 않았음)' : ''].filter(Boolean).join(' · ');
  const audit = lp.audit && lp.audit !== 'off' ? `디스크 점검: ${AUDIT_SKIP_TEXT[lp.audit] || lp.audit}` : '';
  const warn = (lp.warn || []).map((w) => WARN_TEXT[w] || w).join(' · ');
  const tone = lp.code === 'ok' ? 'ok' : lp.code === 'login' ? 'warn' : 'bad';
  const fix = lp.code === 'script' ? ((lp.created || lp.partial) ? PREP_FIX_TEXT.scriptAfterAcct : PREP_FIX_TEXT.script) : PREP_FIX_TEXT[lp.code] || '';
  return { tone, label: `${base}${why}`, sub: [did, audit, warn, fix].filter(Boolean).join(' · ') };
}

/** 단계 막대(서버 PREP_STEPS 0 ~ 7). */
export const PREP_STEP_LABELS = Object.freeze(['준비 계정', '접속', '권한', 'sshd 확인', '수집 계정', '공개키', '키 로그인 확인', '디스크 점검']);

/** 넣을 한 줄의 모양(화면 미리 보기 — 실제 줄은 노드가 자기 공개키로 만든다). */
export function keyLinePreview(from) {
  return `${from ? 'restrict,from="<대상 서버가 본 그 노드의 주소>"' : 'restrict'} <그 노드의 집중 모니터링 공개키> dvc-focusmon@<노드>`;
}

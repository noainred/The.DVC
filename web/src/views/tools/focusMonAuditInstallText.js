/**
 * focusMonAuditInstallText.js — 디스크 점검 프로그램 **자동 설치 · 설치 디렉터리**의 글 · 판정(v3.17.0 · 사용자 "디스크 점검하는 프로그램을 자동으로 설치하는 기능 추가" ·
 * "설치 디렉터리를 사전에 사용자가 지정하는 기능 추가" · 시안 ⑱ · docs/design/focus-mon/README.md §21).
 *
 *  · 디렉터리 판정 `dirIssue` 는 서버 `focusmon/audit/bundle.js dirIssue` 와 **같은 규칙**(서버 시험이 같은 입력으로 대조한다) — 입력하는 동안 바로 알려 주려는 것이고,
 *    저장 · 설치 때 서버가 다시 판정한다(화면 판정을 믿지 않는다).
 *  · 설치 계정 상태 · 결과 까닭 글은 서버 상태 이름(CRED_STATES · INSTALL_CODES · INSTALL_FAILS)과 1:1(서버 시험 대조).
 */
export const DASH = '—';
export const DIR_MAX = 120;
export const DIR_DEPTH_MIN = 2;
export const DIR_DEPTH_MAX = 8;
export const DIR_DENY = Object.freeze(['/tmp', '/var/tmp', '/dev', '/proc', '/sys', '/run', '/home', '/root', '/boot', '/mnt', '/media']);
export const DIR_ISSUE_TEXT = Object.freeze({
  'not-string': '디렉터리는 글자여야 합니다.',
  'too-long': `${DIR_MAX}자를 넘습니다.`,
  'not-absolute': '절대 경로(/ 로 시작)만 됩니다.',
  'bad-char': '쓸 수 있는 글자는 영문 · 숫자 · . _ - / 입니다(공백 · 따옴표 · $ · ; · 한글은 안 됩니다).',
  'trailing-slash': '끝의 / 는 빼 주세요.',
  'empty-segment': '/ 가 겹쳤습니다.',
  'dot-segment': '. 과 .. 은 쓸 수 없습니다.',
  'dash-segment': '이름이 - 로 시작할 수 없습니다.',
  'too-shallow': '최상위 바로 아래 한 칸(/opt 같은 곳)에는 둘 수 없습니다 — 전용 폴더를 한 칸 더 두세요.',
  'too-deep': `${DIR_DEPTH_MAX}칸까지입니다.`,
  denied: '다른 계정이 쓸 수 있거나 재부팅 · 마운트에 따라 바뀌는 곳(/tmp · /home · /run 등) 아래에는 둘 수 없습니다.',
});
/** 서버와 같은 판정(순수). '' = 기본 경로(문제 없음). */
export function dirIssue(dir) {
  if (dir === '' || dir == null) return null;
  if (typeof dir !== 'string') return 'not-string';
  if (dir.length > DIR_MAX) return 'too-long';
  if (dir[0] !== '/') return 'not-absolute';
  if (!/^[A-Za-z0-9._/-]+$/.test(dir)) return 'bad-char';
  if (dir.length > 1 && dir.endsWith('/')) return 'trailing-slash';
  const parts = dir.split('/').slice(1);
  if (parts.some((x) => x === '')) return 'empty-segment';
  if (parts.some((x) => x === '.' || x === '..')) return 'dot-segment';
  if (parts.some((x) => x[0] === '-')) return 'dash-segment';
  if (parts.length < DIR_DEPTH_MIN) return 'too-shallow';
  if (parts.length > DIR_DEPTH_MAX) return 'too-deep';
  if (DIR_DENY.some((d) => dir === d || dir.startsWith(`${d}/`))) return 'denied';
  return null;
}
/** 디렉터리 → 두 파일 경로(화면 미리 보기 — 서버 pathsFor 와 같은 꼴). 규칙 밖이면 null. */
export function pathsPreview(dir, defaults) {
  if (!dir) return defaults ? { program: defaults.program, wrapper: defaults.wrapper } : null;
  if (dirIssue(dir)) return null;
  return { program: `${dir}/rhel_disk_audit.py`, wrapper: `${dir}/dvc-disk-audit` };
}
export const dirLabel = (dir) => (dir == null ? DASH : dir === '' ? '기본 경로(/usr/local/…)' : dir);

/** 설치 계정 상태(서버 CRED_STATES + 화면 전용 'edge-unknown'). */
export const CRED_TEXT = Object.freeze({
  ok: { tone: 'ok', label: '설치할 수 있음', hint: '' },
  feature: { tone: 'warn', label: '못 함 — 키에 ‘설치’ 가 꺼짐', hint: '그 키의 ‘쓸 수 있는 기능’ 에서 ‘디스크 점검 프로그램 설치(root)’ 를 켜면 됩니다(설정 › 보안 › SSH 공용 접속 — 엣지 서버는 그 엣지 포탈에서).' },
  noentry: { tone: 'warn', label: '못 함 — 설치 계정 없음', hint: 'SSH 공용 접속에 이 서버(같은 주소 · 포트)도, 이 법인의 공통 계정도 없습니다.' },
  ambig: { tone: 'warn', label: '고르면 됨 — 공통 계정이 여럿', hint: '‘설치’ 를 켠 이 법인의 공통 계정이 둘 이상입니다 — 줄에서 계정을 고르세요.' },
  dup: { tone: 'warn', label: '못 함 — 같은 주소 서버가 둘', hint: 'SSH 공용 접속에 같은 주소 · 포트로 등록된 서버가 둘 이상이라 어느 자격인지 모릅니다.' },
  password: { tone: 'warn', label: '못 함 — 비밀번호 접속', hint: '찾은 SSH 공용 접속 자격이 비밀번호입니다 — 자동 설치는 키 계정만 씁니다.' },
  stopped: { tone: 'bad', label: '못 함 — 법인 키 사용 중지', hint: 'SSH 공용 접속에서 이 법인의 키 접속을 멈춰 두었습니다.' },
  folder: { tone: 'warn', label: '못 함 — 키 폴더 밖', hint: '찾은 키의 폴더(법인 · 서버)가 이 서버를 덮지 않습니다.' },
  'key-missing': { tone: 'warn', label: '못 함 — 키 · 계정 없음', hint: '참조한 키 · 공통 계정이 지워졌습니다.' },
  unreadable: { tone: 'bad', label: '모름 — 키 저장소를 못 읽음', hint: 'SSH 키 저장소 · 서버 등록부 · 사용 중지 상태 파일을 읽지 못했습니다.' },
  error: { tone: 'bad', label: '모름 — 해석 오류', hint: '' },
  'edge-unknown': { tone: 'off', label: '모름 — 엣지가 아직 알려 오지 않음', hint: '엣지 포탈이 옛 판이거나 연결이 끊겼습니다(엣지는 1분마다 알려 옵니다). 옛 판이면 엣지를 올리세요.' },
});
export const credText = (c) => CRED_TEXT[c?.state] || CRED_TEXT.error;
export const SRC_TEXT = Object.freeze({ server: 'SSH 공용 접속 서버 항목(주소 일치)', corp: '법인 공통 계정(‘설치’ 를 켠 키)' });

/** 설치 결과 까닭(서버 INSTALL_CODES). */
export const INSTALL_CODE_TEXT = Object.freeze({
  ok: '설치함 — 준비됨',
  check: '설치함 — 준비 확인은 못 함',
  cred: '설치 계정이 정해지지 않음',
  'bad-dir': '설치 디렉터리가 규칙에 맞지 않음',
  'bad-acct': '수집 계정 이름이 규칙에 맞지 않음',
  version: '포탈 판이 다름(중앙 · 엣지의 프로그램 판본이 다름)',
  'key-stopped': '같은 키가 연달아 거부돼 잠시 쓰지 않음',
  auth: '설치 계정의 키 로그인 거부',
  hostkey: '호스트키 승인 필요',
  unreachable: '접속하지 못함',
  timeout: '시한 안에 끝나지 않음',
  'sudo-password': 'sudo 가 비밀번호를 물음',
  'sudo-tty': 'sudo 가 터미널(tty)을 요구함',
  upload: '설치 파일을 올리지 못함(SFTP)',
  script: '설치 파일이 멈춤',
  'script-other': '설치 파일이 끝까지 돌지 못함',
});
/** 설치 파일이 멈춘 까닭(서버 bundle.INSTALL_FAILS). */
export const INSTALL_FAIL_TEXT = Object.freeze({
  args: '수집 계정 이름이 규칙에 맞지 않음', 'not-root': 'root 로 돌지 않음', 'no-acct': '수집 계정이 그 서버에 없음',
  'dir-symlink': '디렉터리 경로에 심링크가 있음', 'dir-notdir': '경로에 디렉터리가 아닌 것이 있음', 'dir-owner': '디렉터리가 root 소유가 아님',
  'dir-writable': '디렉터리를 그룹 · 다른 계정이 쓸 수 있음', 'dir-netfs': '네트워크 파일시스템', 'dir-noexec': '실행 금지(noexec) 마운트',
  'no-includedir': '/etc/sudoers 가 sudoers.d 를 읽지 않음', damaged: '설치 파일 손상', visudo: 'sudoers 검사(visudo) 실패', install: '파일을 놓지 못함', other: '알 수 없는 까닭',
});
/** 고칠 곳(까닭 → 안내). */
export const INSTALL_FIX_TEXT = Object.freeze({
  'sudo-password': '설치 계정에 비밀번호 없는 sudo(NOPASSWD)를 주거나 ‘설치 파일 받기’ 로 손으로 설치하세요.',
  'sudo-tty': 'sudoers 의 Defaults requiretty 를 그 계정에 풀거나 손으로 설치하세요.',
  auth: '그 서버의 설치 계정 authorized_keys 를 확인하세요 — 자동으로 다시 시도하지 않습니다.',
  'key-stopped': '같은 키가 연달아 거부됐습니다 — 키를 확인한 뒤 10분 뒤에 다시 누르세요.',
  hostkey: '설정 › 보안 › 장비 신뢰에서 그 서버의 호스트키를 승인하세요.',
  upload: '그 서버의 SSH 에 SFTP 가 꺼져 있을 수 있습니다 — 손으로 설치하세요.',
  version: '중앙 · 엣지 포탈 판이 같아진 뒤 다시 누르세요.',
  check: '수집 계정의 키 로그인을 확인한 뒤 ‘준비 상태 다시 확인’ 을 누르세요(대상 · 키 탭의 ‘다시 연결’).',
});
export function installResultText(li) {
  if (!li) return null;
  const base = INSTALL_CODE_TEXT[li.code] || li.code;
  const why = li.code === 'script' && li.fail ? ` — ${INSTALL_FAIL_TEXT[li.fail] || li.fail}` : li.code === 'cred' && li.cred ? ` — ${credText({ state: li.cred }).label.replace(/^(못 함|모름|고르면 됨) — /, '')}` : '';
  const extra = [li.nopy ? 'python3 없음(설치는 됨)' : '', li.oldRm ? `옛 파일 ${li.oldRm}개 지움` : '', li.oldKeep ? `옛 파일 ${li.oldKeep}개는 판본이 달라 둠` : ''].filter(Boolean).join(' · ');
  return { tone: li.code === 'ok' ? 'ok' : li.code === 'check' ? 'warn' : 'bad', label: `${base}${why}`, sub: [extra, INSTALL_FIX_TEXT[li.code] || ''].filter(Boolean).join(' · ') };
}

/** 설치 단계 막대(서버 INSTALL_STEPS 0 ~ 7). */
export const STEP_LABELS = Object.freeze(['설치 계정', '접속', '권한 확인', '디렉터리 검사', '파일 설치', 'sudoers', '옛 파일 정리', '준비 확인']);

/**
 * 서버 한 줄의 설치 판단(순수) — 설치된 곳 · 옛 디렉터리 · 할 일 · 설치할 수 있나.
 * @param {object} r  서버 행(ready.dir · ready.state · job)  @param {object} cred  설치 계정 상태  @param {string|null} dir  지금 설치 디렉터리(null = 설정을 못 읽음)
 */
export function installRowState(r, cred, dir) {
  const at = typeof r?.ready?.dir === 'string' ? r.ready.dir : null;
  const old = at !== null && dir !== null && at !== dir;
  const settled = !old && at !== null && r?.ready?.state === 'ready';
  const credOk = cred?.state === 'ok' || cred?.state === 'ambig';
  const can = credOk && dir !== null && !r?.job && !settled;
  const act = !r?.ready?.state || r.ready.state === 'notinstalled' || at === null ? '새로 설치' : old ? '새 디렉터리로 옮김' : r.ready.state === 'version' ? '판본 맞춤' : r.ready.state === 'nosudo' ? 'sudoers 한 줄 다시' : '다시 설치';
  return { at, old, settled, can, act, needPick: cred?.state === 'ambig' };
}
/** 확인 창에서 건너뛰는 까닭. */
export function skipReason(r, cred, dir, pick) {
  if (dir === null) return '설치 디렉터리 설정을 읽지 못함';
  const s = installRowState(r, cred, dir);
  if (r?.job) return '이미 작업이 진행 중';
  if (s.settled) return '이미 지금 디렉터리에 준비됨';
  if (cred?.state === 'ambig' && !(pick && cred.choices?.some((c) => c.id === pick))) return '공통 계정을 고르지 않음';
  if (!s.can) return credText(cred).label.replace(/^(못 함|모름) — /, '');
  return null;
}

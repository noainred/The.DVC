/**
 * bareosInstallText.js — Bareos 완전 설치 화면(v2.844)의 문구·판정(순수). 화면은 BareosInstall.jsx.
 * 규칙: 값이 없으면 '—'(0 이 아니다 — numOrNull) · 문구에 백틱 금지(BoldText 는 **강조**만) · 원인은 서버 판정(causes.js)을 그대로 보인다(화면이 지어내지 않는다).
 */
import { numOrNull } from '../../numOrNull.js';
import { bytesText, whenText } from './bareosText.js';

export { bytesText, whenText };

/** 사전 점검 결과 → 표시. */
export const CHECK_VIEW = Object.freeze({
  ok: { mark: '✓ 정상', cls: 'green' }, warn: { mark: '! 확인', cls: 'amber' }, bad: { mark: '✗ 불가', cls: 'red' }, unknown: { mark: '? 확인 불가', cls: 'gray' },
});
export const checkView = (st) => CHECK_VIEW[st] || CHECK_VIEW.unknown;
export function checkCountsText(c) {
  if (!c) return '—';
  return `✓ ${c.ok ?? 0} · ! ${c.warn ?? 0} · ✗ ${c.bad ?? 0} · ? ${c.unknown ?? 0}`;
}

/** 단계 상태 → 표시. */
export const STEP_VIEW = Object.freeze({
  pending: { mark: '대기', cls: 'gray' }, running: { mark: '진행 중', cls: 'blue' }, ok: { mark: '완료', cls: 'green' }, failed: { mark: '실패', cls: 'red' },
  fail: { mark: '실패', cls: 'red' }, rolledback: { mark: '실패 · 되돌림', cls: 'red' }, 'rollback-fail': { mark: '실패 · 되돌림 일부 실패', cls: 'red' }, stopped: { mark: '멈춤', cls: 'amber' },
});
export const stepView = (st) => STEP_VIEW[st] || STEP_VIEW.pending;

/** 작업 상태 → 표시. */
export const JOB_VIEW = Object.freeze({
  running: { text: '진행 중', cls: 'blue' }, failed: { text: '실패', cls: 'red' }, stopped: { text: '멈춤', cls: 'amber' }, done: { text: '설치 완료', cls: 'green' },
  // v2.846 C-1: 잠금에 걸려 아무것도 안 한 되돌리기도 이 상태다 — '일부' 라고 단정하지 않는다(카드가 원인을 밝힌다)
  'rolling-back': { text: '전부 되돌리는 중', cls: 'amber' }, rolledback: { text: '전부 되돌림', cls: 'gray' }, 'rollback-failed': { text: '되돌리기 실패', cls: 'red' },
});
export const jobView = (st) => JOB_VIEW[st] || { text: st || '—', cls: 'gray' };

/** 엣지 응답 나이(ms) → 글자. 모르면 '기록 없음'. */
export function edgeAgeText(ms) {
  const n = numOrNull(ms);
  if (n === null) return '기록 없음';
  if (n < 60_000) return `${Math.max(1, Math.round(n / 1000))}초 전`;
  if (n < 3_600_000) return `${Math.round(n / 60_000)}분 전`;
  if (n < 86_400_000) return `${Math.round(n / 3_600_000)}시간 전`;
  return `${Math.round(n / 86_400_000)}일 전`;
}

/** 대상 행 → 완전 설치 칸. */
export function targetModeText(t) {
  if (!t) return '—';
  if (!t.can) return `불가 — ${t.why || '사유 미상'}`;
  return t.mode === 'reinstall' ? '초기화 후 재설치' : '설치 가능';
}

/** 업로드 진행 → 글자(모르면 '—'). */
export function uploadText(u) {
  if (!u) return '—';
  if (u.reused) return '이미 같은 번들이 서버에 있음(다시 보내지 않음)';
  const sent = numOrNull(u.sent); const total = numOrNull(u.total);
  if (sent === null || total === null || total <= 0) return '—';
  const pct = Math.min(100, Math.floor((sent / total) * 100));
  return `${bytesText(sent)} / ${bytesText(total)} (${pct}%)${u.doneAt ? ' · sha256 확인' : ''}`;
}

/** 단계 소요(초·분) — 끝나지 않았으면 경과. */
export function stepDurText(s, now = Date.now()) {
  const a = numOrNull(s?.at); if (a === null) return '';
  const b = numOrNull(s?.endedAt) ?? now;
  const sec = Math.max(0, Math.round((b - a) / 1000));
  return sec < 60 ? `${sec}초` : `${Math.floor(sec / 60)}분 ${sec % 60}초`;
}

/** 실패 카드의 '고치는 방법' 정리 — 포탈에서 고치기를 맨 앞(사용자 채택), 그다음 그대로 다시, 서버 명령. */
export function fixesOrdered(cause) {
  const f = Array.isArray(cause?.fixes) ? cause.fixes : [];
  const rank = { portal: 0, retry: 1, server: 2 };
  return [...f].sort((a, b) => (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9));
}

/** 다시 시도 단추 문구. */
export function retryLabel(fix, step) {
  const at = Number.isInteger(step) ? `${step}단계부터` : '그 단계부터';
  if (fix?.action === 'pyvmomi-fix') return `플러그인 경로의 사본을 옮기고 ${at} 다시`;
  if (fix?.action === 'running-unknown-ok') return `${RUNNING_UNKNOWN_OK_LABEL}(${at} 다시)`;
  if (fix?.action === 'resend-bundle') return '번들을 다시 보내고 1단계부터';
  if (fix?.action === 'edit-plan') return `계획 값을 바꿔 ${at} 다시`;
  return `${at} 그대로 다시`;
}

/** 계획 입력의 기본값(번들 내용 기준). */
export function defaultPlan(bundle, target) {
  const py = bundle?.contents?.pyvmomi || {};
  return {
    pyvmomi: py.default || (py.versions || [])[0] || '', pyvmomiFix: false, volumeDir: '/var/lib/bareos/storage', webui: true,
    pools: { fullDays: 35, incrDays: 14, maxVolumeGB: 50 }, schedule: { fullDay: 'sun', time: '02:00' },
    consoleName: 'portal', directorName: `${target?.vcenterName || '법인'} Bareos`,
    reset: target?.mode === 'reinstall' ? { ack: false, catalog: true, volumes: false, confirmName: '' } : undefined,
  };
}

/**
 * v2.846 D-2: 실행 중 작업을 못 읽었을 때의 동의 — 서버 사전 점검의 조치 문구(precheck.js RUNNING_UNKNOWN_OK_LABEL)와 **같은 글자**(시험이 대조).
 * 동의는 그 회차에만(서버 작업 기록의 시도 행) — 계획 값이 아니라 다시 하기로 이어지지 않는다.
 */
export const RUNNING_UNKNOWN_OK_LABEL = '확인했음 — 실행 중 작업 확인 없이 진행';
/** 재설치이고 사전 점검이 실행 중 작업을 못 읽었나(? 확인 불가). */
export const runningUnknown = (pre, target) => target?.mode === 'reinstall' && (pre?.items || []).some((i) => i.key === 'running' && i.status === 'unknown');

/** 계획을 서버로 보낼 모양(숫자 칸은 숫자로). */
/**
 * @param {object} p 계획
 * @param {{ pre?: object, target?: object }} [o] v2.847 U2-5(2회차 점검 — 재현): 동의는 **지금 사전 점검이 '실행 중 작업 확인 불가' 일 때만** 싣는다 —
 *   점검을 다시 해 '정상' 이 되면 동의 칸이 사라지는데 값은 남아, 0단계가 다시 확인하지 못해도 확인 없이 초기화했다. pre 를 주지 않으면(다시 하기 계획 편집) 싣지 않는다.
 */
export function planBody(p, { pre = null, target = null } = {}) {
  const n = (v) => (v === '' || v == null ? v : Number(v));
  return {
    ...(p.runningUnknownOk === true && runningUnknown(pre, target) ? { runningUnknownOk: true } : {}),
    pyvmomi: p.pyvmomi, pyvmomiFix: !!p.pyvmomiFix, volumeDir: String(p.volumeDir || '').trim(), webui: p.webui !== false,
    pools: { fullDays: n(p.pools?.fullDays), incrDays: n(p.pools?.incrDays), maxVolumeGB: n(p.pools?.maxVolumeGB) },
    schedule: { fullDay: p.schedule?.fullDay, time: p.schedule?.time }, consoleName: String(p.consoleName || '').trim(), directorName: String(p.directorName || '').trim(),
    ...(p.reset ? { reset: { ack: !!p.reset.ack, catalog: p.reset.catalog !== false, volumes: !!p.reset.volumes, confirmName: String(p.reset.confirmName || '') } } : {}),
  };
}

/** 계획 화면에서 바로 막을 것(서버도 같은 판정을 한다 — 여기는 안내용). pre = 사전 점검 결과(실행 중 작업 확인 불가면 동의 필요 — 러너 0단계도 멈춘다). */
export function planIssues(p, target, pre = null) {
  const out = [];
  if (!p.pyvmomi) out.push('pyVmomi 판을 고르세요.');
  const vd = String(p.volumeDir || '').trim();
  if (!/^\/[A-Za-z0-9._/-]{1,200}$/.test(vd) || vd.includes('..') || vd.split('/').filter(Boolean).length < 2) out.push('볼륨 경로는 두 단계 이상의 절대 경로로 적습니다(예: /var/lib/bareos/storage).');
  if (target?.mode === 'reinstall') {
    if (!p.reset?.ack) out.push('지울 항목을 확인했다는 표시가 필요합니다.');
    if (p.reset?.volumes && String(p.reset.confirmName || '').trim() !== String(target.vcenterName || '').trim()) out.push('백업 볼륨까지 지우려면 법인 이름을 정확히 입력하세요.');
    if (runningUnknown(pre, target) && p.runningUnknownOk !== true) out.push(`실행 중 작업을 확인하지 못했습니다 — 직접 확인했으면 ‘${RUNNING_UNKNOWN_OK_LABEL}’ 을 체크하세요(체크하지 않으면 0단계가 아무것도 지우지 않고 멈춥니다).`);
  }
  return out;
}

/**
 * v2.846 U-12: 초기화 확인의 볼륨 크기 합 — 못 읽은(null) 볼륨을 0 으로 더하지 않는다. 아는 합 + '모름 N곳'.
 * @returns {{ text, known:number|null, unknown:number }}
 */
export function volumesSizeText(vols) {
  const list = Array.isArray(vols) ? vols : [];
  const known = list.map((v) => numOrNull(v?.bytes)).filter((b) => b !== null);
  const unknown = list.length - known.length;
  if (!list.length) return { text: '—', known: null, unknown: 0 };
  if (!known.length) return { text: `크기 모름(${unknown}곳)`, known: null, unknown };
  const sum = known.reduce((a, b) => a + b, 0);
  return { text: unknown ? `${bytesText(sum)} + 크기 모름 ${unknown}곳(일부 모름)` : bytesText(sum), known: sum, unknown };
}

/**
 * v2.846 U-7: postJson 은 409 를 던지지 않고 본문을 돌려준다 — `ok:false` 를 성공으로 보이지 않게 던진다(본문은 e.body — 시작의 precheck 표 되돌림이 쓴다).
 */
export function okOrThrow(r, fallback = '실패했습니다.') {
  if (r && r.ok === false) throw Object.assign(new Error(r.reason || fallback), { body: r });
  return r;
}

/** v2.846 C-1: 되돌리기 실패 원인 문구. */
export function rollbackCauseText(cause) {
  return ({
    busy: '같은 서버(또는 같은 Director)의 다른 작업이 진행 중이라 시작하지 않았습니다 — 아무것도 바꾸지 않았습니다.',
    'ssh-auth': '저장된 SSH 계정으로 로그인하지 못해 멈췄습니다(자동으로 다시 시도하지 않습니다 — 계정 잠금).',
    remote: '원격 되돌리기가 실패했거나 끝 표시 없이 끝났습니다 — 아래 남은 것을 확인하세요.',
    timeout: '원격 되돌리기가 시한 안에 끝나지 않았습니다.',
  })[cause] || '되돌리기를 끝내지 못했습니다 — 사유를 확인하세요.';
}

export const PYVMOMI_REASON = '권고: 8 계열 — Rocky 9 기본 Python 3.9 에서 pyVmomi 9.x 는 ‘Python 3.10 or newer is required’ 로 플러그인이 시작하지 못했습니다(현장 실측 2026-10-30 · 설치 문서 7.4). 번들에는 8.x 휠만 넣습니다.';
export const WEEKDAY_KO = Object.freeze({ sun: '일', mon: '월', tue: '화', wed: '수', thu: '목', fri: '금', sat: '토' });

/* ───────── v2.850 번들 받는 곳 · 서버 디렉터리(서버 bareos/install/bundleSource.js · bundle.js) ───────── */
/** 받는 주소의 출처 글자(서버 bundleSourceInfo().from). */
export const BUNDLE_FROM_TEXT = Object.freeze({ ui: '화면에서 정한 주소', env: '환경 변수 BAREOS_BUNDLE_BASE_URL', package: '업그레이드 패키지 주소에서 만든 주소', '': '정해지지 않음' });
export const bundleFromText = (from) => BUNDLE_FROM_TEXT[from] ?? BUNDLE_FROM_TEXT[''];
/** 서버 디렉터리 상태 글자(서버 importDirState). */
export function importDirStateText(s) {
  return ({ ok: { text: '있음 · 읽을 수 있음', cls: 'green' }, missing: { text: '없음 — 디렉터리를 만들어 두세요', cls: 'amber' }, 'not-dir': { text: '디렉터리가 아닙니다', cls: 'red' },
    unreadable: { text: '읽을 수 없습니다 — 포탈 서비스 계정에 읽기 · 실행 권한을 주세요', cls: 'red' } })[s] || { text: '정하지 않음', cls: 'gray' };
}
/** 번들 행의 위치 글자 — 받은 번들 폴더(지우기 가능) · 서버 디렉터리(읽기만). */
export const bundleWhereText = (w) => (w === 'import' ? '서버 디렉터리' : '받은 번들');
/** 번들 행의 상태 — 확인됨 · 사용 불가 · 확인 중(막 바뀐 파일) · 확인 전. */
export function bundleStateView(x) {
  if (x?.ok === true) return { cls: 'green', text: '✓ 서명·해시 확인' };
  if (x?.ok === false) return { cls: 'red', text: `사용 불가 — ${x.reason || '사유 미상'}` };
  if (x?.reason && x.reason !== '확인 전') return { cls: 'amber', text: `확인 중 — ${x.reason}` };
  return { cls: 'gray', text: '확인 전' };
}

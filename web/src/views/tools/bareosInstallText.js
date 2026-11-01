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
  'rolling-back': { text: '전부 되돌리는 중', cls: 'amber' }, rolledback: { text: '전부 되돌림', cls: 'gray' }, 'rollback-failed': { text: '되돌리기 일부 실패', cls: 'red' },
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

/** 계획을 서버로 보낼 모양(숫자 칸은 숫자로). */
export function planBody(p) {
  const n = (v) => (v === '' || v == null ? v : Number(v));
  return {
    pyvmomi: p.pyvmomi, pyvmomiFix: !!p.pyvmomiFix, volumeDir: String(p.volumeDir || '').trim(), webui: p.webui !== false,
    pools: { fullDays: n(p.pools?.fullDays), incrDays: n(p.pools?.incrDays), maxVolumeGB: n(p.pools?.maxVolumeGB) },
    schedule: { fullDay: p.schedule?.fullDay, time: p.schedule?.time }, consoleName: String(p.consoleName || '').trim(), directorName: String(p.directorName || '').trim(),
    ...(p.reset ? { reset: { ack: !!p.reset.ack, catalog: p.reset.catalog !== false, volumes: !!p.reset.volumes, confirmName: String(p.reset.confirmName || '') } } : {}),
  };
}

/** 계획 화면에서 바로 막을 것(서버도 같은 판정을 한다 — 여기는 안내용). */
export function planIssues(p, target) {
  const out = [];
  if (!p.pyvmomi) out.push('pyVmomi 판을 고르세요.');
  const vd = String(p.volumeDir || '').trim();
  if (!/^\/[A-Za-z0-9._/-]{1,200}$/.test(vd) || vd.includes('..') || vd.split('/').filter(Boolean).length < 2) out.push('볼륨 경로는 두 단계 이상의 절대 경로로 적습니다(예: /var/lib/bareos/storage).');
  if (target?.mode === 'reinstall') {
    if (!p.reset?.ack) out.push('지울 항목을 확인했다는 표시가 필요합니다.');
    if (p.reset?.volumes && String(p.reset.confirmName || '').trim() !== String(target.vcenterName || '').trim()) out.push('백업 볼륨까지 지우려면 법인 이름을 정확히 입력하세요.');
  }
  return out;
}

export const PYVMOMI_REASON = '권고: 8 계열 — Rocky 9 기본 Python 3.9 에서 pyVmomi 9.x 는 ‘Python 3.10 or newer is required’ 로 플러그인이 시작하지 못했습니다(현장 실측 2026-10-30 · 설치 문서 7.4). 번들에는 8.x 휠만 넣습니다.';
export const WEEKDAY_KO = Object.freeze({ sun: '일', mon: '월', tue: '화', wed: '수', thu: '목', fri: '금', sat: '토' });

/**
 * bmOnboardText.js — 7b단계 서버 등록 · SSH 키 저장소 · 누락 점검 화면 문구(순수 · vitest).
 * ⚠ 판정은 서버가 한다(분석 행의 action · code · reason · warnings · 누락 점검 bucket) — 여기는 표시 이름 · 숫자 꼴만. 서버 판정을 복제하지 않는다.
 */
import { toCsv } from '../../util/csv.js';

export const ACTION_TEXT = Object.freeze({ new: '신규', update: '갱신', unchanged: '변화 없음', reject: '거부' });
export const ACTION_TONE = Object.freeze({ new: 'ok', update: 'info', unchanged: 'muted', reject: 'bad' });
export const BUCKET_TEXT = Object.freeze({
  both: '둘 다(OS + iDRAC)', os: 'OS 만', idrac: 'iDRAC 만', none: '없음', unassigned: '미귀속', unknown: '모름(수집 기록 없음)',
  untracked: 'OS 만 — 성능 수집 안 됨',
});
export const BUCKET_ORDER = Object.freeze(['both', 'os', 'idrac', 'none', 'unassigned', 'unknown', 'untracked']);
/** 누락 점검 사유 code → 문구(서버 NO_PATH_REASON 의 짧은 꼴 — 모르는 code 는 그대로). */
export const MISS_REASON_TEXT = Object.freeze({
  'no-record': '아직 수집 기록이 없습니다(등록 직후이거나 주기가 돌지 않음)',
  'edge-no-record': '엣지 보관분에 이 서버 기록이 없습니다',
  'registry-only': 'OS 계정 등록부에만 있습니다 — 이 노드 함대(iDRAC · vCenter)에 없어 성능 수집 대상이 아닙니다(디스크 용량만)',
  unassigned: '법인 귀속 없음 — 기본 제외',
  'corp-off': '이 법인은 수집을 켜지 않음',
  'no-idrac': 'iDRAC 등록 없음',
  'no-idrac-cred': 'iDRAC 계정 없음',
  'no-os-cred': 'OS 계정 없음',
  'both-off': 'iDRAC · OS 수집이 모두 꺼짐',
});
export const KEY_STATUS_TEXT = Object.freeze({ active: '사용', retired: '퇴역(회전됨)' });
export const ACCOUNT_KIND_TEXT = Object.freeze({ os: 'OS(SSH)', idrac: 'iDRAC' });

/** 모르는 수(null)는 '—'(0 으로 보이지 않는다). */
export const numOr = (v) => (Number.isFinite(v) ? Number(v).toLocaleString() : '—');

/** 분석 요약 칩 — 서버 summary 그대로(경고는 신규 · 갱신 중 경고가 붙은 행 수). */
export function summaryChips(s = {}) {
  return [
    { k: 'new', label: '신규', n: s.new, tone: 'ok' },
    { k: 'update', label: '갱신', n: s.update, tone: 'info' },
    { k: 'warn', label: '경고', n: s.warn, tone: 'warn' },
    { k: 'reject', label: '거부', n: s.reject, tone: 'bad' },
    { k: 'unchanged', label: '변화 없음', n: s.unchanged, tone: 'muted' },
  ].map((c) => ({ ...c, text: `${c.label} ${numOr(c.n)}` }));
}

/** 적용할 행이 있나(신규 · 갱신). */
export const applicable = (summary) => (Number(summary?.new) || 0) + (Number(summary?.update) || 0) > 0;

/** 엣지 배포 반영 상태 — 중앙 기록(인메모리)이 없으면 '모름'(재시작 직후). */
export function edgeSyncText(a = {}) {
  if (!a.pulledAt) return { tone: 'muted', text: '모름 — 이 엣지가 중앙 재시작 뒤 아직 받으러 오지 않았습니다' };
  if (a.inSync === true) return { tone: 'ok', text: '반영됨' };
  return { tone: 'warn', text: '대기 — 엣지가 다음 인출에서 반영합니다' };
}

/** 지문 줄임(화면 폭) — 전체는 title. */
export const shortFp = (fp) => { const s = String(fp || ''); return s.length > 28 ? `${s.slice(0, 18)}…${s.slice(-6)}` : s; };

/** 날짜(YYYY-MM-DD) — ms 가 아니면 '—'. */
export function ymd(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** ArrayBuffer → base64(업로드 본문). 큰 파일도 호출 스택을 넘지 않게 조각으로. */
export function bufToBase64(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** 누락 점검 제안 → 등록 CSV(템플릿 열 순서 · 수식 가드). 사람이 고쳐 올린다(자동 등록 없음). */
export const TEMPLATE_COLUMNS = Object.freeze(['name', 'corp', 'idrac_host', 'idrac_cred', 'service_tag', 'os_host', 'os_port', 'os_cred', 'os_key',
  'collect_via', 'class', 'purposes', 'role', 'mounts', 'switch_port', 'enabled', 'note']);
export function suggestCsv(rows = []) {
  const body = [TEMPLATE_COLUMNS.slice()];
  for (const r of rows) {
    if (!r?.suggest) continue;
    const s = r.suggest;
    body.push(TEMPLATE_COLUMNS.map((c) => (c === 'service_tag' ? s.service_tag : s[c]) ?? ''));
  }
  return `﻿${toCsv(body)}\r\n`;
}

/** 분석 행의 사유 · 경고 한 칸(서버 문구 그대로). */
export function rowNote(r = {}) {
  if (r.action === 'reject') return r.reason || '거부';
  return (r.warnings || []).map((w) => w.text).join(' / ');
}

/** 이 계정이 키 · 공통 계정을 관리할 수 있나(설정 소유자 등급) — 서버가 다시 막는다. */
export function canManageKeys(u, isAdmin) {
  if (!isAdmin) return false;
  return u?.settingsOwnerTier === true || u?.name === 'Anonymous';
}

/**
 * 수집 건강 법인 행의 RTT 한 줄(7b — 중앙 직접 수집 법인만 서버가 싣는다). 서버의 rttHigh 를 그대로 쓴다(기준 800ms 를 화면이 다시 판정하지 않는다).
 * @returns {{text:string, tone:string}|null}  RTT 칸이 없는 행(엣지 · 엣지 노드)은 null
 */
export function rttLine(r = {}) {
  if (!r || !Object.hasOwn(r, 'rttHigh')) return null;
  if (r.rttHigh === true) return { text: `중앙 직접 · RTT ${numOr(r.rttMs)}ms — 엣지 수집 권장`, tone: 'warn' };
  if (r.rttHigh === false) return { text: `중앙 직접 · RTT ${numOr(r.rttMs)}ms`, tone: 'muted' };
  return { text: '중앙 직접 · RTT 모름(핑 값 없음)', tone: 'muted' };
}

/** 호스트키 정책 안내(감사 H-1 권고 ② 를 이번에 하지 않은 대신 정직하게 밝힌다). */
export const HOSTKEY_OBSERVE_NOTE = '호스트키 정책이 observe(업그레이드 설치 기본)면 첫 접속에 지문 승인 없이 이 자격으로 접속합니다 — enforce 로 두면 설정 › 장비 신뢰에서 지문을 승인한 뒤에만 보냅니다.';

/** 기존 서버 등록부 항목 → 인증 선택 값('' · key:<id> · acc:<id>). */
export function authChoiceOf(c) {
  if (!c) return '';
  if (c.keyRef) return `key:${c.keyRef}`;
  if (c.credRef) return `acc:${c.credRef}`;
  return '';
}
/** 인증 선택 → 저장 본문의 참조 칸(바뀌지 않으면 보내지 않는다 — 서버가 '묶음' 으로 보지 않게). */
export function authBodyOf(choice = '', c = null) {
  const cur = authChoiceOf(c);
  if ((choice || '') === cur) return {};
  if (!choice) return { keyRef: '', credRef: '' };
  if (choice.startsWith('key:')) return { keyRef: choice.slice(4), credRef: '' };
  if (choice.startsWith('acc:')) return { credRef: choice.slice(4), keyRef: '' };
  return {};
}

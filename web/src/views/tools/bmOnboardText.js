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
  'os-ambiguous': 'OS 등록을 하나로 못 정함(같은 이름 · 주소 등록이 여럿이거나 법인 미지정) — 등록에 법인을 지정하면 풀립니다',   // 2차 재확인 G3
  'os-foreign': 'OS 등록이 다른 법인으로 지정돼 있어 쓰지 않음',
  // 1회차 점검 D3 · D4
  'idrac-disabled': 'iDRAC 등록이 ‘사용 안 함’ 이라 쓰지 않음 — 설정 › iDRAC 등록에서 켜면 풀립니다',
  'os-disabled': 'OS 계정 등록이 ‘사용 안 함’ 이라 쓰지 않음 — 설정 › 베어메탈 스토리지에서 켜면 풀립니다',
  'os-edge': 'OS 계정 등록이 엣지 지정이라 이 노드에서는 접속하지 않음 — 그 엣지 포탈에 OS 등록이 있어야 수집',
  'key-conflict': '식별 키가 이 노드의 다른 서버와 겹쳐 수집하지 않음(값이 섞이지 않게) — 서비스태그를 채우면 풀립니다',   // 다음 점검 ①
  'edge-name-clash': '엣지 이름이 다른 수집 서버의 id · 이름과 겹쳐 그 엣지 보관분을 이름으로 가릴 수 없음 — 모름(수집 서버 이름을 서로 다르게 바꾸면 풀립니다)',   // 재확인 R1
  'remote-collector-unknown': '원격 수집 서버(엣지)가 맡은 서버인데 그 수집 서버의 이름을 등록부에서 확인하지 못함(등록부 못 읽음 · 등록부에 없음 · 이름이 빈 등록) — 어느 엣지인지 몰라 모름으로 둡니다',   // v2.961 · 반증 의심 2
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

/**
 * 엣지 배포 행의 공통 계정 · 키 칸(v2.954 점검 A-4). 범위 계정에는 서버가 이름 대신 '있는지(true/false)' 만 준다 —
 * 불리언을 그대로 이으면 'true · true' 가 된다. 이름이면 이름, true 면 '종류 지정됨', 없으면 뺀다.
 */
export function edgeCredText(r = {}) {
  const part = (v, label) => (v === true ? `${label} 지정됨` : (typeof v === 'string' && v ? v : ''));
  return [part(r.idracCred, 'iDRAC 계정'), part(r.osCred, 'OS 계정'), part(r.osKey, 'SSH 키')].filter(Boolean).join(' · ') || '—';
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

/**
 * 키 회전 결과 한 줄(4회차 점검 D1) — 서버가 판정한 경고(warnings — 새 키로 막히는 수집 기능)를 문구 그대로 붙이고 그때는 주의 색으로.
 *   판정은 서버(refs.rotateKey — keyPlacementIssue)다. 여기는 이어 붙이기만 한다.
 */
export function rotateResultText(r = {}) {
  const servers = Array.isArray(r.servers) ? r.servers.length : 0;
  const warn = (Array.isArray(r.warnings) ? r.warnings : []).map((w) => (typeof w?.text === 'string' ? w.text : '')).filter(Boolean).join(' ');
  const base = `회전했습니다 — 서버 ${servers}대 · 공통 계정 ${numOr(r.accounts)}개가 새 키를 씁니다.${r.retestAdvised ? ' 서버마다 ‘연결 시험’ 을 다시 하세요(자동 재시험 없음).' : ''}`;
  return warn ? { text: `${base} 주의: ${warn}`, tone: 'warn' } : { text: base, tone: 'ok' };
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
/**
 * 6회차 B4 — bm-storage 서버 폼의 인증 드롭다운 목록. 판정은 서버(GET /tools/bm-storage/auth-choices — 저장과 같은 bmPlacementIssue)의 selectable 그대로다.
 *   고를 수 있는 것과 지금 설정(current — 맞지 않아도 남긴다 · fit:false)만 싣고, 뺀 수와 법인 귀속 없음을 안내에 쓴다. 응답을 못 읽으면 목록을 비우고 error.
 */
export function authChoicesView(r) {
  if (!r || r.ok !== true) return { keys: [], accounts: [], hidden: 0, corpless: false, error: true };
  const pick = (l) => (Array.isArray(l) ? l : []).filter((x) => x && (x.selectable === true || x.current === true)).map((x) => ({ ...x, fit: x.selectable === true }));
  const all = [...(Array.isArray(r.keys) ? r.keys : []), ...(Array.isArray(r.accounts) ? r.accounts : [])];
  return { keys: pick(r.keys), accounts: pick(r.accounts), hidden: all.filter((x) => x && x.selectable !== true && x.current !== true).length, corpless: r.corpless === true, error: false };
}
/** 드롭다운 아래 안내 한 줄(빼낸 것이 있을 때 · 못 읽었을 때). 없으면 ''. */
export function authChoicesNote(v = {}) {
  if (v.error) return '이 서버에 쓸 수 있는 키 · 공통 계정 목록을 읽지 못했습니다 — 개별 비밀번호만 고를 수 있습니다.';
  if (!v.hidden) return '';
  const base = `이 서버에 쓸 수 없는 키 · 공통 계정 ${v.hidden}개는 목록에서 뺐습니다(키 폴더 · 계정 법인이 이 서버와 맞지 않음).`;
  return v.corpless ? `${base} 이 서버는 법인 귀속이 없어 법인 폴더 키를 쓸 수 없습니다 — 법인 폴더 키는 서버 등록(CSV)에서 법인을 정한 뒤 고르세요.` : base;
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

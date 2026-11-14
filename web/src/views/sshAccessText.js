/**
 * sshAccessText.js — 설정 › 보안 › SSH 공용 접속 화면의 문구 · 표시 도우미(순수 — React · api.js 를 import 하지 않는다: vitest node 환경).
 * 판정(이 서버에 이 키를 쓸 수 있는가 · 키 점검 등급)은 서버가 한다 — 여기는 서버가 준 값을 글자로 바꾸고 목록을 묶기만 한다.
 * v3.10.0: 두 사람 승인(요청 상태 · 남은 시간 · 대기 문구) · 보호 장치 · 키 로그인 설정 / 키 거두기 결과 줄도 여기서 글자로 바꾼다(성공 · 실패는 서버 ok · code 그대로).
 */
import { unitText } from './unitText.js';

/** 키 점검 등급 → 글자 · 톤. 'unknown' 은 회색(정상도 장애도 아님). */
export const LEVEL_TEXT = Object.freeze({ bad: '위험', warn: '확인', ok: '정상', unknown: '모름' });
export const LEVEL_TONE = Object.freeze({ bad: 'bad', warn: 'warn', ok: 'ok', unknown: 'muted' });
export const LEVEL_ORDER = Object.freeze(['bad', 'warn', 'unknown', 'ok']);

/** 서버의 인증 방식(서버 keyMode). */
export const KEY_MODE_TEXT = Object.freeze({
  pinned: '이름 고정',
  'corp-default': '법인 기본 키',
  password: '비밀번호',
  none: '인증 수단 없음',
});

/** 서버가 주는 issue code → 짧은 글자(화면의 ‘고를 수 없음’ 사유). 긴 문구는 서버 응답 reason 을 그대로 싣는다. */
export const ISSUE_TEXT = Object.freeze({
  'key-folder': '다른 법인 · 다른 서버의 폴더',
  'key-feature': '이 기능에 허용되지 않음',
  'key-retired': '퇴역한 키',
  'key-pending': '승인 대기 중인 키(승인 전에는 쓰지 않음)',
  'key-tampered': '키가 포탈 밖에서 바뀜(바꿔치기 의심)',
  'account-tampered': '공통 계정이 포탈 밖에서 바뀜',
  'corp-stopped': '법인 키 사용 중지 중',
  'state-unreadable': '상태 파일을 읽지 못함',
});

/** 받는 곳 파일 code → 글자. 'ready' 만 승인할 수 있다(passphrase 가 필요한 키는 입력하면 된다). */
export const INBOX_CODE_TEXT = Object.freeze({
  ready: '승인 대기',
  'need-passphrase': 'passphrase 필요',
  symlink: '심볼릭 링크 — 읽지 않음',
  'not-file': '일반 파일 아님',
  'too-large': '너무 큼',
  'too-long': '너무 긺',
  unreadable: '읽지 못함',
  'public-only': '공개키 파일 — 개인키 아님',
  'weak-dsa': 'DSA — 받지 않음',
  'weak-rsa': 'RSA 2048 비트 미만 — 받지 않음',
  'unsupported-format': '읽을 수 없는 형식',
  'unsupported-type': '지원하지 않는 종류',
  'multi-key': '키가 여러 개',
  empty: '빈 파일',
});

export const EVENT_TEXT = Object.freeze({
  'corp-stop': '법인 키 사용 중지',
  'corp-resume': '법인 키 사용 재개',
  'inbox-new': '받는 곳에 새 키 파일',
  'inbox-approved': '받은 키 승인',
  'inbox-discarded': '받은 키 파일 삭제',
  'key-tampered': '키 바꿔치기 의심',
  'key-changed-outside': '키가 포탈 밖에서 바뀜',
  'key-added-outside': '키가 포탈 밖에서 들어옴',
  'account-changed-outside': '공통 계정이 포탈 밖에서 바뀜',
  'state-reloaded': '상태 파일 다시 읽음',
  'keystore-reloaded': '키 저장소 다시 읽음(포탈 밖 변경 받아들임)',
  // v3.10.0 — 두 사람 승인 · 보호 장치 · 키 로그인 설정 · 키 거두기
  'guard-changed': '보호 장치 변경',
  'approval-requested': '승인 요청',
  'approval-decided': '승인 요청 처리',
  'key-login-set': '키 로그인 설정',
  'key-lines-removed': '서버에서 키 줄 삭제',
  'key-job-done': '키 로그인 설정 작업 끝남',
  'key-revoke-done': '키 거두기 작업 끝남',
  // 포탈이 서버를 바꾸던 도중 다시 시작함 — 그 서버의 authorized_keys 를 확인할 것(서버가 기동 때 남김 · 1회차 B7)
  'key-job-interrupted': '키 작업이 서버를 바꾸던 중에 중단됨',
  'key-job-cancel': '키 작업 멈추기',
  'inbox-seen': '받는 곳 새 파일(내부 표지)',
});
/** 키 변경 기록에 그리지 않는 사건 — 사람이 읽을 내용이 없는 내부 표지(받는 곳 ‘본 표지’ 이어 적기). */
export const HIDDEN_EVENT_KINDS = Object.freeze(['inbox-seen']);

/** 사용 기록 결과 code → 글자. */
export const USE_CODE_TEXT = Object.freeze({
  ok: '성공', 'auth-rejected': '로그인 실패', 'auth-stopped': '인증 정지 중', fail: '실패', hostkey: '호스트키 미신뢰', connect: '접속 실패',
  'auth-unresolved': '자격 해석 실패', 'no-secret': '인증 수단 없음', gone: '서버 지워짐',
});
export const UNUSUAL_TEXT = Object.freeze({ 'new-server': '처음 쓰인 서버', 'new-feature': '처음 쓰인 기능' });

/** 지문 줄임(앞 12자 + … + 끝 4자). 없으면 '—'. */
export function shortFp(fp) {
  const s = String(fp || '');
  if (!s) return '—';
  const body = s.replace(/^SHA256:/, '');
  return body.length > 18 ? `SHA256:${body.slice(0, 12)}…${body.slice(-4)}` : s;
}
/** ms → 'YYYY-MM-DD HH:mm'(브라우저 현지 시각). 없으면 '—'. */
export function dateTime(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '—';
  const d = new Date(n);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
/** 며칠 전(정수). 없으면 null. */
export function ageDays(ms, now = Date.now()) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.max(0, Math.floor((now - n) / 86_400_000));
}

/** 허용 기능 → 글자. null = 모든 기능(예전 키), [] = 없음. */
export function featuresText(features, catalog = []) {
  if (features == null) return '모든 기능(예전 방식)';
  if (!features.length) return '없음';
  const name = new Map((catalog || []).map((f) => [f.id, f.label]));
  return features.map((id) => name.get(id) || id).join(' · ');
}

/**
 * 키 폴더 트리 — 법인마다 ‘공통’ + ‘서버별 › 서버’, 그리고 ‘미분류’. 서버별 폴더는 키가 있거나 그 법인 서버로 등록된 것만.
 * @returns {{id:string, kind:'corp'|'common'|'servers'|'server'|'none', corp:string, server:string, label:string, depth:number, count:number}[]}
 */
export function folderTree(view) {
  const corps = Array.isArray(view?.corps) ? view.corps : [];
  const keys = Array.isArray(view?.keys) ? view.keys : [];
  const servers = Array.isArray(view?.servers) ? view.servers : [];
  const out = [];
  for (const c of corps) {
    const ck = keys.filter((k) => k.folderCorp === c.id);
    out.push({ id: `corp:${c.id}`, kind: 'corp', corp: c.id, server: '', label: c.name || c.id, depth: 0, count: ck.length });
    out.push({ id: `common:${c.id}`, kind: 'common', corp: c.id, server: '', label: '공통', depth: 1, count: ck.filter((k) => !k.folderServer).length });
    const names = new Map();
    for (const k of ck) if (k.folderServer) names.set(k.folderServer.toLowerCase(), k.folderServer);
    for (const s of servers) if (s.vcenterId === c.id) { const nm = String(s.name || ''); if (nm && !names.has(nm.toLowerCase())) names.set(nm.toLowerCase(), nm); }
    const list = [...names.values()].sort((a, b) => a.localeCompare(b));
    out.push({ id: `servers:${c.id}`, kind: 'servers', corp: c.id, server: '', label: '서버별', depth: 1, count: ck.filter((k) => k.folderServer).length });
    for (const nm of list) out.push({ id: `server:${c.id}:${nm}`, kind: 'server', corp: c.id, server: nm, label: nm, depth: 2, count: ck.filter((k) => k.folderServer && k.folderServer.toLowerCase() === nm.toLowerCase()).length });
  }
  out.push({ id: 'none', kind: 'none', corp: '', server: '', label: '미분류(폴더 없음)', depth: 0, count: keys.filter((k) => !k.folderCorp).length });
  return out;
}

/** 고른 폴더의 키. corp 노드 = 그 법인 전부, servers 노드 = 서버별 전부. */
export function keysInFolder(view, node) {
  const keys = Array.isArray(view?.keys) ? view.keys : [];
  if (!node) return [];
  if (node.kind === 'none') return keys.filter((k) => !k.folderCorp);
  const ck = keys.filter((k) => k.folderCorp === node.corp);
  if (node.kind === 'corp') return ck;
  if (node.kind === 'common') return ck.filter((k) => !k.folderServer);
  if (node.kind === 'servers') return ck.filter((k) => k.folderServer);
  return ck.filter((k) => k.folderServer && k.folderServer.toLowerCase() === node.server.toLowerCase());
}

/** 고른 폴더의 받는 곳 파일. */
export function inboxInFolder(view, node) {
  const items = Array.isArray(view?.inbox?.items) ? view.inbox.items : [];
  if (!node || node.kind === 'none') return [];
  return items.filter((it) => it.corp === node.corp && (node.kind === 'corp' || (node.kind === 'common' ? !it.server : node.kind === 'servers' ? !!it.server : String(it.server || '').toLowerCase() === node.server.toLowerCase())));
}

/** 키 점검 항목을 등급 순으로. */
export function sortedCheck(items) {
  return [...(Array.isArray(items) ? items : [])].sort((a, b) => LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level));
}

/** 주기 수집 기능 — 서버 표가 ‘이 키는 수집에 허용되지 않음’ 을 가를 때 본다(서버 FEATURE_CATALOG 의 수집 기능 id). */
export const COLLECT_FEATURES = Object.freeze(['bm-usage', 'bm-storage']);
/**
 * 이 키(허용 기능 목록)로는 주기 수집이 접속하지 않는가 — 목록이 있고 수집 기능이 하나도 없을 때만 참(null = 예전 키 · 모든 기능 → 거짓).
 * 키 고르기 창 · 키 로그인 설정 창 · 넣을 키 목록 · 서버 표가 이 함수 하나로 가른다(판정 복제 금지). 최종 판정은 서버(refs.keyPlacementIssue · feature).
 */
export function keyNoCollect(features) {
  return Array.isArray(features) && !COLLECT_FEATURES.some((f) => features.includes(f));
}
/** 수집 미허용 키를 서버에 묶을 때의 경고(키 고르기 · 키 로그인 설정 창 공용 문구). */
export const NO_COLLECT_WARN = '이 키는 베어메탈 사용률 · 스토리지 수집에 허용되지 않았습니다 — 서버가 이 키를 쓰도록 적히면(연결 시험 · 키 접속 확인은 통과해도) 주기 수집은 이 키로 접속하지 않고 비밀번호로 넘어가지도 않아 그 서버의 수집이 멈춥니다. 키 폴더 탭에서 기능을 더하거나 다른 키를 고르세요.';
/**
 * 서버에 저장된 접속 수단이 있는가 — 키로 접속하도록 설정됨(키가 수단) · 비밀번호(서버 항목 또는 공통 계정에 저장됨) · 없음.
 * 서버가 hasSecret 를 주면 그것, 아니면 서버 응답의 keyMode · hasPassword · 공통 계정 hasPassword 로 가른다. 모르면 null(셈에 넣지 않는다).
 * ‘비밀번호 고정이면서 비밀번호가 없는 서버’ 는 keyMode 가 ‘password’ 여도 수단이 없다(점검 E1-10).
 */
export function hasStoredSecret(s, accounts = []) {
  if (!s || typeof s !== 'object') return null;
  if (typeof s.hasSecret === 'boolean') return s.hasSecret;
  if (s.keyMode === 'pinned' || s.keyMode === 'corp-default') return true;
  if (s.keyMode === 'none') return false;
  if (s.keyMode !== 'password') return null;
  if (s.hasPassword === true) return true;
  const acc = s.accountName ? (Array.isArray(accounts) ? accounts : []).find((a) => a && a.name === s.accountName) : null;
  if (acc && acc.hasPassword === true) return true;
  if (s.hasPassword === false && (!s.accountName || (acc && acc.hasPassword === false))) return false;
  return null;
}

/**
 * 서버 표 ‘상태’ 칸 — 실제로 접속을 막는 사유를 먼저(서버가 준 값 그대로 · 화면이 폴더 · 기능을 새로 판정하지 않는다).
 * @returns {{label:string, tone:'ok'|'warn'|'bad'|'muted', title?:string}}
 */
export function serverStatus(s, { tampered = [], stop = false, accounts = null } = {}) {
  if (s.accountMissing) return { label: '공통 계정 없음', tone: 'bad' };
  if (s.keyMissing) return { label: '키 없음(삭제됨)', tone: 'bad' };
  if (stop && (s.keyMode === 'pinned' || s.keyMode === 'corp-default')) return { label: '키 사용 중지', tone: 'bad', title: '법인 키 사용 중지 — 이 노드는 이 서버에 키로 접속하지 않습니다.' };
  if (s.keyId && (tampered || []).includes(s.keyId)) return { label: '키가 포탈 밖에서 바뀜', tone: 'bad' };
  if (s.placementIssue) return { label: ISSUE_TEXT[s.placementIssue] || s.placementIssue, tone: 'bad' };
  if (s.keyStatus === 'retired') return { label: '퇴역 키', tone: 'bad' };
  if (s.keyStatus === 'pending') return { label: '키 승인 대기', tone: 'bad', title: '이 키는 다른 설정 소유자의 승인을 기다립니다 — 승인되기 전에는 이 키로 접속하지 않습니다.' };
  if (s.keyMode === 'none') return { label: '인증 수단 없음', tone: 'bad' };
  // 비밀번호 고정인데 저장된 비밀번호가 없음(서버 · 공통 계정 둘 다) — 접속 수단이 없다(점검 E1-10). 공통 계정 목록을 받지 못했으면 가르지 않는다.
  if (s.keyMode === 'password' && accounts && hasStoredSecret(s, accounts) === false) return { label: '인증 수단 없음', tone: 'bad', title: '비밀번호로 접속하도록 고정돼 있지만 서버 항목 · 공통 계정 어디에도 저장된 비밀번호가 없습니다.' };
  if (s.keyMode === 'password') return { label: '비밀번호', tone: 'warn' };
  if (keyNoCollect(s.keyFeatures)) return { label: '수집 기능 미허용', tone: 'warn', title: '이 키의 ‘쓸 수 있는 기능’ 에 베어메탈 사용률 · 스토리지가 없습니다 — 주기 수집이 이 키로 접속하지 않습니다.' };
  return { label: '키', tone: 'ok' };
}

/** 감사 로그 시각(ISO 문자열 — UTC) → ms. 못 읽으면 0. 화면은 dateTime 으로 이 브라우저 시각에 맞춘다(사건 행과 같은 시간대). */
export function auditTime(at) {
  const n = Date.parse(String(at || ''));
  return Number.isFinite(n) ? n : 0;
}

/**
 * 감사 줄 detail(라우트가 JSON 으로 적은 400자 이내 글자)의 결과 — 실패 · 거절은 실패로, 승인 대기는 대기로 그린다(점검 E1-5 — 예전에는 detail 을 버려 성공처럼 읽혔다).
 * 잘려서 읽을 수 없거나 ok 칸이 없으면 null(지어내지 않는다).
 * @returns {null | {label:string, tone:'bad'|'warn'}}
 */
export function auditOutcome(detail) {
  const raw = typeof detail === 'string' ? detail : '';
  if (!raw || raw.length > 2000 || raw[0] !== '{') return null;
  let d = null;
  try { d = JSON.parse(raw); } catch { return null; }
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  if (d.ok === false) return { label: `실패${typeof d.code === 'string' && d.code ? `(${d.code.slice(0, 40)})` : ''}`, tone: 'bad' };
  if (d.ok === true && d.pending) return { label: '승인 대기', tone: 'warn' };
  return null;
}
/** 문장 끝 마침표를 뗀다(서버 사유를 이어 붙일 때 ‘..’ 이 되지 않게 — 정규식 없이 · 길이 먼저 자름). */
export function noEndDot(text, max = 300) {
  let t = String(text ?? '').slice(0, max).trimEnd();
  while (t.endsWith('.')) t = t.slice(0, -1).trimEnd();
  return t;
}
/**
 * 키 고르기 창 ‘서버에 들어 있는 키 다시 읽기’ 결과 문구(점검 E1-6). 서버는 출력을 못 읽어도 ok:true + error 를 준다(readInstalledKeys) —
 * 그때는 ‘0줄을 읽었습니다’ 라고 하지 않고 확인 톤으로 사유를 보인다.
 * @returns {{text:string, tone:'ok'|'warn'}}
 */
export function installedReadText(r) {
  if (r && typeof r.error === 'string' && r.error) return { text: `서버에 들어 있는 키를 읽지 못했습니다 — ${noEndDot(r.error)}.`, tone: 'warn' };
  const n = Array.isArray(r?.keys) ? r.keys.length : null;
  const cut = finiteNum(r?.truncated);
  return { text: `서버에 들어 있는 키 ${unitText(n, '줄')}을 읽었습니다${cut > 0 ? ` · ${cut}줄은 상한을 넘어 읽지 않음` : ''}.`, tone: 'ok' };
}

/** 받는 곳 승인 때 기본 이름(파일 이름 → 키 이름 규칙에 맞는 글자). 서버 NAME_RE 와 같은 글자만 남긴다(서버가 다시 판정한다). */
export function suggestKeyName(item) {
  const base = `${String(item?.corp || '').slice(0, 20)}-${String(item?.server || 'common').slice(0, 24)}-${String(item?.file || 'key').slice(0, 16)}`;
  const s = base.replace(/[^A-Za-z0-9가-힣._-]/g, '-').replace(/^[^A-Za-z0-9가-힣]+/, '').replace(/-{2,}/g, '-').slice(0, 64);
  return s || 'imported-key';
}

/* ── v3.10.0 — 두 사람 승인(요청 → 다른 설정 소유자의 승인 → 실행) ─────────────────── */

/**
 * 승인 요청 상태 → 글자 · 톤. 'approved' 는 승인은 됐는데 실행 결과가 아직 적히지 않은 상태(실행 중 · 그 사이 포탈이 멈춤) —
 * 서버가 얼마 뒤 ‘실행 실패(중단)’ 로 확정한다(approval/store expireDue). 그래서 ‘실행됨’ 으로 읽히지 않게 적는다.
 */
export const APPROVAL_STATUS_TEXT = Object.freeze({
  pending: '승인 대기', approved: '승인됨(실행 결과 아직 없음)', rejected: '돌려보냄', cancelled: '요청 취소', expired: '시한 지남', executed: '실행됨', failed: '실행 실패',
});
export const APPROVAL_STATUS_TONE = Object.freeze({ pending: 'warn', approved: 'warn', rejected: 'muted', cancelled: 'muted', expired: 'muted', executed: 'ok', failed: 'bad' });

const finiteNum = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** 승인 요청을 대기 / 끝난 것으로 가른다(서버가 준 순서 — 최신 먼저 — 그대로). 시한이 지난 대기 요청은 서버가 이미 'expired' 로 준다. */
export function splitApprovals(list) {
  const all = (Array.isArray(list) ? list : []).filter((r) => r && typeof r === 'object');
  return { pending: all.filter((r) => r.status === 'pending'), done: all.filter((r) => r.status !== 'pending') };
}

/** 요청의 남은 시간 글자. 못 읽은 값은 '—'(0분으로 지어내지 않는다) · 지났으면 '시한 지남'. */
export function approvalRemaining(expiresAt, now = Date.now()) {
  const e = finiteNum(expiresAt); const n = finiteNum(now);
  if (e == null || e <= 0 || n == null) return '—';
  const ms = e - n;
  if (ms <= 0) return '시한 지남';
  const min = Math.floor(ms / 60_000);
  if (min < 1) return '1분 미만';
  const h = Math.floor(min / 60); const m = min % 60;
  return h ? (m ? `${h}시간 ${m}분` : `${h}시간`) : `${m}분`;
}

/**
 * 신원 비교용 글자 — 서버 `approval/store.js identityKey` 와 같은 규칙(소문자 · AD 도메인 접두 ‘CORP\alice’ · 접미 ‘alice@corp.local’ 를 뗀다).
 * 화면은 단추를 잠그는 데만 쓴다 — 판정은 서버가 다시 한다.
 */
export function identityKey(name) {
  let s = String(name ?? '').slice(0, 128).trim().toLowerCase();
  const bs = s.lastIndexOf('\\'); if (bs >= 0) s = s.slice(bs + 1);
  const at = s.indexOf('@'); if (at > 0) s = s.slice(0, at);
  return s;
}
/** 내가 낸 요청인가 — 신원 비교(서버 approval/store 와 같은 규칙). 내 이름을 모르면 false(단추를 잠그지 않고 서버의 403 사유를 보인다). */
export function isOwnRequest(req, username) {
  const me = identityKey(username);
  return !!me && me === identityKey(req?.requestedBy);
}

/**
 * 202(승인 대기) 응답 문구. approvers = 요청자 말고 승인할 수 있는 설정 소유자 수(서버 값 — 모르면 수를 적지 않는다).
 * 0명이면 ‘승인할 사람이 없다’ 고 말하고 보호 장치 스위치를 가리킨다(요청은 승인되지 못한 채 시한이 지나 사라진다).
 */
export function pendingText(r, { what = '요청', then = '실행됩니다' } = {}) {
  const n = finiteNum(r?.approvers);
  if (n != null && n <= 0) {
    return `${what} 요청을 보냈지만 승인할 수 있는 다른 설정 소유자가 없습니다 — 이 요청은 승인되지 못한 채 시한이 지나면 사라집니다. `
      + '다른 설정 소유자가 승인할 수 있게 하거나(관리자 역할 · 전체 범위 · 로그인 수단), 키 보안 › 보호 장치에서 ‘두 사람 승인’ 을 끈 뒤 요청을 취소하고 다시 하세요(승인할 수 있는 소유자 둘을 확인한 적이 있는 포탈은 혼자 끌 수 없습니다).';
  }
  return `${what} 요청을 보냈습니다 — 다른 설정 소유자가 승인하면 ${then}${n != null ? `(승인할 수 있는 소유자 ${n}명)` : ''}. 키 보안 › 승인 대기에서 볼 수 있습니다.`;
}
/** 승인 대기 문구의 톤 — 승인할 사람이 없으면 'bad'. */
export const pendingTone = (r) => (finiteNum(r?.approvers) === 0 ? 'bad' : 'warn');

/** 키의 폴더 글자(법인 › 공통 / 서버별 › 서버 / 미분류). */
export function folderText(k, corpName = (x) => x) {
  if (!k || !k.folderCorp) return '미분류';
  return `${corpName(k.folderCorp)} › ${k.folderServer ? `서버별 › ${k.folderServer}` : '공통'}`;
}
/** 드롭다운의 키 한 줄 — 이름 · (퇴역) · 폴더. */
export function keyOptionLabel(k, corpName = (x) => x) {
  return `${k?.name || '—'}${k?.status === 'retired' ? ' (퇴역)' : ''} — ${folderText(k, corpName)}`;
}

/** 두 사람 승인을 거치는 쓰기(서버 SSH_KINDS 와 같은 목록 — 보호 장치 설명 · 끄기 안내가 이 글자 하나를 쓴다). */
export const TWO_PERSON_TARGETS = '키 등록 · 받은 키 승인 · 교체 · 삭제 · 법인 키 사용 재개 · 키 저장소 다시 읽기 · 보호 장치 끄기';
/** 보호 장치(스위치 둘) — 이름 · 설명. 설명에 시한 숫자를 박지 않는다(남은 시간은 요청마다 서버 값으로 보인다). */
export const GUARD_KEYS = Object.freeze(['twoPerson', 'serverRestrict']);
export const GUARD_TEXT = Object.freeze({
  twoPerson: Object.freeze({ label: '두 사람 승인', note: `${TWO_PERSON_TARGETS}는 다른 설정 소유자 1명이 승인해야 실행됩니다. 요청은 시한이 지나면 사라집니다. 승인할 수 있는 다른 설정 소유자가 없으면 요청을 만들지 않고 사유를 보입니다.` }),
  serverRestrict: Object.freeze({ label: '서버 쪽 제한', note: '포탈이 서버에 넣는 키 줄에 ‘이 포탈 주소에서 올 때만’ · ‘포워딩 금지’ 를 붙입니다 — 키가 새도 서버가 본 주소가 이 포탈이 아닌 접속은 그 줄로 받지 않습니다. 주소는 서버가 본 것이라 같은 NAT 뒤의 다른 장비는 가르지 못하고, 사람이 넣은 줄 · 관리자가 옵션을 바꾼 줄에는 붙지 않습니다.' }),
});
/** 보호 장치 편집값 ↔ 지금 값 — 켜는 것 · 끄는 것(끄는 것은 다른 설정 소유자의 승인을 거칠 수 있다). 참/거짓이 아닌 값은 바꾸지 않는 것으로 본다. */
export function guardDiff(cur, draft) {
  const on = []; const off = [];
  for (const k of GUARD_KEYS) {
    if (typeof draft?.[k] !== 'boolean' || typeof cur?.[k] !== 'boolean' || draft[k] === cur[k]) continue;
    (draft[k] ? on : off).push(k);
  }
  return { on, off, changed: on.length + off.length };
}
/**
 * 보호 장치 저장 실패 문구(점검 E-7) — 켜는 것은 먼저 적용되고 끄는 쪽(요청 만들기 · 승인자 없음)이 실패할 수 있다.
 * 서버가 `partial.applied` 로 켠 것을 밝히면 그 사실을 먼저 말한다(실패로만 말하면 켠 것까지 안 된 줄 안다).
 */
export function guardFailText(body, reason = '') {
  const applied = Array.isArray(body?.partial?.applied) ? body.partial.applied.filter((k) => typeof k === 'string' && k) : [];
  const why = String(reason || body?.reason || '실패했습니다');
  if (!applied.length) return why;
  return `${applied.map((k) => GUARD_TEXT[k]?.label || k).join(' · ')} — 켰습니다(적용됨). 끄는 변경은 하지 못했습니다: ${why}`;
}
/**
 * 보호 장치를 끄는 규칙 안내(서버 `changeGuards` — 반증 R3 뒤): 두 사람 승인이 켜져 있으면 끄는 변경은 다른 소유자의 승인을 거친다.
 * 승인할 사람이 없을 때 본인 OTP 로 바로 끄는 지름길은 **승인할 수 있는 소유자 둘을 본 적이 없는 설치(pairSeen 아님)만**이다.
 * 못 받은 값을 지어내지 않는다 — pairSeen 이 참/거짓이 아니면 두 경우를 함께 말한다.
 */
export function guardOffRuleText(guards) {
  const g = guards && typeof guards === 'object' ? guards : {};
  const head = '두 사람 승인이 켜져 있으면 끄는 변경은 승인할 수 있는 다른 설정 소유자(관리자 역할 · 전체 범위 · 로그인 수단)의 승인을 거쳐 꺼집니다(켜는 변경은 바로 적용됩니다).';
  if (g.unreadable) return `${head} 상태 파일을 읽지 못해 지금은 바꿀 수 없습니다.`;
  if (g.pairSeen === true) return `${head} 이 포탈은 승인할 수 있는 설정 소유자 둘을 확인한 적이 있어, 승인할 다른 소유자가 없어져도 혼자 끌 수 없습니다 — 다른 소유자가 다시 승인할 수 있게 한 뒤 그 사람이 승인해야 합니다.`;
  if (g.pairSeen === false) return `${head} 승인할 수 있는 다른 소유자가 없으면 본인 OTP 로 바로 꺼집니다(이 포탈은 승인할 수 있는 소유자 둘을 확인한 적이 없습니다 — 한 번 확인되면 그 뒤로는 혼자 끌 수 없습니다).`;
  return `${head} 승인할 다른 소유자가 없을 때 본인 OTP 로 바로 꺼지는 것은 승인할 수 있는 소유자 둘을 확인한 적이 없는 포탈뿐입니다.`;
}
/** 보호 장치 저장 결과 문구 — 202 면 끄는 변경이 승인을 기다린다(켜는 변경은 그때도 바로 적용된다). */
export function guardSaveText(r, diff) {
  const names = (ks) => (ks || []).map((k) => GUARD_TEXT[k]?.label || k).join(' · ');
  if (r?.pending) {
    const n = finiteNum(r.approvers);
    return `${diff?.on?.length ? `${names(diff.on)} — 켰습니다. ` : ''}${names(diff?.off) || '보호 장치'} 끄기는 다른 설정 소유자의 승인을 기다립니다${n != null ? `(승인할 수 있는 소유자 ${n}명)` : ''} — 승인되면 꺼집니다.`;
  }
  const done = [diff?.on?.length ? `${names(diff.on)} 켬` : '', diff?.off?.length ? `${names(diff.off)} 끔` : ''].filter(Boolean).join(' · ');
  return finiteNum(r?.changed) === 0 ? '바뀐 것이 없습니다.' : `보호 장치를 저장했습니다${done ? ` — ${done}` : ''}.`;
}

/**
 * 승인 요청이 실행할 내용(요청 본문 — 비밀 없음: 이름 · 종류 · 지문 · 폴더 · 허용 기능). 모르는 종류는 빈 글자.
 * 승인하는 사람이 보는 것 = 요청 지문(digest)에 묶인 것이다 — 허용 기능이 본문에 없으면(예전 요청) 지어내지 않고 적지 않는다.
 */
export function approvalDetail(req, corpName = (x) => x, catalog = []) {
  const p = req?.payload && typeof req.payload === 'object' ? req.payload : {};
  switch (req?.kind) {
    case 'ssh-key-activate': {
      const feat = p.features === null || Array.isArray(p.features) ? ` · 쓸 수 있는 기능 ${featuresText(p.features, catalog)}` : '';
      return `키 ${p.name || '—'}${p.algo ? ` · ${p.algo}` : ''} · 지문 ${shortFp(p.fingerprint)} · 폴더 ${folderText(p, corpName)}${feat} — 승인하면 이 키가 접속에 쓰이기 시작합니다`;
    }
    case 'ssh-key-rotate': return `옛 키 ${p.fromName || p.from || '—'} → 새 키 ${p.toName || p.to || '—'} — 옛 키를 쓰는 서버 · 공통 계정을 새 키로 옮기고 옛 키를 퇴역시킵니다(서버의 authorized_keys 는 바꾸지 않습니다)`;
    case 'ssh-key-delete': return `키 ${p.name || '—'} · 지문 ${shortFp(p.fingerprint)} — 쓰는 곳이 없을 때만 지워집니다`;
    case 'ssh-corp-resume': return `${corpName(p.corp)} — 이 법인의 키 접속을 다시 엽니다`;
    case 'ssh-keystore-reload': return '디스크의 키 저장소 파일 내용을 새 기준으로 받아들입니다 — 포탈 밖에서 바뀐 키도 다시 쓰입니다';
    case 'ssh-guard-change': {
      const off = GUARD_KEYS.filter((k) => p.patch && p.patch[k] === false).map((k) => GUARD_TEXT[k].label);
      return `끄는 보호 장치: ${off.join(' · ') || '—'}`;
    }
    default: return '';
  }
}
/**
 * 승인 대기 키에 살아 있는 등록 요청 — 있으면 그 요청을 돌려보내야(취소해야) 키가 지워지고, 없으면(요청 뒷정리가 실패해 남은 키) 키 폴더에서 바로 지울 수 있다
 * (서버 `service.deleteKeyReq` 와 같은 기준 — 최종 판정은 서버). 없으면 null.
 */
export function pendingKeyRequest(view, keyId) {
  if (!keyId) return null;
  return splitApprovals(view?.approvals).pending.find((r) => r.kind === 'ssh-key-activate' && r.target === keyId) || null;
}

/** 끝난 요청의 결과 한 줄(실패 사유 · 메모). */
export function approvalOutcome(r) {
  if (!r) return '';
  if (r.status === 'failed') return r.result?.reason || '실행하지 못했습니다(다시 하려면 새로 요청합니다)';
  if (r.status === 'expired') return '승인되지 않은 채 시한이 지났습니다';
  if (r.status === 'approved') return '실행 결과가 아직 적히지 않았습니다(실행 중이거나 그 사이 포탈이 멈춤) — 그대로면 얼마 뒤 실행 실패(중단)로 확정됩니다';
  return r.note || '';
}
/** 키 교체(회전) 결과 문구 — 수를 모르면 ‘—’(단위 없이). */
export function rotateDoneText(r) {
  return `서버 ${unitText(Array.isArray(r?.servers) ? r.servers.length : null, '대')} · 공통 계정 ${unitText(finiteNum(r?.accounts), '개')}를 새 키로 옮기고 옛 키를 퇴역시켰습니다`;
}
/**
 * 키 교체가 중간에 실패했을 때 이미 옮긴 곳(점검 E-9 — 서버 `refs.rotateKey` 의 partial: { servers:id[], accounts?:number }).
 * accounts 가 없으면 공통 계정 단계 전에 멈춘 것이다. 어느 경우든 옛 키는 퇴역하지 않았다. partial 이 없으면 ''.
 */
export function rotatePartialText(partial) {
  if (!partial || typeof partial !== 'object') return '';
  const n = Array.isArray(partial.servers) ? partial.servers.length : null;
  const acc = finiteNum(partial.accounts);
  return `일부는 이미 옮겼습니다 — 서버 ${unitText(n, '대')}${acc != null ? ` · 공통 계정 ${unitText(acc, '개')}` : '(공통 계정은 옮기기 전에 멈춤)'}가 새 키를 가리킵니다. 옛 키는 퇴역시키지 못했습니다 — 같은 교체를 다시 하면(두 사람 승인이 켜져 있으면 새 요청) 남은 곳을 옮깁니다.`;
}
/** 승인 · 실행은 됐는데 결과를 승인 기록에 적지 못했을 때(서버 recordFailed — 점검 C-8). 아니면 ''. */
export function recordFailedText(r) {
  if (r?.recordFailed !== true) return '';
  return ` 다만 실행 결과를 승인 기록에 적지 못했습니다(${r.recordReason || '사유를 받지 못함'}) — 승인 기록에는 ‘승인됨(실행 결과 아직 없음)’ 으로 남았다가 얼마 뒤 ‘실행 실패(실행 여부 모름)’ 로 바뀔 수 있습니다. 이번 실행 자체는 됐습니다.`;
}
/** 법인 키 사용 중지 결과(점검 E-8) — 등록부를 못 읽었으면 법인으로만 걸렸다는 것을 밝힌다. */
export function stopDoneText(r, corpLabel = '') {
  const head = `${corpLabel} — 키 사용을 중지했습니다`;
  if (r?.registryUnreadable === true) {
    return `${head}(법인으로만). OS 계정 등록부를 읽지 못해 그 법인 서버 목록을 함께 적지 못했습니다 — 서버의 법인 칸을 바꾸면 이 중지에서 빠질 수 있습니다. 등록부를 고친 뒤 서버 목록을 확인하세요.`;
  }
  const n = finiteNum(r?.servers);
  const edge = finiteNum(r?.edgeServers);
  return `${head}${n != null ? `(이 노드가 접속하는 서버 ${n}대를 함께 적음)` : ''}.${edge > 0 ? ` 엣지가 수집하는 서버 ${edge}대는 그 엣지 포탈에서 따로 중지해야 합니다.` : ''}`;
}

/** 키 보안 사건의 부가 설명 — 사람이 읽을 것만(받는 곳 새 파일의 detail 은 내부 표지라 싣지 않는다). 보호 장치 키 이름은 화면 이름으로. */
const EVENT_DETAIL_KINDS = new Set(['guard-changed', 'approval-requested', 'approval-decided', 'key-login-set', 'key-lines-removed', 'corp-stop', 'inbox-approved', 'keystore-reloaded', 'key-job-done', 'key-revoke-done', 'key-job-interrupted']);
export function eventDetail(e) {
  if (!e || !EVENT_DETAIL_KINDS.has(e.kind)) return '';
  const d = String(e.detail || '').slice(0, 300);
  if (e.kind !== 'guard-changed') return d;
  return d.split('twoPerson=').join(`${GUARD_TEXT.twoPerson.label} `).split('serverRestrict=').join(`${GUARD_TEXT.serverRestrict.label} `);
}

/* ── v3.10.0 — 키 로그인 설정 · 키 거두기(작업 결과 — 서버마다 한 줄) ──────────────── */

/** 작업 결과 code → 짧은 글자(서버 reason 이 없을 때의 대체). 서버 `keyLogin.js` · `service.js`(작업 행) · `refs.AUTH_ERROR` 의 code 와 1:1. */
export const JOB_CODE_TEXT = Object.freeze({
  ok: '완료', removed: '지움', 'not-present': '포탈이 넣은 줄 없음', none: 'authorized_keys 파일 없음',
  'edge-delegated': '엣지가 수집하는 서버 — 그 엣지 포탈에서 합니다', moved: '서버가 지워졌거나 접속처(주소 · 포트 · 계정)가 바뀜', 'not-found': '서버를 찾을 수 없음',
  'key-folder': '키가 다른 법인 · 다른 서버의 폴더에 있음', 'key-feature': '키가 이 기능에 허용되지 않음', 'key-pending': '승인 대기 중인 키', 'key-retired': '퇴역한 키',
  'key-tampered': '키가 포탈 밖에서 바뀜', 'key-missing': '키를 찾을 수 없음', 'key-unreadable': '키를 열지 못함', 'key-parse': '키를 풀지 못함',
  'key-changed': '작업 도중 키가 퇴역 · 삭제 · 변경돼 하지 않음',
  'account-missing': '공통 계정이 없음', 'account-kind': '공통 계정이 OS 계정이 아님', 'account-tampered': '공통 계정이 포탈 밖에서 바뀜', 'store-unreadable': '키 저장소를 읽지 못함',
  'corp-stopped': '법인 키 사용 중지 중', 'state-unreadable': '상태 파일을 읽지 못함', 'no-secret': '저장된 인증 수단 없음',
  'auth-rejected': '인증 거부(다시 시도하지 않음)', 'no-password-method': '서버가 비밀번호 로그인을 받지 않음(보내지 않음)', hostkey: '호스트키 미신뢰', connect: '접속 실패', timeout: '서버가 시한 안에 답하지 않음',
  // 바꾸는 명령을 보낸 뒤 답을 못 받음 — ‘바꾼 것 없음’ 이 아니다(서버의 명령은 끊겨도 끝까지 돌 수 있다)
  uncertain: '명령은 보냈지만 답을 받지 못함 — 서버의 authorized_keys 가 바뀌었을 수 있음',
  'install-failed': '줄을 넣지 못함', 'key-login-failed': '키 접속 확인 실패', 'bind-failed': '서버 설정에 적지 못함', 'revoke-failed': '줄을 지우지 못함', 'bad-key': '공개키 꼴이 올바르지 않음',
  cancelled: '작업을 멈춰 이 서버는 하지 않음', 'over-limit': '한 번에 처리하는 상한을 넘어 이번 작업에서 빠짐', demo: '데모(mock) 모드에서는 서버에 접속하지 않음',
  // 같은 공통 계정 비밀번호가 이 작업의 다른 서버에서 거부돼 건너뜀(같은 디렉터리 인증이면 서버 수만큼 실패가 쌓여 계정이 잠긴다)
  'auth-skipped': '같은 공통 계정 비밀번호가 다른 서버에서 거부돼 건너뜀(계정 잠금 방지)',
  error: '처리 중 오류',
});
/** 서버에 손대지 않고 넘어간 사유(시도 자체를 하지 않았다 — 실패와 따로 센다). 글자가 따로 있는 것은 SKIP_LABEL. */
const SKIP_CODES = new Set(['edge-delegated', 'moved', 'not-found', 'key-changed', 'cancelled', 'over-limit', 'auth-skipped']);
const SKIP_LABEL = Object.freeze({ cancelled: '멈춤', 'over-limit': '빠짐(상한)', 'auth-skipped': '건너뜀' });
/** 거두기에서 시도하지 않은 것 가운데 키 줄이 그대로 남은 것(위험 톤) — 엣지 위임 · 접속처 바뀜과 달리 이 노드가 할 일이 남았다. */
const REVOKE_LEFT_CODES = new Set(['cancelled', 'over-limit', 'auth-skipped']);
/** 결과를 모르는 행 — 명령을 보냈는데 답이 없다(실패도 성공도 아니다). */
const UNCERTAIN_LABEL = '결과 모름';
const LINE_TEXT = Object.freeze({
  added: '공개키 줄을 더하고 키 접속 확인',
  // 서버 쪽 제한이 켜져 있을 때 제한 없는(또는 다른 주소의) 포탈 줄을 제한 줄로 다시 씀 — 서버의 기존 줄을 바꿨다는 사실을 결과에 보인다(점검 E-4)
  replaced: '제한 없는(또는 다른 주소의) 포탈 줄을 제한 줄로 바꾸고 키 접속 확인',
  'present-marked': '포탈이 넣은 줄이 이미 있어 그대로 두고 키 접속 확인',
  'present-unmarked': '같은 키 줄이 이미 있어(표식 없음 — 사람이 넣은 줄) 그대로 두고 키 접속 확인',
});
const rowOf = (r) => (r && typeof r === 'object' ? r : {});
const failText = (row) => row.reason || JOB_CODE_TEXT[row.code] || row.code || '사유를 받지 못했습니다';
const notesOf = (row) => (Array.isArray(row.notes) ? row.notes.filter((x) => typeof x === 'string' && x) : []);
const PINNED_TEXT = '이 서버는 아직 이 키로 접속하도록 설정돼 있습니다(이름 고정 또는 법인 공통 계정의 기본 키) — 법인 · 서버 탭의 ‘키 고르기’ 나 공통 계정의 기본 키를 바꾸세요';

/**
 * 키 로그인 설정 결과 한 줄. meta = 작업의 설정(restrict · removePassword — 서버 job.meta).
 * 서버 쪽 제한이 켜져 있는데 이 서버에 제한 없는(또는 확인 못 한) 같은 키 줄이 남으면 ‘확인’ 톤이다 — 초록으로 끝내지 않는다(점검 E-5).
 * @returns {{label:string, tone:'ok'|'warn'|'bad'|'muted', parts:string[], rollback:''|'done'|'failed'|'unknown'}}
 *   rollback: 더한 줄을 되돌렸는가('done') · 되돌리지 못했는가('failed') · 되돌렸는지 모르는가('unknown' — 서버 rollbackUnknown) · 해당 없음('')
 */
export function keyLoginRow(r, meta = {}) {
  const row = rowOf(r);
  if (row.ok !== true) {
    if (SKIP_CODES.has(row.code)) return { label: SKIP_LABEL[row.code] || '하지 않음', tone: 'warn', parts: [failText(row)], rollback: '' };
    return { label: row.code === 'uncertain' ? UNCERTAIN_LABEL : '실패', tone: 'bad', parts: [failText(row), ...notesOf(row)],
      rollback: row.rolledBack === true ? 'done' : row.rollbackUnknown === true ? 'unknown' : row.rolledBack === false ? 'failed' : '' };   // 모르면 ‘못함’ 이라고 하지 않는다(1회차 반증 11)
  }
  const parts = [LINE_TEXT[row.line] || '키 접속 확인'];
  const unmarked = finiteNum(row.unmarked) || 0;
  const custom = finiteNum(row.custom) || 0;
  let warn = unmarked > 0 || custom > 0;
  if (row.restricted === true) parts.push(`출발지 제한 적용${row.fromIp ? `(${row.fromIp})` : ''} · 포워딩 금지`);
  else if (meta?.restrict === true) {
    // 제한을 켰는데 붙지 않았다 — 사람이 넣은 줄 · 바꾸지 못한 제한 없는 포탈 줄 · 관리자가 바꾼 줄(서버 메모가 자세한 사유를 준다)
    warn = true;
    parts.push(row.line === 'present-unmarked' || unmarked > 0 || row.replaceSkipped === true
      ? '서버 쪽 제한이 켜져 있지만 제한 없는 같은 키 줄이 서버에 남아 있습니다 — 그 줄로도 접속됩니다'
      : '서버 쪽 제한이 켜져 있지만 이 서버의 키 줄에 제한이 붙었는지 확인되지 않았습니다');
  } else if (row.line === 'added') parts.push(meta?.restrict === false ? '서버 쪽 제한 없이 넣음(보호 장치 꺼짐)' : '서버 쪽 제한 없이 넣음');
  // bound = 이 서버가 이 키를 쓰게 됐다(이미 쓰던 서버 — 법인 기본 키를 따르는 서버 포함 — 는 그대로 둔다: ‘고정’ 이라고 말하지 않는다).
  if (row.bound === true) parts.push('이 서버가 이 키를 쓰도록 설정됨');
  // passwordRemoved: true = 지움 · null = 지울 것이 없었음(서버 항목에 저장된 비밀번호 없음) · false = 지우지 못함(사유는 note)
  if (row.passwordRemoved === true) parts.push('저장 비밀번호 삭제');
  else if (row.passwordRemoved === null && meta?.removePassword === true) parts.push('지울 저장 비밀번호 없음');
  if (finiteNum(row.oldRemoved) != null) parts.push(`옛 키 줄 ${row.oldRemoved}개 삭제`);
  if (finiteNum(row.oldUnmarked) > 0) parts.push(`표식 없는 옛 키 줄 ${row.oldUnmarked}개는 남김(사람이 넣은 줄 — 직접 지우세요)`);
  if (row.note) parts.push(String(row.note));
  return { label: '완료', tone: warn || row.note || finiteNum(row.oldUnmarked) > 0 ? 'warn' : 'ok', parts, rollback: '' };
}

/**
 * 키 거두기 결과 한 줄 — 지움 / 포탈 줄 없음 / 파일 없음 / 못 닿음 / 실패 / 결과 모름.
 * 심볼릭 링크 · 못 읽음 · 못 씀은 서버가 ‘revoke-failed’(실패)로 준다 — ‘파일 없음’ 과 섞지 않는다.
 * 표식 없는 같은 키 줄이 남았거나 서버가 아직 그 키를 쓰도록 설정돼 있으면(이름 고정 · 공통 계정 기본 키) ‘확인’ 톤.
 * 멈춤 · 상한으로 빠짐 · 비밀번호 거부로 건너뜀은 키 줄이 그대로 남았으므로 ‘위험’ 톤(긴급 조치가 끝나지 않았다).
 * @returns {{label:string, tone:'ok'|'warn'|'bad'|'muted', parts:string[], rollback:''}}
 */
export function keyRevokeRow(r) {
  const row = rowOf(r);
  if (row.ok !== true) {
    if (SKIP_CODES.has(row.code)) {
      return { label: SKIP_LABEL[row.code] || '하지 않음', tone: REVOKE_LEFT_CODES.has(row.code) ? 'bad' : 'warn', parts: [failText(row)], rollback: '' };
    }
    const failed = row.code === 'revoke-failed' || row.code === 'bad-key' || row.code === 'error' || row.code === 'key-tampered';
    const parts = [failText(row)];
    if (row.pinned === true) parts.push(PINNED_TEXT);
    return { label: row.code === 'uncertain' ? UNCERTAIN_LABEL : failed ? '실패' : '못 닿음', tone: 'bad', parts, rollback: '' };
  }
  const parts = []; let label; let tone;
  if (row.code === 'removed') { label = '지움'; tone = 'ok'; parts.push(`포탈이 넣은 줄 ${unitText(finiteNum(row.removed), '개')} 삭제`); }
  else if (row.code === 'not-present') { label = '포탈 줄 없음'; tone = 'muted'; parts.push('포탈이 넣은 이 키의 줄이 없습니다(지운 것 없음)'); }
  else if (row.code === 'none') { label = '파일 없음'; tone = 'muted'; parts.push('authorized_keys 파일이 없습니다(지울 줄 없음)'); }
  else { label = JOB_CODE_TEXT[row.code] || row.code || '끝남'; tone = 'muted'; }
  if (finiteNum(row.unmarked) > 0) { parts.push(`표식 없는 같은 키 줄 ${row.unmarked}개 남음 — 사람이 넣은 줄이라 지우지 않았습니다(서버에서 직접 지우세요)`); tone = 'warn'; }
  if (row.pinned === true) { parts.push(PINNED_TEXT); tone = 'warn'; }
  return { label, tone, parts, rollback: '' };
}

/**
 * 키 작업 머리말(점검 E-6) — 진행 중 · 끝남 · 더 묻지 못함을 가른다. 더 묻지 못하게 된 뒤에는 ‘도는 중’ 처럼 말하지 않는다(마지막으로 받은 값이라고 밝힌다).
 * @param {object|null} job  마지막으로 받은 서버 job
 * @param {{stopped?:boolean}} o  stopped = 진행을 더 묻지 않게 됨(404 · 연속 실패)
 */
export function jobHeadText(job, { stopped = false, own = true } = {}) {
  // own = 이 화면이 방금 시작한 작업 · false = 이미 있던 작업에 다시 붙음(‘시작했습니다’ 라고 하지 않는다 — 점검 E1-9)
  if (!job || typeof job !== 'object') {
    if (stopped) return own ? '작업을 시작했지만 진행을 받지 못했습니다.' : '이 작업의 진행을 받지 못했습니다.';
    return own ? '작업을 시작했습니다 — 진행을 묻는 중…' : '작업의 진행을 묻는 중…';
  }
  const done = Array.isArray(job.results) ? job.results.length : 0;
  const prog = `${done} / ${unitText(finiteNum(job.total), '대')}`;
  if (job.running === true) {
    if (stopped) return `마지막으로 받은 진행 ${prog}${job.current ? ` — 그때 처리 중 ${job.current}` : ''} · 그 뒤는 모릅니다`;
    return `진행 ${prog}${job.current ? ` — 지금 ${job.current}` : ''} · 1대씩 차례로 합니다${job.cancelled ? ` · 멈추는 중${job.cancelledBy ? `(${job.cancelledBy})` : '(작업이 스스로 멈춤)'} — 지금 서버를 끝낸 뒤 남은 서버는 하지 않음` : ''}`;
  }
  return `끝났습니다(${dateTime(job.doneAt)})${job.cancelled ? ` — 도중에 멈춤${job.cancelledBy ? `(${job.cancelledBy})` : '(작업이 스스로 멈춤 — 사유는 ‘멈춤’ 줄)'}` : ''}`;
}
/**
 * 진행을 더 묻지 못했을 때의 안내(점검 E-6). 404 = 서버가 작업 기록을 모른다(끝난 지 오래됐거나 포탈 재시작 — 서버 사유를 그대로 싣는다).
 * 재시작이면 그때 처리 중이던 서버는 줄을 바꾼 뒤 확인 · 되돌리기 전에 끊겼을 수 있다 — 마지막으로 본 서버 이름을 밝히고 확인할 곳을 가리킨다.
 * 종류별로 가른다(점검 E1-9): 넣기 = 줄을 바꾼 뒤 확인 · 되돌리기 전에 끊겼을 수 있음 · 거두기 = 확인 · 되돌리기 단계가 없다 — 지우는 명령을 보냈는지 모른다.
 */
export function jobLostText(status, reason, job, kind = '') {
  const why = String(reason || '').trim();
  const cur = job && job.running === true && job.current ? String(job.current) : '';
  const k = job?.kind === 'key-revoke' || job?.kind === 'key-login' ? job.kind : kind;
  if (status === 404) {
    const head = why ? (/[.)]$/.test(why) ? why : `${why}.`) : '작업 기록을 찾지 못했습니다.';
    const where = '법인 · 서버 탭 › 키 고르기 › ‘서버에 들어 있는 키 다시 읽기’ 로 확인하세요.';
    const tail = k === 'key-revoke'
      ? `처리 중이던 서버가 있었다면 지우는 명령을 보냈는지 모릅니다 — 그 키 줄이 남았는지 ${where}`
      : `처리 중이던 서버가 있었다면 줄을 바꾼 뒤 확인 · 되돌리기 전에 끊겼을 수 있으니, ${where}`;
    return `${head} ${cur ? `마지막으로 본 처리 중 서버는 ${cur} 입니다 — ` : ''}${tail}`;
  }
  return `진행을 더 묻지 못했습니다${why ? `(${why})` : ''} — 작업은 서버에서 계속되고 있을 수 있습니다.`;
}
/** 키 거두기를 시작했을 때의 문구 — 같은 키 넣기 작업을 멈췄는가(stopped) · 상한으로 빠진 서버(over-limit)를 밝힌다(점검 E-10). */
export function revokeStartText(r) {
  const skipped = Array.isArray(r?.skipped) ? r.skipped : [];
  const over = skipped.filter((x) => x && x.code === 'over-limit').length;
  const edge = skipped.filter((x) => x && x.code === 'edge-delegated').length;
  return [
    `키 거두기를 시작했습니다 — 서버 ${unitText(finiteNum(r?.total), '대')}에 1대씩 차례로 접속합니다. 아래에 서버마다 결과가 나옵니다.`,
    r?.stopped ? '같은 키를 넣던 키 로그인 설정 작업을 멈췄습니다(지금 처리 중인 서버를 끝낸 뒤 멈춤 — 거두는 키를 뒤 서버에 다시 넣지 않게).' : '',
    over ? `한 번에 거두는 상한을 넘은 서버 ${over}대는 이번 작업에서 빠졌습니다 — 이 화면은 법인 단위로만 거두므로, 그 서버는 서버에서 직접 지우세요(결과의 ‘빠짐’ 줄).` : '',
    edge ? `엣지가 수집하는 서버 ${edge}대는 그 엣지 포탈에서 거둡니다.` : '',
  ].filter(Boolean).join(' ');
}
/** 키 거두기의 1회 비밀번호 주의(점검 E-13) — 그 법인 서버 전부에 같은 비밀번호로 한 번씩 접속한다(저장 인증이 되던 서버까지). n 을 모르면 수 없이. */
export function revokeOnceWarn(n) {
  const cnt = finiteNum(n);
  return `넣으면 이 법인 서버${cnt != null ? ` ${cnt}대` : ''} 전부에 이 비밀번호로 한 번씩 접속합니다 — 저장된 인증으로 되던 서버도 이 비밀번호를 씁니다. 비밀번호가 다른 서버는 로그인 실패가 한 번 기록되고(다시 시도하지 않습니다) 계정 잠금 정책에 걸릴 수 있습니다. 두 서버에서 거부되면 작업이 스스로 멈추고 남은 서버는 하지 않습니다(남은 서버에는 키 줄이 그대로 남습니다).`;
}

/** 작업 진행 요약 — 수는 서버 값 그대로(총 대수를 모르면 null). */
export function jobSummary(job) {
  const results = Array.isArray(job?.results) ? job.results : [];
  const ok = results.filter((r) => r && r.ok === true).length;
  const total = finiteNum(job?.total);
  return { ok, fail: results.length - ok, done: results.length, total, left: total == null ? null : Math.max(0, total - results.length), running: job?.running === true, current: String(job?.current || '') };
}

/** 결과 글자별 개수 한 줄(‘완료 3 · 실패 1’) — 처음 나온 순서대로. 빈 목록은 ''. */
export function tallyText(labels) {
  const m = new Map();
  for (const l of Array.isArray(labels) ? labels : []) { const k = String(l || ''); if (k) m.set(k, (m.get(k) || 0) + 1); }
  return [...m].map(([k, n]) => `${k} ${n}`).join(' · ');
}

/** 키 로그인 설정 창의 ‘서버 쪽 제한’ 줄 — 보호 장치 설정을 읽기 전용으로 보인다(요청마다 고르는 값이 아니다). 못 받은 값을 켬 · 끔으로 지어내지 않는다. */
export function restrictLineText(guards) {
  const g = guards && typeof guards === 'object' ? guards : null;
  if (!g || typeof g.serverRestrict !== 'boolean') return '설정을 받지 못했습니다 — 서버가 보호 장치 설정대로 넣습니다(결과 줄에 적용 여부가 나옵니다).';
  if (g.unreadable) return '상태 파일을 읽지 못해 켠 것으로 봅니다 — 넣는 줄에 출발지 제한 · 포워딩 금지를 붙입니다.';
  return g.serverRestrict
    ? '켬 — 넣는 줄에 ‘이 포탈 주소에서 올 때만’ · ‘포워딩 금지’ 를 붙입니다(키 보안 › 보호 장치의 설정 — 여기서 고르지 않습니다).'
    : '끔 — 제한 없이 넣습니다(키 보안 › 보호 장치에서 켭니다).';
}

/**
 * ‘저장된 인증 사용’ 을 골랐을 때의 주의 — 서버는 **지금 설정된 접속 수단**으로 첫 접속을 한다(키로 설정돼 있으면 그 키 — 비밀번호로 넘어가지 않는다).
 *  · 키로 설정돼 있는데 그 키가 서버에 들어 있다고 확인된 적이 없는 서버 → 저장된 인증으로는 거부될 수 있다(한 번 · 재시도 없음).
 *  · 저장된 인증 수단이 없는 서버 → 1회 비밀번호가 있어야 한다.
 * 화면이 접속 가능 여부를 판정하는 것은 아니다(마지막으로 읽은 authorized_keys 기준의 안내 — 실제 결과는 서버가 준다).
 * @returns {string[]} 안내 문장(없으면 빈 배열)
 */
export function savedAuthHints(targets, { keyId = '', accounts = [] } = {}) {
  const list = Array.isArray(targets) ? targets.filter(Boolean) : [];
  // 서버에 설정된 키가 **지금 넣으려는 그 키** 이고 저장 비밀번호(서버 또는 공통 계정)가 있으면, 서버는 첫 접속에 그 비밀번호를 쓴다(keyLogin.firstLegAuth) — 주의할 것 없음.
  const accPw = new Map((Array.isArray(accounts) ? accounts : []).map((a) => [a.name, a.hasPassword === true]));
  const storedPw = (s) => s.hasPassword === true || (!!s.accountName && accPw.get(s.accountName) === true);
  const byKey = list.filter((s) => (s.keyMode === 'pinned' || s.keyMode === 'corp-default') && s.installed?.hasKey !== true
    && !(keyId && s.keyId === keyId && storedPw(s))).length;
  // 저장된 수단이 없는 서버 — keyMode ‘none’ 만이 아니다: 비밀번호로 고정됐는데 서버 · 공통 계정 어디에도 비밀번호가 없는 서버도(점검 E1-10 · hasStoredSecret)
  const none = list.filter((s) => hasStoredSecret(s, accounts) === false).length;
  const out = [];
  if (byKey) out.push(`서버 ${byKey}대는 지금 키로 접속하도록 설정돼 있는데, 그 키가 서버에 들어 있는지 확인된 적이 없습니다 — 들어 있지 않으면 저장된 인증으로는 접속이 거부됩니다(다시 시도하지 않습니다). 그런 서버는 ‘지금 입력’ 으로 비밀번호를 넣으세요.`);
  if (none) out.push(`서버 ${none}대는 저장된 인증 수단이 없습니다 — ‘지금 입력’ 으로 비밀번호를 넣어야 합니다.`);
  return out;
}

/** 키 로그인 설정 대상으로 고를 수 있는 서버인가 — 엣지가 수집하는 서버는 그 엣지 포탈에서 한다(키는 법인 밖으로 나가지 않는다). */
export const keyLoginSelectable = (s) => !!s && !s.agent;

const usableKey = (k, tampered) => !!k && k.status === 'active' && !(Array.isArray(tampered) ? tampered : []).includes(k.id);
/**
 * 여러 서버에 한 번에 넣을 수 있는 키 — 그 법인 **공통 폴더**의 활성 키(승인 대기 · 퇴역 · 바꿔치기 의심 제외).
 * 서버별 폴더 키는 그 서버 하나에만 쓰이므로 여러 대에는 내놓지 않는다(서버 한 대는 후보 API 가 판정한다). 최종 판정은 서버가 다시 한다.
 */
export function keyLoginKeyOptions(view, corp) {
  const keys = Array.isArray(view?.keys) ? view.keys : [];
  return keys.filter((k) => usableKey(k, view?.tampered) && (k.folderCorp || '') === (corp || '') && !k.folderServer);
}
/** 그 법인 서버에 줄이 있을 수 있는 키(그 법인 폴더 · 미분류 — 퇴역 포함 · 승인 대기 제외). 키 거두기 · ‘교체 — 옛 키 줄 삭제’ 의 선택지. */
export function corpKeyOptions(view, corp, { exclude = '' } = {}) {
  const keys = Array.isArray(view?.keys) ? view.keys : [];
  return keys.filter((k) => k && k.status !== 'pending' && k.id !== exclude && (!k.folderCorp || k.folderCorp === (corp || '')));
}
/** 키 교체(회전)의 새 키 선택지 — 활성 · 바꿔치기 의심 아님 · 자기 자신 제외(폴더가 맞는지는 서버가 판정해 충돌 목록을 준다). */
export function rotateTargetOptions(view, key) {
  const keys = Array.isArray(view?.keys) ? view.keys : [];
  return keys.filter((k) => usableKey(k, view?.tampered) && k.id !== key?.id);
}
/** 처음 골라 둘 키 — 후보가 하나뿐이면 그것, 아니면 서버가 지금 쓰는 키(후보에 있을 때), 그 밖은 고르지 않음(''). */
export function defaultKeyChoice(options, currentId = '') {
  const list = Array.isArray(options) ? options : [];
  if (list.length === 1) return list[0].id;
  return currentId && list.some((k) => k.id === currentId) ? currentId : '';
}

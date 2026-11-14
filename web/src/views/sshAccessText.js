/**
 * sshAccessText.js — 설정 › 보안 › SSH 공용 접속 화면의 문구 · 표시 도우미(순수 — React · api.js 를 import 하지 않는다: vitest node 환경).
 * 판정(이 서버에 이 키를 쓸 수 있는가 · 키 점검 등급)은 서버가 한다 — 여기는 서버가 준 값을 글자로 바꾸고 목록을 묶기만 한다.
 */

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
});

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
 * 서버 표 ‘상태’ 칸 — 실제로 접속을 막는 사유를 먼저(서버가 준 값 그대로 · 화면이 폴더 · 기능을 새로 판정하지 않는다).
 * @returns {{label:string, tone:'ok'|'warn'|'bad'|'muted', title?:string}}
 */
export function serverStatus(s, { tampered = [], stop = false } = {}) {
  if (s.accountMissing) return { label: '공통 계정 없음', tone: 'bad' };
  if (s.keyMissing) return { label: '키 없음(삭제됨)', tone: 'bad' };
  if (stop && (s.keyMode === 'pinned' || s.keyMode === 'corp-default')) return { label: '키 사용 중지', tone: 'bad', title: '법인 키 사용 중지 — 이 노드는 이 서버에 키로 접속하지 않습니다.' };
  if (s.keyId && (tampered || []).includes(s.keyId)) return { label: '키가 포탈 밖에서 바뀜', tone: 'bad' };
  if (s.placementIssue) return { label: ISSUE_TEXT[s.placementIssue] || s.placementIssue, tone: 'bad' };
  if (s.keyStatus === 'retired') return { label: '퇴역 키', tone: 'bad' };
  if (s.keyMode === 'none') return { label: '인증 수단 없음', tone: 'bad' };
  if (s.keyMode === 'password') return { label: '비밀번호', tone: 'warn' };
  if (Array.isArray(s.keyFeatures) && !COLLECT_FEATURES.some((f) => s.keyFeatures.includes(f))) return { label: '수집 기능 미허용', tone: 'warn', title: '이 키의 ‘쓸 수 있는 기능’ 에 베어메탈 사용률 · 스토리지가 없습니다 — 주기 수집이 이 키로 접속하지 않습니다.' };
  return { label: '키', tone: 'ok' };
}

/** 감사 로그 시각(ISO 문자열 — UTC) → ms. 못 읽으면 0. 화면은 dateTime 으로 이 브라우저 시각에 맞춘다(사건 행과 같은 시간대). */
export function auditTime(at) {
  const n = Date.parse(String(at || ''));
  return Number.isFinite(n) ? n : 0;
}

/** 받는 곳 승인 때 기본 이름(파일 이름 → 키 이름 규칙에 맞는 글자). 서버 NAME_RE 와 같은 글자만 남긴다(서버가 다시 판정한다). */
export function suggestKeyName(item) {
  const base = `${String(item?.corp || '').slice(0, 20)}-${String(item?.server || 'common').slice(0, 24)}-${String(item?.file || 'key').slice(0, 16)}`;
  const s = base.replace(/[^A-Za-z0-9가-힣._-]/g, '-').replace(/^[^A-Za-z0-9가-힣]+/, '').replace(/-{2,}/g, '-').slice(0, 64);
  return s || 'imported-key';
}

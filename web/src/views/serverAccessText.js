/**
 * serverAccessText.js — 설정 › 보안 › 서버 접속(SSH · Windows)의 **계층 지정(법인 › OS 종류 › 서버)** · 공통 계정 화면 도우미
 * (v3.24 · 설계 docs/design/server-access §4.6 · 순수 — React · api.js 를 import 하지 않는다: vitest node 환경).
 *
 * 판정(이 서버가 어느 단계의 계정을 쓰는가 · 승인이 살아 있는가)은 **서버가 한다**(refs.effectiveAccountOf — 응답의 source · level · pending · mismatch).
 * 여기는 그 값을 글자로 바꾸고 트리를 묶기만 한다. 단, ‘이 단계에 지정을 바꾸면 무엇이 닿는가’ 미리 보기(nodeAccount)는 화면용 어림이다 —
 * 저장 때 서버가 같은 규칙으로 다시 세고(affected) 다르면 서버 값이 맞다.
 */

export const LEVELS = Object.freeze(['all', 'linux', 'windows']);
export const LEVEL_LABEL = Object.freeze({ all: '법인', linux: 'Linux', windows: 'Windows' });
export const OS_LABEL = Object.freeze({ linux: 'Linux', windows: 'Windows', none: 'OS 미지정' });

/** 공통 계정 종류 글자 — Linux · Windows 로컬 · Windows AD(예전 계정 os '' 는 Linux). */
export function accountKindText(a) {
  if (!a) return '—';
  if (a.os === 'windows') return a.logon === 'ad' ? 'Windows AD' : 'Windows 로컬';
  return 'Linux';
}
/** 계정 OS 계열(서버 응답 family 가 있으면 그것 — 없으면 os 로). */
export const familyOf = (a) => (a?.family || (a?.os === 'windows' ? 'windows' : 'linux'));
/** 서버 OS 칸 → 트리 키. 빈 값은 'none'(OS 미지정). */
export const serverOsKey = (s) => (s?.os === 'linux' || s?.os === 'windows' ? s.os : 'none');

/** 지정 찾기(서버 응답 assign 배열). 못 읽었으면(assign null) undefined — ‘없음’ 과 다르다. */
export function assignOf(assign, corp, level) {
  if (!Array.isArray(assign)) return undefined;
  return assign.find((x) => x.corp === corp && x.level === level) || null;
}

/**
 * 트리(법인 › OS 종류). 서버 잎은 OS 노드마다 앞 maxLeaves 대(나머지는 ‘N대 더’). 엣지 위임 서버는 세지만 물려받지 않는다(그 엣지에서 정한다).
 * @returns {{id:string, kind:'corp'|'os', corp:string, os?:string, count:number, state:'set'|'inherit'|'empty'|'unknown', leaves?:object[], more?:number}[]}
 */
export function buildHierTree({ corps = [], servers = [], assign = null, accounts = [] } = {}, { maxLeaves = 5 } = {}) {
  const out = [];
  const accById = new Map((accounts || []).map((a) => [a.id, a]));
  for (const c of corps || []) {
    const cs = (servers || []).filter((s) => (s.vcenterId || '') === c.id);
    const all = assignOf(assign, c.id, 'all');
    out.push({ id: `corp:${c.id}`, kind: 'corp', corp: c.id, count: cs.length, state: all === undefined ? 'unknown' : (all ? 'set' : 'empty') });
    for (const os of ['linux', 'windows', 'none']) {
      const list = cs.filter((s) => serverOsKey(s) === os);
      const na = nodeAccount({ corp: c.id, os }, assign, accById);
      out.push({ id: `os:${c.id}:${os}`, kind: 'os', corp: c.id, os, count: list.length, state: na.state,
        leaves: list.slice(0, maxLeaves), more: Math.max(0, list.length - maxLeaves) });
    }
  }
  return out;
}

/**
 * 노드의 계정 — 이 단계에 정함(set) · 위(법인)에서 물려받음(inherit) · 비움(empty) · 상태 파일 모름(unknown).
 * OS 미지정 노드는 OS 단계를 건너뛰고 법인 단계 계정이 Linux 계열일 때만 닿는다(서버 판정 effectiveAccountOf 와 같은 규칙).
 * @param {{corp:string, os?:'linux'|'windows'|'none'}} node  os 없으면 법인 노드
 */
export function nodeAccount(node, assign, accById = new Map()) {
  const all = assignOf(assign, node.corp, 'all');
  if (all === undefined) return { state: 'unknown' };
  if (!node.os) return all ? { state: 'set', level: 'all', assign: all, account: accById.get(all.account) || null } : { state: 'empty' };
  if (node.os === 'linux' || node.os === 'windows') {
    const own = assignOf(assign, node.corp, node.os);
    if (own) return { state: 'set', level: node.os, assign: own, account: accById.get(own.account) || null };
  }
  const fam = node.os === 'windows' ? 'windows' : 'linux';
  if (all) {
    const acc = accById.get(all.account) || null;
    if (acc && familyOf(acc) === fam) return { state: 'inherit', level: 'all', assign: all, account: acc };
    return { state: 'empty', blockedByOs: !!acc };
  }
  return { state: 'empty' };
}

/** 서버의 계정 출처 → 글자 · 톤 · 설명(서버 응답 source · pending · inheritStale · mismatch · agent). */
export function serverSourceText(s) {
  if (!s) return { label: '—', tone: 'muted' };
  if (s.agent) return { label: '엣지에서 정함', tone: 'muted', title: '엣지가 수집하는 서버 — 계정은 그 엣지 포탈에서 정합니다.' };
  if (s.source === 'own') return { label: '따로 정함', tone: 'warn', title: '이 서버만의 계정 · 키 · 비밀번호 — 위 단계를 바꿔도 이 서버는 그대로입니다.' };
  if (s.source === 'os') return { label: 'OS 종류에서 물려받음', tone: 'ok' };
  if (s.source === 'corp') return { label: '법인에서 물려받음', tone: 'ok' };
  if (s.inheritStale) return { label: '승인 대기(주소 · OS 바뀜)', tone: 'warn', title: '승인 뒤 주소 · 포트 · OS 가 바뀌어 물려받지 않습니다 — 다시 승인하세요.' };
  if (s.pending) return { label: '승인 대기', tone: 'warn', title: '위 단계에 계정이 있지만 이 서버는 아직 물려받도록 승인되지 않았습니다(설정 소유자 + 본인 OTP).' };
  if (s.mismatch) return { label: '법인 계정 OS 다름', tone: 'muted', title: '법인 단계 계정의 OS 가 이 서버와 달라 닿지 않습니다 — OS 종류 단계에 계정을 정하세요.' };
  return { label: '미설정', tone: 'bad', title: '어느 단계에도 계정이 없습니다 — 접속하지 않습니다.' };
}

/** 계정 단위 정지(서버 응답 stop) → 글자. current:false 는 비밀번호를 바꿔 이미 풀린 옛 기록. */
export function accountStopText(stop) {
  if (!stop) return null;
  if (stop.unreadable) return { label: '정지 상태 모름', tone: 'bad' };
  if (!stop.current) return { label: '정지 기록(비밀번호 바꿔 풀림)', tone: 'muted' };
  return { label: '로그인 거부 — 정지 중', tone: 'bad' };
}

/** 비밀번호 나이 · 교체 예정 글자. 모르면 '—'(0 으로 지어내지 않는다). */
export function passwordAgeText(a, now = Date.now()) {
  if (!a || !a.hasPassword) return '저장하지 않음';
  const age = Number.isFinite(a.pwAgeDays) ? `${a.pwAgeDays}일 전 등록` : '등록 시각 모름';
  if (a.rotateDue) return `${age} · 교체 예정일이 지났습니다`;
  if (a.rotateBy) {
    const left = Math.ceil((a.rotateBy - now) / 86_400_000);
    return `${age} · 교체 예정 ${left > 0 ? `${left}일 뒤` : '오늘'}`;
  }
  return age;
}

/** 지정할 수 있는 계정(그 법인 · 전 법인 공용 · 단계 OS 계열). 법인 단계는 OS 를 가리지 않는다(닿는 서버는 계열이 같은 서버뿐). */
export function assignableAccounts(accounts = [], corp = '', level = 'all') {
  return (accounts || []).filter((a) => (!a.corp || a.corp === corp) && (level === 'all' || familyOf(a) === level));
}

/** 서버 표에 보일 서버(노드 아래). OS 노드 'none' = OS 미지정. */
export function serversOfNode(servers = [], node = {}) {
  return (servers || []).filter((s) => (s.vcenterId || '') === node.corp && (node.kind !== 'os' || serverOsKey(s) === node.os));
}

/** 로그인 이름 미리 보기(서버 keyStore.loginNameOf 와 같은 규칙 — 화면 입력 중 보여 주기만). */
export function loginNamePreview({ os = '', logon = '', domain = '', username = '' } = {}) {
  const u = String(username || '').trim();
  const d = String(domain || '').trim();
  if (os !== 'windows' || logon !== 'ad' || !d) return u;
  return d.includes('.') ? `${u}@${d}` : `${d.toUpperCase()}\\${u}`;
}

/**
 * 교체 예정일(ms) → 입력 칸 값 'YYYY-MM-DD'. 서버는 날짜만 받아 **UTC 자정**으로 저장한다(keyStore dateMs) — 그래서 같은 달력 날짜로
 * 되돌리려면 UTC 날짜로 읽는다(로컬 날짜로 읽으면 UTC 보다 늦은 시간대에서 하루 앞당겨져 다시 저장된다). 못 읽으면 ''.
 */
export function rotateByInput(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '';
  const d = new Date(n);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

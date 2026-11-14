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
  if (s.keyStatus === 'pending') return { label: '키 승인 대기', tone: 'bad', title: '이 키는 다른 설정 소유자의 승인을 기다립니다 — 승인되기 전에는 이 키로 접속하지 않습니다.' };
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

/** 내가 낸 요청인가 — 이름 비교는 소문자(서버 approval/store 와 같은 규칙). 내 이름을 모르면 false(단추를 잠그지 않고 서버의 403 사유를 보인다). */
export function isOwnRequest(req, username) {
  const me = String(username || '').trim().toLowerCase();
  return !!me && me === String(req?.requestedBy || '').trim().toLowerCase();
}

/**
 * 202(승인 대기) 응답 문구. approvers = 요청자 말고 승인할 수 있는 설정 소유자 수(서버 값 — 모르면 수를 적지 않는다).
 * 0명이면 ‘승인할 사람이 없다’ 고 말하고 보호 장치 스위치를 가리킨다(요청은 승인되지 못한 채 시한이 지나 사라진다).
 */
export function pendingText(r, { what = '요청', then = '실행됩니다' } = {}) {
  const n = finiteNum(r?.approvers);
  if (n != null && n <= 0) {
    return `${what} 요청을 보냈지만 승인할 수 있는 다른 설정 소유자가 없습니다 — 이 요청은 승인되지 못한 채 시한이 지나면 사라집니다. `
      + '설정 소유자를 한 명 더 두거나, 키 보안 › 보호 장치에서 ‘두 사람 승인’ 을 끈 뒤(다른 소유자가 없으면 본인 OTP 로 꺼집니다) 요청을 취소하고 다시 하세요.';
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

/** 보호 장치(스위치 둘) — 이름 · 설명. 설명에 시한 숫자를 박지 않는다(남은 시간은 요청마다 서버 값으로 보인다). */
export const GUARD_KEYS = Object.freeze(['twoPerson', 'serverRestrict']);
export const GUARD_TEXT = Object.freeze({
  twoPerson: Object.freeze({ label: '두 사람 승인', note: '키 등록 · 받은 키 승인 · 교체 · 삭제 · 법인 키 사용 재개 · 키 저장소 다시 읽기 · 보호 장치 끄기는 다른 설정 소유자 1명이 승인해야 실행됩니다. 요청은 시한이 지나면 사라집니다.' }),
  serverRestrict: Object.freeze({ label: '서버 쪽 제한', note: '서버에 넣는 키 줄에 ‘이 포탈 주소에서 올 때만’ · ‘포워딩 금지’ 를 붙입니다 — 키가 새도 다른 곳에서는 쓸 수 없습니다.' }),
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

/** 키 보안 사건의 부가 설명 — 사람이 읽을 것만(받는 곳 새 파일의 detail 은 내부 표지라 싣지 않는다). 보호 장치 키 이름은 화면 이름으로. */
const EVENT_DETAIL_KINDS = new Set(['guard-changed', 'approval-requested', 'approval-decided', 'key-login-set', 'key-lines-removed', 'corp-stop', 'inbox-approved', 'keystore-reloaded']);
export function eventDetail(e) {
  if (!e || !EVENT_DETAIL_KINDS.has(e.kind)) return '';
  const d = String(e.detail || '').slice(0, 300);
  if (e.kind !== 'guard-changed') return d;
  return d.split('twoPerson=').join(`${GUARD_TEXT.twoPerson.label} `).split('serverRestrict=').join(`${GUARD_TEXT.serverRestrict.label} `);
}

/* ── v3.10.0 — 키 로그인 설정 · 키 거두기(작업 결과 — 서버마다 한 줄) ──────────────── */

/** 작업 결과 code → 짧은 글자(서버 reason 이 없을 때의 대체). 서버 `keyLogin.js` · `refs.AUTH_ERROR` 의 code 와 1:1. */
export const JOB_CODE_TEXT = Object.freeze({
  ok: '완료', removed: '지움', 'not-present': '포탈이 넣은 줄 없음', none: 'authorized_keys 파일 없음',
  'edge-delegated': '엣지가 수집하는 서버 — 그 엣지 포탈에서 합니다', moved: '접속처가 화면에서 본 것과 다름', 'not-found': '서버를 찾을 수 없음',
  'key-folder': '키가 다른 법인 · 다른 서버의 폴더에 있음', 'key-feature': '키가 이 기능에 허용되지 않음', 'key-pending': '승인 대기 중인 키', 'key-retired': '퇴역한 키',
  'key-tampered': '키가 포탈 밖에서 바뀜', 'key-missing': '키를 찾을 수 없음', 'key-unreadable': '키를 열지 못함', 'key-parse': '키를 풀지 못함',
  'account-missing': '공통 계정이 없음', 'account-kind': '공통 계정이 OS 계정이 아님', 'account-tampered': '공통 계정이 포탈 밖에서 바뀜', 'store-unreadable': '키 저장소를 읽지 못함',
  'corp-stopped': '법인 키 사용 중지 중', 'state-unreadable': '상태 파일을 읽지 못함', 'no-secret': '저장된 인증 수단 없음',
  'auth-rejected': '인증 거부(다시 시도하지 않음)', hostkey: '호스트키 미신뢰', connect: '접속 실패',
  'install-failed': '줄을 넣지 못함', 'key-login-failed': '키 접속 확인 실패', 'bind-failed': '서버 설정에 적지 못함', 'revoke-failed': '줄을 지우지 못함', 'bad-key': '공개키 꼴이 올바르지 않음',
  error: '처리 중 오류',
});
/** 서버에 손대지 않고 넘어간 사유(시도 자체를 하지 않았다 — 실패와 따로 센다). */
const SKIP_CODES = new Set(['edge-delegated', 'moved', 'not-found']);
const LINE_TEXT = Object.freeze({
  added: '공개키 줄을 더하고 키 접속 확인',
  'present-marked': '포탈이 넣은 줄이 이미 있어 그대로 두고 키 접속 확인',
  'present-unmarked': '같은 키 줄이 이미 있어(표식 없음 — 사람이 넣은 줄) 그대로 두고 키 접속 확인',
});
const rowOf = (r) => (r && typeof r === 'object' ? r : {});
const failText = (row) => row.reason || JOB_CODE_TEXT[row.code] || row.code || '사유를 받지 못했습니다';

/**
 * 키 로그인 설정 결과 한 줄. meta = 작업의 설정(restrict · removePassword — 서버 job.meta).
 * @returns {{label:string, tone:'ok'|'warn'|'bad'|'muted', parts:string[], rollback:''|'done'|'failed'}}
 *   rollback: 더한 줄을 되돌렸는가('done') · 되돌리지 못했는가('failed') · 해당 없음('')
 */
export function keyLoginRow(r, meta = {}) {
  const row = rowOf(r);
  if (row.ok !== true) {
    const skip = SKIP_CODES.has(row.code);
    return { label: skip ? '하지 않음' : '실패', tone: skip ? 'warn' : 'bad', parts: [failText(row)], rollback: row.rolledBack === true ? 'done' : row.rolledBack === false ? 'failed' : '' };
  }
  const parts = [LINE_TEXT[row.line] || '키 접속 확인'];
  if (row.restricted === true) parts.push(`출발지 제한 적용${row.fromIp ? `(${row.fromIp})` : ''} · 포워딩 금지`);
  else if (row.line === 'added') parts.push('서버 쪽 제한 없이 넣음(보호 장치 꺼짐)');
  else if (meta?.restrict === true) parts.push('있던 줄이라 서버 쪽 제한을 새로 붙이지 않음');
  // bound = 이 서버가 이 키를 쓰게 됐다(이미 쓰던 서버 — 법인 기본 키를 따르는 서버 포함 — 는 그대로 둔다: ‘고정’ 이라고 말하지 않는다).
  if (row.bound === true) parts.push('이 서버가 이 키를 쓰도록 설정됨');
  // passwordRemoved: true = 지움 · null = 지울 것이 없었음(서버 항목에 저장된 비밀번호 없음) · false = 지우지 못함(사유는 note)
  if (row.passwordRemoved === true) parts.push('저장 비밀번호 삭제');
  else if (row.passwordRemoved === null && meta?.removePassword === true) parts.push('지울 저장 비밀번호 없음');
  if (finiteNum(row.oldRemoved) != null) parts.push(`옛 키 줄 ${row.oldRemoved}개 삭제`);
  if (finiteNum(row.oldUnmarked) > 0) parts.push(`표식 없는 옛 키 줄 ${row.oldUnmarked}개는 남김(사람이 넣은 줄 — 직접 지우세요)`);
  if (row.note) parts.push(String(row.note));
  return { label: '완료', tone: row.note || finiteNum(row.oldUnmarked) > 0 ? 'warn' : 'ok', parts, rollback: '' };
}

/**
 * 키 거두기 결과 한 줄 — 지움 / 포탈 줄 없음 / 파일 없음 / 못 닿음. 표식 없는 같은 키 줄이 남았거나 서버가 아직 그 키로 고정돼 있으면 ‘확인’ 톤.
 * @returns {{label:string, tone:'ok'|'warn'|'bad'|'muted', parts:string[], rollback:''}}
 */
export function keyRevokeRow(r) {
  const row = rowOf(r);
  if (row.ok !== true) {
    const skip = SKIP_CODES.has(row.code);
    const failed = row.code === 'revoke-failed' || row.code === 'bad-key' || row.code === 'error';
    return { label: skip ? '하지 않음' : failed ? '실패' : '못 닿음', tone: skip ? 'warn' : 'bad', parts: [failText(row)], rollback: '' };
  }
  const parts = []; let label; let tone;
  if (row.code === 'removed') { label = '지움'; tone = 'ok'; parts.push(`포탈이 넣은 줄 ${unitText(finiteNum(row.removed), '개')} 삭제`); }
  else if (row.code === 'not-present') { label = '포탈 줄 없음'; tone = 'muted'; parts.push('포탈이 넣은 이 키의 줄이 없습니다(지운 것 없음)'); }
  else if (row.code === 'none') { label = '파일 없음'; tone = 'muted'; parts.push('authorized_keys 파일이 없습니다(지울 줄 없음)'); }
  else { label = JOB_CODE_TEXT[row.code] || row.code || '끝남'; tone = 'muted'; }
  if (finiteNum(row.unmarked) > 0) { parts.push(`표식 없는 같은 키 줄 ${row.unmarked}개 남음 — 사람이 넣은 줄이라 지우지 않았습니다(서버에서 직접 지우세요)`); tone = 'warn'; }
  if (row.pinned === true) { parts.push('이 서버는 아직 이 키로 고정돼 있습니다 — 법인 · 서버 탭의 ‘키 고르기’ 에서 바꾸세요'); tone = 'warn'; }
  return { label, tone, parts, rollback: '' };
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
  const none = list.filter((s) => s.keyMode === 'none').length;
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

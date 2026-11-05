/**
 * components/invSearchQuery.js — 헤더 ⌘K '통합 장비 검색' 의 화면 쪽 순수 모듈(v2.909).
 *
 * 설계: docs/design/inventory-search/README.md(컨펌 2026-11-05). 판정(범위 · 권한 · 가림 · 일치)은 **서버**가 한다 —
 * 여기는 ① 접두 표(칩 표시용 — 서버 `server/src/search/inventoryQuery.js` 와 같은 값, 서버 테스트가 대조한다)
 * ② 결과 행 → 이동(focusPlan) · ‘모두 보기’(listPlan) ③ 최근 연 항목(localStorage) 만 가진다.
 *
 * 이동은 기존 화면 주소(도구 키 불변) + 검색어 인계(hooks/searchHandoff.js)다 — 아래 focusPlan · listPlan.
 */

export const KINDS = Object.freeze([
  { key: 'vm', label: '가상머신', prefix: 'vm' },
  { key: 'host', label: 'VM호스트', prefix: 'host' },
  { key: 'server', label: '베어메탈 서버', prefix: 'bm' },
  { key: 'gpu', label: 'GPU 서버', prefix: 'gpu' },
  { key: 'storage', label: '스토리지', prefix: 'st' },
  { key: 'sanswitch', label: 'SAN 스위치', prefix: 'san' },
  { key: 'netswitch', label: '네트워크 스위치', prefix: 'net' },
  { key: 'pdu', label: 'PDU', prefix: 'pdu' },
  { key: 'datastore', label: '데이터스토어', prefix: 'ds' },
  { key: 'vcenter', label: 'vCenter', prefix: 'vc' },
  { key: 'ip', label: 'IP 대장', prefix: 'ip' },
]);

export const PREFIXES = Object.freeze({
  ...Object.fromEntries(KINDS.filter((k) => k.key !== 'ip').map((k) => [k.prefix, { kind: k.key }])),
  ip: { mode: 'ip' },
  sn: { mode: 'sn' },
});

export const KIND_LABEL = Object.freeze(Object.fromEntries(KINDS.map((k) => [k.key, k.label])));
/** 행 태그(좁은 칸) 짧은 이름. */
export const KIND_SHORT = Object.freeze({
  vm: '가상머신', host: 'VM호스트', server: '베어메탈', gpu: 'GPU', storage: '스토리지', sanswitch: 'SAN',
  netswitch: '네트워크', pdu: 'PDU', datastore: '데이터스토어', vcenter: 'vCenter', ip: 'IP',
});
export const MODE_LABEL = Object.freeze({ ip: 'IP', sn: '시리얼' });

const PREFIX_RE = /^([a-z]{2,4}):/i;

/** 입력 → { prefix, kind, mode, rest } — 칩 표시 · Esc 처리용. 해석의 진실은 서버(같은 규칙). */
export function splitPrefix(raw) {
  const s = typeof raw === 'string' ? raw.trimStart() : '';
  const m = PREFIX_RE.exec(s);
  const p = m ? PREFIXES[m[1].toLowerCase()] : null;
  if (!p) return { prefix: '', kind: null, mode: 'all', rest: s };
  return { prefix: m[1].toLowerCase(), kind: p.kind || null, mode: p.mode || 'all', rest: s.slice(m[0].length).trimStart() };
}

/** 칩 하나를 고르면 입력의 접두를 그 종류로 바꾼다(다시 누르면 지움). */
export function withKindPrefix(raw, kind) {
  const { rest, kind: cur } = splitPrefix(raw);
  if (!kind || cur === kind) return rest;
  const k = KINDS.find((x) => x.key === kind);
  return k && k.key !== 'ip' ? `${k.prefix}:${rest}` : `ip:${rest}`;
}

const enc = encodeURIComponent;

/*
 * 이동 — 기존 화면 주소 + 검색어 인계(hooks/searchHandoff.js, v2.616 규약: 검색어 · IP · 시리얼은 **URL 에 싣지 않고 메모리로** 넘긴다).
 *   시안 ④ 는 `#/vms?focus=` 처럼 주소에 실었지만 위 규약과 어긋나 바꿨다(docs/design/inventory-search/README.md §7).
 *   - 행 하나: 이미 있는 상세 주소가 있으면 그것(VM `#/vcenters/<vc>/vm/<id>` v2.895 · 호스트 `#/hosts/<id>` v2.805 · vCenter `#/vcenters/<id>`),
 *     없으면 그 화면의 검색 칸에 장비 이름(베어메탈은 서비스 태그)을 넣고, **v2.911(A1 · A2)부터 고른 장비 id 를 함께 넘겨 그 화면이 상세를 연다**
 *     (`<target>:focus` — 받는 쪽은 hooks/useSearchHandoff.js useFocusHandoff).
 *   - ‘모두 보기’(컨펌 ③): 그 화면의 검색 칸에 지금 검색어를 넣는다. v2.911(A3) PDU 화면에 검색 칸이 생겨 모든 종류가 걸러 보기가 된다.
 * 받는 쪽 target 은 useSearchHandoff · useFocusHandoff 를 쓰는 화면 · App(가상머신 · VM호스트 · 스토리지 탭의 상단 검색)과 글자 그대로 같아야 한다
 * (invSearchQuery.test.js 가 소스로 대조한다).
 */
const SCREEN = Object.freeze({
  vm: { hash: '#/vms', target: 'vms' },
  host: { hash: '#/hosts', target: 'hosts' },
  datastore: { hash: '#/datastores', target: 'datastores', focus: 'datastores:focus' },
  vcenter: { hash: '#/vcenters', target: 'vcenters' },
  server: { hash: '#/tools/serveranalysis/info', target: 'serveranalysis', focus: 'serveranalysis:focus' },
  // 물리 GPU 서버는 서버 분석 › GPU 에서 상세 창이 없다(iDRAC 서버만 연다) — 검색 칸만.
  gpu: { hash: '#/tools/serveranalysis/gpu', target: 'serveranalysis-gpu' },
  storage: { hash: '#/tools/storage-mon/devices', target: 'storage-mon', focus: 'storage-mon:focus' },
  sanswitch: { hash: '#/tools/san-switch', target: 'san-switch', focus: 'san-switch:focus' },
  netswitch: { hash: '#/tools/cvp/devices', target: 'cvp', focus: 'cvp:focus' },
  pdu: { hash: '#/tools/pdu/list', target: 'pdu', focus: 'pdu:focus' },
  ip: { hash: '#/ipam', target: 'ipam' },
  parts: { hash: '#/tools/serial-lookup', target: 'serial-lookup' },
});
/** 검색어를 받을 수 있는 화면인가(‘모두 보기’ 문구가 달라진다). */
export const canFilter = (kind) => !!SCREEN[kind]?.target;
export const HANDOFF_TARGETS = Object.freeze([...new Set(Object.values(SCREEN).map((s) => s.target).filter(Boolean))]);
export const FOCUS_TARGETS = Object.freeze(Object.values(SCREEN).map((s) => s.focus).filter(Boolean));

const masked = (row) => !!row?.addrHidden && String(row?.name || '').endsWith('(이름 가림)');

/** 결과 행 → { hash, handoffs:[[target, 값], …] }. 모르는 종류는 null. */
export function focusPlan(row) {
  const sc = SCREEN[row?.kind];
  if (!sc) return null;
  const id = row.id ? String(row.id) : '';
  if (row.kind === 'vm' && id && row.vcenterId) return { hash: `#/vcenters/${enc(row.vcenterId)}/vm/${enc(id)}`, handoffs: [] };
  if (row.kind === 'host' && id) return { hash: `#/hosts/${enc(id)}`, handoffs: [] };
  if (row.kind === 'vcenter' && id) return { hash: `#/vcenters/${enc(id)}`, handoffs: [] };
  const term = row.kind === 'server' ? (row.serials?.[0] || row.name) : row.kind === 'ip' ? (row.id || row.name) : row.name;
  const handoffs = [];
  if (sc.target && term && !masked(row)) handoffs.push([sc.target, String(term)]);
  if (sc.focus && id) handoffs.push([sc.focus, id]);
  return { hash: sc.hash, handoffs };
}

/** 종류 + 검색어 → ‘모두 보기’ 이동(그 화면의 검색 칸으로 — 컨펌 ③). */
export function listPlan(kind, text) {
  const sc = SCREEN[kind];
  if (!sc) return null;
  const q = String(text || '').trim();
  return { hash: sc.hash, handoffs: sc.target && q ? [[sc.target, q]] : [] };
}

/** 저장된 이동(최근 항목)을 지금 모양으로 — v2.909 의 `handoff:[t,q]` 하나짜리도 읽는다. 값은 길이를 자른다. */
export function normPlan(plan) {
  if (!plan || typeof plan.hash !== 'string' || !plan.hash.startsWith('#/')) return null;
  const raw = Array.isArray(plan.handoffs) ? plan.handoffs : (Array.isArray(plan.handoff) ? [plan.handoff] : []);
  const handoffs = raw.filter((h) => Array.isArray(h) && h.length === 2 && h[0] && h[1]).slice(0, 4)
    .map(([t, q]) => [String(t).slice(0, 40), String(q).slice(0, 200)]);
  return { hash: plan.hash.slice(0, 400), handoffs };
}

/** ‘모두 보기’ 링크의 화면 이름. */
export const LIST_SCREEN = Object.freeze({
  vm: '가상머신 탭', host: 'VM호스트 탭', datastore: '스토리지 탭', vcenter: 'Platform', server: '서버 분석',
  gpu: '서버 분석 › GPU', storage: '스토리지 모니터링', sanswitch: 'SAN 스위치', netswitch: 'Arista CVP', pdu: 'PDU 정보', ip: 'IP관리',
});

// ── 최근 연 항목(컨펌 ④ — 브라우저 localStorage 10개). 저장소가 막혀 있으면 조용히 빈 목록(편의 기능). ──
export const RECENT_KEY = 'ui.invSearch.recent';
export const RECENT_MAX = 10;
/**
 * 계정별 키(반증 L-4 — 같은 브라우저를 쓰는 다음 계정에게 앞 계정이 연 장비 이름 · 법인 · vCenter/VM id 가 보이지 않게).
 * 계정을 모르면 저장하지 않는 키(null)를 돌려준다.
 */
export function recentKeyFor(username) {
  const u = String(username ?? '').trim();
  return u ? `${RECENT_KEY}:${encodeURIComponent(u).slice(0, 120)}` : null;
}

export function readRecent(storage = globalThis.localStorage, key = RECENT_KEY) {
  if (!key) return [];
  try {
    const v = JSON.parse(storage?.getItem(key) || '[]');
    if (!Array.isArray(v)) return [];
    return v.filter((x) => x && typeof x.name === 'string' && normPlan(x.plan)).slice(0, RECENT_MAX).map((x) => ({ ...x, plan: normPlan(x.plan) }));
  } catch { return []; }
}

/** 맨 앞에 넣고 같은 이동은 하나만. 저장하는 것은 이름 · 종류 · 법인 · 이동(plan) · 시각뿐(상태 값은 낡으므로 넣지 않는다). */
export function pushRecent(item, storage = globalThis.localStorage, now = Date.now(), key = RECENT_KEY) {
  if (!key) return [];
  const plan = normPlan(item?.plan);
  if (!plan) return readRecent(storage, key);
  const entry = { kind: String(item.kind || ''), name: String(item.name || '').slice(0, 120), corp: String(item.corp || '').slice(0, 80), plan, at: now };
  const sig = (x) => `${x.plan.hash}|${x.plan.handoffs.map((h) => h.join('|')).join('|')}`;
  const next = [entry, ...readRecent(storage, key).filter((x) => sig(x) !== sig(entry))].slice(0, RECENT_MAX);
  try { storage?.setItem(key, JSON.stringify(next)); } catch { /* 저장 차단 — 무시 */ }
  return next;
}

export function clearRecent(storage = globalThis.localStorage, key = RECENT_KEY) {
  try { if (key) storage?.removeItem(key); } catch { /* 무시 */ }
  return [];
}

/** '방금' · 'n분 전' · 'n시간 전' · 'n일 전'. 못 읽으면 ''. */
export function agoText(at, now = Date.now()) {
  const t = Number(at);
  if (!Number.isFinite(t) || t <= 0) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return '방금';
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return `${Math.floor(s / 86400)}일 전`;
}

// ── 행 표시(순수) ─────────────────────────────────────────────────────────────

/**
 * 이름에서 검색어 위치를 찾아 [앞, 일치, 뒤] — 대소문자 무시. 없으면 [이름, '', ''].
 * v2.911(B2): 통째로 없고 여러 낱말이면 처음 나오는 낱말 하나를 표시한다(나머지 낱말은 다른 칸에 있을 수 있다).
 */
export function highlightParts(text, needle) {
  const s = String(text ?? '');
  const n = String(needle ?? '').trim().toLowerCase();
  if (!n) return [s, '', ''];
  const low = s.toLowerCase();
  let i = low.indexOf(n); let len = n.length;
  if (i < 0 && /\s/.test(n)) {
    for (const w of n.split(/\s+/)) { const j = w ? low.indexOf(w) : -1; if (j >= 0 && (i < 0 || j < i)) { i = j; len = w.length; } }
  }
  return i < 0 ? [s, '', ''] : [s.slice(0, i), s.slice(i, i + len), s.slice(i + len)];
}

const normSn = (v) => String(v ?? '').toLowerCase().replace(/[\s:_.-]/g, '');

/** 상태 점 색(토큰 이름). 상태를 모르면 null — 점을 그리지 않는다. */
export function statusTone(status) {
  return { ok: 'green', warn: 'amber', down: 'red', off: 'faint' }[status] || null;
}

/** sn: 검색이면 걸린 시리얼, 아니면 첫 시리얼. */
export function shownSerial(row, mode, needle) {
  const list = Array.isArray(row?.serials) ? row.serials : [];
  if (mode === 'sn') { const n = normSn(needle); return list.find((s) => normSn(s).includes(n)) || list[0] || ''; }
  return list[0] || '';
}

/** ip: · 숫자 검색이면 걸린 IP, 아니면 첫 IP. */
export function shownIp(row, needle) {
  const ips = Array.isArray(row?.ips) ? row.ips : [];
  const n = String(needle ?? '').trim().toLowerCase();
  // 완전 일치를 먼저(v2.911 B1 — 멀티홈 VM 이 10.1.0.1 로 맨 앞에 왔는데 메타에는 10.1.0.11 이 보였다: Chromium 실측)
  return (n && (ips.find((ip) => ip.toLowerCase() === n) || ips.find((ip) => ip.toLowerCase().startsWith(n)))) || ips[0] || '';
}

/**
 * 행 메타(한 줄에 이어 붙일 조각들). 값이 없으면 조각을 넣지 않는다 — '—' 를 늘어놓지 않는다(못 읽은 값은 0 이 아니다).
 * 조각 = { t: 글자, mono?: true, tone?: 'warn'|'dim' }.
 */
export function metaParts(row, { mode = 'all', needle = '' } = {}) {
  if (!row) return [];
  const out = [];
  const add = (t, extra = {}) => { if (t) out.push({ t: String(t), ...extra }); };
  const ip = shownIp(row, mode === 'ip' || /^[0-9.]+$/.test(String(needle).trim()) ? needle : '');
  const more = Array.isArray(row.ips) && row.ips.length > 1 ? ` 외 ${row.ips.length - 1}` : '';
  const serial = shownSerial(row, mode, needle);
  // 상태는 법인 바로 뒤 — 메타가 길면 오른쪽이 잘리므로 판단에 쓰는 값을 앞에 둔다(1440 실측: 끝에 두면 '사용 62%' 가 잘렸다).
  const st = () => add(row.statusText, { dot: statusTone(row.status) });
  switch (row.kind) {
    case 'vm': add(row.corp); st(); add(ip ? `${ip}${more}` : 'IP —', { mono: !!ip }); add(row.sub); add(row.host); break;
    case 'host': add(row.corp); st(); add(ip, { mono: true }); add(row.model); add(serial, { mono: true }); add(row.sub); break;
    case 'server': add(row.corp); add(row.statusText); add(row.addr ? `관리 ${row.addr}` : '', { mono: true }); add(row.model); add(serial, { mono: true }); add(row.sub); break;
    case 'ip': add(row.alt); add(row.sub); add(row.corp); break;
    case 'datastore': add(row.corp); st(); add(row.sub); break;
    case 'vcenter': add(row.alt); st(); add(row.sub); break;
    default: // gpu · storage · sanswitch · netswitch · pdu
      add(row.corp); st(); add(row.model); add(row.sub); add(row.addr || (row.addrHidden ? '(주소 가림)' : ''), { mono: !!row.addr, tone: row.addr ? undefined : 'dim' });
      add(mode === 'sn' ? serial : '', { mono: true }); add(row.agent ? `엣지 ${row.agent}` : '');
  }
  return out;
}


/** 행 오른쪽 '어디로 가나' 표기. */
export const TO_LABEL = Object.freeze({
  vm: '가상머신 › 상세', host: 'VM호스트 › 상세', datastore: '스토리지 탭', vcenter: 'Platform', server: '서버 분석 › 정보',
  gpu: 'GPU 인벤토리', storage: '스토리지 모니터링', sanswitch: 'SAN 스위치', netswitch: 'Arista CVP', pdu: 'PDU 정보', ip: 'IP관리',
});

/** 색인 시각 → 'n초 전' 류(초 단위 포함). */
export function builtAgoText(at, now = Date.now()) {
  const t = Number(at);
  if (!Number.isFinite(t) || t <= 0) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  return s < 60 ? `${s}초 전` : agoText(t, now);
}

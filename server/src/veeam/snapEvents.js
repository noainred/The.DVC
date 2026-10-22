/**
 * veeam/snapEvents.js — vCenter 이벤트로 본 Veeam 백업 흔적(v2.754). Veeam 연동·VM 메모 없이 쓴다(사용자 지시).
 *
 * 근거: Veeam 은 VM 을 백업할 때마다 자기 vCenter 계정으로 그 VM 의 스냅샷을 만든다(VADP — Veeam KB1790). 이 포탈은 vCenter
 *   이벤트를 이미 로그 DB 에 장기 보관한다(logs/poller.js). 그래서 vCenter 에 요청을 더하지 않고, 저장된 이벤트에서
 *   **'Veeam 계정이 만든 스냅샷 생성 이벤트'** 를 골라 VM 별 마지막 시각·횟수를 낸다.
 *   ⚠ 이벤트(TaskEvent 'Task: Create virtual machine snapshot')에는 스냅샷 이름이 없을 수 있다(확인 못 함) — 그래서 이름이 아니라
 *   **만든 계정** 으로 Veeam 을 가린다. Veeam 계정 = ① 이름에 'veeam' ② 자동 학습(지금 'VEEAM BACKUP TEMPORARY SNAPSHOT' 이 있는 VM 의
 *   그 스냅샷 생성 이벤트를 만든 계정) ③ 설정 › Veeam 백업 서버에서 사람이 적은 계정.
 *
 * 범위: 이벤트는 포탈마다 자기가 직접 수집하는 vCenter 것만 있다. 엣지 위임(site) vCenter 는 그 엣지가 계산해 Veeam push 에 싣고
 *   (`snapEvents` 필드), 중앙은 그 엣지가 맡은 site vCenter 것만 정제해 받는다(sanitizeEdgeSnap · central.js veeam-data).
 *
 * 한계(화면이 말한다): 성공 여부는 모른다(스냅샷 생성 = 백업 시작에 가깝다) · 이벤트 보관 기간·수집 설정에 따른다 · 에이전트 백업은 스냅샷이 없다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';

export const LOOKBACK_DAYS = 7;
const DAY = 86_400_000;
const LEARN_WINDOW_MS = 15 * 60_000;     // 임시 스냅샷 생성 시각과 이벤트 시각의 허용 차(TaskEvent 는 큐 시각이라 조금 앞선다)
const MAX_ACCOUNTS = 32;                 // 사람이 적는 계정 상한
const MAX_LEARNED = 32;
const LEARNED_TTL_MS = 90 * DAY;         // 90일 동안 다시 보이지 않은 학습 계정은 버린다
const ACCOUNT_MAX_LEN = 128;
export const ROW_LIMIT = 20_000;

const s = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/** 이벤트 1건이 'VM 스냅샷 생성' 인가 — 실제 vCenter 는 TaskEvent('Task: Create virtual machine snapshot'), 데모는 VmSnapshotCreatedEvent. */
export function isSnapshotCreateEvent(row) {
  if (!row) return false;
  const t = `${row.type || ''} ${String(row.message || '').slice(0, 300)}`;
  if (/remove|revert|delete|consolidat/i.test(t)) return false;
  return /VmSnapshotCreated|create\s+(?:a\s+)?(?:virtual\s+machine\s+)?snapshot|CreateSnapshot/i.test(t);
}

const normAcct = (u) => s(String(u ?? ''), ACCOUNT_MAX_LEN).toLowerCase();
/** 'DOMAIN\\user' · 'user@domain' · 'user' 을 같은 계정으로 본다(사람이 적은 이름과 이벤트 계정의 표기가 다를 수 있다). */
function acctForms(u) {
  const a = normAcct(u);
  if (!a) return [];
  const bare = a.includes('\\') ? a.slice(a.lastIndexOf('\\') + 1) : a.split('@')[0];
  return [...new Set([a, bare].filter(Boolean))];
}

/**
 * Veeam 계정 판정기. accounts = 사람이 적은 계정 + 학습한 계정(배열). 이름에 'veeam' 이 든 계정은 항상 Veeam 으로 본다.
 * @returns {(user:string) => 'name'|'account'|null}
 */
export function makeVeeamAccountMatcher(accounts = []) {
  const set = new Set();
  for (const a of accounts) for (const f of acctForms(a)) set.add(f);
  return (user) => {
    const forms = acctForms(user);
    if (!forms.length) return null;
    if (forms[0].includes('veeam')) return 'name';
    return forms.some((f) => set.has(f)) ? 'account' : null;
  };
}

/**
 * 지금 Veeam 임시 스냅샷이 있는 VM(vm.veeamSnapTs — soapParse 가 그 이름으로만 싣는다)의 스냅샷 생성 이벤트를 만든 계정을 배운다.
 * 같은 VM 에서 그 시각 ±15분 안에 생성 이벤트가 하나뿐일 때만(둘 이상이면 어느 계정이 Veeam 인지 모른다).
 * @returns {string[]} 계정(원래 표기)
 */
export function learnAccounts(vms, rows) {
  const byName = new Map();
  for (const v of Array.isArray(vms) ? vms : []) {
    if (!v || !(Number(v.veeamSnaps) > 0) || !Number.isFinite(v.veeamSnapTs)) continue;
    const k = String(v.name || '').toLowerCase();
    if (k) byName.set(k, byName.has(k) ? null : v.veeamSnapTs);
  }
  if (!byName.size) return [];
  const hits = new Map(); // vm 이름 → 후보 계정 집합
  for (const r of Array.isArray(rows) ? rows : []) {
    const k = String(r?.entity || '').toLowerCase();
    const t0 = byName.get(k);
    if (t0 == null || !isSnapshotCreateEvent(r) || !r.user || Math.abs(Number(r.ts) - t0) > LEARN_WINDOW_MS) continue;
    let set = hits.get(k); if (!set) { set = new Set(); hits.set(k, set); }
    set.add(s(r.user, ACCOUNT_MAX_LEN));
  }
  const out = new Set();
  for (const set of hits.values()) if (set.size === 1) out.add([...set][0]);
  return [...out];
}

/**
 * 한 vCenter 의 VM 별 '마지막 Veeam 스냅샷 생성' — 순수.
 * @param {object[]} vms   그 vCenter 의 VM(스냅샷 모양 — id·name)
 * @param {object[]} rows  그 vCenter 의 스냅샷 이벤트(로그 DB 행 — ts·type·user·entity·message)
 * @param {{accounts?:string[], since?:number}} opts
 * @returns {{ byVm: Record<string,[number,number]>, events:number, ambiguous:number, unmatched:number }}  byVm 값 = [마지막 시각, 횟수]
 */
export function summarizeVeeamSnapEvents(vms, rows, { accounts = [], since = 0 } = {}) {
  const isVeeam = makeVeeamAccountMatcher(accounts);
  const byName = new Map();
  for (const v of Array.isArray(vms) ? vms : []) {
    if (!v || typeof v.id !== 'string') continue;
    const k = String(v.name || '').trim().toLowerCase();
    if (k) byName.set(k, byName.has(k) ? null : v.id); // null = 같은 이름의 VM 이 둘 이상(이벤트는 이름만 준다)
  }
  const byVm = {};
  let events = 0; let ambiguous = 0; let unmatched = 0;
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || !isSnapshotCreateEvent(r) || !isVeeam(r.user)) continue;
    const ts = Number(r.ts);
    if (!Number.isFinite(ts) || ts < since) continue;
    events++;
    const id = byName.get(String(r.entity || '').trim().toLowerCase());
    if (id === null) { ambiguous++; continue; }
    if (!id) { unmatched++; continue; }
    const cur = byVm[id];
    if (!cur) byVm[id] = [ts, 1];
    else { cur[1]++; if (ts > cur[0]) cur[0] = ts; }
  }
  return { byVm, events, ambiguous, unmatched };
}

/* ── 계정 저장(veeam-vc-accounts.json — 비밀 아님) ─────────────────────────────────────────────────────────── */
// { manual: [사람이 적은 계정] · learned: { 계정: 마지막으로 본 시각 } · pulled: [엣지 — 중앙에서 받은 계정] }

const FILE = () => path.join(config.configDir, 'veeam-vc-accounts.json');
let _acc = null;
let _loadError = '';
function loadAcc() {
  if (_acc) return _acc;
  _acc = { manual: [], learned: {}, pulled: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    _acc.manual = cleanAccountList(raw?.manual).list;
    _acc.pulled = cleanAccountList(raw?.pulled).list;
    if (isObj(raw?.learned)) for (const [k, v] of Object.entries(raw.learned).slice(0, MAX_LEARNED)) { const a = s(k, ACCOUNT_MAX_LEN); if (a && Number.isFinite(v)) _acc.learned[a] = v; }
  } catch (e) {
    if (e?.code !== 'ENOENT') { _loadError = '파일을 읽지 못했습니다'; try { preserveCorrupt(FILE()); } catch { /* */ } }
  }
  return _acc;
}
function persist() { atomicWriteFileSync(FILE(), JSON.stringify(_acc, null, 2)); }

/** 사람이 준 계정 목록 정리 — 문자열만·트림·길이·중복·상한. 버린 수를 돌려준다. */
export function cleanAccountList(raw) {
  const list = []; const seen = new Set(); let dropped = 0;
  for (const x of Array.isArray(raw) ? raw : String(raw ?? '').split(/[\n,;]+/)) {
    const a = typeof x === 'string' ? x.trim() : '';
    if (!a) continue;
    if (a.length > ACCOUNT_MAX_LEN || /[\x00-\x1f]/.test(a)) { dropped++; continue; } // eslint-disable-line no-control-regex
    const k = a.toLowerCase();
    if (seen.has(k)) continue;
    if (list.length >= MAX_ACCOUNTS) { dropped++; continue; }
    seen.add(k); list.push(a);
  }
  return { list, dropped };
}

/** 지금 판정에 쓰는 계정 전부(사람 + 중앙에서 받은 것 + 학습 — 90일 안에 다시 본 것). */
export function veeamAccounts(now = Date.now()) {
  const a = loadAcc();
  const learned = Object.entries(a.learned).filter(([, t]) => now - t <= LEARNED_TTL_MS).map(([k]) => k);
  return [...new Set([...a.manual, ...a.pulled, ...learned])];
}
export function accountView(now = Date.now()) {
  const a = loadAcc();
  return {
    manual: [...a.manual], pulled: [...a.pulled],
    learned: Object.entries(a.learned).filter(([, t]) => now - t <= LEARNED_TTL_MS).map(([name, lastSeen]) => ({ name, lastSeen })).sort((x, y) => y.lastSeen - x.lastSeen),
    loadError: _loadError || null,
  };
}
export function saveManualAccounts(raw) {
  const r = cleanAccountList(raw);
  loadAcc().manual = r.list; persist();
  return r;
}
/** 엣지: 중앙 pull 로 받은 계정(사람이 적은 것 + 중앙이 배운 것). 바뀌었을 때만 쓴다. */
export function applyPulledAccounts(raw) {
  const r = cleanAccountList(raw).list;
  const a = loadAcc();
  if (JSON.stringify(a.pulled) === JSON.stringify(r)) return false;
  a.pulled = r; persist();
  return true;
}
/** 학습 결과 반영 — 새 계정이거나 마지막으로 본 시각이 1시간 넘게 지났을 때만 쓴다(매 조회 쓰기 방지). */
export function rememberLearned(list, now = Date.now()) {
  if (!list?.length) return 0;
  const a = loadAcc();
  let changed = 0;
  for (const raw of list) {
    const k = s(raw, ACCOUNT_MAX_LEN);
    if (!k) continue;
    const prev = a.learned[k];
    if (prev != null && now - prev < 3_600_000) continue;
    a.learned[k] = now; changed++;
  }
  const keys = Object.keys(a.learned);
  if (keys.length > MAX_LEARNED) for (const k of keys.sort((x, y) => a.learned[x] - a.learned[y]).slice(0, keys.length - MAX_LEARNED)) delete a.learned[k];
  if (changed) persist();
  return changed;
}

/* ── 로컬 계산(이 포탈이 직접 이벤트를 모으는 vCenter) ─────────────────────────────────────────────────── */

/**
 * @param {object} db   getLogsDb() 결과
 * @param {string} vcenterId
 * @param {object[]} vms  그 vCenter 의 VM
 */
export async function localSnapSummary(db, vcenterId, vms, { now = Date.now(), days = LOOKBACK_DAYS } = {}) {
  const since = now - days * DAY;
  const f = { vcenterId, q: 'snapshot', since };
  const rows = typeof db.queryAsync === 'function' ? await db.queryAsync(f, ROW_LIMIT) : db.query(f, ROW_LIMIT, 0);
  const learned = learnAccounts(vms, rows);
  if (learned.length) rememberLearned(learned, now);
  const r = summarizeVeeamSnapEvents(vms, rows, { accounts: veeamAccounts(now), since });
  return { ...r, truncated: rows.length >= ROW_LIMIT, since, at: now };
}

/* ── 중앙: 엣지가 보낸 요약(인메모리 — 재시작하면 다음 push 까지 비고 화면이 그 사실을 말한다) ─────────── */

const MAX_EDGE_VCS = 64;
const MAX_EDGE_VMS = 30_000;
const FUTURE_SKEW_MS = 5 * 60_000;
const EDGE_STATUS = new Set(['ok', 'log-off', 'severity-filter']);
const _edge = new Map(); // vcenterId → { agent, at, edgeAt, days, byVm, events, ambiguous, unmatched, truncated }

/**
 * 엣지 push 의 snapEvents 정제 — 아는 필드만·객체만·상한·문자열 수치는 수로 · VM id 는 그 vCenter 접두사만 · 시각은 수신 시각으로 자른다.
 * owns(vcenterId) 가 false 인 vCenter 는 버리고 센다(그 엣지가 맡은 site vCenter 만).
 * @returns {{ items: object[], dropped: { notOwned:number, bad:number } }}
 */
export function sanitizeEdgeSnap(raw, owns, now = Date.now()) {
  const dropped = { notOwned: 0, bad: 0 };
  const items = [];
  for (const x of (Array.isArray(raw) ? raw : []).slice(0, MAX_EDGE_VCS)) {
    if (!isObj(x)) { dropped.bad++; continue; }
    const vcenterId = s(x.vcenterId, 128);
    const status = EDGE_STATUS.has(x.status) ? x.status : 'ok';
    if (!vcenterId || (status === 'ok' && !isObj(x.byVm))) { dropped.bad++; continue; }
    if (!owns(vcenterId)) { dropped.notOwned++; continue; }
    const prefix = `${vcenterId}:`;
    const byVm = {};
    let n = 0;
    for (const [id, v] of Object.entries(isObj(x.byVm) ? x.byVm : {})) {
      if (n >= MAX_EDGE_VMS) break;
      if (typeof id !== 'string' || id.length > 300 || !id.startsWith(prefix) || !Array.isArray(v)) continue;
      const ts = Number(v[0]); const c = Number(v[1]);
      if (!Number.isFinite(ts) || ts <= 0 || !Number.isInteger(c) || c < 1) continue;
      byVm[id] = [Math.min(ts, now), Math.min(c, 10_000)];
      n++;
    }
    const num = (v) => (Number.isInteger(v) && v >= 0 ? Math.min(v, 1e7) : 0);
    const at = Number(x.at);
    items.push({ vcenterId, status, byVm, events: num(x.events), ambiguous: num(x.ambiguous), unmatched: num(x.unmatched), truncated: x.truncated === true,
      days: Number.isInteger(x.days) && x.days > 0 && x.days <= 90 ? x.days : LOOKBACK_DAYS,
      edgeAt: Number.isFinite(at) && at > 0 ? at : null, at: Number.isFinite(at) && at > 0 && at <= now + FUTURE_SKEW_MS ? Math.min(at, now) : now });
  }
  return { items, dropped };
}
export function putEdgeSnap(agent, items) {
  for (const it of items) {
    if (!_edge.has(it.vcenterId) && _edge.size >= 512) continue;
    _edge.set(it.vcenterId, { ...it, agent: s(String(agent || ''), 64) });
  }
}
export function edgeSnapFor(vcenterId) { return _edge.get(String(vcenterId)) || null; }
export function _resetForTest() { _acc = null; _loadError = ''; _edge.clear(); }

/* ── 엣지: push 에 실을 요약(이 엣지가 직접 이벤트를 모으는 vCenter 만) ───────────────────────────────── */

/**
 * @param {{ db: object, snap: object, notCollected: Map<string,string>, logSettings: object|null, now?: number }} ctx
 * @returns {Promise<object[]>} sanitizeEdgeSnap 이 받는 모양
 */
export async function edgeSnapPayload({ db, snap, notCollected, logSettings, now = Date.now() }) {
  const out = [];
  const vcs = (snap?.vcenters || []).filter((v) => v && v.id != null && !notCollected?.has(String(v.id))).slice(0, MAX_EDGE_VCS);
  for (const vc of vcs) {
    const vcenterId = String(vc.id);
    if (logSettings?.enabled === false) { out.push({ vcenterId, status: 'log-off', at: now }); continue; }
    if (logSettings?.minSeverity && logSettings.minSeverity !== 'info') { out.push({ vcenterId, status: 'severity-filter', at: now }); continue; }
    const vms = (snap?.vms || []).filter((v) => v.vcenterId === vcenterId);
    const r = await localSnapSummary(db, vcenterId, vms, { now });
    out.push({ vcenterId, status: 'ok', byVm: r.byVm, events: r.events, ambiguous: r.ambiguous, unmatched: r.unmatched, truncated: r.truncated, days: LOOKBACK_DAYS, at: now });
  }
  return out;
}

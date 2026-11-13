/**
 * IP 변화 → 기록 · 알림 묶음(vNEXT — 설계 docs/design/ipam-alerts-mac-dns ① · 보드 ② ③).
 *
 * scanStore.onScanChanges 로 보고 하나(스캔 한 번)의 변화를 받아:
 *   ① 거른다 — new-ip 는 vCenter 가 아는 IP(VM IP · 호스트 관리 IP)를 뺀다(미등록만), mac-change 는 게이트웨이 이중화 가상 MAC 을 뺀다(보드 ⑥-2).
 *   ② 모두 기록한다(changeLog — 알림을 끈 종류 · 알리지 않을 에이전트도).
 *   ③ 켠 종류만 **스캔 한 번 · 종류 하나에 한 건**으로 묶어 보낸다(최대 LINES_MAX 줄 + '외 N건'). 묶음 상한(ipamNewIp.threshold, 다른 종류는 기본 50)을 넘으면
 *      요약 한 건만(보드 ③-2). MAC 변경은 'MAC 변경 알림 제외'(관리상태 macAlertOff) IP 와 예전 MAC 으로 되돌아간 것(flap — 이중화 의심)을 보내지 않는다.
 * 충돌 의심(상태형)은 알림 엔진(alerts.js evaluate)이 보내고, 여기서는 발생 · 해소를 기록만 한다(onAlertState).
 * 의존 방향: changeNotify → scanStore · alerts · store(scanStore 는 이 모듈을 모른다).
 */
import { onScanChanges } from './scanStore.js';
import { appendChanges, setNotify, listChanges } from './changeLog.js';
import { macInfo } from './macVendor.js';
import { getOverrides } from './overrides.js';
import { store } from '../store.js';
import { loadAlertConfig, enqueueNotify, deliveryOutcome, noteEventSent, onAlertState } from '../alerts.js';

export const LINES_MAX = 10;
export const DIGEST_DEFAULT = 50;
/** 종류 → 알림 규칙 키(alerts.json rules). */
export const TYPE_RULE = Object.freeze({ 'new-ip': 'ipamNewIp', 'reserved-up': 'ipamReservedUp', rename: 'ipamRename', 'mac-change': 'ipamMacChange' });
const TYPE_TITLE = Object.freeze({ 'new-ip': '새 미등록 IP', 'reserved-up': '예약 · 폐기 IP 사용 시작', rename: '호스트명 변경', 'mac-change': 'MAC 변경' });
const SRC_LABEL = Object.freeze({ dns: '역DNS', mdns: 'mDNS', netbios: 'NetBIOS' });
const STATUS_LABEL = Object.freeze({ reserved: '예약', deprecated: '폐기' });

/** vCenter 가 아는 IP — 켜진 · 꺼진 VM 의 IP 와 호스트 관리 IP(이름이 IP 인 호스트 포함). */
export function knownIpSet(snap) {
  const s = new Set();
  for (const vm of Array.isArray(snap?.vms) ? snap.vms : []) {
    const list = Array.isArray(vm.ipAddresses) && vm.ipAddresses.length ? vm.ipAddresses : (vm.ipAddress ? [vm.ipAddress] : []);
    for (const ip of list) if (typeof ip === 'string') s.add(ip);
  }
  for (const h of Array.isArray(snap?.hosts) ? snap.hosts : []) {
    for (const ip of [h.mgmtIp, h.name]) if (typeof ip === 'string' && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) s.add(ip);
  }
  return s;
}

/** 알림 한 줄(순수). */
export function lineOf(c) {
  if (c.type === 'new-ip') return `${c.ip} ${(c.services || []).join(',') || '—'}${c.mac ? ` ${macInfo(c.mac)?.vendor || c.mac}` : ''}`;
  if (c.type === 'reserved-up') return `${c.ip} ${STATUS_LABEL[c.status] || c.status} — ${(c.services || []).join(',') || '응답'}`;
  if (c.type === 'rename') return `${c.ip} ${SRC_LABEL[c.src] || c.src}: ${c.from} → ${c.to}`;
  if (c.type === 'mac-change') {
    const v = (m) => { const i = macInfo(m); return i?.vendor ? `${m}(${i.vendor})` : m; };
    return `${c.ip} ${v(c.from)} → ${v(c.to)}`;
  }
  return c.ip || '';
}

/**
 * 보고 하나의 변화 → { entries(기록할 것 — notify 초기값 포함), groups(보낼 묶음 — type → entries) } (순수 — 시험용으로 나눴다).
 * @param {{agent:string, ts:number, changes:object[]}} batch
 * @param {{ cfg:object, known:Set<string>|null, overrides:object }} ctx
 */
export function planBatch(batch, { cfg, known = null, overrides = {} } = {}) {
  const R = cfg?.rules || {};
  const quiet = new Set((cfg?.ipamQuietAgents || []).map((x) => String(x).toLowerCase()));
  const agent = String(batch?.agent || '');
  const isQuiet = quiet.has(agent.toLowerCase());
  const entries = []; const groups = new Map();
  for (const c of Array.isArray(batch?.changes) ? batch.changes : []) {
    if (!c || typeof c !== 'object') continue;
    if (c.type === 'baseline') { entries.push({ ...c, agent, notify: 'none' }); continue; }
    if (c.type === 'new-ip' && known && known.has(c.ip)) continue;                     // vCenter 가 아는 IP — 미등록이 아니다
    if (c.type === 'mac-change' && (macInfo(c.from)?.kind === 'gateway' || macInfo(c.to)?.kind === 'gateway')) continue;
    const e = { ...c, agent };
    // 화면에는 제조사 표가 없다 — 기록에 제조사 이름을 함께 남긴다
    if (c.type === 'mac-change') { const a = macInfo(c.from)?.vendor; const b = macInfo(c.to)?.vendor; if (b) e.vendor = b; if (a) e.fromVendor = a; }
    else if (c.type === 'new-ip' && c.mac) { const b = macInfo(c.mac)?.vendor; if (b) e.vendor = b; }
    const rule = TYPE_RULE[c.type];
    const ov = Object.prototype.hasOwnProperty.call(overrides, c.ip) ? overrides[c.ip] : null;
    if (!rule) e.notify = 'none';
    else if (!R[rule]?.enabled) e.notify = 'off';
    else if (isQuiet) e.notify = 'quiet';
    else if (c.type === 'mac-change' && ov?.macAlertOff === true) e.notify = 'excluded';
    else if (c.type === 'mac-change' && c.flap) e.notify = 'flap';
    else { e.notify = 'skipped'; if (!groups.has(c.type)) groups.set(c.type, []); groups.get(c.type).push(e); }
    entries.push(e);
  }
  return { entries, groups };
}

/** 묶음 하나 → 알림(순수). 상한을 넘으면 요약 한 건. */
export function digestAlert(type, list, { agent, ts, cap = DIGEST_DEFAULT } = {}) {
  const n = list.length;
  const title = `${TYPE_TITLE[type] || type} ${n}건 — ${agent || '이 포탈'}`;
  const key = `ipchange:${type}:${agent || '-'}:${ts}`;
  if (n > cap) {
    return { alert: { key, severity: 'warning', title, detail: `한 번의 스캔에서 ${n}건(묶음 상한 ${cap}건 초과) — 목록은 IP관리 › IP 변화에서 봅니다. 대역을 새로 넣었거나 장애에서 복구된 경우가 많습니다.` }, summary: true };
  }
  const lines = list.slice(0, LINES_MAX).map(lineOf);
  if (n > LINES_MAX) lines.push(`외 ${n - LINES_MAX}건 — IP관리 › IP 변화`);
  return { alert: { key, severity: 'warning', title, detail: lines.join('\n') }, summary: false };
}

async function handleBatch(batch) {
  const cfg = loadAlertConfig();
  const needKnown = (batch?.changes || []).some((c) => c?.type === 'new-ip');
  const known = needKnown ? knownIpSet(store.get()) : null;
  const { entries, groups } = planBatch(batch, { cfg, known, overrides: getOverrides() });
  const saved = appendChanges(entries, batch?.ts);
  // appendChanges 가 정제한 사본을 돌려준다 — 묶음 항목과 짝을 맞춘다(같은 순서)
  const savedOf = new Map(entries.map((e, i) => [e, saved[i]]));
  for (const [type, list] of groups) {
    const cap = Number(cfg.rules?.[TYPE_RULE[type]]?.threshold) || DIGEST_DEFAULT;
    const { alert, summary } = digestAlert(type, list, { agent: batch.agent, ts: batch.ts, cap });
    const rows = list.map((e) => savedOf.get(e)).filter(Boolean);
    let res = [];
    try { res = await enqueueNotify(alert, cfg); } catch (e) { res = [`queue:err ${String(e?.message || e).slice(0, 120)}`]; }
    const out = deliveryOutcome(res);
    setNotify(rows, out === 'delivered' ? (summary ? 'summary' : 'sent') : out === 'failed' ? 'failed' : 'skipped');
    try { noteEventSent(alert, res); } catch { /* 최근 통지 목록은 보조 */ }
  }
}

// 충돌 의심 발생 · 해소 기록 — 같은 발생을 두 번 남기지 않게 열린 키를 기억한다(재시작 뒤에는 기록에서 되살린다).
const _openConflicts = new Set();
function restoreOpenConflicts() {
  const { entries } = listChanges({ limit: 5000 });
  const done = new Set();
  for (const e of entries) {   // 최신이 먼저 — 먼저 만난 것이 그 IP 의 마지막 상태
    if (done.has(e.ip)) continue;
    if (e.type === 'conflict') { _openConflicts.add(e.ip); done.add(e.ip); } else if (e.type === 'conflict-resolved') done.add(e.ip);
  }
}
export function handleAlertState(ev) {
  const add = [];
  for (const f of Array.isArray(ev?.firing) ? ev.firing : []) {
    const k = String(f?.key || '');
    if (!k.startsWith('ipconflict:')) continue;
    const ip = k.slice('ipconflict:'.length);
    if (_openConflicts.has(ip)) continue;
    _openConflicts.add(ip);
    add.push({ type: 'conflict', ip, vcenterId: f.alert?.vcenterId || '', note: f.alert?.detail || '', vm: (/\(([^)]*)\)\s*$/.exec(f.alert?.title || '') || [])[1] || '', notify: 'engine' });
  }
  for (const r of Array.isArray(ev?.resolved) ? ev.resolved : []) {
    const k = String(r?.key || '');
    if (!k.startsWith('ipconflict:')) continue;
    const ip = k.slice('ipconflict:'.length);
    if (!_openConflicts.delete(ip)) continue;
    add.push({ type: 'conflict-resolved', ip, vcenterId: r.alert?.vcenterId || '', notify: 'engine' });
  }
  if (add.length) appendChanges(add, numOrNow(ev?.now));
  return add.length;
}
const numOrNow = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : Date.now());

let _started = false;
export function startIpamChangeNotify() {
  if (_started) return;
  _started = true;
  try { restoreOpenConflicts(); } catch { /* 기록을 못 읽으면 빈 상태 — 발생이 한 번 더 남을 수 있다 */ }
  onScanChanges((b) => handleBatch(b).catch((e) => console.warn(`[ipam] IP 변화 알림 처리 실패: ${e?.message || e}`)));
  onAlertState((ev) => { try { handleAlertState(ev); } catch (e) { console.warn(`[ipam] 충돌 의심 기록 실패: ${e?.message || e}`); } });
}
/** 테스트용 — 한 묶음을 바로 처리한다(구독 없이). */
export function _handleBatchForTest(b) { return handleBatch(b); }
export function _resetChangeNotifyForTest() { _openConflicts.clear(); }

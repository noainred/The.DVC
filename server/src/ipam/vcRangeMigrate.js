/**
 * vcRangeMigrate.js — v2.691: 'vCenter 별 스캔 대역'(rangeStore, ipam-vcenter-ranges.json)을 **그 vCenter 를 수집하는 에이전트의
 * 스캔 대역**(scanStore, ipam-scan.json)으로 한 번 옮긴다(사용자 지시 "대역·스캔과 IP 스캔 설정을 합쳐 줘" + 선택 "수집하는
 * 에이전트로 자동 이전").
 *
 * 왜 옮기나: vCenter 별 대역은 **언제나 중앙이 스캔**했다(scanPoller.effectiveRanges = 이 포탈 대역 ∪ 켜진 vCenter 대역). 엣지 위임
 * 법인의 대역도 중앙이 직접 TCP 커넥트를 시도해, 중앙에서 닿지 않는 사이트는 결과가 비었다. 에이전트 대역은 그 에이전트가 자기
 * 사이트에서 스캔한다 — 이제 엣지 법인 대역은 그 엣지가 스캔한다(동작이 바뀐다 — 화면이 그 사실을 말한다).
 *
 * 규칙(planVcRangeMigration — 순수):
 *  · 중앙 직접 수집 vCenter → '이 포탈에서 직접'(__local__) · 엣지 위임(collectMode 'site') → 담당 엣지(remoteAgent, 없으면 스냅샷
 *    collectedBy). 담당을 모르면 **옮기지 않는다**(no-agent — 지어낸 엣지에 붙이지 않는다).
 *  · 등록부에 없는 vCenter(deleted)·비활성 vCenter(vc-disabled)·꺼진 대역(range-off — 지금까지 스캔하지 않던 대역을 켜면 동작이
 *    바뀐다)은 옮기지 않는다. 옮기지 않은 대역은 vCenter 별 저장소에 **남고 예전처럼 중앙이 계속 스캔**한다(조용한 손실 없음) —
 *    관리자가 화면에서 에이전트를 골라 옮기거나 지운다.
 *  · 대역 문법 오류 줄은 옮기지 않고 기록에 남긴다(스캔이 읽지 못하던 줄이다 — 예전에도 0 개로 버려졌다).
 *  · 옮긴 에이전트가 꺼져 있었으면 **켠다** — 예전에는 그 대역이 이 포탈 설정과 무관하게 주기 스캔됐다(끈 채로 두면 이전이 곧
 *    스캔 중단이 된다). 켠 사실을 기록에 남긴다.
 *
 * 실행은 1회다(상태 파일 `ipam-vcrange-migration.json` — 상태 파일 등록부에 등록). 옮기기 전 원본을 같은 폴더에 백업한다.
 * 스냅샷 첫 병합 전(store initial)에는 collectedBy 를 몰라 no-agent 가 늘어나므로 기다린다(최대 15분 — 그 뒤에는 등록부만으로 판정).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config, loadVcenterConfig } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { registerStateFile } from '../util/stateFiles.js';
import { listVcRanges, removeVcRanges } from './rangeStore.js';
import { loadScanSettings, saveScanSettings, listScanAgents, LOCAL } from './scanStore.js';
import { checkRangeList } from './rangeSyntax.js';
import { RANGE_CAP } from './scan.js';
import { store } from '../store.js';

const STATE_NAME = registerStateFile('ipam-vcrange-migration.json');
const STATE_FILE = () => path.join(config.configDir, STATE_NAME);
const VC_FILE = () => path.join(config.configDir, 'ipam-vcenter-ranges.json');

export const MIGRATION_REASONS = ['moved', 'empty', 'deleted', 'vc-disabled', 'range-off', 'no-agent'];

const t = (v) => (v == null ? '' : String(v).trim());

/**
 * 계획(순수).
 * @param {object} p
 * @param {Array<{vcenterId, ranges, enabled}>} p.vcRanges   listVcRanges()
 * @param {Array} p.vcenters       등록부 vcenters
 * @param {Array} p.snapVcenters   스냅샷 vcenters(collectedBy·name)
 * @param {string[]} p.agentNames  이미 있는 스캔 에이전트 이름(대소문자 무시로 맞춘다)
 * @returns {Array<{vcenterId, vcenterName, collectMode, ranges, invalid, target, reason}>}
 */
export function planVcRangeMigration({ vcRanges = [], vcenters = [], snapVcenters = [], agentNames = [] } = {}) {
  const reg = new Map((Array.isArray(vcenters) ? vcenters : []).filter((v) => v && t(v.id)).map((v) => [t(v.id), v]));
  const snap = new Map((Array.isArray(snapVcenters) ? snapVcenters : []).filter((v) => v && t(v.id)).map((v) => [t(v.id), v]));
  const names = (Array.isArray(agentNames) ? agentNames : []).map(t).filter(Boolean);
  const canon = (a) => {
    if (a === LOCAL) return LOCAL;
    return names.find((n) => n === a) || names.find((n) => n.toLowerCase() === a.toLowerCase()) || a;
  };
  const out = [];
  for (const e of Array.isArray(vcRanges) ? vcRanges : []) {
    const id = t(e?.vcenterId);
    if (!id) continue;
    const r = reg.get(id); const s = snap.get(id);
    const raw = (Array.isArray(e.ranges) ? e.ranges : []).map(t).filter(Boolean);
    const chk = checkRangeList(raw, { reversed: 'error', scanCap: RANGE_CAP });
    const bad = new Set(chk.invalid.map((x) => x.value));
    const ranges = raw.filter((x) => !bad.has(x));
    const site = r ? t(r.collectMode) === 'site' : t(s?.collectSource) === 'site';
    const item = {
      vcenterId: id, vcenterName: t(r?.name) || t(s?.name) || id,
      collectMode: r || s ? (site ? 'site' : 'direct') : '',
      ranges, invalid: chk.invalid.map((x) => ({ value: t(x.value).slice(0, 120), reason: t(x.reason).slice(0, 200) })),
      enabled: e.enabled !== false, target: null, reason: '',
    };
    if (!r && !s) item.reason = 'deleted';
    else if (r && r.enabled === false) item.reason = 'vc-disabled';
    else if (!raw.length) item.reason = 'empty';
    else if (e.enabled === false) item.reason = 'range-off';
    else if (site) {
      const owner = t(r?.remoteAgent) || t(s?.collectedBy);
      if (!owner) item.reason = 'no-agent';
      else { item.target = canon(owner); item.reason = 'moved'; }
    } else { item.target = LOCAL; item.reason = 'moved'; }
    out.push(item);
  }
  return out;
}

/** 대역 합집합(앞 순서 유지, 같은 글자 줄은 한 번). */
export function unionRanges(cur, add) {
  const out = []; const seen = new Set(); let dup = 0;
  for (const x of (Array.isArray(cur) ? cur : []).map(t).filter(Boolean)) if (!seen.has(x)) { seen.add(x); out.push(x); }
  for (const x of (Array.isArray(add) ? add : []).map(t).filter(Boolean)) { if (seen.has(x)) dup += 1; else { seen.add(x); out.push(x); } }
  return { ranges: out, dup };
}

export function readMigrationState() {
  let raw;
  try { raw = fs.readFileSync(STATE_FILE(), 'utf8'); } catch { return null; } // 없음 = 아직 이전 안 함
  try {
    const j = JSON.parse(raw);
    return j && typeof j === 'object' ? j : null;
  } catch (e) {
    // 손상 — 원본을 보존하고 '아직 안 함' 으로 본다. 다시 실행해도 옮긴 대역은 이미 vCenter 별 저장소에 없으므로 남은 것만 다시 판정한다.
    preserveCorrupt(STATE_FILE(), e.message);
    return null;
  }
}
function writeState(st) {
  fs.mkdirSync(config.configDir, { recursive: true });
  atomicWriteFileSync(STATE_FILE(), JSON.stringify(st, null, 2));
}

/** 한 vCenter 대역을 한 에이전트로 옮긴다(실행부 — 자동·수동 공용). 에이전트가 꺼져 있으면 켠다. */
function moveInto(agent, ranges) {
  const cur = loadScanSettings(agent);
  const u = unionRanges(cur.ranges, ranges);
  const enable = !cur.enabled;
  saveScanSettings(agent, { ranges: u.ranges, ...(enable ? { enabled: true } : {}) });
  return { merged: u.dup, enabledAgent: enable };
}

/**
 * 1회 이전. 이미 했으면 아무것도 하지 않는다. 동기 함수다(중간에 다른 요청이 끼지 않는다).
 * @returns {{ ran:boolean, state:object|null, reason?:string }}
 */
export function runVcRangeMigration({ now = Date.now(), force = false } = {}) {
  const prev = readMigrationState();
  if (prev?.done && !force) return { ran: false, state: prev };
  const vcRanges = listVcRanges();
  if (!vcRanges.length) {
    const st = { version: 1, done: true, at: now, items: [], backup: null, dismissedAt: now };
    writeState(st);
    return { ran: true, state: st };
  }
  let vcenters = [];
  try { vcenters = loadVcenterConfig()?.vcenters || []; } catch (e) { return { ran: false, state: prev, reason: `vCenter 등록부를 읽지 못했습니다: ${e.message}` }; }
  const snap = store.get() || {};
  const plan = planVcRangeMigration({ vcRanges, vcenters, snapVcenters: snap.vcenters, agentNames: listScanAgents().map((a) => a.name) });
  // 백업 — 원본을 그대로 복사한다(실패하면 옮기지 않는다).
  let backup = null;
  try {
    const src = VC_FILE();
    if (fs.existsSync(src)) {
      backup = `ipam-vcenter-ranges.json.pre-v2.691-${now}.bak`;
      fs.copyFileSync(src, path.join(config.configDir, backup));
      try { fs.chmodSync(path.join(config.configDir, backup), 0o600); } catch { /* */ }
    }
  } catch (e) { return { ran: false, state: prev, reason: `백업하지 못해 옮기지 않았습니다: ${e.message}` }; }
  const items = [];
  for (const it of plan) {
    const rec = { ...it, result: 'kept', merged: 0, enabledAgent: false };
    try {
      if (it.reason === 'moved') {
        const m = it.ranges.length ? moveInto(it.target, it.ranges) : { merged: 0, enabledAgent: false };
        removeVcRanges(it.vcenterId);
        Object.assign(rec, m, { result: 'moved' });
      } else if (it.reason === 'empty') {
        removeVcRanges(it.vcenterId);
        rec.result = 'removed';
      }
    } catch (e) { rec.result = 'failed'; rec.error = String(e?.message || e).slice(0, 200); }
    items.push(rec);
  }
  const st = { version: 1, done: true, at: now, backup, items, dismissedAt: null };
  writeState(st);
  return { ran: true, state: st };
}

/** 사용자가 고른 에이전트로 남은 vCenter 대역을 옮긴다. */
export function moveVcRangeManually(vcenterId, agent, { user = '', now = Date.now() } = {}) {
  const id = t(vcenterId); const a = t(agent) || LOCAL;
  const e = listVcRanges().find((x) => x.vcenterId === id);
  if (!e) return { ok: false, status: 404, reason: '옮길 대역이 없습니다(이미 옮겼거나 지웠습니다).' };
  const chk = checkRangeList(e.ranges || [], { reversed: 'error', scanCap: RANGE_CAP });
  const bad = new Set(chk.invalid.map((x) => x.value));
  const ranges = (e.ranges || []).map(t).filter((x) => x && !bad.has(x));
  const m = ranges.length ? moveInto(a, ranges) : { merged: 0, enabledAgent: false };
  removeVcRanges(id);
  updateItem(id, { result: 'moved', target: a, manual: true, by: t(user).slice(0, 64), at: now, ...m, invalidDropped: chk.invalid.length });
  return { ok: true, agent: a, moved: ranges.length, ...m, invalidDropped: chk.invalid.length };
}

/** 남은 vCenter 대역을 지운다. */
export function removeVcRangeManually(vcenterId, { user = '', now = Date.now() } = {}) {
  const id = t(vcenterId);
  const r = removeVcRanges(id);
  if (!r.ok) return { ok: false, status: 404, reason: '지울 대역이 없습니다.' };
  updateItem(id, { result: 'removed', manual: true, by: t(user).slice(0, 64), at: now });
  return { ok: true };
}

export function dismissMigration({ now = Date.now() } = {}) {
  const st = readMigrationState();
  if (!st) return { ok: false, reason: '이전 기록이 없습니다.' };
  writeState({ ...st, dismissedAt: now });
  return { ok: true };
}

function updateItem(vcenterId, patch) {
  const st = readMigrationState() || { version: 1, done: true, at: Date.now(), items: [], backup: null, dismissedAt: null };
  const items = Array.isArray(st.items) ? st.items.slice() : [];
  const i = items.findIndex((x) => x?.vcenterId === vcenterId);
  if (i >= 0) items[i] = { ...items[i], ...patch, reason: items[i].reason };
  else items.push({ vcenterId, vcenterName: vcenterId, ranges: [], reason: 'manual', ...patch });
  writeState({ ...st, items });
}

/** netmap 용 — 이 vCenter 에서 에이전트로 옮긴 대역(옮긴 기록 기준). */
export function migratedRangesFor(vcenterId) {
  const st = readMigrationState();
  const it = (st?.items || []).find((x) => x?.vcenterId === vcenterId && x.result === 'moved');
  return it ? (it.ranges || []) : [];
}

let _timer = null;
/** 기동 뒤 스냅샷 첫 병합을 기다렸다가(최대 15분) 1회 이전한다. 이미 했으면 아무것도 하지 않는다. */
export function scheduleVcRangeMigration({ firstDelayMs = 60_000, retryMs = 60_000, maxWaitMs = 15 * 60_000 } = {}) {
  if (_timer) return;
  const started = Date.now();
  const tick = () => {
    _timer = null;
    try {
      if (readMigrationState()?.done) return;
      const snap = store.get();
      if (snap?.initial && Date.now() - started < maxWaitMs) { _timer = setTimeout(tick, retryMs); _timer.unref?.(); return; }
      const r = runVcRangeMigration();
      if (r.ran) {
        const items = r.state?.items || [];
        const moved = items.filter((x) => x.result === 'moved').length;
        const kept = items.filter((x) => x.result === 'kept').length;
        if (items.length) console.log(`[ipscan] vCenter 별 스캔 대역을 에이전트로 옮겼습니다(v2.691) — 옮김 ${moved} · 남김 ${kept}${r.state.backup ? ` · 백업 ${r.state.backup}` : ''}`);
      } else if (r.reason) {
        console.warn(`[ipscan] vCenter 별 스캔 대역 이전 보류 — ${r.reason}`);
        _timer = setTimeout(tick, 10 * retryMs); _timer.unref?.();
      }
    } catch (e) { console.warn(`[ipscan] vCenter 별 스캔 대역 이전 실패: ${e.message}`); }
  };
  _timer = setTimeout(tick, firstDelayMs); _timer.unref?.();
}

/**
 * bmusage/onboard/edgeDeploy.js — 수집 경로 ‘edge’ 로 등록한 서버의 **엣지 배포 목록**(중앙 · 7b단계 · 설계 PROFILES §18 '엣지 배포(법인 단위)').
 *
 * 파일 `CONFIG_DIR/bm-onboard-edge.json`(0600 · 원자적 쓰기 · 손상 보존 + 쓰기 거절): { agents: { [엣지 소문자]: { rows:[edgeRowFromPlan…], at, by } } }.
 *  · **비밀 없음** — 공통 계정 · SSH 키는 이름으로만 싣는다. 엣지가 자기 키 저장소 · 공통 계정에서 같은 이름을 찾는다(키는 법인 밖으로 나가지 않는다).
 *  · 엣지는 `GET /api/central/bm-onboard`(개별 토큰으로 인증된 이름에만 — 공유 토큰의 ?agent= 는 남의 목록을 받아 갈 수 있다)로 받고,
 *    **같은 분석(analyzeOnboardRows)을 엣지에서 다시 거쳐**(배포 경로 정규화 — v2.933 규약) 자기 등록부에 적용한다(`edgeApply.js`).
 *  · 중앙은 이 목록의 서버를 **열지 않는다**(중앙 등록부에서 빼고 여기로 옮긴다 — 같은 서버를 두 곳이 열지 않는다).
 *  · 엣지가 사라져도(끊김) 이 목록을 central 로 옮기지 않는다 — 사람이 옮긴다.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../../util/atomicWrite.js';
import { makeLoadError } from '../../util/registryCore.js';
import { edgeRowFromPlan } from './importAnalyze.js';

export const EDGE_FILE_NAME = 'bm-onboard-edge.json';
const FILE = path.join(config.configDir, 'bm-onboard-edge.json');   // = EDGE_FILE_NAME
export const MAX_EDGE_ROWS = 5000;
export const MAX_EDGES = 128;
const lc = (v) => String(v ?? '').trim().toLowerCase();

let cache = null;
const loadErr = makeLoadError();
export function edgeDeployLoadError() { load(); return loadErr.get(); }

function load() {
  if (cache) return cache;
  try {
    if (fs.existsSync(FILE)) {
      const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      const agents = Object.create(null);
      const src = j && typeof j.agents === 'object' && j.agents && !Array.isArray(j.agents) ? j.agents : {};
      for (const [a, v] of Object.entries(src)) {
        const k = lc(a);
        if (!k || k.length > 64 || !v || typeof v !== 'object') continue;
        const rows = (Array.isArray(v.rows) ? v.rows : []).filter((r) => r && typeof r === 'object' && !Array.isArray(r)).slice(0, MAX_EDGE_ROWS).map((r) => edgeRowFromPlan({
          name: r.name, vc: r.corp, tag: r.serviceTag, idracHost: r.idracHost, idracCred: r.idracCred, osHost: r.osHost, osPort: r.osPort, osCred: r.osCred, osUser: r.osUser, osKey: r.osKey,
          mounts: r.mounts, enabled: r.enabled, note: r.note, cls: r.cls, apps: r.apps, role: r.role, bindOk: r.bindOk,
        }, k)).filter((r) => r.name);
        // 반증 F14: 배포에서 뺐지만 엣지가 아직 반영(적용 서명 확인)하지 않은 행 — 그 동안 같은 서버의 central 등록을 막는다.
        const pending = (Array.isArray(v.pending) ? v.pending : []).filter((x) => x && typeof x === 'object' && x.name).slice(0, MAX_EDGE_ROWS)
          .map((x) => ({ name: String(x.name).slice(0, 128), corp: String(x.corp || '').slice(0, 128), at: Number(x.at) > 0 ? Number(x.at) : 0 }));
        agents[k] = { rows, pending, at: Number(v.at) > 0 ? Number(v.at) : 0, by: String(v.by || '').slice(0, 64) };
      }
      cache = { agents };
    }
  } catch (e) { preserveCorrupt(FILE, e?.message); loadErr.set(e); cache = null; }
  if (!cache) { loadErr.checkCorruptOnly(FILE); cache = { agents: Object.create(null) }; }
  return cache;
}
export function _resetEdgeDeployForTest() { cache = null; loadErr.clear(); }

/** 한 엣지의 배포 행(사본). */
export function edgeRowsFor(agent) { const v = load().agents[lc(agent)]; return v ? v.rows.map((r) => ({ ...r })) : []; }
/** 전 엣지 행(분석의 경로 변경 판정용) — 행마다 agent. */
export function allEdgeRows() { const out = []; for (const [a, v] of Object.entries(load().agents)) for (const r of v.rows) out.push({ ...r, agent: a }); return out; }
export function edgeSummary() { return Object.entries(load().agents).map(([agent, v]) => ({ agent, rows: v.rows.length, pending: (v.pending || []).length, at: v.at || null, by: v.by, sig: sigOf(v.rows) })); }
/** 제거 대기 행(엣지 반영 전) — 분석의 edge-to-central 판정 입력. */
export function allPendingRemovals() { const out = []; for (const [a, v] of Object.entries(load().agents)) for (const r of v.pending || []) out.push({ ...r, agent: a }); return out; }

export const sigOf = (rows) => crypto.createHash('sha256').update(JSON.stringify(rows || [])).digest('hex').slice(0, 32);

/**
 * 바꾸기(한 번 쓰기). upserts: [{agent,row}] — 같은 엣지 · 같은 이름이면 교체. removes: [{agent,name}].
 * 못 읽은 상태면 쓰지 않는다(registry-unreadable).
 */
export function applyEdgeChanges({ upserts = [], removes = [] } = {}, { by = '', now = Date.now() } = {}) {
  load();
  if (loadErr.get()) return { ok: false, code: 'registry-unreadable', reason: `엣지 배포 목록(${EDGE_FILE_NAME})을 읽지 못해 바꾸지 않았습니다.` };
  const next = Object.create(null);
  for (const [a, v] of Object.entries(cache.agents)) next[a] = { ...v, rows: v.rows.map((r) => ({ ...r })), pending: (v.pending || []).map((r) => ({ ...r })) };
  const touched = new Set();
  for (const { agent, name } of removes) {
    const a = lc(agent); if (!next[a]) continue;
    const n = lc(name);
    const gone = next[a].rows.filter((r) => lc(r.name) === n);
    next[a].rows = next[a].rows.filter((r) => lc(r.name) !== n);
    if (gone.length) { touched.add(a); for (const g of gone) next[a].pending.push({ name: g.name, corp: g.corp, at: now }); }
  }
  for (const { agent, row } of upserts) {
    const a = lc(agent); if (!a) continue;
    if (!next[a]) { if (Object.keys(next).length >= MAX_EDGES) return { ok: false, code: 'too-many', reason: `엣지 배포 목록은 ${MAX_EDGES}개 엣지까지입니다.` }; next[a] = { rows: [], pending: [], at: 0, by: '' }; }
    const r = edgeRowFromPlan({ ...row, vc: row.corp ?? row.vc, tag: row.serviceTag ?? row.tag }, a);
    const i = next[a].rows.findIndex((x) => lc(x.name) === lc(r.name));
    if (i >= 0) next[a].rows[i] = r; else next[a].rows.push(r);
    next[a].pending = next[a].pending.filter((x) => lc(x.name) !== lc(r.name));   // 다시 올리면 제거 대기에서 뺀다
    if (next[a].rows.length > MAX_EDGE_ROWS) return { ok: false, code: 'too-many', reason: `한 엣지의 배포 행은 ${MAX_EDGE_ROWS.toLocaleString()}개까지입니다.` };
    touched.add(a);
  }
  // 반증 F14: 행이 0 이어도 엣지 항목을 남긴다(제거 대기 · 반영 상태를 화면이 보여야 한다). 반영이 확인되면 settlePending 이 정리한다.
  for (const a of touched) { next[a].at = now; next[a].by = String(by || '').slice(0, 64); }
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    atomicWriteFileSync(FILE, JSON.stringify({ agents: next }, null, 2), { mode: 0o600 });
  } catch (e) { return { ok: false, code: 'write-failed', reason: `엣지 배포 목록을 쓰지 못했습니다(${String(e?.code || e?.message || e).slice(0, 80)}).` }; }
  cache = { agents: next };
  loadErr.clear();
  return { ok: true, touched: [...touched] };
}

/**
 * 엣지 인출 응답(중앙 라우트). **개별 토큰으로 검증된 이름에만** 행을 준다.
 * @returns {{distribute:boolean, rows?:object[], sig?:string, reason?:string}}
 */
export function deployFor(agent, { verified = false } = {}) {
  if (!verified) return { distribute: false, reason: 'unverified' };
  const rows = edgeRowsFor(agent);
  return { distribute: true, rows, sig: sigOf(rows) };
}

/* 엣지별 마지막 인출(인메모리 — 중앙 재시작 직후엔 비어 있고 화면이 그 사실을 말한다). */
const _pulls = new Map();
export function recordOnboardPull(agent, { appliedSig = '', applied = null, version = '', now = Date.now() } = {}) {
  const a = lc(agent); if (!a) return;
  if (!_pulls.has(a) && _pulls.size >= 512) _pulls.delete(_pulls.keys().next().value);
  const n = (v) => (Number.isInteger(v) && v >= 0 && v <= 100000 ? v : null);
  _pulls.set(a, { at: now, appliedSig: String(appliedSig || '').slice(0, 64).replace(/[^0-9a-f]/g, ''), version: String(version || '').slice(0, 32),
    applied: applied && typeof applied === 'object' ? { ok: n(applied.ok), rejected: n(applied.rejected), removed: n(applied.removed) } : null });
}
export function onboardPullOf(agent) { return _pulls.get(lc(agent)) || null; }

/**
 * 엣지가 **지금 판**(서명)을 반영했다고 알리면 그 엣지의 제거 대기를 비운다(반증 F14). 행 · 대기가 모두 비면 항목을 지운다. 판이 다르면 아무것도 하지 않는다.
 */
export function settlePending(agent, appliedSig, { now = Date.now() } = {}) {
  const a = lc(agent);
  const v = load().agents[a];
  if (loadErr.get() || !v || !(v.pending || []).length) return { ok: true, changed: false };
  if (String(appliedSig || '') !== sigOf(v.rows)) return { ok: true, changed: false };
  const next = Object.create(null);
  for (const [k, x] of Object.entries(cache.agents)) next[k] = { ...x, rows: x.rows.map((r) => ({ ...r })), pending: (x.pending || []).map((r) => ({ ...r })) };
  next[a].pending = [];
  if (!next[a].rows.length) delete next[a];
  try { atomicWriteFileSync(FILE, JSON.stringify({ agents: next }, null, 2), { mode: 0o600 }); } catch { return { ok: false, changed: false }; }
  cache = { agents: next };
  void now;
  return { ok: true, changed: true };
}
export function _resetOnboardPullsForTest() { _pulls.clear(); }

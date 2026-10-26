/**
 * veeam/em/vmStore.js — Enterprise Manager 가 알려 준 VM 별 최신 백업 기록(v2.795 — 'EM 에서 등록되면 vCenter 화면에도 VM 단위로').
 *
 *  · CONFIG_DIR/veeam-em-vms.json = { v:1, ems: { <EM id>: { target, since, at, vms: { '<백업 서버 소문자>|<VM 소문자>': rec } } } }
 *    rec = { n(VM 이름), s(백업 서버 이름), m(moref 또는 ''), j(작업 이름), lt:{ r:'Success'|'Warning'|'Failed', s, e } | null, rl:[복원 지점 시각 ≤10, 새것부터], at }
 *    — veeam/parse.js 의 B&R vms[] 축약형과 같은 뜻의 이름(view.js 가 그 모양으로 바꾼다).
 *  · 증분: 수집이 완결되면(complete) 다음 기준(since) = 이번 수집 시작 − 겹침 30분. 완결이 아니면 기준을 그대로 둔다(다음 수집이 같은 범위를 새것부터 다시 읽는다).
 *  · 행은 **더 최신일 때만** 덮는다 · 접속처 지문(target)이 바뀌면 그 EM 의 기록을 비운다(다른 EM 이다 — store.js 와 같은 판단).
 *  · 정리: 마지막 근거가 400일보다 오래된 기록 · EM 당 상한 30,000(오래된 것부터 버린다).
 *  · 쓰기는 수집 1회당 1회(원자적 · 0600). 손상 파일은 옆에 보존하고 빈 기록으로 시작한다(EM 에서 다시 받는 값 — 다음 수집이 8일 창으로 채운다).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../../util/atomicWrite.js';

const FILE = () => path.join(config.configDir, 'veeam-em-vms.json');
export const OVERLAP_MS = 30 * 60_000;
export const KEEP_MS = 400 * 86_400_000;
export const MAX_PER_EM = 30_000;
const RL_MAX = 10;
const R_OF = { ok: 'Success', warn: 'Warning', fail: 'Failed' };

let _map = null;
let _rev = 0;
export function emVmRev() { return _rev; }

function load() {
  if (_map) return _map;
  _map = new Map();
  const f = FILE();
  try {
    if (fs.existsSync(f)) {
      const d = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (!d || typeof d !== 'object' || Array.isArray(d) || !d.ems || typeof d.ems !== 'object' || Array.isArray(d.ems)) throw new Error('형식 오류');
      for (const [k, v] of Object.entries(d.ems)) if (v && typeof v === 'object' && v.vms && typeof v.vms === 'object' && !Array.isArray(v.vms)) _map.set(k, v);
    }
  } catch (e) { preserveCorrupt(f, e.message); _map = new Map(); }
  return _map;
}
function save() {
  atomicWriteFileSync(FILE(), JSON.stringify({ v: 1, ems: Object.fromEntries(load()) }), { mode: 0o600 });
}

const keyOf = (server, vm) => `${String(server || '').trim().toLowerCase()}|${String(vm || '').trim().toLowerCase()}`;
/** 기록의 마지막 근거 시각(작업 끝 · 최신 복원 지점 중 늦은 것). */
const lastEvidence = (r) => Math.max(Number(r?.lt?.e) || 0, Number(r?.rl?.[0]) || 0, 0);

/** 다음 수집의 기준 시각 — 그 EM 의 기록이 없거나 접속처가 바뀌었으면 null(첫 수집 창). */
export function emVmSince(emId, target) {
  const e = load().get(emId);
  if (!e || (target && e.target && e.target !== target)) return null;
  return Number.isFinite(e.since) ? e.since : null;
}

/**
 * 수집 1회분을 합친다(순수에 가까운 갱신 — 파일 쓰기 1회).
 * @param {string} emId @param {string} target 접속처 지문
 * @param {{ since:number, tasks:Array, points:Array, complete:boolean }} rows  client.readVmBackups 결과
 * @param {{ startedAt:number, soleServer?:string }} o  soleServer = EM 의 백업 서버가 하나뿐이면 그 이름(서버 링크가 없는 행을 그 서버로 본다)
 * @returns {{ changed:number, unattributed:number, total:number }}
 */
export function mergeEmVms(emId, target, rows, { startedAt = Date.now(), soleServer = '' } = {}) {
  const m = load();
  let e = m.get(emId);
  if (!e || (target && e.target && e.target !== target)) e = { target: target || '', since: null, at: 0, vms: {} };
  const vms = { ...e.vms };
  let changed = 0; let unattributed = 0;
  const slot = (x) => {
    const server = x.server || soleServer;
    if (!server) { unattributed++; return null; }
    const k = keyOf(server, x.vm);
    const cur = vms[k] ? { ...vms[k] } : { n: String(x.vm).slice(0, 200), s: String(server).slice(0, 120), m: '', j: '', lt: null, rl: [], at: 0 };
    vms[k] = cur;
    return cur;
  };
  for (const t of Array.isArray(rows?.tasks) ? rows.tasks : []) {
    if (t.running || t.end == null || !R_OF[t.result]) continue;   // 끝난 작업의 성공·경고·실패만(진행 중은 15분 주기라 싣지 않는다)
    const cur = slot(t);
    if (!cur) continue;
    if (!cur.lt || t.end > (cur.lt.e ?? 0)) {
      cur.lt = { r: R_OF[t.result], s: t.start ?? null, e: t.end };
      if (t.job) cur.j = String(t.job).slice(0, 160);
      if (t.moref) cur.m = t.moref;
      cur.at = startedAt; changed++;
    }
  }
  for (const p of Array.isArray(rows?.points) ? rows.points : []) {
    const cur = slot(p);
    if (!cur) continue;
    if (cur.rl.includes(p.ts)) continue;
    cur.rl = [...cur.rl, p.ts].sort((a, b) => b - a).slice(0, RL_MAX);
    if (p.moref && (!cur.m || p.ts >= (cur.rl[0] ?? 0))) cur.m = p.moref;
    cur.at = startedAt; changed++;
  }
  // 정리 — 오래된 기록 · 상한(마지막 근거가 오래된 것부터)
  const cutoff = startedAt - KEEP_MS;
  let list = Object.entries(vms).filter(([, r]) => lastEvidence(r) >= cutoff);
  if (list.length > MAX_PER_EM) list = list.sort((a, b) => lastEvidence(b[1]) - lastEvidence(a[1])).slice(0, MAX_PER_EM);
  const kept = Object.fromEntries(list);
  const since = rows?.complete ? startedAt - OVERLAP_MS : (Number.isFinite(e.since) ? e.since : (Number.isFinite(rows?.since) ? rows.since : null));
  m.set(emId, { target: target || e.target || '', since, at: startedAt, ua: unattributed, vms: kept });
  save();
  _rev++;
  return { changed, unattributed, total: list.length };
}

/** EM 1대의 기록(읽기 전용 사본이 아니다 — 호출부는 바꾸지 말 것). 없으면 null. */
export function getEmVms(emId) { return load().get(emId) || null; }
/** 백업 서버 이름(대소문자 무시)별 기록 수 — 설정 화면 '반영' 칸. */
export function emVmCountsByServer(emId) {
  const out = new Map();
  for (const r of Object.values(getEmVms(emId)?.vms || {})) { const k = String(r.s || '').trim().toLowerCase(); out.set(k, (out.get(k) || 0) + 1); }
  return out;
}
/** EM 을 지우거나 접속처를 바꾸면 그 EM 의 기록도 지운다. */
export function dropEmVms(emId) { if (load().delete(emId)) { save(); _rev++; } }
export function pruneEmVmsExcept(ids) {
  const keep = new Set(ids); let n = 0;
  for (const k of [...load().keys()]) if (!keep.has(k)) { load().delete(k); n++; }
  if (n) { save(); _rev++; }
  return n;
}
export function _resetEmVmsForTest() { _map = null; _rev++; }

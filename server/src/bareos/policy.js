/**
 * bareos/policy.js — Director 정책 수집(v2.839 백업 메뉴 개편 2차-a · 사용자 결정 '실제 출력 먼저 · show 추가 + 선택 명령 · 표준 검증').
 *
 * 하는 일
 *  ① 수집: Director 마다 작업 표 `policy`(ops.js — 읽기 전용 명령 6개)를 중앙 직접 또는 엣지 대행으로 돌린다(service.onDirector).
 *     Director 들은 병렬(POLICY_CONCURRENCY) + **Director 마다 시한**(signal) · 재진입 가드 · 전체 시한(넘으면 결과를 포기해 가드를 푼다).
 *  ② 저장: CONFIG_DIR/bareos-policy.json(상태 파일 — 원자적 쓰기 · 손상 보존 · 리비전). 명령마다 마지막 성공 값과 그 시각을 따로 둔다 —
 *     이번에 실패한 명령은 지난 값을 지우지 않고 '마지막 성공 시각' 과 이번 실패 코드를 함께 보인다(지운 값을 0 으로 보이지 않게).
 *  ③ 주기: 하루 1회 정한 시각(설정 defaults.policy.time · 포탈 시각) — 실패면 30분 뒤 · 하루 3번까지(staleAlert 와 같은 규약) · '지금 수집' 은 라우트.
 *  ④ 화면 값(policyView · policySummary · directorScheduleItems): **Director 에 접속하지 않는다** — 저장된 수집본 + 원장 + 그룹 + 백업 표시만(v2.828 조회 화면 규칙).
 *     판정(VM 적용 정책 · 풀 가득 참 · 사용 %)은 여기 하나 — 웹은 받은 값만 그린다.
 *
 * 시각: 미리보기(status scheduler)는 epoch 초라 시간대와 무관하다(실측). 볼륨 lastwritten 은 카탈로그(Director 현지) — 포탈 서버 현지로 읽는다(기존 규칙).
 * 엣지에서는 돌지 않는다(중앙 전용 — 엣지는 작업 표로 대행만 한다).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt, safeLoadText } from '../util/atomicWrite.js';
import { makeLoadError } from '../util/registryCore.js';
import { registerStateFile } from '../util/stateFiles.js';
import { localClock, dayIndex, dayStartMs } from '../util/dayKey.js';
import { poolSettled } from '../util/pool.js';
import { onDirector, isDemoActive, effectiveSettings } from './service.js';
import { jobDirectorId } from './settings.js';
import { isResourceName } from './names.js';
import { POLICY_CMDS, POLICY_KEYS, normPolicyResult, poolFull, poolUsagePct, str } from './policyParse.js';
import { nextSlot, scheduleText, slotLevel } from './groupSchedule.js';
import { osKind } from '../inventory/osKind.js';

export const FILE_NAME = 'bareos-policy.json';
const FILE = () => path.join(config.configDir, 'bareos-policy.json');   // ⚠ 리터럴 형태 유지 — scripts/config-doc.mjs 가 이 모양으로 파일을 찾는다
registerStateFile('bareos-policy.json');
export const POLICY_CONCURRENCY = 4;
export const DIRECTOR_DEADLINE_MS = 180_000;
export const RUN_DEADLINE_MS = 15 * 60_000;
export const TICK_MS = 60_000;
export const RETRY_MS = 30 * 60_000;
export const TRIES_MAX = 3;
export const MANUAL_GAP_MS = 60_000;
export const VM_ROWS_MAX = 5000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const EST_MS = HOUR;   // 미리보기 회차의 길이를 모른다 — 60분으로 그린다(2.838 띠와 같은 추정 · est 표지)
const isEdge = () => !!config.agent?.centralUrl;
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

let _db = null; const _loadErr = makeLoadError(); let _rev = 0;
let _busy = false; let _timer = null;
const _collecting = new Set();
const _manualAt = new Map();

function empty() { return { version: 1, directors: {}, sched: { day: '', ok: null, tries: 0, nextTry: null, at: null } }; }

export function loadPolicy() {
  if (_db) return _db;
  try {
    if (fs.existsSync(FILE())) {
      const p = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
      if (!isObj(p) || !isObj(p.directors)) throw new Error('형식 오류');
      const db = empty();
      for (const [id, d] of Object.entries(p.directors)) if (isObj(d)) db.directors[id] = d;
      if (isObj(p.sched)) db.sched = { ...db.sched, ...p.sched };
      _db = db; _loadErr.clear();
      return _db;
    }
  } catch (e) {
    preserveCorrupt(FILE(), e?.message);
    _loadErr.set(e);
    console.warn(`[bareos] 정책 수집본을 읽지 못했습니다(${safeLoadText(e) || '사유 미상'}) — 손상본을 보존하고 비운 채 시작합니다(다음 수집이 다시 채웁니다).`);
  }
  _db = empty();
  _loadErr.checkCorruptOnly(FILE());
  return _db;
}
export function policyLoadError() { loadPolicy(); return _loadErr.get(); }
export const policyRev = () => _rev;
function persist() {
  const db = loadPolicy();
  atomicWriteFileSync(FILE(), JSON.stringify(db), { mode: 0o600 });
  _rev++; _loadErr.clear();
}

/** 수집할 키 — 필수 3 + 설정에서 켠 선택 명령. */
export function policyKeys(policySettings) {
  const opt = policySettings?.optional || {};
  return POLICY_CMDS.filter((c) => !c.optional || opt[c.key] !== false).map((c) => c.key);
}

/**
 * 한 Director 의 수집 결과를 저장본에 합친다(순수에 가깝다 — 테스트가 쓴다). 명령마다: 성공이면 값·시각을 바꾸고, 실패면 지난 값은 두고 코드만 바꾼다.
 * @param {object|undefined} prev 지난 저장본 @param {{results, version}|null} res 정규화한 결과(null = 세션 실패) @param {{code,message}|null} err
 */
export function mergeDirector(prev, { name, keys, res, err, at, trigger }) {
  const p = isObj(prev) ? prev : {};
  const cmds = { ...(isObj(p.cmds) ? p.cmds : {}) };
  const data = { ...(isObj(p.data) ? p.data : {}) };
  for (const k of POLICY_KEYS) {
    if (!keys.includes(k)) { delete cmds[k]; continue; }   // 끈 선택 명령 — 상태는 지우되 지난 값은 '마지막 성공' 으로 남긴다
    const r = res?.results?.[k];
    if (r?.ok) { cmds[k] = { ok: true, at, ms: r.ms ?? null, ...(r.fallback ? { fallback: true } : {}) }; data[k] = { at, value: r.value }; }
    else if (r) cmds[k] = { ok: false, at, code: r.code || 'error', message: str(r.message, 300) };
    else cmds[k] = { ok: false, at, code: err?.code || 'error', message: str(err?.message, 300) };
  }
  const required = POLICY_CMDS.filter((c) => !c.optional).map((c) => c.key);
  return {
    name: str(name, 64), at, trigger, version: res?.version || p.version || '',
    ok: required.every((k) => cmds[k]?.ok === true), any: keys.some((k) => cmds[k]?.ok === true),
    ...(err ? { error: { code: str(err.code, 32) || 'error', message: str(err.message, 300) } } : {}),
    cmds, data,
  };
}

/** 시한이 지나면 결과를 포기한다(staleAlert 와 같은 이유 — 수집 함수는 Director 마다 시한이 있지만 전체가 가드를 영원히 붙잡지 않게). */
function giveUpAfter(ms, p) {
  let t;
  const timer = new Promise((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error(`정책 수집 전체 시한 초과(${Math.round(ms / 60_000)}분)`), { code: 'timeout' })), ms); });
  return Promise.race([Promise.resolve(p), timer]).finally(() => clearTimeout(t));
}

/**
 * 수집 — Director 들(또는 고른 것만). 이미 도는 중이면 { busy:true }.
 * @param {{ trigger?:'timer'|'manual', directorIds?:string[]|null, demoOnly?:boolean, now?:number }} o
 * @returns {Promise<{ busy?:boolean, done:{ id, ok, any, code? }[] }>}
 */
export async function collectPolicy({ trigger = 'timer', directorIds = null, demoOnly = false } = {}) {
  if (_busy) return { busy: true, done: [] };
  _busy = true;
  const done = [];
  try {
    const settings = effectiveSettings();
    const ps = settings.defaults?.policy || {};
    const keys = policyKeys(ps);
    const off = new Set(Array.isArray(ps.off) ? ps.off : []);
    const targets = settings.directors.filter((d) => (directorIds ? directorIds.includes(d.id) : !off.has(d.id)));
    for (const d of targets) _collecting.add(d.id);
    const work = poolSettled(targets, POLICY_CONCURRENCY, async (d) => {
      let res = null; let err = null;
      try {
        res = normPolicyResult(await onDirector(d.id, 'policy', { keys }, { trigger, signal: AbortSignal.timeout(DIRECTOR_DEADLINE_MS), demoOnly }));
      } catch (e) { err = { code: e?.code || 'error', message: e?.message || String(e) }; }
      const db = loadPolicy();
      db.directors[d.id] = mergeDirector(db.directors[d.id], { name: d.name, keys, res, err, at: Date.now(), trigger });
      done.push({ id: d.id, ok: db.directors[d.id].ok, any: db.directors[d.id].any, ...(err ? { code: err.code } : {}) });
      _collecting.delete(d.id);
    });
    try { await giveUpAfter(RUN_DEADLINE_MS, work); } catch (e) { console.warn(`[bareos] ${e.message}`); }
    // 설정에서 사라진 Director 의 저장본은 지운다(매핑이 없으면 화면이 쓸 곳이 없다)
    const db = loadPolicy();
    if (!directorIds) for (const id of Object.keys(db.directors)) if (!settings.directors.some((d) => d.id === id)) delete db.directors[id];
    persist();
  } catch (e) {
    console.warn(`[bareos] 정책 수집 오류: ${String(e?.message || e).slice(0, 200)}`);
  } finally {
    _busy = false;
    _collecting.clear();
  }
  return { done };
}
export const policyCollecting = () => new Set(_collecting);
export const policyBusy = () => _busy;

/** '지금 수집' 1분 간격(Director 마다) — 아직 이르면 남은 초. */
export function manualWaitSec(ids, now = Date.now()) {
  let wait = 0;
  for (const id of ids) { const at = _manualAt.get(id) || 0; if (now - at < MANUAL_GAP_MS) wait = Math.max(wait, Math.ceil((MANUAL_GAP_MS - (now - at)) / 1000)); }
  return wait;
}
export function markManual(ids, now = Date.now()) { for (const id of ids) _manualAt.set(id, now); }

/** 보낼 차례인가(순수 — staleAlert.dueOf 와 같은 규약). */
export function policyDue(ps, st, now = Date.now()) {
  const c = localClock(now);
  const day = c.day;
  if (!ps?.enabled || !/^([01]\d|2[0-3]):[0-5]\d$/.test(ps.time || '')) return { due: false, day };
  const [h, m] = ps.time.split(':').map(Number);
  if (c.hour * 60 + c.minute < h * 60 + m) return { due: false, day };
  if (st?.day === day && st?.ok === true) return { due: false, day };
  const tries = st?.day === day ? Number(st.tries) || 0 : 0;
  if (tries >= TRIES_MAX) return { due: false, day };
  if (st?.day === day && Number.isFinite(st.nextTry) && now < st.nextTry) return { due: false, day };
  return { due: true, day };
}

/** 틱 — 차례면 전부 수집(데모는 데모 Director 로 · 엣지 노드는 돌지 않는다). */
export async function policyTick(now = Date.now()) {
  if (_busy || isEdge()) return null;
  const settings = effectiveSettings();
  const ps = settings.defaults?.policy || {};
  const db = loadPolicy();
  // 데모: 수집본이 비어 있으면 시각과 무관하게 한 번(화면이 비지 않게 — 접속하지 않는 합성 Director)
  const demoFirst = isDemoActive() && !Object.keys(db.directors).length;
  const { due, day } = policyDue(ps, db.sched, now);
  if (!due && !demoFirst) return null;
  if (!settings.directors.length) return null;
  const r = await collectPolicy({ trigger: 'timer' });
  if (r.busy) return null;
  const ok = r.done.length > 0 && r.done.every((x) => x.any);
  if (due) {
    const tries = db.sched.day === day ? (Number(db.sched.tries) || 0) + 1 : 1;
    loadPolicy().sched = { day, ok, tries, at: now, nextTry: ok ? null : now + RETRY_MS };
    persist();
  }
  return r;
}

export function startBareosPolicy() {
  if (_timer || isEdge()) return;
  _timer = setInterval(() => { policyTick().catch(() => {}); }, TICK_MS);
  _timer.unref?.();
}

export function _resetPolicyForTest() { _db = null; _loadErr.clear(); _rev = 0; _busy = false; _collecting.clear(); _manualAt.clear(); if (_timer) { clearInterval(_timer); _timer = null; } }

/* ───────────────────────── 화면 값(Director 에 접속하지 않는다) ───────────────────────── */

const val = (d, k) => (isObj(d?.data?.[k]) ? d.data[k].value : null);
const levelKey = (l) => (l === 'Full' ? 'F' : l === 'Differential' ? 'D' : l === 'Incremental' ? 'I' : 'other');

/**
 * 범위 안 Director — 매핑된 vCenter 가 조회 범위 안에 하나라도 있는 것(전체 범위면 전부 · 매핑이 없어도).
 * @returns {Map<string, { dir, vcIds:string[] }>}
 */
export function scopedDirectors(settings, allowed) {
  const out = new Map();
  for (const d of settings.directors || []) {
    const vcIds = (settings.sites || []).filter((s) => s.directorId === d.id).map((s) => s.vcenterId);
    if (allowed && !vcIds.some((v) => allowed.has(v))) continue;
    out.set(d.id, { dir: d, vcIds: allowed ? vcIds.filter((v) => allowed.has(v)) : vcIds });
  }
  return out;
}

/** 잡 이름 → 원장 잡(포탈이 만든 잡) — 범위 판정 · 법인 귀속에 쓴다. */
const jobIndex = (digests) => new Map((digests || []).filter((j) => j?.bareosJob).map((j) => [j.bareosJob, j]));

/**
 * 한 Director 수집본의 풀 행(볼륨 요약 · 가득 참 · 사용 % 붙임). 풀이나 볼륨을 못 읽었으면 그 칸은 null.
 */
export function poolRows(d) {
  const pools = val(d, 'pools');
  const vol = val(d, 'volumes');
  if (!Array.isArray(pools)) return null;
  const byPool = new Map((vol?.pools || []).map((v) => [v.pool, v]));
  const scratch = pools.find((p) => p.type === 'Scratch' || /^scratch$/i.test(p.name));
  const scratchVols = vol ? (scratch ? (byPool.get(scratch.name.toLowerCase())?.n ?? scratch.numVols ?? 0) : 0) : null;
  return pools.map((p) => {
    const v = vol ? (byPool.get(p.name.toLowerCase()) || { pool: p.name.toLowerCase(), n: 0, status: {}, other: 0, bytes: 0, bytesN: 0, oldest: null, newest: null, retentionSec: null, errors: [] }) : null;
    return { ...p, vol: v, full: poolFull(p, v, scratchVols), pct: poolUsagePct(p, v) };
  });
}

/**
 * Director 스케줄 미리보기 → 잡 회차(쓰는 잡 수 · 레벨). jobOk(name) 가 false 인 잡은 세지 않는다(범위 밖 법인의 잡).
 * @returns {Array<{ at, schedule, level, jobs:number, vcIds:Set<string> }>}
 */
export function previewRuns(d, jobOk = () => true, byJob = new Map()) {
  const sch = val(d, 'scheduler');
  if (!sch) return [];
  const jobsOf = new Map((sch.schedules || []).filter((s) => s.enabled !== false).map((s) => [s.name, (s.jobs || []).filter((j) => j.enabled !== false && jobOk(j.name))]));
  const out = [];
  for (const p of sch.preview || []) {
    const jobs = jobsOf.get(p.schedule) || [];
    if (!jobs.length) continue;
    const vcIds = new Set(jobs.map((j) => byJob.get(j.name)?.vcenterId).filter(Boolean));
    out.push({ at: p.at, schedule: p.schedule, level: p.level, jobs: jobs.length, vcIds });
  }
  return out;
}

/** 그룹의 [from, to] 회차(예약이 켜진 그룹만 · 상한 14) — 2.838 backupSchedule.expandSlots 와 같은 규칙. */
function groupSlots(g, from, to) {
  const out = []; let t = from;
  for (let i = 0; i < 14; i++) {
    const s = nextSlot(g.schedule, t);
    if (!s || !Number.isFinite(s.at) || s.at > to) break;
    if (s.at <= t && i > 0) break;
    out.push({ at: s.at, level: s.level || slotLevel(g.schedule, s.at) });
    t = s.at + 60_000;
  }
  return out;
}

/**
 * VM 적용 정책 판정(계획 D4 — 서버 하나). 정책 있음 · 수동만 · 미등록 · 불일치 · 모름.
 * @param {{ job?:object|null, method?:string|null, group?:object|null, inDirSchedule?:boolean|null }} x
 *   inDirSchedule: 그 잡이 Director 스케줄(status scheduler 의 jobs)에 있다 true · 없다 false · 수집본이 없어 모름 null
 */
export function vmPolicyVerdict({ job, method, group, inDirSchedule }) {
  if (!job) return method === 'bareos' ? 'unregistered' : null;   // 잡도 없고 Bareos 정책도 아니면 이 표의 대상이 아니다
  if (method && method !== 'bareos') return 'mismatch';
  if (group?.schedule?.enabled === true) return 'policy';
  if (inDirSchedule === true) return 'policy';
  if (inDirSchedule === null) return 'unknown';
  return 'manual';
}

/** 이름으로 풀 행 찾기 — 같은 글자 먼저, 없으면 대소문자 무시(볼륨 목록의 풀 키는 소문자로 온다 — 실측). */
function findPool(rows, name) {
  if (!name || !Array.isArray(rows)) return null;
  return rows.find((p) => p.name === name) || rows.find((p) => p.name.toLowerCase() === String(name).toLowerCase()) || null;
}

/**
 * v2.840 잡 하나의 적용 정책(정책 · 일정 탭 VM 표 · 백업 대상 행 '적용 정책' 줄 — 판정은 여기 하나). Director 에 접속하지 않는다(수집본 · 그룹 · 원장만).
 *   일정 출처: 예약이 켜진 그룹 → Director 스케줄(status scheduler 의 jobs) → 없음. 풀: 그룹 풀 → 잡 풀(등록 때 매핑 풀). 보존: 그 풀의 Volume Retention(llist) → 볼륨 최빈값.
 * @returns {(j:object, method:string|null) => { dirId, verdict, src, next, dup, jobdefs, fullPool, incPool, pool, poolFrom, retentionSec, keep, group, collected }}
 *   dup = 그룹 예약과 Director 스케줄 둘 다에 든 잡의 Director 스케줄 이름(두 번 돌 수 있다 — 화면 경고) · 아니면 ''
 */
export function jobPolicyResolver({ settings, groups = [], db = loadPolicy(), now = Date.now() }) {
  const groupOf = new Map();
  for (const g of groups) for (const id of g.vmIds || []) groupOf.set(`${g.vcenterId}|${id}`, g);
  const inSched = new Map();   // directorId → Map(jobName → scheduleName) | null(수집 전)
  const schedOfDir = (dirId) => {
    if (inSched.has(dirId)) return inSched.get(dirId);
    const sch = val(db.directors[dirId], 'scheduler');
    const m = sch ? new Map() : null;
    if (m) for (const s of sch.schedules || []) if (s.enabled !== false) for (const j of s.jobs || []) if (j.enabled !== false && !m.has(j.name)) m.set(j.name, s.name);
    inSched.set(dirId, m);
    return m;
  };
  const poolsOf = new Map();
  const poolsFor = (dirId) => { if (!poolsOf.has(dirId)) poolsOf.set(dirId, poolRows(db.directors[dirId]) || []); return poolsOf.get(dirId); };
  return (j, method) => {
    const g = groupOf.get(`${j.vcenterId}|${j.vmId}`) || null;
    const dirId = jobDirectorId(j, settings);
    const d = db.directors[dirId];
    const m = schedOfDir(dirId);
    const inDir = m ? m.has(j.bareosJob) : null;
    const verdict = vmPolicyVerdict({ job: j, method, group: g, inDirSchedule: inDir });
    const jd = (val(d, 'jobdefs') || []).find((x) => x.name === settings.defaults?.jobDefs) || null;
    const poolName = g?.pool || j.pool || '';
    const pool = findPool(poolsFor(dirId), poolName);
    let src = null; let next = null;
    if (g?.schedule?.enabled === true) { src = { kind: 'group', name: g.name, text: scheduleText(g.schedule) }; const s = nextSlot(g.schedule, now); next = s ? { at: s.at, level: s.level } : null; }
    else if (inDir) {
      const sName = m.get(j.bareosJob);
      const rt = (val(d, 'schedules') || []).find((s) => s.name === sName);
      src = { kind: 'director', name: sName, text: rt ? rt.run.map((r) => r.text).join(' · ') : '' };
      const p = (val(d, 'scheduler')?.preview || []).find((x) => x.schedule === sName && x.at >= now);
      next = p ? { at: p.at, level: p.level } : null;
    }
    // 그룹 예약이 켜진 VM 의 잡이 Director 스케줄에도 들어 있으면 두 곳에서 돈다(그룹에 넣기 전에 Director 스케줄로 등록한 잡 — v2.830 은 새로 등록하는 잡만 스케줄 없이 만든다)
    const dup = g?.schedule?.enabled === true && inDir ? m.get(j.bareosJob) : '';
    return {
      dirId, verdict, src, next, dup, jobdefs: settings.defaults?.jobDefs || '', fullPool: jd?.fullPool || '', incPool: jd?.incPool || '',
      pool: poolName, poolFrom: g?.pool ? 'group' : poolName ? 'job' : '', retentionSec: pool?.volRetentionSec ?? pool?.vol?.retentionSec ?? null,
      keep: g?.keep ?? null, group: g ? { id: g.id, name: g.name } : null, collected: !!d,
    };
  };
}

/**
 * 정책 · 일정 탭 값(GET /tools/bareos-summary/policy). Director 에 접속하지 않는다.
 * @param {{ settings, digests, digestsKnown, groups, marks, marksKnown, vmsById:Map, allowed:Set|null, admin:boolean, demo:boolean, now:number, vcName:(id)=>string }} o
 */
export function policyView(o) {
  const { settings, digests = [], digestsKnown = true, groups = [], marks = {}, marksKnown = true, vmsById = new Map(), allowed = null, admin = false, demo = false, now = Date.now(), vcName = (x) => x } = o;
  const db = o.db || loadPolicy();
  const collecting = o.collecting || new Set();
  const scoped = scopedDirectors(settings, allowed);
  const mine = digests.filter((j) => !!j.demo === demo && (!allowed || allowed.has(j.vcenterId)));
  const byJob = jobIndex(digests.filter((j) => !!j.demo === demo));
  // 범위 계정은 범위 밖 법인의 잡을 세지 않는다 — 포탈이 만든 잡이 아니면(BackupCatalog 등 Director 자체 잡) 전체 범위만 센다
  const jobOk = (name) => (!allowed ? true : allowed.has(byJob.get(name)?.vcenterId));
  const myGroups = groups.filter((g) => !allowed || allowed.has(g.vcenterId));
  const today = dayStartMs(dayIndex(now));
  const weekEnd = today + 7 * DAY;

  // ── Director 수집 상태 ──
  const directors = [];
  let schedN = 0; let unusedN = 0; let jobdefsN = null; let filesetsN = null; let aiN = 0; let poolsN = null; let volsN = null; let fullPools = 0; let errorVols = 0; let maxPct = null;
  const scheduleRows = [];
  const week = Array.from({ length: 7 }, (_, i) => ({ day: today + i * DAY, F: 0, D: 0, I: 0, other: 0, jobs: 0, groups: 0 }));
  const addWeek = (at, level, n) => {
    if (at < today || at >= weekEnd) return;
    const w = week[Math.floor((at - today) / DAY)];
    w[levelKey(level)] += n; w.jobs += n;
  };
  const dirNext = new Map();   // directorId → [{ schedule, at, level }] (오늘부터 24시간 — 겹침 판정)
  const jobdefRows = []; const filesetRows = []; const poolTable = [];
  for (const [id, { dir, vcIds }] of scoped) {
    const d = db.directors[id];
    directors.push({
      id, name: dir.name, via: dir.agent ? 'edge' : 'central', vcNames: vcIds.map(vcName).slice(0, 10),
      at: d?.at ?? null, ok: d ? d.ok === true : null, collecting: collecting.has(id), version: d?.version || '',
      cmds: Object.fromEntries(POLICY_KEYS.map((k) => {
        const c = d?.cmds?.[k];
        const last = d?.data?.[k]?.at ?? null;
        return [k, c ? { ok: c.ok === true, code: c.ok ? '' : c.code || 'error', last, ...(admin && !c.ok && c.message ? { message: c.message } : {}) } : (last ? { ok: null, code: 'off', last } : null)];
      })),
      ...(admin && d?.error?.message ? { error: d.error } : d?.error ? { error: { code: d.error.code } } : {}),
      off: (settings.defaults?.policy?.off || []).includes(id),
    });
    if (!d) continue;
    // 스케줄
    const sch = val(d, 'scheduler');
    const runs = previewRuns(d, jobOk, byJob);
    for (const r of runs) addWeek(r.at, r.level, r.jobs);
    dirNext.set(id, runs.filter((r) => r.at >= now && r.at < now + DAY));
    if (sch) {
      const runText = new Map((val(d, 'schedules') || []).map((s) => [s.name, s]));
      for (const s of sch.schedules || []) {
        const jobs = (s.jobs || []).filter((j) => j.enabled !== false && jobOk(j.name));   // 꺼진 잡은 돌지 않는다 — 쓰는 잡에 세지 않는다
        if (allowed && !jobs.length) continue;   // 범위 계정 — 자기 법인 잡이 없는 스케줄은 보이지 않는다
        schedN++;
        if (!jobs.length) unusedN++;
        const next = runs.find((r) => r.schedule === s.name && r.at >= now) || null;
        const rt = runText.get(s.name);
        scheduleRows.push({
          src: 'director', director: dir.name, directorId: id, name: s.name, enabled: s.enabled, vcNames: [...new Set(jobs.map((j) => byJob.get(j.name)?.vcenterId).filter(Boolean))].map(vcName).slice(0, 5),
          run: rt ? rt.run : null, description: rt?.description || '', jobs: jobs.length, portalJobs: jobs.filter((j) => byJob.has(j.name)).length,
          jobNames: jobs.slice(0, 5).map((j) => j.name), next: next ? { at: next.at, level: next.level } : null, overlap: [],
        });
      }
    }
    // JobDefs · FileSet(수집했을 때만 — 아니면 null 로 남아 화면이 '권한 없음 · 수집 전' 을 밝힌다)
    const jd = val(d, 'jobdefs');
    if (Array.isArray(jd)) { jobdefsN = (jobdefsN || 0) + jd.length; for (const x of jd) { if (x.ai?.on) aiN++; jobdefRows.push({ ...x, director: dir.name, directorId: id }); } }
    const fs2 = val(d, 'filesets');
    if (Array.isArray(fs2)) { filesetsN = (filesetsN || 0) + fs2.length; for (const x of fs2) filesetRows.push({ ...x, director: dir.name, directorId: id }); }
    // 풀
    const pr = poolRows(d);
    if (pr) {
      poolsN = (poolsN || 0) + pr.length;
      for (const p of pr) {
        if (p.numVols !== null) volsN = (volsN || 0) + p.numVols;
        if (p.full === true) fullPools++;
        errorVols += p.vol?.status?.Error || 0;
        if (p.pct !== null && (maxPct === null || p.pct > maxPct)) maxPct = p.pct;
        poolTable.push({ ...p, director: dir.name, directorId: id });
      }
    }
  }
  // 포탈 그룹 예약(같은 표에 · 7일 칸에 더한다)
  let groupSchedN = 0;
  const groupNext = new Map();   // directorId → [{ name, at }]
  for (const g of myGroups) {
    if (g.schedule?.enabled !== true) continue;
    groupSchedN++;
    const slots = groupSlots(g, now, weekEnd);
    for (const s of slots) { addWeek(s.at, s.level, (g.vmIds || []).length); const w = week[Math.floor((s.at - today) / DAY)]; if (w && s.at >= today) w.groups++; }
    const next = slots[0] || null;
    const dirId = g.directorId || (settings.sites || []).find((x) => x.vcenterId === g.vcenterId)?.directorId || '';
    if (next && next.at < now + DAY) { const a = groupNext.get(dirId) || []; a.push({ name: g.name, at: next.at }); groupNext.set(dirId, a); }
    scheduleRows.push({
      src: 'group', director: scoped.get(dirId)?.dir?.name || '', directorId: dirId, name: g.name, enabled: true, vcNames: [vcName(g.vcenterId)],
      run: [{ text: scheduleText(g.schedule), level: g.schedule.level || null, at: g.schedule.time || null, pool: g.pool || null }], description: g.keep ? `보관 Full 체인 ${g.keep}개(포탈)` : '',
      jobs: (g.vmIds || []).length, portalJobs: (g.vmIds || []).length, jobNames: [], next: next ? { at: next.at, level: next.level } : null, overlap: [],
    });
  }
  // 겹침 — 같은 Director 의 Director 스케줄 회차와 그룹 회차가 1시간 안(둘 다 길이를 몰라 60분 추정 — 표지)
  for (const row of scheduleRows) {
    if (!row.next || row.next.at >= now + DAY) continue;
    const other = row.src === 'director' ? (groupNext.get(row.directorId) || []).map((x) => ({ name: x.name, at: x.at })) : (dirNext.get(row.directorId) || []).map((x) => ({ name: x.schedule, at: x.at }));
    row.overlap = [...new Set(other.filter((x) => Math.abs(x.at - row.next.at) < EST_MS).map((x) => x.name))].slice(0, 5);
  }
  scheduleRows.sort((a, b) => (a.next?.at ?? Infinity) - (b.next?.at ?? Infinity) || a.name.localeCompare(b.name));

  // ── VM 적용 정책 ──
  const vmRows = []; const counts = { policy: 0, manual: 0, unregistered: 0, mismatch: 0, unknown: 0 };
  if (digestsKnown) {
    const resolve = jobPolicyResolver({ settings, groups: myGroups, db, now });
    const seenVm = new Set();
    const push = (row) => { counts[row.verdict]++; if (vmRows.length < VM_ROWS_MAX) vmRows.push(row); };
    for (const j of mine) {
      seenVm.add(`${j.vcenterId}|${j.vmId}`);
      const vm = vmsById.get(j.vmId) || null;
      const method = marksKnown ? (marks[j.vmId]?.method || '') : null;
      const r = resolve(j, method);
      push({
        vmId: j.vmId, vm: str(vm?.name || j.vmName, 128), os: vm ? osKind(vm.guestOS) : null,   // inventory/osKind.js(windows·linux·other·null — Detail 과 같은 판정)
        vc: j.vcenterId, vcName: vcName(j.vcenterId), job: j.bareosJob, enabled: j.enabled !== false, director: scoped.get(r.dirId)?.dir?.name || '',
        src: r.src, ...(r.dup ? { dup: r.dup } : {}), jobdefs: r.jobdefs, fullPool: r.fullPool, incPool: r.incPool, pool: r.pool, poolFrom: r.poolFrom,
        retentionSec: r.retentionSec, keep: r.keep,
        lastOk: Number.isFinite(j.lastOkAt) ? j.lastOkAt : null, failing: /^[Eef]/.test(String(j.lastRun?.status || '')), next: r.next, verdict: r.verdict,
      });
    }
    if (marksKnown) {
      for (const [vmId, mk] of Object.entries(marks || {})) {
        if (mk?.method !== 'bareos') continue;
        const vm = vmsById.get(vmId);
        if (!vm || (allowed && !allowed.has(vm.vcenterId))) continue;
        if (seenVm.has(`${vm.vcenterId}|${vmId}`)) continue;
        push({ vmId, vm: str(vm.name, 128), os: osKind(vm.guestOS), vc: vm.vcenterId, vcName: vcName(vm.vcenterId), job: '', enabled: null, director: '', src: null, jobdefs: '', fullPool: '', incPool: '', pool: '', retentionSec: null, keep: null, lastOk: null, failing: false, next: null, verdict: 'unregistered' });
      }
    }
  }
  const order = { mismatch: 0, unregistered: 1, manual: 2, unknown: 3, policy: 4 };
  vmRows.sort((a, b) => order[a.verdict] - order[b.verdict] || String(a.vcName).localeCompare(String(b.vcName)) || String(a.vm).localeCompare(String(b.vm)));

  const collected = directors.filter((d) => d.at !== null).length;
  return {
    ok: true, at: now, directors,
    kpis: {
      schedules: { director: collected ? schedN : null, group: groupSchedN, unused: collected ? unusedN : null },
      jobdefs: jobdefsN, filesets: filesetsN, ai: jobdefsN === null ? null : aiN,
      pools: poolsN === null ? null : { n: poolsN, vols: volsN, full: fullPools, errorVols, maxPct },
      vm: { total: digestsKnown ? Object.values(counts).reduce((a, b) => a + b, 0) : null, ...counts },
    },
    week, schedules: scheduleRows.slice(0, 1000), jobdefs: jobdefRows.slice(0, 500), filesets: filesetRows.slice(0, 500), pools: poolTable.slice(0, 1000),
    vms: vmRows, ...(Object.values(counts).reduce((a, b) => a + b, 0) > vmRows.length ? { vmsTruncated: true } : {}),
    ...(digestsKnown ? {} : { registryUnreadable: true }), ...(marksKnown ? {} : { marksUnreadable: true }),
    loadError: !!policyLoadError() || undefined,
    collect: { enabled: settings.defaults?.policy?.enabled !== false, time: settings.defaults?.policy?.time || '', last: db.sched?.at ?? null, lastOk: db.sched?.ok ?? null, busy: _busy },
  };
}

/**
 * Backup › Summary 의 Bareos 카드 · 용량 카드에 쓰는 요약(범위 안 Director 수집본만). 수집본이 하나도 없으면 null(— '수집 전').
 * @returns {null | { pools:{ n, full, errorVols, maxPct }|null, schedules:number|null, next:number|null, collected:number, directors:number }}
 */
export function policySummary(settings, allowed, digests = [], { now = Date.now(), demo = false, db = loadPolicy() } = {}) {
  const scoped = scopedDirectors(settings, allowed);
  const byJob = jobIndex(digests.filter((j) => !!j.demo === demo));
  const jobOk = (name) => (!allowed ? true : allowed.has(byJob.get(name)?.vcenterId));
  let collected = 0; let pools = null; let schedules = null; let next = null;
  for (const [id] of scoped) {
    const d = db.directors[id];
    if (!d) continue;
    collected++;
    const pr = poolRows(d);
    if (pr) {
      pools = pools || { n: 0, full: 0, errorVols: 0, maxPct: null };
      for (const p of pr) { pools.n++; if (p.full === true) pools.full++; pools.errorVols += p.vol?.status?.Error || 0; if (p.pct !== null && (pools.maxPct === null || p.pct > pools.maxPct)) pools.maxPct = p.pct; }
    }
    const sch = val(d, 'scheduler');
    if (sch) {
      schedules = (schedules || 0) + (sch.schedules || []).filter((s) => !allowed || (s.jobs || []).some((j) => jobOk(j.name))).length;
      for (const r of previewRuns(d, jobOk, byJob)) if (r.at >= now && (next === null || r.at < next)) next = r.at;
    }
  }
  return collected ? { pools, schedules, next, collected, directors: scoped.size } : null;
}

/**
 * 2.838 '백업 스케줄 — 다음 24시간' 의 Bareos 줄에 더할 Director 스케줄 회차 — 법인(vCenter)마다, 그 법인의 포탈 잡이 든 회차만(쓰는 잡 수 = 그 법인 잡 수).
 * @returns {Map<string, Array<{ name, at, end, est:true, full, level, vms, src:'director' }>>}
 */
export function directorScheduleItems(settings, digests, from, to, { demo = false, db = loadPolicy() } = {}) {
  const out = new Map();
  const byJob = jobIndex((digests || []).filter((j) => !!j.demo === demo));
  for (const d0 of settings.directors || []) {
    const d = db.directors[d0.id];
    const sch = val(d, 'scheduler');
    if (!sch) continue;
    const jobsOf = new Map((sch.schedules || []).filter((s) => s.enabled !== false).map((s) => [s.name, (s.jobs || []).filter((j) => j.enabled !== false)]));
    for (const p of sch.preview || []) {
      if (p.at < from || p.at > to) continue;
      const per = new Map();
      for (const j of jobsOf.get(p.schedule) || []) { const vc = byJob.get(j.name)?.vcenterId; if (vc) per.set(vc, (per.get(vc) || 0) + 1); }
      for (const [vc, n] of per) {
        const a = out.get(vc) || [];
        a.push({ name: p.schedule, at: p.at, end: p.at + EST_MS, est: true, full: p.level === 'Full', level: p.level, vms: n, src: 'director' });
        out.set(vc, a);
      }
    }
  }
  return out;
}

/**
 * 그 Director 의 잡 이름 → Director 스케줄의 다음 실행(수집본 미리보기 — 지금 뒤 가장 이른 것). 수집본이 없으면 빈 맵(다음 예정 '—' — 없다고 단정하지 않는다).
 * @returns {Map<string, { at, level, schedule }>}
 */
export function directorNextByJob(directorId, now = Date.now(), db = loadPolicy()) {
  const out = new Map();
  const sch = val(db.directors[directorId], 'scheduler');
  if (!sch) return out;
  const first = new Map();
  for (const p of sch.preview || []) if (p.at > now && !first.has(p.schedule)) first.set(p.schedule, p);
  for (const s of sch.schedules || []) {
    if (s.enabled === false) continue;
    const p = first.get(s.name);
    if (!p) continue;
    for (const j of s.jobs || []) if (j.enabled !== false && !out.has(j.name)) out.set(j.name, { at: p.at, level: p.level, schedule: s.name });
  }
  return out;
}

/* ───────────────────────── v2.840 '보존 · 풀' 탭 · 그룹 카드 · 통합 에러 로그(Director 에 접속하지 않는다) ───────────────────────── */

/** 그룹이 쓰는 Director — 그룹에 적힌 것, 없으면 그 법인 매핑. */
const groupDirId = (g, settings) => g.directorId || (settings.sites || []).find((x) => x.vcenterId === g.vcenterId)?.directorId || '';

/**
 * 풀마다 쓰는 포탈 잡 수(추정 — 화면이 밝힌다): 잡의 풀 = 그 VM 이 든 그룹의 풀 → 잡 풀(등록 때 매핑 풀). 거기에 JobDefs 의 레벨별 풀(Full · Incremental · Differential Backup Pool)도
 * 그 잡이 쓰는 풀로 센다(그룹 풀이 없을 때 — 레벨마다 다른 풀로 간다). Director 자체 잡(포탈 원장에 없음)은 풀을 모른다 — 세지 않는다.
 * @returns {Map<string, { jobs:number, groups:number, jobdefs:string[] }>} 키 = 풀 이름 소문자
 */
export function poolUsage(d, jobs, groups, settings) {
  const out = new Map();
  const at = (name) => { const k = String(name).toLowerCase(); let x = out.get(k); if (!x) { x = { jobs: 0, groups: 0, jobdefs: [] }; out.set(k, x); } return x; };
  const jdList = val(d, 'jobdefs');
  const jd = Array.isArray(jdList) ? jdList.find((x) => x.name === settings.defaults?.jobDefs) || null : null;
  const levelPools = jd ? [jd.fullPool, jd.incPool, jd.diffPool].filter(Boolean) : [];
  const groupOf = new Map();
  for (const g of groups) for (const id of g.vmIds || []) groupOf.set(`${g.vcenterId}|${id}`, g);
  for (const g of groups) if (g.pool) at(g.pool).groups++;
  for (const j of jobs) {
    const g = groupOf.get(`${j.vcenterId}|${j.vmId}`);
    const set = new Set();
    if (g?.pool) set.add(g.pool.toLowerCase());
    else { if (j.pool) set.add(j.pool.toLowerCase()); for (const p of levelPools) set.add(p.toLowerCase()); }
    for (const k of set) at(k).jobs++;
  }
  if (Array.isArray(jdList)) {
    for (const x of jdList) for (const [k, lab] of [['pool', ''], ['fullPool', 'Full'], ['incPool', 'Incr'], ['diffPool', 'Diff']]) {
      if (!x[k]) continue;
      const e = at(x[k]);
      if (e.jobdefs.length < 10) e.jobdefs.push(lab ? `${x.name}(${lab})` : x.name);
    }
  }
  return out;
}

const cmdState = (d, k, admin) => {
  const c = d?.cmds?.[k];
  const last = d?.data?.[k]?.at ?? null;
  return c ? { ok: c.ok === true, code: c.ok ? '' : c.code || 'error', last, ...(admin && !c.ok && c.message ? { message: c.message } : {}) } : (last ? { ok: null, code: 'off', last } : null);
};

/**
 * '보존 · 풀' 탭 값(GET /tools/bareos-summary/pools). 범위 안 Director 의 수집본만 — 풀 표(보존 · 상한 · 볼륨 상태 · 사용량 · 쓰는 잡) · 클라이언트 보존 · 숫자.
 *   범위 계정: 클라이언트는 범위 안 잡이 쓰는 FD 만 · 쓰는 잡 수는 범위 안 잡만 센다.
 * @param {{ settings, digests, digestsKnown, groups, allowed:Set|null, admin:boolean, demo:boolean, now:number, vcName, db? }} o
 */
export function poolsView(o) {
  const { settings, digests = [], digestsKnown = true, groups = [], allowed = null, admin = false, demo = false, now = Date.now(), vcName = (x) => x } = o;
  const db = o.db || loadPolicy();
  const scoped = scopedDirectors(settings, allowed);
  const mine = digests.filter((j) => !!j.demo === demo && (!allowed || allowed.has(j.vcenterId)));
  const myGroups = groups.filter((g) => !allowed || allowed.has(g.vcenterId));
  const directors = []; const pools = []; const clients = [];
  let poolsN = null; let volsN = null; let full = 0; let errorVols = 0; let maxPct = null; let clientsN = null; let unknownFull = 0;
  for (const [id, { dir, vcIds }] of scoped) {
    const d = db.directors[id];
    directors.push({
      id, name: dir.name, via: dir.agent ? 'edge' : 'central', vcNames: vcIds.map(vcName).slice(0, 10), at: d?.at ?? null, version: d?.version || '',
      cmds: { pools: cmdState(d, 'pools', admin), volumes: cmdState(d, 'volumes', admin), clients: cmdState(d, 'clients', admin) },
      fallback: d?.cmds?.pools?.fallback === true || undefined,
    });
    if (!d) continue;
    const jobsHere = mine.filter((j) => jobDirectorId(j, settings) === id);
    const groupsHere = myGroups.filter((g) => groupDirId(g, settings) === id);
    const used = poolUsage(d, jobsHere, groupsHere, settings);
    const pr = poolRows(d);
    if (pr) {
      poolsN = (poolsN || 0) + pr.length;
      for (const p of pr) {
        if (p.numVols !== null) volsN = (volsN || 0) + p.numVols;
        if (p.full === true) full++; else if (p.full === null) unknownFull++;
        errorVols += p.vol?.status?.Error || 0;
        if (p.pct !== null && (maxPct === null || p.pct > maxPct)) maxPct = p.pct;
        pools.push({
          ...p, director: dir.name, directorId: id, poolAt: d.data?.pools?.at ?? null, volAt: d.data?.volumes?.at ?? null,
          used: used.get(p.name.toLowerCase()) || { jobs: 0, groups: 0, jobdefs: [] }, queryable: isResourceName(p.name),
        });
      }
    }
    const cl = val(d, 'clients');
    if (Array.isArray(cl)) {
      clientsN = clientsN || 0;
      for (const c of cl) {
        const jobs = jobsHere.filter((j) => j.client === c.name).length;
        if (allowed && !jobs) continue;   // 범위 계정 — 자기 법인 잡이 쓰는 FD 만
        clientsN++;
        clients.push({ ...c, director: dir.name, directorId: id, jobs, at: d.data?.clients?.at ?? null });
      }
    }
  }
  pools.sort((a, b) => (b.full === true) - (a.full === true) || (b.vol?.status?.Error || 0) - (a.vol?.status?.Error || 0) || a.director.localeCompare(b.director) || a.name.localeCompare(b.name));
  clients.sort((a, b) => a.director.localeCompare(b.director) || a.name.localeCompare(b.name));
  return {
    ok: true, at: now, directors,
    kpis: { pools: poolsN, vols: volsN, full: poolsN === null ? null : full, unknownFull: poolsN === null ? null : unknownFull, errorVols: poolsN === null ? null : errorVols, maxPct, clients: clientsN },
    pools: pools.slice(0, 1000), clients: clients.slice(0, 2000), ...(pools.length > 1000 ? { poolsTruncated: true } : {}),
    ...(digestsKnown ? {} : { registryUnreadable: true }), loadError: !!policyLoadError() || undefined,
  };
}

/**
 * 그룹 카드의 '적용 풀 · 보존'(v2.840) — 그 Director 수집본에서 풀 하나. 수집본 · 풀 목록이 없으면 null(모름 — 화면 '정책 수집 전').
 * @returns {null | { name, missing?:true, retentionSec, retentionFrom:'pool'|'volumes'|null, full, pct, errorVols, at }}
 */
export function poolPolicyOf(directorId, poolName, db = loadPolicy()) {
  const d = db.directors[directorId];
  if (!d || !poolName) return null;
  const pr = poolRows(d);
  if (!pr) return null;
  const at = d.data?.pools?.at ?? null;
  const p = findPool(pr, poolName);
  if (!p) return { name: str(poolName, 64), missing: true, retentionSec: null, retentionFrom: null, full: null, pct: null, errorVols: 0, at };
  const retentionFrom = p.volRetentionSec !== null ? 'pool' : p.vol?.retentionSec != null ? 'volumes' : null;
  return { name: p.name, retentionSec: p.volRetentionSec ?? p.vol?.retentionSec ?? null, retentionFrom, full: p.full, pct: p.pct, errorVols: p.vol?.status?.Error || 0, at };
}

/**
 * 통합 에러 로그의 '오류 볼륨'(v2.840) — 범위 안 Director 의 수집본에서 VolStatus Error 인 볼륨(풀마다 이름 ≤20 + 나머지 수). 시각 = 볼륨 목록을 수집한 시각.
 * @returns {Array<{ at, directorId, director, vcIds, pool, n, names }>}
 */
export function errorVolumeItems(settings, allowed, { db = loadPolicy() } = {}) {
  const out = [];
  for (const [id, { dir, vcIds }] of scopedDirectors(settings, allowed)) {
    const d = db.directors[id];
    const vol = val(d, 'volumes');
    const at = d?.data?.volumes?.at;
    if (!vol || !Number.isFinite(at)) continue;
    const pr = val(d, 'pools');
    for (const p of vol.pools || []) {
      const n = p.status?.Error || 0;
      if (!n) continue;
      const name = (Array.isArray(pr) ? findPool(pr, p.pool)?.name : '') || p.pool;
      out.push({ at, directorId: id, director: dir.name, vcIds, pool: name, n, names: (p.errors || []).slice(0, 20) });
    }
  }
  return out;
}

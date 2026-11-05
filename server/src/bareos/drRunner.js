/**
 * bareos/drRunner.js — 재해 복구 2차: 복구 순서(단계 자동 실행) — 시안 ② Disaster2 '3. 복구 순서' · 사용자 결정 '두 번에 나눠' · '② 표준'(2026-11-04).
 *
 * 사람이 단계(기반 → DB → 나머지 …)와 단계마다 동시 복원 수를 정하고 본인 OTP 로 한 번 시작하면, 포탈이 **앞 단계가 모두 끝난 뒤** 다음 단계를 보낸다.
 * 규칙(되돌리지 말 것):
 *  · 상태는 파일(bareos-dr-runs.json)에 — 재시작해도 이어 간다. 보내기 **전에** 항목을 'sending' 으로 남기고, 재시작 뒤 'sending' 이 보이면
 *    결과 모름(보냈을 수 있다 — 다시 보내지 않는다)으로 바꾸고 그 회차를 멈춘다(사람이 Director 에서 확인).
 *  · 보내는 길은 묶음 복원과 같은 판정(bulkRestorePlan · drItemIssue · 이름 예약 reservedRestoreNames · 진행 중/결과 모름 붙잡기)과 같은 작업(ops.restores) ·
 *    원장 기록(addRestore — dr 표지 · drRun). 판정을 따로 만들지 않는다.
 *  · 단계에 실패 · 결과 모름이 있으면 **멈춤(paused)** — 사람이 '계속'(본인 OTP)을 눌러야 다음 단계로(기반이 실패했는데 DB 를 올리지 않게).
 *    '계속' 은 **그 순간 보인 실패 · 결과 모름 VM 만** 확인 처리한다(acked) — 다른 사유(점검 ✕ 등)로 멈춘 뒤 계속하고 나서 생긴 실패는 다시 멈춘다(반증 F1).
 *  · 걸음은 매번 회차 상태를 다시 본다 — 보내기를 기다리는 동안 멈춘(stopped) 회차는 보내지 않고, 보내기 뒤에도 'stopped' 를 'paused' 로 덮지 않는다(반증 F2 · F3).
 *  · 회차마다 따로 걷는다(법인 1:1:1 — 느린 법인 하나가 다른 법인의 회차를 막지 않게 · 반증 F7). 진행 중 · 멈춤 회차는 보관 상한에서 밀려나지 않는다(F5).
 *  · 단계마다 '켜 보기' 를 고르면 그 복원은 verify(끊기 → 켜기 → Tools → 끄기) — **지우지 않는다**(deleteOnOk false · 재해 복구 VM 이다).
 *  · 점검 ✕(drGateBlock — Director · 새 vCenter · 매핑) 가 생기면 보내지 않고 멈춤. 시험 1대 규칙은 시작할 때 라우트가 본다(회차는 여러 대).
 *  · 대상 잠금(jobLocks)은 보내는 동안만 · 잡지 못한 대상은 다음 틱에. 중앙 전용(엣지는 기동하지 않고 라우트가 시작 · 계속을 409 — 반증 F10) · 회차마다 재진입 가드.
 *  · 시작 때 정한 범위 · 권한으로 돈다(백업 그룹 실행과 같은 모델) — 멈춤 · 계속 · 시작은 라우트가 그때의 쓰기 범위를 본다.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { store } from '../store.js';
import { atomicWriteFileSync, preserveCorrupt, safeLoadText } from '../util/atomicWrite.js';
import { registerStateFile } from '../util/stateFiles.js';
import { listJobsOf, getJob, addRestore, inBatch, restoreOpen, restoreHeld, restoreUnknownHeld, restoreFinishing, registryLoadError } from './registry.js';
import { jobDirectorId, directorById, directorConn, directorCred } from './settings.js';
import { bulkRestorePlan, reservedRestoreNames, inventoryAtOf, BULK_RESTORE_MAX } from './restore.js';
import { onDirector, effectiveSettings, isEdgeNode, isDemoActive, bareosAuthGuard } from './service.js';
import { SESSION_DEAD } from './ops.js';
import { drItemIssue, drGateBlock } from './drPlan.js';
import { pluginValueIssue } from './names.js';
import { noteRestoreBatchStart, noteRestoreBatchEnd } from './inflight.js';
import { RESTORES_DEADLINE_MS } from './edgeOps.js';
import { tryLockJob, unlockJob } from './jobLocks.js';
import { registryHosts } from './vcHost.js';
import { logAudit } from '../audit.js';

export const DR_TICK_MS = 30_000;
export const DR_WAVES_MAX = 10;
export const DR_ITEMS_MAX = 1000;
export const DR_CONC_MAX = BULK_RESTORE_MAX;
const RUNS_KEEP = 20;   // 끝난 · 멈춘 회차 보관 수(진행 중 · 멈춤은 세지 않고 모두 남긴다)
/** 보낸 뒤 원장에서 그 복원 행이 사라졌을 때(다시 묶기 · 보관 상한) 결과 모름으로 보기까지 — 끝맺음 상한(24시간)보다 길게. */
const SENT_LOST_MS = 48 * 3600_000;
const ACTIVE = new Set(['running', 'paused']);
registerStateFile('bareos-dr-runs.json');
const FILE = () => path.join(config.configDir, 'bareos-dr-runs.json');   // ⚠ 리터럴 형태 유지 — scripts/config-doc.mjs 가 이 모양으로 파일을 찾는다
const fail = (code, msg) => Object.assign(new Error(msg), { code });

let _db = null; let _bad = ''; let _timer = null; let _pollDirs = () => ({});
const _stepping = new Set();   // 지금 걷는 회차 id(회차마다 재진입 가드)

/** 상태 파일 모양(버그 점검 B3-06 — JSON 이지만 모양이 틀리면 빈 상태로 보고 다음 저장이 원본을 덮었다 · 회차에 waves 가 없으면 GET 이 500). */
function shapeIssue(db) {
  if (!db || typeof db !== 'object' || Array.isArray(db) || !Array.isArray(db.runs)) return 'runs 목록이 아닙니다';
  for (const r of db.runs) {
    if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !Array.isArray(r.waves)) return '회차 모양이 틀렸습니다';
    for (const w of r.waves) if (!w || typeof w !== 'object' || !Array.isArray(w.items)) return '단계 모양이 틀렸습니다';
  }
  return '';
}
function load() {
  if (_db) return _db;
  try {
    _db = fs.existsSync(FILE()) ? JSON.parse(fs.readFileSync(FILE(), 'utf8')) : { runs: [] };
    const bad = shapeIssue(_db);
    if (bad) throw Object.assign(new Error(bad), { shape: true });
  } catch (e) {
    // 손상 — 보존하고 이 프로세스에서는 실행기를 멈춘다(빈 상태로 다시 시작하면 보내던 단계를 처음부터 다시 보낸다)
    preserveCorrupt(FILE(), e?.message);
    _bad = `재해 복구 실행 상태 파일을 읽지 못해 보존했습니다(${safeLoadText(e) || '사유 미상'}) — 이 프로세스에서는 복구 순서를 멈췄습니다`;
    console.warn(`[bareos] ${_bad}`);
    _db = { runs: [] };
  }
  return _db;
}
/** 저장 — 실패하면 던진다(보내기 전 'sending' 기록이 남지 않으면 보내지 않는다). */
function save() { atomicWriteFileSync(FILE(), JSON.stringify(_db), { mode: 0o600 }); }
/**
 * 사람의 동작(시작 · 멈춤 · 계속) 저장 — 실패하면 **메모리를 되돌리고** 던진다(버그 점검 B1-01 · B3-03 — 재현: 400 을 받았는데 메모리는 바뀌어
 *   시작 실패한 회차가 보내고, 멈춤 실패한 회차가 재시작 뒤 다시 돌았다). 응답 문구에 파일 경로를 싣지 않는다(서버 로그에만).
 */
function saveOrRollback(rollback) {
  try { save(); } catch (e) {
    try { rollback(); } catch { /* 되돌리기 실패는 아래 오류로 함께 알린다 */ }
    console.warn(`[bareos] 재해 복구 실행 상태 저장 실패: ${clip(e?.message || e, 300)}`);
    throw fail('save-failed', '실행 상태를 저장하지 못해 바꾸지 않았습니다(디스크 · 권한 — 서버 로그 확인).');
  }
}
export const drRunsLoadError = () => { load(); return _bad; };
export function _resetDrRunsForTest() { _db = null; _bad = ''; _stepping.clear(); }
/** 폴러의 Director 조회 상태 공급자(drGateBlock 의 Director 판정 — poller 를 import 하면 순환이라 기동 때 넣는다). */
export function setDrPollDirs(fn) { _pollDirs = typeof fn === 'function' ? fn : () => ({}); }

const clip = (v, n) => String(v ?? '').slice(0, n);
/**
 * 시작 요청의 단계 정규화(순수) — 틀리면 던진다(조용히 고치지 않는다). 항목은 화면 drItem 모양(새 VM · 끊은 채)만 받는다.
 * @returns {{ name, concurrency, verify, items: { id, jobid, newVm }[] }[]}
 */
export function normWaves(input) {
  const ws = Array.isArray(input) ? input : [];
  if (!ws.length || ws.length > DR_WAVES_MAX) throw fail('invalid', `단계는 1~${DR_WAVES_MAX}개입니다.`);
  const ids = new Set(); const names = new Set(); let total = 0;
  const out = ws.map((w, i) => {
    const conc = Number(w?.concurrency);
    if (!Number.isInteger(conc) || conc < 1 || conc > DR_CONC_MAX) throw fail('invalid', `${i + 1}단계 동시 복원 수는 1~${DR_CONC_MAX} 입니다.`);
    const items = (Array.isArray(w?.items) ? w.items : []).map((it) => {
      const id = clip(it?.id, 200); const jobid = Number(it?.jobid);
      if (!id || !Number.isInteger(jobid) || jobid <= 0) throw fail('invalid', `${i + 1}단계에 대상 · 복원 지점이 없는 항목이 있습니다.`);
      if (ids.has(id)) throw fail('invalid', '같은 VM 이 두 단계에 있습니다.');
      ids.add(id);
      const nv = it?.newVm && typeof it.newVm === 'object' ? it.newVm : {};
      const newVm = { name: clip(nv.name, 200).trim(), ...(nv.dc ? { dc: clip(nv.dc, 200) } : {}), ...(nv.cluster ? { cluster: clip(nv.cluster, 200) } : {}), ...(nv.datastore ? { datastore: clip(nv.datastore, 200) } : {}) };
      const ni = pluginValueIssue(newVm.name, '새 VM 이름');
      if (ni) throw fail('invalid', ni);
      const k = newVm.name.toLowerCase();
      if (names.has(k)) throw fail('invalid', `새 VM 이름 ‘${newVm.name}’ 이(가) 단계 사이에서 겹칩니다.`);
      names.add(k);
      return { id, jobid, newVm };
    });
    if (!items.length) throw fail('invalid', `${i + 1}단계에 VM 이 없습니다.`);
    total += items.length;
    return { name: clip(w?.name, 40).trim() || `${i + 1}단계`, concurrency: conc, verify: w?.verify === true, items };
  });
  if (total > DR_ITEMS_MAX) throw fail('invalid', `한 회차는 ${DR_ITEMS_MAX}대까지입니다.`);
  return out;
}
/** 보낼 묶음 항목(묶음 복원 라우트와 같은 모양 — 새 VM · 끊은 채). */
export const itemBody = (it) => ({ id: it.id, jobid: it.jobid, mode: 'newVm', nic: 'disconnect', newVm: it.newVm });

/** 회차 만들기 — 같은 vCenter 에 진행 중(running · paused) 회차가 있으면 거부. 판정 · OTP · 범위는 라우트가 먼저 본다. */
export function createRun({ vcenterId, directorId, by, before = '', waves }, now = Date.now()) {
  const db = load();
  if (_bad) throw fail('unavailable', _bad);
  if (db.runs.some((r) => r.vcenterId === vcenterId && ACTIVE.has(r.state))) throw fail('conflict', '이 법인에 진행 중인 복구 순서가 있습니다 — 멈춘 뒤 새로 시작하세요.');
  const run = {
    id: `dr-${now.toString(36)}-${crypto.randomBytes(3).toString('hex')}`, vcenterId: String(vcenterId), directorId: String(directorId || ''), by: clip(by, 64),
    before: /^[0-9T: -]{10,19}$/.test(String(before || '')) ? String(before) : '', at: now, updatedAt: now, state: 'running', reason: '', cur: 0,
    waves: normWaves(waves).map((w) => ({ ...w, acked: [], items: w.items.map((it) => ({ ...it, vmName: '', state: 'queued', rid: null, reason: '', batchId: '' })) })),
  };
  for (const w of run.waves) for (const it of w.items) it.vmName = clip(getJob(it.id)?.vmName, 80);
  const before0 = db.runs;
  db.runs = trimRuns([run, ...db.runs]);
  saveOrRollback(() => { db.runs = before0; });
  return JSON.parse(JSON.stringify(run));
}
/** 보관 — 진행 중 · 멈춤(running · paused)은 모두 남기고, 끝난 · 멈춘 회차만 최근 RUNS_KEEP 개(반증 F5 — 확인을 기다리는 회차가 새 회차에 밀려 사라졌다). */
export function trimRuns(runs) {
  let fin = 0;
  return (Array.isArray(runs) ? runs : []).filter((r) => ACTIVE.has(r?.state) || (fin += 1) <= RUNS_KEEP);
}
/** 진행 중 · 멈춤 회차에 든(대기 · 보내는 중 · 복원 중) 원장 id — 다른 경로(묶음 · 단건 복원)가 같은 VM 을 따로 보내지 않게(반증 F11). */
export function drRunHeldIds() {
  const s = new Set();
  for (const r of load().runs) {
    const active = ACTIVE.has(r.state);
    // 'sending' 은 회차 상태와 상관없이 — 보내는 중에 멈춘 회차의 그 VM 은 보냈을 수 있다(버그 점검 B1-03 · B3-02)
    for (const w of r.waves || []) for (const it of w.items || []) if (it.state === 'sending' || (active && (it.state === 'queued' || it.state === 'sent'))) s.add(it.id);
  }
  return s;
}
function findRun(id) { return load().runs.find((r) => r.id === id) || null; }
export function getRun(id) { const r = findRun(id); return r ? JSON.parse(JSON.stringify(r)) : null; }
/** 멈춤 — 보내지 않은 항목은 그대로 둔다(보낸 복원은 Director 에서 계속 돈다). */
export function stopRun(id, by, now = Date.now()) {
  const r = findRun(id);
  if (!r) throw fail('not-found', '그 회차를 찾을 수 없습니다.');
  if (!ACTIVE.has(r.state)) throw fail('conflict', '이미 끝났거나 멈춘 회차입니다.');
  const prev = { state: r.state, reason: r.reason, updatedAt: r.updatedAt };
  Object.assign(r, { state: 'stopped', reason: `${clip(by, 64)} 이(가) 멈춤 — 보내지 않은 VM 은 보내지 않습니다(보낸 복원은 계속 돕니다)`, updatedAt: now });
  saveOrRollback(() => Object.assign(r, prev));
  return getRun(id);
}
/** 계속 — 멈춤(paused)만. 그 단계의 실패 · 결과 모름을 확인했다고 보고 다음으로 넘긴다(결과 모름 VM 은 다시 보내지 않는다). */
export function resumeRun(id, by, now = Date.now()) {
  const r = findRun(id);
  if (!r) throw fail('not-found', '그 회차를 찾을 수 없습니다.');
  if (r.state !== 'paused') throw fail('conflict', '멈춤 상태인 회차만 계속할 수 있습니다.');
  // 지금 보이는 실패 · 결과 모름만 확인 처리 — 계속한 뒤 새로 생긴 실패는 그 단계 끝에서 다시 멈춘다(반증 F1)
  const w = r.waves[r.cur];
  const prev = { state: r.state, reason: r.reason, updatedAt: r.updatedAt, acked: w ? w.acked : undefined };
  if (w) w.acked = [...new Set([...(Array.isArray(w.acked) ? w.acked : []), ...w.items.filter((it) => it.state === 'failed' || it.state === 'unknown').map((it) => it.id)])];
  Object.assign(r, { state: 'running', reason: `${clip(by, 64)} 이(가) 확인하고 계속`, updatedAt: now });
  saveOrRollback(() => { Object.assign(r, { state: prev.state, reason: prev.reason, updatedAt: prev.updatedAt }); if (w) w.acked = prev.acked; });
  return getRun(id);
}

const FINAL_ITEM = new Set(['ok', 'failed', 'unknown', 'skipped']);
/** 보낸 항목의 원장 상태 → 항목 상태(순수). 끝맺음(NIC 끊기 · 켜 보기)까지 끝나야 끝. */
export function sentItemState(it, job, wave, now = Date.now()) {
  if (!job) return { state: 'failed', reason: '원장에서 대상이 사라졌습니다(복원은 시작됐을 수 있습니다 — vCenter 에서 확인)' };
  const r = (job.restores || []).find((x) => x.jobid === it.rid);
  if (!r) {
    // 원장 이력이 다시 묶기(runsEpoch)로 비었거나 보관 상한으로 밀려났다 — 끝을 알 길이 없다(반증 F9 — 영원히 '복원 중' 이었다)
    const sentAt = Number(it.sentAt) || 0;
    if ((sentAt && (Number(job.runsEpoch) || 0) > sentAt) || (sentAt && now - sentAt > SENT_LOST_MS)) return { state: 'unknown', reason: '원장에서 이 복원 기록이 사라졌습니다(다시 묶기 · 보관 상한) — Director · vCenter 에서 확인하세요' };
    return { state: 'sent' };
  }
  if (restoreOpen(r) || restoreFinishing(r, now)) return { state: 'sent' };
  if (r.abandoned) return { state: 'failed', reason: '복원 추적을 놓쳤습니다 — Director · vCenter 에서 확인하세요' };
  if (!(r.state === 'ok' || r.state === 'warning')) return { state: 'failed', reason: `복원이 성공으로 끝나지 않았습니다(${r.status || r.state || '—'})` };
  if (r.finish?.nic === 'failed') return { state: 'failed', reason: `네트워크 끊기 실패 — ${clip(r.finish.detail, 160)}` };
  // 끝맺음 시한(restoreFinishing 24시간)이 지나도록 결과가 없으면 성공으로 보지 않는다(버그 점검 B1-06 · B3-05 — 끊기를 확인하지 못했는데 'ok' 로 다음 단계가 나갔다)
  if (r.nic === 'disconnect' && r.finish?.nic !== 'ok') return { state: 'unknown', reason: '네트워크 끊기 결과를 받지 못했습니다(끝맺음 시한 지남) — vCenter 에서 NIC 연결 상태를 확인하세요' };
  if (wave?.verify && r.finish?.verify === 'failed') return { state: 'failed', reason: `켜 보기 실패 — ${clip(r.finish?.detail, 160) || '사유 미상'}` };
  if (wave?.verify && r.finish?.verify !== 'ok') return { state: 'unknown', reason: '켜 보기 결과를 받지 못했습니다(끝맺음 시한 지남) — vCenter 에서 확인하세요' };
  return { state: 'ok', reason: '' };
}

/**
 * 'sending'(보내기 전에 남긴 표지)이 걸음 밖에 남아 있으면 — 재시작 · 끊김 — 보냈을 수 있다 · 다시 보내지 않는다. 원장에 그 묶음 기록이 있으면 그것으로 잇고(보냄),
 *   없으면 결과 모름 기록을 원장에 남긴다(반증 F4 — 다른 경로의 복원 · 이름 예약이 그 VM 을 6시간 붙잡게). 회차 상태와 상관없이 돈다
 *   (버그 점검 B1-03 · B3-02 — 보내는 중에 멈춘 회차의 'sending' 은 영원히 남고 붙잡기도 없어 같은 VM 을 다시 보낼 수 있었다). 잃은 대수를 돌려준다.
 */
function recoverSending(run, now) {
  let lost = 0; let found = 0;
  inBatch(() => {
    for (const wave of run.waves) for (const it of wave.items) {
      if (it.state !== 'sending') continue;
      const job = getJob(it.id);
      const r = (job?.restores || []).find((x) => x.drRun === run.id && x.batchId && x.batchId === it.batchId);
      if (r?.jobid) { Object.assign(it, { state: 'sent', rid: r.jobid, sentAt: Number(r.at) || now, reason: '' }); found += 1; continue; }
      lost += 1;
      Object.assign(it, { state: 'unknown', reason: '보내던 중 재시작 · 끊김 — 시작됐는지 Director 에서 확인하세요' });
      if (job && !r) addRestore(it.id, { mode: 'newVm', target: { ...it.newVm }, by: run.by, client: job.client, batchId: it.batchId, nic: 'disconnect', dr: true, drRun: run.id, unknown: true, ...(wave.verify ? { verify: true, deleteOnOk: false } : {}) });
      logAudit({ user: run.by, action: 'Bareos 재해 복구', target: `${run.vcenterId}/${it.vmName || it.id}`, detail: `복구 순서 ${run.id} · ${wave.name} · 결과 모름(보내던 중 재시작 · 끊김) — 다시 보내지 않음` });
    }
  });
  if (lost || found) run.updatedAt = now;
  return { lost, found };
}

/** 한 회차 한 걸음(틱마다) — 갱신 → 단계 끝 판정 → 빈 자리만큼 보내기. */
async function step(run, now) {
  if (run.state !== 'running') return;   // 반증 F2: 틱이 다른 회차를 기다리는 동안 멈춘 회차는 걷지 않는다
  // 회차마다 동기 구간을 따로 — 여러 법인이 함께 돌 때 한 덩어리로 이어 붙지 않게(버그 점검 B3-01)
  await new Promise((r) => setImmediate(r));
  if (run.state !== 'running') return;
  const wave = run.waves[run.cur];
  if (!wave) { Object.assign(run, { state: 'done', updatedAt: now }); save(); return; }
  // 원장을 못 읽으면 갱신도 보내기도 하지 않는다(반증 F8 — 보낸 항목이 '원장에서 사라짐' 실패로 굳었다)
  if (registryLoadError()) { Object.assign(run, { state: 'paused', reason: '백업 대상 원장을 읽지 못해 멈췄습니다(손상본 보존 · 서비스 점검에서 확인)', updatedAt: now }); save(); return; }
  if (run.waves.some((w) => w.items.some((it) => it.state === 'sending'))) {
    const { lost } = recoverSending(run, now);
    if (lost) Object.assign(run, { state: 'paused', reason: `보내던 ${lost}대의 결과를 모릅니다(재시작 · 끊김) — Director 에서 확인한 뒤 계속을 누르세요(그 VM 은 다시 보내지 않습니다)`, updatedAt: now });
    save(); return;
  }
  let changed = false;
  for (const it of wave.items) {
    if (it.state !== 'sent') continue;
    const s = sentItemState(it, getJob(it.id), wave, now);
    if (s.state !== 'sent') { Object.assign(it, s); changed = true; }
  }
  // 단계 끝?
  if (wave.items.every((it) => FINAL_ITEM.has(it.state))) {
    const acked = new Set(Array.isArray(wave.acked) ? wave.acked : []);
    const bad = wave.items.filter((it) => (it.state === 'failed' || it.state === 'unknown') && !acked.has(it.id)).length;
    if (bad) {
      Object.assign(run, { state: 'paused', reason: `${wave.name}: ${bad}대 실패 · 결과 모름 — 확인한 뒤 계속을 누르면 다음 단계로 넘어갑니다`, updatedAt: now });
      save(); return;
    }
    run.cur += 1;
    if (run.cur >= run.waves.length) Object.assign(run, { state: 'done', reason: '' });
    run.updatedAt = now; save();
    logAudit({ user: run.by, action: 'Bareos 재해 복구', target: run.vcenterId, detail: `복구 순서 ${run.id} · ${wave.name} 끝(성공 ${wave.items.filter((x) => x.state === 'ok').length} / ${wave.items.length}대)${run.state === 'done' ? ' · 회차 끝' : ''}` });
    return;
  }
  const inflight = wave.items.filter((it) => it.state === 'sent').length;
  const free = wave.concurrency - inflight;
  const queued = wave.items.filter((it) => it.state === 'queued');
  if (free <= 0 || !queued.length) { if (changed) { run.updatedAt = now; save(); } return; }
  const settings = effectiveSettings();
  const snapshot = store.get();
  // 첫 수집 전 골격 · 그 vCenter 수집 대기 — 점검 ✕ 로 멈추지 않고 이번 틱만 넘긴다(버그 점검 B1-04 — 재시작 · 자동 업그레이드마다 회차가 멈춰 OTP 로 계속해야 했다)
  const vcNow = (snapshot?.vcenters || []).find((v) => String(v.id) === String(run.vcenterId));
  if (snapshot?.initial || vcNow?.status === 'pending') { if (changed) { run.updatedAt = now; save(); } return; }
  const vcJobs = listJobsOf(run.vcenterId);   // 판정 · 이름 예약은 vCenter 로 나뉜다(B3-01)
  // 점검 ✕ 는 보내지 않고 멈춘다(시험 1대 규칙은 시작 때 — 회차는 여러 대라 count 1 로 본다)
  const block = drGateBlock({ items: [{ vcenterId: run.vcenterId }], jobs: vcJobs, settings, snapshot, pollDirs: _pollDirs() || {}, regHosts: registryHosts(), lastOkOf: () => null, directorOf: (id) => directorById(id, settings), now });
  if (block) { Object.assign(run, { state: 'paused', reason: block, updatedAt: now }); save(); return; }
  // Director 접속값 · 인증 정지 — 보내지 않고 멈춘다(버그 점검 B2-03 · B2-04: 덜 된 설정으로 실패하거나, 틀린 줄 아는 비밀번호로 다시 로그인했다 — 자동 재시도 금지)
  const dirNow = run.directorId ? directorById(run.directorId, settings) : null;
  if (!isDemoActive(settings) && dirNow) {
    const miss = directorConn(dirNow).missing;
    if (miss?.length) { Object.assign(run, { state: 'paused', reason: `‘${dirNow.name}’ Director 설정이 덜 됐습니다(${miss.join('·')}) — 설정에서 채운 뒤 계속을 누르세요`, updatedAt: now }); save(); return; }
    const stop = bareosAuthGuard.authStopFor(directorCred(dirNow));
    if (stop) { Object.assign(run, { state: 'paused', reason: `‘${dirNow.name}’ Director 인증 실패로 멈춘 상태입니다(${clip(stop.reason, 120)}) — 접속값을 고치고 연결 시험이 성공한 뒤 계속을 누르세요`, updatedAt: now }); save(); return; }
  }
  const pick = queued.slice(0, Math.min(free, BULK_RESTORE_MAX));
  const locked = [];
  const jobs = new Map();
  let blocked = 0;   // 이번 걸음에서 보내기 전에 막힌 대수 — 단계 끝까지 기다리지 않고 바로 멈춘다(버그 점검 B1-02 ②)
  for (const it of pick) {
    const job = getJob(it.id);
    if (!job) { Object.assign(it, { state: 'failed', reason: '원장에서 대상이 사라졌습니다(보내지 않았습니다)' }); changed = true; blocked += 1; continue; }
    if ((job.restores || []).some((r) => restoreUnknownHeld(r, now))) { Object.assign(it, { state: 'failed', reason: '이 VM 의 직전 복원 결과를 모릅니다 — 두 번 돌지 않게 보내지 않았습니다' }); changed = true; blocked += 1; continue; }
    if ((job.restores || []).some((r) => restoreHeld(r, now))) continue;   // 다른 복원이 진행 중 — 다음 틱에
    if (!tryLockJob(job.id)) continue;   // 다른 요청(실행 · 삭제 · 묶음)이 쓰는 중 — 다음 틱에
    locked.push(job.id); jobs.set(job.id, job);
  }
  const pauseBlocked = () => {
    if (blocked && run.state === 'running') Object.assign(run, { state: 'paused', reason: `${wave.name}: ${blocked}대를 보내기 전에 막았습니다(사유는 항목에) — 확인한 뒤 계속하면 그 VM 은 건너뛰고 이어 갑니다`, updatedAt: now });
  };
  try {
    const cand = pick.filter((it) => jobs.has(it.id));
    if (!cand.length) { pauseBlocked(); if (changed) { run.updatedAt = now; save(); } return; }
    const reservedNames = reservedRestoreNames(vcJobs, { now, snapAt: inventoryAtOf(snapshot), isOpen: restoreOpen });
    const baseOf = (job) => { const site = settings.sites.find((x) => String(x.vcenterId) === String(job.vcenterId)); return { vcserver: site?.vcserver || '', configFile: site?.configFile || '' }; };
    const plan = bulkRestorePlan({ items: cand.map(itemBody), jobOf: (id) => jobs.get(id) || null, dirOf: (j) => jobDirectorId(j, settings), snapshot, pluginName: settings.defaults.pluginName, reservedNames, baseOf });
    const ready = [];
    cand.forEach((it, i) => {
      const p = plan.items[i];
      const why = !p?.ok ? (p?.issue || '판정에서 막혔습니다') : drItemIssue(p);
      if (why) { Object.assign(it, { state: 'failed', reason: clip(`${why}(보내지 않았습니다)`, 300) }); changed = true; blocked += 1; } else ready.push({ it, p });
    });
    if (!ready.length) { pauseBlocked(); run.updatedAt = now; save(); return; }
    const dirId = plan.directorId || run.directorId;
    const batchId = `${run.id}-${now.toString(36)}`;
    const sendItems = ready.map(({ it, p }, i) => {
      const job = jobs.get(it.id);
      const site = settings.sites.find((s) => s.vcenterId === job.vcenterId);
      return { key: i, jobid: p.jobid, name: job.bareosJob, client: site?.client || job.client, restoreJob: settings.defaults.restoreJob, pluginOptions: p.plan.pluginOptions };
    });
    // 보내기 **전에** 남긴다 — 이 저장이 실패하면 보내지 않는다(재시작 뒤 같은 VM 을 다시 보내지 않게)
    for (const { it } of ready) Object.assign(it, { state: 'sending', batchId });
    run.updatedAt = now;
    try { save(); } catch (e) {
      for (const { it } of ready) Object.assign(it, { state: 'queued', batchId: '' });
      console.warn(`[bareos] 재해 복구 ${run.id} 상태 저장 실패: ${clip(e?.message || e, 300)}`);
      Object.assign(run, { state: 'paused', reason: '실행 상태를 저장하지 못해 보내지 않았습니다(디스크 · 권한 — 서버 로그 확인)' });
      return;
    }
    noteRestoreBatchStart(batchId, `재해 복구 ${wave.name} ${ready.length}대`);
    let out = null; let err = null;
    try { out = await onDirector(dirId, 'restores', { items: sendItems }, { trigger: 'dr', signal: AbortSignal.timeout(RESTORES_DEADLINE_MS) }); } catch (e) { err = e; } finally { noteRestoreBatchEnd(batchId); }
    const rec = (it, p, extra) => addRestore(it.id, { mode: 'newVm', target: p.plan.target, by: run.by, client: sendItems[ready.findIndex((x) => x.it === it)].client, batchId, nic: 'disconnect', dr: true, drRun: run.id, ...(wave.verify ? { verify: true, deleteOnOk: false } : {}), ...extra });
    // VM 마다 감사(묶음 복원 라우트와 같은 결 — 버그 점검 B1-05 · B2-02: 결과 모름 · 보내기 오류가 감사에 남지 않았다)
    const auditVm = (it, what) => logAudit({ user: run.by, action: 'Bareos 재해 복구', target: `${run.vcenterId}/${it.vmName || it.id}`, detail: clip(`복구 순서 ${run.id} · ${wave.name} · 묶음 ${batchId} · ${what}`, 600) });
    if (err) {
      const unknown = !!err?.unknown || err?.code === 'unknown';
      inBatch(() => {
        for (const { it, p } of ready) {
          if (unknown) { Object.assign(it, { state: 'unknown', reason: `결과 모름 — ${clip(err?.message || err, 160)}` }); rec(it, p, { unknown: true }); auditVm(it, `결과 모름 — ${clip(err?.message || err, 160)}`); }
          else Object.assign(it, { state: 'queued', batchId: '' });   // 보내지 못했다(연결 · 설정) — 사람이 확인하도록 멈춘다
        }
      });
      logAudit({ user: run.by, action: 'Bareos 재해 복구', target: run.vcenterId, detail: clip(`복구 순서 ${run.id} · ${wave.name} · 묶음 ${batchId} · ${unknown ? `결과 모름 ${ready.length}대` : `보내지 못함 ${ready.length}대(대기로 돌림)`} — ${err?.message || err}`, 600) });
      // 반증 F3: 보내는 동안 사람이 멈췄으면(stopped) 그대로 둔다 — 'paused' 로 덮으면 다시 계속할 수 있게 된다
      if (run.state === 'running') Object.assign(run, { state: 'paused', reason: unknown ? `보낸 ${ready.length}대의 결과를 모릅니다 — Director 에서 확인한 뒤 계속을 누르세요` : `보내지 못했습니다 — ${clip(err?.message || err, 200)}`, updatedAt: now });
      else run.updatedAt = now;
    } else {
      const byKey = new Map((Array.isArray(out) ? out : []).map((x) => [x.key, x]));
      let started = 0; let unknownN = 0; let notSent = 0; let failedN = 0;
      inBatch(() => {
        ready.forEach(({ it, p }, i) => {
          const x = byKey.get(i);
          if (x?.ok) {
            const saved = rec(it, p, { jobid: x.rid, fromJobids: x.chain });
            if (saved) { Object.assign(it, { state: 'sent', rid: x.rid, sentAt: now, reason: '' }); started += 1; auditVm(it, `시작(jobid ${x.rid} · 새 VM ${p.plan.target?.name || '—'})`); }
            else { Object.assign(it, { state: 'failed', rid: x.rid, reason: `복원(jobid ${x.rid})은 시작했지만 원장에서 대상이 사라졌습니다 — vCenter 에서 확인` }); failedN += 1; auditVm(it, `시작(jobid ${x.rid}) — 원장에서 대상이 사라짐`); }
          } else if (!x || x.code === 'unknown') {
            Object.assign(it, { state: 'unknown', reason: clip(x?.message || 'Director 회신에 없음 — 결과 모름', 200) });
            rec(it, p, { unknown: true }); unknownN += 1; auditVm(it, `결과 모름 — ${clip(x?.message || 'Director 회신에 없음', 160)}`);
          } else if (x.code === 'skipped' || SESSION_DEAD.has(x.code)) {
            // 보내기 전에 세션이 끊겼다(ops.restores 는 restore 명령을 보낸 뒤 끊긴 것만 'unknown') — 대기로 돌리고 멈춘다(버그 점검 B1-02 ①: 영구 실패로 굳었다)
            Object.assign(it, { state: 'queued', batchId: '', reason: clip(x.message || x.code, 200) }); notSent += 1;
          } else { Object.assign(it, { state: 'failed', reason: clip(x.message || x.code, 200) }); failedN += 1; auditVm(it, `실패 — ${clip(x.message || x.code, 160)}`); }
        });
      });
      logAudit({ user: run.by, action: 'Bareos 재해 복구', target: `${run.vcenterId}/${ready[0].it.vmName || ready[0].it.id}${ready.length > 1 ? ` 외 ${ready.length - 1}대` : ''}`, detail: `복구 순서 ${run.id} · ${wave.name} · 묶음 ${batchId} · 시작 ${started} / ${ready.length}대${unknownN ? ` · 결과 모름 ${unknownN}` : ''}${failedN ? ` · 실패 ${failedN}` : ''}${notSent ? ` · 보내지 못함 ${notSent}(대기로 돌림)` : ''}${run.before ? ` · 기준 시각 ${run.before.replace('T', ' ')}(브라우저 시각)` : ''}` });
      if (notSent && run.state === 'running') Object.assign(run, { state: 'paused', reason: `Director 연결 문제로 ${notSent}대를 보내지 못했습니다(대기로 돌림) — 연결을 확인한 뒤 계속하면 다시 보냅니다`, updatedAt: now });
      run.updatedAt = now;
    }
    pauseBlocked();
    save();
  } finally { for (const id of locked) unlockJob(id); }
}

/**
 * 틱 — 진행 중(running) 회차마다 한 걸음씩 **따로**(회차마다 재진입 가드 — 느린 법인 하나가 다른 법인 회차를 막지 않는다 · 반증 F7).
 *   엣지 제외 · 상태 파일 손상이면 멈춤. 돌아오는 값: 걸음을 하나라도 띄웠으면(또는 걸을 회차가 없으면) true,
 *   걸을 회차가 모두 이미 걷는 중이면 null(앞 걸음이 끝나길 기다리는 쪽 — 시험 · 라우트가 다시 부른다).
 */
export async function drTick(now = Date.now()) {
  const db = load();
  if (_bad) return null;
  // 멈춘 · 끝난 회차에 남은 'sending'(보내는 중에 멈춘 뒤 재시작) — 걷지 않는 회차도 결과 모름 기록까지는 한다(B1-03 · B3-02)
  let fixed = false;
  for (const r of db.runs) {
    if (r.state === 'running' || _stepping.has(r.id) || !r.waves.some((w) => w.items.some((it) => it.state === 'sending'))) continue;
    try { recoverSending(r, now); fixed = true; } catch (e) { console.warn(`[bareos] 재해 복구 ${r.id} 보내던 표지 정리 실패: ${clip(e?.message || e, 200)}`); }
  }
  if (fixed) { try { save(); } catch (e) { console.warn(`[bareos] 재해 복구 상태 저장 실패: ${clip(e?.message || e, 200)}`); } }
  const runs = db.runs.filter((r) => r.state === 'running');
  const todo = runs.filter((r) => !_stepping.has(r.id));
  if (runs.length && !todo.length) return null;
  await Promise.all(todo.map(async (run) => {
    _stepping.add(run.id);
    try { await step(run, now); } catch (e) {
      console.warn(`[bareos] 재해 복구 ${run.id} 한 걸음 실패: ${clip(e?.message || e, 200)}`);
      // 반증 F3: 사람이 그사이 멈췄으면(stopped) 덮지 않는다
      try { if (run.state === 'running') Object.assign(run, { state: 'paused', reason: `실행기 오류 — ${clip(e?.message || e, 160)}`, updatedAt: now }); save(); } catch { /* 다음 틱 */ }
    } finally { _stepping.delete(run.id); }
  }));
  return true;
}

/** 화면용 — 범위(allowed: vCenter id Set · null = 전체) 안 회차. 항목은 이름 · 상태 · 사유 · jobid 만. */
export function drRunsView(allowed = null) {
  const db = load();
  const runs = db.runs.filter((r) => !allowed || allowed.has(r.vcenterId)).map((r) => ({
    id: r.id, vcenterId: r.vcenterId, directorId: r.directorId, by: r.by, at: r.at, updatedAt: r.updatedAt, before: r.before, state: r.state, reason: r.reason, cur: r.cur,
    waves: r.waves.map((w) => {
      const counts = {};
      for (const it of w.items) counts[it.state] = (counts[it.state] || 0) + 1;
      return { name: w.name, concurrency: w.concurrency, verify: w.verify, total: w.items.length, counts, items: w.items.map((it) => ({ id: it.id, vmName: it.vmName || it.newVm?.name || it.id, name: it.newVm?.name || '', state: it.state, reason: it.reason || '', rid: it.rid ?? null })) };
    }),
  }));
  return { runs, loadError: _bad || '' };
}

export function startDrRunner() {
  if (_timer || isEdgeNode()) return;
  _timer = setInterval(() => { drTick().catch((e) => console.warn(`[bareos] 재해 복구 틱 실패: ${e?.message || e}`)); }, DR_TICK_MS);
  _timer.unref?.();
}

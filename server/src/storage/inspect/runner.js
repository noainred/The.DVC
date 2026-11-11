/**
 * storage/inspect/runner.js — PowerScale 주간 점검 **실행기**(v2.964 · 설계 README §4).
 *
 * 무엇: 장비 하나에 **읽기 전용** 명령 · REST 조회를 한 묶음으로 보내 facts(facts.js)를 만들고 이력(store.js)에 적는다. 판정은 화면을 그릴 때 judge.js 가 한다.
 *  · 어디서: 그 장비를 수집하는 포탈(중앙 직접 장비는 중앙 · 위임 장비는 그 법인 엣지 — CLAUDE.md '백업은 법인 로컬' 과 같은 원칙: 명령 수만큼 WAN 왕복 금지).
 *    엣지는 결과를 storage push 본문(`inspectRuns`)에 실어 보낸다 — 중앙이 200 을 주면 고리에서 지운다(노드 부하 표본과 같은 구조).
 *  · 언제: 중앙의 주간 회차(schedule.js) — 중앙 직접 장비는 여기서 돌리고 위임 장비는 요청 큐(requests.js)에 넣어 엣지가 다음 설정 pull 때 받아 돌린다.
 *    '지금 점검'(화면) 도 같은 길이다. 엣지는 스스로 회차를 돌리지 않는다(두 번 돌지 않게).
 *  · 규약: 재진입 가드 · 동시 2 · 장비당 시한(세션을 실제로 끊는다) · SSH 세션 예산 < 장비 시한(SSH_BUDGET_MS — 테스트가 산수를 고정) ·
 *    명령마다 시한 · 명령은 상수(사용자 입력을 넣지 않는다) · 인증 실패는 수집 주기와 같은 정지 레코드(authGuard — 자동 재시도 없음) ·
 *    수집 주기 · 표본과 장비 점유를 나눈다(runSampleExclusive — 수집 중이면 이번 점검은 건너뛰고 사유를 남긴다).
 *  · 기존 수집 스냅샷에서 가져오는 값(Cluster Health · Critical Events · 노드 상태 · 용량 · 풀 · VHS · 잡)은 다시 읽지 않는다.
 *
 * ⚠ 실장비 미확인(facts.js 머리말) — 명령이 거부 · 미지원이면 그 항목은 확인 불가(사유)로 남는다. 설정을 바꾸는 명령은 없다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';
import { atomicWriteFileSync, preserveCorrupt, safeLoadText } from '../../util/atomicWrite.js';
import { registerExitFlush } from '../../util/exitFlush.js';
import { registerStateFile } from '../../util/stateFiles.js';
import { withDeadline } from '../../util/deadline.js';
import { withSsh, isSshAuthError } from '../../proxy/sshExec.js';
import { poolRun } from '../../util/pool.js';
import { pushAll } from '../../util/pushAll.js';
import { reqTimeoutMs } from '../../agent/envTimeout.js';
import { devicesForThisNode, getDeviceWithSecret, registryLoadError, listDevices } from '../registry.js';
import { authStopFor, markAuthStopped, clearAuthStop } from '../authGuard.js';
import { runSampleExclusive, IN_FLIGHT_BUSY, useDemoSynth } from '../poller.js';
import { localSnapshots } from '../store.js';
import { getAny as isiGetAny } from '../collectors/isilon.js';
import { isCredReject } from '../collectors/restCommon.js';
import { isMockMode, isDemoId } from '../../mock/demo/storage.js';
import { factsFromSnapshot, parseGroup, parseBootMirror, parsePsuText, parseDrives, parseDrivesText, parseBatteries, parseRestPsu, parseIfaces,
  parseHealthcheck, parseNtp, parseVhsSettings, parseSnapshots, parseSyncPolicies, parseSyncReports, parseEventGroups, parseJobs } from './facts.js';
import { recordRun, pruneRuns } from './store.js';
import { demoInspectFacts, fillDemoRatios } from './demo.js';

/** 장비당 점검 시한 — 명령 열몇 개 · 기본 3분(30초 ~ 15분). 수집 주기 시한과 같은 env 관문. */
export const INSPECT_TIMEOUT_MS = reqTimeoutMs(process.env.STORAGE_INSPECT_TIMEOUT_MS, 180_000, { min: 30_000, max: 900_000 });
/** SSH 세션 예산 — 장비 시한보다 20초 짧게(남은 예산이 명령 시한보다 적으면 뒤 명령을 건너뛰고 '시간 부족' 으로 적는다). */
export const SSH_BUDGET_MS = Math.max(20_000, INSPECT_TIMEOUT_MS - 20_000);
export const CMD_TIMEOUT_MS = 15_000;
export const RING_MAX = 2; // 엣지 미전송 실행(장비당) — 주간이라 2회면 충분
const capErr = (e) => String(e?.message || e || '').slice(0, 160);
const isEdge = () => !!(config.agent.centralUrl && config.agent.centralToken);

/**
 * SSH 명령(순서가 계약 — 예산이 모자라면 뒤부터 잃는다: 드라이브 · 이벤트 · 그룹 · 배터리 · 전원 · 포트 · HealthCheck · NTP · SyncIQ · 스냅샷 · 부트 미러).
 * 전부 조회 명령이다. `--format json` 은 CLI 참조 [9] 의 공통 옵션으로 보고 붙였다(판마다 다를 수 있다 — 실패하면 그 항목은 확인 불가).
 */
export const SSH_CMDS = Object.freeze([
  { key: 'drives', cmd: 'isi devices drive list --node-lnn all --format json', fallback: 'isi devices drive list --node-lnn all' },
  { key: 'events', cmd: 'isi event groups list --resolved=false --format json' },
  { key: 'group', cmd: 'sysctl efs.gmp.group' },
  { key: 'battery', cmd: 'isi batterystatus list --format json' },
  { key: 'psu', cmd: "isi_for_array -s \"isi_hw_status | grep -i -A3 'Power Supplies'\"" },
  { key: 'ifaces', cmd: 'isi network interfaces list --format json' },
  { key: 'healthcheck', cmd: 'isi healthcheck evaluations list --format json' },
  { key: 'ntp', cmd: 'isi ntp servers list --format json' },
  { key: 'syncPolicies', cmd: 'isi sync policies list --format json' },
  { key: 'syncReports', cmd: 'isi sync reports list --format json' },
  { key: 'snapshots', cmd: 'isi snapshot snapshots list --format json' },
  { key: 'bootMirror', cmd: "isi_for_array -s 'gmirror status'" },
]);
/** REST 경로(앞의 것부터 시도 — 판마다 버전 번호가 다르다). ⚠ 실장비 미확인. */
export const REST_PATHS = Object.freeze({
  events: ['/platform/3/event/eventgroup-occurrences?resolved=false&limit=500'],
  nodes: ['/platform/3/cluster/nodes'],
  ifaces: ['/platform/7/network/interfaces', '/platform/4/network/interfaces', '/platform/3/network/interfaces'],
  healthcheck: ['/platform/3/healthcheck/evaluations'],
  ntp: ['/platform/3/protocols/ntp/servers', '/platform/1/protocols/ntp/servers'],
  vhs: ['/platform/1/storagepool/settings'],
  snapshots: ['/platform/1/snapshot/snapshots?limit=1000'],
  syncPolicies: ['/platform/1/sync/policies'],
  syncReports: ['/platform/1/sync/reports?limit=1000'],
  jobs: ['/platform/1/job/jobs'],
});
const SSH_ONLY_WHY = 'REST 로 읽는 경로가 없습니다 — SSH 로 수집하는 장비만 읽습니다(장비 편집 › 수집 방식)';
const PERM_RE = /permission denied|privilege|not authorized|insufficient|requires root|not permitted/i;
const UNSUP_RE = /unknown (command|option|argument)|unrecognized|invalid (option|argument)|usage:|not found|no such/i;
/** 명령 실패 사유(짧게 · 원문 일부는 관리자 화면만 보도록 160자). */
export function cmdWhy(stdout, stderr, err) {
  const s = `${stderr || ''} ${err ? capErr(err) : ''}`.slice(0, 400);
  if (PERM_RE.test(s)) return `권한 없음 — 수집 계정에 이 명령 권한이 없습니다(${s.trim().slice(0, 80)})`;
  if (UNSUP_RE.test(s)) return `이 OneFS 판에서 명령 · 옵션이 다릅니다(${s.trim().slice(0, 80)})`;
  if (err) return `실행 실패: ${capErr(err)}`;
  if (!String(stdout || '').trim()) return '출력이 비었습니다';
  return '출력 형식 미인식(실장비 출력 미확인 — 원본 확인 필요)';
}

/** 그 장비의 최신 로컬 스냅샷(이 포탈이 수집한 것). */
function snapOf(id) { return localSnapshots().find((s) => s?.deviceId === id) || null; }

/** facts 를 합친다 — 앞(스냅샷)의 값이 있으면 뒤(명령)가 덮는다. why 는 값이 생기면 지운다. */
function merge(base, key, value, why, whyText) {
  if (value != null) { base.facts[key] = value; delete base.why[key]; }
  else if (base.facts[key] == null && whyText) base.why[key] = whyText;
  return base;
}

// ── SSH ──────────────────────────────────────────────────────────────────────
async function collectSsh(full, signal, base, errors, now) {
  const out = {};
  const t0 = Date.now();
  await withSsh({ host: full.host, port: Number(full.sshPort) || 22, username: full.username, password: full.password || '', signal }, async (sh) => {
    for (const c of SSH_CMDS) {
      const left = SSH_BUDGET_MS - (Date.now() - t0);
      if (left < 3_000) { out[c.key] = { skipped: true }; continue; }
      const ms = Math.min(CMD_TIMEOUT_MS, left - 1_000);
      try {
        const r = await sh.exec(c.cmd, ms);
        out[c.key] = { stdout: r?.stdout || '', stderr: r?.stderr || '' };
        if (c.fallback && !parseDrives(out[c.key].stdout) && Date.now() - t0 < SSH_BUDGET_MS - CMD_TIMEOUT_MS) {
          const r2 = await sh.exec(c.fallback, Math.min(CMD_TIMEOUT_MS, SSH_BUDGET_MS - (Date.now() - t0) - 1_000));
          out[c.key] = { stdout: r2?.stdout || '', stderr: r2?.stderr || '', text: true };
        }
      } catch (e) {
        if (isSshAuthError(e)) throw e;
        out[c.key] = { error: e };
      }
    }
  });
  const take = (key, parse, factKey = key) => {
    const o = out[key];
    if (!o) return;
    if (o.skipped) { merge(base, factKey, null, null, `시간 부족 — 세션 예산(${Math.round(SSH_BUDGET_MS / 1000)}초) 안에 이 명령까지 가지 못했습니다`); errors.push({ step: key, error: '세션 예산 초과로 건너뜀' }); return; }
    const v = o.error ? null : parse(o.stdout);
    const why = v == null ? cmdWhy(o.stdout, o.stderr, o.error) : null;
    if (why) errors.push({ step: key, error: why });
    merge(base, factKey, v, null, why);
  };
  take('drives', (s) => (out.drives?.text ? parseDrivesText(s) : parseDrives(s)));
  take('events', parseEventGroups);
  take('group', (s) => parseGroup(s, base.facts.nodeCount));
  take('battery', parseBatteries);
  take('psu', parsePsuText);
  take('ifaces', parseIfaces);
  take('healthcheck', parseHealthcheck);
  take('ntp', parseNtp);
  take('snapshots', parseSnapshots);
  take('bootMirror', parseBootMirror);
  // SyncIQ = 정책 수 + 7일 보고서
  const pol = out.syncPolicies && !out.syncPolicies.error && !out.syncPolicies.skipped ? parseSyncPolicies(out.syncPolicies.stdout) : null;
  const rep = out.syncReports && !out.syncReports.error && !out.syncReports.skipped ? parseSyncReports(out.syncReports.stdout, { now }) : null;
  if (pol && (pol.policies === 0 || rep)) merge(base, 'synciq', { policies: pol.policies, ...(rep || { reports: 0, failed: 0, failedPolicies: [] }) });
  else {
    const o = out.syncPolicies?.error || !pol ? out.syncPolicies : out.syncReports;
    const why = o?.skipped ? '시간 부족 — 세션 예산 안에 가지 못했습니다' : cmdWhy(o?.stdout, o?.stderr, o?.error);
    errors.push({ step: 'synciq', error: why });
    merge(base, 'synciq', null, null, why);
  }
}

// ── REST ─────────────────────────────────────────────────────────────────────
async function collectRest(full, signal, base, errors, now) {
  const dev = { ...full, _signal: signal };
  // 반증 F10: 장비 시한이 끊었으면(signal.aborted) 남은 경로를 '조회 실패' 로 적고 넘어가지 않는다 — 던져서 실행이 partial(일부만)로 남게 한다.
  const soft = async (paths) => {
    if (signal?.aborted) throw new Error(`점검 시한(${Math.round(INSPECT_TIMEOUT_MS / 1000)}초) 초과 — 남은 경로를 읽지 않았습니다`);
    try { return { ok: true, v: await isiGetAny(dev, paths) }; } catch (e) {
      if (isCredReject(e)) throw e;
      if (signal?.aborted) throw new Error(`점검 시한(${Math.round(INSPECT_TIMEOUT_MS / 1000)}초) 초과 — 이 경로와 남은 경로를 읽지 못했습니다`);
      return { ok: false, err: e };
    }
  };
  const why404 = (r) => (/\b404\b|not found/i.test(capErr(r.err)) ? '이 OneFS 판에 REST 경로가 없습니다' : `조회 실패: ${capErr(r.err)}`);
  const take = (key, r, parse) => {
    const v = r.ok ? parse(r.v) : null;
    const why = r.ok ? (v == null ? '응답 형식 미인식(실장비 응답 미확인 — 원본 확인 필요)' : null) : why404(r);
    if (why) errors.push({ step: key, error: why });
    merge(base, key, v, null, why);
  };
  // 첫 요청에서 401 이면 던진다(isCredReject) — 나머지를 두드리지 않는다(계정 잠금 방지).
  const ev = await soft(REST_PATHS.events);
  take('events', ev, parseEventGroups);
  const nodes = await soft(REST_PATHS.nodes);
  take('drives', nodes, parseDrives);
  take('psu', nodes, parseRestPsu);
  take('battery', nodes, parseBatteries);
  take('ifaces', await soft(REST_PATHS.ifaces), parseIfaces);
  take('healthcheck', await soft(REST_PATHS.healthcheck), parseHealthcheck);
  take('ntp', await soft(REST_PATHS.ntp), parseNtp);
  if (base.facts.vhs == null) take('vhs', await soft(REST_PATHS.vhs), parseVhsSettings);
  take('snapshots', await soft(REST_PATHS.snapshots), parseSnapshots);
  if (base.facts.jobs == null) take('jobs', await soft(REST_PATHS.jobs), parseJobs);
  const pol = await soft(REST_PATHS.syncPolicies);
  const p = pol.ok ? parseSyncPolicies(pol.v) : null;
  if (p && p.policies === 0) merge(base, 'synciq', { policies: 0, reports: 0, failed: 0, failedPolicies: [] });
  else if (p) {
    const rep = await soft(REST_PATHS.syncReports);
    const r = rep.ok ? parseSyncReports(rep.v, { now }) : null;
    if (r) merge(base, 'synciq', { policies: p.policies, ...r });
    else { const w = rep.ok ? '응답 형식 미인식' : why404(rep); errors.push({ step: 'synciq', error: w }); merge(base, 'synciq', null, null, w); }
  } else { const w = pol.ok ? '응답 형식 미인식' : why404(pol); errors.push({ step: 'synciq', error: w }); merge(base, 'synciq', null, null, w); }
  for (const k of ['group', 'bootMirror']) merge(base, k, null, null, SSH_ONLY_WHY);
}

/**
 * 장비 하나 점검 — { ok, run } | { skipped } | { ok:false, error, auth }. 이력에 적고(이 포탈) 엣지면 고리에 넣는다.
 * @param {object} dev 등록부 장비(비밀 없음 판)
 */
export async function inspectDevice(dev, { now = Date.now() } = {}) {
  if (authStopFor(dev)) return { skipped: 'auth' };
  const r = await runSampleExclusive(dev, async () => {
    const full = getDeviceWithSecret(dev.id) || dev;
    const t0 = Date.now();
    const base = factsFromSnapshot(snapOf(dev.id));
    const errors = [];
    let method = full.collectMethod === 'ssh' ? 'ssh' : 'api';
    let auth = false; let fatal = null;
    if (useDemoSynth(dev)) { method = 'demo'; const d = demoInspectFacts({ ...full, nodeCount: base.facts.nodeCount }, now); Object.assign(base.facts, d.facts); base.why = { ...base.why, ...d.why }; for (const k of Object.keys(d.facts)) delete base.why[k]; fillDemoRatios(base.facts); pushAll(errors, d.errors); }
    else {
      try {
        await withDeadline(INSPECT_TIMEOUT_MS, (signal) => (method === 'ssh' ? collectSsh(full, signal, base, errors, now) : collectRest(full, signal, base, errors, now)), '점검 시한');
      } catch (e) { fatal = capErr(e); auth = isCredReject(e) || isSshAuthError(e); }
    }
    if (auth) { markAuthStopped(dev.id, full, fatal || '인증 실패'); return { ok: false, error: fatal || '인증 실패', auth: true }; }
    if (fatal) errors.push({ step: 'session', error: fatal });
    if (!auth && !fatal && method !== 'demo') clearAuthStop(dev.id);
    const run = { at: t0, ms: Date.now() - t0, method, facts: base.facts, why: base.why, errors, ...(fatal ? { partial: true } : {}) };
    const saved = recordRun(dev.id, run);
    if (isEdge() || _ringForce) ringPush(dev.id, saved.run || run);
    return { ok: true, run: saved.run || run, saved: !!saved.saved, partial: !!fatal };
  });
  if (r === IN_FLIGHT_BUSY) return { skipped: 'in-flight' };
  return r;
}

// ── 엣지 미전송 고리(노드 부하 표본 고리와 같은 구조 · 파일 보존) ───────────────
const _ring = new Map(); let _ringDropped = 0; let _ringLoaded = false; let _ringTimer = null; let _ringDirty = false; let _ringForce = false;
const RING_FILE = () => path.join(config.configDir, 'storage-inspect-ring.json');
function loadRing() {
  if (_ringLoaded) return;
  _ringLoaded = true;
  const file = RING_FILE();
  registerStateFile(file);
  registerExitFlush('storage-inspect-ring', flushRing);
  try {
    if (!fs.existsSync(file)) return;
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!j || typeof j !== 'object' || !j.devices || typeof j.devices !== 'object') throw new Error('고리 파일 모양이 아닙니다');
    for (const [id, arr] of Object.entries(j.devices).slice(0, 500)) if (Array.isArray(arr) && arr.length) _ring.set(String(id).slice(0, 128), arr.slice(-RING_MAX));
  } catch (e) { preserveCorrupt(file, e?.message); console.warn(`[storage-inspect] 미전송 점검 파일을 읽지 못해 빈 고리로 시작합니다: ${safeLoadText(e)}`); }
}
function flushRing() {
  if (_ringTimer) { clearTimeout(_ringTimer); _ringTimer = null; }
  if (!_ringDirty) return;
  _ringDirty = false;
  try { atomicWriteFileSync(RING_FILE(), JSON.stringify({ version: 1, devices: Object.fromEntries(_ring) }), { mode: 0o600 }); } catch (e) { console.warn(`[storage-inspect] 미전송 점검 파일 저장 실패: ${capErr(e)}`); }
}
function saveRing() { _ringDirty = true; if (_ringTimer) return; _ringTimer = setTimeout(() => { _ringTimer = null; flushRing(); }, 2_000); _ringTimer.unref?.(); }
function ringPush(id, run) {
  loadRing();
  const a = _ring.get(String(id)) || [];
  a.push(run);
  while (a.length > RING_MAX) { a.shift(); _ringDropped += 1; }
  _ring.set(String(id), a); saveRing();
}
/** push 본문에 실을 미전송 점검 — [{ deviceId, runs:[…] }](사본). */
export function pendingInspectRuns() { loadRing(); return [..._ring].filter(([, a]) => a.length).map(([deviceId, a]) => ({ deviceId, runs: a.slice() })); }
/** 중앙이 받은 점검을 고리에서 지운다(at 로 대조). */
export function markInspectRunsSent(list) {
  let changed = false;
  for (const ent of list || []) {
    const a = _ring.get(String(ent?.deviceId));
    if (!a) continue;
    const sent = new Set((ent.runs || []).map((r) => r?.at));
    const left = a.filter((r) => !sent.has(r.at));
    if (left.length === a.length) continue;
    changed = true;
    if (left.length) _ring.set(String(ent.deviceId), left); else _ring.delete(String(ent.deviceId));
  }
  if (changed) saveRing();
}
function ringStatus() { let n = 0; for (const a of _ring.values()) n += a.length; return { devices: _ring.size, runs: n, dropped: _ringDropped, max: RING_MAX }; }

// ── 실행 묶음(재진입 가드) ──────────────────────────────────────────────────
let _busy = false; let _last = null; const _queue = new Set(); let _current = null;
/** 이 노드 몫 아이실론(활성) — live 에서는 mock- 장비 제외. */
export function inspectTargets(devs = null) {
  const all = devs || (isMockMode() ? devicesForThisNode() : devicesForThisNode().filter((d) => !isDemoId(d.id)));
  return all.filter((d) => d && d.type === 'isilon' && d.enabled !== false);
}
/**
 * 점검 한 묶음 — ids 가 없으면 이 노드 몫 전부. 이미 돌고 있으면 ids 를 대기열에 넣고 { queued } (끝나면 이어서 돈다).
 * @returns {Promise<object>} 요약(_last)
 */
/* 반증 E1: 엣지는 점검이 끝나면 다음 주기를 기다리지 않고 storage push 를 한 번 당긴다 — push 주기가 요청 큐의 ack 시한(받아 간 뒤 15분 + 장비 시한)보다 길면
 *   중앙이 '결과 없음' 으로 요청을 버리고 같은 장비를 다시 점검시켰다. push 모듈이 이 고리를 읽으므로(정적 import) 거꾸로 import 하지 않고 훅으로 받는다. */
let _afterEdgeRun = null;
export function setAfterEdgeInspectHook(fn) { _afterEdgeRun = typeof fn === 'function' ? fn : null; }
export async function runInspectOnce({ ids = null, reason = 'manual' } = {}) {
  if (_busy) { for (const id of ids || inspectTargets().map((d) => d.id)) _queue.add(String(id)); return { queued: _queue.size, busy: true }; }
  _busy = true;
  const startedAt = Date.now();
  try {
    const targets = inspectTargets();
    const want = ids ? new Set(ids.map(String)) : null;
    const devs = want ? targets.filter((d) => want.has(String(d.id))) : targets;
    // 정리 기준은 '등록부에 있는 아이실론 전부'(중앙) · '내 몫'(엣지) — 중앙에서 이 노드 몫(중앙 직접 장비)만 넘기면 엣지 위임 장비의 이력이 지워진다(반증 F9 검토 중 확인).
    if (!registryLoadError()) pruneRuns(new Set((isEdge() ? targets : listDevices().filter((d) => d && d.type === 'isilon')).map((d) => String(d.id))));
    let ok = 0; let fail = 0; let authStopped = 0; let busySkipped = 0; let partial = 0; const errors = [];
    await poolRun(devs, 2, async (d) => {
      _current = String(d.id);
      let r;
      try { r = await inspectDevice(d); } catch (e) { r = { ok: false, error: capErr(e) }; }
      if (r?.skipped === 'auth') authStopped += 1;
      else if (r?.skipped === 'in-flight') busySkipped += 1;
      else if (r?.ok) { ok += 1; if (r.partial) partial += 1; }
      else { fail += 1; if (errors.length < 5) errors.push({ id: String(d.id), error: r?.error || '알 수 없는 오류', ...(r?.auth ? { auth: true } : {}) }); }
    });
    _last = { at: Date.now(), startedAt, ms: Date.now() - startedAt, reason, targets: devs.length, ok, failed: fail, partial, authStopped, busySkipped, errors, ring: ringStatus() };
    if (fail) console.warn(`[storage-inspect] 점검 실패 ${fail}대/${devs.length}: ${errors.map((e) => `${e.id}: ${e.error}`).join(' · ')}`);
    else console.log(`[storage-inspect] 점검 ${ok}대 완료(${reason}${partial ? ` · 일부만 ${partial}` : ''}${busySkipped ? ` · 수집 중이라 건너뜀 ${busySkipped}` : ''}${authStopped ? ` · 인증 정지 ${authStopped}` : ''})`);
    if (isEdge() && ok && _afterEdgeRun) { try { Promise.resolve(_afterEdgeRun()).catch((e) => console.warn(`[storage-inspect] 점검 뒤 push 실패: ${capErr(e)}`)); } catch (e) { console.warn(`[storage-inspect] 점검 뒤 push 실패: ${capErr(e)}`); } }
    return _last;
  } finally {
    _busy = false; _current = null;
    if (_queue.size) { const next = [..._queue]; _queue.clear(); setTimeout(() => { runInspectOnce({ ids: next, reason: 'queued' }).catch(() => {}); }, 1_000).unref?.(); }
  }
}
export function inspectRunnerStatus() {
  return { ...(_last || {}), busy: _busy, current: _current, queued: _queue.size, timeoutMs: INSPECT_TIMEOUT_MS, sshBudgetMs: SSH_BUDGET_MS, ring: (loadRing(), ringStatus()), edge: isEdge() };
}
export function _resetRunnerForTest() { _ring.clear(); _ringDropped = 0; _last = null; _busy = false; _queue.clear(); _current = null; }
export function _ringForTest({ force = null } = {}) { if (force != null) _ringForce = !!force; return ringStatus(); }

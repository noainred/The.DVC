/**
 * storage/nodeLoadPoller.js — 아이실론 노드 부하 **표본** 폴러(v2.932, 2차 ⑨ · 설계 `docs/design/isilon-node-clients/README.md` §4).
 *
 * 왜 따로 도나: 수집 주기(기본 1시간)는 용량·노드 상태·계정·영역까지 읽는 무거운 수집이다. 노드 부하·클라이언트·프로토콜은 '쏠림' 을 보려면
 * 더 자주 필요하지만(기본 5분) 그 전부를 5분마다 돌릴 수 없다. 이 폴러는 **가벼운 호출 4개**만 한다 —
 *   REST: statistics/current(devid=all · 노드 키) · summary/client · summary/protocol · summary/drive
 *   SSH : 세션 1개에 isi statistics system / client / protocol / drive (--nodes all --format json)
 *
 * 규약(CLAUDE.md 폴러 규칙 그대로):
 *  · 주기는 매 틱 조회(intervals.nodeLoadMs — 중앙 배포 · 하한 1분 · 상한 60분) · 재진입 가드 · 동시 3 · 장비당 시한(기본 60초 — 세션을 실제로 끊는다).
 *  · 장비 점유는 수집 주기와 나눈다(poller.runSampleExclusive): 같은 장비가 수집 주기 중이면 이번 표본은 **건너뛴다**(실패 아님 — inFlightSkipped).
 *  · 인증 실패 정지는 수집 주기와 **같은 레코드**(authGuard) — 자격증명이 하나이므로 어느 쪽이 401 을 받아도 둘 다 멈춘다. 성공하면 풀린다.
 *  · 0건이어도 상태를 올린다(_last · `edgelog/spec.js` collect.storageNodeLoad). 장비 오류 원문은 콘솔·상태에 160자까지(주소가 들 수 있어 관리자 화면만).
 *
 * 대상: 이 노드 몫(devicesForThisNode) 아이실론 중 `enabled !== false` 이고 `nodeLoadEnabled !== false`(기본 켬 — registry.normalizeDevice). live 에서는 mock- 장비 제외.
 * 적재: 로컬 DB(db.saveNodeLoadSample — 표본 1개 = 트랜잭션 1개). **엣지는** 미전송 표본을 장비당 RING_MAX 개 들고 있다가 storage push 본문(`nodeLoadSamples`)에
 *       실어 보낸다(push.js) — 중앙이 200 을 주면 지운다. 더 쌓이면(중앙 불통) 가장 오래된 것을 버리고 그 수를 상태에 센다(무음 금지). 엣지 로컬 DB 에는 전부 남는다.
 *
 * ⚠⚠ 정직 기록 — **실장비 미확인**(isilonNodeLoad.js 머리말과 같은 수준): REST summary 경로·필드 이름 · `isi statistics client/protocol/drive --format json` 의 행 모양 ·
 *   클라이언트·프로토콜 행의 node 가 lnn 인지 devid 인지(lnn 으로 본다) · statistics/current 의 devid 는 /cluster/nodes 의 id 라(v2.603) NODE_MAP_TTL 마다 한 번
 *   노드 목록을 읽어 devid→lnn 으로 바꾼다(못 읽으면 devid 그대로 — probe.idMap 이 밝힌다). 첫 실장비 수집에서 probe(clientsRead 등)를 보고 보정할 것.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt, safeLoadText } from '../util/atomicWrite.js'; // 로드 오류 원문(파일 조각)은 콘솔·상태에 싣지 않는다(RG2744-02)
import { registerExitFlush } from '../util/exitFlush.js';
import { registerStateFile } from '../util/stateFiles.js';
import { devicesForThisNode, getDeviceWithSecret, registryLoadError } from './registry.js';
import { authStopFor, markAuthStopped, clearAuthStop } from './authGuard.js';
import { runtimeIntervals, startAdaptiveTimer } from './intervals.js';
import { runSampleExclusive, IN_FLIGHT_BUSY, useDemoSynth } from './poller.js';
import { withDeadline, withSsh, isSshAuthError } from '../proxy/sshExec.js';
import { poolRun } from '../util/pool.js';
import { get as isiGet, getAny as isiGetAny } from './collectors/isilon.js';
import { isCredReject } from './collectors/restCommon.js';
import { ISI_NODE_LOAD_REST_KEYS, ISI_SUMMARY_PATHS, ISI_SAMPLE_CMDS, restSampleNodes, nodeIdMapOf, parseIsiSystemStats,
  parseClientRows, parseProtocolRows, parseDriveRows, buildNodeLoadSample } from './collectors/isilonNodeLoad.js';
import { saveNodeLoadSample, saveNodeUnits } from './db.js';
import { sampleArrayPerf, isFePerfType } from './collectors/arrayPerf.js'; // v2.952 어레이 프런트엔드(디렉터 · 노드 · SP) 표본
import { CLIENT_LIMIT_DEF, CLIENT_LIMIT_MAX, sanitizeNodeLoadSample } from './nodeLoad.js';
import { isMockMode, isDemoId, demoNodeLoadSample } from '../mock/demo/storage.js';
import { reqTimeoutMs } from '../agent/envTimeout.js'; // 시한 env 단일 관문(TIM2605-04 — [하한, 상한] 밖·NaN 은 기본값)

/** 장비당 표본 시한 — 수집 주기 시한(3분)보다 짧다: 가벼운 호출 4개라 60초를 넘기면 그 장비는 이번 표본을 포기한다(15초 ~ 10분). */
export const SAMPLE_TIMEOUT_MS = reqTimeoutMs(process.env.STORAGE_NODELOAD_TIMEOUT_MS, 60_000, { min: 15_000, max: 600_000 });
/** 엣지 미전송 표본 고리(장비당) — 기본 3 = push 주기(5분) 기준 15분치. 그 이상은 가장 오래된 것부터 버린다(로컬 DB 에는 남는다). */
export const RING_MAX = 3;
const CMD_TIMEOUT_MS = 15_000;          // 명령·요청 하나의 시한(장비 시한 60초 안에 4개)
const NODE_MAP_TTL_MS = 6 * 3_600_000;  // REST devid→lnn 대응표 갱신 간격
const NODE_MAP_RETRY_MS = 30 * 60_000;  // 못 읽었을 때 다시 시도하는 간격
const REST_SOURCE = 'REST statistics/current · summary/{client,protocol,drive}';
const SSH_SOURCE = 'isi statistics {system,client,protocol,drive}';
const nodeLoadMs = () => runtimeIntervals().nodeLoadMs;
const isEdge = () => !!(config.agent.centralUrl && config.agent.centralToken);
const capErr = (e) => String(e?.message || e || '').slice(0, 160);

let _timer = null;
let _busy = false;
let _last = null;

/**
 * 표본 대상(순수): 활성 · 토글 켬(기본)인 아이실론, 그리고 v2.952 부터 REST 로 수집하는 어레이(PowerMax · VMAX · PowerStore · Unity — SSH 변형은 성능 경로가 없다).
 * 어레이 표본은 디렉터 · 노드 · SP 단위 성능(arrayPerf.js) — 같은 5분 주기 · 같은 시한 · 같은 인증 정지 레코드.
 */
export function sampleTargets(devs) {
  return (devs || []).filter((d) => d && d.enabled !== false && d.nodeLoadEnabled !== false
    && (d.type === 'isilon' || (isFePerfType(d.type) && (d.collectMethod || 'api') === 'api')));
}

// ── REST ─────────────────────────────────────────────────────────────────────
const _nodeMap = new Map(); // deviceId → { at, map: Map|null }
async function nodeIdMap(dev) {
  const cur = _nodeMap.get(dev.id);
  const now = Date.now();
  if (cur && now - cur.at < (cur.map ? NODE_MAP_TTL_MS : NODE_MAP_RETRY_MS)) return cur.map;
  let map = null;
  try { map = nodeIdMapOf(await isiGetAny(dev, ['/platform/3/cluster/nodes', '/platform/1/cluster/nodes'])); } catch { map = null; }
  _nodeMap.set(dev.id, { at: now, map });
  while (_nodeMap.size > 1_000) _nodeMap.delete(_nodeMap.keys().next().value);
  return map;
}
const soft = async (p) => { try { return { ok: true, v: await p }; } catch (e) { return { ok: false, err: capErr(e) }; } };
/** 요약 3개를 파서에 넣고 probe 에 읽기 상태(ok · parse · error)를 적는다 — 조용히 비우지 않는다. */
function assemble({ ts, nodes, cl, pr, dr, source, clientLimit, extraProbe = {} }) {
  const clients = cl.ok ? parseClientRows(cl.v) : null;
  const protocols = pr.ok ? parseProtocolRows(pr.v) : null;
  const drives = dr.ok ? parseDriveRows(dr.v) : null;
  const sample = buildNodeLoadSample({ ts, nodes, clients, protocols, drives, clientLimit, source });
  const state = (r, parsed) => (r.ok ? (parsed ? 'ok' : 'parse') : 'error');
  sample.probe.clientsRead = state(cl, clients); sample.probe.protocolsRead = state(pr, protocols); sample.probe.drivesRead = state(dr, drives);
  if (!cl.ok) sample.probe.clientsError = String(cl.err).slice(0, 120);
  if (!pr.ok) sample.probe.protocolsError = String(pr.err).slice(0, 120);
  if (!dr.ok) sample.probe.drivesError = String(dr.err).slice(0, 120);
  Object.assign(sample.probe, extraProbe);
  return sample;
}
async function sampleRest(full, signal, clientLimit) {
  const dev = { ...full, _signal: signal };
  const ts = Date.now();
  // 노드 통계가 필수 — 401 이면 여기서 던져(isCredReject) 나머지 3개를 두드리지 않는다(계정 잠금 방지 — isilon.collect 와 같은 순서).
  const st = await isiGet(dev, '/platform/1/statistics/current?devid=all&key=node.net.ext.bytes.in.rate&key=node.net.ext.bytes.out.rate'
    + ISI_NODE_LOAD_REST_KEYS.map((k) => `&key=${k}`).join(''));
  const idMap = await nodeIdMap(dev);
  const nodes = restSampleNodes(st, idMap);
  if (!nodes.length) throw new Error('statistics/current 응답에 노드 행(devid)이 없습니다');
  const limit = Math.max(50, Math.min(2000, nodes.length * clientLimit * 2));
  const [cl, pr, dr] = await Promise.all([
    soft(isiGet(dev, ISI_SUMMARY_PATHS.client(limit))), soft(isiGet(dev, ISI_SUMMARY_PATHS.protocol)), soft(isiGet(dev, ISI_SUMMARY_PATHS.drive)),
  ]);
  return assemble({ ts, nodes, cl, pr, dr, source: REST_SOURCE, clientLimit, extraProbe: { idMap: idMap ? 'lnn' : 'devid' } });
}

// ── SSH ──────────────────────────────────────────────────────────────────────
async function sampleSsh(full, signal, clientLimit) {
  const ts = Date.now();
  const r = await withSsh(
    { host: full.host, port: Number(full.sshPort) || 22, username: full.username, password: full.password || '', signal },
    async (sh) => {
      const run = (cmd) => soft(sh.exec(cmd, CMD_TIMEOUT_MS).then((x) => x.stdout || ''));
      const sys = await sh.exec(ISI_SAMPLE_CMDS.system, CMD_TIMEOUT_MS); // 필수 — 실패하면 표본 실패
      // 순서가 계약이다(시한이 모자랄 때 뒤부터 잃는다): 클라이언트(쏠림 판정의 원천) → 프로토콜 → 드라이브.
      const cl = await run(ISI_SAMPLE_CMDS.client); const pr = await run(ISI_SAMPLE_CMDS.protocol); const dr = await run(ISI_SAMPLE_CMDS.drive);
      return { sys: sys.stdout || '', cl, pr, dr };
    },
  );
  const parsed = parseIsiSystemStats(r.sys, { net: true });
  if (!parsed) throw new Error('isi statistics system 출력 형식을 읽지 못했습니다(JSON 아님 또는 모르는 모양)');
  const nodes = [...parsed].map(([id, v]) => ({ id, ...v })).sort((a, b) => a.id - b.id);
  if (!nodes.length) throw new Error('isi statistics system 출력에 노드 행이 없습니다');
  return assemble({ ts, nodes, cl: r.cl, pr: r.pr, dr: r.dr, source: SSH_SOURCE, clientLimit });
}

// ── 엣지 미전송 고리 ─────────────────────────────────────────────────────────
/*
 * v2.938: 고리를 **파일로도 남긴다**(`storage-nodeload-ring.json` — 상태 파일로 등록, 백업·설정 감시 대상 아님). 예전에는 메모리뿐이라 엣지가
 * 재시작하면 최대 15분치(표본 3개)가 중앙에 오르지 않았다(엣지 로컬 DB 에는 있었다). 저장은 2초 디바운스 + 종료 시 동기 flush(exitFlush),
 * 기동 시 첫 사용에서 읽어 **정제(sanitizeNodeLoadSample)·장비당 RING_MAX·7일 이내**만 되살린다. 손상이면 원본을 보존하고 빈 고리로 간다(무음 금지 — 콘솔·상태).
 * 엣지(중앙 URL·토큰)가 아니면 쓰지 않는다(중앙은 고리를 쓰지 않는다).
 */
const _ring = new Map(); // deviceId → [sample]
let _ringDropped = 0;
const RING_FILE = () => path.join(config.configDir, 'storage-nodeload-ring.json');
const RING_MAX_DEVICES = 500;
const RING_MAX_AGE_MS = 7 * 86_400_000;
let _ringLoaded = false; let _ringTimer = null; let _ringDirty = false; let _ringForce = false;
const _ringPersist = { loaded: 0, saved: 0, error: null, hasFile: false };
function loadRing() {
  if (_ringLoaded) return;
  _ringLoaded = true;
  const file = RING_FILE();
  registerStateFile(file);
  registerExitFlush('storage-nodeload-ring', flushRingSync);
  try {
    if (!fs.existsSync(file)) return;
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const dev = j && typeof j === 'object' && !Array.isArray(j) && j.devices && typeof j.devices === 'object' && !Array.isArray(j.devices) ? j.devices : null;
    if (!dev) throw new Error('고리 파일 모양이 아닙니다');
    const now = Date.now(); let n = 0;
    for (const [id, arr] of Object.entries(dev).slice(0, RING_MAX_DEVICES)) {
      if (!Array.isArray(arr)) continue;
      const keep = [];
      for (const raw of arr.slice(-RING_MAX)) {
        const s = sanitizeNodeLoadSample(raw, { clientLimit: CLIENT_LIMIT_MAX });
        if (s && now - s.ts <= RING_MAX_AGE_MS) keep.push(s);
      }
      if (keep.length) { _ring.set(String(id).slice(0, 128), keep); n += keep.length; }
    }
    _ringPersist.loaded = n; _ringPersist.hasFile = true;
    if (n) console.log(`[storage-nodeload] 재시작 전 미전송 표본 ${n}개를 파일에서 되살렸습니다(장비 ${_ring.size}대) — 다음 push 에 싣습니다`);
  } catch (e) {
    const why = safeLoadText(e); // 원문(JSON 조각)이 아니라 요약
    _ringPersist.error = why;
    preserveCorrupt(file, e?.message);
    console.warn(`[storage-nodeload] 미전송 표본 파일을 읽지 못해 빈 고리로 시작합니다(원본은 .corrupt 로 보존): ${why}`);
  }
}
const ringJson = () => JSON.stringify({ version: 1, at: Date.now(), devices: Object.fromEntries([..._ring]) });
function flushRingSync() {
  if (_ringTimer) { clearTimeout(_ringTimer); _ringTimer = null; }
  if (!_ringDirty) return;
  _ringDirty = false;
  try { atomicWriteFileSync(RING_FILE(), ringJson(), { mode: 0o600 }); _ringPersist.saved += 1; _ringPersist.error = null; _ringPersist.hasFile = true; }
  catch (e) { _ringPersist.error = capErr(e); console.warn(`[storage-nodeload] 미전송 표본 파일 저장 실패: ${capErr(e)}`); }
}
function saveRing() {
  if (!isEdge() && !_ringForce) return;
  _ringDirty = true;
  if (_ringTimer) return;
  _ringTimer = setTimeout(() => { _ringTimer = null; flushRingSync(); }, 2_000);
  _ringTimer.unref?.();
}
function ringPush(id, sample) {
  loadRing();
  const a = _ring.get(String(id)) || [];
  a.push(sample);
  while (a.length > RING_MAX) { a.shift(); _ringDropped += 1; }
  _ring.set(String(id), a);
  saveRing();
}
/** push 본문에 실을 미전송 표본 — [{ deviceId, samples:[…] }](사본 — 보내는 동안 새 표본이 들어와도 섞이지 않게). */
export function pendingNodeLoadSamples() {
  loadRing();
  const out = [];
  for (const [deviceId, a] of _ring) if (a.length) out.push({ deviceId, samples: a.slice() });
  return out;
}
/** 중앙이 받은 표본(pendingNodeLoadSamples 가 돌려준 목록)을 고리에서 지운다 — ts 로 대조(보내는 동안 들어온 새 표본은 남는다). */
export function markNodeLoadSamplesSent(list) {
  let changed = false;
  for (const ent of list || []) {
    const a = _ring.get(String(ent?.deviceId));
    if (!a) continue;
    const sent = new Set((ent.samples || []).map((s) => s?.ts));
    const left = a.filter((s) => !sent.has(s.ts));
    if (left.length === a.length) continue;
    changed = true;
    if (left.length) _ring.set(String(ent.deviceId), left); else _ring.delete(String(ent.deviceId));
  }
  if (changed) saveRing();
}
function ringStatus() { let n = 0; for (const a of _ring.values()) n += a.length; return { devices: _ring.size, samples: n, dropped: _ringDropped, max: RING_MAX, persist: { ..._ringPersist } }; }
function pruneRing(liveIds) { let removed = 0; for (const k of [..._ring.keys()]) if (!liveIds.has(k)) { _ring.delete(k); removed += 1; } if (removed) saveRing(); }

// ── 장비 1대 ─────────────────────────────────────────────────────────────────
async function sampleOne(dev) {
  if (authStopFor(dev)) return { skipped: 'auth' };
  const r = await runSampleExclusive(dev, async () => {
    const full = getDeviceWithSecret(dev.id) || dev;
    const t0 = Date.now();
    let sample = null; let error = null; let auth = false;
    if (useDemoSynth(dev)) sample = demoNodeLoadSample(full, t0);
    else {
      try {
        sample = await withDeadline(SAMPLE_TIMEOUT_MS,
          (signal) => (isFePerfType(full.type) ? sampleArrayPerf(full, { signal, now: t0 })
            : full.collectMethod === 'api' ? sampleRest(full, signal, CLIENT_LIMIT_DEF) : sampleSsh(full, signal, CLIENT_LIMIT_DEF)), '표본 시한');
      } catch (e) { error = capErr(e); auth = isCredReject(e) || isSshAuthError(e); }
    }
    if (auth) markAuthStopped(dev.id, full, error || '인증 실패'); // 수집 주기와 같은 레코드 — 재시도하지 않는다(계정 잠금)
    if (!sample) return { ok: false, error: error || '표본 없음', auth, ms: Date.now() - t0 };
    if (!useDemoSynth(dev)) clearAuthStop(dev.id);
    let saved;
    try { saved = await saveNodeLoadSample(dev.id, sample); } catch (e) { saved = { saved: false, reason: capErr(e) }; }
    // v2.952: 어레이 단위 카탈로그(id ↔ 이름 · 종류 · 부모)는 표본과 함께 — 엣지는 push 본문의 표본 안(sample.units)에 실려 중앙이 같은 함수로 저장한다.
    if (Array.isArray(sample.units) && sample.units.length) { try { await saveNodeUnits(dev.id, sample.units); } catch (e) { console.warn(`[storage-nodeload] 단위 카탈로그 저장 실패(${dev.id}): ${capErr(e)}`); } }
    if (isEdge()) ringPush(dev.id, sample);
    return { ok: true, saved, nodes: sample.nodes.length, ms: Date.now() - t0 };
  });
  if (r === IN_FLIGHT_BUSY) return { skipped: 'in-flight' };
  return r;
}

/** 한 주기 — 테스트·'지금 표본' 이 직접 부른다. 재진입 가드(_busy). */
export async function pollNodeLoadOnce() {
  if (_busy) return { skipped: true };
  _busy = true;
  const startedAt = Date.now();
  try {
    const demo = isMockMode();
    const all = demo ? devicesForThisNode() : devicesForThisNode().filter((d) => !isDemoId(d.id));
    const devs = sampleTargets(all);
    if (!registryLoadError()) pruneRing(new Set(devs.map((d) => String(d.id))));
    let ok = 0; let fail = 0; let authStopped = 0; let inFlightSkipped = 0; let duplicate = 0; let unsaved = 0;
    const errors = [];
    await poolRun(devs, 3, async (d) => {
      let r;
      try { r = await sampleOne(d); } catch (e) { r = { ok: false, error: capErr(e) }; }
      if (r?.skipped === 'auth') authStopped += 1;
      else if (r?.skipped === 'in-flight') inFlightSkipped += 1;
      else if (r?.ok) { ok += 1; if (r.saved?.duplicate) duplicate += 1; else if (!r.saved?.saved) unsaved += 1; }
      else { fail += 1; if (errors.length < 5) errors.push({ id: String(d.id), error: r?.error || '알 수 없는 오류', ...(r?.auth ? { auth: true } : {}) }); }
    });
    _last = { at: Date.now(), ms: Date.now() - startedAt, targets: devs.length, ok, failed: fail, authStopped, inFlightSkipped, duplicate, unsaved,
      registryError: !!registryLoadError(), errors, ring: ringStatus() };
    if (fail) console.warn(`[storage-nodeload] 표본 실패 ${fail}대/${devs.length}: ${errors.map((e) => `${e.id}: ${e.error}`).join(' · ')}`);
    if (unsaved) console.warn(`[storage-nodeload] 표본 ${unsaved}개를 DB 에 적재하지 못했습니다(DB 비활성 또는 오류)`);
    return _last;
  } finally { _busy = false; }
}

export function startNodeLoadPoller() {
  if (_timer) return;
  // 첫 표본은 수집 주기 첫 수집(15초) 뒤 — 같은 장비를 동시에 두드리지 않게. 이후 매 회 현재 주기(중앙 배포값)로 재무장.
  _timer = startAdaptiveTimer(nodeLoadMs, () => pollNodeLoadOnce(), { firstDelayMs: 40_000, name: '노드 부하 표본' });
}
export function nodeLoadPollerStatus() {
  return { ...(_last || {}), intervalMs: nodeLoadMs(), timeoutMs: SAMPLE_TIMEOUT_MS, busy: _busy, ring: ringStatus(), edge: isEdge() };
}
export function _resetForTest() { _ring.clear(); _ringDropped = 0; _nodeMap.clear(); _last = null; _busy = false; }
export function _ringPushForTest(id, sample) { ringPush(id, sample); }
/** 테스트 — 엣지가 아니어도 파일에 쓰게(force) · 지금 flush · '재시작' 흉내(메모리 비우고 파일에서 다시 읽기). */
export function _ringPersistForTest({ force = null, flush = false, reload = false } = {}) {
  if (force != null) _ringForce = !!force;
  if (flush) flushRingSync();
  if (reload) { _ring.clear(); _ringLoaded = false; _ringPersist.loaded = 0; _ringPersist.error = null; loadRing(); }
  return { ..._ringPersist, file: RING_FILE() };
}

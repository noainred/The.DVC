/**
 * iDRAC 센서 상세 캐시(v2.659) — 서버별 ① Thermal 상세(매 폴 주기, 인메모리) ② Sensors 컬렉션(인벤토리 주기, 파일 보관).
 *
 * ② 는 재시작 뒤에도 30분 동안 화면이 비지 않게 `idrac-sensor-cache.json` 에 남긴다. 이것은 **캐시**다 —
 *   손상되면 새로 시작하고(다음 인벤토리 주기가 다시 채운다) 원본을 보존하지 않는다(v2.516 활동 로그와 같은 판단,
 *   arch2582 CACHE_OK 에 사유와 함께 등재). 백업 '설정 변경' 감시에 잡히지 않게 상태 파일로 등록한다(v2.613).
 * ① 은 1분마다 바뀌므로 파일에 쓰지 않는다(재시작 직후 한 주기 동안 비는 것은 화면이 '센서 상세 수집 전' 으로 말한다).
 *
 * v2.741(감사 LEFT-08): 디바운스 저장은 **조각 직렬화 + 비동기 tmp → fsync → rename** 이다(ipam/scanStore.js v2.731 A6-01 과 같은 규칙).
 *   예전에는 60초마다 전 서버 컬렉션(1,000대 × 센서 150개 ≈ 13~18MB)을 동기 JSON.stringify + 동기 원자 쓰기 해 회당 약 0.2초 동안
 *   포탈 전체가 멈췄다(v2.680 E-03 은 빈도만 줄였다). 이제 ① 서버 항목을 하나씩 직렬화해 이어 쓰고 조각 사이에서 양보한다(시간 기준 —
 *   WRITE_SLICE_MS) ② 진행 중 쓰기는 1건 — 그 사이 바뀐 것은 dirty 로 다음 회차 ③ 종료 flush 는 **동기**다(exit 훅에서 비동기는 실행되지
 *   않는다). 동기 flush 가 진행 중 비동기 쓰기를 대체하면(세대 gen) 그 쓰기는 rename 하지 않는다 — 늦게 끝난 옛 본문이 새 본문을 덮지 않게.
 *   ④ 실패는 콘솔에 남기고 dirty 로 둔다(다음 변경·종료 flush 가 다시 쓴다 — 큰 파일을 재시도 루프로 다시 직렬화하지 않는다).
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, safeLoadText } from '../util/atomicWrite.js';
import { registerExitFlush } from '../util/exitFlush.js';
import { registerStateFile } from '../util/stateFiles.js';
import { compactSensor, expandCompact, mergeSensors, SENSOR_LIST_MAX } from './sensorDetail.js';

// 파일명은 리터럴로 둔다(이름 끝 -cache.json 은 백업의 상태 파일 규약 RUNTIME_STATE_RE 에 걸린다 — 모듈이 로드되지 않아도 상태로 판정) — scripts/config-doc.mjs 가 path.join(config.configDir, '<이름>') 형태를 읽어 CONFIG-FILES.md 를 만든다.
registerStateFile('idrac-sensor-cache.json');
const FILE = () => path.join(config.configDir, 'idrac-sensor-cache.json');

const thermal = new Map();     // serverId -> { at, list }
let collection = new Map();    // serverId -> { at, ok, sensors(compact[]), chassis, absent, failed, expanded, notRead, error }
let loaded = false;
let timer = null;

function load() {
  if (loaded) return;
  loaded = true;
  // 이전 프로세스가 비동기 쓰기 도중 끝나 남긴 임시 파일을 치운다(이 모듈의 표지가 붙은 것만 · 지금 쓰는 중이면 건드리지 않는다).
  if (!w.writing) {
    try {
      for (const n of fs.readdirSync(path.dirname(FILE()))) if (n.startsWith(TMP_PREFIX)) { try { fs.unlinkSync(path.join(path.dirname(FILE()), n)); } catch { /* */ } }
    } catch { /* 설정 디렉터리가 아직 없다 */ }
  }
  try {
    if (!fs.existsSync(FILE())) return;
    const obj = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      for (const [k, v] of Object.entries(obj)) if (v && typeof v === 'object') collection.set(k, v);
    }
  } catch (e) {
    console.warn(`[idrac] 센서 상세 캐시를 읽지 못해 새로 시작합니다: ${safeLoadText(e)}`);
    collection = new Map();
  }
}
/**
 * 저장 디바운스(v2.680 E-03). 파일은 서버 1,000대 × 센서 150개면 약 18MB 다. 인벤토리 재수집 구간 동안 10초마다 전량을 다시 쓰던 것을
 * 60초로 늘렸다 — 이 파일은 캐시이고 종료 시에는 exit flush 가 즉시 동기 저장한다(마지막 창을 잃지 않는다). 더 짧게 되돌리지 말 것.
 * v2.741(LEFT-08): 디바운스 뒤 저장은 비동기 조각 쓰기다(머리말) — 빈도를 줄인 것만으로는 회당 정지가 그대로였다.
 */
export const PERSIST_DEBOUNCE_MS = 60_000;
const WRITE_SLICE_MS = 8;              // 조각 하나를 만드는 데 쓰는 최대 시간(이만큼 돌았으면 파일로 내보내며 양보한다)
const WRITE_CHUNK_CHARS = 256 * 1024;  // 조각 하나의 최대 길이(문자)
const TMP_PREFIX = '.idrac-sensor-cache.json.atmp-'; // 비동기 쓰기 임시 파일 표지(동기 원자 쓰기의 '.tmp-' 와 겹치지 않게)
const SUPERSEDED = Symbol('superseded'); // 동기 flush 가 진행 중 비동기 쓰기를 대체했다
let tmpSeq = 0;
// 쓰기 상태 — dirty: 아직 파일에 안 쓴 변경 · writing: 비동기 쓰기 진행 중 · gen: 세대(동기 flush 가 올리면 진행 중 쓰기는 rename 하지 않는다)
const w = { dirty: false, writing: false, gen: 0, tmp: null, inflight: null, writes: 0, failures: 0, lastError: null, lastWriteAt: null, lastWriteMs: null };

function persistSoon() {
  w.dirty = true;
  if (timer || w.writing) return; // 진행 중인 쓰기가 끝나면 dirty 를 보고 다시 예약한다(파일마다 1건 — 늦게 끝난 옛 본문이 새 본문을 덮지 않게)
  timer = setTimeout(() => { timer = null; startWrite(); }, PERSIST_DEBOUNCE_MS);
  timer.unref?.();
}

/** 문자열을 끝까지 쓴다 — FileHandle.write 는 한 번에 다 썼다고 보장하지 않는다(util/atomicWrite.js writeAll 과 같은 규칙). */
async function writeAllAsync(fh, str) {
  const buf = Buffer.from(str, 'utf8');
  let off = 0;
  while (off < buf.length) {
    const { bytesWritten } = await fh.write(buf, off, buf.length - off);
    if (!(bytesWritten > 0)) throw new Error(`쓰기가 진행되지 않습니다(${off}/${buf.length}바이트)`);
    off += bytesWritten;
  }
}

/**
 * 조각 직렬화 — 서버 항목을 `JSON.stringify(Object.fromEntries(collection))` 과 같은 모양으로 이어 쓰며 시간 기준으로 양보한다.
 * 시작 시점의 키를 돈다(조각마다 그때 값을 읽는다 — 지운 키는 건너뛰고 새 키는 dirty 가 다음 회차에 쓴다). 항목 하나는 한 번에 직렬화된다.
 */
async function writeChunks(fh, gen) {
  const keys = [...collection.keys()];
  let buf = '{'; let first = true; let started = performance.now();
  for (const k of keys) {
    const v = collection.get(k);
    if (v === undefined) continue;
    const sv = JSON.stringify(v);
    if (sv === undefined) continue;
    buf += (first ? '' : ',') + JSON.stringify(k) + ':' + sv;
    first = false;
    if (buf.length >= WRITE_CHUNK_CHARS || performance.now() - started >= WRITE_SLICE_MS) {
      await writeAllAsync(fh, buf); // 파일 쓰기(스레드풀)를 기다리는 동안 이벤트 루프가 다른 일을 한다 — 이것이 양보다
      buf = '';
      if (gen !== w.gen) throw SUPERSEDED;
      started = performance.now();
    }
  }
  await writeAllAsync(fh, `${buf}}`);
}

function startWrite() {
  if (!w.dirty || w.writing) return;
  w.dirty = false; w.writing = true;
  const gen = ++w.gen;
  const file = FILE(); const dir = path.dirname(file);
  const tmp = path.join(dir, `${TMP_PREFIX}${process.pid}-${++tmpSeq}`);
  w.tmp = tmp;
  const t0 = performance.now();
  w.inflight = (async () => {
    let fh = null; let failed = false;
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      fh = await fs.promises.open(tmp, 'w', 0o600);
      await writeChunks(fh, gen);
      await fh.sync();
      await fh.close(); fh = null;
      if (gen !== w.gen) throw SUPERSEDED;
      await fs.promises.chmod(tmp, 0o600).catch(() => {});
      await fs.promises.rename(tmp, file);
      try { const d = await fs.promises.open(dir, 'r'); try { await d.sync(); } finally { await d.close(); } } catch { /* 디렉터리 fsync 미지원 */ }
      if (gen === w.gen) { w.writes += 1; w.lastWriteAt = Date.now(); w.lastWriteMs = Math.round(performance.now() - t0); w.lastError = null; }
    } catch (e) {
      if (fh) await fh.close().catch(() => {});
      await fs.promises.unlink(tmp).catch(() => {});
      // 동기 flush 가 대체했다(그 flush 가 tmp 를 지워 rename 이 ENOENT 가 되기도 한다) — 실패로 세지 않는다.
      if (e !== SUPERSEDED && gen === w.gen) {
        failed = true;
        w.dirty = true; w.failures += 1; w.lastError = { at: Date.now(), code: e?.code || 'error' }; // 원문(임시 파일 절대 경로)은 상태에 싣지 않는다 — 콘솔에만
        console.warn(`[idrac] 센서 상세 캐시 저장 실패: ${e?.message || e}`);
      }
    } finally {
      w.writing = false; w.tmp = null; w.inflight = null;
      // 쓰는 동안 바뀐 것은 한 번 더(같은 디바운스). 실패한 것은 다음 변경·종료 flush 가 다시 쓴다(재시도 루프를 만들지 않는다).
      if (w.dirty && !failed) persistSoon();
    }
  })();
}

/**
 * 동기 원자 저장(종료 flush · 테스트) — 진행 중인 비동기 쓰기를 대체한다. 쓸 것이 없으면(변경 없음 · 진행 중 쓰기 없음) 아무것도 안 한다.
 * 진행 중인 비동기 쓰기의 tmp 를 먼저 지운다 — 아직 커널에 닿지 않은 rename 은 ENOENT 로 실패하고(대체됨), 이미 끝난 rename 은 아래
 *   동기 쓰기가 덮는다(rename(2) 는 원자라 둘 중 하나다 — ipam/scanStore.js flushStore 와 같은 규칙).
 */
export function flushSensorDetailNow() {
  if (!w.dirty && !w.writing && !timer) return;
  if (timer) { clearTimeout(timer); timer = null; }
  w.gen += 1;
  if (w.writing && w.tmp) { try { fs.unlinkSync(w.tmp); } catch { /* 이미 rename 됐거나 아직 만들어지지 않았다 */ } }
  w.dirty = false;
  try {
    fs.mkdirSync(path.dirname(FILE()), { recursive: true });
    atomicWriteFileSync(FILE(), JSON.stringify(Object.fromEntries(collection)), { mode: 0o600 });
    w.writes += 1; w.lastWriteAt = Date.now(); w.lastError = null;
  } catch (e) {
    w.dirty = true; w.failures += 1; w.lastError = { at: Date.now(), code: e?.code || 'error' };
    console.warn(`[idrac] 센서 상세 캐시 저장 실패: ${e?.message || e}`);
  }
}
registerExitFlush('idrac/sensorDetailCache', flushSensorDetailNow);

/** 쓰기 상태(진단·테스트) — 경로는 싣지 않는다. */
export function sensorDetailWriteStatus() {
  return { dirty: w.dirty, writing: w.writing, pending: !!timer, writes: w.writes, failures: w.failures, lastWriteAt: w.lastWriteAt, lastWriteMs: w.lastWriteMs, lastError: w.lastError };
}

/** 매 폴 주기의 Thermal 상세(임계값 포함). 빈 목록이면 저장하지 않는다(직전 값을 지우지 않는다). */
export function setThermalDetail(serverId, list, at = Date.now()) {
  if (!serverId || !Array.isArray(list) || !list.length) return;
  thermal.set(String(serverId), { at, list: list.slice(0, SENSOR_LIST_MAX) });
}

/** Sensors 컬렉션 결과 — 성공·실패 모두 기록한다(실패는 직전 센서 목록을 지우지 않고 사유만 갱신). */
export function setSensorCollection(serverId, res, at = Date.now()) {
  if (!serverId || !res || typeof res !== 'object') return;
  load();
  const id = String(serverId);
  const prev = collection.get(id) || null;
  const good = Array.isArray(res.sensors) && res.sensors.length > 0;
  collection.set(id, {
    at,
    ok: !!res.ok,
    sensors: good ? res.sensors.slice(0, SENSOR_LIST_MAX).map(compactSensor).filter(Boolean) : (prev?.sensors || []),
    sensorsAt: good ? at : (prev?.sensorsAt || null),
    chassis: res.chassis ?? null, absent: res.absent ?? 0, failed: res.failed ?? 0,
    expanded: res.expanded ?? 0, notRead: res.notRead ?? 0,
    ...(res.error ? { error: String(res.error).slice(0, 300) } : {}),
  });
  persistSoon();
}

/** 컬렉션 재수집이 필요한가(없거나 maxAgeMs 보다 오래됨). */
export function sensorCollectionStale(serverId, maxAgeMs) {
  load();
  const c = collection.get(String(serverId));
  return !c || (Date.now() - (c.at || 0)) > maxAgeMs;
}

/**
 * 서버 한 대의 로컬 상세 — { list, omitted, thermalAt, collection:{…메타} } (둘 다 없으면 null).
 * v2.680 A-01: 컬렉션에만 있는 센서는 컬렉션 시각(sensorsAt)이 신선도 경계를 넘으면 `stale` 로 표시된다(mergeSensors).
 */
export function localSensorDetail(serverId, { now = Date.now() } = {}) {
  load();
  const id = String(serverId);
  const th = thermal.get(id) || null;
  const co = collection.get(id) || null;
  if (!th && !co) return null;
  const collList = (co?.sensors || []).map(expandCompact).filter(Boolean);
  const { list, omitted } = mergeSensors(collList, th?.list || [], { collAt: co?.sensorsAt ?? null, now });
  return {
    list, omitted,
    thermalAt: th?.at ?? null,
    collection: co ? { at: co.at, ok: co.ok, sensorsAt: co.sensorsAt ?? null, count: collList.length, chassis: co.chassis, absent: co.absent, failed: co.failed, expanded: co.expanded, notRead: co.notRead, error: co.error || '' } : null,
  };
}

/**
 * v2.680 E-01: CPU 사용률 판정 전용 — 컬렉션의 **퍼센트 센서만** 펼친다. 통합 추이 샘플러가 1분마다 전 서버를 도는데
 * CPU 사용률 센서는 컬렉션의 퍼센트 종류에서만 오므로(Thermal 에는 온도·팬뿐) 150개 전량을 펼칠 이유가 없다.
 * @returns {{ list: object[], collAt: number|null } | null}
 */
export function localCpuSensorDetail(serverId) {
  load();
  const id = String(serverId);
  const co = collection.get(id) || null;
  if (!co) return thermal.has(id) ? { list: [], collAt: null } : null;
  const list = [];
  for (const o of co.sensors || []) if (o && o.k === 'percent') { const x = expandCompact(o); if (x) list.push(x); }
  return { list, collAt: co.sensorsAt ?? null };
}

/** 엣지 export 용 콤팩트(중앙이 expandCompact 로 되돌린다). */
export function exportSensorDetail(serverId) {
  const d = localSensorDetail(serverId);
  if (!d || !d.list.length) return null;
  return {
    at: Math.max(d.thermalAt || 0, d.collection?.sensorsAt || 0) || null,
    thermalAt: d.thermalAt, collAt: d.collection?.sensorsAt ?? null,
    collOk: d.collection ? d.collection.ok : null,
    collError: d.collection?.error || '',
    omitted: d.omitted,
    list: d.list.map(compactSensor).filter(Boolean),
  };
}

export function removeSensorDetail(serverId) {
  load();
  thermal.delete(String(serverId));
  if (collection.delete(String(serverId))) persistSoon();
}

export function _resetSensorDetailForTest() {
  thermal.clear(); collection = new Map(); loaded = false;
  if (timer) { clearTimeout(timer); timer = null; }
  // 진행 중 비동기 쓰기는 rename 하지 않게 세대만 올린다(writing 은 그 쓰기가 스스로 내린다 — 강제로 내리면 두 쓰기가 겹친다)
  w.gen += 1; w.dirty = false; w.writes = 0; w.failures = 0; w.lastError = null; w.lastWriteAt = null; w.lastWriteMs = null;
}

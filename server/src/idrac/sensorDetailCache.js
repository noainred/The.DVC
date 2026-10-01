/**
 * iDRAC 센서 상세 캐시(v2.659) — 서버별 ① Thermal 상세(매 폴 주기, 인메모리) ② Sensors 컬렉션(인벤토리 주기, 파일 보관).
 *
 * ② 는 재시작 뒤에도 30분 동안 화면이 비지 않게 `idrac-sensor-cache.json` 에 남긴다. 이것은 **캐시**다 —
 *   손상되면 새로 시작하고(다음 인벤토리 주기가 다시 채운다) 원본을 보존하지 않는다(v2.516 활동 로그와 같은 판단,
 *   arch2582 CACHE_OK 에 사유와 함께 등재). 백업 '설정 변경' 감시에 잡히지 않게 상태 파일로 등록한다(v2.613).
 * ① 은 1분마다 바뀌므로 파일에 쓰지 않는다(재시작 직후 한 주기 동안 비는 것은 화면이 '센서 상세 수집 전' 으로 말한다).
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';
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
  try {
    if (!fs.existsSync(FILE())) return;
    const obj = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      for (const [k, v] of Object.entries(obj)) if (v && typeof v === 'object') collection.set(k, v);
    }
  } catch (e) {
    console.warn(`[idrac] 센서 상세 캐시를 읽지 못해 새로 시작합니다: ${e?.message || e}`);
    collection = new Map();
  }
}
function writeNow() {
  fs.mkdirSync(path.dirname(FILE()), { recursive: true });
  atomicWriteFileSync(FILE(), JSON.stringify(Object.fromEntries(collection)), { mode: 0o600 });
}
/**
 * 저장 디바운스(v2.680 E-03). 파일은 서버 1,000대 × 센서 150개면 약 18MB 이고 저장은 동기 stringify + 동기 원자 쓰기
 * (회당 150~350ms 실측)다. 인벤토리 재수집 구간 동안 10초마다 전량을 다시 쓰던 것을 60초로 늘렸다 — 이 파일은 캐시이고
 * 종료 시에는 exit flush 가 즉시 동기 저장한다(마지막 창을 잃지 않는다). 더 짧게 되돌리지 말 것.
 */
export const PERSIST_DEBOUNCE_MS = 60_000;
function persistSoon() {
  if (timer) return;
  timer = setTimeout(() => { timer = null; try { writeNow(); } catch { /* best effort — 캐시 */ } }, PERSIST_DEBOUNCE_MS);
  timer.unref?.();
}
registerExitFlush('idrac/sensorDetailCache', () => { if (!timer) return; clearTimeout(timer); timer = null; writeNow(); });

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

export function _resetSensorDetailForTest() { thermal.clear(); collection = new Map(); loaded = false; if (timer) { clearTimeout(timer); timer = null; } }

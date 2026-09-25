/**
 * central/edgeRecord.js — 엣지가 push 한 **장비 스냅샷 원소**의 수신 정리와, 그 보관 파일의 쓰기(v2.599).
 *
 * ⚠⚠ 왜 필요한가 — v2.599 감사 확정 결함(CEN-2599-03·04·05):
 *   ① 스토리지·PDU·SAN 스위치 수신이 원소를 `{ ...d, agent }` 로 **그대로** 저장했다. `name:{a:1}` 하나로
 *      중앙 화면이 `Minified React error #31`(객체를 글자로 렌더)로 통째로 죽었다 — 장비 이름·모델 같은
 *      **표시 필드는 글자여야 한다**. v2.548 partFaultEdge·svcmonEdge 가 이미 '엣지 보고를 믿지 않는다' 로
 *      만든 규약인데 이 세 수신에는 없었다.
 *   ② 공유 토큰 수신은 소유권 필터가 없어 `null`·`'x'`·`1` 원소가 `{agent}`·`{0:'x',agent}` 로 저장돼
 *      화면에 **deviceId 없는 유령 행**이 생겼다.
 *   ③ 엣지 수·장비 크기 상한이 없었고 **push 마다 전체 맵을 동기로** 파일에 썼다(실측: 14MB 장비 12개 →
 *      RSS 134→639MB, 파일 168MB, 13번째 push 동안 /api/health 1.89초 대기).
 *
 * 규칙(테스트가 하나씩 고정한다 — test/audit2599b.test.js):
 *  - 평범한 객체만 받는다. 식별자는 글자(또는 숫자)이고 1~128자, 제어문자·`__proto__` 류 금지.
 *  - 표시 필드(`DISPLAY_KEYS`)가 객체·배열이면 **null** 로 바꾼다(지어낸 글자를 넣지 않는다). 긴 글자는 자른다.
 *  - 숫자 필드(`capacity.*`·`ports.*`)는 `numOrNull` — '못 읽은 값' 을 0 으로 만들지 않는다(v2.561 규약).
 *  - 장비 하나의 직렬화 크기·엣지 하나의 합계 크기에 상한을 두고, **뺀 개수를 사유별로 밝힌다**(조용한 상한 금지).
 *  - 엣지 수 상한: 꽉 차면 **오래 조용한(기본 24시간) 엣지만** 밀어낸다. 모두 최근이면 새 이름을 **거절**한다 —
 *    공유 토큰 발신자가 이름을 바꿔 가며 보내 **실제 엣지의 기록을 밀어내지 못하게** 한다(v2.589 pullStats 와 같은 판단).
 *  - 파일 쓰기는 디바운스 + 비동기(tmp→rename) + 종료 시 동기 flush(central/inventory.js · fleet.js 와 같은 규약).
 */
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from '../util/atomicWrite.js';
import { registerExitFlush } from '../util/exitFlush.js';
import { numOrNull } from '../util/numOrNull.js';
import { capStr } from '../util/capStr.js'; // v2.606 TIM2606-02
import { registerStateFile } from '../util/stateFiles.js'; // v2.613 PERSIST2613-08

export const RESERVED_IDS = new Set(['__proto__', 'constructor', 'prototype']);
export const EDGE_DEVICE_MAX_BYTES = Math.max(64 * 1024, Number(process.env.CENTRAL_EDGE_DEVICE_MAX_BYTES) || 1024 * 1024);
export const EDGE_AGENT_MAX_BYTES = Math.max(1024 * 1024, Number(process.env.CENTRAL_EDGE_AGENT_MAX_BYTES) || 16 * 1024 * 1024);
export const EDGE_MAX_AGENTS = Math.max(8, Number(process.env.CENTRAL_EDGE_MAX_AGENTS) || 128);
export const EDGE_AGENT_EVICT_MS = Math.max(60 * 60_000, Number(process.env.CENTRAL_EDGE_AGENT_EVICT_MS) || 24 * 60 * 60_000);

/** 화면이 글자로 그리는 필드 — 객체·배열이면 null 로 바꾼다. */
export const DISPLAY_KEYS = Object.freeze([
  'id', 'deviceId', 'name', 'host', 'model', 'firmware', 'version', 'error', 'type', 'serial', 'serialNumber',
  'vendor', 'status', 'location', 'datacenterId', 'datacenter', 'site', 'wwn', 'mgmtIp', 'ip', 'collectMethod', 'note',
]);
/** 숫자여야 하는 중첩 필드 — [부모 키, 자식 키...]. 부모가 객체가 아니면 부모를 null 로. */
export const NUMERIC_PATHS = Object.freeze([
  ['capacity', 'totalBytes', 'usedBytes', 'freeBytes', 'pct'],
  ['ports', 'total', 'licensed', 'online', 'free', 'usedPct'],
  ['nodes', 'count', 'unhealthy'],
]);
const STR_MAX = 512;

export const isPlainObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);

/** 식별자로 쓸 수 있는 값이면 정규 글자, 아니면 ''. */
export function edgeId(v) {
  if (typeof v !== 'string' && !(typeof v === 'number' && Number.isFinite(v))) return '';
  const s = String(v).trim();
  // eslint-disable-next-line no-control-regex
  if (!s || s.length > 128 || RESERVED_IDS.has(s) || /[\u0000-\u001f\u007f]/.test(s)) return '';
  return s;
}

/** 표시 필드를 글자(또는 null)로 좁힌다 — 바꾼 필드 수를 돌려준다. `o` 를 제자리에서 고친다. */
export function scalarizeFields(o, keys = DISPLAY_KEYS, max = STR_MAX) {
  let n = 0;
  for (const k of keys) {
    if (!Object.hasOwn(o, k)) continue;
    const v = o[k];
    if (v == null) continue;
    if (typeof v === 'object' || typeof v === 'function') { o[k] = null; n += 1; }
    // v2.606(TIM2606-02): 잘라 평탄화 — `.slice` 는 원문(본문 최대 16MB)을 붙잡는다.
    else if (typeof v === 'string' && v.length > max) o[k] = capStr(v, max);
  }
  return n;
}

function numericPaths(o) {
  for (const [parent, ...kids] of NUMERIC_PATHS) {
    if (!Object.hasOwn(o, parent) || o[parent] == null) continue;
    if (!isPlainObj(o[parent])) { o[parent] = null; continue; }
    const c = { ...o[parent] };
    for (const k of kids) if (Object.hasOwn(c, k) && c[k] != null) c[k] = numOrNull(c[k]);
    o[parent] = c;
  }
}

/**
 * 엣지 장비 목록 정리.
 * @returns {{ devices: object[], dropped: {notObject:number, badId:number, tooLarge:number, overAgentBytes:number, overCount:number}, coerced:number }}
 */
export function sanitizeEdgeDevices(list, { idKey = 'deviceId', altIdKey = '', max = 500, deviceMaxBytes = EDGE_DEVICE_MAX_BYTES, agentMaxBytes = EDGE_AGENT_MAX_BYTES } = {}) {
  const dropped = { notObject: 0, badId: 0, tooLarge: 0, overAgentBytes: 0, overCount: 0 };
  let coerced = 0; let total = 0; let trimmed = 0;
  const devices = [];
  for (const d of Array.isArray(list) ? list : []) {
    if (!isPlainObj(d)) { dropped.notObject += 1; continue; }
    const id = edgeId(d[idKey]) || (altIdKey ? edgeId(d[altIdKey]) : '');
    if (!id) { dropped.badId += 1; continue; }
    if (devices.length >= max) { dropped.overCount += 1; continue; }
    const o = { ...d };
    coerced += scalarizeFields(o);
    if (Object.hasOwn(o, idKey)) o[idKey] = edgeId(o[idKey]) || null;
    if (altIdKey && Object.hasOwn(o, altIdKey)) o[altIdKey] = edgeId(o[altIdKey]) || null;
    numericPaths(o);
    let size;
    try { size = JSON.stringify(o).length; } catch { dropped.tooLarge += 1; continue; }
    if (size > deviceMaxBytes) {
      // v2.600(감사 RECENT2600-02): 큰 장비를 **통째로 버리지 않는다** — 상한을 넘는 주범은 대개 SAN 조닝(zone 4,000 ×
      //   멤버 · 별칭 8,000)이고 엣지의 문제 포트 축약은 조닝을 줄이지 않는다. 조닝을 잘라 맞추고 limited + 사유·개수를 싣는다.
      //   그래도 넘으면(조닝 없이도 큰 장비) 그때만 뺀다.
      const t = trimZoningToFit(o, deviceMaxBytes, { by: 'central' });
      if (!t) { dropped.tooLarge += 1; continue; }
      size = t.size; trimmed += 1;
    }
    if (total + size > agentMaxBytes) { dropped.overAgentBytes += 1; continue; }
    total += size;
    devices.push(o);
  }
  return { devices, dropped, coerced, bytes: total, trimmed };
}

/**
 * 장비 스냅샷의 조닝(zones 배열·aliases 맵)을 잘라 직렬화 크기를 `maxBytes` 아래로 맞춘다(v2.600 RECENT2600-02 — 순수, `o` 를 제자리에서 고친다).
 * 앞에서부터 들어가는 만큼 남기고(zone 먼저, 남는 자리에 별칭), `limited:true` + `trimmed{zonesOmitted, aliasesOmitted, by, reason}` 로
 * **뺀 개수를 밝힌다**(조용한 상한 금지 — 화면 sanZoningView 가 limited 를 읽는다). 조닝을 전부 비워도 넘으면 null(맞출 수 없다).
 * 조닝이 없거나 이미 맞으면 손대지 않고 `{ size, zonesOmitted:0, aliasesOmitted:0 }`.
 * @returns {{ size:number, zonesOmitted:number, aliasesOmitted:number } | null}
 */
export function trimZoningToFit(o, maxBytes, { by = 'central' } = {}) {
  const len = (x) => JSON.stringify(x).length;
  let size;
  try { size = len(o); } catch { return null; }
  if (size <= maxBytes) return { size, zonesOmitted: 0, aliasesOmitted: 0 };
  const z = o?.zoning;
  if (!isPlainObj(z)) return null;
  const zones = Array.isArray(z.zones) ? z.zones : [];
  const aliasEntries = isPlainObj(z.aliases) ? Object.entries(z.aliases) : [];
  const prevTrim = isPlainObj(z.trimmed) ? z.trimmed : null;
  const base = { ...z, zones: [], aliases: {}, limited: true, trimmed: { zonesOmitted: 0, aliasesOmitted: 0, by, reason: '' } };
  o.zoning = base;
  let baseSize;
  try { baseSize = len(o); } catch { o.zoning = z; return null; }
  if (baseSize > maxBytes) { o.zoning = z; return null; }
  let budget = maxBytes - baseSize - 256; // 사유 문구·쉼표 여유
  const keptZones = [];
  for (const row of zones) {
    let n; try { n = len(row) + 1; } catch { continue; }
    if (n > budget) break;
    keptZones.push(row); budget -= n;
  }
  const keptAliases = {};
  let aliasKept = 0;
  for (const [k, v] of aliasEntries) {
    let n; try { n = len(k) + len(v) + 2; } catch { continue; }
    if (n > budget) break;
    keptAliases[k] = v; budget -= n; aliasKept += 1;
  }
  const zonesOmitted = zones.length - keptZones.length + (Number(prevTrim?.zonesOmitted) || 0);
  const aliasesOmitted = aliasEntries.length - aliasKept + (Number(prevTrim?.aliasesOmitted) || 0);
  const who = by === 'edge' ? '엣지 전송' : '중앙 수신';
  o.zoning = {
    ...base, zones: keptZones, aliases: keptAliases,
    trimmed: {
      zonesOmitted, aliasesOmitted, by: prevTrim?.by && prevTrim.by !== by ? `${prevTrim.by}+${by}` : by,
      reason: `장비 1대 ${who} 상한(${Math.round(maxBytes / 1024)}KB)을 넘어 조닝 일부만 실었습니다 — zone ${zonesOmitted}개 · 별칭 ${aliasesOmitted}개 생략(개수 요약 counts 는 전체 기준)`,
    },
  };
  try { size = len(o); } catch { return null; }
  if (size > maxBytes) return null;
  return { size, zonesOmitted, aliasesOmitted };
}

export const droppedTotal = (d) => Object.values(d || {}).reduce((a, n) => a + (Number(n) || 0), 0);

/**
 * 엣지 수 상한 판정. 새 이름이 들어올 자리가 없으면 오래 조용한 엣지 하나를 밀어내고(그 이름을 돌려준다),
 * 모두 최근이면 거절한다. `atOf(rec)` 는 그 엣지의 마지막 보고 시각.
 * @returns {{ ok: boolean, evicted?: string }}
 */
export function admitAgent(map, key, { atOf = (r) => r?.at, now = Date.now(), maxAgents = EDGE_MAX_AGENTS, evictMs = EDGE_AGENT_EVICT_MS } = {}) {
  if (map.has(key) || map.size < maxAgents) return { ok: true };
  let oldest = null;
  for (const [k, v] of map) { const at = Number(atOf(v)) || 0; if (!oldest || at < oldest[1]) oldest = [k, at]; }
  if (oldest && now - oldest[1] > evictMs) { map.delete(oldest[0]); return { ok: true, evicted: oldest[0] }; }
  return { ok: false };
}

/**
 * 디바운스 + 비동기(tmp→rename) 파일 저장. 종료 시에는 대기 중인 저장을 동기로 끝낸다.
 * @returns {{ save(): void, flushSync(): void }}
 */
export function createDebouncedWriter(file, serialize, { delayMs = 2_000, name = path.basename(file) } = {}) {
  registerStateFile(file); // v2.613 PERSIST2613-08: 이 파일은 수신 캐시(상태)다 — 백업 변경 감시·엣지 설정 push 가 설정으로 보지 않게 스스로 등록
  let writeTimer = null; let writing = false; let dirty = false;
  const flushSync = () => {
    if (!writeTimer && !dirty && !writing) return; // 비동기 쓰기가 도는 중이면 그 rename 은 종료 뒤 오지 않는다 — 동기로 다시 쓴다
    if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
    dirty = false;
    atomicWriteFileSync(file, serialize(), { mode: 0o600 });
  };
  const run = () => {
    writeTimer = null;
    if (writing) { save(); return; } // 이전 쓰기 진행 중 — 다음 주기로 미룬다(늦게 끝난 옛 본문이 새 본문을 덮지 않게)
    let body;
    try { body = serialize(); } catch (e) { console.warn(`[${name}] 직렬화 실패: ${e?.message || e}`); return; }
    dirty = false; writing = true;
    const tmp = `${file}.tmp-${process.pid}`;
    fs.promises.mkdir(path.dirname(file), { recursive: true })
      .then(() => fs.promises.writeFile(tmp, body, { mode: 0o600 }))
      .then(() => fs.promises.rename(tmp, file))
      .catch((e) => { console.warn(`[${name}] 저장 실패: ${e?.message || e}`); dirty = true; return fs.promises.unlink(tmp).catch(() => {}); })
      .finally(() => { writing = false; });
  };
  function save() {
    dirty = true;
    if (writeTimer) return;
    writeTimer = setTimeout(run, delayMs);
    writeTimer.unref?.();
  }
  registerExitFlush(`central/${name}`, flushSync);
  return { save, flushSync };
}

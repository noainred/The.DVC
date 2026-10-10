/**
 * IP 스캔 설정(에이전트별) + 결과 저장소.
 * - 설정: config/ipam-scan.json → { agents: { [name]: cfg } }
 *     "__local__" = 이 포탈(중앙)에서 직접 스캔하는 설정.
 *     그 외 이름 = 해당 분산 에이전트가 중앙에서 읽어가 자기 사이트에서 스캔할 설정.
 * - 결과: config/ipam-scan-results.json (ip → 열린포트/서비스/호스트명/최근확인/agent)
 *   → IP 대장(ledger)이 이 결과를 병합해 물리/기타 서버 IP를 채운다.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config, clampIntervalMs } from '../config.js';
import { clampSetting } from '../util/clampSetting.js';
import { DEFAULT_PORTS, isIpv4 } from './scan.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { getOverrides } from './overrides.js';
import { getPolicies, isCoveredByAnyPolicy } from './rangePolicies.js';
import { registerExitFlush } from '../util/exitFlush.js'; // v2.582 ARCH-4: 디바운스 저장은 종료 시 동기 flush 를 등록한다
import { ipToNum } from '../util/ipv4.js';
import { numOrNull } from '../util/numOrNull.js';
import { makeSettingsLoadError } from '../util/settingsLoadError.js';
import { agentKeyOf, agentValueOf } from '../util/agentKey.js'; // v2.604 RECENT2604-01
import { registerStateFile } from '../util/stateFiles.js';
import { capStr } from '../util/capStr.js'; // v2.733: 엣지가 보낸 미완료 사유를 평탄화해 상주시킨다

const MAX_MERGE = 20_000; // 한 보고당 병합 상한(악의/오작동 에이전트의 대량 주입 방지)
// v2.603(감사 CEN2603-02): **전체** 상한. MAX_MERGE 는 한 호출에만 걸려, 배정 범위가 없는 토큰이 보고를 반복하면 results·history 가
//   무한히 쌓였다(그 IP 들이 원장 행이 되어 CEN2603-03 RangeError 로 이어졌다). 기본 262,144 = /14 한 개 분량. 넘치면 **새 IP 만**
//   받지 않고 개수를 돌려준다 — 이미 있는 IP(다른 엣지 것 포함)는 밀어내지 않는다(조용한 상한 금지 — 호출부가 응답·로그에 싣는다).
const _capEnv = numOrNull(process.env.IPAM_SCAN_RESULTS_MAX);
export const MAX_SCAN_IPS = _capEnv != null && _capEnv > 0 ? Math.floor(_capEnv) : 262_144;
const MAX_HIST_IPS = MAX_SCAN_IPS * 2; // 이력은 결과보다 오래 남는다(1년) — 여유를 둔다. v2.639: 바깥 호출부 0건(scanInfo.historyMax 로 나간다) — 내부 상수
let _histCapped = 0;   // 이력 상한으로 만들지 않은 이력 항목 수(누적 — scanInfo 가 밝힌다)
let _resultCount = 0;   // Object.keys(results).length 를 매 원소 세지 않게(v2.589 규약) — 새 IP 를 넣을 때만 늘린다
let _histCount = 0;

// v2.593(감사 DEPS-03): 손으로 쓴 사본이 '10..1.1'·'0x0a.1.1.1' 을 받았다 — IPv4 파서는 util/ipv4.js 하나다(v2.586).
const _ipNum = ipToNum;
// 운영자가 관리(수동 override 또는 대역 정책)하는 IP인지 판단하는 '예측자'를 1회 구성해 반환.
// 루프 안에서 매번 override 맵/정책 목록을 다시 읽지 않도록 컨텍스트를 캡처하고,
// 활성 정책이 하나도 없으면 findPolicy 자체를 건너뛴다(대다수 환경에서 O(N)로 동작).
function managedChecker() {
  const ovMap = getOverrides();
  const hasPolicies = getPolicies().some((p) => p.enabled !== false);
  // ⚠ 회귀 방지(v2.287, 확정 버그 #11): 여기서 findPolicy(ip, '') 를 쓰면 claimedVcenterId 가
  // 붙은(특정 법인 귀속) 대역정책이 스코프 불일치로 제외돼, 귀속 정책으로만 관리되는 IP 가
  // '미관리'로 오판되고 스캔 결과·이력이 보존기간 후 삭제됐다. 관리 여부는 귀속 무관(어떤 활성
  // 정책이든 덮으면 관리)으로 판단한다.
  return (ip) => (Object.prototype.hasOwnProperty.call(ovMap, ip)) || (hasPolicies && isCoveredByAnyPolicy(_ipNum(ip)));
}

const CFG = path.join(config.configDir, 'ipam-scan.json');
const RES = path.join(config.configDir, 'ipam-scan-results.json');
// v2.674: 에이전트별 마지막 스캔 보고(시각·스캔 수·응답 수)라 **상태 파일**이다. 등록하지 않으면 엣지가 보고할 때마다
//   백업의 '설정 변경' 감시가 반응해 change 백업이 보관 슬롯을 채웠다(v2.590 P1 · v2.613 PERSIST2613-01 과 같은 유형).
const REP = path.join(config.configDir, 'ipam-scan-agents.json');   // ⚠ 리터럴 형태 유지 — scripts/config-doc.mjs 가 이 모양으로 파일을 찾는다
registerStateFile(REP);
const HIST = path.join(config.configDir, 'ipam-scan-history.json');
export const LOCAL = '__local__';

const MAX_EVENTS = 200;             // IP당 보관 이벤트 수(가장 오래된 것부터 삭제)
const HISTORY_RETENTION_MS = 365 * 86_400_000; // 1년 넘게 안 보인 IP는 이력에서 제거(무한 증식 방지)

const DEFAULTS = {
  enabled: false, ranges: [], ports: DEFAULT_PORTS,
  intervalMs: 3_600_000, concurrency: 128, timeoutMs: 700, reverseDns: true, ping: false, retentionDays: 30,
};

const clamp = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
// ⚠ v2.583 감사 #23: 손상 파일을 **조용히** 기본값으로 넘기면 다음 디바운스 저장이 온전했던 원본(사용자가 입력한
//   에이전트별 스캔 범위·포트, 1년치 up/down 이력)을 빈 값으로 덮어쓴다. 보존(.corrupt.<ts>) + 경고 후 기본값.
function readJson(file, dflt) {
  if (!fs.existsSync(file)) return dflt;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    preserveCorrupt(file, e?.message || String(e));
    console.warn(`[ipam] ${path.basename(file)} 파싱 실패(${e?.message || e}) — 손상본을 .corrupt 로 보존하고 기본값으로 시작합니다.`);
    return dflt;
  }
}

// ---- 디바운스 원자적 쓰기 ---------------------------------------------------
// 분산 에이전트가 POST /ip-scan-result로 보고할 때마다 전체 results.json·history.json을
// '동기' writeFileSync 하던 것을 제거한다. 30개 에이전트 동시 보고 시 매 보고가 대형 JSON을
// 동기 직렬화·기록 → 이벤트 루프 블로킹(고RTT 환경 취약). 대신 dirty 플래그를 세우고 짧게
// 디바운스해 '한 번'만 atomicWriteFileSync(임시파일+rename)로 기록한다. 프로세스 종료 시
// flushAllNow()로 잔여 dirty를 동기 보존(데이터 유실 방지).
// v2.605(감사 TIM2605-04): env 를 그대로 setTimeout 에 넣으면 음수·2^31 초과가 **1ms** 가 되어 디바운스가 사라진다
//   (버스트마다 대형 JSON 동기 직렬화 — 위 블로킹 사고가 되살아난다). [100ms, 10분] 에 가둔다(종료 시 flush 가 있으니 상한은 유실이 아니라 지연).
export function writeDebounceMsFromEnv(raw) {
  return Math.min(600_000, clampIntervalMs(raw == null || String(raw).trim() === '' ? NaN : Number(raw), 1500, 100));
}
const WRITE_DEBOUNCE_MS = writeDebounceMsFromEnv(process.env.IPAM_WRITE_DEBOUNCE_MS);
/*
 * v2.731(점검 A6-01 — 재현): 위 머리말의 '동기 블로킹 제거' 는 사실이 아니었다. 디바운스는 버스트를 한 번으로 묶을 뿐이고 그 한 번이
 *   **결과 맵 전체 + 이력 맵 전체**를 들여쓰기 JSON 으로 메인 스레드에서 직렬화하고 fsync 했다 — 엣지 보고 1건(1/28)마다
 *   5만 IP 에서 336~480ms(이벤트 5개면 640~1,005ms), 설계 상한(26만 IP) 근처면 수 초 동안 포탈 전체가 멈췄다.
 *   이제 ① 들여쓰기를 뺀다 ② 결과·이력(IP 키 맵)은 항목을 조각으로 직렬화해 파일에 이어 쓰고 조각 사이에서 양보한다(시간 기준 —
 *   `WRITE_SLICE_MS`) ③ tmp → fsync → rename 을 **비동기**로 한다(진행 중 쓰기는 파일마다 1건 — 그 사이 바뀐 것은 dirty 로 다음 회차)
 *   ④ 종료 flush(`flushAllNow`)는 예전처럼 **동기**다(exit 훅에서 비동기는 실행되지 않는다 — util/exitFlush.js). 동기 flush 가
 *   진행 중 비동기 쓰기를 대체하면(세대 `gen`) 그 쓰기는 rename 하지 않는다 — 옛 본문이 새 본문을 덮지 않게(bulletin/store.js 와 같은 규칙).
 *   ⑤ lastSeen 만 바뀐 보고는 더 긴 디바운스(`SEEN_ONLY_DEBOUNCE_MS`)로 묶는다 — 그 값은 재시작 때 해제(down) 판정의 기준인데
 *   판정 임계는 최소 3시간(scanPoller releaseIdleMs)이라 몇 분 늦게 쓰여도 판정이 바뀌지 않는다. 내용 변화(새 IP·포트·서비스·
 *   호스트명·에이전트·up/down 전이)는 예전 디바운스 그대로다.
 *   조각 직렬화 결과는 변경이 없으면 `JSON.stringify(맵)` 과 **바이트 단위로 같다**(키 순서 동일 — 테스트가 고정). 쓰는 도중 바뀐 항목은
 *   그때 값으로 쓰이고(항목 하나는 한 번에 직렬화된다) dirty 가 다음 쓰기를 예약한다.
 */
const SEEN_ONLY_DEBOUNCE_MS = Math.min(600_000, Math.max(WRITE_DEBOUNCE_MS, 300_000));
const WRITE_SLICE_MS = 8;              // 조각 하나를 만드는 데 쓰는 최대 시간(이만큼 돌았으면 파일로 내보내며 양보한다)
const WRITE_CHUNK_CHARS = 256 * 1024;  // 조각 하나의 최대 길이(문자)
const TMP_TAG = '.atmp-';              // 비동기 쓰기 임시 파일 표지(동기 원자 쓰기의 '.tmp-' 와 겹치지 않게)
const SUPERSEDED = Symbol('superseded'); // 동기 flush 가 진행 중 비동기 쓰기를 대체했다
let _tmpSeq = 0;
const _stores = new Map(); // file -> { getData, map, dirty, urgent, timer, due, writing, gen, tmp, inflight, writes, failures, lastError, lastWriteAt, lastWriteMs }

/** @param {boolean} map 최상위가 IP 키 맵(결과·이력)이면 true — 항목 조각 직렬화 대상 */
function registerStore(file, getData, map = false) {
  _stores.set(file, { getData, map, dirty: false, urgent: false, timer: null, due: 0, writing: false, gen: 0, tmp: null, inflight: null, writes: 0, failures: 0, lastError: null, lastWriteAt: null, lastWriteMs: null });
}
/**
 * @param {string} file
 * @param {boolean} [seenOnly] lastSeen 만 바뀐 변경 — 긴 디바운스로 묶는다(내용 변경이 하나라도 오면 짧은 디바운스로 당긴다)
 */
function scheduleWrite(file, seenOnly = false) {
  const st = _stores.get(file);
  if (!st) return;
  st.dirty = true;
  if (!seenOnly) st.urgent = true;
  if (st.writing) return; // 진행 중인 쓰기가 끝나면 dirty 를 보고 다시 예약한다(늦게 끝난 옛 본문이 새 본문을 덮지 않게 — 파일마다 1건)
  const delay = st.urgent ? WRITE_DEBOUNCE_MS : SEEN_ONLY_DEBOUNCE_MS;
  const due = Date.now() + delay;
  if (st.timer) { if (due >= st.due) return; clearTimeout(st.timer); } // 이미 예약됨 → 버스트를 1회로 합침(더 이른 예약만 당긴다)
  st.due = due;
  st.timer = setTimeout(() => { st.timer = null; st.due = 0; startWrite(file); }, delay);
  st.timer.unref?.();
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

/** 조각 직렬화 — 최상위 맵의 항목을 `JSON.stringify(맵)` 과 같은 모양으로 이어 쓰며 시간 기준으로 양보한다. */
async function writeMapChunks(fh, data, st, gen) {
  const keys = Object.keys(data); // 시작 시점의 키 — 이후 조각마다 그때 값을 읽는다(지운 키는 건너뛴다 · 새 키는 dirty 가 다음 회차에 쓴다)
  const own = Object.prototype.hasOwnProperty;
  let buf = '{'; let first = true; let started = performance.now();
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (!own.call(data, k)) continue;
    const s = JSON.stringify(data[k]);
    if (s === undefined) continue; // JSON.stringify(맵) 도 이 항목을 뺀다
    buf += (first ? '' : ',') + JSON.stringify(k) + ':' + s;
    first = false;
    if (buf.length >= WRITE_CHUNK_CHARS || performance.now() - started >= WRITE_SLICE_MS) {
      await writeAllAsync(fh, buf); // 파일 쓰기(스레드풀)를 기다리는 동안 이벤트 루프가 다른 일을 한다 — 이것이 양보다
      buf = '';
      if (gen !== st.gen) throw SUPERSEDED;
      started = performance.now();
    }
  }
  await writeAllAsync(fh, `${buf}}`);
}

function startWrite(file) {
  const st = _stores.get(file);
  if (!st || !st.dirty || st.writing) return;
  st.dirty = false; st.urgent = false; st.writing = true;
  const gen = ++st.gen;
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}${TMP_TAG}${process.pid}-${++_tmpSeq}`);
  st.tmp = tmp;
  const t0 = performance.now();
  st.inflight = (async () => {
    let fh = null; let failed = false;
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      fh = await fs.promises.open(tmp, 'w', 0o600);
      if (st.map) await writeMapChunks(fh, st.getData(), st, gen);
      else await writeAllAsync(fh, JSON.stringify(st.getData())); // 보고 기록·실행 이력 — 작다(수십~200 항목)
      await fh.sync();
      await fh.close(); fh = null;
      if (gen !== st.gen) throw SUPERSEDED;
      await fs.promises.chmod(tmp, 0o600).catch(() => {});
      await fs.promises.rename(tmp, file);
      try { const d = await fs.promises.open(dir, 'r'); try { await d.sync(); } finally { await d.close(); } } catch { /* 디렉터리 fsync 미지원 */ }
      if (gen === st.gen) { st.writes += 1; st.lastWriteAt = Date.now(); st.lastWriteMs = Math.round(performance.now() - t0); st.lastError = null; }
    } catch (e) {
      if (fh) await fh.close().catch(() => {});
      await fs.promises.unlink(tmp).catch(() => {});
      // 동기 flush 가 대체했다(그 flush 가 tmp 를 지워 rename 이 ENOENT 가 되기도 한다) — 실패로 세지 않는다.
      if (e !== SUPERSEDED && gen === st.gen) {
        failed = true;
        st.dirty = true; st.failures += 1; st.lastError = { at: Date.now(), code: e?.code || 'error' }; // 원문(임시 파일 절대 경로)은 상태에 싣지 않는다 — 콘솔에만
        console.warn(`[ipam] 저장 실패(${path.basename(file)}): ${e?.message || e}`);
      }
    } finally {
      st.writing = false; st.tmp = null; st.inflight = null;
      // 쓰는 동안 바뀐 것은 한 번 더(예전과 같은 디바운스). 실패한 것은 예전처럼 다음 변경·종료 flush 가 다시 쓴다(실패 재시도 루프를 만들지 않는다 — 큰 맵을 1.5초마다 다시 직렬화하지 않게).
      if (st.dirty && !failed) scheduleWrite(file, !st.urgent);
    }
  })();
}

/** 동기 원자 쓰기(종료 flush·테스트). 진행 중인 비동기 쓰기를 대체한다. */
function flushStore(file) {
  const st = _stores.get(file);
  if (!st || (!st.dirty && !st.writing)) return;
  if (st.timer) { clearTimeout(st.timer); st.timer = null; st.due = 0; }
  st.gen += 1; // 진행 중인 비동기 쓰기를 무효화한다(그 쓰기는 rename 하지 않는다)
  // 진행 중인 비동기 쓰기의 tmp 를 먼저 지운다 — 아직 커널에 닿지 않은 rename 은 ENOENT 로 실패하고(대체됨), 이미 끝난 rename 은
  //   아래 동기 쓰기가 덮는다(rename(2) 는 원자라 둘 중 하나다). bulletin/store.js flushSync 와 같은 규칙.
  if (st.writing && st.tmp) { try { fs.unlinkSync(st.tmp); } catch { /* 이미 rename 됐거나 아직 만들어지지 않았다 */ } }
  st.dirty = false; st.urgent = false;
  try { atomicWriteFileSync(file, JSON.stringify(st.getData()), { mode: 0o600 }); st.writes += 1; st.lastWriteAt = Date.now(); st.lastError = null; }
  catch (e) { st.dirty = true; st.failures += 1; st.lastError = { at: Date.now(), code: e?.code || 'error' }; console.warn(`[ipam] 저장 실패(${path.basename(file)}): ${e.message}`); }
}
/** 모든 dirty 저장소를 즉시 동기 기록(프로세스 종료 직전 데이터 보존용). */
export function flushAllNow() { for (const file of _stores.keys()) flushStore(file); }
/**
 * 예약된 쓰기를 기다리지 않고 지금 비동기로 쓰고, 진행 중인 쓰기가 전부 끝날 때까지 기다린다(테스트·측정용 — 운영 경로는 디바운스가 쓴다).
 * @returns {Promise<void>}
 */
export async function flushScanStoreAsync() {
  for (let round = 0; round < 10; round++) {
    let busy = false;
    for (const [file, st] of _stores) {
      if (st.timer) { clearTimeout(st.timer); st.timer = null; st.due = 0; }
      if (st.dirty && !st.writing) startWrite(file);
      if (st.inflight) { busy = true; await st.inflight; }
    }
    if (!busy && [..._stores.values()].every((s) => !s.dirty || s.lastError)) return;
  }
}
/** 파일별 쓰기 상태(진단·테스트) — 경로는 싣지 않는다(파일 이름만). */
export function scanStoreWriteStatus() {
  const out = {};
  for (const [file, st] of _stores) out[path.basename(file)] = { dirty: st.dirty, writing: st.writing, pending: !!st.timer, writes: st.writes, failures: st.failures, lastWriteAt: st.lastWriteAt, lastWriteMs: st.lastWriteMs, lastError: st.lastError };
  return out;
}
// 이전 프로세스가 비동기 쓰기 도중 끝나 남긴 임시 파일을 치운다(이 모듈의 표지가 붙은 것만).
try {
  for (const n of fs.readdirSync(config.configDir)) {
    if (/^\.ipam-scan-(results|history|agents|runs)\.json\.atmp-/.test(n)) { try { fs.unlinkSync(path.join(config.configDir, n)); } catch { /* */ } }
  }
} catch { /* 설정 디렉터리가 아직 없다 */ }
let _exitHooked = false;
function ensureExitFlush() {
  if (_exitHooked) return; _exitHooked = true;
  // v2.447(감사 I3): 시그널에서는 flush 만 — process.exit 를 부르면 index.js 의 정상 종료가
  // 실행되지 못한다(진행 중 HTTP 응답이 끊김). 'exit' 훅이 있어 flush 자체는 보장된다.
  // v2.582 ARCH-4: 공용 레지스트리(util/exitFlush.js) — 시그널 훅은 index.js gracefulExit 이 process.exit 으로 exit 를 낸다.
  registerExitFlush('ipam/scanStore', flushAllNow);
}

function normalizeCfg(p = {}) {
  return {
    enabled: !!p.enabled,
    ranges: Array.isArray(p.ranges) ? p.ranges.filter(Boolean) : [],
    ports: Array.isArray(p.ports) && p.ports.length ? p.ports.map(Number).filter((n) => n > 0 && n < 65536) : DEFAULT_PORTS,
    intervalMs: clamp(p.intervalMs, 60_000, 7 * 86_400_000, DEFAULTS.intervalMs),
    concurrency: clamp(p.concurrency, 1, 1024, DEFAULTS.concurrency),
    timeoutMs: clamp(p.timeoutMs, 100, 10_000, DEFAULTS.timeoutMs),
    reverseDns: p.reverseDns !== false,
    // ICMP ping 병행(v2.359) — 포트가 전부 닫힌 서버도 생존 감지. v2.360: 기본 OFF(opt-in).
    // 프로세스/FD 폭주로 포탈이 먹통이 된 장애(v2.359) 이후, 명시적으로 켤 때만 동작하고
    // 켜더라도 ping 전용 동시성 상한(scan.js PING_MAX)으로 소수만 동시에 실행된다.
    ping: p.ping === true,
    retentionDays: clamp(p.retentionDays, 0, 3650, DEFAULTS.retentionDays),
    // v2.638: 이 에이전트가 찾은 IP 를 귀속시킬 DataCenter(비우면 자동 — ipam/scanDatacenter.js). 엣지는 이 칸을 쓰지 않는다.
    datacenterId: typeof p.datacenterId === 'string' ? p.datacenterId.trim().slice(0, 64) : '',
  };
}

/*
 * v2.632(감사 EDGE2632-03): 스캔 **설정**(ipam-scan.json — 엣지에 배정이 배포된다)의 로드 오류 상태. 손상 → 보존 → 빈 설정이면
 *   /api/central/ip-scan-assignment 가 assigned:false 로 답해 전 엣지 스캔이 멈췄다(원인은 손상). 오류면 그 라우트가 503 으로 답한다.
 *   재시작 뒤 보존본만 남은 경우도 못 읽은 것이다. 저장(saveAll)만 해제한다.
 */
const _cfgLoadErr = makeSettingsLoadError(() => CFG, { label: 'IP 스캔 배정', confirm: () => saveAll(loadAll()) });
/** 스캔 설정 파일을 못 읽었으면 { at, reason }, 읽었으면 null. */
export function scanSettingsLoadError() { loadAll(); return _cfgLoadErr.get(); }

function readCfg() {
  if (!fs.existsSync(CFG)) { _cfgLoadErr.missing(); return {}; }
  try {
    const j = JSON.parse(fs.readFileSync(CFG, 'utf8'));
    if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('객체가 아닌 JSON 값');
    _cfgLoadErr.ok();
    return j;
  } catch (e) {
    _cfgLoadErr.corrupt(e);
    preserveCorrupt(CFG, e?.message || String(e));
    console.warn(`[ipam] ${path.basename(CFG)} 파싱 실패(${e?.message || e}) — 손상본을 .corrupt 로 보존하고 기본값으로 시작합니다.`);
    return {};
  }
}

/*
 * v2.639(감사 I3): 설정 파일(ipam-scan.json)은 (mtime,size) 토큰 캐시다 — 예전에는 loadScanSettings·listScanAgents 가 **호출마다**
 *   readFileSync + JSON.parse 였다(원장 재구성·폴러·릴리스 타이머·설정 pull 이 부른다). rangeStore·datacenter/store 와 같은 방식.
 *   ⚠ 이 파일은 디바운스 저장소(_stores)에 **없다** — 결과·이력·보고·실행 이력만 디바운스이고 설정은 saveAll 이 즉시 원자 쓰기 한다.
 *   그래서 '메모리에는 있는데 파일에는 아직 없는 값' 과 mtime 캐시가 어긋날 경로가 없다(saveAll 이 캐시를 직접 세운다 — 같은 ms
 *   저장이어도 stat 을 다시 읽지 않고 방금 쓴 객체를 그대로 캐시로 둔다).
 *   파일이 없을 때(토큰 '')는 캐시하지 않는다 — readCfg 의 missing() 판정(.corrupt 보존본만 남았는가)을 매번 다시 보게.
 */
let _cfgCache = null;
let _cfgTok = '';
const cfgTok = () => { try { const st = fs.statSync(CFG); return `${st.mtimeMs}:${st.size}`; } catch { return ''; } };

function loadAll() {
  const tok = cfgTok();
  if (tok && _cfgCache && tok === _cfgTok) return _cfgCache;
  const p = readCfg();
  // 구버전(단일 설정) 마이그레이션: 최상위에 ranges가 있으면 __local__로 이전.
  const all = (!p.agents && (p.ranges || p.enabled !== undefined))
    ? { agents: { [LOCAL]: normalizeCfg(p) } }
    : { agents: p.agents && typeof p.agents === 'object' ? p.agents : {} };
  if (tok) { _cfgCache = all; _cfgTok = tok; } else { _cfgCache = null; _cfgTok = ''; }
  return all;
}

function saveAll(all) {
  fs.mkdirSync(path.dirname(CFG), { recursive: true });
  atomicWriteFileSync(CFG, JSON.stringify(all, null, 2));
  _cfgLoadErr.ok();
  _cfgCache = all; _cfgTok = cfgTok(); // 쓰기 성공 뒤에만 — 실패하면 캐시는 옛 값(디스크와 같다)
}

/** 한 에이전트(기본=로컬)의 설정. */
export function loadScanSettings(agent = LOCAL) {
  const all = loadAll();
  // v2.604(감사 RECENT2604-01 — 재현): 이름은 **대소문자 무시**로 찾는다(util/agentKey.js — v2.597 L2597-03 과 같은 규칙).
  //   예전에는 글자 그대로라 설정이 'edge-seoul', 토큰이 'Edge-Seoul' 이면 배정(?agent=)은 200 assigned:true 인데 결과
  //   (토큰 이름)는 범위 0 → v2.603 의 409 unassigned 로 **스캔은 돌고 결과만 전량 거부**됐다.
  return normalizeCfg(agentValueOf(all.agents, agent) || {});
}

/** 에이전트별 설정 저장(부분 업데이트). */
export function saveScanSettings(agent, partial = {}) {
  const all = loadAll();
  // v2.604 RECENT2604-01: 대소문자만 다른 기존 키가 있으면 그 키를 갱신한다(같은 엣지의 설정이 두 벌로 갈라지지 않게).
  const key = agentKeyOf(all.agents, agent) ?? agent;
  const cur = normalizeCfg(all.agents[key] || {});
  const next = { ...cur };
  if (partial.enabled !== undefined) next.enabled = !!partial.enabled;
  if (partial.ranges !== undefined) next.ranges = (Array.isArray(partial.ranges) ? partial.ranges : String(partial.ranges).split(/[\n,]/)).map((s) => String(s).trim()).filter(Boolean);
  if (partial.ports !== undefined) { const arr = (Array.isArray(partial.ports) ? partial.ports : String(partial.ports).split(/[\s,]+/)).map(Number).filter((n) => n > 0 && n < 65536); if (arr.length) next.ports = arr; }
  // v2.605(감사 LEFT2605-06 — 재현): 숫자 칸의 빈 값·숫자 아님은 **미지정**(이전 값 유지)이다. 예전 clamp(Number('')=0) 는
  //   주기 12시간 → 1분(전 대역 스캔이 1분마다) · 동시성 → 1 · 보존 90일 → 0(정리 안 함)이 됐다(오류 없이 '저장됨').
  //   명시적 숫자만 값이다(명시적 0 보존일 = 정리 안 함 — 화면 min={0} 으로 허용된 값). util/clampSetting.js(v2.595).
  if (partial.intervalMs !== undefined) next.intervalMs = clampSetting(partial.intervalMs, { min: 60_000, max: 7 * 86_400_000, def: cur.intervalMs });
  if (partial.concurrency !== undefined) next.concurrency = clampSetting(partial.concurrency, { min: 1, max: 1024, def: cur.concurrency });
  if (partial.timeoutMs !== undefined) next.timeoutMs = clampSetting(partial.timeoutMs, { min: 100, max: 10_000, def: cur.timeoutMs });
  if (partial.reverseDns !== undefined) next.reverseDns = !!partial.reverseDns;
  if (partial.ping !== undefined) next.ping = !!partial.ping; // v2.359 — 누락 시 저장이 조용히 무시됨
  if (partial.retentionDays !== undefined) next.retentionDays = clampSetting(partial.retentionDays, { min: 0, max: 3650, def: cur.retentionDays });
  // v2.638: 데이터센터 귀속(빈 값 = 자동). 존재 여부는 라우트가 등록부로 검사한다(여기는 형식만).
  if (partial.datacenterId !== undefined) next.datacenterId = typeof partial.datacenterId === 'string' ? partial.datacenterId.trim().slice(0, 64) : '';
  saveAll({ ...all, agents: { ...all.agents, [key]: next } }); // v2.639 I3: 캐시 객체를 제자리에서 고치지 않는다(쓰기 실패 시 메모리≠디스크 방지)
  return next;
}

/**
 * v2.694: 에이전트 등록 삭제 — 스캔 설정 항목(대역·포트·주기)과 마지막 보고 기록을 지운다(대소문자 무시로 찾는다).
 *   엣지는 다음 배정 조회(/api/central/ip-scan-assignment)에서 assigned:false 를 받아 스캔을 멈춘다.
 *   ⚠ 이 에이전트가 이미 보고한 스캔 결과·실행 이력은 지우지 않는다 — 결과는 보존 기간·해제 판정으로 정리된다(관리상태가 붙은 IP 를 같이 지우지 않게).
 *   이 포탈(__local__)은 지우지 않는다(라우트가 대역만 비우게 한다).
 * @returns {{ removedSettings:boolean, removedReport:boolean, ranges:string[] }}
 */
export function deleteScanAgent(agent) {
  const all = loadAll();
  const key = agentKeyOf(all.agents, agent);
  const ranges = key != null ? normalizeCfg(all.agents[key] || {}).ranges : [];
  let removedSettings = false;
  if (key != null) {
    const agents = { ...all.agents };
    delete agents[key];
    saveAll({ ...all, agents });
    removedSettings = true;
  }
  const rk = agentKeyOf(reports, agent);
  let removedReport = false;
  if (rk != null) { delete reports[rk]; scheduleWrite(REP); removedReport = true; }
  return { removedSettings, removedReport, ranges };
}

export function listScanAgents() {
  const all = loadAll();
  return Object.keys(all.agents).map((name) => ({ name, ...normalizeCfg(all.agents[name]) }));
}

// ---- 결과 ----------------------------------------------------------------
// v2.601(감사 CEN2601-01): 엣지가 보낸 alive[] 원소는 **아는 필드·타입만** 담는다. 예전에는 openPorts·
//   services·hostname 을 받은 그대로 저장해, 원소 하나({openPorts:{a:1}, services:'x', hostname:{}})가
//   대장(ledger.js)의 .join/.map 에서 던져 **매 주기 ipam.db 저장이 실패**하고 /tools/ipam/insights 가 500 이었다.
//   정제는 저장 함수 안에 둔다(라우트가 아니라 — 디스크에서 읽은 옛 파일도 같은 정제를 거친다. v2.598 CENTRAL 규약).
const MAX_PORTS = 256, MAX_SERVICES = 64, MAX_SVC_LEN = 64, MAX_HOST_LEN = 255;
// eslint-disable-next-line no-control-regex
const CTRL_RE = /[\u0000-\u001f\u007f]/g;
function cleanPorts(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const p of v) {
    if (out.length >= MAX_PORTS) break;
    if (typeof p !== 'number' && typeof p !== 'string') continue;
    const n = Number(p);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) out.push(n);
  }
  return out;
}
function cleanServices(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const s of v) {
    if (out.length >= MAX_SERVICES) break;
    if (typeof s !== 'string' && typeof s !== 'number') continue;
    const t = String(s).replace(CTRL_RE, '').slice(0, MAX_SVC_LEN);
    if (t) out.push(t);
  }
  return out;
}
function cleanHostname(v) {
  return typeof v === 'string' ? v.replace(CTRL_RE, '').slice(0, MAX_HOST_LEN) : '';
}
/** alive 원소 하나를 아는 필드로 좁힌다(순수). ip 는 호출부가 isIpv4 로 검사한다. v2.639: 바깥 호출부 0건(테스트도 mergeScanResults 로 검사한다) — 내부 함수. */
function cleanAliveHost(h) {
  return { ip: h.ip, openPorts: cleanPorts(h.openPorts), services: cleanServices(h.services), hostname: cleanHostname(h.hostname) };
}
// v2.639(감사 I2): 결과에 나오는 에이전트 이름 → IP 수. 데이터센터 귀속 판정(scanDatacenterSource)이 '결과에 나오는 에이전트
//   집합' 을 매번 26만 개를 훑어 모으던 것을(실측 약 150ms) 적재·정리 시점에 유지한다. 갱신 지점은 셋뿐이다 — 로드 정제·
//   mergeScanResults(새 IP·에이전트 교체)·pruneScanResults(삭제). results 를 다른 곳에서 고치면 여기도 함께.
const _agentCount = new Map();
function bumpAgent(agent, d) {
  const k = agent || LOCAL;
  const n = (_agentCount.get(k) || 0) + d;
  if (n > 0) _agentCount.set(k, n); else _agentCount.delete(k);
}
function cleanStoredResults(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [ip, r] of Object.entries(raw)) {
    if (!r || typeof r !== 'object' || !isIpv4(ip)) continue;
    out[ip] = { ...cleanAliveHost({ ...r, ip }), lastSeen: numOrNull(r.lastSeen) ?? 0, agent: typeof r.agent === 'string' ? r.agent : LOCAL };
    bumpAgent(out[ip].agent, 1);
  }
  return out;
}
let results = cleanStoredResults(readJson(RES, {}));
_resultCount = Object.keys(results).length;
registerStore(RES, () => results, true);
ensureExitFlush();

let scanRevN = 0; // 스캔 결과/이력 변경 리비전(대장 캐시 무효화 키)
export function scanRev() { return scanRevN; }
export function getScanResults() { return results; }
const cmpScanIp = (a, b) => (a.ip < b.ip ? -1 : 1);
export function scanResultList() { return Object.values(results).sort(cmpScanIp); }
/** 스캔 결과 IP 수(세지 않는다 — 적재·정리 때 유지하는 값). v2.731: 원장 동기화가 동기/양보 경로를 고를 때 쓴다. */
export function scanResultCount() { return _resultCount; }
/**
 * v2.731(점검 A6-02): `scanResultList()` 와 **같은 순서**를 시간 기준으로 양보하며 만든다 — 26만 개를 한 번에 정렬하면
 *   그 한 번이 수백 ms 다(20만 개 270~330ms 실측). 조각(8,192개)마다 정렬하고 인접 조각끼리 병합한다. 결과 객체의 ip 는 키라
 *   유일하므로 정렬 결과가 하나뿐이다 — 조각 정렬 + 병합과 한 번 정렬의 결과가 같다(테스트가 대조한다).
 *   목록은 시작 시점의 키로 만들고 값은 읽는 순간의 객체다(양보 사이 바뀐 내용은 scanRev 가 오르므로 호출부가 결과를 버린다 —
 *   ledger.js buildIpamRowsAsync. lastSeen 만 바뀐 객체는 더 새 값으로 들어간다).
 * @param {() => Promise<boolean>} maybeYield util/timeSlice.js createYielder
 * @param {() => boolean} [isCancelled] 참이면 중간에 멈추고 null
 * @returns {Promise<object[]|null>}
 */
export async function scanResultListAsync(maybeYield, isCancelled = () => false) {
  // Object.values(결과) 한 번은 20만 개에서 130~144ms 다(Object.keys 는 약 50ms) — 키만 한 번에 받고 값은 조각마다 읽는다.
  //   그 사이 바뀐 항목은 그때 객체(지운 키는 건너뛴다) — 변경이 없으면 Object.values 와 같은 목록이다.
  const keys = Object.keys(results);
  const vals = [];
  for (let i = 0; i < keys.length; i++) {
    const v = results[keys[i]];
    if (v) vals.push(v);
    if ((i & 4095) === 4095 && (await maybeYield()) && isCancelled()) return null;
  }
  const CH = 8192;
  let runs = [];
  for (let i = 0; i < vals.length; i += CH) {
    runs.push(vals.slice(i, i + CH).sort(cmpScanIp));
    if ((await maybeYield()) && isCancelled()) return null;
  }
  while (runs.length > 1) {
    const next = [];
    for (let i = 0; i < runs.length; i += 2) {
      if (i + 1 >= runs.length) { next.push(runs[i]); continue; }
      const a = runs[i]; const b = runs[i + 1]; const m = new Array(a.length + b.length);
      let x = 0; let y = 0; let k = 0;
      while (x < a.length && y < b.length) {
        m[k++] = cmpScanIp(a[x], b[y]) > 0 ? b[y++] : a[x++]; // 같은 키는 없다(ip = 키) — 그래도 왼쪽을 먼저(안정)
        if ((k & 4095) === 0 && (await maybeYield()) && isCancelled()) return null;
      }
      while (x < a.length) m[k++] = a[x++];
      while (y < b.length) m[k++] = b[y++];
      next.push(m);
      if ((await maybeYield()) && isCancelled()) return null;
    }
    runs = next;
  }
  return runs[0] || [];
}
/** 스캔 결과에 나오는 에이전트 이름 목록(정렬 없음 · O(에이전트 수)). 결과가 0건인 이름은 없다. */
export function scanResultAgents() { return [..._agentCount.keys()]; }

const sameList = (a, b) => { const x = a || [], y = b || []; return x.length === y.length && x.every((v, i) => v === y[i]); };

/**
 * @param {object} [opts]
 * @param {boolean} [opts.seenOnly] v2.733(C1-02): **부분 결과**(시한에 걸린 스캔이 그때까지 찾은 생존 IP) — 이미 있는 IP 는 마지막 확인
 *   시각만 갱신한다(포트·서비스·호스트명·소유 에이전트는 완료된 스캔이 정한다 — 부분 결과에는 호스트명이 없다). 새 IP 는 그대로 넣는다
 *   (관측이다). 해제 판정 근거(완료 여부)는 이것이 아니라 recordAgentReport/recordAgentIncomplete 가 정한다.
 * @returns {{merged:number, capped:number}} 병합한 IP 수 · 전체 상한(MAX_SCAN_IPS)으로 받지 않은 새 IP 수
 */
export function mergeScanResults(alive, ts = Date.now(), agent = LOCAL, opts = {}) {
  const seenOnly = opts?.seenOnly === true;
  let changed = false;
  let resContent = false; let resWritten = false; // v2.731 A6-01: 결과 파일을 쓸 일이 있는가 · 그것이 내용 변화인가(lastSeen 만이면 긴 디바운스)
  let n = 0; let merged = 0; let capped = 0; const histCappedBefore = _histCapped;
  for (const raw of alive) {
    if (n++ >= MAX_MERGE) break;                 // 대량 주입 상한
    if (!raw || typeof raw !== 'object' || !isIpv4(raw.ip)) continue; // 잘못된/오염 IP 키 차단(__proto__, 333.0.0.0 등)
    const h = cleanAliveHost(raw);               // v2.601 CEN2601-01: 아는 필드·타입만
    const prev = results[h.ip];
    // v2.603 CEN2603-02: 새 IP 는 결과 전체 상한 안에서만 받는다. 이력은 따로 상한(MAX_HIST_IPS)을 두고 넘치면 **이력 항목만** 만들지 않는다
    //   (이력은 1년 보존이라 결과 prune 뒤에도 남는다 — 이력 상한으로 결과를 막으면 IP 가 바뀐 대역이 1년 동안 안 들어온다).
    if (!prev && _resultCount >= MAX_SCAN_IPS) { capped++; continue; }
    if (!prev) _resultCount++;
    merged++;
    if (seenOnly && prev) {
      // v2.733 C1-02: 부분 결과 — 마지막 확인 시각만. 소유 에이전트도 바꾸지 않는다(이력 항목의 것을 그대로 넘긴다).
      if (ts > (prev.lastSeen || 0)) { prev.lastSeen = ts; resWritten = true; }
      recordSeen(h, ts, history[h.ip]?.agent || prev.agent || agent);
      continue;
    }
    // 분산 멀티에이전트: 더 오래된(stale) 보고가 최신 관측을 덮어쓰지 않게 한다.
    if (prev && (prev.lastSeen || 0) > ts) { recordSeen(h, ts, agent); continue; }
    // 실제 내용(포트/서비스/호스트명/에이전트) 변화가 있을 때만 리비전을 올린다(불필요한 대장 재계산 방지).
    if (!prev || !sameList(prev.openPorts, h.openPorts) || !sameList(prev.services, h.services)
      || (prev.hostname || '') !== (h.hostname || '') || prev.agent !== agent) { changed = true; resContent = true; }
    if (!prev) bumpAgent(agent, 1); else if (prev.agent !== agent) { bumpAgent(prev.agent, -1); bumpAgent(agent, 1); } // v2.639 I2
    results[h.ip] = { ip: h.ip, openPorts: h.openPorts, services: h.services, hostname: h.hostname || '', lastSeen: ts, agent };
    resWritten = true;
    recordSeen(h, ts, agent); // IP 사용 이력(온라인 전환) 갱신
  }
  if (histDirty) changed = true; // up/down 전이·신규 이력도 대장(usageStatus/firstSeen)에 영향
  // v2.731 A6-01: 결과가 바뀌지 않은 보고(살아 있는 IP 0개·전부 더 오래된 보고)는 쓰지 않는다. lastSeen 만 바뀌었으면 긴 디바운스.
  if (resWritten) scheduleWrite(RES, !resContent);   // 디바운스 + 비동기 조각 쓰기(위 '디바운스 원자적 쓰기' 머리말)
  persistHist();
  if (changed) scanRevN++;
  if (_histCapped > histCappedBefore) console.warn(`[ipam] IP 사용 이력 상한(${MAX_HIST_IPS}개) — 새 이력 ${_histCapped - histCappedBefore}개를 만들지 않았습니다(스캔 결과는 받았습니다)`);
  if (capped) console.warn(`[ipam] 스캔 결과 전체 상한(${MAX_SCAN_IPS}개) — ${agent} 보고의 새 IP ${capped}개를 받지 않았습니다(IPAM_SCAN_RESULTS_MAX)`);
  return { merged, capped };
}


// ---- IP 사용 이력 ----------------------------------------------------------
// 어떤 IP가 "사용 시작(up) → 미사용(down)"으로 바뀌는 전이를 기록해 대장에서 추이를 본다.
// up 전이: 스캔에서 새로 보이거나, down 이후 다시 보일 때 기록.
// down 전이: sweepReleases()가 일정 시간 미응답 IP를 '해제'로 마킹할 때 기록.
let history = readJson(HIST, {}) || {};
_histCount = Object.keys(history).length;
// 두 관심사를 분리한다:
//  histDirty      = 대장(ledger)에 영향 있는 이력 변화(신규 IP / up·down 전이) → scanRev 증가 유발.
//  histPersistDirty = 디스크 기록만 필요한 변화(안정 IP 의 lastSeen 전진) → scanRev 는 올리지 않는다.
// 겸용(과거)이면 lastSeen 전진마다 scanRev 가 올라 매 스캔 전 대장이 재계산된다(불필요한 부하 회귀).
let histDirty = false;
let histPersistDirty = false;
registerStore(HIST, () => history, true);

function pushEvent(entry, ev) {
  entry.events.push(ev);
  if (entry.events.length > MAX_EVENTS) entry.events.splice(0, entry.events.length - MAX_EVENTS);
}

function recordSeen(h, ts, agent) {
  const ip = h.ip;
  let e = history[ip];
  if (!e) {
    if (_histCount >= MAX_HIST_IPS) { _histCapped++; return; } // v2.603 CEN2603-02: 이력만 건너뛴다(결과는 받았다)
    _histCount++;
    e = history[ip] = { ip, firstSeen: ts, lastSeen: ts, status: 'up', agent, events: [] };
    pushEvent(e, { ts, type: 'up', hostname: h.hostname || '', ports: h.openPorts || [], agent });
    histDirty = true;
    return;
  }
  // 최신 관측만 반영 — stale(오래된) 보고가 lastSeen을 뒤로 돌려 IP가 조기 down 처리되지 않게 한다.
  // lastSeen 전진은 **디스크 기록만** 필요(histPersistDirty) — 안 켜면 안정(status='up') IP 의
  // 갱신된 lastSeen 이 디스크에 안 써져(persistHist 는 dirty 일 때만 기록), 재시작 후 오래된
  // lastSeen 으로 sweep 이 그 IP 를 가짜 down 처리한다. 단 내용 변화가 아니므로 histDirty(=scanRev)
  // 는 올리지 않는다(안 그러면 매 스캔 대장 재계산 — CLAUDE.md 불필요 재계산 방지 위반).
  if (ts > (e.lastSeen || 0)) { e.lastSeen = ts; e.agent = agent; histPersistDirty = true; }
  if (e.status !== 'up') {
    e.status = 'up';
    pushEvent(e, { ts, type: 'up', hostname: h.hostname || '', ports: h.openPorts || [], agent });
    histDirty = true;
  }
}

/*
 * v2.733(점검 3회차 C1-02 — v2.732 B4-02 가 만든 회귀): 해제 판정은 '마지막으로 본 시각' 만 봤다. 그런데 v2.732 부터 시한(SCAN_DEADLINE)을
 *   넘긴 스캔은 결과를 하나도 남기지 않아, 스캔이 매번 시한에 걸리는 대역은 **살아 있는 IP 가 3시간 뒤 전부 해제(down)** 로 바뀌었다(재현).
 *   보지 못한 것(관측 부재)을 '없어졌다'(부재의 관측)로 세면 안 된다 — 이제 소유 에이전트의 **완료된** 스캔이 해제 기준 시간 안에 없으면
 *   down 전환을 **보류**한다. 사유: `scan-incomplete`(마지막 시도가 미완료 — recordAgentIncomplete) / `no-recent-scan`(완료 보고가 기준 안에
 *   없다 — 스캔이 꺼졌거나 엣지가 보고하지 못한다).
 *   · 보류에는 시한이 있다(v2.601 '보류에는 반드시 시한'): 마지막 확인 + 기준 + max(기준, 24시간)이 지나면 down 으로 바꾸되 이벤트에
 *     `unverified:true` 와 사유를 남긴다(완료 스캔이 확인한 해제가 아니다). 영원히 보류하면 진짜 반납된 IP 를 영영 해제하지 못한다.
 *   · 완료된 스캔이 기준 안에 있으면 예전과 같다(그 스캔이 그 IP 를 보지 못했다 = 부재의 관측).
 *   · 보류 개수·사유·시한은 releaseHoldStatus() → 스캔 상태 응답(scanStatus().releaseHold) → 화면(IpamScanStatus.jsx)이 말한다.
 */
/** 보류 시한에 더하는 최소 여유(24시간) — 시한 = 기준 + max(기준, 이 값). */
export const RELEASE_HOLD_MIN_EXTRA_MS = 24 * 3_600_000;
/** 해제 기준(idleMs)에 대한 보류 시한(ms) — 마지막 확인으로부터 이만큼 지나면 보류를 풀고 '미확인 해제' 로 기록한다. */
export function releaseHoldLimitMs(idleMs) {
  const n = Number(idleMs);
  return Number.isFinite(n) && n > 0 ? n + Math.max(n, RELEASE_HOLD_MIN_EXTRA_MS) : RELEASE_HOLD_MIN_EXTRA_MS;
}
const _holds = new Map();   // 에이전트 → 마지막 판정의 보류 요약(전체 sweep 은 통째로, { agent } sweep 은 그 에이전트만 바꾼다)
let _holdSweepAt = null;
let _expiredTotal = 0;      // 보류 시한이 지나 '미확인 해제' 로 바꾼 IP 수(프로세스 시작 이후 누적)
let _lastExpiredAt = null;
const _holdLogged = new Map(); // 에이전트 → 마지막으로 콘솔에 알린 보류 사유(같은 상태를 10분마다 다시 적지 않게)

/** 보고 기록 하나(정확히 같은 이름 → 대소문자만 다른 이름). 자기 속성만 본다. */
function reportOf(agent) {
  const name = String(agent || LOCAL);
  if (Object.prototype.hasOwnProperty.call(reports, name)) return reports[name];
  return agentValueOf(reports, name);
}
/** 그 에이전트의 마지막 완료 스캔 시각 · 그보다 새(또는 같은) 미완료 기록. */
function completionOf(agent) {
  const rep = reportOf(agent);
  if (!rep || typeof rep !== 'object') return { completedAt: null, incomplete: null };
  const at = numOrNull(rep.at);
  const completedAt = at != null && at > 0 ? at : null;
  const inc = rep.incomplete && typeof rep.incomplete === 'object' ? rep.incomplete : null;
  const incAt = numOrNull(inc?.at);
  const newer = inc && incAt != null && (completedAt == null || incAt >= completedAt);
  return { completedAt, incomplete: newer ? inc : null };
}

/**
 * 일정 시간(idleMs) 이상 응답이 없던 'up' IP를 '해제(down)'로 마킹한다.
 * opts.agent를 주면 그 에이전트가 마지막으로 보고한 IP만 대상으로 한다 — 중앙이 직접 스캔한
 * 로컬 대역만 down 처리하고, 원격 사이트 에이전트 소유 IP를 중앙 스캔이 오탐 down하지 않게 한다.
 * v2.733: 소유 에이전트의 완료된 스캔이 기준 안에 없으면 보류한다(위 머리말). 반환값은 예전처럼 바뀐 항목 수다(보류는 세지 않는다).
 */
export function sweepReleases(idleMs, opts = {}) {
  const now = typeof opts === 'number' ? opts : (opts.now || Date.now());
  const onlyAgent = typeof opts === 'object' ? opts.agent : undefined;
  // opts.idleMsByAgent(Map name→ms): 소유 에이전트별 임계 — 주기가 긴(최대 7일) 원격 에이전트의
  // IP를 로컬 주기 기준으로 일괄 판정하면 스캔 사이마다 가짜 down/up 플립이 생긴다.
  const byAgent = (typeof opts === 'object' && opts.idleMsByAgent instanceof Map) ? opts.idleMsByAgent : null;
  if ((!idleMs || idleMs <= 0) && !byAgent) return 0;
  let changed = 0;
  const isManaged = managedChecker(); // 루프 시작 시 1회 구성(O(N) 유지)
  const verdicts = new Map(); // 에이전트 → completionOf(한 sweep 에 에이전트당 1회 — O(N) 유지)
  const agg = new Map();      // 에이전트 → 이번 판정의 보류 요약
  for (const e of Object.values(history)) {
    const ag = e.agent || LOCAL;
    const owned = onlyAgent === undefined || ag === onlyAgent;
    const eff = byAgent ? (byAgent.get(ag) ?? idleMs) : idleMs;
    if (owned && e.status === 'up' && eff > 0 && (e.lastSeen || 0) < now - eff) {
      let v = verdicts.get(ag);
      if (!v) { v = completionOf(ag); verdicts.set(ag, v); }
      if (v.completedAt != null && v.completedAt >= now - eff) {
        // 기준 안에 완료된 스캔이 있다 — 그 스캔이 이 IP 를 보지 못했다(예전과 같은 해제).
        e.status = 'down';
        pushEvent(e, { ts: now, type: 'down' });
        changed++;
      } else {
        const reason = v.incomplete ? 'scan-incomplete' : 'no-recent-scan';
        const limit = releaseHoldLimitMs(eff);
        const seen = e.lastSeen || 0;
        let a = agg.get(ag);
        if (!a) {
          a = { agent: ag, held: 0, expired: 0, reason, idleMs: eff, holdLimitMs: limit, oldestSeen: null, lastCompletedAt: v.completedAt,
            incomplete: v.incomplete ? { at: numOrNull(v.incomplete.at), since: numOrNull(v.incomplete.since), streak: numOrNull(v.incomplete.streak), code: String(v.incomplete.code || ''), reason: String(v.incomplete.reason || '') } : null };
          agg.set(ag, a);
        }
        if (seen >= now - limit) {
          a.held++;
          if (a.oldestSeen == null || seen < a.oldestSeen) a.oldestSeen = seen;
        } else {
          // 보류 시한이 지났다 — 해제하되 완료 스캔이 확인한 해제가 아니라는 사실을 남긴다.
          e.status = 'down';
          pushEvent(e, { ts: now, type: 'down', unverified: true, reason });
          changed++;
          a.expired++;
        }
      }
    }
    // 아주 오래 안 보인 IP의 이력은 정리(무한 증식 방지). 단, 운영자가 관리(override/대역정책)하는
    // IP는 사용 추이를 계속 보존한다(관리 대상의 이력 손실 방지).
    if ((e.lastSeen || 0) < now - HISTORY_RETENTION_MS && !isManaged(e.ip)) { delete history[e.ip]; _histCount--; changed++; }
  }
  if (changed) { histDirty = true; persistHist(); scanRevN++; }
  recordHolds(agg, onlyAgent, now);
  return changed;
}

/** 이번 판정의 보류 요약을 상태에 반영하고, 새로 생긴 보류·시한 만료를 콘솔에 한 번 알린다(무음 실패 금지 — 같은 상태는 다시 적지 않는다). */
function recordHolds(agg, onlyAgent, now) {
  if (onlyAgent !== undefined) _holds.delete(onlyAgent); else _holds.clear();
  for (const a of agg.values()) {
    const base = a.oldestSeen;
    _holds.set(a.agent, {
      agent: a.agent, held: a.held, expired: a.expired, reason: a.reason, idleMs: a.idleMs, holdLimitMs: a.holdLimitMs,
      heldSince: base == null ? null : base + a.idleMs, holdUntil: base == null ? null : base + a.holdLimitMs,
      lastCompletedAt: a.lastCompletedAt, incomplete: a.incomplete,
    });
    if (a.expired) {
      _expiredTotal += a.expired; _lastExpiredAt = now;
      console.warn(`[ipam] 해제 판정 보류 시한이 지나 ${a.agent} 의 IP ${a.expired}개를 '미확인 해제' 로 기록했습니다(사유 ${a.reason} — 완료된 스캔이 확인한 해제가 아닙니다)`);
    }
    const key = a.held ? a.reason : '';
    if (a.held && _holdLogged.get(a.agent) !== key) {
      console.warn(`[ipam] 해제 판정 보류 — ${a.agent} 의 IP ${a.held}개(사유 ${a.reason}: ${a.reason === 'scan-incomplete' ? '마지막 스캔이 미완료' : '해제 기준 시간 안에 완료된 스캔 보고가 없음'}) · 보류 시한 ${Math.round(a.holdLimitMs / 3_600_000)}시간`);
    }
    _holdLogged.set(a.agent, key);
  }
  for (const k of [..._holdLogged.keys()]) if (!_holds.has(k) && (onlyAgent === undefined || k === onlyAgent)) _holdLogged.delete(k);
  _holdSweepAt = now;
}

/**
 * v2.733: 해제 판정 보류 현황(스캔 상태 응답 · 화면). held = 지금 보류 중인 IP 수, expired = 보류 시한이 지나 '미확인 해제' 로 바꾼 누적 수(프로세스 시작 이후).
 * @returns {{at:number|null, held:number, byReason:object, expired:number, lastExpiredAt:number|null, minExtraMs:number, agents:object[]}}
 */
export function releaseHoldStatus() {
  const agents = [..._holds.values()].sort((a, b) => String(a.agent).localeCompare(String(b.agent)));
  let held = 0; const byReason = {};
  for (const a of agents) { held += a.held; if (a.held) byReason[a.reason] = (byReason[a.reason] || 0) + a.held; }
  return { at: _holdSweepAt, held, byReason, expired: _expiredTotal, lastExpiredAt: _lastExpiredAt, minExtraMs: RELEASE_HOLD_MIN_EXTRA_MS, agents };
}

function persistHist() {
  if (!histDirty && !histPersistDirty) return; // ledger 변화 또는 lastSeen 전진 중 하나라도 있으면 기록
  const seenOnly = !histDirty; // v2.731 A6-01: lastSeen 전진만이면 긴 디바운스(재시작 해제 판정 임계는 최소 3시간)
  histDirty = false;
  histPersistDirty = false;
  scheduleWrite(HIST, seenOnly); // 디바운스 + 비동기 조각 쓰기
}

/** 한 IP의 사용 이력(없으면 null). */
export function getIpHistory(ip) { return history[ip] || null; }

/**
 * v2.731(점검 A6-02): 한 IP 의 이력 항목(살아 있는 객체 — 읽기 전용으로 쓸 것) 또는 null. 원장(ledger.js)이 행마다 이것을 본다 —
 *   예전에는 재구성마다 `getIpHistoryMap()` 으로 이력 맵 **전체**를 복사했다(20만 IP 300~540ms). 자기 속성만 본다(IP 가 아닌
 *   문자열 'constructor' 등이 Object.prototype 값을 이력으로 읽지 않게).
 */
export function ipHistoryEntry(ip) {
  if (typeof ip !== 'string' || !Object.prototype.hasOwnProperty.call(history, ip)) return null;
  const e = history[ip];
  return e && typeof e === 'object' ? e : null;
}

/** ip → { firstSeen, lastSeen, status } 요약 맵(대장 주석용). */
export function getIpHistoryMap() {
  const m = {};
  for (const e of Object.values(history)) m[e.ip] = { firstSeen: e.firstSeen, lastSeen: e.lastSeen, status: e.status };
  return m;
}

/** ip → { firstSeen, lastSeen, status, agent, events[] } 전체 맵(시간축 시각화용 — up/down 전이 시계열 포함). v2.639: 바깥 호출부 0건(netmap 은 getIpHistory 를 쓴다) — 내부 함수(export 를 뗐다). */
// eslint-disable-next-line no-unused-vars
function getAllHistoryEvents() {
  const m = {};
  for (const e of Object.values(history)) {
    m[e.ip] = { firstSeen: e.firstSeen, lastSeen: e.lastSeen, status: e.status, agent: e.agent || '', events: e.events || [] };
  }
  return m;
}

export function pruneScanResults(retentionDays) {
  if (!retentionDays) return;
  const cut = Date.now() - retentionDays * 86_400_000;
  let changed = false;
  const isManaged = managedChecker();
  // 관리(override/대역정책) IP의 스캔 결과는 보존(보존기간 초과여도 운영 가시성 유지).
  for (const [ip, r] of Object.entries(results)) if ((r.lastSeen || 0) < cut && !isManaged(ip)) { bumpAgent(r.agent, -1); delete results[ip]; _resultCount--; changed = true; }
  if (changed) { scheduleWrite(RES); scanRevN++; }
}

export function scanInfo() {
  // v2.639 I2: 정렬(scanResultList) 없이 — 에이전트별 개수는 _agentCount, 마지막 관측은 한 번 훑는다(값은 예전과 같다).
  const byAgent = {};
  for (const [a, n] of _agentCount) byAgent[a] = n;
  let lastSeen = 0;
  for (const r of Object.values(results)) if ((r.lastSeen || 0) > lastSeen) lastSeen = r.lastSeen || 0;
  return { count: _resultCount, max: MAX_SCAN_IPS, historyMax: MAX_HIST_IPS, ...(_histCapped ? { historyCapped: _histCapped } : {}), lastSeen: lastSeen || null, byAgent };
}

// ---- 에이전트별 보고 기록(마지막 보고 시각·스캔/응답 수) ----------------------
let reports = readJson(REP, {}) || {};
registerStore(REP, () => reports);

export function recordAgentReport(agent, { scanned = 0, alive = 0, durationMs = null } = {}) {
  const name = agent || LOCAL;
  // v2.601 CEN2601-01: 엣지 본문의 수치를 그대로 저장하지 않는다(객체·문자열이 화면·이력으로 새지 않게).
  scanned = numOrNull(scanned); alive = numOrNull(alive); durationMs = numOrNull(durationMs);
  reports[name] = { at: Date.now(), scanned, alive };
  scheduleWrite(REP); // 디바운스 원자 기록(에이전트 보고 핫패스 비차단)
  recordRun({ agent: name, scanned, alive, durationMs }); // 완료된 스캔 이력에 추가
}

/**
 * v2.733(C1-02): 스캔 미완료(시한 초과·실패) 기록. 마지막 **완료** 시각(at)·스캔/응답 수는 그대로 두고 `incomplete` 만 갱신한다 —
 *   다음 완료 보고(recordAgentReport)가 기록을 통째로 바꿔 이 표지를 지운다. 완료된 스캔 이력(recordRun)에는 넣지 않는다.
 *   since = 연속 미완료가 시작된 시각, streak = 연속 횟수. 엣지가 보낸 값도 들어오므로 글자·수치를 좁힌다.
 * @returns {object|null} 기록한 incomplete(이름이 쓸 수 없는 값이면 null)
 */
export function recordAgentIncomplete(agent, { code = 'error', reason = '', durationMs = null, partial = null, done = null, total = null, at = null } = {}) {
  const name = String(agent || LOCAL);
  if (name === '__proto__') return null; // 평범한 객체 맵 — 프로토타입을 바꾸지 않게
  const prev = Object.prototype.hasOwnProperty.call(reports, name) && reports[name] && typeof reports[name] === 'object' ? reports[name] : null;
  const prevInc = prev?.incomplete && typeof prev.incomplete === 'object' ? prev.incomplete : null;
  const t = numOrNull(at) ?? Date.now();
  const c = typeof code === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(code) ? code : 'error';
  const inc = {
    at: t,
    since: numOrNull(prevInc?.since) ?? t,
    streak: (numOrNull(prevInc?.streak) ?? 0) + 1,
    code: c,
    reason: typeof reason === 'string' ? capStr(reason.slice(0, 300).replace(CTRL_RE, ' '), 300) : '', // 평탄화 — 큰 본문을 붙잡지 않게(v2.607 TIM2607-01)
    durationMs: numOrNull(durationMs), partial: numOrNull(partial), done: numOrNull(done), total: numOrNull(total),
  };
  reports[name] = { at: numOrNull(prev?.at), scanned: numOrNull(prev?.scanned), alive: numOrNull(prev?.alive), incomplete: inc };
  scheduleWrite(REP);
  return inc;
}

export function getAgentReports() { return reports; }

// ---- 스캔 실행 이력(완료된 스캔 로그, 최근 N건) ------------------------------
const RUNLOG = path.join(config.configDir, 'ipam-scan-runs.json');
const MAX_RUNS = 200;
let runs = (() => { const r = readJson(RUNLOG, {}); return Array.isArray(r?.runs) ? r.runs : []; })();
registerStore(RUNLOG, () => ({ runs }));

export function recordRun({ agent = LOCAL, scanned = 0, alive = 0, durationMs = null } = {}) {
  runs.unshift({ at: Date.now(), agent: String(agent), scanned: numOrNull(scanned), alive: numOrNull(alive), durationMs: numOrNull(durationMs) });
  if (runs.length > MAX_RUNS) runs = runs.slice(0, MAX_RUNS);
  scheduleWrite(RUNLOG); // 디바운스 원자 기록
}

export function getScanRuns(limit = 50) { return runs.slice(0, limit); }

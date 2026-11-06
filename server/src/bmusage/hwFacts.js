/**
 * bmusage/hwFacts.js — 리눅스 성능 1단계(v2.919)의 **하드웨어(iDRAC) 쪽 사실** — 이미 가진 데이터만 읽는다.
 *
 * ⚠⚠ **주기당 Redfish HTTP 회수를 1회도 늘리지 않는다**(idrac/poller.js 상단 주석의 실측 규약 · 설계 §3.2).
 *   여기서 읽는 것은 전부 다른 모듈이 이미 받아 둔 값이다 — 장비 왕복 0:
 *    · 전력 W            — `idrac/db.js` 최신값 캐시(latest — 주 iDRAC 폴러가 적재)
 *    · 전력 cap          — `idrac/invCache.js` 인벤토리 `powerCap.limitWatts`(느린 주기 인벤토리)
 *    · 흡기 온도 · CPU %  — `idrac/sensorStore.js` 최신 표본(주 폴러의 Thermal · 텔레메트리 CPU)
 *    · DIMM·디스크·SEL   — 인벤토리 `memoryDimms[].health` · `disks[].predictiveFailure` · `events[]`(Critical/Warning)
 *    · 부품 장애         — `partfault/db.js openFaults({scope:'idrac'})`(부품 장애 모듈의 판정 그대로 — 복제하지 않는다)
 *   **읽지 못하는 것**(이 저장소가 받지 않는 값 — 정직 기록): CPU 스로틀링 · ECC 정정 카운트 · SMART 재할당 섹터 · NIC CRC.
 *   이 칸들은 `null` 이고 판정은 ‘못 읽음(missing)’ 으로 둔다(없다고 단정하지 않는다).
 * ⚠ 이 모듈은 fetch·redfish 를 import 하지 않는다 — 테스트가 소스를 검사해 고정한다(bmPerf2919 ‘Redfish 호출 수 불변’).
 */
import { numOrNull } from '../util/numOrNull.js';

const n = numOrNull;
const t = (v) => String(v ?? '').trim();
/** 흡기 센서 이름 패턴 — Dell 은 `System Board Inlet Temp` · HPE 는 `01-Inlet Ambient`. 못 찾으면 null(다른 센서로 대신하지 않는다). */
const INLET_RE = /inlet|ambient/i;
const BAD_HEALTH = /^(critical)$/i;
const WARN_HEALTH = /^(warning)$/i;

/**
 * 순수 — 이미 모은 원재료를 판정 입력 모양으로(테스트 대상).
 * @param {{power?:{watts,ts}|null, inv?:object|null, sensor?:{t,cpu,temps}|null, faults?:Array}} raw
 * @param {{now?:number, freshMs?:number}} [o]  freshMs: 전력·센서 표본을 ‘지금 값’ 으로 볼 한계
 */
export function shapeHwFacts(raw = {}, { now = Date.now(), freshMs = 15 * 60_000 } = {}) {
  const fresh = (at) => n(at) != null && now - n(at) <= freshMs;
  const power = raw.power && fresh(raw.power.ts) ? { watts: n(raw.power.watts), at: n(raw.power.ts) } : null;
  const inv = raw.inv && typeof raw.inv === 'object' ? raw.inv : null;
  const capW = n(inv?.powerCap?.limitWatts);
  const capPct = power?.watts != null && capW != null && capW > 0 ? Math.round((power.watts / capW) * 1000) / 10 : null;
  const sensor = raw.sensor && fresh(raw.sensor.t) ? raw.sensor : null;
  let inletC = null;
  if (sensor?.temps && typeof sensor.temps === 'object') {
    for (const [name, c] of Object.entries(sensor.temps)) { if (INLET_RE.test(name) && n(c) != null) { inletC = inletC == null ? n(c) : Math.max(inletC, n(c)); } }
  }
  const coll = inv?.collections && typeof inv.collections === 'object' ? inv.collections : {};
  const dimmsRead = Array.isArray(inv?.memoryDimms) && coll.memoryDimms !== 'failed';
  const disksRead = Array.isArray(inv?.disks) && coll.disks !== 'failed';
  const dimmBad = dimmsRead ? inv.memoryDimms.filter((d) => BAD_HEALTH.test(t(d?.health))).map((d) => t(d.locator).slice(0, 64)) : null;
  const dimmWarn = dimmsRead ? inv.memoryDimms.filter((d) => WARN_HEALTH.test(t(d?.health))).map((d) => t(d.locator).slice(0, 64)) : null;
  const diskPredicted = disksRead ? inv.disks.filter((d) => d?.predictiveFailure === true).map((d) => t(d.name || d.id || d.serial).slice(0, 64)) : null;
  const events = Array.isArray(inv?.events) ? inv.events : null;
  const selCritical = events ? events.filter((e) => /critical/i.test(t(e?.severity))).length : null;
  const faults = Array.isArray(raw.faults) ? raw.faults : null;
  const byKind = (k) => (faults ? faults.filter((f) => f.kind === k) : null);
  const faultView = (list) => (list ? list.slice(0, 16).map((f) => ({ kind: t(f.kind).slice(0, 16), label: t(f.label).slice(0, 80), state: t(f.state).slice(0, 16) })) : null);
  return {
    read: !!(power || sensor || inv),
    power: power ? { ...power, capWatts: capW, capPct } : (capW != null ? { watts: null, at: null, capWatts: capW, capPct: null } : null),
    inletC, sensorAt: sensor ? n(sensor.t) : null,
    cpuPct: sensor ? n(sensor.cpu) : null,
    inventoryAt: inv ? n(inv.collectedAt) : null,
    dimmBad, dimmWarn, diskPredicted, selCritical,
    faults: faultView(faults),
    faultCount: faults ? faults.length : null,
    cpuFaults: faultView(byKind('cpu')), dimmFaults: faultView(byKind('dimm')), diskFaults: faultView(byKind('disk')), nicFaults: faultView(byKind('nic')),
    // 이 저장소가 받지 않는 값 — null 고정(판정은 missing). 받게 되면 여기서 채운다.
    throttle: null, eccCorrectable: null, smartRealloc: null, nicCrc: null,
  };
}

/**
 * 한 노드의 iDRAC 사실 조회기 — 요청 1회에 한 번 만든다(부품 장애 목록·DB 핸들을 서버마다 다시 열지 않게).
 * 반환 함수 `(target) => facts|null` — iDRAC 등록이 없는 대상은 null(‘경로 없음’).
 */
export async function hwFactsReader({ agent = '', now = Date.now(), freshMs = 15 * 60_000 } = {}) {
  const [{ getInventory }, { getSensorSeries }] = await Promise.all([import('../idrac/invCache.js'), import('../idrac/sensorStore.js')]);
  let idb = null;
  try { idb = await (await import('../idrac/db.js')).getDb(); } catch { idb = null; }
  let open = null;
  try {
    const pf = await import('../partfault/db.js');
    // 부품 장애 DB 가 없는 노드에 파일을 만들지 않는다(open() 은 없으면 만든다).
    open = pf.partFaultDbExists() ? await pf.openFaults({ scope: 'idrac' }) : null;
  } catch { open = null; }
  const ag = t(agent);
  const byDevice = new Map();
  if (Array.isArray(open)) {
    for (const f of open) {
      // 법인 축: 이 노드의 이름으로 적재된 것 — 엣지는 로컬 판정분이 빈 agent 일 수 있어 그것도 받는다(중앙은 자기 것 '' 만 — 엣지 장애를 섞지 않는다).
      if (!(t(f.agent) === ag || (ag && t(f.agent) === ''))) continue;
      for (const k of [t(f.deviceId), t(f.deviceKey).toUpperCase()]) {
        if (!k) continue;
        if (!byDevice.has(k)) byDevice.set(k, []);
        byDevice.get(k).push(f);
      }
    }
  }
  return (target) => {
    const id = t(target?.idrac?.regId);
    if (!id) return null;
    let power = null;
    try { power = idb?.latest ? idb.latest(id) : null; } catch { power = null; }
    let sensor = null;
    try { sensor = getSensorSeries(id, { minutes: 0 }).latest || null; } catch { sensor = null; }
    const tag = t(target.serviceTag).toUpperCase();
    const faults = open == null ? null : [...new Set([...(byDevice.get(id) || []), ...(tag ? byDevice.get(tag) || [] : [])])];
    return shapeHwFacts({ power, inv: getInventory(id), sensor, faults }, { now, freshMs });
  };
}

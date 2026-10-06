/**
 * mock/demo/pdu.js — PDU 정보 화면 데모 데이터(v2.708, DATA_SOURCE=mock 전용).
 *
 * 하는 일(전부 mock 모드에서만 — live/auto 에서는 아무것도 하지 않는다):
 *  · 등록부가 **비어 있을 때만** 법인(DataCenter)마다 PDU 4~8대를 `mock-pdu-` id 로 시드한다.
 *  · 폴러가 mock 이면 SSH 대신 `demoPduSnapshot()` 으로 합성 스냅샷을 만든다(장비 접속 0).
 *    값은 장비 id 해시로 결정되고 시간(하루 주기 + 작은 흔들림)에 따라 조금 바뀐다. 누적 kWh 는 시간에 단조 증가한다.
 *  · 시드한 그 순간에만 과거 30일 시계열을 백필한다(최근 48시간은 10분, 그 이전은 2시간 간격) — 추이 화면 기본 기간(24시간)
 *    과 7일·30일 버튼이 바로 채워지게.
 *  · 일부러 넣은 이상: 뱅크 전류 경고(12A 초과)·온도 경고(27℃ 초과) 장비 몇 대, 수집 실패 장비 1대(값을 지어내지 않는다 —
 *    실패 스냅샷은 수치가 비어 있다).
 *
 * 법인 목록(`demoCorps`)은 CVP 데모도 쓴다 — DataCenter 가 등록돼 있으면 그것을, 없으면 mock vCenter 마다 `dc-<도시>` 를 만든다.
 */
import { isMockMode, demoHash, demoRand, demoIp } from './flags.js';

const HOUR = 3_600_000;
const T0 = Date.UTC(2025, 0, 1);   // 누적 전력량(kWh) 기준 시각 — 시간에 단조 증가하게
const slug = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\x20-\x7e]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;

/** 데모 장비 id 인가(live 폴러가 건너뛴다). */
export const isDemoId = (id) => String(id || '').startsWith('mock-');
/** 데모가 지금 쓰이는가 — mock 모드이고 등록부에 데모(mock-) PDU 가 있다. */
export const pduDemoActive = (devices) => isMockMode() && (Array.isArray(devices) ? devices : []).some((x) => isDemoId(x?.id));

/**
 * 데모 법인 목록 [{id, name, code}] — DataCenter 가 있으면 그것(앞 12곳), 없으면 mock vCenter 의 도시로 `dc-<도시>` 를 만든다.
 * ⚠ DataCenter 를 만드는 것은 mock 모드·목록이 비어 있을 때뿐이다. vCenter 할당은 할당이 없는 vCenter 만 데모 법인으로 채운다(v2.709 assignDemoCorps).
 */
export async function demoCorps(snapshot) {
  if (!isMockMode()) return [];
  const dcs = await import('../../datacenter/store.js');
  let list = dcs.listDatacenters();
  if (!list.length) {
    const vcs = Array.isArray(snapshot?.vcenters) ? snapshot.vcenters : [];
    if (!vcs.length) return [];
    for (const vc of vcs) {
      const city = vc.location?.city || vc.name || vc.id;
      const id = `dc-${slug(city) || slug(vc.id)}`;
      dcs.ensureDatacenter({ id, name: `${city} 법인`, region: vc.location?.region || vc.region || '', note: '데모(mock) 법인' });
    }
    list = dcs.listDatacenters();
  }
  await assignDemoCorps(dcs, snapshot).catch((e) => console.warn(`[mock] 데모 법인 할당 실패: ${e?.message || e}`));
  list = dcs.listDatacenters();
  return list.slice(0, 12).map((d) => ({ id: String(d.id), name: String(d.name || d.id), code: (slug(d.name || d.id).replace(/^dc-/, '').slice(0, 3) || 'dc').toUpperCase() }));
}

/**
 * v2.709: **mock vCenter 중 할당이 없는 것**을 데모 법인에 할당한다 — 할당이 없으면 전체 소비 전력·법인별 화면에서 서버가 전부
 * '(법인 미지정)' 이었다(데모 재조사에서 발견). 순서: ① 그 vCenter 를 수집하는 데모 엣지의 DataCenter(이름 대소문자 무시 —
 * 데모 엣지 등록이 'Seoul' 같은 DataCenter 를 자동으로 만든다) ② 없으면 도시 이름의 데모 법인 `dc-<도시>`(없으면 만든다 · note '데모(mock) 법인').
 * 사람이 등록한 vCenter(목 vCenter 가 아님)와 이미 할당된 vCenter 는 건드리지 않는다.
 */
async function assignDemoCorps(dcs, snapshot) {
  const vcs = Array.isArray(snapshot?.vcenters) ? snapshot.vcenters : [];
  if (!vcs.length) return;
  const [{ isMockVcenter }, { demoEdgeOfVcenter }] = await Promise.all([import('../generator.js'), import('./edge.js')]);
  const assigned = dcs.getDatacenterAssign();
  const byName = new Map(dcs.listDatacenters().flatMap((d) => [[String(d.id).toLowerCase(), d.id], [String(d.name || '').toLowerCase(), d.id]]));
  const fresh = [];
  for (const vc of vcs) {
    if (!vc?.id || assigned[vc.id] || !isMockVcenter(vc)) continue;
    const edgeDc = String(demoEdgeOfVcenter(vc.id)?.datacenter || '').toLowerCase();
    let dc = edgeDc ? byName.get(edgeDc) : null;
    if (!dc) {
      const city = vc.location?.city || vc.name || vc.id;
      dc = `dc-${slug(city) || slug(vc.id)}`;
      if (!byName.has(dc)) { dcs.ensureDatacenter({ id: dc, name: `${city} 법인`, region: vc.location?.region || vc.region || '', note: '데모(mock) 법인' }); byName.set(dc, dc); }
    }
    fresh.push({ vcenterId: String(vc.id), datacenterId: dc });
  }
  if (fresh.length) dcs.setVcenterDatacenterMany(fresh);
}

/** 법인 하나의 데모 PDU 목록(등록부 모양). 4~8대. */
export function demoPduDevicesFor(corp) {
  const n = 4 + (demoHash(`pdu-n|${corp.id}`) % 5);
  const out = [];
  for (let i = 1; i <= n; i++) {
    const id = `mock-pdu-${slug(corp.id)}-${i}`;
    out.push({
      id, name: `PDU-${corp.code}-R${String.fromCharCode(64 + Math.ceil(i / 2))}${i % 2 ? 'A' : 'B'}`,
      host: demoIp(id, 10), username: 'apc', password: 'mock', sshPort: 22,
      datacenterId: corp.id, agent: '', enabled: true, note: '데모(합성) 장비 — 실제로 접속하지 않습니다', updatedAt: Date.now(),
    });
  }
  return out;
}

/** 하루 주기 부하 계수(오후 2시 최고). */
function diurnal(ts, amp) {
  const h = (ts / HOUR) % 24;
  return 1 + amp * Math.sin(((h - 8) / 24) * 2 * Math.PI);
}

/**
 * 장비 한 대의 합성 스냅샷(apcSsh.collect 와 같은 모양). 같은 (id, 시각 10분 칸)이면 같은 값이다.
 * @param {{id:string,name?:string,host?:string,datacenterId?:string}} dev
 * @param {number} [ts]
 */
export function demoPduSnapshot(dev, ts = Date.now()) {
  const id = String(dev?.id || '');
  const h = demoHash(`pdu|${id}`);
  const slot = Math.floor(ts / 600_000);
  const noise = (k, amp) => (demoRand(`${id}|${k}|${slot}`) * 2 - 1) * amp;
  const snap = {
    id, name: dev?.name || dev?.host || id, host: dev?.host || '', datacenterId: dev?.datacenterId || '', agent: '',
    collectedAt: ts, ok: true, error: '', model: h % 3 === 0 ? 'AP8861' : 'AP8853', serial: `MOCK${String(h).slice(0, 8)}`,
    nmcModel: 'AP9641', aosVersion: 'v7.0.6', appVersion: 'v7.0.6', units: [], sensors: [],
    totals: { powerW: null, energyKwh: null, units: 0, sensors: 0 }, notes: [], demo: true,
  };
  // 수집 실패 1대 — 이상한 값을 지어내지 않고 실패 스냅샷으로 둔다(화면이 사유를 보여 준다).
  if (h % 41 === 7) {
    snap.ok = false;
    snap.error = '데모: SSH 연결 시간 초과(합성 실패 — 실제로 접속하지 않았습니다)';
    return snap;
  }
  const nUnits = h % 4 === 0 ? 2 : 1;
  const bankHot = h % 11 === 3;   // 뱅크 전류 경고(12A 초과)
  for (let u = 1; u <= nUnits; u++) {
    const base = 1300 + (demoHash(`pdu-w|${id}|${u}`) % 2300);
    const w = Math.max(50, Math.round(base * diurnal(ts, 0.07) * (1 + noise(`w${u}`, 0.03))));
    const pf = r2(0.95 + (demoHash(`pf|${id}|${u}`) % 4) / 100);
    const kwh = r1((base / 1000) * ((ts - T0) / HOUR) + (demoHash(`kwh|${id}|${u}`) % 5000));
    const bankA = (w / 230) / 2;
    const banks = [1, 2].map((b) => ({ index: b, currentA: r1(bankHot && u === 1 && b === 1 ? 12.6 + noise('hot', 0.4) : bankA * (b === 1 ? 1.08 : 0.92)) }));
    const phases = [{ index: 1, currentA: r1(w / 230), voltageV: r1(229 + noise(`v${u}`, 1.5)) }];
    snap.units.push({ index: u, powerW: w, energyKwh: kwh, appPowerW: Math.round(w / pf), pf, banks, phases });
  }
  const nSensors = 1 + (h % 2);
  const hot = h % 13 === 4;       // 온도 경고(27℃ 초과)
  for (let s = 1; s <= nSensors; s++) {
    const t = 20.5 + (demoHash(`t|${id}|${s}`) % 25) / 10 + (hot && s === 1 ? 7 : 0);
    snap.sensors.push({
      index: s, name: s === 1 ? '랙 전면(흡기)' : '랙 후면(배기)',
      tempC: r1(t * diurnal(ts, 0.03) + noise(`t${s}`, 0.2) + (s === 2 ? 2.5 : 0)),
      humidityPct: Math.round(42 + (demoHash(`hm|${id}|${s}`) % 12) + noise(`hm${s}`, 1.5)),
    });
  }
  snap.totals = {
    powerW: snap.units.reduce((a, x) => a + x.powerW, 0),
    energyKwh: r2(snap.units.reduce((a, x) => a + x.energyKwh, 0)),
    units: snap.units.length, sensors: snap.sensors.length,
  };
  return snap;
}

let _seeding = null;
let _seeded = false;

/**
 * 등록부가 비어 있으면 데모 PDU 를 시드하고 30일 이력을 백필한다(mock 전용 · 한 번만).
 * @returns {Promise<{seeded:boolean, devices?:number, backfilled?:number, reason?:string}>}
 */
export function ensurePduDemo() {
  if (!isMockMode()) return Promise.resolve({ seeded: false, reason: 'not-mock' });
  if (_seeded) return Promise.resolve({ seeded: false, reason: 'done' });
  if (_seeding) return _seeding;
  _seeding = seedInner().finally(() => { _seeding = null; });
  return _seeding;
}

async function seedInner() {
  const reg = await import('../../pdu/registry.js');
  if (reg.listDevices().length) { _seeded = true; return { seeded: false, reason: 'registry-not-empty' }; }
  const { store } = await import('../../store.js');
  const snap = store.get();
  // 메인 mock 스냅샷이 생긴 뒤에만 시드한다(테스트처럼 스냅샷 없이 폴러만 부르는 경우에는 시드하지 않는다).
  if (!Array.isArray(snap?.vcenters) || !snap.vcenters.length) return { seeded: false, reason: 'snapshot-not-ready' };
  const corps = await demoCorps(snap);
  if (!corps.length) return { seeded: false, reason: 'snapshot-not-ready' };   // 다음 호출에 다시
  const devices = corps.flatMap(demoPduDevicesFor);
  const r = reg.seedDemoDevices(devices);
  if (!r.ok) { _seeded = true; return { seeded: false, reason: r.reason }; }   // _seeded 는 백필 뒤에(동시 호출자는 _seeding 을 기다린다)
  const backfilled = await backfillPdu(devices);
  console.log(`[mock] PDU 데모 시드: 법인 ${corps.length}곳 · PDU ${devices.length}대 + 30일 시계열 ${backfilled}건`);
  _seeded = true;
  return { seeded: true, devices: devices.length, backfilled };
}

/** 과거 이력 백필 시각 목록(오래된 것부터): 30일 전 ~ 48시간 전은 2시간, 최근 48시간은 10분. */
export function backfillTimes(now = Date.now()) {
  const out = [];
  const end = now - 600_000;
  for (let t = now - 30 * 24 * HOUR; t < now - 48 * HOUR; t += 2 * HOUR) out.push(t);
  for (let t = now - 48 * HOUR; t <= end; t += 600_000) out.push(t);
  return out;
}

async function backfillPdu(devices, now = Date.now()) {
  const { recordSnapshots } = await import('../../pdu/db.js');
  const times = backfillTimes(now);
  let n = 0;
  for (const d of devices) {
    await new Promise((r) => setImmediate(r));   // 장비마다 양보 · 트랜잭션은 50건씩(실측 최장 정지 약 70ms)
    const snaps = times.map((t) => demoPduSnapshot(d, t)).filter((s) => s.ok);
    if (!snaps.length) continue;
    n += await recordSnapshots(snaps, { chunk: 50 });
  }
  return n;
}

export function _resetForTest() { _seeded = false; _seeding = null; }
export const _backfillForTest = (devices, now) => backfillPdu(devices, now);

/**
 * mock/demo/baremetal.js — 데모(DATA_SOURCE=mock) 베어메탈 서버·베어메탈 사용률(v2.708).
 *
 * 예전 mock 은 iDRAC 등록이 전부 ESXi 를 받치는 서버라 통합 서버 인벤토리의 '베어메탈' 이 0대였고, 그 위에 서는 화면
 * (베어메탈 사용률·법인별 서버 사용량의 물리 서버)이 통째로 비었다. 여기서
 *  ① (idrac.js 가 한다) iDRAC 등록부에 **ESXi 가 아닌 물리 서버** 17대를 시드한다(id `mock-bmsrv-` — 이미 하나라도 있으면 다시 하지 않는다,
 *     등록부에 실등록(`mock-` 아님)이 있으면 하지 않는다). 이름이 ESXi 호스트와 겹치지 않으므로 classifyFleet 이 베어메탈로 분류한다.
 *  ② 베어메탈 사용률 폴러가 mock 이면 장비에 접속하지 않고 iDRAC 텔레메트리 모양의 합성 행을 만들고(`demoBmUsageRows`),
 *     원시 14일 + 일 롤업 45일을 1회 백필한다(`backfillBmUsage`).
 *  ③ (idrac.js 가 한다) seed.js 초판이 만든 mock 서비스태그 충돌(`MOCK`+해시 앞 6자리 — 70대가 11개 태그를 공유해 전력·인벤토리가 11대로 합쳐졌다)을
 *     `mock-` 항목에 한해 1회 고친다.
 * 규칙은 flags.js 머리말 — mock 모드에서만, 설정 파일은 바꾸지 않는다(사용률 수집 켜짐·법인 선택은 판정 지점의 데모 값이다).
 */
import { isMockMode, demoHash, demoRand } from './flags.js';
// 베어메탈 사양·시드·서비스태그 보정은 idrac.js 가 소유한다(이 모듈 → idrac.js 단방향 — 순환 금지). 호환을 위해 재수출한다.
import { demoServerProfile, demoLoadAt, BM_PREFIX, demoBareMetalSpecs, bareMetalSpecOf, primeBareMetalSpecs, ensureBareMetalSeed, repairMockServiceTags, _resetBareMetalSeedForTest } from './idrac.js';
export { BM_PREFIX, demoBareMetalSpecs, bareMetalSpecOf, primeBareMetalSpecs, ensureBareMetalSeed, repairMockServiceTags };

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/* ───────────────────────── 베어메탈 사용률 ───────────────────────── */

/**
 * 데모 설정 — 저장된 설정 파일은 바꾸지 않고 판정 지점에서만 덮는다: 수집 켜짐 · 모든 법인 선택 · 귀속 없는 서버 포함 · iDRAC 경로 켬.
 * 가상화 호스트(includeVirtualization)는 저장값 그대로 둔다(켜면 ESXi 186대가 대상이 되어 사용률 화면이 베어메탈을 덮는다).
 */
export function demoBmSettings(saved = {}, vcenters = []) {
  if (!isMockMode()) return saved;
  const corps = { ...(saved.corps || {}) };
  for (const v of vcenters || []) if (v?.id) corps[v.id] = true;
  return { ...saved, enabled: true, corps, includeUnassigned: true, idracTelemetry: true, demo: true };
}

/**
 * v2.719(감사 R1-03): 데모 대상인가 — iDRAC 등록 id(serverId·regId)가 `mock-` 이거나, iDRAC 없이 OS 계정만 있는 대상이면
 * 그 OS 등록 id 가 `mock-` 일 때. mock 모드라도 사람이 등록한 서버(`mock-` 아님)는 합성하지 않고 예전처럼 수집한다
 * (합성 값이 실장비 키로 이력 DB 에 실측처럼 남지 않게 — flags.js 규칙).
 */
export function isDemoBmTarget(tg) {
  const m = (v) => String(v || '').startsWith('mock-');
  if (!tg || typeof tg !== 'object') return false;
  if (m(tg.serverId) || m(tg.idrac?.regId)) return true;
  return !tg.idrac && !String(tg.serverId || '').trim() && m(tg.osHost?.id);
}

const r1 = (v) => Math.round(v * 10) / 10;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * 한 대상의 시각 t 사용률 행 — iDRAC 텔레메트리 경로의 값만(CPU·메모리·I/O 집계·NIC·FC). 디스크 busy·디스크 사용률은
 * 실장비에서도 OS 경로만 주므로 **비워 둔다**(지어내지 않는다 — 화면이 '그 값은 OS 경로만 줍니다' 를 말한다).
 */
export function demoBmUsageRow(target, t) {
  const key = String(target.key || target.serviceTag || target.serverId || target.name || '');
  const spec = bareMetalSpecOf(target.serverId || target.regId || '') || null;
  const p = demoServerProfile({ id: String(target.serverId || key), vcenterId: target.vcenterId }, { spec: spec || { model: target.model || 'PowerEdge R650', loadBase: 20 + (demoHash(key) % 40), gpus: [] } });
  const load = demoLoadAt(p, t);
  const wob = (k) => demoRand(`${key}|${k}|${Math.floor(t / (15 * MIN))}`);
  const memBase = 35 + (demoHash(`mem|${key}`) % 40);
  const netPct = r1(clamp(load * 0.35 + wob('n') * 8, 0, 100));
  const fast = /db|gpu/.test(String(target.name || '')) ? 25e9 : 10e9;
  const hasFc = /db/.test(String(target.name || ''));
  return {
    // v2.719(감사 R1-03): 데모 행 표지 — src 토큰 'demo'. 'idrac' 토큰은 그대로 둔다(iDRAC 출처 판정 bmSrcIsIdrac·IDRAC_ONLY_SQL 이 같게 읽는다).
    key, name: target.name || key, vcenterId: target.vcenterId || '', ts: t, src: 'idrac+demo',
    cpu_pct: r1(load), mem_pct: r1(clamp(memBase + load * 0.25 + (wob('m') - 0.5) * 4, 1, 99)),
    disk_busy_pct: null, disk_used_pct: null,
    net_pct: netPct, net_bps: Math.round((netPct / 100) * (fast / 8)),
    hba_pct: hasFc ? r1(clamp(load * 0.5 + wob('h') * 10, 0, 100)) : null,
    hba_bps: hasFc ? Math.round(clamp(load * 0.5, 0, 100) / 100 * (32e9 / 8)) : null,
    io_pct: r1(clamp(load * 0.45 + wob('i') * 6, 0, 100)),
  };
}

/** 폴러 결과 모양(`collectOne` 과 같은 {ok, target, built:{row}}). */
export function demoBmUsageResults(targets = [], now = Date.now()) {
  return targets.map((tg) => ({ ok: true, target: tg, demo: true, built: { row: demoBmUsageRow(tg, now), srcOf: { cpu: 'idrac', mem: 'idrac', io: 'idrac', net: 'idrac', hba: 'idrac' }, notes: [] } }));
}

let _bmBackfill = null;
/**
 * 사용률 DB 백필 — 원시 14일(30분) + 그 앞 31일은 하루 4점(일 롤업용). 대상의 첫 키에 이력이 있으면 건너뛴다. 1회.
 * insertUsage 가 원시·일 롤업·최신 표를 같은 트랜잭션으로 채운다.
 */
export async function backfillBmUsage(targets = [], { now = Date.now() } = {}) {
  if (!isMockMode() || !targets.length) return { skipped: 'empty' };
  if (_bmBackfill) return _bmBackfill;
  _bmBackfill = (async () => {
    const db = await import('../../bmusage/db.js');
    const { config } = await import('../../config.js');
    const agent = config.agent?.name || '';   // 폴러(insertUsage(rows, config.agent?.name))와 같은 agent 축 — 다르면 최신값이 두 행이 된다
    try {
      const days = await db.usageDaily({ key: String(targets[0].key), agent, days: 45 });
      if (Array.isArray(days) && days.length >= 5) return { skipped: 'exists' };
    } catch { /* */ }
    const rows = [];
    for (let t = Math.floor((now - 45 * DAY) / HOUR) * HOUR; t < now - 14 * DAY; t += 6 * HOUR) for (const tg of targets) rows.push(demoBmUsageRow(tg, t));
    for (let t = Math.floor((now - 14 * DAY) / (30 * MIN)) * 30 * MIN; t < now - 5 * MIN; t += 30 * MIN) for (const tg of targets) rows.push(demoBmUsageRow(tg, t));
    let inserted = 0;
    for (let i = 0; i < rows.length; i += 2_000) {
      const r = await db.insertUsage(rows.slice(i, i + 2_000), agent);
      inserted += r?.inserted || 0;
      await new Promise((res) => setImmediate(res));
    }
    console.log(`[mock] 베어메탈 사용률 데모 백필: ${targets.length}대 · ${inserted}행(원시 14일 + 일 롤업 45일)`);
    return { inserted };
  })();
  return _bmBackfill;
}

export function _resetBareMetalDemoForTest() { _resetBareMetalSeedForTest(); _bmBackfill = null; }

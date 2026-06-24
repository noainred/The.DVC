/**
 * FinOps — 전력 수집(iDRAC/OME/원격) 데이터를 kWh·전기요금·CO2로 환산해 vCenter/지역별로
 * 집계한다. 추가 수집 없이 기존 전력 샘플만 재활용한다. 순간 전력(현재 W)을 기준으로
 * 일/월/년 에너지·비용을 추정하며, PUE로 냉각 등 설비 오버헤드를 반영한다.
 *
 * Config: CONFIG_DIR/finops.json — { tariffPerKwh, currency, co2KgPerKwh, pue }.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const FILE = path.join(config.configDir, 'finops.json');

const DEFAULTS = {
  tariffPerKwh: 130,   // 전기요금 단가(통화/kWh). 한국 산업용 대략치.
  currency: '₩',
  co2KgPerKwh: 0.45,   // 전력 1kWh당 CO2(kg). 국가 전력믹스에 따라 조정.
  pue: 1.5,            // Power Usage Effectiveness(설비 오버헤드). 1.0=서버전력만.
};

let cache = null;
export function loadFinopsConfig() {
  if (cache) return cache;
  cache = { ...DEFAULTS };
  try {
    if (fs.existsSync(FILE)) cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
  } catch { /* defaults */ }
  return cache;
}
export function saveFinopsConfig(body = {}) {
  const cur = loadFinopsConfig();
  const next = {
    tariffPerKwh: Math.max(0, Number(body.tariffPerKwh) || cur.tariffPerKwh),
    currency: String(body.currency || cur.currency).slice(0, 8),
    co2KgPerKwh: Math.max(0, Number(body.co2KgPerKwh) ?? cur.co2KgPerKwh),
    pue: Math.min(5, Math.max(1, Number(body.pue) || cur.pue)),
  };
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  cache = next;
  return next;
}

const round = (x, d = 1) => (x == null || !Number.isFinite(x) ? 0 : Number(x.toFixed(d)));

/**
 * 현재 전력 기준 에너지/비용/탄소 집계.
 * @param snap        store 스냅샷(hosts, vcenters)
 * @param measuredList allMeasuredPower() 결과 — 등록된 '모든' 서버의 측정 전력(서버 단위).
 *                     ESXi 인벤토리에 매핑 안 된 서버도 포함하므로 측정 전력이 누락되지 않는다.
 *                     (하위호환: Map<hostLower,{watts}> 형태가 오면 항목으로 변환)
 */
export function computeFinOps(snap, measuredList, cfg = loadFinopsConfig()) {
  const regionByVc = new Map();
  for (const v of snap.vcenters || []) regionByVc.set(v.id, v.location?.region || v.region || '기타');
  // 인벤토리 호스트명(정규화) → vCenter/모델. 매핑된 서버를 어느 vCenter로 귀속할지 판단.
  const hostInfo = new Map();
  for (const h of snap.hosts || []) hostInfo.set(String(h.name || '').toLowerCase(), { vcenterId: h.vcenterId, model: h.model || '' });

  // 하위호환: Map(host→{watts})가 들어오면 배열로 변환.
  const list = Array.isArray(measuredList)
    ? measuredList
    : [...(measuredList?.entries?.() || [])].map(([host, p]) => ({ serverName: host, host, watts: p?.watts, ts: p?.ts }));

  const byVc = new Map();      // vcId -> { vcId, region, watts, hosts }
  const byRegion = new Map();  // region -> { region, watts, hosts, vcenters:Set }
  const perHost = [];          // [{ host, vcenterId, region, watts }]
  let totalW = 0, measured = 0, unmapped = 0, unmappedW = 0;

  for (const m of list) {
    const w = m.watts;
    if (w == null || !Number.isFinite(w)) continue;
    measured++;
    totalW += w;
    const hi = hostInfo.get(String(m.host || '').toLowerCase());
    const vcId = hi ? hi.vcenterId : '(미매핑)';
    const region = hi ? (regionByVc.get(hi.vcenterId) || '기타') : '(미매핑)';
    if (!hi) { unmapped++; unmappedW += w; }
    perHost.push({ host: m.serverName || m.host, vcenterId: vcId, region, watts: w, model: hi?.model || '', mapped: !!hi });

    const cv = byVc.get(vcId) || { vcId, region, watts: 0, hosts: 0 };
    cv.watts += w; cv.hosts++; byVc.set(vcId, cv);

    const cr = byRegion.get(region) || { region, watts: 0, hosts: 0, vcenters: new Set() };
    cr.watts += w; cr.hosts++; cr.vcenters.add(vcId); byRegion.set(region, cr);
  }

  // 현재 전력(facility = 서버전력 × PUE)으로 기간 에너지·비용·탄소 산출.
  const energy = (watts, hours) => (watts * cfg.pue / 1000) * hours; // kWh
  const money = (kwh) => kwh * cfg.tariffPerKwh;
  const carbon = (kwh) => kwh * cfg.co2KgPerKwh;

  const pack = (watts) => {
    const kwhDay = energy(watts, 24), kwhMonth = energy(watts, 24 * 30), kwhYear = energy(watts, 24 * 365);
    return {
      watts: Math.round(watts),
      facilityWatts: Math.round(watts * cfg.pue),
      kwhDay: round(kwhDay), kwhMonth: round(kwhMonth), kwhYear: round(kwhYear, 0),
      costDay: round(money(kwhDay), 0), costMonth: round(money(kwhMonth), 0), costYear: round(money(kwhYear), 0),
      co2MonthKg: round(carbon(kwhMonth), 0), co2YearKg: round(carbon(kwhYear), 0),
    };
  };

  return {
    config: cfg,
    measuredHosts: measured,         // 측정된 등록 서버 수(매핑 여부 무관)
    totalHosts: (snap.hosts || []).length,
    unmappedServers: unmapped,       // 인벤토리 ESXi 호스트와 매핑 안 된 측정 서버 수
    unmappedWatts: Math.round(unmappedW),
    totals: pack(totalW),
    byVcenter: [...byVc.values()].map((c) => ({ vcId: c.vcId, region: c.region, hosts: c.hosts, ...pack(c.watts) })).sort((a, b) => b.watts - a.watts),
    byRegion: [...byRegion.values()].map((c) => ({ region: c.region, hosts: c.hosts, vcenters: c.vcenters.size, ...pack(c.watts) })).sort((a, b) => b.watts - a.watts),
    topHosts: perHost.sort((a, b) => b.watts - a.watts).slice(0, 20),
    generatedAt: Date.now(),
  };
}

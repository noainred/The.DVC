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
import { buildHostIndex, resolveServerVcenter } from '../idrac/attribution.js';
import { atomicWriteFileSync, preserveCorrupt, safeLoadText } from '../util/atomicWrite.js';
import { makeJsonFileReader } from '../util/jsonFileRead.js';   // 107회차: 읽기 오류 ≠ 손상(공용 읽기 — 30초 간격 재읽기)
import { numOrNull } from '../util/numOrNull.js';

const FILE = path.join(config.configDir, 'finops.json');

const DEFAULTS = {
  tariffPerKwh: 130,   // 전기요금 단가(통화/kWh). 한국 산업용 대략치.
  currency: '₩',
  co2KgPerKwh: 0.45,   // 전력 1kWh당 CO2(kg). 국가 전력믹스에 따라 조정.
  pue: 1.5,            // Power Usage Effectiveness(설비 오버헤드). 1.0=서버전력만.
};

let cache = null;
/*
 * 107회차(재현 — EISDIR): 읽기 오류(EACCES · EIO · EISDIR)는 손상이 아니다 — 예전 catch 하나는 온전한 원본을 .corrupt 로 옮기고 빈 값 · 기본값을 캐시해
 *   다음 저장이 원본 자리를 덮었다. 읽기 단계는 공용 읽기: 원본을 두고 · 캐시하지 않고(30초 간격 재읽기) · 저장을 거절한다(503 settingsUnreadable). parse 실패는 예전과 같다.
 */
const _reader = makeJsonFileReader(() => FILE, { parse: (t) => t, preserve: false, tag: 'finops' });
let _readErr = '';
/** 107회차: 읽기 오류 중의 저장 거절 본문(503) 또는 null. */
export function finopsWriteRefusal() {
  loadFinopsConfig();
  return _readErr ? { ok: false, status: 503, code: 'settingsUnreadable', readError: true, reason: `FinOps 단가 설정 파일(${path.basename(FILE)})을 읽지 못해 저장하지 않았습니다 — 읽기 오류(${_readErr})이고 원본은 그대로 있습니다. 파일 권한 · 소유자 · 디스크를 확인하세요(30초마다 다시 읽고, 읽히면 저장이 다시 열립니다).` } : null;
}
export function loadFinopsConfig() {
  if (cache) return cache;
  const rr = _reader.read();
  if (rr.kind === 'read-error') { _readErr = String(rr.error?.code || 'read-error').slice(0, 32); return { ...DEFAULTS }; }   // 107회차: 캐시하지 않는다 — 쓰기는 거절한다
  _readErr = '';
  cache = { ...DEFAULTS };
  try {
    if (rr.kind === 'ok') cache = { ...DEFAULTS, ...JSON.parse(rr.value) };
  } catch (e) {
    // v2.595(감사 FS-4): 손상을 조용히 기본값으로 넘기면 다음 저장이 원본을 덮는다 — 원본을 보존하고 알린다.
    preserveCorrupt(FILE, e?.message);
    console.warn(`[finops] 설정 파일을 읽지 못해 기본값으로 시작합니다(원본 보존): ${safeLoadText(e) || '사유 미상'}`);
  }
  return cache;
}
export function saveFinopsConfig(body = {}) {
  const cur = loadFinopsConfig();
  { const no = finopsWriteRefusal(); if (no) throw Object.assign(new Error(no.reason), no, { extra: { code: no.code, readError: true } }); }   // 107회차: 읽기 오류 중에는 빈 값 · 기본값 위에 쓰지 않는다

  // v2.611 LEFT2611-05: 세 숫자 칸의 규칙을 하나로 — 빈 값·null·숫자 아님은 **미지정**(이전 값 유지), 명시적 0 은 값이다
  //   (v2.583·v2.596 규약). 예전엔 요금·PUE 가 `Number(x) || cur` 라 0 을 저장할 수 없었고, CO2 는 `Number('') === 0` 이라
  //   빈 칸이 **0(무탄소)** 으로 저장됐다. 음수는 0 으로 자른다(요금·CO2), PUE 는 [1,5].
  const pick = (v, prev) => { const n = numOrNull(v); return n == null ? prev : n; };
  const next = {
    tariffPerKwh: Math.max(0, pick(body.tariffPerKwh, cur.tariffPerKwh)),
    currency: String(body.currency || cur.currency).slice(0, 8),
    co2KgPerKwh: Math.max(0, pick(body.co2KgPerKwh, cur.co2KgPerKwh)),
    pue: Math.min(5, Math.max(1, pick(body.pue, cur.pue))),
  };
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  atomicWriteFileSync(FILE, JSON.stringify(next, null, 2));
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
  const validVcIds = new Set();
  for (const v of snap.vcenters || []) { regionByVc.set(v.id, v.location?.region || v.region || '기타'); validVcIds.add(v.id); }
  // 서버 → vCenter 귀속(명시 vcenterId 우선 → 호스트명 → 서비스태그). 공유 규칙 사용.
  const idx = buildHostIndex(snap.hosts || []);
  const resolve = (m) => resolveServerVcenter(m, idx, validVcIds);

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
    const hi = resolve(m);
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

  // 70회차 F2: 측정한 서버가 0대면 합계는 '모름' 이다 — 0 W · ₩0 · 0 kg 이 아니다(fleetInventory v2.977 bareMetalWatts 와 같은 규약).
  //   키는 그대로 두고 값만 null(화면 포맷터가 '—').
  const unknownPack = () => Object.fromEntries(Object.keys(pack(0)).map((k) => [k, null]));
  return {
    config: cfg,
    measuredHosts: measured,         // 측정된 등록 서버 수(매핑 여부 무관)
    totalHosts: (snap.hosts || []).length,
    unmappedServers: unmapped,       // 인벤토리 ESXi 호스트와 매핑 안 된 측정 서버 수
    unmappedWatts: Math.round(unmappedW),
    totals: measured ? pack(totalW) : unknownPack(),
    byVcenter: [...byVc.values()].map((c) => ({ vcId: c.vcId, region: c.region, hosts: c.hosts, ...pack(c.watts) })).sort((a, b) => b.watts - a.watts),
    byRegion: [...byRegion.values()].map((c) => ({ region: c.region, hosts: c.hosts, vcenters: c.vcenters.size, ...pack(c.watts) })).sort((a, b) => b.watts - a.watts),
    topHosts: perHost.sort((a, b) => b.watts - a.watts).slice(0, 20),
    generatedAt: Date.now(),
  };
}

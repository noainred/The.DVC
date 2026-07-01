import { config, loadVcenterConfig } from './config.js';
import { generateSnapshot } from './mock/generator.js';
import { collectFromVCenter } from './vcenter/restClient.js';
import { describeError } from './util/errors.js';
import { latestPowerByHostName, latestPowerByServiceTag, allMeasuredPower, vcPowerKey } from './idrac/service.js';
import { filterMeasuredByMapping, loadPowerSettings } from './idrac/powerSettings.js';
import { applyFleetAssign } from './insights/fleetAssign.js';
import { getDb as getPowerDb } from './idrac/db.js';
import { loadRegistry as loadIdracRegistry } from './idrac/registry.js';
import { buildHostIndex, resolveServerVcenter } from './idrac/attribution.js';
import { applyMutes } from './alarm-mutes.js';
import { getDataSource } from './runtime-settings.js';
import { buildIpamRows } from './ipam/ledger.js';
import { syncLedger } from './ipam/db.js';
import { getInventory, pruneInventory } from './central/inventory.js';
import { isStopped } from './security/emergencyStop.js';

// 사이트 위임 vCenter가 이 시간 이상 push가 없으면 'stale'로 표시(데이터는 계속 서빙).
const SITE_STALE_MS = Number(process.env.SITE_INVENTORY_STALE_MS) || 300_000;

// 매 폴링 주기의 동시 vCenter 수집 개수 상한(고RTT·다수 vCenter에서 CPU 스파이크 완화).
const COLLECT_CONCURRENCY = Math.max(1, Number(process.env.COLLECT_CONCURRENCY) || 8);

/**
 * Promise.allSettled과 같은 결과 배열([{status,value|reason}])을 돌려주되, 동시 실행을
 * `limit`개로 제한한다. 빈 슬롯이 나는 대로 다음 항목을 시작 → 28개가 한꺼번에 몰리지 않음.
 */
async function collectPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const idx = next++;
      if (idx >= items.length) return;
      try { results[idx] = { status: 'fulfilled', value: await fn(items[idx]) }; }
      catch (reason) { results[idx] = { status: 'rejected', reason }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// IP 대장의 '내용' 지문(djb2). generatedAt 같은 비본질 변화는 제외하고 외부 DB에 반영할
// 실제 변동(IP·소유자·전원·관리상태 등)만 감지해 불필요한 SQLite 재기록을 막는다.
function ledgerSignature(rows) {
  let h = 5381;
  const mix = (s) => { const str = String(s ?? ''); for (let i = 0; i < str.length; i++) h = (((h << 5) + h) ^ str.charCodeAt(i)) >>> 0; };
  mix(rows.length);
  for (const r of rows) {
    mix(r.ip); mix('|'); mix(r.ownerName); mix('|'); mix(r.powerState); mix('|');
    mix(r.mgmtStatus); mix('|'); mix(r.usageStatus); mix('|'); mix(r.duplicate ? 1 : 0); mix('|');
    mix(r.reconcile); mix(';');
  }
  return h;
}

// 등록된 iDRAC 서버 수(OME 자동발견 엔트리 제외). best-effort.
function idracRegisteredCount() {
  try { return loadIdracRegistry().filter((s) => s.type !== 'ome').length; } catch { return 0; }
}

/**
 * Overlay real iDRAC power (Watts) onto hosts by matching the ESXi host name to
 * a registered Dell server. When matched, the measured value takes precedence
 * over any mock/SOAP estimate and is flagged with powerSource='idrac'.
 */
// vCenter 호스트 전력 시계열 적재(throttled prune 포함). 설정 off면 건너뜀.
let _vcPersistTicks = 0;
async function persistVcenterPower(snap) {
  try {
    if (loadPowerSettings().includeVcenterPower === false) return;
    const ts = Date.now();
    const samples = [];
    for (const h of (snap.hosts || [])) {
      const w = Number(h.powerWatts);
      if (!Number.isFinite(w) || w <= 0) continue;
      if (h.powerSource === 'idrac') continue; // iDRAC 전용 소스가 별도 저장하므로 제외
      samples.push({ serverId: vcPowerKey(h.vcenterId, h.name), watts: Math.round(w), ts });
    }
    if (!samples.length) return;
    const db = await getPowerDb();
    if (db.insertMany) db.insertMany(samples);
    // 보존기간 prune은 매 폴이 아니라 가끔(약 10주기)만 — DELETE 스캔 비용 절감.
    if (config.idrac.retentionDays > 0 && (++_vcPersistTicks % 10 === 0)) {
      try { db.prune(ts - config.idrac.retentionDays * 86_400_000); } catch { /* best effort */ }
    }
  } catch { /* best effort — 전력 적재 실패는 수집을 막지 않음 */ }
}

async function overlayIdracPower(snap) {
  try {
    const byName = await latestPowerByHostName();
    const byTag = await latestPowerByServiceTag();
    for (const h of snap.hosts) {
      // 1) 호스트명 일치, 2) 서비스태그 일치(이름이 달라도 Dell 서버 전력 귀속).
      const m = byName.get(String(h.name || '').trim().toLowerCase())
        || byTag.get(String(h.serviceTag || '').trim().toLowerCase());
      // iDRAC 실측을 호스트 '주' 전력(powerWatts)에 덮어쓰지 않는다 — 호스트 전력은 vCenter 추정 유지.
      // iDRAC 값은 참조용으로만 병기(호스트 상세 'iDRAC 실측' 표기 + iDRAC 서버 등록 메뉴에서 별도 집계).
      if (m) { h.powerWattsIdrac = m.watts; h.idracBacked = true; }
    }

    // vCenter PerformanceManager로 수집한 ESXi 호스트 전력을 시계열 DB에 적재(대시보드 24h 피크/평균·추세용).
    // iDRAC으로 이미 덮어쓴 호스트(powerSource='idrac')는 제외(중복 저장 방지). 트랜잭션 배치로 비차단.
    await persistVcenterPower(snap);

    // 전체 측정 전력(iDRAC/OME/원격/vCenter, 매핑 무관)을 vCenter별로 귀속 — Overview 총합·per-vCenter 롤업의 근거.
    // 우선순위: 서버에 명시 지정된 vcenterId → 호스트명 → 서비스태그 → (미매핑).
    // 설정 시 vCenter 미매핑(귀속 안 됨) 측정 전력을 총합/보고/롤업에서 제외.
    // vcenterFirst: 매칭된 Dell 호스트는 vCenter 추정 전력으로, iDRAC은 베어메탈만 — 호스트 전력에 iDRAC을 섞지 않는다.
    const measured = filterMeasuredByMapping(applyFleetAssign(await allMeasuredPower({ hosts: snap.hosts, vcenterFirst: true })), snap);
    const idx = buildHostIndex(snap.hosts);
    const validVcIds = new Set(snap.vcenters.map((v) => v.id));
    const byVc = new Map();
    let totalW = 0, count = 0;
    for (const mm of measured) {
      const w = Number(mm.watts);
      if (!Number.isFinite(w)) continue;
      count++; totalW += w;
      const hit = resolveServerVcenter(mm, idx, validVcIds);
      const vcId = hit ? hit.vcenterId : '(미매핑)';
      byVc.set(vcId, (byVc.get(vcId) || 0) + w);
    }
    snap.measuredPower = { totalWatts: Math.round(totalW), servers: count, byVc: Object.fromEntries(byVc) };
  } catch { /* power overlay is best-effort */ }
  return snap;
}

/** Drop alarms matching user-defined mute rules ("ignore this kind"). */
function applyAlarmMutes(snap) {
  try { snap.alarms = applyMutes(snap.alarms); } catch { /* best effort */ }
  return snap;
}

/**
 * In-memory aggregated store. Holds the most recent global snapshot and
 * refreshes it on an interval. The API reads exclusively from here so HTTP
 * requests never block on slow/unreachable vCenters.
 */
class Store {
  constructor() {
    this.snapshot = emptySnapshot();
    this.lastError = null;
    this.timer = null;
    this.vcCache = new Map(); // vcId -> { ok, data } | { ok:false, vc, err, at }
    this.vcLast = new Map();  // vcId -> last collection attempt (ms)
  }

  async refresh() {
    try {
      // 긴급중단(2인 승인) 활성 시 모든 수집 정지 — 마지막 스냅샷은 그대로 유지.
      if (isStopped()) return;
      const dataSource = getDataSource();
      if (dataSource === 'mock') {
        this.snapshot = withRollups(applyAlarmMutes(await overlayIdracPower(generateSnapshot())));
        this.syncLedger();
        return;
      }

      const { vcenters } = loadVcenterConfig();
      const now = Date.now();
      const globalMs = config.pollIntervalMs;

      // Collect only the vCenters whose own interval has elapsed (or never
      // collected). High-RTT sites can use a longer pollIntervalSec so they
      // don't get re-polled every base tick; disabled ones are skipped.
      const due = vcenters.filter((vc) => {
        if (vc.enabled === false) return false;
        if (vc.maintenance) return false; // 점검중: 수집 일시 중단(연결 실패로 잡지 않음)
        if (vc.collectMode === 'site') return false; // 사이트 위임: 중앙은 직접 폴링하지 않음
        const last = this.vcLast.get(vc.id) || 0;
        const intervalMs = vc.pollIntervalSec > 0 ? vc.pollIntervalSec * 1000 : globalMs;
        return now - last >= intervalMs - 500;
      });
      // 성능: 28개 vCenter를 한꺼번에 수집하면 매 주기 SOAP 파싱이 몰려 CPU가 순간 100%를
      // 찍고 UI가 끊긴다. 동시 수집을 제한(기본 8)해 같은 작업을 평탄하게 흘려보낸다.
      // 느린 1곳은 per-vCenter 타임아웃으로 격리되고, 나머지는 빈 슬롯이 나는 대로 진행.
      const results = await collectPool(due, COLLECT_CONCURRENCY, (vc) => collectFromVCenter(vc));
      results.forEach((r, i) => {
        const vc = due[i];
        this.vcLast.set(vc.id, Date.now());
        if (r.status === 'fulfilled') {
          this.vcCache.set(vc.id, { ok: true, data: r.value });
        } else {
          const d = describeError(r.reason);
          console.error(`[collect] ${vc.id} (${vc.name}) 연결 실패: ${d.message}${d.hint ? ` — ${d.hint}` : ''}`);
          this.vcCache.set(vc.id, { ok: false, vc, err: d, at: Date.now() });
        }
      });
      // Drop cache entries for vCenters that were removed from the registry.
      const ids = new Set(vcenters.map((v) => v.id));
      for (const id of [...this.vcCache.keys()]) if (!ids.has(id)) this.vcCache.delete(id);
      pruneInventory(ids); // 위임 인벤토리 캐시도 동기화

      // Rebuild the merged snapshot from cache every tick (cheap), so non-due
      // vCenters keep serving their last-known data instead of disappearing.
      const merged = emptySnapshot();
      merged.source = dataSource;
      // auto 모드 폴백: 도달 불가 vCenter가 실제로 생겼을 때만 목 데이터를 1회 생성(지연).
      const isAuto = dataSource === 'auto';
      let mockSnap = null;
      const getMock = () => (mockSnap ||= generateSnapshot());
      for (const vc of vcenters) {
        if (vc.enabled === false) {
          merged.vcenters.push({ id: vc.id, name: vc.name, location: vc.location, status: 'disabled' });
          continue;
        }
        // 점검중: 수집 중단. 직전 수집 데이터가 있으면 유지(숫자 사라지지 않게)하되 상태는 '점검중'.
        if (vc.maintenance) {
          const c = this.vcCache.get(vc.id);
          if (c?.ok) {
            const s = c.data;
            merged.vcenters.push({ ...s.vcenter, status: 'maintenance', maintenance: true });
            merged.hosts.push(...s.hosts);
            merged.vms.push(...s.vms);
            merged.datastores.push(...s.datastores);
            merged.networks.push(...s.networks);
            merged.alarms.push(...s.alarms);
          } else {
            merged.vcenters.push({ id: vc.id, name: vc.name, location: vc.location, status: 'maintenance', maintenance: true });
          }
          continue;
        }
        // 사이트 위임 vCenter: 현장 서버가 push한 인벤토리를 병합(중앙 폴링 없음).
        if (vc.collectMode === 'site') {
          const inv = getInventory(vc.id);
          if (inv?.data?.vcenter) {
            const s = inv.data;
            const stale = Date.now() - inv.at > SITE_STALE_MS;
            merged.vcenters.push({ ...s.vcenter, collectSource: 'site', collectedBy: inv.agent, receivedAt: inv.at, stale });
            merged.hosts.push(...(s.hosts || []));
            merged.vms.push(...(s.vms || []));
            merged.datastores.push(...(s.datastores || []));
            merged.networks.push(...(s.networks || []));
            merged.alarms.push(...(s.alarms || []));
          } else {
            merged.vcenters.push({ id: vc.id, name: vc.name, location: vc.location, status: 'pending', collectSource: 'site', note: '사이트 에이전트 수집 대기' });
          }
          continue;
        }
        const c = this.vcCache.get(vc.id);
        if (c?.ok) {
          const s = c.data;
          merged.vcenters.push(s.vcenter);
          merged.hosts.push(...s.hosts);
          merged.vms.push(...s.vms);
          merged.datastores.push(...s.datastores);
          merged.networks.push(...s.networks);
          merged.alarms.push(...s.alarms);
        } else if (c && !c.ok) {
          merged.collectionErrors.push({ vcenterId: vc.id, name: vc.name, ...c.err, at: c.at, fallback: isAuto });
          if (isAuto) pushSite(merged, getMock(), vc.id);
          else merged.vcenters.push({ id: vc.id, name: vc.name, location: vc.location, status: 'unreachable', error: c.err.message, hint: c.err.hint, code: c.err.code });
        } else {
          merged.vcenters.push({ id: vc.id, name: vc.name, location: vc.location, status: 'pending' });
        }
      }

      merged.generatedAt = new Date().toISOString();
      this.snapshot = withRollups(applyAlarmMutes(await overlayIdracPower(merged)));
      this.syncLedger();
      this.lastError = null;
    } catch (err) {
      this.lastError = err.message;
      console.error('[store] refresh failed:', err.message);
    }
  }

  // Export the current IP inventory to the shareable SQLite ledger (best-effort,
  // non-blocking) so other programs can read CONFIG_DIR/ipam.db.
  // 폴링마다 generatedAt이 바뀌어도 IP 내용이 동일하면 DELETE+INSERT(디스크 fsync)를 건너뛴다
  // — 30개·고RTT 확장 시 매 주기 수천 행 재기록으로 이벤트 루프가 막히는 것을 방지(성능 설계).
  syncLedger() {
    try {
      const { rows } = buildIpamRows(this.snapshot);
      const sig = ledgerSignature(rows);
      if (sig === this._lastLedgerSig) return; // 내용 변동 없음 → 쓰기 생략
      this._lastLedgerSig = sig;
      syncLedger(rows);
    } catch { /* best effort */ }
  }

  start() {
    this.refresh();
    this.timer = setInterval(() => this.refresh(), config.pollIntervalMs);
    this.timer.unref?.();
  }

  get() {
    return this.snapshot;
  }
}

function pushSite(target, source, vcId) {
  const vc = source.vcenters.find((v) => v.id === vcId);
  if (vc) target.vcenters.push(vc);
  target.hosts.push(...source.hosts.filter((h) => h.vcenterId === vcId));
  target.vms.push(...source.vms.filter((v) => v.vcenterId === vcId));
  target.datastores.push(...source.datastores.filter((d) => d.vcenterId === vcId));
  target.networks.push(...source.networks.filter((n) => n.vcenterId === vcId));
  target.alarms.push(...source.alarms.filter((a) => a.vcenterId === vcId));
}

function emptySnapshot() {
  return {
    generatedAt: new Date().toISOString(),
    source: getDataSource(),
    vcenters: [], hosts: [], vms: [], datastores: [], networks: [], alarms: [],
    collectionErrors: [],
    rollups: null,
  };
}

/** Compute global / regional / per-vCenter rollups used by the dashboard. */
function withRollups(snap) {
  if (!snap.collectionErrors) snap.collectionErrors = [];
  const sum = (arr, fn) => arr.reduce((a, x) => a + (fn(x) || 0), 0);

  const cpuTotalMhz = sum(snap.hosts, (h) => h.cpuTotalMhz);
  const cpuUsedMhz = sum(snap.hosts, (h) => h.cpuUsageMhz);
  const memTotalMB = sum(snap.hosts, (h) => h.memTotalMB);
  const memUsedMB = sum(snap.hosts, (h) => h.memUsageMB);
  const storCapGB = sum(snap.datastores, (d) => d.capacityGB);
  const storUsedGB = sum(snap.datastores, (d) => d.usedGB);

  const global = {
    vcenters: snap.vcenters.length,
    vcentersConnected: snap.vcenters.filter((v) => v.status === 'connected').length,
    vcentersMaintenance: snap.vcenters.filter((v) => v.status === 'maintenance').length,
    hosts: snap.hosts.length,
    hostsConnected: snap.hosts.filter((h) => h.connectionState === 'CONNECTED').length,
    hostsMaintenance: snap.hosts.filter((h) => h.connectionState === 'MAINTENANCE').length,
    hostsDisconnected: snap.hosts.filter((h) => h.connectionState === 'DISCONNECTED').length,
    vms: snap.vms.length,
    vmsPoweredOn: snap.vms.filter((v) => v.powerState === 'POWERED_ON').length,
    vmsPoweredOff: snap.vms.filter((v) => v.powerState !== 'POWERED_ON').length,
    cpuCores: sum(snap.hosts, (h) => h.cpuCores),
    cpuTotalGhz: round(cpuTotalMhz / 1000, 1),
    cpuUsedGhz: round(cpuUsedMhz / 1000, 1),
    cpuUsagePct: pct(cpuUsedMhz, cpuTotalMhz),
    memTotalGB: round(memTotalMB / 1024, 0),
    memUsedGB: round(memUsedMB / 1024, 0),
    memUsagePct: pct(memUsedMB, memTotalMB),
    storageTotalTB: round(storCapGB / 1024, 1),
    storageUsedTB: round(storUsedGB / 1024, 1),
    storageUsagePct: pct(storUsedGB, storCapGB),
    datastores: snap.datastores.length,
    networks: snap.networks.length,
    alarms: snap.alarms.length,
    alarmsCritical: snap.alarms.filter((a) => a.severity === 'critical').length,
    alarmsWarning: snap.alarms.filter((a) => a.severity === 'warning').length,
    // 총 소비전력: 측정된 '모든' 서버(iDRAC/OME/원격) 합계 — ESXi 호스트로 매핑 안 된 서버도 포함.
    powerWatts: snap.measuredPower ? snap.measuredPower.totalWatts : sum(snap.hosts, (h) => h.powerWatts),
    powerKw: round((snap.measuredPower ? snap.measuredPower.totalWatts : sum(snap.hosts, (h) => h.powerWatts)) / 1000, 1),
    powerReporting: snap.measuredPower ? snap.measuredPower.servers : snap.hosts.filter((h) => h.powerWatts > 0).length,
    // 등록된 Dell iDRAC 서버 수(OME 자동발견 엔트리 제외) — '전력 보고 중' 수량과 비교용.
    powerRegistered: idracRegisteredCount(),
    powerUnmappedKw: round((snap.measuredPower?.byVc?.['(미매핑)'] || 0) / 1000, 1),
  };

  // 성능: 호스트/VM/DS/알람을 vCenter별로 '한 번만' 그룹핑한 뒤 조회한다. 이전에는
  // 그룹마다 snap.hosts.filter(...) 등 전체 재순회로 O(N×그룹수)였다(28 vCenter × 6천 VM).
  const groupByVc = (arr) => {
    const m = new Map();
    for (const x of arr) { let a = m.get(x.vcenterId); if (!a) m.set(x.vcenterId, a = []); a.push(x); }
    return m;
  };
  const hostsByVc = groupByVc(snap.hosts);
  const vmsByVc = groupByVc(snap.vms);
  const dsByVc = groupByVc(snap.datastores);
  const alarmsByVc = groupByVc(snap.alarms);
  const pick = (map, ids) => { const out = []; for (const id of ids) { const a = map.get(id); if (a) for (const x of a) out.push(x); } return out; };

  const byKey = (key) => {
    const groups = new Map();
    for (const v of snap.vcenters) {
      const k = key === 'region' ? v.location?.region || 'Unknown' : v.id;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(v.id);
    }
    return [...groups.entries()].map(([k, ids]) => {
      const h = pick(hostsByVc, ids);
      const v = pick(vmsByVc, ids);
      const d = pick(dsByVc, ids);
      const a = pick(alarmsByVc, ids);
      const cpuT = sum(h, (x) => x.cpuTotalMhz), cpuU = sum(h, (x) => x.cpuUsageMhz);
      const memT = sum(h, (x) => x.memTotalMB), memU = sum(h, (x) => x.memUsageMB);
      const stC = sum(d, (x) => x.capacityGB), stU = sum(d, (x) => x.usedGB);
      return {
        key: k,
        vcenters: ids.length,
        hosts: h.length,
        vms: v.length,
        vmsPoweredOn: v.filter((x) => x.powerState === 'POWERED_ON').length,
        cpuUsagePct: pct(cpuU, cpuT),
        memUsagePct: pct(memU, memT),
        storageUsagePct: pct(stU, stC),
        storageTotalTB: round(stC / 1024, 1),
        alarmsCritical: a.filter((x) => x.severity === 'critical').length,
        alarmsWarning: a.filter((x) => x.severity === 'warning').length,
        // 측정 전력을 vCenter 귀속 기준으로 합산(명시 지정·이름·태그). 호스트 미매핑 서버도 그 vCenter에 포함.
        powerKw: round(ids.reduce((acc, id) => acc + (snap.measuredPower?.byVc?.[id] || 0), 0) / 1000, 1),
      };
    });
  };

  // byKey('vcenter')는 호스트/VM/DS 전체를 재순회하므로 vCenter 수만큼 호출하면 O(N²).
  // 한 번만 계산해 Map으로 조회한다.
  const vcRollup = byKey('vcenter');
  const vcMetrics = new Map(vcRollup.map((x) => [x.key, x]));
  const sites = snap.vcenters.map((vc) => ({ ...vc, metrics: vcMetrics.get(vc.id) }));

  snap.rollups = { global, byRegion: byKey('region'), sites };
  return snap;
}

const round = (v, d) => Number(v.toFixed(d));
const pct = (used, total) => (total > 0 ? Math.round((used / total) * 100) : 0);

export const store = new Store();

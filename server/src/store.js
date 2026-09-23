import crypto from 'node:crypto';
import { config, loadVcenterConfig , secretsReady } from './config.js';
import { withJob } from './perf/monitor.js'; // v2.498: 스톨 발생 시 '진행 중 작업' 표시(계측 전용)
import { generateSnapshot } from './mock/generator.js';
import { collectFromVCenter, vcAuthGuard, isVcAuthError } from './vcenter/restClient.js';
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
import { poolSettled } from './util/pool.js'; // v2.575 IMP-08 — 동시성 풀 단일 소스

/**
 * 사이트 위임 vCenter가 이 시간 이상 push가 없으면 'stale'로 표시(데이터는 계속 서빙).
 * ⚠ v2.575 IMP-11: **export 한다** — `routes/api/portalCheck.js` 가 같은 값을 다시 읽고 있었고
 *   그 주석이 직접 "store.js 와 같은 env·같은 기본값" 이라 적고 있었다. 두 벌이면 한쪽만
 *   바꿨을 때 **인벤토리 점검 화면이 store 와 다른 기준으로 '낡음' 을 세면서도 오류가 없다**.
 */
export const SITE_STALE_MS = Number(process.env.SITE_INVENTORY_STALE_MS) || 300_000;
// 수집 실패 시 마지막 정상 수집(lastGood)을 이월해 서빙하는 최대 시간(v2.279). 이 창 안에서는
// 일시 실패(고RTT 타임아웃 등)로 vCenter 인벤토리가 스냅샷에서 사라지지 않는다(호스트/VM 소실·
// ipam.db 대량 재기록·알람 전원 해소→재발송 방지). 이 창을 넘겨 계속 실패하면 진짜 장기 장애로
// 보고 unreachable 엔트리로 떨어뜨린다(낡은 데이터를 영원히 정상처럼 보여주지 않기 위함).
const LASTGOOD_HOLD_MS = Number(process.env.LASTGOOD_HOLD_MS) || 6 * 3_600_000; // 기본 6시간

// 매 폴링 주기의 동시 vCenter 수집 개수 상한(고RTT·다수 vCenter에서 CPU 스파이크 완화).
const COLLECT_CONCURRENCY = Math.max(1, Number(process.env.COLLECT_CONCURRENCY) || 8);

/**
 * Promise.allSettled과 같은 결과 배열([{status,value|reason}])을 돌려주되, 동시 실행을
 * `limit`개로 제한한다. 빈 슬롯이 나는 대로 다음 항목을 시작 → 28개가 한꺼번에 몰리지 않음.
 * v2.575 IMP-08: 구현은 `util/pool.js poolSettled` 하나다(같은 스캐폴드가 손으로 23벌이었고
 * 항목별 catch 유무가 갈려 있었다). 이 이름은 CLAUDE.md 가 불변조건으로 부르는 것이라 남긴다.
 */
const collectPool = poolSettled;

// IP 대장의 '내용' 지문. generatedAt 같은 비본질 변화는 제외하고 외부 DB에 반영할
// 실제 변동(IP·소유자·전원·관리상태 등)만 감지해 불필요한 SQLite 재기록을 막는다.
// ⚠ v2.590 RT-1: 예전에는 필드마다 문자 단위 JS 루프로 djb2 를 돌려 운영 규모(8천 행)에서 매 폴링(30초) 43ms+ 를
//   메인 스레드에서 썼다(내용이 그대로여도 — '변화 없음' 판정 비용이 매 틱 전량). 행 문자열을 만들어 네이티브 sha1 에
//   넣는다(실측 43.3ms → 13.3ms). 비교 대상 컬럼은 **그대로**다 — 줄이면 외부 ipam.db 가 stale 로 남는다(아래 주석).
export function ledgerSignature(rows) {
  const h = crypto.createHash('sha1');
  const f = (v) => (v == null ? '' : String(v));
  h.update(String(rows.length));
  // db.js toRecord가 ipam.db에 쓰는 '모든' 식별/귀속/관리 컬럼을 지문에 포함한다(타임스탬프
  // firstSeen/lastSeen/updatedAt만 제외). 이전엔 7개 필드만 해시해, label·owner·deviceType·
  // vcenter·host·guestOS·os·cluster·scope·multiHomed 등만 바뀌면 재기록이 스킵되어 외부
  // ipam.db가 stale로 남던 버그가 있었다.
  for (const r of rows) {
    h.update([
      r.ip, r.ipNum, r.vcenterId, r.vcenterName, r.ownerType, r.serverType, r.ownerName,
      r.powerState, r.guestOS, r.osName, r.osVersion, r.hostName, r.cluster, r.scope,
      r.multiHomed ? 1 : 0, r.duplicate ? 1 : 0,
      r.discovery, r.reconcile, r.mgmtStatus, r.owner_, r.label, r.deviceType, r.usageStatus,
      r.appliedBy, r.rangePolicySpec,
    ].map(f).join('|') + ';');
  }
  return h.digest('hex');
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
      // v2.453: db.prune 은 청크 삭제라 **비동기**다 — await 를 빼면 부동 프로미스가 되어
      // 실패가 unhandledRejection 으로 새고 다음 주기와 겹쳐 돌 수 있다.
      // v2.590 P15: 원본(raw)과 롤업의 보존을 idrac/poller 와 같은 두 인자로 나눈다 — 인자 하나로 부르면 원본도
      // retentionDays 까지 남아, iDRAC 을 전부 엣지에 위임한 중앙에서는 IDRAC_RAW_RETENTION_DAYS 가 집행되지 않았다
      // (idrac/poller 는 서버가 0대면 prune 전에 return 한다).
      const keep = config.idrac.retentionDays;
      const raw = config.idrac.rawRetentionDays > 0 ? Math.min(config.idrac.rawRetentionDays, keep) : keep;
      try { await db.prune(ts - raw * 86_400_000, ts - keep * 86_400_000); }
      catch (e) { console.warn(`[store] 전력 prune 실패: ${e.message}`); }
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
    const countByVc = new Map(); // v2.583: 범위 계정 KPI 용(vCenter 별 보고 서버 수 — scopedRollups)
    let totalW = 0, count = 0;
    for (const mm of measured) {
      const w = Number(mm.watts);
      if (!Number.isFinite(w)) continue;
      count++; totalW += w;
      const hit = resolveServerVcenter(mm, idx, validVcIds);
      const vcId = hit ? hit.vcenterId : '(미매핑)';
      byVc.set(vcId, (byVc.get(vcId) || 0) + w);
      countByVc.set(vcId, (countByVc.get(vcId) || 0) + 1);
    }
    snap.measuredPower = { totalWatts: Math.round(totalW), servers: count, byVc: Object.fromEntries(byVc), countByVc: Object.fromEntries(countByVc) };
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

  /**
   * 스냅샷 갱신. opts:
   *  - scheduled: 타이머 틱 — 이전 수집이 진행 중이면 건너뜀(중첩→CPU 누적 악화 방지).
   *  - (기본, 뮤테이션 콜러): 진행 중이면 완료를 기다렸다가 1회 더 실행 — 'vCenter 저장 시 즉시
   *    재수집' 같은 계약이 폴링과 겹쳐도 조용히 유실되지 않는다. 폭주 시 대기 1회로 병합(coalesce).
   *  - collectAll: due(주기) 필터를 무시하고 활성 vCenter 전부 수집 — 'GPU 지금 수집' 등
   *    명시적 수동 수집용(방금 폴링된 vCenter도 다시 수집해 강제 플래그가 소비되게 한다).
   */
  async refresh(opts = {}) {
    const scheduled = !!opts.scheduled;
    const force = opts.force != null ? !!opts.force : !scheduled;
    if (opts.collectAll) this._collectAllPending = true;
    if (this._refreshing) {
      if (!force) return undefined;
      if (!this._forcePending) {
        this._forcePending = (async () => {
          try { await this._inflight; } catch { /* */ }
          this._forcePending = null;
          return this.refresh({ force: true });
        })();
      }
      return this._forcePending;
    }
    const collectAll = this._collectAllPending === true;
    this._collectAllPending = false;
    this._refreshing = true;
    // v2.498: 이벤트 루프 정체가 관측되면 '그때 무엇이 돌던 중' 을 hang 기록에 남긴다(계측만, 동작 무변).
    this._inflight = withJob('store.refresh', () => this._refreshBody(collectAll));
    try { await this._inflight; } finally { this._refreshing = false; this._inflight = null; }
    return undefined;
  }

  async _refreshBody(collectAll = false) {
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
        if (collectAll) return true; // 수동 '지금 수집': 주기 무시하고 전부(동시성 제한은 유지)
        // v2.590(감사 F1): 자격증명 거부로 멈춘 vCenter 는 **주기 수집에서만** 건너뛴다 — 30초마다 같은
        // 계정으로 다시 로그인하면 SSO/AD 계정이 잠긴다. 비밀번호를 고치면(credHash 변경) authStopFor 가
        // 스스로 기록을 지워 이번 주기부터 재개하고, 수동 '지금 수집'(collectAll)은 위에서 이미 통과했다.
        if (vcAuthGuard.authStopFor(vc)) return false;
        const last = this.vcLast.get(vc.id) || 0;
        const intervalMs = vc.pollIntervalSec > 0 ? vc.pollIntervalSec * 1000 : globalMs;
        return now - last >= intervalMs - 500;
      });
      // 성능: 28개 vCenter를 한꺼번에 수집하면 매 주기 SOAP 파싱이 몰려 CPU가 순간 100%를
      // 찍고 UI가 끊긴다. 동시 수집을 제한(기본 8)해 같은 작업을 평탄하게 흘려보낸다.
      // 느린 1곳은 per-vCenter 타임아웃으로 격리되고, 나머지는 빈 슬롯이 나는 대로 진행.
      // per-vCenter '전체' 데드라인(v2.287, 확정 버그 #9). SOAP 타임아웃은 '건별'(soapClient.js)이라
      // 한 vCenter 수집이 login→view→retrieve→GPU 청크 N회→ext/lic→logout 로 9회+ 직렬 왕복하면
      // 그 합이 데드라인 없이 수 분까지 늘어난다. collectPool 은 전부 끝나야 스냅샷을 재구성하므로,
      // 느린 1곳이 이미 끝난 27곳의 신규 데이터 게시까지 막고 재진입 가드로 폴 주기가 늘어졌다.
      // vCenter 하나를 max(건별타임아웃×3, 90초)로 감싸 초과 시 실패로 떨어뜨린다(#2 lastGood 이월로
      // 인벤토리는 유지). '느린 1개가 전체 폴링을 막지 않게' 라는 CLAUDE.md 불변조건을 합산 경로에 적용.
      const vcDeadlineMs = (vc) => Math.max(90_000, (vc?.timeoutMs > 0 ? vc.timeoutMs : 30_000) * 3);
      const withDeadline = (vc) => collectWithDeadline(vc, vcDeadlineMs(vc));
      const results = await collectPool(due, COLLECT_CONCURRENCY, (vc) => withDeadline(vc));
      results.forEach((r, i) => {
        const vc = due[i];
        this.vcLast.set(vc.id, Date.now());
        if (r.status === 'fulfilled') {
          this.vcCache.set(vc.id, { ok: true, data: r.value, at: Date.now() });
          vcAuthGuard.clearAuthStop(vc.id); // 다시 로그인됐다 — 정지 기록 해제(수동 실행으로 확인한 경우 포함)
        } else {
          const d = describeError(r.reason);
          console.error(`[collect] ${vc.id} (${vc.name}) 연결 실패: ${d.message}${d.hint ? ` — ${d.hint}` : ''}`);
          // v2.590(감사 F1): 자격증명 거부면 주기 수집을 멈춘다(재시도해도 결과가 같고 계정만 잠근다).
          // 조용히 멈추지 않는다 — 아래 병합 단계가 `authStopped` 를 vCenter 항목에 실어 화면이 말한다.
          if (isVcAuthError(r.reason)) {
            const rec = vcAuthGuard.markAuthStopped(vc.id, vc, d.message);
            console.warn(`[collect] ${vc.id} (${vc.name}) 인증 실패로 주기 수집 정지(${rec.attempts}회) — 비밀번호를 고치면 자동 재개합니다`);
          }
          // ⚠ 회귀 방지(v2.279): 실패 시 마지막 정상 데이터를 폐기하지 말고 lastGood 으로 이월한다.
          // 과거에는 {ok:false} 로 덮어써 그 vCenter 인벤토리가 스냅샷에서 통째로 사라졌고(호스트/VM
          // 수백 개 소실 플랩), 외부 공유 ipam.db 가 DELETE+INSERT 로 대량 재기록되며, 파생 알람이
          // 전부 '해소' 처리됐다가 복구 시 쿨다운을 무시하고 재발송됐다. restClient.js 주석의
          // '상위(store)가 마지막 정상 캐시를 유지한다'는 계약을 여기서 실제로 이행한다.
          const prev = this.vcCache.get(vc.id);
          const lastGood = prev?.ok ? prev.data : prev?.lastGood;
          const lastGoodAt = prev?.ok ? prev.at : prev?.lastGoodAt;
          this.vcCache.set(vc.id, { ok: false, vc, err: d, at: Date.now(), lastGood, lastGoodAt });
        }
      });
      // Drop cache entries for vCenters that were removed from the registry.
      const ids = new Set(vcenters.map((v) => v.id));
      for (const id of [...this.vcCache.keys()]) if (!ids.has(id)) this.vcCache.delete(id);
      for (const id of [...this.vcLast.keys()]) if (!ids.has(id)) this.vcLast.delete(id); // 마지막 수집시각 맵도 동기화
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
        // v2.590: 인증 실패 정지 기록(있으면 항목에 싣는다 — 화면이 '멈췄다' 를 말한다). 캐시가 ok 면
        // (방금 성공했거나 정지 전 값) 기록은 이미 지워졌거나 무관하다.
        const authStop = c?.ok ? null : authStopView(vcAuthGuard.authStopFor(vc));
        if (c?.ok) {
          const s = c.data;
          merged.vcenters.push(s.vcenter);
          merged.hosts.push(...s.hosts);
          merged.vms.push(...s.vms);
          merged.datastores.push(...s.datastores);
          merged.networks.push(...s.networks);
          merged.alarms.push(...s.alarms);
        } else if (c && !c.ok) {
          merged.collectionErrors.push({ vcenterId: vc.id, name: vc.name, ...c.err, at: c.at, fallback: isAuto, ...(authStop ? { authStopped: authStop } : {}) });
          if (c.lastGood?.vcenter && (Date.now() - (c.lastGoodAt || 0)) <= LASTGOOD_HOLD_MS) {
            // 마지막 정상 수집을 이월(보존 창 안) — 상태는 unreachable + stale 로 표시해 낡은
            // 데이터임을 알리되, 인벤토리·알람은 유지해 소실 플랩·ipam.db 재기록·알람 재발송을 막는다.
            const s = c.lastGood;
            merged.vcenters.push({ ...s.vcenter, status: 'unreachable', stale: true, staleSince: c.lastGoodAt, error: c.err.message, hint: c.err.hint, code: c.err.code, ...(authStop ? { authStopped: authStop } : {}) });
            merged.hosts.push(...s.hosts);
            merged.vms.push(...s.vms);
            merged.datastores.push(...s.datastores);
            merged.networks.push(...s.networks);
            merged.alarms.push(...s.alarms);
          } else if (isAuto && pushSite(merged, getMock(), vc.id, { mock: true })) {
            // auto 폴백: 목 데이터에 이 vc.id가 있으면 그걸로 채운다.
            // v2.443: 채운 vCenter 에 mock 표시를 남긴다 — 이 데이터는 가짜라서 중앙에 push 하면
            // 안 되는데, DATA_SOURCE 는 'auto' 라 기존 차단(source==='mock')을 그냥 통과했다.
          } else {
            // 보존 창을 넘긴 장기 장애(또는 lastGood 없음) → 최소 unreachable 엔트리(인벤토리는 비움).
            merged.vcenters.push({ id: vc.id, name: vc.name, location: vc.location, status: 'unreachable', error: c.err.message, hint: c.err.hint, code: c.err.code, ...(authStop ? { authStopped: authStop } : {}) });
          }
        } else if (authStop) {
          // v2.590: 재시작 직후처럼 캐시는 없는데 정지 기록(파일)이 남아 있는 경우. 주기 수집이 이 vCenter 를
          // 건너뛰므로 'pending(첫 수집 중 — 기다리면 채워진다)' 으로 두면 **영원히 채워지지 않는 거짓 안내**가
          // 된다(v2.509 규약). 연결 실패로 두고 정지 사실을 싣는다.
          merged.collectionErrors.push({ vcenterId: vc.id, name: vc.name, message: authStop.reason, at: authStop.at, fallback: false, authStopped: authStop });
          merged.vcenters.push({ id: vc.id, name: vc.name, location: vc.location, status: 'unreachable', error: authStop.reason, hint: '인증 실패 — 계정/비밀번호 또는 권한을 확인하세요.', authStopped: authStop });
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
      // 서명은 쓰기 '성공 후'에 기록 — 외부 리더의 락 등으로 쓰기가 실패했는데 서명만 갱신되면
      // 내용이 실제로 바뀔 때까지 재시도가 영영 없어 ipam.db가 낡은 채 남는다.
      syncLedger(rows).then((ok) => { if (ok) this._lastLedgerSig = sig; });
    } catch { /* best effort */ }
  }

  start() {
    // v2.479(감사 코어 B-2): 자격증명 복호 모듈(secretVault 지연 import)이 준비된 뒤 첫 수집 — 암호문 로그인 방지.
    secretsReady.then(() => this.refresh({ scheduled: true })).catch(() => {});
    this.timer = setInterval(() => { this.refresh({ scheduled: true }).catch(() => {}); }, config.pollIntervalMs);
    this.timer.unref?.();
  }

  get() {
    return this.snapshot;
  }
}

/**
 * vCenter 1곳 수집 + 데드라인(v2.590 — 감사 F7, v2.417 규약).
 *
 * 예전에는 `Promise.race([collectFromVCenter(vc), guard])` 로 **결과만 포기**했다 — 버려진 수집이 남은
 * SOAP 왕복(건당 최대 30초 × 9회 이상)을 계속 돌리는 동안 `_refreshing` 이 풀리고, 다음 주기가 같은
 * vCenter 에 **두 번째 세션**을 열었다(COLLECT_CONCURRENCY 는 버려진 수집을 세지 않는다). 이제 데드라인에
 * 신호를 **abort** 해 진행 중인 요청을 실제로 끊는다. race 는 남긴다 — 신호가 닿지 않는 구간(워커 파싱 등)이
 * 있어도 결과 대기는 데드라인에서 끝나야 한다.
 * @returns {Promise<object>}
 */
export function collectWithDeadline(vc, deadlineMs, collect = collectFromVCenter) {
  const ac = new AbortController();
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => {
      ac.abort(new Error('vCenter 수집 데드라인'));
      reject(new Error(`vCenter 수집 데드라인 초과(${Math.round(deadlineMs / 1000)}초) — 응답이 느립니다`));
    }, deadlineMs);
    timer.unref?.();
  });
  const work = Promise.resolve().then(() => collect(vc, { signal: ac.signal }));
  work.catch(() => {}); // 데드라인 뒤의 abort 거부가 unhandled 로 남지 않게
  return Promise.race([work, guard]).finally(() => clearTimeout(timer));
}

/** 정지 기록 → 화면·API 용(자격증명 해시는 싣지 않는다). */
function authStopView(rec) {
  if (!rec) return null;
  return { since: rec.since, at: rec.at, attempts: rec.attempts, reason: rec.reason };
}

// 목 스냅샷에서 vcId에 해당하는 사이트를 target에 복사. vc를 찾았으면 true(호출부가 폴백
// 엔트리 삽입 여부를 판단).
function pushSite(target, source, vcId, mark = null) {
  const vc = source.vcenters.find((v) => v.id === vcId);
  if (vc) target.vcenters.push(mark ? { ...vc, ...mark } : vc);
  target.hosts.push(...source.hosts.filter((h) => h.vcenterId === vcId));
  target.vms.push(...source.vms.filter((v) => v.vcenterId === vcId));
  target.datastores.push(...source.datastores.filter((d) => d.vcenterId === vcId));
  target.networks.push(...source.networks.filter((n) => n.vcenterId === vcId));
  target.alarms.push(...source.alarms.filter((a) => a.vcenterId === vcId));
  return !!vc;
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
  snap.rollups = rollupsOf(snap);
  return snap;
}

/**
 * 범위 제한 계정용 롤업(v2.583 감사 #20). ⚠ 전체 롤업을 **필터링하면 안 된다** — `byRegion` 한 행은 그
 *   지역의 **모든** vCenter 합이라(같은 지역의 다른 법인 대수·전력이 섞인다), `global` 은 전 함대 합이다.
 *   v2.582 까지 `/overview` 는 byRegion 을 존재하지 않는 `r.region` 으로 걸러 빈 배열을 주고 `global` 은
 *   **그대로** 내보냈다(범위 계정이 전 함대 vCenter·호스트·VM 수를 봤다 — 실측 11/186/2242).
 *   허용 vCenter 의 원소만으로 **다시 계산**한다. 전 함대 값(iDRAC 등록 수·미매핑 전력)은 null 로 비운다.
 */
export function scopedRollups(snap, allowed) {
  const inV = (x) => allowed.has(x.vcenterId);
  const mp = snap.measuredPower;
  let measuredPower = null;
  if (mp) {
    const byVc = {}; let totalWatts = 0; let servers = mp.countByVc ? 0 : null; // 구 스냅샷(countByVc 없음)은 모른다 — 지어내지 않는다
    for (const id of allowed) {
      const w = Number(mp.byVc?.[id]) || 0; if (w) { byVc[id] = w; totalWatts += w; }
      if (servers != null) servers += Number(mp.countByVc[id]) || 0;
    }
    measuredPower = { totalWatts: Math.round(totalWatts), servers, byVc };
  }
  const view = {
    vcenters: (snap.vcenters || []).filter((v) => allowed.has(v.id)),
    hosts: (snap.hosts || []).filter(inV), vms: (snap.vms || []).filter(inV),
    datastores: (snap.datastores || []).filter(inV), networks: (snap.networks || []).filter(inV),
    alarms: (snap.alarms || []).filter(inV), measuredPower,
  };
  return rollupsOf(view, { scoped: true });
}

function rollupsOf(snap, { scoped = false } = {}) {
  const sum = (arr, fn) => arr.reduce((a, x) => a + (fn(x) || 0), 0);

  // 전역 카운터 단일 루프(v2.343 #10): 종전엔 filter/sum 으로 호스트 8회·VM 2회·알람 2회·DS 2회
  // 전체 재순회했다(6.5천 객체 × ~12패스, 매 30초). 값은 종전과 동일 — 패스 수만 통합.
  const hc = { connected: 0, maintenance: 0, disconnected: 0, cores: 0, cpuT: 0, cpuU: 0, memT: 0, memU: 0, powerW: 0, powerReporting: 0 };
  for (const h of snap.hosts) {
    if (h.connectionState === 'CONNECTED') hc.connected++;
    else if (h.connectionState === 'MAINTENANCE') hc.maintenance++;
    else if (h.connectionState === 'DISCONNECTED') hc.disconnected++;
    hc.cores += h.cpuCores || 0;
    hc.cpuT += h.cpuTotalMhz || 0; hc.cpuU += h.cpuUsageMhz || 0;
    hc.memT += h.memTotalMB || 0; hc.memU += h.memUsageMB || 0;
    hc.powerW += h.powerWatts || 0;
    if (h.powerWatts > 0) hc.powerReporting++;
  }
  let vmsOn = 0;
  for (const v of snap.vms) if (v.powerState === 'POWERED_ON') vmsOn++;
  let alCrit = 0, alWarn = 0;
  for (const a of snap.alarms) {
    if (a.severity === 'critical') alCrit++;
    else if (a.severity === 'warning') alWarn++;
  }
  let storCapGB = 0, storUsedGB = 0;
  for (const d of snap.datastores) { storCapGB += d.capacityGB || 0; storUsedGB += d.usedGB || 0; }
  const cpuTotalMhz = hc.cpuT, cpuUsedMhz = hc.cpuU, memTotalMB = hc.memT, memUsedMB = hc.memU;

  const global = {
    vcenters: snap.vcenters.length,
    vcentersConnected: snap.vcenters.filter((v) => v.status === 'connected').length,
    vcentersMaintenance: snap.vcenters.filter((v) => v.status === 'maintenance').length,
    hosts: snap.hosts.length,
    hostsConnected: hc.connected,
    hostsMaintenance: hc.maintenance,
    hostsDisconnected: hc.disconnected,
    vms: snap.vms.length,
    vmsPoweredOn: vmsOn,
    vmsPoweredOff: snap.vms.length - vmsOn,
    cpuCores: hc.cores,
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
    alarmsCritical: alCrit,
    alarmsWarning: alWarn,
    // 총 소비전력: 측정된 '모든' 서버(iDRAC/OME/원격) 합계 — ESXi 호스트로 매핑 안 된 서버도 포함.
    powerWatts: snap.measuredPower ? snap.measuredPower.totalWatts : hc.powerW,
    powerKw: round((snap.measuredPower ? snap.measuredPower.totalWatts : hc.powerW) / 1000, 1),
    powerReporting: snap.measuredPower ? (snap.measuredPower.servers ?? null) : hc.powerReporting,
    // 등록된 Dell iDRAC 서버 수(OME 자동발견 엔트리 제외) — '전력 보고 중' 수량과 비교용.
    powerRegistered: scoped ? null : idracRegisteredCount(), // 전 함대 등록 수 — 범위 계정에는 주지 않는다
    powerUnmappedKw: scoped ? null : round((snap.measuredPower?.byVc?.['(미매핑)'] || 0) / 1000, 1),
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
        // 사용량/전체 병기용(v2.232) — %만으로는 규모가 안 보인다(카드에서 "63% · 69/110 TB" 표기).
        cpuUsedGhz: round(cpuU / 1000, 1),
        cpuTotalGhz: round(cpuT / 1000, 1),
        memUsedGB: Math.round(memU / 1024),
        memTotalGB: Math.round(memT / 1024),
        storageUsedTB: round(stU / 1024, 1),
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

  return { global, byRegion: byKey('region'), sites };
}

const round = (v, d) => Number(v.toFixed(d));
const pct = (used, total) => (total > 0 ? Math.round((used / total) * 100) : 0);

export const store = new Store();

/**
 * vCenter 인벤토리 수집 상태(v2.560) — 엣지 로그·진행상태(`edgelog/spec.js`)가 읽는다.
 *
 * 왜 필요한가: 중앙의 '에이전트 수신 트래픽 진단' 이 어떤 엣지의 push 를 `호스트 0 · VM 0` 으로
 * 받으면 화면이 **'빈 인벤토리'** 라고만 말했다. 그런데 그 한 배지가 **조치가 정반대인 상황들**을
 * 덮는다 — 그 엣지에 vCenter 등록이 0개(등록해야 한다) / 첫 수집 중(기다리면 된다) /
 * vCenter 접속 실패(자격증명·방화벽) / mock 데이터라 push 에서 빠졌다 / 그 vCenter 가 실제로 비었다.
 * 이 상태를 중앙이 **당겨서** 읽으면 그 구분이 가능해진다(v2.549 pull — 새 네트워크 허용 불필요).
 *
 * ⚠ **자격증명을 담지 않는다** — vCenter id·이름·상태·오류 문구까지다(호스트명은 오류 문구에
 *   들어갈 수 있고, 그것은 엣지 로그와 같은 노출 수준이다. 응답은 `edgelog/redact.js` 를 지난다).
 * ⚠ 목록에 **상한을 둔다**(64) — 잘렸으면 개수를 밝힌다(조용한 상한 금지).
 */
export function storeStatus() {
  const snap = store.snapshot || {};
  const all = Array.isArray(snap.vcenters) ? snap.vcenters : [];
  const MAX = 64;
  const counts = { total: all.length, ok: 0, pending: 0, unreachable: 0, disabled: 0, mock: 0, site: 0, other: 0 };
  for (const vc of all) {
    if (vc.mock === true) counts.mock += 1;
    if (vc.collectMode === 'site' || vc.collectSource === 'site') counts.site += 1;
    const st = String(vc.status || '').toLowerCase();
    if (st === 'ok' || st === 'connected' || st === '') counts.ok += 1;
    else if (st === 'pending') counts.pending += 1;
    else if (st === 'unreachable') counts.unreachable += 1;
    else if (st === 'disabled') counts.disabled += 1;
    else counts.other += 1;
  }
  return {
    // ⚠ 등록 자체가 0 인 것과 '수집이 아직 없다' 는 다르다 — 둘을 구분할 수 있게 함께 낸다.
    registered: all.length,
    generatedAt: snap.generatedAt || null,
    lastError: store.lastError || null,
    refreshing: store._refreshing === true,
    intervalMs: config.pollIntervalMs,
    counts,
    truncated: all.length > MAX,
    omitted: Math.max(0, all.length - MAX),
    vcenters: all.slice(0, MAX).map((vc) => ({
      id: vc.id, name: vc.name || '', status: vc.status || 'ok',
      hosts: Array.isArray(vc.hosts) ? vc.hosts.length : (vc.hostCount ?? null),
      vms: Array.isArray(vc.vms) ? vc.vms.length : (vc.vmCount ?? null),
      mock: vc.mock === true,
      collectMode: vc.collectMode || vc.collectSource || '',
      error: vc.error || '', code: vc.code || '', hint: vc.hint || '',
    })),
  };
}

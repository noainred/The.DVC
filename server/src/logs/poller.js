/**
 * vCenter 이벤트 로그 수집 폴러 — 주기적으로 각 vCenter의 신규 이벤트를 가져와 장기 보관 DB에
 * 누적하고, 보관기간 초과분을 정리한다. mock 모드에서는 합성 이벤트로 UI를 채운다.
 */

import { config, loadVcenterConfig } from '../config.js';
import { poolRun } from '../util/pool.js';   // v2.447: vCenter 병렬 수집(감사 T2) · v2.579: routes 의존 제거
import { store } from '../store.js';
import { collectVCenterEvents } from '../vcenter/soapClient.js';
import { getLogsDb } from './db.js';
import { loadLogSettings } from './settings.js';

const SEV_RANK = { info: 0, warning: 1, error: 2 };
// 동시 수집 상한 — 28개를 한꺼번에 열면 매 주기 SOAP 파싱이 몰린다(store.collectPool 과 같은 취지).
const LOG_CONCURRENCY = Math.max(1, Math.min(16, Number(process.env.VCLOGS_CONCURRENCY) || 6));
const DAY = 86_400_000;

let timer = null;
let lastRun = null;
let running = false;
let tick = 0; // prune/용량점검 스로틀용(매 폴 DELETE 스캔 방지)
const PRUNE_EVERY = 10; // N폴마다 1회만 보관기간/용량 정리

const MOCK_TYPES = [
  ['UserLoginSessionEvent', 'info', (u, e) => `User ${u} logged in`],
  ['VmPoweredOnEvent', 'info', (u, e) => `${e} is powered on`],
  ['VmPoweredOffEvent', 'info', (u, e) => `${e} is powered off`],
  ['VmMigratedEvent', 'info', (u, e) => `Migrated ${e} (vMotion)`],
  ['AlarmStatusChangedEvent', 'warning', (u, e) => `Alarm changed to Yellow on ${e}`],
  ['HostConnectionLostEvent', 'error', (u, e) => `Lost connection to host ${e}`],
  ['DatastoreCapacityIncreasedEvent', 'info', (u, e) => `Datastore ${e} capacity changed`],
  ['VmReconfiguredEvent', 'info', (u, e) => `Reconfigured ${e}`],
];
// mock: sinceTs~now 사이에 분산된 합성 이벤트 N개.
function synthEvents(vcId, sinceTs, n) {
  const snap = store.get();
  const hosts = (snap.hosts || []).filter((h) => h.vcenterId === vcId);
  const vms = (snap.vms || []).filter((v) => v.vcenterId === vcId);
  const names = [...hosts.map((h) => h.name), ...vms.map((v) => v.name)];
  if (!names.length) return [];
  const now = Date.now();
  const span = Math.max(1, now - sinceTs);
  const out = [];
  for (let i = 0; i < n; i++) {
    const [type, sev, msg] = MOCK_TYPES[(i + vcId.length) % MOCK_TYPES.length];
    const entity = names[(i * 7 + vcId.length) % names.length];
    const ts = sinceTs + Math.floor(((i + 1) / (n + 1)) * span);
    out.push({ key: `mock-${vcId}-${ts}-${i}`, ts, type, severity: sev, user: 'administrator@vsphere.local', entity, message: msg('administrator@vsphere.local', entity) });
  }
  return out;
}

export async function pollLogsOnce() {
  if (running) return lastRun;
  const s = loadLogSettings();
  if (!s.enabled) { lastRun = { at: Date.now(), collected: 0, skipped: true }; return lastRun; }
  running = true;
  try {
    const db = await getLogsDb();
    const mock = config.dataSource === 'mock';
    const minRank = SEV_RANK[s.minSeverity] || 0;
    const vcs = mock ? (store.get().vcenters || []).map((v) => ({ id: v.id, name: v.name })) : (loadVcenterConfig().vcenters || []);
    let collected = 0;
    // v2.447(감사 T2): vCenter 를 **병렬 + per-vCenter 데드라인**으로 수집한다.
    // 예전에는 순차 await 라 vCenter 당 왕복 5회 이상(login→createCollector→readNext…→destroy→logout)이
    // 그대로 더해졌다 — 28곳 중 폴란드·미 동부처럼 RTT 800ms 를 넘는 곳이 섞이면 한 주기가 10초를
    // 훌쩍 넘고, 이벤트가 많아 readNext 가 여러 번 돌면 수십 초까지 늘어났다. '수집은 병렬 + per-vCenter
    // 타임아웃, 느린 1개가 전체를 막지 않게' 라는 CLAUDE.md 불변조건이 이 폴러에만 빠져 있었다.
    // DB 적재는 수집이 끝난 뒤 메인에서 한 번에 한다(동시 write 로 SQLITE_BUSY 를 만들지 않게).
    const deadlineMs = (vc) => Math.max(60_000, (vc?.timeoutMs > 0 ? vc.timeoutMs : 30_000) * 2);
    const withDeadline = (vc, p) => {
      let timer;
      const guard = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`수집 데드라인 초과(${Math.round(deadlineMs(vc) / 1000)}초)`)), deadlineMs(vc));
        timer.unref?.();
      });
      return Promise.race([p, guard]).finally(() => clearTimeout(timer));
    };
    const perVc = [];
    await poolRun(vcs, LOG_CONCURRENCY, async (vc) => {
      try {
        const last = db.lastTs(vc.id);
        const sinceTs = last ? last + 1 : Date.now() - 7 * DAY; // 첫 수집은 최근 7일
        const events = mock
          ? synthEvents(vc.id, sinceTs, 25)
          : await withDeadline(vc, collectVCenterEvents(vc, { sinceTs, max: s.maxPerPoll }));
        const rows = events
          .filter((e) => (SEV_RANK[e.severity] || 0) >= minRank)
          .map((e) => ({ vcenterId: vc.id, key: e.key, ts: e.ts, severity: e.severity, type: e.type, user: e.user, entity: e.entity, message: e.message }));
        if (rows.length) perVc.push(rows);
      } catch (e) { console.warn(`[vclogs] ${vc.id} 수집 실패: ${e.message}`); }
    });
    for (const rows of perVc) { db.insertMany(rows); collected += rows.length; }
    // prune/용량 점검은 매 폴이 아니라 N폴마다 1회(DELETE 스캔·크기 계산 비용 절감).
    // ⚠ v2.503: `tick++ % N === 0` 은 tick 초기값이 0 이라 **첫 폴에서 즉시 참**이었다 —
    // metrics/sampler.js 가 금지한 v2.453 패턴과 같다(보존기간을 365→90일로 줄이고 재시작하면
    // 기동 30초 뒤 첫 폴이 수백만 행 삭제 + VACUUM 을 동기로 돈다). 전위 증가로 바꾼다.
    if ((++tick % PRUNE_EVERY) === 0) {
      if (s.retentionDays > 0) {
        const removed = db.prune(Date.now() - s.retentionDays * DAY);
        if (removed) console.log(`[vclogs] 보관기간(${s.retentionDays}일) 초과 ${removed}건 정리`);
      }
      // 용량 제한: DB가 maxSizeMB를 넘으면 오래된 것부터 삭제. VACUUM(전체 재작성, 동기)은
      // 삭제 루프 '밖'에서 1회만 — 루프 안에서 매 회 VACUUM하면 이벤트 루프가 초~분 단위로 멈춘다.
      if (s.maxSizeMB > 0) {
        const limit = s.maxSizeMB * 1024 * 1024;
        let size = db.sizeBytes(), guard = 0, dropped = 0;
        // ⚠ v2.503: 행 수는 **루프 밖에서 1회만** 센다. 예전에는 매 반복 `db.meta().count` 를 불렀는데
        // meta() 는 COUNT/MIN/MAX + `GROUP BY vcenterId` 로 **풀스캔 2회**다 — 상한 50회 × 2 = 최악
        // 100회 전체 스캔이 한 틱 안에서 동기로 돌았다(삭제 자체의 스캔은 별도). 삭제한 만큼 빼가며
        // 추정하면 되고(바로 아래 `size` 가 이미 같은 방식이다), 카운트가 조금 낡아도 영향은
        // '이번 회차에 지우는 행 수' 뿐이다. 행 수만 필요하므로 GROUP BY 가 없는 `rowCount()` 를 쓴다.
        let cnt = typeof db.rowCount === 'function' ? db.rowCount() : db.meta().count;
        while (size > limit && guard++ < 50) {
          if (cnt <= 0) break;
          const n = db.pruneOldest(Math.max(500, Math.floor(cnt * 0.1)));
          if (!n) break;
          dropped += n; cnt -= n; size -= n * 220; // 행당 대략치로 추정(매 회 statSync/ VACUUM 회피)
        }
        // VACUUM 은 파일 전체 재작성(동기)이다. 그래도 부르는 이유: 삭제만으로는 파일 크기가 줄지
        // 않아 `sizeBytes()` 기준 루프가 다음 주기에도 계속 참이 되어 **로그를 전부 지운다**.
        // 루프 '밖에서 1회' 규약은 유지한다.
        if (dropped) { db.vacuum(); console.log(`[vclogs] 용량 제한(${s.maxSizeMB}MB) 초과 → 오래된 ${dropped}건 정리`); }
      }
    }
    lastRun = { at: Date.now(), collected };
    if (collected) console.log(`[vclogs] ${collected}건 장기 보관`);
    return lastRun;
  } finally { running = false; }
}

function schedule() {
  if (timer) { clearInterval(timer); timer = null; }
  const s = loadLogSettings();
  if (!s.enabled) return;
  timer = setInterval(() => pollLogsOnce().catch((e) => console.warn(`[vclogs] poll 오류: ${e.message}`)), s.pollIntervalMin * 60_000);
  timer.unref?.();
}

export function startLogPoller() {
  schedule();
  setTimeout(() => pollLogsOnce().catch(() => {}), 30_000).unref?.();
  console.log('[vclogs] vCenter 로그 보관 폴러 시작');
}

export function rescheduleLogPoller() { schedule(); }

export async function logStatus() {
  const db = await getLogsDb();
  return { settings: loadLogSettings(), lastRun, store: db.meta(), dbKind: db.kind, dbPath: db.path, dbSizeBytes: db.sizeBytes() };
}

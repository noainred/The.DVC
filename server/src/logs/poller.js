/**
 * vCenter 이벤트 로그 수집 폴러 — 주기적으로 각 vCenter의 신규 이벤트를 가져와 장기 보관 DB에
 * 누적하고, 보관기간 초과분을 정리한다. mock 모드에서는 합성 이벤트로 UI를 채운다.
 */

import { config, loadVcenterConfig, clampIntervalMs } from '../config.js';
import { poolRun } from '../util/pool.js';   // v2.447: vCenter 병렬 수집(감사 T2) · v2.579: routes 의존 제거
import { store } from '../store.js';
import { collectVCenterEvents } from '../vcenter/soapClient.js';
import { vcAuthGuard } from '../vcenter/restClient.js';
import { getLogsDb } from './db.js';
import { loadLogSettings } from './settings.js';
import { demoLoginFailEvents } from '../mock/demo/users.js'; // v2.708 로그인 실패 분석 데모(mock 에서만)

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
  ['DrsVmMigratedEvent', 'info', (u, e) => `DRS migrated ${e}`],          // v2.702(A7)
  ['PermissionAddedEvent', 'info', (u, e) => `Permission created for ${e}`], // v2.702(A8)
  ['VmCreatedEvent', 'info', (u, e) => `Created virtual machine ${e}`],      // v2.706(C5)
  ['VmClonedEvent', 'info', (u, e) => `Clone of VM completed: ${e}`],
  ['VmRemovedEvent', 'info', (u, e) => `Removed ${e} on host`],
  ['VmDeployedEvent', 'info', (u, e) => `Template deployed to ${e}`],
  ['EnteredMaintenanceModeEvent', 'info', (u, e) => `Host ${e} in maintenance mode`], // v2.706(C4)
  ['VmGuestRebootEvent', 'info', (u, e) => `Guest OS reboot for ${e}`],          // v2.707(C6) 대비
  ['VmRestartedOnAlternateHostEvent', 'warning', (u, e) => `${e} was restarted on another host by vSphere HA`],
];
// v2.702(A7·A8): 합성 이벤트의 상세 — 실수집(vmchanges/eventDetail.js)과 같은 모양.
const VM_EVENT = new Set(['VmPoweredOnEvent', 'VmPoweredOffEvent', 'VmMigratedEvent', 'VmReconfiguredEvent', 'DrsVmMigratedEvent',
  'VmCreatedEvent', 'VmClonedEvent', 'VmDeployedEvent', 'VmGuestRebootEvent', 'VmRestartedOnAlternateHostEvent']);
const HOST_EVENT = new Set(['EnteredMaintenanceModeEvent', 'HostConnectionLostEvent']);
function synthDetail(type, i, hosts) {
  const h = (k) => hosts.length ? hosts[(i + k) % hosts.length].name : null;
  if (type === 'VmMigratedEvent') return i % 3 === 0 ? { from: h(0), to: h(0), fromDs: `ds-${i % 4}`, toDs: `ds-${(i + 1) % 4}`, kind: 'svmotion' } : { from: h(0), to: h(1), fromDs: 'ds-0', toDs: 'ds-0', kind: 'vmotion' };
  if (type === 'DrsVmMigratedEvent') return { from: h(1), to: h(2), fromDs: 'ds-0', toDs: 'ds-0', kind: 'drs' };
  if (type === 'VmReconfiguredEvent') return i % 2 ? { modified: `config.hardware.numCPU: 2 -> 4; config.hardware.memoryMB: 8192 -> 16384`, fields: ['numCPUs', 'memoryMB'], numCpu: 4, memoryMB: 16384 } : { added: 'config.hardware.device(2001): (key = 2001, deviceInfo = (label = "Hard disk 2"))', fields: ['deviceChange'], devices: ['add VirtualDisk'] };
  if (type === 'PermissionAddedEvent') return { principal: `CORP\\ops${i % 3}`, role: i % 2 ? 'Admin' : 'ReadOnly', group: null, propagate: true };
  // v2.706(C5): 생성·삭제 — 실수집(lifeDetail)과 같은 모양.
  if (type === 'VmCreatedEvent') return { kind: 'create', host: h(0), ds: `ds-${i % 4}` };
  if (type === 'VmClonedEvent') return { kind: 'clone', host: h(1), ds: `ds-${i % 4}`, source: `template-src-${i % 3}` };
  if (type === 'VmDeployedEvent') return { kind: 'deploy', host: h(2), ds: `ds-${i % 4}`, source: `tpl-rhel9-${i % 2}` };
  if (type === 'VmRemovedEvent') return { kind: 'remove', host: h(0) };
  return null;
}
// v2.710: 데모 첫 수집 기간(일) — 가용성 화면의 가장 긴 보기(90일)를 덮는다.
export const MOCK_FIRST_DAYS = 91;
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
    // VM 이벤트는 VM 이름으로(이동·구성 변경 화면이 VM 으로 묶는다) — 같은 VM 이 여러 번 옮겨 다니게 앞쪽 VM 에 몰아 준다.
    const entity = type === 'VmRemovedEvent' ? `retired-vm-${(i * 5 + vcId.length) % 40}`   // 삭제된 VM 은 인벤토리에 없다
      : HOST_EVENT.has(type) && hosts.length ? hosts[(i + vcId.length) % hosts.length].name
        : VM_EVENT.has(type) && vms.length ? vms[(i * 3 + vcId.length) % Math.min(vms.length, 12)].name : names[(i * 7 + vcId.length) % names.length];
    const ts = sinceTs + Math.floor(((i + 1) / (n + 1)) * span);
    const d = synthDetail(type, i, hosts);
    const user = /^Vm(Created|Cloned|Deployed|Removed)Event$/.test(type) ? ['administrator@vsphere.local', 'CORP\\ops1', 'svc-automation@vsphere.local'][i % 3] : 'administrator@vsphere.local';
    out.push({ key: `mock-${vcId}-${ts}-${i}`, ts, type, severity: sev, user, entity, message: msg(user, entity), detail: d ? JSON.stringify(d) : null });
  }
  // v2.706(C4): 최근 재부팅한 호스트의 절반은 부팅 직전 연결 끊김(예기치 않은 재부팅 갈래), 나머지 일부는 유지보수 모드 진입(계획) —
  //   실수집과 같은 종류·시각 관계로 합성한다. 그 시각이 이번 수집 구간 안일 때만.
  for (const [k, h] of hosts.entries()) {
    if (!Number.isFinite(h.bootTime)) continue;
    const ts = h.bootTime - (k % 2 ? 10 * 60_000 : 3 * 3_600_000);
    if (ts < sinceTs || ts > now) continue;
    const type = k % 2 ? 'HostConnectionLostEvent' : 'EnteredMaintenanceModeEvent';
    out.push({ key: `mock-${vcId}-boot-${h.name}-${ts}`, ts, type, severity: type === 'HostConnectionLostEvent' ? 'error' : 'info', user: type === 'HostConnectionLostEvent' ? '' : 'administrator@vsphere.local', entity: h.name, message: `${type === 'HostConnectionLostEvent' ? 'Lost connection to host' : 'Host in maintenance mode'} ${h.name}`, detail: null });
  }
  // v2.708: 로그인 실패(BadUsername·SSO LoginFailure) — 시간 슬롯마다 결정적, 일부 vCenter 는 같은 출처의 무차별 대입.
  //   위 MOCK_TYPES 회전과 섞지 않고 덧붙인다(다른 화면이 쓰는 합성 이벤트 분포를 바꾸지 않게).
  for (const e of demoLoginFailEvents(vcId, sinceTs, now)) out.push(e);
  return out;
}

// ⚠ setTimeout 은 2^31−1ms 를 넘으면 1ms 가 된다(v2.591 L2·L3) — 옛 저장값의 거대한 timeoutMs 가 데드라인을 즉시 발화시키지 않게 자른다.
export const vcLogDeadlineMs = (vc) => Math.min(2_147_000_000, Math.max(60_000, (vc?.timeoutMs > 0 ? vc.timeoutMs : 30_000) * 2));
// v2.598 T2598-02: 데드라인이 **결과만 포기**하던 것(Promise.race)에 AbortController 를 더한다 — 시한이 되면
// signal 을 abort 해 수집기가 남은 SOAP 왕복(ReadNextEvents…)을 멈출 수 있게 한다(store.collectWithDeadline ·
// v2.417 '세션을 실제로 끊는다' 규약). race 는 남긴다 — 신호를 아직 읽지 않는 수집기도 결과는 기다리지 않는다.
export function vcLogWithDeadline(vc, run, ms = vcLogDeadlineMs(vc)) {
  const ac = new AbortController();
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => { ac.abort(); reject(new Error(`수집 데드라인 초과(${Math.round(ms / 1000)}초)`)); }, ms);
    timer.unref?.();
  });
  return Promise.race([run(ac.signal), guard]).finally(() => clearTimeout(timer));
}

/**
 * @param {{manual?: boolean}} [opts] manual — 관리자 '지금 수집'. v2.590: 인증 실패로 멈춘 vCenter 는
 *   **주기 수집에서만** 건너뛴다(store 와 같은 정지 기록 — 같은 계정이다. 로그 폴러가 따로 로그인하면
 *   store 가 멈춰도 계정 잠금은 그대로다). 수동 실행은 막지 않는다(authGuard 규칙 3).
 */
export async function pollLogsOnce({ manual = false } = {}) {
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
    const authStopped = [];   // v2.590: 이번 주기에 인증 실패 정지로 건너뛴 vCenter — 조용히 빼지 않고 밝힌다
    // v2.447(감사 T2): vCenter 를 **병렬 + per-vCenter 데드라인**으로 수집한다.
    // 예전에는 순차 await 라 vCenter 당 왕복 5회 이상(login→createCollector→readNext…→destroy→logout)이
    // 그대로 더해졌다 — 28곳 중 폴란드·미 동부처럼 RTT 800ms 를 넘는 곳이 섞이면 한 주기가 10초를
    // 훌쩍 넘고, 이벤트가 많아 readNext 가 여러 번 돌면 수십 초까지 늘어났다. '수집은 병렬 + per-vCenter
    // 타임아웃, 느린 1개가 전체를 막지 않게' 라는 CLAUDE.md 불변조건이 이 폴러에만 빠져 있었다.
    // DB 적재는 수집이 끝난 뒤 메인에서 한 번에 한다(동시 write 로 SQLITE_BUSY 를 만들지 않게).
    const perVc = [];
    await poolRun(vcs, LOG_CONCURRENCY, async (vc) => {
      if (!mock && !manual && vcAuthGuard.authStopFor(vc)) { authStopped.push(vc.id); return; }
      try {
        const last = db.lastTs(vc.id);
        // 첫 수집은 최근 7일. v2.710: 데모(mock)는 91일 — VM 가용성(7·30·90일 보기)이 합성 이벤트 7일치만으로
        //   전 VM 을 '수집 시작부터만 잼(일부 기간)' 으로 내던 공백. 이벤트 수도 기간에 비례(7일마다 25건).
        const firstDays = mock ? MOCK_FIRST_DAYS : 7;
        const sinceTs = last ? last + 1 : Date.now() - firstDays * DAY;
        const events = mock
          ? synthEvents(vc.id, sinceTs, last ? 25 : 25 * Math.ceil(firstDays / 7))
          : await vcLogWithDeadline(vc, (signal) => collectVCenterEvents(vc, { sinceTs, max: s.maxPerPoll, signal }));
        const rows = events
          .filter((e) => (SEV_RANK[e.severity] || 0) >= minRank)
          .map((e) => ({ vcenterId: vc.id, key: e.key, ts: e.ts, severity: e.severity, type: e.type, user: e.user, entity: e.entity, message: e.message, detail: e.detail ?? null }));
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
        // v2.601(감사 DB2601-03): 한 방 DELETE(183만 행 4.8초 정지)가 아니라 청크 + 양보로 지우고, 보고 건수는 실제 전체다.
        //   상한(PRUNE_MAX_ROWS)에 걸리면 남은 분은 다음 prune 주기가 잇는다 — 그 사실을 로그에 적는다.
        const before = Date.now() - s.retentionDays * DAY;
        const r = typeof db.pruneAsync === 'function' ? await db.pruneAsync(before) : { deleted: db.prune(before), done: true };
        if (r.deleted) console.log(`[vclogs] 보관기간(${s.retentionDays}일) 초과 ${r.deleted}건 정리${r.done === false ? ' — 상한에 걸려 다음 주기에 계속' : ''}`);
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
          // v2.601(DB2601-03): 한 단계(행 수의 10%)를 청크(pruneOldest 가 PRUNE_CHUNK_ROWS 로 묶는다)로 나눠 지우고
          //   청크마다 이벤트 루프에 양보한다 — 예전에는 10% 를 한 문장으로 최대 50회 연달아 동기로 지웠다.
          const want = Math.max(500, Math.floor(cnt * 0.1));
          let n = 0;
          while (n < want) {
            const k = db.pruneOldest(want - n);
            if (!k) break;
            n += k;
            await new Promise((res) => setImmediate(res));
          }
          if (!n) break;
          dropped += n; cnt -= n; size -= n * 220; // 행당 대략치로 추정(매 회 statSync/ VACUUM 회피)
        }
        // VACUUM 은 파일 전체 재작성(동기)이다. 그래도 부르는 이유: 삭제만으로는 파일 크기가 줄지
        // 않아 `sizeBytes()` 기준 루프가 다음 주기에도 계속 참이 되어 **로그를 전부 지운다**.
        // 루프 '밖에서 1회' 규약은 유지한다.
        if (dropped) { db.vacuum(); console.log(`[vclogs] 용량 제한(${s.maxSizeMB}MB) 초과 → 오래된 ${dropped}건 정리`); }
      }
    }
    lastRun = { at: Date.now(), collected, ...(authStopped.length ? { authStopped } : {}) };
    if (collected) console.log(`[vclogs] ${collected}건 장기 보관`);
    return lastRun;
  } finally { running = false; }
}

function schedule() {
  if (timer) { clearInterval(timer); timer = null; }
  const s = loadLogSettings();
  if (!s.enabled) return;
  // v2.603(감사 TIM2603-01) 2차 방어 — 설정 로드가 이미 1~1440분으로 자르지만, 캐시가 다른 경로로 바뀌어도 0·NaN·음수·2^31 초과가
  // setInterval 에 가서 1ms 루프가 되지 않게 여기서도 [1분, 1일] 로 묶는다(숫자 아님은 기본 10분).
  const everyMs = Math.min(86_400_000, clampIntervalMs(Number(s.pollIntervalMin) * 60_000, 600_000, 60_000));
  timer = setInterval(() => pollLogsOnce().catch((e) => console.warn(`[vclogs] poll 오류: ${e.message}`)), everyMs);
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

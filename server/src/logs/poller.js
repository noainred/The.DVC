/**
 * vCenter 이벤트 로그 수집 폴러 — 주기적으로 각 vCenter의 신규 이벤트를 가져와 장기 보관 DB에
 * 누적하고, 보관기간 초과분을 정리한다. mock 모드에서는 합성 이벤트로 UI를 채운다.
 */

import { config, loadVcenterConfig, clampIntervalMs } from '../config.js';
import { poolRun } from '../util/pool.js';   // v2.447: vCenter 병렬 수집(감사 T2) · v2.579: routes 의존 제거
import { store } from '../store.js';
import { collectVCenterEvents } from '../vcenter/soapClient.js';
import { vcAuthGuard, isVcAuthError } from '../vcenter/restClient.js';
import { splitDirectCollectTargets } from '../vcenter/collectTarget.js'; // v2.732(B4-01): 직접 수집 대상 판정(store.js 주 폴러와 같은 조건)
import { createYielder } from '../util/timeSlice.js';
import { capStr } from '../util/capStr.js';
import { getLogsDb } from './db.js';
import { ingestSnapRows } from '../veeam/snapDb.js';   // v2.759: 스냅샷 행은 Veeam 전용 DB 에도(카드 백업 수량을 바로 계산)
import { loadLogSettings } from './settings.js';
import { demoLoginFailEvents } from '../mock/demo/users.js'; // v2.708 로그인 실패 분석 데모(mock 에서만)
import { demoBackupEvents } from '../mock/demo/backup.js'; // v2.711 미보호 VM 데모(mock 에서만)

const SEV_RANK = { info: 0, warning: 1, error: 2 };
// 동시 수집 상한 — 28개를 한꺼번에 열면 매 주기 SOAP 파싱이 몰린다(store.collectPool 과 같은 취지).
const LOG_CONCURRENCY = Math.max(1, Math.min(16, Number(process.env.VCLOGS_CONCURRENCY) || 6));
const DAY = 86_400_000;

let timer = null;
let lastRun = null;
let running = false;
let runningSince = null; // v2.743(감사 WEB-04): 진행 중인 수집이 언제 시작됐는지 — '지금 수집' 이 겹쳤을 때 화면이 말한다
let tick = 0; // prune/용량점검 스로틀용(매 폴 DELETE 스캔 방지)
let lastCap = null; // v2.741(DB-03): 마지막 용량 상한 처리 결과 — 상태 화면이 '사용 중 크기 기준' 을 말한다
const PRUNE_EVERY = 10; // N폴마다 1회만 보관기간/용량 정리

/*
 * v2.731(점검 r1 A2-01): vCenter 별 '이벤트가 온전한 마지막 시각' — VM 가용성(availability/analyze.js)의 측정 끝 근거.
 * 이 기록이 없으면 가용성은 측정 끝을 언제나 '지금' 으로 둬서, 수집이 멈춘 vCenter 의 꼬리(수집하지 못한 구간)를 '정지 없음 = 가동' 으로 셌다.
 * 마지막 이벤트 시각(db.lastTs)으로는 대신할 수 없다 — 최소 심각도가 info 가 아니면 조용한 vCenter 는 수집이 정상이어도 이벤트가 오래 없다.
 *  · 적재까지 성공한 수집만 기록한다(데드라인·접속 실패·적재 실패는 기록을 바꾸지 않는다 — 멈춘 수집이 '방금 성공' 으로 보이면 안 된다).
 *  · 상한(maxPerPoll)에 걸렸으면 그 뒤 이벤트는 아직 안 읽었다 — 수집 시작 시각이 아니라 마지막으로 읽은 이벤트 시각까지만 온전하다
 *    (이벤트는 오래된 것부터 읽는다 — collectVCenterEvents).
 *  · 인메모리다 — 재시작 직후에는 기록이 없고 가용성은 마지막 이벤트 시각으로 대신한다(그 사실을 화면이 말한다).
 *    재시작 사이에 쌓인 이벤트는 다음 수집이 lastTs 부터 다시 읽으므로 그 틈은 실제로 아직 수집 전이다.
 */
const _collectOk = new Map();   // vcenterId → { at, capped, events }

/*
 * v2.756(실서버 — OC2 vCenter 의 이벤트 수집이 2026-10-10 04:32 에서 12일째 멈춤): 수집 시작점이 '로그 DB 에 마지막으로 **저장된** 시각'
 *   (db.lastTs + 1)뿐이었다. 읽은 이벤트가 전부 저장되지 않으면(① 중복 키로 INSERT OR IGNORE 가 버림 ② 최소 심각도로 걸러짐) 시작점이
 *   그대로라 다음 주기가 같은 구간을 다시 읽고 다시 버렸다 — 영원히. ①의 실제 경로: 중복 키가 vCenter **이벤트 번호(key) 하나**였다 —
 *   vCenter 를 다시 배포·마이그레이션 업그레이드하면 번호가 처음부터 다시 매겨져 새 이벤트가 보관 중인 옛 번호(기본 365일)와 겹친다(추정 —
 *   그 vCenter 의 업그레이드 이력은 확인하지 못했다). 이제 ⓐ 중복 키 = 번호@시각(eventRowKey) ⓑ 시작점 = max(마지막 저장, 마지막으로 **읽은** 시각)
 *   (nextSinceTs — 읽은 커서는 인메모리, 재시작하면 한 번 더 읽고 다시 나아간다) ⓒ 읽었는데 하나도 저장되지 않은 상한 주기는 경고·결과에 남긴다.
 */
const _readCursor = new Map();  // vcenterId → 마지막으로 읽은 이벤트 시각(저장 여부와 무관)
/** 이벤트 행의 중복 키 — vCenter 이벤트 번호 + 시각. 번호가 없으면 null(db 가 시각·문구로 만든다). */
export function eventRowKey(e) {
  const k = e?.key;
  return k == null || k === '' ? null : `${k}@${Number(e.ts) || 0}`;
}
/** 다음 수집 시작 시각 — 저장된 마지막과 읽은 마지막 중 늦은 것 + 1ms. 둘 다 없으면 첫 수집 창. */
export function nextSinceTs(lastStored, lastRead, { now = Date.now(), firstDays = 7 } = {}) {
  const base = Math.max(Number(lastStored) || 0, Number(lastRead) || 0);
  return base > 0 ? base + 1 : now - firstDays * DAY;
}
const _stallLog = new Map();    // vcenterId → 마지막 경고 시각(같은 vCenter 는 1시간에 1줄)
/** 수집 결과로 '이벤트가 온전한 시각' 을 계산한다(순수). events = 원시 이벤트(심각도 거르기 전), max = 한 번에 읽는 상한. */
export function eventsCompleteUntil(events, { startedAt, max = Infinity } = {}) {
  const list = Array.isArray(events) ? events : [];
  let maxTs = null;
  for (const e of list) { const t = Number(e?.ts); if (Number.isFinite(t) && (maxTs == null || t > maxTs)) maxTs = t; }
  const capped = Number.isFinite(max) && max > 0 && list.length >= max;
  if (capped) return { at: maxTs, capped: true };
  // 상한 밖 — 수집을 시작한 시각까지 온전하다. vCenter 시계가 앞서 그보다 늦은 이벤트가 있으면 그 시각까지.
  return { at: Math.max(Number(startedAt) || 0, maxTs ?? 0) || null, capped: false };
}
/** 그 vCenter 의 마지막 수집 성공 기록 — { at, capped, events } 또는 null. */
export function logCollectOk(vcenterId) { const r = _collectOk.get(String(vcenterId ?? '')); return r ? { ...r } : null; }
/** 그 vCenter 의 이벤트가 온전한 마지막 시각(ms) 또는 null(기록 없음). */
export function logCollectOkAt(vcenterId) { return _collectOk.get(String(vcenterId ?? ''))?.at ?? null; }

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
  // v2.711: 백업 스냅샷(미보호 VM 화면의 보호 근거) — 최근 8일 · 켜진 VM 의 약 60%.
  for (const e of demoBackupEvents(vcId, vms, sinceTs, now)) out.push(e);
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
  // v2.743(감사 WEB-04): 진행 중이면 **직전 결과(lastRun)를 돌려주지 않는다** — '지금 수집' 이 그 값을 이번 결과로 읽어
  //   '수집 완료: N건' 이라고 말했다(첫 실행 중이면 null 이라 0건). 이번 요청은 새로 수집하지 않았다는 사실을 busy 로 밝힌다.
  if (running) return { busy: true, runningSince };
  const s = loadLogSettings();
  // 꺼져 있으면 skipped:true(수집하지 않음) — '0건 수집' 과 다르다(화면이 구분한다).
  if (!s.enabled) { lastRun = { at: Date.now(), collected: 0, skipped: true }; return lastRun; }
  running = true;
  runningSince = Date.now();
  const failed = [];   // v2.743(WEB-04): 이번 주기에 인증 외 사유로 수집하지 못한 vCenter — 반환에만 싣는다(아래)
  try {
    const db = await getLogsDb();
    const mock = config.dataSource === 'mock';
    const minRank = SEV_RANK[s.minSeverity] || 0;
    // v2.732(점검 2회차 B4-01): live 대상은 **직접 수집 vCenter 만**이다 — 관리자가 끈(enabled:false)·점검중(maintenance)·엣지 위임
    //   (collectMode 'site') vCenter 는 로그인하지 않는다(store.js 주 폴러·vmseries·curuser 와 같은 판정 — vcenter/collectTarget.js 하나).
    //   예전에는 등록부 전량이라 그 셋에 10분마다 로그인했고(재현: 3주기 × 계정 3개 = 9회), 주 폴러가 그 셋을 수집하지 않으므로 인증 정지
    //   기록도 생기지 않아 비밀번호가 틀린 구간에 실패 로그인이 쌓였다. site 의 로그는 엣지가 보관하고 화면은 연합 조회로 본다
    //   (/tools/vclogs/sources 가 site 를 remote 로 분류한다). 수동 실행도 이 셋은 건너뛴다(store 의 '지금 수집' 과 같다).
    //   건너뛴 vCenter 는 lastRun.notCollected 로 밝힌다(조용한 제외 금지).
    const split = mock ? { targets: (store.get().vcenters || []).map((v) => ({ id: v.id, name: v.name })), skipped: [] } : splitDirectCollectTargets(loadVcenterConfig().vcenters || []);
    const vcs = split.targets;
    let collected = 0;
    const authStopped = [];   // v2.590: 이번 주기에 인증 실패 정지로 건너뛴 vCenter — 조용히 빼지 않고 밝힌다
    const authRejected = [];  // v2.732(B4-01): 이번 주기에 로그인이 거부된 vCenter — 주 폴러와 같은 정지 기록에 올렸다
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
        const startedAt = Date.now();   // v2.731(A2-01): 이 수집이 온전하게 덮는 끝(상한에 걸리지 않으면)
        const last = db.lastTs(vc.id);
        // 첫 수집은 최근 7일. v2.710: 데모(mock)는 91일 — VM 가용성(7·30·90일 보기)이 합성 이벤트 7일치만으로
        //   전 VM 을 '수집 시작부터만 잼(일부 기간)' 으로 내던 공백. 이벤트 수도 기간에 비례(7일마다 25건).
        const firstDays = mock ? MOCK_FIRST_DAYS : 7;
        const sinceTs = nextSinceTs(last, _readCursor.get(String(vc.id)), { firstDays }); // v2.756: 읽은 커서까지 본다
        const events = mock
          ? synthEvents(vc.id, sinceTs, last ? 25 : 25 * Math.ceil(firstDays / 7))
          : await vcLogWithDeadline(vc, (signal) => collectVCenterEvents(vc, { sinceTs, max: s.maxPerPoll, signal }));
        const rows = events
          .filter((e) => (SEV_RANK[e.severity] || 0) >= minRank)
          .map((e) => ({ vcenterId: vc.id, key: eventRowKey(e), ts: e.ts, severity: e.severity, type: e.type, user: e.user, entity: e.entity, message: e.message, detail: e.detail ?? null }));
        // v2.731(A2-01): 적재할 행이 0개여도 '수집은 성공' 이다 — 성공 시각 기록을 위해 항상 넘긴다.
        const done = eventsCompleteUntil(events, { startedAt, max: mock ? Infinity : s.maxPerPoll });
        let maxRead = 0;
        for (const e of events) { const t = Number(e?.ts); if (Number.isFinite(t) && t > maxRead) maxRead = t; }
        perVc.push({ vcId: String(vc.id), rows, done, events: events.length, maxRead });
      } catch (e) {
        console.warn(`[vclogs] ${vc.id} 수집 실패: ${e.message}`);
        // v2.732(B4-01): 로그인 거부(InvalidLogin 등)면 주 폴러와 **같은 정지 기록**에 올린다(v2.591 보조 수집기 규약 — 이 폴러만 빠져 있었다).
        //   다음 주기는 authStopFor 가 건너뛴다. 수동 실행의 거부도 올린다(시도 횟수가 정직해지게 — guestdisk 와 같다). mock 은 제외.
        if (!mock && isVcAuthError(e)) {
          const rec = vcAuthGuard.markAuthStopped(vc.id, vc, e.message);
          authRejected.push({ vcenterId: String(vc.id), attempts: rec?.attempts ?? null });
        } else failed.push({ vcenterId: String(vc.id), error: capStr(String(e?.message || e || '알 수 없는 오류'), 300) });
      }
    });
    // v2.732(점검 2회차 B6-01): 적재는 vCenter 사이·조각 사이에서 이벤트 루프에 양보한다 — 예전에는 28곳 × 최대 5,000행을 양보 없이
    //   이어 붙여 따라잡기 주기마다 약 2.4초 멈췄다(재현). 조각은 ts 가 바뀌는 안전 지점에서만 자른다(logs/db.js tsSafeChunks).
    //   같은 연결의 동시 write 는 여전히 없다(running 재진입 가드 · 양보는 COMMIT 뒤).
    const maybeYield = createYielder(15);
    const stalled = [];   // v2.756: 상한만큼 읽었는데 하나도 저장되지 않은 vCenter(중복 키·심각도 필터) — 예전에는 여기서 영원히 멈췄다
    for (const { vcId, rows, done, events, maxRead } of perVc) {
      await maybeYield();
      const before = db.lastTs(vcId);
      if (rows.length) {
        if (typeof db.insertManyAsync === 'function') await db.insertManyAsync(rows);
        else db.insertMany(rows);
        collected += rows.length;
        await ingestSnapRows(rows);   // 실패해도 로그 적재는 그대로(시간당 경고 1줄)
      }
      // 적재가 끝난 뒤에만 기록한다(적재가 던지면 이 vCenter 이후는 기록되지 않는다 — 온전하지 않다).
      if (done.at != null) _collectOk.set(vcId, { at: done.at, capped: done.capped, events });
      if (maxRead > 0) {
        if (maxRead > (_readCursor.get(vcId) || 0)) _readCursor.set(vcId, maxRead);
        if (done.capped && db.lastTs(vcId) <= before) {
          stalled.push({ vcenterId: vcId, read: events, stored: rows.length });
          const t = Date.now();
          if (!_stallLog.has(vcId) || t - _stallLog.get(vcId) > 3_600_000) {
            _stallLog.set(vcId, t);
            console.warn(`[vclogs] ${vcId}: 이벤트 ${events}건을 읽었는데 새로 저장된 것이 없습니다(중복 또는 심각도 필터) — 읽은 시각(${new Date(maxRead).toISOString()})부터 이어 읽습니다`);
          }
        }
      }
    }
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
      // 용량 제한: DB 의 **사용 중 크기**가 maxSizeMB 를 넘으면 오래된 것부터 삭제.
      // ⚠⚠ v2.741(감사 DB-03 — 재현): 예전에는 파일 크기(sizeBytes, +wal)로 판정해 삭제만으로는 줄지 않았고, 그래서 상한에 닿을
      //   때마다 루프 밖에서 VACUUM(파일 전체 재작성, 동기)을 돌렸다 — 상한에 닿은 포탈은 prune 주기마다 수 초씩 멈췄다(합성 534MB 실측).
      //   이제 (page_count − freelist_count) × page_size 로 판정한다(db.usedBytes). 지운 페이지는 다음 INSERT 가 다시 쓰므로 파일은
      //   최고 수위 근처에 머물고 더 커지지 않는다 — VACUUM 이 필요 없다. 대가(정직 기록): 상한을 낮춰도 파일은 줄어들지 않는다
      //   (빈 공간은 freeBytes 로 화면이 말한다).
      if (s.maxSizeMB > 0) {
        const limit = s.maxSizeMB * 1024 * 1024;
        const usedOf = () => (typeof db.usedBytes === 'function' ? db.usedBytes() : db.sizeBytes());
        let size = usedOf(), guard = 0, dropped = 0, stuck = false;
        // ⚠ v2.503: 행 수는 **루프 밖에서 1회만** 센다. 예전에는 매 반복 `db.meta().count` 를 불렀는데
        // meta() 는 COUNT/MIN/MAX + `GROUP BY vcenterId` 로 **풀스캔 2회**다 — 상한 50회 × 2 = 최악
        // 100회 전체 스캔이 한 틱 안에서 동기로 돌았다(삭제 자체의 스캔은 별도). 삭제한 만큼 빼가며
        // 추정하면 되고, 카운트가 조금 낡아도 영향은 '이번 회차에 지우는 행 수' 뿐이다.
        // 행 수만 필요하므로 GROUP BY 가 없는 `rowCount()` 를 쓴다.
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
          dropped += n; cnt -= n;
          // v2.741(DB-03): 사용 중 크기를 다시 잰다(헤더 필드 — 즉시). 지웠는데 줄지 않았으면 더 지워도 같다 — 조용히 전부 지우지 않고
          //   멈춘 뒤 사유를 남긴다(다음 prune 주기가 다시 본다).
          const next = usedOf();
          if (!(next < size)) { stuck = true; break; }
          size = next;
        }
        if (dropped) console.log(`[vclogs] 용량 제한(${s.maxSizeMB}MB) 초과 → 오래된 ${dropped}건 정리(사용 중 ${(size / 1048576).toFixed(0)}MB — 지운 자리는 새 로그가 다시 씁니다)`);
        if (stuck) console.warn(`[vclogs] 용량 제한(${s.maxSizeMB}MB): 오래된 로그를 지웠지만 사용 중 크기가 줄지 않았습니다 — 이번 주기는 여기서 멈춥니다(다음 정리 주기에 다시 봅니다)`);
        lastCap = { at: Date.now(), limitBytes: limit, usedBytes: size, dropped, stuck };
      }
    }
    lastRun = { at: Date.now(), collected, ...(authStopped.length ? { authStopped } : {}), ...(authRejected.length ? { authRejected } : {}), ...(stalled.length ? { stalled } : {}),
      ...(split.skipped.length ? { notCollected: split.skipped } : {}) };
    if (collected) console.log(`[vclogs] ${collected}건 장기 보관`);
    // v2.743(WEB-04): 수집 실패한 vCenter 는 **반환에만** 싣는다 — '지금 수집'(관리자 + 전체 범위)이 '전부 실패해도 수집 완료 0건' 이라
    //   말하지 않게. 상태(lastRun)에는 싣지 않는다 — /vclogs/status 는 범위 계정도 읽고, 오류 원문에 vCenter 주소가 들어간다
    //   (scopeVcLogStatus 가 모르는 필드를 거르지 않는다). 상한 50곳, 넘으면 개수를 밝힌다.
    if (!failed.length) return lastRun;
    return { ...lastRun, failed: failed.slice(0, 50), ...(failed.length > 50 ? { failedOmitted: failed.length - 50 } : {}) };
  } finally { running = false; runningSince = null; }
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
  // v2.741(DB-03): 파일 크기와 함께 사용 중 크기·빈 공간을 싣는다 — 용량 상한은 사용 중 크기로 판정하고 파일은 줄어들지 않는다.
  const used = typeof db.usedBytes === 'function' ? db.usedBytes() : null;
  const free = typeof db.freeBytes === 'function' ? db.freeBytes() : null;
  // v2.744(감사 DB-03): 건수 집계는 vCenter 사이에 양보하는 metaAsync(설정 화면이 30초마다 부른다 — 캐시가 지날 때의 동기 정지 제거).
  const meta = typeof db.metaAsync === 'function' ? await db.metaAsync() : db.meta();
  return { settings: loadLogSettings(), lastRun, store: meta, dbKind: db.kind, dbPath: db.path, dbSizeBytes: db.sizeBytes(),
    dbUsedBytes: Number.isFinite(used) ? used : null, dbFreeBytes: Number.isFinite(free) ? free : null, ...(lastCap ? { lastCap } : {}) };
}

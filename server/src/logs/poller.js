/**
 * vCenter 이벤트 로그 수집 폴러 — 주기적으로 각 vCenter의 신규 이벤트를 가져와 장기 보관 DB에
 * 누적하고, 보관기간 초과분을 정리한다. mock 모드에서는 합성 이벤트로 UI를 채운다.
 */

import { config, loadVcenterConfig } from '../config.js';
import { store } from '../store.js';
import { collectVCenterEvents } from '../vcenter/soapClient.js';
import { getLogsDb } from './db.js';
import { loadLogSettings } from './settings.js';

const SEV_RANK = { info: 0, warning: 1, error: 2 };
const DAY = 86_400_000;

let timer = null;
let lastRun = null;
let running = false;

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
    for (const vc of vcs) {
      try {
        const last = db.lastTs(vc.id);
        const sinceTs = last ? last + 1 : Date.now() - 7 * DAY; // 첫 수집은 최근 7일
        const events = mock ? synthEvents(vc.id, sinceTs, 25) : await collectVCenterEvents(vc, { sinceTs, max: s.maxPerPoll });
        const rows = events
          .filter((e) => (SEV_RANK[e.severity] || 0) >= minRank)
          .map((e) => ({ vcenterId: vc.id, key: e.key, ts: e.ts, severity: e.severity, type: e.type, user: e.user, entity: e.entity, message: e.message }));
        if (rows.length) { db.insertMany(rows); collected += rows.length; }
      } catch (e) { console.warn(`[vclogs] ${vc.id} 수집 실패: ${e.message}`); }
    }
    if (s.retentionDays > 0) {
      const removed = db.prune(Date.now() - s.retentionDays * DAY);
      if (removed) console.log(`[vclogs] 보관기간(${s.retentionDays}일) 초과 ${removed}건 정리`);
    }
    // 용량 제한: DB가 maxSizeMB를 넘으면 오래된 것부터 삭제 + VACUUM.
    if (s.maxSizeMB > 0) {
      const limit = s.maxSizeMB * 1024 * 1024;
      let size = db.sizeBytes(), guard = 0, dropped = 0;
      while (size > limit && guard++ < 50) {
        const cnt = db.meta().count;
        if (cnt <= 0) break;
        const n = db.pruneOldest(Math.max(500, Math.floor(cnt * 0.1)));
        if (!n) break;
        dropped += n; db.vacuum(); size = db.sizeBytes();
      }
      if (dropped) console.log(`[vclogs] 용량 제한(${s.maxSizeMB}MB) 초과 → 오래된 ${dropped}건 정리`);
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

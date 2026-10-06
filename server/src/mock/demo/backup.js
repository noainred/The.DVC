/**
 * mock/demo/backup.js — v2.711 백업 스냅샷 이벤트 데모.
 * 특수 기능 › 미보호 VM 은 '조회 기간 안에 백업 계정이 만든 VM 스냅샷 이벤트' 를 보호 근거로 쓰는데, 합성 vCenter 이벤트에는
 * 그런 이벤트가 없어 데모에서 VM 전부가 '미보호'(보호 확인 0대)였다.
 * 규칙(flags.js 머리말): mock 로그 폴러에서만 부른다 · 결정적(VM·날짜가 같으면 같은 시각) · 최근 8일만(기본 조회 7일 + 여유 —
 * 91일 첫 수집 전체에 넣으면 VM 수 × 91 행이 된다) · 켜진 VM 의 약 60% 만(나머지는 실제로 '미보호' 로 보이게).
 */
import { demoHash } from './flags.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const BACKUP_DAYS = 8;
const ACCOUNTS = ['CORP\\svc-veeam', 'CORP\\svc-commvault', 'svc-rubrik@vsphere.local'];

/** 이 VM 을 데모 백업 대상으로 보는가 — 켜진 VM 의 약 60%. */
export function demoBackedUp(vm) {
  return !!vm && vm.powerState !== 'POWERED_OFF' && vm.template !== true && demoHash(`bk|${vm.id}`) % 5 < 3;
}

/** sinceTs~now 안에 드는 데모 백업 스냅샷 이벤트(생성·삭제 짝). */
export function demoBackupEvents(vcId, vms, sinceTs, now = Date.now()) {
  const out = [];
  const from = Math.max(sinceTs, now - BACKUP_DAYS * DAY);
  if (!(from <= now)) return out;
  const firstDay = Math.floor(from / DAY) * DAY;
  for (const vm of Array.isArray(vms) ? vms : []) {
    if (!demoBackedUp(vm)) continue;
    const h = demoHash(`bkt|${vm.id}`);
    const acct = ACCOUNTS[h % ACCOUNTS.length];
    for (let d = firstDay; d <= now; d += DAY) {
      const ts = d + (h % 20) * HOUR + (h % 50) * 60_000;
      if (ts < sinceTs || ts > now) continue;
      out.push({ key: `mock-bk-${vcId}-${vm.id}-${ts}`, ts, type: 'VmSnapshotCreatedEvent', severity: 'info', user: acct, entity: vm.name, message: `Task: Create virtual machine snapshot (${acct} backup job)`, detail: null });
      const ts2 = ts + 20 * 60_000;
      if (ts2 <= now) out.push({ key: `mock-bkd-${vcId}-${vm.id}-${ts2}`, ts: ts2, type: 'VmSnapshotRemovedEvent', severity: 'info', user: acct, entity: vm.name, message: `Task: Remove snapshot (${acct} backup job)`, detail: null });
    }
  }
  return out;
}

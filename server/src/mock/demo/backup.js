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
    // v2.763(V4-1): 실제 vCenter 는 스냅샷 생성·제거를 TaskEvent 로 남기고 문구에 계정이 없다(영어 또는 한국어 — vCenter 기본 언어).
    //   데모가 VmSnapshotCreatedEvent 만 내면 그 모양만 보는 판정의 결함을 가린다 — VM 마다 세 모양 중 하나로 낸다(결정적).
    const shape = Math.floor(h / 7) % 3;   // 0 = 옛 데모 종류 · 1 = TaskEvent 영어 · 2 = TaskEvent 한국어
    const mk = (kind, ts) => {
      const k = `mock-bk${kind === 'remove' ? 'd' : ''}-${vcId}-${vm.id}-${ts}`;
      if (shape === 1) return { key: k, ts, type: 'TaskEvent', severity: 'info', user: acct, entity: vm.name, message: kind === 'remove' ? 'Task: Remove snapshot' : 'Task: Create virtual machine snapshot', detail: null };
      if (shape === 2) return { key: k, ts, type: 'TaskEvent', severity: 'info', user: acct, entity: vm.name, message: kind === 'remove' ? '작업: 스냅샷 제거' : '작업: 가상 시스템 스냅샷 생성', detail: null };
      return kind === 'remove'
        ? { key: k, ts, type: 'VmSnapshotRemovedEvent', severity: 'info', user: acct, entity: vm.name, message: `Task: Remove snapshot (${acct} backup job)`, detail: null }
        : { key: k, ts, type: 'VmSnapshotCreatedEvent', severity: 'info', user: acct, entity: vm.name, message: `Task: Create virtual machine snapshot (${acct} backup job)`, detail: null };
    };
    for (let d = firstDay; d <= now; d += DAY) {
      const ts = d + (h % 20) * HOUR + (h % 50) * 60_000;
      if (ts < sinceTs || ts > now) continue;
      out.push(mk('create', ts));
      const ts2 = ts + 20 * 60_000;
      if (ts2 <= now) out.push(mk('remove', ts2));
    }
  }
  return out;
}

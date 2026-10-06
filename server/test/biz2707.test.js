// v2.707 — C6 VM 가용성(SLA) · C11 비용 배분(쇼백) · C7 VM 이전 준비도.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'biz2707-'));
process.env.CONFIG_DIR = TMP;
const { analyzeAvailability, userInitiated } = await import('../src/availability/analyze.js');
const cost = await import('../src/cost/analyze.js');
const cs = await import('../src/cost/settings.js');
const mig = await import('../src/migration/analyze.js');
const { targetOf } = await import('../src/routes/api/vmAvailability.js');

const H = 3_600_000;
const DAY = 24 * H;
const NOW = Math.floor(1_800_000_000_000 / H) * H - 30 * 60_000;   // 정시 -30분(경계에서 떨어뜨린 고정 시각)
const ev = (vm, ts, type, user = '') => ({ vcenterId: 'vc1', entity: vm, ts, type, user });
const vm = (name, powerState = 'POWERED_ON', extra = {}) => ({ id: `vc1:${name}`, name, vcenterId: 'vc1', cluster: 'C1', powerState, ...extra });
const FULL = () => ({ firstTs: NOW - 400 * DAY, lastTs: NOW });

// ── C6 ──────────────────────────────────────────────────────────────────────
test('① 가동률 — 끔→켬 구간이 정지 · 사람이 끈 정지 제외 가동률 · 재부팅·HA 는 횟수만', () => {
  const rows = [
    ev('a', NOW - 10 * DAY, 'VmPoweredOffEvent', 'admin@vsphere.local'), ev('a', NOW - 10 * DAY + 3 * H, 'VmPoweredOnEvent'),
    ev('a', NOW - 5 * DAY, 'VmPoweredOffEvent', 'vpxd'), ev('a', NOW - 5 * DAY + H, 'VmPoweredOnEvent'),
    ev('a', NOW - DAY, 'VmGuestRebootEvent'), ev('a', NOW - DAY, 'VmRestartedOnAlternateHostEvent'), ev('a', NOW - DAY, 'VmResettingEvent'),
  ];
  const r = analyzeAvailability(rows, [vm('a'), vm('b')], { days: 30, now: NOW, coverageOf: FULL, target: 99.9 });
  const a = r.vms.find((x) => x.name === 'a');
  assert.equal(a.downMs, 4 * H);
  assert.equal(a.userDownMs, 3 * H, '시스템 계정이 끈 것은 사람이 끈 것이 아니다');
  assert.equal(a.availability, Math.round((100 - (4 * H / (30 * DAY)) * 100) * 1000) / 1000);
  assert.ok(a.unplanned > a.availability);
  assert.deepEqual([a.offs, a.userOffs, a.reboots, a.ha, a.resets], [2, 1, 1, 1, 1]);
  assert.equal(a.below, true);
  assert.equal(r.coverage.measured, 2, '이벤트 없는 켜진 VM 도 측정(정지 없음)');
  assert.equal(r.vms.some((x) => x.name === 'b'), false, '정지·재시작이 없으면 기본 목록에 없다');
  assert.equal(r.coverage.belowTarget, 1);
  assert.equal(r.vcenters[0].availability, Math.round((100 - (4 * H / (60 * DAY)) * 100) * 1000) / 1000, '합산 = 전체 정지 ÷ 전체 측정 시간');
});

test('② 판정 보류 — 이벤트 없는 vCenter · 켬 이벤트 놓침 · 기간 내내 꺼짐 · 지금도 꺼짐 · 수집 시작 이후만', () => {
  const none = analyzeAvailability([], [vm('x')], { now: NOW, coverageOf: () => null });
  assert.equal(none.coverage.noEvents, 1); assert.equal(none.coverage.measured, 0);
  assert.equal(none.totals.availability, null, '측정 0 이면 100% 가 아니라 null');
  const never = analyzeAvailability([], [vm('x')], { now: NOW, coverageOf: () => ({ firstTs: null, lastTs: null }) });
  assert.equal(never.coverage.noEvents, 1, '이벤트를 한 번도 받지 않은 vCenter(lastTs 없음)도 판정하지 않는다');
  const miss = analyzeAvailability([ev('m', NOW - DAY, 'VmPoweredOffEvent')], [vm('m')], { now: NOW, coverageOf: FULL });
  assert.equal(miss.coverage.inconsistent, 1); assert.equal(miss.coverage.measured, 0);
  const offAll = analyzeAvailability([], [vm('o', 'POWERED_OFF')], { now: NOW, coverageOf: FULL });
  assert.equal(offAll.coverage.offAll, 1); assert.equal(offAll.coverage.measured, 0);
  const stillOff = analyzeAvailability([ev('s', NOW - 2 * DAY, 'VmPoweredOffEvent', 'u1')], [vm('s', 'POWERED_OFF')], { days: 30, now: NOW, coverageOf: FULL });
  assert.equal(stillOff.vms[0].downMs, 2 * DAY, '지금도 꺼져 있으면 지금까지');
  const late = analyzeAvailability([ev('l', NOW - DAY, 'VmPoweredOffEvent'), ev('l', NOW - DAY + H, 'VmPoweredOnEvent')], [vm('l')],
    { days: 30, now: NOW, coverageOf: () => ({ firstTs: NOW - 10 * DAY, lastTs: NOW }) });
  assert.equal(late.coverage.partialWindow, 1);
  assert.equal(late.vms[0].availability, Math.round((100 - (H / (10 * DAY)) * 100) * 1000) / 1000, '분모는 수집 시작부터');
  // 첫 전원 이벤트가 '켬' 이면 그 전은 꺼져 있었다 — 기간 중 만든 VM 은 생성 뒤부터 잰다
  const born = analyzeAvailability([ev('n', NOW - 3 * DAY, 'VmCreatedEvent'), ev('n', NOW - 3 * DAY + H, 'VmPoweredOnEvent')], [vm('n')], { days: 30, now: NOW, coverageOf: FULL, onlyBelow: true });
  assert.equal(born.vms[0].downMs, H, '생성 전 27일을 정지로 세지 않는다');
  assert.equal(born.vms[0].bornInWindow, true);
  const before = analyzeAvailability([ev('p', NOW - 3 * DAY, 'VmPoweredOnEvent')], [vm('p')], { days: 30, now: NOW, coverageOf: FULL, onlyBelow: true });
  assert.equal(before.vms[0].downMs, 27 * DAY, '생성 기록이 없으면 기간 시작부터 꺼져 있던 것');
  assert.equal(userInitiated('vpxuser'), false); assert.equal(userInitiated('CORP\\ops'), true); assert.equal(userInitiated(''), false);
  assert.equal(targetOf('99.95'), 99.95); assert.equal(targetOf(''), 99.9); assert.equal(targetOf('50'), 99.9);
});

// ── C11 ─────────────────────────────────────────────────────────────────────
test('③ 비용 — 단가 없으면 null · 일부 단가 · 꺼진 VM 정책 · 스토리지 기준', () => {
  const vms = [
    vm('a', 'POWERED_ON', { cpuCount: 4, memMB: 8192, storageGB: 100, uncommittedGB: 50, folder: 'F1' }),
    vm('b', 'POWERED_OFF', { cpuCount: 2, memMB: 4096, storageGB: 40, uncommittedGB: 0, folder: 'F2' }),
    vm('t', 'POWERED_OFF', { template: true, cpuCount: 8, memMB: 1024, storageGB: 10 }),
  ];
  const snap = { vcenters: [{ id: 'vc1', name: 'VC1' }], vms };
  const none = cost.analyzeCost(snap, { ...cs.DEFAULTS });
  assert.equal(none.ratesSet, 0); assert.equal(none.totals.total, null, '단가가 없으면 0 원이 아니라 null');
  assert.equal(none.totals.vcpu, 4, '꺼진 VM 은 기본(storage) 정책으로 CPU 를 세지 않는다');
  assert.equal(none.totals.storageGB, 140); assert.equal(none.notes.templates, 1);
  const s = { ...cs.DEFAULTS, vcpu: 10, ramGB: 2, storageGB: 0.5 };
  const r = cost.analyzeCost(snap, s);
  assert.equal(r.totals.total, 4 * 10 + 8 * 2 + 140 * 0.5);
  const full = cost.analyzeCost(snap, { ...s, offPolicy: 'full' });
  assert.equal(full.totals.vcpu, 6);
  const no = cost.analyzeCost(snap, { ...s, offPolicy: 'none' });
  assert.equal(no.totals.vms, 1); assert.equal(no.notes.excludedOff, 1);
  const prov = cost.analyzeCost(snap, { ...s, storageBasis: 'provisioned' });
  assert.equal(prov.totals.storageGB, 190);
  const part = cost.analyzeCost(snap, { ...cs.DEFAULTS, vcpu: 10 });
  assert.equal(part.partialRates, true); assert.equal(part.totals.ram, null); assert.equal(part.totals.total, 40);
  const byFolder = cost.analyzeCost(snap, s, { by: 'folder' });
  assert.deepEqual(byFolder.groups.map((g) => g.label).sort(), ['F1', 'F2']);
  assert.equal(byFolder.groups.reduce((x, g) => x + g.share, 0), 100);
  const unk = cost.analyzeCost({ ...snap, vms: [vm('u', 'POWERED_ON', { cpuCount: 1, memMB: 1024 })] }, s);
  assert.equal(unk.notes.storageUnknown, 1); assert.equal(unk.groups[0].storageUnknown, 1);
});

test('④ 비용 — 태그 기준: 못 읽은 vCenter · 태그 없음 · 같은 카테고리 태그 둘이면 첫 태그만', () => {
  const inv = { categories: [{ name: 'Team' }], tags: [{ name: 'A', cat: 0 }, { name: 'B', cat: 0 }], vmTags: { x: [0, 1], y: [] } };
  const snap = { vcenters: [{ id: 'vc1', tagInv: inv }, { id: 'vc2', tagInv: null }],
    vms: [vm('x', 'POWERED_ON', { id: 'vc1:x', cpuCount: 1, memMB: 1024, storageGB: 1 }), vm('y', 'POWERED_ON', { id: 'vc1:y', cpuCount: 1, memMB: 1024, storageGB: 1 }),
      { ...vm('z', 'POWERED_ON', { cpuCount: 1, memMB: 1024, storageGB: 1 }), vcenterId: 'vc2', id: 'vc2:z' }] };
  const r = cost.analyzeCost(snap, cs.DEFAULTS, { by: 'tag', category: 'team' });
  const labels = Object.fromEntries(r.groups.map((g) => [g.label, g.vms]));
  assert.deepEqual(labels, { A: 1, [cost.NO_TAG]: 1, [cost.TAG_UNKNOWN]: 1 });
  assert.equal(r.notes.multiTag, 1); assert.equal(r.notes.tagUnknown, 1);
  assert.equal(r.totals.vms, 3, '두 번 세지 않는다');
  assert.deepEqual(cost.tagCategories(snap.vcenters), ['Team']);
});

test('⑤ 단가 설정 — 빈 칸은 null(무료 0 과 다르다) · 음수·글자는 이전 값 · 손상 보존', () => {
  cs._resetCostSettings();
  let s = cs.saveCostSettings({ vcpu: '10', ramGB: 0, storageGB: '', currency: 'USD', offPolicy: 'full', storageBasis: 'x' }, 'admin');
  assert.equal(s.vcpu, 10); assert.equal(s.ramGB, 0); assert.equal(s.storageGB, null);
  assert.equal(s.currency, 'USD'); assert.equal(s.offPolicy, 'full'); assert.equal(s.storageBasis, 'used');
  s = cs.saveCostSettings({ vcpu: -5, ramGB: 'abc' }, 'admin');
  assert.equal(s.vcpu, 10); assert.equal(s.ramGB, 0);
  s = cs.saveCostSettings({ vcpu: null }, 'admin');
  assert.equal(s.vcpu, null);
  fs.writeFileSync(path.join(TMP, 'cost-rates.json'), '{broken');
  cs._resetCostSettings();
  assert.equal(cs.loadCostSettings().vcpu, null);
  assert.ok(fs.readdirSync(TMP).some((f) => f.startsWith('cost-rates.json.corrupt')));
});

// ── C7 ──────────────────────────────────────────────────────────────────────
const CFG = { question: null, consolidationNeeded: false, managedBy: null, cpuReservationMhz: 0, memReservationMB: 0 };
const DEV = { disks: [], usb: 0, serial: 0, parallel: 0, cdroms: [] };
test('⑥ 이전 준비도 — 막힘·확인 필요·준비됨·판정 불가(미수집이면 준비됨이 아니다)', () => {
  const lv = (v) => mig.migrationOf(v).level;
  assert.equal(lv(vm('r', 'POWERED_ON', { cfg: CFG, dev: DEV, hwVersion: 'vmx-19' })), 'ready');
  assert.equal(lv(vm('u', 'POWERED_ON', { hwVersion: 'vmx-19' })), 'unknown');
  assert.equal(lv(vm('u2', 'POWERED_ON', { cfg: CFG })), 'unknown', '장치를 안 읽었으면 판정 불가');
  assert.equal(lv(vm('g', 'POWERED_ON', { gpu: { type: 'passthrough' } })), 'blocked', '막힘은 미수집이어도 사실이다');
  assert.equal(lv(vm('rd', 'POWERED_ON', { cfg: CFG, dev: { ...DEV, disks: [{ rdm: true, rdmMode: 'physicalMode' }] } })), 'blocked');
  assert.equal(lv(vm('rv', 'POWERED_ON', { cfg: CFG, dev: { ...DEV, disks: [{ rdm: true, rdmMode: 'virtualMode' }] } })), 'ready', '가상 호환 RDM 은 막지 않는다');
  assert.equal(lv(vm('s', 'POWERED_ON', { cfg: CFG, dev: DEV, snapshotCount: 2 })), 'caution');
  assert.equal(lv(vm('h', 'POWERED_ON', { cfg: CFG, dev: DEV, hwVersion: 'vmx-8' })), 'caution');
  const codes = mig.migrationOf(vm('t', 'POWERED_ON', { cfg: { ...CFG, question: { text: 'q' } }, dev: { ...DEV, usb: 1, cdroms: [{ connected: true, host: true }] }, toolsVersionStatus: 'guestToolsNotInstalled' })).findings.map((f) => f.code);
  assert.deepEqual(codes, ['question', 'cdrom-connected', 'tools-missing', 'usb']);
  for (const c of Object.keys(mig.MIG_CODES)) assert.ok(['blocked', 'caution'].includes(mig.MIG_CODES[c]));
});

test('⑦ 이전 준비도 집계 — 준비율 분모는 판정한 VM · 필터 · 묶음', () => {
  const vms = [
    vm('a', 'POWERED_ON', { cfg: CFG, dev: DEV, storageGB: 10 }), vm('b', 'POWERED_ON', { cfg: CFG, dev: DEV, snapshotCount: 1 }),
    vm('c', 'POWERED_ON'), vm('d', 'POWERED_ON', { gpu: { type: 'passthrough' } }), vm('t', 'POWERED_OFF', { template: true }),
  ];
  const r = mig.analyzeMigration(vms);
  assert.deepEqual(r.counts, { blocked: 1, caution: 1, unknown: 1, ready: 1 });
  assert.equal(r.readyPct, Math.round((1 / 3) * 1000) / 10, '판정 불가는 분모에서 뺀다');
  assert.equal(r.templates, 1);
  assert.equal(r.vms[0].level, 'blocked', '막힘이 먼저');
  assert.equal(mig.analyzeMigration(vms, { level: 'ready' }).matched, 1);
  assert.equal(mig.analyzeMigration(vms, { code: 'snapshots' }).vms[0].name, 'b');
  assert.equal(mig.analyzeMigration(vms, { by: 'cluster' }).groups[0].cluster, 'C1');
  assert.equal(mig.analyzeMigration([vm('c')]).readyPct, null, '판정한 VM 이 없으면 null');
});

test('⑧ 배선 — 라우트·도구 키·카탈로그', () => {
  const api = fs.readFileSync(new URL('../src/routes/api.js', import.meta.url), 'utf8');
  for (const f of ['registerVmAvailability', 'registerCostShowback', 'registerMigrationReadiness']) assert.match(api, new RegExp(`${f}\\(api\\)`));
  const access = fs.readFileSync(new URL('../src/auth/toolAccess.js', import.meta.url), 'utf8');
  for (const k of ['vm-availability', 'cost-showback', 'migration-readiness']) assert.match(access, new RegExp(`'${k}': '${k}'`));
  const r = fs.readFileSync(new URL('../src/routes/api/costShowback.js', import.meta.url), 'utf8');
  assert.match(r, /api\.put\('\/tools\/cost-showback\/settings', adminOnly, fleetOnly/);
});

// vNEXT — IP 변화 기록 · 알림 · 충돌 의심(설계 docs/design/ipam-alerts-mac-dns ① ③ · 릴리스 나 · 컨펌 '전부 기본값').
// 실제 모듈을 호출해 값으로 본다: ARP 연속 횟수 · 변화 감지(기준선 · 부분 결과 · 새 IP · 예약 IP · 이름 · MAC · 되돌아감) ·
//   알림 묶음(거르기 · 기록만 사유 · 상한 요약 · 줄 상한) · 변화 기록 · 충돌 의심 판정(모름 사유 · 이중화 · 대리 ARP · 연속) ·
//   알림 엔진 평가(보류 · 규칙 끔) · 발생/해소 기록 · 관리상태 macAlertOff · 알리지 않을 에이전트 · 대장 · 라우트(자식 프로세스 — 목 데이터).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-ipchg-'));
process.env.CONFIG_DIR = CFG;
process.env.DATA_SOURCE = 'live';
process.env.IPAM_WRITE_DEBOUNCE_MS = '60000';
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

const ss = await import('../src/ipam/scanStore.js');
const cl = await import('../src/ipam/changeLog.js');
const cn = await import('../src/ipam/changeNotify.js');
const cf = await import('../src/ipam/conflict.js');
const cs = await import('../src/ipam/conflictState.js');
const al = await import('../src/alerts.js');
const ov = await import('../src/ipam/overrides.js');
const rp = await import('../src/ipam/rangePolicies.js');
const T0 = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 7_200_000;   // 정시 경계(docs/rules/common.md)
const tick = () => new Promise((r) => setImmediate(r));
const H = (ip, extra = {}) => ({ ip, openPorts: [22], services: ['SSH'], ...extra });

/** onScanChanges 로 받은 묶음을 모은다. */
function collect() {
  const got = [];
  const off = ss.onScanChanges((b) => got.push(b));
  return { got, off, all: () => got.flatMap((b) => b.changes.map((c) => ({ ...c, agent: b.agent }))) };
}

// ── ① ARP 연속 횟수 ──────────────────────────────────────────────────────────
test('① mergeArp n — 같은 MAC 이면 +1 · 바뀌면 1 · 표에 없거나 볼 수 없던 보고는 그대로', () => {
  let a = ss.mergeArp(null, { arpMac: 'AA:00:00:00:00:01' }, 1).arp; assert.equal(a.n, 1);
  a = ss.mergeArp(a, { arpMac: 'AA:00:00:00:00:01' }, 2).arp; assert.equal(a.n, 2);
  a = ss.mergeArp(a, { arpTried: true }, 3).arp; assert.equal(a.n, 2); assert.equal(a.miss, 1);
  a = ss.mergeArp(a, {}, 4).arp; assert.equal(a.n, 2);
  a = ss.mergeArp(a, { arpMac: 'AA:00:00:00:00:01' }, 5).arp; assert.equal(a.n, 3);
  a = ss.mergeArp(a, { arpMac: 'AA:00:00:00:00:02' }, 6).arp; assert.equal(a.n, 1);
});

// ── ② 변화 감지 ──────────────────────────────────────────────────────────────
test('② 기준선 — 대역 줄의 첫 완료 스캔은 새 IP 를 알리지 않고 baseline 을 낸다 · 다음 스캔부터 new-ip', async () => {
  ss.saveScanSettings('edge-b', { enabled: true, ranges: ['10.61.0.0/24'] });
  const c = collect();
  ss.mergeScanResults([H('10.61.0.5', { arpMac: 'AA:61:00:00:00:05', arpTried: true })], T0, 'edge-b');
  ss.recordAgentReport('edge-b', { scanned: 254, alive: 1 });
  await tick();
  assert.deepEqual(c.all().map((x) => x.type), ['baseline']);
  assert.equal(c.all()[0].spec, '10.61.0.0/24');
  assert.ok(ss.changeBaselineOf('EDGE-B')['10.61.0.0/24'], '에이전트 이름은 대소문자 무시');
  ss.mergeScanResults([H('10.61.0.5', { arpMac: 'AA:61:00:00:00:05', arpTried: true }), H('10.61.0.9')], T0 + 1000, 'edge-b');
  ss.recordAgentReport('edge-b', { scanned: 254, alive: 2 });
  await tick();
  const news = c.all().filter((x) => x.type === 'new-ip');
  assert.deepEqual(news.map((x) => x.ip), ['10.61.0.9']);
  assert.equal(c.all().filter((x) => x.type === 'baseline').length, 1, '기준선은 줄마다 한 번');
  c.off();
});

test('② 부분 결과(시한에 걸린 스캔)는 비교하지 않는다 · 대역 밖 IP 의 새 응답은 new-ip 가 아니다', async () => {
  const c = collect();
  ss.mergeScanResults([H('10.61.0.20')], T0 + 2000, 'edge-b', { seenOnly: true });
  ss.mergeScanResults([H('10.62.0.1')], T0 + 2000, 'edge-b');
  await tick();
  assert.deepEqual(c.all(), []);
  c.off();
});

test('② 예약 · 폐기 IP 사용 시작 — IP 지정 · 대역 정책 · 해제 뒤 다시 응답 · 이미 쓰던 IP 는 아님', async () => {
  ov.setOverride('10.63.0.1', { status: 'reserved' }, { username: 't' });
  ov.setOverride('10.63.0.2', { status: 'active' }, { username: 't' });
  rp.setPolicy({ spec: '10.63.1.0/24', status: 'deprecated' }, { username: 't' });
  const c = collect();
  ss.mergeScanResults([H('10.63.0.1'), H('10.63.0.2'), H('10.63.1.7')], T0, 'edge-r');
  await tick();
  const ups = c.all().filter((x) => x.type === 'reserved-up');
  assert.deepEqual(ups.map((x) => [x.ip, x.status]), [['10.63.0.1', 'reserved'], ['10.63.1.7', 'deprecated']]);
  ss.mergeScanResults([H('10.63.0.1')], T0 + 1000, 'edge-r');
  await tick();
  assert.equal(c.all().filter((x) => x.type === 'reserved-up').length, 2, '계속 쓰는 IP 는 다시 알리지 않는다');
  c.off();
});

test('② 호스트명 변경 · MAC 변경 · 예전 MAC 으로 되돌아감(flap)', async () => {
  const ip = '10.64.0.1';
  const c = collect();
  ss.mergeScanResults([H(ip, { names: { dns: 'a.corp' }, tried: ['dns'], arpMac: 'AA:64:00:00:00:01', arpTried: true })], T0, 'edge-m');
  ss.mergeScanResults([H(ip, { names: { dns: 'b.corp' }, tried: ['dns'], arpMac: 'AA:64:00:00:00:02', arpTried: true })], T0 + 1000, 'edge-m');
  ss.mergeScanResults([H(ip, { names: { dns: 'b.corp' }, tried: ['dns'], arpMac: 'AA:64:00:00:00:01', arpTried: true })], T0 + 2000, 'edge-m');
  await tick();
  const rn = c.all().filter((x) => x.type === 'rename');
  assert.deepEqual(rn.map((x) => [x.src, x.from, x.to]), [['dns', 'a.corp', 'b.corp']]);
  const mc = c.all().filter((x) => x.type === 'mac-change');
  assert.deepEqual(mc.map((x) => [x.from, x.to, !!x.flap]), [['AA:64:00:00:00:01', 'AA:64:00:00:00:02', false], ['AA:64:00:00:00:02', 'AA:64:00:00:00:01', true]]);
  c.off();
});

// ── ③ 알림 묶음(순수) ─────────────────────────────────────────────────────────
const cfgOf = (rules = {}, quiet = []) => ({ rules: { ipamConflict: { enabled: true, threshold: 2 }, ipamMacChange: { enabled: false }, ipamNewIp: { enabled: false, threshold: 50 }, ipamReservedUp: { enabled: false }, ipamRename: { enabled: false }, ...rules }, ipamQuietAgents: quiet });
test('③ planBatch — vCenter 가 아는 IP · 이중화 MAC 은 거른다 · 기록만 사유(off · quiet · excluded · flap) · 보낼 것만 묶음', () => {
  const batch = { agent: 'Edge-Q', ts: T0, changes: [
    { type: 'new-ip', ip: '10.70.0.1', services: ['SSH'] },
    { type: 'new-ip', ip: '10.70.0.2', services: ['SSH'] },
    { type: 'mac-change', ip: '10.70.0.3', from: '00:00:5E:00:01:01', to: 'AA:00:00:00:00:03' },
    { type: 'mac-change', ip: '10.70.0.4', from: 'AA:00:00:00:00:04', to: 'AA:00:00:00:00:05' },
    { type: 'mac-change', ip: '10.70.0.5', from: 'AA:00:00:00:00:06', to: 'AA:00:00:00:00:07', flap: true },
    { type: 'mac-change', ip: '10.70.0.6', from: '3C:EC:EF:00:00:01', to: 'F4:8E:38:00:00:01' },
    { type: 'rename', ip: '10.70.0.7', src: 'dns', from: 'a', to: 'b' },
    { type: 'baseline', spec: '10.70.0.0/24' },
  ] };
  const known = new Set(['10.70.0.1']);
  const overrides = { '10.70.0.4': { macAlertOff: true } };
  const p = cn.planBatch(batch, { cfg: cfgOf({ ipamNewIp: { enabled: true, threshold: 50 }, ipamMacChange: { enabled: true } }), known, overrides });
  const st = Object.fromEntries(p.entries.map((e) => [e.ip || e.type, e.notify]));
  assert.equal(st['10.70.0.1'], undefined, 'vCenter 가 아는 IP 는 새 미등록 IP 가 아니다');
  assert.equal(st['10.70.0.3'], undefined, '이중화 가상 MAC 은 MAC 변경으로 세지 않는다');
  assert.deepEqual([st['10.70.0.2'], st['10.70.0.4'], st['10.70.0.5'], st['10.70.0.6'], st['10.70.0.7'], st.baseline], ['skipped', 'excluded', 'flap', 'skipped', 'off', 'none']);
  assert.deepEqual([...p.groups.keys()].sort(), ['mac-change', 'new-ip']);
  const e6 = p.entries.find((e) => e.ip === '10.70.0.6');
  assert.deepEqual([e6.fromVendor, e6.vendor], ['Super Micro Computer, Inc.', 'Dell Inc.'], '기록에 제조사 이름을 남긴다(화면에는 제조사 표가 없다)');
  const q = cn.planBatch(batch, { cfg: cfgOf({ ipamNewIp: { enabled: true } }, ['edge-q']), known, overrides });
  assert.equal(q.entries.find((e) => e.ip === '10.70.0.2').notify, 'quiet', '알리지 않을 에이전트(대소문자 무시)');
  assert.equal(q.groups.size, 0);
});

test('③ digestAlert — 줄 상한 LINES_MAX + 외 N건 · 묶음 상한을 넘으면 요약 한 건', () => {
  const list = Array.from({ length: 13 }, (_, i) => ({ type: 'new-ip', ip: `10.71.0.${i + 1}`, services: ['SSH'] }));
  const a = cn.digestAlert('new-ip', list, { agent: 'edge-x', ts: 1, cap: 50 });
  assert.equal(a.summary, false);
  assert.equal(a.alert.title, '새 미등록 IP 13건 — edge-x');
  const lines = a.alert.detail.split('\n');
  assert.equal(lines.length, cn.LINES_MAX + 1);
  assert.match(lines.at(-1), /^외 3건/);
  const b = cn.digestAlert('new-ip', list, { agent: 'edge-x', ts: 1, cap: 10 });
  assert.equal(b.summary, true);
  assert.match(b.alert.detail, /13건\(묶음 상한 10건 초과\)/);
  assert.notEqual(a.alert.key, cn.digestAlert('new-ip', list, { agent: 'edge-x', ts: 2 }).alert.key, '스캔마다 다른 키(억제 창이 다음 스캔 알림을 막지 않게)');
});

test('③ 묶음 처리 — 기록 · 알림 결과(채널 없음 = 보내지 않음) · 목록 필터 · 종류별 개수', async () => {
  cl._resetChangeLogForTest();
  await cn._handleBatchForTest({ agent: 'edge-h', ts: T0, changes: [{ type: 'rename', ip: '10.72.0.1', src: 'netbios', from: 'A', to: 'B' }, { type: 'new-ip', ip: '10.72.0.2', services: ['HTTP'] }] });
  const all = cl.listChanges({});
  assert.equal(all.total, 2);
  assert.equal(all.counts.rename, 1); assert.equal(all.counts['new-ip'], 1);
  assert.deepEqual(all.entries.map((e) => [e.type, e.notify]).sort(), [['new-ip', 'off'], ['rename', 'off']], '기본값은 충돌 의심만 켬 — 나머지는 기록만');
  assert.equal(cl.listChanges({ type: 'rename' }).entries.length, 1);
  assert.equal(cl.listChanges({ ip: '10.72.0.2' }).entries[0].type, 'new-ip');
  assert.equal(cl.listChanges({ agent: 'EDGE-H' }).matched, 2);
  assert.equal(cl.listChanges({ type: '<x>' }).matched, 2, '모르는 종류는 거르지 않는다(전체)');
  // 규칙을 켜면 보내려 한다 — 이 시험에는 채널이 없어 'skipped'(보내지 않음)
  al.saveAlertConfig({ rules: { ipamRename: { enabled: true } } });
  await cn._handleBatchForTest({ agent: 'edge-h', ts: T0 + 1, changes: [{ type: 'rename', ip: '10.72.0.3', src: 'dns', from: 'x', to: 'y' }] });
  assert.equal(cl.listChanges({ ip: '10.72.0.3' }).entries[0].notify, 'skipped');
  al.saveAlertConfig({ rules: { ipamRename: { enabled: false } } });
});

test('③ 변화 기록 — 아는 칸만 · 모르는 종류 버림 · 제어문자 제거 · 디스크에 남는다', () => {
  cl._resetChangeLogForTest(); fs.rmSync(path.join(CFG, 'ipam-changes.json'), { force: true });
  cl.appendChanges([{ type: 'new-ip', ip: '10.73.0.1', services: ['<b>', 'SSH'], evil: 1, note: 'a\u0007b' }, { type: 'nope', ip: '1.1.1.1' }], T0);
  const e = cl.listChanges({}).entries[0];
  assert.equal(e.evil, undefined); assert.equal(e.note, 'a b'); assert.equal(cl.listChanges({}).total, 1);
  cl._flushChangeLogForTest();
  const disk = JSON.parse(fs.readFileSync(path.join(CFG, 'ipam-changes.json'), 'utf8'));
  assert.equal(disk.length, 1);
});

// ── ④ 충돌 의심 판정 ──────────────────────────────────────────────────────────
const vm = (id, ip, macs, extra = {}) => ({ id, name: id, vcenterId: 'vc1', powerState: 'POWERED_ON', ipAddresses: [ip], dev: { nics: macs.map((m) => ({ mac: m })) }, ...extra });
test('④ findConflicts — VM 의 NIC 이 아닌 ARP MAC 이 연속 N회 · 모름 사유 · 이중화 · 대리 ARP · 다른 VM 의 NIC', () => {
  const snap = { vms: [
    vm('vm-a', '10.80.0.1', ['00:50:56:00:00:01']),
    vm('vm-b', '10.80.0.2', ['00:50:56:00:00:02']),
    vm('vm-c', '10.80.0.3', []),
    vm('vm-d', '10.80.0.4', ['00:50:56:00:00:04']), vm('vm-d2', '10.80.0.4', ['00:50:56:00:00:44']),
    vm('vm-e', '10.80.0.5', ['00:50:56:00:00:05']),
    vm('vm-f', '10.80.0.6', ['00:50:56:00:00:06']),
    vm('vm-g', '10.80.0.7', ['00:50:56:00:00:07']),
    vm('vm-h', '10.80.0.8', ['00:50:56:00:00:08'], { powerState: 'POWERED_OFF' }),
    vm('vm-i', '10.80.0.9', [], { dns: { nics: [{ mac: '00:50:56:00:00:09' }] } }),
  ] };
  const arp = (v, n = 2, extra = {}) => ({ arp: { v, at: 100, miss: 0, n, ...extra }, agent: 'e1' });
  const scans = {
    '10.80.0.1': arp('00:50:56:00:00:01'),                 // 자기 NIC — 정상
    '10.80.0.2': arp('F4:8E:38:2A:91:0C'),                 // 의심
    '10.80.0.3': arp('F4:8E:38:2A:91:0C'),                 // NIC 미수집 — 모름
    '10.80.0.4': arp('F4:8E:38:2A:91:0C'),                 // 여러 VM — 모름
    '10.80.0.5': arp('00:00:5E:00:01:05'),                 // 이중화 — 제외
    '10.80.0.6': arp('F4:8E:38:2A:91:0C', 1),              // 아직 1회
    '10.80.0.7': arp('00:50:56:00:00:01', 3),              // 다른 VM(vm-a)의 NIC — 의심 + otherVm
    '10.80.0.8': arp('F4:8E:38:2A:91:0C'),                 // 꺼진 VM — 대상 아님
    '10.80.0.9': arp('00:50:56:00:00:09'),                 // 게스트 NIC MAC 으로 맞음
  };
  const r = cf.findConflicts(snap, (ip) => scans[ip] || null, { streak: 2 });
  assert.deepEqual(r.suspects.map((s) => s.ip), ['10.80.0.2', '10.80.0.7']);
  assert.equal(r.suspects[0].vendor, 'Dell Inc.');
  assert.equal(r.suspects[1].otherVm.id, 'vm-a');
  assert.deepEqual(r.unknown.map((u) => [u.ip, u.reason]).sort(), [['10.80.0.3', 'no-vm-mac'], ['10.80.0.4', 'ambiguous']]);
  // 대리 ARP — 한 MAC 이 SHARED_MAC_MAX 이상 IP 에 답하면 뺀다
  const r2 = cf.findConflicts(snap, (ip) => scans[ip] || null, { streak: 2, macIpCount: (m) => (m === 'F4:8E:38:2A:91:0C' ? cf.SHARED_MAC_MAX : 1) });
  assert.deepEqual(r2.suspects.map((s) => s.ip), ['10.80.0.7']);
  // 지난 스캔에 없음(miss) — 모름(마지막 완료 스캔 시각을 모를 때도)
  const rm = cf.findConflicts(snap, (ip) => (ip === '10.80.0.2' ? arp('F4:8E:38:2A:91:0C', 2, { miss: 1 }) : null), {});
  assert.deepEqual([rm.suspects.length, rm.unknown.map((u) => u.reason)], [0, ['not-seen']]);
  // 지난 스캔에 없음(miss) · 마지막 완료 스캔이 못 봄(lastScanOf) — 모름
  const r3 = cf.findConflicts(snap, (ip) => (ip === '10.80.0.2' ? arp('F4:8E:38:2A:91:0C', 2, { miss: 1 }) : ip === '10.80.0.7' ? arp('00:50:56:00:00:01', 3) : null), { lastScanOf: () => 100 + 61_000 });
  assert.deepEqual(r3.suspects, []);
  assert.deepEqual(r3.unknown.map((u) => u.reason).sort(), ['not-seen', 'not-seen']);
  // 연속 횟수 설정
  assert.deepEqual(cf.findConflicts(snap, (ip) => scans[ip] || null, { streak: 3 }).suspects.map((s) => s.ip), ['10.80.0.7']);
});

test('④ 알림 엔진 평가 — 충돌 의심 위험 알림 · 모름은 보류 · 못 읽은 vCenter 의 VM 은 보류 · 규칙을 꺼도 판정(표시)은 한다', () => {
  // 실제 스캔 저장소에 넣는다 — 같은 MAC 을 두 번(연속 2회)
  // 병합 시각 = 보고 시각 근처(마지막 완료 스캔이 본 MAC 이어야 의심이다 — 오래된 병합 시각이면 '모름')
  const now = Date.now();
  for (const t of [now - 2000, now - 1000]) ss.mergeScanResults([H('10.81.0.1', { arpMac: 'F4:8E:38:2A:91:0C', arpTried: true }), H('10.81.0.2', { arpMac: 'F4:8E:38:2A:91:0C', arpTried: true })], t, 'e-conf');
  ss.recordAgentReport('e-conf', { scanned: 2, alive: 2 });
  const snap = { vcenters: [{ id: 'vc1', status: 'ok' }, { id: 'vc2', status: 'unreachable' }], vms: [vm('vm-x', '10.81.0.1', ['00:50:56:00:01:01']), vm('vm-y', '10.81.0.2', ['00:50:56:00:01:02'], { vcenterId: 'vc2' })] };
  const out = al.evaluate(snap, { rules: { ipamConflict: { enabled: true, threshold: 2 } } });
  const c = out.filter((a) => a.key.startsWith('ipconflict:'));
  assert.deepEqual(c.map((a) => [a.key, a.severity, a.vcenterId]), [['ipconflict:10.81.0.1', 'critical', 'vc1']]);
  assert.match(c[0].title, /^IP 충돌 의심: 10\.81\.0\.1 \(vm-x\)/);
  assert.ok(out.held.has('ipconflict:10.81.0.2'), '지금 값을 못 읽은 vCenter 의 VM 은 해소하지 않고 보류');
  assert.deepEqual(cs.conflictSuspects().map((x) => x.ip).sort(), ['10.81.0.1', '10.81.0.2']);
  const rev = cs.conflictRev();
  const off = al.evaluate(snap, { rules: { ipamConflict: { enabled: false, threshold: 2 } } });
  assert.equal(off.filter((a) => a.key.startsWith('ipconflict:')).length, 0, '규칙을 끄면 알리지 않는다');
  assert.equal(cs.conflictRev(), rev, '같은 목록이면 리비전이 오르지 않는다(대장 캐시)');
  assert.equal(cs.conflictSuspects().length, 2, '규칙을 꺼도 판정(대장 표시)은 한다');
});

test('④ 발생 · 해소 기록 — 같은 발생은 한 번 · 해소는 열린 것만 · 재시작 뒤 기록에서 되살린다', () => {
  cl._resetChangeLogForTest(); cn._resetChangeNotifyForTest();
  const f = { key: 'ipconflict:10.82.0.1', alert: { vcenterId: 'vc1', title: 'IP 충돌 의심: 10.82.0.1 (vm-q)', detail: 'd' } };
  assert.equal(cn.handleAlertState({ firing: [f], resolved: [] }), 1);
  assert.equal(cn.handleAlertState({ firing: [f, { key: 'ds:1' }], resolved: [] }), 0, '같은 발생 · 다른 알림은 남기지 않는다');
  const e = cl.listChanges({ type: 'conflict' }).entries[0];
  assert.deepEqual([e.ip, e.vm, e.notify], ['10.82.0.1', 'vm-q', 'engine']);
  assert.equal(cn.handleAlertState({ firing: [], resolved: [{ key: 'ipconflict:10.99.0.9', alert: {} }] }), 0, '열린 적 없는 해소는 남기지 않는다');
  assert.equal(cn.handleAlertState({ firing: [], resolved: [{ key: 'ipconflict:10.82.0.1', alert: { vcenterId: 'vc1' } }] }), 1);
  assert.equal(cl.listChanges({ type: 'conflict-resolved' }).matched, 1);
});

// ── ⑤ 설정 · 관리상태 ─────────────────────────────────────────────────────────
test('⑤ 기본값 — 충돌 의심만 켬 · 연속 2회 · 묶음 상한 50 · 범위 밖 값은 자른다 · 알리지 않을 에이전트 저장/유지', () => {
  const d = al.loadAlertConfig();
  assert.equal(d.rules.ipamConflict.enabled, true);
  for (const k of ['ipamMacChange', 'ipamNewIp', 'ipamReservedUp', 'ipamRename']) assert.equal(d.rules[k].enabled, false, k);
  const s = al.saveAlertConfig({ rules: { ipamConflict: { threshold: 99 }, ipamNewIp: { threshold: 0 } }, ipamQuietAgents: ['edge-a', 'EDGE-A', '', 5, 'x'.repeat(100)] });
  assert.equal(s.rules.ipamConflict.threshold, 10);
  assert.equal(s.rules.ipamNewIp.threshold, 50, '0 · 빈 값은 이전 값 유지');
  assert.deepEqual(s.ipamQuietAgents, ['edge-a', 'x'.repeat(64)]);
  const s2 = al.saveAlertConfig({ rules: {} });
  assert.deepEqual(s2.ipamQuietAgents, ['edge-a', 'x'.repeat(64)], '본문에 없으면 유지');
  const disk = JSON.parse(fs.readFileSync(path.join(CFG, 'alerts.json'), 'utf8'));
  assert.deepEqual(disk.ipamQuietAgents, ['edge-a', 'x'.repeat(64)]);
  al.saveAlertConfig({ rules: { ipamConflict: { threshold: 2 } }, ipamQuietAgents: [] });
});

test('⑤ 관리상태 macAlertOff — 불리언 참만 · 그 칸만 있어도 항목이 남는다', () => {
  assert.equal(ov.setOverride('10.83.0.1', { macAlertOff: 'true' }, { username: 't' }).ok, true);
  assert.equal(ov.getOverride('10.83.0.1')?.macAlertOff ?? false, false);
  ov.setOverride('10.83.0.1', { macAlertOff: true }, { username: 't' });
  assert.equal(ov.getOverride('10.83.0.1').macAlertOff, true);
  ov.setOverride('10.83.0.1', { macAlertOff: false }, { username: 't' });
  assert.equal(ov.getOverride('10.83.0.1'), null, '모든 칸이 비면 항목을 지운다');
});

// ── ⑥ 대장 · 라우트(자식 프로세스 — 목 데이터) ─────────────────────────────────────
test('⑥ 대장 — VM 행 macConflict · 최근 MAC 변경(macChangedAt · macPrev) · 범위 계정 없음 · /admin/ipam/changes 는 전 법인 관리자만', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-ipchg-route-'));
  const script = `
    const SRC = ${JSON.stringify(SRC + '/')};
    const express = (await import('express')).default;
    const { store } = await import(SRC + 'store.js');
    await store.refresh?.();
    const { api } = await import(SRC + 'routes/api.js');
    const { adminRouter } = await import(SRC + 'routes/admin.js');
    const ss = await import(SRC + 'ipam/scanStore.js');
    const al = await import(SRC + 'alerts.js');
    const cn = await import(SRC + 'ipam/changeNotify.js');
    cn.startIpamChangeNotify();
    const app = express(); app.use(express.json({ limit: '5mb' }));
    app.use((req, _r, n) => { const vc = req.headers['x-scope']; req.user = vc ? { username: 'scoped', role: 'admin', scope: { vcenters: [vc] } } : { username: 'full', role: 'admin', scope: null }; n(); });
    app.use('/api', api); app.use('/api/admin', adminRouter);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = 'http://127.0.0.1:' + srv.address().port;
    const call = async (p, h = {}) => { const r = await fetch(base + '/api' + p, { headers: h }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j }; };
    const out = {};
    try {
      const snap = store.get();
      const vm = (snap.vms || []).find((v) => v.powerState === 'POWERED_ON' && (v.ipAddresses || []).length && (v.dev?.nics || []).length);
      const ip = vm.ipAddresses[0];
      out.vc = vm.vcenterId;
      const now = Date.now();
      for (const t of [now - 2000, now - 1000]) ss.mergeScanResults([{ ip, openPorts: [22], services: ['SSH'], arpMac: 'F4:8E:38:2A:91:0C', arpTried: true }], t, '__local__');
      ss.mergeScanResults([{ ip: '10.250.9.1', openPorts: [22], services: ['SSH'], arpMac: 'AA:00:00:00:09:01', arpTried: true }], now - 1500, '__local__');
      ss.mergeScanResults([{ ip: '10.250.9.1', openPorts: [22], services: ['SSH'], arpMac: 'AA:00:00:00:09:02', arpTried: true }], now - 500, '__local__');
      ss.recordAgentReport('__local__', { scanned: 2, alive: 2 });
      al.evaluate(store.get(), al.loadAlertConfig());
      await new Promise((r) => setTimeout(r, 50));   // 구독자(setImmediate) · 묶음 처리(비동기)를 기다린다
      const led = await call('/tools/ipam');
      out.vmRow = led.j.rows.find((r) => r.ip === ip && r.ownerType === 'vm');
      out.chg = led.j.rows.find((r) => r.ip === '10.250.9.1');
      const sled = await call('/tools/ipam', { 'x-scope': vm.vcenterId });
      out.scopedVm = sled.j.rows.find((r) => r.ip === ip && r.ownerType === 'vm');
      out.changes = await call('/admin/ipam/changes?limit=50');
      out.changesScoped = await call('/admin/ipam/changes', { 'x-scope': vm.vcenterId });
    } catch (e) { out.err = String(e && e.stack || e); } finally { srv.close(); }
    console.log('@@' + JSON.stringify(out));
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUTH_ENABLED: 'false' }, encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 180_000,
  });
  assert.equal(r.status, 0, (r.stderr || '').slice(-2000));
  const ln = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(ln, `${r.stdout.slice(-800)} ${r.stderr.slice(-800)}`);
  const o = JSON.parse(ln.slice(2));
  assert.equal(o.err, undefined, o.err);
  assert.deepEqual([o.vmRow.macConflict?.mac, o.vmRow.macConflict?.vendor, o.vmRow.macConflict?.seen], ['F4:8E:38:2A:91:0C', 'Dell Inc.', 2]);
  assert.equal(o.chg.macPrev, 'AA:00:00:00:09:01');
  assert.ok(o.chg.macChangedAt > 0);
  assert.equal(o.scopedVm.macConflict, undefined, '범위 계정에는 스캔 기반 칸을 싣지 않는다');
  assert.equal(o.changes.s, 200);
  assert.ok(o.changes.j.counts['mac-change'] >= 1, JSON.stringify(o.changes.j.counts));
  assert.equal(o.changesScoped.s, 403, '범위 계정은 IP 변화 기록을 볼 수 없다(스캔 로그와 같은 게이트)');
});

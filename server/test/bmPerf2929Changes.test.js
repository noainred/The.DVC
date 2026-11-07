/**
 * v2.929(리눅스 성능 5단계) — 변경 이벤트 띠(전이만 · 해시만 · 첫 관찰은 기준만 · 못 읽음은 비교하지 않는다) · 소모품 since(며칠째) · 적재 전 판정(cycleOps) ·
 *   보관(change_event · change_latest — 메인 bm-usage.db · 청크 정리 · 대상 밖 서버 정리).
 * 기준 시각: 정시 −30분(v2.517 규약).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bm2929ch-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = '';
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;
let sqlite = true; try { await import('node:sqlite'); } catch { sqlite = false; }

const C = await import('../src/bmusage/changes.js');

const os0 = {
  bootId: '11111111-1111-4111-8111-111111111111', upS: 41 * 86_400, kernel: '5.14.0-362', needsRestart: false, rpmdbAt: 1_000, dnf: null,
  sysctlCrc: '100', sysctlFiles: { '99-gp.conf': '1', 'a.conf': '2' }, cronFiles: { crontab: '9' }, spool: { root: '7' }, spoolPerm: false, firewalld: 'inactive',
  sysctl: { 'vm.dirty_ratio': '20', 'vm.swappiness': '10' }, tuned: 'throughput-performance', selinux: 'disabled', unitsFailed: 0,
};

test('첫 관찰은 기준만 — 이벤트 0 · 다음 기준에 사실이 남는다', () => {
  const r = C.diffChangeFacts(null, { os: os0 }, { now: NOW });
  assert.equal(r.first, true); assert.deepEqual(r.events, []);
  assert.equal(r.facts.kernel, '5.14.0-362');
});

test('전이만 — 같은 사실이면 0 · 바뀐 것만(재부팅 · 커널 · sysctl 키 · 파일 추가/삭제/바뀜 · TuneD · 실패 유닛 · 재부팅 필요 · 패키지)', () => {
  const a = C.diffChangeFacts(null, { os: os0 }, { now: NOW }).facts;
  assert.deepEqual(C.diffChangeFacts(a, { os: os0 }, { now: NOW + 300_000 }).events, [], '같으면 이벤트 없음');
  const b = {
    ...os0, bootId: '22222222-2222-4222-8222-222222222222', upS: 600, kernel: '5.14.0-427', needsRestart: true, rpmdbAt: 2_000,
    dnf: [{ id: 214, at: '2026-11-05 22:05', action: 'Install', altered: 12 }],
    sysctl: { 'vm.dirty_ratio': '10', 'vm.swappiness': '10' }, sysctlFiles: { '99-gp.conf': '5' }, cronFiles: { crontab: '9', 'pg_dump-adhoc': '33' },
    tuned: 'latency-performance', unitsFailed: 2, sysctlCrc: '101',
  };
  const ev = C.diffChangeFacts(a, { os: b }, { now: NOW + 600_000 }).events;
  const kinds = ev.map((e) => `${e.kind}:${e.item}`);
  for (const k of ['reboot:재부팅', 'kernel:실행 커널', 'needs-restart:재부팅 필요', 'package:dnf history #214', 'sysctl:vm.dirty_ratio', 'sysctl-file:99-gp.conf', 'sysctl-file:a.conf', 'cron:pg_dump-adhoc', 'tuned:TuneD 프로파일', 'units-failed:실패 유닛 수']) {
    assert.ok(kinds.includes(k), `${k} 없음: ${kinds.join(', ')}`);
  }
  assert.ok(!kinds.some((k) => k.startsWith('sysctl-all')), '이름을 아는 sysctl 변화가 있으면 전체 CRC 이벤트는 따로 내지 않는다');
  const pkg = ev.find((e) => e.kind === 'package');
  assert.equal(pkg.after, 'Install · 12개 · 2026-11-05 22:05');
  const f = ev.find((e) => e.item === 'a.conf');
  assert.deepEqual([f.before, f.after], ['crc 2', '없음'], '파일 이름과 CRC 앞 8자만(내용 없음)');
  for (const e of ev) { assert.ok(String(e.before ?? '').length <= 120 && String(e.after ?? '').length <= 120); assert.equal(e.ts, NOW + 600_000); }
});

test('못 읽은 칸은 비교하지 않는다 — 구획 missing(null)이 ‘바뀜’ 이 되지 않고 직전 값을 들고 간다', () => {
  const a = C.diffChangeFacts(null, { os: os0 }, { now: NOW }).facts;
  const partial = { ...os0, kernel: null, tuned: null, sysctl: null, sysctlFiles: null, cronFiles: null, spool: null, unitsFailed: null, needsRestart: null, firewalld: null, selinux: null, rpmdbAt: null, sysctlCrc: null, bootId: null };
  const r = C.diffChangeFacts(a, { os: partial }, { now: NOW + 300_000 });
  assert.deepEqual(r.events, []);
  assert.equal(r.facts.kernel, '5.14.0-362', '직전 값 유지');
  const r2 = C.diffChangeFacts(a, { os: null }, { now: NOW + 300_000 });
  assert.deepEqual(r2.events, [], 'OS 경로가 실패한 주기도 거짓 이벤트 없음');
  // 권한 칸(perm)은 내용 변화가 아니다
  const r3 = C.diffChangeFacts(a, { os: { ...os0, spool: { root: 'perm' } } }, { now: NOW + 300_000 });
  assert.deepEqual(r3.events, []);
});

test('sysctl 전체 CRC — 연속 3주기 바뀌면 휘발성(noisy)으로 보고 그 이벤트를 멈춘다(실장비 휘발성 키 미확인 대비)', () => {
  let f = C.diffChangeFacts(null, { os: os0 }, { now: NOW }).facts;
  const seen = [];
  for (let i = 1; i <= 5; i++) {
    const r = C.diffChangeFacts(f, { os: { ...os0, sysctlCrc: String(100 + i) } }, { now: NOW + i * 300_000 });
    seen.push(r.events.filter((e) => e.kind === 'sysctl-all').length);
    f = r.facts;
  }
  assert.deepEqual(seen, [1, 1, 0, 0, 0], '두 번 알리고 세 번째부터 멈춤');
  assert.equal(f.sxNoisy, true);
});

test('펌웨어 · CVP 매핑 · 소모품 칸 전이 — 이미 가진 인벤토리 · 수동 매핑 · 판정 code', () => {
  const inv = { system: { biosVersion: '2.14.1' }, idrac: { firmwareVersion: '7.10.30' }, firmware: [{ name: 'BIOS', version: '2.14.1' }, { name: 'NIC 1', version: '22.31' }] };
  const fw0 = C.firmwareFactsOf(inv);
  assert.deepEqual(fw0, { bios: '2.14.1', idrac: '7.10.30', list: { BIOS: '2.14.1', 'NIC 1': '22.31' } });
  assert.equal(C.firmwareFactsOf({}), null, '인벤토리가 없으면 null(비교하지 않는다)');
  const cvp0 = C.cvpFactsOf([{ nic: 'eno1', cvpId: 'cvp-kr', deviceKey: 'sw1', port: 'Et1' }]);
  const a = C.diffChangeFacts(null, { os: os0, fw: fw0, cvp: cvp0, health: { chrony: { code: 'ok', since: NOW } } }, { now: NOW }).facts;
  const fw1 = C.firmwareFactsOf({ ...inv, system: { biosVersion: '2.15.0' }, firmware: [{ name: 'BIOS', version: '2.15.0' }, { name: 'NIC 1', version: '22.31' }] });
  const cvp1 = C.cvpFactsOf([{ nic: 'eno1', cvpId: 'cvp-kr', deviceKey: 'sw1', port: 'Et2' }]);
  const ev = C.diffChangeFacts(a, { os: os0, fw: fw1, cvp: cvp1, health: { chrony: { code: 'warn', since: NOW + 300_000 } } }, { now: NOW + 300_000 }).events;
  assert.deepEqual(ev.map((e) => `${e.kind}:${e.item}:${e.before}>${e.after}`).sort(), [
    'cvp-map:eno1:cvp-kr|sw1|Et1>cvp-kr|sw1|Et2', 'firmware:BIOS:2.14.1>2.15.0', 'health:chrony:ok>warn',
  ].sort(), 'BIOS 는 한 번만(목록의 같은 버전 변화는 겹쳐 적지 않는다)');
});

test('since(며칠째 = 전이 기록) — 같은 code 면 유지 · 바뀌면 지금', () => {
  const s1 = C.healthSince(null, { chrony: { code: 'warn' }, units: { code: 'ok' } }, NOW);
  assert.deepEqual(s1, { chrony: { code: 'warn', since: NOW }, units: { code: 'ok', since: NOW } });
  const s2 = C.healthSince(s1, { chrony: { code: 'warn' }, units: { code: 'warn' } }, NOW + 86_400_000);
  assert.equal(s2.chrony.since, NOW, '주의가 이어지면 처음 시각'); assert.equal(s2.units.since, NOW + 86_400_000);
});

test('한 주기 이벤트 상한 — 넘으면 ‘그 밖 n건’ 한 줄(목록 폭주 방지)', () => {
  const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`f${i}.conf`, String(i)]));
  const a = C.diffChangeFacts(null, { os: { ...os0, sysctlFiles: {} } }, { now: NOW }).facts;
  const ev = C.diffChangeFacts(a, { os: { ...os0, sysctlFiles: many } }, { now: NOW + 1 }).events;
  assert.equal(ev.length, C.EVENTS_PER_CYCLE_MAX);
  assert.match(ev.at(-1).item, /^그 밖 \d+건$/);
});

test('보관(실제 DB) + cycleOps — 한 트랜잭션 · 소모품 칸이 행 detail_json 에 실린다 · 재시작 뒤 같은 변화를 다시 적지 않는다 · 청크 정리 · 대상 밖 정리', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  const O = await import('../src/bmusage/opsDb.js');
  const CY = await import('../src/bmusage/cycleOps.js');
  const db = await import('../src/bmusage/db.js');
  const { jsonCol } = await import('../src/bmusage/usage.js');
  const detail = { v: 1, osKind: 'linux', hfacts: { chrony: null, dmesg: { err: 0, warn: 0, err24: 0, warn24: 0 }, upS: 100, kernel: 'k1', needsRestart: false, nrAbsent: false, fd: { alloc: 1, max: 100, pct: 1 }, conntrack: null, oomTotal: 0, sections: { chrony: 'absent', dmesg: 'ok', changes: 'ok' } } };
  const mk = (kernel) => ({ ok: true, target: { key: 'S1', name: 's1', vcenterId: 'vcA', idrac: null },
    built: { row: { key: 'S1', oom_kill_delta: 0, detail_json: jsonCol(detail), tuning_json: jsonCol({ units: { failed: 0 } }) }, changeFacts: { ...os0, kernel } } });
  const deps = { certSource: async () => null, portMapOf: async () => [], portMapError: async () => null, inventoryOf: async () => null };
  const r1 = await CY.prepareCycleOps([mk('k1')], { agent: '', rules: { health: {} }, now: NOW, deps });
  assert.equal(r1.items.length, 1); assert.equal(r1.items[0].events.length, 0, '첫 관찰');
  const res1 = mk('k1');
  await CY.prepareCycleOps([res1], { agent: '', rules: { health: {} }, now: NOW, deps });
  const d1 = JSON.parse(res1.built.row.detail_json);
  assert.equal(d1.health.cells.chrony.code, 'absent'); assert.equal(d1.health.cells.cert.code, 'missing', '인증서 원천을 못 읽음 = 못 읽음(해당 없음과 구분)');
  assert.ok(d1.health.since.chrony != null, 'since 를 함께 싣는다');
  assert.equal((await O.changeWriteBatch({ agent: '', items: r1.items })).ok, true);
  // 같은 사실 — 다시 적지 않는다(재시작해도 change_latest 가 기준)
  const r2 = await CY.prepareCycleOps([mk('k1')], { agent: '', rules: { health: {} }, now: NOW + 300_000, deps });
  assert.equal(r2.items[0].events.length, 0);
  const r3 = await CY.prepareCycleOps([mk('k2')], { agent: '', rules: { health: {} }, now: NOW + 600_000, deps });
  assert.deepEqual(r3.items[0].events.map((e) => e.kind), ['kernel']);
  await O.changeWriteBatch({ agent: '', items: r3.items });
  const got = await O.changeEventsRange({ key: 'S1', agent: '', from: NOW, to: NOW + HOUR });
  assert.deepEqual(got.rows.map((e) => [e.kind, e.before, e.after]), [['kernel', 'k1', 'k2']]);
  // 보존 정리(청크 형태) · 대상 밖 서버 최신값 정리
  assert.equal(await O.changePrune({ before: NOW + HOUR }), 1);
  assert.equal(await O.changeLatestKeep({ agent: '', keys: ['OTHER'] }), 1, 'S1 은 대상 밖 — 최신값을 지운다');
  assert.equal((await O.changeLatestAll({ agent: '' })).size, 0);
  db._resetForTest();
});

test('L1 needs-restarting 을 건너뛴 주기(nr=skip)는 직전에 읽은 값을 이어 쓴다 — 직전 값이 없으면 확인 불가(지어내지 않는다)', async () => {
  const CO = await import('../src/bmusage/cycleOps.js');
  const U = await import('../src/bmusage/usage.js');
  const hf = { chrony: null, dmesg: null, upS: 3 * 86_400, kernel: '5.14.0', needsRestart: null, nrAbsent: false, nrSkipped: true, firewalld: null, fd: null, conntrack: null, oomTotal: null, sections: { chrony: 'absent', dmesg: 'absent', changes: 'ok' } };
  const res = (key) => ({ target: { key }, built: { row: { key, detail_json: U.jsonCol({ osKind: 'linux', hfacts: hf }) }, changeFacts: null } });
  const deps = (facts) => ({ latestAll: async () => new Map(facts ? [['K1', { facts }]] : []), certSource: async () => null, inventoryOf: async () => null, portMapOf: async () => [], portMapError: async () => null });
  const cellOf = (r) => JSON.parse(r.built.row.detail_json).health.cells.uptime;
  const a = res('K1'); await CO.prepareCycleOps([a], { agent: '', rules: {}, now: NOW, deps: deps({ needsRestart: true }) });
  assert.equal(cellOf(a).code, 'warn', '직전 ‘필요’ 를 이어 쓴다');
  const b = res('K1'); await CO.prepareCycleOps([b], { agent: '', rules: {}, now: NOW, deps: deps(null) });
  assert.equal(cellOf(b).code, 'missing', '직전 값이 없으면 확인 불가');
});

test('L6 펌웨어 — 인벤토리 일부 실패로 빠진 부품은 ‘없음’ 이벤트가 아니다(직전 버전 유지) · V1 sysctl 한쪽 못 읽음은 비교하지 않는다', () => {
  const fw0 = { bios: '2.1', idrac: '7.0', list: { 'NIC 1': '22.5', 'RAID': '52.1', 'PSU 1': '1.0' } };
  const a = C.diffChangeFacts(null, { os: os0, fw: fw0 }, { now: NOW });
  const b = C.diffChangeFacts(a.facts, { os: os0, fw: { ...fw0, list: { 'NIC 1': '22.5' } } }, { now: NOW + 300_000 });   // RAID · PSU GET 실패
  assert.deepEqual(b.events, [], '빠진 부품 = 못 읽음');
  assert.deepEqual(b.facts.fw.list, fw0.list, '직전 버전을 들고 간다');
  const c = C.diffChangeFacts(b.facts, { os: os0, fw: { ...fw0, list: { ...fw0.list, RAID: '52.2' } } }, { now: NOW + 600_000 });
  assert.deepEqual(c.events.map((e) => [e.kind, e.item, e.before, e.after]), [['firmware', 'RAID', '52.1', '52.2']], '다시 읽힌 부품은 실제 변화만');
  // V1: sysctl 키가 이번에 없음(못 읽음) — 이벤트가 아니다
  const d = C.diffChangeFacts(a.facts, { os: { ...os0, sysctl: { 'vm.swappiness': '10' } } }, { now: NOW + 300_000 });
  assert.equal(d.events.filter((e) => e.kind === 'sysctl').length, 0, 'vm.dirty_ratio 못 읽음 ≠ 바뀜');
});

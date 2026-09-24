/**
 * v2.607 감사 그룹 d — 수집기 정확성·비밀 승계 회귀.
 *
 * COL2607-01 Capacity 샘플러·엣지 push 가 델타 기준선·지연 히스토그램을 공유하지 않는다 ·
 * COL2607-03 ESXi 전력 파서는 와트 단위만(전류 센서 제외) ·
 * COL2607-04 /sys 분류 후 선로 인터페이스 0개면 '0 bps' 가 아니라 폴백/측정 없음 ·
 * COL2607-05 PowerStore 목록 limit 도달 시 truncated ·
 * COL2607-07 PDU 누적 전력량 부분 합은 전체처럼 내지 않는다 ·
 * SEC2607-07(+LEFT2607-06) 스토리지·SAN·PDU·베어메탈 스토리지 등록부: 계정·포트 변경 시 비밀 폐기, agent 변경은 승계.
 * 실제 함수를 호출해 동작으로 본다(시각 비의존).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-2607d-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.SSRF_ALLOW_LOOPBACK = 'true';
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const src = (rel) => stripComments(fs.readFileSync(path.join(SRC, rel), 'utf8'));

/* ── COL2607-01 ─────────────────────────────────────────────────────────────── */
test('COL2607-01 push 호출이 로컬 샘플러의 델타 창을 자르지 않는다', async () => {
  const { collectSnapshot, createSnapshotState } = await import('../src/capacity/sampler.js');
  const { registerCollector } = await import('../src/capacity/collectors.js');
  let counter = 0;
  // 누적 카운터의 차분을 내는 탐침 수집기(cpu_process 와 같은 모양).
  registerCollector({ key: 'z_probe_2607', unit: 'ratio', sample: (ctx) => {
    const p = ctx.prev.zprobe; ctx.prev.zprobe = counter; return p == null ? null : counter - p;
  } });
  const probe = (snap) => snap.rows.find((r) => r.metric === 'z_probe_2607')?.v ?? null;
  collectSnapshot();                                   // 로컬 기준선
  const pushState = createSnapshotState();
  collectSnapshot(pushState, { resetEld: false });     // push 기준선
  counter += 10;                                       // 부하 구간
  assert.equal(probe(collectSnapshot(pushState, { resetEld: false })), 10);  // push 창
  counter += 1;
  // 수정 전: push 가 전역 prev 를 갱신해 로컬 창이 1 로 잘렸다(부하 10 이 사라졌다).
  assert.equal(probe(collectSnapshot()), 11, '로컬 창은 push 와 무관하게 자기 직전 표본부터 센다');
});

test('COL2607-01 지연 히스토그램은 로컬 샘플러만 reset 한다', async () => {
  const { collectSnapshot, createSnapshotState } = await import('../src/capacity/sampler.js');
  const mkHist = () => ({ resets: 0, percentile: () => 50e6, reset() { this.resets++; } });
  const h = mkHist();
  const pushState = createSnapshotState(); pushState.eld = h;
  const snap = collectSnapshot(pushState, { resetEld: false });
  assert.equal(snap.rows.find((r) => r.metric === 'event_loop_lag')?.v, 50);
  assert.equal(h.resets, 0, 'push 는 percentile 만 읽는다');
  const h2 = mkHist(); const local = createSnapshotState(); local.eld = h2;
  collectSnapshot(local, { resetEld: true });
  assert.equal(h2.resets, 1, '소유자(로컬)는 창마다 reset');
  assert.match(src('agent/capacityPush.js'), /collectSnapshot\(\s*pushState\s*,\s*\{\s*resetEld:\s*false/);
});

/* ── COL2607-03 ─────────────────────────────────────────────────────────────── */
const sensor = (name, reading, type = 'power', base = 'Watts', mod = 0) =>
  `<HostNumericSensorInfo><name>${name}</name><currentReading>${reading}</currentReading>` +
  `<unitModifier>${mod}</unitModifier><baseUnits>${base}</baseUnits><sensorType>${type}</sensorType></HostNumericSensorInfo>`;

test('COL2607-03 전류(Amps) 센서는 와트로 읽지 않는다', async () => {
  const { parsePowerSensorWatts } = await import('../src/vcenter/soapClient.js');
  const ampsOnly = sensor('Power Supply 1 Input Current', 24, 'power', 'Amps', -1)
    + sensor('Power Supply 2 Input Current', 22, 'power', 'Amps', -1);
  assert.equal(parsePowerSensorWatts(ampsOnly), null, '전류만 있으면 전력 없음(수정 전 4)');
  const mixed = sensor('PS1 Input Power', 350) + sensor('PS2 Input Power', 340)
    + sensor('PS1 Input Current', 16, 'power', 'Amps', -1) + sensor('PS2 Input Current', 15, 'power', 'Amps', -1);
  assert.equal(parsePowerSensorWatts(mixed), 690, '와트 입력 합에 전류값이 섞이지 않는다(수정 전 694)');
  assert.equal(parsePowerSensorWatts(sensor('System Board 1 Pwr Consumption', 624)), 624);
});

/* ── COL2607-04 ─────────────────────────────────────────────────────────────── */
test('COL2607-04 선로 인터페이스 0개면 0 bps 가 아니다', async () => {
  const { sumWireNetBytes } = await import('../src/capacity/collectors.js');
  const dev = 'Inter-|   Receive\n face |bytes packets errs drop fifo frame compressed multicast|bytes\n'
    + '    lo: 100 1 0 0 0 0 0 0 100 1 0 0 0 0 0 0\n'
    + '  eth0: 5000000 10 0 0 0 0 0 0 7000000 10 0 0 0 0 0 0\n';
  const r = sumWireNetBytes(dev, () => ({ device: false, bonding: false, masterIsBond: false }));
  assert.ok(r, '측정 가능한 인터페이스가 있으면 폴백으로 센다');
  assert.equal(r.rx, 5000000);
  assert.equal(r.mode, 'fallback-nowire');
  // 폴백으로도 셀 것이 없으면 null(측정 없음) — {rx:0,tx:0} 이 아니다.
  const onlyVeth = dev.replace('eth0', 'veth1');
  assert.equal(sumWireNetBytes(onlyVeth, () => ({ device: false, bonding: false, masterIsBond: false })), null);
  // 정상 분류 경로는 그대로.
  const ok = sumWireNetBytes(dev, (i) => (i === 'eth0' ? { device: true, bonding: false, masterIsBond: false } : null));
  assert.equal(ok.mode, 'sys'); assert.equal(ok.tx, 7000000);
});

/* ── COL2607-05 ─────────────────────────────────────────────────────────────── */
test('COL2607-05 PowerStore 목록 상한 도달은 truncated 로 밝힌다', async () => {
  const { normalizePowerstore } = await import('../src/storage/collectors/powerstore.js');
  const fs1 = Array.from({ length: 1000 }, () => ({ size_total: 1e12, size_used: 5e11 }));
  const hosts = Array.from({ length: 1000 }, (_, i) => ({ id: `h${i}` }));
  const out = normalizePowerstore({ id: 'ps1', name: 'ps1', type: 'powerstore' },
    { fileSystems: fs1, fileSystemsTruncated: true, hosts, hostsTruncated: true, nasServers: [], nasServersTruncated: false });
  const inv = out.extra.inventory;
  assert.equal(inv.fileSystems.truncated, true);
  assert.equal(inv.hosts.truncated, true);
  assert.equal(inv.nasServers.truncated, undefined);
  // 수집 경로: limit 을 건 목록 조회는 전부 listStep(절단 표식)을 거친다 — 알림(별도 alertsTruncated) 외에 맨 step+limit 이 없다.
  const s = src('storage/collectors/powerstore.js');
  const bare = [...s.matchAll(/step\('(\w+)'[^\n]*limit=/g)].map((m) => m[1]).filter((k) => k !== 'alerts' && k !== 'sw'); // sw: limit=1 은 최신 버전 한 건 조회(목록 아님)
  assert.deepEqual(bare, [], `절단 표식 없는 목록 조회: ${bare.join(',')}`);
  for (const k of ['hardware', 'volumes', 'hosts', 'hostGroups', 'fileSystems', 'nasServers', 'storageContainers', 'replication']) {
    assert.match(s, new RegExp(`listStep\\('${k}'`), k);
  }
});

/* ── COL2607-07 ─────────────────────────────────────────────────────────────── */
test('COL2607-07 PDU 누적 전력량 부분 합은 전체처럼 내지 않는다', async () => {
  const { summarize } = await import('../src/pdu/types.js');
  const part = summarize({ units: [{ powerW: 1980, energyKwh: 50000 }, { powerW: 1500, energyKwh: null }] });
  assert.equal(part.energyKwh, null, '수정 전 50000(유닛 2 누락)');
  assert.equal(part.energyPartial, true);
  assert.equal(part.energyUnitsRead, 1);
  assert.equal(part.energyKwhPartial, 50000);
  const full = summarize({ units: [{ energyKwh: 10.004 }, { energyKwh: 5 }] });
  assert.equal(full.energyKwh, 15);
  assert.equal(full.energyPartial, undefined);
  assert.equal(summarize({ units: [{ energyKwh: null }] }).energyKwh, null);
});

/* ── SEC2607-07 / LEFT2607-06 ───────────────────────────────────────────────── */
test('SEC2607-07 스토리지: 계정 변경은 비밀 폐기, agent 변경은 승계', async () => {
  const st = await import('../src/storage/registry.js');
  const a = st.saveDevice({ type: 'unity480', name: 'u1', host: '10.1.1.5', username: 'service', password: 'P1', agent: '' });
  const b = st.saveDevice({ id: a.id, type: 'unity480', name: 'u1', host: '10.1.1.5', username: 'service', password: '', agent: 'edge-kr' });
  assert.equal(b.hasPassword, true, 'agent 만 바꾸면 승계(위임 수집에 필요)');
  assert.equal(b.droppedSecrets, undefined);
  const c = st.saveDevice({ id: a.id, type: 'unity480', name: 'u1', host: '10.1.1.5', username: 'admin', password: '', agent: 'edge-kr' });
  assert.equal(c.hasPassword, false, '계정이 바뀌면 옛 비밀번호를 쓰지 않는다(수정 전 true)');
  assert.deepEqual(c.droppedSecrets, ['password']);
  // SSH 포트: 둘 다 ssh 일 때만 비교
  const d = st.saveDevice({ type: 'unity480', name: 'u2', host: '10.1.1.9', username: 's', password: 'P2', collectMethod: 'ssh', sshPort: 22 });
  const e = st.saveDevice({ id: d.id, type: 'unity480', name: 'u2', host: '10.1.1.9', username: 's', password: '', collectMethod: 'ssh', sshPort: 2222 });
  assert.equal(e.hasPassword, false, 'SSH 포트 변경 → 폐기');
  const f = st.saveDevice({ type: 'unity480', name: 'u3', host: '10.1.1.10', username: 's', password: 'P3', collectMethod: 'api' });
  const g = st.saveDevice({ id: f.id, type: 'unity480', name: 'u3', host: '10.1.1.10', username: 's', password: '', collectMethod: 'api', sshPort: '' });
  assert.equal(g.hasPassword, true, 'API 수집이면 쓰지 않는 SSH 포트로 폐기하지 않는다');
});

test('SEC2607-07 SAN 스위치: 계정 변경 폐기 · agent 변경 승계', async () => {
  const sw = await import('../src/sanswitch/registry.js');
  const c = sw.saveDevice({ type: 'brocade', name: 's1', host: '10.1.1.6', username: 'admin', password: 'x1', agent: '' });
  const d = sw.saveDevice({ id: c.id, type: 'brocade', name: 's1', host: '10.1.1.6', username: 'admin', password: '', agent: 'edge-pl' });
  assert.equal(d.hasPassword, true);
  const e = sw.saveDevice({ id: c.id, type: 'brocade', name: 's1', host: '10.1.1.6', username: 'root', password: '', agent: 'edge-pl' });
  assert.equal(e.hasPassword, false, '수정 전 true');
  assert.deepEqual(e.droppedSecrets, ['password']);
});

test('SEC2607-07 PDU: 계정 변경 폐기 · agent 변경 승계', async () => {
  const pdu = await import('../src/pdu/registry.js');
  const a = pdu.saveDevice({ name: 'p1', host: '10.1.1.7', username: 'apc', password: 'y1', agent: '' });
  assert.equal(a.ok, true, a.reason);
  const id = a.device.id;
  const b = pdu.saveDevice({ id, name: 'p1', host: '10.1.1.7', username: 'apc', password: '', agent: 'edge-us' });
  assert.equal(b.device.hasPassword ?? !!pdu.listDevicesRaw?.().find((x) => x.id === id)?.password, true);
  const c = pdu.saveDevice({ id, name: 'p1', host: '10.1.1.7', username: 'other', password: '', agent: 'edge-us' });
  assert.deepEqual(c.droppedSecrets, ['password'], '수정 전: 비밀번호 유지');
});

test('LEFT2607-06 베어메탈 스토리지: 계정·포트 변경 폐기 · agent 변경 승계', async () => {
  const bm = await import('../src/bmstor/registry.js');
  const a = bm.saveBmServer({ host: '10.1.2.3', port: 22, username: 'root', password: 'z1', name: 'b1', mounts: ['/'] });
  assert.equal(a.ok, true, a.reason);
  const id = a.server.id;
  const raw = () => bm.listBmServersRaw().find((s) => s.id === id);
  bm.saveBmServer({ id, host: '10.1.2.3', port: 22, username: 'root', password: '', agent: 'edge-x', name: 'b1', mounts: ['/'] });
  assert.equal(raw().password, 'z1', 'agent 변경은 승계');
  const c = bm.saveBmServer({ id, host: '10.1.2.3', port: 22, username: 'admin', password: '', agent: 'edge-x', name: 'b1', mounts: ['/'] });
  assert.equal(raw().password, '', '수정 전 z1');
  assert.deepEqual(c.droppedSecrets, ['password']);
});

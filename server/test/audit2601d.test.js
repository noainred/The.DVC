/**
 * v2.601 감사 그룹 d — 수집기·GPU 확정분 회귀(실제 함수 호출로 동작 검증).
 *  RECENT2601-04 전 GPU 오류 → gpuErrors 보존 + 'GPU 응답 없음' 실패
 *  COL-2601-01   nvidia-smi 오류 문장('No devices were found')을 GPU 모델로 등록하지 않음(가짜 SSH 서버)
 *  COL-2601-02   VPLEX 와일드카드 ll 의 반복 머리글이 데이터 행이 되지 않음
 *  COL-2601-03   switchshow 'Disabled (Persistent)' 주석 열 → disabled
 *  COL-2601-05   PowerMax 미해결 경보: 미확인만 · summary 이중 계수 없음 · 못 찾으면 null
 *  COL-2601-06   chassisshow PSU 전력 부분 합 표식
 *  LO2601-06     PowerStore 파일시스템 size_used 결측 → null
 *  EDGE2601-01   GPU 게스트 설정 pull 이 중앙에서 지운 VM 자격증명·고정 IP 를 지운다
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2601d-'));
process.env.CONFIG_DIR = TMP;

const { parseNvidiaSmiCsv, gpuLostError } = await import('../src/gpu/guestops.js');
const { detectPhysicalGpu, collectVmGpuSsh, parseGpuNameLines } = await import('../src/gpu/sshCollect.js');
const { normalizeVplexSsh, parseLl } = await import('../src/storage/collectors/vplexSsh.js');
const { parseSwitchShow, parseChassisShow } = await import('../src/sanswitch/collectors/fosParse.js');
const { summarizePorts } = await import('../src/sanswitch/types.js');
const { powermaxAlertCount, normalizePowermax } = await import('../src/storage/collectors/powermax.js');
const { normalizePowerstore } = await import('../src/storage/collectors/powerstore.js');
const { mergePulledGpuGuestSettings, applyPulledGpuGuestSettings, saveGpuGuestSettings, loadGpuGuestSettings, mergeGpuGuestSettings } = await import('../src/gpu/settings.js');

const require = createRequire(import.meta.url);
const ssh2 = require('ssh2');
async function fakeSsh(handler, bindIp = '127.0.0.1') {
  // ⚠ ssh2.utils.generateKeyPairSync('ed25519') 는 자기 파서가 거부하는 키를 0.5% 만든다(v2.590 CI 사고) — EC SEC1 PEM.
  const hostKey = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'sec1', format: 'pem' });
  const srv = new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
    client.on('authentication', (ctx) => ctx.accept());
    client.on('ready', () => client.on('session', (accept) => {
      const s = accept();
      s.on('pty', (a) => a && a());
      s.on('exec', (a, _r, info) => {
        const ch = a(); const o = handler(info.command) || { out: '', err: 'not found', code: 127 };
        ch.write(o.out || ''); if (o.err) ch.stderr.write(o.err); ch.exit(o.code ?? 0); ch.end();
      });
    }));
    client.on('error', () => {});
  });
  const port = await new Promise((r) => srv.listen(0, bindIp, () => r(srv.address().port)));
  return { port, close: () => srv.close() };
}

const LOST = 'Unable to determine the device handle for GPU0000:3B:00.0: Unknown Error';

test('RECENT2601-04: 전 GPU 오류면 null 이 아니라 count 0 + gpuErrors', () => {
  const r = parseNvidiaSmiCsv(LOST);
  assert.ok(r, '결과가 null 이면 gpuErrors 가 사라진다');
  assert.equal(r.count, 0);
  assert.equal(r.gpuErrors, 1);
  assert.equal(r.utilPct, null); // 사용률을 지어내지 않는다
  assert.deepEqual(r.gpuErrorLines, [LOST]);
  const e = gpuLostError(r);
  assert.ok(e && e.gpuLost && e.guestDiag);
  assert.match(e.message, /GPU 응답 없음/);
  assert.match(e.message, /Unable to determine/);
  // 정상·혼합은 그대로(실패로 바꾸지 않는다)
  assert.equal(gpuLostError(parseNvidiaSmiCsv('10, 5, 100, 1000, Disabled\n' + LOST)), null);
  assert.equal(parseNvidiaSmiCsv('garbage only'), null);
});

test('RECENT2601-04: SSH 수집이 전 GPU 오류를 "GPU 응답 없음" 으로 던진다(파싱 실패 아님)', async () => {
  // collectVmGpuSsh 는 루프백(127.*)을 게스트 IP 로 쓰지 않는다 — 이 호스트의 비루프백 IPv4 로 듣는다.
  const ip = Object.values(os.networkInterfaces()).flat().find((n) => n && n.family === 'IPv4' && !n.internal)?.address;
  if (!ip) return; // 비루프백 IPv4 가 없는 환경 — 파서·gpuLostError 는 위 테스트가 고정한다
  const s = await fakeSsh((c) => (/nvidia-smi/.test(c) ? { out: `${LOST}\n` } : null), ip);
  try {
    const vm = { name: 'v', ipAddress: ip, ipAddresses: [] };
    await assert.rejects(() => collectVmGpuSsh(vm, { username: 'u', password: 'p' }, { port: s.port, timeoutMs: 5000 }),
      (e) => { assert.match(e.message, /GPU 응답 없음/); assert.equal(e.gpuLost, true); assert.equal(e.sshConnected, true); return true; });
  } finally { s.close(); }
});

test('COL-2601-01: parseGpuNameLines 는 uuid 있는 줄만 GPU', () => {
  assert.deepEqual(parseGpuNameLines('No devices were found'), { models: [], note: 'No devices were found' });
  assert.deepEqual(parseGpuNameLines('NVIDIA A100-SXM4-40GB, GPU-1a2b3c4d-0000-1111-2222-333344445555\nTesla T4, GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee').models,
    ['NVIDIA A100-SXM4-40GB', 'Tesla T4']);
  assert.equal(parseGpuNameLines("NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver.").models.length, 0);
});

test('COL-2601-01: GPU 없는 호스트(No devices were found, exit 6)를 GPU 모델로 등록하지 않는다', async () => {
  const s = await fakeSsh((c) => {
    if (/nvidia-smi/.test(c)) return { out: 'No devices were found\n', code: 6 };
    if (c === 'hostname') return { out: 'plainhost\n' };
    if (c === 'uname -s') return { out: 'Linux\n' };
    return null;
  });
  try {
    const det = await detectPhysicalGpu('127.0.0.1', { username: 'u', password: 'p' }, { port: s.port, timeoutMs: 5000 });
    assert.equal(det.reachable, true);
    assert.deepEqual(det.gpuModels, []);
    assert.equal(det.gpuNote, 'No devices were found');
  } finally { s.close(); }
});

test('COL-2601-02: VPLEX 와일드카드 ll 의 반복 머리글이 디렉터·볼륨이 되지 않는다', () => {
  const block = (eng, a, b) => `
/engines/${eng}/directors:
Name            Director ID         Cluster ID  Commissioned  Operational Status  Health State
--------------  ------------------  ----------  ------------  ------------------  ------------
${a}  0x000000003ca00147  1           true          ok                  ok
${b}  0x000000003cb00147  1           true          ok                  ok
`;
  const dirs = block('engine-1-1', 'director-1-1-A', 'director-1-1-B') + block('engine-2-1', 'director-2-1-A', 'director-2-1-B');
  const s = normalizeVplexSsh({ id: 'v', name: 'v' }, { version: 'Product Version: 6.2.0', directors: dirs });
  assert.equal(s.nodes.count, 4);
  assert.equal(s.nodes.unhealthy, 0);
  assert.ok(!s.nodes.list.some((n) => n.name === 'Name'));
  const vols = `
/clusters/cluster-1/storage-elements/storage-volumes:
Name   VPD83 ID   Capacity  Use      Health State
-----  ---------  --------  -------  ------------
v1     VPD83T3:1  1T        used     ok

/clusters/cluster-2/storage-elements/storage-volumes:
Name   VPD83 ID   Capacity  Use      Health State
-----  ---------  --------  -------  ------------
v2     VPD83T3:2  1T        used     ok
`;
  assert.equal(parseLl(vols).length, 2);
  const s2 = normalizeVplexSsh({ id: 'v', name: 'v' }, { version: 'Product Version: 6.2.0', storageVolumes: vols });
  assert.equal(s2.extra.storageVolumes.count, 2);
  assert.deepEqual(s2.extra.storageVolumes.byHealth, { ok: 2 });
});

test('COL-2601-03: switchshow Disabled (Persistent) 주석 → disabled(고장은 덮지 않음)', () => {
  const txt = `switchName: sw1
Index Port Address  Media Speed   State       Proto
==================================================
  0   0   010000   id    N16   Online      FC  F-Port  10:00:00:00:00:00:00:01
  5   5   010500   id    N8    No_Light    FC  Disabled (Persistent)
  6   6   010600   --    N8    No_Module   FC  Disabled
  7   7   010700   id    N8    No_Light    FC
  8   8   010800   id    N8    Mod_Inv     FC  Disabled
`;
  const { ports } = parseSwitchShow(txt);
  const st = Object.fromEntries(ports.map((p) => [p.port, p.state]));
  assert.deepEqual(st, { 0: 'online', 5: 'disabled', 6: 'disabled', 7: 'offline', 8: 'faulty' });
  assert.equal(ports.find((p) => p.port === 5).stateRaw, 'No_Light'); // 원문 유지
  const sum = summarizePorts(ports);
  assert.equal(sum.disabled, 2);
  assert.equal(sum.offline, 1);
});

test('COL-2601-05: PowerMax 미해결 경보 — 미확인 필터·summary 단일 필드·못 찾으면 null', () => {
  assert.deepEqual(powermaxAlertCount({ alertId: ['a', 'b'] }, '/univmax/restapi/102/system/alert?acknowledged=false'), { count: 2, basis: 'unacknowledged' });
  assert.deepEqual(powermaxAlertCount({ alertId: ['a', 'b', 'c'] }, '/univmax/restapi/102/system/alert'), { count: 3, basis: 'all' });
  // 합계와 부분집합(alert_count·critical·warning)을 모두 더하던 이중 계수 — 이제 all_unacknowledged_count 하나
  const sum = { serverAlertSummary: { alert_count: 5, critical: 2, warning: 3, all_unacknowledged_count: 4 },
    symmAlertSummary: [{ symmId: '0001', alert_count: 7, critical: 1, all_unacknowledged_count: 6 }] };
  assert.deepEqual(powermaxAlertCount(sum, '/x/system/alert_summary'), { count: 6, basis: 'summary-unacknowledged' });
  // 알 수 있는 필드가 없으면 0 이 아니라 null
  assert.deepEqual(powermaxAlertCount({ serverAlertSummary: { fatal: 1 } }, '/x/system/alert_summary'), { count: null, basis: null });
  const snap = normalizePowermax({ id: 'pm', type: 'powermax' }, { alertCount: 2, alertsBasis: 'all' });
  assert.equal(snap.alerts.unresolved, 2);
  assert.equal(snap.extra.alertsBasis, 'all');
});

test('COL-2601-06: chassisshow PSU 전력 부분 합이면 powerPartial', () => {
  const txt = `POWER SUPPLY  Unit: 1
Power Usage:            -240
Factory Serial Num:     PS1

POWER SUPPLY  Unit: 2
Factory Serial Num:     PS2
`;
  const r = parseChassisShow(txt);
  assert.equal(r.powerWatts, 240);
  assert.deepEqual(r.powerPartial, { read: 1, total: 2 });
  const full = parseChassisShow(txt.replace('Factory Serial Num:     PS2', 'Power Usage:            -200\nFactory Serial Num:     PS2'));
  assert.equal(full.powerWatts, 440);
  assert.equal(full.powerPartial, null);
});

test('LO2601-06: PowerStore 파일시스템 size_used 결측 → 사용량 null + 개수', () => {
  const fs1 = normalizePowerstore({ id: 'p', type: 'powerstore' }, { fileSystems: [{ size_total: 1e12 }] }).extra.inventory.fileSystems;
  assert.equal(fs1.usedBytes, null);
  assert.equal(fs1.usedUnknown, 1);
  assert.equal(fs1.totalBytes, 1e12);
  const fs2 = normalizePowerstore({ id: 'p', type: 'powerstore' }, { fileSystems: [{ size_total: 1e12, size_used: 0 }, { size_total: 2e12, size_used: 5e11 }] }).extra.inventory.fileSystems;
  assert.equal(fs2.usedBytes, 5e11); // 보고된 0 은 값이다
  assert.equal(fs2.usedUnknown, undefined);
});

test('EDGE2601-01: 중앙 pull 병합은 중앙에서 지운 VM 자격증명·고정 IP 를 지운다', () => {
  const cur = mergeGpuGuestSettings({}, { vcenters: {
    vc1: { enabled: true, username: 'root', password: 'pw', vms: { vmA: { username: 'a', password: 'OLD-SECRET' }, vmB: { username: 'b', password: 'bb' } }, vmIps: { vmA: '10.0.0.1', vmB: '10.0.0.2' } },
    local: { enabled: true, username: 'l', password: 'lp', vms: { vmL: { username: 'l', password: 'lp' } } },
  } });
  // 중앙 사본: vmA override·IP 를 지웠다(키가 사라졌을 뿐 삭제 표식 없음). vmB 는 빈 비밀번호 = 기존 유지.
  const pulled = { enabled: true, vcenters: { vc1: { enabled: true, username: 'root', password: 'pw', vms: { vmB: { username: 'b', password: '' } }, vmIps: { vmB: '10.0.0.2' } } } };
  // 예전 병합(부분 패치 규칙)은 vmA 를 남긴다 — 결함 재현
  assert.equal(mergeGpuGuestSettings(cur, pulled).vcenters.vc1.vms.vmA.password, 'OLD-SECRET');
  const { next, removed } = mergePulledGpuGuestSettings(cur, pulled);
  assert.equal(next.vcenters.vc1.vms.vmA, undefined);
  assert.equal(next.vcenters.vc1.vmIps.vmA, undefined);
  assert.equal(next.vcenters.vc1.vms.vmB.password, 'bb'); // 빈 비밀번호 = 기존 유지 규칙은 그대로
  assert.equal(next.vcenters.vc1.vmIps.vmB, '10.0.0.2');
  assert.deepEqual(removed, { vms: 1, vmIps: 1 });
  assert.equal(next.vcenters.local.vms.vmL.password, 'lp'); // 중앙이 보내지 않은(엣지 로컬) vCenter 는 보존
});

test('EDGE2601-01: applyPulledGpuGuestSettings 가 디스크에 반영한다', () => {
  saveGpuGuestSettings({ enabled: true, vcenters: { vc1: { enabled: true, username: 'r', password: 'p', vms: { vmA: { username: 'a', password: 'OLD' } }, vmIps: { vmA: '10.1.1.1' } } } });
  assert.equal(loadGpuGuestSettings().vcenters.vc1.vms.vmA.password, 'OLD');
  const r = applyPulledGpuGuestSettings({ enabled: true, vcenters: { vc1: { enabled: true, username: 'r', password: 'p', vms: {}, vmIps: {} } } });
  assert.deepEqual(r.removed, { vms: 1, vmIps: 1 });
  const s = loadGpuGuestSettings();
  assert.equal(s.vcenters.vc1.vms.vmA, undefined);
  assert.equal(s.vcenters.vc1.vmIps.vmA, undefined);
  assert.equal(s.vcenters.vc1.password, 'p');
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 무시 */ } });

/**
 * v2.650 — GPU 메모리 점유/사용량·할당 + GPU 온도 + 동작 판정 + 추이(사용자 요청 "GPU 메모리 점유/사용량도 추가" ·
 * "GPU 온도 센서의 온도도 같이 수집해서 실제로 GPU 가 동작하는지 점검" · 호스트 상세 "GPU 사용율, GPU 온도, GPU 메모리 할당/사용율").
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gpu2650-'));
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');

const { parseNvidiaSmiCsv, NVSMI_QUERY } = await import('../src/gpu/guestops.js');
const { gpuActivity, activityCounts, BUSY_UTIL_PCT, HELD_MEM_PCT } = await import('../src/gpu/activity.js');
const { vgpuProfileGB, vmVgpuAllocGB } = await import('../src/gpu/vgpuProfile.js');
const { summarizeHostGpu } = await import('../src/gpu/hostGpu.js');
const gstore = await import('../src/gpu/store.js');
const { narrowGpuRow } = await import('../src/routes/central.js');

test('① nvidia-smi 쿼리는 온도를 맨 뒤에 붙이고, 게스트·SSH 두 경로가 같은 상수를 쓴다', () => {
  assert.match(NVSMI_QUERY, /mig\.mode\.current,temperature\.gpu --format/);
  const ssh = stripComments(fs.readFileSync(path.join(SRC, 'gpu/sshCollect.js'), 'utf8'));
  assert.match(ssh, /NVSMI_QUERY/);
  // 사본 금지 — src 전체에서 query-gpu=utilization 리터럴은 guestops.js 한 곳뿐
  const hits = [];
  const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (p.endsWith('.js') && /query-gpu=utilization/.test(stripComments(fs.readFileSync(p, 'utf8')))) hits.push(path.relative(SRC, p)); } };
  walk(SRC);
  assert.deepEqual(hits, ['gpu/guestops.js']);
});

test('② 파서: 온도·메모리 MB 합·가장 뜨거운 GPU · 구버전 5열 출력 · 이상값', () => {
  const r = parseNvidiaSmiCsv('12, 8, 2048, 81920, Disabled, 54\n90, 50, 40000, 81920, Disabled, 71\n');
  assert.equal(r.tempC, 71);
  assert.equal(r.memUsedMB, 42048); assert.equal(r.memTotalMB, 163840);
  assert.equal(r.gpus[0].tempC, 54);
  const legacy = parseNvidiaSmiCsv('12, 8, 2048, 81920, Disabled\n');
  assert.equal(legacy.tempC, null, '온도 열이 없으면 null(0℃ 가 아니다)');
  assert.equal(legacy.memUsedMB, 2048);
  const na = parseNvidiaSmiCsv('12, 8, 2048, 81920, Disabled, [N/A]\n30, 8, 100, 81920, Disabled, 60\n');
  assert.equal(na.tempC, 60); assert.equal(na.tempPartial, 1);
  const blank = parseNvidiaSmiCsv('12, 8, 2048, 81920, Disabled, \n');
  assert.equal(blank.tempC, null, '빈 온도 칸은 null(Number(\'\')===0 함정)');
  const bad = parseNvidiaSmiCsv('12, 8, 2048, 81920, Disabled, 255\n');
  assert.equal(bad.tempC, null, '센서 오류값(255)은 null');
  const noMem = parseNvidiaSmiCsv('12, 8, [N/A], 81920, Disabled, 40\n');
  assert.equal(noMem.memUsedMB, null); assert.equal(noMem.memTotalMB, null);
});

test('③ 동작 판정: 사용률 → 메모리 순 · 모르는 것은 unknown(유휴 아님)', () => {
  assert.equal(BUSY_UTIL_PCT, 10); assert.equal(HELD_MEM_PCT, 10);
  assert.equal(gpuActivity({ utilPct: 50, memUsedPct: 5 }).state, 'busy');
  assert.equal(gpuActivity({ utilPct: 2, memUsedPct: 70 }).state, 'held');
  assert.equal(gpuActivity({ utilPct: 2, memUsedPct: 1 }).state, 'idle');
  assert.equal(gpuActivity({ utilPct: 2, memUsedPct: null }).state, 'idle');
  assert.equal(gpuActivity({ utilPct: null, memUsedPct: 90 }).state, 'unknown');
  assert.equal(gpuActivity({ utilPct: 0, utilNA: true, memUsedPct: 90 }).state, 'unknown', 'MIG 는 판정 불가');
  assert.equal(gpuActivity(null).state, 'unknown');
  assert.equal(gpuActivity({ utilPct: 50, tempC: 60 }).tempRead, true);
  // 온도는 판정에 쓰지 않는다 — 온도가 달라도 상태가 같다
  assert.equal(gpuActivity({ utilPct: 2, memUsedPct: 1, tempC: 90 }).state, 'idle');
  assert.deepEqual(activityCounts(['busy', 'held', 'x', 'idle']), { busy: 1, held: 1, idle: 1, unknown: 1 });
});

test('④ vGPU 프로파일 → 할당 GB · 해석 못 하면 null', () => {
  assert.equal(vgpuProfileGB('grid_a100-10c'), 10);
  assert.equal(vgpuProfileGB('nvidia_l40s-48q'), 48);
  assert.equal(vgpuProfileGB('grid_a100-3-40c'), 40);
  assert.equal(vgpuProfileGB('grid_m60-0b'), 0.5);
  assert.equal(vgpuProfileGB(''), null);
  assert.equal(vgpuProfileGB('custom'), null);
  assert.equal(vmVgpuAllocGB({ vgpu: 2, profile: 'grid_t4-8q' }), 16);
  assert.equal(vmVgpuAllocGB({ vgpu: 0, passthrough: 1, profile: '' }), null, '패스스루는 대상 아님');
});

test('⑤ 호스트 요약: 꺼진 VM 은 할당·사용에서 빠지고, 미수집 VM 은 개수로 밝힌다', () => {
  const host = { id: 'h1', name: 'h1', vcenterId: 'vc', gpuUtilPct: null, gpus: [{ model: 'A100', memGB: 80, mode: 'vgpu' }, { model: 'A100', memGB: 80, mode: 'vgpu' }] };
  const vms = [
    { id: 'a', name: 'a', powerState: 'POWERED_ON', gpu: { type: 'vgpu', vgpu: 1, passthrough: 0, count: 1, profile: 'grid_a100-40c' } },
    { id: 'b', name: 'b', powerState: 'POWERED_ON', gpu: { type: 'vgpu', vgpu: 1, passthrough: 0, count: 1, profile: 'grid_a100-20c' } },
    { id: 'c', name: 'c', powerState: 'POWERED_OFF', gpu: { type: 'vgpu', vgpu: 1, passthrough: 0, count: 1, profile: 'grid_a100-40c' } },
    { id: 'd', name: 'd', powerState: 'POWERED_ON', gpu: { type: 'vgpu', vgpu: 1, passthrough: 0, count: 1, profile: 'weird' } },
  ];
  const guest = new Map([
    ['a', { utilPct: 80, memUsedPct: 50, memUsedMB: 20480, memTotalMB: 40960, tempC: 66, at: Date.now() }],
    ['c', { utilPct: 99, memUsedPct: 99, memUsedMB: 1, memTotalMB: 1, tempC: 99, at: Date.now() }], // 꺼진 VM 의 낡은 값
  ]);
  const s = summarizeHostGpu(host, vms, guest);
  assert.equal(s.capacityGB, 160); assert.equal(s.capacityEstimated, false);
  assert.equal(s.allocGB, 60, '켜진 VM(a 40 + b 20)만 — 꺼진 c 는 빠진다');
  assert.equal(s.allocUnknown, 1); assert.equal(s.allocPct, 38);
  assert.equal(s.memUsedMB, 20480); assert.equal(s.memVms, 1);
  assert.equal(s.tempC, 66, '꺼진 VM 의 99℃ 는 쓰지 않는다');
  assert.equal(s.utilPct, 80); assert.equal(s.utilSource, 'guest');
  assert.equal(s.vmsOn, 3); assert.equal(s.vmsRead, 1); assert.equal(s.vmsUnread, 2);
  assert.deepEqual(s.activity, { busy: 1, held: 0, idle: 0, unknown: 2 });
  assert.equal(s.vms.find((v) => v.id === 'c').activity, 'off');
  // ESXi 값이 있으면 그것이 먼저
  assert.equal(summarizeHostGpu({ ...host, gpuUtilPct: 12 }, vms, guest).utilSource, 'esxi');
  // 용량을 모르는 GPU 가 하나라도 있으면 합계를 지어내지 않는다
  assert.equal(summarizeHostGpu({ ...host, gpus: [{ model: 'X', memGB: 0, mode: 'passthrough' }] }, [], new Map()).capacityGB, null);
});

test('⑥ 저장소·중앙 수신: MB·온도를 좁힌다(객체·범위 밖은 null)', () => {
  gstore._resetGuestGpuForTest();
  gstore.setGuestGpu({ vms: [{ vmId: 'v1', utilPct: 5, memUsedPct: 10, memUsedMB: '2048', memTotalMB: { x: 1 }, tempC: 300, gpus: 2 }] });
  const v = gstore.getGuestGpuVms()[0];
  assert.equal(v.memUsedMB, 2048); assert.equal(v.memTotalMB, null); assert.equal(v.tempC, null); assert.equal(v.gpus, 2);
  const row = narrowGpuRow({ vmId: 'v2', utilPct: 5, memUsedMB: -1, memTotalMB: 81920, tempC: '55', gpus: 999 });
  assert.equal(row.memUsedMB, null); assert.equal(row.memTotalMB, 81920); assert.equal(row.tempC, 55); assert.equal(row.gpus, null);
  // 구버전 엣지(필드 없음)는 필드를 만들지 않는다
  assert.equal(Object.hasOwn(narrowGpuRow({ vmId: 'v3', utilPct: 1 }), 'tempC'), false);
  gstore._resetGuestGpuForTest();
});

test('⑦ 실제 api 라우터: /tools/gpu/host · /tools/gpu/vms · /tools/gpu · 추이 지표 선택 · 범위', async () => {
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const { store } = await import('../src/store.js');
  const prev = store.snapshot;
  store.snapshot = {
    ...(prev || {}), source: 'vcenter', generatedAt: new Date().toISOString(),
    vcenters: [{ id: 'vc-a' }, { id: 'vc-b' }],
    hosts: [
      { id: 'ha', name: 'esx-a', vcenterId: 'vc-a', connectionState: 'CONNECTED', gpus: [{ model: 'H200 NVL', memGB: 141, mode: 'passthrough' }, { model: 'H200 NVL', memGB: 141, mode: 'passthrough' }] },
      { id: 'hb', name: 'esx-b', vcenterId: 'vc-b', connectionState: 'CONNECTED', gpus: [{ model: 'A100', memGB: 80, mode: 'vgpu' }] },
      { id: 'hn', name: 'esx-n', vcenterId: 'vc-a', connectionState: 'CONNECTED', gpus: [] },
    ],
    vms: [{ id: 'va', name: 'gpu-vm', vcenterId: 'vc-a', host: 'esx-a', powerState: 'POWERED_ON', gpu: { type: 'passthrough', count: 2, vgpu: 0, passthrough: 2, profile: '' } }],
    datastores: [], networks: [], alarms: [],
  };
  gstore._resetGuestGpuForTest();
  gstore.setGuestGpu({ vms: [{ vmId: 'va', host: 'esx-a', vcenterId: 'vc-a', utilPct: 3, memUsedPct: 60, memUsedMB: 172000, memTotalMB: 288000, tempC: 41, gpus: 2 }] });
  const mk = (scope) => { const app = express(); app.use((req, _r, n) => { req.user = { username: 'u', role: 'admin', scope }; n(); }); app.use('/api', api); return app; };
  const srv = await new Promise((r) => { const s = mk(null).listen(0, '127.0.0.1', () => r(s)); });
  const srvS = await new Promise((r) => { const s = mk({ vcenters: ['vc-b'] }).listen(0, '127.0.0.1', () => r(s)); });
  const get = async (s, p) => { const r = await fetch(`http://127.0.0.1:${s.address().port}${p}`); return { status: r.status, body: await r.json().catch(() => null) }; };
  try {
    const h = await get(srv, '/api/tools/gpu/host?id=ha');
    assert.equal(h.status, 200);
    assert.equal(h.body.tempC, 41); assert.equal(h.body.memUsedMB, 172000); assert.equal(h.body.passthroughOn, 2);
    assert.equal(h.body.capacityGB, 282); assert.equal(h.body.capacityEstimated, true);
    assert.equal(h.body.vms[0].activity, 'held');
    assert.deepEqual(h.body.activityRule, { busyUtilPct: 10, heldMemPct: 10 });
    assert.equal((await get(srv, '/api/tools/gpu/host?id=nope')).status, 404);
    assert.equal((await get(srv, '/api/tools/gpu/host?id=hn')).body.gpus, 0);
    assert.equal((await get(srvS, '/api/tools/gpu/host?id=ha')).status, 404, '범위 밖 호스트는 존재를 숨긴다');
    const vms = await get(srv, '/api/tools/gpu/vms');
    const v = vms.body.vms[0];
    assert.equal(v.guestTempC, 41); assert.equal(v.guestMemUsedMB, 172000); assert.equal(v.activity, 'held'); assert.equal(v.allocGB, null);
    const inv = await get(srv, '/api/tools/gpu');
    const row = inv.body.items.find((x) => x.id === 'ha');
    assert.equal(row.tempC, 41); assert.equal(row.memUsedPct, 60);
    assert.equal(inv.body.tempC, 41); assert.equal(inv.body.activity.held, 1);
    const tempHist = await get(srv, '/api/tools/gpu/history?level=host&key=ha&metric=temp');
    assert.equal(tempHist.status, 200); assert.equal(tempHist.body.unit, '℃'); assert.equal(tempHist.body.metric, 'temp');
    assert.equal((await get(srv, '/api/tools/gpu/history?level=cluster&key=vc-a|c&metric=temp')).status, 400, '클러스터는 사용률만');
    const vmHist = await get(srvS, '/api/tools/gpu/history?level=vm&key=va&metric=mem');
    assert.deepEqual(vmHist.body.points, [], '범위 밖 VM 추이는 비운다');
  } finally {
    srv.close(); srvS.close(); store.snapshot = prev; gstore._resetGuestGpuForTest();
  }
});

test('⑧ 지표 샘플러: VM 별 GPU 계열 3종 + 호스트 온도·메모리, 신선한 값만(GPU_VM_SERIES=0 으로 끈다)', () => {
  const src = stripComments(fs.readFileSync(path.join(SRC, 'metrics/sampler.js'), 'utf8'));
  for (const m of ['gpu_vm_util', 'gpu_vm_mem', 'gpu_vm_temp', 'gpu_temp', 'gpu_mem']) assert.match(src, new RegExp(`'${m}'`));
  assert.match(src, /GPU_VM_SERIES !== '0'/);
  assert.match(src, /g\.at > nowG - freshMs/);
});

test('⑨ gpu 객체에 vgpu·passthrough 개수가 없으면 type + count 로 되돌린다', async () => {
  const { vmGpuDevices } = await import('../src/gpu/vgpuProfile.js');
  assert.deepEqual(vmGpuDevices({ type: 'vgpu', count: 2 }), { vgpu: 2, passthrough: 0 });
  assert.deepEqual(vmGpuDevices({ type: 'passthrough', count: 1 }), { vgpu: 0, passthrough: 1 });
  assert.deepEqual(vmGpuDevices({ type: 'mixed', count: 3, vgpu: 1, passthrough: 2 }), { vgpu: 1, passthrough: 2 });
  assert.equal(vmVgpuAllocGB({ type: 'vgpu', count: 1, profile: 'grid_h100-20c' }), 20);
});

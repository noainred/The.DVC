// v2.873 Bareos 백업 대상 GPU 표지 — 인벤토리 vm.gpu → gpuDev(gpu/vgpuProfile.js vmGpuMark) · 대상 목록·등록 후보 두 응답이 같은 함수를 쓴다.
// 사용자 요청 'GPU VM 백업 대상 화면에 표지 추가' — VMware 는 vGPU·PCI 패스스루 장치가 있는 켜진 VM 의 스냅샷을 지원하지 않는다(Broadcom KB 394566).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { vmGpuMark, vmGpuDevices } from '../src/gpu/vgpuProfile.js';
import { stripComments } from './_stripComments.js';

test('vmGpuMark — 모르는 값·장치 없음은 null(없다고 단정하지 않는다 — 표지를 안 붙일 뿐)', () => {
  for (const vm of [undefined, null, 0, 'vm', {}, { gpu: null }, { gpu: 'x' }, { gpu: {} }, { gpu: { type: 'vgpu', count: 0, vgpu: 0, passthrough: 0 } }]) {
    assert.equal(vmGpuMark(vm), null, JSON.stringify(vm));
  }
  // 음수·NaN·1 미만 소수는 장치 0 으로(0 을 장치로 세지 않는다)
  assert.equal(vmGpuMark({ gpu: { vgpu: -2, passthrough: 'abc' } }), null);
  assert.equal(vmGpuMark({ gpu: { vgpu: 0.5, passthrough: 0 } }), null);
});

test('vmGpuMark — vGPU · 패스스루 · 혼합 · 구버전 모양(type + count)', () => {
  assert.deepEqual(vmGpuMark({ gpu: { type: 'vgpu', count: 2, vgpu: 2, passthrough: 0, profile: 'grid_a100-10c' } }), { vgpu: 2, passthrough: 0, profile: 'grid_a100-10c' });
  assert.deepEqual(vmGpuMark({ gpu: { type: 'passthrough', count: 1, vgpu: 0, passthrough: 1, profile: '', pciIds: ['0000:3b:00.0'] } }), { vgpu: 0, passthrough: 1, profile: '' });
  assert.deepEqual(vmGpuMark({ gpu: { type: 'mixed', count: 3, vgpu: 1, passthrough: 2, profile: 'nvidia_l40s-48q' } }), { vgpu: 1, passthrough: 2, profile: 'nvidia_l40s-48q' });
  // vgpu·passthrough 필드가 없는 구버전 스냅샷·목 — vmGpuDevices 와 같은 되돌림(판정 코어 하나)
  assert.deepEqual(vmGpuMark({ gpu: { type: 'vgpu', count: 1, profile: 'grid_t4-16q' } }), { vgpu: 1, passthrough: 0, profile: 'grid_t4-16q' });
  assert.deepEqual(vmGpuMark({ gpu: { type: 'passthrough', count: 2 } }), { vgpu: 0, passthrough: 2, profile: '' });
  const g = { type: 'mixed', count: 3, vgpu: 1, passthrough: 2 };
  const d = vmGpuDevices(g);
  const m = vmGpuMark({ gpu: g });
  assert.equal(m.vgpu, d.vgpu); assert.equal(m.passthrough, d.passthrough);
});

test('vmGpuMark — 엣지 push 값은 수 형식을 좁히지 않으므로 정수 0~64 · 프로파일은 이름 글자만', () => {
  assert.deepEqual(vmGpuMark({ gpu: { vgpu: 1e9, passthrough: 2.9 } }), { vgpu: 64, passthrough: 2, profile: '' });
  // 프로파일은 vGPU 가 있을 때만, 이름 글자(영숫자 . _ -) 64자까지
  assert.equal(vmGpuMark({ gpu: { vgpu: 0, passthrough: 1, profile: 'grid_a100-10c' } }).profile, '');
  for (const bad of ['<b>x</b>', 'a b', 'x'.repeat(65), 'grid\nx', 42]) {
    assert.equal(vmGpuMark({ gpu: { vgpu: 1, passthrough: 0, profile: bad } }).profile, '', String(bad));
  }
  assert.equal(vmGpuMark({ gpu: { vgpu: 1, passthrough: 0, profile: '  grid_a40-24q ' } }).profile, 'grid_a40-24q');
});

test('대상 목록(viewJob)과 등록 후보(vm-candidates) 두 응답이 같은 함수로 gpuDev 를 싣는다', () => {
  const src = stripComments(fs.readFileSync(new URL('../src/routes/api/bareosBackup.js', import.meta.url), 'utf8'));
  assert.match(src, /import \{ vmGpuMark \} from '\.\.\/\.\.\/gpu\/vgpuProfile\.js'/);
  const view = src.slice(src.indexOf('const viewJob ='), src.indexOf('const viewJob =') + 900);
  assert.match(view, /gpuDev: vmGpuMark\(vm\)/, 'viewJob 이 gpuDev 를 싣는다');
  const cand = src.slice(src.indexOf("'/tools/bareos-backup/vm-candidates'"), src.indexOf("'/tools/bareos-backup/vm-candidates'") + 1500);
  assert.match(cand, /gpuDev: vmGpuMark\(v\)/, '등록 후보가 gpuDev 를 싣는다');
  // 판정을 복제하지 않는다 — 라우트 파일에 vm.gpu 를 직접 세는 코드가 없다
  assert.doesNotMatch(src, /\.gpu\.(vgpu|passthrough|count)\b/);
});

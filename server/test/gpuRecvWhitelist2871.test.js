/**
 * gpuRecvWhitelist2871.test.js — 중앙이 엣지 인벤토리의 호스트 gpus · VM gpu 를 **아는 키만** 받는다(v2.871 · 감사 A3-06).
 *
 * 고정하는 것:
 *  ① 무손실 — 데모 생성기(수집기와 같은 모양)의 GPU 원소 전부가 정제 뒤에도 그대로 남고 coerced 가 0 이다(정상 데이터를 떨어뜨리지 않는다).
 *  ② 모르는 키 · 큰 글자 · 객체 · 형식 밖 값은 지우거나 null(모름)이고 coerced 로 센다(0 이나 빈 배열로 지어내지 않는다).
 *  ③ 실제 수신 경로(sanitizeInventoryList)도 같은 정제를 탄다.
 *  ④ 수집기 소스의 GPU 원소 키가 화이트리스트에 있다(수집기가 필드를 더하면 이 시험이 깨진다 — 중앙에서 조용히 사라지지 않게).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeHostGpus, sanitizeVmGpuField, sanitizeInventoryList, GPU_HOST_KEYS, GPU_VM_KEYS } from '../src/routes/central.js';
import { generateSnapshot } from '../src/mock/generator.js';
import { stripComments } from './_stripComments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

test('① 무손실 — 데모 생성기의 호스트 gpus · VM gpu 가 정제 뒤에도 그대로다', () => {
  const snap = generateSnapshot();
  const hosts = (snap.hosts || []).filter((h) => Array.isArray(h.gpus) && h.gpus.length);
  const vms = (snap.vms || []).filter((v) => v.gpu && typeof v.gpu === 'object');
  assert.ok(hosts.length > 5, `GPU 호스트가 있어야 시험이 의미가 있다(${hosts.length})`);
  assert.ok(vms.length > 5, `GPU VM 이 있어야 한다(${vms.length})`);
  for (const h of hosts) {
    const r = sanitizeHostGpus(h.gpus);
    assert.equal(r.coerced, 0, `${h.id}: ${JSON.stringify(h.gpus[0])}`);
    assert.deepEqual(r.value, h.gpus);
  }
  for (const v of vms) {
    const r = sanitizeVmGpuField(v.gpu);
    assert.equal(r.coerced, 0, `${v.id}: ${JSON.stringify(v.gpu)}`);
    assert.deepEqual(r.value, v.gpu);
  }
});

test('② 모르는 키 · 큰 글자 · 객체 · 형식 밖 값은 지우거나 null(모름)이다', () => {
  const big = 'x'.repeat(5000);
  const h = sanitizeHostGpus([{ model: big, vendor: { a: 1 }, memGB: '24', mode: 'evil', vgpuMode: 'yes', pciId: '0000:3b:00.0', busId: '../../x', vms: ['vm-1'], extra: big, nested: { deep: [1, 2] }, __proto__x: 1 }]);
  const g = h.value[0];
  assert.deepEqual(Object.keys(g).sort(), ['busId', 'memGB', 'mode', 'model', 'pciId', 'vendor', 'vms'].sort(), '모르는 키(extra · nested · __proto__x)와 형식 밖 vgpuMode 는 지운다');
  assert.ok(g.model.length <= 128, '글자는 상한으로 자른다');
  assert.equal(g.vendor, null, '객체는 모름(null)');
  assert.equal(g.memGB, 24, '문자열 수치는 수로');
  assert.equal(g.mode, null, '모르는 모드는 모름(null) — 화면이 vgpuMode 로 폴백한다');
  assert.equal(g.busId, null);
  assert.ok(h.coerced >= 6, `셌다(${h.coerced})`);
  assert.equal(sanitizeHostGpus([{ memGB: -1 }]).value[0].memGB, null, '음수 용량은 모름');
  assert.equal(sanitizeHostGpus([{ memGB: '' }]).value[0].memGB, null, "빈 글자는 0 이 아니라 모름(numOrNull)");

  const v = sanitizeVmGpuField({ type: 'vgpu', count: '2', vgpu: 2.5, passthrough: -1, profile: big, pciIds: ['0000:3b:00.0'], secret: 'x', html: '<b>' });
  assert.deepEqual(Object.keys(v.value).sort(), ['count', 'passthrough', 'pciIds', 'profile', 'type', 'vgpu'].sort());
  assert.equal(v.value.count, 2);
  assert.equal(v.value.vgpu, null, '정수가 아니면 모름');
  assert.equal(v.value.passthrough, null);
  assert.ok(v.value.profile.length <= 64);
  assert.ok(v.coerced >= 4);
  assert.equal(sanitizeVmGpuField({ type: 'nope' }).value.type, null);
});

test('③ 실제 수신 경로 sanitizeInventoryList 가 gpus · gpu 의 모르는 키를 지운다', () => {
  const dropped = { notObject: 0, otherVcenter: 0, badId: 0, coerced: 0 };
  const [h] = sanitizeInventoryList([{ id: 'vc1:h1', name: 'esx1', gpus: [{ model: 'A40', mode: 'vgpu', injected: 'x'.repeat(10000) }] }], 'vc1', 10, dropped);
  assert.deepEqual(h.gpus, [{ model: 'A40', mode: 'vgpu' }]);
  assert.ok(dropped.coerced >= 1, '지운 수를 센다');
  const d2 = { notObject: 0, otherVcenter: 0, badId: 0, coerced: 0 };
  const [v] = sanitizeInventoryList([{ id: 'vc1:vm1', name: 'vm1', gpu: { type: 'passthrough', count: 1, injected: { a: 1 } } }], 'vc1', 10, d2);
  assert.deepEqual(v.gpu, { type: 'passthrough', count: 1 });
  assert.ok(d2.coerced >= 1);
});

test('④ 수집기 소스가 GPU 원소에 넣는 키는 전부 화이트리스트에 있다', () => {
  const src = stripComments(fs.readFileSync(path.resolve(HERE, '../src/vcenter/soapClient.js'), 'utf8'));
  const body = (name) => { const i = src.indexOf(`function ${name}(`); assert.ok(i >= 0, name); return src.slice(i, src.indexOf('\n}\n', i)); };
  const keysOf = (txt) => [...txt.matchAll(/\{\s*([^{}]*?)\s*\}\s*\)?;?/g)].flatMap((m) => [...m[1].matchAll(/(?:^|,)\s*([a-zA-Z]+)\s*(?::|,|$)/g)].map((x) => x[1]));
  // parseGpus · parsePassthruGpus 의 out.push({...}) 키
  const hostKeys = new Set();
  for (const fn of ['parseGpus', 'parsePassthruGpus']) {
    for (const m of body(fn).matchAll(/out\.push\(\{([\s\S]*?)\}\);/g)) {
      for (const k of m[1].matchAll(/(?:^|[\n,{])\s*([a-zA-Z]+)\s*(?=[:,\n}]|$)/g)) hostKeys.add(k[1]);
    }
  }
  hostKeys.delete('graphicsVmRefs'); // 펼침(...graphicsVmRefs(blk)) — vms 를 만든다
  assert.ok(hostKeys.size >= 5, [...hostKeys].join(','));
  for (const k of hostKeys) assert.ok(GPU_HOST_KEYS.includes(k), `호스트 GPU 키 '${k}' 가 화이트리스트에 없다`);
  const vmBody = body('parseVmGpu');
  const vmObj = /const out = \{([^}]*)\}/.exec(vmBody)[1];
  for (const k of vmObj.split(',').map((x) => x.trim().split(':')[0].trim()).filter(Boolean)) assert.ok(GPU_VM_KEYS.includes(k), `VM GPU 키 '${k}'`);
  assert.ok(/out\.pciIds\s*=/.test(vmBody) && GPU_VM_KEYS.includes('pciIds'));
  void keysOf;
});

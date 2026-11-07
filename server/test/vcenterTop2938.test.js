/**
 * vcenterTop2938.test.js — 엣지 인벤토리 push 의 vcenter 객체는 아는 최상위 필드만 저장한다(v2.938 · vCenter 규칙 '별건' 해결).
 *  ① 순수 판정 — 모르는 키는 버리고 이름·개수 · 형식이 다르면 버림 · 앞에서 정제한 키는 그대로 · 글자 상한
 *  ② 실제 라우터 — POST /api/central/inventory 에 모르는 키·거대 문자열·객체를 실으면 저장되지 않고 응답 dropped 가 밝힌다 · 정상 필드는 그대로
 *  ③ 소스 스윕 — 수집기(soapClient·restClient)·store.js merge·목 생성기가 만드는 vcenter 키가 전부 표에 있다(새 필드를 더하면 표에도)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'vctop2938-'));
const TOKEN = 'tok-2938';
Object.assign(process.env, { CONFIG_DIR: CFG, DATA_SOURCE: 'live', AUTH_ENABLED: 'true', CENTRAL_TOKEN: TOKEN });
const VC_ID = 'vc-site2938';
fs.writeFileSync(path.join(CFG, 'vcenters.json'), JSON.stringify({ vcenters: [{ id: VC_ID, name: 'Site 2938', host: 'https://10.0.0.37', collectMode: 'site' }] }));

const vt = await import('../src/central/vcenterTop.js');

test('① 순수 판정 — 아는 키만 · 형식 · 앞에서 정제한 키는 그대로 · 상한', () => {
  const big = 'x'.repeat(100_000);
  const r = vt.sanitizeVcenterTop({
    id: 'vc1', name: big, status: 'connected', version: 8, stale: 'yes', maintenance: true, vmGpuCarried: 3,
    restUnknown: ['hostCapacity', 7, 'y'.repeat(100), ...Array(50).fill('a')], invFetch: { mode: 'updates', changed: 5, evil: { x: 1 } },
    authStopped: { since: 1, at: 2, attempts: 3, reason: 'r', password: 'p' }, location: { city: 'Seoul' }, clusterCfg: [{ a: 1 }],
    secretBlob: big, nested: { deep: true }, __proto__x: 1,
  });
  assert.equal(r.value.name.length, 200, '글자 상한');
  assert.equal(r.value.version, undefined, '형식이 다르면 버린다(글자 칸에 수)');
  assert.equal(r.value.stale, undefined); assert.equal(r.value.maintenance, true); assert.equal(r.value.vmGpuCarried, 3);
  assert.equal(r.value.restUnknown.length, 32); assert.equal(r.value.restUnknown[1].length, 32, '배열 원소도 상한 · 글자 아닌 원소는 뺀다');
  assert.deepEqual(r.value.invFetch, { mode: 'updates', changed: 5 }, '하위 객체도 아는 필드만');
  assert.deepEqual(r.value.authStopped, { since: 1, at: 2, attempts: 3, reason: 'r' });
  assert.deepEqual(r.value.location, { city: 'Seoul' }, '앞에서 정제한 키는 건드리지 않는다');
  assert.deepEqual(r.value.clusterCfg, [{ a: 1 }]);
  assert.deepEqual(r.droppedKeys.sort(), ['__proto__x', 'nested', 'secretBlob']);
  assert.equal(r.droppedCount, 3); assert.equal(r.coerced, 2, 'version · stale');
  assert.equal(Object.hasOwn(r.value, 'secretBlob'), false);
  assert.deepEqual(vt.sanitizeVcenterTop(null).value, {});
  const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, i]));
  const m = vt.sanitizeVcenterTop(many);
  assert.equal(m.droppedCount, 40); assert.equal(m.droppedKeys.length, 20, '이름은 20개까지만 밝힌다');
});

test('①-2 반증 A-1 — 프로토타입 이름 키(constructor · toString · hasOwnProperty · __proto__)도 던지지 않고 버린다', async () => {
  const { sanitizeVcenterTop } = await import('../src/central/vcenterTop.js');
  const raw = JSON.parse('{"id":"x","name":"ok","constructor":1,"toString":"a","hasOwnProperty":{},"__proto__":{"polluted":1},"valueOf":[]}');
  const r = sanitizeVcenterTop(raw);
  assert.equal(r.value.name, 'ok');
  for (const k of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf']) assert.ok(r.droppedKeys.includes(k), k);
  assert.equal(Object.prototype.hasOwnProperty.call(r.value, 'constructor'), false);
  assert.equal(({}).polluted, undefined);
});

test('② 실제 라우터 — 모르는 키·거대 값은 저장되지 않고 응답이 밝힌다 · 정상 필드는 그대로', async () => {
  const express = (await import('express')).default;
  const { centralRouter } = await import('../src/routes/central.js');
  const inv = await import('../src/central/inventory.js');
  const vcId = VC_ID;
  const app = express();
  app.use(express.json({ limit: '8mb' }));
  app.use('/api/central', centralRouter);
  const srv = app.listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  try {
    const token = TOKEN;
    const body = {
      agent: 'edge2938', vcenterId: vcId, source: 'live', generatedAt: new Date().toISOString(),
      vcenter: { id: vcId, name: 'Site 2938', status: 'connected', version: '8.0.3', build: '24305161', instanceUuid: 'u-1', alarmsUnknown: false,
        location: { city: 'Warsaw', country: 'PL', region: 'EU', lat: 52.2, lon: 21 }, secretBlob: 'z'.repeat(200_000), credentials: { password: 'leak' } },
      hosts: [{ id: `${vcId}:host-1`, vcenterId: vcId, name: 'esx1', connectionState: 'CONNECTED' }], vms: [], datastores: [], networks: [], alarms: [],
    };
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/central/inventory`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { 'x-central-token': token } : {}) }, body: JSON.stringify(body),
    });
    const j = await res.json();
    assert.equal(res.status, 200, JSON.stringify(j));
    assert.equal(j.ok, true, JSON.stringify(j));
    assert.equal(j.dropped?.vcTopUnknown, 2, JSON.stringify(j));
    assert.deepEqual(j.dropped.vcTopKeys.sort(), ['credentials', 'secretBlob']);
    const saved = inv.getInventory(vcId);
    assert.ok(saved, '저장됐다');
    const v = saved.data?.vcenter || saved.vcenter;
    assert.equal(v.secretBlob, undefined); assert.equal(v.credentials, undefined);
    assert.equal(v.version, '8.0.3'); assert.equal(v.instanceUuid, 'u-1'); assert.equal(v.location.city, 'Warsaw'); assert.equal(v.id, vcId);
  } finally { srv.close(); }
});

const strip = (t) => stripComments(t);   // 공용 주석 제거기(v2.574 규약 — 2줄 정규식 사본 금지)
const keysIn = (t) => [...t.matchAll(/(?:[{,]\s*|\.\.\.\(\w+ \? \{ )(\w+)(?=\s*[:,}])/g)].map((m) => m[1]);
const seg = (rel, a, b) => { const s = fs.readFileSync(path.join(SRC, rel), 'utf8'); const i = s.indexOf(a); assert.ok(i >= 0, `${rel}: 시작 표지를 찾지 못했다 — 이 테스트의 표지를 고칠 것`); const j = s.indexOf(b, i); assert.ok(j > i, `${rel}: 끝 표지`); return strip(s.slice(i, j)); };

test('③ 소스 스윕 — 수집기·store merge·목 생성기의 vcenter 키가 전부 표에 있다', async () => {
  const known = new Set([...Object.keys(vt.VC_TOP_FIELDS), ...vt.PRE_SANITIZED, 'vcInfo']);
  const found = {
    soap: keysIn(seg('vcenter/soapClient.js', '      vcenter: {\n        id: vc.id', '      hosts, vms, datastores')),
    rest: keysIn(seg('vcenter/restClient.js', '      vcenter: {\n        id: vc.id', '      hosts: hosts.map')),
    store: [...strip(fs.readFileSync(path.join(SRC, 'store.js'), 'utf8')).matchAll(/merged\.vcenters\.push\((\{[^;]*?\})\);/g)].flatMap((m) => keysIn(m[1])),
  };
  assert.ok(found.soap.includes('instanceUuid') && found.rest.includes('restUnknown') && found.store.includes('collectedBy'), '추출이 동작한다(표지가 맞다)');
  for (const [where, ks] of Object.entries(found)) {
    const missing = [...new Set(ks)].filter((k) => !known.has(k));
    assert.deepEqual(missing, [], `${where} 가 만드는 vcenter 키가 central/vcenterTop.js 표에 없다 — 위임 법인에서 그 값이 사라진다`);
  }
  // 목 생성기의 실제 스냅샷 — 버려지는 키 0
  const { generateSnapshot } = await import('../src/mock/generator.js');
  for (const vc of generateSnapshot().vcenters) {
    const r = vt.sanitizeVcenterTop(vc);
    assert.equal(r.droppedCount, 0, `${vc.id}: ${r.droppedKeys}`); assert.equal(r.coerced, 0, vc.id);
  }
  // store.js 가 스냅샷 vcenter 에 직접 다는 필드
  assert.match(fs.readFileSync(path.join(SRC, 'store.js'), 'utf8'), /snap\.vcenter\.vmGpuCarried = /); assert.ok(known.has('vmGpuCarried'));
  // 라우터가 실제로 이 정제를 쓴다
  const central = strip(fs.readFileSync(path.join(SRC, 'routes/central.js'), 'utf8'));
  assert.match(central, /const top = sanitizeVcenterTop\(vcenter\)/); assert.match(central, /vcenter: \{ \.\.\.top\.value, id: vcId \}/);
});

/**
 * test/bareosInventory.test.js — VM 의 정확한 위치(vcenter/vmPlacement.js)와 그 필드의 수집·전달 경로.
 *  - 'vm' 이라는 이름의 사용자 폴더 · 폴더 속 데이터센터(전체 경로) · 루트 VM('/') · vApp(부모 없음 → null) · 고리 → null
 *  - soapClient 가 Datacenter.parent 를 받고 VM 레코드에 펼친다(소스 고정) · 엣지 정제는 글자만 통과(객체 → null)
 *  - 목업 VM 도 두 필드를 갖는다(데모에서 등록 가능)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vmPlacement } from '../src/vcenter/vmPlacement.js';
import { stripComments } from './_stripComments.js';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

// 인벤토리: 루트(group-d1) → 폴더 'Asia'(group-d2) → 데이터센터 DC-Seoul(datacenter-3) → vmFolder 'vm'(group-v4)
//   → 사용자 폴더 'vm'(group-v5 — 이름이 vm 이다) → 'web'(group-v6)
const folders = new Map([
  ['group-d1', { name: 'Datacenters', parent: undefined }],
  ['group-d2', { name: 'Asia', parent: 'group-d1' }],
  ['group-v4', { name: 'vm', parent: 'datacenter-3' }],
  ['group-v5', { name: 'vm', parent: 'group-v4' }],
  ['group-v6', { name: 'web', parent: 'group-v5' }],
  ['group-v7', { name: 'vm', parent: 'datacenter-8' }],
  ['loop-1', { name: 'a', parent: 'loop-2' }],
  ['loop-2', { name: 'b', parent: 'loop-1' }],
]);
const dcs = new Map([
  ['datacenter-3', { name: 'DC-Seoul', parent: 'group-d2' }],
  ['datacenter-8', { name: 'DC-Root', parent: 'group-d1' }],
]);

test('정확한 위치: 사용자 폴더 이름이 vm 이어도 넣는다 · 폴더 속 데이터센터는 전체 경로', () => {
  assert.deepEqual(vmPlacement('group-v6', folders, dcs), { vcDatacenter: 'Asia/DC-Seoul', folderPath: '/vm/web' });
  assert.deepEqual(vmPlacement('group-v5', folders, dcs), { vcDatacenter: 'Asia/DC-Seoul', folderPath: '/vm' });
});

test('루트 VM 은 / · 루트 데이터센터는 이름만', () => {
  assert.deepEqual(vmPlacement('group-v7', folders, dcs), { vcDatacenter: 'DC-Root', folderPath: '/' });
});

test('따라갈 수 없으면 null(지어내지 않는다): vApp(부모 없음) · 모르는 부모 · 고리', () => {
  const none = { vcDatacenter: null, folderPath: null };
  assert.deepEqual(vmPlacement(undefined, folders, dcs), none);
  assert.deepEqual(vmPlacement('resgroup-99', folders, dcs), none);
  assert.deepEqual(vmPlacement('loop-1', folders, dcs), none);
});

test('soapClient: Datacenter 는 parent 를 받고 VM 레코드에 vmPlacement 를 펼친다', () => {
  const s = stripComments(fs.readFileSync(path.join(SRC, 'vcenter/soapClient.js'), 'utf8'));
  assert.match(s, /\{ type: 'Datacenter', paths: \['name', 'parent'\] \}/);
  assert.match(s, /folder: folderPath\(p\.parent\),\s*\.\.\.vmPlacement\(p\.parent, folderByRef, dcByRef\)/);
});

test('엣지 정제: vcDatacenter·folderPath 는 글자만(객체·수는 null)', async () => {
  const { sanitizeInventoryList } = await import('../src/routes/central.js');
  const dropped = { notObject: 0, otherVcenter: 0, badId: 0, coerced: 0 };
  const out = sanitizeInventoryList([
    { id: 'vc:vm-1', vcenterId: 'vc', name: 'a', vcDatacenter: 'DC', folderPath: '/x' },
    { id: 'vc:vm-2', vcenterId: 'vc', name: 'b', vcDatacenter: { evil: 1 }, folderPath: 5 },
  ], 'vc', 10, dropped);
  assert.equal(out[0].vcDatacenter, 'DC');
  assert.equal(out[0].folderPath, '/x');
  assert.equal(out[1].vcDatacenter, null);
  assert.equal(out[1].folderPath, null);
  assert.ok(dropped.coerced >= 2);
});

test('목업 VM 도 두 필드를 갖는다', () => {
  const s = fs.readFileSync(path.join(SRC, 'mock/generator.js'), 'utf8');
  assert.match(s, /vcDatacenter: `DC-\$\{site\.id\}`/);
  assert.match(s, /folderPath: `\/\$\{VM_FOLDERS\[/);
});

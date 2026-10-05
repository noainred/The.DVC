// v2.703 — 태그·사용자 지정 속성(A15): 파싱·정제 · 못 읽은 vCenter 는 '확인 안 됨' · 필수 카테고리 누락 · 법인 귀속 · 정책 저장.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vmtags-'));
process.env.CONFIG_DIR = TMP;
const { parseCustomFieldDefs, parseCustomValues, buildTagIndex, sanitizeTagInv } = await import('../src/tags/parse.js');
const { analyzeTags, vmTagsOf, tagStateOf, vmRefOf } = await import('../src/tags/analyze.js');
const { loadTagPolicy, saveTagPolicy, _resetTagPolicy, normalizePolicy } = await import('../src/tags/policy.js');
const { refreshTagInv, _resetTagInv } = await import('../src/tags/collect.js');

test('① 사용자 지정 속성 파싱 — 정의·값(빈 값은 싣지 않음)·XML 이스케이프', () => {
  const defs = parseCustomFieldDefs('<CustomFieldDef><key>101</key><name>Owner &amp; Team</name><type>xsd:string</type><managedObjectType>VirtualMachine</managedObjectType></CustomFieldDef><CustomFieldDef><key>x</key><name>bad</name></CustomFieldDef>');
  assert.deepEqual(defs, [{ key: 101, name: 'Owner & Team', type: 'string', mo: 'VirtualMachine' }]);
  const v = parseCustomValues('<CustomFieldStringValue><key>101</key><value xsi:type="xsd:string">kim</value></CustomFieldStringValue><CustomFieldStringValue><key>102</key><value>  </value></CustomFieldStringValue>');
  assert.deepEqual(v, { 101: 'kim' });
  assert.deepEqual(parseCustomValues(null), {});
});

test('② 태그 색인 — 카테고리 인덱스·VM/호스트 연결·중복 제거·모르는 태그 무시', () => {
  const idx = buildTagIndex(
    [{ id: 'c1', name: 'Env', cardinality: 'SINGLE', associable_types: ['VirtualMachine'] }],
    [{ id: 't1', name: 'Prod', category_id: 'c1' }, { id: 't2', name: 'Orphan', category_id: 'zz' }],
    [{ tag_id: 't1', object_ids: [{ type: 'VirtualMachine', id: 'vm-1' }, { type: 'VirtualMachine', id: 'vm-1' }, { type: 'HostSystem', id: 'host-9' }, { type: 'Datastore', id: 'ds-1' }] }, { tag_id: 'nope', object_ids: [{ type: 'VirtualMachine', id: 'vm-2' }] }],
  );
  assert.deepEqual(idx.vmTags, { 'vm-1': [0] });
  assert.deepEqual(idx.hostTags, { 'host-9': [0] });
  assert.equal(idx.tags[1].cat, null, '모르는 카테고리는 null');
});

test('③ 엣지 정제 — 아는 필드만 · 예약어/형식 밖 참조 거부 · 범위 밖 인덱스 제거 · 객체가 아니면 null', () => {
  const r = sanitizeTagInv({
    at: 5, categories: [{ id: 'c', name: 'Env', cardinality: 'X', evil: 1 }], tags: [{ id: 't', name: 'P', cat: 0 }, { id: 't2', name: 'Q', cat: 9 }],
    vmTags: JSON.parse('{"vm-1":[0,5,"x"],"__proto__":[0],"constructor":[0],"bad ref":[0]}'), fields: [{ key: '101', name: 'Owner' }], vmCustom: { 'vm-1': { 101: 'kim', zz: 'x', 102: 5 } },
  });
  assert.equal(r.value.categories[0].cardinality, null); assert.equal(r.value.categories[0].evil, undefined);
  assert.equal(r.value.tags[1].cat, null);
  assert.deepEqual(r.value.vmTags, { 'vm-1': [0] });
  assert.ok(r.dropped >= 3, '예약어 2개 + 형식 밖 1개');
  assert.deepEqual(r.value.vmCustom, { 'vm-1': { 101: 'kim' } });
  assert.equal(sanitizeTagInv('x').value, null);
  assert.equal(sanitizeTagInv({ tags: null, vmTags: { 'vm-1': [0] } }).value.vmTags, null, '태그를 못 읽었으면 연결도 null(빈 객체로 지어내지 않는다)');
  assert.equal(Object.getPrototypeOf(r.value.vmTags), Object.prototype);
});

const INV = {
  at: 1, tagsAt: 1, customAt: 1, categories: [{ id: 'c1', name: 'Environment' }, { id: 'c2', name: 'Corp' }],
  tags: [{ id: 't1', name: 'Prod', cat: 0 }, { id: 't2', name: 'SEOUL', cat: 1 }],
  vmTags: { 'vm-1': [0, 1], 'vm-2': [1] }, fields: [{ key: 101, name: 'Owner' }], vmCustom: { 'vm-1': { 101: 'kim' } },
};
const VCS = [{ id: 'vc1', name: 'VC1', tagInv: INV }, { id: 'vc2', name: 'VC2', tagInv: { at: 1, tags: null, tagsError: 'boom', fields: null } }, { id: 'vc3', name: 'VC3', tagInv: null }];
const VMS = [
  { id: 'vc1:vm-1', vcenterId: 'vc1', name: 'web', powerState: 'POWERED_ON' },
  { id: 'vc1:vm-2', vcenterId: 'vc1', name: 'db', powerState: 'POWERED_ON' },
  { id: 'vc1:vm-3', vcenterId: 'vc1', name: 'tpl', template: true },
  { id: 'vc2:vm-1', vcenterId: 'vc2', name: 'x' },
  { id: 'vc3:vm-1', vcenterId: 'vc3', name: 'y' },
];

test('④ 분석 — 못 읽은 vCenter 의 VM 은 확인 안 됨 · 누락 · 법인 귀속 · 템플릿 제외 · 필수 카테고리 부재 · 속성 채움률', () => {
  const r = analyzeTags(VCS, VMS, { requiredCategories: ['environment', 'Owner-Team'], corpCategory: 'corp' });
  assert.equal(r.coverage.checkedVms, 2); assert.equal(r.coverage.uncheckedVms, 2);
  assert.deepEqual(r.rows.map((x) => [x.vm, x.missing]), [['db', ['environment', 'Owner-Team']], ['web', ['Owner-Team']]]);
  assert.deepEqual(r.missingByCategory, { environment: 1, 'Owner-Team': 2 });
  assert.deepEqual(r.vcenters.find((v) => v.vcenterId === 'vc1').requiredAbsent, ['Owner-Team']);
  assert.equal(r.vcenters.find((v) => v.vcenterId === 'vc2').withMissing, null, '못 읽은 vCenter 는 누락 수를 말하지 않는다');
  assert.deepEqual(r.corp.values, [{ tag: 'SEOUL', vms: 2, vcenters: 1 }]); assert.equal(r.corp.unassigned, 0);
  assert.deepEqual(r.fields, [{ name: 'Owner', filled: 1, checked: 2, vcenters: 1 }]);
  assert.equal(tagStateOf(VCS[1].tagInv), 'error'); assert.equal(tagStateOf(null), 'not-collected');
  assert.equal(tagStateOf({ tagsUnsupported: true, tags: null }), 'unsupported');
  assert.equal(tagStateOf({ tags: [], tagsError: 'x' }), 'stale');
  assert.equal(analyzeTags(VCS, VMS, {}).rows.length, 0, '정책이 없으면 누락 행이 없다');
  assert.equal(vmRefOf('a:b', 'a:b:vm-1'), 'vm-1', 'vCenter id 에 콜론이 있어도 접두를 뗀다');
  assert.deepEqual(vmTagsOf(INV, 'vm-1'), { tags: [{ category: 'Environment', tag: 'Prod' }, { category: 'Corp', tag: 'SEOUL' }], custom: [{ name: 'Owner', value: 'kim' }] });
  assert.deepEqual(vmTagsOf(null, 'vm-1'), { tags: null, custom: null });
});

test('⑤ 정책 — 정규화·중복 제거·제어 문자 거부·rev 충돌·손상 파일 보존', () => {
  _resetTagPolicy();
  assert.deepEqual(loadTagPolicy().requiredCategories, []);
  const n = normalizePolicy({ requiredCategories: [' Env ', 'env', 'a\u0001b', ''], corpCategory: 'Corp' });
  assert.deepEqual(n.policy.requiredCategories, ['Env']); assert.equal(n.invalid.length, 2);
  const bad = saveTagPolicy({ requiredCategories: ['a\u0001b'] }, 'u');
  assert.equal(bad.ok, false);
  const ok = saveTagPolicy({ requiredCategories: ['Env'], corpCategory: 'Corp' }, 'u');
  assert.equal(ok.ok, true);
  assert.equal(saveTagPolicy({ corpCategory: 'X', rev: 'stale' }, 'u').code, 'stale');
  assert.deepEqual(saveTagPolicy({ corpCategory: '' , rev: ok.policy.rev }, 'u').policy.requiredCategories, ['Env'], '보내지 않은 필드는 유지');
  fs.writeFileSync(path.join(TMP, 'tag-policy.json'), '{bad');
  _resetTagPolicy();
  assert.deepEqual(loadTagPolicy().requiredCategories, []);
  assert.ok(fs.readdirSync(TMP).some((f) => f.startsWith('tag-policy.json.corrupt')));
});

test('⑥ 수집 — 주기 안에서는 캐시 · 태그 실패는 직전 값을 지우지 않고 오류를 싣는다 · 꺼져 있으면 읽지 않는다', async () => {
  _resetTagInv();
  let calls = 0;
  const c = {
    sc: { customFieldsManager: 'CustomFieldsManager' },
    retrieveObjectProps: async () => { calls += 1; return [{ props: { field: '<CustomFieldDef><key>101</key><name>Owner</name></CustomFieldDef>' } }]; },
    retrieveManyObjectProps: async (_t, refs) => refs.map((r) => ({ ref: r, props: { customValue: '<x><key>101</key><value>kim</value></x>' } })),
  };
  const vc = { id: 'vc1', host: 'https://127.0.0.1:1', username: 'u', password: 'p', timeoutMs: 1000 };
  const settings = { tagScan: true, tagRefreshMs: 3_600_000 };
  const a = await refreshTagInv(c, vc, ['vm-1'], { now: 1_000, settings, budgetMs: 3000 });
  assert.deepEqual(a.vmCustom, { 'vm-1': { 101: 'kim' } });
  assert.equal(a.tags, null, '태그를 못 읽었으면 null'); assert.ok(a.tagsError);
  const b = await refreshTagInv(c, vc, ['vm-1'], { now: 2_000, settings });
  assert.equal(b, a, '주기 안에서는 다시 읽지 않는다'); assert.equal(calls, 1);
  assert.equal(await refreshTagInv(c, { id: 'vc9' }, [], { settings: { tagScan: false } }), null);
});

/**
 * v2.954(점검 A-2) — 운영 주석 조회(GET /tools/bm-usage/annotations = bmAnnotationsRead)의 비관리자 판본.
 *  · 작성 · 수정 · 삭제한 사람(by · edits[].by · deleted.by)은 가림 토큰(형제 저활용 화면 maskBy 와 같은 maskedIdToken) — 'system' 은 그대로.
 *    예전에는 저활용 검토(auto idle:*) 주석의 by 에 검토자 계정명 원문이 나가, 저활용 화면의 토큰 ↔ 계정명 대응까지 풀렸다.
 *  · 남이 쓴 주석의 본문 주소(IPv4 · 등록부 주소)는 대상 이름과 같은 판정기로 가린다 — 집중 시작 자동 주석(auto focus)의 사유 IPv4 가 그대로 나갔다.
 *  · 본인 주석의 본문은 원문(고칠 수 있는 유일한 주석 — 가린 본문을 고쳐 저장하면 원문이 덮인다) · 관리자는 전부 원문.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { bmAnnotationsRead } = await import('../src/routes/api/bmAnnotations.js');
const { maskedIdToken } = await import('../src/auth/addressMask.js');

const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR;   // 정시 경계로 고정
const ANNOTS = [
  { id: 'a1', at: NOW - 3 * HOUR, kind: 'memo', auto: 'idle:keep', by: 'alice', created: NOW - 3 * HOUR, text: '[저활용 검토] 유지 — db01.corp.local 이관 대기',
    target: { type: 'server', keys: ['k1'], names: ['db01.corp.local'], vcenterIds: ['vcA'] }, edits: [{ at: NOW - 2 * HOUR, by: 'bob', fields: ['text'] }] },
  { id: 'a2', at: NOW - 2 * HOUR, kind: 'work', auto: 'focus', by: 'system', created: NOW - 2 * HOUR, text: '집중 모니터링 시작 — 10.20.30.40 디스크 지연',
    target: { type: 'server', keys: ['k1'], names: ['db01.corp.local'], vcenterIds: ['vcA'] }, links: { focus: 'f1' }, edits: [] },
  { id: 'a3', at: NOW - HOUR, kind: 'memo', by: 'carol', created: NOW - HOUR, text: '내 메모 10.1.1.1 확인',
    target: { type: 'server', keys: ['k1'], names: ['db01.corp.local'], vcenterIds: ['vcA'] }, edits: [] },
  { id: 'a4', at: NOW - HOUR, kind: 'memo', by: 'dave', created: NOW - HOUR, text: '', deleted: { at: NOW, by: 'erin' },
    target: { type: 'server', keys: ['k1'], names: ['db01.corp.local'], vcenterIds: ['vcA'] }, edits: [] },
];
const deps = {
  store: async () => ({ listAnnotations: () => ANNOTS.map((a) => ({ ...a })), ANNOT_KINDS: ['memo', 'work'], TEXT_MAX: 2000 }),
  currentTargets: async () => ({ targets: [] }),
  bmAddressHosts: async () => ['db01.corp.local'],
  listEdgeBmUsage: async () => [],
  audit: () => {},
};
const snap = { vcenters: [{ id: 'vcA', name: 'KR-SEL' }] };
const read = (user) => bmAnnotationsRead({ user, query: {} }, snap, deps);
const byId = (r) => Object.fromEntries(r.annotations.map((a) => [a.id, a]));

test('A-2: 비관리자 — 작성 · 수정 · 삭제한 사람은 가림 토큰(system 은 그대로)', async () => {
  const r = await read({ username: 'carol', role: 'operator', scope: null });
  assert.equal(r.ok, true);
  const m = byId(r);
  assert.equal(m.a1.by, maskedIdToken('alice'), `저활용 검토자 계정명이 원문으로 나갔다: ${m.a1.by}`);
  assert.equal(m.a1.edits[0].by, maskedIdToken('bob'));
  assert.equal(m.a2.by, 'system');
  assert.equal(m.a4.deleted.by, maskedIdToken('erin'));
  const s = JSON.stringify(r);
  for (const nm of ['alice', 'bob', 'erin', 'dave']) assert.ok(!s.includes(`"${nm}"`), `${nm} 원문`);
});

test('A-2: 비관리자 — 남의 주석 본문 주소(IPv4 · 등록부 주소)는 가리고 본인 주석은 원문', async () => {
  const r = await read({ username: 'carol', role: 'viewer', scope: null });
  const m = byId(r);
  assert.ok(!m.a2.text.includes('10.20.30.40'), `집중 사유 IPv4 가 그대로 나갔다: ${m.a2.text}`);
  assert.ok(m.a2.text.includes(maskedIdToken('10.20.30.40')));
  assert.ok(m.a2.text.startsWith('집중 모니터링 시작'), '주소 아닌 낱말은 그대로');
  assert.ok(!m.a1.text.includes('db01.corp.local'), `등록부 주소가 본문에 그대로: ${m.a1.text}`);
  assert.equal(m.a3.text, '내 메모 10.1.1.1 확인', '본인 주석 본문은 원문');
  assert.equal(m.a3.canEdit, true);
  assert.equal(m.a1.canEdit, false);
  assert.equal(r.addressHidden, true);
});

test('A-2: 관리자 — 전부 원문', async () => {
  const r = await read({ username: 'root', role: 'admin', scope: null });
  const m = byId(r);
  assert.equal(m.a1.by, 'alice');
  assert.equal(m.a1.edits[0].by, 'bob');
  assert.equal(m.a4.deleted.by, 'erin');
  assert.equal(m.a2.text, '집중 모니터링 시작 — 10.20.30.40 디스크 지연');
  assert.equal(m.a1.text, '[저활용 검토] 유지 — db01.corp.local 이관 대기');
});

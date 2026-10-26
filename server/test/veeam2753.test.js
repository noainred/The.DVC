/**
 * v2.753 — Veeam 연동 없이 vCenter 스냅샷으로만 Veeam 백업을 본다(사용자 지시: 메모는 참고하지 말 것).
 * 수집: VM 'snapshot' 트리에서 'VEEAM BACKUP TEMPORARY SNAPSHOT'(Veeam KB1790)의 개수·생성 시각 → veeamSnaps·veeamSnapTs.
 * 이름 목록(5개 상한) 밖에 있어도 찾는다 · 없으면 필드를 싣지 않는다(예전 모양 그대로).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { snapshotInfo, VEEAM_SNAP_NAME } = await import('../src/vcenter/soapParse.js');

const node = (name, t, child = '') => `<VirtualMachineSnapshotTree><snapshot type="VirtualMachineSnapshot">snapshot-${name.length}</snapshot><vm type="VirtualMachine">vm-1</vm>`
  + `<name>${name}</name><description></description><id>1</id><createTime>${t}</createTime><state>poweredOn</state><quiesced>false</quiesced>${child ? `<childSnapshotList>${child}</childSnapshotList>` : ''}</VirtualMachineSnapshotTree>`;
const wrap = (tree) => `<currentSnapshot type="VirtualMachineSnapshot">snapshot-9</currentSnapshot><rootSnapshotList>${tree}</rootSnapshotList>`;

test('Veeam 임시 스냅샷의 생성 시각은 그 노드의 createTime(부모·자식 시각과 섞지 않는다)', () => {
  const r = snapshotInfo(wrap(node('pre-patch', '2026-09-01T00:00:00Z', node(VEEAM_SNAP_NAME, '2026-10-22T01:05:00Z', node('after', '2026-10-22T02:00:00Z')))), '');
  assert.equal(r.veeamSnaps, 1);
  assert.equal(r.veeamSnapTs, Date.parse('2026-10-22T01:05:00Z'));
  assert.equal(r.snapshotOldestTs, Date.parse('2026-09-01T00:00:00Z'), '기존 필드는 그대로');
});

test('이름 목록(5개 상한) 뒤에 있어도 찾고 · 대소문자·XML 이스케이프를 가리지 않는다 · 여러 개면 가장 이른 시각', () => {
  let tree = node(VEEAM_SNAP_NAME.toLowerCase(), '2026-10-21T03:00:00Z');
  for (let i = 0; i < 6; i++) tree = node(`s${i}`, `2026-10-0${i + 1}T00:00:00Z`, tree);
  const r = snapshotInfo(wrap(node(VEEAM_SNAP_NAME, '2026-10-22T03:00:00Z', tree)), '');
  assert.equal(r.snapshotNames.length, 5, '이름 목록 상한은 그대로');
  assert.equal(r.veeamSnaps, 2);
  assert.equal(r.veeamSnapTs, Date.parse('2026-10-21T03:00:00Z'));
});

test('Veeam 스냅샷이 없으면 필드를 싣지 않는다 · 비슷한 이름은 아니다 · 시각을 못 읽으면 null', () => {
  const none = snapshotInfo(wrap(node('VEEAM BACKUP TEMPORARY SNAPSHOT (old)', '2026-10-22T01:00:00Z')), '');
  assert.equal('veeamSnaps' in none, false);
  assert.equal('veeamSnaps' in snapshotInfo('', ''), false);
  const bad = snapshotInfo(wrap(node(VEEAM_SNAP_NAME, 'not-a-date')), '');
  assert.equal(bad.veeamSnaps, 1); assert.equal(bad.veeamSnapTs, null);
});

test('서버·웹의 이름 상수가 같다(판정 코어 하나 — 대조)', async () => {
  const fs = await import('node:fs');
  const web = fs.readFileSync(new URL('../../web/src/views/veeamBadge.js', import.meta.url), 'utf8');
  assert.match(web, new RegExp(`VEEAM_SNAP_NAME = '${VEEAM_SNAP_NAME}'`));
});

test('메모 휴리스틱(veeamed)은 화면에서 없어졌다 — 연동 없는 Veeam 표시는 스냅샷만', async () => {
  const fs = await import('node:fs');
  const { stripComments } = await import('./_stripComments.js');
  const src = stripComments(fs.readFileSync(new URL('../../web/src/views/VCenterDetail.jsx', import.meta.url), 'utf8'));
  assert.doesNotMatch(src, /veeamed/);
  assert.doesNotMatch(src, /\/veeam\/i\.test\(vm\.notes/);
});

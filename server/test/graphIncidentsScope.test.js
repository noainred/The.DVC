import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 확정 버그 회귀 방지(2026-08-30) — 구성도 그래프의 NSX 매니저 누수 + 인시던트 scope 누락.
//
// (1) buildGraph 의 NSX 노드는 scope 로 좁힌 스냅샷이 아니라 listNsxRegistry()(전 등록 매니저)
//     에서 직접 만들어졌고, 필터가 `vcenterId` **쿼리 파라미터**뿐이었다. 범위 제한 계정이
//     파라미터 없이 호출하면 전 사이트 NSX 매니저(이름·host·버전·상태·region)가 노드로 나갔다
//     — 같은 계정이 /api/nsx 에서는 차단되는 정보(v2.320 NSX scope 불변조건 우회).
// (2) /insights/incidents 는 insights 라우터에서 유일하게 scope 처리가 없어, 범위 제한 계정이
//     전 사이트 알람 상세와 vCenter 수집 실패(이름·오류)를 볼 수 있었다.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-scope-'));
process.env.CONFIG_DIR = tmp;

const nsxReg = await import('../src/nsx/registry.js');
const { buildGraph } = await import('../src/insights/graph.js');
const { getIncidents } = await import('../src/insights/incidents.js');
const { store } = await import('../src/store.js');

// NSX 매니저 3대: vc-a 귀속 / vc-b(범위 밖) 귀속 / 무귀속.
for (const m of [
  { id: 'nsx-a', name: 'nsx-a', host: 'https://10.1.0.10', username: 'u', password: 'p', vcenterId: 'vc-a' },
  { id: 'nsx-b', name: 'nsx-b', host: 'https://10.2.0.10', username: 'u', password: 'p', vcenterId: 'vc-b' },
  { id: 'nsx-orphan', name: 'nsx-orphan', host: 'https://10.3.0.10', username: 'u', password: 'p' },
]) {
  const r = nsxReg.addManager(m);
  assert.ok(r.ok, `테스트 셋업 실패(${m.id}): ${r.reason}`);
}

// 범위 계정이 보는 스냅샷(scopeSlice 결과 형태) — vc-a 만.
const scopedSnap = {
  vcenters: [{ id: 'vc-a', name: 'Seoul', location: { region: 'KR' } }],
  hosts: [{ id: 'h1', name: 'esxi-a1', vcenterId: 'vc-a' }],
  vms: [],
};

const nsxLabels = (g) => g.nodes.filter((n) => n.type === 'nsx').map((n) => n.label);

test('그래프: 전체 범위 계정(allowedVcIds=null)은 종전대로 전 매니저 표시 — 동작 보존', () => {
  const labels = nsxLabels(buildGraph(scopedSnap, {}));
  assert.equal(labels.length, 3, `전체 범위에서는 3대 모두: ${labels}`);
});

test('그래프: 범위 계정은 허용 vCenter 귀속 매니저만 — 범위 밖·무귀속 매니저 숨김', () => {
  const labels = nsxLabels(buildGraph(scopedSnap, { allowedVcIds: new Set(['vc-a']) }));
  assert.ok(labels.some((l) => l.includes('nsx-a')), `허용 매니저는 표시: ${labels}`);
  assert.ok(!labels.some((l) => l.includes('nsx-b')), '범위 밖 매니저 노출 금지');
  assert.ok(!labels.some((l) => l.includes('nsx-orphan')), '무귀속 매니저는 범위 계정에 노출 금지');
  // host(내부 주소)가 라벨로 새지 않는지도 확인 — name 이 없으면 host 가 라벨이 된다.
  assert.ok(!labels.some((l) => l.includes('10.2.0.10') || l.includes('10.3.0.10')));
});

test('그래프: scope 는 요청 필터보다 먼저 — 범위 밖 vcenterId 를 지정해도 새지 않는다', () => {
  const labels = nsxLabels(buildGraph(scopedSnap, { vcenterId: 'vc-b', allowedVcIds: new Set(['vc-a']) }));
  assert.deepEqual(labels, [], '범위 밖 vCenter 를 명시해도 매니저가 나오면 우회 가능');
});

test('그래프: region 으로만 귀속된 매니저도 /api/nsx 와 같은 규칙으로 보인다(판정 이중구현 방지)', () => {
  // 재감사 지적: 그래프가 vcenterId 만 보면 region 으로 귀속된 매니저가 /api/nsx 에서는 보이는데
  // 구성도에서만 사라진다(규칙 이중 구현). 판정은 nsx/scope.js managerInScope 하나로 공유해야 한다.
  const r = nsxReg.addManager({
    id: 'nsx-region', name: 'nsx-region', host: 'https://10.4.0.10',
    username: 'u', password: 'p', location: { region: 'KR' },   // vcenterId 없음, region 만
  });
  assert.ok(r.ok, `테스트 셋업 실패: ${r.reason}`);

  const labels = nsxLabels(buildGraph(scopedSnap, { allowedVcIds: new Set(['vc-a']) }));
  assert.ok(labels.some((l) => l.includes('nsx-region')),
    `허용 vCenter(vc-a)의 리전(KR) 매니저는 보여야 함: ${labels}`);
  assert.ok(!labels.some((l) => l.includes('nsx-orphan')), '무귀속 매니저는 계속 숨김');
});

test('인시던트: 범위 계정에는 허용 vCenter 의 수집 실패만 노출', () => {
  store.setSnapshot?.({}); // 없으면 무시 — 아래에서 직접 주입
  const snap = store.get();
  snap.vcenters = [
    { id: 'vc-a', name: 'Seoul', status: 'unreachable', error: 'A 연결 불가', receivedAt: Date.now() },
    { id: 'vc-b', name: 'Warsaw', status: 'unreachable', error: 'B 연결 불가', receivedAt: Date.now() },
  ];

  const scoped = getIncidents({ allowed: new Set(['vc-a']) });
  const titles = scoped.timeline.map((e) => e.title).join(' | ');
  assert.ok(titles.includes('Seoul'), `허용 vCenter 는 표시: ${titles}`);
  assert.ok(!titles.includes('Warsaw'), '범위 밖 vCenter 이름·오류 노출 금지');

  const full = getIncidents({});
  const fullTitles = full.timeline.map((e) => e.title).join(' | ');
  assert.ok(fullTitles.includes('Seoul') && fullTitles.includes('Warsaw'), '전체 범위는 종전대로 모두');
});

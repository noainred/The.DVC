// v2.630 감사 그룹 B — 회귀 고정.
//   R2630-01 iDRAC 범위 절단(idracCore.idracInScope)이 법인 귀속을 3단(명시·매핑·서비스태그)으로 줄인 사본이라, 개요·법인별
//     사용량이 'DataCenter 의 vCenter 가 하나뿐' 규칙으로 귀속하는 물리 서버를 범위 계정에서 통째로 뺐다 →
//     idrac/corpAttribution.js 색인(vcIndexFromSnap)을 이어 본다. 모호(DataCenter 에 vCenter 2개)면 여전히 귀속 없음.
//   R2630-03 bmUsage.scopeBmStatus 가 last.error·sourceErrors 를 버려 범위 계정 화면이 실패를 '기다리면 된다' 로 말했다 →
//     사실(있음·개수)은 남기고 원문만 가림. lastPrune 삭제 행 수(함대 수치)는 null.
//   A2-04 SAN 에러 기준선·월간 점검 증분 키를 rates.js rateKey(slot/port)로 — REST 디렉터 '1/10'·'11/0' 이 index 110 으로 합쳐졌다.
//   A2-05 IPAM 예약 만료일(날짜만)이 UTC 자정으로 저장돼 KST 09:00 에 만료 → 포탈 오프셋 기준 그 날 끝(다음 날 00:00).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2630b-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.IDRAC_ENABLED = 'false';
process.env.PORTAL_TZ_OFFSET_MIN = '540';

// DC-A → vc-us-east 하나뿐(귀속 가능) · DC-B → vc-eu-west · DC-M → 두 vCenter(모호 — 귀속 없음).
fs.writeFileSync(path.join(tmp, 'datacenters.json'), JSON.stringify({
  datacenters: [{ id: 'DC-A', name: 'A' }, { id: 'DC-B', name: 'B' }, { id: 'DC-M', name: 'M' }],
  assign: { 'vc-us-east': 'DC-A', 'vc-eu-west': 'DC-B', 'vc-ap-seoul': 'DC-M', 'vc-ap-tokyo': 'DC-M' },
}));
fs.writeFileSync(path.join(tmp, 'idrac.json'), JSON.stringify({ servers: [
  { id: 'p1', name: 'phys-dca-01', host: 'https://10.61.0.1', username: 'u', password: 'x', datacenterId: 'DC-A', serviceTag: 'ZZDCA01' },
  { id: 'p2', name: 'phys-dcb-01', host: 'https://10.62.0.1', username: 'u', password: 'x', datacenterId: 'DC-B', serviceTag: 'ZZDCB01' },
  { id: 'p3', name: 'phys-dcm-01', host: 'https://10.63.0.1', username: 'u', password: 'x', datacenterId: 'DC-M', serviceTag: 'ZZDCM01' },
] }), { mode: 0o600 });

let core; let snapVcIds;
const reqOf = (vcs) => ({ user: { username: 'sadm', role: 'admin', scope: { vcenters: vcs } } });
before(async () => {
  const { store } = await import('../src/store.js');
  await store.refresh().catch(() => {});
  snapVcIds = new Set((store.get()?.vcenters || []).map((v) => String(v.id)));
  core = await import('../src/routes/admin/idracCore.js');
  core._resetIdracCorpIndex?.();
});

test('R2630-01: DataCenter 단일 vCenter 로만 귀속되는 물리 서버도 그 범위 계정에 보인다(corpAttribution 한 벌)', async (t) => {
  if (!snapVcIds.has('vc-us-east') || !snapVcIds.has('vc-eu-west')) return t.skip('목 스냅샷에 vc-us-east/vc-eu-west 가 없다');
  const { loadRegistry } = await import('../src/idrac/registry.js');
  const reg = loadRegistry();
  const scA = core.idracScopeOf(reqOf(['vc-us-east']));
  assert.ok(scA && scA.index, '범위 계정은 귀속 색인을 가진다');
  const byId = (id) => reg.find((s) => s.id === id);
  assert.equal(core.idracInScope(scA, byId('p1')), true, 'DC-A 단일 vCenter 로 귀속 → 범위 안');
  assert.equal(core.idracInScope(scA, byId('p2')), false, 'DC-B 서버는 범위 밖');
  assert.equal(core.idracInScope(scA, byId('p3')), false, '모호한 DataCenter 는 귀속 없음 → 노출하지 않는다');
  const r = core.scopeIdracServers(reqOf(['vc-us-east']), reg);
  assert.deepEqual(r.servers.map((s) => s.id), ['p1']);
  assert.equal(r.omitted, 2);
  // 전산실 온도 그룹 — DC-A 그룹 전원이 범위 안이면 허용
  const g = core.roomTempGroupsAllowed(reqOf(['vc-us-east']), ['DC-A', 'DC-B']);
  assert.deepEqual(g.allowed, ['DC-A']);
  // 전체 범위는 판정 자체가 없다
  assert.equal(core.idracScopeOf({ user: { username: 'full', role: 'admin', scope: null } }), null);
  // 명시 vcenterId 는 여전히 먼저다(색인이 덮지 않는다)
  assert.equal(core.idracServerVcOf({ id: 'p1', vcenterId: 'vc-eu-west' }, new Map(), scA.index), 'vc-eu-west');
});

test('R2630-03: scopeBmStatus — 오류 사실·개수는 남기고 원문·함대 수치(lastPrune 행 수)는 가린다', async () => {
  const { scopeBmStatus, FULL_SCOPE_TEXT } = await import('../src/routes/api/bmUsage.js');
  const NOW = 1_790_000_000_000;
  const st = {
    enabled: true,
    last: { at: NOW, ms: 10, trigger: 'timer', servers: null, okCount: 0, failCount: 0, inserted: 0, error: '대상 분류 실패 — 등록부 /x/y 손상',
      sourceErrors: [{ source: 'classify', error: '원문 A' }, { source: 'idrac-registry', error: '원문 B' }], dbOk: false, dbError: 'SQLITE /x' },
    lastPrune: { at: NOW, ok: true, rawDeleted: 12345, dailyDeleted: 67, done: true },
  };
  const s = scopeBmStatus(st, new Set(['vc-a']));
  assert.ok(s.last.error, '실패 사실은 남아야 emptyDiag 가 failed 로 판정한다');
  assert.equal(s.last.error, FULL_SCOPE_TEXT);
  assert.ok(!JSON.stringify(s).includes('원문 A') && !JSON.stringify(s).includes('SQLITE'), '원문 미노출');
  assert.ok(!JSON.stringify(s).includes('/x/y'));
  assert.deepEqual(s.last.sourceErrors, [{ source: 'classify', error: FULL_SCOPE_TEXT }, { source: 'idrac-registry', error: FULL_SCOPE_TEXT }]);
  assert.equal(s.last.dbOk, false);
  assert.equal(s.lastPrune.rawDeleted, null);
  assert.equal(s.lastPrune.dailyDeleted, null);
  assert.equal(s.lastPrune.ok, true);
  assert.equal(s.last.servers, null);
  // 오류가 없으면 필드를 만들지 않는다(없는 실패를 지어내지 않는다)
  const ok = scopeBmStatus({ last: { at: NOW, servers: 3 } }, new Set(['vc-a']));
  assert.equal('error' in ok.last, false);
  assert.equal('sourceErrors' in ok.last, false);
  assert.equal(scopeBmStatus(st, null), st, '전체 범위는 원본');
});

test('A2-04: REST 디렉터(default-index 없음) — 기준선이 slot/port 로 갈리고 증분이 제 포트 것이다', async () => {
  const { baselineFromSnapshot } = await import('../src/sanswitch/errBaseline.js');
  const { checkPorts } = await import('../src/sanswitch/healthCheck.js');
  const mkPorts = (crcA, crcB) => [
    { index: 110, slot: 1, slotPort: '1/10', errCrc: crcA, state: 'online' },
    { index: 110, slot: 11, slotPort: '11/0', errCrc: crcB, state: 'online' },
  ];
  const b = baselineFromSnapshot({ collectedAt: 1, ports: { list: mkPorts(5, 900) } });
  assert.deepEqual(Object.keys(b.ports).sort(), ['s:1/10', 's:11/0']);
  assert.equal(b.ports['s:1/10'].errCrc, 5);
  assert.equal(b.portCount, 2);
  const snap = { sections: { ports: 'ok', counters: 'ok' }, ports: { list: mkPorts(8, 905) } };
  const r = checkPorts(snap, { baseline: b });
  const row = (sp) => r.rows.find((x) => x.slotPort === sp);
  assert.equal(row('1/10').errDelta.errCrc, 3);
  assert.equal(row('11/0').errDelta.errCrc, 5);
  // 옛 기준선(index 키) — 두 포트가 같은 index 로 겹치면 어느 포트 것인지 모른다 → 증분 보류
  const old = { at: 1, ports: { 110: { errCrc: 900 } } };
  const r2 = checkPorts(snap, { baseline: old });
  assert.equal(r2.rows[0].errDelta.errCrc, undefined);
  assert.equal(r2.rows[1].errDelta.errCrc, undefined);
  // 옛 기준선이라도 index 가 겹치지 않으면 읽는다(호환)
  const snap3 = { sections: { ports: 'ok', counters: 'ok' }, ports: { list: [{ index: 42, slot: 1, slotPort: '1/10', errCrc: 50, state: 'online' }] } };
  const r3 = checkPorts(snap3, { baseline: { at: 1, ports: { 42: { errCrc: 40 } } } });
  assert.equal(r3.rows[0].errDelta.errCrc, 10);
  // slot 없는 스위치는 예전 키 그대로
  const b4 = baselineFromSnapshot({ collectedAt: 1, ports: { list: [{ index: 3, errCrc: 1 }] } });
  assert.deepEqual(Object.keys(b4.ports), ['3']);
});

test('A2-05: 예약 만료일(날짜만)은 포탈 오프셋 기준 그 날 끝까지 — 화면 표시(앞 10자)는 고른 날짜 그대로', async () => {
  const { reservedUntilIso } = await import('../src/ipam/overrides.js');
  const iso = reservedUntilIso('2026-10-01', 540);
  assert.equal(iso, '2026-10-01T15:00:00.000Z', 'KST 10/2 00:00');
  assert.equal(iso.slice(0, 10), '2026-10-01');
  // 10/1 KST 23:59 에는 아직 예약, 10/2 KST 00:00 부터 만료
  const due = Date.parse(iso);
  assert.ok(Date.parse('2026-10-01T23:59:00+09:00') < due);
  assert.ok(!(Date.parse('2026-10-02T00:00:00+09:00') < due));
  assert.equal(reservedUntilIso('2026-02-30', 540), null, '없는 날짜');
  assert.equal(reservedUntilIso('2026-10-01T03:00:00Z', 540), '2026-10-01T03:00:00.000Z', '시각이 있으면 그대로');
  assert.equal(reservedUntilIso('xx', 540), null);
});

/**
 * v2.752 — 실서버(VBR 12.3) 화면에서 나온 두 문제의 회귀.
 *  ① /api/v1/restorePoints 가 판 1.1-rev0 에서 'Unsupported RESTAPI version …(지원 목록)' 400 → 그 경로만 지원 목록의 가장 높은 판으로 다시 읽는다.
 *     1.2 를 지원하지 않는 서버는 /api/v1/objectRestorePoints 로 읽는다.
 *  ② 에이전트 작업만 있는 서버 — /api/v1/jobs 가 비고, 백업 객체·복원 지점이 에이전트 플랫폼이다 → 컴퓨터 이름으로 VM 에 맞춘다(하나뿐일 때만).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const P = await import('../src/veeam/parse.js');
const C = await import('../src/veeam/client.js');

const VC = 'apac:vc01';
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const UNSUPPORTED = { errorCode: 'BadRequest', message: 'Unsupported RESTAPI version. The following versions are supported: v1.0-rev1, v1.0-rev2, v1.1-rev0, v1.1-rev1, v1.1-rev2, v1.2-rev0' };

test('higherVersion — 거절문의 지원 목록에서 지금보다 높은 판 중 가장 높은 것 · 거절문이 아니면 null', () => {
  const t = `HTTP 400 — ${UNSUPPORTED.message}`;
  assert.equal(C.higherVersion(t, '1.1-rev0'), '1.2-rev0');
  assert.equal(C.higherVersion(t, '1.2-rev0'), null, '이미 가장 높으면 올리지 않는다');
  assert.equal(C.higherVersion('HTTP 400 — Bad filter v1.3-rev0', '1.1-rev0'), null, '판 거절문이 아니면 목록처럼 보여도 올리지 않는다');
  assert.equal(C.higherVersion(`${UNSUPPORTED.message}, v1.10-rev0`, '1.2-rev0'), '1.10-rev0', '숫자로 비교한다(문자열 비교 아님)');
});

function makeServer({ supportsRestorePoints }) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url); const ver = init.headers['x-api-version'];
    calls.push({ path: u.pathname, ver });
    if (u.pathname === '/api/oauth2/token') return json({ access_token: 'TKN' });
    if (u.pathname === '/api/oauth2/logout') return json({});
    if (u.pathname === '/api/v1/jobs') return json({ data: [], pagination: { total: 0 } }); // 에이전트 작업은 이 목록에 없다
    if (u.pathname === '/api/v1/backupObjects') return json({ data: [
      { id: 'o1', name: 'web01.corp.local', type: 'Computer', platformName: 'WindowsPhysical', restorePointsCount: 7 },
      { id: 'o2', name: 'DUP', type: 'Computer', platformName: 'LinuxPhysical', restorePointsCount: 2 },
      { id: 'o3', name: 'hv-vm', type: 'VM', platformName: 'HyperV', restorePointsCount: 4 },
    ] });
    if (u.pathname === '/api/v1/restorePoints') {
      if (supportsRestorePoints && ver === '1.2-rev0') return json({ data: [{ id: 'rp1', name: 'web01.corp.local', platformName: 'WindowsPhysical', creationTime: '2026-10-22T01:10:00Z', backupId: 'bk1' }] });
      return json(supportsRestorePoints ? UNSUPPORTED : { message: 'Not found' }, supportsRestorePoints ? 400 : 404);
    }
    if (u.pathname === '/api/v1/objectRestorePoints') return json({ data: [{ id: 'rp9', name: 'web01.corp.local', platformName: 'WindowsPhysical', creationTime: '2026-10-21T01:10:00Z' }] });
    if (u.pathname === '/api/v1/sessions') return json({ data: [] });
    if (u.pathname === '/api/v1/backups') return json({ data: [] });
    return json({}, 404);
  };
  return { calls, fetchImpl };
}

test('① 판 거절 → 그 경로만 지원 판으로 다시 읽는다(다른 경로는 등록한 판 그대로) · 사실을 notes 로 말한다', async () => {
  const { calls, fetchImpl } = makeServer({ supportsRestorePoints: true });
  const r = await C.collectVeeamServer({ id: 'v', name: 'OC', host: 'vbr.corp.local', port: 9419, username: 'u', password: 'p', apiVersion: '1.1-rev0' }, { fetchImpl });
  assert.equal(r.ok, true);
  const rp = calls.filter((c) => c.path === '/api/v1/restorePoints').map((c) => c.ver);
  assert.deepEqual(rp, ['1.1-rev0', '1.2-rev0'], '한 번 거절된 뒤 올린 판으로 한 번');
  assert.ok(calls.filter((c) => c.path !== '/api/v1/restorePoints').every((c) => c.ver === '1.1-rev0'), '다른 경로는 올리지 않는다');
  assert.ok(!calls.some((c) => c.path === '/api/v1/objectRestorePoints'), '올린 판으로 읽혔으면 대체 경로는 부르지 않는다');
  assert.ok(r.notes.some((n) => /restorePoints 는 이 서버가 판 1\.1-rev0 으로는 주지 않아 지원 판 1\.2-rev0/.test(n)), r.notes.join('\n'));
  assert.ok(!r.notes.some((n) => /복원 지점을\(를\) 읽지 못했습니다/.test(n)));
  const web = r.vms.find((v) => v.n === 'web01.corp.local');
  assert.equal(web.ag, 1); assert.equal(web.rn, 1); assert.equal(web.rp, 7);
});

test('① 1.2 를 지원하지 않는 서버(404) → objectRestorePoints 로 읽는다', async () => {
  const { calls, fetchImpl } = makeServer({ supportsRestorePoints: false });
  const r = await C.collectVeeamServer({ id: 'v', name: 'OC', host: 'vbr.corp.local', port: 9419, username: 'u', password: 'p', apiVersion: '1.1-rev0' }, { fetchImpl });
  assert.ok(calls.some((c) => c.path === '/api/v1/objectRestorePoints' && c.ver === '1.1-rev0'));
  assert.equal(r.vms.find((v) => v.n === 'web01.corp.local').rn, 1);
  assert.ok(!r.notes.some((n) => /복원 지점을\(를\) 읽지 못했습니다/.test(n)));
});

test('② 에이전트 백업 — 작업 0개 안내 · 하이퍼바이저(Hyper-V)는 건너뛰고 개수를 말한다 · 이름(또는 첫 마디)이 하나뿐인 VM 에만', () => {
  const r = P.buildServerResult({
    jobs: { data: [] },
    backupObjects: { data: [
      { name: 'web01.corp.local', platformName: 'WindowsPhysical', restorePointsCount: 7 },
      { name: 'DUP', platformName: 'LinuxPhysical', restorePointsCount: 2 },
      { name: 'web02', platformName: 'LinuxPhysical', restorePointsCount: 0 },
      { name: 'hv-vm', platformName: 'HyperV', restorePointsCount: 4 },
      { name: 'web01', platformName: 'VMware', objectId: 'vm-777', path: 'vc99.corp.local\\DC\\web01', restorePointsCount: 1 },
    ] },
  });
  assert.ok(r.notes.some((n) => /작업 목록\(\/api\/v1\/jobs\)이 비어 있습니다 — Veeam REST 는 에이전트 작업을/.test(n)));
  assert.ok(r.notes.some((n) => /HyperV 1개/.test(n)));
  assert.equal(r.counts.agentObjects, 3);
  const ag = r.vms.filter((v) => v.ag === 1).map((v) => v.n).sort();
  assert.deepEqual(ag, ['DUP', 'web01.corp.local', 'web02'], 'VMware 의 같은 이름(web01)과 합치지 않는다');
  const vms = [
    { id: `${VC}:vm-1`, name: 'web01' }, // 에이전트 이름은 FQDN — 첫 마디로 맞는다
    { id: `${VC}:vm-2`, name: 'dup' }, { id: `${VC}:vm-3`, name: 'DUP' }, // 동명 둘 — 고르지 않는다
    { id: `${VC}:vm-4`, name: 'web02' },
  ];
  const m = P.matchToVcenter({ id: VC, host: 'vc01.corp.local' }, vms, [{ server: { id: 's', name: 'OC' }, result: r }]);
  assert.equal(m.byVm[`${VC}:vm-1`].ag, 1); assert.equal(m.byVm[`${VC}:vm-1`].rp, 7);
  assert.equal(m.byVm[`${VC}:vm-2`], undefined); assert.equal(m.byVm[`${VC}:vm-3`], undefined);
  assert.equal(m.byVm[`${VC}:vm-4`], undefined, '복원 지점 0개 · 작업 없음은 근거가 없다(배지 없음)');
  assert.equal(m.ambiguous, 1);
  assert.equal(m.otherVcenter, 1, 'vc99 의 VMware 항목은 다른 vCenter');
});

test('② 정제 — 엣지가 보낸 ag 표지는 moref 가 없을 때만 믿는다(vCenter 도 지운다)', () => {
  const r = P.sanitizeServerResult({ ok: true, ts: Date.now(), jobs: [], vms: [
    { n: 'a', m: '', h: 'vc01', j: [], rp: 3, ag: 1 },
    { n: 'b', m: 'vm-5', h: 'vc01', j: [], rp: 3, ag: 1 },
    { n: 'c', m: '', h: '', j: [], rp: 3, ag: 'yes' },
  ], counts: { agentObjects: 2 } });
  assert.equal(r.vms[0].ag, 1); assert.equal(r.vms[0].h, '');
  assert.equal(r.vms[1].ag, undefined); assert.equal(r.vms[2].ag, undefined);
  assert.equal(r.counts.agentObjects, 2);
});

test('플랫폼 판정 — 에이전트 이름만 · 하이퍼바이저는 아니다', () => {
  for (const p of ['WindowsPhysical', 'LinuxPhysical', 'Windows', 'Linux', 'MacPhysical', 'UnixPhysical']) assert.equal(P.isAgentPlatform(p), true, p);
  for (const p of ['VMware', 'HyperV', 'Hyper-V', 'vCloud', 'CloudDirector', 'Nutanix', '', null]) assert.equal(P.isAgentPlatform(p), false, String(p));
});

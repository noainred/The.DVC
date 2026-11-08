/**
 * 다음 점검 ①(2026-11-08 — 8b 반증 F9 의 ‘남은 것’) — 성능 상세 대상 = **(법인, 키) 쌍** · 저장 단계 키 충돌.
 *   기준판(b533c396)에서 재현한 결함: resolvePerfTarget 이 vcenterId 없이 **같은 키의 첫 대상**을 골랐다(bmPerfView · bmTrendView · /history 는 같은 해석을 따로 두었다).
 *     ⓐ 같은 키가 두 법인에 있으면 엉뚱한 서버의 상세 · 추이 · 로그 · Top-N · 주석 · 정비 창 · 집중 대상이 열린다
 *     ⓑ 첫 대상이 범위 밖이면 범위 안의 같은 키 서버가 404(범위 계정이 자기 서버를 못 본다)
 *     ⓒ 엣지 보관분 탐색도 첫 일치에서 멈춘다(엣지 B 가 먼저면 엣지 C 의 같은 키 서버는 C 범위 계정에 404)
 *     ⓓ 같은 노드 안의 같은 키 두 서버는 저장 표((agent, key) 기본키) · 폴러 인메모리 맵이 한 키를 같이 써 값이 섞인다
 *   ① 실제 api 라우터 — 같은 키 세 법인(이 노드 A · 엣지 보관분 B · C — 섞어서) × 관리자 · 범위 관리자(A) · 범위 운영자(B · C · AB)
 *   ② ambiguous 응답 모양 · 범위 밖 법인이 어디에도 실리지 않는다(존재 오라클) · 범위 밖 vcenterId 는 없는 키와 같은 404
 *   ③ 쓰기 — 주석 · 검토 · 정비 창 · 집중 시작 · 포트 매핑 · 용도 태그가 고른 법인 서버에만
 *   ④ 저장 단계 — 같은 노드 같은 키는 둘 다 수집하지 않는다(key-conflict · 실제 currentTargets) · 기본키 (agent, key) 가 섞임을 만든다는 사실(실제 DB)
 *   ⑤ 소스 스윕 — 라우트의 대상 해석은 resolvePerfTarget 하나 · 호출마다 vcenterId 를 주고 perfTargetFail 로 응답 모양을 정한다
 *   ⑥ 비용 — 엣지 28 × 대상 300 을 다 훑어도 요청 하나가 짧다(가림 토큰 포함)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripComments } from './_stripComments.js';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bmkeypair-'));
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = 'live';
process.env.SETTINGS_OWNERS = 'own';
fs.writeFileSync(path.join(DIR, 'permissions.json'), JSON.stringify({ schemaVersion: 2, matrix: { operator: ['dashboard', 'tools'], viewer: ['dashboard', 'tools'], toolsDenied: { operator: [], viewer: [] } } }));
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const HOUR = 3_600_000;
const NOW = Date.now();
const SRC = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src');

const USERS = {
  adm: { username: 'adm', role: 'admin', scope: null },
  own: { username: 'own', role: 'admin', scope: null },
  admA: { username: 'adma', role: 'admin', scope: { vcenters: ['vcA'] } },
  opB: { username: 'opb', role: 'operator', scope: { vcenters: ['vcB'] } },
  opC: { username: 'opc', role: 'operator', scope: { vcenters: ['vcC'] } },
  opAB: { username: 'opab', role: 'operator', scope: { vcenters: ['vcA', 'vcB'] } },
};

let _app = null;
async function setup(t) {
  fs.writeFileSync(path.join(DIR, 'idrac.json'), JSON.stringify({ servers: [] }));
  fs.writeFileSync(path.join(DIR, 'bm-storage.json'), JSON.stringify({ servers: [
    { id: 'o-a1', name: 'bm-a1', host: '127.0.0.1', port: 9, username: 'mon', password: 'pw', mounts: [] },
  ] }));
  fs.writeFileSync(path.join(DIR, 'bmusage-settings.json'), JSON.stringify({ enabled: true, corps: { vcA: true }, osSsh: true, idracTelemetry: false }));
  const poller = await import('../src/bmusage/poller.js');
  poller._setFleetForTest(async () => ({ bareMetal: [{ serverId: 's-a1', name: 'bm-a1', serviceTag: 'DUPK', vcenterId: 'vcA', vcName: 'A 법인' }], virtualizationHosts: [] }));
  (await import('../src/bmusage/settings.js'))._resetForTest();
  const { store } = await import('../src/store.js');
  store.set?.({ ...store.get(), vcenters: [{ id: 'vcA', name: 'A 법인' }, { id: 'vcB', name: 'B 법인' }, { id: 'vcC', name: 'C 법인' }] });
  // 엣지 보관분 — 같은 키 DUPK 가 B · C 에도 · EDK 는 엣지 B · C 에만(이 노드에 없다 — ⓒ) · 넣는 순서: B 먼저
  const E = await import('../src/central/bmUsageEdgePull.js');
  E._resetForTest();
  E.putEdgeBmUsage('Edge-B', { ok: true, snap: { targets: [
    { key: 'DUPK', name: 'b-dup', serviceTag: 'DUPK', vcenterId: 'vcB', vcName: 'B 법인', paths: ['os'] },
    { key: 'EDK', name: 'b-edk', vcenterId: 'vcB', vcName: 'B 법인', paths: ['os'] },
  ], perf: [], rows: [] } });
  E.putEdgeBmUsage('Edge-C', { ok: true, snap: { targets: [
    { key: 'DUPK', name: 'c-dup', serviceTag: 'DUPK', vcenterId: 'vcC', vcName: 'C 법인', paths: ['os'] },
    { key: 'EDK', name: 'c-edk', vcenterId: 'vcC', vcName: 'C 법인', paths: ['os'] },
  ], perf: [], rows: [] } });
  if (!_app) {
    const express = (await import('express')).default;
    const { api } = await import('../src/routes/api.js');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
    app.use('/api', api);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    _app = { srv, base: `http://127.0.0.1:${srv.address().port}/api/tools/bm-usage` };
  }
  t.after(() => { poller._setFleetForTest(null); E._resetForTest(); });
  const call = async (u, method, p, body) => {
    const r = await fetch(`${_app.base}${p}`, { method, headers: { 'x-u': u, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: await r.json() };
  };
  return { call, E };
}
test.after(() => { _app?.srv.close(); });

/** 응답이 어느 서버 것인가(이 노드 vcA · Edge-B · Edge-C) — 상세 · 추이 · 로그 · Top-N 공통. */
const whoOf = (r) => (r.body?.via === 'local' ? 'local' : (r.body?.agent || r.status));

test('① ⓐ ⓑ ⓒ — 상세 · 추이 · 로그 · Top-N: 같은 키 세 법인(이 노드 · 엣지 보관분) × 관리자 · 범위 관리자 · 범위 운영자', async (t) => {
  const { call } = await setup(t);
  const routes = ['/perf/DUPK', '/perf/DUPK/history', '/perf/DUPK/devices', '/perf/DUPK/logs', `/perf/DUPK/top?ts=${NOW}`, '/perf/DUPK/tuning', '/perf/DUPK/profile', '/capacity/DUPK', '/perf/DUPK/playbook', '/perf/DUPK/slo', '/perf/DUPK/changes'];
  for (const p of routes) {
    const sep = p.includes('?') ? '&' : '?';
    // ⓐ 관리자 — 법인을 안 주면 고르지 않는다(기준판: 이 노드 A 를 골랐다 · B · C 서버를 볼 길이 없었다)
    const amb = await call('adm', 'GET', p);
    assert.equal(amb.status, 400, `${p} 관리자 · 법인 없음 → 400(기준판 200 이 노드 A) ${JSON.stringify(amb.body).slice(0, 200)}`);
    assert.equal(amb.body.code, 'ambiguous-key', p);
    assert.deepEqual(amb.body.candidates.map((c) => c.vcenterId), ['vcA', 'vcB', 'vcC'], p);
    // 법인을 주면 그 법인 서버
    assert.equal(whoOf(await call('adm', 'GET', `${p}${sep}vcenterId=vcA`)), 'local', p);
    assert.equal(whoOf(await call('adm', 'GET', `${p}${sep}vcenterId=vcB`)), 'Edge-B', `${p} 관리자 vcB`);
    assert.equal(whoOf(await call('adm', 'GET', `${p}${sep}vcenterId=vcC`)), 'Edge-C', `${p} 관리자 vcC`);
    // 범위 관리자(A) — 범위 안 후보 하나 → 그 서버(법인을 안 줘도)
    assert.equal(whoOf(await call('admA', 'GET', p)), 'local', `${p} 범위 관리자 A`);
    // ⓑ 범위 운영자(B) — 기준판 404(첫 대상 A 가 범위 밖)
    assert.equal(whoOf(await call('opB', 'GET', p)), 'Edge-B', `${p} 범위 운영자 B(기준판 404)`);
    // ⓒ 범위 운영자(C) — 기준판 404(이 노드 A 에서 멈춤 · 엣지 B 에서 멈춤)
    assert.equal(whoOf(await call('opC', 'GET', p)), 'Edge-C', `${p} 범위 운영자 C(기준판 404)`);
  }
  // ⓒ 엣지끼리만 겹치는 키(이 노드에 없다) — 넣은 순서가 B 먼저여도 C 범위 계정은 C 서버
  for (const p of ['/perf/EDK', '/perf/EDK/history', '/perf/EDK/logs', `/perf/EDK/top?ts=${NOW}`]) {
    assert.equal(whoOf(await call('opC', 'GET', p)), 'Edge-C', `${p} 엣지 C(기준판 404 — 엣지 B 에서 멈췄다)`);
    assert.equal(whoOf(await call('opB', 'GET', p)), 'Edge-B', p);
    const a = await call('adm', 'GET', p);
    assert.equal(a.status, 400, p); assert.deepEqual(a.body.candidates.map((c) => c.vcenterId), ['vcB', 'vcC']);
  }
});

test('② ambiguous 모양 · 범위 밖 법인은 후보에도 본문에도 없다 · 범위 밖 vcenterId 는 없는 키와 같은 404', async (t) => {
  const { call } = await setup(t);
  const r = await call('opAB', 'GET', '/perf/DUPK');
  assert.equal(r.status, 400);
  assert.deepEqual(Object.keys(r.body).sort(), ['candidates', 'code', 'ok', 'reason']);
  assert.equal(r.body.ok, false); assert.equal(r.body.code, 'ambiguous-key');
  assert.deepEqual(r.body.candidates, [{ vcenterId: 'vcA', vcName: 'A 법인' }, { vcenterId: 'vcB', vcName: 'B 법인' }]);
  assert.match(r.body.reason, /2개 법인/, '범위 안 개수만 센다(기준 C 를 세지 않는다)');
  const txt = JSON.stringify(r.body);
  assert.ok(!txt.includes('vcC') && !txt.includes('C 법인') && !txt.includes('c-dup') && !txt.includes('Edge-C'), `범위 밖 법인 · 서버 · 엣지가 본문에 없다: ${txt}`);
  // 범위 밖 법인을 고르면 — 없는 키 · 없는 법인과 같은 모양(존재 오라클 금지)
  const out = await call('opAB', 'GET', '/perf/DUPK?vcenterId=vcC');
  const none = await call('opAB', 'GET', '/perf/NOPE-KEY?vcenterId=vcA');
  const nocorp = await call('opAB', 'GET', '/perf/DUPK?vcenterId=vcZ');
  assert.equal(out.status, 404); assert.deepEqual(out.body, none.body); assert.deepEqual(out.body, nocorp.body);
  // 범위 운영자 B 에게 C 에만 있는 키는 없는 키와 같다
  fs.writeFileSync(path.join(DIR, 'x.json'), '{}');
  const E = await import('../src/central/bmUsageEdgePull.js');
  E.putEdgeBmUsage('Edge-C2', { ok: true, snap: { targets: [{ key: 'ONLYC', name: 'c-only', vcenterId: 'vcC' }], perf: [], rows: [] } });
  const onlyC = await call('opB', 'GET', '/perf/ONLYC');
  assert.equal(onlyC.status, 404); assert.deepEqual(onlyC.body, none.body);
  // 비교 — 같은 키 두 열(법인을 준다) · 법인 없는 열은 ‘법인 고르기’(범위 안 후보만)
  const cmp = await call('opAB', 'GET', '/compare?keys=DUPK,DUPK,DUPK&vcenterIds=vcA,vcB,');
  assert.equal(cmp.status, 200, JSON.stringify(cmp.body).slice(0, 300));
  assert.deepEqual(cmp.body.columns.map((c) => [c.vcenterId || '', c.state === 'ambiguous' ? 'amb' : c.via]), [['vcA', 'local'], ['vcB', 'edge'], ['', 'amb']]);
  assert.deepEqual(cmp.body.columns[2].candidates.map((c) => c.vcenterId), ['vcA', 'vcB']);
  assert.ok(!JSON.stringify(cmp.body).includes('vcC'), '비교 응답에도 범위 밖 법인이 없다');
});

test('③ 쓰기 — 주석 · 검토 · 정비 창 · 집중 · 포트 매핑 · 용도 태그는 고른 법인 서버에만(법인 없으면 400 · 범위 계정은 자기 서버)', async (t) => {
  const { call } = await setup(t);
  const A = await import('../src/bmusage/annotations.js');
  // 주석 쓰기 — 관리자 · 법인 없음 → 400(기준판: 이 노드 A 에 적혔다)
  const a0 = await call('adm', 'POST', '/annotations', { keys: ['DUPK'], at: NOW - HOUR, kind: 'memo', text: '법인 없음' });
  assert.equal(a0.status, 400, JSON.stringify(a0.body)); assert.equal(a0.body.code, 'ambiguous-key'); assert.equal(a0.body.candidates.length, 3);
  const aB = await call('adm', 'POST', '/annotations', { keys: ['DUPK'], vcenterIds: ['vcB'], at: NOW - HOUR, kind: 'memo', text: 'B 서버 메모' });
  assert.equal(aB.status, 200, JSON.stringify(aB.body));
  assert.deepEqual(A.getAnnotation(aB.body.id).target.vcenterIds, ['vcB']);
  // ⓑ 범위 운영자 C — 법인을 안 줘도 자기 서버(기준판 404)
  const aC = await call('opC', 'POST', '/annotations', { keys: ['DUPK'], at: NOW - HOUR, kind: 'memo', text: 'C 서버 메모' });
  assert.equal(aC.status, 200, `기준판 404: ${JSON.stringify(aC.body)}`); assert.deepEqual(A.getAnnotation(aC.body.id).target.vcenterIds, ['vcC']);
  // 주석 읽기 — A 서버 추이에 B · C 서버 주석이 핀으로 뜨지 않는다(기준판: 키만 봐 셋 다 떴다)
  const q = `from=${NOW - 2 * HOUR}&to=${NOW}`;
  const ra = await call('adm', 'GET', `/annotations?keys=DUPK&vcenterIds=vcA&${q}`);
  assert.equal(ra.status, 200); assert.deepEqual(ra.body.annotations.map((x) => x.text), [], 'A 서버에는 B · C 주석이 없다');
  const rb = await call('adm', 'GET', `/annotations?keys=DUPK&vcenterIds=vcB&${q}`);
  assert.deepEqual(rb.body.annotations.map((x) => x.text), ['B 서버 메모']);
  assert.deepEqual(rb.body.annotations[0].target.includesPairs, [{ key: 'DUPK', vcenterId: 'vcB' }]);
  const two = await call('adm', 'GET', `/annotations?keys=DUPK,DUPK&vcenterIds=vcB,vcC&${q}`);
  assert.deepEqual(two.body.annotations.map((x) => x.text).sort(), ['B 서버 메모', 'C 서버 메모']);
  assert.equal((await call('adm', 'GET', `/annotations?keys=DUPK&${q}`)).status, 400, '법인 없이 모호하면 400(엉뚱한 주석을 보이지 않는다)');
  assert.deepEqual((await call('opC', 'GET', `/annotations?keys=DUPK&${q}`)).body.annotations.map((x) => x.text), ['C 서버 메모'], '범위 운영자 C — 자기 서버 주석');

  // 저활용 검토 쓰기(8b F9 — 이미 쌍) · 범위 운영자 C 가 자기 서버에
  const rv = await call('opC', 'POST', '/idle/review', { key: 'DUPK', vcenterId: 'vcC', status: 'review', reason: '' });
  assert.equal(rv.status, 200, JSON.stringify(rv.body)); assert.deepEqual(A.getAnnotation(rv.body.id).target.vcenterIds, ['vcC']);
  assert.equal((await call('opC', 'POST', '/idle/review', { key: 'DUPK', vcenterId: 'vcB', status: 'review', reason: '' })).status, 404, '조회 밖 법인 404');

  // 정비 창 — 법인 없음 400(후보 · 범위 안만) · 범위 운영자 B 는 자기 서버 · 음영은 그 법인 창만
  const loc = (await import('../src/bmusage/maint/schedule.js')).fmtLocal;
  const S = (ms) => loc('Asia/Seoul', ms).replace(' ', 'T');
  const win = (extra = {}) => ({ name: '패치', reason: '정비', tz: 'Asia/Seoul', target: { kind: 'server', keys: ['DUPK'] }, schedule: { kind: 'once', start: S(NOW + HOUR), end: S(NOW + 2 * HOUR) }, scopes: { alerts: true }, ...extra });
  const m0 = await call('opAB', 'POST', '/maintenance', win());
  assert.equal(m0.status, 400); assert.equal(m0.body.code, 'ambiguous-key'); assert.deepEqual(m0.body.candidates.map((c) => c.vcenterId), ['vcA', 'vcB'], '범위 안 후보만');
  const mB = await call('opB', 'POST', '/maintenance', win());
  assert.equal(mB.status, 200, JSON.stringify(mB.body));
  const ST = await import('../src/bmusage/maint/store.js');
  assert.equal(ST.getWindow(mB.body.id).vcenterId, 'vcB');
  const occA = await call('adm', 'GET', `/maintenance/occurrences?key=DUPK&vcenterId=vcA&from=${NOW}&to=${NOW + 3 * HOUR}`);
  assert.equal(occA.status, 200, JSON.stringify(occA.body));
  assert.ok(!occA.body.merged.flatMap((x) => x.ids).includes(mB.body.id), 'A 서버 음영에 B 서버 창이 없다');
  assert.equal((await call('adm', 'GET', `/maintenance/occurrences?key=DUPK&from=${NOW}&to=${NOW + 3 * HOUR}`)).status, 400, '음영 조회도 법인 없으면 400(기준판: A 서버 음영)');
  const occB = await call('opB', 'GET', `/maintenance/occurrences?key=DUPK&from=${NOW}&to=${NOW + 3 * HOUR}`);
  assert.ok(occB.body.merged.flatMap((x) => x.ids).includes(mB.body.id), '범위 운영자 B — 자기 서버 음영(기준판 404)');

  // 집중 시작 — 관리자 법인 없음 400(아무것도 시작하지 않는다) · 범위 운영자 C 는 엣지 C 대행(등록부에 없는 엣지라 실패 — 고른 엣지가 응답에 실린다)
  const f0 = await call('adm', 'POST', '/perf/DUPK/focus', { reason: '확인' });
  assert.equal(f0.status, 400); assert.equal(f0.body.code, 'ambiguous-key');
  const fC = await call('opC', 'POST', '/perf/DUPK/focus', { reason: '확인' });
  assert.equal(fC.body.agent, 'Edge-C', `기준판 404: ${JSON.stringify(fC.body).slice(0, 200)}`); assert.equal(fC.body.via, 'edge');
  const fB = await call('adm', 'POST', '/perf/DUPK/focus', { reason: '확인', vcenterId: 'vcB' });
  assert.equal(fB.body.agent, 'Edge-B');
  // 진단 스냅샷 실행 · 포트 매핑 · 용도 태그(관리자) — 법인 없음 400 · 고르면 그 서버
  const sn0 = await call('adm', 'POST', '/perf/DUPK/snapshot', { reason: '확인' });
  assert.equal(sn0.status, 400); assert.equal(sn0.body.code, 'ambiguous-key');
  const pm0 = await call('adm', 'PUT', '/port-map', { key: 'DUPK', nic: 'eth0', cvpId: 'x', deviceKey: 'd', port: 'Et1' });
  assert.equal(pm0.status, 400); assert.equal(pm0.body.code, 'ambiguous-key');
  const pu0 = await call('adm', 'PUT', '/purpose', { key: 'DUPK', role: 'web' });
  assert.equal(pu0.status, 400); assert.equal(pu0.body.code, 'ambiguous-key');
  const puA = await call('admA', 'PUT', '/purpose', { key: 'DUPK', role: 'web' });
  assert.notEqual(puA.status, 400, '범위 관리자 A — 자기 서버 하나로 정해진다');
  assert.notEqual(puA.status, 404);
});

test('②-2 사용률 추이(/history — 이 노드 원시만) · 목표 설정(서버별 목표 — 같은 키 여러 법인이면 범위 안 법인 하나라도 있으면 보인다)', async (t) => {
  const { call } = await setup(t);
  // /history 는 이 노드 대상만 본다(localOnly) — 엣지 보관분 B · C 가 같은 키여도 이 노드 A 하나라 모호하지 않다(엣지에는 원시 이력이 없다)
  const h = await call('adm', 'GET', '/history?key=DUPK&hours=1&days=1');
  assert.equal(h.status, 200, JSON.stringify(h.body).slice(0, 200)); assert.equal(h.body.target.vcenterId, 'vcA');
  assert.equal((await call('opB', 'GET', '/history?key=DUPK&hours=1')).status, 404, '범위 운영자 B — 이 노드에 자기 서버가 없다(엣지 서버의 원시 이력은 중앙에 없다)');
  assert.equal((await call('adm', 'GET', '/history?key=DUPK&hours=1&vcenterId=vcB')).status, 404);
  // 목표 설정 읽기 — 서버별 목표는 키 하나에 걸린다(저장 키가 쌍이 아니다 — 정직 기록) · 그 키가 범위 안 법인에 하나라도 있으면 범위 계정에 보인다(예전: 첫 법인 A 만 봐 B 계정에 숨었다)
  const L = await import('../src/bmusage/slo.js');
  L.saveSlo({ servers: { DUPK: [{ id: 's-cpu', metric: 'cpu_pct', basis: 'avg', op: 'lt', value: 80, objectivePct: 99 }], GONE: [{ id: 's-x', metric: 'cpu_pct', basis: 'avg', op: 'lt', value: 80, objectivePct: 99 }] } }, { by: 'own' });
  const sB = await call('opB', 'GET', '/slo');
  assert.equal(sB.status, 200); assert.equal(sB.body.serversHidden, 1, '비관리자 — 개수만(키는 싣지 않는다) · 범위 B 에 DUPK 가 있다(기준판 0)');
  const sA = await call('admA', 'GET', '/slo');
  assert.deepEqual(Object.keys(sA.body.slo.servers), ['DUPK']);
  L.saveSlo({ servers: {} }, { by: 'own' });
});

test('④ 저장 단계 — 같은 노드 같은 키는 둘 다 수집하지 않는다(key-conflict) · 기본키 (agent, key) 가 섞임을 만든다(실제 DB)', async (t) => {
  // 실제 폴러 대상 해석(currentTargets) — 다른 vCenter 의 같은 키 두 대(IP 로 등록한 iDRAC — 키 = IP)
  fs.writeFileSync(path.join(DIR, 'idrac.json'), JSON.stringify({ servers: [
    { id: '10.1.1.5', name: 'ip-a', host: 'https://10.1.1.5', username: 'u', password: 'p', vcenterId: 'vcA' },
    { id: '10.1.1.6', name: 'ip-b', host: 'https://10.1.1.6', username: 'u', password: 'p', vcenterId: 'vcB' },
    { id: '10.1.1.7', name: 'ip-c', host: 'https://10.1.1.7', username: 'u', password: 'p', vcenterId: 'vcA' },
  ] }));
  fs.writeFileSync(path.join(DIR, 'bm-storage.json'), JSON.stringify({ servers: [] }));
  fs.writeFileSync(path.join(DIR, 'bmusage-settings.json'), JSON.stringify({ enabled: true, corps: { vcA: true, vcB: true }, osSsh: false, idracTelemetry: true }));
  const poller = await import('../src/bmusage/poller.js');
  // 분류가 같은 키를 두 번 내는 경우(가상화 호스트 동명 · 수동 합성 등) — resolveTargets 입력으로 직접 만든다
  poller._setFleetForTest(async () => ({ bareMetal: [
    { serverId: '10.1.1.5', fleetId: '10.1.1.9', name: 'ip-a', serviceTag: '', vcenterId: 'vcA' },
    { serverId: '10.1.1.6', fleetId: '10.1.1.9', name: 'ip-b', serviceTag: '', vcenterId: 'vcB' },
    { serverId: '10.1.1.7', fleetId: '10.1.1.7', name: 'ip-c', serviceTag: '', vcenterId: 'vcA' },
  ], virtualizationHosts: [] }));
  t.after(() => poller._setFleetForTest(null));
  (await import('../src/bmusage/settings.js'))._resetForTest();
  const tg = await poller.currentTargets();
  assert.deepEqual(tg.targets.map((x) => x.key), ['10.1.1.7'], '같은 키 두 대는 수집 대상이 아니다(기준판: 둘 다 대상 — 한 행에 섞였다)');
  assert.deepEqual(tg.skipped.filter((x) => x.reason === 'key-conflict').map((x) => `${x.vcenterId}|${x.name}`).sort(), ['vcA|ip-a', 'vcB|ip-b']);
  assert.deepEqual(tg.keyConflicts.map((x) => `${x.vcenterId}|${x.names.join(',')}`).sort(), ['vcA|ip-a', 'vcB|ip-b'], '서버마다 한 줄 — 법인 B 범위 계정이 법인 A 서버 이름을 보지 않는다');
  // 섞임이 사실인지 — 실제 DB: 같은 (agent, key) 두 서버의 최신값은 한 행 · 이력은 번갈아 한 계열(기준판에서 일어나던 것)
  let sqlite = true; try { await import('node:sqlite'); } catch { sqlite = false; }
  if (!sqlite) return t.diagnostic('node:sqlite 없음 — DB 확인 생략');
  const DB = await import('../src/bmusage/db.js');
  const ts0 = Math.floor(NOW / 300_000) * 300_000 - 3_600_000;
  await DB.insertUsage([{ key: '10.1.1.9', ts: ts0, cpu_pct: 10, mem_pct: 10 }, { key: '10.1.1.9', ts: ts0 + 1_000, cpu_pct: 90, mem_pct: 90 }], 'mixtest');
  const latest = (await DB.latestUsage({})).filter((r) => r.agent === 'mixtest');
  assert.equal(latest.length, 1, '두 서버 = 최신값 한 행(덮어쓴다)');
  const hist = await DB.usageHistory('10.1.1.9', { agent: 'mixtest', hours: 24 });
  assert.deepEqual(hist.rows.map((r) => r.cpu_pct), [10, 90], '이력은 두 서버 값이 한 계열에 번갈아 — 법인 축이 없다');
});

test('⑤ 소스 스윕 — 라우트의 대상 해석은 resolvePerfTarget 하나 · 호출마다 vcenterId · 응답 모양은 perfTargetFail', () => {
  const files = fs.readdirSync(path.join(SRC, 'routes', 'api')).filter((f) => /^bm.*\.js$/.test(f));
  let calls = 0;
  for (const f of files) {
    const src = stripComments(fs.readFileSync(path.join(SRC, 'routes', 'api', f), 'utf8'));
    // 따로 둔 해석 금지(예전 bmPerfView · bmTrendView · /history 의 사본 — 같은 키의 첫 대상 · 첫 엣지에서 멈춤)
    assert.ok(!/resolveMaskedToken\s*\(/.test(src), `${f}: 가림 토큰 대응은 resolvePerfTarget 안에서만`);
    assert.ok(!/targets\.find\(\(x\)\s*=>\s*(?:t\()?x\.key\)?\s*===\s*(?:realKey|key)\b/.test(src), `${f}: 키로 대상을 직접 찾지 않는다`);
    assert.ok(!/\.find\(\(x\)\s*=>\s*(?:corpOk\(x\)\s*&&\s*)?\(?t\(x\.key\)\s*===\s*key/.test(src), `${f}: 엣지 보관분을 키로 직접 찾지 않는다`);
    const re = /(?<!function )resolvePerfTarget\(\s*req\s*,/g;
    let m;
    while ((m = re.exec(src))) {
      calls += 1;
      const end = src.indexOf(');', m.index);
      const args = src.slice(m.index, end);
      assert.ok(/\bvcenterId\s*(?::|,|\})/.test(args), `${f}: resolvePerfTarget 호출에 vcenterId 가 없다 — ${args.slice(0, 160)}`);
      const after = src.slice(end, end + 400);
      assert.ok(/perfTargetFail\(/.test(after) || /f\?\.ambiguous/.test(after), `${f}: 해석 뒤 perfTargetFail 로 응답 모양을 정하지 않는다 — ${after.slice(0, 160)}`);
    }
  }
  assert.ok(calls >= 20, `호출처 ${calls}곳(라우트 10개 파일)`);
  // 정의 — vcenterId · 범위를 세기 전에 거르고 · 첫 일치에서 멈추지 않는다(엣지 루프 안 return 금지) · 식별은 targetIdOf
  const u = stripComments(fs.readFileSync(path.join(SRC, 'routes', 'api', 'bmUsage.js'), 'utf8'));
  const body = u.slice(u.indexOf('async function resolvePerfTarget('), u.indexOf('export { resolvePerfTarget'));
  assert.match(body, /targetIdOf\(x\)/);
  assert.ok(!/for \(const x of rec\.snap\.targets\)[\s\S]*?return \{ via/.test(body.slice(0, body.indexOf('if (!byId.size)'))), '엣지 루프 안에서 첫 일치를 돌려주지 않는다');
  assert.match(body, /allowed\.has\(v\)/);
});

test('⑥ 비용 — 엣지 28 × 대상 300 · 이 노드 600 을 다 훑어도 요청 하나가 짧다(비관리자 가림 토큰 포함)', async () => {
  const { _resolvePerfTargetForTest: R } = await import('../src/routes/api/bmUsage.js');
  const { maskedIdToken } = await import('../src/auth/addressMask.js');
  const local = { targets: Array.from({ length: 600 }, (_, i) => ({ key: `10.0.${i >> 8}.${i & 255}`, vcenterId: 'vc0' })) };
  const recs = Array.from({ length: 28 }, (_, e) => ({ agent: `E${e}`, snapAt: e, snap: { targets: Array.from({ length: 300 }, (_, k) => ({ key: `10.9.${k >> 8}.${k & 255}`, vcenterId: `vc${e + 1}` })) } }));
  const D = { currentTargets: async () => local, listEdgeBmUsage: async () => recs };
  const tok = maskedIdToken('10.9.0.7');
  const allowed = new Set(['vc5']);
  const times = [];
  for (let i = 0; i < 5; i += 1) {
    // 이 노드 대상은 currentTargets 가 부를 때마다 새 배열이다 — 그 색인은 매번 다시 만든다(엣지 보관분 색인만 남는다)
    D.currentTargets = async () => ({ targets: local.targets.slice() });
    const t0 = performance.now();
    const f = await R({}, D, { allowed, isAdmin: false, key: tok });
    times.push(performance.now() - t0);
    assert.equal(f.agent, 'E4'); assert.equal(f.realKey, '10.9.0.7');
  }
  const cold = times[0]; const warm = Math.max(...times.slice(1)); const worst = Math.max(cold, warm);
  const t1 = performance.now();
  const amb = await R({}, D, { allowed: null, isAdmin: false, key: tok });
  const ambMs = performance.now() - t1;
  assert.equal(amb.ambiguous, true); assert.equal(amb.candidates.length, 28);
  console.log(`[⑥] 대상 ${600 + 28 * 300}개 · 가림 토큰 해석 첫 요청(색인 생성) ${cold.toFixed(1)}ms · 다음 요청 최악 ${warm.toFixed(1)}ms · 28법인 모호 ${ambMs.toFixed(1)}ms`);
  assert.ok(warm < 30, `색인 뒤 요청 ${warm.toFixed(1)}ms — 이 노드 대상(600)만 다시 색인`);
  assert.ok(worst < 250 && ambMs < 250, `요청 하나 ${worst.toFixed(1)}ms / ${ambMs.toFixed(1)}ms`);
});

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
  // 비교 세트 — 같은 키 · 다른 법인 두 서버를 쌍으로 저장(예전: 키로 합쳐 1대 → 400) · 같은 쌍 두 번은 한 번
  const set = await call('adm', 'PUT', '/compare/sets', { name: '같은 키 두 법인', keys: ['DUPK', 'DUPK'], vcenterIds: ['vcA', 'vcB'] });
  assert.equal(set.status, 200, JSON.stringify(set.body)); assert.deepEqual(set.body.set.keys, ['DUPK', 'DUPK']); assert.deepEqual(set.body.set.vcenterIds, ['vcA', 'vcB']);
  const dup = await call('adm', 'PUT', '/compare/sets', { name: '같은 쌍', keys: ['DUPK', 'DUPK'], vcenterIds: ['vcA', 'vcA'] });
  assert.equal(dup.status, 400, '같은 쌍 두 번은 한 대(2대 미만)');
  assert.equal((await call('adm', 'PUT', '/compare/sets', { name: 'x', keys: ['A', 'B'], vcenterIds: ['bad vc', ''] })).status, 400, '법인 형식 밖 400');
  const old = await call('adm', 'PUT', '/compare/sets', { name: '예전 모양', keys: ['DUPK', 'EDK'] });
  assert.equal(old.status, 200); assert.equal(old.body.set.vcenterIds, undefined, '법인 없이 저장한 세트는 예전 모양 그대로');
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

/*
 * ④ 저장 단계 — ⚠ 정정(반증 F1): 처음 판은 ‘같은 노드 같은 키는 둘 다 수집하지 않는다 · 섞임은 사실’ 이라 적었지만, 실제 파이프라인에서는
 *   분류(classifyFleet)가 같은 dk 의 둘째 서버를 bareMetal 에 넣지 않아(가상화 호스트는 targets.js 가 같은 키를 건너뛰어) key-conflict 경로에 닿지 않는다.
 *   섞임은 ‘저장 기본키 (agent, key) 가 허용하는 상태’ 이지 파이프라인이 만든 사실이 아니다. 그래서:
 *   (a) 실제 classifyFleet → 실제 currentTargets(공통 태그 두 대 · 숫자 태그 vs serverId · 대소문자만 다른 태그) — 남은 서버가 **keyOverlaps 로 보인다**(예전: 아무 데도 없음)
 *   (b) key-conflict 는 분류가 만들 수 없는 입력에 대한 **방어 코드**로 남는다(직접 넣은 입력으로만 닿는다)
 *   (c) 기본키가 섞임을 허용한다는 사실(실제 DB)
 */
test('④ 저장 단계 — 실제 분류의 같은 키 서버는 겹침 목록으로 보인다(조용한 제외 없음) · key-conflict 는 방어 코드 · 기본키 (agent, key) 는 섞임을 허용한다', async (t) => {
  const poller = await import('../src/bmusage/poller.js');
  const { classifyFleet } = await import('../src/insights/fleetInventory.js');
  t.after(() => poller._setFleetForTest(null));
  const vcenters = [{ id: 'vcA', name: 'A' }, { id: 'vcB', name: 'B' }];
  const cases = {
    junkTag: [{ serverId: 'r-a1', serverName: 'wb-a1', serviceTag: 'To Be Filled By O.E.M.', source: 'idrac', vcenterId: 'vcA' }, { serverId: 'r-b1', serverName: 'wb-b1', serviceTag: 'To Be Filled By O.E.M.', source: 'idrac', vcenterId: 'vcB' }],
    tagVsId: [{ serverId: 'r-a2', serverName: 's-a2', serviceTag: '1234567', source: 'idrac', vcenterId: 'vcA' }, { serverId: '1234567', serverName: 's-b2', serviceTag: '', source: 'idrac', vcenterId: 'vcB' }],
    caseOnly: [{ serverId: 'r-a3', serverName: 's-a3', serviceTag: 'abc12', source: 'idrac', vcenterId: 'vcA' }, { serverId: 'ABC12', serverName: 's-b3', serviceTag: '', source: 'idrac', vcenterId: 'vcB' }],
  };
  fs.writeFileSync(path.join(DIR, 'bm-storage.json'), JSON.stringify({ servers: [] }));
  fs.writeFileSync(path.join(DIR, 'bmusage-settings.json'), JSON.stringify({ enabled: true, corps: { vcA: true, vcB: true }, osSsh: false, idracTelemetry: true }));
  (await import('../src/bmusage/settings.js'))._resetForTest();
  for (const [name, servers] of Object.entries(cases)) {
    fs.writeFileSync(path.join(DIR, 'idrac.json'), JSON.stringify({ servers: servers.map((x) => ({ id: x.serverId, name: x.serverName, host: `https://10.9.${name.length}.${x.serverId.length}`, username: 'u', password: 'p', vcenterId: x.vcenterId, serviceTag: x.serviceTag })) }));
    poller._setFleetForTest(async () => classifyFleet({ hosts: [], vcenters, servers, tags: {}, assign: {} }));
    const tg = await poller.currentTargets();
    assert.equal(tg.targets.length, 1, `${name}: 분류는 그대로 한 대만 수집 대상(이미 수집 중인 서버의 키 · 이력은 그대로)`);
    assert.equal(tg.targets[0].vcenterId, 'vcA');
    assert.equal(tg.keyOverlaps.length, 1, `${name}: 남은 서버가 겹침 목록에 보인다(기준판 · 첫 판: skipped 0 · keyConflicts 0 — 아무 데도 없었다)`);
    const o = tg.keyOverlaps[0];
    assert.equal(o.vcenterId, 'vcB'); assert.equal(o.decision, null);
    assert.equal(o.serviceTag, servers[1].serviceTag, '서비스태그 원문(공통 값 포함)');
    assert.ok(o.idracHost.startsWith('https://10.9.'), '주소는 serverId 로 찾은 등록(서비스태그로 찾지 않는다 — 공통 태그면 남의 등록)');
    assert.equal(o.dupOf.vcenterId, 'vcA', '겹친 상대(수집 중 서버)');
    assert.equal(o.decidedKey, `vcB:${servers[1].serverId}`, '추가하면 쓸 별도 키');
    assert.equal(tg.keyConflicts.length, 0, 'key-conflict 경로에는 닿지 않는다(방어 코드)');
  }
  // (b) 방어 코드 — 분류가 만들 수 없는 입력(서로 다른 serverId · 같은 fleetId)을 직접 넣으면 둘 다 빼고 밝힌다
  fs.writeFileSync(path.join(DIR, 'idrac.json'), JSON.stringify({ servers: [
    { id: '10.1.1.5', name: 'ip-a', host: 'https://10.1.1.5', username: 'u', password: 'p', vcenterId: 'vcA' },
    { id: '10.1.1.6', name: 'ip-b', host: 'https://10.1.1.6', username: 'u', password: 'p', vcenterId: 'vcB' },
  ] }));
  poller._setFleetForTest(async () => ({ bareMetal: [
    { serverId: '10.1.1.5', fleetId: '10.1.1.9', name: 'ip-a', serviceTag: '', vcenterId: 'vcA' },
    { serverId: '10.1.1.6', fleetId: '10.1.1.9', name: 'ip-b', serviceTag: '', vcenterId: 'vcB' },
  ], virtualizationHosts: [] }));
  const tg2 = await poller.currentTargets();
  assert.deepEqual(tg2.targets.map((x) => x.key), []);
  assert.deepEqual(tg2.skipped.filter((x) => x.reason === 'key-conflict').map((x) => `${x.vcenterId}|${x.name}`).sort(), ['vcA|ip-a', 'vcB|ip-b']);
  assert.deepEqual(tg2.keyConflicts.map((x) => `${x.vcenterId}|${x.names.join(',')}`).sort(), ['vcA|ip-a', 'vcB|ip-b'], '서버마다 한 줄');
  // (c) 기본키 (agent, key) 는 같은 키 두 서버를 한 행 · 한 계열로 받는다(실제 DB — 파이프라인 사실이 아니라 저장이 허용하는 상태)
  let sqlite = true; try { await import('node:sqlite'); } catch { sqlite = false; }
  if (!sqlite) return t.diagnostic('node:sqlite 없음 — DB 확인 생략');
  const DB = await import('../src/bmusage/db.js');
  const ts0 = Math.floor(NOW / 300_000) * 300_000 - 3_600_000;
  await DB.insertUsage([{ key: '10.1.1.9', ts: ts0, cpu_pct: 10, mem_pct: 10 }, { key: '10.1.1.9', ts: ts0 + 1_000, cpu_pct: 90, mem_pct: 90 }], 'mixtest');
  assert.equal((await DB.latestUsage({})).filter((r) => r.agent === 'mixtest').length, 1, '두 서버 = 최신값 한 행');
  assert.deepEqual((await DB.usageHistory('10.1.1.9', { agent: 'mixtest', hours: 24 })).rows.map((r) => r.cpu_pct), [10, 90], '이력은 한 계열');
});

/*
 * 소스 스윕(반증 F5 로 강화) — 라우트 파일(routes/api/bm*.js)에서
 *   (a) resolvePerfTarget 호출은 **첫 인자 이름과 무관하게** 다 센다 · `vcenterId` 값은 요청에서 온 식(perfVcOf(req) · 쌍 변수 · 검사한 본문 값)만 — 글자 상수 금지 ·
 *       호출 뒤 perfTargetFail(또는 f?.ambiguous)로 응답 모양을 정한다
 *   (b) 대상 목록을 읽는 함수(currentTargets( · listEdgeBmUsage( 를 부르는 함수) 안에서 **키 비교로 하나를 고르는 곳**(`.find((x) => … x.key … ===`)과
 *       키 → 대상 맵(`[x.key, …]`)은 허용 목록(파일 · 함수 · 줄 조각 — 행 · 판정 항목 찾기와 함대 목록)에 있어야 한다.
 * 반증 mut-sweep 의 변형 5종(인자 이름 바꾼 find · 엣지 첫 일치 · 첫 인자 rq · vcenterId 글자 상수 · 키 맵)이 모두 걸린다(아래 시험이 고정).
 */
const SWEEP_ALLOW = Object.freeze({
  // 함대 목록(여러 서버 — 범위로 거른 목록을 키로 잇는다 · 대상 하나를 고르지 않는다)
  'bmCapacity.js:bmCapacityFleet': ['[x.key,', '[t(x.key),'], 'bmIdle.js:bmIdleFleet': ['[x.key,', '[t(x.key),'], 'bmLogs.js:bmLogsFleet': ['[x.key,'],
  'bmLogs.js:inScope': ['[String(x.key),'], 'bmOnboard.js:fileOf': ['[String(p.key),'], 'bmPerfOps.js:bmFocusFleet': ['[x.key,', '[String(x.key),'],
  'bmUsage.js:opsFleetItems': ['(p) => t(p.key) === k', '(r) => t(r.key) === k', '[t(r.key),', '[t(p.key),'],
  // 해석이 끝난 대상의 행 · 판정 항목 찾기(resolvePerfTarget 뒤 — 같은 대상의 최신값 행 · 엣지 봉투의 그 서버 항목)
  'bmUsage.js:bmPerfView': ['(r) => t(r.key) === target.key && t(r.agent) === agent', '(p) => t(p.key) === t(tgt.key)'],
});
// 요청에서 온 식만(축약형 `vcenterId` 는 쌍 변수 — 콜론 없음). `m.corp` 는 물리서버 폴더 추이(bmFolders.js v2.986) — 키를 받은 뒤 **범위로 거른 구성원**의 법인(서버가 정한 쌍 · 요청보다 강함)
const VC_EXPR_OK = /^\s*(?:perfVcOf\(req\)|want|vcIn|t\(b\.vcenterId\)\.slice\(0, 128\)|m\.corp)\s*(?:,|\}|$)/;
function sweepIssues(files) {
  const issues = [];
  let calls = 0;
  const closeOf = (s, open) => { let d = 0; for (let i = open; i < s.length; i += 1) { if (s[i] === '(') d += 1; else if (s[i] === ')') { d -= 1; if (!d) return i; } } return -1; };
  const chunksOf = (src) => {
    const re = /(?:^|\n)[ \t]*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(|(?:^|\n)[ \t]*(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>/g;
    const marks = []; let m;
    while ((m = re.exec(src))) marks.push({ name: m[1] || m[2], at: m.index });
    return marks.map((x, i) => ({ name: x.name, body: src.slice(x.at, i + 1 < marks.length ? marks[i + 1].at : src.length) }));
  };
  for (const [f, raw] of Object.entries(files)) {
    const src = stripComments(raw);
    if (/resolveMaskedToken\s*\(/.test(src)) issues.push(`${f}: 가림 토큰 대응은 resolvePerfTarget 안에서만`);
    for (const m of src.matchAll(/(?<!function\s)resolvePerfTarget\(/g)) {
      calls += 1;
      const open = m.index + 'resolvePerfTarget'.length;
      const close = closeOf(src, open);
      const args = src.slice(open + 1, close);
      const vm = /\bvcenterId\s*(:)?/.exec(args);
      if (!vm) issues.push(`${f}: resolvePerfTarget 호출에 vcenterId 가 없다 — ${args.slice(0, 120)}`);
      else if (vm[1] && !VC_EXPR_OK.test(args.slice(vm.index + vm[0].length))) issues.push(`${f}: vcenterId 값이 요청에서 온 식이 아니다 — ${args.slice(vm.index, vm.index + 60)}`);
      const after = src.slice(close, close + 400);
      if (!/perfTargetFail\(/.test(after) && !/f\?\.ambiguous/.test(after)) issues.push(`${f}: 해석 뒤 perfTargetFail 로 응답 모양을 정하지 않는다 — ${after.slice(0, 100)}`);
    }
    for (const c of chunksOf(src)) {
      if (!/currentTargets\(|listEdgeBmUsage\(/.test(c.body)) continue;
      const allow = SWEEP_ALLOW[`${f}:${c.name}`] || [];
      for (const m of c.body.matchAll(/\.find\(/g)) {
        const open = m.index + 5; const inner = c.body.slice(open + 1, closeOf(c.body, open));
        const pm = /^\s*\(?\s*(\w+)\s*\)?\s*=>/.exec(inner);
        if (pm && new RegExp(`\\b${pm[1]}\\??\\.key\\b`).test(inner) && /===/.test(inner) && !allow.some((a) => inner.includes(a))) issues.push(`${f}:${c.name}: 키 비교로 대상 하나를 고른다 — ${inner.slice(0, 80)}`);
      }
      for (const m of c.body.matchAll(/\[\s*(?:t\(|String\()?\s*\w+\??\.key\s*\)?\s*,/g)) if (!allow.includes(m[0])) issues.push(`${f}:${c.name}: 키 → 대상 맵 — ${m[0]}`);
    }
  }
  return { issues, calls };
}
const SWEEP_MUTANTS = Object.freeze([
  ['M1 이 노드 대상 키 직접 찾기(인자 이름 s)', 'export async function _m1(req, D, key) { const tg = await D.currentTargets(); return tg.targets.find((s) => s.key === key) || null; }'],
  ['M2 엣지 보관분 첫 일치(인자 이름 y)', 'export async function _m2(req, D, key) { for (const rec of await D.listEdgeBmUsage()) { const hit = (rec.snap.targets || []).find((y) => String(y.key) === key); if (hit) return hit; } return null; }'],
  ['M3 첫 인자 이름 rq · vcenterId 없음 · denied 판정', 'export async function _m3(rq, D, key) { const f = await resolvePerfTarget(rq, D, { allowed: null, isAdmin: true, key }); if (!f || f.denied) return null; return f; }'],
  ['M4 vcenterId 를 빈 글자로 박음', 'export async function _m4(req, D, key) { const f = await resolvePerfTarget(req, D, { allowed: null, isAdmin: true, key, vcenterId: "" }); const bad = perfTargetFail(f); if (bad) return bad; return f; }'],
  ['M5 키 → 대상 Map 으로 찾기', 'export async function _m5(req, D, key) { const idx = new Map((await D.currentTargets()).targets.map((x) => [x.key, x])); return idx.get(key) || null; }'],
]);

test('⑤ 소스 스윕 — 라우트의 대상 해석은 resolvePerfTarget 하나 · 호출마다 요청의 vcenterId · 응답 모양은 perfTargetFail · 키로 직접 고르지 않는다(반증 F5 변형 5종)', () => {
  const dir = path.join(SRC, 'routes', 'api');
  const files = Object.fromEntries(fs.readdirSync(dir).filter((f) => /^bm.*\.js$/.test(f)).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));
  const real = sweepIssues(files);
  assert.deepEqual(real.issues, [], real.issues.join('\n'));
  assert.ok(real.calls >= 20, `호출처 ${real.calls}곳(라우트 10개 파일)`);
  // 반증 mut-sweep(rvn1/mut-sweep.sh) 재현 — 변형을 bmTop.js 사본 글자에 붙이면 각각 걸린다(작업 트리 소스는 바꾸지 않는다)
  for (const [name, code] of SWEEP_MUTANTS) {
    const r = sweepIssues({ ...files, 'bmTop.js': `${files['bmTop.js']}\n${code}\n` });
    assert.ok(r.issues.length > 0, `${name} — 스윕이 잡지 못했다`);
  }
  // 정의 — 범위를 세기 전에 거르고 · 첫 일치에서 멈추지 않는다(엣지 루프 안 return 금지) · 식별은 targetIdOf(귀속 없음은 노드까지 — 반증 F4)
  const u = stripComments(files['bmUsage.js']);
  const body = u.slice(u.indexOf('async function resolvePerfTarget('), u.indexOf('export { resolvePerfTarget'));
  assert.match(body, /targetIdOf\(x\)/);
  assert.ok(!/for \(const x of hits\(rec\.snap\.targets\)\)[\s\S]*?return \{ via/.test(body.slice(0, body.indexOf('if (!byId.size)'))), '엣지 루프 안에서 첫 일치를 돌려주지 않는다');
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

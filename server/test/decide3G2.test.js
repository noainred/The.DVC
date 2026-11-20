/**
 * 결정(76~105 남긴 것 · 2026-11-20) A3 — 엣지 적용 상태 파일(bm-onboard-applied.json) 읽기 오류를 중앙 화면이 알 수 있게(77 F3 · 79 남긴 것).
 *
 * 예전: 엣지는 읽기 오류면 옮기지도 쓰지도 않고 그 판을 건너뛰지만(77 F3), 인출 쿼리는 빈 서명 + 결과 수 0 뿐이라 중앙 화면은 '대기' 로만 보였다(사유 모름 ·
 *   못 읽은 결과 수가 0 으로 보였다). 이제:
 *  · 엣지(`agent/bmOnboardPull.js pullBmOnboardNow`)는 읽기 오류일 때만 불리언 한 칸 `unread=1` 을 싣고 결과 수(ok · rej · rm)는 뺀다(못 읽은 값 — 0 이 아니다).
 *    손상(parse 실패 — lost 경로)과 파일 없음은 표지가 아니다(예전과 같다).
 *  · 중앙(`routes/central/storageRoutes.js GET /bm-onboard` → `edgeDeploy.recordOnboardPull`)은 **개별 토큰으로 검증된 이름에만** · 정확히 '1' 만 참으로 받는다
 *    (배열 · 다른 글자 · 없음 = 거짓) · 인출 기록을 통째로 바꿔 다음 인출(칸 없음 · 거짓)이 표지를 지운다 · 시각은 중앙 수신 시각.
 *  · 하위 호환: 옛 엣지(칸 없음) = 예전 '대기' · 중앙은 모르는 쿼리 칸을 거절하지 않는다(옛 중앙도 같은 스택 — 표지 칸이 거절 사유가 되지 않는다).
 *  · 화면 API(`routes/api/bmOnboard.js GET /tools/bm-usage/onboard/edge-rows`)는 엣지마다 `stateUnread`(불리언)를 싣는다.
 * 진입 함수를 실제로 부른다: 엣지는 자식 프로세스(자기 CONFIG_DIR · 실제 config)로 실제 `pullBmOnboardNow` → 실제 centralRouter.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'decide3g2-c-'));
const EDIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'decide3g2-e-'));
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = 'live';
delete process.env.CENTRAL_URL;

const REGISTRY = [{ id: 'vcE', name: 'KR-EDGE', host: 'e.invalid', collectMode: 'site', remoteAgent: 'Edge-A' }];
let srv; let port; let tokA; let SHARED; let ED; let api;

before(async () => {
  SHARED = 'shared-central-token-decide3g2-abcdef';
  fs.writeFileSync(path.join(DIR, 'vcenters.json'), JSON.stringify({ vcenters: REGISTRY }));
  fs.writeFileSync(path.join(DIR, 'portal.env'), `CENTRAL_TOKEN=${SHARED}\n`);
  process.env.CENTRAL_TOKEN = SHARED;
  const express = (await import('express')).default;
  const { centralRouter } = await import('../src/routes/central.js');
  const { store } = await import('../src/store.js');
  store.snapshot = { ...store.get(), vcenters: REGISTRY.map((v) => ({ id: v.id, name: v.name })) };
  const tokens = await import('../src/central/agentTokens.js');
  tokA = tokens.issueAgentToken('Edge-A').token;
  ED = await import('../src/bmusage/onboard/edgeDeploy.js');
  // 배포 목록 — 엣지 저장소에 없는 키 이름이라 엣지 분석이 거부한다(적용 결과는 이 시험의 관심이 아니다 — 등록부를 바꾸지 않는 행)
  assert.equal(ED.applyEdgeChanges({ upserts: [{ agent: 'edge-a', row: { name: 'g2-a', corp: 'vcE', osHost: '10.70.0.1', osUser: 'mon', osKey: 'missing-key', mounts: ['/'], enabled: true } }] }, { by: 'adm' }).ok, true);
  const { registerBmOnboard } = await import('../src/routes/api/bmOnboard.js');
  const app = express();
  app.use(express.json());
  app.use('/api/central', centralRouter);   // 운영의 queryNormalizer 없이 — 배열 쿼리가 그대로 오는 구성(정제가 라우트 안에서 서는지)
  const r = express.Router();
  registerBmOnboard(r, {});
  app.use('/api', (req, _res, next) => { req.user = { username: 'full', role: 'admin', scope: null }; next(); }, r);
  srv = http.createServer(app);
  port = await new Promise((res) => srv.listen(0, '127.0.0.1', () => res(srv.address().port)));
  api = async (p) => { const x = await fetch(`http://127.0.0.1:${port}${p}`); return { s: x.status, j: await x.json().catch(() => ({})) }; };
  fs.writeFileSync(path.join(EDIR, 'bmusage-settings.json'), JSON.stringify({ enabled: true, corps: { vcE: true }, osSsh: true }));
  fs.writeFileSync(path.join(EDIR, 'vcenters.json'), JSON.stringify({ vcenters: [{ id: 'vcE', name: 'KR-EDGE', host: 'e.invalid' }] }));
});
after(() => { try { srv?.close(); } catch { /* */ } fs.rmSync(DIR, { recursive: true, force: true }); fs.rmSync(EDIR, { recursive: true, force: true }); });

/** 엣지 자식 — 실제 config(CENTRAL_URL · 개별 토큰)로 한 번 인출하고 결과를 출력. */
function edgeOnce(token) {
  const code = `
    const { store } = await import(${JSON.stringify(path.join(HERE, '../src/store.js'))});
    store.snapshot = { ...store.get(), vcenters: [{ id: 'vcE', name: 'KR-EDGE' }] };
    const W = await import(${JSON.stringify(path.join(HERE, '../src/agent/bmOnboardPull.js'))});
    const r = await W.pullBmOnboardNow();
    console.log('@@' + JSON.stringify({ r }));
  `;
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['--input-type=module', '-e', code], {
      env: { ...process.env, CONFIG_DIR: EDIR, CENTRAL_URL: `http://127.0.0.1:${port}`, CENTRAL_TOKEN: token, AGENT_CENTRAL_TOKEN: token, AGENT_NAME: 'Edge-A', DATA_SOURCE: 'live' },
      encoding: 'utf8', timeout: 60_000,
    }, (err, stdout, stderr) => {
      const line = String(stdout).split('\n').find((l) => l.startsWith('@@'));
      if (!line) return reject(new Error(`엣지 자식 출력 없음: ${err?.message || ''}\n${stderr}\n${stdout}`.slice(0, 2000)));
      resolve(JSON.parse(line.slice(2)));
    });
  });
}
const edgeRow = async () => (await api('/api/tools/bm-usage/onboard/edge-rows')).j.agents.find((a) => a.agent === 'edge-a');
/** 개별 토큰으로 중앙 인출을 직접(옛 엣지 · 정제 시험용). */
const pullAs = (token, qs) => fetch(`http://127.0.0.1:${port}/api/central/bm-onboard?${qs}`, { headers: { 'X-Central-Token': token, 'X-Agent-Name': 'Edge-A' } });

test('A3 ① 왕복 — 엣지가 적용 상태 파일을 못 읽으면(읽기 오류) 중앙 기록 · 화면 API 에 표지가 서고 결과 수는 못 읽음(null) · 읽히면 다음 인출이 표지를 지운다', async () => {
  const applied = path.join(EDIR, 'bm-onboard-applied.json');
  fs.mkdirSync(applied);   // 읽기 오류(EISDIR) — root 로 돌아도 재현되는 읽기 단계 실패
  const t0 = Date.now();
  const e = await edgeOnce(tokA);
  const t1 = Date.now();
  assert.equal(e.r.ok, false, JSON.stringify(e.r));
  assert.match(String(e.r.error || ''), /읽기 오류/, '엣지 자기 상태에는 사유(이 엣지에만)');
  assert.ok(fs.statSync(applied).isDirectory(), '원본은 옮기지 않는다(77 F3 그대로)');
  const rec = ED.onboardPullOf('Edge-A');
  assert.equal(rec.stateUnread, true, '중앙 기록에 표지');
  assert.ok(rec.at >= t0 && rec.at <= t1, '시각은 중앙 수신 시각');
  assert.deepEqual(rec.applied, { ok: null, rejected: null, removed: null }, '못 읽은 결과 수는 0 이 아니다(엣지가 싣지 않는다)');
  assert.equal(rec.appliedSig, '', '서명은 예전처럼 빈 값(제거 대기 유지)');
  const row = await edgeRow();
  assert.equal(row.stateUnread, true, '화면 API 에 표지');
  assert.equal(row.inSync, false);
  assert.ok(!JSON.stringify(row).includes('EISDIR') && !JSON.stringify(rec).includes('EISDIR'), '오류 코드 · 사유 원문은 중앙에 오지 않는다');
  // 읽히게 되면(디렉터리를 치움 = 파일 없음) — 다음 인출이 표지를 지운다
  fs.rmdirSync(applied);
  const e2 = await edgeOnce(tokA);
  assert.ok(!/읽기 오류/.test(String(e2.r.error || '')), JSON.stringify(e2.r));
  const rec2 = ED.onboardPullOf('Edge-A');
  assert.equal(rec2.stateUnread, false, '칸 없는 인출이 표지를 지운다(한 번 세운 표지가 남지 않는다)');
  assert.equal((await edgeRow()).stateUnread, false);
  // 그다음 인출은 적용 결과 수를 다시 숫자로(엣지 분석이 그 행을 거부 — 0 · 1 · 0)
  await edgeOnce(tokA);
  assert.deepEqual(ED.onboardPullOf('Edge-A').applied, { ok: 0, rejected: 1, removed: 0 });
  assert.equal(ED.onboardPullOf('Edge-A').stateUnread, false);
});

test('A3 ② 엣지 쿼리 — 읽기 오류만 표지(손상 · 파일 없음 · 정상은 칸 없음) · 읽기 오류 때 결과 수를 싣지 않는다', async () => {
  // 실제 진입 함수를 이 프로세스에서 부르고 보낸 주소만 받는다(중앙 응답 503 — 아무것도 적용하지 않는다)
  const W = await import('../src/agent/bmOnboardPull.js');
  const file = path.join(DIR, 'bm-onboard-applied.json');
  const sent = async () => {
    const urls = [];
    await W.pullBmOnboardNow({ fetchImpl: async (u) => { urls.push(String(u)); return { status: 503, ok: false }; } });
    assert.equal(urls.length, 1);
    return new URL(urls[0], 'http://x').searchParams;
  };
  fs.rmSync(file, { recursive: true, force: true });
  let q = await sent();
  assert.equal(q.has('unread'), false, '파일 없음(신규 설치)은 표지가 아니다');
  assert.equal(q.get('ok'), '0');
  fs.mkdirSync(file);
  q = await sent();
  assert.equal(q.get('unread'), '1', '읽기 오류');
  assert.equal(q.has('ok') || q.has('rej') || q.has('rm'), false, '못 읽은 결과 수는 싣지 않는다');
  assert.equal(q.get('applied'), '');
  assert.deepEqual([...q.keys()].sort(), ['agent', 'applied', 'unread'], '사유 · 오류 코드 칸이 없다');
  fs.rmdirSync(file);
  fs.writeFileSync(file, JSON.stringify({ sig: 'a'.repeat(32), created: {}, at: 1, result: { applied: 2, rejected: 1, removed: 0 } }));
  q = await sent();
  assert.equal(q.has('unread'), false, '읽히면 칸 없음');
  assert.deepEqual([q.get('ok'), q.get('rej'), q.get('rm'), q.get('applied')], ['2', '1', '0', 'a'.repeat(32)], '예전 쿼리 그대로');
  fs.writeFileSync(file, '{"sig":');
  q = await sent();
  assert.equal(q.has('unread'), false, '손상은 읽기 오류가 아니다(lost 경로 — 예전처럼 빈 서명 · 대기)');
  assert.equal(q.get('applied'), '');
});

test('A3 ③ 중앙 정제 · 하위 호환 — 정확히 1 만 참 · 검증된 이름에만 · 옛 엣지(칸 없음)는 표지 지움 · 모르는 칸은 거절하지 않는다', async () => {
  const flag = () => ED.onboardPullOf('Edge-A')?.stateUnread;
  let r = await pullAs(tokA, 'applied=&unread=1&zzz=1');
  assert.equal(r.status, 200, '모르는 쿼리 칸을 거절하지 않는다');
  const body = await r.json();
  assert.equal(body.distribute, true);
  assert.equal(flag(), true);
  // 옛 엣지 — 칸 없음 = 표지 지움(예전 '대기')
  assert.equal((await pullAs(tokA, 'applied=&ok=0&rej=0&rm=0')).status, 200);
  assert.equal(flag(), false);
  assert.deepEqual(ED.onboardPullOf('Edge-A').applied, { ok: 0, rejected: 0, removed: 0 }, '옛 엣지 쿼리는 예전 그대로 기록');
  // 정확히 '1' 만 — 다른 글자 · 배열은 거짓(세운 뒤 보내 지우는지까지)
  for (const v of ['unread=0', 'unread=true', 'unread=yes', 'unread=', 'unread=1&unread=1', 'unread[a]=1', 'unread=%201']) {
    await pullAs(tokA, 'applied=&unread=1');
    assert.equal(flag(), true);
    assert.equal((await pullAs(tokA, `applied=&${v}`)).status, 200);
    assert.equal(flag(), false, `${v} 는 표지가 아니다`);
  }
  // 공유 토큰(?agent= 주장)은 남의 엣지에 표지를 세우지 못한다
  const before0 = ED.onboardPullOf('Edge-A');
  r = await fetch(`http://127.0.0.1:${port}/api/central/bm-onboard?agent=Edge-A&applied=&unread=1`, { headers: { 'X-Central-Token': SHARED } });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).distribute, false);
  assert.equal(ED.onboardPullOf('Edge-A'), before0, '기록이 바뀌지 않는다');
  assert.equal(flag(), false);
});

test('A3 ④ 기록 함수 — 엄격한 true 만 · 다음 기록이 통째로 바꾼다 · 인출 기록이 없으면 화면 API 는 false(모름은 pulledAt null)', async () => {
  ED.recordOnboardPull('Edge-Z', { stateUnread: true, now: 1000 });
  assert.equal(ED.onboardPullOf('edge-z').stateUnread, true);
  for (const v of ['true', 1, {}, [true], null, undefined]) {
    ED.recordOnboardPull('Edge-Z', { stateUnread: true });
    ED.recordOnboardPull('Edge-Z', { stateUnread: v });
    assert.equal(ED.onboardPullOf('edge-z').stateUnread, false, `${JSON.stringify(v)} 는 참이 아니다`);
  }
  ED.recordOnboardPull('Edge-Z', { stateUnread: true });
  ED.recordOnboardPull('Edge-Z', {});
  assert.equal(ED.onboardPullOf('edge-z').stateUnread, false, '칸 없는 기록이 지운다');
  // 인출 기록이 없는 엣지(배포만 있음)
  assert.equal(ED.applyEdgeChanges({ upserts: [{ agent: 'edge-n', row: { name: 'g2-n', corp: 'vcE', osHost: '10.70.0.9', osUser: 'mon', osKey: 'k', mounts: ['/'], enabled: true } }] }, { by: 'adm' }).ok, true);
  const n = (await api('/api/tools/bm-usage/onboard/edge-rows')).j.agents.find((a) => a.agent === 'edge-n');
  assert.equal(n.pulledAt, null);
  assert.equal(n.stateUnread, false);
});

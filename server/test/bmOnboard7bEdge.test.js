/**
 * 7b단계 수집 경로 — 중앙 → 엣지 서버 등록 배포 **성공 왕복**(실제 centralRouter `/api/central/bm-onboard` + 실제 엣지 워커 `pullBmOnboardNow` —
 * 엣지는 자식 프로세스(자기 CONFIG_DIR · 자기 키 저장소)) · 개별 토큰만(공유 토큰 ?agent= 는 행을 받지 못한다) · 엣지가 같은 분석을 다시 거친다 ·
 * 키는 엣지 자기 저장소에서 이름으로 · 같은 서명은 건너뜀 · 결과 수 · 서명이 중앙에 남는다 · 배포에서 빼면 엣지가 **자기가 만든 항목만** 지운다 ·
 * 경계: 중앙은 엣지로 옮긴 서버를 자기 등록부에서 뺀다(같은 서버를 두 곳이 열지 않는다) · resolveTargets 경계(중앙은 agent 없는 서버만 · 엣지는 자기 것만) ·
 * 엣지가 끊겨도 auto 가 central 로 정하지 않는다.
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
const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bm7bedge-c-'));
const EDIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bm7bedge-e-'));
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = 'live';
delete process.env.CENTRAL_URL;

let srv; let port; let tokA; let SHARED; let ED; let RUN; let BM; let store;
const REGISTRY = [{ id: 'vcE', name: 'KR-EDGE', host: 'e.invalid', collectMode: 'site', remoteAgent: 'Edge-A' }, { id: 'vcC', name: 'KR-CENTRAL', host: 'c.invalid' }];

before(async () => {
  SHARED = 'shared-central-token-1234567890abcdef';
  fs.writeFileSync(path.join(DIR, 'vcenters.json'), JSON.stringify({ vcenters: REGISTRY }));
  fs.writeFileSync(path.join(DIR, 'portal.env'), `CENTRAL_TOKEN=${SHARED}\n`);
  process.env.CENTRAL_TOKEN = SHARED;
  const express = (await import('express')).default;
  const { centralRouter } = await import('../src/routes/central.js');
  ({ store } = await import('../src/store.js'));
  store.snapshot = { ...store.get(), vcenters: REGISTRY.map((v) => ({ id: v.id, name: v.name })) };
  const tokens = await import('../src/central/agentTokens.js');
  tokA = tokens.issueAgentToken('Edge-A').token;
  ED = await import('../src/bmusage/onboard/edgeDeploy.js');
  RUN = await import('../src/bmusage/onboard/onboardRun.js');
  BM = await import('../src/bmstor/registry.js');
  const app = express();
  app.use(express.json());
  app.use('/api/central', centralRouter);
  srv = http.createServer(app);
  port = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
  // 엣지 자식의 설정 — 자기 법인 vcE · 자기 키 저장소(키 이름 edge-key) · 공통 계정 edge-ops
  fs.writeFileSync(path.join(EDIR, 'bmusage-settings.json'), JSON.stringify({ enabled: true, corps: { vcE: true }, osSsh: true }));
  fs.writeFileSync(path.join(EDIR, 'vcenters.json'), JSON.stringify({ vcenters: [{ id: 'vcE', name: 'KR-EDGE', host: 'e.invalid' }] }));
});
after(() => { try { srv?.close(); } catch { /* */ } fs.rmSync(DIR, { recursive: true, force: true }); fs.rmSync(EDIR, { recursive: true, force: true }); });

/** 엣지 자식 — 한 번 인출하고 결과 · 자기 등록부를 출력. */
function edgeOnce(token, { setup = '' } = {}) {
  const code = `
    const { store } = await import(${JSON.stringify(path.join(HERE, '../src/store.js'))});
    store.snapshot = { ...store.get(), vcenters: [{ id: 'vcE', name: 'KR-EDGE' }, { id: 'vcO', name: 'OTHER-CORP' }] };   // vcO 는 이 엣지가 알지만 수집하지 않는 법인
    const VAULT = await import(${JSON.stringify(path.join(HERE, '../src/security/secretVault.js'))});
    VAULT.saveSecretsPolicy({ mode: 'encrypted', level: 1 });
    const KS = await import(${JSON.stringify(path.join(HERE, '../src/bmusage/onboard/keyStore.js'))});
    const F = await import(${JSON.stringify(path.join(HERE, './_sshKeyFixtures.js'))});
    if (!KS.keyByName('edge-key')) KS.addKey({ name: 'edge-key', privateKey: F.ed25519Key().pem }, { by: 'edge-adm' });
    if (!KS.accountByName('idrac', 'edge-idrac')) KS.saveAccount({ name: 'edge-idrac', kind: 'idrac', corp: 'vcE', username: 'ro', password: 'Edge-Idrac-1' });
    ${setup}
    const W = await import(${JSON.stringify(path.join(HERE, '../src/agent/bmOnboardPull.js'))});
    const r = await W.pullBmOnboardNow();
    const BM = await import(${JSON.stringify(path.join(HERE, '../src/bmstor/registry.js'))});
    const IDR = await import(${JSON.stringify(path.join(HERE, '../src/idrac/registry.js'))});
    const key = KS.keyByName('edge-key');
    console.log('@@' + JSON.stringify({ r, os: BM.listBmServersRaw().map((s) => ({ name: s.name, keyRef: s.keyRef, keyIsLocal: s.keyRef === key.id, vc: s.vcenterId, via: s.collectVia, agent: s.agent, password: s.password })),
      idrac: IDR.loadRegistry().map((s) => ({ name: s.name, username: s.username, hasPw: !!s.password })) }));
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

const HDR = 'name,corp,idrac_host,idrac_cred,service_tag,os_host,os_port,os_cred,os_key,collect_via,mounts,enabled,note';
const csv = (lines) => Buffer.from(`${lines.join('\r\n')}\r\n`, 'utf8');
async function centralCtx(edgeOnline) {
  const D = await RUN.defaultOnboardDeps();
  return RUN.buildOnboardCtx({ D, corps: REGISTRY.map((v) => ({ id: v.id, name: v.name })), isEdge: false, myCorps: [],
    edgeOf: (vc) => (vc === 'vcE' ? { agent: 'edge-a', online: edgeOnline } : null), rttOf: () => null,
    canView: () => true, canWrite: () => true, fullScope: true }).ctx;
}

test('① 왕복 — 중앙 등록(edge) → 엣지 인출(개별 토큰) → 엣지가 다시 분석해 자기 키 · 공통 계정 이름으로 적용 · 결과 · 서명이 중앙에 남는다', async () => {
  // 중앙에 먼저 central 로 등록돼 있던 서버를 edge 로 옮긴다 — 중앙 등록부에서 빠져야 한다
  BM.saveBmServer({ name: 'mv1', host: '10.60.0.2', username: 'root', mounts: ['/'], vcenterId: 'vcE' });
  const a = await RUN.analyzeUpload(csv([HDR,
    'e1,KR-EDGE,10.60.1.1,edge-idrac,TAGE1,10.60.0.1,,개별:mon,edge-key,edge,/;/data,,',
    'mv1,KR-EDGE,,,,10.60.0.2,,개별:mon,edge-key,edge,/,,',
    'c1,KR-CENTRAL,,,,10.61.0.1,,개별:mon,password,central,/,,',
  ]), { ctx: await centralCtx(true) });
  assert.deepEqual(a.rows.map((r) => [r.action, r.via]), [['new', 'edge'], ['update', 'edge'], ['new', 'central']], JSON.stringify(a.rows.map((r) => [r.code, r.reason])));
  const D = await RUN.defaultOnboardDeps();
  const ap = RUN.applyOnboard(a.rows, { D, by: 'adm' });
  assert.equal(ap.ok, true, JSON.stringify(ap));
  const central = BM.listBmServersRaw().map((s) => s.name);
  assert.deepEqual(central.sort(), ['c1'], '중앙은 엣지로 간 서버를 자기 등록부에 두지 않는다(두 곳이 열지 않는다)');
  const rows = ED.edgeRowsFor('edge-a');
  assert.deepEqual(rows.map((r) => r.name).sort(), ['e1', 'mv1']);
  assert.equal(JSON.stringify(rows).includes('PRIVATE KEY') || JSON.stringify(rows).includes('Edge-Idrac-1'), false);
  // 공유 토큰(?agent= 주장)은 행을 받지 못한다 — 엣지는 아무것도 바꾸지 않는다
  const sh = await edgeOnce(SHARED);
  assert.equal(sh.r.ok, true); assert.equal(sh.r.distribute, false, JSON.stringify(sh.r));
  assert.equal(sh.os.length, 0);
  // 개별 토큰 — 왕복 성공
  const e = await edgeOnce(tokA);
  assert.equal(e.r.ok, true, JSON.stringify(e.r));
  assert.equal(e.r.applied, 3, 'OS 2 + iDRAC 1');
  assert.equal(e.r.rejected, 0);
  const e1 = e.os.find((s) => s.name === 'e1');
  assert.equal(e1.keyIsLocal, true, '키는 엣지 자기 저장소의 같은 이름 키');
  assert.equal(e1.vc, 'vcE'); assert.equal(e1.via, 'edge'); assert.equal(e1.agent, '', '엣지 로컬 등록(자기가 수집)');
  assert.equal(e1.password, '');
  assert.deepEqual(e.idrac, [{ name: 'e1', username: 'ro', hasPw: true }], 'iDRAC 계정은 엣지 공통 계정에서');
  // 중앙 기록 — 다음 인출의 쿼리로 서명 · 결과 수
  const again = await edgeOnce(tokA);
  assert.equal(again.r.skipped, true, '같은 서명은 건너뛴다');
  const rec = ED.onboardPullOf('Edge-A');
  assert.equal(rec.appliedSig, ED.sigOf(ED.edgeRowsFor('edge-a')));
  assert.deepEqual(rec.applied, { ok: 3, rejected: 0, removed: 0 });
});

test('② 배포에서 빼면 엣지는 **자기가 만든 항목만** 지운다 · 엣지 관리자가 손으로 둔 항목은 남는다 · 엣지 쪽 분석이 거부하면 적용하지 않고 수를 알린다', async () => {
  // 엣지에 손으로 등록한 서버(배포와 무관) — 지우면 안 된다
  const setup = `const BMx = await import(${JSON.stringify(path.join(HERE, '../src/bmstor/registry.js'))}); if (!BMx.listBmServersRaw().some((s) => s.name === 'hand')) BMx.saveBmServer({ name: 'hand', host: '10.60.9.9', username: 'root', mounts: ['/'] });`;
  assert.equal(ED.applyEdgeChanges({ removes: [{ agent: 'edge-a', name: 'mv1' }] }, { by: 'adm' }).ok, true);
  // 엣지 저장소에 없는 키 이름을 가진 행 — 엣지 분석이 거부
  ED.applyEdgeChanges({ upserts: [{ agent: 'edge-a', row: { name: 'nokey', corp: 'vcE', osHost: '10.60.0.7', osUser: 'mon', osKey: 'missing-key', mounts: ['/'], enabled: true } }] }, { by: 'adm' });
  // 엣지가 아는 법인이지만 자기 수집 법인(로컬 corps)이 아닌 행 — 엣지 쪽 분석이 거부(중앙 목록 문자열만 믿고 남의 법인 서버를 열지 않는다)
  ED.applyEdgeChanges({ upserts: [{ agent: 'edge-a', row: { name: 'othercorp', corp: 'vcO', osHost: '10.60.0.8', osUser: 'mon', osKey: 'edge-key', mounts: ['/'], enabled: true } }] }, { by: 'adm' });
  const e = await edgeOnce(tokA, { setup });
  assert.equal(e.r.ok, true, JSON.stringify(e.r));
  assert.equal(e.r.removed, 1);
  assert.equal(e.r.rejected, 2, '키 없음 · 남의 법인');
  const names = e.os.map((s) => s.name).sort();
  assert.deepEqual(names, ['e1', 'hand'], '만든 mv1 만 지웠고 손으로 둔 hand 는 남는다 · 거부 행은 등록하지 않는다');
});

test('③ 경계 — resolveTargets: 중앙은 엣지 보고(remoteAgent) 서버를 열지 않고 엣지는 자기 것만 · auto 는 엣지가 끊겼거나 모르면 central 로 정하지 않는다', async () => {
  const T = await import('../src/bmusage/targets.js');
  const bareMetal = [{ serverId: 'sE', name: 'e1', serviceTag: 'TAGE1', vcenterId: 'vcE', remoteAgent: 'Edge-A' }, { serverId: 'sC', name: 'c1', serviceTag: 'TAGC1', vcenterId: 'vcC' }];
  const bmServers = [{ id: 'o1', name: 'e1', host: '10.60.0.1', username: 'mon', mounts: ['/'] }, { id: 'o2', name: 'c1', host: '10.61.0.1', username: 'mon', mounts: ['/'] }];
  const settings = { corps: { vcE: true, vcC: true }, osSsh: true, idracTelemetry: false };
  const c = T.resolveTargets({ bareMetal, bmServers, settings, agentName: 'central', isEdge: false });
  const e = T.resolveTargets({ bareMetal, bmServers, settings, agentName: 'Edge-A', isEdge: true });
  const o = T.resolveTargets({ bareMetal, bmServers, settings, agentName: 'Edge-B', isEdge: true });
  const keysC = c.targets.map((x) => x.name); const keysE = e.targets.map((x) => x.name);
  assert.deepEqual(keysC, ['c1']);
  assert.ok(keysE.includes('e1'));
  assert.equal(o.targets.some((x) => x.name === 'e1'), false, '다른 엣지는 열지 않는다');
  assert.equal(keysC.filter((k) => keysE.includes(k) && k === 'e1').length, 0, '같은 서버(e1)를 중앙과 엣지가 둘 다 열지 않는다');
  // auto — 엣지 끊김(false) · 모름(null) 은 거부, 엣지 없음은 central
  for (const online of [false, null]) {
    const a = await RUN.analyzeUpload(csv([HDR, 'au1,KR-EDGE,,,,10.60.3.1,,개별:mon,,auto,/,,']), { ctx: await centralCtx(online) });
    assert.equal(a.rows[0].code, 'auto-unknown', String(online));
  }
  const a2 = await RUN.analyzeUpload(csv([HDR, 'au2,KR-CENTRAL,,,,10.61.3.1,,개별:mon,,auto,/,,']), { ctx: await centralCtx(false) });
  assert.equal(a2.rows[0].via, 'central');
});

test('④ 본문 모양 — 엣지 워커는 배포 판정 칸 · 서명 꼴이 맞아야 받는다(봉투 { ok, node } 판정이 아니다) · 최소 엣지 버전은 공용 함수(숫자 박지 않음)', async () => {
  const W = await import('../src/agent/bmOnboardPull.js');
  assert.equal(W.onboardBodyOk({ ok: true, distribute: false, reason: 'unverified' }), true);
  assert.equal(W.onboardBodyOk({ ok: true, distribute: true, rows: [], sig: 'a'.repeat(32) }), true);
  for (const b of [null, { ok: true }, { ok: true, node: {} }, { ok: true, distribute: true, rows: {}, sig: 'a'.repeat(32) }, { ok: true, distribute: true, rows: [], sig: 'x' }]) assert.equal(W.onboardBodyOk(b), false, JSON.stringify(b));
  const M = await import('../src/central/featureMinEdgeVersion.js');
  assert.equal(M.STAGE7B_TITLE_RE.source, '리눅스 통합 성능 모니터링 7b단계');
  assert.match(M.stage7bMinEdgeVersion(), /^\d+\.\d+\.\d+$/);
  const src = fs.readFileSync(path.join(HERE, '../src/routes/api/bmOnboard.js'), 'utf8');
  assert.equal(/minEdgeVersion\s*=\s*['"]\d/.test(src), false, '최소 버전 숫자를 코드에 박지 않는다');
});

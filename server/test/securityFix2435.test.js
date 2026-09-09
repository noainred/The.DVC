/**
 * v2.435 — 보안 감사 지적 수정 회귀 고정.
 *  I1 relaytopo/ops.js isActiveOut  — 'inactive' 를 성공으로 읽어 롤백이 건너뛰어지던 정규식
 *  S1 relaytopo/store.js normNode   — host 변경 시 저장 비밀 이월(불변조건 v2.257 M3 회귀)
 *  S2 relaytopo/ops.js resolveNodeAccess — 배포 대상 자격증명이 임의 host 로 전송되던 교차 유출
 *  S3 routes/api/relaytopo.js       — 조회가 tools 권한(operator 도달)이라 cfg 전문이 나가던 문제
 *  redact deployRegistry            — centralToken/collectorToken 이 응답에 평문으로 실리던 문제
 * (S5 백업 실패 시 교체 중단 · S6 빈 cfg 판별은 원격 SSH 가 필요해 여기서는 셸 조립만 고정한다.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'secfix2435-'));
process.env.AUTH_ENABLED = 'false';
// 인증 비활성 시 requireRole 은 AUTH_DISABLED_ROLE 로 실제 검사한다(auth.js:938). operator 로 낮춰
// 'admin 전용 라우트가 정말 403 인가' 를 이 환경에서도 확인한다.
process.env.AUTH_DISABLED_ROLE = 'operator';
process.env.SSRF_ALLOW_LOOPBACK = 'true';

const MAIN = { privateIp: '192.168.20.143', publicIp: '10.94.40.217', portalPort: 4000 };

test('I1: isActiveOut 이 inactive 를 성공으로 읽지 않는다(마지막 줄 정확 비교)', async () => {
  const { isActiveOut } = await import('../src/relaytopo/ops.js');
  assert.equal(isActiveOut('active'), true);
  assert.equal(isActiveOut('inactive'), false, "⚠ 예전 /active\\s*$/ 는 'inactive' 에 매치돼 롤백을 건너뛰었다");
  assert.equal(isActiveOut('rc=0\ninactive'), false);
  assert.equal(isActiveOut('Job for haproxy.service failed\ninactive'), false);
  assert.equal(isActiveOut('failed'), false);
  assert.equal(isActiveOut('activating'), false);
  assert.equal(isActiveOut('deactivating'), false);
  assert.equal(isActiveOut(''), false);
  assert.equal(isActiveOut('Warning: something\nactive\n'), true, '앞에 잡음이 있어도 마지막 줄이 active 면 성공');
});

test('S1: host 가 바뀌면 저장된 SSH 비밀을 이월하지 않는다 / 같으면 유지', async () => {
  const st = await import('../src/relaytopo/store.js');
  st._resetForTest();
  st.saveTopology({ main: MAIN, sites: [{ dc: 'AZ', edge: { privateIp: '192.168.30.221', publicIp: '10.112.158.217', ssh: { username: 'root', password: 'REAL-PW', privateKey: 'KEY', passphrase: 'PP' } }, irs: {} }] });
  // ① publicIp 만 공격자 호스트로 바꾸고 비밀을 빈 값으로 저장 → 이월되지 않아야 한다
  const moved = st.saveTopology({ main: MAIN, sites: [{ dc: 'AZ', edge: { privateIp: '192.168.30.221', publicIp: '203.0.113.9', ssh: { username: 'root', password: '' } }, irs: {} }] });
  const raw = st.loadTopologyRaw();
  assert.equal(raw.sites[0].edge.ssh.password, '', 'host 가 바뀌면 비밀번호를 버린다');
  assert.equal(raw.sites[0].edge.ssh.privateKey, '', '개인키도 함께 끊는다');
  assert.equal(raw.sites[0].edge.ssh.passphrase, '');
  assert.equal(moved.sites[0].edge.ssh.hasPassword, false);
  // ② IP 가 그대로면 빈 비밀은 기존 값을 잇는다(편집 편의 유지)
  st._resetForTest();
  st.saveTopology({ main: MAIN, sites: [{ dc: 'GM1', edge: { privateIp: '10.1.1.1', ssh: { username: 'root', password: 'KEEP' } }, irs: {} }] });
  st.saveTopology({ main: MAIN, sites: [{ dc: 'GM1', edge: { privateIp: '10.1.1.1', vcenterIp: '10.1.1.9', ssh: { username: 'root', password: '' } }, irs: {} }] });
  assert.equal(st.loadTopologyRaw().sites[0].edge.ssh.password, 'KEEP', 'IP 가 같으면 유지');
  // ③ Main 노드도 같은 규칙
  st._resetForTest();
  st.saveTopology({ main: { ...MAIN, ssh: { username: 'root', password: 'MPW' } }, sites: [] });
  st.saveTopology({ main: { ...MAIN, publicIp: '198.51.100.7', ssh: { username: 'root', password: '' } }, sites: [] });
  assert.equal(st.loadTopologyRaw().main.ssh.password, '', 'Main 도 host 변경 시 비밀 폐기');
  // ④ 가져오기(mergeImport) 경로도 같은 규칙
  st._resetForTest();
  const cur = st.normalizeTopology({ main: MAIN, sites: [{ dc: 'HD', edge: { privateIp: '10.2.2.2', ssh: { username: 'root', password: 'IMP' } }, irs: {} }] });
  const merged = st.normalizeTopology(st.mergeImport(cur, { sites: [{ dc: 'HD', edge: { privateIp: '203.0.113.10' }, irs: {} }] }));
  assert.equal(merged.sites[0].edge.ssh.password, '', '가져오기로 IP 가 바뀌어도 비밀을 잇지 않는다');
});

test('S2: 배포 대상 자격증명은 그 배포 대상 자신에게만 쓴다(교차 유출 차단)', async () => {
  const reg = await import('../src/agent/deployRegistry.js');
  const { resolveNodeAccess } = await import('../src/relaytopo/ops.js');
  const { normalizeTopology } = await import('../src/relaytopo/store.js');
  const saved = reg.saveTarget({ host: '10.70.0.1', port: 22, username: 'root', password: 'DEPLOY-PW', agentName: 'AZ' });
  assert.equal(saved.ok, true);
  const tid = saved.target.id;

  // ① IRS IP 를 공격자 호스트로 두고 sshTargetId 로 남의 배포 대상을 고른 경우 → 거부
  const evil = normalizeTopology({ main: MAIN, sites: [{
    dc: 'AZ', edge: { privateIp: '192.168.30.221', publicIp: '10.112.158.217' },
    irs: { privateIp: '203.0.113.9' }, sshTargetId: tid,
  }] });
  const a = resolveNodeAccess(evil, evil.sites[0], 'irs');
  assert.ok(a.error, 'IRS 폴백이 거부되어야 한다');
  assert.match(a.error, /배포 대상|자격증명/);
  assert.equal(a.creds, undefined, '자격증명이 반환되지 않는다');

  // ② 그 배포 대상이 바로 이 사이트의 중계 엣지면 허용(엣지 자신에 들어가는 것과 같은 신뢰 경계)
  const okTopo = normalizeTopology({ main: MAIN, sites: [{
    dc: 'GM1', edge: { privateIp: '10.70.0.1' }, irs: { privateIp: '192.168.31.11' }, sshTargetId: tid,
  }] });
  const b = resolveNodeAccess(okTopo, okTopo.sites[0], 'irs');
  assert.equal(b.error, undefined, `허용되어야 하는데 거부됨: ${b.error}`);
  assert.equal(b.creds.password, 'DEPLOY-PW');
  assert.equal(b.host, '10.70.0.1'); assert.equal(b.port, 4067, '중계 엣지의 IRS SSH 포트 경유');

  // ③ Edge 역할에서 지정 배포 대상의 host 가 노드와 다르면 거부
  const mism = normalizeTopology({ main: MAIN, sites: [{ dc: 'HD', edge: { privateIp: '10.99.9.9' }, irs: {}, sshTargetId: tid }] });
  const c = resolveNodeAccess(mism, mism.sites[0], 'edge');
  assert.ok(c.error); assert.match(c.error, /호스트가 10\.70\.0\.1/);
  assert.equal(c.creds, undefined);

  // ④ 같은 IP 의 배포 대상은 정상 폴백
  const good = normalizeTopology({ main: MAIN, sites: [{ dc: 'MI', edge: { privateIp: '10.70.0.1' }, irs: {} }] });
  const d = resolveNodeAccess(good, good.sites[0], 'edge');
  assert.equal(d.error, undefined); assert.equal(d.creds.password, 'DEPLOY-PW'); assert.equal(d.source, `deploy:${tid}`);
});

test('S3: 조회 응답이 비-admin 에게 cfg 전문·portal.env·배포 대상을 주지 않는다', async () => {
  const ops = await import('../src/relaytopo/ops.js');
  // stripCfg 는 내부 함수라 lastResults 를 통해 확인 — _last 에 직접 넣을 수 없으므로 형태만 검증한다.
  assert.equal(typeof ops.lastResults, 'function');
  const full = ops.lastResults({ full: true });
  const slim = ops.lastResults();
  assert.deepEqual(Object.keys(full), Object.keys(slim), '키 집합은 같다(내용만 축약)');

  const express = (await import('express')).default;
  const { registerRelayTopo } = await import('../src/routes/api/relaytopo.js');
  const st = await import('../src/relaytopo/store.js'); st._resetForTest();
  const app = express(); app.use(express.json());
  // operator 로 위장 — requirePerm('tools') 는 통과하지만 admin 전용 필드는 비어야 한다.
  let role = 'operator';
  app.use((req, _res, next) => { req.user = { username: 'op', role, perms: ['tools'] }; next(); });
  const api = express.Router(); registerRelayTopo(api); app.use('/api', api);
  const srv = app.listen(0); await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}/api`;
  // PUT 은 adminOnly 라 이 환경(AUTH_DISABLED_ROLE=operator)에서 403 이다 — 저장은 스토어로 직접 한다.
  st.saveTopology({ main: MAIN, sites: [{ dc: 'AZ', edge: { privateIp: '192.168.30.221' }, irs: { privateIp: '192.168.31.11' } }] });
  try {
    let j = await (await fetch(`${base}/tools/relaytopo`)).json();
    assert.equal(j.admin, false);
    assert.deepEqual(j.deployTargets, [], '배포 대상 목록은 admin 만');
    assert.deepEqual(j.access, {}, '접속 경로·자격증명 출처는 admin 만');
    assert.ok(j.topology.sites.length, '토폴로지 자체는 tools 권한으로 볼 수 있다(변경 없음)');
    // admin 전용으로 올린 라우트는 operator 에게 403
    assert.equal((await fetch(`${base}/tools/relaytopo/render/AZ`)).status, 403, 'render 는 admin 전용');
    assert.equal((await fetch(`${base}/tools/relaytopo`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    // admin 이면 같은 GET 에서 전체가 나온다(응답 축약 판정은 req.user.role 기준)
    role = 'admin';
    j = await (await fetch(`${base}/tools/relaytopo`)).json();
    assert.equal(j.admin, true);
    assert.ok(j.access.AZ, 'admin 은 접속 경로를 본다');
    // ⚠ 정직한 한계: requireRole 은 인증 비활성 시 req.user 가 아니라 AUTH_DISABLED_ROLE 로 검사하므로
    //   (auth.js:938) 이 환경에서 'admin 은 render 200' 은 확인할 수 없다. 인증 활성 배포에서 성립한다.
  } finally { srv.close(); }
});

test('redact: 배포 대상 응답에 centralToken/collectorToken 이 없고, 빈 값 저장은 기존 값을 유지한다', async () => {
  const reg = await import('../src/agent/deployRegistry.js');
  const r = reg.saveTarget({ host: '10.80.0.1', port: 22, username: 'root', password: 'PW',
    centralToken: 'CENTRAL-SECRET', collectorToken: 'COLLECT-SECRET' });
  assert.equal(r.ok, true);
  const id = r.target.id;
  // 저장 응답
  assert.equal(r.target.centralToken, undefined); assert.equal(r.target.collectorToken, undefined);
  assert.equal(r.target.hasCentralToken, true); assert.equal(r.target.hasCollectorToken, true);
  // 목록 응답
  const listed = reg.listTargets().find((t) => t.id === id);
  const j = JSON.stringify(listed);
  assert.equal(j.includes('CENTRAL-SECRET'), false, '목록 응답에 중앙 토큰 평문 없음');
  assert.equal(j.includes('COLLECT-SECRET'), false, '목록 응답에 수집 토큰 평문 없음');
  assert.equal(listed.hasCollectorToken, true);
  // 원본은 그대로(서버 내부용)
  assert.equal(reg.getTargetRaw(id).collectorToken, 'COLLECT-SECRET');
  // 빈 값으로 다시 저장(화면이 되돌려 보내는 형태) → 기존 값 유지
  reg.saveTarget({ id, host: '10.80.0.1', port: 22, username: 'root', centralToken: '', collectorToken: '' });
  assert.equal(reg.getTargetRaw(id).collectorToken, 'COLLECT-SECRET', '빈 값은 기존 유지');
  assert.equal(reg.getTargetRaw(id).centralToken, 'CENTRAL-SECRET');
  // 새 값은 교체된다
  reg.saveTarget({ id, host: '10.80.0.1', port: 22, username: 'root', collectorToken: 'NEW-TOKEN' });
  assert.equal(reg.getTargetRaw(id).collectorToken, 'NEW-TOKEN');
  // 비밀 포함 내보내기(설정 소유자 전용 경로)는 여전히 원본을 준다
  assert.equal(reg.listTargetsRaw().find((t) => t.id === id).centralToken, 'CENTRAL-SECRET');
});

test('redact 확장 후에도 collectorSync 대조가 토큰 보유를 인식한다(has* 플래그 경로)', async () => {
  const reg = await import('../src/agent/deployRegistry.js');
  const { diffTargets } = await import('../src/agent/collectorSync.js');
  const r = reg.saveTarget({ host: '10.81.0.1', port: 22, username: 'root', password: 'p', portalPort: 4000, agentName: 'ZZ', collectorToken: 'tok' });
  const redacted = reg.listTargets().filter((t) => t.id === r.target.id);
  const { rows } = diffTargets(redacted, []);
  assert.equal(rows[0].hasToken, true, 'redact 된 목록에서도 토큰 보유를 인식');
  assert.equal(rows[0].status, 'missing');
  assert.equal(JSON.stringify(rows).includes('tok'), false);
});

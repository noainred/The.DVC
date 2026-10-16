/**
 * v2.741 점검 — 수정 그룹 GD1(인가·주문형 vCenter 로그인 가드).
 *   AUTHZ-01 범위 관리자가 GET /admin/permissions 의 matrix.users 와 PUT /admin/user-tools 성공 응답의 users 로
 *            범위 밖 계정의 이름·도구 재정의·설정자(by)를 보던 것(단건 PUT 은 404 존재 은닉인데 형제 응답이 우회로였다)
 *   AUTHZ-03 프로비저닝 배치 조회(getPlacement)가 인증 정지 vCenter 에도 로그인하고 거부를 기록하지 않던 것
 *            (site·비활성·점검중은 건너뛰지 않는다 — 프로비저닝 작업 자체가 그 vCenter 에 직접 로그인하는 설계)
 *   VC-05    심층 검색 게스트 탐침(guestProbe)이 엣지 위임·비활성·점검중 vCenter 에도 로그인하고 거부를 기록하지 않던 것
 *            (인증 정지 vCenter 는 수동 실행이라 시도한다 — 검증자 판단 · osScanner 수동 실행과 같은 규칙)
 *
 * 하니스: 자식 프로세스(config.js 싱글턴 — CONFIG_DIR·DATA_SOURCE 를 테스트마다 다시 가리켜야 한다).
 *   · AUTHZ-01 은 **실제 adminRouter** 를 express 에 마운트해 응답 본문을 본다(audit2607a 와 같은 하니스).
 *   · AUTHZ-03·VC-05 는 live 모드에서 **가짜 vCenter SOAP 서버**(Login → InvalidLogin fault)를 띄우고 실제 함수를 불러
 *     로그인 시도 수를 사용자명별로 센다(소스 grep 이 아니다).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');

function runChild(body, { env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2741d-'));
  const script = `
    const SRC = ${JSON.stringify(SRC + '/')};
    const fs = await import('node:fs'); const path = await import('node:path'); const http = await import('node:http');
    const CFG = process.env.CONFIG_DIR;
    const out = {};
    try { ${body} } catch (e) { out.err = String(e && e.stack || e); }
    console.log('@@' + JSON.stringify(out));
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, AUTH_ENABLED: 'false', ...env },
    encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 120_000,
  });
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 임시 디렉터리 정리 실패는 무시 */ }
  assert.equal(r.status, 0, `자식 프로세스 실패: ${(r.stderr || '').slice(-2000)}`);
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, `출력 없음: ${r.stdout.slice(-1000)} ${r.stderr.slice(-1000)}`);
  const o = JSON.parse(line.slice(2));
  assert.equal(o.err, undefined, o.err);
  return o;
}

/* 가짜 vCenter SOAP 서버 — RetrieveServiceContent 는 정상, Login 은 언제나 InvalidLogin fault. 사용자명별 Login 수를 센다. */
const FAKE_VC = `
  const logins = {};
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
      if (b.includes('<RetrieveServiceContent')) {
        res.writeHead(200, { 'content-type': 'text/xml' });
        return res.end('<?xml version="1.0"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><RetrieveServiceContentResponse><returnval><rootFolder>group-d1</rootFolder><propertyCollector>propertyCollector</propertyCollector><viewManager>ViewManager</viewManager><sessionManager>SessionManager</sessionManager><about><version>8.0</version></about></returnval></RetrieveServiceContentResponse></soapenv:Body></soapenv:Envelope>');
      }
      if (b.includes('<Login')) {
        const u = /<userName>([^<]*)</.exec(b)?.[1] || '?'; logins[u] = (logins[u] || 0) + 1;
        res.writeHead(500, { 'content-type': 'text/xml' });
        return res.end('<?xml version="1.0"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><soapenv:Fault><faultcode>ServerFaultCode</faultcode><faultstring>Cannot complete login due to an incorrect user name or password.</faultstring><detail><InvalidLoginFault xsi:type="InvalidLogin" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"/></detail></soapenv:Fault></soapenv:Body></soapenv:Envelope>');
      }
      res.writeHead(200, { 'content-type': 'text/xml' });
      res.end('<?xml version="1.0"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><LogoutResponse/></soapenv:Body></soapenv:Envelope>');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const host = 'http://127.0.0.1:' + srv.address().port;
  const L = (u) => logins[u] || 0;
`;

test('AUTHZ-01: 범위 관리자는 범위 밖 계정의 도구 재정의·설정자를 matrix.users·PUT 응답으로 볼 수 없다', () => {
  const o = runChild(`
    const express = (await import('express')).default;
    const { store } = await import(SRC + 'store.js');
    await store.refresh?.();
    const auth = await import(SRC + 'auth/auth.js');
    const perms = await import(SRC + 'auth/permissions.js');
    const { adminRouter } = await import(SRC + 'routes/admin.js');
    auth.createUser({ username: 'boss', role: 'admin', name: 'B' }, { trusted: true });
    auth.createUser({ username: 'sadm', role: 'admin', name: 'S', scope: { vcenters: ['vc-us-east'] } }, { trusted: true });
    auth.createUser({ username: 'sub', role: 'viewer', name: 'U', scope: { vcenters: ['vc-us-east'] } }, { trusted: true });
    auth.createUser({ username: 'euop', role: 'operator', name: 'E', scope: { vcenters: ['vc-eu-west'] } }, { trusted: true });
    const app = express(); app.use(express.json());
    app.use((req, _r, n) => {
      const name = req.headers['x-u'] || 'full';
      if (name === 'full') { req.user = { username: 'full', role: 'admin', scope: null }; return n(); }
      const u = auth.listUsers().find((x) => x.username === name);
      req.user = u ? { username: u.username, role: u.role, scope: u.scope } : null; n();
    });
    app.use('/api/admin', adminRouter);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = 'http://127.0.0.1:' + srv.address().port;
    const call = async (u, method, p, b) => {
      const r = await fetch(base + '/api' + p, { method, headers: { 'x-u': u, 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
      const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { j = t.slice(0, 300); }
      return { s: r.status, j };
    };
    try {
      // 전체 범위 관리자가 범위 안(sub)·범위 밖(euop) 계정에 재정의를 건다. 파일에만 남은 유령 항목(ghost)도 하나 둔다.
      out.setEu = (await call('full', 'PUT', '/admin/user-tools/euop', { mode: 'allow', tools: ['ipam'] })).s;
      out.setSub = (await call('full', 'PUT', '/admin/user-tools/sub', { mode: 'deny', tools: ['gpu'] })).s;
      perms.setUserTools('ghost', { mode: 'deny', tools: ['gpu'], by: 'boss' });

      const listed = (await call('sadm', 'GET', '/admin/users')).j;
      out.listed = listed.users.map((u) => u.username).sort();
      const p = await call('sadm', 'GET', '/admin/permissions');
      out.permS = p.s;
      out.permUsers = Object.keys(p.j.matrix.users || {}).sort();
      out.permSubBy = (p.j.matrix.users.sub || {}).by ?? null;
      out.permSubTools = (p.j.matrix.users.sub || {}).tools || null;
      out.permScoped = p.j.scoped ?? null; out.permOmitted = p.j.omittedOutOfScope ?? null; out.permByHidden = p.j.byHidden ?? null;
      out.permRaw = JSON.stringify(p.j);

      out.putOut = (await call('sadm', 'PUT', '/admin/user-tools/euop', { mode: 'deny', tools: ['gpu'] })).s;   // 기존 404 유지
      const put = await call('sadm', 'PUT', '/admin/user-tools/sub', { mode: 'deny', tools: ['gpu', 'ipam'] });
      out.putS = put.s;
      out.putUsers = Object.keys(put.j.users || {}).sort();
      out.putEntryBy = put.j.entry && put.j.entry.by;
      out.putSubBy = (put.j.users.sub || {}).by ?? null;   // 이제 설정자가 sadm 자신 — 볼 수 있는 계정이라 남는다
      out.putOmitted = put.j.omittedOutOfScope ?? null;
      out.putRaw = JSON.stringify(put.j);

      const f = await call('full', 'GET', '/admin/permissions');
      out.fullUsers = Object.keys(f.j.matrix.users || {}).sort();
      out.fullEuBy = (f.j.matrix.users.euop || {}).by ?? null;
      out.fullScoped = f.j.scoped ?? null;
      const fp = await call('full', 'PUT', '/admin/user-tools/sub', { mode: 'deny', tools: ['gpu'] });
      out.fullPutUsers = Object.keys(fp.j.users || {}).sort();
      out.fileUsers = Object.keys(perms.loadMatrix().users || {}).sort();
    } finally { srv.close(); }
  `, { env: { DATA_SOURCE: 'mock' } });
  assert.equal(o.setEu, 200); assert.equal(o.setSub, 200);
  assert.ok(!o.listed.includes('euop'), '전제: 범위 관리자 목록에 범위 밖 계정이 없다');
  assert.equal(o.permS, 200);
  // 핵심: matrix.users 키 ⊆ /admin/users 목록, 범위 밖·유령 항목 없음
  for (const k of o.permUsers) assert.ok(o.listed.includes(k), `matrix.users 에 목록 밖 계정 ${k}`);
  assert.deepEqual(o.permUsers, ['sub']);
  assert.ok(!o.permRaw.includes('euop'), '범위 밖 계정 이름이 응답 어디에도 없어야 한다');
  assert.ok(!o.permRaw.includes('ghost'), '유령 항목도 범위 계정에 싣지 않는다');
  assert.deepEqual(o.permSubTools, ['gpu']);
  assert.equal(o.permSubBy, null, '설정자(full)는 범위 관리자가 볼 수 없는 계정 — 가린다');
  assert.ok(!o.permRaw.includes('"full"'), '전체 범위 관리자 이름을 흘리지 않는다');
  assert.equal(o.permScoped, true); assert.equal(o.permOmitted, 2); assert.equal(o.permByHidden, 1);
  // PUT 응답도 같은 경계
  assert.equal(o.putOut, 404, '범위 밖 계정 단건 PUT 은 예전대로 404');
  assert.equal(o.putS, 200);
  assert.deepEqual(o.putUsers, ['sub']);
  assert.ok(!o.putRaw.includes('euop') && !o.putRaw.includes('ghost'));
  assert.equal(o.putEntryBy, 'sadm');
  assert.equal(o.putSubBy, 'sadm', '볼 수 있는 계정(자기 자신)이 설정자면 남긴다');
  assert.equal(o.putOmitted, 2);
  // 전체 범위 관리자는 예전 그대로 전량(설정자 포함), 저장 파일은 걸러지지 않는다
  assert.deepEqual(o.fullUsers, ['euop', 'ghost', 'sub']);
  assert.equal(o.fullEuBy, 'full');
  assert.equal(o.fullScoped, null);
  assert.deepEqual(o.fullPutUsers, ['euop', 'ghost', 'sub']);
  assert.deepEqual(o.fileUsers, ['euop', 'ghost', 'sub']);
});

test('AUTHZ-03: 배치 조회는 인증 정지 vCenter 에 로그인하지 않고, 거부는 주 폴러와 같은 기록에 올린다(v2.743: site 도 건너뛴다)', () => {
  const o = runChild(`
    ${FAKE_VC}
    const vcs = [
      { id: 'vc-stop', name: 'stop', host, username: 'stopuser', password: 'wrong', enabled: true },
      { id: 'vc-new', name: 'new', host, username: 'newuser', password: 'wrong', enabled: true },
      { id: 'vc-site', name: 'site', host, username: 'siteuser', password: 'pw', enabled: true, collectMode: 'site', remoteAgent: 'edge-a' },
    ];
    fs.writeFileSync(path.join(CFG, 'vcenters.json'), JSON.stringify({ vcenters: vcs }, null, 2));
    const { vcAuthGuard } = await import(SRC + 'vcenter/restClient.js');
    const { loadVcenterConfig } = await import(SRC + 'config.js');
    const { getDataSource } = await import(SRC + 'runtime-settings.js');
    const { getPlacement } = await import(SRC + 'provision/placement.js');
    out.ds = getDataSource();
    const vcOf = (id) => loadVcenterConfig().vcenters.find((v) => v.id === id);
    vcAuthGuard.markAuthStopped('vc-stop', vcOf('vc-stop'), '주 폴러 정지(합성)');
    try {
      const a = await getPlacement('vc-stop'); const b = await getPlacement('vc-stop');
      out.stop = { logins: L('stopuser'), src: a.foldersSource, src2: b.foldersSource, authStopped: a.authStopped, folders: a.folders, pools: a.resourcePools, attempts: vcAuthGuard.peekAuthStop(vcOf('vc-stop'))?.attempts };
      const n1 = await getPlacement('vc-new');
      out.new1 = { logins: L('newuser'), src: n1.foldersSource, authStopped: n1.authStopped, attempts: vcAuthGuard.peekAuthStop(vcOf('vc-new'))?.attempts ?? null };
      const n2 = await getPlacement('vc-new');
      out.new2 = { logins: L('newuser'), src: n2.foldersSource, attempts: vcAuthGuard.peekAuthStop(vcOf('vc-new'))?.attempts ?? null };
      const s1 = await getPlacement('vc-site');
      out.site = { logins: L('siteuser'), src: s1.foldersSource, stopped: !!vcAuthGuard.peekAuthStop(vcOf('vc-site')) };
    } finally { srv.close(); }
  `, { env: { DATA_SOURCE: 'live' } });
  assert.equal(o.ds, 'live');
  // 인증 정지 vCenter — 두 번 불러도 로그인 0, 사유를 싣고 기록은 그대로
  assert.equal(o.stop.logins, 0, '인증 정지 vCenter 에 로그인했다');
  assert.match(o.stop.src, /^auth-stopped: vCenter 인증 실패로 멈춰 있어/);
  assert.equal(o.stop.src2, o.stop.src);
  assert.equal(o.stop.authStopped.attempts, 1);
  assert.deepEqual(o.stop.folders, ['vm']); assert.deepEqual(o.stop.pools, ['Resources']);
  assert.equal(o.stop.attempts, 1, '읽기 전용 — 시도 수를 올리지 않는다');
  // 처음 거부된 vCenter — 1회 시도 후 같은 기록에 올라가고 다음 조회는 로그인 0
  assert.equal(o.new1.logins, 1);
  assert.match(o.new1.src, /^error: vCenter 인증 실패\(InvalidLogin\)/);
  assert.ok(o.new1.authStopped && o.new1.authStopped.attempts === 1, JSON.stringify(o.new1));
  assert.equal(o.new1.attempts, 1, '거부를 주 폴러와 같은 기록(vcAuthGuard)에 올려야 한다');
  assert.equal(o.new2.logins, 1, '기록된 뒤 다음 조회는 로그인하지 않는다');
  assert.match(o.new2.src, /^auth-stopped:/);
  // v2.743(리드 통합 — VC-03 의 형제): 생성 작업(provision/vsphere.js)이 주문형 로그인 문으로 site·비활성·점검중을 막으므로
  //   배치 칸 조회도 같은 문을 지난다 — 로그인 0, 사유 코드를 싣는다(v2.741 의 '건너뛰지 않는다' 는 생성이 직접 로그인하던 때의 판단).
  assert.equal(o.site.logins, 0, 'site vCenter 에 로그인했다');
  assert.match(o.site.src, /^skipped: site/);
  assert.equal(o.site.stopped, false);
});

test('VC-05: 게스트 탐침은 비활성·점검중·엣지 위임 vCenter 에 로그인하지 않고 사유를 싣는다 · 거부는 같은 기록에', () => {
  const o = runChild(`
    ${FAKE_VC}
    const vcs = [
      { id: 'vc-site', name: 'site', host, username: 'siteuser', password: 'pw', collectMode: 'site', remoteAgent: 'edge-a' },
      { id: 'vc-dis', name: 'dis', host, username: 'disuser', password: 'pw', enabled: false },
      { id: 'vc-maint', name: 'maint', host, username: 'maintuser', password: 'pw', maintenance: true },
      { id: 'vc-stop', name: 'stop', host, username: 'stopuser', password: 'wrong' },
      { id: 'vc-bad', name: 'bad', host, username: 'baduser', password: 'wrong' },
    ];
    fs.writeFileSync(path.join(CFG, 'vcenters.json'), JSON.stringify({ vcenters: vcs }, null, 2));
    const { vcAuthGuard } = await import(SRC + 'vcenter/restClient.js');
    const { loadVcenterConfig } = await import(SRC + 'config.js');
    const { guestProbe, PROBE_SKIP_TEXT } = await import(SRC + 'search/deepSearch.js');
    const vcOf = (id) => loadVcenterConfig().vcenters.find((v) => v.id === id);
    vcAuthGuard.markAuthStopped('vc-stop', vcOf('vc-stop'), '주 폴러 정지(합성)');
    const cands = [];
    vcs.forEach((v, i) => { for (let k = 0; k < 2; k++) cands.push({ id: v.id + ':vm-' + i + k, vcenterId: v.id, name: v.name + '-vm' + k, powerState: 'POWERED_ON', toolsStatus: 'RUNNING', guestOS: 'Ubuntu Linux' }); });
    try {
      const r = await guestProbe(cands, { type: 'gpuDriver' }, { guestUser: 'root', guestPass: 'x' });
      out.logins = { ...logins };
      out.notCollected = r.notCollected;
      out.errors = r.errors;
      out.checked = r.checked;
      out.authStopped = r.authStopped;
      out.stopAttempts = vcAuthGuard.peekAuthStop(vcOf('vc-stop'))?.attempts ?? null;
      out.badAttempts = vcAuthGuard.peekAuthStop(vcOf('vc-bad'))?.attempts ?? null;
      out.skipText = PROBE_SKIP_TEXT;
    } finally { srv.close(); }
  `, { env: { DATA_SOURCE: 'live' } });
  // 비활성·점검중·엣지 위임 — 로그인 0, 사유와 대수를 밝힌다(조용한 제외 금지)
  for (const u of ['siteuser', 'disuser', 'maintuser']) assert.equal(o.logins[u] || 0, 0, `${u} 로 로그인했다`);
  assert.deepEqual(o.notCollected.map((x) => [x.vcenterId, x.why, x.vms]).sort(), [['vc-dis', 'disabled', 2], ['vc-maint', 'maintenance', 2], ['vc-site', 'site', 2]]);
  for (const [id, why] of [['vc-dis', 'disabled'], ['vc-maint', 'maintenance'], ['vc-site', 'site']]) {
    const e = o.errors.find((x) => x.vcenterId === id);
    assert.ok(e && e.why === why && e.error.startsWith(o.skipText[why]) && /후보 2대/.test(e.error), JSON.stringify(e));
  }
  // 거부는 주 폴러와 같은 기록에 — 새로 거부된 vCenter 는 기록이 생기고, 정지 중이던 vCenter 는 시도 수가 오른다
  assert.equal(o.logins.baduser, 1);
  assert.equal(o.badAttempts, 1, '거부를 vcAuthGuard 에 기록하지 않았다');
  assert.equal(o.authStopped['vc-bad'] && o.authStopped['vc-bad'].attempts, 1);
  // 인증 정지 vCenter 는 수동 실행이라 1회 시도한다(검증자 판단) — 문구가 정지 중이었다는 사실을 말한다
  assert.equal(o.logins.stopuser, 1);
  assert.equal(o.stopAttempts, 2);
  const se = o.errors.find((x) => x.vcenterId === 'vc-stop');
  assert.match(se.error, /^로그인 실패: .*이미 멈춰 있던 vCenter.*인증 실패 기록 2회/);
  assert.equal(o.checked, 0);
});

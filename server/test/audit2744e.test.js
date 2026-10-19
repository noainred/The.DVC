/**
 * audit2744e.test.js — v2.744(3회차) 수정 그룹 GE: 권한(데모 계정 관리자 판본 남은 경로·설정 소유자 전체 범위·svcmon 로그 CSV)
 * · vCenter 로그 meta 집계.
 *
 *  AUTHZ-01  v2.743 AUTHZ-01 의 남은 형제 경로 — 라우트가 req.user?.role === 'admin' 을 직접 봐서 mock 데모 계정(요청 문맥 admin +
 *            demoGuest)이 관리자 판본(중계 토폴로지의 전 사이트 IP·SSH 계정·haproxy.cfg 원문·portal.env 발췌, HAProxy 점검 대상 주소,
 *            svcmon 엣지 소스 IP 등)을 받았다. 판정은 demoGuest.isAdminDetailUser 하나다.
 *  AUTHZ-02  설정 소유자 등급(requireSettingsOwner)은 username 만 봐서 settingsOwners 에 든 범위 관리자가 공유 CENTRAL_TOKEN 평문·
 *            백업 생성·내려받기·복원을 했다 — 이제 전체 범위 계정만 통과한다.
 *  AUTHZ-03  svcmon 결과 로그 CSV(GET /api/svcmon/log/files/:name)를 데모 계정이 받았다(v2.743 의 CSV 403 과 어긋난다).
 *  DB-03     vCenter 로그 meta() 캐시가 지나면 events 전체를 GROUP BY vcenterId 로 한 번에 훑었다 — 재귀 CTE + vCenter 별 조회 +
 *            양보(metaAsync). 결과는 예전 GROUP BY 와 같다.
 *
 * ②는 실제 authMiddleware·requireEnrolled 와 실제 api·admin·auth·svcmon 라우터를 띄워 상태코드·응답 본문으로 본다(소스 grep 아님).
 * 임시 파일은 os.tmpdir() 아래에만 만든다(저장소 안에 CONFIG_DIR 를 만들지 않는다).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const J = (p) => JSON.stringify(path.join(SRC, p));

// 순수 모듈·logs DB 도 config.js 를 거친다 — 저장소의 server/config 를 건드리지 않게 먼저 임시 CONFIG_DIR 을 잡는다.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2744e-'));
process.env.CONFIG_DIR = TMP;

// ── ① 소스 스윕(AUTHZ-01) ────────────────────────────────────────────────
/**
 * 가림·'남의 것도 본다' 판정이 role 문자열을 직접 비교하면 mock 데모 계정이 그 판정을 통과한다. routes·provision·proxy·util 을 훑어
 * 남은 직접 비교를 허용 목록(파일 → 사유)과 대조한다. 허용 목록의 사유는 아래 ③ 테스트가 실제로 확인한다(거짓 사유 금지).
 */
const ROLE_CMP = /(?:\.role|\brole)\s*(?:===|!==|==|!=)\s*['"](?:admin|super_admin)['"]|['"](?:admin|super_admin)['"]\s*(?:===|!==)\s*[\w.?]*\brole\b/;
const SWEEP_DIRS = ['routes', 'provision', 'proxy', 'util'];
const ALLOW = {
  // 저장 역할 비교 — req.user 가 아니라 대상 계정의 저장 레코드(target.role)다(관리자 계정에 기능 제한을 걸지 않는다).
  'routes/admin/users.js': { n: 1, why: 'stored-role' },
  // 같은 줄에서 isDemoGuest 로 데모 계정을 함께 뺀다 — isAdminDetailUser 와 같은 판정(③ 이 줄 내용을 확인).
  'routes/api/bulletin.js': { n: 1, why: 'demo-excluded' },
  'routes/api/userMenu.js': { n: 1, why: 'demo-excluded' },
  // 원격 접속: HTTP 는 READ_DENY '/api/remote'(모든 메서드)가 데모 계정을 라우트 앞에서 막고, WS 게이트웨이는 remoteUserIssue 가
  //   매핑 판정(mappingAccessIssue) 전에 demoGuest 를 403 으로 막는다 — 데모 계정은 이 비교에 닿지 않는다(③ 이 두 근거를 확인).
  'routes/remote.js': { n: 3, why: 'remote-blocked' },
  'proxy/registry.js': { n: 2, why: 'remote-blocked' },
  'proxy/sshGateway.js': { n: 1, why: 'remote-blocked' },
  // 큰 본문 풀 입장(파싱 허가) 판정 — 관리자 판본(응답 내용)이 아니라 '파싱할지' 이고, 통과해도 라우트·demoGuestDenial 이 다시 본다.
  'util/bigJsonGate.js': { n: 3, why: 'pool-admission' },
};

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('① AUTHZ-01 routes·provision·proxy·util 의 role 직접 비교는 허용 목록(사유)과 일치한다 — 새 가림 판정은 isAdminDetailUser 를 쓴다', () => {
  const found = {};
  for (const d of SWEEP_DIRS) {
    for (const f of walk(path.join(SRC, d))) {
      const rel = path.relative(SRC, f).split(path.sep).join('/');
      const lines = stripComments(fs.readFileSync(f, 'utf8')).split('\n');
      const hits = lines.map((l, i) => [i + 1, l]).filter(([, l]) => ROLE_CMP.test(l));
      if (hits.length) found[rel] = hits;
    }
  }
  const extra = Object.keys(found).filter((k) => !ALLOW[k]).map((k) => `${k}: ${found[k].map(([n, l]) => `${n}:${l.trim().slice(0, 100)}`).join(' | ')}`);
  assert.deepEqual(extra, [], `role 직접 비교가 허용 목록 밖에 있다 — auth/demoGuest.js isAdminDetailUser 로 바꾸거나 사유와 함께 ALLOW 에 넣을 것:\n${extra.join('\n')}`);
  for (const [k, a] of Object.entries(ALLOW)) {
    assert.equal((found[k] || []).length, a.n, `${k}: 허용한 개수(${a.n})와 다르다 — 줄이 늘었으면 판정을 다시 볼 것(${(found[k] || []).map(([n, l]) => `${n}:${l.trim()}`).join(' | ')})`);
    if (a.why === 'demo-excluded') for (const [n, l] of found[k]) assert.match(l, /isDemoGuest\(/, `${k}:${n} 데모 계정을 같은 줄에서 빼지 않는다`);
  }
  // 직접 비교를 고친 파일들은 판정 함수를 쓴다(되돌리면 ① 이 먼저 실패하지만, import 만 남고 호출이 빠진 경우도 막는다)
  for (const f of ['routes/api/relaytopo.js', 'routes/api/relaycheck.js', 'routes/svcmon/overview.js', 'routes/svcmon/edge.js', 'routes/svcmon/logs.js',
    'routes/ping.js', 'routes/api/checksLogs.js', 'routes/api/perfClient.js', 'provision/jobs.js', 'routes/api/hostHygiene.js', 'routes/api/clusterCheck.js',
    'routes/api/vmHygiene.js', 'routes/api/vmTags.js', 'routes/api/contention.js', 'routes/api/vmSeries.js', 'routes/api/overviewNsx.js']) {
    const s = stripComments(fs.readFileSync(path.join(SRC, f), 'utf8'));
    assert.match(s, /isAdminDetailUser\(/, `${f}: isAdminDetailUser 호출`);
  }
});

test('① AUTHZ-01 memo 키 — 역할에 따라 본문이 갈리는 memoJson 의 extraKey 는 역할 문자열이 아니라 판정 결과로 만든다', () => {
  for (const f of ['routes/api/hostHygiene.js', 'routes/api/clusterCheck.js', 'routes/api/vmHygiene.js', 'routes/api/vmTags.js', 'routes/api/contention.js']) {
    const s = stripComments(fs.readFileSync(path.join(SRC, f), 'utf8'));
    const keys = s.match(/extraKey:\s*`[^`]*`/g) || [];
    assert.ok(keys.length >= 1, `${f}: extraKey`);
    for (const k of keys) assert.doesNotMatch(k, /req\.user\??\.role/, `${f}: ${k} — 데모 계정과 관리자가 같은 캐시 칸을 쓴다`);
    assert.ok(keys.some((k) => /isAdminDetailUser\(req\.user\)/.test(k)), `${f}: 판정 결과(a/u)가 키에 들어간다`);
  }
});

// ── ② 실제 라우터 하니스 ─────────────────────────────────────────────────
function runHarness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2744e-h-'));
  const script = `
    const fs = await import('node:fs');
    const path = await import('node:path');
    const express = (await import('express')).default;
    const auth = await import(${J('auth/auth.js')});
    const { store } = await import(${J('store.js')});
    await store.refresh();
    // 시드 — 사람이 입력한 중계 토폴로지·SSH 결과(cfg/env)·HAProxy 점검 대상·엣지 보고(소스 IP)·svcmon 결과 로그 파일
    const topo = await import(${J('relaytopo/store.js')});
    topo.saveTopology({
      main: { name: 'Main', privateIp: '10.88.0.1', publicIp: '203.0.113.10', ssh: { username: 'mainSshUserZ', port: 22 } },
      sites: [{ dc: 'SITE-A', edge: { privateIp: '10.88.1.1', publicIp: '203.0.113.11', ssh: { username: 'edgeSshUserZ', port: 22 } }, irs: { privateIp: '10.88.1.2', ssh: { username: 'irsSshUserZ' } } }],
    });
    (await import(${J('relaytopo/ops.js')}))._setResultForTest('SITE-A', { ok: true, dc: 'SITE-A', reason: '', edge: { host: '10.88.1.1', port: 22, via: 'direct', source: 'x', error: '',
      haproxy: { cfg: 'listen stats\\n  stats auth admin:HAPROXY-SECRET-Z\\n', units: [] }, portal: { units: [], env: ['CENTRAL_URL=https://10.88.0.1:4000'] }, node: { hostname: 'edge-a', kernel: '5.x' } }, irs: null, rows: [], irsIssues: [] });
    (await import(${J('relaycheck/settings.js')})).saveSettings({ hosts: [{ host: '10.88.5.5', label: 'relay' }] });
    (await import(${J('central/svcmonEdge.js')})).ingestReport('edge-real', { snapId: Date.now(), seq: 1, total: 1, items: 0, caps: { portalPort: 4000 } }, Date.now(), { sourceIp: '10.88.9.9' });
    const { logDir } = await import(${J('svcmon/logsettings.js')});
    fs.writeFileSync(path.join(logDir(), 'results-2026-10-16.csv'), 'ts,target,host,result\\n1,REAL-TGT,10.66.1.1,ok\\n');
    // 사용자 — sadm: 범위 관리자이면서 설정 소유자(SETTINGS_OWNERS) · fadm: 전체 범위 소유자 · nadm: 전체 범위 admin(소유자 아님) · op: operator
    const mk = (u) => auth.createUser(u, { trusted: true });
    mk({ username: 'sadm', role: 'admin', password: 'Passw0rd!long1', scope: { vcenters: ['vc-us-east'] } });
    mk({ username: 'fadm', role: 'admin', password: 'Passw0rd!long1' });
    mk({ username: 'nadm', role: 'admin', password: 'Passw0rd!long1' });
    mk({ username: 'op', role: 'operator', password: 'Passw0rd!long1' });
    const tok = (name) => { const u = auth.getUser(name); const sid = 'sid-' + name; const exp = Math.floor(Date.now() / 1000) + 3600;
      const t = auth.signToken({ sub: name, role: u.role, name: u.name || name, src: 'local', tv: u.tokenVersion || 0, sid }, { exp });
      auth.noteIssuedSession({ sub: name, sid, exp }); return t; };
    const TOK = { demo: tok(auth.DEMO_USERNAME), sadm: tok('sadm'), fadm: tok('fadm'), nadm: tok('nadm'), op: tok('op') };
    const { adminRouter } = await import(${J('routes/admin.js')});
    const { api } = await import(${J('routes/api.js')});
    const { svcmonRouter } = await import(${J('routes/svcmon.js')});
    const { authRouter } = await import(${J('routes/auth.js')});
    const shared = await import(${J('routes/admin/shared.js')});
    const app = express(); app.use(express.json({ limit: '2mb' }));
    app.use('/api/auth', authRouter);
    app.use('/api/admin', auth.authMiddleware, auth.requireEnrolled, adminRouter);
    app.use('/api/svcmon', auth.authMiddleware, auth.requireEnrolled, auth.requirePerm('svcmon'), svcmonRouter);
    app.use('/api', auth.authMiddleware, auth.requireEnrolled, api);
    app.use((err, req, res, _n) => res.status(500).json({ err: String(err?.message || err) }));
    const srv = app.listen(0, '127.0.0.1'); await new Promise((r) => srv.once('listening', r));
    const base = 'http://127.0.0.1:' + srv.address().port;
    const call = async (who, method, p, body) => {
      const r = await fetch(base + p, { method, headers: { authorization: 'Bearer ' + TOK[who], 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      return { st: r.status, txt: await r.text() };
    };
    const out = { view: {}, owner: {} };
    for (const who of ['demo', 'op', 'fadm']) {
      const o = out.view[who] = {};
      for (const p of ['/api/tools/relaytopo', '/api/tools/relaycheck', '/api/svcmon/edges', '/api/svcmon/state?limit=1', '/api/svcmon/diag',
        '/api/svcmon/log/files/results-2026-10-16.csv']) o[p] = await call(who, 'GET', p);
    }
    for (const who of ['sadm', 'fadm', 'nadm']) {
      const o = out.owner[who] = {};
      o.token = await call(who, 'GET', '/api/admin/central-token');
      o.backupStatus = await call(who, 'GET', '/api/admin/backup/status');
      o.download = await call(who, 'GET', '/api/admin/backup/download/portal-backup-nonexistent.json.gz');
      o.restore = await call(who, 'POST', '/api/admin/backup/restore/portal-backup-nonexistent.json.gz', {});
      o.policy = await call(who, 'GET', '/api/admin/secrets/policy');
      o.session = await call(who, 'GET', '/api/admin/security/session');
    }
    out.owner.sadm.backupNow = await call('sadm', 'POST', '/api/admin/backup/now', {});
    // 라우터 스택 스윕 — settingsOwner 표지를 단 게이트는 전부 공용 requireSettingsOwner(전체 범위 판정 포함)여야 한다
    const sweep = { owner: 0, foreign: [] };
    const routers = [['admin', adminRouter], ['api', api], ['svcmon', svcmonRouter], ['auth', authRouter]];
    for (const [nm, r] of routers) for (const l of r.stack) {
      const rt = l.route; if (!rt) continue;
      for (const s of rt.stack) {
        if (s.handle?.gate?.kind !== 'settingsOwner') continue;
        sweep.owner++;
        if (s.handle.gate !== shared.requireSettingsOwner.gate) sweep.foreign.push(nm + ' ' + Object.keys(rt.methods).join(',') + ' ' + rt.path);
      }
    }
    out.sweep = sweep;
    // 판정 함수 직접 — ping 엣지 주소 · svcmon 로그 오류 원문 · 소유자 저장 경고
    const demoUser = auth.resolveTokenUser(TOK.demo);
    const fadmUser = auth.resolveTokenUser(TOK.fadm);
    const opUser = auth.resolveTokenUser(TOK.op);
    out.demoUser = { role: demoUser?.role, demoGuest: demoUser?.demoGuest === true };
    const { canSeeEdgeAddress } = await import(${J('routes/ping.js')});
    out.ping = { demo: canSeeEdgeAddress({ user: demoUser }), op: canSeeEdgeAddress({ user: opUser }), fadm: canSeeEdgeAddress({ user: fadmUser }) };
    const jobs = await import(${J('provision/jobs.js')});
    // 전체 범위 관리자(fadm)가 만든 작업 하나 — 데모 계정은 남의 작업을 목록·단건 어느 쪽으로도 보지 않는다(mock 이라 실제 생성 없음)
    const vm0 = (store.get().vms || [])[0];
    const cj = vm0 ? jobs.createJob({ sourceId: vm0.id, perVm: [{ name: 'ge-audit-job-1' }], guest: { ipMode: 'dhcp' } }, { user: fadmUser }) : { ok: false };
    out.jobs = { created: cj.ok === true, demo: jobs.listJobsScoped(demoUser).jobs.length, fadm: jobs.listJobsScoped(fadmUser).jobs.length,
      getDemo: cj.job ? (jobs.getJob(cj.job.id, demoUser) ? 1 : 0) : null, getFadm: cj.job ? (jobs.getJob(cj.job.id, fadmUser) ? 1 : 0) : null };
    const ops = await import(${J('routes/admin/opsSettings.js')});
    out.ownerWarn = typeof ops.scopedOwnerWarnings === 'function' ? ops.scopedOwnerWarnings(['sadm', 'fadm', 'nobody']) : null;
    // 허용 목록 근거(③) — 원격 접속은 데모 계정에 HTTP·WS 모두 막혀 있다
    const dg = await import(${J('auth/demoGuest.js')});
    const gw = await import(${J('proxy/sshGateway.js')});
    out.remote = {
      httpGet: dg.demoGuestDenial('GET', '/api/remote/mappings'), httpDel: dg.demoGuestDenial('DELETE', '/api/remote/mappings/x'),
      httpRdp: dg.demoGuestDenial('GET', '/api/remote/rdp/x'), ws: gw.remoteUserIssue(demoUser)?.code || null,
      logAnalysis: dg.demoGuestDenial('POST', '/api/admin/log-analysis/paste'),
    };
    out.configDir = process.env.CONFIG_DIR;
    srv.close();
    fs.writeFileSync(process.env.CONFIG_DIR + '/harness-out.json', JSON.stringify(out));
    console.log('@@done');
    process.exit(0);`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUTH_ENABLED: 'true', AUTH_SECRET: 'x'.repeat(40), OTP_ROLE_ENFORCE: 'false',
      SETTINGS_OWNERS: 'sadm,fadm', CENTRAL_TOKEN: 'SHARED-CENTRAL-TOKEN-ZZZ1234567890abcdef' },
    encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 240_000, maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(r.status, 0, r.stderr.slice(-2000));
  assert.ok(r.stdout.includes('@@done'), r.stdout.slice(-600) + r.stderr.slice(-600));
  return JSON.parse(fs.readFileSync(path.join(dir, 'harness-out.json'), 'utf8'));
}

let H;
const harness = () => (H ||= runHarness());
const NEEDLES = ['10.88.', '203.0.113', 'SshUserZ', 'HAPROXY-SECRET-Z', 'CENTRAL_URL'];
const hitsOf = (txt) => NEEDLES.filter((n) => txt.includes(n));

test('② AUTHZ-01 데모 계정 — 중계 토폴로지·HAProxy 점검·svcmon 엣지 응답에 시드한 IP·SSH 계정·cfg 문자열 0(operator 판본과 같다)', () => {
  const { view } = harness();
  for (const p of ['/api/tools/relaytopo', '/api/tools/relaycheck', '/api/svcmon/edges', '/api/svcmon/state?limit=1', '/api/svcmon/diag']) {
    const d = view.demo[p]; const o = view.op[p]; const f = view.fadm[p];
    assert.equal(d.st, 200, `${p} demo ${d.txt.slice(0, 160)}`);   // 조회 자체는 막지 않는다(v2.716 '조회 전부')
    assert.equal(o.st, 200, `${p} op`);
    assert.deepEqual(hitsOf(d.txt), [], `${p} 데모 계정 응답에 관리자 판본 문자열`);
    assert.deepEqual(hitsOf(o.txt), [], `${p} operator 대조`);
    assert.ok(hitsOf(f.txt).length > 0, `대조: 전체 범위 관리자는 ${p} 의 주소를 본다`);
  }
  const rt = JSON.parse(view.demo['/api/tools/relaytopo'].txt);
  assert.equal(rt.admin, false);
  assert.equal(rt.addressHidden, true);
  assert.deepEqual(rt.deployTargets, []);
  assert.deepEqual(rt.access, {});
  assert.ok(JSON.parse(view.fadm['/api/tools/relaytopo'].txt).admin === true, '대조: 관리자 판본');
  for (const p of ['/api/svcmon/edges', '/api/svcmon/state?limit=1']) assert.equal(JSON.parse(view.demo[p].txt).addressHidden, true, `${p} addressHidden`);
});

test('② AUTHZ-01 판정 함수 — ping 엣지 주소 · 프로비저닝 작업 목록은 데모 계정을 관리자로 보지 않는다', () => {
  const { ping, jobs, demoUser } = harness();
  assert.deepEqual(demoUser, { role: 'admin', demoGuest: true }, '데모 계정의 요청 문맥(전제)');
  assert.deepEqual(ping, { demo: false, op: false, fadm: true });
  assert.equal(jobs.created, true, '작업 시드(전제)');
  assert.deepEqual({ demo: jobs.demo, getDemo: jobs.getDemo }, { demo: 0, getDemo: 0 }, '데모 계정이 남의 프로비저닝 작업을 본다');
  assert.ok(jobs.fadm >= 1 && jobs.getFadm === 1, '전체 범위 관리자는 예전처럼 남의 작업도 본다');
});

test('② AUTHZ-03 svcmon 결과 로그 CSV — 데모 계정 403(데모 표지·data.csv), operator·관리자는 예전처럼 200', () => {
  const { view } = harness();
  const p = '/api/svcmon/log/files/results-2026-10-16.csv';
  assert.equal(view.demo[p].st, 403, view.demo[p].txt.slice(0, 200));
  const b = JSON.parse(view.demo[p].txt);
  assert.equal(b.demoGuest, true);
  assert.deepEqual(b.requiredPerm, ['data.csv']);
  assert.equal(view.demo[p].txt.includes('REAL-TGT'), false);
  assert.equal(view.op[p].st, 200, 'operator 는 v2.643 정책 판단 항목 — 바꾸지 않았다');
  assert.ok(view.fadm[p].txt.includes('REAL-TGT'));
});

test('② AUTHZ-02 설정 소유자 등급 — settingsOwners 에 든 범위 관리자는 공유 토큰 조회·백업 생성·내려받기·복원·비밀 정책·세션 보안 403', () => {
  const { owner } = harness();
  const s = owner.sadm;
  for (const k of ['token', 'backupStatus', 'download', 'restore', 'policy', 'session', 'backupNow']) {
    assert.equal(s[k].st, 403, `sadm ${k}: ${s[k].txt.slice(0, 200)}`);
    const b = JSON.parse(s[k].txt);
    assert.match(String(b.reason), /전체 범위/, `${k} 사유`);
    assert.equal(b.requiredOwner, undefined, `${k}: 이미 소유자인 계정에 '소유자 목록에 등록' 안내를 주지 않는다`);
  }
  assert.equal(s.token.txt.includes('SHARED-CENTRAL-TOKEN'), false, '공유 토큰 평문 0');
  assert.equal(fs.readdirSync(harness().configDir).some((f) => /^portal-backup-.*\.json\.gz$/.test(f)), false, '범위 관리자 요청으로 백업이 만들어지지 않았다');
  // 대조 — 전체 범위 소유자는 예전 그대로, 소유자가 아닌 관리자는 예전 requiredOwner 403
  assert.equal(owner.fadm.token.st, 200);
  assert.ok(owner.fadm.token.txt.includes('SHARED-CENTRAL-TOKEN'));
  for (const k of ['backupStatus', 'policy', 'session']) assert.equal(owner.fadm[k].st, 200, `fadm ${k}`);
  assert.notEqual(owner.fadm.download.st, 403, 'fadm download 는 권한이 아니라 파일 없음으로 끝난다');
  assert.equal(owner.nadm.token.st, 403);
  assert.equal(JSON.parse(owner.nadm.token.txt).requiredOwner, true);
});

test('② AUTHZ-02 라우터 스택 — settingsOwner 표지 게이트는 전부 공용 requireSettingsOwner(전체 범위 판정 포함) · 소유자 저장 경고', () => {
  const { sweep, ownerWarn } = harness();
  assert.ok(sweep.owner >= 30, `settingsOwner 게이트 라우트 수 ${sweep.owner}`);
  assert.deepEqual(sweep.foreign, [], '공용 판정이 아닌 settingsOwner 표지 게이트');
  assert.ok(Array.isArray(ownerWarn), 'scopedOwnerWarnings');
  assert.deepEqual(ownerWarn.map((w) => w.username), ['sadm'], '범위가 지정된 소유자만 경고(없는 계정·AD 는 판정하지 않는다)');
  assert.match(ownerWarn[0].reason, /전체 범위/);
});

test('③ 허용 목록 근거 — 데모 계정은 원격 접속(HTTP 전 메서드·WS)과 로그 분석 붙여넣기에 닿지 않는다', () => {
  const { remote } = harness();
  assert.ok(remote.httpGet && remote.httpDel && remote.httpRdp, `READ_DENY /api/remote ${JSON.stringify(remote)}`);
  assert.equal(remote.ws, 'demo-guest');
  assert.ok(remote.logAnalysis, 'bigJsonGate 가 파싱을 허가해도 데모 계정은 로그 분석 붙여넣기에서 거부된다');
});

// ── ④ DB-03 vCenter 로그 meta ───────────────────────────────────────────
/** 모듈 안의 Date.now 를 앞으로 민다(캐시 TTL 경과 재현). */
function withClock(offsetMs, fn) {
  const real = Date.now;
  Date.now = () => real() + offsetMs;
  return Promise.resolve().then(fn).finally(() => { Date.now = real; });
}

test('④ DB-03 meta()·metaAsync() 는 예전 GROUP BY 와 같은 결과를 표 전체 훑기 없이 낸다(재귀 CTE + vCenter 별 조회) · 양보 · 합류', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  // 실행된 SQL 기록 — 표 전체를 훑는 문장(SCAN events)이 meta 경로에 없어야 한다
  const ran = [];
  const origPrepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (sql) {
    const st = origPrepare.call(this, sql);
    for (const m of ['all', 'get', 'run', 'iterate']) {
      const f = st[m]?.bind(st);
      if (f) st[m] = (...a) => { ran.push(sql); return f(...a); };
    }
    return st;
  };
  let db;
  try {
    const { getLogsDb } = await import('../src/logs/db.js');
    db = await getLogsDb();
  } finally { DatabaseSync.prototype.prepare = origPrepare; }
  assert.equal(db.kind, 'sqlite');
  // 기준 시각은 경계에서 떨어뜨려 고정(CLAUDE.md — Date.now 를 기준으로 쓰지 않는다)
  const base = Date.UTC(2026, 0, 10, 3, 30);
  const vcs = { 'vc-b': 7, 'VC-Z': 3, 'vc-a': 12, 'vc-a2': 1, vc10: 5 };
  const recs = [];
  for (const [vc, n] of Object.entries(vcs)) for (let i = 0; i < n; i++) recs.push({ vcenterId: vc, key: `${vc}-${i}`, ts: base + i * 60_000 + vc.length, severity: 'info', type: 't', user: '', entity: 'e', message: 'm' });
  db.insertMany(recs);
  // 예전 판정(한 문장 GROUP BY)을 별도 연결로 계산해 대조한다
  const ref = new DatabaseSync(db.path);
  const oldRows = ref.prepare('SELECT vcenterId, COUNT(*) n, MAX(ts) mx FROM events GROUP BY vcenterId').all().map((x) => ({ vcenterId: x.vcenterId, count: Number(x.n), lastTs: Number(x.mx) }));
  const oldCount = Number(ref.prepare('SELECT COUNT(*) n FROM events').get().n);
  const scanned = (sql) => ref.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().some((r) => /\bSCAN events\b/.test(String(r.detail)));

  const n0 = ran.length;
  const m1 = db.meta();
  assert.deepEqual(m1.vcenters, oldRows, '순서·건수·마지막 시각이 예전 GROUP BY 와 같다');
  assert.equal(m1.count, oldCount);
  const metaSql = [...new Set(ran.slice(n0))];
  assert.ok(metaSql.length > 0, 'meta 가 실행한 문장');
  const full = metaSql.filter((s) => !/\?/.test(s) ? scanned(s) : scanned(s.replace(/\?/g, "'vc-a'")));
  assert.deepEqual(full, [], `표 전체를 훑는 문장(SCAN events)이 meta 경로에 있다: ${full.join(' | ')}`);

  // metaAsync — TTL 이 지난 뒤에도 같은 결과, vCenter 사이에 양보, 동시 호출은 한 번만 센다
  assert.equal(typeof db.metaAsync, 'function');
  await withClock(301_000, async () => {
    const n1 = ran.length;
    let yields = 0; let done = false;
    const spin = () => { if (done) return; yields += 1; setImmediate(spin); };
    setImmediate(spin);
    const [a, b] = await Promise.all([db.metaAsync({ yieldMs: 0.0001 }), db.metaAsync({ yieldMs: 0.0001 })]);
    done = true;
    assert.deepEqual(a.vcenters, oldRows);
    assert.equal(a.count, oldCount);
    assert.deepEqual(b, a, '합류한 호출은 같은 결과');
    assert.ok(yields >= 2, `vCenter 사이 양보(${yields})`);
    const cte = ran.slice(n1).filter((s) => /WITH RECURSIVE/.test(s)).length;
    assert.equal(cte, 1, `동시 호출 두 개가 vCenter 목록을 한 번만 읽는다(${cte})`);
  });
  // 계산 도중 정리(prune)가 캐시를 지우면 그 결과를 캐시에 넣지 않는다 — 다음 호출이 지운 뒤 건수를 센다
  await withClock(602_000, async () => {
    const p = db.metaAsync({ yieldMs: 0.0001 });
    assert.equal(db.pruneOldest(1), 1);
    await p;
    const after = await db.metaAsync();
    assert.equal(after.count, oldCount - 1, '정리 뒤 건수');
  });
  ref.close();
});

test('④ DB-03 호출부 — 설정 화면(logStatus)·로그 뷰어(/tools/vclogs)는 양보하는 metaAsync 를 쓴다(동기 meta 는 구버전 폴백만)', () => {
  const poller = stripComments(fs.readFileSync(path.join(SRC, 'logs/poller.js'), 'utf8'));
  const fn = /export async function logStatus\([\s\S]*?\n\}/.exec(poller);
  assert.ok(fn, 'logStatus 를 찾지 못했다');
  assert.match(fn[0], /await db\.metaAsync\(\)/, 'logStatus 가 동기 meta() 만 부른다');
  assert.doesNotMatch(fn[0], /store: db\.meta\(\)/, 'logStatus 가 동기 meta() 를 그대로 싣는다');
  const routes = stripComments(fs.readFileSync(path.join(SRC, 'routes/api/checksLogs.js'), 'utf8'));
  const r = /api\.get\('\/tools\/vclogs',[\s\S]*?\n\}\);/.exec(routes);
  assert.ok(r, '/tools/vclogs 라우트를 찾지 못했다');
  assert.match(r[0], /await db\.metaAsync\(\)/, '/tools/vclogs 가 동기 meta() 만 부른다');
  assert.doesNotMatch(r[0], /scopeLogMeta\(db\.meta\(\)/, '/tools/vclogs 가 동기 meta() 를 그대로 싣는다');
});

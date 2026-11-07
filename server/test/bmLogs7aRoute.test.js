/**
 * 7a단계 로그 분석 — **실제 api 라우터**(권한 · 범위 · 가림 · 캐시 분리) + 도구 키 집행 범위. 고정하는 규약(security-api.md 7a):
 *   · 조회 = tools + vCenter scope — 범위 교집합 먼저 · 범위 밖 · 귀속 없음(범위 계정) · 없는 키 → 404(존재 은닉) · 함대 표도 범위 안 서버만
 *   · 보안 패널(IP · 계정)과 보안 패턴 표본은 관리자 판본(isAdminDetailUser)만 원문 — 그 밖은 가림 토큰 · 표본 없음 · 다른 표본 · 이름의 주소도 가림
 *   · 응답 캐시(memoJson)는 역할 · 범위 서명으로 갈린다(관리자가 먼저 읽어도 비관리자는 가린 판본)
 *   · 경로 /tools/bm-usage/… 는 도구 키 ‘bm-usage’ 로 집행된다(새 첫 세그먼트 없음)
 * 기준 시각: 정시 −30분.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bmlog7r-'));
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = 'live';
fs.writeFileSync(path.join(DIR, 'permissions.json'), JSON.stringify({ schemaVersion: 2, matrix: { operator: ['dashboard', 'tools'], viewer: ['dashboard', 'tools'], toolsDenied: { operator: [], viewer: [] } } }));
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;
let sqlite = true; try { await import('node:sqlite'); } catch { sqlite = false; }
const syslog = (ts, msg, proc = 'sshd[1]') => { const d = new Date(ts); const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]; return `${M} ${String(d.getDate()).padStart(2, ' ')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')} h ${proc}: ${msg}`; };

async function setup(t) {
  fs.writeFileSync(path.join(DIR, 'idrac.json'), JSON.stringify({ servers: [{ id: 'ip-1', name: '10.9.8.7', host: '10.9.8.7', username: 'root', password: 'p' }] }));
  fs.writeFileSync(path.join(DIR, 'bm-storage.json'), JSON.stringify({ servers: [
    { id: 'o-a1', name: 'bm-a1', host: '127.0.0.1', port: 9, username: 'mon', password: 'pw', mounts: [] },
    { id: 'o-b1', name: 'bm-b1', host: '127.0.0.1', port: 9, username: 'mon', password: 'pw', mounts: [] },
    { id: 'o-u1', name: 'bm-u1', host: '127.0.0.1', port: 9, username: 'mon', password: 'pw', mounts: [] },
  ] }));
  fs.writeFileSync(path.join(DIR, 'bmusage-settings.json'), JSON.stringify({ enabled: true, corps: { vcA: true, vcB: true }, osSsh: true, idracTelemetry: true, includeUnassigned: true }));
  const poller = await import('../src/bmusage/poller.js');
  poller._setFleetForTest(async () => ({ bareMetal: [
    { serverId: 's-a1', name: 'bm-a1', serviceTag: 'LTAGA1', vcenterId: 'vcA' },
    { serverId: 's-b1', name: 'bm-b1', serviceTag: 'LTAGB1', vcenterId: 'vcB' },
    { serverId: 's-u1', name: 'bm-u1', serviceTag: 'LTAGU1', vcenterId: '' },
    { serverId: 'ip-1', name: '10.9.8.7', serviceTag: 'LTAGIP', vcenterId: 'vcA' },
  ], virtualizationHosts: [] }));
  (await import('../src/bmusage/settings.js'))._resetForTest();
  const { store } = await import('../src/store.js');
  store.set?.({ ...store.get(), vcenters: [{ id: 'vcA', name: 'A' }, { id: 'vcB', name: 'B' }] });
  // 로그 데이터 — 실제 쓰기 경로(buildLogWrite → logWriteBatch)
  const RUN = await import('../src/bmusage/logs/run.js');
  const S = await import('../src/bmusage/logs/store.js');
  const { config } = await import('../src/config.js');
  const tg = await poller.currentTargets();
  const keys = tg.targets.map((x) => x.key);
  const sec = [
    syslog(NOW - 40 * 60_000, 'Failed password for root from 203.0.113.45 port 51822 ssh2'),
    syslog(NOW - 39 * 60_000, 'Failed password for admin from 203.0.113.45 port 51823 ssh2'),
    syslog(NOW - 30 * 60_000, 'Accepted password for root from 10.20.1.5 port 44012 ssh2'),
    syslog(NOW - 20 * 60_000, 'kim.ops : TTY=pts/0 ; PWD=/home/kim.ops ; USER=root ; COMMAND=/usr/bin/systemctl restart postgresql', 'sudo[9]'),
    // 반증 F7 · F8 — OpenSSH 연결 식별 꼴(계정이 서명에 남던 꼴) · 메일 · 토큰이 실린 로그인 실패
    syslog(NOW - 19 * 60_000, 'Disconnected from invalid user kimops 198.51.100.10 port 40000 [preauth]'),
    syslog(NOW - 18 * 60_000, 'Connection closed by invalid user svc_backup 198.51.100.11 port 40001 [preauth]'),
    syslog(NOW - 17 * 60_000, 'login failure for user kim.ops@corp.example from 198.51.100.9 Bearer abcDEFghiJKLmnoPQR', 'vsftpd[3]'),
  ];
  // 반증 F11 — GPDB 로그인 실패는 보안(계정이 비관리자 표본으로 나가던 결함)
  const gp = `${new Date(NOW - 15 * 60_000).toISOString().slice(0, 19).replace('T', ' ')}.123 KST,"etl_loader","dw",p1,th1,10.1.1.9:5432,,,0,,,seg-1,,,,,"FATAL","28P01","password authentication failed for user ""etl_loader""",,,,,,,0,,"auth.c",1,`;
  const out = ['##JOURNAL', 'J#absent', '##DMESG', 'K#boot=3818fa4e-dde8-4491-a53a-a696101a21ab', 'K#last=-1', `K#up=1000.00`, `K#now=${Math.floor(NOW / 1000)}`,
    `K|kern  :warn  : [  900.000001] nfs: server 10.9.8.7 not responding, still trying`, 'K#n=1', 'K#rc=0',
    '##SECURE', ...sec.map((l) => `S|${l}`), 'S#ino=5', 'S#size=500', 'S#mode=inc', `S#n=${sec.length}`, 'S#off=500', '##AUDIT', 'A#svc=active', 'A#absent', '##APPLOG', 'G#dir=0', `G|${gp}`, 'G#ino=3', 'G#size=900', 'G#mode=inc', 'G#n=1', 'G#e=1', 'G#off=900', 'F#absent', '##END'].join('\n');
  const items = [];
  for (const k of keys) items.push((await RUN.buildLogWrite({ key: k, stdout: out, prev: null, now: NOW })).write);
  const w = await S.logWriteBatch({ agent: config.agent?.name || '', items });
  assert.equal(w.written, keys.length);
  const V = await import('../src/bmusage/logs/view.js');
  V._resetLogViewForTest(); await V.refreshLogSummary({ now: NOW });
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const USERS = {
    viewer: { username: 'v', role: 'viewer', scope: null },
    opA: { username: 'opa', role: 'operator', scope: { vcenters: ['vcA'] } },
    adm: { username: 'adm', role: 'admin', scope: null },
    admA: { username: 'adma', role: 'admin', scope: { vcenters: ['vcA'] } },
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => { srv.close(); poller._setFleetForTest(null); });
  const base = `http://127.0.0.1:${srv.address().port}/api/tools/bm-usage`;
  const call = async (u, p) => { const r = await fetch(`${base}${p}`, { headers: { 'x-u': u } }); return { status: r.status, body: await r.json() }; };
  return { call, keys, tg };
}

test('실제 라우터 — 범위 · 404 은닉 · 관리자 판본 가림 · 캐시 분리 · 함대 표 범위', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  const { call } = await setup(t);
  // 관리자 — 원문
  const a = await call('adm', '/perf/LTAGA1/logs?range=24h');
  assert.equal(a.status, 200, JSON.stringify(a.body).slice(0, 300));
  assert.equal(a.body.via, 'local');
  assert.ok(a.body.security.fail_ip.some((x) => x.item === '203.0.113.45'));
  assert.ok(a.body.security.fail_user.some((x) => x.item === 'admin'));
  assert.ok(a.body.security.sudo.some((x) => x.item.startsWith('kim.ops → root')));
  const secPat = a.body.patterns.find((p) => p.ruleId === 'SEC-SSH-FAIL');
  assert.ok(secPat.samples.length > 0);
  assert.equal(a.body.kpi.sec.lines, 8); assert.equal(a.body.kpi.perf.lines, 1);
  // 반증 F7 · F8 · F11 — 서명(tmpl)은 관리자 판본에도 계정 · 메일 · 토큰이 없다(표본과 같은 가림 + 계정 · 주소 치환) · ‘invalid’ 는 IP 가 아니다
  for (const p of a.body.patterns) for (const leak of ['kimops', 'svc_backup', 'kim.ops@corp.example', 'abcDEFghiJKLmnoPQR', 'etl_loader']) assert.ok(!p.tmpl.includes(leak), `서명 ${p.ruleId} 에 ${leak}: ${p.tmpl}`);
  assert.ok(!a.body.security.fail_ip.some((x) => x.item === 'invalid'), '연결 식별 꼴에서 ‘invalid’ 를 IP 로 뽑지 않는다');
  assert.equal(a.body.patterns.filter((p) => p.ruleId === 'SEC-SSH-PREAUTH').length, 2, 'Connection closed · Disconnected [preauth] = 문구 2개 → 서명 2개(계정 · 주소는 치환 — 계정마다 갈라지지 않는다)');
  assert.equal(a.body.security.totals.fail_ip, 4, '실패 = Failed 2 + 로그인 실패 1 + GPDB 인증 실패 1(사전 인증 종료 2줄은 세지 않음)');
  const gpa = a.body.patterns.find((p) => p.ruleId === 'APP-GP-AUTH-FAIL');
  assert.equal(gpa?.cls, 'sec', 'GPDB 로그인 실패 = 보안');
  assert.ok(a.body.security.fail_user.some((x) => x.item === 'etl_loader'), '관리자 보안 상위에는 계정 원문');
  assert.equal(a.body.security.auditd, 'active');
  // 비관리자(전체 범위 viewer) — 같은 URL 을 관리자가 먼저 읽었어도 가린 판본(캐시 분리)
  const v = await call('viewer', '/perf/LTAGA1/logs?range=24h');
  assert.equal(v.status, 200);
  const vs = JSON.stringify(v.body);
  for (const leak of ['203.0.113.45', '"admin"', 'kim.ops', '10.20.1.5', 'kimops', 'svc_backup', 'abcDEFghiJKLmnoPQR', 'etl_loader', '198.51.100.10']) assert.ok(!vs.includes(leak), `비관리자 응답에 ${leak}`);
  assert.equal(v.body.secHidden, true);
  assert.deepEqual(v.body.patterns.find((p) => p.ruleId === 'SEC-SSH-FAIL').samples, []);
  assert.equal(v.body.security.fail_ip[0].count, a.body.security.fail_ip[0].count, '개수는 같다');
  const nfs = v.body.patterns.find((p) => p.ruleId === 'PERF-NFS-STALL');
  assert.ok(nfs.samples.length && !nfs.samples[0].text.includes('10.9.8.7'), '다른 분류 표본의 등록부 주소 · IPv4 도 가린다');
  // 범위 — opA(vcA) 는 vcB 서버 404 · 귀속 없음 404 · vcA 는 200 · 없는 키 404(같은 문구)
  assert.equal((await call('opA', '/perf/LTAGB1/logs')).status, 404);
  assert.equal((await call('opA', '/perf/LTAGU1/logs')).status, 404, '귀속 없는 서버는 범위 계정에 없다');
  assert.equal((await call('opA', '/perf/NOPE/logs')).status, 404);
  assert.equal((await call('opA', '/perf/LTAGA1/logs')).status, 200);
  assert.equal((await call('admA', '/perf/LTAGB1/logs')).status, 404, '범위 관리자도 범위 밖은 404');
  assert.equal((await call('adm', '/perf/LTAGU1/logs')).status, 200, '전체 범위는 귀속 없음도 본다');
  // 함대 표
  const fa = await call('adm', '/logs');
  assert.equal(fa.status, 200);
  assert.deepEqual(fa.body.servers.map((s) => s.key).sort(), ['LTAGA1', 'LTAGB1', 'LTAGIP', 'LTAGU1']);
  assert.ok(fa.body.common.some((c) => c.ruleId === 'SEC-SSH-FAIL' && c.count === 4), '같은 규칙 · 같은 시간대 여러 서버 = 공통 원인 후보');
  const fo = await call('opA', '/logs');
  assert.deepEqual(fo.body.servers.map((s) => s.key).sort(), ['LTAGA1', 'LTAGIP'], '범위 밖 · 귀속 없음은 함대에도 없다');
  assert.ok(!JSON.stringify(fo.body).includes('10.9.8.7'), '비관리자에게 주소인 서버 이름은 가린다');
  assert.ok(fo.body.common.every((c) => c.servers.every((s) => !['LTAGB1', 'LTAGU1'].includes(s.key))), '공통 원인 후보도 범위 안 서버로만');
  const fv = await call('viewer', '/logs');
  assert.ok(!JSON.stringify(fv.body).includes('10.9.8.7'), '비관리자 함대 응답에 주소 이름 없음');
  assert.ok(fv.body.servers.every((s) => s.top.every((p) => p.cls !== 'sec' || p.sample === '')), '보안 표본 없음');
  for (const leak of ['kimops', 'svc_backup', 'etl_loader']) assert.ok(!JSON.stringify(fv.body).includes(leak), `비관리자 함대에 ${leak}`);
});

test('반증 F10 — 범위 계정의 함대 응답에는 자기 범위 대상이 보이는 노드만(엣지 이름 · 상태 · 시각) · 뺀 수는 밝힌다', async () => {
  const R = await import('../src/routes/api/bmLogs.js');
  const edges = [
    { agent: 'edge-kr-seoul', snapAt: NOW, snap: { logsVer: 1, targets: [{ key: 'E-A1', name: 'e-a1', vcenterId: 'vcA' }], logSummary: [{ key: 'E-A1', wasRead: true, cls: {}, top: [] }] } },
    { agent: 'edge-poland-wroclaw', snapAt: NOW, snap: { logsVer: 1, targets: [{ key: 'E-B1', name: 'e-b1', vcenterId: 'vcB' }], logSummary: [] } },
    { agent: 'edge-us-east-ashburn', snapAt: NOW, snap: { targets: [{ key: 'E-B2', name: 'e-b2', vcenterId: 'vcB' }] } },
  ];
  const deps = { listEdgeBmUsage: async () => edges, summary: async () => ({ at: NOW, list: [] }), currentTargets: async () => ({ targets: [{ key: 'L-B', name: 'l-b', vcenterId: 'vcB' }] }), bmAddressHosts: async () => [] };
  const snap = { vcenters: [{ id: 'vcA' }, { id: 'vcB' }] };
  const scoped = await R.bmLogsFleet({ user: { username: 'opa', role: 'operator', scope: { vcenters: ['vcA'] } } }, snap, deps);
  assert.deepEqual(scoped.nodes.map((n) => n.agent), ['edge-kr-seoul']);
  assert.equal(scoped.nodesOmitted, 3, '이 노드(범위 밖 대상만) + 엣지 둘'); assert.equal(scoped.scoped, true);
  assert.ok(!JSON.stringify(scoped).includes('poland') && !JSON.stringify(scoped).includes('ashburn'));
  const all = await R.bmLogsFleet({ user: { username: 'adm', role: 'admin', scope: null } }, snap, deps);
  assert.equal(all.nodes.length, 4); assert.equal(all.nodesOmitted, undefined);
});

test('비관리자 계정 꼴 가림(maskAccountForms) — role "x" · user=x · acct="x" 는 토큰(같은 값은 같은 토큰)', async () => {
  const { maskAccountForms } = await import('../src/routes/api/bmLogs.js');
  const a = maskAccountForms('FATAL: role "bob" does not exist; user=bob acct="bob"');
  assert.ok(!a.includes('bob'), a);
  assert.equal(maskAccountForms('no account here 1.2.3.4'), 'no account here 1.2.3.4');
});

test('도구 키 집행 — 새 경로는 ‘bm-usage’ 키로 집행된다(첫 세그먼트를 새로 만들지 않는다)', async () => {
  const { toolKeyForPath } = await import('../src/auth/toolAccess.js');
  // toolGate 는 /api/tools 에 마운트된다 — 경로는 /tools 아래 부분
  assert.equal(toolKeyForPath('/bm-usage/logs'), 'bm-usage');
  assert.equal(toolKeyForPath('/bm-usage/perf/LTAGA1/logs'), 'bm-usage');
});

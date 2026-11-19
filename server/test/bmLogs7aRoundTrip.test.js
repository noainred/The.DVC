/**
 * 7a단계 로그 분석 — 엣지 → 중앙 **성공 왕복**(6단계 반증 F2 교훈: pull 경로마다 bodyOk 를 명시하고 실제 collector 라우터 ↔ 실제 pull 함수로 본다) + 봉투 정제.
 *   ① 실제 collector 라우터(같은 프로세스가 엣지 역할) · 실제 수집 서버 등록부 · 실제 pullBmUsage(봉투 logsVer · logSummary 정제) · 실제 pullEdgeLogs(상세)
 *   ② 구버전 엣지(경로 없음) → old-version(최소 버전 문구는 릴리스 노트 7a 표지 — 숫자를 박지 않는다)
 *   ③ 정제(순수): 아는 필드만 · 규칙 id 카탈로그만 · 키는 같은 봉투 대상만 · 문자열 수치 → 수 · 제어문자 · 시각 clamp · 프로토타입 키
 * 기준 시각: 정시 −30분.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bmlog7t-'));
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = 'live';
process.env.COLLECTOR_TOKEN = 'tok-logs';
process.env.SSRF_ALLOW_LOOPBACK = 'true';
fs.writeFileSync(path.join(DIR, 'permissions.json'), JSON.stringify({ schemaVersion: 2, matrix: { operator: ['dashboard', 'tools'], viewer: ['dashboard', 'tools'], toolsDenied: { operator: [], viewer: [] } } }));
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;
let sqlite = true; try { await import('node:sqlite'); } catch { sqlite = false; }
const L = await import('../src/central/bmLogsPull.js');

test('① 성공 왕복 — 봉투(logsVer · logSummary) · 상세(pullEdgeLogs) · 대상 밖 키 404', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  fs.writeFileSync(path.join(DIR, 'idrac.json'), JSON.stringify({ servers: [] }));
  fs.writeFileSync(path.join(DIR, 'bm-storage.json'), JSON.stringify({ servers: [{ id: 'o-a1', name: 'bm-a1', host: '127.0.0.1', port: 9, username: 'mon', password: 'pw', mounts: [] }] }));
  fs.writeFileSync(path.join(DIR, 'bmusage-settings.json'), JSON.stringify({ enabled: true, corps: { vcA: true }, osSsh: true, idracTelemetry: false }));
  const poller = await import('../src/bmusage/poller.js');
  poller._setFleetForTest(async () => ({ bareMetal: [{ serverId: 's-a1', name: 'bm-a1', serviceTag: 'RTAGA1', vcenterId: 'vcA' }], virtualizationHosts: [] }));
  (await import('../src/bmusage/settings.js'))._resetForTest();
  const RUN = await import('../src/bmusage/logs/run.js');
  const S = await import('../src/bmusage/logs/store.js');
  const V = await import('../src/bmusage/logs/view.js');
  const { config } = await import('../src/config.js');
  const CUR = `s=${'a'.repeat(32)};i=9;b=${'b'.repeat(32)};m=1;t=1;x=1`;
  const jl = (ts, id, msg) => JSON.stringify({ __REALTIME_TIMESTAMP: String(ts * 1000), PRIORITY: '3', SYSLOG_IDENTIFIER: id, _COMM: id, MESSAGE: msg });
  const out = ['##JOURNAL', 'J#uid=1001', 'J#grp=', `J|${jl(NOW - 600_000, 'systemd', "postgresql.service: Failed with result 'exit-code'.")}`, `J#cur=${CUR}`, 'J#n=1', 'J#e=1', 'J#rc=0',
    '##JSEC', 'Q#uid=1001', 'Q#grp=', 'Q#perm=own', 'Q#n=0', 'Q#e=0', 'Q#rc=0',
    '##DMESG', 'K#absent', '##SECURE', 'S#svc=active', 'S#perm=file', '##AUDIT', 'A#svc=', 'A#perm=dir', '##APPLOG', 'G#absent', 'F#absent', '##END'].join('\n');
  const b = await RUN.buildLogWrite({ key: 'RTAGA1', stdout: out, prev: null, now: NOW });
  assert.equal((await S.logWriteBatch({ agent: config.agent?.name || '', items: [b.write] })).written, 1);
  V._resetLogViewForTest(); await V.refreshLogSummary({ now: NOW });
  const express = (await import('express')).default;
  const { collectorRouter } = await import('../src/routes/collector.js');
  const app = express(); app.use('/api/collector', collectorRouter);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const reg = await import('../src/collector/registry.js');
  assert.equal(reg.addCollector({ id: 'log-edge', name: 'log-edge', url: `http://127.0.0.1:${srv.address().port}`, token: 'tok-logs' }).ok, true);
  const E = await import('../src/central/bmUsageEdgePull.js');
  t.after(() => { srv.close(); poller._setFleetForTest(null); E._resetForTest(); });
  const env = await E.pullBmUsage('log-edge');
  assert.equal(env.ok, true, JSON.stringify(env).slice(0, 300));
  const sn = env.rec.snap;
  assert.equal(sn.logsVer, 1);
  const row = sn.logSummary.find((x) => x.key === 'RTAGA1');
  assert.ok(row, '정제를 지나 요약이 남는다');
  assert.equal(row.wasRead, true); assert.equal(row.cls.issue.lines, 1); assert.equal(row.status.sources.secure, 'perm', '권한 없음은 출처 상태로(0 이 아니다)');
  assert.equal(row.top[0].ruleId, 'ISS-UNIT-FAIL');
  // 분류별 읽기 범위(추가 수정) — 봉투 요약에 cover · 못 읽은 담는 출처가 실린다(정제를 지나도)
  assert.equal(row.cls.sec.cover, 'partial', 'journald 만 읽음 — 보안은 일부 출처만'); assert.deepEqual(row.cls.sec.missing, ['jsec', 'secure', 'audit']);
  assert.equal(row.cls.fault.cover, 'all'); assert.equal(row.cls.issue.lines, 1);
  assert.equal(row.cls.perf.cover, 'none'); assert.equal(row.cls.perf.patterns, null, '성능을 담는 출처(커널 · GPDB)를 못 읽었다 — 0 이 아니라 모름');
  // 상세 대행 — bodyOk 명시(기본 판정이면 bad-body 였다)
  const d = await L.pullEdgeLogs('log-edge', { key: 'RTAGA1', range: '24h' });
  assert.equal(d.ok, true, JSON.stringify(d).slice(0, 300));
  assert.equal(d.body.kpi.issue.lines, 1);
  assert.equal(d.body.kpi.perf.patterns, null); assert.equal(d.body.kpi.perf.cover, 'none'); assert.equal(d.body.kpi.sec.cover, 'partial');
  assert.ok(d.body.hourly.every((h) => h.perf == null), '성능 시간 칸도 모름(null) — 0 으로 그리지 않는다');
  assert.equal(d.body.read.sources.secure.status, 'perm');
  assert.equal(d.body.patterns[0].ruleId, 'ISS-UNIT-FAIL');
  assert.ok(Array.isArray(d.body.hourly) && d.body.hourly.length === 24);
  assert.equal(d.body.hourly[0].issue, null, '읽은 기록이 없는 시간 칸은 null(0 으로 채우지 않는다)');
  assert.equal(d.body.hourly.filter((h) => h.issue != null).length >= 1, true, '읽은 시간 칸은 수');
  // 반증 F9 — 엣지 대행 응답(정제 뒤)이 로컬 응답의 모양을 다 갖는다(화면이 쓰는 칸이 엣지 위임 서버에서 비지 않게)
  const local = await V.logViewFor({ key: 'RTAGA1', range: '24h', now: Date.now() });
  const paths = (o, pre = '', out = new Set()) => {
    if (Array.isArray(o)) { for (const x of o) paths(x, `${pre}[]`, out); return out; }
    if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { const p = pre ? `${pre}.${k}` : k; out.add(p); paths(v, p, out); }
    return out;
  };
  const lp = paths(local); const ep = paths(d.body);
  const missing = [...lp].filter((x) => !ep.has(x));
  assert.deepEqual(missing, [], `로컬에는 있고 엣지 대행에는 없는 칸: ${missing.join(', ')}`);
  // 화면이 실제로 쓰는 칸(BmLogsTab · bmLogsText) — 값까지
  assert.ok(d.body.rules.length > 50, '규칙 카탈로그(중앙 자기 것)'); assert.equal(d.body.rulesFrom, 'central');
  assert.ok(d.body.method.sections.includes('JSEC')); assert.ok('intervalMs' in d.body.method); assert.ok(d.body.method.authIdents.includes('sshd'));
  assert.equal(d.body.read.sources.jsec.scope, 'own'); assert.equal(d.body.read.sources.jsec.uid, 1001); assert.deepEqual(d.body.read.sources.jsec.groups, []);
  assert.equal(d.body.read.sources.secure.scope, 'file'); assert.equal(d.body.read.sources.audit.scope, 'dir');
  assert.equal(d.body.security.totals.ok, null, 'SSH 성공을 담는 출처(secure · journald 보안)를 못 읽었다 — 0 이 아니다(반증 F1)');
  assert.deepEqual(d.body.security.totalsWhy.ok.carriers, ['secure', 'jsec']); assert.equal(d.body.security.totalsWhy.ok.states.secure, 'perm');
  assert.equal(d.body.classLabel.fault, '장애'); assert.ok(d.body.corrSource && 'changes' in d.body.corrSource);
  // 풍부한 응답(보안 상위 · 집중 · 시각 모름 · 첫 읽기 · 잘림 · 감사)도 정제를 지나 모양이 같다(같은 정제 함수 — HTTP 없이)
  const sl = (ts, m) => `S|${new Date(ts).toString().slice(4, 15).replace(/ (\d{4})$/, '')} ${new Date(ts).toTimeString().slice(0, 8)} h ${m}`;
  const rich = ['##JOURNAL', `J|${jl(NOW - 40 * 86_400_000, 'app', 'I/O error, dev sdb, sector 1')}`, `J|${jl(NOW - 300_000, 'systemd', "x.service: Failed with result 'exit-code'.")}`, `J#cur=${CUR}`, 'J#n=3', 'J#e=2', 'J#rc=124',
    '##JSEC', 'Q#absent', '##DMESG', 'K#boot=3818fa4e-dde8-4491-a53a-a696101a21ab', 'K#last=10.000000', 'K#up=100.00', `K#now=${Math.floor(NOW / 1000)}`, 'K#n=0', 'K#e=0', 'K#first=7', 'K#rc=0',
    '##SECURE', 'S#svc=active', ...Array.from({ length: 25 }, (_, i) => sl(NOW - 120_000 + i * 1000, `sshd[9]: Failed password for root from 203.0.113.45 port ${4000 + i} ssh2`)),
    sl(NOW - 60_000, 'sshd[9]: Accepted publickey for gpadmin from 10.20.1.5 port 5 ssh2: RSA SHA256:x'), sl(NOW - 50_000, 'sudo[1]: kim.ops : TTY=pts/0 ; PWD=/home/kim.ops ; USER=root ; COMMAND=/usr/bin/id'),
    'S#ino=7', 'S#size=9000', 'S#mode=first', 'S#n=27', 'S#e=27', 'S#part=12', 'S#off=8988',
    '##AUDIT', 'A#svc=active', `A|type=AVC msg=audit(${Math.floor((NOW - 30_000) / 1000)}.100:5): avc:  denied  { read } for  pid=1 comm="httpd" tclass=file permissive=0`, 'A#ino=8', 'A#size=100', 'A#mode=inc', 'A#n=1', 'A#e=1', 'A#off=100',
    '##APPLOG', 'G#perm=dir', 'F#absent', '##END'].join('\n');
  const b2 = await RUN.buildLogWrite({ key: 'RICH', stdout: rich, prev: null, now: NOW });
  assert.equal((await S.logWriteBatch({ agent: config.agent?.name || '', items: [b2.write] })).written, 1);
  const lr = await V.localLogView({ key: 'RICH', range: '24h', now: NOW, cfg: { lineCap: 5000 }, intervalMs: 300_000, ops: { changes: [{ ts: NOW - 60_000, kind: 'pkg', item: 'kernel' }], focus: [{ id: 'f1', start: NOW - 60_000, end: NOW, status: 'done' }] } });
  const sr = L.sanitizeLogView(JSON.parse(JSON.stringify(lr)), Date.now());
  const miss2 = [...paths(lr)].filter((x) => !paths(sr).has(x));
  assert.deepEqual(miss2, [], `풍부한 응답에서 정제가 버린 칸: ${miss2.join(', ')}`);
  assert.ok(sr.security.fail_ip.length && sr.security.bursts.length, '보안 상위 · 집중');
  assert.equal(sr.read.sources.journal.partial, 'timeout'); assert.equal(sr.read.sources.kernel.older, 7); assert.equal(sr.read.sources.secure.partial, 12);
  assert.equal(sr.read.bySrc.journal.undated, 1, '시각 모름(40일 전)은 분류하지 않고 센다');
  assert.equal(sr.kpi.fault.cover, 'partial'); assert.deepEqual(sr.kpi.fault.missing, ['gpdb'], 'GPDB 로그 폴더 권한 없음 — 장애 · 성능 · 이슈는 일부 출처만');
  assert.deepEqual(sr.classCarriers, lr.classCarriers);
  const nf = await L.pullEdgeLogs('log-edge', { key: 'NOPE' });
  assert.equal(nf.ok, false); assert.notEqual(nf.kind, 'bad-body', '대상 밖 키는 엣지가 404 로 답한다(왕복 성공)');
});

test('② 구버전 엣지(경로 없음) → old-version · 최소 버전은 릴리스 노트 7a 표지(없으면 지금 판)', async (t) => {
  const express = (await import('express')).default;
  const app = express();
  app.get('/api/collector/bm-usage', (req, res) => res.json({ ok: true, node: { agent: 'old', version: '2.900.0' } }));
  app.use((req, res) => res.status(404).json({ ok: false }));
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => srv.close());
  const reg = await import('../src/collector/registry.js');
  reg.addCollector({ id: 'old-edge', name: 'old-edge', url: `http://127.0.0.1:${srv.address().port}`, token: 'tok-logs' });
  const r = await L.pullEdgeLogs('old-edge', { key: 'X' });
  assert.equal(r.ok, false); assert.equal(r.kind, 'old-version', JSON.stringify(r));
  const F = await import('../src/central/featureMinEdgeVersion.js');
  assert.match(String(F.STAGE7A_TITLE_RE), /7a단계/);
  const tmp = path.join(DIR, 'notes.json');
  fs.writeFileSync(tmp, JSON.stringify({ notes: [{ version: '2.950.0', title: '리눅스 통합 성능 모니터링 7a단계(로그 분석)' }, { version: '2.951.0', title: '리눅스 통합 성능 모니터링 7a단계 정정' }] }));
  F._resetFeatureMinEdgeVersionForTest(F.STAGE7A_TITLE_RE);
  assert.equal(F.stage7aMinEdgeVersion({ notesFile: tmp }), '2.950.0');
  F._resetFeatureMinEdgeVersionForTest(F.STAGE7A_TITLE_RE);
  assert.equal(F.stage7aMinEdgeVersion({ notesFile: path.join(DIR, 'none.json'), fallback: () => '2.999.1' }), '2.999.1', '노트에 없으면 지금 판(숫자를 박지 않는다)');
  F._resetFeatureMinEdgeVersionForTest(F.STAGE7A_TITLE_RE);
});

test('③ 정제 — 아는 필드만 · 규칙 id 카탈로그만 · 대상 밖 키 버림 · 수 · 제어문자 · 시각 clamp · 프로토타입 · 봉투 상한', async () => {
  const now = NOW;
  const evil = [
    { key: 'K1', at: now + 10 * 86_400_000, cls: { fault: { patterns: '2', lines: '5' }, perf: 'x', __proto__: { polluted: 1 } }, read: '10', trunc: null, secHigh: 'abc',
      top: [{ sig: 'abcdef0123456789', ruleId: 'HW-MCE', cls: 'fault', severity: 'critical', count: '3', last: now + 99 * 86_400_000, tmpl: 'x\u0000y\u001b[31m', sample: 's'.repeat(900), src: 'kernel', extra: 'drop' },
        { sig: 'abcdef0123456789', ruleId: 'EVIL-RULE', cls: 'fault' }, { sig: '../../etc', ruleId: 'HW-MCE' }],
      status: { sources: { journal: 'ok', kernel: 'pwned', secure: 'perm' }, ended: true }, injected: '<script>' },
    { key: 'NOT-MINE', cls: {} }, 'str', null, { key: { toString: 1 } },
  ];
  const r = L.sanitizeLogSummary(evil, { targetKeys: new Set(['K1']), now });
  assert.equal(r.list.length, 1); assert.equal(r.dropped, 4);
  const x = r.list[0];
  assert.equal(x.at, now, '미래 시각은 수신 시각으로'); assert.equal(x.cls.fault.patterns, 2); assert.equal(x.cls.fault.lines, 5);
  assert.deepEqual(x.cls.perf, { patterns: null, lines: null }, '모르는 모양은 null(0 아님)');
  assert.equal(x.read, 10); assert.equal(x.trunc, null); assert.equal(x.secHigh, null);
  assert.equal(x.top.length, 1, '모르는 규칙 · 서명 꼴 밖은 버린다');
  assert.ok(!/[\u0000-\u001f]/.test(x.top[0].tmpl)); assert.equal(x.top[0].sample.length, 300); assert.equal(x.top[0].last, now); assert.equal(x.top[0].extra, undefined);
  assert.equal(x.status.sources.kernel, null); assert.equal(x.status.sources.secure, 'perm');
  assert.equal(x.injected, undefined); assert.equal(({}).polluted, undefined);
  // 상세 본문
  const v = L.sanitizeLogView({ ok: true, key: 'K1', range: 'x', patterns: [{ sig: 'abcdef0123456789', ruleId: 'NOPE', cls: 'evil', severity: 'boom', evidence: ['K1', 'ZZ'], samples: [{ ts: now, text: 'a\u0007b' }], corr: { playbook: 'use:disk; rm -rf', health: 'oom', faults: 'yes' } }],
    hourly: [{ t: now, fault: '1', perf: null }], read: { sources: { journal: { status: 'weird', n: '3' } }, cut: '<b>' }, security: { fail_ip: [{ item: '203.0.113.45', count: '2' }], evil: [{ item: 'x' }], bursts: [{ ip: '1.2.3.4', count: 21 }] } }, now);
  assert.equal(v.range, '24h'); assert.equal(v.patterns[0].ruleId, ''); assert.equal(v.patterns[0].cls, 'issue'); assert.equal(v.patterns[0].severity, 'info');
  assert.deepEqual(v.patterns[0].evidence, ['K1']); assert.equal(v.patterns[0].samples[0].text, 'a b');
  assert.equal(v.patterns[0].corr.playbook, undefined, '연계 표지도 꼴 검사'); assert.equal(v.patterns[0].corr.health, 'oom'); assert.equal(v.patterns[0].corr.faults, undefined);
  assert.equal(v.hourly[0].fault, 1); assert.equal(v.hourly[0].perf, null);
  assert.equal(v.read.sources.journal.status, 'missing'); assert.equal(v.read.sources.journal.n, 3); assert.equal(v.read.cut, null);
  assert.equal(v.security.fail_ip[0].count, 2); assert.equal(v.security.evil, undefined);
  assert.equal(L.logViewBodyOk({ ok: true, node: {} }), false, '봉투 모양은 상세가 아니다');
  // 반증 F7 — 엣지가 보낸 서명(예전 판 · 다른 판)도 중앙이 같은 가림을 다시 댄다(상세 · 봉투 요약 둘 다)
  const vm = L.sanitizeLogView({ ok: true, patterns: [{ sig: 'abcdef0123456789', cls: 'sec', ruleId: 'SEC-SSH-PREAUTH', tmpl: 'Connection closed by invalid user svc_backup <ip> port <n> [preauth]' }], hourly: [] }, now);
  assert.equal(vm.patterns[0].tmpl, 'Connection closed by invalid user <user> <ip> port <n> [preauth]');
  const sm = L.sanitizeLogSummary([{ key: 'K1', top: [{ sig: 'abcdef0123456789', ruleId: 'SEC-SSH-PREAUTH', cls: 'sec', tmpl: 'Disconnected from invalid user kimops <ip> port <n> [preauth]' }] }], { targetKeys: new Set(['K1']), now });
  assert.ok(!sm.list[0].top[0].tmpl.includes('kimops'));
  // 봉투 바이트 상한 — 로그 요약은 표본 · 서명 글자 → 상위 패턴 순으로 줄이고(분류별 개수는 남김) logsTruncated 로 밝힌다
  const EP = await import('../src/bmusage/edgePull.js');
  const big = { node: {}, perf: [], logSummary: Array.from({ length: 40 }, (_, i) => ({ key: `k${i}`, cls: { fault: { patterns: 1, lines: 2 } }, top: [{ sig: 'a'.repeat(16), ruleId: 'HW-MCE', sample: 'x'.repeat(160), tmpl: 'y'.repeat(120) }] })) };
  const f1 = EP.fitEnvelope(big, 6_000);
  assert.equal(f1.logsTruncated.level, 'compact'); assert.equal(f1.logSummary[0].top[0].sample, undefined); assert.equal(f1.logSummary[0].top[0].ruleId, 'HW-MCE');
  const f2 = EP.fitEnvelope(big, 3_000);
  assert.equal(f2.logsTruncated.level, 'dropped'); assert.deepEqual(f2.logSummary[0].top, []); assert.equal(f2.logSummary[0].cls.fault.lines, 2);
  assert.equal(EP.fitEnvelope(big, 10_000_000).logsTruncated, undefined, '상한 안이면 그대로');
  assert.equal(L.logViewBodyOk({ ok: true, patterns: [], hourly: [] }), true);
});

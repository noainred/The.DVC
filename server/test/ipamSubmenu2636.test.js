/**
 * v2.636 — IP관리 서브메뉴의 서버 쪽(사용자 요청 2026-09-28: IPMS 설정·추천 30선·대용량 CSV·스캔 상태·스캔 로그를 각각의 페이지로).
 *   ① 스캔 실행 로그(ipam/scanLog.js) — 기록·연속 skip 합치기·상한·필터·파일 영속
 *   ② IP 관리상태 + 메모·태그 CSV(ipam/manageCsv.js) — '헤더에 있는 열만 바꾼다' · 빈 칸 = 지움 · 모르는 값은 오류(조용히 고치지 않음)
 *      · 파일 안 중복 IP · lineOffset(청크) · 범위 판정은 호출부 verdict 하나
 *   ③ 에이전트별 스캔 대역 CSV(ipam/scanRangesCsv.js) — 교체/추가 · 오류 줄이 있는 에이전트는 통째로 막는다 · 이 포탈 별칭
 *   ④ 라우트(실제 api·adminRouter 를 express 에 마운트) — 권한·범위·왕복·적용·감사 로그·스캔 로그 기록
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipam2636-'));
  const script = `
    const SRC = ${JSON.stringify(SRC + '/')};
    const fs = await import('node:fs'); const path = await import('node:path');
    const express = (await import('express')).default;
    const { store } = await import(SRC + 'store.js');
    await store.refresh?.();
    const auth = await import(SRC + 'auth/auth.js');
    const { api } = await import(SRC + 'routes/api.js');
    const { adminRouter } = await import(SRC + 'routes/admin.js');
    auth.createUser({ username: 'sadm', role: 'admin', name: 'S', scope: { vcenters: ['vc-us-east'] } }, { trusted: true });
    auth.createUser({ username: 'viewer1', role: 'viewer', name: 'V' }, { trusted: true });
    auth.createUser({ username: 'euop', role: 'admin', name: 'E', scope: { vcenters: ['vc-eu-west'] } }, { trusted: true }); // v2.643: CSV 는 관리자 이상 — 범위 판정을 보려면 범위 admin 이어야 한다
    const app = express(); app.use(express.json({ limit: '5mb' }));
    app.use((req, _r, n) => {
      const name = req.headers['x-u'] || 'full';
      if (name === 'full') { req.user = { username: 'full', role: 'admin', scope: null }; return n(); }
      const u = auth.listUsers().find((x) => x.username === name);
      req.user = u ? { username: u.username, role: u.role, scope: u.scope } : null; n();
    });
    app.use('/api/admin', adminRouter); app.use('/api', api);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = 'http://127.0.0.1:' + srv.address().port;
    const call = async (u, method, p, b) => {
      const r = await fetch(base + '/api' + p, { method, headers: { 'x-u': u, 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
      const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { j = t; }
      return { s: r.status, j, h: Object.fromEntries(r.headers.entries()) };
    };
    const CFG = process.env.CONFIG_DIR;
    const readJson = (f) => { try { return JSON.parse(fs.readFileSync(path.join(CFG, f), 'utf8')); } catch { return null; } };
    const out = {};
    try { ${body} } catch (e) { out.err = String(e && e.stack || e); } finally { srv.close(); }
    console.log('@@' + JSON.stringify(out));
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUTH_ENABLED: 'false', ...env },
    encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 180_000,
  });
  assert.equal(r.status, 0, `자식 프로세스 실패: ${(r.stderr || '').slice(-2000)}`);
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, `출력 없음: ${r.stdout.slice(-1000)} ${r.stderr.slice(-1000)}`);
  const o = JSON.parse(line.slice(2));
  assert.equal(o.err, undefined, o.err);
  return o;
}

// ── ① 스캔 실행 로그 ─────────────────────────────────────────────────────────────
test('① 스캔 로그: 기록·레벨·연속 skip 합치기·모르는 이벤트 거부·필터·파일 영속', () => {
  const o = runChild(`
    const L = await import(SRC + 'ipam/scanLog.js');
    L._resetScanLogForTest();
    out.bad = L.recordScanLog({ event: 'nope' });
    L.recordScanLog({ event: 'start', trigger: 'manual', ranges: 3, rangesSample: ['10.0.0.0/24', '10.0.1.0/24'], message: '시작' });
    L.recordScanLog({ event: 'finish', trigger: 'manual', scanned: '256', alive: 12, durationMs: 1500 });
    L.recordScanLog({ event: 'skip', message: '꺼져 있음' });
    L.recordScanLog({ event: 'skip', message: '꺼져 있음' });
    L.recordScanLog({ event: 'skip', message: '꺼져 있음' });
    L.recordScanLog({ event: 'fail', agent: 'Edge-A', message: 'x'.repeat(900) });
    L.recordScanLog({ event: 'report', agent: 'edge-a', scanned: null, alive: 'abc' });
    const all = L.listScanLog({ limit: 50 });
    out.all = all;
    out.byAgent = L.listScanLog({ agent: 'EDGE-A' }).entries.map((e) => e.event);
    out.byLevel = L.listScanLog({ level: 'error' }).entries.map((e) => e.event);
    out.byEvent = L.listScanLog({ event: 'skip' }).entries.length;
    out.limit1 = L.listScanLog({ limit: 1 });
    await new Promise((r) => setTimeout(r, 20));
    out.file = readJson(L.SCAN_LOG_FILE_NAME);
    out.events = L.SCAN_LOG_EVENTS;
  `);
  assert.equal(o.bad, null, '모르는 이벤트는 기록하지 않는다');
  const ev = o.all.entries.map((e) => e.event);
  assert.deepEqual(ev, ['report', 'fail', 'skip', 'finish', 'start'], '최신이 먼저 · 연속 skip 3건은 한 줄');
  const skip = o.all.entries.find((e) => e.event === 'skip');
  assert.equal(skip.count, 3); assert.ok(skip.lastAt >= skip.at);
  assert.equal(o.all.entries.find((e) => e.event === 'fail').level, 'error');
  assert.equal(skip.level, 'warn');
  assert.equal(o.all.entries.find((e) => e.event === 'start').level, 'info');
  assert.equal(o.all.entries.find((e) => e.event === 'finish').scanned, 256, '숫자 문자열은 숫자로');
  const rep = o.all.entries.find((e) => e.event === 'report');
  assert.equal(rep.scanned, null, '못 읽은 수치는 null(0 으로 채우지 않는다)');
  assert.equal(rep.alive, null);
  assert.ok(o.all.entries.find((e) => e.event === 'fail').message.length <= 300, '문구 300자 상한');
  assert.deepEqual(o.byAgent, ['report', 'fail'], '에이전트 필터는 대소문자 무시');
  assert.deepEqual(o.byLevel, ['fail']);
  assert.equal(o.byEvent, 1);
  assert.equal(o.limit1.entries.length, 1); assert.equal(o.limit1.matched, 5); assert.equal(o.limit1.truncated, true, '상한으로 잘렸으면 밝힌다');
  assert.ok(Array.isArray(o.file) && o.file.length === 5, '파일로 영속');
  assert.ok(o.events.includes('reject') && o.events.includes('settings'));
});

// ── ② IP 관리상태 CSV(순수) ─────────────────────────────────────────────────────
test('② 관리상태 CSV: 헤더에 있는 열만 · 빈 칸 = 지움 · 모르는 값은 오류 · 중복 · lineOffset · 범위 verdict', async () => {
  const M = await import('../src/ipam/manageCsv.js');
  const cur = {
    '10.0.0.1': { status: 'active', owner: 'A', label: 'L', note: 'n' },
    '10.0.0.2': { status: 'reserved', reservedUntil: '2026-12-31T15:00:00.000Z' },
  };
  const ann = { '10.0.0.1': { memo: 'm', tags: ['x'] } };
  const ctx = {
    getOverride: (ip) => cur[ip] || null, getAnnotation: (ip) => ann[ip] || null,
    resolveVc: (s) => (s === 'VC East' || s === 'vc-us-east' ? 'vc-us-east' : null),
    verdict: (ip) => (ip === '10.0.9.9' ? { reason: '범위 밖' } : null),
    statuses: ['active', 'reserved', 'deprecated'], deviceTypes: ['server', 'switch'],
    dayOf: (iso) => (iso === '2026-12-31T15:00:00.000Z' ? '2026-12-31' : String(iso).slice(0, 10)),
  };
  // (a) 메모만 있는 파일은 상태를 건드리지 않는다
  const p1 = M.parseManageCsv('ip,memo\n10.0.0.1,새 메모\n');
  assert.equal(p1.error, null);
  assert.deepEqual(p1.columns, ['ip', 'memo']);
  const a1 = M.analyzeManageImport(p1.rows, p1.columns, ctx);
  assert.equal(a1.report[0].action, 'update');
  assert.deepEqual(a1.report[0].changes, ['memo']);
  assert.equal(a1.plans[0].override, null, '메모만 고친 파일은 관리상태를 바꾸지 않는다');
  assert.deepEqual(a1.plans[0].annotation, { memo: '새 메모', tags: ['x'] }, '태그 열이 없으면 기존 태그 유지');
  // (b) 빈 칸 = 지움, 전부 비면 clear
  const p2 = M.parseManageCsv('ip,status,owner,label,note,memo,tags\n10.0.0.1,,,,,,\n');
  const a2 = M.analyzeManageImport(p2.rows, p2.columns, ctx);
  assert.equal(a2.report[0].action, 'clear');
  assert.equal(a2.plans[0].override.status, '');
  // (c) 모르는 상태·디바이스·날짜·vCenter 는 오류(조용히 고치지 않는다)
  const p3 = M.parseManageCsv('ip,status,deviceType,reservedUntil,vcenter\n10.0.0.3,resrved,server,,\n10.0.0.4,active,toaster,,\n10.0.0.5,active,,2026-02-30,\n10.0.0.6,active,,,없는VC\n');
  const a3 = M.analyzeManageImport(p3.rows, p3.columns, ctx);
  assert.deepEqual(a3.report.map((r) => r.action), ['error', 'error', 'error', 'error']);
  assert.match(a3.report[0].reason, /상태 'resrved'/);
  assert.match(a3.report[1].reason, /디바이스/);
  assert.match(a3.report[2].reason, /YYYY-MM-DD/);
  assert.match(a3.report[3].reason, /알 수 없는 vCenter/);
  assert.equal(a3.plans.length, 0);
  // (d) 새 IP 는 create, 이름으로 vCenter, 파일 안 중복은 두 번째 행 오류, 잘못된 IP 오류, 선행 0 은 정규형으로
  const p4 = M.parseManageCsv('ip,status,vcenter\n10.0.0.7,reserved,VC East\n10.0.0.7,active,\n010.000.000.008,active,\nnot-ip,active,\n', { lineOffset: 100 });
  const a4 = M.analyzeManageImport(p4.rows, p4.columns, ctx);
  assert.equal(a4.report[0].action, 'create');
  assert.equal(a4.plans[0].override.claimedVcenterId, 'vc-us-east');
  assert.equal(a4.report[1].action, 'error'); assert.match(a4.report[1].reason, /두 번/);
  assert.equal(a4.report[2].ip, '10.0.0.8', '선행 0 표기는 정규형으로 저장');
  assert.equal(a4.report[3].action, 'error');
  assert.equal(a4.report[0].line, 102, 'lineOffset 이 원래 파일의 행 번호를 맞춘다(헤더 = 1행)');
  // (e) 값이 같으면 same(적용 안 함) — 예약 만료는 날짜로 비교
  const p5 = M.parseManageCsv('ip,status,reservedUntil\n10.0.0.2,reserved,2026-12-31\n');
  const a5 = M.analyzeManageImport(p5.rows, p5.columns, ctx);
  assert.equal(a5.report[0].action, 'same'); assert.equal(a5.plans.length, 0);
  // (f) 범위 verdict 가 거부하면 오류, 적용 목록에 없다
  const p6 = M.parseManageCsv('ip,status\n10.0.9.9,active\n');
  const a6 = M.analyzeManageImport(p6.rows, p6.columns, ctx);
  assert.equal(a6.report[0].action, 'error'); assert.equal(a6.plans.length, 0);
  // (g) ip 외 열이 없으면 오류 · ip 열이 없으면 오류 · 샘플 주석 행은 건너뛴다
  assert.match(M.parseManageCsv('ip\n10.0.0.1\n').error, /바꿀 열/);
  assert.match(M.parseManageCsv('addr_x,status\n10.0.0.1,active\n').error, /'ip'/);
  const sample = M.manageSampleCsv(['active', 'reserved'], ['server']);
  const ps = M.parseManageCsv(sample);
  assert.equal(ps.error, null);
  assert.ok(ps.rows.every((r) => !String(r.ip).startsWith('#')), '샘플의 # 주석 행은 데이터가 아니다');
  // (h) 길이 초과는 자르지 않고 오류
  const p7 = M.parseManageCsv(`ip,owner\n10.0.0.1,${'가'.repeat(201)}\n`);
  assert.equal(M.analyzeManageImport(p7.rows, p7.columns, ctx).report[0].action, 'error');
  // (i) 수식 가드 왕복 — 내보낸 '=' 시작 값이 가져오기에서 원문으로 돌아온다
  const csv = M.manageToCsv([{ ip: '10.0.0.1', override: { owner: '=SUM(A1)', status: 'active' }, annotation: { memo: '+memo', tags: ['a', 'b'] } }]);
  const pr = M.parseManageCsv(csv);
  assert.equal(pr.rows[0].owner, '=SUM(A1)'); assert.equal(pr.rows[0].memo, '+memo'); assert.equal(pr.rows[0].tags, 'a; b');
});

// ── ③ 스캔 대역 CSV(순수) ───────────────────────────────────────────────────────
test('③ 스캔 대역 CSV: 교체는 파일에 나온 에이전트만 · 추가 모드 · 오류 줄 있는 에이전트는 통째로 막는다 · 별칭', async () => {
  const S = await import('../src/ipam/scanRangesCsv.js');
  const { rangeSize } = await import('../src/ipam/scan.js');
  const current = new Map([
    ['__local__', { name: '__local__', ranges: ['10.0.0.0/24', '10.0.1.0/24'] }],
    ['edge-a', { name: 'Edge-A', ranges: ['172.16.0.0/24'] }],
    ['edge-b', { name: 'edge-b', ranges: ['172.17.0.0/24'] }],
  ]);
  const { rows } = S.parseScanRangesCsv('agent,range\n이 포탈,10.0.1.0/24\n이 포탈,10.0.2.1 - 10.0.2.9\nEDGE-A,172.16.9.0/24\nEDGE-A,999.1.1.1\nedge-new,192.168.5.0/16\n');
  const rep = S.analyzeScanRangesImport(rows, { mode: 'replace', current, rangeSize, rangeCap: 4096 });
  const local = rep.plans.find((p) => p.key === '__local__');
  assert.deepEqual(local.after, ['10.0.1.0/24', '10.0.2.1-10.0.2.9'], '교체 모드 · 공백 정규화 · 별칭');
  assert.deepEqual(local.removed, ['10.0.0.0/24']);
  const ea = rep.plans.find((p) => p.agent === 'Edge-A');
  assert.ok(ea.blocked, '오류 줄이 있는 에이전트는 적용하지 않는다(교체면 대역이 조용히 지워진다)');
  assert.equal(rep.plans.find((p) => p.agent === 'edge-b'), undefined, '파일에 없는 에이전트는 건드리지 않는다');
  const nw = rep.plans.find((p) => p.agent === 'edge-new');
  assert.equal(nw.isNew, true);
  assert.equal(rep.summary.warn, 1, '/16 은 스캐너 상한을 넘는다고 밝힌다');
  assert.equal(rep.summary.error, 1);
  const add = S.analyzeScanRangesImport(rows.filter((r) => r.agent === '이 포탈'), { mode: 'add', current, rangeSize });
  assert.deepEqual(add.plans[0].after, ['10.0.0.0/24', '10.0.1.0/24', '10.0.2.1-10.0.2.9'], '추가 모드는 기존 뒤에 붙인다');
  assert.deepEqual(add.plans[0].removed, []);
  // 왕복: 내보낸 파일을 그대로 교체로 가져오면 바뀌는 것이 없다(대역 없는 에이전트 포함)
  const csv = S.scanRangesToCsv([...current.values(), { name: 'empty-one', ranges: [] }]);
  const back = S.analyzeScanRangesImport(S.parseScanRangesCsv(csv).rows, { mode: 'replace', current, rangeSize });
  assert.ok(back.plans.every((p) => !p.added.length && !p.removed.length), '왕복은 변화 0');
  assert.match(S.parseScanRangesCsv('name,cidr\nx,1.1.1.1\n').error, /'agent'/);
});

// ── ④ 라우트 ─────────────────────────────────────────────────────────────────
test('④ 라우트: 관리상태 CSV 왕복·적용·범위·권한 + 스캔 대역 CSV + 스캔 로그 게이트·기록', () => {
  const o = runChild(`
    const { ipVcenterOwners } = await import(SRC + 'ipam/ledger.js');
    const snap = store.get();
    const owners = ipVcenterOwners(snap);
    const ipOf = (vc) => { for (const [ip, set] of owners) if (set.size === 1 && set.has(vc)) return ip; return null; };
    const usIp = ipOf('vc-us-east'); const euIp = ipOf('vc-eu-west');
    out.ips = { usIp, euIp };
    // 적용 전 dryRun
    const csv1 = 'ip,status,owner,memo,tags\\n' + usIp + ',reserved,홍길동,이관 예정,db; 이관\\n' + euIp + ',active,유럽팀,,\\n10.254.254.9,xx,,,\\n';
    const d = await call('full', 'POST', '/tools/ipam/manage/import', { csv: csv1, dryRun: true });
    out.dry = d;
    const { getOverride } = await import(SRC + 'ipam/overrides.js');
    out.beforeApply = getOverride(usIp);
    const a = await call('full', 'POST', '/tools/ipam/manage/import', { csv: csv1, dryRun: false });
    out.apply = a;
    out.afterUs = getOverride(usIp);
    const { getAnnotation } = await import(SRC + 'ipam/annotations.js');
    out.annUs = getAnnotation(usIp);
    // 내보내기 → 그대로 가져오기 = 전부 same
    const ex = await call('full', 'GET', '/tools/ipam/manage.csv');
    out.exStatus = ex.s; out.exRows = ex.h['x-ipam-rows']; out.exHas = typeof ex.j === 'string' && ex.j.includes(usIp);
    const rt = await call('full', 'POST', '/tools/ipam/manage/import', { csv: ex.j, dryRun: true });
    out.roundtrip = rt.j.summary;
    // 범위: 유럽 운영자는 미국 IP 를 쓸 수 없고, 내보내기에서 보지 못한다
    const e1 = await call('euop', 'POST', '/tools/ipam/manage/import', { csv: 'ip,status\\n' + usIp + ',deprecated\\n' + euIp + ',deprecated\\n', dryRun: false });
    out.euApply = e1;
    out.usAfterEu = getOverride(usIp)?.status;
    out.euAfterEu = getOverride(euIp)?.status;
    const e2 = await call('euop', 'GET', '/tools/ipam/manage.csv');
    out.euExport = { s: e2.s, hasUs: String(e2.j).includes(usIp), hasEu: String(e2.j).includes(euIp), hidden: e2.h['x-ipam-hidden-out-of-scope'] };
    // 권한: viewer 는 가져오기 불가(조회 역할), 내보내기는 tools 권한으로
    out.viewerImport = (await call('viewer1', 'POST', '/tools/ipam/manage/import', { csv: csv1, dryRun: true })).s;
    out.sample = await call('full', 'GET', '/tools/ipam/manage/sample.csv');
    out.bad = (await call('full', 'POST', '/tools/ipam/manage/import', { csv: 'foo,bar\\n1,2\\n', dryRun: true })).s;
    out.empty = (await call('full', 'POST', '/tools/ipam/manage/import', { csv: '  ', dryRun: true })).s;
    // 청크 상한
    const big = 'ip,status\\n' + Array.from({ length: 2600 }, (_, i) => '10.200.' + Math.floor(i / 250) + '.' + (i % 250 + 1) + ',active').join('\\n');
    out.bigChunk = (await call('full', 'POST', '/tools/ipam/manage/import', { csv: big, dryRun: true })).s;
    out.audit = fs.existsSync(path.join(CFG, 'audit.ndjson')) ? fs.readFileSync(path.join(CFG, 'audit.ndjson'), 'utf8').includes('IP 관리상태 CSV 가져오기') : false;

    // ── 스캔 대역 CSV + 스캔 로그
    out.sadmLog = (await call('sadm', 'GET', '/admin/ipam/scan/log')).s;
    out.sadmRangesCsv = (await call('sadm', 'GET', '/admin/ipam/scan/ranges.csv')).s;
    out.sadmImport = (await call('sadm', 'POST', '/admin/ipam/scan/ranges/import', { csv: 'agent,range\\n__local__,10.9.0.0/24\\n', dryRun: true })).s;
    const put = await call('full', 'PUT', '/admin/ipam/scan/settings', { agent: '__local__', enabled: false, ranges: ['10.50.0.0/24'], ports: [1], timeoutMs: 100, concurrency: 256, reverseDns: false });
    out.putS = put.s;
    const rd = await call('full', 'POST', '/admin/ipam/scan/ranges/import', { csv: 'agent,range\\n이 포탈,10.50.1.0/24\\nedge-x,172.20.0.0/24\\nedge-y,300.0.0.0/24\\n', dryRun: true });
    out.rangesDry = rd.j;
    const ra = await call('full', 'POST', '/admin/ipam/scan/ranges/import', { csv: 'agent,range\\n이 포탈,10.50.1.0/24\\nedge-x,172.20.0.0/24\\nedge-y,300.0.0.0/24\\n', dryRun: false });
    out.rangesApply = ra.j;
    const { loadScanSettings } = await import(SRC + 'ipam/scanStore.js');
    out.localRanges = loadScanSettings('__local__').ranges;
    out.edgeX = loadScanSettings('edge-x').ranges;
    out.edgeY = loadScanSettings('edge-y').ranges;
    const rcsv = await call('full', 'GET', '/admin/ipam/scan/ranges.csv');
    out.rangesCsvHas = String(rcsv.j).includes('172.20.0.0/24') && String(rcsv.j).includes('10.50.1.0/24');
    // 로컬 스캔 실행(주기 꺼짐이어도 수동은 돈다 — 대역이 있으므로 start 가 기록된다)
    await call('full', 'POST', '/admin/ipam/scan/run', {});
    for (let i = 0; i < 100; i++) { const st = (await call('full', 'GET', '/admin/ipam/scan/status')).j.status; if (!st?.running) break; await new Promise((r) => setTimeout(r, 200)); }
    const lg = await call('full', 'GET', '/admin/ipam/scan/log?limit=50');
    out.log = lg.j;
  `, { env: { AUTH_ENABLED: 'true' } }); // 인증 꺼짐이면 requireRole 이 익명(admin)으로 통과시킨다 — 역할 게이트를 보려면 켠다(req.user 는 하니스가 넣는다)
  assert.ok(o.ips.usIp && o.ips.euIp, '목 데이터에 두 vCenter 소유 IP 가 있어야 한다');
  assert.equal(o.dry.s, 200);
  assert.deepEqual(o.dry.j.report.map((r) => r.action), ['create', 'create', 'error']);
  assert.equal(o.beforeApply, null, 'dryRun 은 저장하지 않는다');
  assert.equal(o.apply.s, 200); assert.equal(o.apply.j.applied, 2);
  assert.equal(o.afterUs.status, 'reserved'); assert.equal(o.afterUs.owner, '홍길동');
  assert.deepEqual(o.annUs.tags, ['db', '이관']); assert.equal(o.annUs.memo, '이관 예정');
  assert.equal(o.exStatus, 200); assert.ok(o.exHas); assert.ok(Number(o.exRows) >= 2);
  assert.equal(o.roundtrip.error, 0); assert.equal(o.roundtrip.create + o.roundtrip.update + o.roundtrip.clear, 0, '내보낸 파일을 그대로 가져오면 바뀌는 것이 없다');
  assert.equal(o.euApply.s, 200);
  const euRep = o.euApply.j.report;
  assert.equal(euRep.find((r) => r.ip === o.ips.usIp).action, 'error', '범위 밖 IP 는 그 행만 오류');
  assert.equal(o.usAfterEu, 'reserved', '범위 밖 IP 는 바뀌지 않는다');
  assert.equal(o.euAfterEu, 'deprecated', '범위 안 IP 는 적용된다');
  assert.equal(o.euExport.s, 200); assert.equal(o.euExport.hasUs, false); assert.equal(o.euExport.hasEu, true);
  assert.ok(Number(o.euExport.hidden) >= 1, '범위 밖으로 뺀 개수를 밝힌다');
  assert.equal(o.viewerImport, 403);
  assert.equal(o.sample.s, 200); assert.match(String(o.sample.j), /status/);
  assert.equal(o.bad, 400); assert.equal(o.empty, 400);
  assert.equal(o.bigChunk, 400, '청크 상한을 넘으면 거절(화면은 나눠 보낸다)');
  assert.equal(o.audit, true, '적용은 감사 로그에 남는다');
  assert.equal(o.sadmLog, 403, '스캔 로그는 전체 범위 계정만(전 엣지 이름·대역)');
  assert.equal(o.sadmRangesCsv, 403); assert.equal(o.sadmImport, 403);
  assert.equal(o.putS, 200);
  assert.equal(o.rangesDry.dryRun, true);
  assert.ok(o.rangesDry.plans.find((p) => p.agent === 'edge-y').blocked);
  assert.deepEqual(o.localRanges, ['10.50.1.0/24'], '교체 모드는 파일의 대역으로 바꾼다');
  assert.deepEqual(o.edgeX, ['172.20.0.0/24']);
  assert.deepEqual(o.edgeY || [], [], '오류 줄이 있는 에이전트는 적용하지 않는다');
  assert.equal(o.rangesApply.blocked.length, 1);
  assert.ok(o.rangesCsvHas);
  const evs = o.log.entries.map((e) => e.event);
  assert.ok(evs.includes('settings'), '설정 저장·CSV 가져오기가 로그에 남는다');
  assert.ok(evs.includes('start'), '수동 스캔 시작이 로그에 남는다');
  assert.ok(evs.includes('finish') || evs.includes('fail'), '스캔 종료(또는 실패)가 로그에 남는다');
  const st = o.log.entries.find((e) => e.event === 'start');
  assert.equal(st.trigger, 'manual'); assert.equal(st.ranges, 1);
  assert.ok(Array.isArray(o.log.events));
});

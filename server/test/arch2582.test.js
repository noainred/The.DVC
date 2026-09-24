/**
 * v2.582 회귀 — 아키텍처 점검 4차(각 5건).
 *  ARCH-1 손상 보존 스윕 · ARCH-2 날짜 코어 하나 · ARCH-3 원자 쓰기 · ARCH-4 종료 flush 레지스트리 · ARCH-5 통계 레벨
 *  BUG-1 iDRAC 스캔 워커 무음 실패 · BUG-2 storage collect-all 엣지 요청 · BUG-3 UTC 파일명 · BUG-4 주기 하드코딩 · BUG-5 일일 보고 TZ
 *  TUNE-1/2 ipam memo + ?q · TUNE-3 esxi-temp memo · TUNE-4 vmseries 핸들 상한
 * ⚠ 소스 검사는 주석을 먼저 제거한다(v2.535 규약 — `test/_stripComments.js`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');
const code = (p) => stripComments(read(p));
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'mock' && e.name !== 'intro') walk(p, out); } else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

/* ── ARCH-2 / BUG-3 / BUG-5: 날짜 코어 ───────────────────────────────────────── */
test('ARCH-2 dayKey — env 우선순위·0(UTC) 허용·KST 경계·못 읽으면 빈 문자열', async () => {
  const m = await import('../src/util/dayKey.js');
  assert.equal(m.resolveDayOffsetMin({}), 540);
  assert.equal(m.resolveDayOffsetMin({ PORTAL_TZ_OFFSET_MIN: '0' }), 0, '0(UTC) 은 유효한 값이다 — || 540 으로 되돌리면 안 된다');
  assert.equal(m.resolveDayOffsetMin({ STORAGE_GROWTH_TZ_OFFSET_MIN: '60', BMUSAGE_TZ_OFFSET_MIN: '120' }), 60, '옛 이름 호환');
  assert.equal(m.resolveDayOffsetMin({ PORTAL_TZ_OFFSET_MIN: 'abc', LINKCHECK_TZ_OFFSET_MIN: '-300' }), -300);
  assert.equal(m.resolveDayOffsetMin({ PORTAL_TZ_OFFSET_MIN: '' , BMUSAGE_TZ_OFFSET_MIN: '480' }), 480, '빈 문자열은 무시');
  // 2026-09-22T23:30Z = KST 09-23 08:30 → UTC 날짜는 22일, KST 날짜는 23일
  const t = Date.parse('2026-09-22T23:30:00Z');
  assert.equal(m.dayKey(t, 540), '2026-09-23');
  assert.equal(m.dayKey(t, 0), '2026-09-22');
  assert.equal(m.dayKey('2026-09-22T23:30:00Z', 540), '2026-09-23', 'ISO 문자열도 받는다(라이선스 만료일)');
  assert.equal(m.dayKey(String(t), 540), '2026-09-23', '숫자 문자열은 epoch 로');
  assert.equal(m.dayKey(null), ''); assert.equal(m.dayKey('x'), ''); assert.equal(m.dayKey(''), '');
  assert.equal(m.todayStamp(t, 540), '2026-09-23');
  const c = m.localClock(t, 540);
  assert.deepEqual({ day: c.day, hour: c.hour, minute: c.minute }, { day: '2026-09-23', hour: 8, minute: 30 });
  // 세 DB 모듈은 코어를 재수출한다(값 동일)
  const st = await import('../src/storage/db.js'); const bm = await import('../src/bmusage/db.js'); const lc = await import('../src/linkcheck/db.js');
  assert.equal(st.DAY_OFFSET_MIN, m.DAY_OFFSET_MIN); assert.equal(bm.DAY_OFFSET_MIN, m.DAY_OFFSET_MIN); assert.equal(lc.DAY_OFFSET_MIN, m.DAY_OFFSET_MIN);
  assert.equal(bm.dayKey(t), lc.dayKey(t)); assert.equal(st.dayLabel(st.dayIndex(t)), m.dayLabel(m.dayIndex(t)));
});

test('BUG-3 스윕 — 라우트·서비스 코드에 UTC 날짜 파일명(toISOString().slice(0,10)) 이 남아 있지 않다', () => {
  const bad = [];
  for (const f of walk(SRC)) {
    const rel = path.relative(SRC, f);
    if (rel === 'util/dayKey.js' || rel === 'release-notes.js') continue;
    const s = code(rel);
    if (/new Date\(\)\.toISOString\(\)\.slice\(0, ?10\)/.test(s) || /toISOString\(\)\.split\('T'\)\[0\]/.test(s)) bad.push(rel);
  }
  assert.deepEqual(bad, [], `todayStamp()/dayKey() 를 쓸 것: ${bad.join(', ')}`);
});

test('BUG-5 일일 보고 — 발송 판정은 서버 TZ 가 아니라 포탈 오프셋(기본 UTC+9) 기준', async () => {
  const m = await import('../src/reports/dailyReport.js');
  // 08:00 KST 발송 설정. 2026-09-22T23:30Z 는 KST 08:30 → due. UTC 로 읽으면 23시라 due 이지만 '오늘' 이 22일이 된다.
  const s = { enabled: true, hour: 8, minute: 0, lastRunTs: 0 };
  const t = Date.parse('2026-09-22T23:30:00Z');
  assert.equal(m.dailyReportDue(s, t), true);
  assert.equal(m.dailyReportDue({ ...s, hour: 9 }, t), false, 'KST 08:30 은 09:00 발송 전');
  // 같은 KST 날짜(23일 07:00 KST = 22일 22:00Z)에 이미 보냈으면 재발송 없음 — UTC 날짜로 비교하면 22일≠23일로 오판한다
  assert.equal(m.dailyReportDue({ ...s, lastRunTs: Date.parse('2026-09-22T22:00:00Z') }, t), false);
  // 어제(KST 22일 = 21일 23:30Z)에 보냈으면 오늘은 보낸다
  assert.equal(m.dailyReportDue({ ...s, lastRunTs: Date.parse('2026-09-21T23:30:00Z') }, t), true);
  assert.equal(typeof m.dailyReportStatus().tzOffsetMin, 'number', '화면이 시간대 기준을 적을 수 있게 status 에 실린다');
  const src = code('reports/dailyReport.js');
  assert.ok(!/getHours\(\)|toDateString\(\)/.test(src), '서버 프로세스 TZ 에 매인 API 를 쓰지 않는다');
});

/* ── ARCH-1: 손상 보존 스윕 ────────────────────────────────────────────────── */
test('ARCH-1 스윕 — configDir JSON 을 읽고 원자 쓰기로 저장하는 스토어는 로드 catch 에서 preserveCorrupt 를 부른다', () => {
  // 캐시 성격(다음 push/수집이 재구축) — 보존하지 않는 것이 맞다. 사유와 함께 선언한다.
  const CACHE_OK = new Set([
    'central/storageEdge.js', 'central/sanSwitchEdge.js', // 엣지 push 캐시 — 다음 push 가 재구축
    'idrac/invCache.js',                                  // iDRAC 인벤토리 캐시 — 30분 주기 재수집
    'inventory/osStore.js', 'inventory/osScanner.js',     // OS 스캔 캐시
    'central/fleet.js',                                   // 엣지 fleet push 캐시
    'metrics/vmperfDb.js', 'vmseries/db.js',              // _index.json(표시용 인덱스)
    'sanswitch/perfPush.js', 'sanswitch/store.js',        // push 커서·스냅샷 캐시
    'cvp/push.js',                                        // v2.608 CVP push 커서 — 잃으면 처음부터 다시 보내고 중앙이 UNIQUE 로 중복을 거른다
    'idrac/scanLog.js', 'net/captureHistory.js',          // 이력 링버퍼(캐시 성격 — v2.516 활동 로그와 같은 판단)
    'auth/sessions.js',                                   // 세션 — 손상이면 재로그인(v2.580 판단)
    'bmusage/notify.js',                                  // 알림 억제 상태 — 손상이면 재알림 1회
    'rma/agent.js',                                       // 엣지 RMA 에이전트 상태
    'insights/dbLocation.js', // 설정 — 손상이면 기본값(별도 감사 대상). finops·dailyReport 는 v2.595 에 preserveCorrupt 를 받았다
    'routes/admin/nsxImport.js', 'central/inventory.js', 'central/agentTokens.js', // 자체 보존 로직(renameSync .corrupt) 또는 저장소가 아닌 경로(nsxImport 는 가져오기 파일 읽기) — v2.583: scanStore·packageSettings 는 '자체 보존' 이 사실이 아니어서 빼고 고쳤다
    'svcmon/logsettings.js', 'net/monitor.js', 'central/svcmonEdge.js', 'security/netIssueStore.js', 'security/loginStore.js', 'storage/authGuard.js', 'util/authGuard.js', 'util/tokenFingerprint.js',
    'central/sanSwitchPerfEdge.js', 'storage/store.js',     // 엣지 push·스냅샷 캐시 — 다음 push/수집이 재구축
    'util/activityLog.js', 'tool-usage.js',                  // 링버퍼·사용 횟수 — v2.516 이 'preserveCorrupt 대상이 아니다' 로 못 박은 캐시
    'loganalysis/live.js',                                   // v2.583 로그 분석 누적 통계 — 재생성 가능한 집계(손상 시 새로 시작하고 상태에 밝힌다)
  ]);
  const missing = [];
  for (const f of walk(SRC)) {
    const rel = path.relative(SRC, f);
    const s = code(rel);
    if (!/JSON\.parse\(fs\.readFileSync/.test(s)) continue;
    if (!/atomicWriteFileSync\(/.test(s)) continue; // 저장하지 않는 읽기 전용은 왕복 손상이 없다
    if (CACHE_OK.has(rel)) continue;
    if (!/preserveCorrupt\(|backupCorrupt\(/.test(s)) missing.push(rel); // backupCorrupt: guestScanScheduler·loginMonitor 의 동등한 자체 보존
  }
  assert.deepEqual(missing, [], `로드 catch 에 preserveCorrupt(FILE, e.message) 를 넣을 것(다음 저장이 온전했던 원본을 빈 값으로 덮어쓴다): ${missing.join(', ')}`);
});

test('ARCH-1 실행 — 손상된 ipam-annotations.json 은 .corrupt 로 보존되고 빈 값으로 시작한다', async () => {
  // 자식 프로세스: 이 파일의 다른 테스트가 ledger→annotations 를 기본 configDir 로 이미 로드했으므로 격리한다.
  const { spawnSync } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-corrupt2582-'));
  fs.writeFileSync(path.join(dir, 'ipam-annotations.json'), '{"10.0.0.1": {"note": "x"'); // 절단본
  const script = `
    const m = await import(${JSON.stringify(path.join(SRC, 'ipam/annotations.js'))});
    const v = m.getAnnotation('10.0.0.1');
    console.log(JSON.stringify({ v }));
  `;
  const r = spawnSync(process.execPath, ['--experimental-sqlite', '--input-type=module', '-e', script], { env: { ...process.env, CONFIG_DIR: dir }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(out.v, null, '손상본을 값으로 쓰지 않는다');
  assert.match(r.stderr, /파싱 실패/, '경고를 낸다(조용한 빈값 금지)');
  const kept = fs.readdirSync(dir).filter((n) => n.startsWith('ipam-annotations.json.corrupt.'));
  assert.equal(kept.length, 1, '원본을 .corrupt 로 보존한다');
});

/* ── ARCH-3: 원자 쓰기 ─────────────────────────────────────────────────────── */
test('ARCH-3 — 디바운스 상태 파일 6곳은 fs.writeFileSync 직접 쓰기를 하지 않는다', () => {
  for (const rel of ['security/loginStore.js', 'idrac/invCache.js', 'central/fleet.js', 'net/captureHistory.js', 'inventory/osStore.js', 'security/netIssueStore.js']) {
    const s = code(rel);
    assert.ok(!/fs\.writeFileSync\(/.test(s), `${rel}: atomicWriteFileSync 를 쓸 것`);
    assert.ok(/atomicWriteFileSync\(/.test(s), `${rel}: atomicWriteFileSync 호출이 있어야 한다`);
  }
});

/* ── ARCH-4: 종료 flush 레지스트리 ─────────────────────────────────────────── */
test('ARCH-4 — 레지스트리: 등록한 flush 를 1회 실행하고 실패는 다음으로 넘긴다', async () => {
  const m = await import('../src/util/exitFlush.js');
  m._resetExitFlushForTest();
  const ran = [];
  m.registerExitFlush('a', () => ran.push('a'));
  m.registerExitFlush('boom', () => { throw new Error('x'); });
  m.registerExitFlush('b', () => ran.push('b'));
  assert.deepEqual(m.exitFlushNames(), ['a', 'boom', 'b']);
  assert.deepEqual(m.runExitFlush('test'), { ran: 2, skipped: false });
  assert.deepEqual(ran, ['a', 'b']);
  assert.deepEqual(m.runExitFlush('test'), { ran: 0, skipped: true }, '두 번째는 실행하지 않는다');
  assert.throws(() => m.registerExitFlush('x', null));
});

test('ARCH-4 스윕 — setTimeout 디바운스로 파일을 쓰는 모듈은 registerExitFlush 를 등록한다', () => {
  const EXEMPT = new Set([
    'central/inventory.js', // 수MB 비동기 쓰기 — 캐시이고 다음 push 가 재구축(모듈 주석이 근거)
    'svcmon/store.js',      // index.js svcmonShutdown 이 flushSvcmonStore 를 직접 부른다(v2.447 이전부터의 경로)
  ]);
  const missing = [];
  for (const f of walk(SRC)) {
    const rel = path.relative(SRC, f);
    if (EXEMPT.has(rel) || rel.startsWith('util/')) continue;
    const s = code(rel);
    // 디바운스 저장: 모듈 수준 타이머 변수 + setTimeout 콜백 안에서 파일을 쓴다
    if (!/(writeTimer|persistTimer|saveTimer|flushTimer|\bwt\b|\bt1\b) = setTimeout\(/.test(s)) continue;
    if (!/atomicWriteFileSync\(|fs\.writeFileSync\(/.test(s)) continue;
    if (!/registerExitFlush\(/.test(s)) missing.push(rel);
  }
  assert.deepEqual(missing, [], `종료 시 마지막 창을 잃지 않게 registerExitFlush 를 등록할 것: ${missing.join(', ')}`);
  // 자체 exit/시그널 훅은 index.js 와 레지스트리 밖에 없다
  for (const f of walk(SRC)) {
    const rel = path.relative(SRC, f);
    if (rel === 'index.js' || rel === 'util/exitFlush.js' || rel.startsWith('rma/') || rel.startsWith('ipam/scanWorker') || rel.startsWith('svcmon/worker')) continue;
    const s = code(rel);
    assert.ok(!/process\.(once|on)\('(exit|SIGTERM|SIGINT|beforeExit)'/.test(s), `${rel}: 자체 종료 훅 대신 registerExitFlush 를 쓸 것`);
  }
});

/* ── ARCH-5: 통계 레벨 ─────────────────────────────────────────────────────── */
test('ARCH-5 — 카운터 카탈로그의 <level> 을 읽어 표본 없음 사유가 그 값을 말한다', async () => {
  const { analyzeRightsize } = await import('../src/tools/rightsize.js');
  const r = analyzeRightsize({ vm: { id: 'vm-1', name: 'x', vcpus: 4, memMB: 8192 }, series: {}, empty: ['memActiveMB(mem.active.average)'], levels: { memActiveMB: 2 } });
  const reason = (r.evidence?.reasons || []).find((x) => x.includes('표본 없음'));
  assert.ok(reason && /통계 레벨은 2 입니다/.test(reason), reason);
  assert.ok(!/\*\*/.test(reason), '화면이 <li> 로 그대로 그리므로 별표 마크다운 금지');
  const r2 = analyzeRightsize({ vm: { id: 'vm-1', name: 'x', vcpus: 4, memMB: 8192 }, series: {}, empty: ['memActiveMB(mem.active.average)'] });
  const reason2 = (r2.evidence?.reasons || []).find((x) => x.includes('표본 없음'));
  assert.ok(reason2 && /가능성이 큽니다/.test(reason2), '레벨을 모르면 단정하지 않는다');
  const src = code('vcenter/soapClient.js');
  assert.ok(/<level>\(\\d\)<\\\/level>/.test(src) && /perfCounterLevels\(\)/.test(src), 'perfCounterMap 이 <level> 을 파싱하고 perfCounterLevels 로 꺼낸다');
  assert.ok(!/전부 vCenter \*\*통계 레벨 1\*\*/.test(read('vcenter/soapClient.js')), '낡은 주석("전부 레벨 1")을 되살리지 말 것');
});

/* ── BUG-1: iDRAC 스캔 위임 워커 무음 실패 ───────────────────────────────────── */
test('BUG-1 — 중앙이 403 을 돌려주면 워커 상태에 lastPollError 가 남는다(조용한 null 금지)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-idracw2582-'));
  process.env.CONFIG_DIR = dir; process.env.SSRF_ALLOW_LOOPBACK = 'true';
  const { config } = await import('../src/config.js'); config.configDir = dir;
  const srv = http.createServer((req, res) => { res.statusCode = 403; res.setHeader('Content-Type', 'application/json'); res.end('{"error":"forbidden"}'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  config.agent = { ...(config.agent || {}), name: 'edge-2582', centralUrl: `http://127.0.0.1:${srv.address().port}`, centralToken: 'tok' };
  try {
    const m = await import('../src/agent/idracScanWorker.js');
    const r = await m.runIdracScanWorkerOnce();
    assert.equal(r, null);
    const st = m.getIdracScanWorkerStatus();
    assert.ok(st.lastPollError, '실패가 상태에 남아야 한다');
    assert.equal(st.lastPollError.kind, 'auth');
    assert.match(st.lastPollError.detail, /403/);
    assert.equal(st.lastPollError.streak, 1);
  } finally { srv.close(); }
});

/* ── BUG-2: storage collect-all ──────────────────────────────────────────── */
test('BUG-2 — /tools/storage/collect-all 은 엣지 위임 장비의 재수집 요청을 등록하고 개수를 밝힌다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-collall2582-'));
  process.env.CONFIG_DIR = dir; process.env.DATA_SOURCE = 'mock';
  const { config } = await import('../src/config.js'); config.configDir = dir;
  const reg = await import('../src/storage/registry.js');
  reg._resetForTest?.();
  reg.saveDevice({ name: 'edge-unity', host: '10.99.0.10', type: 'unity480', username: 'u', password: 'p', agent: 'edge-a', collectMethod: 'ssh' });
  const cr = await import('../src/storage/collectRequests.js');
  cr._resetForTest();
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { username: 'admin', role: 'admin', scope: null }; next(); });
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const base = `http://127.0.0.1:${srv.address().port}`;
    const r1 = await (await fetch(`${base}/api/tools/storage/collect-all`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
    assert.equal(r1.ok, true);
    assert.equal(r1.edge, 1);
    assert.equal(r1.requested, 1, `엣지 장비 1대의 요청이 등록돼야 한다: ${JSON.stringify(r1)}`);
    const dev = reg.listDevices().find((d) => d.name === 'edge-unity');
    assert.equal(cr.hasPendingRequest(dev.id), true);
    const r2 = await (await fetch(`${base}/api/tools/storage/collect-all`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
    assert.equal(r2.requested, 0); assert.equal(r2.alreadyQueued, 1, '연타는 큐를 부풀리지 않는다');
  } finally { srv.close(); }
});

/* ── BUG-4 / TUNE-1 / TUNE-3 / TUNE-4: 소스 계약 ─────────────────────────────── */
test('BUG-4 — 스토리지 화면 각주는 주기 숫자를 박지 않고 서버가 준 edgeIntervals 를 쓴다', () => {
  const web = fs.readFileSync(path.resolve(HERE, '../../web/src/views/tools/StorageMonTool.jsx'), 'utf8');
  assert.ok(!/config pull\(≤5분\)/.test(web) && !/push\(≤5분\)/.test(web), '≤5분 하드코딩 금지');
  assert.ok(/edgeIntervalText\(d\.edgeIntervals\?\.configPull\)/.test(web));
  assert.ok(/edgeIntervals:/.test(code('routes/api/storageMon.js')));
});

test('TUNE-1/2/3 — /tools/ipam·/tools/esxi-temp 는 memoJson + 범위 키(+원장 리비전) 이고 ?q 는 서버가 거른다', () => {
  const ipam = code('routes/api/ipamExport.js');
  assert.ok(/api\.get\('\/tools\/ipam', requirePerm\('tools'\), \(req, res\) => memoJson\(req, res, 'tools-ipam'/.test(ipam));
  assert.ok(/extraKey: `\$\{scopeKey\(req\.user, store\.get\(\)\)\}\|\$\{ipamRevKey\(\)\}`/.test(ipam), '범위 + 원장 리비전이 캐시 키에 들어간다');
  assert.ok(/req\.query\.q/.test(ipam) && /truncated/.test(ipam));
  const cap = code('routes/api/toolsCapacity.js');
  assert.ok(/api\.get\('\/tools\/esxi-temp', requirePerm\('tools'\), \(req, res\) => memoJson\(req, res, 'tools-esxi-temp'/.test(cap));
  const ipms = fs.readFileSync(path.resolve(HERE, '../../web/src/components/IpmsMatches.jsx'), 'utf8');
  assert.ok(/fetchJson\('\/tools\/ipam', \{ \.\.\.p, q, limit: 2000 \}\)/.test(ipms), 'IPMS 검색은 서버 ?q 를 쓴다(전량 수신 금지)');
});

test('TUNE-4 — vmseries 파일별 DB 핸들 상한 기본값은 운영 vCenter 수(28 · 30+) 보다 크다', async () => {
  const m = await import('../src/vmseries/db.js');
  assert.ok(m.VMSERIES_MAX_OPEN_DEFAULT >= 36, `기본 ${m.VMSERIES_MAX_OPEN_DEFAULT}`);
  assert.ok(!/Math\.min\(32,/.test(code('vmseries/db.js')), '하드캡 32 는 33 vCenter 현장에서 env 로도 넘을 수 없었다');
});

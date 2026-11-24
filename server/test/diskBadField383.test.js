// v3.8.3 디스크 배드 섹터 — 3.8.2 실사용 화면(서버 한 대: 1,894건 · 37일 · USR0030 884 · LOG007 883 · SWC0403 126 · LOG203 1 · 장비 진단 없음)에서 드러난 것.
//   ① 다른 점검이 도는 중에 누른 서버 한 대 점검은 조용히 건너뛰어졌다 — 화면은 '점검을 보냈습니다' 였다. 이제 시작하지 못하면 409 + 이유.
//   ② 로그인 기록의 반복 표시(LOG007)를 세지 않아 93% 가 로그인 계열인 로그를 47% 로 봤다.
//   ③ 읽기 진단에 가장 오래된 항목의 기록 ID(LOG203 — 보관 표시로 보인다 · 문서 대조 전)를 싣는다.
//   ④ 장비 진단: 로그인이 어느 경로로 왔는가(낱말만) · 가장 오래된 항목 한 건(LOG 계열만 문장).
//   스윕은 test/_stripComments.js 로 주석을 먼저 지운다. 기준 시각은 실제 시각을 정시 경계로 떨어뜨려 고정한다(docs/rules/common.md).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'diskbadfld383-'));
process.env.CONFIG_DIR = TMP;
process.env.DISKBAD_DB_PATH = path.join(TMP, 'disk-bad.db');
process.env.AUTH_ENABLED = 'false';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const code = (p) => stripComments(fs.readFileSync(path.join(ROOT, 'src', p), 'utf8'));
const webCode = (p) => stripComments(fs.readFileSync(path.join(ROOT, '..', 'web', 'src', p), 'utf8'));
const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR;

const L = await import('../src/diskbad/lclog.js');
const I = await import('../src/diskbad/ingest.js');
const D = await import('../src/diskbad/db.js');
const S = await import('../src/diskbad/summary.js');
const C = await import('../src/diskbad/classify.js');
const P = await import('../src/diskbad/probe.js');
const J = await import('../src/diskbad/jobs.js');

after(() => { try { D._resetDiskBadDbForTest(); } catch { /* */ } fs.rmSync(TMP, { recursive: true, force: true }); });

const MGR = '/redfish/v1/Managers/iDRAC.Embedded.1';
const BASE = `${MGR}/LogServices/Lclog/Entries`;
const mgrs = { Members: [{ '@odata.id': MGR }] };
const lc = (id, created, msgId, message = 'x') => ({ Id: String(id), Created: new Date(created).toISOString(), MessageId: `IDRAC.2.9.${msgId}`, Message: message });
const skipOf = (p) => { const m = /\$skip=(\d+)/.exec(p); return m ? Number(m[1]) : 0; };
/** 실사용 화면의 꼴: 로그인 한 건 + 반복 표시 한 건이 번갈아, 사이사이 SWC0403, 맨 끝(가장 오래된 것)에 LOG203 한 건. 최신 먼저. */
function fieldLog(pairs = 60) {
  const rows = [];
  let id = 100_000; let t = NOW;
  for (let i = 0; i < pairs; i += 1) {
    rows.push(lc(id--, t, 'LOG007', 'The previous log entry was repeated 58 times.')); t -= 30 * 60_000;
    rows.push(lc(id--, t, 'USR0030', 'Successfully logged in using svc-monitor, from 10.20.30.40 and REDFISH.')); t -= 30 * 60_000;
    if (i % 7 === 0) { rows.push(lc(id--, t, 'SWC0403', 'software config')); t -= 60_000; }
  }
  rows.push(lc(id--, t, 'LOG203', 'Lifecycle Controller Log archived up to Log Sequence number 48211.'));
  return rows;
}
const serve = (all) => async (_e, p) => {
  if (p === '/redfish/v1/Managers') return mgrs;
  if (p === MGR) return { FirmwareVersion: '6.10.30.00', Model: '15G Monolithic' };
  if (p.startsWith(`${BASE}?$filter=`)) {
    const m = /MessageId eq '([^']+)'/.exec(decodeURIComponent(p));
    const rows = m ? all.filter((x) => x.MessageId === m[1]) : [];
    return { Members: rows.slice(0, 50), 'Members@odata.count': rows.length };
  }
  if (p === BASE || p.startsWith(`${BASE}?$skip=`)) { const k = skipOf(p); return { Members: all.slice(k, k + 50), 'Members@odata.count': all.length, ...(k + 50 < all.length ? { 'Members@odata.nextLink': `${BASE}?$skip=${k + 50}` } : {}) }; }
  throw Object.assign(new Error('nf'), { status: 404 });
};

test('로그인 비율: 반복 표시(LOG007)는 로그인 계열 건수까지만 로그인 쪽으로 센다 — 실사용 구성은 47% 가 아니라 93%', () => {
  const real = { read: 1894, top: [{ code: 'USR0030', n: 884 }, { code: 'LOG007', n: 883 }, { code: 'SWC0403', n: 126 }, { code: 'LOG203', n: 1 }] };
  const share = C.loginShareOf(real);
  assert.ok(share > 0.93 && share < 0.94, `share ${share}`);
  // 반복 표시가 로그인보다 많으면 넘치는 몫은 세지 않는다(다른 기록의 반복일 수 있다) · 로그인이 없으면 반복 표시만으로는 0.
  assert.equal(C.loginShareOf({ read: 1000, top: [{ code: 'USR0030', n: 100 }, { code: 'LOG007', n: 800 }] }), 0.2);
  assert.equal(C.loginShareOf({ read: 1000, top: [{ code: 'LOG007', n: 900 }, { code: 'PDR54', n: 3 }] }), 0);
  assert.equal(C.REPEAT_CODE, 'LOG007');
  assert.equal(S.diagView(real).repeatCode, 'LOG007'); assert.ok(S.diagView(real).loginShare > 0.93);
});

test('읽기 진단: 가장 오래된 항목의 기록 ID 를 싣는다(활성 로그의 맨 끝 — 실사용에서는 LOG203) · 정제 · DB · 화면용 값까지', async () => {
  const all = fieldLog();
  const r = await L.readLclog({}, { getJson: serve(all) });
  assert.equal(r.reachedEnd, true); assert.equal(r.read, all.length); assert.equal(r.oldestCode, 'LOG203');
  assert.equal(r.entries.length, 0);
  const log = { order: r.order, total: r.total, read: r.read, oldestRead: r.oldestRead, newestCreated: r.newest.created, reachedEnd: true, foundCursor: false, cursorUsed: false,
    pages: r.pages, ms: r.ms, distinct: r.distinct, top: r.top, firstLen: r.firstLen, hasNext: r.hasNext, path: r.path, oldestCode: r.oldestCode };
  const clean = I.cleanPush({ v: 1, jobId: 'j', servers: [{ id: 'f1', ok: true, log, records: [], drives: [] }] }, { now: NOW + HOUR }).servers;
  assert.equal(clean[0].log.oldestCode, 'LOG203');
  assert.equal(I.cleanServer({ id: 'x', ok: true, log: { oldestCode: 'A'.repeat(99) } }, NOW).log.oldestCode.length, 16);
  await D.ingestServers('f383', clean, { now: NOW + HOUR });
  const d = await D.loadServer('f383', 'f1');
  assert.equal(d.server.readDiag.oldestCode, 'LOG203');
  const v = S.serverView(d.server, d.records, d.serials);
  assert.equal(v.coverage.diag.oldestCode, 'LOG203'); assert.ok(v.coverage.diag.loginShare > 0.9);
});

test('시작하지 못한 점검: 그 노드가 다른 점검 중이면 작업을 만들지 않고 409 + 이유 — 화면은 그 답을 본다', () => {
  J._resetJobsForTest();
  assert.equal(J.isAgentBusy('edge-nj'), false);
  const a = J.createJob({ scope: 'corp', target: 'vc1', units: [{ agent: 'Edge-NJ', kind: 'edge', serverIds: ['10.112.160.34', '10.112.160.35'] }] });
  assert.equal(J.isAgentBusy('EDGE-nj'), true, '대기 · 진행 중인 조각이 있으면 바쁘다(대소문자 무시)');
  assert.equal(J.isAgentBusy('other'), false);
  J.stopJob(a.id);
  assert.equal(J.isAgentBusy('edge-nj'), false, '끝난 뒤에는 바쁘지 않다');
  const r = code('routes/api/diskBad.js');
  // 서버 · 법인: 조각이 전부 바쁜 노드면 createJob 보다 먼저 409.
  const i = r.indexOf("if (units.every((u) => isAgentBusy(u.agent))) return res.status(409).json(busyBody(");
  assert.ok(i > 0 && i < r.indexOf("const job = createJob({ scope, target, targetLabel: label"), '작업을 만들기 전에 답한다');
  assert.match(r, /allUnits\.length && allUnits\.every\(\(u\) => isAgentBusy\(u\.agent\)\)\) return res\.status\(409\)/);
  assert.match(r, /const busyBody = \(who\) => \(\{ ok: false, busy: true, reason:/);
  assert.match(r, /canProbe: isAdminDetailUser\(req\.user\)/, '장비 진단을 볼 수 있는 계정인지 화면에 알린다');
  // 화면 세 곳 모두 답의 ok 를 본다(409 는 던져지지 않는다 — api.js).
  const panel = webCode('views/tools/DiskBadServerPanel.jsx'); const tool = webCode('views/tools/DiskBadTool.jsx');
  assert.match(panel, /const sent = scanSent\(r\);/); assert.equal((tool.match(/scanSent\(r/g) || []).length, 2);
  assert.doesNotMatch(panel, /\.then\(\(\) => \{ setMsg\('점검을 보냈습니다/);
  assert.match(panel, /data\.canProbe && !data\.probe &&/, '장비 진단이 없으면 받는 방법을 안내한다');
});

test('장비 진단: 로그인이 온 경로는 낱말만(계정 · 주소 없음) · 가장 오래된 항목 한 건은 LOG 계열일 때만 문장', async () => {
  const all = fieldLog();
  const calls = [];
  const p = await P.probeIdrac({}, { now: () => NOW, getJson: async (e, path) => { calls.push(path); return serve(all)(e, path); } });
  assert.deepEqual(p.lclog.loginVia, { REDFISH: p.lclog.codes.USR0030 });
  assert.equal(p.lclogOldest.messageId, 'IDRAC.2.9.LOG203');
  assert.equal(p.lclogOldest.message, 'Lifecycle Controller Log archived up to Log Sequence number 48211.');
  assert.ok(calls.includes(`${BASE}?$skip=${all.length - 1}`), '가장 오래된 항목은 요청 한 번(건수 − 1)');
  const text = JSON.stringify(p);
  assert.equal(text.includes('svc-monitor'), false); assert.equal(text.includes('10.20.30.40'), false, '계정 이름 · 주소는 싣지 않는다');
  // 가장 오래된 항목이 LOG 계열이 아니면 문장을 싣지 않는다(로그인 문장에는 계정 · 주소가 있다).
  const tailLogin = [...all.slice(0, -1), lc(1, NOW - 9999 * HOUR, 'USR0030', 'Successfully logged in using root, from 10.9.9.9 and GUI.')];
  const q = await P.probeIdrac({}, { now: () => NOW, getJson: serve(tailLogin) });
  assert.equal(q.lclogOldest.messageId, 'IDRAC.2.9.USR0030'); assert.equal('message' in q.lclogOldest, false);
  // 건수가 첫 쪽 이하이면(전체 건수로 못 믿는다) 가장 오래된 항목을 묻지 않는다.
  const small = await P.probeIdrac({}, { now: () => NOW, getJson: serve(all.slice(0, 30)) });
  assert.equal('lclogOldest' in small, false);
});

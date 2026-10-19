/**
 * test/audit2744ve.test.js — v2.744 최종 수정분 적대적 검토 그룹 VE(RV2744F-WEB-03).
 *
 * 결함: 화면 상세 카드의 '무엇을 읽었고 무엇을 못 읽었나'(웹 bmUsageText.detailNotes·telemetryNote·entDetailNotes·fcNominalRestKind)는
 *   buildUsage().detail 을 입력으로 쓰는데, 그 상세는 DB 에 넣지 않고 **어떤 서버 응답도 싣지 않아** 그 문구가 화면에 한 번도 나오지 않았다.
 *   buildUsage 의 notes(fcRateNotes fallback 문구 포함)도 폴러가 버렸다.
 * 고친 것: 폴러가 서버마다 마지막 수집의 상세를 **화면이 쓰는 필드만** 메모리에 두고(poller.usageDetailFor — 대상 목록으로 매 주기 정리),
 *   상세 조회(GET /tools/bm-usage/history)가 그 서버 것만 싣는다. 비-관리자에게는 오류·노트 문장 속 주소를 가리고 racadm 원문을 싣지 않는다.
 *
 * 실제 api 라우터(express) + 실제 폴러 1주기(가짜 Redfish 서버 두 대 — 정상 텔레메트리 · 다른 주소로 리다이렉트)로 본다.
 * 시각 단언은 하지 않는다(폴러가 Date.now() 로 찍는다) — 판정은 상태·필드·가림만 본다.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2744ve-'));
Object.assign(process.env, {
  CONFIG_DIR: TMP, DATA_SOURCE: 'live', AUTH_ENABLED: 'true', SSRF_ALLOW_LOOPBACK: 'true', IPAM_WRITE_WORKER: '0',
  BMUSAGE_ENABLED: 'true',
});
fs.writeFileSync(path.join(TMP, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));
fs.writeFileSync(path.join(TMP, 'vcenters.json'), JSON.stringify({ vcenters: [] }));

const REDIRECT_IP = '10.20.30.40';   // 리다이렉트 오류 문장에 들어가는 주소(등록부에 없는 주소 — IPv4 토큰 가림 대상)
const closers = [];
let apiBase; let okHost; let badHost;

async function listen(srv) {
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  closers.push(() => new Promise((q) => { srv.closeAllConnections?.(); srv.close(q); }));
  return `http://127.0.0.1:${srv.address().port}`;
}

before(async () => {
  // ① 정상 iDRAC — 텔레메트리 리포트 2종(SystemUsage · NICStatistics).
  const ts = '2026-10-19T00:30:00Z';
  const reports = {
    SystemUsage: { Id: 'SystemUsage', MetricValues: [{ MetricId: 'SystemBoardCPUUsage', MetricValue: '41', Timestamp: ts }, { MetricId: 'SystemBoardMEMUsage', MetricValue: '63', Timestamp: ts }] },
    NICStatistics: { Id: 'NICStatistics', MetricValues: [{ MetricId: 'RxBytes', MetricValue: '1000', Timestamp: ts, Oem: { Dell: { FQDD: 'NIC.Integrated.1-1-1' } } }] },
  };
  okHost = await listen(http.createServer((req, res) => {
    const u = req.url.split('?')[0];
    const J = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (u === '/redfish/v1/TelemetryService/MetricReports') {
      return J(200, { Members: Object.keys(reports).map((id) => ({ '@odata.id': `/redfish/v1/TelemetryService/MetricReports/${id}` })) });
    }
    const id = u.split('/').pop();
    return reports[id] ? J(200, reports[id]) : J(404, { error: 'nope' });
  }));
  // ② 실패 iDRAC — 다른 주소로 리다이렉트(오류 문장에 그 주소가 실린다: 'BMC 가 다른 주소로 리다이렉트했습니다(302 → 10.20.30.40)').
  badHost = await listen(http.createServer((_req, res) => { res.writeHead(302, { Location: `https://${REDIRECT_IP}/redfish/v1/x` }); res.end(); }));

  fs.writeFileSync(path.join(TMP, 'idrac.json'), JSON.stringify({ servers: [
    { id: 'idrac-ve-ok', name: 've-ok-db01', host: okHost, username: 'root', password: 'p' },
    { id: 'idrac-ve-bad', name: 've-bad-db02', host: badHost, username: 'root', password: 'p' },
  ] }));
  const { saveBmUsageSettings } = await import('../src/bmusage/settings.js');
  saveBmUsageSettings({ enabled: true, includeUnassigned: true, idracTelemetry: true });

  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const inject = (req, _r, n) => { const role = req.get('x-role') || 'admin'; req.user = { username: role === 'admin' ? 'adm' : `u-${role}`, role, scope: null }; n(); };
  const a = express(); a.use(express.json()); a.use(inject); a.use('/api', api);
  apiBase = await listen(http.createServer(a));
});
after(async () => {
  try { (await import('../src/bmusage/poller.js'))._setFleetForTest(null); } catch { /* */ }
  for (const c of closers) { try { await c(); } catch { /* */ } }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ }
});

const fleetBoth = async () => ({
  bareMetal: [
    { serverId: 'idrac-ve-ok', name: 've-ok-db01', serviceTag: 'VETAG01' },
    { serverId: 'idrac-ve-bad', name: 've-bad-db02', serviceTag: 'VETAG02' },
  ],
  virtualizationHosts: [],
});

async function history(key, role) {
  const res = await fetch(`${apiBase}/api/tools/bm-usage/history?key=${encodeURIComponent(key)}`, { headers: { 'x-role': role } });
  const txt = await res.text();
  return { status: res.status, txt, j: (() => { try { return JSON.parse(txt); } catch { return null; } })() };
}

test('① 수집 전(재시작 직후와 같다): 상세 조회는 상세를 지어내지 않고 상태 none 과 기록 시작 시각을 준다', async () => {
  const P = await import('../src/bmusage/poller.js');
  P._setFleetForTest(fleetBoth);
  const r = await history('VETAG01', 'admin');
  assert.equal(r.status, 200, r.txt.slice(0, 300));
  assert.equal(r.j.usageDetail, null, '수집하지 않은 서버의 상세는 null');
  assert.equal(r.j.usageDetailState, 'none');
  assert.equal(typeof r.j.usageDetailSince, 'number', '기록 시작 시각(화면이 "시작한 뒤 아직 수집하지 않았다" 를 말한다)');
});

test('② 폴러 1주기 뒤 관리자 상세 조회에 그 서버의 수집 상세(화면 필드 계약 그대로)가 실린다', async () => {
  const P = await import('../src/bmusage/poller.js');
  P._setFleetForTest(fleetBoth);
  const run = await P.pollBmUsageOnce({ trigger: 'manual' });
  assert.equal(run.ok, true, JSON.stringify(run).slice(0, 400));
  assert.equal(run.okCount, 1, JSON.stringify(run).slice(0, 400));
  assert.equal(run.failCount, 1);

  const ok = await history('VETAG01', 'admin');
  assert.equal(ok.status, 200, ok.txt.slice(0, 300));
  assert.equal(ok.j.usageDetailState, 'ok');
  const d = ok.j.usageDetail;
  assert.ok(d && typeof d === 'object', ok.txt.slice(0, 400));
  assert.deepEqual(Object.keys(d).sort(), [...P.USAGE_DETAIL_FIELDS].sort(), '응답 필드 = 화면 계약(USAGE_DETAIL_FIELDS)');
  assert.equal(d.ok, true);
  assert.ok(d.idracReports.includes('SystemUsage'), JSON.stringify(d));
  assert.equal(d.idracSeenReportCount, 2, '장비가 가진 리포트 수(목록을 자르더라도 개수는 따로)');
  assert.ok(Array.isArray(d.notes), 'buildUsage 노트가 배열로 실린다(예전엔 폴러가 버렸다)');
  assert.equal(typeof d.at, 'number');

  const bad = await history('VETAG02', 'admin');
  assert.equal(bad.status, 200, bad.txt.slice(0, 300));
  assert.equal(bad.j.usageDetailState, 'ok', '실패한 주기도 상세를 남긴다(그 사유가 곧 상세다)');
  assert.equal(bad.j.usageDetail.ok, false);
  assert.equal(bad.j.usageDetail.idracKind, 'unreachable');
  assert.ok(bad.j.usageDetail.idracError.includes(REDIRECT_IP), `관리자에게는 원래 문장 그대로: ${bad.j.usageDetail.idracError}`);

  // 웹 문구 함수가 이 응답으로 실제 문장을 만든다(번들 경계 — 웹 소스를 그대로 import 해 확인).
  const W = await import('../../web/src/views/tools/bmUsageText.js');
  assert.match(W.telemetryNote(d), /리포트 \*\*2종\*\* 중 \*\*\d+종\*\*을 읽었습니다/);
  assert.ok(W.detailNotes(bad.j.usageDetail).some((s) => s.includes('iDRAC 수집 실패')), JSON.stringify(W.detailNotes(bad.j.usageDetail)));
});

test('③ 비-관리자(operator) 상세 조회: 오류 문장 속 주소를 가리고, 상세는 그대로 싣는다', async () => {
  const P = await import('../src/bmusage/poller.js');
  P._setFleetForTest(fleetBoth);
  const r = await history('VETAG02', 'operator');
  assert.equal(r.status, 200, r.txt.slice(0, 300));
  assert.equal(r.j.usageDetailState, 'ok');
  const d = r.j.usageDetail;
  assert.ok(d, r.txt.slice(0, 300));
  assert.equal(d.idracKind, 'unreachable', '판정 필드는 그대로');
  assert.ok(!r.txt.includes(REDIRECT_IP), `operator 응답에 주소가 남았다: ${d.idracError}`);
  assert.ok(!r.txt.includes('127.0.0.1'), 'operator 응답에 등록부 주소가 남았다');
  assert.match(d.idracError, /masked-[0-9a-f]+/, '주소 자리는 표식으로');
  // 장치·센서 이름은 상세에 아예 없다(개수만).
  assert.ok(!r.txt.includes('NIC.Integrated'), 'FQDD 가 상세에 실렸다');
  const ok = await history('VETAG01', 'operator');
  assert.ok(!ok.txt.includes('NIC.Integrated'), 'FQDD 가 상세에 실렸다');
  assert.ok(!ok.txt.includes('127.0.0.1'));
});

test('④ 주 조회(/tools/bm-usage)에는 상세를 싣지 않는다(200대 × 상세면 수 MB)', async () => {
  const P = await import('../src/bmusage/poller.js');
  P._setFleetForTest(fleetBoth);
  const res = await fetch(`${apiBase}/api/tools/bm-usage`, { headers: { 'x-role': 'admin' } });
  const txt = await res.text();
  assert.equal(res.status, 200, txt.slice(0, 300));
  assert.ok(!txt.includes('"usageDetail"'), '주 조회에 상세가 실렸다');
});

test('⑤ 대상 목록에서 빠진 서버의 상세는 다음 주기에 정리된다(인메모리 상한 = 대상 수)', async () => {
  const P = await import('../src/bmusage/poller.js');
  P._setFleetForTest(async () => ({ bareMetal: [{ serverId: 'idrac-ve-ok', name: 've-ok-db01', serviceTag: 'VETAG01' }], virtualizationHosts: [] }));
  await P.pollBmUsageOnce({ trigger: 'manual' });
  assert.equal(P.usageDetailFor('VETAG02').state, 'none', '빠진 서버의 상세가 남았다(누수)');
  assert.equal(P.usageDetailFor('VETAG01').state, 'ok');
  P._resetForTest();
  assert.equal(P.usageDetailFor('VETAG01').state, 'none', '재시작(초기화) 뒤에는 다음 수집까지 비어 있다');
});

test('⑥ slimUsageDetail — 이름·경로를 빼고 개수만, 내부 키(__seenMetricIds)·크기 상한', async () => {
  const P = await import('../src/bmusage/poller.js');
  const big = 'x'.repeat(10_000);
  const built = {
    notes: Array.from({ length: 40 }, (_, i) => `노트 ${i} ${big}`),
    detail: {
      osKind: 'linux', osRead: ['cpu', 'mem'], osMissing: [], osAbsent: ['hba'], osError: '',
      idracKind: 'ids-unmatched', idracError: '', idracUsedIds: { cpu: 'SystemBoardCPUUsage', __seenMetricIds: ['a', 'b'] }, idracSeenIds: ['a', 'b', 'c'],
      idracReports: ['SystemUsage'], idracSeenReports: Array.from({ length: 150 }, (_, i) => `R${i}`), idracAbsent: ['hba'],
      interfaces: Array.from({ length: 300 }, (_, i) => ({ iface: `eth${i}`, bps: 10, bitsPerSec: null, pct: null })),
      fc: [{ host: 'host0', bps: 5, pct: null, pctOver: true, pctBasis: 'nominal' }], idracFc: [],
      mounts: [{ path: '/data', usedPct: 3 }], memDetail: { total: 1 },
      entTried: ['api'], entVia: 'api', entKind: '', entError: '', entUsedPaths: { cpu: '/redfish/v1/Chassis/x/Sensors/CPU' }, entUsedCmd: '',
      entUsedStat: null, entSeenSensors: ['CPU Usage', 'MEM Usage'], entSkipped: [{ step: 'ssh', reason: '예산', extra: 1 }], entRaw: big,
      license: { tier: 'enterprise' },
    },
  };
  const d = P.slimUsageDetail(built, { at: 1_790_000_000_000, ok: true });
  assert.deepEqual(Object.keys(d).sort(), [...P.USAGE_DETAIL_FIELDS].sort());
  assert.deepEqual(d.idracUsedIds, { cpu: 'SystemBoardCPUUsage' }, '내부 키·배열 값은 id 가 아니다');
  assert.equal(d.idracSeenIdCount, 3);
  assert.equal(d.idracSeenReportCount, 150, '목록은 잘라도 개수는 전체');
  assert.ok(d.idracSeenReports.length <= 100);
  assert.equal(d.entUsedPathCount, 1, 'Redfish 경로는 싣지 않고 개수만');
  assert.equal(d.entSeenSensorCount, 2, '센서 이름은 싣지 않고 개수만');
  assert.ok(d.interfaces.length <= 128, '장치 행 상한');
  assert.ok(!('iface' in d.interfaces[0]), '인터페이스 이름은 싣지 않는다');
  assert.ok(!('host' in d.fc[0]), 'FC 호스트 이름은 싣지 않는다');
  assert.equal(d.fc[0].pctBasis, 'nominal');
  assert.equal(d.fc[0].pctOver, true);
  assert.ok(!('mounts' in d) && !('license' in d) && !('memDetail' in d), '화면이 상세에서 읽지 않는 필드는 싣지 않는다');
  assert.ok(d.notes.length <= 24 && d.notes.every((x) => x.length <= 600));
  assert.ok(d.entRaw.length <= 2_400);
  assert.deepEqual(d.entSkipped, [{ step: 'ssh', reason: '예산' }]);
  // 크기(계산): 상한을 다 채운 최악의 상세 한 대가 40KB 안 — 200대여도 메모리 8MB 미만(보통 상세는 2~4KB).
  const worst = JSON.stringify(d).length;
  assert.ok(worst < 40_000, `최악 상세 ${worst}B`);
  // 원본은 바뀌지 않는다.
  assert.equal(built.detail.interfaces.length, 300);
  assert.ok('__seenMetricIds' in built.detail.idracUsedIds);
});

test('⑦ maskUsageDetail — 문장 속 IPv4·등록부 호스트는 표식, racadm 원문은 싣지 않고 그 사실을 밝힌다', async () => {
  const { maskUsageDetail } = await import('../src/routes/api/bmUsage.js');
  const src = {
    osError: 'ssh 10.1.2.3:22 거부', idracError: 'idrac-a.corp.example 응답 없음', entError: '', entRaw: 'banner 10.9.9.9 host idrac-a.corp.example',
    entSkipped: [{ step: 'ssh', reason: '10.4.4.4 예산' }], notes: ['노트 10.5.5.5', '주소 없는 노트'], idracKind: 'unreachable',
  };
  const m = maskUsageDetail(src, ['idrac-a.corp.example']);
  const s = JSON.stringify(m);
  for (const leak of ['10.1.2.3', '10.4.4.4', '10.5.5.5', '10.9.9.9', 'idrac-a.corp.example']) assert.ok(!s.includes(leak), `${leak} 가 남았다: ${s}`);
  assert.equal(m.entRaw, '');
  assert.equal(m.entRawHidden, true, '원문을 뺀 사실을 밝힌다');
  assert.equal(m.notes[1], '주소 없는 노트', '사람 문장은 그대로');
  assert.equal(m.idracKind, 'unreachable');
  assert.equal(src.entRaw.includes('10.9.9.9'), true, '원본은 바뀌지 않는다');
  assert.equal(maskUsageDetail({ entRaw: '' }).entRawHidden, undefined, '원문이 없으면 표지도 없다');
  assert.equal(maskUsageDetail(null), null);
});

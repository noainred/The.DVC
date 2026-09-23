/**
 * v2.598 감사 수정(그룹 d) 회귀 — DB2598-01~05 · T2598-01·02·04 · L2598-02·03.
 * 전부 실제 함수를 호출해 동작으로 본다. 기준 시각은 '정시 −30분' 으로 경계에서 떨어뜨려 고정한다
 * (CLAUDE.md v2.517 규약 — Date.now() 를 그대로 기준으로 쓰지 않는다).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2598d-'));
process.env.CONFIG_DIR = tmp;
process.env.PING_DB_PATH = path.join(tmp, 'ping-2598d.db');
process.env.SSRF_ALLOW_LOOPBACK = 'true';
process.env.STORAGE_ISILON_PORT = '1';          // 닫힌 포트 — 연결 거부(HTTP 응답 없음)
process.env.STORAGE_HTTP_TIMEOUT_MS = '3000';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;

after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

/* ── DB2598-01: ping 버킷이 정수로 묶인다 ─────────────────────────────── */
test('DB2598-01 ping history — 24시간 × 1분 표본을 1시간 버킷으로 묶는다(REAL 바인딩이면 표본마다 버킷)', async () => {
  const { getPingDb } = await import('../src/ping/db.js');
  const db = await getPingDb();
  const since = NOW - 24 * HOUR;
  const rows = [];
  for (let t = since; t < NOW; t += 60_000) rows.push({ target: 'p1', ts: t, rtt: 5, ok: (t / 60_000) % 10 !== 0 });
  db.insertMany(rows);
  const h = db.history('p1', since, HOUR, 500);
  assert.ok(h.length >= 24 && h.length <= 25, `버킷 수 ${h.length}`);
  assert.equal(h[0].ts % HOUR, 0, '버킷 시작이 정시');
  assert.ok(h.every((b) => b.n >= 30), `버킷당 표본 수 ${h.map((b) => b.n).join(',')}`);
  assert.ok(h.some((b) => b.loss > 0 && b.loss < 1), '손실률이 0/1 이 아닌 비율');
});

/* ── DB2598-02: 엣지의 같은 전력 표본을 매 pull 재적재하지 않는다 ─────────── */
test('DB2598-02 puller — 같은 ts 의 엣지 전력 표본은 한 번만 롤업한다', async () => {
  let body = { power: { byHost: [{ host: 'esx-1', watts: 500, ts: NOW - HOUR, serverId: 's1' }] }, servers: [] };
  const srv = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const { addCollector } = await import('../src/collector/registry.js');
    const { pullNow } = await import('../src/collector/puller.js');
    const { getCollectorStatus } = await import('../src/collector/state.js');
    const { getDb } = await import('../src/idrac/db.js');
    const r = addCollector({ id: 'edge2598', name: 'edge2598', url: `http://127.0.0.1:${srv.address().port}`, token: 't', enabled: true });
    assert.ok(r?.ok !== false, JSON.stringify(r));
    const db = await getDb();
    const cnt = async () => {
      const { DatabaseSync } = await import('node:sqlite');
      const { config } = await import('../src/config.js');
      const c = new DatabaseSync(config.idrac.dbPath);
      try { return Number(c.prepare("SELECT COALESCE(SUM(cnt),0) n FROM power_hourly WHERE server_id='rmt:esx-1'").get().n); } finally { c.close(); }
    };
    await pullNow();
    await pullNow();
    await pullNow();
    assert.equal(await cnt(), 1, '같은 표본 3회 pull → 롤업 1회');
    assert.equal(getCollectorStatus('edge2598')?.duplicateSkipped, 1, '건너뛴 개수를 상태에 밝힌다');
    body = { power: { byHost: [{ host: 'esx-1', watts: 700, ts: NOW - HOUR + 60_000, serverId: 's1' }] }, servers: [] };
    await pullNow();
    assert.equal(await cnt(), 2, '새 ts 는 적재한다');
    assert.equal(db.latest('rmt:esx-1')?.watts, 700);
  } finally { srv.close(); }
});

/* ── DB2598-03: 데이지체인 유닛은 합산한다 ──────────────────────────────── */
test('DB2598-03 PDU 전력 추이 — 유닛 1,000W + 500W = 장비 1,500W, 한 유닛을 못 읽은 시각은 빼고 개수를 밝힌다', async () => {
  const pdb = await import('../src/pdu/db.js');
  pdb._resetForTest();
  const t0 = NOW - 2 * HOUR;
  for (let i = 0; i < 5; i++) {
    await pdb.recordSnapshot({ id: 'pdu1', collectedAt: t0 + i * 60_000, units: [{ index: 1, powerW: 1000 }, { index: 2, powerW: 500 }] });
  }
  await pdb.recordSnapshot({ id: 'pdu1', collectedAt: t0 + 10 * 60_000, units: [{ index: 1, powerW: 1000 }, { index: 2, powerW: null }] });
  const r = await pdb.powerSeries(['pdu1'], { from: t0 - HOUR, to: t0 + HOUR, points: 10 });
  const s = r.series.find((x) => x.key === 'pdu1');
  assert.ok(s, '계열');
  const vals = s.avg.filter((v) => v != null);
  assert.ok(vals.length >= 1);
  assert.ok(vals.every((v) => v === 1500), `평균 ${vals.join(',')}`);
  assert.equal(s.maxTotal, 1500);
  assert.equal(r.partialSamples, 1, '부분 합 시각 1개를 밝힌다');
});

/* ── DB2598-04: guestdisk prune 이 현재 VM·파티션의 마지막 행을 남긴다 ─────── */
test('DB2598-04 guestdisk prune — 안정 VM 의 유일한 행·현재 파티션은 남기고, 사라진 VM 의 행은 지운다', async () => {
  const g = await import('../src/guestdisk/db.js');
  const old = NOW - 200 * DAY;
  const vm = (id) => ({ vmId: id, vmName: id, allocGB: 100, usedGB: 40, partCount: 1, parts: [{ path: '/', capGB: 100, usedGB: 40 }] });
  await g.commitCollection('vcA', 'vcA', [vm('vm-keep'), vm('vm-gone')], { ts: old });
  await g.commitCollection('vcA', 'vcA', [vm('vm-keep')], { ts: old + DAY }); // vm-gone 이 목록에서 사라졌다(값 불변 → 새 행 없음)
  const r = await g.prune(180);
  assert.ok(r.ok);
  const keep = await g.vmSeries('vm-keep', NOW - 30 * DAY);
  assert.equal(keep.length, 1, '이월 행이 있어야 한다(상세 추이가 비지 않는다)');
  assert.equal(keep[0].usedGB, 40);
  assert.deepEqual([...(await g.currentPartPaths('vm-keep'))], ['/'], '현재 파티션 목록 유지');
  assert.equal((await g.partSeries('vm-keep', NOW - 30 * DAY)).length, 1);
  assert.equal((await g.vmSeries('vm-gone', 0)).length, 0, '사라진 VM 의 행은 보존 기간 뒤 지운다');
});

/* ── DB2598-05 · L2598-02: 지표 설정 빈 칸은 미지정 ─────────────────────── */
test('L2598-02/DB2598-05 지표 설정 — 빈 칸은 이전 값 유지, 명시적 0 만 값이다', async () => {
  const m = await import('../src/metrics/settings.js');
  m.saveMetricsSettings({ retentionDays: 400, rawRetentionDays: 30, sampleIntervalMs: 120_000, gpuUtilIntervalSec: 90 });
  const a = m.saveMetricsSettings({ retentionDays: '', rawRetentionDays: null, sampleIntervalMs: '', gpuUtilIntervalSec: '' });
  assert.equal(a.retentionDays, 400);
  assert.equal(a.rawRetentionDays, 30);
  assert.equal(a.sampleIntervalMs, 120_000);
  assert.equal(a.gpuUtilIntervalSec, 90);
  const b = m.saveMetricsSettings({ rawRetentionDays: 0 });
  assert.equal(b.rawRetentionDays, 0, '명시적 0 은 저장');
});

/* ── L2598-03: 메일 설정 빈 칸 ─────────────────────────────────────────── */
test('L2598-03 메일 설정 — 빈 칸은 한도 0(무제한)·포트 1·시한 1초가 아니라 이전 값', async () => {
  const mail = await import('../src/mail/settings.js');
  mail.save({ rateLimitPerHour: 30, historyMax: 300, smtp: { host: '', port: 587, timeoutMs: 15000 } });
  const s = mail.save({ rateLimitPerHour: '', historyMax: '', smtp: { port: '', timeoutMs: '' } });
  assert.equal(s.rateLimitPerHour, 30);
  assert.equal(s.historyMax, 300);
  assert.equal(s.smtp.port, 587);
  assert.equal(s.smtp.timeoutMs, 15000);
  assert.equal(mail.save({ rateLimitPerHour: 0 }).rateLimitPerHour, 0, '명시적 0 = 제한 없음');
});

/* ── T2598-01: OneFS 영역 수집 — 회로 차단기·시한 ───────────────────────── */
test('T2598-01 영역 수집 — 응답 없는 장비는 연속 3회 뒤 멈추고 나머지를 시도하지 않았다고 밝힌다', async () => {
  const { collectAreasOnce, TRANSPORT_FAIL_LIMIT } = await import('../src/storage/areasCollector.js');
  const t = Date.now();
  const r = await collectAreasOnce({ id: 'isi1', host: '127.0.0.1', username: 'u', password: 'p' });
  assert.equal(r.stopped, 'transport');
  assert.equal(r.endpoints, TRANSPORT_FAIL_LIMIT, `시도한 엔드포인트 ${r.endpoints}(예전 66)`);
  assert.ok(r.notTried > 0);
  assert.ok(r.summary.some((x) => x.skipped && /응답 없음/.test(x.error || '')));
  assert.ok(Date.now() - t < 20_000);
});

test('T2598-01 영역 수집 — 시한(signal)이 끊으면 던지지 않고 멈춘 사유를 싣는다', async () => {
  const { collectAreasOnce } = await import('../src/storage/areasCollector.js');
  const ac = new AbortController(); ac.abort();
  const r = await collectAreasOnce({ id: 'isi2', host: '127.0.0.1', username: 'u', password: 'p' }, { signal: ac.signal });
  assert.equal(r.stopped, 'deadline');
  assert.equal(r.endpoints, 0);
});

/* ── T2598-02: 데드라인이 signal 을 abort 한다 ─────────────────────────── */
test('T2598-02 vCenter 로그·게스트 디스크 데드라인 — 결과 포기와 함께 signal 을 abort 한다', async () => {
  const { vcLogWithDeadline, vcLogDeadlineMs } = await import('../src/logs/poller.js');
  const keep = setInterval(() => {}, 1000); // 데드라인 타이머는 unref — 테스트 동안 이벤트 루프를 붙잡는다
  after(() => clearInterval(keep));
  let seen = null;
  await assert.rejects(vcLogWithDeadline({}, (sig) => { seen = sig; return new Promise(() => {}); }, 50), /데드라인/);
  assert.equal(seen?.aborted, true, '로그 수집 signal abort');
  assert.ok(vcLogDeadlineMs({ timeoutMs: 3e9 }) <= 2_147_000_000, 'setTimeout 상한');
  const { withTimeout } = await import('../src/guestdisk/service.js');
  let seen2 = null;
  await assert.rejects(withTimeout((sig) => { seen2 = sig; return new Promise(() => {}); }, 50, 'x'), /타임아웃/);
  assert.equal(seen2?.aborted, true, '게스트 디스크 signal abort');
});

/* ── T2598-04: adaptiveTimer 재무장이 진행 중 틱과 겹치지 않는다 ─────────── */
test('T2598-04 adaptiveTimer — 실행 중 주기 변경이 두 번째 동시 실행을 만들지 않는다', async () => {
  const { startAdaptiveTimer } = await import('../src/util/adaptiveTimer.js');
  const cbs = [];
  let ms = 60_000; let running = 0; let maxRun = 0; let runs = 0;
  const t = startAdaptiveTimer(() => ms, async () => {
    running++; runs++; maxRun = Math.max(maxRun, running);
    await new Promise((r) => setTimeout(r, 1600));
    running--;
  }, { firstDelayMs: 0, subscribe: (cb) => { cbs.push(cb); return () => {}; } });
  // 첫 틱은 하한 1초 뒤에 시작해 1.6초 돈다(1.0~2.6초). 그 사이(1.3초)에 주기를 1초로 줄인다 —
  // 예전 코드는 즉시 재무장해 2.3초에 두 번째 fn 을 겹쳐 실행했다.
  const t0 = Date.now();
  while (running === 0 && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 300));
  ms = 1000; cbs.forEach((c) => c());
  await new Promise((r) => setTimeout(r, 1700));
  t.stop();
  assert.equal(maxRun, 1, `동시 실행 ${maxRun}`);
  assert.ok(runs >= 1);
});

/* ── T2598-02 완결: 가짜 SOAP 서버로 abort 가 소켓을 실제로 끊는지 본다 ───────── */
function fakeSoap(hangOn) {
  const seen = []; const closed = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; });
    req.on('end', () => {
      const op = (/<(\w+) xmlns="urn:vim25"/.exec(b) || [])[1] || '?';
      seen.push(op);
      const send = (x) => { res.setHeader('Content-Type', 'text/xml'); res.end(`<soapenv:Envelope><soapenv:Body>${x}</soapenv:Body></soapenv:Envelope>`); };
      if (op === hangOn) { res.on('close', () => closed.push({ op, at: Date.now() })); return; } // 응답하지 않는다
      if (op === 'RetrieveServiceContent') return send('<returnval><propertyCollector>pc</propertyCollector><rootFolder>rf</rootFolder><viewManager>vm</viewManager><sessionManager>sm</sessionManager><eventManager>em</eventManager><about><version>8.0</version></about></returnval>');
      if (op === 'Login') { res.setHeader('Set-Cookie', 'vmware_soap_session=x'); return send('<returnval><key>s</key></returnval>'); }
      if (op === 'CreateCollectorForEvents') return send('<returnval type="EventHistoryCollector">session[1]col</returnval>');
      return send('<returnval></returnval>');
    });
  });
  return { srv, seen, closed };
}

test('T2598-02 collectVCenterEvents — 데드라인 abort 가 진행 중인 ReadNextEvents 소켓을 끊고, DestroyCollector·Logout 은 보낸다', async () => {
  const { srv, seen, closed } = fakeSoap('ReadNextEvents');
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const { collectVCenterEvents } = await import('../src/vcenter/soapClient.js');
    const { vcLogWithDeadline } = await import('../src/logs/poller.js');
    const vc = { id: 'vcx', host: `http://127.0.0.1:${srv.address().port}`, username: 'u', password: 'p', timeoutMs: 20_000 };
    const t0 = Date.now();
    await assert.rejects(vcLogWithDeadline(vc, (signal) => collectVCenterEvents(vc, { sinceTs: NOW - DAY, signal }), 300), /데드라인/);
    for (let i = 0; i < 50 && !(closed.length && seen.includes('Logout')); i++) await new Promise((r) => setTimeout(r, 40));
    assert.equal(closed.length, 1, '매달린 ReadNextEvents 소켓이 끊겨야 한다(건별 시한 20초가 아니라)');
    assert.ok(closed[0].at - t0 < 3000, `끊긴 시각 ${closed[0].at - t0}ms`);
    assert.ok(seen.includes('DestroyCollector'), `정리 호출 ${seen.join(',')}`);
    assert.ok(seen.includes('Logout'));
    assert.equal(seen.filter((o) => o === 'ReadNextEvents').length, 1, 'abort 뒤 다음 페이지를 읽지 않는다');
  } finally { srv.close(); srv.closeAllConnections?.(); }
});

test('T2598-02 collectDetails — 게스트 디스크 시한 abort 가 속성 조회 소켓을 끊고 Logout 은 보낸다', async () => {
  const { srv, seen, closed } = fakeSoap('RetrieveProperties');
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const { collectDetails } = await import('../src/vcenter/vmExport.js');
    const { withTimeout } = await import('../src/guestdisk/service.js');
    const vc = { id: 'vcy', host: `http://127.0.0.1:${srv.address().port}`, username: 'u', password: 'p', timeoutMs: 20_000 };
    const t0 = Date.now();
    await assert.rejects(withTimeout((signal) => collectDetails(vc, ['vm-1'], { signal }), 300, 'x'), /타임아웃/);
    for (let i = 0; i < 50 && !(closed.length && seen.includes('Logout')); i++) await new Promise((r) => setTimeout(r, 40));
    assert.ok(seen.includes('RetrieveProperties'), `호출 ${seen.join(',')}`);
    assert.equal(closed.length, 1, '매달린 조회 소켓이 끊겨야 한다');
    assert.ok(closed[0].at - t0 < 3000);
    assert.ok(seen.includes('Logout'));
  } finally { srv.close(); srv.closeAllConnections?.(); }
});

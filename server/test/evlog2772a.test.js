// v2.772(bughunt4 G1) — vCenter 이벤트 로그 폴러·DB·설정 화면 후속(Z1·Z2).
//  Z1-1 주기 도중 상태 표가 두 주기를 섞지 않는다(running · 상태는 끝난 주기 기준) · Z1-2 마지막 저장은 실시간 · Z1-3 '지금 수집' 먼저 응답(경주)
//  Z1-4 인증 정지·수집 제외 사유(진단·콘솔) · Z1-5 vCenter 하나의 건수도 (vcenterId, ts) 반열린 구간 조각 + 양보 · I-1 진척 근거 · I-3 콘솔·화면 같은 말
//  Z2-2 용량 확인은 둘째 주기부터 매 주기 + 주기 꼬리 시간 예산(기동 첫 틱 금지 · 보관기간 정리는 10주기에 1번 그대로) · Z2-3 직전 주기 정상 vCenter 먼저
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'evlog2772a-'));
process.env.CONFIG_DIR = TMP;
process.env.DATA_SOURCE = 'live';
process.env.VCLOGS_BATCH_ROWS = '100';
process.env.VCLOGS_CONCURRENCY = '1';
process.env.PRUNE_CHUNK_ROWS = '500';   // 용량 정리 청크 상한 — 시간 예산이 청크 단위로 끊는지 본다(Z2-2)   // Z2-3 — 수집 순서를 관찰하려고 한 번에 하나씩(이 파일의 모든 주기)
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

const H = 3_600_000;
const DAY = 24 * H;
const T0 = Math.floor(Date.now() / H) * H;   // 정시 경계로 고정(규칙)
const P = await import('../src/logs/poller.js');
const D = await import('../src/logs/db.js');
const { saveLogSettings } = await import('../src/logs/settings.js');
const { scopeVcLogStatus, vcLogCollectRace, VCLOG_COLLECT_WAIT_MS } = await import('../src/routes/admin/backupNetSec.js');
const { vcAuthGuard } = await import('../src/vcenter/restClient.js');
const { loadVcenterConfig } = await import('../src/config.js');
const { stripComments } = await import('./_stripComments.js');

/** 가짜 vCenter — ReadNextEvents 지연(readDelay) · beginTime 을 지킨다 · 첫 Login 시각을 남긴다. */
function fakeVcenter({ readDelay = 0 } = {}) {
  const state = { events: [], view: [], served: 0, logins: [] };
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; });
    req.on('end', () => {
      const op = (/<(\w+) xmlns="urn:vim25"/.exec(b) || [])[1] || '?';
      const send = (x) => { res.setHeader('Content-Type', 'text/xml'); res.end(`<soapenv:Envelope><soapenv:Body>${x}</soapenv:Body></soapenv:Envelope>`); };
      if (op === 'RetrieveServiceContent') return send('<RetrieveServiceContentResponse><returnval><propertyCollector>pc</propertyCollector><rootFolder>rf</rootFolder><viewManager>vm</viewManager><sessionManager>sm</sessionManager><eventManager>em</eventManager><about><version>8.0</version></about></returnval></RetrieveServiceContentResponse>');
      if (op === 'Login') { state.logins.push(process.hrtime.bigint()); res.setHeader('Set-Cookie', 'vmware_soap_session=x'); return send('<LoginResponse><returnval><key>s</key></returnval></LoginResponse>'); }
      if (op === 'CreateCollectorForEvents') {
        const begin = Date.parse((/<beginTime>([^<]+)<\/beginTime>/.exec(b) || [])[1] || '') || 0;
        state.view = state.events.filter((e) => e.ts >= begin).sort((x, y) => x.ts - y.ts || String(x.key).localeCompare(String(y.key)));
        state.served = 0;
        return send('<CreateCollectorForEventsResponse><returnval type="EventHistoryCollector">col</returnval></CreateCollectorForEventsResponse>');
      }
      if (op === 'ReadNextEvents') {
        const n = Number((/<maxCount>(\d+)<\/maxCount>/.exec(b) || [])[1] || 0);
        const page = state.view.slice(state.served, state.served + n);
        state.served += page.length;
        const xml = page.map((e) => `<returnval xsi:type="VmPoweredOnEvent"><key>${e.key}</key><createdTime>${new Date(e.ts).toISOString()}</createdTime><userName>u</userName><vm><name>vm-${e.key}</name></vm><fullFormattedMessage>on</fullFormattedMessage></returnval>`).join('');
        const body = `<ReadNextEventsResponse>${xml}</ReadNextEventsResponse>`;
        return readDelay ? setTimeout(() => send(body), readDelay) : send(body);
      }
      return send('<Response></Response>');
    });
  });
  return { srv, state };
}
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', r));
const closeSrv = (srv) => new Promise((r) => { srv.close(r); srv.closeAllConnections?.(); });
const quiet = () => { const w = mock.method(console, 'warn', () => {}); const l = mock.method(console, 'log', () => {}); return { w, l, restore: () => { w.mock.restore(); l.mock.restore(); } }; };
const writeRegistry = (list) => fs.writeFileSync(path.join(TMP, 'vcenters.json'), JSON.stringify({ vcenters: list }));
const vcEntry = (id, srv, extra = {}) => ({ id, name: id.toUpperCase(), host: `http://127.0.0.1:${srv.address().port}`, username: 'u', password: 'p', timeoutMs: 5000, ...extra });
const useDb = async (name) => {
  const dir = path.join(TMP, name); fs.mkdirSync(dir, { recursive: true });
  saveLogSettings({ storagePath: dir }); D.resetLogsDb();
  return D.getLogsDb();
};
const row = (vcenterId, key, ts) => ({ vcenterId, key, ts, severity: 'info', type: 'VmPoweredOnEvent', user: 'u', entity: 'e', message: `m ${'x'.repeat(300)}` });

/* ── 순수 ─────────────────────────────────────────────────────────────────────────────────────── */

test('Z1-5 순수 — vcCountSlices 는 반열린 구간 [a,b) 조각의 합이 한 문장 COUNT 와 같다(경계·같은 시각 묶음·마지막 조각 상한 없음) · 조각마다 yield', () => {
  const naive = (arr) => arr.length;
  const run = (arr, opts = {}) => {
    const ts = arr.map(Number);
    const it = D.vcCountSlices({ minTs: Math.min(...ts), maxTs: Math.max(...ts), countRange: (a, b) => ts.filter((t) => t >= a && t < b).length, countFrom: (a) => ts.filter((t) => t >= a).length, ...opts });
    let r; let steps = 0;
    while (!(r = it.next()).done) steps++;
    return { n: r.value, steps };
  };
  // 경계에 정확히 걸린 행 — 1시간 간격 시각 + 같은 시각 4건(첫 조각 폭 1시간이면 모든 행이 조각 경계 위)
  const boundary = []; for (let i = 0; i < 50; i++) { boundary.push(T0 + i * H); if (i % 7 === 0) boundary.push(T0 + i * H, T0 + i * H, T0 + i * H); }
  let clockT = 0; const fixedClock = (took) => () => (clockT += took);   // 소요를 고정해 폭 조절 갈래를 고른다
  for (const [label, opts] of [['기본', {}], ['폭 줄이기(늘 느림)', { clock: fixedClock(1000), startSpanMs: 4 * H }], ['폭 늘리기(늘 빠름)', { clock: fixedClock(0) }], ['폭 1ms', { startSpanMs: 1, clock: fixedClock(1000) }]]) {
    const { n, steps } = run(boundary, opts);
    assert.equal(n, naive(boundary), `${label}: 이중 계수·누락 없음`);
    assert.ok(steps >= 1, `${label}: 조각마다 양보 지점이 있다`);
  }
  // 조각이 늘 느려도 조각 수는 상한(VC_COUNT_MAX_SLICES) 안 — 폭이 1ms 까지 줄면 365일 구간이 조각 수백억 개다
  const year = [T0 - 365 * DAY, T0 - 100 * DAY, T0];
  const slow = run(year, { clock: fixedClock(1000), startSpanMs: 1 });
  assert.equal(slow.n, 3);
  assert.ok(slow.steps <= D.VC_COUNT_MAX_SLICES + 1, `조각 ${slow.steps}개`);
  // 한 행 · 같은 시각만 · 마지막 조각(상한 없음)이 MAX 와 같은 시각을 센다
  assert.equal(run([T0]).n, 1);
  assert.equal(run([T0, T0, T0]).n, 3);
  assert.equal(run([T0, T0 + H]).n, 2, '[T0, T0+H) 다음 마지막 조각 ts >= T0+H');
  // 무작위 대조(정수·비정수 시각)
  let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let k = 0; k < 200; k++) {
    const arr = Array.from({ length: 1 + Math.floor(rnd() * 60) }, () => T0 + Math.floor(rnd() * 10 * DAY) + (k % 3 === 0 ? rnd() : 0));
    if (k % 5 === 0) arr.push(arr[0], arr[0]);
    assert.equal(run(arr, { startSpanMs: 1 + Math.floor(rnd() * 2 * DAY), clock: fixedClock(Math.floor(rnd() * 20)) }).n, arr.length, `무작위 ${k}`);
  }
  // 넓은 구간은 여러 조각(조각마다 yield) — 예전에는 vCenter 하나가 한 문장(양보 없음)
  const wide = Array.from({ length: 2000 }, (_, i) => T0 - 120 * DAY + i * 90 * 60_000);
  assert.ok(run(wide, { clock: fixedClock(0) }).steps >= 8, '드문 구간도 폭을 두 배씩 늘리며 여러 조각으로');
});

test('Z2-2·Z2-3 순수 — 용량 정리 예산 = min(30초, 주기 시작 + 간격 − 5초 − 지금), 바닥 0 · 직전 주기 capped vCenter 는 뒤로(나머지 순서 그대로)', () => {
  assert.equal(P.capCleanupBudgetMs({ everyMs: 600_000, cycleStart: T0, now: T0 + 60_000 }), 30_000, '여유가 많으면 30초');
  assert.equal(P.capCleanupBudgetMs({ everyMs: 600_000, cycleStart: T0, now: T0 + 580_000 }), 15_000, '주기 끝 − 5초까지만');
  assert.equal(P.capCleanupBudgetMs({ everyMs: 600_000, cycleStart: T0, now: T0 + 700_000 }), 0, '주기를 넘겼으면 0(정리 루프는 청크 하나만)');
  assert.equal(P.capCleanupBudgetMs({ everyMs: 0, cycleStart: T0, now: T0 }), 30_000, '잘못된 간격은 기본 10분');
  const vcs = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id }));
  const capped = new Map([['a', true], ['c', true], ['d', false]]);
  assert.deepEqual(P.fairCollectOrder(vcs, (id) => capped.get(id)).map((v) => v.id), ['b', 'd', 'e', 'a', 'c']);
  assert.deepEqual(P.fairCollectOrder(vcs).map((v) => v.id), ['a', 'b', 'c', 'd', 'e'], '기록이 없으면 등록부 순서');
  assert.deepEqual(P.fairCollectOrder(null), []);
});

test('I-3 콘솔 상태 문구는 화면(vcLogCollect.js)과 같은 말 · failed 는 실패(예전 콘솔은 정체)', async () => {
  const W = await import('../../web/src/views/vcLogCollect.js');
  assert.deepEqual({ ...P.COLLECT_STATE_TEXT }, { ...W.VCLOG_STATE_TEXT });
  assert.equal(P.lagStateText('nobody', { skip: 'auth-stopped' }), '인증 정지');
  assert.equal(P.lagStateText('nobody', { skip: 'site' }), '수집 안 함');
  assert.equal(P.lagStateText('nobody'), '—');
});

test('Z1-3 지금 수집 경주 — 시한 안에 끝나면 결과 · 넘으면 {running, runningSince} 먼저(수집은 계속, 결과·거부는 콘솔) · 시한 전 거부는 그대로 던진다', async () => {
  assert.ok(VCLOG_COLLECT_WAIT_MS < 180_000, '브라우저 POST 시한(180초)보다 작게');
  assert.deepEqual(await vcLogCollectRace(Promise.resolve({ collected: 3 }), { waitMs: 1000 }), { collected: 3 });
  const lines = [];
  const l = mock.method(console, 'log', (...a) => lines.push(a.join(' ')));
  const w = mock.method(console, 'warn', (...a) => lines.push(a.join(' ')));
  try {
    let done;
    const slow = new Promise((r) => { done = r; });
    const r = await vcLogCollectRace(slow, { waitMs: 20, runningSinceOf: () => T0 });
    assert.deepEqual(r, { running: true, runningSince: T0 });
    done({ collected: 7, failed: [{ vcenterId: 'x' }] });
    await new Promise((res) => setImmediate(res));
    assert.ok(lines.some((x) => /먼저 응답한 '지금 수집' 이 끝났습니다\(7건 적재 · 수집 실패 1곳\)/.test(x)), lines.join('\n'));
    let fail;
    const late = new Promise((_, rej) => { fail = rej; });
    assert.deepEqual(await vcLogCollectRace(late, { waitMs: 20 }), { running: true });
    fail(new Error('boom'));
    await new Promise((res) => setImmediate(res));
    assert.ok(lines.some((x) => /먼저 응답한 '지금 수집' 이 실패했습니다: boom/.test(x)), '늦은 거부는 처리된 거부(콘솔) — 프로세스 unhandledRejection 이 아니다');
    await assert.rejects(vcLogCollectRace(Promise.reject(new Error('early')), { waitMs: 1000 }), /early/);
  } finally { l.mock.restore(); w.mock.restore(); }
  const src = stripComments(fs.readFileSync(new URL('../src/routes/admin/backupNetSec.js', import.meta.url), 'utf8'));
  const route = src.slice(src.indexOf("adminRouter.post('/vclogs/collect'"), src.indexOf("adminRouter.get('/net/agents'"));
  assert.match(route, /vcLogCollectRace\(pollLogsOnce\(\{ manual: true \}\), \{ runningSinceOf: logPollRunningSince \}\)/, '라우트가 경주를 쓴다');
  assert.match(route, /denyScopedRun\(req, res/, '범위 계정 403 그대로');
});

/* ── 실제 폴러 ─────────────────────────────────────────────────────────────────────────────────── */

test('Z1-1·Z1-2·I-1 실제 폴러 — 주기 도중 상태: running 이 서고 상태·읽음/저장은 끝난 주기 값(정상), 마지막 저장은 실시간 · 끝나면 진척 근거', async () => {
  const q = quiet();
  const { srv, state } = fakeVcenter({ readDelay: 40 });
  await listen(srv);
  let p2 = null;
  try {
    const db = await useDb('mid');
    saveLogSettings({ enabled: true, minSeverity: 'info', pollIntervalMin: 10, maxSizeMB: 0, retentionDays: 0 });
    writeRegistry([vcEntry('oc2', srv)]);
    const base = T0 - 2 * H;
    state.events = Array.from({ length: 50 }, (_, i) => ({ key: `a${i}`, ts: base + i * 60_000 }));
    await P.pollLogsOnce({ manual: true });
    let st = await P.logStatus();   // 건수 캐시를 채운다(최대 5분 — 아래에서 새 행이 들어와도 그대로)
    let c = st.collect.find((x) => x.vcenterId === 'oc2');
    assert.equal(c.state, 'ok'); assert.equal(c.running, null); assert.equal(c.lastPoll.read, 50);
    const okAt1 = c.okAt;
    // 둘째 주기 — 새 이벤트 1,500건(묶음 100 × 15, 쪽마다 40ms)을 읽는 동안 상태를 읽는다
    const t1 = base + 60 * 60_000;
    for (let i = 0; i < 1500; i++) state.events.push({ key: `n${i}`, ts: t1 + i * 1000 });
    p2 = P.pollLogsOnce({ manual: true });
    let mid = null;
    for (let i = 0; i < 300 && !mid; i++) {
      await new Promise((r) => setTimeout(r, 10));
      st = await P.logStatus();
      const m = st.collect.find((x) => x.vcenterId === 'oc2');
      if (m?.running && m.running.read >= 300 && m.running.read < 1500) mid = { st, m };
    }
    assert.ok(mid, '주기 도중 상태를 잡지 못했다');
    const m = mid.m;
    assert.ok(Number.isFinite(mid.st.runningSince), '응답에 진행 중인 주기의 시작 시각');
    assert.ok(m.running.since >= mid.st.runningSince && m.running.stored >= 290 && m.running.rounds >= 3, JSON.stringify(m.running));   // 시작 시각은 포함으로 다시 읽는다(중복 1건)
    assert.equal(m.state, 'ok', "직전 주기는 끝까지 읽었다 — 예전에는 묶음마다 덮인 capped 와 섞여 '따라잡기 중'");
    assert.equal(m.lastPoll.read, 50, '읽음/저장은 직전에 끝난 주기 값(진행분은 running)');
    assert.equal(m.ended, 'batch', '진행분의 묶음 기록은 그대로 싣는다(화면이 running 이면 진행 중으로 말한다)');
    assert.equal(m.lastStoredTs, db.lastTs('oc2'), '마지막 저장은 실시간(단독 MAX)');
    assert.ok(m.lastStoredTs >= t1, `캐시(5분)의 옛 마지막 저장이 아니다: ${new Date(m.lastStoredTs).toISOString()}`);
    assert.equal(mid.st.store.vcenters.find((v) => v.vcenterId === 'oc2').count, 50, '건수는 캐시 값 — 그래서 countsAt 을 함께 싣는다');
    assert.ok(Number.isFinite(mid.st.store.countsAt));
    await p2;
    st = await P.logStatus();
    c = st.collect.find((x) => x.vcenterId === 'oc2');
    assert.equal(c.running, null, '끝나면 진행 표지가 없다');
    assert.equal(st.runningSince, null);
    assert.equal(c.state, 'ok'); assert.equal(c.lastPoll.read, 1501, '새 1,500건 + 시작 시각 재읽기 1건');
    assert.equal(c.firstTs, base, '가장 오래된 보관 로그(단독 MIN)');
    assert.deepEqual({ okAtStart: c.lastPoll.okAtStart, okAtEnd: c.lastPoll.okAtEnd, everyMs: c.lastPoll.everyMs }, { okAtStart: okAt1, okAtEnd: c.okAt, everyMs: 600_000 }, 'I-1 진척 근거');
  } finally { await p2?.catch(() => {}); q.restore(); await closeSrv(srv); }
});

test('Z1-4 실제 폴러 — 인증 정지 vCenter 는 skip·state auth-stopped(콘솔도 사유) · 엣지 위임은 not-collected · 범위 거르기는 항목 단위 그대로', async () => {
  const lines = [];
  const w = mock.method(console, 'warn', (...a) => lines.push(a.join(' ')));
  const l = mock.method(console, 'log', () => {});
  const { srv, state } = fakeVcenter();
  await listen(srv);
  try {
    const db = await useDb('auth');
    saveLogSettings({ enabled: true, minSeverity: 'info', pollIntervalMin: 10, maxSizeMB: 0, retentionDays: 0 });
    writeRegistry([vcEntry('oc1', srv), vcEntry('pl1', srv), vcEntry('edge1', srv, { collectMode: 'site' })]);
    state.events = [{ key: 'k1', ts: T0 - 10 * 60_000 }];
    db.insertMany([row('pl1', 'old1', T0 - 3 * DAY), row('edge1', 'old2', T0 - 3 * DAY)]);
    const pl1 = loadVcenterConfig().vcenters.find((v) => v.id === 'pl1');
    vcAuthGuard.markAuthStopped('pl1', pl1, 'InvalidLogin');
    const r = await P.pollLogsOnce();   // 주기 수집(수동 아님) — 인증 정지는 건너뛴다
    assert.deepEqual(r.authStopped, ['pl1']);
    assert.ok(lines.some((x) => /pl1: 수집이 3\.\d일 뒤처짐\(읽음 —\/저장 —\) — 인증 정지\(주기 수집에서 건너뜀/.test(x)), `콘솔 지연 줄에 사유(예전 '— —'): ${lines.join('\n')}`);
    const st = await P.logStatus();
    const by = (id) => st.collect.find((x) => x.vcenterId === id);
    assert.deepEqual({ skip: by('pl1').skip, state: by('pl1').state }, { skip: 'auth-stopped', state: 'auth-stopped' }, "예전: 상태 null('—')인데 지연만 호박색");
    assert.deepEqual({ skip: by('edge1').skip, state: by('edge1').state }, { skip: 'site', state: 'not-collected' });
    assert.deepEqual({ skip: by('oc1').skip, state: by('oc1').state }, { skip: null, state: 'ok' });
    assert.ok(vcAuthGuard.peekAuthStop(pl1), '상태 조회는 정지 기록을 지우지 않는다(읽기 전용)');
    const scoped = scopeVcLogStatus(st, new Set(['pl1']));
    assert.deepEqual(scoped.collect.map((x) => [x.vcenterId, x.skip]), [['pl1', 'auth-stopped']], '범위 밖 vCenter 의 사유는 싣지 않는다');
  } finally { w.mock.restore(); l.mock.restore(); vcAuthGuard.clearAuthStop('pl1'); await closeSrv(srv); }
});

test('Z2-3 실제 폴러 — 직전 주기에 끝까지 못 읽은 vCenter 는 다음 주기에 뒤로(동시 1개에서 정상 vCenter 가 먼저 로그인)', async () => {
  const q = quiet();
  const lag = fakeVcenter({ readDelay: 40 }); const norm = fakeVcenter();
  await listen(lag.srv); await listen(norm.srv);
  try {
    await useDb('fair');
    saveLogSettings({ enabled: true, minSeverity: 'info', pollIntervalMin: 10, maxSizeMB: 0, retentionDays: 0 });
    writeRegistry([vcEntry('lag', lag.srv), vcEntry('norm', norm.srv)]);   // 등록부 순서: lag 먼저
    lag.state.events = Array.from({ length: 6000 }, (_, i) => ({ key: `l${i}`, ts: T0 - 2 * DAY + i * 1000 }));
    norm.state.events = [{ key: 'n1', ts: T0 - 5 * 60_000 }];
    await P.pollLogsOnce({ manual: true, budgetMs: 300 });   // lag 은 예산에서 멈춘다(capped)
    assert.equal(P.logCollectOk('lag')?.capped, true, JSON.stringify(P.logCollectOk('lag')));
    assert.equal(P.logCollectOk('norm')?.capped, false);
    assert.ok(lag.state.logins[0] < norm.state.logins[0], '첫 주기는 기록이 없어 등록부 순서');
    await P.pollLogsOnce({ manual: true, budgetMs: 300 });
    assert.ok(norm.state.logins[1] < lag.state.logins[1], '둘째 주기 — 직전 주기 정상인 norm 이 먼저(예전: 등록부 순서라 lag 의 예산 뒤)');
  } finally { q.restore(); await closeSrv(lag.srv); await closeSrv(norm.srv); }
});

test('Z1-5 실제 DB — 조각 건수 = 한 문장 COUNT(경계 위 행·같은 시각) · vCenter 하나를 세는 동안에도 여러 번 양보한다', async () => {
  const db = await useDb('meta');
  const rows = [];
  for (let i = 0; i < 6000; i++) {
    rows.push(row('big', `b${i}`, T0 - 125 * DAY + i * 30 * 60_000));   // 30분 간격 — 절반은 조각 경계(1시간 배수) 위
    if (i % 500 === 0) for (let j = 0; j < 3; j++) rows.push(row('big', `b${i}d${j}`, T0 - 125 * DAY + i * 30 * 60_000));
  }
  rows.push(row('small', 's1', T0 - DAY));
  db.insertMany(rows);
  const { DatabaseSync } = await import('node:sqlite');
  const ref = new DatabaseSync(db.path, { readOnly: true });
  const exact = Object.fromEntries(ref.prepare('SELECT vcenterId v, COUNT(*) n FROM events GROUP BY vcenterId').all().map((r) => [r.v, r.n]));
  ref.close();
  let turns = 0; let live = true;
  const spin = () => { if (!live) return; turns++; setImmediate(spin); };
  setImmediate(spin);
  const m = await db.metaAsync({ yieldMs: 0.001 });
  live = false;
  assert.deepEqual(Object.fromEntries(m.vcenters.map((v) => [v.vcenterId, v.count])), exact, '이중 계수·누락 없음');
  assert.equal(m.count, 6000 + 12 * 3 + 1);
  assert.ok(turns >= 8, `vCenter 둘인데 양보가 ${turns}회뿐이다(예전: vCenter 사이에서만 — 한 vCenter 는 한 문장)`);
  assert.deepEqual(db.meta().vcenters, m.vcenters, '동기 meta 도 같은 결과(같은 생성기)');
  const src = stripComments(fs.readFileSync(new URL('../src/logs/db.js', import.meta.url), 'utf8'));
  assert.match(src, /COUNT\(\*\) n FROM events WHERE vcenterId=\? AND ts>=\? AND ts<\?/, '반열린 구간 [a, b)');
  const raw = fs.readFileSync(new URL('../src/logs/db.js', import.meta.url), 'utf8');
  assert.doesNotMatch(raw, /남는 한계: vCenter 하나의 COUNT 는 여전히 한 문장이다/, "고친 뒤 '남는 한계' 문구는 정정한다(루트 규칙)");
});

test('Z2-2 실제 폴러 — 용량: 기동 첫 틱은 보지 않고, 둘째 주기부터 매 주기 · 넘었을 때만 · 주기 꼬리 시간 예산 안에서(남으면 다음 주기) · 끝나면 상한 아래', async () => {
  const q = quiet();
  try {
    const db = await useDb('cap');
    if (db.kind !== 'sqlite') return;
    writeRegistry([]);
    saveLogSettings({ enabled: true, minSeverity: 'info', pollIntervalMin: 10, maxSizeMB: 1, retentionDays: 0 });
    const LIMIT = 1024 * 1024;
    const fill = (tag, n) => db.insertMany(Array.from({ length: n }, (_, i) => row('cap', `${tag}${i}`, T0 - 200 * DAY + i * 1000)));
    fill('a', 12_000);
    assert.ok(db.usedBytes() > 3 * LIMIT, `사전 적재가 상한보다 커야 한다(${db.usedBytes()})`);
    P._resetTickForTest();
    const n0 = db.rowCount();
    await P.pollLogsOnce({ manual: true });   // tick 1
    assert.equal(db.rowCount(), n0, '기동 첫 틱은 용량 정리를 하지 않는다(스로틀 규칙)');
    assert.equal((await P.logStatus()).lastCap, undefined);
    await P.pollLogsOnce({ manual: true });   // tick 2 — 예전에는 10번째 주기까지 기다렸다
    assert.ok(db.usedBytes() <= LIMIT, `둘째 주기에 상한 아래로(${db.usedBytes()})`);
    let cap = (await P.logStatus()).lastCap;
    assert.ok(cap && cap.dropped > 0 && cap.done === true && cap.stuck === false && cap.limitBytes === LIMIT && cap.budgetMs > 0, JSON.stringify(cap));
    const n2 = db.rowCount();
    assert.ok(n2 > 500, `상한 만큼만 지운다(남은 ${n2}행)`);
    await P.pollLogsOnce({ manual: true });   // tick 3 — 상한 아래면 지우지 않는다
    assert.equal(db.rowCount(), n2, '넘지 않았으면 지우지 않는다');
    assert.equal((await P.logStatus()).lastCap.at, cap.at, 'lastCap 은 넘었을 때만 갱신');
    // 예산 0(주기 꼬리를 다 썼다) — 청크 하나만 지우고 남은 초과분은 다음 주기
    fill('b', 12_000);
    const before = db.rowCount();
    await P.pollLogsOnce({ manual: true, capBudgetMs: 0 });   // tick 4
    cap = (await P.logStatus()).lastCap;
    assert.ok(cap.dropped > 0 && cap.dropped <= 500, `시간 예산 0 — 청크 하나(상한 500)만 지운다(지운 ${cap.dropped}건)`);
    assert.equal(cap.done, false); assert.equal(cap.stuck, false, '예산이 끊은 단계는 정체로 보지 않는다');
    assert.ok(db.usedBytes() > LIMIT && db.rowCount() === before - cap.dropped);
    await P.pollLogsOnce({ manual: true });   // tick 5 — 이어서 상한 아래로
    assert.ok(db.usedBytes() <= LIMIT); assert.equal((await P.logStatus()).lastCap.done, true);
  } finally { q.restore(); saveLogSettings({ maxSizeMB: 1024, retentionDays: 365 }); }
});

test('Z2-2 실제 폴러 — 보관기간 정리는 예전대로 10주기에 1번(첫 틱 금지) · 소스: 용량 확인이 % PRUNE_EVERY 안에 있지 않다', async () => {
  const q = quiet();
  try {
    const db = await useDb('ret');
    if (db.kind !== 'sqlite') return;
    writeRegistry([]);
    saveLogSettings({ enabled: true, minSeverity: 'info', pollIntervalMin: 10, maxSizeMB: 1024, retentionDays: 1 });
    db.insertMany(Array.from({ length: 300 }, (_, i) => row('r', `r${i}`, T0 - 5 * DAY + i)));
    P._resetTickForTest();
    for (let i = 1; i <= 9; i++) await P.pollLogsOnce({ manual: true });
    assert.equal(db.rowCount(), 300, '9주기까지 보관기간 정리를 하지 않는다');
    await P.pollLogsOnce({ manual: true });
    await db.pruneInFlight?.();
    assert.equal(db.rowCount(), 0, '10번째 주기에 정리');
  } finally { q.restore(); saveLogSettings({ storagePath: '', maxSizeMB: 1024, retentionDays: 365 }); D.resetLogsDb(); }
  const src = stripComments(fs.readFileSync(new URL('../src/logs/poller.js', import.meta.url), 'utf8'));
  assert.match(src, /if \(s\.maxSizeMB > 0 && thisTick > 1\)/, '용량 확인은 둘째 주기부터 매 주기');
  assert.match(src, /if \(\(thisTick % PRUNE_EVERY\) === 0 && s\.retentionDays > 0\)/, '보관기간 정리는 10주기에 1번');
});

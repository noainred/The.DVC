/**
 * 베어메탈 사용률 점검 반복 3회차(기준판 5c6d87a6b) D2 — 끝난(· 지운 · 만료된) 중앙 정비 창이 엣지 배포본에서 빠져 엣지 서버의 ⑤ 분모 제외가 소급해 사라지던 결함.
 *   실제 centralRouter `/api/central/bm-maint` ↔ 실제 엣지 워커 `pullBmMaintNow`(엣지 = 자식 프로세스 · 자기 CONFIG_DIR) — 두 문맥(중앙 · 엣지)으로 같은 소비처를 대조한다:
 *   용량 예측 날 제외(capacity.computeServer) · 저활용 날 제외(idle.computeIdleServer) · 베이스라인 롤업 제외(runtime.exclusionFor).
 *   ① 창 진행 중 인출 — 지금 억제(windows) + 지난 구간용 history(끝남 · 지움 · 만료) · 엣지 ⑤ = 중앙 ⑤ · history 는 지금 판정에 들지 않는다
 *   ② 그 창을 끝낸 뒤 다음 인출 — 창이 history 로 옮겨도 엣지의 지난 날 제외가 남는다(재현: 예전 제외 구간 [] · 용량 제외 날 [] · exclOf 0구간)
 *   ③ 배포본 24시간 시한 — 지금 억제는 꺼지고 history 는 남는다(마지막으로 받은 것)
 *   ④ 구버전 엣지 호환(본문 windows · sig 는 예전 그대로 · maintBodyOk) · 엣지 정제(형식 밖 · 90일 · 개수 · 크기 상한)
 * 기준 시각: 실제 시각을 정시로 떨어뜨린 T0(창 파일은 실제 시각으로 판정된다 — common.md).
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bmloop3e-c-'));
const EDIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bmloop3e-e-'));
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = 'live';
delete process.env.CENTRAL_URL;
const MIN = 60_000; const HOUR = 3_600_000; const DAY = 86_400_000;
const T0 = Math.floor(Date.now() / HOUR) * HOUR;
const REGISTRY = [{ id: 'vcE', name: 'KR-EDGE', host: 'e.invalid', collectMode: 'site', remoteAgent: 'Edge-A' }, { id: 'vcC', name: 'KR-CENTRAL', host: 'c.invalid' }];
const TARGET = { key: 'E1', serviceTag: 'E1', vcenterId: 'vcE', paths: ['os'] };

let srv; let port; let tokA; let ST; let S; let DP; let R; let C; let I; let W;
const loc = (ms) => S.fmtLocal('Asia/Seoul', ms).replace(' ', 'T');
let MOUNT = []; let DAILY = [];

before(async () => {
  const SHARED = 'shared-central-token-1234567890abcdef';
  fs.writeFileSync(path.join(DIR, 'vcenters.json'), JSON.stringify({ vcenters: REGISTRY }));
  fs.writeFileSync(path.join(DIR, 'portal.env'), `CENTRAL_TOKEN=${SHARED}\n`);
  process.env.CENTRAL_TOKEN = SHARED;
  const express = (await import('express')).default;
  const { centralRouter } = await import('../src/routes/central.js');
  const { store } = await import('../src/store.js');
  store.snapshot = { ...store.get(), vcenters: REGISTRY.map((v) => ({ id: v.id, name: v.name })) };
  tokA = (await import('../src/central/agentTokens.js')).issueAgentToken('Edge-A').token;
  S = await import('../src/bmusage/maint/schedule.js');
  ST = await import('../src/bmusage/maint/store.js');
  DP = await import('../src/bmusage/maint/deploy.js');
  R = await import('../src/bmusage/maint/runtime.js');
  C = await import('../src/bmusage/capacity.js');
  I = await import('../src/bmusage/idle.js');
  W = await import('../src/agent/bmMaintPull.js');
  const { dayKey } = await import('../src/util/dayKey.js');
  // 두 문맥이 같은 일 롤업을 본다(소비처의 날 제외만 다르게 나올 수 있게)
  const days = Array.from({ length: 33 }, (_, b) => dayKey(T0 - (32 - b) * DAY));
  MOUNT = days.map((d, i) => ({ day: d, mount: '/data', used_pct_max: 40 + i * 0.5, inode_pct_max: 3, size_bytes: 1e12 }));
  DAILY = days.map((d) => ({ day: d, mem_max: 50, mem_avg: 30, cpu_avg: 5, cpu_max: 10 }));
  const E = await import('../src/central/bmUsageEdgePull.js');
  E.putEdgeBmUsage('Edge-A', { ok: true, snap: { targets: [{ key: 'E1', serviceTag: 'E1', vcenterId: 'vcE' }], maintVer: 1 } });
  const app = express();
  app.use(express.json());
  app.use('/api/central', centralRouter);
  srv = http.createServer(app);
  port = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
});
after(() => { try { srv?.close(); } catch { /* */ } fs.rmSync(DIR, { recursive: true, force: true }); fs.rmSync(EDIR, { recursive: true, force: true }); });

/** 한 문맥의 ⑤ 소비처 출력(중앙 · 엣지가 같은 코드 — 엣지 자식에 같은 글자로 넘긴다). */
const CONSUMERS = `
  async function consumers({ R, C, I, now, target, mount, daily, pastAt }) {
    const J = await R.maintJudge({ now });
    const monthStore = { readMountDaily: async () => ({ rows: mount }), readDailyRange: async () => ({ live: daily, mig: [] }) };
    const from = now - 31 * 86400000;
    const cover = J.cover(target, from, now, 'exclude').map((x) => ({ from: x.from, to: x.to, ids: [...x.ids].sort() }));
    const cap = await C.computeServer({ agent: '', target, now, judge: J, series: true, xfs: new Set(), deps: { monthStore } });
    const idle = await I.computeIdleServer({ agent: '', target, now, judge: J, deps: { monthStore } });
    const excl = R.exclusionFor(J, () => target).exclOf(target.key, from, now);
    const st = J.stateFor(target, now);
    const past = pastAt ? J.stateFor(target, pastAt) : null;
    return { cover, capEx: cap.excludedDays, idleEx: idle.excludedDays, excl: excl.length, exclIds: [...new Set(excl.flatMap((x) => x.ids))].sort(),
      stNow: { active: st.active, ids: st.windows.map((w) => w.id).sort() }, past: past ? { active: past.active, ids: past.windows.map((w) => w.id).sort() } : null };
  }
`;

/** 엣지 자식 — (pull 이면) 한 번 인출하고 ⑤ 소비처 · 판정 · 배포본 상태를 출력. */
function edgeRun({ now, pastAt = null, pull = true }) {
  const imp = (p) => JSON.stringify(path.join(HERE, '../src', p));
  const code = `
    ${CONSUMERS}
    const Wk = await import(${imp('agent/bmMaintPull.js')});
    const r = ${pull ? 'await Wk.pullBmMaintNow()' : 'null'};
    const ST = await import(${imp('bmusage/maint/store.js')});
    const R = await import(${imp('bmusage/maint/runtime.js')});
    const C = await import(${imp('bmusage/capacity.js')});
    const I = await import(${imp('bmusage/idle.js')});
    const w = ST.windowsForJudge(${now});
    const out = await consumers({ R, C, I, now: ${now}, target: ${JSON.stringify(TARGET)}, mount: ${JSON.stringify(MOUNT)}, daily: ${JSON.stringify(DAILY)}, pastAt: ${pastAt == null ? 'null' : pastAt} });
    console.log('@@' + JSON.stringify({ r, deployed: w.deployed, items: w.windows.filter((x) => x.origin === 'central' && !x.history).map((x) => x.id).sort(),
      hist: w.windows.filter((x) => x.history).map((x) => x.id).sort(), ...out }));
  `;
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['--input-type=module', '-e', code], {
      env: { ...process.env, CONFIG_DIR: EDIR, CENTRAL_URL: `http://127.0.0.1:${port}`, CENTRAL_TOKEN: tokA, AGENT_CENTRAL_TOKEN: tokA, AGENT_NAME: 'Edge-A', DATA_SOURCE: 'live' },
      encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      const line = String(stdout).split('\n').find((l) => l.startsWith('@@'));
      if (!line) return reject(new Error(`엣지 자식 출력 없음: ${err?.message || ''}\n${stderr}\n${stdout}`.slice(0, 3000)));
      resolve(JSON.parse(line.slice(2)));
    });
  });
}
async function centralRun({ now, pastAt = null }) {
  // eslint-disable-next-line no-new-func
  const consumers = new Function(`${CONSUMERS}; return consumers;`)();
  ST._resetMaintStoreForTest();
  return consumers({ R, C, I, now, target: TARGET, mount: MOUNT, daily: DAILY, pastAt });
}

const ids = {};
test('① 창 진행 중 인출 — 지금 억제 + history · 엣지 ⑤ = 중앙 ⑤ · history 는 지금 판정에 들지 않는다', async () => {
  const sc = { exclude: true, alerts: true };
  const base = { reason: 'r', target: { kind: 'server', keys: ['E1'] }, vcenterId: 'vcE', tz: 'Asia/Seoul', scopes: sc };
  // 끝난 일회 창(그제 6시간)
  ids.W1 = (await ST.addWindow({ ...base, name: 'W1 끝남', schedule: { kind: 'once', start: loc(T0 - 2 * DAY), end: loc(T0 - 2 * DAY + 6 * HOUR) } }, { by: 'op', now: T0 - 3 * DAY })).id;
  // 지운 창(묘비 — 닷새 전 6시간 · 그 뒤에 지움 → 지운 시각까지 = 발생 전부)
  const w2 = await ST.addWindow({ ...base, name: 'W2 지움', schedule: { kind: 'once', start: loc(T0 - 5 * DAY), end: loc(T0 - 5 * DAY + 6 * HOUR) } }, { by: 'op', now: T0 - 6 * DAY });
  await ST.deleteWindow(w2.id, { by: 'op', rev: w2.rev, now: T0 - 4 * DAY });
  ids.W2 = w2.id;
  // 재확인 만료된 반복 창(100일 전 확인 → 8일 전 만료 · 열흘 전 요일 03:00 2시간 — 만료 전 발생만 지난 구간)
  const dow = new Date(T0 - 10 * DAY + 9 * HOUR).getUTCDay();
  ids.W3 = (await ST.addWindow({ ...base, name: 'W3 만료', schedule: { kind: 'weekly', days: [dow], time: '03:00', durMin: 120 } }, { by: 'op', now: T0 - 100 * DAY })).id;
  // 진행 중 창(지금 억제)
  ids.W4 = (await ST.addWindow({ ...base, name: 'W4 진행 중', schedule: { kind: 'once', start: loc(T0 - 30 * MIN), end: loc(T0 + 3 * HOUR) } }, { by: 'op', now: T0 })).id;
  ST._resetMaintStoreForTest();
  const now = Date.now();
  const pastAt = T0 - 2 * DAY + 3 * HOUR;   // W1 발생 한가운데
  const e = await edgeRun({ now, pastAt });
  const c = await centralRun({ now, pastAt });
  assert.equal(e.r.ok, true, JSON.stringify(e.r));
  // 엣지 ⑤ = 중앙 ⑤(세 소비처) — 재현 r3: 예전 엣지는 진행 중 창(W4)만 받아 W1 · W2 · W3 의 지난 날이 빠졌다
  assert.deepEqual(e.capEx, c.capEx, '용량 예측 날 제외'); assert.equal(e.idleEx, c.idleEx, '저활용 날 제외');
  assert.equal(e.excl, c.excl, '베이스라인 제외 구간'); assert.deepEqual(e.exclIds, c.exclIds);
  assert.deepEqual(e.cover, c.cover, '제외 구간');
  assert.deepEqual(e.exclIds, [ids.W1, ids.W2, ids.W3, ids.W4].sort());
  assert.equal(e.r.history, 3, 'history = 끝남 · 지움 · 만료');
  assert.deepEqual(e.items, [ids.W4], '지금 억제용은 진행 중 창만');
  assert.deepEqual(e.hist, [ids.W1, ids.W2, ids.W3].sort());
  // 지금 판정 — 진행 중 창만 · history 창은 그 발생 시각에서도 억제를 만들지 않는다(중앙 원본은 그때 억제였다)
  assert.deepEqual(e.stNow, c.stNow); assert.deepEqual(e.stNow.ids, [ids.W4]);
  assert.deepEqual(c.past.ids, [ids.W1], '중앙 — 그 시각에는 W1 안');
  assert.deepEqual(e.past, { active: false, ids: [] }, 'history 는 지금 판정(억제)에 쓰지 않는다');
});

test('② 창을 끝낸 뒤 다음 인출 — history 로 옮겨도 엣지의 지난 날 제외가 남는다(재현: 예전 [] · [] · 0)', async () => {
  const w4 = ST.getWindow(ids.W4);
  await ST.endWindowNow(ids.W4, { by: 'op', rev: w4.rev, now: Date.now() });
  ST._resetMaintStoreForTest();
  const now = Date.now() + 1;
  const e = await edgeRun({ now });
  const c = await centralRun({ now });
  assert.equal(e.r.ok, true); assert.equal(e.r.kept, 0, '지금 억제용 창 없음');
  assert.ok(e.cover.length >= 4, `제외 구간 ${e.cover.length}개(예전 엣지: 0)`);
  assert.deepEqual(e.cover, c.cover);
  assert.ok(e.capEx.length >= 4, `용량 제외 날 ${JSON.stringify(e.capEx)}(예전 엣지: [])`);
  assert.deepEqual(e.capEx, c.capEx); assert.equal(e.idleEx, c.idleEx); assert.ok(e.idleEx >= 3, '저활용 제외 날(오늘은 저활용 계산에서 원래 빠진다)');
  assert.equal(e.excl, c.excl); assert.deepEqual(e.exclIds, [ids.W1, ids.W2, ids.W3, ids.W4].sort(), '베이스라인 제외(예전 엣지: 0구간)');
  // 끝낸 창은 끝낸 시각까지(지금 끝내기 반영 — 중앙과 같은 자름)
  const w4c = e.cover.find((x) => x.ids.includes(ids.W4));
  assert.ok(w4c && w4c.to <= now && w4c.to > T0 - 30 * MIN, JSON.stringify(w4c));
  assert.deepEqual(e.stNow, { active: false, ids: [] });
  assert.equal(e.r.history, 4); assert.deepEqual(e.items, []); assert.deepEqual(e.hist, [ids.W1, ids.W2, ids.W3, ids.W4].sort());
});

test('③ 배포본 24시간 시한 — 지금 억제는 꺼지고 history 는 남는다(마지막으로 받은 것)', async () => {
  const base = { reason: 'r', target: { kind: 'server', keys: ['E1'] }, vcenterId: 'vcE', tz: 'Asia/Seoul', scopes: { exclude: true, alerts: true } };
  ids.W5 = (await ST.addWindow({ ...base, name: 'W5 진행 중', schedule: { kind: 'once', start: loc(T0 - 20 * MIN), end: loc(T0 + 3 * HOUR) } }, { by: 'op', now: T0 })).id;
  ST._resetMaintStoreForTest();
  const now = Date.now();
  const e1 = await edgeRun({ now });
  assert.deepEqual(e1.stNow.ids, [ids.W5], '받은 직후 — 지금 억제');
  // 받은 시각을 25시간 전으로(엣지 배포본 파일 — 배포가 끊긴 엣지)
  const f = path.join(EDIR, 'maintenance-windows-deployed.json');
  const o = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(o.history.length, 4, '파일에 history 를 따로 둔다');
  fs.writeFileSync(f, JSON.stringify({ ...o, at: now - 25 * HOUR }));
  const e2 = await edgeRun({ now, pull: false });
  assert.equal(e2.deployed.stale, true);
  assert.deepEqual(e2.stNow, { active: false, ids: [] }, '시한 지난 배포본은 지금 억제에 쓰지 않는다');
  assert.deepEqual(e2.items, []);
  assert.deepEqual(e2.hist, [ids.W1, ids.W2, ids.W3, ids.W4].sort(), 'history 는 시한과 무관하게 남는다');
  const c = await centralRun({ now });
  // W4(끝냄) · W5(진행 중)는 겹쳐 중앙에서 한 구간으로 합쳐진다 — 그 앞(W1 · W2 · W3)은 그대로 대조하고 W4 는 끝낸 시각까지 따로 본다
  const before4 = (cv) => cv.filter((x) => x.to <= T0 - 30 * MIN);
  assert.ok(before4(e2.cover).length >= 3);
  assert.deepEqual(before4(e2.cover), before4(c.cover), '지난 구간(history 창)은 중앙과 같다');
  const w4 = ST.getWindow(ids.W4);
  assert.ok(e2.cover.some((x) => x.ids.includes(ids.W4) && x.to === w4.endedAt), 'W4 는 끝낸 시각까지(history)');
  assert.deepEqual(e2.exclIds, [ids.W1, ids.W2, ids.W3, ids.W4].sort());
});

test('④ 구버전 엣지 호환 · 엣지 정제(형식 밖 · 90일 · 개수 · 크기 상한) · 직전 history 유지', async () => {
  // 본문: windows · sig 는 예전 그대로(지금 억제용만 · sig = windows 서명) — 구버전 엣지는 history 를 모르고 무시한다
  const body = await DP.deployFor('Edge-A', { verified: true, now: Date.now() });
  assert.equal(W.maintBodyOk({ ok: true, ...body }), true);
  assert.deepEqual(body.windows.map((x) => x.id), [ids.W5]);
  assert.equal(body.sig, DP.sigOf(body.windows), '서명은 지금 억제용 windows 만으로(배포 현황 ‘반영됨’ 뜻 그대로)');
  assert.equal(body.historyVer, DP.HISTORY_VER);
  assert.ok(body.history.every((x) => !body.windows.some((y) => y.id === x.id)));
  assert.equal(body.history.find((x) => x.id === ids.W2).deleted?.at, T0 - 4 * DAY, '묘비는 지운 시각을 싣는다');
  // 구버전 엣지의 저장(history 인자 없음) — 지금 억제는 예전과 같다
  const ODIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bmloop3e-o-'));
  const prevDir = process.env.CONFIG_DIR;
  const { config } = await import('../src/config.js');
  const keep = config.configDir;
  try {
    config.configDir = ODIR; ST._resetMaintStoreForTest();
    ST.saveDeployed(body.windows, { sig: body.sig, now: Date.now() });
    const MJ = await R.maintJudge({ now: Date.now() });
    assert.deepEqual(MJ.stateFor(TARGET, Date.now()).windows.map((w) => w.id), [ids.W5]);
    // 엣지 정제 — history 도 같은 normalizeWindow · 지금 창과 같은 id 는 뺀다 · 90일 지난 것은 비운다 · 개수 상한
    const now = Date.now();
    const good = body.history.find((x) => x.id === ids.W1);
    const old = { ...good, id: 'mw-old000001', schedule: { kind: 'once', start: loc(now - 120 * DAY), end: loc(now - 120 * DAY + HOUR) }, at: now - 121 * DAY, confirmedAt: now - 121 * DAY };
    const bad = { ...good, id: 'mw-bad000001', scopes: { nope: true } };
    const dupLive = { ...good, id: ids.W5 };
    const many = Array.from({ length: ST.DEPLOY_HISTORY_MAX + 40 }, (_, i) => ({ ...good, id: `mw-many${String(i).padStart(5, '0')}` }));
    const r = ST.saveDeployed(body.windows, { sig: body.sig, now, history: [good, old, bad, dupLive, ...many] });
    assert.equal(r.history, ST.DEPLOY_HISTORY_MAX, '개수 상한');
    assert.ok(r.historyDropped >= 41, `형식 밖 · 상한(${r.historyDropped})`);
    const d = ST.loadDeployed(now);
    assert.ok(!d.history.some((x) => x.id === 'mw-old000001'), '90일 지난 창은 비운다(중앙 정리와 같은 keptPast)');
    assert.ok(!d.history.some((x) => x.id === ids.W5), '지금 창과 같은 id 는 history 에 두지 않는다');
    assert.ok(d.history.every((x) => x.history === true && x.origin === 'central'));
    // 크기 상한 — 큰 태그 창(펼친 keys 5,000)은 크기 상한에서 멈춘다
    const bigTag = (i) => ({ ...good, id: `mw-big${String(i).padStart(5, '0')}`, target: { kind: 'tag', tag: 'role:web', keys: Array.from({ length: 5_000 }, (_, k) => `K${k}`) } });
    const r2 = ST.saveDeployed([], { sig: body.sig, now, history: Array.from({ length: 30 }, (_, i) => bigTag(i)) });
    assert.ok(r2.history < 30 && r2.historyDropped > 0, `크기 상한(${r2.history}개 남김)`);
    assert.ok(JSON.stringify(ST.loadDeployed(now).history).length <= ST.DEPLOY_HISTORY_BYTES_MAX + 10_000);
    // 구버전 중앙(본문에 history 없음) — 직전 history 를 그대로 둔다(과거 사실)
    const n0 = ST.loadDeployed(now).history.length;
    ST.saveDeployed([], { sig: body.sig, now });
    assert.equal(ST.loadDeployed(now).history.length, n0, 'history 배열이 오지 않으면 직전 것을 유지');
  } finally {
    config.configDir = keep; process.env.CONFIG_DIR = prevDir; ST._resetMaintStoreForTest();
    fs.rmSync(ODIR, { recursive: true, force: true });
  }
});

test('R3(3회차 재확인) — history 상한을 넘으면 최근에 끝난 창부터 남긴다(유효 끝 열쇠) · 엣지는 받은 원문 길이로 잰다', async () => {
  // 열흘 전 만든 · 아흐레 전 끝난 일회 창 500 + 85일 전 만들고 어제 끝난 창 1(지난 31일 계산에 걸리는 창) — 파일에 바로 쓴다(만들기 500번을 피한다)
  const f = path.join(DIR, 'maintenance-windows.json');
  const o = JSON.parse(fs.readFileSync(f, 'utf8'));
  const mk = (id, name, startMs, createdMs) => ({ id, name, reason: 'r', target: { kind: 'server', keys: ['E1'] }, vcenterId: 'vcE', tz: 'Asia/Seoul',
    schedule: { kind: 'once', start: loc(startMs), end: loc(startMs + HOUR) }, scopes: { exclude: true }, by: 'op', at: createdMs, rev: 1, approvedBy: '', confirmedAt: createdMs, edits: [] });
  for (let i = 0; i < 500; i += 1) o.items.push(mk(`mw-old${String(i).padStart(5, '0')}`, `옛 ${i}`, T0 - 9 * DAY - i * MIN, T0 - 10 * DAY));
  const late = mk('mw-yday00001', '어제 끝남', T0 - DAY, T0 - 85 * DAY);
  o.items.push(late);
  fs.writeFileSync(f, JSON.stringify(o));
  ST._resetMaintStoreForTest();
  const now = Date.now();
  const body = await DP.deployFor('Edge-A', { verified: true, now });
  assert.equal(body.history.length, ST.DEPLOY_HISTORY_MAX); assert.ok(body.historyDropped > 0);
  assert.ok(body.history.some((x) => x.id === late.id), '재현 r3 재확인 — 예전 열쇠(만든 · 재확인 시각)로는 85일 전 만든 이 창이 가장 먼저 버려졌다');
  assert.ok(!body.history.some((x) => x.id === 'mw-old00499'), '버린 것은 가장 오래전에 끝난 창');
  // 엣지 — 받은 그대로 남기고 어제 끝난 창의 지난 구간이 남는다(중앙과 같다)
  const ODIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bmloop3e-r3-'));
  const { config } = await import('../src/config.js');
  const keep = config.configDir;
  try {
    config.configDir = ODIR; ST._resetMaintStoreForTest();
    const r = ST.saveDeployed(body.windows, { sig: body.sig, now, history: body.history });
    assert.equal(r.history, body.history.length, '엣지가 더 버리지 않는다');
    const cv = (await R.maintJudge({ now })).cover(TARGET, now - 31 * DAY, now, 'exclude');
    assert.ok(cv.some((x) => x.ids.includes(late.id)), '어제 끝난 창의 ⑤ 구간(예전 엣지: 없음)');
    // 크기 상한 경계 — 중앙이 잰 대로 보낸 개수를 엣지가 그대로 받는다(정규화 뒤 길이(edits 등)로 다시 재면 하나 더 버렸다).
    //   보낸 꼴 그대로 한 개 정확히 10,000자 × 100개 = 상한 1,000,000자(남는 자리 0 — 정규화로 늘어난 몇 글자가 경계를 넘긴다)
    const one = (i, keys) => ({ id: `mw-sz${String(i).padStart(5, '0')}`, name: `크기 ${String(i).padStart(3, '0')}`, reason: 'r', target: { kind: 'tag', tag: 'role:web', keys },
      vcenterId: 'vcE', tz: 'Asia/Seoul', schedule: { kind: 'once', start: loc(now - 2 * DAY), end: loc(now - 2 * DAY + HOUR) }, scopes: { exclude: true }, rev: 1, by: 'op', at: now - 3 * DAY, approvedBy: '', confirmedAt: now - 3 * DAY });
    const per = ST.DEPLOY_HISTORY_BYTES_MAX / 100;
    const keys = [];
    while (JSON.stringify(one(0, keys)).length < per - 260) keys.push(`S${String(keys.length).padStart(4, '0')}`);
    keys.push('P'.repeat(per - JSON.stringify(one(0, keys)).length - 3));   // 서버 키 형식(256자 이하) 안에서 남은 글자를 채운다
    const items = Array.from({ length: 101 }, (_, i) => one(i, keys));
    const sent = ST.capHistory(items);
    assert.equal(sent.list.length, 100); assert.equal(sent.dropped, 1);
    const r2 = ST.saveDeployed([], { sig: body.sig, now, history: JSON.parse(JSON.stringify(sent.list)) });
    assert.equal(r2.history, 100, `중앙 100개 = 엣지(예전: 정규화 뒤 길이로 재어 ${r2.history}개)`);
    ST._resetMaintStoreForTest();
    assert.equal(ST.loadDeployed(now).history.length, 100, '다시 읽어도 그대로(읽을 때 다시 재어 버리지 않는다)');
  } finally {
    config.configDir = keep; ST._resetMaintStoreForTest();
    fs.rmSync(ODIR, { recursive: true, force: true });
  }
});

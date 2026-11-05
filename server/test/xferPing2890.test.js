/**
 * v2.890 — 법인 간 전송 속도 상세의 'Ping 함께 보기'(시안 docs/design/xfer-ping · 사용자 컨펌 2026-11-05 '좋아 기본값대로 구현해줘').
 *
 * 새로 재지 않는다 — Ping 모니터가 엣지 노드를 자동 대상(`edge_<id>` · TCP 연결)으로 잰 기록을 `/tools/xfer-speed/ping` 이 창 단위로 준다.
 * 실제 api 라우터를 띄워 부른다(기준 시각은 정시에서 30분 떨어뜨린 3일 전 — CLAUDE.md 테스트 규칙):
 *  ① 과거 창은 [end − days, end) 만 — 창 앞·뒤·최근 표본이 섞이지 않는다 · 통계(n·fail·avg·max·median)도 창 안만
 *  ② 이웃한 두 창이 경계 표본을 두 번 세지 않는다(반개구간)
 *  ③ 창(start·end·past·days)이 `/history` 와 같다 — 두 차트가 같은 x 축을 그린다(detailWindowOf 하나)
 *  ④ 응답에 대상 호스트(엣지 주소)가 없다 — id·kind·port·enabled 만
 *  ⑤ 사유 코드: no-target · disabled · before-retention · no-samples (+ monitor-off 는 ⑨ 별도 프로세스)
 *  ⑥ 긴 창은 시간 요약(hourly) — 중앙값은 지어내지 않는다(null) · 짧은 창은 원시 + 중앙값
 *  ⑦ 권한: operator 403(adminOnly) · 범위 계정 403(fullScopeOnly) · 데모 계정은 실등록 엣지 404 · 없는 엣지 404
 *  ⑧ 서버 사유 코드 ↔ 웹 PING_REASON_TEXT 1:1 · 대상 id 는 store.edgeTargetId 하나(사본 금지)
 *  ⑨ Ping 모니터가 꺼져 있으면(PING_MON_ENABLED=false) monitor-off + 남은 기록은 그대로
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
const WEB = path.resolve(HERE, '../../web/src');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const COLS = [
  { id: 'Edge-Seoul', name: 'Edge Seoul', url: 'https://10.20.0.5:4000', token: 't', enabled: true },
  { id: 'Edge-Empty', name: 'Edge Empty', url: 'https://10.20.0.6:4000', token: 't', enabled: true },
  { id: 'Edge-Off', name: 'Edge Off', url: 'https://10.20.0.7:4000', token: 't', enabled: true },
  { id: 'Edge-New', name: 'Edge New', url: 'https://10.20.0.8:4000', token: 't', enabled: true },
];

function runScript(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xferping2890-'));
  fs.writeFileSync(path.join(dir, 'collectors.json'), JSON.stringify({ collectors: COLS }));
  const script = `
    const HOUR = 3600000, DAY = 24 * HOUR, MIN = 60000;
    const store = await import(${JSON.stringify(path.join(SRC, 'ping/store.js'))});
    const { getPingDb } = await import(${JSON.stringify(path.join(SRC, 'ping/db.js'))});
    // Edge-New 는 등록하지 않는다(모니터 시작 뒤 추가된 엣지 = no-target).
    const seeded = ${JSON.stringify(COLS.slice(0, 3))};
    const sr = store.seedEdgeTargets(seeded);
    if (!sr.ok) throw new Error('seed ' + sr.reason);
    const off = store.listTargets().find((t) => t.id === 'edge_edge-off');
    const ur = store.updateTarget('edge_edge-off', { ...off, enabled: false });
    if (!ur.ok) throw new Error('update ' + ur.reason);
    const db = await getPingDb();
    const now = Date.now();
    const E = Math.floor(now / HOUR) * HOUR - 3 * DAY - 30 * MIN;
    const recs = [];
    // 10분 간격 [E − 2일, E + 1일] — 창 B=[E−1일, E) 는 200ms, 그 앞 창 A 는 100ms, 창 뒤는 900ms. 창 B 안 실패 1건.
    for (let ts = E - 2 * DAY; ts <= E + DAY; ts += 10 * MIN) {
      const inB = ts >= E - DAY && ts < E;
      const fail = ts === E - 5 * HOUR;
      recs.push({ target: 'edge_edge-seoul', ts, rtt: fail ? null : (inB ? 200 : ts < E - DAY ? 100 : 900), ok: !fail });
    }
    for (let ts = now - 2 * HOUR; ts <= now - MIN; ts += 10 * MIN) recs.push({ target: 'edge_edge-seoul', ts, rtt: 50, ok: true });
    for (let ts = now - 2 * HOUR; ts <= now - MIN; ts += 10 * MIN) recs.push({ target: 'edge_edge-off', ts, rtt: 70, ok: true });
    db.insertMany(recs);
    await db._rollupSeed?.();
    const express = (await import('express')).default;
    const { api } = await import(${JSON.stringify(path.join(SRC, 'routes/api.js'))});
    const users = {
      admin: { username: 'a', role: 'admin', scope: null },
      operator: { username: 'o', role: 'operator', scope: null },
      scoped: { username: 's', role: 'admin', scope: { vcenters: ['vc-x'] } },
      demo: { username: 'thedvcdemp', role: 'admin', scope: null, demoGuest: true },
    };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = users[req.headers['x-test-user'] || 'admin']; next(); });
    app.use('/api', api);
    const srv = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
    const base = 'http://127.0.0.1:' + srv.address().port + '/api/tools/xfer-speed/';
    const get = async (p, who = 'admin') => { const x = await fetch(base + p, { headers: { 'x-test-user': who } }); const text = await x.text(); let body = null; try { body = JSON.parse(text); } catch {} return { status: x.status, body, text }; };
    const out = { E, now };
    if (process.env.ONLY_MONOFF) {
      out.monoff = await get('ping?agent=edge-seoul&days=1');
    } else {
      out.pastB = await get('ping?agent=edge-seoul&days=1&end=' + E);
      out.pastA = await get('ping?agent=edge-seoul&days=1&end=' + (E - DAY));
      out.histB = await get('history?agent=edge-seoul&days=1&end=' + E);
      out.latest = await get('ping?agent=edge-seoul&days=1');
      out.histLatest = await get('history?agent=edge-seoul&days=1');
      out.week = await get('ping?agent=edge-seoul&days=7&end=' + E);
      out.month = await get('ping?agent=edge-seoul&days=30');
      out.before = await get('ping?agent=edge-seoul&days=1&end=' + (E - 5 * DAY));
      out.empty = await get('ping?agent=edge-empty&days=1');
      out.offT = await get('ping?agent=edge-off&days=1');
      out.newT = await get('ping?agent=edge-new&days=1');
      out.unknown = await get('ping?agent=nope&days=1');
      out.operator = await get('ping?agent=edge-seoul&days=1', 'operator');
      out.scoped = await get('ping?agent=edge-seoul&days=1', 'scoped');
      out.demo = await get('ping?agent=edge-seoul&days=1', 'demo');
      out.points = await get('ping?agent=edge-seoul&days=1&end=' + E + '&points=99999');
    }
    srv.close();
    console.log('@@' + JSON.stringify(out));
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'live', AUTH_ENABLED: 'true', ...env },
    encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 120_000,
  });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stderr.slice(-2000));
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, r.stdout.slice(-800));
  return JSON.parse(line.slice(2));
}

test('①~⑦ 실제 api 라우터 — 창 · 경계 · 축 공유 · 주소 미포함 · 사유 · 요약 · 권한', () => {
  const o = runScript();
  const E = o.E;

  // ① 과거 창 B = [E − 1일, E)
  assert.equal(o.pastB.status, 200, o.pastB.text);
  const b = o.pastB.body;
  assert.equal(b.ok, true);
  assert.equal(b.past, true);
  assert.equal(b.start, E - DAY);
  assert.equal(b.end, E);
  assert.equal(b.reason, null, '정상 창은 사유 없음');
  assert.equal(b.source, 'raw');
  assert.ok(b.series.length > 0);
  assert.ok(b.series.every((x) => x.ts + b.bucketMs > E - DAY && x.ts < E), '칸은 창 안');
  assert.ok(b.series.every((x) => x.avg == null || (x.avg === 200 && x.min === 200 && x.max === 200)), '창 앞(100)·창 뒤(900)·최근(50) 표본이 섞이지 않는다');
  assert.equal(b.stats.n, 144, '24시간 × 10분 = 144 표본(끝 E 는 제외)');
  assert.equal(b.stats.fail, 1);
  assert.equal(b.stats.ok, 143);
  assert.equal(b.stats.avg, 200, '평균은 성공 표본만');
  assert.equal(b.stats.max, 200);
  assert.equal(b.stats.median, 200, '짧은 창은 원시 표본으로 중앙값');
  assert.equal(b.stats.lossPct, Math.round((1 / 144) * 10_000) / 100);
  assert.equal(b.last, null, '과거 창은 마지막 표본을 싣지 않는다');
  const failBucket = b.series.find((x) => x.loss > 0);
  assert.ok(failBucket && failBucket.n >= 1, '실패 표본은 손실로 센다(0 이 아니다)');

  // ② 이웃 창 A = [E − 2일, E − 1일) — 경계 E − 1일 표본은 B 에만
  assert.equal(o.pastA.status, 200);
  assert.equal(o.pastA.body.stats.n, 144);
  assert.equal(o.pastA.body.stats.max, 100, '창 A 는 100ms 표본만 — 경계(E − 1일, 200ms)는 창 B 쪽');
  assert.equal(o.pastA.body.stats.n + b.stats.n, 288, '두 창 합 = [E − 2일, E) 표본 수(중복·누락 없음)');

  // ③ 창이 /history 와 같다
  assert.equal(o.histB.status, 200, o.histB.text);
  for (const k of ['start', 'end', 'past', 'days']) assert.equal(b[k], o.histB.body[k], `과거 창 ${k} 가 /history 와 같다`);
  assert.equal(o.latest.body.past, false);
  assert.equal(o.histLatest.body.past, false);
  assert.ok(Math.abs(o.latest.body.end - o.histLatest.body.end) < 60_000, '지금 창 끝 = 지금(두 요청 사이 시차만)');
  assert.equal(o.latest.body.days, o.histLatest.body.days);

  // 지금 창 — 최근 표본(50ms)과 마지막 표본
  const lt = o.latest.body;
  assert.equal(lt.stats.max, 50);
  assert.ok(lt.last && lt.last.ok === true && lt.last.rtt === 50, '지금 창은 마지막 표본을 싣는다');
  assert.equal(lt.method, 'tcp-connect', '엣지 대상은 TCP 연결 — ICMP 가 아니다');
  assert.equal(lt.target.id, 'edge_edge-seoul');
  assert.equal(lt.target.port, 4000);
  assert.equal(lt.monitorEnabled, true);
  assert.ok(lt.intervalMs > 0 && lt.retentionDays > 0, '주기·보관은 응답 값(화면에 박지 않는다)');

  // ④ 엣지 주소 미포함
  for (const k of ['pastB', 'latest', 'week', 'month', 'offT', 'empty', 'newT']) {
    assert.ok(!/10\.20\.0\.\d/.test(o[k].text), `${k}: 응답에 엣지 주소가 없다`);
    if (o[k].body?.target) assert.deepEqual(Object.keys(o[k].body.target).sort(), ['enabled', 'id', 'kind', 'port'], `${k}: 대상 필드는 id·kind·port·enabled 만`);
  }

  // ⑤ 사유
  assert.equal(o.newT.status, 200);
  assert.equal(o.newT.body.reason, 'no-target', '모니터 시작 뒤 추가된 엣지');
  assert.equal(o.newT.body.target, null);
  assert.deepEqual(o.newT.body.series, []);
  assert.equal(o.empty.body.reason, 'no-samples', '대상은 있으나 창에 표본 없음');
  assert.equal(o.offT.body.reason, 'disabled', '꺼 둔 대상');
  assert.ok(o.offT.body.series.length > 0, '꺼 둔 대상도 남은 기록은 그린다');
  assert.equal(o.offT.body.target.enabled, false);
  assert.equal(o.before.body.reason, 'before-retention', '창이 가장 오래된 표본보다 앞');
  assert.equal(o.before.body.oldest.sampleTs, E - 2 * DAY);
  assert.deepEqual(o.before.body.series, []);

  // ⑥ 긴 창 = 시간 요약, 중앙값 null · 7일 창 = 원시
  assert.equal(o.week.body.source, 'raw');
  assert.ok(o.week.body.stats.median != null);
  assert.equal(o.month.status, 200, o.month.text);
  assert.equal(o.month.body.source, 'hourly', '30일은 시간 롤업');
  assert.equal(o.month.body.stats.median, null, '롤업 창의 중앙값은 지어내지 않는다');
  assert.ok(o.month.body.bucketMs % HOUR === 0);
  assert.ok(o.month.body.stats.n > 0 && o.month.body.stats.max === 900, '롤업 통계도 창 안 최고');

  // points 상한(480)
  assert.ok(o.points.body.series.length <= 482);
  assert.ok(o.points.body.bucketMs >= Math.floor(DAY / 480));

  // ⑦ 권한
  assert.equal(o.operator.status, 403, 'operator 는 403(adminOnly)');
  assert.equal(o.scoped.status, 403, '범위 계정은 403(fullScopeOnly)');
  assert.equal(o.demo.status, 404, '데모 계정에 실등록 엣지는 없는 것과 같다');
  assert.equal(o.unknown.status, 404);
});

test('⑨ Ping 모니터 꺼짐 — monitor-off + 남은 기록은 그대로', () => {
  const o = runScript({ ONLY_MONOFF: '1', PING_MON_ENABLED: 'false' });
  assert.equal(o.monoff.status, 200, o.monoff.text);
  assert.equal(o.monoff.body.reason, 'monitor-off');
  assert.equal(o.monoff.body.monitorEnabled, false);
  assert.ok(o.monoff.body.series.length > 0, '꺼져 있어도 남은 기록은 그린다');
});

test('⑧ 사유 코드 ↔ 웹 문구 1:1 · 대상 id 는 edgeTargetId 하나', async () => {
  const route = await import('../src/routes/api/xferSpeed.js');
  const web = await import(path.join(WEB, 'views/tools/xferSpeedText.js'));
  assert.deepEqual(Object.keys(web.PING_REASON_TEXT).sort(), [...route.PING_REASONS].sort(), '서버 PING_REASONS ↔ 웹 PING_REASON_TEXT');
  for (const v of Object.values(web.PING_REASON_TEXT)) {
    assert.ok(v.title && v.body, '제목·설명');
    assert.ok(!/`/.test(v.title + v.body), '화면 문구에 백틱 금지(BoldText)');
  }
  // 라우트가 쓰는 사유 리터럴은 전부 PING_REASONS 안
  const src = stripComments(fs.readFileSync(path.join(SRC, 'routes/api/xferSpeed.js'), 'utf8'));
  const seg = src.slice(src.indexOf("'/tools/xfer-speed/ping'"), src.indexOf("'/tools/xfer-speed/run'"));
  assert.ok(seg.length > 100, '라우트 본문을 찾았다');
  const used = [...seg.matchAll(/reason(?: =|:) ([^;\n]+)/g)].flatMap((m) => [...m[1].matchAll(/'([a-z]+(?:-[a-z]+)*)'/g)].map((x) => x[1]));
  assert.ok(used.length >= 5, `사유 리터럴 ${used.join(',')}`);
  for (const u of used) assert.ok(route.PING_REASONS.includes(u), `라우트 사유 ${u} 는 PING_REASONS 안`);
  // 대상 id 사본 금지 — edge_ 리터럴로 조립하는 곳은 store.edgeTargetId 하나
  const storeSrc = stripComments(fs.readFileSync(path.join(SRC, 'ping/store.js'), 'utf8'));
  assert.equal((storeSrc.match(/`edge_\$\{/g) || []).length, 1, 'store.js 안 edge_ 조립은 edgeTargetId 하나');
  assert.ok(/edgeTargetId\(/.test(seg), '라우트는 edgeTargetId 로 대상 id 를 만든다');
  assert.ok(!/`edge_\$\{/.test(seg), '라우트에 edge_ 조립 사본이 없다');
  const store = await import('../src/ping/store.js');
  assert.equal(store.edgeTargetId({ id: 'Edge-Seoul', name: 'x' }), 'edge_edge-seoul');
  assert.equal(store.edgeTargetId({ name: 'Only Name' }), 'edge_only name');
  assert.equal(store.edgeTargetId({}), '');
});

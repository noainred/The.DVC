/**
 * v2.902 — 법인 간 전송 속도 상세 '측정 기록' 표 강화(사용자 요청 "히스토리 보는 기능 강화 및 버그 수정").
 *
 * 예전 표는 기간·구간과 상관없이 '끝 이전 14일 중 최근 40건' 이었다. `/tools/xfer-speed/log` 는 **보고 있는 창 전체**를 커서 쪽 넘김으로 준다.
 * 실제 api 라우터를 띄워 부른다(기준 시각은 정시에서 30분 떨어뜨린 3일 전 — CLAUDE.md 테스트 규칙):
 *  ① 과거 창의 쪽을 끝까지 넘기면 창 [end − days, end] 안 행이 빠짐·중복 없이 (ts 내림 · 같은 ts 는 down 먼저) 순서로 나온다 · total 이 그 수와 같다
 *  ② only=fail — 실패 행만 · failTotal 과 같다
 *  ③ 지금 창 — 쪽을 읽는 사이에 새 측정이 들어와도 커서 뒤 쪽이 밀리지 않는다(중복 없음)
 *  ④ 형식이 틀린 커서는 400(field:'before') · limit 은 [10, 200]
 *  ⑤ /history?log=0 은 예전 14일 기록을 읽지 않는다(log []) · 기본은 그대로
 *  ⑥ 권한: operator 403 · 범위 계정 403 · 데모 계정은 실등록 엣지 404 · 없는 엣지 404
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

test('①~⑥ 실제 api 라우터 — 창 전체 · 커서 쪽 넘김 · 실패만 · 형식 · log=0 · 권한', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xferlog2902-'));
  fs.writeFileSync(path.join(dir, 'collectors.json'), JSON.stringify({ collectors: [{ id: 'Edge-Seoul', name: 'Edge Seoul', url: 'https://10.20.0.5:4000', token: 't', enabled: true }] }));
  const script = `
    const HOUR = 3600000, DAY = 24 * HOUR, MIN = 60000;
    const db = await import(${JSON.stringify(path.join(SRC, 'xferspeed/db.js'))});
    const now = Date.now();
    const E = Math.floor(now / HOUR) * HOUR - 3 * DAY - 30 * MIN;
    const row = (dir, ts, ok) => ({ agent: 'Edge-Seoul', dir, ts, ok, mbps: ok ? 40 : null, bytes: ok ? 10485760 : null, xferMs: ok ? 2000 : null, totalMs: 2500, ttfbMs: ok ? 100 : null, basis: ok ? 'receiver' : null, kind: ok ? null : 'timeout', error: ok ? '' : '시한 초과', trig: 'timer' });
    const all = [];
    // 30분 간격 [E − 2일, E + 1일] — down 은 ts, up 은 ts + 1. 7번째마다 down 실패, 11번째마다 up 실패. 같은 ts 의 down·up 한 쌍(정렬 확인)도 하나.
    let k = 0;
    for (let ts = E - 2 * DAY; ts <= E + DAY; ts += 30 * MIN, k += 1) {
      all.push(row('down', ts, k % 7 !== 3));
      all.push(row('up', k === 60 ? ts : ts + 1, k % 11 !== 5));   // k=60 = E − 1일 + 6시간(창 안)
    }
    for (let ts = now - 3 * HOUR; ts <= now - MIN; ts += 30 * MIN) { all.push(row('down', ts, true)); all.push(row('up', ts + 1, true)); }
    const r = await db.insertSamples(all);
    if (!r.ok) throw new Error('insert ' + r.error);
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
    const walk = async (q) => { const pages = []; let next = null; for (let i = 0; i < 100; i++) { const p = await get('log?' + q + (next ? '&before=' + next : '')); pages.push(p); if (p.status !== 200 || !p.body.next) break; next = p.body.next; } return pages; };
    const out = { E, now };
    out.pastPages = await walk('agent=edge-seoul&days=1&end=' + E + '&limit=10');
    out.failPages = await walk('agent=edge-seoul&days=1&end=' + E + '&limit=10&only=fail');
    out.expectPast = all.filter((x) => x.ts >= E - DAY && x.ts <= E).map((x) => x.dir + '@' + x.ts + '@' + (x.ok ? 1 : 0));
    // ③ 지금 창 — 첫 쪽을 읽은 뒤 새 측정 2건이 들어온다
    out.live1 = await get('log?agent=edge-seoul&days=1&limit=10');
    await db.insertSamples([row('down', now - 20 * 1000, true), row('up', now - 19 * 1000, true)]);
    out.live2 = await get('log?agent=edge-seoul&days=1&limit=10&before=' + out.live1.body.next);
    out.liveFirstAgain = await get('log?agent=edge-seoul&days=1&limit=10');
    out.bad = await get('log?agent=edge-seoul&days=1&before=abc');
    out.bigLimit = await get('log?agent=edge-seoul&days=1&end=' + E + '&limit=99999');
    out.smallLimit = await get('log?agent=edge-seoul&days=1&end=' + E + '&limit=1');
    out.histNoLog = await get('history?agent=edge-seoul&days=1&end=' + E + '&log=0');
    out.histLog = await get('history?agent=edge-seoul&days=1&end=' + E);
    out.operator = await get('log?agent=edge-seoul&days=1', 'operator');
    out.scoped = await get('log?agent=edge-seoul&days=1', 'scoped');
    out.demo = await get('log?agent=edge-seoul&days=1', 'demo');
    out.unknown = await get('log?agent=nope&days=1');
    srv.close();
    // 출력이 커서(약 150KB) stdout 파이프로 보내면 process.exit 에 잘린다 — 파일로 넘긴다.
    (await import('node:fs')).writeFileSync(process.env.XFERLOG_OUT, JSON.stringify(out));
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'live', AUTH_ENABLED: 'true', XFERLOG_OUT: path.join(dir, 'out.json') },
    encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 120_000,
  });
  assert.equal(r.status, 0, r.stderr.slice(-2000));
  const o = JSON.parse(fs.readFileSync(path.join(dir, 'out.json'), 'utf8'));
  fs.rmSync(dir, { recursive: true, force: true });
  const E = o.E;
  const DAY = 86_400_000;

  // ① 과거 창 전체 — 쪽을 끝까지 넘기면 창 안 행이 빠짐·중복 없이
  assert.ok(o.pastPages.every((p) => p.status === 200), o.pastPages.map((p) => p.text).join('\n').slice(0, 500));
  const first = o.pastPages[0].body;
  assert.equal(first.past, true);
  assert.equal(first.start, E - DAY);
  assert.equal(first.end, E);
  assert.equal(first.limit, 10);
  const got = o.pastPages.flatMap((p) => p.body.rows);
  assert.ok(o.pastPages.every((p) => p.body.rows.length <= 10), '쪽 크기 상한');
  assert.equal(o.pastPages.at(-1).body.next, null, '마지막 쪽은 next 없음');
  const keys = got.map((x) => `${x.dir}@${x.ts}@${x.ok ? 1 : 0}`);
  assert.equal(new Set(keys).size, keys.length, '쪽 사이 중복 없음');
  assert.deepEqual([...keys].sort(), [...o.expectPast].sort(), '창 [end − 1일, end] 안 행 전부(창 앞·뒤·최근 행 없음)');
  assert.equal(first.total, o.expectPast.length, 'total = 창 안 행 수');
  for (let i = 1; i < got.length; i++) {
    const a = got[i - 1]; const b = got[i];
    assert.ok(a.ts > b.ts || (a.ts === b.ts && a.dir === 'down' && b.dir === 'up'), `순서(ts 내림 · 같은 ts 는 down 먼저) ${i}`);
  }
  assert.ok(got.some((x, i) => i > 0 && got[i - 1].ts === x.ts), '같은 ts 의 down·up 쌍이 창 안에 있고 갈라지지 않았다');
  const failRow = got.find((x) => !x.ok);
  assert.ok(failRow && failRow.mbps === null && failRow.kind === 'timeout', '실패 행의 속도는 null(0 아님) · 사유');
  assert.ok(got.find((x) => x.ok && x.mbps === 40 && x.bytes === 10_485_760 && x.ttfbMs === 100), '성공 행 필드');

  // ② 실패만
  const fails = o.failPages.flatMap((p) => p.body.rows);
  assert.equal(o.failPages[0].body.only, 'fail');
  assert.ok(fails.length > 0 && fails.every((x) => x.ok === false));
  assert.equal(fails.length, o.expectPast.filter((k) => k.endsWith('@0')).length);
  assert.equal(o.failPages[0].body.failTotal, fails.length);
  assert.equal(first.failTotal, fails.length, '전체 보기에도 실패 건수를 싣는다');

  // ③ 지금 창 — 새 측정이 들어와도 커서 뒤 쪽은 밀리지 않는다
  assert.equal(o.live1.body.past, false);
  const p1 = o.live1.body.rows.map((x) => `${x.dir}@${x.ts}`);
  const p2 = o.live2.body.rows.map((x) => `${x.dir}@${x.ts}`);
  assert.equal(p1.filter((k) => p2.includes(k)).length, 0, '1쪽과 2쪽이 겹치지 않는다');
  assert.ok(o.live2.body.rows[0].ts <= o.live1.body.rows.at(-1).ts, '2쪽은 1쪽 마지막 행 다음부터');
  assert.ok(o.liveFirstAgain.body.rows[0].ts > o.live1.body.rows[0].ts, '다시 읽은 1쪽에는 새 측정이 맨 앞');
  assert.equal(o.liveFirstAgain.body.total, o.live1.body.total + 2);

  // ④ 형식 · 상한
  assert.equal(o.bad.status, 400);
  assert.equal(o.bad.body.field, 'before');
  assert.equal(o.bigLimit.body.limit, 200);
  assert.equal(o.smallLimit.body.limit, 10);
  assert.ok(o.bigLimit.body.retention && 'sampleDays' in o.bigLimit.body.retention);
  assert.ok(o.bigLimit.body.oldest && o.bigLimit.body.oldest.sampleTs != null);

  // ⑤ /history?log=0
  assert.equal(o.histNoLog.status, 200);
  assert.deepEqual(o.histNoLog.body.log, [], 'log=0 이면 예전 14일 기록을 읽지 않는다');
  assert.ok(o.histNoLog.body.series.down.length > 0, '추이는 그대로');
  assert.ok(o.histLog.body.log.length > 0 && o.histLog.body.log.length <= 40, '기본(log 없음)은 예전 그대로');

  // ⑥ 권한
  assert.equal(o.operator.status, 403);
  assert.equal(o.scoped.status, 403);
  assert.equal(o.demo.status, 404);
  assert.equal(o.unknown.status, 404);
  assert.ok(!/10\.20\.0\.5/.test(JSON.stringify(o.pastPages[0].body)), '측정 기록 응답에 엣지 주소가 없다');
});

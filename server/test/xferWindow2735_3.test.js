/**
 * v2.735.3 — 법인 간 전송 속도 상세 '이전 구간' 보기(사용자 요청 "각 시간 단위의 이전 단위를 볼 수 있는 기능")
 *            + 차트 마우스 오버용 점 필드(bytes·latMs).
 *
 * 실제 api 라우터를 띄워 `/tools/xfer-speed/history?end=` 를 부른다:
 *  ① 과거 창은 [end − days, end] 만 — 창 뒤·앞의 표본·측정 기록이 섞이지 않는다(past:true, start/end 를 싣는다).
 *  ② end 가 없거나 지금보다 뒤이거나 숫자가 아니면 예전처럼 '지금까지'(past:false).
 *  ③ 일 요약 창은 창 시작일을 빼고 끝 날까지 — 이웃한 두 창이 같은 날을 두 번 그리지 않는다.
 *  ④ oldest(가장 오래된 원시·일 요약)를 싣는다 — 화면이 갈 수 있는 칸 수를 정한다.
 *  ⑤ seriesOf 점에 bytes·latMs(지연)가 실린다 — 못 읽은 값은 null.
 * 기준 시각은 정시에서 떨어뜨려 고정한다(CLAUDE.md v2.517 — Date.now() 를 경계 근처에 두지 않는다).
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
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

test('⑤ seriesOf — 점에 bytes·latMs(못 읽으면 null)', async () => {
  const an = await import('../src/xferspeed/analyze.js');
  const s = an.seriesOf([
    { dir: 'down', ts: 1000, ok: 1, mbps: 30, bytes: 10_485_760, ttfb_ms: 120, total_ms: 3000, xfer_ms: 2800, basis: 'receiver' },
    { dir: 'up', ts: 1001, ok: 1, mbps: 20, bytes: 10_485_760, ttfb_ms: null, total_ms: 4000, xfer_ms: 3500, basis: 'receiver' },
    { dir: 'down', ts: 2000, ok: 0, mbps: null, bytes: null, ttfb_ms: null, total_ms: null, xfer_ms: null, basis: null, kind: 'timeout' },
  ]);
  assert.equal(s.down[0].bytes, 10_485_760);
  assert.equal(s.down[0].latMs, 120, '↓ 지연 = 저장된 ttfb');
  assert.equal(s.up[0].latMs, 500, '↑ 지연 = 전체 − 엣지 수신 구간');
  assert.equal(s.down[1].bytes, null, '못 읽은 바이트는 0 이 아니라 null');
  assert.equal(s.down[1].latMs, null);
  assert.equal(s.down[1].kind, 'timeout');
});

test('①~④ 실제 api 라우터 — end 창·잘라내기·일 요약 경계·oldest', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xferwin2735_3-'));
  fs.writeFileSync(path.join(dir, 'collectors.json'), JSON.stringify({ collectors: [{ id: 'Edge-Seoul', name: 'Edge Seoul', url: 'https://10.20.0.5:4000', token: 't', enabled: true }] }));
  const script = `
    const HOUR = 3600000, DAY = 24 * HOUR;
    const db = await import(${JSON.stringify(path.join(SRC, 'xferspeed/db.js'))});
    const { dayKey } = await import(${JSON.stringify(path.join(SRC, 'util/dayKey.js'))});
    const now = Date.now();
    // 기준 끝: 정시 −30분에서 3일 전(항상 과거 · 경계에서 30분 떨어진다).
    const E = Math.floor(now / HOUR) * HOUR - 3 * DAY - 30 * 60000;
    const row = (dir, ts, mbps, extra = {}) => ({ agent: 'Edge-Seoul', dir, ts, ok: mbps != null, mbps, bytes: 10485760, xferMs: 2000, totalMs: 2500, ttfbMs: 100, basis: 'receiver', kind: mbps == null ? 'timeout' : null, error: '', trig: 'timer', ...extra });
    const r = await db.insertSamples([
      row('down', E - DAY - HOUR, 777),          // 창 앞(제외)
      row('down', E - 20 * HOUR, 10),
      row('up', E - 10 * HOUR, 20),
      row('down', E - 2 * HOUR, 30),
      row('down', E - HOUR, null),                // 창 안 실패
      row('down', E + HOUR, 999),                 // 창 뒤(제외)
      row('down', E + 2 * DAY, 555),              // 다음 날짜(일 요약 경계 확인)
      row('down', E - 90 * DAY + 60000, 444),     // 90일 창의 시작일(E 의 시각이 HH:30 이라 +1분은 같은 날) — 일 요약에서 빠져야 한다
      row('down', now - HOUR, 50),                // 최근 창
    ]);
    if (!r.ok) throw new Error('insert ' + r.error);
    const express = (await import('express')).default;
    const { api } = await import(${JSON.stringify(path.join(SRC, 'routes/api.js'))});
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { username: 'a', role: 'admin', scope: null }; next(); });
    app.use('/api', api);
    const srv = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
    const b = 'http://127.0.0.1:' + srv.address().port + '/api/tools/xfer-speed/history?agent=edge-seoul';
    const get = async (q) => { const x = await fetch(b + q); return { status: x.status, body: await x.json() }; };
    const out = {
      E, now, endDay: dayKey(E), startDay90: dayKey(E - 90 * DAY), nextDay: dayKey(E + 2 * DAY),
      past: await get('&days=1&end=' + E),
      latest: await get('&days=1'),
      future: await get('&days=1&end=' + (now + 10 * DAY)),
      junk: await get('&days=1&end=abc'),
      daily: await get('&days=90&end=' + E),
      dailyLatest: await get('&days=90'),
    };
    srv.close();
    console.log('@@' + JSON.stringify(out));
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'live', AUTH_ENABLED: 'true' },
    encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 120_000,
  });
  assert.equal(r.status, 0, r.stderr.slice(-2000));
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, r.stdout.slice(-800));
  const o = JSON.parse(line.slice(2));
  const E = o.E;

  // ① 과거 창
  assert.equal(o.past.status, 200);
  const p = o.past.body;
  assert.equal(p.past, true);
  assert.equal(p.end, E);
  assert.equal(p.start, E - DAY);
  const downVals = p.series.down.filter((x) => x.mbps != null).map((x) => x.mbps).sort((a, b) => a - b);
  assert.deepEqual(downVals, [10, 30], '창 앞(777)·창 뒤(999)·최근(50) 표본은 섞이지 않는다');
  assert.ok(p.series.down.every((x) => x.ts >= E - DAY && x.ts <= E));
  assert.equal(p.series.down.filter((x) => !x.ok).length, 1, '창 안 실패는 실패 점으로');
  assert.equal(p.stats.down.max, 30);
  assert.equal(p.stats.down.n, 3, '통계도 창 안 표본만(성공 2 + 실패 1)');
  assert.deepEqual(p.series.up.map((x) => x.mbps), [20]);
  assert.ok(p.log.length > 0 && p.log.every((x) => x.ts <= E), '측정 기록도 창 끝 이전만');
  assert.ok(!p.log.some((x) => x.mbps === 999 || x.mbps === 50));
  assert.equal(p.series.down[0].bytes, 10485760, '마우스 오버용 bytes');

  // ④ oldest — 가장 이른 원시 표본(90일 창 시작일의 444)
  assert.equal(p.oldest.sampleTs, E - 90 * DAY + 60_000, '가장 이른 원시 표본');
  assert.match(p.oldest.day || '', /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(p.retention && 'sampleDays' in p.retention && 'dailyDays' in p.retention);

  // ② 지금 창 — end 없음·미래·숫자 아님은 예전 그대로
  for (const k of ['latest', 'future', 'junk']) {
    const b = o[k].body;
    assert.equal(o[k].status, 200, k);
    assert.equal(b.past, false, `${k}: 지금 창`);
    assert.ok(Math.abs(b.end - o.now) < 60_000, `${k}: 끝 = 지금`);
    assert.deepEqual(b.series.down.filter((x) => x.mbps != null).map((x) => x.mbps), [50], `${k}: 최근 24시간 표본만`);
  }

  // ③ 일 요약 창 — 시작일 제외 · 끝 날 포함 · 다음 날짜 제외
  const d = o.daily.body;
  assert.equal(o.daily.status, 200);
  assert.equal(d.source, 'daily');
  assert.equal(d.past, true);
  const days = d.series.down.map((x) => x.day);
  assert.ok(days.every((k) => k > o.startDay90 && k <= o.endDay), `일 요약은 (시작일, 끝 날] — ${days.join(',')}`);
  assert.ok(!days.includes(o.nextDay), '창 뒤 날짜는 빠진다');
  assert.ok(days.includes(o.endDay), '끝 날은 들어간다');
  assert.ok(!days.includes(o.startDay90), '시작일은 빠진다(이전 창의 끝 날)');
  const dl = o.dailyLatest.body;
  assert.equal(dl.past, false);
  assert.ok(dl.series.down.map((x) => x.day).includes(o.nextDay), '지금 창은 끝이 열려 있다');
});

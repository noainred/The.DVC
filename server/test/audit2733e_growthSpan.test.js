/**
 * v2.733 점검 3회차 — 그룹 e · C2-03 스토리지 증가량 합계의 '구간 불일치' 합산.
 *
 * 결함(재현 r3/C2/r02_growth.mjs): 장비 행은 요청한 날짜에 수집이 없으면 그 이전 가장 가까운 날과 비교하고
 *   `exact:false`·실제 `spanDays` 를 밝히는데(v2.531 규칙 ②), 합계(`totalsOf`·웹 `aggregateGrowth`)는 그 값을 무시하고
 *   바이트를 그대로 더했다. 1년 전 1회 관측 뒤 수집이 끊겼다가 최근 20일만 수집된 장비 하나가 '1개월 증가' 합계를
 *   322TB(정답 약 30TB)로 만들고 `partial:false` 로 '전 장비 측정' 이라 말했다. 일 증가(perDay)도 합계 ÷ 30일이라 틀렸다.
 *
 * 고정하는 것:
 *  ① 실제 구간이 요청 기간의 GROWTH_SPAN_TOLERANCE 배(내림)를 넘는 장비는 합계에서 빠지고 `inexact` 로 세어 partial 이 된다
 *  ② 경계 — 한계 안(widened)은 더하고 개수를 밝힌다 · 한계 +1일은 뺀다 · 1일·1주는 하루 공백도 뺀다
 *  ③ 합계의 하루 증가량은 장비별 perDayBytes 의 합이다(합계 ÷ 요청 일수가 아니다)
 *  ④ 서버 totalsOf 와 웹 aggregateGrowth 가 **같은 입력에 같은 답**을 낸다(상수·한계 함수·합계 객체 대조)
 *  ⑤ 실제 라우터 — 내부 /api/tools/storage-growth 합계와 공개 API /capacity/storage-growth(growthSpanDays·meta.inexactCount)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2733e-'));
process.env.CONFIG_DIR = process.env.CONFIG_DIR || path.join(tmp, 'config');
fs.mkdirSync(process.env.CONFIG_DIR, { recursive: true });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const WEB = path.resolve(HERE, '../../web/src');

const srv = await import('../src/storage/growth.js');
const web = await import(path.join(WEB, 'views/tools/storageGrowthText.js'));
const { growthMatrix, normalizePeriods, DEFAULT_PERIODS } = srv;

const TB = 1e12;
const AS_OF = 20000;   // 고정 일 인덱스(Date.now() 를 기준으로 쓰지 않는다 — v2.517 규약)
const row = (id, day, used, total = 2000 * TB) => ({ device_id: id, day, total_bytes: total, used_bytes: used, last_ts: day * 86_400_000, samples: 4 });

/** 장비 A: 매일 수집, 하루 +1TB. 장비 B: 365일 전 1회(10TB) → 공백 → 최근 20일 수집(300TB, 하루 +0.1TB). */
function reproRows() {
  const rows = [];
  for (let d = AS_OF - 400; d <= AS_OF; d++) rows.push(row('A', d, (100 + (d - (AS_OF - 400))) * TB));
  rows.push(row('B', AS_OF - 365, 10 * TB, 1000 * TB));
  for (let d = AS_OF - 20; d <= AS_OF; d++) rows.push(row('B', d, (300 + 0.1 * (d - (AS_OF - 20))) * TB, 1000 * TB));
  return rows;
}

/* ── ① 재현 ──────────────────────────────────────────────────────────── */

test('C2-03 ① 요청 기간보다 크게 긴 구간의 증가는 합계에서 빠지고 inexact 로 세어 partial 이 된다', () => {
  const { periods } = normalizePeriods([7, 30, 90]);
  const m = growthMatrix(reproRows(), { periods, asOfDay: AS_OF });
  const B = m.devices.find((d) => d.deviceId === 'B');
  assert.equal(B.growth['30d'].spanDays, 365, '장비 행은 그대로 정직하게 싣는다(규칙 ②)');
  assert.equal(B.growth['30d'].exact, false);

  const g30 = m.totals.growth['30d'];
  assert.ok(Math.abs(g30.bytes - 30 * TB) < 1e-3, `1개월 합계는 A 의 30TB 여야 한다(예전 322TB) — ${g30.bytes / TB}TB`);
  assert.equal(g30.measured, 1);
  assert.equal(g30.missing, 1, 'measured + missing = 합계 기준 장비 수');
  assert.equal(g30.inexact, 1);
  assert.equal(g30.partial, true, '일부만 더한 합계를 전체라 말하지 않는다');
  assert.equal(g30.maxSpanDays, 33);
  assert.equal(m.totals.growth['90d'].inexact, 1);
  assert.equal(m.totals.growth['90d'].partial, true);
  // 1주는 둘 다 정확한 구간이다 — 전체 합 그대로.
  const g7 = m.totals.growth['7d'];
  assert.ok(Math.abs(g7.bytes - 7.7 * TB) < 1e-3);
  assert.equal(g7.partial, false);
  assert.equal(g7.inexact, undefined, '0 이면 싣지 않는다(lagging 과 같은 모양)');
});

/* ── ② 경계 ──────────────────────────────────────────────────────────── */

test('C2-03 ② 한계 = 요청 일수 × GROWTH_SPAN_TOLERANCE(내림) — 안이면 더하고 widened 로 밝히고, 넘으면 뺀다', () => {
  assert.equal(srv.GROWTH_SPAN_TOLERANCE, 1.1);
  const expectMax = { 1: 1, 7: 7, 14: 15, 30: 33, 60: 66, 90: 99, 180: 198, 365: 401, 1825: 2007 };
  for (const [d, mx] of Object.entries(expectMax)) assert.equal(srv.maxSpanDaysFor(Number(d)), mx, `${d}일`);
  assert.equal(srv.maxSpanDaysFor(0), null);
  assert.equal(srv.maxSpanDaysFor(''), null);
  assert.equal(srv.maxSpanDaysFor(null), null);

  // 30일: 요청 날짜(−30)와 그 앞 사흘(−31·−32)이 비어 기준선이 −33(한계 안) / −34(한계 밖)인 장비.
  const mk = (id, base) => [row(id, AS_OF - base, 100 * TB), row(id, AS_OF - 1, 150 * TB), row(id, AS_OF, 160 * TB)];
  const P30 = [{ key: '30d', days: 30, label: '1개월' }];
  const inT = growthMatrix(mk('in', 33), { periods: P30, asOfDay: AS_OF }).totals.growth['30d'];
  assert.equal(inT.measured, 1);
  assert.equal(inT.inexact, undefined);
  assert.equal(inT.widened, 1, '한계 안이지만 요청보다 긴 구간을 더했다는 사실을 센다');
  assert.equal(inT.partial, false);
  const outT = growthMatrix(mk('out', 34), { periods: P30, asOfDay: AS_OF }).totals.growth['30d'];
  assert.equal(outT.measured, 0);
  assert.equal(outT.bytes, null, '한 대도 못 더했으면 0 이 아니라 null');
  assert.equal(outT.inexact, 1);
  assert.equal(outT.missing, 1);

  // 1일: 어제 행이 없어 그제와 비교한 장비(구간 2일 = 2배)는 1일 합계에 넣지 않는다.
  const P1 = [{ key: '1d', days: 1, label: '1일' }];
  const one = growthMatrix([row('x', AS_OF - 2, 10 * TB), row('x', AS_OF, 12 * TB), row('y', AS_OF - 1, 5 * TB), row('y', AS_OF, 6 * TB)],
    { periods: P1, asOfDay: AS_OF }).totals.growth['1d'];
  assert.equal(one.measured, 1);
  assert.equal(one.inexact, 1);
  assert.equal(one.bytes, 1 * TB);
  assert.equal(one.partial, true);
});

/* ── ③ 하루 증가량 ────────────────────────────────────────────────────── */

test('C2-03 ③ 합계 perDayBytes 는 장비별 perDayBytes 의 합이다(합계 ÷ 요청 일수 아님)', () => {
  const P30 = [{ key: '30d', days: 30, label: '1개월' }];
  // 'w' 는 33일 구간에 33TB(하루 1TB) — 합계 ÷ 30 이면 1.1TB/일로 부풀린다.
  const rows = [row('w', AS_OF - 33, 100 * TB), row('w', AS_OF, 133 * TB),
    row('e', AS_OF - 30, 50 * TB), row('e', AS_OF, 110 * TB)];
  const g = growthMatrix(rows, { periods: P30, asOfDay: AS_OF }).totals.growth['30d'];
  assert.equal(g.bytes, 93 * TB);
  assert.ok(Math.abs(g.perDayBytes - 3 * TB) < 1e-3, `장비별 1TB + 2TB = 3TB/일이어야 한다 — ${g.perDayBytes / TB}`);
  // 재현 입력: 1개월 하루 증가량은 A 의 1TB(예전 10.73TB)
  const m = growthMatrix(reproRows(), { periods: P30, asOfDay: AS_OF });
  assert.ok(Math.abs(m.totals.growth['30d'].perDayBytes - TB) < 1e-3);
});

/* ── ④ 서버 ↔ 웹 대조 ─────────────────────────────────────────────────── */

const COMPARE_KEYS = ['bytes', 'measured', 'missing', 'partial', 'lagging', 'inexact', 'widened', 'perDayBytes', 'maxSpanDays'];

function scenarios() {
  const out = [{ name: 'repro', rows: reproRows() }];
  // 결정적 의사난수(시드 고정) — 공백·정체·퇴역·사용량 결측이 섞인 함대.
  let s = 7;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  for (let k = 0; k < 6; k++) {
    const rows = [];
    for (let i = 0; i < 14; i++) {
      const id = `d${k}-${i}`;
      const latest = AS_OF - (rnd() < 0.15 ? 1 + Math.floor(rnd() * 12) : 0);   // 일부는 오늘보다 늦다(lagging·stale)
      let used = 100 * TB * (1 + rnd());
      for (let d = latest - 420; d <= latest; d++) {
        if (rnd() < 0.08 + (i % 3) * 0.1) continue;                               // 장비마다 다른 공백률
        used += (rnd() - 0.3) * TB;
        rows.push(row(id, d, rnd() < 0.01 ? null : used, 1000 * TB));
      }
    }
    out.push({ name: `fleet-${k}`, rows });
  }
  return out;
}

test('C2-03 ④ 서버 totalsOf 와 웹 aggregateGrowth 는 같은 입력에 같은 합계를 낸다', () => {
  assert.equal(web.GROWTH_SPAN_TOLERANCE, srv.GROWTH_SPAN_TOLERANCE, '허용 배수 상수가 두 벌에서 같아야 한다');
  for (let d = 1; d <= 3650; d++) assert.equal(web.maxSpanDaysFor(d), srv.maxSpanDaysFor(d), `${d}일 한계`);
  for (const v of [0, -3, '', null, undefined, 'x', NaN]) assert.equal(web.maxSpanDaysFor(v), srv.maxSpanDaysFor(v), `입력 ${String(v)}`);

  let sawInexact = 0; let sawWidened = 0; let sawLagging = 0;
  for (const sc of scenarios()) {
    for (const knownIds of [null, undefined]) {
      const m = growthMatrix(sc.rows, { periods: DEFAULT_PERIODS, asOfDay: AS_OF, knownIds });
      // 화면은 HTTP 로 받은 장비 행을 다시 더한다 — JSON 왕복을 거친 같은 행을 넘긴다.
      const devices = JSON.parse(JSON.stringify(m.devices));
      const a = web.aggregateGrowth(devices, m.periods, { asOfDay: AS_OF });
      for (const p of m.periods) {
        const S = m.totals.growth[p.key]; const W = a.growth[p.key];
        for (const k of COMPARE_KEYS) {
          const sv = S[k]; const wv = W[k];
          if (typeof sv === 'number' && typeof wv === 'number' && !Number.isInteger(sv)) {
            assert.ok(Math.abs(sv - wv) <= Math.abs(sv) * 1e-12, `${sc.name} ${p.key}.${k}: 서버 ${sv} · 웹 ${wv}`);
          } else assert.deepEqual(wv, sv, `${sc.name} ${p.key}.${k}: 서버 ${sv} · 웹 ${wv}`);
        }
        sawInexact += S.inexact || 0; sawWidened += S.widened || 0; sawLagging += S.lagging || 0;
      }
      assert.equal(a.devices, m.totals.devices, `${sc.name}: 합계 기준 장비 수`);
    }
  }
  // 대조가 의미 있으려면 세 갈래가 실제로 나와야 한다(전부 0 이면 아무것도 비교하지 않은 것이다).
  assert.ok(sawInexact > 0 && sawWidened > 0 && sawLagging > 0, `inexact ${sawInexact} · widened ${sawWidened} · lagging ${sawLagging}`);
});

/* ── ⑤ 실제 라우터 ────────────────────────────────────────────────────── */

test('C2-03 ⑤ 실제 라우터 — 내부 합계 inexact/partial · 공개 API growthSpanDays·meta.inexactCount · 키 집합 == 선언', () => {
  const J = (rel) => JSON.stringify(path.join(SRC, rel));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2733e-route-'));
  // 표본 시각은 일 인덱스의 정오(날 경계에서 12시간 떨어뜨림 — v2.517 규약). 라우트의 '오늘' 은 dayIndex(Date.now()).
  const boot = `
    const express = (await import('express')).default;
    const { api } = await import(${J('routes/api.js')});
    const v1 = (await import(${J('routes/publicApi.js')})).default;
    const keys = await import(${J('publicapi/keys.js')});
    const { ENDPOINT_BY_PATH } = await import(${J('publicapi/allowlist.js')});
    const reg = await import(${J('storage/registry.js')});
    const db = await import(${J('storage/db.js')});
    const { store } = await import(${J('store.js')});
    await store.refresh({ force: true });
    reg.saveDevice({ type: 'unity480', collectMethod: 'api', name: 'SYNTH-A', host: 'a.example.invalid', username: 'u', password: 'p' });
    reg.saveDevice({ type: 'unity480', collectMethod: 'api', name: 'SYNTH-B', host: 'b.example.invalid', username: 'u', password: 'p' });
    const [a, b] = reg.listDevices();
    const TB = 1e12;
    const today = db.dayIndex(Date.now());
    const mk = (d, day, used, total) => ({ deviceId: d.id, type: 'unity480', name: d.name, ok: true,
      collectedAt: db.dayStartMs(day) + 12 * 3600e3, capacity: { totalBytes: total, usedBytes: used }, sections: { capacity: 'ok' }, extra: {} });
    for (let day = today - 40; day <= today; day++) await db.saveCapacityPoint(mk(a, day, (100 + (day - today + 40)) * TB, 2000 * TB));
    await db.saveCapacityPoint(mk(b, today - 365, 10 * TB, 1000 * TB));
    for (let day = today - 20; day <= today; day++) await db.saveCapacityPoint(mk(b, day, (300 + 0.1 * (day - today + 20)) * TB, 1000 * TB));
    const app = express();
    app.use('/api', api); app.use('/api/v1', v1);
    const srv = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
    const base = 'http://127.0.0.1:' + srv.address().port;
    const key = keys.issueApiKey({ name: 'k', groups: ['capacity'] }).plaintext;
    const internal = await (await fetch(base + '/api/tools/storage-growth')).json();
    const pub = await (await fetch(base + '/api/v1/capacity/storage-growth', { headers: { 'X-Api-Key': key } })).json();
    srv.close();
    console.log('@@' + JSON.stringify({ totals: internal.totals, pub, ids: [a.id, b.id], fields: ENDPOINT_BY_PATH['/capacity/storage-growth'].fields }));
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', boot], {
    env: { ...process.env, CONFIG_DIR: dir, AUTH_ENABLED: 'false', DATA_SOURCE: 'mock' },
    encoding: 'utf8', cwd: path.resolve(HERE, '..'), timeout: 180_000,
  });
  assert.equal(r.status, 0, `자식 프로세스 실패: ${r.stderr?.slice(-2000)}`);
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, `출력 없음: ${r.stdout.slice(-1000)} ${r.stderr?.slice(-800)}`);
  const out = JSON.parse(line.slice(2));
  const [idA, idB] = out.ids;

  // 내부 화면 합계(기본 기간 — 가장 긴 365일 + 1일을 읽으므로 B 의 1년 전 행이 기준선이 된다).
  const t30 = out.totals.growth['30d'];
  assert.ok(Math.abs(t30.bytes - 30 * 1e12) < 1, `내부 1개월 합계는 A 의 30TB — ${t30.bytes}`);
  assert.equal(t30.inexact, 1);
  assert.equal(t30.partial, true);

  // 공개 API — 장비 행은 그대로 싣되 실제 비교 구간과 합산 기준을 밝힌다.
  const rowB = out.pub.data.find((x) => x.deviceId === idB);
  const rowA = out.pub.data.find((x) => x.deviceId === idA);
  assert.ok(rowB && rowA, JSON.stringify(out.pub).slice(0, 600));
  assert.equal(rowB.growthSpanDays['30d'], 365);
  assert.equal(rowA.growthSpanDays['30d'], 30);
  assert.equal(rowB.growthSpanDays['7d'], 7);
  assert.deepEqual(out.pub.meta.maxSpanDays, { '1d': 1, '7d': 7, '30d': 33 });
  assert.deepEqual(out.pub.meta.inexactCount, { '1d': 0, '7d': 0, '30d': 1 });
  for (const x of out.pub.data) assert.deepEqual(Object.keys(x).sort(), [...out.fields].sort(), '키 집합 == 선언 fields');
  assert.ok(out.fields.includes('growthSpanDays'));
});

/* ── 문서 ─────────────────────────────────────────────────────────────── */

test('C2-03 공개 API 문서가 growthSpanDays·inexactCount·maxSpanDays 를 설명한다', () => {
  const doc = fs.readFileSync(path.resolve(SRC, '../../docs/API-PUBLIC.md'), 'utf8');
  const sec = doc.slice(doc.indexOf('### 7-6.'), doc.indexOf('### 7-7.'));
  for (const k of ['growthSpanDays', 'inexactCount', 'maxSpanDays']) assert.match(sec, new RegExp(k), `7-6 절에 ${k} 설명이 없다`);
});

/**
 * serverTempSpark2556.test.js — '서버 온도' 24시간 스파크라인 API(v2.556) 회귀 고정.
 *
 * 시안 B(docs/design/server-temp/README.md §State Management)가 요구한 계약을 고정한다.
 * 메트릭 선택은 순수 함수로, 라우트 계약은 **실제 express 앱에 마운트해 상태코드·본문으로**
 * 본다(소스 grep 이 아니다 — v2.506 이 그 실수를 했다. authzGates2536 과 같은 하니스).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sparkMetricFor, sparkMetricFallback } from '../src/tools/serverTemp.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');

test('★ 메트릭 선택 — 흡기 계열은 상세 적재일 때만 쓴다(기본은 최고 센서)', () => {
  // 기본 설정에서는 서버당 1계열(idractemp_max)만 적재된다 — idrac/serverTempSeries.js 머리말.
  assert.equal(sparkMetricFor('idrac'), 'idractemp_max');
  assert.equal(sparkMetricFor('idrac', { detail: false }), 'idractemp_max');
  assert.equal(sparkMetricFor('idrac', { detail: true }), 'idractemp_inlet');
  assert.equal(sparkMetricFor('esxi'), 'temp_host');
  assert.equal(sparkMetricFor('host'), 'temp_host');
  assert.equal(sparkMetricFor('cluster'), 'temp_cluster');
  assert.equal(sparkMetricFor('vc'), 'temp_vc');
});

test('모르는 출처는 null — 엉뚱한 계열을 추측해 주지 않는다', () => {
  for (const bad of ['', 'nope', null, undefined, 0, {}]) {
    assert.equal(sparkMetricFor(bad), null, `${JSON.stringify(bad)} 에 메트릭을 지어냈습니다`);
  }
});

test('흡기 계열이 비었을 때의 대체는 최고 센서 하나뿐', () => {
  assert.equal(sparkMetricFallback('idractemp_inlet'), 'idractemp_max');
  // 다른 계열에는 대체가 없다 — 없는 것을 다른 것으로 채우면 화면이 거짓을 말한다.
  for (const m of ['idractemp_max', 'temp_host', 'temp_cluster', 'temp_vc']) {
    assert.equal(sparkMetricFallback(m), null);
  }
});

/** 실제 라우터를 띄워 POST 한다. viewerScope 가 있으면 그 범위의 계정으로 요청한다. */
function postSpark(body, { scope = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tempspark2556-'));
  const script = `
    const express = (await import('express')).default;
    const { api } = await import(${JSON.stringify(path.join(SRC, 'routes/api.js'))});
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { username: 'u', role: 'admin', scope: ${JSON.stringify(scope)} }; next(); });
    app.use('/api', api);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = 'http://127.0.0.1:' + srv.address().port;
    const r = await fetch(base + '/api/tools/esxi-temp/spark', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: ${JSON.stringify(JSON.stringify(body))},
    });
    let b = null; try { b = await r.json(); } catch {}
    srv.close();
    console.log('@@' + JSON.stringify({ status: r.status, body: b }));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUTH_ENABLED: 'true', ESXI_TEMP_SPARK_MAX: '3' },
    encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 120_000,
  });
  assert.equal(r.status, 0, `자식 프로세스 실패: ${r.stderr}`);
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, `출력에 결과가 없습니다: ${r.stdout.slice(-600)}`);
  return JSON.parse(line.slice(2));
}

test('★ 빈 요청은 200 + 상한을 알려 준다 — 화면이 배치 크기를 하드코딩하지 않게', () => {
  const out = postSpark({ items: [] });
  assert.equal(out.status, 200);
  assert.equal(out.body.maxItems, 3, 'maxItems 가 응답에 없으면 화면이 숫자를 박게 된다(sparkBatch.js 규약)');
  assert.equal(out.body.bucketMs, 3_600_000);
  assert.equal(out.body.hours, 24);
  assert.deepEqual(out.body.series, {});
});

test('★★ 상한을 넘기면 자른 사실을 밝힌다(capped) — 조용히 자르지 않는다', () => {
  const items = ['a', 'b', 'c', 'd', 'e'].map((k) => ({ key: `vc-${k}`, source: 'vc' }));
  const out = postSpark({ items });
  assert.equal(out.status, 200);
  assert.equal(out.body.capped, true, 'ESXI_TEMP_SPARK_MAX=3 인데 5건을 다 처리했다고 답했습니다');
  assert.ok(Object.keys(out.body.series).length <= 3, '상한을 넘겨 조회했습니다');
});

test('모르는 출처의 항목은 skipped + 그 키 null(오류 아님)', () => {
  const out = postSpark({ items: [{ key: 'x', source: 'wat' }] });
  assert.equal(out.status, 200);
  assert.equal(out.body.skipped, 1);
  assert.equal(out.body.series.x, null);
});

test('★ mock 에서는 합성이고 그 사실을 밝힌다 + 실제로 쓴 메트릭을 적는다', () => {
  const out = postSpark({ items: [{ key: 'vc-ap-northeast-01', source: 'vc' }] });
  assert.equal(out.status, 200);
  assert.equal(out.body.synthesized, true, 'mock 합성을 실데이터처럼 내보내면 안 된다');
  const pts = out.body.series['vc-ap-northeast-01'];
  assert.ok(Array.isArray(pts) && pts.length >= 2, `합성 점이 없습니다: ${JSON.stringify(pts)}`);
  for (const p of pts) {
    assert.ok(Number.isFinite(p.ts) && Number.isFinite(p.avg), `점 형식이 다릅니다: ${JSON.stringify(p)}`);
  }
  assert.equal(out.body.metricByKey['vc-ap-northeast-01'], 'temp_vc', 'metricByKey 가 없으면 화면이 계열을 구분해 말할 수 없다');
});

test('★★ 범위 밖 키는 조회하지 않고 null — 403 으로 존재를 알리지 않는다(존재 은닉)', () => {
  // 범위를 존재하지 않는 vCenter 하나로 묶으면 요청한 키는 전부 범위 밖이 된다.
  const out = postSpark({ items: [{ key: 'vc-ap-northeast-01', source: 'vc' }] }, { scope: { vcenters: ['vc-does-not-exist'], regions: [] } });
  assert.equal(out.status, 200, '범위 밖 조회가 오류가 되면 그 키의 존재가 드러난다');
  assert.equal(out.body.series['vc-ap-northeast-01'], null);
  assert.equal(out.body.skipped, 1);
  assert.ok(!('vc-ap-northeast-01' in out.body.metricByKey), '조회하지 않았는데 메트릭을 적었습니다');
});

test('소스 계약 — 라우트가 tools 권한 게이트를 쓰고 점 1개는 null 로 버린다', () => {
  const src = fs.readFileSync(path.join(SRC, 'routes/api/toolsCapacity.js'), 'utf8');
  const i = src.indexOf("api.post('/tools/esxi-temp/spark'");
  assert.ok(i > 0, '라우트가 없습니다');
  const seg = src.slice(i, i + 4200);
  assert.ok(/requirePerm\('tools'\)/.test(src.slice(i, i + 200)), 'requirePerm(tools) 게이트가 빠졌습니다');
  assert.ok(/points\.length >= 2 \? points : null/.test(seg), '점 2개 미만을 null 로 만들지 않으면 화면이 한 점을 선으로 그린다');
  assert.ok(/console\.warn/.test(seg), 'DB 실패를 조용히 삼키면 원인을 알 수 없다');
});

/**
 * v2.574 — **범위(scope) 누락 8건** 회귀 고정 (2026-09-21 감사 SEC-01~08).
 *
 * server/CLAUDE.md 불변조건: **"조회 라우트 scope 는 예외 없이"** ·
 * **"귀속 없는/범위 밖 데이터는 범위 계정에 노출하지 않는다"**.
 * 이 8건은 전부 그 규약 밖에 남아 있던 라우트이고, **형제 라우트가 제대로 하고 있었다는 점**이
 * 근거였다(같은 파일·같은 모듈에서 하나만 빠짐 = 실수이지 설계가 아니다).
 *
 * ⚠ 검증 방식은 v2.536 하니스와 같다 — **실제 `api` 라우터를 express 에 마운트하고 상태코드·
 *   응답 본문으로** 본다. 소스 grep 은 미들웨어 순서가 바뀌어도 통과한다(v2.506 교훈).
 *   자식 프로세스인 이유: `config.js` 싱글턴이라 이 프로세스에서 CONFIG_DIR 을 다시 못 가리킨다.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';
import { scopeEdgeSettings } from '../src/routes/api/bmUsage.js';
import { scopeVmSeriesStatus } from '../src/routes/api/vmSeries.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const read = (p) => stripComments(fs.readFileSync(path.join(SRC, p), 'utf8'));

/* ── ① 실제 앱 — 범위 계정과 admin 의 응답을 대조한다 ────────────────────────── */

/** vCenter 3개를 등록하고, 범위 계정(vc-a 만)과 전체 계정으로 같은 경로를 친다. */
function compare(paths) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope2574-'));
  fs.writeFileSync(path.join(dir, 'vcenters.json'), JSON.stringify({
    vcenters: [
      { id: 'vc-a', name: 'A', host: 'a.example', username: 'u', password: 'p' },
      { id: 'vc-b', name: 'B', host: 'b.example', username: 'u', password: 'p' },
      { id: 'vc-c', name: 'C', host: 'c.example', username: 'u', password: 'p' },
    ],
  }));
  const script = `
    const express = (await import('express')).default;
    const { api } = await import(${JSON.stringify(path.join(SRC, 'routes/api.js'))});
    const mk = (scope) => {
      const app = express();
      app.use((req, _res, next) => { req.user = { username: 'u', role: 'admin', scope }; next(); });
      app.use('/api', api);
      return app;
    };
    const run = async (scope) => {
      const srv = await new Promise((r) => { const s = mk(scope).listen(0, '127.0.0.1', () => r(s)); });
      const base = 'http://127.0.0.1:' + srv.address().port;
      const out = {};
      for (const p of ${JSON.stringify(paths)}) {
        const r = await fetch(base + p);
        let b = null; try { b = await r.json(); } catch {}
        out[p] = { status: r.status, body: b };
      }
      srv.close();
      return out;
    };
    const scoped = await run({ vcenters: ['vc-a'] });
    const full = await run(null);
    console.log('@@' + JSON.stringify({ scoped, full }));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUTH_ENABLED: 'false' },
    encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 180_000,
  });
  assert.equal(r.status, 0, `자식 프로세스 실패: ${r.stderr.slice(-2000)}`);
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, `출력 없음: ${r.stdout.slice(-1500)}`);
  return JSON.parse(line.slice(2));
}

const PATHS = [
  '/api/tools/vclogs/sources',        // SEC-01
  '/api/tools/bm-usage/history?key=x',// SEC-02
  '/api/tools/bm-usage/activity',     // SEC-04
  '/api/tools/curuser/activity',      // SEC-05
  '/api/tools/vmseries/status',       // SEC-07
];

describe('SEC-01~07 — 범위 계정 응답이 전체 계정 응답과 달라야 한다', () => {
  const { scoped, full } = compare(PATHS);

  test('★ SEC-01 /tools/vclogs/sources — 허용 vCenter 만 준다(유출 실증분)', () => {
    const s = scoped['/api/tools/vclogs/sources'];
    const f = full['/api/tools/vclogs/sources'];
    assert.equal(s.status, 200);
    assert.deepEqual(s.body.local, ['vc-a'], `범위 밖 vCenter 가 샜다: ${JSON.stringify(s.body.local)}`);
    // 수정 전에는 이 둘이 **바이트 단위로 같았다**. 같으면 결함이 되살아난 것이다.
    assert.notDeepEqual(s.body, f.body, '범위 계정과 admin 응답이 같다 — scope 가 적용되지 않았다');
    assert.ok((f.body.local || []).length >= 3, '전체 범위 계정은 그대로 다 봐야 한다(과차단 금지)');
  });

  test('★ SEC-02 /tools/bm-usage/history — Set.includes TypeError 로 매달리지 않는다', () => {
    const s = scoped['/api/tools/bm-usage/history?key=x'];
    // 수정 전: `allowed.includes` 가 TypeError → async throw → **응답 없음**.
    // 지금은 404(존재 은닉) 또는 400 이어야 한다. 500·무응답이면 회귀다.
    assert.ok([400, 404].includes(s.status), `기대 400/404, 실제 ${s.status} ${JSON.stringify(s.body)}`);
  });

  test('★ SEC-04 /tools/bm-usage/activity — scope 를 적용했다고 응답이 밝힌다', () => {
    const s = scoped['/api/tools/bm-usage/activity'];
    assert.equal(s.status, 200);
    assert.equal(s.body.scoped, true, '범위 계정인데 scoped 표시가 없다');
    assert.ok('omittedOutOfScope' in s.body, '조용히 빼지 말 것 — 뺀 건수를 밝혀야 한다');
    // 전체 범위 계정은 축약하지 않는다(과차단 금지).
    assert.notEqual(full['/api/tools/bm-usage/activity'].body.scoped, true);
  });

  test('★ SEC-05 /tools/curuser/activity — 뺀 건수를 밝힌다', () => {
    const s = scoped['/api/tools/curuser/activity'];
    assert.equal(s.status, 200);
    assert.ok('omittedOutOfScope' in s.body, '조용히 빼지 말 것');
  });

  test('★ SEC-07 /tools/vmseries/status — 범위 계정에는 축약본을 준다', () => {
    const s = scoped['/api/tools/vmseries/status'];
    assert.equal(s.status, 200);
    assert.equal(s.body.scoped, true, 'lastResult 가 그대로 나가고 있다');
    assert.notEqual(full['/api/tools/vmseries/status'].body.scoped, true);
  });
});

/* ── ② 순수 헬퍼 ────────────────────────────────────────────────────────────── */

describe('SEC-03 — 엣지 설정 사본에서 법인 축을 뺀다', () => {
  const S = { intervalMs: 300000, corps: ['a', 'b', 'c'], osSsh: true };
  test('범위 계정: corps 를 빼고 **뺐다는 사실을 밝힌다**', () => {
    const out = scopeEdgeSettings(S, new Set(['vc-a']));
    assert.equal(out.corps, null);
    assert.equal(out.corpsHidden, true);
    assert.equal(out.corpsCount, 3);           // 조용한 축약 금지 — 개수는 준다
    assert.equal(out.intervalMs, 300000, '나머지 설정은 남겨야 화면이 원인을 말할 수 있다');
  });
  test('전체 범위 계정은 그대로(과차단 금지)', () => {
    assert.equal(scopeEdgeSettings(S, null), S);
  });
  test('값이 없으면 null — 지어내지 않는다', () => {
    assert.equal(scopeEdgeSettings(null, new Set(['x'])), null);
    assert.equal(scopeEdgeSettings('nope', new Set(['x'])), null);
  });
});

describe('SEC-07 — 폴러 상태 축약이 범위 밖 vCenter 를 남기지 않는다', () => {
  const ST = {
    running: false, enabled: true, intervalMs: 3_000_000,
    lastResult: {
      at: 1, trigger: 'timer', ms: 10, vcenters: 3, vms: 300, samples: 900,
      errors: [{ vcenterId: 'vc-b', error: 'vc-b 수집 실패: 인증 거부' }],
      skipped: [{ vcenterId: 'vc-c', why: 'no-targets' }],
      per: [{ vcenterId: 'vc-a', vms: 100, samples: 300 }, { vcenterId: 'vc-b', vms: 200, samples: 600 }],
    },
  };
  test('범위 밖 vcenterId 와 실패 메시지가 사라진다', () => {
    const out = scopeVmSeriesStatus(ST, new Set(['vc-a']));
    const json = JSON.stringify(out);
    assert.ok(!json.includes('vc-b'), 'vc-b 가 남아 있다');
    assert.ok(!json.includes('vc-c'), 'vc-c 가 남아 있다');
    assert.ok(!json.includes('인증 거부'), '범위 밖 실패 메시지가 남아 있다');
  });
  test('합계도 **보이는 것만** 다시 센다 — 전 법인 합계를 흘리지 않는다', () => {
    const out = scopeVmSeriesStatus(ST, new Set(['vc-a']));
    assert.equal(out.lastResult.vcenters, 1);
    assert.equal(out.lastResult.vms, 100);      // 300 이면 전 법인 합계가 샌 것이다
    assert.equal(out.lastResult.samples, 300);
    assert.equal(out.scoped, true);
  });
  test('running·enabled 는 남긴다 — 화면이 "수집이 꺼져 있다" 를 말해야 한다', () => {
    const out = scopeVmSeriesStatus(ST, new Set(['vc-a']));
    assert.equal(out.enabled, true);
    assert.equal(out.running, false);
    assert.equal(out.intervalMs, 3_000_000);
  });
  test('전체 범위 계정은 그대로', () => assert.equal(scopeVmSeriesStatus(ST, null), ST));
});

/* ── ③ 소스 계약 ────────────────────────────────────────────────────────────── */

describe('소스 계약 — 같은 실수가 되살아나지 않게', () => {
  test('★ scope 의 `allowed` 에 .includes() 를 쓰지 않는다 — Set 이다(SEC-02)', () => {
    /*
     * ⚠ 스윕을 `allowed.includes(` 로 넓게 잡으면 **오탐**이 난다 — 이 저장소에는 같은 이름의
     *   무관한 **배열**이 둘 있다(`auth/permissions.js:322` 의 도구 허용목록,
     *   `svcmon/store.js:152` 의 정렬 키 목록). 그래서 **그 파일이 `scopedVcenterIds` 로
     *   `allowed` 를 만든 경우에만** 결함으로 본다(v2.550.3 '없는 결함을 만들어 고치지 말 것').
     */
    const walk = (d, out = []) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (e.name.endsWith('.js')) out.push(p);
      }
      return out;
    };
    const bad = [];
    for (const f of walk(SRC)) {
      const src = stripComments(fs.readFileSync(f, 'utf8'));
      if (!/\ballowed\s*=\s*scopedVcenterIds\s*\(/.test(src)) continue;   // scope 의 allowed 인 파일만
      if (/\ballowed\s*\.\s*includes\s*\(/.test(src)) bad.push(path.relative(SRC, f));
    }
    assert.deepEqual(bad, [], `scope Set 에 .includes() 를 쓰고 있다: ${bad.join(', ')}`);
  });

  test('★ SEC-01 — vclogs/sources 가 사용자를 본다(`_req` 가 아니다)', () => {
    const src = read('routes/api/checksLogs.js');
    const m = /api\.get\('\/tools\/vclogs\/sources'[\s\S]{0,1200}?\n\}\);/.exec(src);
    assert.ok(m, '라우트를 찾지 못했다');
    assert.ok(!/\(_req,/.test(m[0]), '사용자를 보지 않는 시그니처(_req)로 되돌아갔다');
    assert.match(m[0], /scopedVcenterIds/, 'scope 교집합이 없다');
  });

  test('★ SEC-06 — 엣지 주소는 admin + 전체범위에만 준다', () => {
    const src = read('routes/ping.js');
    assert.match(src, /redactEdgeAddresses\(r, req\)/, '엣지 overview 가 주소를 가리지 않는다');
    const fn = /function redactEdgeAddresses[\s\S]*?\n\}/.exec(src)[0];
    // v2.598(AUTHZ-2598-01): 판정은 canSeeEdgeAddress 하나로 옮겼다(/series 와 공유) — 그 함수가 두 조건을 갖는다.
    assert.match(fn, /canSeeEdgeAddress\(req\)/);
    const judge = /function canSeeEdgeAddress[\s\S]*?\n\}/.exec(src)[0];
    assert.match(judge, /role === 'admin'/);
    assert.match(judge, /scopedVcenterIds/);
    assert.match(fn, /addressHidden/, '가린 사실을 밝혀야 한다(조용한 축약 금지)');
  });

  test('★ SEC-08 — 공개 API 선언이 내부 fullScopeOnly 라우트와 어긋나지 않는다', () => {
    const al = read('publicapi/allowlist.js');
    const pf = /path: '\/faults\/parts'[^}]*/.exec(al);
    assert.ok(pf, '/faults/parts 선언을 찾지 못했다');
    assert.match(pf[0], /requiresFullScope: true/,
      '내부 동등 라우트 /api/tools/part-faults 는 fullScopeOnly 인데 공개 API 는 전량을 준다');
    // 내부 쪽이 실제로 fullScopeOnly 인지도 함께 본다(한쪽만 바뀌면 이 대조가 무의미해진다).
    assert.match(read('routes/api/partFaults.js'), /'\/tools\/part-faults',[^)]*fullScopeOnly/);
  });
});

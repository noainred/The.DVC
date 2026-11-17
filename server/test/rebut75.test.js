/**
 * rebut75.test.js — 전체 점검 75회차(72 · 73 · 74회차 수정 반증) 확정분 회귀.
 *
 * R1 (72 F3) 엣지 로그 진행상태 글자 값을 **먼저 자르고 가렸다** — 16,384자 경계에 걸친 비밀은 끝 표지('@' · 닫는 따옴표)가 잘려 앞부분이
 *    원문으로 남았다(18회차 A-1 과 같은 함정). 가린 뒤 자르고, 중앙의 두 번째 가림이 글자 · 개수를 바꾸지 않는다(멱등).
 * R2 (73 F3) /overview/trend 가 오류 원문을 가린 응답(errorHidden)을 화면(trendNote)이 '이 기간에 쌓인 추이가 없습니다' 로 읽었다 —
 *    읽기 실패를 '기록 없음' 으로 단정. 500 사유도 200 경로와 같은 판정(admin + 전체 범위).
 * R3 (73 F4) 메일 받는 사람 검증이 `{toString:1}` 같은 객체 값에서 던져 400 대신 500(72 F4 toolcats 와 같은 함정).
 * R4 (74 F3) 서버는 시작 번호 0 을 받게 고쳤지만 화면이 `Number(x) || 1` 로 0 을 1 로 바꿔 보냈다(저장된 작업 열기도 `|| 1`).
 * R5 (74 F9) 저장된 작업 파일 읽기 오류 중 단건 조회(/provision/saved/:id)가 '찾을 수 없음'(404) — 목록(readError)과 다른 말.
 * R6 (74 F4 형제) perfBatch · nicPerf · soapClient parsePerfMultiXml 의 게으른 `<returnval>` · `<id>` 정규식 O(n²)
 *    (닫히지 않은 <id> 100KB 0.3초 · <returnval> 220KB 0.5초) → vcenter/soapParse.js 선형 훑기 한 벌(contention 도 같은 것).
 * 확인 — (73 F2) 로그 분석 크기 기억(WeakMap)이 합치기 · 줄이기 · 직렬화 뒤에도 상한을 넘기거나 일찍 막지 않는다(불변식).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

// v3.18.8: 이 파일이 만든 임시 폴더는 시험이 끝나면 지운다(지우지 않아 전량 실행마다 /tmp 에 쌓였다 — tmpCleanup3188 이 고정).
//   exit 에서 한 번 더 지운다 — 모듈의 종료 flush(util/exitFlush.js)가 뒤늦게 다시 만든 폴더(수 MB 실측)까지.
const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };
const rmTmpDirs = () => { for (const d of TMP_DIRS) fs.rmSync(d, { recursive: true, force: true }); };
after(() => { rmTmpDirs(); process.once('exit', () => { try { rmTmpDirs(); } catch { /* 종료 중 */ } }); });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const WEB = path.resolve(HERE, '../../web/src');
const src = (rel) => stripComments(fs.readFileSync(path.join(SRC, rel), 'utf8'));

let seed = 75;
const rnd = (n) => { seed = (seed + 0x6D2B79F5) | 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return (((t ^ (t >>> 14)) >>> 0) % n); };

function run(body, { router = 'api', prep = '' } = {}) {
  const dir = tmpDir('rebut75-');
  const mount = router === 'admin'
    ? `const { adminRouter } = await import(${JSON.stringify(path.join(SRC, 'routes/admin.js'))}); app.use('/api/admin', adminRouter);`
    : `const { api } = await import(${JSON.stringify(path.join(SRC, 'routes/api.js'))}); app.use('/api', api);`;
  const script = `
    const fs = await import('node:fs'); const path = await import('node:path');
    ${prep}
    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { username: 'adm', role: 'admin', scope: null }; next(); });
    ${mount}
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = 'http://127.0.0.1:' + srv.address().port + '/api';
    const call = async (m, p, b) => {
      const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
      let j = null; try { j = await r.json(); } catch {}
      return { s: r.status, j };
    };
    const out = {};
    ${body}
    srv.close();
    console.log('@@' + JSON.stringify(out));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUTH_ENABLED: 'true', SETTINGS_OWNERS: 'adm' },
    encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 120_000,
  });
  assert.equal(r.status, 0, `자식 프로세스 실패: ${r.stderr}`);
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  return JSON.parse(line.slice(2));
}

test('R1 — 상한을 넘는 글자 값은 가린 뒤 자른다(경계에 걸친 비밀 앞부분이 남지 않는다) · 중앙의 두 번째 가림은 글자 · 개수를 바꾸지 않는다', async () => {
  const { redactDeep } = await import('../src/edgelog/redact.js');
  const { putEdgeLog } = await import('../src/central/edgeLogStore.js');
  const shapes = [
    (o) => `${'x'.repeat(o)} https://svc:SuperSecretPassw0rd@central.corp/api tail`,
    (o) => `${'y'.repeat(o)} password: "abc def ghi jkl" more`,
    (o) => `${'z'.repeat(o)} {"centralToken":"tok1 tok2 tok3"} x`,
    (o) => `${'w'.repeat(o)} PASSWORD: 'pq1 pq2 pq3' s`,
  ];
  const LEAK = /SuperSecr|abc|def|ghi|tok1|tok2|tok3|pq1|pq2|pq3/;
  let n = 0;
  for (const sh of shapes) {
    for (let o = 16_384 - 48; o <= 16_384 + 4; o += 1) {
      const v = sh(o);
      const r1 = redactDeep({ lastError: v });
      const out = r1.value.lastError;
      assert.equal(r1.truncated, v.length > 16_384);
      assert.ok(!LEAK.test(out), `경계 ${o} 에서 비밀 조각이 남았다: ${JSON.stringify(out.slice(-60))}`);
      const r2 = redactDeep(r1.value);   // 중앙 재가림(72회차 개선)
      assert.equal(r2.masked, 0, `두 번째 가림이 개수를 더 셌다(경계 ${o})`);
      assert.equal(r2.value.lastError, out, `두 번째 가림이 글자를 바꿨다(경계 ${o})`);
      n += 1;
    }
  }
  assert.ok(n > 200);
  // 중앙 보관 경로(sanitizeStatus)도 같은 결과 — maskedFields 는 엣지 몫 그대로(이미 가린 값은 다시 세지 않는다).
  const edge = redactDeep({ centralUrl: 'https://u:pw@central/x', big: shapes[0](16_384 - 20) });
  const rec = putEdgeLog('edge-r75', { ok: true, maskedFields: edge.masked, status: [{ key: 'k', label: 'l', group: 'g', ok: true, value: edge.value }] });
  assert.equal(rec.maskedFields, edge.masked);
  assert.ok(!LEAK.test(JSON.stringify(rec.status)));
});

test('R2 — 추이 오류를 가린 지표(errorHidden)는 \'추이 없음\' 이 아니라 읽기 실패로 말한다 · 500 사유도 admin + 전체 범위만', async () => {
  const { trendNote } = await import(path.join(WEB, 'views/execOverviewText.js'));
  const { trendErrorsFor } = await import('../src/routes/api/overviewCards.js');
  const body = { ok: true, virtual: { series: null, error: 'SQLITE_CANTOPEN /data/vmtrack.db' }, storage: { series: null, error: 'x' } };
  const user = trendErrorsFor(body, false);
  assert.equal(user.virtual.error, undefined);
  const note = trendNote('virtual', user.virtual);
  assert.match(note, /읽지 못했습니다/);
  assert.doesNotMatch(note, /쌓인 추이가 없습니다/);
  assert.doesNotMatch(note, /SQLITE|vmtrack/);
  assert.match(trendNote('virtual', trendErrorsFor(body, true).virtual), /SQLITE_CANTOPEN/);
  // 500 사유: 같은 판정(isAdminReq ∧ 전체 범위) — 범위 관리자에게 원문을 주지 않는다.
  const s = src('routes/api/overviewCards.js');
  const h = s.slice(s.indexOf("api.get('/overview/trend'"), s.indexOf("api.get('/tools/power-total'"));
  const c = h.slice(h.indexOf('catch (e)'));
  assert.match(c, /scopedVcenterIds\(req\.user/);
  assert.match(c, /full \? \(e\?\.message/);
});

test('R3 — 메일 받는 사람에 객체 값({toString:1})이 오면 500 이 아니라 400 + field', () => {
  const out = run(`
    out.obj = await call('PUT', '/admin/mail', { defaultTo: [{ toString: 1 }] });
    out.objTop = await call('PUT', '/admin/mail', { defaultTo: { toString: 1 } });
    out.kind = await call('PUT', '/admin/mail', { kinds: { alert: { enabled: true, to: [{ toString: 1 }], cc: [] } } });
    out.good = await call('PUT', '/admin/mail', { defaultTo: ['good@corp.com'] });
  `, { router: 'admin' });
  assert.equal(out.obj.s, 400, JSON.stringify(out.obj));
  assert.equal(out.obj.j.field, 'defaultTo');
  assert.equal(out.objTop.s, 400, JSON.stringify(out.objTop));
  assert.equal(out.kind.s, 400, JSON.stringify(out.kind));
  assert.equal(out.kind.j.field, 'kinds.alert.to');
  assert.equal(out.good.s, 200, JSON.stringify(out.good));
});

test('R4 — 화면이 시작 번호 0 을 0 으로 보낸다(빈 칸만 서버 기본 1) · 저장된 작업을 열어도 0 그대로', async () => {
  const { startIndexOut } = await import(path.join(WEB, 'views/provisionText.js'));
  assert.equal(startIndexOut(0), 0);
  assert.equal(startIndexOut('0'), 0);
  assert.equal(startIndexOut('7'), 7);
  assert.equal(startIndexOut('-2'), -2, '음수는 그대로 보내 서버가 사유를 돌려준다');
  assert.equal(startIndexOut(''), null);
  assert.equal(startIndexOut(null), null);
  assert.equal(startIndexOut(undefined), null);
  const { expandSpec } = await import('../src/provision/spec.js');
  assert.equal(expandSpec({ namePattern: 'w-{n}', count: 2, startIndex: startIndexOut('0'), guest: { ipMode: 'dhcp' } }).vms[0].name, 'w-0');
  assert.equal(expandSpec({ namePattern: 'w-{n}', count: 1, startIndex: startIndexOut(''), guest: { ipMode: 'dhcp' } }).vms[0].name, 'w-1');
  const jsx = stripComments(fs.readFileSync(path.join(WEB, 'views/VmProvision.jsx'), 'utf8'));
  assert.doesNotMatch(jsx, /startIndex\)\s*\|\|\s*1/, '`Number(form.startIndex) || 1` 이 0 을 1 로 바꾼다');
  assert.doesNotMatch(jsx, /sp\.startIndex\s*\|\|\s*1/, '저장된 작업을 열 때 `sp.startIndex || 1` 이 0 을 1 로 바꾼다');
  assert.match(jsx, /startIndex: startIndexOut\(form\.startIndex\)/);
});

test('R5 — 저장된 작업 파일 읽기 오류 중 단건 조회는 404(없음)가 아니라 503 + 사유(경로 없음)', () => {
  const out = run(`
    out.list = await call('GET', '/provision/saved');
    out.one = await call('GET', '/provision/saved/00000000-0000-0000-0000-000000000000');
  `, { prep: "fs.mkdirSync(path.join(process.env.CONFIG_DIR, 'provision-saved.json'));" });
  assert.equal(out.list.j.readError, true, JSON.stringify(out.list));
  assert.equal(out.one.s, 503, JSON.stringify(out.one));
  assert.equal(out.one.j.readError, true);
  assert.match(out.one.j.reason, /EISDIR/);
  assert.doesNotMatch(out.one.j.reason, /\//, '사유에 경로를 싣지 않는다');
});

/* R6 — 옛 정규식(기준)과 결과가 같고, 닫히지 않은 태그 반복에 선형이다. */
const oldBodies = (xml, wb) => [...String(xml).matchAll(wb ? /<returnval\b[^>]*>([\s\S]*?)<\/returnval>/g : /<returnval[^>]*>([\s\S]*?)<\/returnval>/g)].map((m) => m[1]);
const oldMarks = (blk) => [...String(blk).matchAll(/<id>([\s\S]*?)<\/id>/g)].map((m) => ({ inner: m[1], start: m.index, end: m.index + m[0].length }));

test('R6 — returnvalBodies · perfIdMarks 는 옛 게으른 정규식과 결과가 같다(무작위 1만 건)', async () => {
  const { returnvalBodies, perfIdMarks } = await import('../src/vcenter/soapParse.js');
  const T = ['<returnval>', '<returnval xsi:type="PerfEntityMetric">', '<returnval\n>', '<returnvalue>', '<returnval', '</returnval>', '<id>', '</id>', '<id x="1">',
    '<counterId>2</counterId>', '<instance>vmnic0</instance>', '<instance></instance>', '<value>5</value>', '<value>-1</value>', '<timestamp>t</timestamp>',
    '<entity type="VirtualMachine">vm-1</entity>', 'x', '>', '<', ' ', '\n'];
  for (let n = 0; n < 10_000; n += 1) {
    let s = ''; const len = 1 + rnd(50);
    for (let i = 0; i < len; i += 1) s += T[rnd(T.length)];
    assert.deepEqual(returnvalBodies(s), oldBodies(s, false), JSON.stringify(s));
    assert.deepEqual(returnvalBodies(s, { wordBoundary: true }), oldBodies(s, true), JSON.stringify(s));
    assert.deepEqual(returnvalBodies(s, { max: 1 })[0] ?? null, oldBodies(s, false)[0] ?? null, JSON.stringify(s));
    assert.deepEqual(perfIdMarks(s), oldMarks(s), JSON.stringify(s));
  }
});

test('R6 — 세 성능 파서가 닫히지 않은 <id> · <returnval> 반복에 선형이다(정상 응답과 같은 자릿수)', async () => {
  const { parseEntityPerfBatchXml } = await import('../src/vcenter/perfBatch.js');
  const { parsePerfInstancesXml } = await import('../src/vcenter/nicPerf.js');
  const { parsePerfMultiXml } = await import('../src/vcenter/soapClient.js');
  const n = 40_000;
  const idOpen = `<returnval><entity type="VirtualMachine">vm-1</entity>${'<id>x'.repeat(n)}</returnval>`;   // 200KB
  const rvOpen = '<returnval>'.repeat(n);                                                                       // 440KB
  const normal = `<returnval><entity type="VirtualMachine">vm-1</entity>${'<timestamp>t</timestamp>'.repeat(4)}${'<id><counterId>2</counterId><instance></instance></id><value>1</value>'.repeat(n / 8)}</returnval>`;
  const time = (f) => { const t0 = performance.now(); f(); return performance.now() - t0; };
  for (const [name, f] of [['perfBatch', (x) => parseEntityPerfBatchXml(x, ['2'])], ['nicPerf', (x) => parsePerfInstancesXml(x, ['2'])], ['multi', (x) => parsePerfMultiXml(x, ['2'])]]) {
    const base = time(() => f(normal));
    for (const [kind, x] of [['id', idOpen], ['returnval', rvOpen]]) {
      const t = time(() => f(x));
      assert.ok(t < Math.max(100, base * 20), `${name} 닫히지 않은 <${kind}> ${x.length}자 ${t.toFixed(1)}ms (정상 ${base.toFixed(1)}ms)`);
    }
  }
  // 정상 응답은 예전과 같은 값
  const r = parsePerfMultiXml('<returnval><timestamp>a</timestamp><timestamp>b</timestamp><id><counterId>2</counterId><instance></instance></id><value>3</value><value>4</value></returnval>', ['2']);
  assert.deepEqual(r.get('2'), [{ t: 'a', v: 3 }, { t: 'b', v: 4 }]);
  for (const f of ['vcenter/perfBatch.js', 'vcenter/nicPerf.js', 'contention/parse.js']) {
    assert.doesNotMatch(src(f), /<id>\(\[\\s\\S\]\*\?\)/, `${f} 에 게으른 <id> 정규식이 남았다`);
    assert.doesNotMatch(src(f), /<returnval(?:\\b)?\[\^>\]\*>\(\[\\s\\S\]\*\?\)/, `${f} 에 게으른 <returnval> 정규식이 남았다`);
  }
});

test('확인(73 F2) — 로그 분석 크기 기억은 합치기 · 줄이기 · 직렬화를 섞어도 상한을 넘기지 않고, 꽉 찼을 때만 넘침을 센다', async () => {
  const E = await import('../src/loganalysis/engine.js');
  const saved = { ...E.CAPS };
  Object.assign(E.CAPS, { tmpl: 7, prob: 5, ent: 4, http: 6 });
  try {
    const rules = [{ id: 'r1', tag: '', re: /failed on node (\S+)/, entity: 1, severity: 'medium', title: 't' }];
    const idx = E.indexRules(rules);
    const W = ['alpha', 'beta', 'gamma', 'delta', 'eps', 'zeta', 'eta', 'theta', 'iota', 'kappa'];
    const item = () => {
      const k = rnd(4);
      if (k === 0) return { level: 'warn', msg: `[svc] failed on node n${W[rnd(10)]}` };
      if (k === 1) return { level: 'info', msg: `GET /api/${W[rnd(10)]} ${[200, 500][rnd(2)]} ${rnd(900)}ms` };
      return { level: ['warn', 'error', 'info'][rnd(3)], msg: `[t${rnd(2)}] ${W[rnd(10)]} thing ${W[rnd(10)]} error` };
    };
    const size = (o) => Object.keys(o || {}).length;
    for (let trial = 0; trial < 60; trial += 1) {
      let st = E.newState();
      for (let step = 0; step < 150; step += 1) {
        const op = rnd(16);
        if (op === 0) E.compactState(st, { tmpl: 3, prob: 2, ent: 2, http: 3 });
        else if (op === 1) { const x = E.newState(); for (let i = 0; i < 10; i += 1) E.addItem(x, item(), idx); E.mergeState(st, x); }
        else if (op === 2) st = JSON.parse(JSON.stringify(st));
        else {
          const before = { ...st.overflow }; const sz = { tmpl: size(st.tmpl), prob: size(st.prob), http: size(st.http) };
          E.addItem(st, item(), idx);
          for (const k of ['tmpl', 'prob', 'http']) if (st.overflow[k] > before[k]) assert.equal(sz[k], E.CAPS[k], `${k} 가 꽉 차기 전(${sz[k]})에 넘침을 셌다`);
        }
        assert.ok(size(st.tmpl) <= E.CAPS.tmpl && size(st.prob) <= E.CAPS.prob && size(st.http) <= E.CAPS.http);
        for (const r of Object.values(st.rules)) assert.ok(size(r.ent) <= E.CAPS.ent);
      }
    }
  } finally { Object.assign(E.CAPS, saved); }
});

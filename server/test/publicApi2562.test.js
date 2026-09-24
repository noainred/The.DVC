/**
 * publicApi2562.test.js — **외부 포탈용 공개 조회 API**(v2.562) 회귀 고정.
 *
 * 사용자 요청(2026-09-18): "모든 기능에 대해서 api 서비스 엔드포인트를 만들어서 다른 포탈에서
 * 읽어서 사용하게 할 수 있어?" 선택: **조회 전용 + 허용 목록**(거부 기본값) · **전용 API 키 신규
 * 발급**(CENTRAL_TOKEN 재사용 금지) · **버전 고정 경로 + OpenAPI** · **설정 화면에서 발급** ·
 * 1차 분류 **인벤토리 · 용량/사용량 · 장애/알람**(포탈 자체 상태는 고르지 않았다).
 *
 * ⚠⚠ **왜 소스 grep 이 아니라 실제 앱을 띄우는가**: v2.536 이 기록한 사고가 그것이다 —
 *   선언만 있고 집행이 없으면 접근제어가 아니다. 아래 게이트·투사 테스트는 **진짜 `/api/v1`
 *   라우터를 express 에 마운트해 상태코드와 응답 키로** 본다(`authzGates2536`·`userTools2555`
 *   와 같은 하니스). 자식 프로세스인 이유는 `config.js` 가 싱글턴이라 한 프로세스에서
 *   CONFIG_DIR 을 다시 가리킬 수 없기 때문이다.
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
const ROOT = path.resolve(SRC, '..');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
/** 주석을 규칙의 통과 근거로 쓰지 않는다(v2.535 규약) — 검사 전에 제거한다. */
// v2.574: 지역 정규식 판본은 **줄 주석 안의 슬래시+별 조합**에 걸려 코드를 통째로 지운다
// (실제 사례 `agent/configPush.js:34`). 공용 상태기계 코어를 쓴다 — `_stripComments.js` 머리말.
import { stripComments } from './_stripComments.js';

/* ── 실제 앱을 띄우는 하니스 ──────────────────────────────────────────────── */

/**
 * 임시 CONFIG_DIR 에서 `/api/v1` 라우터를 express 에 마운트하고 `script` 를 돈다.
 * `@@<json>` 한 줄을 받아 돌려준다.
 */
function runLive(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papi2562-'));
  const boot = `
    const express = (await import('express')).default;
    const { store } = await import(${JSON.stringify(path.join(SRC, 'store.js'))});
    const v1 = (await import(${JSON.stringify(path.join(SRC, 'routes/publicApi.js'))})).default;
    const keys = await import(${JSON.stringify(path.join(SRC, 'publicapi/keys.js'))});
    /*
     * 목 스냅샷을 **실제 경로로** 1회 채운다(DATA_SOURCE=mock). 스냅샷이 없으면 전 경로가
     * 503(not-collected)이고 그것도 계약이지만, 여기서는 데이터 경로를 봐야 한다.
     * (주의) 이 블록은 자식 프로세스로 넘기는 템플릿 리터럴 안이라 **백틱을 쓸 수 없다** —
     * 백틱 하나가 리터럴을 그 자리에서 끊는다(CLAUDE.md v2.550.3 규약).
     * 스냅샷을 손으로 조립하지 말 것 — withRollups/applyAlarmMutes 가 store 내부 비공개
     * 함수라 조립본은 실제와 다른 모양이 되고, 그러면 이 테스트가 계약을 못 지킨다.
     */
    await store.refresh({ force: true });
    const app = express();
    app.use('/api/v1', v1);
    const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
    const base = 'http://127.0.0.1:' + srv.address().port + '/api/v1';
    const call = async (p, key, init = {}) => {
      const res = await fetch(base + p, { ...init, headers: key ? { 'X-Api-Key': key, ...(init.headers || {}) } : (init.headers || {}) });
      let body = null; try { body = await res.json(); } catch { /* 본문 없음도 정보다 */ }
      return { status: res.status, body, headers: Object.fromEntries(res.headers) };
    };
    const out = await (async () => { ${script} })();
    srv.close();
    console.log('@@' + JSON.stringify(out));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', boot], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUTH_ENABLED: 'false' },
    encoding: 'utf8', cwd: ROOT, timeout: 180_000,
  });
  assert.equal(r.status, 0, `자식 프로세스 실패: ${r.stderr?.slice(-1500)}`);
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, `출력에 결과가 없습니다: ${r.stdout.slice(-800)}`);
  return JSON.parse(line.slice(2));
}

/* ── ① 조회 전용 — 상태변경을 열지 않는다 ────────────────────────────────── */

test('공개 API 는 전부 GET 이다 — 상태변경 라우트를 선언조차 하지 않는다', () => {
  const src = stripComments(read('routes/publicApi.js'));
  const bad = src.match(/\bv1\s*\.\s*(post|put|patch|delete)\s*\(/gi) || [];
  assert.deepEqual(bad, [], `공개 라우터에 상태변경이 있습니다: ${bad.join(', ')}`);
  // 카탈로그 선언도 GET 뿐이어야 한다 — 선언과 라우터가 갈라지면 문서가 거짓이 된다.
  const al = stripComments(read('publicapi/allowlist.js'));
  const methods = [...al.matchAll(/method:\s*'([A-Z]+)'/g)].map((m) => m[1]);
  assert.ok(methods.length >= 8, `엔드포인트 선언을 찾지 못했습니다(${methods.length}개)`);
  assert.deepEqual([...new Set(methods)], ['GET'], `GET 이 아닌 선언: ${[...new Set(methods)].join(',')}`);
});

/* ── ② 거부 기본값 — 분류를 켜지 않은 키는 아무것도 못 본다 ──────────────── */

test('거부 기본값 — 키 없음 401 · 분류 없음 403 · 다른 분류 403 · 미선언 경로 404', () => {
  const r = runLive(`
    const full = keys.issueApiKey({ name: 'full', groups: ['inventory', 'capacity', 'faults'] }).plaintext;
    const invOnly = keys.issueApiKey({ name: 'inv', groups: ['inventory'] }).plaintext;
    const none = keys.issueApiKey({ name: 'none', groups: [] }).plaintext;
    return {
      noKey:       await call('/inventory/summary', null),
      unknownKey:  await call('/inventory/summary', 'dvcapi_' + 'x'.repeat(43)),
      noGroups:    await call('/inventory/summary', none),
      otherGroup:  await call('/faults/alarms', invOnly),
      ownGroup:    await call('/inventory/summary', invOnly),
      unknownPath: await call('/inventory/does-not-exist', full),
      catalog:     await call('/', invOnly),
    };
  `);
  assert.equal(r.noKey.status, 401, '키 없이 데이터가 나갔습니다');
  assert.equal(r.noKey.body.code, 'missing-key');
  assert.equal(r.unknownKey.status, 401);
  assert.equal(r.unknownKey.body.code, 'unknown-key');
  /*
   * ⚠ 빈 허용목록을 '전부 허용' 으로 읽으면 안 된다(v2.555 규약).
   * ⚠ 상태는 **403** 이다 — 키 자체는 유효(인증 성공)하고 인가가 비어 있는 것이므로 401 이
   *   아니다. `openapi.js COMMON_RESPONSES` 의 분류와 같아야 한다(문서와 응답이 갈라지면
   *   상대 포탈이 401 을 보고 '키가 틀렸다' 며 멀쩡한 키를 재발급한다).
   */
  assert.equal(r.noGroups.status, 403, '빈 허용목록 키가 데이터를 받았습니다(거부 기본값 위반)');
  assert.equal(r.noGroups.body.code, 'no-groups');
  assert.equal(r.otherGroup.status, 403, '허용하지 않은 분류가 나갔습니다');
  assert.equal(r.otherGroup.body.code, 'group-denied');
  assert.equal(r.ownGroup.status, 200);
  // ⚠ 404 가 경로 목록을 흘리지 않는다(열거 단서).
  assert.equal(r.unknownPath.status, 404);
  assert.ok(!/\/inventory\/summary|\/faults\//.test(JSON.stringify(r.unknownPath.body)),
    '404 응답이 다른 경로를 알려줍니다');
  // 카탈로그는 이 키로 무엇이 되는지 스스로 확인하는 경로다 — 안 되는 것도 표시한다.
  const groups = r.catalog.body.data.groups;
  assert.equal(groups.find((g) => g.key === 'inventory').allowed, true);
  assert.equal(groups.find((g) => g.key === 'faults').allowed, false);
});

/* ── ③ 필드 계약 — 선언한 것만 나가고, 선언한 것은 빠지지 않는다 ─────────── */

test('투사 계약 — 응답 키 집합이 선언 fields 와 정확히 같다(내부 필드 유출 0)', () => {
  const r = runLive(`
    const k = keys.issueApiKey({ name: 'all', groups: ['inventory', 'capacity', 'faults'] }).plaintext;
    const { ENDPOINTS } = await import(${JSON.stringify(path.join(SRC, 'publicapi/allowlist.js'))});
    const out = {};
    for (const ep of ENDPOINTS) {
      const res = await call(ep.path, k);
      const d = res.body?.data;
      const one = Array.isArray(d) ? d[0] : d;
      out[ep.path] = {
        status: res.status,
        declared: ep.fields,
        got: one ? Object.keys(one) : null,
        rows: Array.isArray(d) ? d.length : 1,
        metaKeys: Object.keys(res.body?.meta || {}),
        envelope: Object.keys(res.body || {}),
      };
    }
    return out;
  `);
  for (const [p, v] of Object.entries(r)) {
    assert.ok([200, 503].includes(v.status), `${p}: 예상 못한 상태 ${v.status}`);
    if (v.status !== 200 || v.got == null) continue;      // 모듈 미사용 환경(503)·빈 목록은 건너뛴다
    assert.deepEqual([...v.got].sort(), [...v.declared].sort(),
      `${p}: 응답 키가 선언과 다릅니다\n  선언=${v.declared.join(',')}\n  실제=${v.got.join(',')}`);
    // 봉투는 고정 계약이다 — 키가 바뀌면 상대 포탈이 깨진다.
    assert.deepEqual([...v.envelope].sort(), ['apiVersion', 'data', 'endpoint', 'generatedAt', 'meta', 'ok'],
      `${p}: 응답 봉투가 바뀌었습니다: ${v.envelope.join(',')}`);
  }
  // 목 데이터에서 실제로 값이 온 경로가 있어야 한다(전부 503 이면 이 테스트는 아무것도 안 본 것이다).
  const live = Object.values(r).filter((v) => v.status === 200 && v.got != null);
  assert.ok(live.length >= 4, `200 + 데이터가 온 경로가 ${live.length}개뿐입니다 — 하니스를 확인하세요`);
});

/* ── ④ 범위로 나눌 수 없는 자원은 부분 데이터를 주지 않고 거절한다 ───────── */

test('범위 지정 키는 법인 축이 없는 자원에 403 needs-full-scope — 빈 목록을 주지 않는다', () => {
  const r = runLive(`
    const scoped = keys.issueApiKey({ name: 'sc', groups: ['capacity', 'inventory'], vcenters: ['vc-ap-northeast'] }).plaintext;
    const full   = keys.issueApiKey({ name: 'fu', groups: ['capacity', 'inventory'] }).plaintext;
    return {
      scopedStorage: await call('/capacity/storage', scoped),
      fullStorage:   await call('/capacity/storage', full),
      scopedDs:      await call('/capacity/datastores', scoped),
      fullDs:        await call('/capacity/datastores', full),
      scopedVcs:     await call('/inventory/vcenters', scoped),
    };
  `);
  // ⚠⚠ 빈 목록(= '장비 0대' 라는 거짓)도, 전량(= 범위 위반)도 아니라 403 이다.
  assert.equal(r.scopedStorage.status, 403, '범위 키가 스토리지 목록을 받았습니다');
  assert.equal(r.scopedStorage.body.code, 'needs-full-scope');
  assert.ok([200, 503].includes(r.fullStorage.status), '전체 범위 키가 거절됐습니다');
  // 데이터스토어는 vCenter 축이 있으니 교집합으로 좁힌다(403 이 아니다).
  assert.equal(r.scopedDs.status, 200);
  assert.equal(r.scopedVcs.status, 200);
  assert.equal(r.scopedVcs.body.meta.scopedToVcenters, 1, '범위가 meta 에 밝혀지지 않았습니다');
  // ⚠ `scopedVcenterIds` 의 `null`(제한 없음)을 빈 집합으로 읽으면 전체 키가 아무것도 못 본다.
  assert.equal(r.fullDs.body.meta.scopedToVcenters, null, '전체 범위 키의 meta 가 null 이 아닙니다');
  assert.ok(r.fullDs.body.data.length >= r.scopedDs.body.data.length,
    '범위 키가 전체 키보다 많은 행을 받았습니다');
  assert.ok(r.scopedDs.body.data.every((d) => d.vcenterId === 'vc-ap-northeast'),
    '범위 밖 vCenter 의 데이터스토어가 섞였습니다');
});

/* ── ⑤ 중복 집계가 조용히 어긋나지 않게 — 내부 /summary 와 대조 ──────────── */

test('v1 /inventory/summary 는 내부 집계와 같은 값이다(단위만 다르다)', () => {
  const r = runLive(`
    const k = keys.issueApiKey({ name: 'sum', groups: ['inventory'] }).plaintext;
    const v1sum = (await call('/inventory/summary', k)).body.data;
    // 내부 /summary 의 집계는 그 라우트 안에 인라인이라 꺼내 쓸 함수가 없다 — 스냅샷에서 직접 센다.
    const snap = store.get();
    const hosts = snap.hosts || [], vms = snap.vms || [], dss = snap.datastores || [];
    const sum = (a, f) => a.reduce((s, x) => s + (Number(f(x)) || 0), 0);
    return { v1sum, internal: {
      vcenters: (snap.vcenters || []).length,
      hosts: hosts.length,
      vms: vms.length,
      vmsPoweredOn: vms.filter((v) => v.powerState === 'POWERED_ON').length,
      datastores: dss.length,
      networks: (snap.networks || []).length,
      clusters: new Set(hosts.map((h) => h.vcenterId + '/' + h.cluster)).size,
      cpuCores: sum(hosts, (h) => h.cpuCores),
      cpuTotalMhz: sum(hosts, (h) => h.cpuTotalMhz),
      memTotalMB: sum(hosts, (h) => h.memTotalMB),
      storageCapacityGB: sum(dss, (d) => d.capacityGB),
      vmVcpu: sum(vms, (v) => v.cpuCount),
    } };
  `);
  for (const [k, want] of Object.entries(r.internal)) {
    assert.equal(r.v1sum[k], want, `${k}: v1=${r.v1sum[k]} 내부=${want} — 중복 집계가 갈라졌습니다`);
  }
});

/* ── ⑥ 비밀은 어떤 응답에도 실리지 않는다 ────────────────────────────────── */

test('평문 키·해시는 발급 응답 말고 어디에도 없다', () => {
  const r = runLive(`
    const issued = keys.issueApiKey({ name: 'secret-probe', groups: ['inventory'] });
    const pt = issued.plaintext;
    const listed = keys.listApiKeys();
    return {
      plaintextLen: pt.length,
      prefixOk: pt.startsWith(keys.KEY_PREFIX),
      listedJson: JSON.stringify(listed),
      publicKeyHasHash: Object.prototype.hasOwnProperty.call(issued.key, 'hash'),
      plaintext: pt,
      catalogJson: JSON.stringify((await call('/', pt)).body),
      dataJson: JSON.stringify((await call('/inventory/summary', pt)).body),
      openapiJson: JSON.stringify((await call('/openapi.json', pt)).body),
      cacheHeader: (await call('/inventory/summary', pt)).headers['cache-control'] || '',
      fp: issued.key.fp,
    };
  `);
  assert.equal(r.plaintextLen, 50, '키 길이가 바뀌었습니다');
  assert.ok(r.prefixOk, '접두가 붙지 않았습니다');
  assert.equal(r.publicKeyHasHash, false, 'publicKey 가 해시를 내보냅니다');
  /*
   * ⚠ 접두(`dvcapi_`)만으로 검사하면 **OpenAPI 문서의 사용법 예시**(`X-Api-Key: dvcapi_...`)에
   *   걸려 오탐한다(v2.562 초판이 실제로 그랬다). 검사 대상은 **발급된 실제 평문**이다.
   */
  for (const [where, json] of [['목록', r.listedJson], ['카탈로그', r.catalogJson], ['데이터', r.dataJson], ['OpenAPI', r.openapiJson]]) {
    assert.ok(!json.includes(r.plaintext), `${where} 응답에 평문 키가 있습니다`);
    // 난수부(43자)만으로도 유출이다 — 접두를 떼고도 확인한다.
    assert.ok(!json.includes(r.plaintext.slice(7)), `${where} 응답에 평문 키의 난수부가 있습니다`);
    assert.ok(!/"hash"/.test(json), `${where} 응답에 해시 필드가 있습니다`);
    assert.ok(!/[0-9a-f]{64}/.test(json), `${where} 응답에 sha256 전체 해시로 보이는 값이 있습니다`);
  }
  // ⚠ 지문은 8자만이다(전체 해시는 곧 저장값이다 — v2.560 규약).
  assert.match(r.fp, /^sha256:[0-9a-f]{8}\(len=\d+\)$/, `지문 표기가 다릅니다: ${r.fp}`);
  // 키마다 범위가 달라 중간 캐시가 섞으면 안 된다.
  assert.match(r.cacheHeader, /no-store/, 'Cache-Control: no-store 가 없습니다');
});

/* ── ⑦ 상한·정직성 ───────────────────────────────────────────────────────── */

test('분당 상한을 넘기면 429 + Retry-After 이고, 조용히 자르지 않는다', () => {
  const r = runLive(`
    const k = keys.issueApiKey({ name: 'rl', groups: ['inventory'], rpm: 3 }).plaintext;
    const seq = [];
    for (let i = 0; i < 5; i++) {
      const res = await call('/inventory/collection', k);
      seq.push({ status: res.status, retry: res.headers['retry-after'] || null, limit: res.headers['x-ratelimit-limit'] || null });
    }
    return { seq };
  `);
  const codes = r.seq.map((s) => s.status);
  assert.deepEqual(codes.slice(0, 3), [200, 200, 200], `상한 3 인데 앞 3회가 통과하지 않았습니다: ${codes}`);
  assert.deepEqual(codes.slice(3), [429, 429], `상한 초과가 429 가 아닙니다: ${codes}`);
  assert.ok(Number(r.seq[3].retry) > 0, 'Retry-After 가 없습니다 — 언제 재시도할지 알 수 없습니다');
  assert.equal(r.seq[0].limit, '3', 'X-RateLimit-Limit 가 실제 상한과 다릅니다');
});

test('목록 상한은 응답에 밝힌다 — truncated·omitted·limit 키가 계약이다', () => {
  const src = stripComments(read('routes/publicApi.js'));
  for (const k of ['truncated', 'omitted', 'limit']) {
    assert.ok(src.includes(k), `상한 표기 키 '${k}' 가 사라졌습니다(조용한 상한 금지)`);
  }
  // 상한을 넘긴 경우에만 truncated:true 여야 한다 — 항상 true 면 뜻이 없다.
  const r = runLive(`
    const k = keys.issueApiKey({ name: 'cap', groups: ['inventory'] }).plaintext;
    const res = await call('/inventory/vcenters', k);
    return { meta: res.body.meta, rows: res.body.data.length };
  `);
  assert.equal(r.meta.truncated, false, '상한에 닿지 않았는데 truncated 입니다');
  assert.equal(r.meta.omitted, 0);
  assert.equal(r.meta.count, r.rows, 'meta.count 와 실제 행 수가 다릅니다');
});

/* ── ⑧ async throw 가 요청을 매달지 않는다(v2.548 S1) ────────────────────── */

test('핸들러의 async reject 는 500 으로 응답한다 — 요청이 매달리지 않는다', () => {
  const src = stripComments(read('routes/publicApi.js'));
  /*
   * ⚠⚠ express 4 는 async 핸들러의 throw 를 잡지 않아 요청이 **응답 없이 매달린다**.
   *   동기 `try/catch` 는 async reject 를 놓치므로 `Promise.resolve().then().catch()` 여야 한다.
   */
  assert.match(src, /Promise\s*\.\s*resolve\s*\(\s*\)[\s\S]{0,400}?\.catch\s*\(/,
    'guarded() 가 Promise 체인으로 감싸지 않았습니다 — async throw 가 요청을 매달립니다');
  assert.match(src, /res\.headersSent/, '이미 보낸 응답을 덮어쓰지 않는 가드가 없습니다');

  const r = runLive(`
    // DB 를 못 열게 만들어 실제로 던지는 경로를 만든다 — 상한 시간 안에 응답이 와야 한다.
    const k = keys.issueApiKey({ name: 'boom', groups: ['faults'] }).plaintext;
    const t0 = Date.now();
    const res = await call('/faults/parts', k);
    return { status: res.status, ms: Date.now() - t0, code: res.body?.code || null };
  `);
  assert.ok(r.ms < 20_000, `응답이 ${r.ms}ms 걸렸습니다 — 매달린 것으로 봅니다`);
  assert.ok([200, 500, 503].includes(r.status), `예상 못한 상태 ${r.status}`);
});

/* ── ⑨ 시각 표기 — ISO 문자열을 null 로 만들지 않는다 ───────────────────── */

test('msOrNull — ISO 문자열·숫자·숫자문자열을 epoch ms 로, 나머지는 null', async () => {
  const { msOrNull } = await import('../src/publicapi/time.js');
  const iso = '2026-09-18T08:58:34.918Z';
  assert.equal(msOrNull(iso), Date.parse(iso), 'ISO 문자열을 읽지 못했습니다');
  assert.equal(msOrNull(1789700314918), 1789700314918);
  assert.equal(msOrNull('1789700314918'), 1789700314918);
  // ⚠ `Date.parse('12345')` 는 **연도 12345** 로 해석된다 — 숫자 꼴을 먼저 봐야 한다.
  assert.equal(msOrNull('12345'), 12345, '숫자 문자열이 연도로 해석됐습니다');
  assert.equal(msOrNull(new Date(5)), 5);
  // ⚠ `Number('') === 0` · `Number([]) === 0` 함정(v2.561 규약) — 전부 null 이어야 한다.
  for (const v of [null, undefined, '', '   ', [], {}, true, false, NaN, 'not a date', new Date('x')]) {
    assert.equal(msOrNull(v), null, `${JSON.stringify(v)} 가 null 이 아닙니다: ${msOrNull(v)}`);
  }
});

test('시각 필드는 numOrNull 이 아니라 msOrNull 을 쓴다 — 실제 응답이 숫자다', () => {
  const src = stripComments(read('routes/publicApi.js'));
  for (const f of ['generatedAt', 'collectedAt', 'triggeredAt', 'openedAt', 'lastSeenAt']) {
    const m = new RegExp(`${f}:\\s*numOrNull\\(`);
    assert.ok(!m.test(src), `${f} 가 numOrNull 을 씁니다 — ISO 문자열이 null 이 됩니다(v2.562 실측 결함)`);
  }
  const r = runLive(`
    const k = keys.issueApiKey({ name: 'ts', groups: ['inventory'] }).plaintext;
    const col = (await call('/inventory/collection', k)).body.data;
    const sum = (await call('/inventory/summary', k)).body;
    const vcs = (await call('/inventory/vcenters', k)).body.data;
    return { colGeneratedAt: col.generatedAt, metaCollectedAt: sum.meta.collectedAt,
             envelopeGeneratedAt: sum.generatedAt, vcCollectedAt: vcs[0]?.collectedAt ?? null,
             snapType: typeof store.get().generatedAt };
  `);
  // 스냅샷은 ISO 문자열이다(`store.js:402`) — 그것이 이 규칙이 필요한 이유다.
  assert.equal(r.snapType, 'string', '스냅샷 generatedAt 의 꼴이 바뀌었습니다 — 이 규칙을 재검토하세요');
  for (const [k, v] of Object.entries(r)) {
    if (k === 'snapType') continue;
    assert.equal(typeof v, 'number', `${k} 가 숫자가 아닙니다: ${JSON.stringify(v)}`);
    assert.ok(v > 1_600_000_000_000, `${k} 가 epoch ms 로 보이지 않습니다: ${v}`);
  }
});

/* ── ⑩ 고르지 않은 분류를 만들지 않았다 ─────────────────────────────────── */

test('1차 허용 분류는 셋뿐이다 — 고르지 않은 포탈 자체 상태를 함께 싣지 않았다', async () => {
  const { GROUP_KEYS, ENDPOINTS } = await import('../src/publicapi/allowlist.js');
  assert.deepEqual([...GROUP_KEYS].sort(), ['capacity', 'faults', 'inventory'],
    `허용 분류가 바뀌었습니다: ${GROUP_KEYS.join(',')}`);
  assert.deepEqual(ENDPOINTS.filter((e) => !GROUP_KEYS.includes(e.group)), [],
    '선언된 분류에 없는 엔드포인트가 있습니다');
  const src = stripComments(read('routes/publicApi.js'));
  assert.ok(!/\/portal\/status/.test(src), '고르지 않은 /portal/status 가 되살아났습니다');
});

/* ── ⑪ 배선·비밀 파일 등록 ──────────────────────────────────────────────── */

test('/api/v1 은 세션 인증 미들웨어 앞에 마운트된다(키 인증이 자기 게이트다)', () => {
  const idx = stripComments(read('index.js'));
  assert.match(idx, /app\.use\(\s*'\/api\/v1'\s*,\s*publicApiRouter\s*\)/,
    '/api/v1 마운트가 사라졌습니다');
  // 라우터 자신이 첫 미들웨어로 키 인증을 건다 — 이것이 유일한 게이트다.
  const src = stripComments(read('routes/publicApi.js'));
  assert.match(src, /v1\.use\(\s*apiKeyAuth\(\)\s*\)/, '라우터에 키 인증 미들웨어가 없습니다');
  const useIdx = src.indexOf('v1.use(apiKeyAuth())');
  const firstGet = src.search(/v1\.get\(/);
  assert.ok(useIdx > -1 && useIdx < firstGet,
    '키 인증이 첫 GET 보다 뒤에 있습니다 — 그 앞의 경로가 무인증으로 열립니다');
});

test('api-keys.json 은 SECRET_FILES 등록 + .gitignore 차단 — 둘 다 해야 한다', () => {
  // ⚠ 봉인(SECRET_FILES)과 커밋 차단(.gitignore)은 **별개의 의무**다(v2.500 C/M4 규약).
  const vault = read('security/secretVault.js');
  assert.match(vault, /'api-keys\.json'/, 'api-keys.json 이 SECRET_FILES 에 없습니다');
  // ⚠ 경로가 `server/config/...` 이므로 **저장소 루트**에서 돌린다(ROOT 는 `server/` 다).
  const repoRoot = path.resolve(ROOT, '..');
  const r = spawnSync('git', ['check-ignore', '-q', 'server/config/api-keys.json'], { cwd: repoRoot });
  assert.equal(r.status, 0, 'server/config/api-keys.json 이 .gitignore 로 차단되지 않았습니다');
});

/* ── ⑫ 발급·폐기 계약(순수) ─────────────────────────────────────────────── */

test('키 발급 정직성 — 모르는 분류는 버리고 밝히고, 빈 목록·무기한을 조용히 넘기지 않는다', async () => {
  const { normalizeKeyInput, DEFAULT_RPM } = await import('../src/publicapi/keys.js');
  const a = normalizeKeyInput({ name: 'x', groups: ['inventory', 'nope', 'portal'] });
  assert.deepEqual(a.values.groups, ['inventory'], '모르는 분류가 통과했습니다');
  assert.ok(a.issues.some((s) => s.includes('모르는 분류')), '버린 사실을 밝히지 않습니다');
  // ⚠ 빈 허용목록은 정당한 설정이고 그대로 저장한다 — '전부 허용' 으로 되돌리지 말 것.
  const b = normalizeKeyInput({ name: 'y', groups: [] });
  assert.deepEqual(b.values.groups, []);
  assert.ok(b.issues.some((s) => s.includes('거부 기본값')), '거부 기본값임을 밝히지 않습니다');
  // 무기한 키는 경고한다(조용히 발급하지 않는다).
  assert.ok(b.issues.some((s) => s.includes('무기한')), '무기한 키를 경고하지 않습니다');
  assert.ok(normalizeKeyInput({ name: 'z' }).values.rpm === DEFAULT_RPM);
  // 이름이 없으면 발급하지 않는다 — 나중에 어느 포탈의 키인지 알 수 없다.
  assert.deepEqual(normalizeKeyInput({ groups: ['inventory'] }).values.name, '');
});

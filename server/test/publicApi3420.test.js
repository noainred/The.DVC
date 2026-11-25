/**
 * publicApi3420.test.js — 공개 조회 API 2차(v3.42.0) 회귀 고정.
 *
 * 사용자 요청(2026-11-26): "버그 수정하고, 없는 API 추가해줘" — 선택: **1차 핵심 조회**(호스트 · VM · 네트워크 · 클러스터 · 라이선스 만료 ·
 * 스냅샷 · 법인별 백업 · 전력/GPU) · 쓰기는 **설계부터**(이번에 열지 않는다) · **전체 검증**.
 *
 * 고정하는 것
 *   ① 새 분류 넷(objects · compliance · backup · resources)은 거부 기본값 — 기존 분류만 켠 키는 새 경로 전부 403 group-denied
 *   ② 범위 — 범위 키는 그 vCenter 행만 · 전력(법인 축 없음)은 403 needs-full-scope · ?vcenterId 범위 밖과 없는 id 는 **같은 404**(존재 은닉)
 *   ③ 쪽 나눔 — 쪽을 이어 붙이면 전체와 같다(겹침 · 빠짐 0) · 형식 오류는 400(조용히 기본값으로 바꾸지 않는다)
 *   ④ 판정 코어 하나 — 라이선스 · 스냅샷 · 백업 · GPU 행 수가 내부 화면 함수와 같다 · 라이선스 키 값은 응답 어디에도 없다
 *   ⑤ 못 읽은 값은 null — 끊긴 호스트 사용률 · 전력을 하나도 못 읽은 합(웹 powerTotalKw/powerCatKw 와 같은 입력으로 대조)
 *   ⑥ 중첩 객체(policy · rpo · servers …)도 선언한 키만 — 내부 객체를 펼쳐 새는 것을 막는다
 *   ⑦ OpenAPI 쿼리 인자 = 카탈로그 params · 문서(API-PUBLIC.md)의 공개 경로 · 분류 개수 = 카탈로그 · 낡은 전체 개수(820 · 686) 없음
 *
 * 하니스는 publicApi2562 와 같다(진짜 /api/v1 라우터를 express 에 마운트 · DATA_SOURCE=mock · 자식 프로세스 — config 싱글턴 때문).
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
const ROOT = path.resolve(SRC, '..');
const REPO = path.resolve(ROOT, '..');
const NEW_PATHS = ['/objects/hosts', '/objects/vms', '/objects/networks', '/objects/clusters', '/compliance/licenses', '/compliance/snapshots',
  '/backup/summary', '/resources/power', '/resources/gpu'];

function runLive(script, { refresh = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papi3420-'));
  const boot = `
    const express = (await import('express')).default;
    const { store } = await import(${JSON.stringify(path.join(SRC, 'store.js'))});
    const v1 = (await import(${JSON.stringify(path.join(SRC, 'routes/publicApi.js'))})).default;
    const keys = await import(${JSON.stringify(path.join(SRC, 'publicapi/keys.js'))});
    const { GROUP_KEYS } = await import(${JSON.stringify(path.join(SRC, 'publicapi/allowlist.js'))});
    ${refresh ? 'await store.refresh({ force: true });' : '/* 골격 시험 — 첫 병합을 하지 않는다 */'}
    const app = express();
    app.use('/api/v1', v1);
    const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
    const base = 'http://127.0.0.1:' + srv.address().port + '/api/v1';
    const call = async (p, key) => {
      const res = await fetch(base + p, { headers: key ? { 'X-Api-Key': key } : {} });
      const text = await res.text();
      let body = null; try { body = JSON.parse(text); } catch { /* 본문 없음도 정보다 */ }
      return { status: res.status, body, text };
    };
    const out = await (async () => { ${script} })();
    srv.close();
    console.log('@@' + JSON.stringify(out));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', boot], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUTH_ENABLED: 'false' },
    encoding: 'utf8', cwd: ROOT, timeout: 240_000, maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(r.signal, null, `자식 프로세스가 신호로 끝났습니다(${r.signal}) — 출력 상한 · 시한을 확인하세요`);
  assert.equal(r.status, 0, `자식 프로세스 실패: ${r.stderr?.slice(-1500)}`);
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, `출력에 결과가 없습니다: ${r.stdout.slice(-800)}`);
  return JSON.parse(line.slice(2));
}

/* ── 실제 앱 하나로 여러 성질을 본다(자식 프로세스 기동이 비싸다) ─────────────────────────── */

const LIVE = (() => {
  let cache = null;
  return () => {
    if (cache) return cache;
    cache = runLive(`
      const NEW = ${JSON.stringify(NEW_PATHS)};
      const SCOPE_VC = 'vc-ap-northeast';
      const all = keys.issueApiKey({ name: 'all', groups: [...GROUP_KEYS] }).plaintext;
      const old = keys.issueApiKey({ name: 'old', groups: ['inventory', 'capacity', 'faults', 'san'] }).plaintext;
      const scoped = keys.issueApiKey({ name: 'sc', groups: [...GROUP_KEYS], vcenters: [SCOPE_VC] }).plaintext;
      const snap = store.get();
      const o = { oldKey: {}, scoped: {}, full: {}, pick: {} };
      for (const p of NEW) {
        const a = await call(p, old); o.oldKey[p] = { status: a.status, code: a.body?.code };
        const s = await call(p, scoped); o.scoped[p] = { status: s.status, code: s.body?.code, vcs: Array.isArray(s.body?.data) ? [...new Set(s.body.data.map((x) => x.vcenterId))] : null, rows: Array.isArray(s.body?.data) ? s.body.data.length : null, scopedTo: s.body?.meta?.scopedToVcenters };
        const f = await call(p, all);
        // 출력은 필요한 조각만 — 전량(VM 5천 행 등)을 실으면 spawnSync 출력 상한을 넘어 자식이 죽는다(실측).
        const keep = ['/compliance/licenses', '/backup/summary', '/resources/power'].includes(p) ? f.body?.data
          : p === '/objects/hosts' ? (f.body?.data || []).filter((h) => (snap.hosts || []).some((x) => x.id === h.id && x.connectionState === 'DISCONNECTED')) : undefined;
        o.full[p] = { status: f.status, rows: Array.isArray(f.body?.data) ? f.body.data.length : null, data: keep, meta: f.body?.meta };
        if (p === '/compliance/snapshots') {
          const d = f.body?.data || [];
          o.snapJudge = { unjudged: d.filter((x) => x.judged === false).length, unjudgedWithFlag: d.filter((x) => x.judged === false && (x.overAge !== null || x.overCount !== null || x.overSize !== null)).length,
            judged: d.filter((x) => x.judged === true).length,
            // 판정했고 값(나이 · 크기)을 읽은 행만 불리언이어야 한다 — 값을 못 읽은 행은 null(반증 B-2 — 예전 단언은 '판정 = 불리언' 이라 그 결함을 굳혔다)
            judgedNonBool: d.filter((x) => x.judged === true && ((x.ageDays != null && typeof x.overAge !== 'boolean') || (x.sizeGB != null && typeof x.overSize !== 'boolean') || typeof x.overCount !== 'boolean')).length,
            judgedUnknownWithFlag: d.filter((x) => x.judged === true && ((x.ageDays == null && x.overAge !== null) || (x.sizeGB == null && x.overSize !== null))).length };
        }
        const k = await call(p + (p.includes('?') ? '&' : '?') + 'vcenterId=' + SCOPE_VC, all);
        o.pick[p] = { status: k.status, vcs: Array.isArray(k.body?.data) ? [...new Set(k.body.data.map((x) => x.vcenterId))] : null };
      }
      // ② 범위 밖 id 와 없는 id 는 같은 응답(존재 은닉)
      const otherVc = (snap.vcenters || []).map((v) => v.id).find((id) => id !== SCOPE_VC);
      o.outOfScope = await call('/objects/hosts?vcenterId=' + encodeURIComponent(otherVc), scoped);
      o.nonexist = await call('/objects/hosts?vcenterId=no-such-vcenter', scoped);
      o.nonexistFull = await call('/objects/hosts?vcenterId=no-such-vcenter', all);
      // ③ 쪽 나눔 — 2,000 행씩 이어 받기
      const ids = []; let off = 0; let guard = 0; let snapAt = null; let total = null;
      while (guard++ < 20) {
        const r = await call('/objects/vms?limit=2000&offset=' + off, all);
        for (const v of r.body.data) ids.push(v.id);
        snapAt = r.body.meta.snapshotAt; total = r.body.meta.total;
        if (!r.body.meta.truncated) { o.lastMeta = r.body.meta; break; }
        off = r.body.meta.nextOffset;
      }
      o.paging = { ids: ids.length, uniq: new Set(ids).size, total, snapAt, sorted: ids.every((x, i) => i === 0 || String(ids[i - 1]) < String(x)) };
      o.bad = {};
      for (const q of ['limit=0', 'limit=5001', 'limit=abc', 'offset=-1', 'offset=1.5']) { const r = await call('/objects/vms?' + q, all); o.bad[q] = { status: r.status, code: r.body?.code, field: r.body?.field }; }
      // ④ 판정 코어 하나 — 내부 함수와 대조
      const { vcenterLicenseRows } = await import(${JSON.stringify(path.join(SRC, 'corelicense/analyze.js'))});
      const { snapshotToolView } = await import(${JSON.stringify(path.join(SRC, 'snaphist/view.js'))});
      const { loadVmHygieneSettings } = await import(${JSON.stringify(path.join(SRC, 'vmhygiene/settings.js'))});
      const { buildGpuInventory } = await import(${JSON.stringify(path.join(SRC, 'routes/api/hardwareGpu.js'))});
      const { backupSummaryRowsFor } = await import(${JSON.stringify(path.join(SRC, 'routes/api/veeam.js'))});
      const lic = vcenterLicenseRows(snap.vcenters);
      o.internal = {
        licenses: lic.items.length, licenseKeys: lic.items.map((l) => l.key).filter((k) => k && k.length >= 8),
        licenseStatus: lic.items.map((l) => l.status + '|' + l.daysLeft),
        snapshots: snapshotToolView(snap, { hygiene: loadVmHygieneSettings(), now: Date.now() }).items.length,
        gpu: buildGpuInventory(snap, undefined, null).items.length,
        backup: (await backupSummaryRowsFor({ username: 'test', role: 'viewer' }, snap)).rows.map((r) => r.id + ':' + r.pa.n),
        vcenters: (snap.vcenters || []).length,
        disconnected: (snap.hosts || []).filter((h) => h.connectionState === 'DISCONNECTED').map((h) => h.id),
      };
      o.licenseText = (await call('/compliance/licenses', all)).text;
      return o;
    `);
    return cache;
  };
})();

test('① 새 분류 넷은 거부 기본값 — 기존 분류만 켠 키는 새 경로 전부 403 group-denied', () => {
  const r = LIVE();
  for (const p of NEW_PATHS) {
    assert.equal(r.oldKey[p].status, 403, `${p}: 기존 분류 키가 ${r.oldKey[p].status} 를 받았습니다`);
    assert.equal(r.oldKey[p].code, 'group-denied', `${p}: ${r.oldKey[p].code}`);
  }
});

test('② 범위 — 범위 키는 그 vCenter 행만 · 전력은 403 needs-full-scope · 범위 밖과 없는 id 는 같은 404', () => {
  const r = LIVE();
  for (const p of NEW_PATHS) {
    if (p === '/resources/power') {
      assert.equal(r.scoped[p].status, 403); assert.equal(r.scoped[p].code, 'needs-full-scope');
      continue;
    }
    assert.equal(r.scoped[p].status, 200, `${p}: 범위 키 ${r.scoped[p].status} ${r.scoped[p].code}`);
    assert.ok(r.scoped[p].rows > 0, `${p}: 범위 키가 0행 — 범위 절단을 볼 수 없습니다(목 데이터 확인)`);
    assert.deepEqual(r.scoped[p].vcs, ['vc-ap-northeast'], `${p}: 범위 밖 vCenter 행이 섞였습니다 ${r.scoped[p].vcs}`);
    assert.equal(r.scoped[p].scopedTo, 1, `${p}: meta.scopedToVcenters`);
    assert.ok(r.full[p].rows > r.scoped[p].rows, `${p}: 전체 키(${r.full[p].rows})가 범위 키(${r.scoped[p].rows})보다 많아야 합니다`);
    // ?vcenterId — 전체 키도 그 vCenter 하나로 좁혀진다
    assert.equal(r.pick[p].status, 200, `${p}: ?vcenterId ${r.pick[p].status}`);
    assert.deepEqual(r.pick[p].vcs, ['vc-ap-northeast'], `${p}: ?vcenterId 가 좁히지 않았습니다`);
  }
  assert.equal(r.outOfScope.status, 404); assert.equal(r.outOfScope.body.code, 'unknown-vcenter');
  assert.equal(r.nonexist.status, 404);
  // 존재 은닉 — 범위 밖 실재 vCenter 와 없는 id 의 응답이 글자까지 같다
  assert.deepEqual(r.outOfScope.body, r.nonexist.body, '범위 밖 vCenter 와 없는 id 의 응답이 다릅니다(존재 단서)');
  assert.equal(r.nonexistFull.status, 404, '전체 키도 없는 id 는 404(빈 목록으로 \'0 대\' 라고 하지 않는다)');
});

test('③ 쪽 나눔 — 이어 붙이면 전체와 같고(겹침 · 빠짐 0 · id 순) 형식 오류는 400', () => {
  const r = LIVE();
  assert.ok(r.paging.total > 2000, `목 VM 수가 쪽 하나보다 적습니다(${r.paging.total}) — 쪽 경계를 보지 못합니다`);
  assert.equal(r.paging.ids, r.paging.total, '이어 받은 행 수가 total 과 다릅니다');
  assert.equal(r.paging.uniq, r.paging.total, '쪽 사이에 겹친 행이 있습니다');
  assert.ok(r.paging.sorted, 'id 순서가 아닙니다');
  assert.equal(typeof r.paging.snapAt, 'number', 'meta.snapshotAt 이 숫자가 아닙니다');
  assert.equal(r.lastMeta.nextOffset, null); assert.equal(r.lastMeta.omitted, 0); assert.equal(r.lastMeta.truncated, false);
  for (const [q, v] of Object.entries(r.bad)) {
    assert.equal(v.status, 400, `${q}: ${v.status}`);
    assert.equal(v.code, 'bad-query');
    assert.ok(['limit', 'offset'].includes(v.field), `${q}: field ${v.field}`);
  }
});

test('④ 판정 코어 하나 — 라이선스 · 스냅샷 · GPU · 백업 행이 내부 함수와 같고, 라이선스 키 값은 응답에 없다', () => {
  const r = LIVE();
  assert.equal(r.full['/compliance/licenses'].rows, r.internal.licenses);
  assert.deepEqual(r.full['/compliance/licenses'].data.map((l) => `${l.status}|${l.daysLeft}`), r.internal.licenseStatus, '상태 · 남은 일수가 내부 판정과 다릅니다');
  assert.ok(r.internal.licenseKeys.length > 0, '목 라이선스에 키 값이 없어 유출 검사를 할 수 없습니다');
  for (const k of r.internal.licenseKeys) assert.ok(!r.licenseText.includes(k), '라이선스 키 값이 공개 API 응답에 실렸습니다');
  assert.equal(r.full['/compliance/snapshots'].rows, r.internal.snapshots);
  assert.equal(r.full['/resources/gpu'].rows, r.internal.gpu);
  assert.deepEqual(r.full['/backup/summary'].data.map((b) => `${b.vcenterId}:${b.vms}`), r.internal.backup, '법인별 VM 수가 Summary 집계와 다릅니다');
  assert.equal(r.full['/backup/summary'].rows, r.internal.vcenters, '법인 줄 수가 vCenter 수와 다릅니다');
});

test('⑤ 판정하지 않은 스냅샷 행의 기준 초과 여부는 false 가 아니라 null — 판정한 행은 불리언', () => {
  const r = LIVE();
  assert.ok(r.snapJudge.unjudged > 0 && r.snapJudge.judged > 0, `목 데이터에 판정/미판정 행이 다 있어야 합니다 ${JSON.stringify(r.snapJudge)}`);
  assert.equal(r.snapJudge.unjudgedWithFlag, 0, 'judged:false 인 행에 overAge · overCount · overSize 값이 있습니다(템플릿 · 예외 · 보류를 \'초과 아님\' 으로 말한다)');
  assert.equal(r.snapJudge.judgedNonBool, 0, 'judged:true 이고 값을 읽은 행의 초과 여부가 불리언이 아닙니다');
  assert.equal(r.snapJudge.judgedUnknownWithFlag, 0, '나이 · 크기를 못 읽은 행에 초과 여부 값이 있습니다');
});

test('⑤ 못 읽은 값은 null — 끊긴 호스트의 사용률', () => {
  const r = LIVE();
  assert.ok(r.internal.disconnected.length > 0, '목 데이터에 끊긴 호스트가 없습니다');
  const byId = new Map(r.full['/objects/hosts'].data.map((h) => [h.id, h]));
  for (const id of r.internal.disconnected) {
    const h = byId.get(id);
    assert.ok(h, `${id}: 행 없음`);
    assert.equal(h.cpuUsagePct, null, `${id}: 끊긴 호스트 CPU 사용률이 ${h.cpuUsagePct}`);
    assert.equal(h.memUsagePct, null);
    assert.equal(h.usageUnknown, true);
  }
});

test('⑤ 전력 — 읽은 장비가 없는 원천의 watts · 아무것도 못 읽은 합은 null(웹 powerCatKw · powerTotalKw 와 같은 입력으로 대조)', async () => {
  const { powerRowOf } = await import('../src/routes/publicApiRows.js');
  const { powerCatKw, powerTotalKw } = await import(path.join(REPO, 'web/src/views/overviewCardsText.js'));
  const cat = (watts, measured, partial) => ({ watts, measured, partial, devices: 3, unread: 0 });
  const cases = [
    { totalWatts: 0, servers: cat(0, 0, 0), network: cat(0, 0, 0), storage: cat(0, 0, 0) },              // 아무것도 못 읽음
    { totalWatts: 0, servers: cat(0, 1, 0), network: cat(0, 0, 0), storage: cat(0, 0, 0) },              // 측정한 0 은 값
    { totalWatts: 950, servers: cat(500, 2, 0), network: cat(450, 0, 1), storage: cat(0, 0, 0) },        // 일부 PSU 만 읽은 장비도 읽은 것
    { totalWatts: 120, servers: cat(0, 0, 0), network: cat(0, 0, 0), storage: cat(120, null, 2) },       // measured 결측(null)
  ];
  for (const c of cases) {
    const row = powerRowOf(c);
    assert.equal(row.totalWatts == null, powerTotalKw(c) === '—', `합: 서버 ${row.totalWatts} · 웹 ${powerTotalKw(c)}`);
    for (const k of ['servers', 'network', 'storage']) {
      assert.equal(row[k].watts == null, powerCatKw(c[k]) === '—', `${k}: 서버 ${row[k].watts} · 웹 ${powerCatKw(c[k])}`);
    }
  }
  assert.equal(powerRowOf(cases[0]).totalWatts, null);
  assert.equal(powerRowOf(cases[1]).totalWatts, 0, '측정한 0 W 는 null 로 지우지 않는다');
});

test('⑥ 중첩 객체도 선언한 키만 — policy · rpo · results24h · success7d · servers · network · storage', () => {
  const r = LIVE();
  const b = r.full['/backup/summary'].data[0];
  assert.deepEqual(Object.keys(b.rpo).sort(), ['d1', 'd3', 'd7']);
  for (const k of ['d1', 'd3', 'd7']) assert.deepEqual(Object.keys(b.rpo[k]).sort(), ['miss', 'ok', 'unknown']);
  assert.deepEqual(Object.keys(b.results24h).sort(), ['fail', 'ok', 'warn']);
  assert.deepEqual(Object.keys(b.success7d).sort(), ['bareos', 'veeam']);
  if (b.policy) assert.deepEqual(Object.keys(b.policy).sort(), ['bareos', 'check', 'none', 'ssh', 'veeam']);
  const p = r.full['/resources/power'].data;
  assert.deepEqual(Object.keys(p.servers).sort(), ['devices', 'excludedVcenter', 'measured', 'ome', 'unread', 'watts']);
  // 네트워크에는 noTime 이 없다(power/total.js ② — CVP 는 시각 없음을 stale 로 센다 · 반증 B-6: 항상 null 이던 칸을 계약에서 뺐다)
  assert.deepEqual(Object.keys(p.network).sort(), ['devices', 'measured', 'outputOnly', 'partial', 'stale', 'unread', 'watts']);
  assert.deepEqual(Object.keys(p.storage).sort(), ['devices', 'measured', 'noTime', 'partial', 'stale', 'unread', 'unsupported', 'watts']);
  // 원천 오류 원문은 meta 에 없다(어느 원천인지 키 · 개수만)
  assert.ok(!('error' in (r.full['/resources/power'].meta || {})), '전력 meta 에 오류 원문 필드가 있습니다');
  const errs = r.full['/resources/power'].meta.errors || {};
  for (const v of Object.values(errs)) assert.equal(v, true, '전력 오류는 true(사실)만 — 원문 글자가 실렸습니다');
});

test('⑦ OpenAPI 쿼리 인자는 카탈로그 params 에서 만들고, 핸들러가 같은 이름을 읽는다', async () => {
  const { ENDPOINTS, GROUP_KEYS } = await import('../src/publicapi/allowlist.js');
  const { buildOpenApi } = await import('../src/publicapi/openapi.js');
  const doc = buildOpenApi({ groups: [...GROUP_KEYS] });
  const rows = stripComments(fs.readFileSync(path.join(SRC, 'routes/publicApiRows.js'), 'utf8'));
  for (const ep of ENDPOINTS.filter((e) => Array.isArray(e.params))) {
    const got = (doc.paths[ep.path].get.parameters || []).map((p) => p.name).sort();
    assert.deepEqual(got, ep.params.map((p) => p.name).sort(), `${ep.path}: OpenAPI 인자`);
    for (const p of ep.params) assert.ok(rows.includes(`q?.${p.name}`) || rows.includes(`'${p.name}'`), `${ep.path}: 핸들러가 ${p.name} 를 읽지 않습니다`);
  }
  // 새 경로는 전부 GET 이고 publicApi.js 에 상태변경 선언이 없다(2562 ①과 같은 규약 — 새 파일에도)
  const src = stripComments(fs.readFileSync(path.join(SRC, 'routes/publicApi.js'), 'utf8'));
  assert.equal((src.match(/\bv1\.(post|put|patch|delete)\(/g) || []).length, 0);
  assert.ok(!/\.(post|put|patch|delete)\(/.test(rows.replace(/\b(?:Math|Number|String|JSON|Object|Array)\.\w+\(/g, '')), 'publicApiRows.js 에 라우트 등록이 있습니다');
  for (const p of NEW_PATHS) {
    const ep = ENDPOINTS.find((e) => e.path === p);
    assert.ok(ep && ep.method === 'GET' && typeof ep.list === 'boolean', `${p}: 카탈로그 선언`);
  }
});

test('⑦ 문서 — 공개 경로 · 분류 개수가 카탈로그와 같고, 손으로 적은 낡은 전체 개수(820 · 686)가 없다', async () => {
  const { ENDPOINTS, GROUPS } = await import('../src/publicapi/allowlist.js');
  const doc = fs.readFileSync(path.join(REPO, 'docs/API-PUBLIC.md'), 'utf8');
  const n = ENDPOINTS.length;
  assert.ok(doc.includes(`외부에 공개된 ${n}개`), `머리말의 공개 경로 수가 ${n} 이 아닙니다`);
  assert.ok(new RegExp(`^## 7\\. 엔드포인트 ${n}개`, 'm').test(doc), `§7 제목의 경로 수가 ${n} 이 아닙니다`);
  assert.ok(new RegExp(`^## 6\\. 허용 분류 ${GROUPS.length}종`, 'm').test(doc), `§6 제목의 분류 수가 ${GROUPS.length} 가 아닙니다`);
  for (const ep of ENDPOINTS) assert.ok(doc.includes(`\`GET ${ep.path}\``), `문서에 ${ep.path} 절이 없습니다`);
  for (const g of GROUPS) assert.ok(doc.includes(`| \`${g.key}\` |`), `§6 표에 분류 ${g.key} 가 없습니다`);
  // 전체 라우트 수는 생성 문서(API.md)만 적는다 — 손으로 적은 숫자는 릴리스마다 낡는다(820 · 686 이 그렇게 남아 있었다)
  assert.ok(!/820개|686개/.test(doc), 'API-PUBLIC.md 에 낡은 전체 라우트 수가 남아 있습니다');
  const allow = fs.readFileSync(path.join(SRC, 'publicapi/allowlist.js'), 'utf8');
  assert.ok(!/686개/.test(allow), 'allowlist.js 머리말에 낡은 전체 라우트 수가 남아 있습니다');
});

/* ── 반증 B(v3.42.0 검토) 확정분 회귀 — 값을 모를 때 0 · false 가 나가지 않는다 ───────────────────── */

test('반증 B-1 — 첫 병합 전 골격 스냅샷이면 503 not-collected(수집 상태 경로만 답한다)', () => {
  const r = runLive(`
    // 실제 경로로 골격을 게시한다(store.publishSkeleton — 첫 병합 전 · initial:true). refresh 를 부르지 않는다.
    store.publishSkeleton([{ id: 'vc-a', name: 'A' }, { id: 'vc-b', name: 'B' }], 'mock');
    const all = keys.issueApiKey({ name: 'all', groups: [...GROUP_KEYS] }).plaintext;
    const out = {};
    for (const p of ['/inventory/summary', '/inventory/vcenters', '/inventory/collection', '/capacity/datastores', '/faults/alarms', '/objects/hosts', '/objects/vms', '/backup/summary', '/compliance/licenses']) {
      const x = await call(p, all); out[p] = { status: x.status, code: x.body?.code, pending: x.body?.data?.pending, done: x.body?.data?.firstCollectionDone };
    }
    // 재확인 R-1: vCenter 와 무관한 경로(범위 미적용 — 스토리지 · SAN · 부품 · 전력)는 첫 병합 전에도 503 not-collected 가 아니다
    const nonVc = {};
    for (const p of ['/capacity/storage', '/san-storage/arrays', '/faults/parts', '/resources/power']) { const x = await call(p, all); nonVc[p] = { status: x.status, code: x.body?.code }; }
    return { initial: store.get()?.initial === true, out, nonVc };
  `, { refresh: false });
  assert.equal(r.initial, true, '하니스가 골격 상태를 만들지 못했습니다');
  for (const [p, v] of Object.entries(r.out)) {
    if (p === '/inventory/collection') {
      assert.equal(v.status, 200); assert.equal(v.pending, 2, '수집 상태 경로는 pending 수를 답해야 합니다');
      assert.equal(v.done, false, 'firstCollectionDone 이 첫 병합 전인데 true 입니다');
      continue;
    }
    assert.equal(v.status, 503, `${p}: 골격인데 ${v.status}(0 · 빈 배열을 '없다' 로 줌)`);
    assert.equal(v.code, 'not-collected');
  }
  for (const [p, v] of Object.entries(r.nonVc)) assert.notEqual(v.code, 'not-collected', `${p}: vCenter 와 무관한 경로가 첫 수집 중 503 not-collected 입니다(재확인 R-1)`);
});

test('반증 재확인 R-2 · R-3 — 골격 게시 전(빈 스냅샷)도 수집 전 · 첫 병합 뒤 firstCollectionDone · 받지 않는 인자의 중복은 무시', () => {
  const pre = runLive(`
    // 골격도 병합도 없다(생성자의 빈 스냅샷 — 기동 직후 · 등록부 읽기 오류로 골격을 못 띄운 동안)
    const all = keys.issueApiKey({ name: 'all', groups: [...GROUP_KEYS] }).plaintext;
    return { hosts: (await call('/objects/hosts', all)).status, coll: (await call('/inventory/collection', all)).body?.data?.firstCollectionDone };
  `, { refresh: false });
  assert.equal(pre.hosts, 503, '골격 게시 전 빈 스냅샷인데 200(빈 목록)입니다');
  assert.equal(pre.coll, false);
  const post = runLive(`
    const all = keys.issueApiKey({ name: 'all', groups: [...GROUP_KEYS] }).plaintext;
    return { coll: (await call('/inventory/collection', all)).body?.data?.firstCollectionDone,
      hostsDupLimit: (await call('/objects/hosts?limit=5&limit=6', all)).status,
      vmsDupLimit: (await call('/objects/vms?limit=5&limit=6', all)).status };
  `);
  assert.equal(post.coll, true);
  assert.equal(post.hostsDupLimit, 200, '호스트 목록은 limit 을 받지 않는다 — 중복이어도 무시(400 이 아니다)');
  assert.equal(post.vmsDupLimit, 400, 'VM 목록은 limit 을 받는다 — 중복은 400');
});

test('반증 B-1 · B-3 — 백업 행: VM 목록을 모르면 수가 전부 null(inventoryUnknown) · 등록부를 못 읽으면 Veeam 서버 수는 null', async () => {
  const { backupRowOf } = await import('../src/routes/publicApiRows.js');
  const pa = { n: 0, on: 0, pol: { veeam: 0, bareos: 0, ssh: 0, none: 0, check: 0 }, polUnk: 0, unprot: 0, unver: 0, rpo: { d1: { ok: 0, miss: 0, unk: 0 } }, r24: { ok: 0, warn: 0, fail: 0 }, v7: { ok: 0, bad: 0 }, b7: { ok: 0, bad: 0 }, run: 0, lok: null, nx: null };
  const unk = backupRowOf({ id: 'vc-a', name: 'A', vm: null, veeamState: 'no-inventory', pa, veeamServers: 1 });
  assert.equal(unk.inventoryUnknown, true);
  for (const k of ['vms', 'poweredOn', 'backedUp', 'policy', 'policyUnknown', 'unprotected', 'unverified', 'running']) assert.equal(unk[k], null, `${k}: 모르는 VM 목록인데 ${unk[k]}`);
  assert.deepEqual(unk.rpo.d1, { ok: null, miss: null, unknown: null });
  assert.deepEqual(unk.results24h, { ok: null, warn: null, fail: null });
  assert.equal(unk.veeamState, 'no-inventory');
  const known = backupRowOf({ id: 'vc-b', name: 'B', vm: 0, pa, veeamServers: 0, veeamFailed: 0 });
  assert.equal(known.inventoryUnknown, false); assert.equal(known.vms, 0, '읽은 0 대는 값이다');
  const reg = backupRowOf({ id: 'vc-c', name: 'C', vm: 3, pa: { ...pa, n: 3 }, veeamServers: 0, veeamFailed: 0, veeamStale: 0 }, { registryUnreadable: true });
  assert.equal(reg.veeamServers, null); assert.equal(reg.veeamFailed, null); assert.equal(reg.veeamStale, null);
});

test('반증 B-2 · B-4 · B-5 · B-13 — 판정했어도 못 읽은 값 · 구성을 못 읽은 클러스터 · 한쪽만 못 읽은 사용률 · 모르는 template', async () => {
  const rows = await import('../src/routes/publicApiRows.js');
  const now = Date.now();
  const snap = {
    vcenters: [{ id: 'vc1', name: 'vc1', status: 'connected' }],
    hosts: [{ id: 'vc1:h1', vcenterId: 'vc1', name: 'h1', cluster: 'C1', connectionState: 'CONNECTED', cpuUsagePct: 30, memUsagePct: null }],
    vms: [{ id: 'vc1:v1', vcenterId: 'vc1', name: 'v1', host: 'h1', cluster: 'C1', powerState: 'POWERED_ON', snapshotCount: 2, snapshotOldestTs: null, snapshotSizeGB: null },
      { id: 'vc1:v2', vcenterId: 'vc1', name: 'v2', powerState: 'POWERED_ON' }],
    datastores: [], networks: [], alarms: [],
  };
  const hygiene = { snapAgeDays: 7, snapCount: 3, snapSizeGB: 100, exceptions: [] };
  const s = rows.snapshotRows(snap, { allowed: null, vcId: null, now, hygiene, dcOf: () => '', dcNames: new Map() });
  const v1 = s.rows.find((x) => x.vmId === 'vc1:v1');
  assert.ok(v1, '스냅샷 행이 없습니다');
  assert.equal(v1.judged, true, '판정 대상 VM 입니다(템플릿 · 예외 아님)');
  assert.equal(v1.ageDays, null); assert.equal(v1.overAge, null, `생성일을 모르는데 overAge=${v1.overAge}`);
  assert.equal(v1.sizeGB, null); assert.equal(v1.overSize, null, `크기를 모르는데 overSize=${v1.overSize}`);
  assert.equal(typeof v1.overCount, 'boolean', '개수는 읽었으니 불리언');
  const h = rows.hostRows(snap, () => true)[0];
  assert.equal(h.usageUnknown, true, '메모리 사용률을 못 읽었는데 usageUnknown=false');
  const c = rows.clusterRows(snap, { username: 't', role: 'viewer' }, null).rows[0];
  assert.equal(c.collected, false); assert.equal(c.findings, null, `구성을 못 읽은 클러스터의 발견 수=${c.findings}`);
  assert.equal(c.haEnabled, null);
  const vm2 = rows.vmRows(snap, () => true).find((x) => x.id === 'vc1:v2');
  assert.equal(vm2.template, null, 'template 을 모르는 VM 이 false 로 나갑니다');
  assert.equal(vm2.ipAddresses, null, 'IP 배열이 없으면(못 읽음) null');
});

test('반증 B-7 · B-9 · B-12 — 라이선스 자리표시는 null · vcenterId 400 에 field', async () => {
  const rows = await import('../src/routes/publicApiRows.js');
  const snap = { vcenters: [{ id: 'vc1', name: 'vc1', licenses: [{ name: '', edition: '', product: 'X', key: 'AAAAA-BBBBB', expires: null }] }] };
  const l = rows.licenseRows(snap, () => true).rows[0];
  assert.equal(l.name, null, `이름을 못 읽은 라이선스가 '${l.name}' 로 나갑니다`);
  const bad = rows.vcenterPickOf({ vcenterId: 'x'.repeat(201) }, () => true, null);
  assert.equal(bad.status, 400); assert.equal(bad.field, 'vcenterId');
  const src = stripComments(fs.readFileSync(path.join(SRC, 'routes/publicApi.js'), 'utf8'));
  const lic = src.slice(src.indexOf("v1.get('/compliance/licenses'"), src.indexOf("v1.get('/compliance/snapshots'"));
  assert.ok(/notCurrentMetaOf\(/.test(lic), '/compliance/licenses 에 멈춘 vCenter 표지가 없습니다');
});

test('반증 B-8 — OpenAPI 공통 응답에 400 bad-query · 404 unknown-vcenter · limit 최대값', async () => {
  const { GROUP_KEYS } = await import('../src/publicapi/allowlist.js');
  const { buildOpenApi } = await import('../src/publicapi/openapi.js');
  const doc = buildOpenApi({ groups: [...GROUP_KEYS] });
  const op = doc.paths['/objects/vms'].get;
  assert.ok(op.responses[400] && /bad-query/.test(op.responses[400].description));
  assert.ok(/unknown-vcenter/.test(op.responses[404].description));
  assert.equal(op.parameters.find((p) => p.name === 'limit').schema.maximum, 5000);
});

/* ── 반증 A(v3.42.0 검토) 확정분 회귀 ─────────────────────────────────────────── */

test('반증 A C-2 — 원문 쿼리 모양: 같은 이름 여러 번 · 객체 모양은 400(운영 정규화가 마지막 값 · 버림으로 바꾸기 전에 판정)', async () => {
  const { rawQueryShapeIssue } = await import('../src/routes/publicApiRows.js');
  const N = ['vcenterId', 'offset', 'limit'];
  assert.equal(rawQueryShapeIssue('/objects/vms?vcenterId=a&vcenterId=b', N), 'vcenterId');
  assert.equal(rawQueryShapeIssue('/objects/vms?limit[x]=1', N), 'limit');
  assert.equal(rawQueryShapeIssue('/objects/vms?vcenterId%5Bx%5D=a', N), 'vcenterId', '퍼센트 인코딩한 대괄호도 객체 모양이다');
  assert.equal(rawQueryShapeIssue('/objects/vms?offset=1&limit=2&vcenterId=a', N), null);
  assert.equal(rawQueryShapeIssue('/objects/vms', N), null);
  assert.equal(rawQueryShapeIssue('/objects/vms?other=1&other=2', N), null, '이 경로가 읽지 않는 인자는 보지 않는다');
  // 정규화기를 붙인 운영 구성에서도 400 인가 — index.js 의 queryNormalizer 를 그대로 앞에 둔다
  const src = stripComments(fs.readFileSync(path.join(SRC, 'routes/publicApi.js'), 'utf8'));
  assert.ok(/rawQueryShapeIssue\(req\.originalUrl/.test(src), 'pickedVcenter 가 원문 쿼리로 판정하지 않습니다');
});

test('반증 A C-2 — 운영 구성(쿼리 정규화기 앞단)에서도 중복 · 객체 모양 인자는 400', () => {
  const idx = fs.readFileSync(path.join(SRC, 'index.js'), 'utf8');
  const m = idx.match(/import\s*\{\s*([^}]*queryNormalizer[^}]*)\}\s*from\s*'([^']+)'/);
  assert.ok(m, 'index.js 에서 queryNormalizer 가져오기를 찾지 못했습니다');
  const r = runLive(`
    const qn = await import(${JSON.stringify(path.join(SRC, '/'))} + ${JSON.stringify(m[2].replace(/^\.\//, ''))});
    const mw = qn.queryNormalizer ? qn.queryNormalizer() : null;
    const app2 = express();
    if (mw) app2.use(mw);
    app2.use('/api/v1', v1);
    const srv2 = await new Promise((r) => { const s = app2.listen(0, () => r(s)); });
    const b2 = 'http://127.0.0.1:' + srv2.address().port + '/api/v1';
    const all = keys.issueApiKey({ name: 'all', groups: [...GROUP_KEYS] }).plaintext;
    const go = async (q) => { const res = await fetch(b2 + q, { headers: { 'X-Api-Key': all } }); const b = await res.json(); return { status: res.status, code: b.code, field: b.field }; };
    const out = { mw: !!mw,
      dup: await go('/objects/hosts?vcenterId=vc-ap-northeast&vcenterId=vc-us-east'),
      obj: await go('/objects/hosts?vcenterId[x]=vc-ap-northeast'),
      lim: await go('/objects/vms?limit[x]=1'),
      ok: await go('/objects/vms?limit=2') };
    srv2.close();
    return out;
  `);
  assert.ok(r.mw, 'queryNormalizer 를 만들지 못했습니다 — 하니스 확인');
  for (const k of ['dup', 'obj', 'lim']) { assert.equal(r[k].status, 400, `${k}: ${r[k].status}`); assert.equal(r[k].code, 'bad-query'); }
  assert.equal(r.ok.status, 200);
});

test('반증 A 재확인 — 메모의 \'고르지 않음\' 표식이 id 와 겹치지 않는다 · 8,192자 뒤 · 파싱에서 빠진 인자도 400 · 기본 쪽 1,000행', async () => {
  const rows = await import('../src/routes/publicApiRows.js');
  const N = ['vcenterId', 'offset', 'limit'];
  assert.equal(rows.rawQueryShapeIssue(`/objects/vms?p=${'x'.repeat(8300)}&vcenterId[x]=a`, N), 'vcenterId', '8,192자 뒤의 객체 모양 인자');
  assert.equal(rows.rawQueryShapeIssue('/objects/vms?vcenterId=a', N, {}), 'vcenterId', '원문에는 있는데 파싱 결과에 없는 인자');
  assert.equal(rows.rawQueryShapeIssue('/objects/vms?vcenterId=a', N, { vcenterId: 'a' }), null);
  assert.equal(rows.rawQueryShapeIssue('/objects/hosts?limit=1&limit=2', []), null, '받지 않는 인자는 보지 않는다');
  assert.equal(rows.pageQueryOf({}, 5000).limit, 1000, '기본 쪽 크기');
  assert.equal(rows.pageQueryOf({ limit: '5000' }, 5000).limit, 5000);
  const src = stripComments(fs.readFileSync(path.join(SRC, 'routes/publicApiRows.js'), 'utf8'));
  assert.ok(!/vcId \|\| '\*'/.test(src), "메모 열쇠에 '*' 표식이 남아 있습니다(id '*' 와 충돌)");
  // 실제 메모: id '*' 인 vCenter 와 '고르지 않음' 이 다른 칸
  const snap = { generatedAt: 't1', vcenters: [{ id: '*', status: 'connected' }, { id: 'vc2', status: 'connected' }],
    vms: [{ id: '*:a', vcenterId: '*', name: 'a' }, { id: 'vc2:b', vcenterId: 'vc2', name: 'b' }] };
  const user = { username: 't', role: 'viewer' };
  const all = await rows.vmRowsMemo(snap, user, () => true, null);
  const star = await rows.vmRowsMemo(snap, user, (id) => id === '*', '*');
  assert.equal(all.length, 2); assert.equal(star.length, 1, `id '*' 를 고른 결과가 '고르지 않음' 칸을 받았습니다(${star.length}행)`);
});

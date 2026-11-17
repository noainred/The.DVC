/**
 * rebut71.test.js — 전체 점검 71회차: 67 · 68 · 69 · 70회차 수정 반증(적대적 재검토)에서 확정한 덜 고침 · 회귀와 개선.
 *
 * R1(67 개선의 덜 고침) LLM 설정 enabled 를 저장에서만 불리언으로 좁혀, 이미 저장된 "false" 같은 글자 값은 로드에서 그대로 —
 *    자연어 검색 · ChatOps · 상태 점검(참/거짓)은 켜짐, 설정 현황 · 링크 점검(=== true)은 꺼짐으로 계속 갈렸고, 화면이 불러온 값을 그대로
 *    다시 보내 어떤 저장도 400 이 됐다 → loadLlmConfig 가 normLlmEnabled 로 불리언을 만든다.
 * R2(69 F4 반증) 설정 파일을 읽지 못한 동안(unreadable) 소비처가 기본값으로 판정한 사실을 말하지 않았다 — 태그 VM 상세는 missing:[](빠진 필수 태그 없음)을
 *    단정했고 목록 · CSV 는 '정책 미설정' 과 구분이 없었다. 비용 · VM 구성 점검 본 응답에도 표지가 없었다.
 * R3(69 남긴 것 ②) 호스트 재부팅 분류(hostChecks · hostHygiene · hostExport)의 이벤트 수집 범위 lastTs 가 경계 없는 MAX 라 미래 행 1건에 끌려
 *    '이벤트 없음(수집 범위 밖)' 재부팅을 '원인 모름(이벤트를 받았는데 정비 기록 없음)' 으로 분류했다 → eventLastTsOf 한 벌.
 * I1(68 P3 개선) dirusage 이력 정리 스로틀을 벽시계 모듈로에서 저장소 규약 (++tick % N) === 0 으로.
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
const read = (rel) => stripComments(fs.readFileSync(path.join(SRC, rel), 'utf8'));
// 기준 시각: 실제 시각을 정시 경계로 떨어뜨려 고정(Date.now() 직접 · 고정 epoch 둘 다 깨진다)
const NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;
const DAY = 86_400_000;

function child(script, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebut71-'));
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, LLM_ENABLED: '', ...env }, encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 120_000, maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(r.status, 0, `자식 프로세스 실패: ${r.stderr}`);
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, `결과 줄 없음: ${r.stdout.slice(-400)} ${r.stderr.slice(-400)}`);
  return JSON.parse(line.slice(2));
}

test('R1 — 이미 저장된 글자 enabled 도 로드에서 불리언 · 모든 소비처 판정 일치 · 화면 왕복 저장 200', () => {
  const out = child(`
    const fs = await import('node:fs'); const path = await import('node:path');
    const f = path.join(process.env.CONFIG_DIR, 'llm.json');
    const m = await import(${JSON.stringify(path.join(SRC, 'llm/config.js'))});
    const out = { cases: [] };
    for (const v of ['false', 'true', ' TRUE ', 'no', 1, 0, null, true, false]) {
      fs.writeFileSync(f, JSON.stringify({ enabled: v, url: 'http://10.1.2.3:11434', model: 'llama3.1' }));
      const c = m.loadLlmConfig();
      // 소비처: nlSearch · chatops · health(참/거짓) ↔ settingsStatus · linkcheck(=== true)
      out.cases.push({ v, enabled: c.enabled, truthy: !!c.enabled, strict: c.enabled === true });
    }
    fs.writeFileSync(f, JSON.stringify({ enabled: 'true', url: 'http://10.1.2.3:11434', model: 'llama3.1' }));
    try { const s = m.saveLlmConfig({ ...m.loadLlmConfig(), model: 'llama3.1:8b' }); out.roundTrip = { ok: true, enabled: s.enabled, model: s.model }; }
    catch (e) { out.roundTrip = { ok: false, status: e.status, msg: e.message }; }
    out.file = JSON.parse(fs.readFileSync(f, 'utf8')).enabled;
    console.log('@@' + JSON.stringify(out));
  `);
  const want = { false: false, true: true, ' TRUE ': true, no: false, 1: false, 0: false, null: false };
  for (const c of out.cases) {
    assert.equal(typeof c.enabled, 'boolean', `${JSON.stringify(c.v)}: 로드 값이 불리언이 아니다(수정 전 글자 그대로)`);
    assert.equal(c.truthy, c.strict, `${JSON.stringify(c.v)}: 수정 전 '"false"' 는 자연어 검색 켜짐 · 설정 현황 꺼짐으로 갈렸다`);
    if (typeof c.v !== 'boolean') assert.equal(c.enabled, want[String(c.v)], `${JSON.stringify(c.v)} 판정`);
    else assert.equal(c.enabled, c.v);
  }
  assert.deepEqual(out.roundTrip, { ok: true, enabled: true, model: 'llama3.1:8b' }, '수정 전: 화면이 불러온 "true" 를 그대로 보내 400');
  assert.equal(out.file, true, '저장하면 파일도 불리언으로 바뀐다');
});

test('R2 — 태그 정책 파일을 읽지 못하면 VM 상세는 빠진 필수 태그를 판정하지 않는다(missing null · policyUnreadable)', async () => {
  const { vmTagsOfBody } = await import('../src/routes/api/vmTags.js');
  const inv = { tags: [{ cat: 0, name: 'Prod' }], categories: [{ name: 'Env' }], vmTags: { 'vm-1': [0] }, fields: [], vmCustom: {} };
  const vm = { id: 'vc-a:vm-1', vcenterId: 'vc-a', template: false };
  const ok = vmTagsOfBody(vm, inv, { requiredCategories: ['Owner'] });
  assert.deepEqual(ok.missing, ['Owner'], '전제: 정책을 읽었으면 빠진 필수 태그를 낸다');
  const un = vmTagsOfBody(vm, inv, { requiredCategories: [], unreadable: true, rev: 'unreadable' });
  assert.equal(un.missing, null, "수정 전: missing:[] — '빠진 필수 태그 없음' 을 단정했다");
  assert.equal(un.policyUnreadable, true);
  assert.deepEqual(un.tags, [{ category: 'Env', tag: 'Prod' }], '태그 자체는 그대로 보인다');
  // 목록 · CSV 도 표지를 싣는다(소스 — 본 응답 · 파일)
  const src = read('routes/api/vmTags.js');
  assert.match(src, /policyUnreadable: pol\.unreadable === true/);
  assert.match(src, /if \(pol\.unreadable === true\) lines\.push/);
});

test('R2 — 비용 · VM 구성 점검 본 응답이 설정을 읽지 못한 사실(settingsUnreadable)을 싣는다(실제 라우트 · 읽기 오류 주입)', () => {
  const out = child(`
    const fs = (await import('node:fs')).default; const path = await import('node:path');
    const D = process.env.CONFIG_DIR;
    fs.writeFileSync(path.join(D, 'vm-hygiene.json'), JSON.stringify({ snapAgeDays: 3 }));
    fs.writeFileSync(path.join(D, 'cost-rates.json'), JSON.stringify({ currency: 'KRW', vcpu: 10000, ramGB: 5000, storageGB: 100 }));
    const express = (await import('express')).default;
    const { store } = await import(${JSON.stringify(path.join(SRC, 'store.js'))});
    const NOW = ${NOW};
    const snap = { generatedAt: new Date(NOW).toISOString(), initial: false,
      vcenters: [{ id: 'vc-a', name: 'A', status: 'connected' }], hosts: [], datastores: [], networks: [], alarms: [],
      vms: [{ id: 'vc-a:vm-1', vcenterId: 'vc-a', name: 'v1', powerState: 'POWERED_ON', numCpu: 2, memoryMB: 4096 }] };
    store.get = () => snap;
    const cost = await import(${JSON.stringify(path.join(SRC, 'cost/settings.js'))});
    const hy = await import(${JSON.stringify(path.join(SRC, 'vmhygiene/settings.js'))});
    const { api } = await import(${JSON.stringify(path.join(SRC, 'routes/api.js'))});
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.user = { username: 'adm', role: 'admin', scope: null }; next(); });
    app.use('/api', api);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = 'http://127.0.0.1:' + srv.address().port + '/api';
    const get = async (p) => { const r = await fetch(base + p); return { s: r.status, j: await r.json().catch(() => null) }; };
    const pick = (c, h) => ({ cs: c.s, hs: h.s, cost: c.j?.settingsUnreadable, rates: c.j?.ratesSet, hy: h.j?.settingsUnreadable, snapAge: h.j?.settings?.snapAgeDays });
    const out = {};
    out.before = pick(await get('/tools/cost-showback'), await get('/tools/vm-hygiene'));
    const orig = fs.readFileSync;
    fs.readFileSync = function (p, ...a) { if (/(vm-hygiene|cost-rates)\.json$/.test(String(p))) { const e = new Error('EIO: i/o error, read'); e.code = 'EIO'; throw e; } return orig.call(this, p, ...a); };
    cost._resetCostSettings(); hy._resetVmHygieneSettings();
    out.during = pick(await get('/tools/cost-showback'), await get('/tools/vm-hygiene'));
    fs.readFileSync = orig;
    srv.close();
    console.log('@@' + JSON.stringify(out));
  `, { DATA_SOURCE: 'mock' });
  assert.deepEqual(out.before, { cs: 200, hs: 200, cost: false, rates: 3, hy: false, snapAge: 3 }, JSON.stringify(out.before));
  assert.equal(out.during.cs, 200);
  assert.equal(out.during.hs, 200);
  assert.equal(out.during.rates, 0, '읽지 못한 동안 단가 없음(0원을 지어내지 않는다 — 69 F4 그대로)');
  assert.equal(out.during.cost, true, "수정 전: 표지 없음 — 화면이 '단가 미설정 · 입력하세요' 로 말했다");
  assert.equal(out.during.snapAge, 7, '전제: 읽지 못한 동안 판정은 기본 기준(7일)으로 한다');
  assert.equal(out.during.hy, true, "수정 전: 표지 없음 — 기본 기준(7일)의 '정상' 을 설정한 기준(3일)의 정상으로 보였다");
});

test('R3 — 호스트 재부팅 분류의 수집 범위는 미래 행 경계 안의 MAX(실 SQLite) · 세 라우트가 같은 함수', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebut71-logs-'));
  process.env.CONFIG_DIR = dir;
  const { getLogsDb } = await import('../src/logs/db.js');
  const { eventLastTsOf } = await import('../src/vmchanges/analyze.js');
  const { analyzeReboots } = await import('../src/hostcfg/reboots.js');
  const db = await getLogsDb();
  const last = NOW - 3 * DAY;   // 실제로 받은 마지막 이벤트 — 3일 전(그 뒤 수집이 멈췄다)
  db.insertMany([
    { vcenterId: 'vc-a', key: 'a1', ts: NOW - 20 * DAY, severity: 'info', type: 'VmMigratedEvent', user: '', entity: 'vm1', message: 'm' },
    { vcenterId: 'vc-a', key: 'a2', ts: last, severity: 'info', type: 'VmMigratedEvent', user: '', entity: 'vm1', message: 'm' },
    { vcenterId: 'vc-a', key: 'a3', ts: Date.UTC(2099, 0, 1), severity: 'info', type: 'VmMigratedEvent', user: '', entity: 'vm1', message: 'm' },
  ]);
  const hosts = [{ id: 'h1', name: 'esx1', vcenterId: 'vc-a', connectionState: 'CONNECTED', bootTime: NOW - DAY }];   // 수집이 멈춘 뒤에 재부팅
  const kindWith = (lastTs) => analyzeReboots(hosts, [], { now: NOW, days: 30, coverageOf: () => ({ firstTs: db.firstTs('vc-a') || null, lastTs, why: null }) }).rows[0].kind;
  assert.equal(kindWith(db.lastTs('vc-a') || null), 'unknown', "전제(수정 전 경로): 미래 행 MAX 로는 '이벤트를 받았는데 원인 모름' 으로 분류됐다");
  assert.equal(kindWith(eventLastTsOf(db, 'vc-a', NOW)), 'no-events', "그 시간대 이벤트를 받지 못했다 — '이벤트 없음'");
  for (const f of ['routes/api/hostChecks.js', 'routes/api/hostHygiene.js', 'routes/api/hostExport.js']) {
    const s = read(f);
    assert.doesNotMatch(s, /db\.lastTs\(/, `${f}: 경계 없는 db.lastTs 가 남았다`);
    assert.match(s, /lastTs: eventLastTsOf\(db, /, `${f}: eventLastTsOf 를 쓴다`);
  }
});

test('I1 — dirusage 이력 정리는 (++tick % N) === 0(기동 첫 틱 금지 · 실제로 돈 틱만 센다)', async () => {
  const S = await import('../src/dirusage/scheduler.js');
  S._resetDirUsage();
  const N = S.PRUNE_EVERY_TICKS;
  assert.ok(Number.isInteger(N) && N >= 1);
  assert.equal(N, Math.round((6 * 3_600_000) / S.schedulerStatus().tickMs), '6시간 분량의 틱');
  const fired = [];
  for (let i = 1; i <= 3 * N; i++) if (S.pruneDue()) fired.push(i);
  assert.deepEqual(fired, [N, 2 * N, 3 * N], '첫 틱에 돌지 않고 N 틱마다 한 번');
  S._resetDirUsage();
  const body = read('dirusage/scheduler.js');
  const tickOnce = body.slice(body.indexOf('async function tickOnce'), body.indexOf('async function tick()'));
  assert.match(tickOnce, /if \(pruneDue\(\)\)/);
  assert.doesNotMatch(tickOnce, /now %/, '벽시계 모듈로가 남았다');
});

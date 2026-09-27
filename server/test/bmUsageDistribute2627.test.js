/**
 * test/bmUsageDistribute2627.test.js — 베어메탈 사용률 설정 중앙 → 엣지 배포(v2.627, 사용자 요청 "한번에 켜는 기능").
 *
 * 한 프로세스가 중앙(실제 centralRouter 를 express 에 마운트)과 엣지(pullBmUsageConfigNow)를 겸한다 — 두 노드의 파일은
 * 이름이 달라(bmusage-settings.json = 원본 · bmusage-central.json = 엣지 사본) 같은 CONFIG_DIR 에서도 섞이지 않는다.
 * 고정하는 것:
 *  ① 배포 꺼짐 → distribute:false(off) · 엣지 사본 없음 · 엣지 로컬 설정 그대로
 *  ② 배포 켜짐 → 엣지 유효 설정이 중앙 값(켬·법인·주기 …)이 되고 **Enterprise 는 엣지 로컬 값**이 남는다
 *  ③ 같은 판을 다시 받으면 changed:false · 중앙이 '적용됨' 으로 본다(applied sig)
 *  ④ 배포 중 엣지 저장은 배포 키를 저장하지 않고 ignoredCentralManaged 로 밝힌다(Enterprise·로컬 키는 저장된다)
 *  ⑤ 중앙 오류(500) → 마지막 사본 유지 · ⑥ 그 엣지 제외(대소문자 무시) → 사본 삭제 → 로컬로 복귀
 *  ⑦ DISTRIBUTED_KEYS 에 enterprise 키 없음 · 데이터 흐름 분류 · 엣지 로그 표 등재 · 상태 파일 등록
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bmdist2627-'));
process.env.CONFIG_DIR = DIR;
process.env.SSRF_ALLOW_LOOPBACK = 'true';
process.env.CENTRAL_TOKEN = 'ctok-2627';
process.env.DATA_SOURCE = 'mock';
delete process.env.BMUSAGE_ENABLED;

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
let central; let centralPort; let config; let S; let pull; let fail500 = false;

before(async () => {
  const express = (await import('express')).default;
  const { centralRouter } = await import('../src/routes/central.js');
  const app = express();
  app.use((req, res, next) => { if (fail500) { res.status(500).json({ ok: false }); return; } next(); });
  app.use(express.json());
  app.use('/api/central', centralRouter);
  central = http.createServer(app);
  centralPort = await listen(central);
  ({ config } = await import('../src/config.js'));
  S = await import('../src/bmusage/settings.js');
  pull = await import('../src/agent/bmUsageConfigPull.js');
  config.agent.centralUrl = `http://127.0.0.1:${centralPort}`;
  config.agent.centralToken = 'ctok-2627';
  config.agent.name = 'Edge-2627';
});
after(() => { try { central?.close(); } catch { /* */ } fs.rmSync(DIR, { recursive: true, force: true }); });

/** 엣지 로컬 파일을 직접 쓴다(중앙 원본과 같은 파일이지만, 테스트는 사본 겹침만 본다 — 원본은 아래에서 따로 바꾼다). */
function writeLocal(obj) { fs.writeFileSync(path.join(DIR, 'bmusage-settings.json'), JSON.stringify(obj)); S._resetForTest(); }

test('① 배포 꺼짐 — distribute:false(off) · 사본 없음 · 로컬 설정 그대로', async () => {
  writeLocal({ enabled: false, intervalMs: 600_000, enterpriseEnabled: true, enterpriseAck: true });
  const r = await pull.pullBmUsageConfigNow();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.managed, false);
  assert.equal(r.reason, 'off');
  assert.equal(S.bmUsageCentralState().managed, false);
  assert.equal(fs.existsSync(path.join(DIR, 'bmusage-central.json')), false);
  assert.equal(S.loadBmUsageSettings().intervalMs, 600_000);
});

test('② 배포 켜짐 — 엣지 유효 설정 = 중앙 배포 키 + 엣지 로컬 Enterprise', async () => {
  // 중앙 원본(같은 파일): 켬 · 법인 2곳 · 5분 · ESXi 포함 · Enterprise 는 꺼짐(배포되지 않아야 한다)
  writeLocal({ enabled: true, corps: { 'vc-a': true, 'vc-b': true }, intervalMs: 300_000, includeVirtualization: true, enterpriseEnabled: false, enterpriseAck: false });
  S.saveDistribution({ enabled: true }, 'tester');
  const r = await pull.pullBmUsageConfigNow();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.managed, true);
  assert.equal(r.changed, true);
  const copy = JSON.parse(fs.readFileSync(path.join(DIR, 'bmusage-central.json'), 'utf8'));
  for (const k of Object.keys(copy.settings)) assert.ok(!/^enterprise/.test(k), `Enterprise 키가 배포됐다: ${k}`);
  // 엣지 로컬을 '다른 값' 으로 바꾼 상황을 만든다 — 사본이 이겨야 하고 Enterprise 는 로컬이 이겨야 한다.
  fs.writeFileSync(path.join(DIR, 'bmusage-settings.json'), JSON.stringify({ enabled: false, intervalMs: 900_000, enterpriseEnabled: true, enterpriseAck: true, enterpriseMode: 'api' }));
  S._resetForTest();
  const eff = S.loadBmUsageSettings();
  assert.equal(eff.enabled, true, '중앙이 켠 값이 이겨야 한다');
  assert.deepEqual(Object.keys(eff.corps).sort(), ['vc-a', 'vc-b']);
  assert.equal(eff.intervalMs, 300_000);
  assert.equal(eff.includeVirtualization, true);
  assert.equal(eff.enterpriseEnabled, true, 'Enterprise 동의는 엣지 로컬 값이어야 한다(v2.554)');
  assert.equal(eff.enterpriseMode, 'api');
  assert.equal(S.bmUsageCentralState().managed, true);
});

test('③ 같은 판 재인출 — changed:false · 중앙이 적용됨으로 본다', async () => {
  // 중앙 원본을 ②의 값으로 되돌려 sig 가 사본과 같게 만든다.
  fs.writeFileSync(path.join(DIR, 'bmusage-settings.json'), JSON.stringify({ enabled: true, corps: { 'vc-a': true, 'vc-b': true }, intervalMs: 300_000, includeVirtualization: true, enterpriseEnabled: true, enterpriseAck: true, enterpriseMode: 'api' }));
  S._resetForTest();
  // _resetForTest 가 사본 캐시·인출 기록도 비우므로 한 번 받아 기록을 만든다.
  await pull.pullBmUsageConfigNow();
  const r = await pull.pullBmUsageConfigNow();
  assert.equal(r.ok, true);
  assert.equal(r.changed, false, 'Enterprise 만 다른 로컬 값은 배포 판을 바꾸지 않는다');
  const st = S.distributionStatus(['edge-2627', 'other-edge']);
  const me = st.rows.find((x) => x.agent.toLowerCase() === 'edge-2627');
  assert.equal(me.state, 'applied', JSON.stringify(st.rows));
  assert.equal(st.rows.find((x) => x.agent === 'other-edge').state, 'no-pull');
  assert.equal(st.rows.filter((x) => x.agent.toLowerCase() === 'edge-2627').length, 1, '대소문자만 다른 이름을 두 행으로 만들지 않는다');
});

test('④ 배포 중 엣지 저장 — 배포 키는 무시하고 밝힌다 · Enterprise 는 저장된다', () => {
  const out = S.saveBmUsageSettings({ enabled: false, intervalMs: 3_600_000, enterpriseMode: 'ssh' });
  assert.deepEqual([...out.ignoredCentralManaged].sort(), ['enabled', 'intervalMs']);
  assert.equal(out.enabled, true);
  assert.equal(out.enterpriseMode, 'ssh');
  const local = JSON.parse(fs.readFileSync(path.join(DIR, 'bmusage-settings.json'), 'utf8'));
  assert.equal(local.enterpriseMode, 'ssh');
  assert.equal(local.enabled, true, '무시한 키를 로컬 파일에 쓰지 않는다(원래 값 유지)');
});

test('⑤ 중앙 500 — 마지막 사본을 유지한다(한 번의 장애가 28곳을 로컬로 되돌리지 않게)', async () => {
  fail500 = true;
  try {
    const r = await pull.pullBmUsageConfigNow();
    assert.equal(r.ok, false);
    assert.match(r.error, /500/);
    assert.equal(r.keptCopy, true);
    assert.equal(S.bmUsageCentralState().managed, true);
  } finally { fail500 = false; }
});

test('⑥ 그 엣지 제외(대소문자 무시) — 사본을 지우고 로컬 설정으로 돌아간다', async () => {
  S.saveDistribution({ excluded: { 'EDGE-2627': true } }, 'tester');
  const r = await pull.pullBmUsageConfigNow();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.managed, false);
  assert.equal(r.reason, 'excluded');
  assert.equal(r.changed, true);
  assert.equal(fs.existsSync(path.join(DIR, 'bmusage-central.json')), false);
  assert.equal(S.bmUsageCentralState().managed, false);
  const st = S.distributionStatus(['Edge-2627']);
  assert.equal(st.rows[0].state, 'excluded');
});

test('⑦ 구조 — Enterprise 비배포 · 데이터 흐름 분류 · 엣지 로그 표 · 상태 파일 등록 · 손상 배포 파일은 꺼짐', async () => {
  for (const k of S.DISTRIBUTED_KEYS) assert.ok(!/^enterprise/.test(k), k);
  assert.ok(S.DISTRIBUTED_KEYS.includes('includeVirtualization'));
  const { CATS } = await import('../src/dataflow/build.js');
  const cat = CATS.find((c) => c.test.test('central:/bmusage-config'));
  assert.equal(cat?.id, 'idrac');
  const { STATUS_SPEC } = await import('../src/edgelog/spec.js');
  assert.ok(STATUS_SPEC.some((x) => x.fn === 'bmUsageConfigPullStatus'));
  const { isRuntimeStateFile } = await import('../src/backup/service.js');
  assert.equal(isRuntimeStateFile('bmusage-central.json'), true, '엣지 사본은 상태 파일이다');
  assert.equal(isRuntimeStateFile('bmusage-distribute.json'), false, '배포 설정은 관리자 설정이다(백업 대상)');
  fs.writeFileSync(path.join(DIR, 'bmusage-distribute.json'), '{broken');
  assert.equal(S.loadDistribution().enabled, false, '손상이면 켜진 척하지 않는다');
  assert.ok(fs.readdirSync(DIR).some((f) => f.startsWith('bmusage-distribute.json.corrupt')), '손상 원본을 보존한다');
});

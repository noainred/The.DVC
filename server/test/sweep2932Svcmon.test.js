// v2.932 — 최근 변경 점검(축 4 D1-01 ~ D1-09 · 축 5 E1-05) Monitoring(svcmon) 묶음 회귀. 고정하는 것:
//  D1-01 load-error 표지가 없는 등록부(vCenter · NSX · Horizon · 배포 대상 · 중계 토폴로지 · 물리 GPU · 캡처 · 통합 계정)도 손상 보존본만 있으면
//        sourceErrors → 연동 대상은 '사라짐' 이 아니라 '보류'. 파일이 그냥 없으면(진짜 0건) 보류가 아니다. 실제 로더 · 실제 파일 이름으로 대조.
//  D1-02 데모 계정은 설정 연동(/api/svcmon/settings-sync/*)을 조회도 못 한다(통신 점검 link-check 와 같은 카탈로그). 알림 설정 조회는 연다.
//  D1-03 중앙 재시작 직후 메타 없는 엣지 행은 알림 판정을 미루고(집계·전이는 기록) 메타가 오면 이름·경로로 알린다 · '설정 연동만' 범위도 · 시한.
//  D1-04 같은 이름의 수집 서버 · 배포 대상이 같은 폴더에 → 종류 라벨로 이름을 갈라 둘 다 연동 · 건너뛴 키는 known 밖 · 자동 등록 무변경은 이벤트·파일 없음.
//  D1-05 범위 밖·끈 종류의 복구는 상태만 닫는다 · 지우거나 끈 점검(이 포탈 · 엣지 GC · 엣지 잊기)의 알린 상태가 닫힌다.
//  D1-06 요약 알림 통계 · D1-07 아이실론 설정 링크 · D1-08 화면 문구용 주기·창을 API 가 싣는다 · E1-05 개요 집계는 양보하는 async(결과는 동기 판과 같다).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep2932svcmon-'));
process.env.CONFIG_DIR = TMP;
process.env.AUTH_ENABLED = 'true';
// 캐시하는 로더(배포 대상 · 물리 GPU · 캡처 · 통합 계정)는 첫 읽기에서 굳는다 — 어떤 모듈이 먼저 읽든 손상본을 보게 import 보다 먼저 쓴다.
const CORRUPT_EARLY = ['agent-deploy-targets.json', 'gpu-physical.json', 'capture-monitors.json', 'credentials.json'];
for (const f of CORRUPT_EARLY) fs.writeFileSync(path.join(TMP, f), '{"targets": [ {"id": "trunc');

const SYNC = await import('../src/svcmon/settingsSync.js');
const STORE = await import('../src/svcmon/store.js');
const TR = await import('../src/svcmon/transitions.js');
const KINDS = await import('../src/linkcheck/settingsKinds.js');
const LINKS = await import('../src/linkcheck/settingsLinks.js');
const DASH = await import('../src/svcmon/dash.js');
const EDGE = await import('../src/central/svcmonEdge.js');
const { damaged } = await import('../src/settingsStatus/sources.js');
const { demoGuestDenial } = await import('../src/auth/demoGuest.js');
const SRC = (p) => fs.readFileSync(path.join(HERE, '..', p), 'utf8');

// 기준 시각 — 실제 시각에서 정시 경계로 떨어뜨린다(고정 epoch · Date.now() 직접 둘 다 쓰지 않는다).
const NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 30 * 60_000;

const cat = (kind, ref, o = {}) => ({
  id: `${kind}|${ref}`, kind, ref, label: KINDS.SETTING_KINDS[kind].label, group: KINDS.SETTING_KINDS[kind].group,
  depth: KINDS.SETTING_KINDS[kind].depth, settings: KINDS.SETTING_KINDS[kind].settings, name: o.name || ref,
  agent: o.agent || '', vcenterId: '', enabled: true, address: o.host || `${ref}.corp.example`,
  scheme: o.scheme || 'https', host: o.host || `${ref}.corp.example`, port: o.port || KINDS.SETTING_KINDS[kind].defaultPort || 443,
  hadScheme: true, basePath: '', facts: {},
});
const linkedTarget = (kind, ref) => ({ id: `g-${ref}`, kind: 'infra', name: ref, host: `${ref}.corp.example`, path: 'p', tests: [], origin: { key: `${kind}|${ref}`, kind, ref } });

after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

/* ── D1-01 ── */
test('D1-01 표지 없는 등록부 8곳 — 손상 보존본만 있으면 sourceErrors · 연동 대상은 보류(held) · 파일이 그냥 없으면 사라짐(gone)', async () => {
  const LATE = { vcenters: 'vcenters.json', nsx: 'nsx.json', horizon: 'horizon.json', relaytopo: 'relay-topology.json' };
  // ① 진짜 0건(파일 없음 · 보존본 없음) — 보류가 아니다
  for (const f of Object.values(LATE)) assert.equal(damaged(f), false, f);
  const clean = await LINKS.buildSettingsTargets({ snapshot: null, deploy: [], gpuPhysical: [], capture: [], credentials: [] });
  for (const k of Object.keys(LATE)) assert.ok(!clean.sourceErrors.some((e) => e.source === k), `${k}: 파일이 없을 뿐이면 sourceErrors 가 아니다 ${JSON.stringify(clean.sourceErrors)}`);
  assert.equal(SYNC.classifyCatalog(clean, [linkedTarget('set:vcenter', 'vc1')]).rows.find((r) => r.key === 'set:vcenter|vc1').state, 'gone');

  // ② 손상 — 로더가 보존본으로 옮기고 [] 를 준다 → 보류
  for (const f of Object.values(LATE)) fs.writeFileSync(path.join(TMP, f), '{"vcenters": [ {"id": "trunc');
  (await import('../src/relaytopo/store.js'))._resetForTest();
  const r = await LINKS.buildSettingsTargets({ snapshot: null });
  const KEYS = ['vcenters', 'nsx', 'horizon', 'deploy', 'relaytopo', 'gpuPhysical', 'capture', 'credentials'];
  for (const k of KEYS) assert.ok(r.sourceErrors.some((e) => e.source === k), `${k}: 손상본만 있으면 sourceErrors ${JSON.stringify(r.sourceErrors.map((e) => e.source))}`);
  assert.deepEqual(Object.keys(LINKS.REGISTRY_FILE_OF).sort(), [...KEYS].sort());
  for (const [k, f] of Object.entries(LINKS.REGISTRY_FILE_OF)) {
    assert.ok(fs.readdirSync(TMP).some((n) => n.startsWith(`${f}.corrupt.`)), `${k}: 표의 파일 이름(${f})이 실제 로더가 보존한 파일과 같다`);
  }
  assert.ok(!JSON.stringify(r.sourceErrors).includes('trunc'), '사유에 파일 원문 조각을 싣지 않는다');
  const KIND_OF = { vcenters: 'set:vcenter', nsx: 'set:nsx', horizon: 'set:horizon', deploy: 'set:deploy', relaytopo: 'set:relaytopo', gpuPhysical: 'set:gpu-physical', capture: 'set:capture' };
  const linked = Object.values(KIND_OF).map((k, i) => linkedTarget(k, `r${i}`));
  const rows = SYNC.classifyCatalog(r, linked).rows;
  for (const [i, k] of Object.values(KIND_OF).entries()) assert.equal(rows.find((x) => x.key === `${k}|r${i}`).state, 'held', k);
});

/* ── D1-02 ── */
test('D1-02 데모 계정 — 설정 연동은 조회·미리보기·적용 모두 거부 · 알림 설정 조회와 개요는 연다', () => {
  for (const [m, p] of [['GET', '/api/svcmon/settings-sync/catalog'], ['GET', '/api/svcmon/settings-sync/catalog?x=1'], ['POST', '/api/svcmon/settings-sync/preview'],
    ['POST', '/api/svcmon/settings-sync/apply'], ['PUT', '/api/svcmon/settings-sync/options'], ['GET', '/API/SVCMON/SETTINGS-SYNC/CATALOG/']]) {
    assert.ok(demoGuestDenial(m, p), `${m} ${p} 는 데모 계정에 거부`);
  }
  assert.ok(demoGuestDenial('GET', '/api/tools/link-check/targets'), '형제 경로(같은 카탈로그)와 같은 기준');
  assert.equal(demoGuestDenial('GET', '/api/svcmon/alert-settings'), null, '알림 설정 조회(켜짐·횟수·범위 — 주소·비밀 없음)는 연다');
  assert.ok(demoGuestDenial('PUT', '/api/svcmon/alert-settings'), '저장은 SAFE_ACTIONS 밖이라 거부');
  assert.equal(demoGuestDenial('GET', '/api/svcmon/overview'), null);
  assert.equal(demoGuestDenial('GET', '/api/svcmon/state'), null);
});

/* ── D1-03 ── */
test('D1-03 메타 없는 엣지 행 — 알림 판정을 미루고 메타가 오면 이름·경로로 알린다 · 집계는 한 번 · 범위 settings 도 · 시한', async () => {
  const sent = [];
  TR._resetTransitionsForTest({ send: async (a) => { sent.push(a); } });
  EDGE._resetEdgeCache();
  TR._setAlertSettingsForTest({ enabled: true, failCount: 3, scope: 'all' });
  const row = { i: 't-9f3a01bc', s: 'bad', r: 'connect ECONNREFUSED', m: null, k: 40, a: 1000 };
  const meta = [{ i: 't-9f3a01bc', p: '설정 연동\\가상화\\PL', n: 'web01', h: '10.0.0.5', t: 'TCP 443', y: 'tcp', iv: 60 }];
  const r1 = EDGE.ingestReport('KR-EDGE', { snapId: NOW, seq: 1, total: 1, rows: [row] }, NOW);
  assert.equal(r1.needMeta, true);
  await TR.flushAlerts();
  assert.equal(sent.length, 0, '메타가 없으면 내부 ID 제목의 알림을 보내지 않는다');
  assert.equal(TR.hourlySeries(NOW).find((h) => h.at === Math.floor((NOW - 1000) / 3_600_000) * 3_600_000).n, 1, '집계는 기록한다');
  EDGE.ingestReport('KR-EDGE', { snapId: NOW + 60_000, seq: 1, total: 1, rows: [{ ...row, a: 61_000 }], meta, metaSig: 'sig1' }, NOW + 60_000);
  await TR.flushAlerts();
  assert.equal(sent.length, 1, '메타가 온 보고에서 한 번');
  assert.match(sent[0].title, /web01 › TCP 443/);
  assert.doesNotMatch(sent[0].title, /t-9f3a01bc/);
  assert.match(sent[0].detail, /경로 설정 연동\\가상화\\PL/);
  assert.equal(TR.hourlySeries(NOW).reduce((a, h) => a + h.n, 0), 1, '같은 측정의 재전송(상태·연속 횟수 같음)은 두 번 세지 않는다');

  // 범위 '설정 연동 대상만' — 메타 없는 첫 보고에서 판정에서 빠지지 않는다
  sent.length = 0;
  TR._resetTransitionsForTest({ send: async (a) => { sent.push(a); } });
  EDGE._resetEdgeCache();
  TR._setAlertSettingsForTest({ enabled: true, failCount: 3, scope: 'settings' });
  EDGE.ingestReport('KR-EDGE', { snapId: NOW, seq: 1, total: 1, rows: [row] }, NOW);
  assert.equal(TR.alertStats().metaPending, 1, '경로를 모르면 범위도 모른다 — 범위 검사 전에 보류로 센다');
  EDGE.ingestReport('KR-EDGE', { snapId: NOW + 60_000, seq: 1, total: 1, rows: [{ ...row, a: 61_000 }], meta, metaSig: 'sig1' }, NOW + 60_000);
  await TR.flushAlerts();
  assert.equal(sent.length, 1, '메타가 온 뒤 범위 안(설정 연동 경로)으로 판정');
  assert.equal(TR.alertStats().metaPending, 0);

  // 시한 — 메타가 끝내 오지 않으면 시한 뒤 메타 없이 판정한다(무기한 보류 금지)
  sent.length = 0;
  TR._resetTransitionsForTest({ send: async (a) => { sent.push(a); } });
  EDGE._resetEdgeCache();
  TR._setAlertSettingsForTest({ enabled: true, failCount: 3, scope: 'all' });
  EDGE.ingestReport('OLD-EDGE', { snapId: NOW, seq: 1, total: 1, rows: [row] }, NOW);
  const hold = EDGE.metaAlertHoldMs(EDGE.getAgentRaw('OLD-EDGE'));
  assert.ok(hold >= EDGE.META_ALERT_HOLD_MS && hold <= 15 * 60_000);
  EDGE.ingestReport('OLD-EDGE', { snapId: NOW + 60_000, seq: 1, total: 1, rows: [{ ...row, a: 61_000 }] }, NOW + 60_000);
  await TR.flushAlerts();
  assert.equal(sent.length, 0, '시한 전에는 보류');
  EDGE.ingestReport('OLD-EDGE', { snapId: NOW + hold + 1000, seq: 1, total: 1, rows: [{ ...row, a: hold + 1000 }] }, NOW + hold + 1000);
  await TR.flushAlerts();
  assert.equal(sent.length, 1, '시한을 넘기면 메타 없이 판정');
  assert.match(sent[0].title, /t-9f3a01bc/);
});

/* ── D1-04 ── */
test('D1-04 같은 이름의 수집 서버 · 배포 대상 — 종류 라벨로 이름을 갈라 둘 다 연동 · 건너뛴 키는 known 밖', () => {
  SYNC._resetSettingsSyncForTest();
  const col = cat('set:collector', 'c1', { name: 'KR-EDGE', host: 'kr-edge.corp.example' });
  const dep = cat('set:deploy', 'd1', { name: 'KR-EDGE', host: 'kr-edge.corp.example' });
  const built = { targets: [col, dep] };
  const builtByKey = new Map(built.targets.map((x) => [x.id, x]));
  let rows = SYNC.classifyCatalog(built, STORE.listTargets()).rows;
  assert.equal(rows.find((r) => r.key === col.id).path, rows.find((r) => r.key === dep.id).path, '재현 조건 — 같은 폴더');
  const out = SYNC.executePlan(SYNC.planApply(rows, [col.id, dep.id], { builtByKey }), { user: 't' });
  assert.equal(out.added, 2, JSON.stringify(out.addSkipped));
  rows = SYNC.classifyCatalog(built, STORE.listTargets(), { known: SYNC.knownKeys() }).rows;
  assert.deepEqual([rows.find((r) => r.key === col.id).state, rows.find((r) => r.key === dep.id).state], ['linked', 'linked']);
  const names = STORE.listTargets().filter((x) => x.origin).map((x) => x.name).sort();
  assert.deepEqual(names, ['KR-EDGE', `KR-EDGE (${KINDS.SETTING_KINDS['set:deploy'].label})`]);

  // 대량 등록이 건너뛴 행(같은 계획 안 같은 이름)은 known 에 넣지 않는다(everLinked 오표시)
  const p = (k, ref) => ({ key: `${k}|${ref}`, name: 'DUP', kindLabel: 'x', path: '설정 연동\\테스트', host: 'h', port: 22, agent: '',
    row: { kind: 'infra', path: '설정 연동\\테스트', name: 'DUP', host: 'dup.corp.example', enabled: false, tests: [], origin: { key: `${k}|${ref}`, kind: k, ref } } });
  const r2 = SYNC.executePlan({ add: [p('set:pdu', 'a'), p('set:pdu', 'b')], change: [], gone: [], skip: [] }, { user: 't' });
  assert.equal(r2.added, 1);
  assert.ok(SYNC.knownKeys().has('set:pdu|a'));
  assert.equal(SYNC.knownKeys().has('set:pdu|b'), false, '건너뛴 키는 연동된 적이 없다');
});

test('D1-04 자동 등록 — 아무것도 못 더하면 이벤트·상태 파일을 남기지 않는다 · 같은 실패는 한 번만', async () => {
  SYNC._resetSettingsSyncForTest();
  const FILE = path.join(TMP, 'svcmon-settings-sync.json');
  // 종류 라벨을 붙여도 겹치는 이름 — 계획 단계에서 건너뜀(자동 등록 시도 자체가 없다)
  STORE.addTarget({ kind: 'infra', path: '설정 연동\\서버\\전역', name: 'GPU1', host: 'g1.corp.example', enabled: false });
  STORE.addTarget({ kind: 'infra', path: '설정 연동\\서버\\전역', name: `GPU1 (${KINDS.SETTING_KINDS['set:gpu-physical'].label})`, host: 'g2.corp.example', enabled: false });
  SYNC.setOptions({ autoKinds: ['set:gpu-physical'] });
  const gpu = cat('set:gpu-physical', 'gp1', { name: 'GPU1', host: 'gpu1.corp.example' });
  const deps = { build: async () => ({ targets: [gpu] }), ctx: {}, candidates: new Map() };
  await SYNC.detectOnce(deps);
  const ev0 = SYNC.syncEvents().length;
  fs.rmSync(FILE, { force: true });
  for (let i = 0; i < 3; i++) await SYNC.detectOnce(deps);
  assert.equal(SYNC.syncEvents().length, ev0, '5분마다 변경 없음 이벤트가 쌓이지 않는다');
  assert.equal(fs.existsSync(FILE), false, '상태 파일을 다시 쓰지 않는다');
  const row = SYNC.classifyCatalog({ targets: [gpu] }, STORE.listTargets()).rows.find((r) => r.key === gpu.id);
  assert.equal(row.state, 'new');
  assert.equal(SYNC.planApply([row], [row.key], { builtByKey: new Map([[gpu.id, gpu]]) }).skip.length, 1, '건너뜀 사유가 계획에 남는다(화면 미리보기)');

  // executePlan 직접 — 대량 등록이 전부 건너뛴 자동 등록(경합: 계획 뒤 같은 이름이 생김)도 이벤트·파일 없음
  const dupRow = { key: 'set:pdu|c', name: 'DUP', kindLabel: 'PDU', path: '설정 연동\\테스트', host: 'h', port: 22, agent: '',
    row: { kind: 'infra', path: '설정 연동\\테스트', name: 'DUP', host: 'dup2.corp.example', enabled: false, tests: [], origin: { key: 'set:pdu|c', kind: 'set:pdu', ref: 'c' } } };
  const ev1 = SYNC.syncEvents().length;
  const rAuto = SYNC.executePlan({ add: [dupRow], change: [], gone: [], skip: [] }, { user: 'auto', batchPrefix: 'settings-auto' });
  assert.deepEqual([rAuto.added, rAuto.committed, rAuto.addSkipped.length], [0, true, 1]);
  assert.equal(SYNC.syncEvents().length, ev1, '변경 없음 이벤트를 남기지 않는다');
  assert.equal(fs.existsSync(FILE), false, '상태 파일을 쓰지 않는다');
  // executePlan 직접 — 자동 등록의 실패(추가 취소)는 처음 한 번은 남기고 같은 실패의 반복은 생략
  const bad = { key: 'set:pdu|zz', name: '', kindLabel: 'PDU', path: '설정 연동\\x', host: 'h', port: 22, agent: '', row: { kind: 'infra', path: '설정 연동\\x', name: '', host: 'h.corp.example', tests: [] } };
  const before = SYNC.syncEvents().length;
  SYNC.executePlan({ add: [bad], change: [], gone: [], skip: [] }, { user: 'auto', batchPrefix: 'settings-auto' });
  SYNC.executePlan({ add: [bad], change: [], gone: [], skip: [] }, { user: 'auto', batchPrefix: 'settings-auto' });
  assert.equal(SYNC.syncEvents().length, before + 1, '실패는 무음이 아니다 — 첫 번은 남긴다');
  assert.match(SYNC.syncEvents()[0].text, /추가 취소/);
  SYNC.setOptions({ autoKinds: [] });
});

/* ── D1-05 · D1-06 ── */
test('D1-05 ① 범위 밖 복구는 상태만 닫는다 — 범위를 다시 넓혀도 오래전 복구된 점검에 복구 알림이 없다', async () => {
  const sent = [];
  TR._resetTransitionsForTest({ send: async (a) => { sent.push(a); } });
  const base = { scope: '', testId: 'm1', target: { name: 'web01', path: 'Infra' }, test: { name: 'TCP', type: 'tcp' } };
  TR._setAlertSettingsForTest({ enabled: true, failCount: 1, recover: true, scope: 'all' });
  TR.noteResult({ ...base, at: NOW, prev: 'ok', status: 'bad', streak: 1 });
  await TR.flushAlerts();
  assert.equal(sent.length, 1);
  TR._setAlertSettingsForTest({ enabled: true, failCount: 1, recover: true, scope: 'settings' });
  TR.noteResult({ ...base, at: NOW + 60_000, prev: 'bad', status: 'ok', streak: 1 });
  await TR.flushAlerts();
  assert.equal(sent.length, 1, '범위 밖 복구는 알리지 않는다');
  assert.equal(TR.alertStats().alerted, 0, '그러나 알린 상태는 닫는다');
  TR._setAlertSettingsForTest({ enabled: true, failCount: 1, recover: true, scope: 'all' });
  TR.noteResult({ ...base, at: NOW + 6 * 3_600_000, prev: 'ok', status: 'ok', streak: 300 });
  await TR.flushAlerts();
  assert.equal(sent.length, 1, '되돌린 뒤 거짓 복구 알림(이상 지속 약 360분)이 없다');
});

test('D1-05 ② 경고만 알렸던 점검은 경고 알림을 끈 뒤 복구돼도 알리지 않는다(상태는 닫는다) · 실패는 그대로 복구를 알린다', async () => {
  const sent = [];
  TR._resetTransitionsForTest({ send: async (a) => { sent.push(a); } });
  TR._setAlertSettingsForTest({ enabled: true, failCount: 1, recover: true, warn: true });
  const w = { scope: '', testId: 'w1', target: { name: 'cert01', path: 'Infra' }, test: { name: 'cert', type: 'cert' } };
  const b = { scope: '', testId: 'b1', target: { name: 'db01', path: 'Infra' }, test: { name: 'TCP', type: 'tcp' } };
  TR.noteResult({ ...w, at: NOW, prev: 'ok', status: 'warn', streak: 1 });
  TR.noteResult({ ...b, at: NOW, prev: 'ok', status: 'bad', streak: 1 });
  await TR.flushAlerts();
  assert.equal(sent.length, 2);
  TR._setAlertSettingsForTest({ enabled: true, failCount: 1, recover: true, warn: false });
  TR.noteResult({ ...w, at: NOW + 60_000, prev: 'warn', status: 'ok', streak: 1 });
  TR.noteResult({ ...b, at: NOW + 60_000, prev: 'bad', status: 'ok', streak: 1 });
  await TR.flushAlerts();
  assert.deepEqual(sent.slice(2).map((a) => a.key), ['svcmon.test.ok:|b1']);
  assert.deepEqual([TR.alertStats().alerted, TR.alertStats().warned], [0, 0]);
});

test('D1-05 ③ 지우거나 끈 점검의 알린 상태가 닫힌다 — 이 포탈(폴러 색인) · 엣지 완결 GC · 엣지 잊기', async () => {
  TR._resetTransitionsForTest({ send: async () => {} });
  EDGE._resetEdgeCache();
  TR._setAlertSettingsForTest({ enabled: true, failCount: 1 });
  // 이 포탈 — 저장소에 없는(지운) 점검의 알린 상태는 폴러가 색인을 다시 만들 때 닫힌다
  TR.noteResult({ scope: '', testId: 't-gone', at: NOW, prev: 'ok', status: 'bad', streak: 1, target: { name: 'x', path: 'Infra' }, test: { name: 'TCP' } });
  assert.equal(TR.alertStats().alerted, 1);
  STORE.addTarget({ kind: 'infra', path: 'Infra', name: 'off-only', host: 'off.corp.example', enabled: false });   // 저장소 세대 +1(살아 있는 점검 0)
  const POLLER = await import('../src/svcmon/poller.js');
  if (POLLER.executesHere()) {
    await POLLER.runNow();
    assert.equal(TR.alertStats().alerted, 0, '색인을 다시 만들면 살아 있지 않은 점검의 상태를 닫는다');
  }
  assert.match(SRC('src/svcmon/poller.js'), /forgetAlertedWhere\('', \(_k, e\) => liveIds\.has\(e\.testId\)\)/);
  // keep 판정 — 살아 있는 것은 남기고 다른 scope 는 건드리지 않는다
  TR.noteResult({ scope: '', testId: 'live', at: NOW, prev: 'ok', status: 'bad', streak: 1, target: { path: 'Infra' } });
  TR.noteResult({ scope: '', testId: 'dead', at: NOW, prev: 'ok', status: 'bad', streak: 1, target: { path: 'Infra' } });
  // v2.928 엣지 알림 키는 이름 기준 — 이름이 없으면 판정 보류라 알린 상태가 생기지 않는다(대상·점검 이름을 싣는다)
  TR.noteResult({ scope: 'EDGE-B', testId: 'dead', at: NOW, prev: 'ok', status: 'bad', streak: 1, target: { name: 'db9', path: 'Infra' }, test: { name: 'TCP' } });
  TR.forgetAlertedWhere('', (_k, e) => e.testId === 'live');
  assert.equal(TR.alertStats().alerted, 2, '살아 있는 점검 · 다른 scope(엣지)는 남는다');
  TR._resetTransitionsForTest({ send: async () => {} });
  TR._setAlertSettingsForTest({ enabled: true, failCount: 1 });

  // 엣지 — 엣지에서 지운 점검은 완결 GC 가 행을 지울 때 상태도 닫는다
  const meta = (i) => ({ i, p: 'Infra', n: i, h: 'h', t: 'TCP', y: 'tcp', iv: 60 });
  EDGE.ingestReport('EDGE-G', { snapId: NOW, seq: 1, total: 1, rows: [{ i: 'e1', s: 'bad', r: 'x', k: 1, a: 0 }, { i: 'e2', s: 'ok', r: '1ms', m: 1, k: 1, a: 0 }], meta: [meta('e1'), meta('e2')], metaSig: 's' }, NOW);
  assert.equal(TR.alertStats().alerted, 1);
  EDGE.ingestReport('EDGE-G', { snapId: NOW + 60_000, seq: 1, total: 1, rows: [{ i: 'e2', s: 'ok', r: '1ms', m: 1, k: 2, a: 0 }], metaSig: 's' }, NOW + 60_000);
  assert.equal(TR.alertStats().alerted, 1, '한 세대 전까지는 남긴다(청크 유실 대비 — GC 규칙 그대로)');
  EDGE.ingestReport('EDGE-G', { snapId: NOW + 120_000, seq: 1, total: 1, rows: [{ i: 'e2', s: 'ok', r: '1ms', m: 1, k: 3, a: 0 }], metaSig: 's' }, NOW + 120_000);
  assert.equal(EDGE.getAgentRaw('EDGE-G').rows.has('e1'), false);
  assert.equal(TR.alertStats().alerted, 0, 'GC 가 행을 지우면 알린 상태도 닫힌다');
  // 재배정(같은 점검에 새 id) — 옛 id 행이 GC 로 지워져도 남은 행이 같은 이름 키라 알린 상태는 남는다(v2.928 의도 — 같은 실패를 다시 알리지 않는다)
  const sentR = [];
  TR._resetTransitionsForTest({ send: async (x) => { sentR.push(x); } });
  TR._setAlertSettingsForTest({ enabled: true, failCount: 1 });
  const mr = (i) => ({ i, p: 'Infra', n: 'vc-r', h: 'h', t: 'TCP 443', y: 'tcp', iv: 60 });
  EDGE.ingestReport('EDGE-R', { snapId: NOW, seq: 1, total: 1, rows: [{ i: 'o1', s: 'bad', r: 'x', k: 1, a: 0 }], meta: [mr('o1')], metaSig: 's1' }, NOW);
  EDGE.ingestReport('EDGE-R', { snapId: NOW + 60_000, seq: 1, total: 1, rows: [{ i: 'n1', s: 'bad', r: 'x', k: 2, a: 0 }], meta: [mr('n1')], metaSig: 's2' }, NOW + 60_000);
  EDGE.ingestReport('EDGE-R', { snapId: NOW + 120_000, seq: 1, total: 1, rows: [{ i: 'n1', s: 'bad', r: 'x', k: 3, a: 0 }], metaSig: 's2' }, NOW + 120_000);
  assert.equal(EDGE.getAgentRaw('EDGE-R').rows.has('o1'), false, '옛 id 행은 GC 됐다');
  // ⚠ 재배정 직후 한 세대는 옛 행·새 행 메타가 공존해 nameCount 2 → dupName → 새 id 는 testId 키로 한 번 더 알린다(main v2.928 동작 그대로 —
  //   이 묶음에서 고치지 않았다 · 보고). GC 뒤에는 이름 키(옛 알림)만 남고 고아가 된 testId 키는 닫힌다.
  assert.equal(TR.alertStats().alerted, 1, '같은 이름 키의 행이 남아 있으면 알린 상태를 지우지 않는다(고아 testId 키만 닫는다)');
  EDGE.ingestReport('EDGE-R', { snapId: NOW + 180_000, seq: 1, total: 1, rows: [{ i: 'n1', s: 'ok', r: '1ms', m: 1, k: 1, a: 0 }], metaSig: 's2' }, NOW + 180_000);
  assert.equal(TR.alertStats().alerted, 0, '새 id 의 복구가 남은 이름 키를 닫는다');
  await TR.flushAlerts();
  assert.equal(sentR.filter((x) => x.severity === 'info').length, 1, '복구 알림 한 번');
  // 보류 중이던 행이 GC 로 사라지면 보류 수에서도 빠진다
  TR._resetTransitionsForTest({ send: async () => {} });
  TR._setAlertSettingsForTest({ enabled: true, failCount: 1 });
  EDGE.ingestReport('EDGE-H', { snapId: NOW, seq: 1, total: 1, rows: [{ i: 'h1', s: 'bad', r: 'x', k: 1, a: 0 }, { i: 'h2', s: 'ok', r: '1', m: 1, k: 1, a: 0 }], meta: [meta('h2')], metaSig: 's' }, NOW);
  assert.equal(TR.alertStats().metaPending, 1);
  EDGE.ingestReport('EDGE-H', { snapId: NOW + 60_000, seq: 1, total: 1, rows: [{ i: 'h2', s: 'ok', r: '1', m: 1, k: 2, a: 0 }], metaSig: 's' }, NOW + 60_000);
  EDGE.ingestReport('EDGE-H', { snapId: NOW + 120_000, seq: 1, total: 1, rows: [{ i: 'h2', s: 'ok', r: '1', m: 1, k: 3, a: 0 }], metaSig: 's' }, NOW + 120_000);
  assert.equal(EDGE.getAgentRaw('EDGE-H').alertPending.size, 0);
  assert.equal(TR.alertStats().metaPending, 0, '지운 행을 보류로 세지 않는다');
  TR._setAlertSettingsForTest({ enabled: true, failCount: 1 });
  // 엣지 잊기
  EDGE.ingestReport('EDGE-F', { snapId: NOW, seq: 1, total: 1, rows: [{ i: 'f1', s: 'bad', r: 'x', k: 1, a: 0 }], meta: [meta('f1')], metaSig: 's' }, NOW);
  assert.equal(TR.alertStats().alerted, 1);
  EDGE.forgetAgent('EDGE-F', 'test');
  assert.equal(TR.alertStats().alerted, 0);
});

test('D1-06 요약 알림은 통계에서 요약으로 센다', async () => {
  TR._resetTransitionsForTest({ send: async () => {} });
  TR._setAlertSettingsForTest({ enabled: true, failCount: 1 });
  // v2.928 엣지 알림 키는 (엣지 · 경로 · 대상 · 점검 이름) — 서로 다른 점검 7개
  for (let i = 0; i < 7; i++) TR.noteResult({ scope: 'edge-x', testId: `s${i}`, at: NOW, status: 'bad', streak: 1, target: { name: `h${i}`, path: 'Infra' }, test: { name: 'TCP' } });
  const sent = await TR.flushAlerts();
  assert.equal(sent.length, 1);
  assert.match(sent[0].key, /:summary:\d+$/, '키 모양(시각 포함 — 반증 M4)은 그대로');
  assert.deepEqual([TR.alertStats().individual, TR.alertStats().summaries], [0, 1]);
});

/* ── D1-07 ── */
test('D1-07 아이실론 직접 대상의 설정 링크는 설정 화면(슈퍼 관리자 전용)', () => {
  const p = KINDS.SETTINGS_PATHS[KINDS.SETTING_KINDS['set:isidu-host'].settings];
  assert.equal(p.hash, '#/settings/isilon-dirusage');
  assert.match(p.label, /^설정 › 수집 주기·임계 › 아이실론 디렉터리 사용량/);
  assert.match(p.label, /슈퍼 관리자/);
  assert.match(SRC('../web/src/views/Settings.jsx'), /\{ k: 'isilon-dirusage', .*group: 'collect'.*superOnly: true/);
  assert.equal(SYNC.kindMeta()['set:isidu-host'].settingsHash, '#/settings/isilon-dirusage');
});

/* ── D1-08 · E1-05 라우트 ── */
let server; let base; let who = null;
before(async () => {
  const express = (await import('express')).default;
  const { svcmonRouter } = await import('../src/routes/svcmon.js');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = who; next(); });
  app.use('/api/svcmon', svcmonRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api/svcmon`;
});
after(() => { try { server?.close(); } catch { /* */ } });
const ADMIN = { username: 'adm', role: 'admin' };
const VIEWER = { username: 'v', role: 'viewer' };
const call = async (method, p, user) => {
  who = user;
  const r = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json' } });
  let json = null; try { json = await r.json(); } catch { /* */ }
  return { status: r.status, json };
};

test('D1-08 화면 문구용 값 — 알림 묶음 창·요약 기준(+1 은 서버) · 감지 주기 · 개요 창', async () => {
  const al = await call('GET', '/alert-settings', ADMIN);
  assert.equal(al.status, 200);
  assert.deepEqual(al.json.batch, { batchMs: TR.ALERT_BATCH_MS, batchIndividualMax: TR.ALERT_BATCH_INDIVIDUAL_MAX, summaryFrom: TR.ALERT_BATCH_INDIVIDUAL_MAX + 1 });
  const items = Array.from({ length: al.json.batch.summaryFrom }, (_, i) => ({ kind: 'bad', key: `|q${i}`, label: `q${i}`, where: '이 포탈', x: { streak: 1, target: {}, at: NOW } }));
  assert.equal(TR.buildAlerts(items).length, 1, 'summaryFrom 건이면 요약 1건');
  assert.equal(TR.buildAlerts(items.slice(1)).length, al.json.batch.summaryFrom - 1, '하나 적으면 개별');
  const c = await call('GET', '/settings-sync/catalog', ADMIN);
  assert.deepEqual(c.json.detect, { intervalMs: SYNC.DETECT_INTERVAL_MS, firstDelayMs: SYNC.FIRST_DELAY_MS });
  SYNC.noteDetection({ rows: [] }, { at: NOW });
  const st = await call('GET', '/state', VIEWER);
  assert.equal(st.json.settingsDrift.intervalMs, SYNC.DETECT_INTERVAL_MS);
  const ov = await call('GET', '/overview', VIEWER);
  assert.deepEqual(ov.json.limits, { hours: TR.HOURS_KEEP, transitions: 60 });
  // 화면 파일에 서버 상수 문구가 남지 않는다
  for (const [f, re] of [['web/src/views/svcmon/AlertTab.jsx', /20초 안에 6건/], ['web/src/views/SvcMonitor.jsx', /5분 주기/], ['web/src/views/svcmon/SettingsSyncTab.jsx', /1분 뒤부터 5분마다|5분 감지/], ['web/src/views/svcmon/OverviewDash.jsx', /최근 24시간|최근 60건/]]) {
    assert.doesNotMatch(SRC(`../${f}`), re, f);
  }
});

test('E1-05 개요 집계 — 라우트는 양보판(buildDashAsync)과 single-flight · 엣지 행은 엣지 하나씩(main v2.928 구현 — 등가·양보·계산 1회는 svcmonImprove2928 이 고정)', async () => {
  // 우리 단언: 큰 입력에서 실제로 이벤트 루프가 돈다(시간 기준 양보 — 기본 yielder)
  const targets = []; const results = new Map();
  for (let i = 0; i < 6000; i++) {
    const tests = [{ id: `x${i}a`, name: 'ping', type: 'ping', intervalSec: 60 }, { id: `x${i}b`, name: 'https', type: 'http', intervalSec: 60 }];
    targets.push({ id: `gx${i}`, name: `host-${i % 900}`, host: 'h', path: `법인${i % 9}\\랙${i % 4}`, tests });
    for (const x of tests) results.set(x.id, { status: ['ok', 'warn', 'bad'][i % 3], reply: 'ok', ms: i % 300, streak: i % 6, ts: NOW - 10_000 });
  }
  const items = Array.from({ length: 6000 }, (_, i) => ({ state: 'ok', reply: 'x', ms: i % 50, streak: 1, path: `엣지\\g${i % 7}`, target: `e-${i}`, host: 'h', test: 't', type: 'ping' }));
  let ticks = 0; let on = true;
  const spin = () => { if (!on) return; ticks += 1; setImmediate(spin); };
  setImmediate(spin);
  const { createYielder } = await import('../src/util/timeSlice.js');
  const asy = await DASH.buildDashAsync({ targets, results, agents: ['A'], edgeItemsOf: () => items, now: NOW }, { maybeYield: createYielder(1), every: 128 });
  on = false;
  assert.equal(asy.summary.total, 18000);
  assert.ok(ticks >= 2, `계산 도중 이벤트 루프가 돌았다(ticks ${ticks})`);
  const route = SRC('src/routes/svcmon/settingsSync.js');
  assert.match(route, /await buildDashAsync\(/);
  assert.match(route, /_dashInflight/);
  assert.doesNotMatch(route, /edgeState\(e\.agent, \{ limit: 50_000/, '엣지 행을 전 엣지 한꺼번에 모으지 않는다');
  const [a, b] = await Promise.all([call('GET', '/overview', VIEWER), call('GET', '/overview', VIEWER)]);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.equal(a.json.at, b.json.at);
});

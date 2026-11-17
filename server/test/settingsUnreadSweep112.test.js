/**
 * settingsUnreadSweep112.test.js — 전체 점검 112회차: 설정 화면 스윕 '못 읽은 기본값으로 채운 폼이 회복 뒤 저장을 덮는다'(106회차 R3 · R4 와 같은 꼴).
 *
 * 꼴: 서버가 설정 파일을 **읽지 못한 동안**(읽기 오류 — EACCES · EIO · EISDIR) 조회(GET)는 저장된 값이 아니라 기본값 · 빈 목록을 준다. 화면이 그 값으로 편집 폼을 채우고,
 *   파일이 다시 읽힌 뒤(쓰기 거절 503 · 409 는 읽기 오류가 이어지는 동안만 막는다) ‘저장’ 한 번이 저장돼 있던 설정을 기본값으로 덮는다(원본이 제자리에 있었으므로 보존본도 없다).
 * 고정하는 것:
 *   ① 조회 응답이 읽기 오류 표지를 싣는다(실제 핸들러 호출 — EISDIR) · 다시 읽히면 싣지 않는다 · 표지에 파일 경로 · 파일 이름을 싣지 않는다
 *   ② 화면이 그 표지를 보고 저장을 잠그고(소스 배선) 못 읽은 값으로 채운 폼을 다시 채운다(순수 판정은 vitest web/src/views/settingsUnread112.test.js)
 *   ③ 분류표: 읽기 오류 중 쓰기 거절(`…WriteRefusal`)을 내보내는 모듈은 전부 표에 있어야 한다 — 새 설정 모듈이 표에 없으면 실패한다(조회 표지 · 화면 잠금을 정하게 한다)
 *   ④ 쓰기 거절 응답 처리(105회차가 남긴 것): 웹 putJson · delJson 은 409 · 400 을 던지지 않고 본문을 준다 — 디스크 점검 설정 저장(엣지 노드 409)과
 *      장비 · 수집 서버 · 중계 서버 삭제(등록부 읽기 오류 409 · 사용 중 409)가 그 본문을 성공으로 읽거나 조용히 삼키지 않는다
 * 읽기 오류는 root 컨테이너라 EACCES 대신 EISDIR(파일 자리에 폴더 — 실제 fs 오류)로 재현한다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'unread112-'));
process.env.CONFIG_DIR = TMP;
process.env.DATA_DIR = TMP;
process.env.AUTH_ENABLED = 'false';
process.env.DATA_SOURCE = 'live';
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');
const WEB = path.join(HERE, '..', '..', 'web', 'src');
const F = (n) => path.join(TMP, n);
const put = (n, v) => fs.writeFileSync(F(n), typeof v === 'string' ? v : JSON.stringify(v));
const srcOf = (rel) => stripComments(fs.readFileSync(path.join(SRC, rel), 'utf8'));
const webOf = (rel) => stripComments(fs.readFileSync(path.join(WEB, rel), 'utf8'));

// 시계: 실제 시각에서 정시 경계로 떨어뜨려 고정(재읽기 간격 판정 — util/jsonFileRead.js nowMs).
const RD = await import('../src/util/jsonFileRead.js');
let NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;
RD._setJsonFileLoadClockForTest(() => NOW);
after(() => RD._setJsonFileLoadClockForTest());
const pass = (ms = RD.READ_RETRY_MS + 1_000) => { NOW += ms; };

/** 원본을 옆에 비켜 두고 그 자리에 폴더를 둔다(실제 EISDIR) — restore() 가 원본을 되돌린다. */
function asDir(name) {
  const keep = F(`${name}.keep112`);
  if (fs.existsSync(F(name)) && !fs.statSync(F(name)).isDirectory()) fs.renameSync(F(name), keep);
  fs.mkdirSync(F(name), { recursive: true });
  return () => { fs.rmSync(F(name), { recursive: true, force: true }); if (fs.existsSync(keep)) fs.renameSync(keep, F(name)); };
}
const quiet = async (fn) => { const w = console.warn; const e = console.error; const l = console.log; console.warn = () => {}; console.error = () => {}; console.log = () => {}; try { return await fn(); } finally { console.warn = w; console.error = e; console.log = l; } };

/** 라우트 등록 함수에 가짜 라우터를 넘겨 마지막 핸들러(게이트 뒤)를 모은다 — 106회차 rebut106 과 같은 방식. */
function handlersOf(register) {
  const handlers = {};
  const reg = (m) => (p, ...h) => { handlers[`${m} ${p}`] = h.at(-1); };
  register({ get: reg('GET'), post: reg('POST'), put: reg('PUT'), delete: reg('DELETE'), patch: reg('PATCH'), use: () => {} });
  return async (key, req = {}) => {
    assert.ok(handlers[key], `핸들러 없음: ${key}`);
    let body = null; let code = 200;
    const res = { json: (b) => { body = b; return res; }, status: (c) => { code = c; return res; }, set: () => res, setHeader: () => res };
    await handlers[key]({ query: {}, body: {}, params: {}, headers: {}, user: { username: 'admin', role: 'admin' }, ...req }, res, (e) => { if (e) throw e; });
    return { code, body };
  };
}
/** 표지 모양: 읽기 오류 · 사유 요약만 — 파일 경로 · 파일 이름 · 설정 폴더를 싣지 않는다. */
function isMark(le, label, fileName) {
  assert.ok(le && typeof le === 'object', `${label}: 못 읽은 동안의 조회는 표지를 실어야 화면이 저장을 잠근다`);
  assert.equal(le.readError, true, `${label}: 읽기 오류(다시 읽히면 풀림)임을 싣는다`);
  const text = JSON.stringify(le);
  assert.ok(!text.includes(TMP), `${label}: 표지에 설정 폴더 경로를 싣지 않는다`);
  if (fileName) assert.ok(!text.includes(fileName), `${label}: 표지에 파일 이름을 싣지 않는다`);
  assert.match(String(le.reason || ''), /읽지 못했습니다|읽기 오류/, label);
}

test('unreadMark: 쓰기 거절 본문(107회차)에서 조회 표지를 만든다 — 사유는 오류 코드 요약만(파일 이름 · 경로 없음)', async () => {
  const { unreadMark } = await import('../src/routes/settingsUnreadMark.js');
  assert.deepEqual(unreadMark(null), {});
  assert.deepEqual(unreadMark(undefined), {});
  assert.deepEqual(unreadMark({ ok: false, reason: '손상' }), {}, '읽기 오류가 아닌 거절은 표지가 아니다');
  const refusal = { ok: false, status: 503, code: 'settingsUnreadable', readError: true, reason: 'RMA 분배 · 접속 허용 설정 파일(rma-settings.json)을 읽지 못해 저장하지 않았습니다 — 읽기 오류(EACCES)이고 원본은 그대로 있습니다.' };
  const m = unreadMark(refusal);
  assert.deepEqual(Object.keys(m), ['loadError']);
  assert.equal(m.loadError.readError, true);
  assert.equal(m.loadError.code, 'EACCES');
  assert.match(m.loadError.reason, /^설정 파일을 읽지 못했습니다\(EACCES\) — 읽기 오류이고 원본은 그대로 있습니다/);
  assert.ok(!m.loadError.reason.includes('rma-settings.json'), '파일 이름을 옮겨 싣지 않는다');
  assert.ok(!m.loadError.reason.includes('저장하지 않았습니다'), '조회에서는 저장을 말하지 않는다');
  assert.match(m.loadError.reason, new RegExp(`${Math.round(RD.READ_RETRY_MS / 1000)}초마다 다시 읽습니다`), '재읽기 간격은 서버 값에서');
  assert.deepEqual(Object.keys(unreadMark(refusal, 'settingsLoadError')), ['settingsLoadError']);
  // 코드가 없는 사유 · 이상한 값에도 던지지 않는다
  assert.equal(unreadMark({ readError: true, reason: '' }).loadError.code, undefined);
  assert.equal(unreadMark({ readError: true, reason: 12345 }).loadError.readError, true);
  assert.equal(unreadMark({ readError: true, reason: `읽기 오류(${'A'.repeat(200)})` }).loadError.code, undefined, '코드 길이 상한 밖은 싣지 않는다');
});

test('A1 스토리지 수집 주기 조회: 주기 파일을 못 읽은 동안 config 가 빈 지정이라는 표지(loadError)를 싣고, 읽히면 싣지 않는다', () => quiet(async () => {
  const I = await import('../src/storage/intervals.js');
  const spec = I.INTERVAL_SPEC[0];
  const want = Math.min(spec.max || 24 * 3_600_000, Math.max(spec.min, 2 * 3_600_000));
  const saved = { version: 1, global: { [spec.key]: want }, agents: { 'edge-a': { [spec.key]: want }, 'edge-b': { [spec.key]: want } } };
  put('storage-intervals.json', saved);
  I._resetForTest();
  const { registerStorageMon } = await import('../src/routes/api/storageMon.js');
  const call = handlersOf(registerStorageMon);
  const ok = await call('GET /tools/storage/intervals');
  assert.deepEqual(Object.keys(ok.body.config.agents).sort(), ['edge-a', 'edge-b']);
  assert.equal(ok.body.loadError, undefined, '읽힌 설정에는 표지가 없다');

  I._resetForTest();
  const restore = asDir('storage-intervals.json');
  const bad = await call('GET /tools/storage/intervals');
  assert.deepEqual(bad.body.config, { global: {}, agents: {} }, '못 읽은 동안 config 는 빈 지정이다(저장된 값이 아니다)');
  isMark(bad.body.loadError, '스토리지 수집 주기', 'storage-intervals.json');
  // 그 빈 폼의 저장(전체 교체): 읽기 오류가 이어지는 동안은 서버가 409 로 막는다(105회차 A5) — 다시 읽힌 뒤에는 막을 근거가 없어 조회의 표지로 화면이 잠근다.
  const refused = await call('PUT /tools/storage/intervals', { body: { global: {}, agents: {} } });
  assert.equal(refused.code, 409);
  restore(); pass();
  const again = await call('GET /tools/storage/intervals');
  assert.equal(again.body.loadError, undefined);
  assert.deepEqual(Object.keys(again.body.config.agents).sort(), ['edge-a', 'edge-b'], '다시 읽히면 저장된 엣지별 주기');
  // 재현(수정 전 화면): 못 읽은 동안 받은 빈 폼을 다시 읽힌 뒤 저장하면 엣지별 주기가 전부 사라진다 — 서버는 그 저장을 받아들인다.
  const wiped = await call('PUT /tools/storage/intervals', { body: bad.body.config });
  assert.equal(wiped.code, 200);
  assert.deepEqual(wiped.body.config.agents, {}, '전체 교체 저장 — 서버가 막지 못한다(그래서 화면이 잠가야 한다)');

  // 손상(보존본으로 옮김)은 읽기 오류가 아니다 — 표지는 싣되 readError 는 false(저장이 해제 길이라 잠그지 않는다)
  put('storage-intervals.json', '{ broken');
  I._resetForTest();
  const corrupt = await call('GET /tools/storage/intervals');
  assert.equal(corrupt.body.loadError?.readError, false);
  for (const f of fs.readdirSync(TMP).filter((x) => x.startsWith('storage-intervals.json.corrupt.'))) fs.rmSync(F(f), { force: true });
  I._resetForTest();
}));

test('A2 SAN 포트 사용량 설정 조회: 표지가 읽기 오류(readError)와 손상을 가른다 — 화면이 둘 다 저장 · 정리를 잠근다', () => quiet(async () => {
  const P = await import('../src/sanswitch/perfSettings.js');
  put('sanswitch-perf-settings.json', { version: 1, enabled: true, intervalMs: 600_000, sampleSeconds: 5, retentionDays: 3650, rollupRetentionDays: 3650 });
  P._resetForTest();
  const restore = asDir('sanswitch-perf-settings.json');
  const le = P.perfSettingsLoadError();
  assert.equal(le?.readError, true);
  assert.notEqual(P.loadPerfSettings().retentionDays, 3650, '못 읽은 동안은 기본 보관일');
  const route = srcOf('routes/api/sanSwitch.js');
  assert.match(route, /loadError: \{ reason: String\(le\.reason \|\| ''\)\.slice\(0, 200\), readError: le\.readError === true \}/, '조회 표지에 readError 를 싣는다');
  restore(); pass();
  assert.equal(P.perfSettingsLoadError(), null);
  assert.equal(P.loadPerfSettings().retentionDays, 3650, '다시 읽히면 저장된 보관일');
  P._resetForTest();
}));

test('B RMA 분배 · 접속 허용 조회: 설정을 못 읽은 동안 법인별 allowedIps 가 빈 값이라는 표지(settingsLoadError)를 싣는다', () => quiet(async () => {
  const M = await import('../src/rma/settings.js');
  put('rma-settings.json', { version: 1, defaultMode: 'active-backup', agents: { 'edge-a': { allowedIps: ['10.1.1.0/24'], comment: 'c' } } });
  M._resetRmaSettings();
  const { registerRma } = await import('../src/routes/api/rma.js');
  const call = handlersOf(registerRma);
  const restore = asDir('rma-settings.json');
  const bad = await call('GET /tools/rma');
  assert.equal(bad.body.settings.defaultMode, 'active-active', '못 읽은 동안은 기본 분배 방식');
  assert.deepEqual(bad.body.settings.agents, {}, '못 읽은 동안 접속 허용 IP 는 빈 값(= 제한 없음 으로 보인다)');
  isMark(bad.body.settingsLoadError, 'RMA', 'rma-settings.json');
  restore(); pass();
  const ok = await call('GET /tools/rma');
  assert.equal(ok.body.settingsLoadError, undefined);
  assert.deepEqual(ok.body.settings.agents['edge-a'].allowedIps, ['10.1.1.0/24']);
  M._resetRmaSettings();
}));

test('B 설정 조회 10곳(실제 핸들러): 못 읽은 동안 표지를 싣고 다시 읽히면 싣지 않는다', () => quiet(async () => {
  /** [이름, 파일, 씨앗, 등록 함수 얻기, 조회 키, 표지 꺼내기, 저장된 값이 돌아왔는가] */
  const CASES = [
    ['IPMS 설정', 'ipam-settings.json', { global: ['10.9.0.0/16'], vcenters: { 'vc-a': ['10.8.0.0/24'] }, publicRanges: ['203.0.113.0/24'], privateRanges: [] },
      async () => (await import('../src/routes/admin/centralIpam.js')).registerCentralIpam, 'GET /ipam/settings', (b) => b.loadError, (b) => b.settings.global[0] === '10.9.0.0/16'],
    ['IP 대역 정책', 'ipam-range-policies.json', { policies: [{ id: 'p1', spec: '10.5.0.0/24', specLo: 168099841, specHi: 168100094, specSize: 254, status: 'reserved', priority: 100, enabled: true }] },
      async () => (await import('../src/routes/api/ipamExport.js')).registerIpamExport, 'GET /tools/ipam/policies', (b) => b.loadError, (b) => b.policies.length === 1],
    ['특수 기능 분류', 'tool-categories.json', { enabled: true, showUncategorized: false, categories: [{ id: 'c1', label: '서버', icon: '🖥', enabled: true, tools: [] }] },
      async () => (await import('../src/routes/admin/toolCategories.js')).registerToolCategories, 'GET /tool-categories', (b) => b.loadError, (b) => b.settings.categories.length === 1],
    ['로그인 실패 감시', 'login-monitor.json', { enabled: false, intervalMin: 7, days: 3, threshold: 9, windowMin: 11, alert: false },
      async () => (await import('../src/routes/admin/backupNetSec.js')).registerBackupNetSec, 'GET /security/login-fails/status', (b) => b.loadError, (b) => b.settings.threshold === 9],
    ['일일 리포트', 'daily-report.json', { enabled: true, hour: 7, minute: 30, snapshotAgeDays: 5, dsWarnPct: 90 },
      async () => (await import('../src/routes/admin/opsSettings.js')).registerOpsSettings, 'GET /report/daily', (b) => b.loadError, (b) => b.hour === 7],
    ['실제 OS 스캔', 'os-scan.json', { enabled: true, intervalMin: 60, maxVms: 33 },
      async () => (await import('../src/routes/admin/opsSettings.js')).registerOpsSettings, 'GET /os-scan', (b) => b.loadError, (b) => b.settings.maxVms === 33],
    ['AI 검색(LLM)', 'llm.json', { enabled: true, url: 'http://10.0.0.9:11434', model: 'm1', timeoutMs: 20000 },
      async () => (await import('../src/routes/admin/deployLlm.js')).registerDeployLlm, 'GET /llm-config', (b) => b.loadError, (b) => b.config.model === 'm1'],
    ['전원 꺼짐 점검', 'power-off-check.json', { enabled: false, intervalHours: 24 },
      async () => (await import('../src/routes/api/toolsCapacity.js')).registerToolsCapacity, 'GET /tools/waste/off-check', (b) => b.loadError, (b) => b.settings.intervalHours === 24],
    ['알림 설정', 'alerts.json', { channels: { webhook: { enabled: true, url: 'https://hooks.example.com/alerts' } }, cooldownMin: 77 },
      async () => (await import('../src/routes/admin/opsSettings.js')).registerOpsSettings, 'GET /alerts', (b) => b.loadError, (b) => b.config.cooldownMin === 77 && b.config.channels.webhook.url === 'https://hooks.example.com/alerts'],
    ['게스트 파티션', 'guest-partition.json', { threshold: 77 },
      async () => (await import('../src/routes/api/toolsGuestPart.js')).registerToolsGuestPart, 'GET /tools/guest-partition/settings', (b) => b.settingsLoadError, (b) => b.settings.threshold === 77],
  ];
  for (const [label, file, seed, getReg, key, markOf, restored] of CASES) {
    put(file, seed);
    const restore = asDir(file);   // 모듈이 처음 읽기 전에 읽기 오류로 둔다(캐시 초기화 함수가 없는 모듈도 같은 순서로)
    const call = handlersOf(await getReg());
    const bad = await call(key);
    assert.equal(bad.code, 200, `${label}: 조회 자체는 답한다`);
    assert.equal(restored(bad.body), false, `${label}: 못 읽은 동안은 저장된 값이 아니다`);
    isMark(markOf(bad.body), label, file);
    restore(); pass();
    const ok = await call(key);
    assert.equal(markOf(ok.body), undefined, `${label}: 다시 읽히면 표지가 없다`);
    assert.equal(restored(ok.body), true, `${label}: 다시 읽히면 저장된 값`);
  }
}));

test('B 게스트 파티션 조회 문구: 읽기 오류인데 보존본으로 옮겼다고 말하지 않는다(107회차 뒤 — 원본은 그대로다)', () => {
  const s = srcOf('routes/api/toolsGuestPart.js');
  assert.match(s, /settingsLoadError\(\) \? \(guestPartWriteRefusal\(\) \? '[^']*읽기 오류이고 원본은 그대로 있습니다\.' : '[^']*\.corrupt 로 보존했습니다\.'\) : null/);
});

test('B FinOps 단가 · 스토리지 사용량 메일 · Bareos 번들 받는 곳: 조회가 읽기 오류 표지를 싣는다(소스 + 모듈)', () => quiet(async () => {
  assert.match(srcOf('routes/insights.js'), /insightsRouter\.get\('\/finops\/config', \(_req, res\) => res\.json\(\{ \.\.\.loadFinopsConfig\(\), \.\.\.unreadMark\(finopsWriteRefusal\(\)\) \}\)\)/);
  assert.match(srcOf('routes/api/bareosInstall.js'), /\.\.\.\(bundleSourceWriteRefusal\(\) \? \{ readError: true \} : \{\}\)/);
  // 사용량 메일: 상태의 loadError 가 readError 를 싣는다(설정 파일만 — 처리 기록 파일 읽기 오류는 폼 값과 무관하다)
  const U = await import('../src/storage/usageMail.js');
  put('storage-usage-mail.json', { enabled: true, days: [1], time: '09:00', gran: 'week', to: ['a@example.com'], includeAdmin: false });
  U._resetForTest();
  const restore = asDir('storage-usage-mail.json');
  assert.equal(U.loadUsageMailSettings().enabled, false, '못 읽은 동안은 기본값(꺼짐 · 받는 사람 없음)');
  const st = U.storageUsageMailStatus();
  assert.equal(st.loadError?.readError, true);
  assert.deepEqual(Object.keys(st.loadError).sort(), ['at', 'readError'], '사유 원문 · 경로는 싣지 않는다');
  restore(); pass();
  assert.equal(U.storageUsageMailStatus().loadError, null);
  assert.deepEqual(U.loadUsageMailSettings().to, ['a@example.com']);
  U._resetForTest();
}));

/*
 * 분류표 — 읽기 오류 중 쓰기 거절(`export function …WriteRefusal`)을 내보내는 모듈 전부.
 *   form  : 폼으로 저장하는 설정 화면이 있다 → route(조회 라우트 소스)에 표지 식이 있고 screen(화면 소스)이 잠금 식을 쓴다(둘 다 검사)
 *   own   : 112회차 전에 자체 표지 · 화면 처리가 있던 곳(검사 식을 적는다)
 *   left  : 조회 표지 · 화면 잠금을 넣지 않고 남긴 곳(사유) — 고치면 form 으로 옮긴다
 *   out   : 112회차가 대조하지 않은 곳(97 · 103회차의 등록부 · 자체 표지 모듈 — 사유를 적는다). 대조하면 form · own · left 중 하나로 옮긴다
 * 새 모듈이 `…WriteRefusal` 을 내보내면 여기에 한 줄을 더해야 한다(없으면 실패) — 그때 '조회가 표지를 싣는가 · 화면이 그 표지를 보는가' 를 정한다.
 */
const lock = (name = 'saveLocked') => new RegExp(`disabled=\\{[^}]*\\b${name}\\b`);
const TABLE = {
  // ── A(106회차가 남긴 것) · B(107회차 30개 모듈 중 설정 화면이 있는 것)
  'storage/intervals.js': { cls: 'form', route: ['routes/api/storageMon.js', /const le = storageIntervalsLoadError\(\);[\s\S]{0,400}loadError: \{ reason: String\(le\.reason \|\| ''\)\.slice\(0, 300\), readError: le\.readError === true \}/], screen: ['views/StorageIntervals.jsx', lock()], lose: '엣지별 주기 전부(전체 교체)' },
  'rma/settings.js': { cls: 'form', route: ['routes/api/rma.js', /\.\.\.unreadMark\(rmaSettingsWriteRefusal\(\), 'settingsLoadError'\)/], screen: ['views/tools/RemoteCommand.jsx', /disabled=\{!!lockWhy\} onClick=\{saveAccess\}/], lose: '법인의 접속 허용 IP(빈 저장 = 제한 없음) · 분배 · 원격 관리' },
  'hostaccess/settings.js': { cls: 'form', route: ['routes/admin/hostAccess.js', /\.\.\.unreadMark\(hostAccessWriteRefusal\(\)\)/], screen: ['views/HostAccessSettings.jsx', /disabled=\{busy !== '' \|\| saveLocked\} onClick=\{\(\) => run\('draft'\)\}/], lose: '방화벽 초안(허용 목록 · 추가 규칙) — 적용하면 기본값이 방화벽에' },
  'ipam/settings.js': { cls: 'form', route: ['routes/admin/centralIpam.js', /\.\.\.unreadMark\(ipamSettingsWriteRefusal\(\)\)/], screen: ['views/tools/IpmsSettings.jsx', /if \(saveLockedByUnread\(unread\)\) return <Frame/], lose: '전 vCenter 무시 대역 · 공인/사설 분류(전체 교체)' },
  'ipam/rangePolicies.js': { cls: 'form', route: ['routes/api/ipamExport.js', /\.\.\.unreadMark\(rangePoliciesWriteRefusal\(\)\)/], screen: ['views/tools/IpamNet.jsx', /<SettingsUnreadBanner le=\{unreadMarkOf\(data\)\} what="IP 대역 정책"/], lose: '덮지 않는다(정책 단건 저장) — 0건 목록이 정책 없음 으로 보이던 것만' },
  'toolcats/settings.js': { cls: 'form', route: ['routes/admin/toolCategories.js', /\.\.\.unreadMark\(toolCatsWriteRefusal\(\)\)/], screen: ['views/ToolCategories.jsx', lock()], lose: '분류 목록(전체 교체) · 이름 · 단계' },
  'security/loginMonitor.js': { cls: 'form', route: ['routes/admin/backupNetSec.js', /\.\.\.unreadMark\(loginMonitorWriteRefusal\(\)\)/], screen: ['views/LoginFails.jsx', lock()], lose: '임계 · 주기 · 알림' },
  'reports/dailyReport.js': { cls: 'form', route: ['routes/admin/opsSettings.js', /\.\.\.unreadMark\(dailyReportWriteRefusal\(\)\)/], screen: ['views/ToolsReports.jsx', /if \(schedLocked\) \{ setSaving\(/], lose: '사용 여부 · 발송 시각' },
  'inventory/osScanner.js': { cls: 'form', route: ['routes/admin/opsSettings.js', /\.\.\.unreadMark\(osScanWriteRefusal\(\)\)/], screen: ['views/tools/GuestOsTools.jsx', lock()], lose: '주기 스캔 켜짐 · 주기 · 상한' },
  'insights/finops.js': { cls: 'form', route: ['routes/insights.js', /\.\.\.unreadMark\(finopsWriteRefusal\(\)\)/], screen: ['views/Insights.jsx', lock('cfgLocked')], lose: '요금 · PUE · 탄소 계수' },
  'llm/config.js': { cls: 'form', route: ['routes/admin/deployLlm.js', /\.\.\.unreadMark\(llmConfigWriteRefusal\(\)\)/], screen: ['views/LlmSettings.jsx', lock()], lose: 'LLM 주소 · 모델(기동 뒤 한 번도 못 읽었을 때만 — 그 밖은 마지막 값)' },
  'tools/powerOffSettings.js': { cls: 'form', route: ['routes/api/toolsCapacity.js', /\.\.\.unreadMark\(powerOffWriteRefusal\(\)\)/], screen: ['views/PowerOffCheckSettings.jsx', lock()], lose: '점검 사용 · 주기' },
  'guestpart/settings.js': { cls: 'form', route: ['routes/api/toolsGuestPart.js', /\.\.\.unreadMark\(guestPartWriteRefusal\(\), 'settingsLoadError'\)/], screen: ['views/tools/GuestPartSettings.jsx', /const ro = !full \|\| saveLocked;/], lose: '임계 · 무시 패턴 · 메일 받는 사람(구획마다 전체 교체)' },
  'diskbad/settings.js': { cls: 'form', route: ['routes/api/diskBad.js', /settingsLoadError: diskBadSettingsLoadError\(\)/], screen: ['views/tools/DiskBadTool.jsx', /if \(saveLocked\) \{ setMsg\(/], lose: '법인 담당자 메일 목록(체크 하나만 바꿔도 함께 전체 교체)' },
  'bareos/install/bundleSource.js': { cls: 'form', route: ['routes/api/bareosInstall.js', /\.\.\.\(bundleSourceWriteRefusal\(\) \? \{ readError: true \} : \{\}\)/], screen: ['views/tools/BareosInstall.jsx', /disabled=\{busy \|\| !writable \|\| src\.readError === true\}/], lose: '번들 받는 주소 · 서버 디렉터리' },
  'alerts.js': { cls: 'form', route: ['routes/admin/opsSettings.js', /\.\.\.unreadMark\(alertConfigWriteRefusal\(\)\)/], screen: ['views/Alerts2.jsx', /disabled=\{!!lock \|\| saveLocked\}/], lose: '웹훅 주소 · 임계 · 채널(103회차 모듈 — 표본 대조에서 같은 꼴 확인)' },
  // ── own: 112회차 전에 표지 · 화면 처리가 있던 곳
  'linkcheck/settings.js': { cls: 'own', route: ['routes/api/linkCheck.js', /settingsLoadError: \{ reason: String\(settingsLe\.reason \|\| ''\)\.slice\(0, 300\), readError: settingsLe\.readError === true \}/], screen: ['views/tools/LinkCheck.jsx', /disabled=\{busy \|\| !!data\?\.settingsLoadError\?\.readError\}/], why: '106회차 R3' },
  // ── left: 넣지 않고 남긴 곳
  'usermenu/store.js': { cls: 'left', why: '내 메뉴 편집 — 못 읽은 동안 기본 메뉴로 편집 · 저장하면 내 메뉴가 바뀌지만 직전 메뉴(prev)가 남아 ‘이전 메뉴로 되돌리기’ 로 되살린다(낮음). 조회가 App 기동 경로라 표지 · 편집기 잠금은 따로 본다' },
  'runtime-settings.js': { cls: 'left', why: '데이터 소스 — 값 하나를 사용자가 명시로 고르는 선택(숨은 칸이 없다 — 기본값 폼이 덮는 꼴 아님). 못 읽은 동안 현재 소스 표시만 env 기본값(표시 문제 · 낮음)' },
  'ui-settings.js': { cls: 'left', why: '화면 표시 설정(지도 높이 등) — 못 읽은 동안 마지막으로 읽은 값을 준다(107회차). 기동 뒤 한 번도 못 읽었을 때만 기본값 · 표시 설정이라 낮음' },
  'attach/store.js': { cls: 'left', why: '첨부 상한 설정 — 조회에 표지가 이미 있다고 107회차가 적었으나 화면 대조를 하지 못했다(낮음 — 상한 숫자 둘)' },
  'wiki/userState.js': { cls: 'left', why: '즐겨찾기 · 조회 수 — 폼이 아니다(항목 단위 토글). 못 읽은 동안 빈 즐겨찾기로 보이는 표시 문제만' },
  'sshaccess/installed.js': { cls: 'left', why: 'SSH 키 설치 기록 — 사용자가 편집하는 폼이 아니다(작업이 쓰는 원장)' },
  // ── out: 112회차가 대조하지 않은 곳(97 · 103회차 모듈 — 등록부 · 자체 표지 · 자체 화면 처리). 대조하면 옮긴다
  ...Object.fromEntries([
    'auth/permissions.js', 'bmstor/registry.js', 'cvp/registry.js', 'gpu/physicalRegistry.js',
    'idrac/powerSettings.js', 'idrac/registry.js', 'idrac/scanPoller.js', 'idrac/scanRanges.js', 'net/monitor.js', 'partfault/settings.js', 'pdu/registry.js',
    'perf/settings.js', 'sanswitch/registry.js', 'storage/registry.js', 'svcmon/store.js', 'upgrade/packageSettings.js', 'upgrade/settings.js', 'veeam/em/registry.js', 'veeam/registry.js',
    'util/registryCore.js',
  ].map((f) => [f, { cls: 'out', why: '97 · 103회차의 등록부 · 설정(자체 loadError · registryLoadError 흐름) — 112회차는 화면까지 대조하지 않았다' }])),
  // 116회차가 읽기 단계를 가른 NSX 등록부(112회차 뒤에 들어왔다 — 메인이 등재). 조회 표지 · NsxAdmin 화면의 저장 잠금은 아직 대조하지 않았다.
  'nsx/registry.js': { cls: 'out', why: '116회차의 NSX 등록부(registryLoadError · registryWriteRefusal — 못 읽는 동안 마지막으로 읽은 목록을 준다) — 조회 표지와 NSX 관리 화면의 잠금은 대조하지 않았다(다음 반증 회차 후보)' },
};

test('분류표: 쓰기 거절(…WriteRefusal)을 내보내는 모듈은 전부 표에 있다 — 새 설정 모듈은 조회 표지 · 화면 잠금을 정해야 한다', () => {
  const found = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) { if (ent.name !== 'routes' && ent.name !== 'node_modules') walk(p); continue; }
      if (!ent.name.endsWith('.js')) continue;
      const text = fs.readFileSync(p, 'utf8');
      if (/^export (?:function|const) \w*WriteRefusal\b/m.test(text)) found.push(path.relative(SRC, p).split(path.sep).join('/'));
    }
  };
  walk(SRC);
  const missing = found.filter((f) => !TABLE[f]).sort();
  assert.deepEqual(missing, [], `분류표에 없는 모듈 — 조회(GET)가 읽기 오류 표지를 싣는가 · 화면이 그 표지를 보고 저장을 잠그는가를 정해 표에 넣을 것: ${missing.join(', ')}`);
  const stale = Object.keys(TABLE).filter((f) => !found.includes(f)).sort();
  assert.deepEqual(stale, [], `표에만 있고 소스에 없는 줄(파일 이동 · 삭제): ${stale.join(', ')}`);
  for (const [f, row] of Object.entries(TABLE)) {
    assert.ok(['form', 'own', 'left', 'out'].includes(row.cls), f);
    if (row.cls === 'left' || row.cls === 'out') assert.ok(String(row.why || '').length >= 10, `${f}: 남긴 사유를 적는다`);
  }
});

test('분류표 form · own: 조회 라우트가 표지를 싣고 화면이 그 표지로 저장을 잠근다(소스 배선)', () => {
  for (const [f, row] of Object.entries(TABLE)) {
    if (row.cls !== 'form' && row.cls !== 'own') continue;
    const [routeFile, routeRe] = row.route;
    assert.match(srcOf(routeFile), routeRe, `${f}: 조회 라우트(${routeFile})가 읽기 오류 표지를 싣는다`);
    const [screenFile, screenRe] = row.screen;
    const web = webOf(screenFile);
    assert.match(web, screenRe, `${f}: 화면(${screenFile})이 표지로 저장을 잠근다`);
    if (row.cls === 'form') assert.match(web, /from '\.{1,2}\/settingsUnread\.js'|src\.readError === true/, `${f}: 판정은 공용 도우미(views/settingsUnread.js) 하나`);
  }
});

test('화면 배선: 못 읽은 값으로 채운 폼은 상태가 바뀐 조회에서 다시 채운다 · 저장 성공은 표지를 내린다', () => {
  const si = webOf('views/StorageIntervals.jsx');
  assert.match(si, /const unread = unreadMarkOf\(data\);\s*const saveLocked = saveLockedByUnread\(unread\);/);
  assert.match(si, /if \(saveLocked\) return;/, '잠긴 저장은 보내지 않는다(버튼 잠금의 이중 방어)');
  assert.match(si, /setData\(\(p\) => \(\{ \.\.\.p, \.\.\.r, loadError: null \}\)\)/, '저장 성공 = 표지 해제');
  assert.match(si, /<SettingsUnreadBanner le=\{unread\} what="스토리지 수집 주기" save="저장" onRecheck=\{load\}/);
  const sp = webOf('views/SanSwitchPerf.jsx');
  assert.ok(!/setForm\(\(f\) => f \|\| d\.settings\)/.test(sp), '처음 받은 값을 끝까지 들고 있지 않는다(106회차가 남긴 꼴)');
  assert.match(sp, /if \(seedKind\.current === null \|\| shouldReseed\(seedKind\.current, le\)\) \{ seedKind\.current = unreadKind\(le\); setForm\(d\.settings\); \}/);
  assert.match(sp, /saveLockedByUnread\(unread, \{ corruptLocks: true \}\)/, '이 설정은 손상도 서버가 저장 · 정리를 거절한다 — 둘 다 잠근다');
  assert.match(sp, /disabled=\{busy \|\| saveLocked \|\| db\.available === false\} onClick=\{pruneNow\}/, '기본 보관일 기준의 지금 정리도 잠근다');
  const ha = webOf('views/HostAccessSettings.jsx');
  assert.match(ha, /if \(!inited\.current \|\| resetDraft \|\| shouldReseed\(seedKind\.current, le\)\) \{ inited\.current = true; seedKind\.current = unreadKind\(le\); setDraft\(fromServer\(d\.draft\)\); \}/);
  assert.match(ha, /disabled=\{busy !== '' \|\| !eng\?\.ok \|\| !!pend \|\| saveLocked\} onClick=\{\(\) => setOtpFor\('apply'\)\}/, '기본값 초안을 방화벽에 적용하지 않는다');
  const rc = webOf('views/tools/RemoteCommand.jsx');
  assert.match(rc, /const \[openedKind\] = useState\(\(\) => unreadKind\(unread\)\);\s*const lockWhy = staleSeedLock\(openedKind, unread,/, '못 읽은 동안 연 설정 창은 다시 읽힌 뒤에도 잠근다(창은 폼을 다시 채우지 않는다)');
  for (const fn of ['save', 'saveAccess', 'saveRemote']) assert.match(rc, new RegExp(`disabled=\\{!!lockWhy\\} onClick=\\{${fn}\\}`), fn);
  assert.match(rc, /<SettingsModal group=\{cfg\}[^>]*unread=\{unreadMarkOf\(data\)\}/);
  const lf = webOf('views/LoginFails.jsx');
  assert.ok(!/setS\(\(cur\) => cur \|\| st\.settings\)/.test(lf), '처음 받은 값을 끝까지 들고 있지 않는다');
  assert.match(lf, /if \(seedKind\.current === null \|\| shouldReseed\(seedKind\.current, le\)\) \{ seedKind\.current = unreadKind\(le\); setS\(st\.settings\); \}/);
  const os2 = webOf('views/tools/GuestOsTools.jsx');
  assert.match(os2, /const keep = !!cur\?\.dirty && !shouldReseed\(unreadKind\(unreadMarkOf\(cur\)\), le\);/, '못 읽은 값 위의 편집은 다시 읽힌 조회에서 버린다');
  assert.match(os2, /loadError: le, dirty: keep, settings: keep \? cur\.settings : r\.settings/, '표지는 조회마다 새로 둔다(펼침 병합에 예전 표지가 남지 않게)');
  const tc = webOf('views/ToolCategories.jsx');
  assert.match(tc, /if \(\(!inited\.current \|\| shouldReseed\(seedKind\.current, le\)\) && r\?\.settings\) \{/);
  assert.match(tc, /\{saveLocked\s*\? <div className="muted"[^>]*>[^<]*<\/div>\s*: <ToolNamesStages /, '못 읽은 동안 이름 · 단계 편집기를 열지 않는다');
  const st = webOf('views/SpecialTools.jsx');
  assert.match(st, /const ok = !!\(r && r\.settings && typeof r\.settings === 'object'\) && !unreadLe;/, '특수 기능 화면의 이름 · 단계 드로어도 못 읽은 설정으로 열지 않는다');
  const po = webOf('views/PowerOffCheckSettings.jsx');
  assert.match(po, /if \(!inited\.current \|\| shouldReseed\(seedKind\.current, le\)\) \{ inited\.current = true; seedKind\.current = unreadKind\(le\);/);
  const db = webOf('views/tools/DiskBadTool.jsx');
  assert.match(db, /<ScanPanel key=\{unreadKind\(unreadMarkOf\(data\)\) \|\| 'ok'\}/, '설정 파일 상태가 바뀌면 설정 칸을 다시 만든다(열 때의 값으로 채우는 칸)');
  const su = webOf('views/tools/StorageUsageTool.jsx');
  assert.match(su, /const unread = unreadMarkOf\(st\);\s*const saveLocked = saveLockedByUnread\(unread, \{ corruptLocks: true \}\);/);
  // Ping 측정 설정(쓰기 거절 함수가 없어 분류표 밖 — 112회차 전부터 화면이 표지로 편집을 잠근다): 그대로인지 고정한다
  assert.match(webOf('views/PingMonitor.jsx'), /const canEdit = isAdmin && st && !st\.loadError && st\.load != null;/);
  // 알림 설정은 화면이 둘이다(설정 › 알림 · 리포트 › 알림 채널) — 둘 다 잠근다
  assert.equal((webOf('views/Alerts2.jsx').match(/onClick=\{save\} disabled=\{!!lock \|\| saveLocked\}/g) || []).length, 3, '저장 단추 셋 모두');
  assert.match(webOf('views/Alerts2.jsx'), /if \(lock \|\| saveLocked\) return;/);
  const tr = webOf('views/ToolsReports.jsx');
  assert.match(tr, /setCfgUnread\(unreadMarkOf\(r\)\); setCfg\(r\.config\);/);
  assert.match(tr, /if \(lock \|\| cfgLocked\) return;/);
  assert.match(tr, /onClick=\{save\} disabled=\{!!lock \|\| cfgLocked\}/);
  const im = webOf('views/tools/IpmsSettings.jsx');
  assert.match(im, /if \(!saveLockedByUnread\(le\)\) \{ d\.load\(r\.settings\); setMeta\(metaOf\(r\)\); \}/, '못 읽은 조회로는 폼(편집 초안의 기준값)을 채우지 않는다');
});

test('C 디스크 점검 설정 저장: 409(엣지 노드) · 400 본문을 저장 성공으로 읽지 않는다(putJson 은 던지지 않고 본문을 준다)', async () => {
  const db = webOf('views/tools/DiskBadTool.jsx');
  assert.match(db, /putJson\('\/tools\/disk-bad\/settings', \{ \.\.\.patch, corpTo \}\)\.then\(\(r\) => \{ requireChanged\(r\); setSt\(r\.settings\);/, '판정한 뒤에만 설정 칸을 바꾼다');
  // 서버 전제: 엣지 노드의 저장은 409 {ok:false, reason} 이다 — 웹 putJson 은 409 를 던지지 않는다.
  assert.match(srcOf('routes/api/diskBad.js'), /api\.put\('\/tools\/disk-bad\/settings', adminOnly, fullScopeOnly, \(req, res\) => \{\s*if \(isEdge\(\)\) return res\.status\(409\)\.json\(EDGE_NODE\);/);
  assert.match(fs.readFileSync(path.join(WEB, 'api.js'), 'utf8'), /if \(!res\.ok && res\.status !== 409 && res\.status !== 400\) throw httpFail\(path, res, data\);/);
});

test('C 삭제 호출부 12곳: 409(등록부 읽기 오류 · 사용 중) · 400 본문을 삭제 성공으로 읽거나 조용히 삼키지 않는다', () => {
  /** [화면, 호출 식(판정 뒤에만 다음 줄로), 서버 라우트 파일, 그 라우트가 409 · 400 본문을 준다는 전제] */
  const CASES = [
    ['views/tools/SanSwitchTool.jsx', /requireChanged\(await delJson\(`\/tools\/sanswitch\/devices\/\$\{r\.id\}`\)\); await load\(\); setMsg\('삭제되었습니다\.'\);/,
      'routes/api/sanSwitch.js', /api\.delete\('\/tools\/sanswitch\/devices\/:id'[^\n]*\n\s*const refused = registryWriteRefusal\(\);[^\n]*\n\s*if \(refused\) return res\.status\(409\)\.json\(refused\);/],
    ['views/tools/PduTool.jsx', /requireChanged\(await delJson\(`\/tools\/pdu\/devices\/\$\{encodeURIComponent\(d\.id\)\}`\)\); await load\(\);/,
      'routes/api/pdu.js', /api\.delete\('\/tools\/pdu\/devices\/:id'[\s\S]{0,260}res\.status\(r\.ok \? 200 : \(r\.status \|\| 404\)\)\.json\(r\);/],
    ['views/tools/StorageMonTool.jsx', /requireChanged\(await delJson\(`\/tools\/storage\/devices\/\$\{encodeURIComponent\(r\.id\)\}`\)\); await load\(\);/,
      'routes/api/storageMon.js', /api\.delete\('\/tools\/storage\/devices\/:id'[^\n]*\n\s*const refused = registryWriteRefusal\(\);[^\n]*\n\s*if \(refused\) return res\.status\(409\)\.json\(refused\);/],
    ['views/tools/BmStorageTool.jsx', /requireChanged\(await delJson\(`\/tools\/bm-storage\/servers\/\$\{encodeURIComponent\(s\.id\)\}`\)\); refresh\(\);/,
      'routes/api/bmstor.js', /res\.status\(r\.ok \? 200 : \(r\.status \|\| 404\)\)\.json\(r\);/],
    ['views/Collectors.jsx', /requireChanged\(await delJson\(`\/admin\/collectors\/\$\{encodeURIComponent\(c\.id\)\}`\)\); await load\(\);/,
      'routes/admin/collectorsDc.js', /res\.status\(result\.ok \? 200 : \(result\.status \|\| 404\)\)\.json\(result\);/],
    ['views/RemoteAccess.jsx', /requireChanged\(await delJson\(`\/remote\/proxies\/\$\{p\.id\}`\)\);/,
      'routes/remote.js', /return res\.status\(409\)\.json\(\{ ok: false, code: 'proxy-in-use'/],
    ['views/ProxySettings.jsx', /requireChanged\(await delJson\(`\/remote\/proxies\/\$\{p\.id\}`\)\);/,
      'routes/remote.js', /res\.status\(r\.ok \? 200 : 400\)\.json\(r\);/],
    ['views/Collectors.jsx', /try \{ requireChanged\(await delJson\(`\/admin\/collectors\/\$\{encodeURIComponent\(id\)\}`\)\); n\+\+; \}/,   // 일괄 삭제 — 거절을 '삭제 완료' 수에 세지 않는다
      'routes/admin/collectorsDc.js', /res\.status\(result\.ok \? 200 : \(result\.status \|\| 404\)\)\.json\(result\);/],
    ['views/Collectors.jsx', /requireChanged\(await delJson\(`\/admin\/central\/agent-tokens\/\$\{encodeURIComponent\(agent\)\}`\)\); await loadAgentTok\(\);/,
      'routes/admin/centralTokens.js', /res\.status\(r\.ok \? 200 : \(r\.status === 409 \? 409 : 400\)\)\.json\(r\);/],
    ['views/AgentDeploy.jsx', /requireChanged\(await delJson\(`\/admin\/agent-deploy\/targets\/\$\{t\.id\}`\)\);/,
      'routes/admin/deployLlm.js', /res\.status\(r\.ok \? 200 : 400\)\.json\(r\);/],
    ['views/AgentScans.jsx', /requireChanged\(await delJson\(`\/admin\/assignments\/\$\{encodeURIComponent\(a\.agent\)\}`\)\); await load\(\);/,
      'routes/admin/horizonAssign.js', /res\.status\(result\.ok \? 200 : \(result\.status \|\| 404\)\)\.json\(result\);/],
    ['views/tools/CvpTool.jsx', /requireChanged\(await delJson\(`\/tools\/cvp\/servers\/\$\{encodeURIComponent\(s\.id\)\}`\)\); await loadAll\(\);/,
      'routes/api/cvp.js', /const refused = registryWriteRefusal\(\);[^\n]*\n\s*if \(refused\) return res\.status\(409\)\.json\(refused\);\s*\n[^\n]*\n?\s*if \(!deleteServer\(req\.params\.id\)\)/],
  ];
  for (const [screen, callRe, route, routeRe] of CASES) {
    assert.match(webOf(screen), callRe, `${screen}: 판정(requireChanged)한 뒤에만 목록을 다시 읽고 성공을 말한다`);
    assert.match(srcOf(route), routeRe, `${route}: 이 삭제는 409 · 400 본문을 준다(전제)`);
  }
});

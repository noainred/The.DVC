/**
 * upgradeAuto2736_2.test.js — v2.736.2: 업그레이드 화면이 '자동 업그레이드가 왜 안 되는지 · 다음 확인은 언제인지' 를 말한다.
 *
 * 사용자 신고(2026-10-15): "아직도 자동 업그레이드가 안되고 동일한 메시지가 있어, 서명 필수". 게시된 2.736.1 은 실제 코드로
 * 서명 필수 정책에서 통과·설치됐다 — '마지막 검증 없음' 은 서명이 막은 것이 아니라 **업그레이드를 시도하지 않았다** 는 뜻이었다.
 * 화면은 시도하지 않는 이유(주기 0분 · 자동 적용 꺼짐 · 설치 경로 없음 · 확인 실패)를 말하지 않았고, 확인·적용 기록은 재시작마다 사라졌다.
 *
 *  ① 판정 — 다섯 상태와 사유 코드(꺼짐·소스 없음·주기 0·자동 적용 꺼짐·설치 경로 없음·확인 실패·적용 실패)
 *  ② 다음 확인 시각 = 무장 시각 + 주기의 배수(setInterval 규칙) · 꺼짐이면 null
 *  ③ 실제 매니저: 주기 0 이면 타이머 없음 → state 'manual' · 주기·자동 적용이 있으면 무장·다음 확인 시각
 *  ④ 백그라운드 확인 결과(lastTick) — 새 버전 있음(자동 적용 꺼짐)·설치 경로 없음(적용 실패)·확인 실패를 남긴다
 *  ⑤ 재시작 뒤에도 기록이 보인다(파일) · 되살린 '새 버전 있음' 은 지금 버전 기준으로 다시 계산 · import 만으로는 쓰지 않는다
 *  ⑥ 정제 — 아는 필드만 · 주소의 계정·쿼리 제거 · 손상 파일 보존 후 새로 시작 · 파일 권한 0600 · 상태 파일 등록
 *  ⑦ 엣지·수집기 push 수신 결과도 기록한다(routes 소스)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'upg-auto-'));
Object.assign(process.env, { CONFIG_DIR: CFG, DATA_SOURCE: 'mock' });
for (const k of ['UPGRADE_ENABLED', 'UPGRADE_POLL_INTERVAL_MS', 'UPGRADE_AUTO_APPLY', 'UPGRADE_INSTALL_DIR', 'UPGRADE_REMOTE_BASE', 'UPGRADE_WATCH_DIR', 'EDGE_MODE', 'CENTRAL_URL']) delete process.env[k];

const auto = await import('../src/upgrade/autoState.js');
const store = await import('../src/upgrade/statusStore.js');
const { UpgradeManager } = await import('../src/upgrade/manager.js');
const { isRegisteredStateFile } = await import('../src/util/stateFiles.js');
const { currentVersion } = await import('../src/config.js');

const NOW = Date.UTC(2026, 9, 15, 2, 30, 0); // 고정 기준 시각(정시와 떨어뜨림 — CLAUDE.md 규약)
const codes = (st) => st.issues.map((i) => i.code);
const base = { enabled: true, remoteBase: 'https://example.invalid/downloads', installDir: '/opt/vmware-portal/app', autoApply: true };

test('① 판정 — 다섯 상태와 사유 코드', () => {
  let st = auto.autoUpgradeState({ settings: { ...base, enabled: false }, intervalMs: 3_600_000, armedAt: NOW, now: NOW });
  assert.equal(st.state, 'off'); assert.deepEqual(codes(st), ['disabled']); assert.equal(st.nextCheckAt, null);

  st = auto.autoUpgradeState({ settings: base, intervalMs: 0, armedAt: null, now: NOW });
  assert.equal(st.state, 'manual', '주기 0 이면 자동 확인을 하지 않는다 — 자동 적용이 켜져 있어도 일어나지 않는다');
  assert.deepEqual(codes(st), ['no-interval']); assert.equal(st.nextCheckAt, null);

  st = auto.autoUpgradeState({ settings: { ...base, autoApply: false }, intervalMs: 3_600_000, armedAt: NOW, now: NOW });
  assert.equal(st.state, 'check-only'); assert.deepEqual(codes(st), ['no-auto-apply']);

  st = auto.autoUpgradeState({ settings: { ...base, installDir: '' }, intervalMs: 3_600_000, armedAt: NOW, now: NOW });
  assert.equal(st.state, 'blocked'); assert.deepEqual(codes(st), ['no-install-dir']);

  st = auto.autoUpgradeState({ settings: { ...base, remoteBase: '', watchDir: '' }, intervalMs: 3_600_000, armedAt: NOW, now: NOW });
  assert.equal(st.state, 'blocked'); assert.ok(codes(st).includes('no-source'));

  st = auto.autoUpgradeState({ settings: base, intervalMs: 3_600_000, armedAt: NOW, now: NOW });
  assert.equal(st.state, 'on'); assert.deepEqual(codes(st), []); assert.equal(st.armed, true);

  // 확인 실패 · 적용 실패 — 상태는 그대로 두고 사유를 더한다. '이미 최신' 은 실패가 아니다.
  st = auto.autoUpgradeState({ settings: base, intervalMs: 3_600_000, armedAt: NOW, now: NOW,
    lastCheck: { at: NOW - 1000, remote: { ok: false, error: '원격 소스(versions.json) 접속 실패: ENOTFOUND' } } });
  assert.equal(st.state, 'on'); assert.deepEqual(codes(st), ['check-failed']); assert.match(st.issues[0].reason, /ENOTFOUND/);
  st = auto.autoUpgradeState({ settings: base, intervalMs: 3_600_000, armedAt: NOW, now: NOW,
    lastResult: { at: NOW - 1000, ok: false, reason: '서명 검증 실패 — 서명 manifest 가 없습니다' } });
  assert.deepEqual(codes(st), ['apply-failed']);
  st = auto.autoUpgradeState({ settings: base, intervalMs: 3_600_000, armedAt: NOW, now: NOW,
    lastResult: { at: NOW - 1000, ok: false, upToDate: true, reason: 'already up to date (2.736.1)' } });
  assert.deepEqual(codes(st), [], "'이미 최신' 을 적용 실패로 세지 않는다");
  for (const i of [...auto.AUTO_CODES]) assert.ok(typeof i === 'string' && i);
});

test('② 다음 확인 시각 — 무장 시각 + 주기의 배수 · 모르면 null', () => {
  const H = 3_600_000;
  assert.equal(auto.nextCheckAt({ armedAt: NOW, intervalMs: H, now: NOW }), NOW + H);
  assert.equal(auto.nextCheckAt({ armedAt: NOW, intervalMs: H, now: NOW + 10 * 60_000 }), NOW + H);
  assert.equal(auto.nextCheckAt({ armedAt: NOW, intervalMs: H, now: NOW + H }), NOW + 2 * H, '경계에서는 다음 칸');
  assert.equal(auto.nextCheckAt({ armedAt: NOW, intervalMs: H, now: NOW + 5 * H + 1 }), NOW + 6 * H);
  assert.equal(auto.nextCheckAt({ armedAt: NOW, intervalMs: 0, now: NOW }), null);
  assert.equal(auto.nextCheckAt({ armedAt: null, intervalMs: H, now: NOW }), null);
});

/** 설정을 메모리에서만 바꾼 매니저(저장·타이머 없음) — tick()/check() 를 직접 부른다. */
function makeManager(settings) {
  const m = new UpgradeManager();
  m.settings = { ...m.settings, ...settings };
  return m;
}

test('③ 실제 매니저 — 주기 0 이면 타이머 없음(manual) · 주기가 있으면 무장 + 다음 확인 시각', async (t) => {
  const watch = fs.mkdtempSync(path.join(CFG, 'w-'));
  // updateSettings = 저장(upgrade.json) + 타이머 재무장 — 화면에서 '설정 저장' 을 누른 것과 같은 경로
  const m0 = new UpgradeManager();
  m0.updateSettings({ enabled: true, watchDir: watch, remoteBase: '', installDir: '', autoApply: true, pollIntervalMs: 0 });
  const s0 = m0.status();
  assert.equal(m0.timer, null, '주기 0 이면 타이머를 무장하지 않는다');
  assert.equal(s0.auto.state, 'manual'); assert.equal(s0.auto.armed, false); assert.equal(s0.auto.nextCheckAt, null);
  assert.ok(codes(s0.auto).includes('no-interval'));

  const m1 = new UpgradeManager();
  const before = Date.now();
  m1.updateSettings({ enabled: true, watchDir: watch, remoteBase: '', installDir: '/tmp/x', autoApply: true, pollIntervalMs: 3_600_000 });
  t.after(() => { if (m1.timer) clearInterval(m1.timer); });
  const s1 = m1.status();
  assert.equal(s1.auto.armed, true);
  assert.ok(s1.auto.nextCheckAt >= before + 3_600_000 && s1.auto.nextCheckAt <= Date.now() + 3_600_000, '다음 확인 = 무장 + 1시간');
  assert.equal(s1.auto.intervalMs, 3_600_000);
  assert.equal(s1.auto.state, 'on');
  clearInterval(m1.timer); m1.timer = null;
  assert.equal(m1.status().auto.nextCheckAt, null, '무장하지 않은 상태에서는 다음 확인 시각을 지어내지 않는다');
  await new Promise((r) => setTimeout(r, 50)); // 무장 때 시작한 즉시 확인(빈 감시 폴더)이 끝나게
});

test('④ 백그라운드 확인 결과를 남긴다 — 새 버전(자동 적용 꺼짐) · 적용 실패(설치 경로 없음) · 확인 실패', async () => {
  const watch = fs.mkdtempSync(path.join(CFG, 'w-'));
  fs.writeFileSync(path.join(watch, 'vmware-portal-99.0.0.tar.gz'), 'x');

  const a = makeManager({ enabled: true, watchDir: watch, remoteBase: '', installDir: '/tmp/none', autoApply: false, pollIntervalMs: 0 });
  await a.tick();
  assert.equal(a.lastTick.outcome, 'available'); assert.equal(a.lastTick.latest, '99.0.0');
  assert.ok(a.lastTick.finishedAt >= a.lastTick.at);
  assert.equal(a.lastCheck.trigger, 'auto', '백그라운드 확인은 trigger auto');
  assert.equal(a.lastResult, null, '자동 적용이 꺼져 있으면 적용하지 않는다');

  const b = makeManager({ enabled: true, watchDir: watch, remoteBase: '', installDir: '', autoApply: true, pollIntervalMs: 0 });
  await b.tick();
  assert.equal(b.lastTick.outcome, 'apply-failed');
  assert.match(b.lastTick.reason, /설치 경로/);
  assert.equal(b.lastResult.ok, false); assert.equal(b.lastResult.code, 'no-install-dir');
  assert.equal(b.lastResult.trigger, 'auto');
  assert.ok(codes(b.status().auto).includes('apply-failed'), '설치 경로가 없어 멈춘 자동 적용이 화면에 남는다');

  const c = makeManager({ enabled: true, watchDir: '', remoteBase: 'http://127.0.0.1:1/dl', installDir: '/tmp/x', autoApply: true, pollIntervalMs: 0 });
  await c.tick();
  assert.equal(c.lastTick.outcome, 'check-failed');
  assert.ok(c.lastTick.reason, '실패 사유를 싣는다');
  assert.ok(codes(c.status().auto).includes('check-failed'));
  // 수동 확인은 trigger manual
  await c.check();
  assert.equal(c.lastCheck.trigger, 'manual');
});

test('⑤ 재시작 뒤에도 기록이 보인다 · 되살린 새 버전 표시는 지금 버전 기준 · import 만으로는 쓰지 않는다', async () => {
  const file = store.upgradeStatusFile();
  assert.equal(fs.existsSync(file), false, '테스트가 만든 매니저들은 persistence 를 켜지 않았다 — 파일이 없어야 한다');

  const cur = currentVersion();
  const watch = fs.mkdtempSync(path.join(CFG, 'w-'));
  fs.writeFileSync(path.join(watch, 'vmware-portal-99.0.0.tar.gz'), 'x');
  const a = makeManager({ enabled: true, watchDir: watch, remoteBase: '', installDir: '', autoApply: true, pollIntervalMs: 0 });
  a.enablePersistence(file);
  await a.tick();
  assert.equal(fs.existsSync(file), true, '서버가 켜면 남긴다');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  // '재시작' — 새 매니저가 파일을 읽는다
  const b = makeManager({ enabled: true, watchDir: watch, remoteBase: '', installDir: '', autoApply: true, pollIntervalMs: 0 });
  b.enablePersistence(file);
  const st = b.status();
  assert.equal(st.lastTick.outcome, 'apply-failed'); assert.equal(st.lastTick.restored, true);
  assert.equal(st.lastResult.restored, true); assert.equal(st.lastResult.code, 'no-install-dir');
  assert.equal(st.lastCheck.restored, true);
  assert.equal(st.lastCheck.watch.available, true, '99.0.0 은 지금 버전보다 새것 — 그대로 새 버전');
  assert.ok(st.persist.enabled);

  // 재시작 전 '새 버전 있음' 이 이미 설치된 버전이면 '없음' 으로 다시 계산한다
  const doc = { lastCheck: { at: NOW, current: '2.0.0', remote: { ok: true, available: true, latest: cur, current: '2.0.0' } } };
  const r = auto.restoreStatus(doc, cur);
  assert.equal(r.lastCheck.remote.available, false, '이미 그 버전이 설치됐다 — 새 버전으로 보이면 안 된다');
  const r2 = auto.restoreStatus({ lastCheck: { at: NOW, remote: { ok: false, available: true, latest: '99.0.0', error: 'x' } } }, cur);
  assert.equal(r2.lastCheck.remote.available, false, '실패한 확인의 available 은 되살리지 않는다');
});

test('⑥ 정제 — 아는 필드만 · 주소의 계정·쿼리 제거 · 손상 보존 · 상태 파일 등록', () => {
  const c = auto.sanitizeCheck({ at: NOW, current: '2.736.0', trigger: 'auto', evil: 'x', watch: { available: true, version: '2.736.1', path: '/w/a.tar.gz' },
    remote: { ok: true, available: true, latest: '2.736.1', source: 'https://user:pw@mirror.example/dl/versions.json?token=SECRET', downloadUrl: 'https://mirror/x?token=SECRET', manifestUrl: 'https://m/x?token=SECRET' } });
  const j = JSON.stringify(c);
  assert.equal(j.includes('SECRET'), false, '토큰이 실린 쿼리를 싣지 않는다');
  assert.equal(j.includes('pw@'), false, '주소의 계정을 싣지 않는다');
  assert.equal('evil' in c, false); assert.equal('downloadUrl' in c.remote, false);
  assert.equal(auto.sanitizeCheck({ at: 'x' }), null, '시각이 없는 기록은 버린다');

  const r = auto.sanitizeResult({ at: NOW, ok: false, reason: 'r'.repeat(5000), check: { source: 'https://a:b@x/dl?token=SECRET', latest: '2.736.1' }, signature: { verified: false, code: 'manifest-missing', policy: 'require', where: 'remote', extra: 1 } });
  assert.ok(r.reason.length <= 800);
  assert.equal(JSON.stringify(r).includes('SECRET'), false);
  assert.deepEqual(Object.keys(r.signature).sort(), ['code', 'keyId', 'policy', 'verified', 'version', 'warned', 'where'].sort());

  const t = auto.sanitizeTick({ at: NOW, outcome: 'zzz', reason: 'y' });
  assert.equal(t.outcome, 'error', '모르는 결과는 error');

  // 손상 파일 — 보존 후 새로 시작, 사실을 상태에 싣는다
  const dir = fs.mkdtempSync(path.join(CFG, 'bad-'));
  const f = path.join(dir, 'upgrade-status.json');
  fs.writeFileSync(f, '{not json');
  const m = new UpgradeManager();
  m.enablePersistence(f);
  assert.match(m.status().persist.error, /손상/);
  assert.ok(fs.readdirSync(dir).some((n) => n.startsWith('upgrade-status.json.corrupt.')), '원본을 보존한다');

  assert.equal(isRegisteredStateFile('upgrade-status.json'), true, "백업 '설정 변경' 감시에서 빠진다");
});

test('⑦ 엣지·수집기 push 수신 결과도 기록한다 · 서버 시작이 기록을 켠다', () => {
  const src = (p) => stripComments(fs.readFileSync(path.join(HERE, '..', 'src', p), 'utf8'));
  assert.match(src('routes/collector.js'), /upgradeManager\.lastResult\s*=\s*\{[^}]*source:\s*'collector-push'/);
  assert.match(src('routes/upgrade.js'), /upgradeManager\.lastResult\s*=\s*\{[^}]*source:\s*'edge-push'/);
  const mgr = src('upgrade/manager.js');
  assert.match(mgr, /start\(\)\s*\{\s*this\.enablePersistence\(\)/, 'start() 가 기록을 켠다(서버 프로세스만)');
  assert.match(mgr, /set lastResult\(v\)\s*\{[^}]*#save\(\)/, '대입하면 파일에도 남는다');
});

test('⑧ 리뷰 확정분 — 지난 실패는 지금 사유가 아니다 · 확인할 곳이 없으면 최신이라 기록하지 않는다', async () => {
  const on = { ...base, pollIntervalMs: 3_600_000 };
  // F1: 엣지가 원격으로 먼저 올라간 뒤 중앙 push 로 같은 번들을 받으면 'not newer' — 설치할 것이 없었던 것이지 실패가 아니다.
  const notNewer = { at: NOW - 60_000, source: 'collector-push', ok: false, reason: 'not newer (2.736.2 <= 2.736.2)', version: '2.736.2' };
  assert.equal(auto.failureMoot(notNewer, null, '2.736.2'), true, '대상 버전이 지금 버전이면 지난 일이다');
  let st = auto.autoUpgradeState({ settings: on, intervalMs: 3_600_000, armedAt: NOW, lastResult: auto.sanitizeResult(notNewer), currentVersion: '2.736.2', now: NOW });
  assert.equal(codes(st).includes('apply-failed'), false);
  const upg = stripComments(fs.readFileSync(path.join(HERE, '..', 'src', 'upgrade', 'upgrade.js'), 'utf8'));
  assert.match(upg, /reason: `not newer \([^`]*\)`, version: vstr\(newV\), upToDate: true/, "설치 함수 자체도 '설치할 것 없음' 을 upToDate 로 밝힌다");
  // F2: 실패 뒤 다른 경로로 그 버전을 설치했다(재시작 후 되살린 기록) — 대상 버전 2.736.2 == 지금 버전.
  const failed = { at: NOW - 3 * 86_400_000, ok: false, reason: 'download HTTP 404', check: { latest: '2.736.2' } };
  const restored = auto.restoreStatus({ lastResult: failed }, '2.736.2').lastResult;
  st = auto.autoUpgradeState({ settings: on, intervalMs: 3_600_000, armedAt: NOW, lastResult: restored, currentVersion: '2.736.2', now: NOW });
  assert.equal(codes(st).includes('apply-failed'), false, '이미 설치된 버전의 지난 실패를 말하지 않는다');
  // F2: 대상이 아직 새 버전이면 실패는 지금 사유다(지우지 않는다)
  st = auto.autoUpgradeState({ settings: on, intervalMs: 3_600_000, armedAt: NOW, lastResult: restored, currentVersion: '2.736.1', now: NOW });
  assert.equal(codes(st).includes('apply-failed'), true);
  // F2: 그 뒤의 자동 확인이 '최신' 이었다(versions.json 되돌림) — 지난 실패
  const later = { at: NOW - 3_600_000, outcome: 'up-to-date', latest: '2.736.1' };
  st = auto.autoUpgradeState({ settings: on, intervalMs: 3_600_000, armedAt: NOW, lastResult: restored, lastTick: later, currentVersion: '2.736.1', now: NOW });
  assert.equal(codes(st).includes('apply-failed'), false);
  // 대상 버전을 모르면 버전으로는 지우지 않는다(지어내지 않는다)
  assert.equal(auto.failureMoot({ at: NOW, ok: false, reason: 'x' }, null, '2.736.2'), false);
  assert.equal(auto.failureMoot({ at: NOW, ok: true }, null, '2.736.2'), false);
  // 실제 매니저 status() 가 지금 버전을 넘긴다
  const m = makeManager({ ...on, pollIntervalMs: 0 });
  m.lastResult = { at: NOW, ok: false, reason: `not newer (${currentVersion()} <= ${currentVersion()})`, version: currentVersion() };
  assert.equal(codes(m.status().auto).includes('apply-failed'), false, 'status() 가 currentVersion 을 판정에 넘긴다');

  // F3: 원격 소스·감시 폴더가 둘 다 없으면 아무것도 확인하지 않았다 — '최신' 이 아니라 'no-source'
  const n = makeManager({ enabled: true, watchDir: '', remoteBase: '', installDir: '/tmp/x', autoApply: true, pollIntervalMs: 0 });
  await n.tick();
  assert.equal(n.lastTick.outcome, 'no-source');
  assert.ok(auto.TICK_OUTCOMES.includes('no-source'));
  assert.equal(auto.sanitizeTick(n.lastTick).outcome, 'no-source', "정제가 'error' 로 바꾸지 않는다");
});

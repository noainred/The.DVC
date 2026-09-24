/**
 * v2.605 감사 그룹 e — 웹 화면·숫자 설정 빈 칸 회귀.
 *  WEB2605-01·RECENT2605-06 폴더 사용량 빈 칸·0 · WEB2605-05·06 알림 임계 빈 칸·문구 · WEB2605-08 파트 장애 늦은 응답 ·
 *  LEFT2605-02 svcmon 로그 설정 빈 칸 · LEFT2605-06 IPAM 스캔 설정 빈 칸 · TIM2605-04(scanStore 디바운스 env).
 *  WEB2605-03(끊긴 호스트 사용률)은 웹 vitest(web/src/views/vcdOverview.test.js)가 판정을, 여기서는 소스 사용처를 고정한다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2605e-'));
process.env.CONFIG_DIR = TMP;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(HERE, '..', '..', 'web', 'src');
const webSrc = (rel) => stripComments(fs.readFileSync(path.join(WEB, rel), 'utf8'));

// ── WEB2605-01 · RECENT2605-06 ────────────────────────────────────────────
test('RECENT2605-06: 폴더 사용량 보존일 0·음수·빈 값은 미지정(이전 값 유지) — 하루치로 줄지 않는다', async () => {
  const { save, invalidate } = await import('../src/dirusage/settings.js');
  invalidate();
  assert.equal(save({ retentionDays: 400 }).retentionDays, 400);
  assert.equal(save({ retentionDays: 0 }).retentionDays, 400, '0 은 1일로 클램프되면 안 된다');
  assert.equal(save({ retentionDays: '0' }).retentionDays, 400);
  assert.equal(save({ retentionDays: -5 }).retentionDays, 400);
  assert.equal(save({ retentionDays: '' }).retentionDays, 400);
  assert.equal(save({ retentionDays: 5000 }).retentionDays, 3650, '명시적 숫자는 범위로 자른다');
  assert.equal(save({ retentionDays: 30 }).retentionDays, 30);
});

test('WEB2605-01: 대상의 Top N·주기 칸이 비면 같은 id 의 기존 값(새 대상이면 기본값)을 유지한다', async () => {
  const { save, invalidate, validate, targetIssue } = await import('../src/dirusage/settings.js');
  invalidate();
  const base = { agent: 'edge-a', path: '/mnt/share' };
  save({ targets: [{ ...base, id: 'a', topN: 30, intervalHours: 48 }] });
  const s = save({ targets: [{ ...base, id: 'a', topN: '', intervalHours: undefined }, { ...base, id: 'b', path: '/mnt/b', topN: '', intervalHours: '' }] });
  const a = s.targets.find((t) => t.id === 'a');
  const b = s.targets.find((t) => t.id === 'b');
  assert.equal(a.topN, 30); assert.equal(a.intervalHours, 48, '빈 칸이 1시간(24배 du 스캔)이 되면 안 된다');
  assert.equal(b.topN, 20); assert.equal(b.intervalHours, 24);
  // 라우트 검증도 빈 칸을 '미지정' 으로 통과시킨다(저장이 기존 값으로 채운다). 명시한 범위 밖 값은 여전히 거절.
  assert.equal(targetIssue({ ...base, topN: '', intervalHours: undefined }), null);
  assert.equal(validate({ targets: [{ ...base, id: 'a', topN: '' }] }).length, 0);
  assert.match(targetIssue({ ...base, topN: 0, intervalHours: 24 }) || '', /Top N/);
  assert.match(targetIssue({ ...base, topN: 20, intervalHours: 9999 }) || '', /주기/);
});

test('WEB2605-01: 화면은 숫자 칸의 원문을 상태에 두고 전송 때 blankOr — onChange 에서 Number() 금지 + 저장 응답으로 대상 갱신', () => {
  const s = webSrc('views/DirUsageSettings.jsx');
  assert.doesNotMatch(s, /Number\(e\.target\.value\)/, 'onChange 에서 Number() 를 하면 빈 칸이 이미 0 이라 blankOr 가 거르지 못한다');
  assert.match(s, /topN:\s*blankOr\(t\.topN\)/);
  assert.match(s, /intervalHours:\s*blankOr\(t\.intervalHours\)/);
  assert.match(s, /retentionDays:\s*blankOr\(retentionDays\)/);
  assert.match(s, /setTargets\(r\.settings\.targets/);
});

// ── WEB2605-05 · WEB2605-06 ───────────────────────────────────────────────
test('WEB2605-05: 알림 임계치 빈 값·0·음수는 이전 값 유지, 범위 밖은 자른다 — 화면 0 · 실제 90 불일치 제거', async () => {
  const { saveAlertConfig, loadAlertConfig, normalizeRuleThreshold, mergeRules } = await import('../src/alerts.js');
  let c = saveAlertConfig({ rules: { datastorePct: { enabled: true, threshold: 85 } } });
  assert.equal(c.rules.datastorePct.threshold, 85);
  c = saveAlertConfig({ rules: { datastorePct: { enabled: true, threshold: 0 } } });   // 예전 웹의 Number('')
  assert.equal(c.rules.datastorePct.threshold, 85, '0 이 저장·표시되면서 평가는 90 이었다');
  c = saveAlertConfig({ rules: { datastorePct: { enabled: true, threshold: '' } } });
  assert.equal(c.rules.datastorePct.threshold, 85);
  c = saveAlertConfig({ rules: { datastorePct: { enabled: true, threshold: -5 } } });
  assert.equal(c.rules.datastorePct.threshold, 85, '음수가 저장되면 전 데이터스토어가 발화한다');
  c = saveAlertConfig({ rules: { datastorePct: { enabled: true } } });                 // 키 없음 = 유지
  assert.equal(c.rules.datastorePct.threshold, 85);
  c = saveAlertConfig({ rules: { datastorePct: { enabled: true, threshold: 150 } } });
  assert.equal(c.rules.datastorePct.threshold, 100);
  assert.equal(loadAlertConfig().rules.datastorePct.threshold, 100);
  assert.equal(normalizeRuleThreshold('vcpuPerCore', '4.5', 5), 4.5);
  assert.equal(normalizeRuleThreshold('ramOvercommitPct', null, 120), 120);
  // 다른 필드(perVcenter)·객체 아닌 규칙은 망가뜨리지 않는다
  const m = mergeRules({ massVmPowerOff: { enabled: true, threshold: 10, perVcenter: { v1: 3 } } }, { massVmPowerOff: { enabled: false, threshold: '' }, bogus: 'x' });
  assert.deepEqual(m.massVmPowerOff, { enabled: false, threshold: 10, perVcenter: { v1: 3 } });
  assert.equal('bogus' in m, false);
});

test('WEB2605-05·06: 알림 화면은 빈 칸을 보내지 않고, 주기 변경이 재시작 없이 적용된다고 말한다', () => {
  const s = webSrc('views/Alerts2.jsx');
  assert.doesNotMatch(s, /Number\(e\.target\.value\)/);
  assert.match(s, /threshold:\s*blankOr\(v\.threshold\)/);
  assert.match(s, /putJson\('\/admin\/alerts',\s*toBody\(c\)\)/);
  assert.doesNotMatch(s, /재시작 후 적용/, '저장 즉시 rescheduleAlertEngine 이 재적용한다');
});

// ── WEB2605-08 ───────────────────────────────────────────────────────────
test('WEB2605-08: 파트 장애 이벤트 기간 효과는 늦게 온 이전 응답을 버린다', () => {
  const s = webSrc('views/tools/PartFaults.jsx');
  const m = s.match(/useEffect\(\(\) => \{\s*if \(tab !== 'events'\)[\s\S]*?\}, \[tab, days\]\);/);
  assert.ok(m, '이벤트 효과를 찾지 못했다');
  assert.match(m[0], /let active = true/);
  assert.match(m[0], /if \(active\) setEvents\(r\)/);
  assert.match(m[0], /return \(\) => \{ active = false; \}/);
});

// ── LEFT2605-02 ──────────────────────────────────────────────────────────
test('LEFT2605-02: svcmon 로그 설정의 빈 숫자 칸은 이전 값 유지 — 보관 1개·상한 0(무제한)으로 바뀌지 않는다', async () => {
  const { setLogSettings, _resetLogSettingsCache, cleanLogPatch } = await import('../src/svcmon/logsettings.js');
  _resetLogSettingsCache();
  setLogSettings({ keepFiles: 90, maxFileMB: 512, maxTotalMB: 20000 });
  let r = setLogSettings({ keepFiles: '', maxFileMB: '', maxTotalMB: '' });
  assert.deepEqual([r.keepFiles, r.maxFileMB, r.maxTotalMB], [90, 512, 20000]);
  r = setLogSettings({ keepFiles: undefined, maxFileMB: null, maxTotalMB: 'abc' });
  assert.deepEqual([r.keepFiles, r.maxFileMB, r.maxTotalMB], [90, 512, 20000]);
  r = setLogSettings({ maxTotalMB: '0' });
  assert.equal(r.maxTotalMB, 0, "명시적 '0' 은 무제한(하한 100 으로 바뀌지 않는다)");
  r = setLogSettings({ maxTotalMB: 30000, keepFiles: '30' });
  assert.deepEqual([r.keepFiles, r.maxTotalMB], [30, 30000]);
  assert.deepEqual(cleanLogPatch({ __proto__: { x: 1 }, keepFiles: '' }), {});
});

test('LEFT2605-02: svcmon 로그 설정 화면 두 곳은 blankOr 로 보낸다', () => {
  for (const f of ['views/svcmon/LogSettingsTab.jsx', 'views/SvcMonitor.jsx']) {
    const s = webSrc(f);
    assert.doesNotMatch(s, /keepFiles:\s*Number\(/, f);
    assert.doesNotMatch(s, /maxTotalMB:\s*Number\(/, f);
    assert.match(s, /maxTotalMB:\s*blankOr\(/, f);
  }
});

// ── LEFT2605-06 · TIM2605-04 ─────────────────────────────────────────────
test('LEFT2605-06: IPAM 스캔 설정의 빈 값은 이전 값 유지 — 주기 1분·동시성 1·보존 0 이 되지 않는다', async () => {
  const { saveScanSettings } = await import('../src/ipam/scanStore.js');
  saveScanSettings('edge-x', { intervalMs: 12 * 3_600_000, retentionDays: 90, concurrency: 64, timeoutMs: 900 });
  let n = saveScanSettings('edge-x', { intervalMs: '', retentionDays: '', concurrency: '', timeoutMs: null });
  assert.deepEqual([n.intervalMs, n.retentionDays, n.concurrency, n.timeoutMs], [12 * 3_600_000, 90, 64, 900]);
  n = saveScanSettings('edge-x', { retentionDays: 0 });
  assert.equal(n.retentionDays, 0, '명시적 0 보존일(정리 안 함)은 허용된 값');
  n = saveScanSettings('edge-x', { intervalMs: 1000, concurrency: 99999 });
  assert.deepEqual([n.intervalMs, n.concurrency], [60_000, 1024], '명시한 숫자는 범위로 자른다');
});

test('TIM2605-04: IPAM_WRITE_DEBOUNCE_MS 는 [100ms, 10분] — 음수·2^31 초과가 1ms 가 되지 않는다', async () => {
  const { writeDebounceMsFromEnv } = await import('../src/ipam/scanStore.js');
  assert.equal(writeDebounceMsFromEnv(undefined), 1500);
  assert.equal(writeDebounceMsFromEnv(''), 1500);
  assert.equal(writeDebounceMsFromEnv('-5'), 1500);
  assert.equal(writeDebounceMsFromEnv('3000000000'), 600_000);
  assert.equal(writeDebounceMsFromEnv('10'), 100);
  assert.equal(writeDebounceMsFromEnv('2000'), 2000);
  const src = stripComments(fs.readFileSync(path.join(HERE, '..', 'src', 'ipam', 'scanStore.js'), 'utf8'));
  assert.doesNotMatch(src, /Number\(process\.env\.IPAM_WRITE_DEBOUNCE_MS\)\s*\|\|/);
});

test('LEFT2605-06: IPAM 스캔 화면은 숫자 칸 원문을 상태에 두고 ipamScanForm 으로 보낸다', () => {
  const s = webSrc('views/tools/IpamSettings.jsx');
  assert.doesNotMatch(s, /retentionDays:\s*Number\(e\.target\.value\)/);
  assert.doesNotMatch(s, /concurrency:\s*Number\(e\.target\.value\)/);
  assert.match(s, /scanSettingsBody\(s, agent\)/);
});

// ── WEB2605-03 ───────────────────────────────────────────────────────────
test('WEB2605-03: vCenter 상세 트리의 클러스터 평균·호스트 막대는 끊긴 호스트를 빼는 헬퍼를 쓴다', () => {
  const s = webSrc('views/VCenterDetail.jsx');
  assert.match(s, /clusterAvgPct\(chosts, 'cpuUsagePct'\)/);
  assert.match(s, /cpu=\{hostUsagePct\(h, 'cpuUsagePct'\)\}/);
  assert.doesNotMatch(s, /h\.cpuUsagePct \|\| 0/);
});

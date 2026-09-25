/**
 * v2.602 감사 그룹 e — 설정 숫자 칸·타이머·DB open·경로 정규식 회귀.
 * LEFT2602-01·02·03·05 · TIM2602-01~05 · SEC2602-04 · DB2602-03.
 * 기준 시각에 Date.now() 를 쓰지 않는다 — 보존 경계보다 한참 과거인 고정 시각(2001년)만 쓴다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2602e-'));
process.env.CONFIG_DIR = DIR;
process.env.DIRUSAGE_DB_PATH = path.join(DIR, 'dirusage.db');
process.env.VMTRACK_DB_PATH = path.join(DIR, 'vm-track.db');
// TIM2602-04: 손으로 고친 로그인 모니터 설정(로드 경로) — import 전에 둔다.
fs.writeFileSync(path.join(DIR, 'login-monitor.json'), JSON.stringify({ intervalMin: 0, days: -3, threshold: 'abc', windowMin: 99999 }));

test('LEFT2602-01: 배포 대상 lastResult 만 바뀌면 설정 지문이 같다', async () => {
  const { settingsFingerprint } = await import('../src/backup/service.js');
  const base = { targets: [{ id: 't1', host: '10.0.0.1', port: 22, username: 'root' }] };
  const r1 = { targets: [{ ...base.targets[0], lastResult: { at: 1, ok: true } }] };
  const r2 = { targets: [{ ...base.targets[0], lastResult: { at: 2, ok: false, reason: 'x' } }] };
  const fp = (o) => settingsFingerprint({ 'agent-deploy-targets.json': JSON.stringify(o) });
  assert.equal(fp(r1), fp(base));
  assert.equal(fp(r2), fp(base));
  // 설정(host) 변경은 여전히 지문을 바꾼다
  assert.notEqual(fp({ targets: [{ ...base.targets[0], host: '10.0.0.2' }] }), fp(base));
});

test('LEFT2602-02: 통신 점검 숫자 칸의 빈 값은 이전 값을 유지한다', async () => {
  const { saveLinkCheckSettings, normalizeSettings } = await import('../src/linkcheck/settings.js');
  saveLinkCheckSettings({ intervalMs: 15 * 60_000, sampleRetentionDays: 120, eventRetentionDays: 45 });
  const s = saveLinkCheckSettings({ intervalMs: '', sampleRetentionDays: '', eventRetentionDays: null, concurrency: '  ' });
  assert.equal(s.intervalMs, 15 * 60_000);
  assert.equal(s.sampleRetentionDays, 120);
  assert.equal(s.eventRetentionDays, 45);
  assert.equal(s.concurrency, 6);
  // 정규화 단독에서도 빈 값은 하한이 아니라 기본값
  assert.equal(normalizeSettings({ sampleRetentionDays: '' }).sampleRetentionDays, 90);
  // 명시적 값은 범위 안으로
  assert.equal(saveLinkCheckSettings({ sampleRetentionDays: 1 }).sampleRetentionDays, 7);
});

test('LEFT2602-03: 전원 꺼짐 점검 주기의 빈 값은 이전 값', async () => {
  const m = await import('../src/tools/powerOffSettings.js');
  m._resetPowerOffSettingsCache();
  assert.equal(m.savePowerOffSettings({ intervalHours: 24 }).intervalHours, 24);
  assert.equal(m.savePowerOffSettings({ intervalHours: '' }).intervalHours, 24);
  assert.equal(m.savePowerOffSettings({ intervalHours: '   ' }).intervalHours, 24);
  assert.equal(m.savePowerOffSettings({ intervalHours: 0 }).intervalHours, 1);   // 명시적 0 은 값 → 하한
});

test('LEFT2602-05 · TIM2602-02: VM 성능 보존 — env 0 = 무제한, 음수는 미지정', async () => {
  const m = await import('../src/metrics/vmperfSettings.js');
  const prev = process.env.VMPERF_RETENTION_DAYS;
  try {
    process.env.VMPERF_RETENTION_DAYS = '0';
    assert.equal(m.loadVmperfSettings().retentionDays, 0);
    process.env.VMPERF_RETENTION_DAYS = '';
    assert.equal(m.loadVmperfSettings().retentionDays, 90);
    process.env.VMPERF_RETENTION_DAYS = '-4';
    assert.equal(m.loadVmperfSettings().retentionDays, 90);
    delete process.env.VMPERF_RETENTION_DAYS;
    assert.equal(m.saveVmperfSettings({ retentionDays: 30 }).retentionDays, 30);
    assert.equal(m.saveVmperfSettings({ retentionDays: -7 }).retentionDays, 30);
    assert.equal(m.saveVmperfSettings({ retentionDays: 0 }).retentionDays, 0);
  } finally { if (prev === undefined) delete process.env.VMPERF_RETENTION_DAYS; else process.env.VMPERF_RETENTION_DAYS = prev; }
});

test('TIM2602-01: 지표 보존일 상한·음수는 이전 값', async () => {
  const m = await import('../src/metrics/settings.js');
  assert.equal(m.saveMetricsSettings({ retentionDays: 400, rawRetentionDays: 30 }).retentionDays, 400);
  const big = m.saveMetricsSettings({ retentionDays: 1e13 });
  assert.equal(big.retentionDays, m.METRICS_LIMITS.maxRetentionDays);
  assert.ok(big.retentionDays <= 3650);
  const neg = m.saveMetricsSettings({ retentionDays: 500 });
  assert.equal(neg.retentionDays, 500);
  const s = m.saveMetricsSettings({ retentionDays: -7, rawRetentionDays: -1 });
  assert.equal(s.retentionDays, 500);
  assert.equal(s.rawRetentionDays, 30);
  // 손으로 고친 파일의 음수도 무제한(0)이 아니다
  fs.writeFileSync(path.join(DIR, 'metrics.json'), JSON.stringify({ retentionDays: -9 }));
  assert.notEqual(m.loadMetricsSettings().retentionDays, 0);
});

test('TIM2602-02: 스파이크 보존일 음수·env 빈 값', async () => {
  const m = await import('../src/vmseries/settings.js');
  const prev = process.env.VMSERIES_RETENTION_DAYS;
  try {
    process.env.VMSERIES_RETENTION_DAYS = '';
    assert.equal(m.loadVmSeriesSettings().retentionDays, 60);
    process.env.VMSERIES_RETENTION_DAYS = '0';
    assert.equal(m.loadVmSeriesSettings().retentionDays, 0);
    delete process.env.VMSERIES_RETENTION_DAYS;
    assert.equal(m.saveVmSeriesSettings({ retentionDays: 90 }).retentionDays, 90);
    assert.equal(m.saveVmSeriesSettings({ retentionDays: -7 }).retentionDays, 90);
    assert.equal(m.saveVmSeriesSettings({ retentionDays: 0 }).retentionDays, 0);
  } finally { if (prev === undefined) delete process.env.VMSERIES_RETENTION_DAYS; else process.env.VMSERIES_RETENTION_DAYS = prev; }
});

test('TIM2602-03: SSH 콘솔 유휴 시한은 타이머 범위 안', async () => {
  const { idleTimeoutMs } = await import('../src/proxy/sshGateway.js');
  const { MAX_TIMER_MS } = await import('../src/config.js');
  assert.equal(idleTimeoutMs('3000000000'), MAX_TIMER_MS);
  assert.equal(idleTimeoutMs('-5'), 30 * 60_000);
  assert.equal(idleTimeoutMs(''), 30 * 60_000);
  assert.equal(idleTimeoutMs(undefined), 30 * 60_000);
  assert.equal(idleTimeoutMs('5000'), 60_000);
  assert.equal(idleTimeoutMs('600000'), 600_000);
});

test('TIM2602-04: 로그인 모니터 로드 경로도 범위를 적용한다', async () => {
  const { loadLoginMonitor } = await import('../src/security/loginMonitor.js');
  const s = loadLoginMonitor();
  assert.equal(s.intervalMin, 15);   // 0 → 기본(1ms 루프 금지)
  assert.equal(s.days, 7);
  assert.equal(s.threshold, 5);
  assert.equal(s.windowMin, 1440);
});

test('SEC2602-04: stripPath 는 끝 슬래시가 많아도 선형', async () => {
  const { stripPath } = await import('../src/auth/toolAccess.js');
  assert.equal(stripPath('/IPAM.csv///'), '/ipam');
  assert.equal(stripPath('////'), '/');
  const p = `/api/tools${'/'.repeat(15000)}x${'/'.repeat(15000)}`;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 20; i++) stripPath(p);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 1000, `20회 ${ms.toFixed(1)}ms — O(n²) 면 3만 자 × 20회에 수십 초`);   // v2.613 TESTDOC2613-02: 절대 상한은 1초(회귀와 확실히 갈리는 값 — v2.603) · 입력은 옛 O(n²) 구현이 수 초가 되는 크기
  assert.ok(stripPath(p).endsWith('x'));
});

test('TIM2602-05: dirusage DB 첫 open 잠금은 래치하지 않는다', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const holder = new DatabaseSync(process.env.DIRUSAGE_DB_PATH);
  holder.exec('CREATE TABLE IF NOT EXISTS _x (a INTEGER); BEGIN EXCLUSIVE; INSERT INTO _x VALUES (1);');
  const m = await import('../src/dirusage/db.js');
  const first = await m.getDb();
  assert.equal(first, null);
  assert.equal(m.dbStatus().available, false);
  holder.exec('COMMIT'); holder.close();
  m._expireDirusageLockRetry();
  const second = await m.getDb();
  assert.ok(second, '잠금이 풀리면 다시 열려야 한다');
  assert.equal(m.dbStatus().available, true);
});

test('DB2602-03: changes prune 이 VM 의 유일한 전원 전이 행을 남긴다', async () => {
  const m = await import('../src/vmtrack/db.js');
  const x = await m.getDb();
  assert.ok(x);
  const ins = x.db.prepare('INSERT INTO changes (snap_id, ts, vcenter_id, kind, vm_id) VALUES (1, ?, ?, ?, ?)');
  const OLD = 1_000_000_000_000;   // 2001-09 — 어떤 보존 경계보다 과거
  ins.run(OLD, 'vc1', 'powered_off', 'vm-a');              // 유일한 전이 → 남아야 한다
  ins.run(OLD, 'vc1', 'powered_off', 'vm-b');
  ins.run(OLD + 86_400_000, 'vc1', 'powered_off', 'vm-b'); // vm-b 는 더 늦은 행 하나만 남는다
  ins.run(OLD, 'vc1', 'powered_on', 'vm-b');
  ins.run(OLD, 'vc1', 'added', 'vm-c');                    // 전원 전이가 아니면 지운다
  const r = await m.pruneVmtrack(1095);
  assert.equal(r.ok, true);
  const pc = await m.loadPowerChanges('vc1');
  assert.equal(pc.get('vm-a')?.offTs, OLD);
  assert.equal(pc.get('vm-b')?.offTs, OLD + 86_400_000);
  assert.equal(pc.get('vm-b')?.onTs, OLD);
  const n = x.db.prepare("SELECT COUNT(*) n FROM changes WHERE vcenter_id='vc1'").get().n;
  assert.equal(n, 3);
});

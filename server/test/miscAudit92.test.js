/**
 * test/miscAudit92.test.js — 전체 점검 92회차(지표 · perf · 로그 · 네트워크 · 시스템 · 베어메탈 스토리지 연결).
 *
 * 결정 G2(읽기 오류 ≠ 손상)의 형제 꼴이 이 범위의 설정 · 정의 파일 다섯 곳에 남아 있었다 — 읽기와 JSON.parse 를 catch 하나로 받아
 * **읽기 오류**(EACCES · EIO · EMFILE · EISDIR)도 손상으로 보고 온전한 원본을 `.corrupt` 로 옮긴 뒤 기본값 · 빈 목록으로 돌았다.
 *  F1 net/monitor.js        — 모니터 정의(SSH 자격증명) · 다음 저장이 한 건만 든 파일을 썼다
 *  F2 metrics/settings.js · metrics/vmperfSettings.js — 보존일이 기본값으로 바뀌어 다음 prune 이 긴 이력을 지웠다(복구 불가)
 *  F3 logs/settings.js      — 기본값(365일 · 1,024MB)을 프로세스 수명 동안 캐시 → 다음 정리가 긴 로그를 지웠다
 *  F4 system/nfsMounts.js   — 다음 등록이 한 건만 든 파일을 썼다 · `mounts` 가 배열이 아니면 목록 조회마다 TypeError
 * 재현은 EISDIR(파일 자리에 디렉터리 — root 컨테이너에서 EACCES 를 만들 수 없어 같은 갈래인 읽기 단계 실패로 본다 · 78회차 F6 와 같은 방법).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'miscAudit92-'));
Object.assign(process.env, { CONFIG_DIR: TMP, DATA_SOURCE: 'mock' });
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

const { _setJsonFileLoadClockForTest } = await import('../src/util/jsonFileRead.js');
// 기준 시각: 실제 시각을 정시 경계로 떨어뜨려 고정(재읽기 간격 30초를 시계로 넘긴다).
let NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;
_setJsonFileLoadClockForTest(() => NOW);
after(() => _setJsonFileLoadClockForTest());
const tick = () => { NOW += 31_000; };

const file = (n) => path.join(TMP, n);
const corruptCopies = (n) => fs.readdirSync(TMP).filter((x) => x.startsWith(`${n}.corrupt.`));
/** 파일 자리에 디렉터리를 둔다 — readFileSync 가 EISDIR(읽기 단계 실패)로 던진다. */
function makeUnreadable(n) { try { fs.rmSync(file(n), { recursive: true, force: true }); } catch { /* */ } fs.mkdirSync(file(n)); }
function restore(n, body) { fs.rmSync(file(n), { recursive: true, force: true }); fs.writeFileSync(file(n), body); }
/** console 경고를 삼킨다(읽기 오류 · 손상 경고는 정상 동작). */
async function quiet(fn) {
  const saved = { warn: console.warn, error: console.error, log: console.log };
  console.warn = () => {}; console.error = () => {}; console.log = () => {};
  try { return await fn(); } finally { Object.assign(console, saved); }
}

test('92 F2 metrics/settings — 읽기 오류는 원본을 옮기지 않고 마지막 값으로 돈다 · 저장 거절 · 한 번도 못 읽었으면 보존일 모름(prune 건너뜀)', async () => {
  const m = await import('../src/metrics/settings.js');
  fs.writeFileSync(file('metrics.json'), JSON.stringify({ retentionDays: 3650, rawRetentionDays: 400 }));
  assert.equal(m.loadMetricsSettings().retentionDays, 3650);
  await quiet(() => {
    makeUnreadable('metrics.json');
    const s = m.loadMetricsSettings();
    assert.equal(s.retentionDays, 3650, '읽기 오류 동안은 마지막으로 읽은 보존일(기본 1,830일로 줄지 않는다)');
    assert.equal(s.rawRetentionDays, 400);
    assert.equal(m.metricsRetentionUnknown(), false, '마지막 값이 있으면 모르는 것이 아니다');
    assert.ok(fs.statSync(file('metrics.json')).isDirectory(), '원본 자리를 옮기지 않았다');
    assert.equal(corruptCopies('metrics.json').length, 0, '읽기 오류는 손상 보존본을 만들지 않는다');
    const no = m.metricsSettingsRefusal();
    assert.equal(no?.code, 'settings-unreadable');
    assert.throws(() => m.saveMetricsSettings({ retentionDays: 30 }), (e) => e.status === 409);
    // 재시작과 같다 — 한 번도 못 읽었다
    m._resetMetricsSettingsForTest();
    assert.equal(m.metricsRetentionUnknown(), true, '보존일을 모른다 — sampler 가 prune 을 건너뛴다');
    // 회복: 원본을 되돌리고 간격(30초)이 지나면 다시 읽는다
    restore('metrics.json', JSON.stringify({ retentionDays: 3650 }));
    tick();
    assert.equal(m.metricsRetentionUnknown(), false);
    assert.equal(m.metricsSettingsRefusal(), null, '읽히면 저장이 다시 열린다');
    assert.equal(m.loadMetricsSettings().retentionDays, 3650);
    // 손상은 예전처럼 보존본으로 옮기고 기본값(관리자가 확인할 몫)
    fs.writeFileSync(file('metrics.json'), '{"retentionDays": 36');
    m.loadMetricsSettings();
    assert.equal(corruptCopies('metrics.json').length, 1, '손상만 보존본으로 옮긴다');
  });
});

test('92 F2 sampler — 보존일을 모르면 prune 을 부르지 않는다(소스 대조 — 판정 함수 하나)', () => {
  const src = fs.readFileSync(new URL('../src/metrics/sampler.js', import.meta.url), 'utf8');
  assert.match(src, /% 20 === 0\) && !metricsRetentionUnknown\(\)\)/, '공용 지표 prune 조건');
  assert.match(src, /% 120\) === 0\) && !vmperfRetentionUnknown\(\)\)/, 'VM 성능 prune 조건');
});

test('92 F2 vmperfSettings — 읽기 오류 동안 보존일은 마지막 값 · 저장 409 · 라우트도 먼저 409', async () => {
  const v = await import('../src/metrics/vmperfSettings.js');
  fs.writeFileSync(file('vmperf.json'), JSON.stringify({ retentionDays: 365 }));
  assert.equal(v.loadVmperfSettings().retentionDays, 365);
  await quiet(() => {
    makeUnreadable('vmperf.json');
    assert.equal(v.loadVmperfSettings().retentionDays, 365, '기본 90일로 줄지 않는다');
    assert.equal(corruptCopies('vmperf.json').length, 0);
    assert.equal(v.vmperfSettingsRefusal()?.code, 'settings-unreadable');
    assert.throws(() => v.saveVmperfSettings({ retentionDays: 30 }), (e) => e.status === 409);
    v._resetVmperfSettingsForTest();
    assert.equal(v.vmperfRetentionUnknown(), true);
    restore('vmperf.json', JSON.stringify({ retentionDays: 365 }));
    tick();
    assert.equal(v.vmperfRetentionUnknown(), false);
    assert.equal(v.saveVmperfSettings({ retentionDays: 200 }).retentionDays, 200, '회복 뒤 저장은 예전대로');
  });
  const route = fs.readFileSync(new URL('../src/routes/api/toolsCapacity.js', import.meta.url), 'utf8');
  assert.match(route, /put\('\/tools\/waste\/settings'[^\n]*\n[^\n]*\n\s*const unreadable = vmperfSettingsRefusal\(\);\n\s*if \(unreadable\) return res\.status\(409\)/, 'PUT /tools/waste/settings 는 저장 전에 409');
});

test('92 F3 logs/settings — 읽기 오류는 기본값을 캐시하지 않는다 · 폴러는 수집 · 정리를 건너뛴다 · 저장은 거절 본문', async () => {
  const L = await import('../src/logs/settings.js');
  L._resetLogSettingsForTest();
  await quiet(async () => {
    makeUnreadable('vcenter-logs.json');
    const s = L.loadLogSettings();
    assert.equal(s.retentionDays, 365, '자리 표시(기본값)');
    assert.equal(L.logSettingsUnknown(), true, '보관 기간 · 용량 · 저장 위치를 모른다');
    assert.ok(fs.statSync(file('vcenter-logs.json')).isDirectory(), '원본을 옮기지 않았다');
    assert.equal(corruptCopies('vcenter-logs.json').length, 0);
    const r = L.saveLogSettings({ retentionDays: 30 });
    assert.equal(r.ok, false); assert.equal(r.code, 'settings-unreadable');
    assert.ok(fs.statSync(file('vcenter-logs.json')).isDirectory(), '거절 — 기본값 위에 쓰지 않았다');
    const P = await import('../src/logs/poller.js');
    const run = await P.pollLogsOnce({ manual: true });
    assert.equal(run.skipped, true); assert.equal(run.settingsUnreadable, true, '수집 · 정리를 건너뛴다(기본값으로 지우지 않는다)');
    restore('vcenter-logs.json', JSON.stringify({ retentionDays: 3000, maxSizeMB: 9000 }));
    tick();
    assert.equal(L.logSettingsUnknown(), false);
    assert.equal(L.loadLogSettings().retentionDays, 3000, '회복하면 저장값');
    assert.equal(L.logSettingsRefusal(), null);
  });
});

test('92 F1 net/monitor — 읽기 오류는 자격증명 파일을 옮기지 않는다 · 저장 · 삭제 거절 · 회복하면 정의가 돌아온다', async () => {
  const M = await import('../src/net/monitor.js');
  M._resetNetMonitorForTest();
  const body = JSON.stringify([{ id: 'mon_a', name: 'a', enabled: false, mode: 'single', intervalMin: 10, hostA: { host: '10.0.0.1', username: 'u', password: 'pw' }, peer: '10.0.0.2' }]);
  await quiet(() => {
    makeUnreadable('capture-monitors.json');
    assert.deepEqual(M.listMonitors(), []);
    assert.equal(corruptCopies('capture-monitors.json').length, 0, '읽기 오류는 보존본을 만들지 않는다');
    const r = M.saveMonitor({ name: 'new', hostA: { host: '10.0.0.9', username: 'u', password: 'x' }, peer: '10.0.0.8' });
    assert.equal(r.ok, false); assert.equal(r.code, 'settings-unreadable');
    assert.equal(M.removeMonitor('mon_a'), false);
    assert.ok(fs.statSync(file('capture-monitors.json')).isDirectory(), '빈 목록으로 원본을 덮지 않았다');
    assert.ok(M.monitorsWriteRefusal());
    restore('capture-monitors.json', body);
    tick();
    assert.deepEqual(M.listMonitors().map((x) => x.id), ['mon_a'], '회복하면 정의가 그대로');
    assert.equal(M.monitorsWriteRefusal(), null);
    // 손상은 예전처럼 보존본(사유 요약 문구 — RV2744F-LOAD-01)
    M._resetNetMonitorForTest();
    fs.writeFileSync(file('capture-monitors.json'), '[{"id":');
    assert.deepEqual(M.listMonitors(), []);
    assert.equal(corruptCopies('capture-monitors.json').length, 1);
    assert.equal(M.monitorsWriteRefusal(), null, '손상은 쓰기 거절이 아니다(예전 규약 — 새로 시작)');
  });
});

test('92 F4 system/nfsMounts — 읽기 오류는 옮기지 않고 등록 · 삭제 거절 · mounts 가 배열이 아니면 손상(목록 조회가 던지지 않는다)', async () => {
  const N = await import('../src/system/nfsMounts.js');
  N._resetForTest();
  await quiet(() => {
    makeUnreadable('nfs-mounts.json');
    assert.deepEqual(N.listMounts(), []);
    assert.equal(N.nfsMountsReadError(), true);
    assert.throws(() => N.addMount({ server: 'nas1', exportPath: '/vol/a', options: '' }), /읽기 오류/);
    assert.throws(() => N.deleteMount('nfs-x'), /읽기 오류/);
    assert.equal(corruptCopies('nfs-mounts.json').length, 0);
    assert.ok(fs.statSync(file('nfs-mounts.json')).isDirectory());
    restore('nfs-mounts.json', JSON.stringify({ version: 1, mounts: [{ id: 'nfs-a', server: 'nas1', exportPath: '/vol/a', options: '' }] }));
    tick();
    assert.deepEqual(N.listMounts().map((m) => m.id), ['nfs-a']);
    assert.equal(N.nfsMountsReadError(), false);
    // 배열이 아닌 mounts — 예전에는 목록 조회마다 TypeError(500)
    N._resetForTest();
    fs.writeFileSync(file('nfs-mounts.json'), JSON.stringify({ version: 1, mounts: 'x' }));
    assert.doesNotThrow(() => N.listMounts());
    assert.deepEqual(N.listMounts(), []);
    assert.equal(corruptCopies('nfs-mounts.json').length, 1, '형식 불일치는 손상으로 보존');
  });
});

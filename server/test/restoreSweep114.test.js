/**
 * restoreSweep114.test.js — 전체 점검 114회차: **백업 복원 대상 전수 분류**(스윕) + 그 스윕이 찾은 결함의 회귀 + 공개 API 자기점검.
 *
 * 배경: 포탈 백업은 CONFIG_DIR 의 `*.json` 을 (수집 데이터 4개만 빼고) 전부 담고, 복원(backup/stagedRestore.js — 기동 때 적용)은 본인 OTP 를 묻지 않는다.
 *   그래서 백업 파일을 그대로 쓰면 ⓐ 백업 뒤에 한 보안 조치(폐기 · 회수 · 강화 · OTP 로만 하는 저장)가 되돌아가고 ⓑ '이미 한 일' 의 기록(보낸 메일 · 돈 회차 ·
 *   실행 원장 · 인증 정지)이 옛 판본이 되어 같은 일을 다시 한다. 88 · 91 · 98 · 100 · 110회차가 파일 하나씩 찾아 고쳤고, 이번에 전수로 분류했다.
 *
 * ① 분류표(아래 CLASS) — 서버 소스에 글자로 나오는 `*.json` 이름은 전부 이 표에 있어야 한다. **새 설정 · 상태 파일을 만들면 이 시험이 실패한다** —
 *    그 파일이 복원될 때 어떻게 돼야 하는지(합침 · 제외 · 지금 것 유지 · 그대로) 정해서 표에 넣는다. 표와 코드(RESTORE_EXCLUDE · RESTORE_KEEP_CURRENT ·
 *    reconcileForApply)가 어긋나도 실패한다.
 * ② 회귀 — 재현한 결함마다: 순수 함수 + 실제 적용(applyStagedRestore) + 실제 소비 모듈(자식 프로세스 = 다음 기동). 재해 복구(지금 파일 없음)는 백업 그대로다.
 * ③ 공개 API `GET /api/v1/` — 경로의 allowed 는 실제 게이트와 같은 판정(범위 키 · 전체 범위 전용 경로).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripComments } from './_stripComments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const ROOT = path.resolve(SRC, '..');
const u = (rel) => pathToFileURL(path.join(SRC, rel)).href;
const SR = await import('../src/backup/stagedRestore.js');
const { keepOtpReasons } = await import('../src/bareos/groupRetention.js');

const TMP = [];
const mk = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rs114-')); fs.mkdirSync(path.join(d, 'backups'), { recursive: true }); TMP.push(d); return d; };
const rmTmp = () => { for (const d of TMP) fs.rmSync(d, { recursive: true, force: true }); };
after(() => { rmTmp(); process.once('exit', () => { try { rmTmp(); } catch { /* 종료 중 */ } }); });
const w = (dir, name, v) => fs.writeFileSync(path.join(dir, name), typeof v === 'string' ? v : JSON.stringify(v, null, 2));
const r = (dir, name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
const has = (dir, name) => fs.existsSync(path.join(dir, name));
const J = (v) => JSON.stringify(v);
/** 복원 예약 → 기동 때 적용(조용히). */
function restore(dir, files) {
  SR._resetStagedRestoreState();
  const staged = SR.stageRestore(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, typeof v === 'string' ? v : J(v)])), { configDir: dir, source: 'rs114' });
  const log = console.log; const warn = console.warn;
  console.log = () => {}; console.warn = () => {};
  try { return { staged, ...SR.applyStagedRestore({ configDir: dir }) }; } finally { console.log = log; console.warn = warn; }
}
/** 실제 모듈을 새 프로세스(= 복원 뒤 다음 기동)에서 돌린다 — 'OUT <json>' 한 줄. */
function child(dir, code) {
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, CONFIG_DIR: dir, AUTH_ENABLED: 'false', DATA_SOURCE: 'mock', NODE_ENV: 'test' }, encoding: 'utf8', cwd: ROOT, timeout: 120_000,
  });
  const line = (res.stdout || '').split('\n').filter((l) => l.startsWith('OUT ')).pop();
  assert.ok(line, `자식 프로세스 출력 없음: ${(res.stderr || res.stdout || '').slice(-1200)}`);
  return JSON.parse(line.slice(4));
}
// 기준 시각 — 실제 시각에서 정시 경계로 떨어뜨린다(docs/rules/common.md — 날짜 · 시 경계에서 깨지지 않게)
const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;

/* ══ ① 분류표 ═══════════════════════════════════════════════════════════════════════════════ */

/** CONFIG_DIR 최상위의 백업 대상이 아닌 이름(소스에 글자로만 나온다). */
const NOT_CONFIG = {
  '_index.json': 'vmperf/ 하위 디렉터리의 색인(백업은 최상위만 담는다)',
  'agent-config.json': '안내 문구 속 이름(파일을 만들지 않는다)',
  'bareos-bundle.json': '번들 서버의 최신 포인터 파일 이름(원격)',
  'index.json': '첨부 내려받기 tar 안의 멤버 이름',
  'manifest.json': 'NFS 백업 폴더 안의 완료 표지',
  'package.json': '설치본의 package.json',
  'release-signing-keys.json': '저장소에 든 서명 공개키 파일(server/src/upgrade/)',
  'special-tools.json': 'web/dist 의 특수 기능 카탈로그',
  'vcenters.example.json': '번들 예제 템플릿',
  'versions.json': '원격 버전 목록',
};

/** ⓐ 합침 — reconcileForApply 가 지금 파일과 맞춰 쓴다(지금보다 약해지지 않게 · 이미 한 일을 다시 하지 않게). */
const MERGE = {
  'security-session.json': '세션 보안 — 지금보다 약한 값은 지금 수준으로(v2.842 · 9회차 V-20 · 91 · 100회차)',
  'secrets-policy.json': '자격증명 저장 방식 — 암호화 → 평문 금지(9회차 · 91 · 110회차)',
  'secrets-policy.trusted.json': '위 정책의 신뢰 사본 — 같은 규칙',
  'peer-trust.json': '장비 신뢰 — 정책은 켜기만 · 회수 · 교체한 지문은 되살리지 않는다(91 · 110회차)',
  'api-keys.json': '연동 키 — 폐기 · 삭제는 되돌리지 않는다(88회차 F7)',
  'auth.json': 'AD 설정 — 정책 카운터 = max + 1(88회차 F6)',
  'users.json': '계정 — 세션 버전 = max + 1(v2.769)',
  'central-agent-tokens.json': '엣지 토큰 — 지금 파일 우선 병합(v2.769)',
  'ssh-keys.json': 'SSH 키 저장소 — 지금 키의 개인키 · 폴더 · 기능 · 상태 유지(v3.9.0 D5)',
  'bareos-groups.json': 'Bareos 백업 그룹 — 회차 기록은 늦은 쪽(v2.830 S7) · 보관 개수는 지워질 범위를 넓히지 않게(114회차 F1)',
  'vm-clone.json': 'VM 백업 잡 — 실행 원장(clones · lastRun · history · running · ops)은 지금 것(114회차 F5)',
  'host-access.json': '호스트 접근 제어 — 이 호스트의 적용 기록 · 확정 대기는 지금 것(114회차 F6)',
  'rma-schedules.json': '원격 명령 점검 스케줄 — 셸 점검은 지금 같은 내용으로 켜져 있을 때만 켠 채(114회차 · 110 결정 ①)',
  'credentials.json': '통합 계정 — 지운 계정은 되살리지 않고 범위는 좁은 쪽(114회차 · 110 결정 ②)',
  // 마지막 실행 시각으로 다음 실행을 정하는 스토어 — 실행 필드(last* · useCount)는 지금 것(114회차 F4)
  'capture-monitors.json': '연속 캡처 — lastRun 은 지금 것',
  'os-scan.json': 'OS 스캔 — lastRun 은 지금 것',
  'guest-scans.json': '게스트 조사 — lastRun 은 지금 것',
  'daily-report.json': '일일 보고 — lastRunTs 는 지금 것',
  'idrac-scan-ranges.json': 'iDRAC 대역 — lastRun 은 지금 것',
};
/** ⓑ 제외 — 복원하지 않는다(RESTORE_EXCLUDE) · 백업에 담지도 않는다(DATA_FILE_NAMES). */
const EXCLUDE = ['session-state.json', 'upgrade-signature-override.json', 'bareos-dr-runs.json', 'ssh-access-state.json', 'emergency-stop.json', 'security-session.trusted.json',
  'scan-journal.json',   // 114회차 F2
  'central-inventory.json', 'central-agent-config.json', 'ipam-scan-history.json', 'ipam-scan-results.json'];
/** ⓒ 그대로 — 백업 판본을 그대로 써도 지금보다 약해지지 않고 실행이 꼬이지 않는다(까닭마다 묶음). */
const ASIS = {
  '설정 — 사람이 고치는 값(되돌리는 것이 복원의 목적 · 본인 OTP 로만 바꾸는 값이 아니다)': [
    'agent-assignments.json', 'alarm-mutes.json', 'alerts.json', 'attach-settings.json', 'backup-stale-alert.json', 'backup.json', 'bareos-bundle-source.json', 'bareos-digest.json',
    'bareos-health.json', 'bm-capacity.json', 'bm-folders.json', 'bm-idle.json', 'bm-key-decisions.json', 'bm-perf-compare-sets.json', 'bm-perf-rules.json', 'bm-perf-slo.json',
    'bmusage-distribute.json', 'bmusage-portmap.json', 'bmusage-settings.json', 'bmusage-tuning.json', 'cost-rates.json', 'curuser-settings.json', 'cvp-settings.json', 'datacenters.json',
    'db-location.json', 'dirusage.json', 'disk-bad-settings.json', 'finops.json', 'fleet-assign.json', 'fleet-tags.json', 'focusmon-alert-rules.json', 'guest-disk.json', 'guest-partition.json',
    'horizon-sessions.json', 'hw-export-prefs.json', 'idrac-scan-settings.json', 'ipam-annotations.json', 'ipam-overrides.json', 'ipam-range-policies.json', 'ipam-report.json', 'ipam-scan.json',
    'ipam-settings.json', 'ipam-subnet-notes.json', 'ipam-vcenter-ranges.json', 'isidu-settings.json', 'issue-alert-auto.json', 'issue-autocreate.json', 'issue-settings.json', 'issue-templates.json',
    'linkcheck-settings.json', 'login-monitor.json', 'maintenance-windows.json', 'metrics.json', 'packages.json', 'partfault-settings.json', 'pdu-intervals.json', 'pdu-thresholds.json',
    'perf-monitor.json', 'permissions.json', 'ping-settings.json', 'ping-targets.json', 'power-off-check.json', 'power-settings.json', 'provision-saved.json', 'relaycheck-settings.json',
    'runtime.json', 'san-storage-map.json', 'san-storage-notify.json', 'san-storage-report.json', 'sanswitch-err-baseline.json', 'sanswitch-perf-settings.json', 'service-map.json',
    'storage-growth-settings.json', 'storage-inspect.json', 'storage-intervals.json', 'storage-perf-check.json', 'storage-usage-mail.json', 'svcmon-alert.json', 'svcmon-log.json',
    'svcmon-templates.json', 'svcmon.json', 'tag-policy.json', 'tool-categories.json', 'ui.json', 'upgrade.json', 'usage-settings.json', 'user-menus.json', 'vcenter-logs.json',
    'vcenter-order.json', 'veeam-em-map.json', 'vm-clone-corp.json', 'vm-clone-nfsds.json', 'vm-dns-policy.json', 'vm-export-prefs.json', 'vm-hygiene.json', 'vm-list-prefs.json', 'vmperf.json',
    'vmseries.json', 'wiki-templates.json', 'xfer-speed-settings.json', 'focusmon-sessions.json'],
  '등록부 · 자격증명 — 접속처와 비밀이 같은 판본으로 함께 돌아온다(복원의 목적 · 등록 · 수정이 본인 OTP 가 아니다)': [
    'vcenters.json', 'nsx.json', 'collectors.json', 'agent-deploy-targets.json', 'horizon.json', 'idrac.json', 'gpu-guest.json', 'gpu-physical.json', 'cvp-servers.json', 'pdu-devices.json',
    'sanswitch-devices.json', 'storage-devices.json', 'veeam-servers.json', 'veeam-em.json', 'relay-topology.json', 'remote-access.json', 'mail.json', 'llm.json', 'bareos.json', 'nfs-mounts.json',
    'rma-agents.json', 'rma-settings.json', 'central-agent-users.json', 'central-agent-gpu-guest.json', 'focusmon-targets.json'],
  '사용자 데이터 — 글 · 이슈 · 표시(되돌리는 것이 복원의 목적)': [
    'board.json', 'notices.json', 'issues.json', 'issue-sprints.json', 'issue-filters.json', 'issue-inbox.json', 'wiki.json', 'wiki-user.json', 'attachments.json', 'backup-marks.json',
    'service-map-pins.json', 'bm-folders-assign.json', 'release-notes.json', 'bm-perf-annotations.json'],
  '수집 사본 · 캐시 — 다음 수집 · 엣지 push 가 덮는다(수집 · 수신 시각이 함께 실려 지금 값으로 읽히지 않는다)': [
    'agent-results.json', 'central-agent-cvp.json', 'central-agent-sanswitch.json', 'central-agent-sanswitch-perf.json', 'central-agent-storage.json', 'central-fleet.json', 'central-pdu.json',
    'central-unsupported-servers.json', 'idrac-inventory.json', 'idrac-sensor-cache.json', 'os-inventory.json', 'sanswitch-latest.json', 'storage-latest.json', 'veeam-em-latest.json',
    'veeam-em-vms.json', 'veeam-latest.json', 'veeam-vc-accounts.json', 'veeam-portal-vms.json', 'bareos-policy.json', 'storage-nodeload-ring.json', 'storage-inspect-ring.json',
    'ipam-scan-agents.json', 'ipam-changes.json', 'maintenance-stats.json', 'focusmon-keys.json', 'active-sessions.json'],
  '엣지가 받은 중앙 사본 — 다음 pull 이 덮는다': ['bareos-edge-directors.json', 'bm-folders-central.json', 'bmusage-central.json', 'isidu-edge-targets.json', 'maintenance-windows-deployed.json'],
  '작업 로그 · 이력 · 사용 집계 — 표시용(판정 · 실행에 쓰지 않는다)': [
    'bmusage-activity.json', 'curuser-activity.json', 'horizon-session-activity.json', 'sanswitch-activity.json', 'sanswitch-perf-activity.json', 'storage-activity.json', 'capture-history.json',
    'idrac-scan-log.json', 'ipam-scan-log.json', 'log-analysis-stats.json', 'tool-usage.json', 'credentials-usage.json', 'ssh-key-usage.json', 'portal-db-size-history.json', 'svcmon-batches.json',
    'ssh-access-installed.json'],
  '함께 복원되는 설정과 한 벌인 상태 — 백업 판본끼리가 맞다(지금 것을 두면 짝이 깨진다)': [
    'svcmon-trial.json', 'svcmon-settings-sync.json', 'ipam-vcrange-migration.json', 'bm-onboard-applied.json', 'central-svcmon-assign.json'],
  '설정 + 실행 필드가 섞였지만 그대로 — 실행 필드가 다음 실행을 정하지 않는다(대기는 Director 가 모르면 내려가고 · 마무리는 꺼진 VM 에만 · 플로우 기록은 장비와 어긋나면 드러난다)': [
    'bareos-jobs.json', 'san-flows.json'],
};
/**
 * ⓓ 남긴 것 — 본인 OTP 로 저장하는 설정인데 복원이 OTP 없이 백업 판본으로 되돌린다(예전에 OTP 로 승인한 값으로 돌아간다). 정책 판단이 필요해 이번에 고치지 않았다.
 *   여기서 빼려면 reconcileForApply · RESTORE_EXCLUDE 에 넣고 표를 옮긴다(조용히 '그대로' 로 옮기지 말 것).
 */
const OPEN = {
  'bm-storage.json': '저장 비밀(SSH 키 · 공통 계정)을 주소에 묶는 쓰기는 소유자 등급 + 본인 OTP(bindRule) — 복원이 푼 묶음 · 옛 주소의 묶음을 되살린다',
  'bm-onboard-edge.json': '엣지 배포 목록의 묶음 승인(bindOk) — 위와 같은 종류',
  'bareos-rehearsal.json': '복원 검증 정책 저장은 본인 OTP — 꺼 둔 검증을 복원이 다시 켠다(매주 검증용 VM 을 만든다)',
  'veeam-backup-run.json': '백업 실행 설정 저장은 본인 OTP 재인증 — 잡 접두 · 저장소 지정이 옛 값으로',
  'focusmon-audit-settings.json': '디스크 점검 도구 설치 경로 저장은 소유자 + 본인 OTP 재인증 — 옛 경로로',
};

/** 서버 소스(주석 제거)에 글자로 나오는 `*.json` 이름. */
function jsonNamesInSource() {
  const out = new Set();
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) for (const m of stripComments(fs.readFileSync(p, 'utf8')).matchAll(/['"`]([A-Za-z0-9_][A-Za-z0-9_.-]{0,120}\.json)['"`]/g)) out.add(m[1]);
    }
  };
  walk(SRC);
  return out;
}
const asisNames = () => Object.values(ASIS).flat();
function classOf(name) {
  if (Object.hasOwn(MERGE, name) || SR.AUTH_STOPS_RE.test(name)) return 'merge';
  if (EXCLUDE.includes(name)) return 'exclude';
  if (SR.RESTORE_KEEP_CURRENT.has(name)) return 'keep';
  if (asisNames().includes(name)) return 'asis';
  if (Object.hasOwn(OPEN, name)) return 'open';
  if (Object.hasOwn(NOT_CONFIG, name)) return 'not-config';
  return null;
}

test('분류표 — 서버 소스의 모든 *.json 이름은 복원 동작이 정해져 있다(새 파일을 만들면 여기서 실패한다)', () => {
  const names = [...jsonNamesInSource()].sort();
  assert.ok(names.length >= 280, `이름을 충분히 찾지 못했습니다(${names.length}개) — 스윕이 눈을 감았습니다`);
  const missing = names.filter((n) => !classOf(n));
  assert.deepEqual(missing, [], `복원 분류표에 없는 파일 ${missing.length}개 — 복원될 때 어떻게 돼야 하는지 정해 test/restoreSweep114.test.js 의 표`
    + ` (합침 MERGE · 제외 EXCLUDE · 지금 것 유지 RESTORE_KEEP_CURRENT · 그대로 ASIS)에 넣으세요: ${missing.join(', ')}`);
  // 한 이름은 한 분류에만
  const all = [...Object.keys(MERGE), ...EXCLUDE, ...SR.RESTORE_KEEP_CURRENT.keys(), ...asisNames(), ...Object.keys(OPEN), ...Object.keys(NOT_CONFIG)];
  const dup = all.filter((n, i) => all.indexOf(n) !== i);
  assert.deepEqual(dup, [], `두 분류에 든 이름: ${dup.join(', ')}`);
  // 표에만 있고 소스에 없는 이름(지운 파일 — 표를 정리한다)
  const src = new Set(names);
  const stale = all.filter((n) => !src.has(n));
  assert.deepEqual(stale, [], `소스에 없는 이름이 표에 남았습니다: ${stale.join(', ')}`);
  // 인증 정지 파일은 전부 정규식 하나로 잡힌다(도구마다 createAuthGuard({ file }))
  const stops = names.filter((n) => /stops\.json$/.test(n));
  assert.ok(stops.length >= 20, `인증 정지 파일 ${stops.length}개`);
  for (const n of stops) assert.ok(SR.AUTH_STOPS_RE.test(n), `${n} 이 AUTH_STOPS_RE 에 걸리지 않습니다`);
});

test('분류표 ↔ 코드 — 제외 · 지금 것 유지 · 합침이 실제 동작과 같다', async () => {
  // ⓑ 제외 = RESTORE_EXCLUDE ∪ DATA_FILE_NAMES (양방향)
  assert.deepEqual([...EXCLUDE].sort(), [...SR.RESTORE_EXCLUDE.keys(), ...SR.DATA_FILE_NAMES].sort());
  for (const n of EXCLUDE) assert.ok(SR.stagedNameIssue(n), `${n} 이 예약에서 걸러지지 않습니다`);
  // 지금 것 유지 · 합침 · 그대로는 예약 이름 검사를 지난다(조용히 빠지지 않는다)
  for (const n of [...SR.RESTORE_KEEP_CURRENT.keys(), ...Object.keys(MERGE), ...asisNames(), ...Object.keys(OPEN)]) assert.equal(SR.stagedNameIssue(n), null, n);
  // ⓐ 합침: 지금 파일 **읽기 오류**면 그 파일만 적용하지 않는다(지금 값을 모른 채 덮지 않는다 — 91회차 규칙). 지금 파일이 없으면 던지지 않는다(재해 복구).
  for (const n of [...Object.keys(MERGE), 'storage-auth-stops.json']) {
    const d = mk();
    assert.doesNotThrow(() => SR.reconcileForApply(n, '{}', d), `${n} — 지금 파일이 없는데 던졌습니다(재해 복구가 막힙니다)`);
    fs.mkdirSync(path.join(d, n));   // 같은 이름의 폴더 = EISDIR(root 로 도는 시험은 chmod 로 읽기 오류를 만들 수 없다)
    assert.throws(() => SR.reconcileForApply(n, '{}', d), /읽지 못해/, `${n} — 지금 파일 읽기 오류를 없음으로 봤습니다`);
  }
  // ⓒ 그대로 · ⓓ 남긴 것: 지금 파일이 있어도 백업 글자 그대로(이 표가 '합침' 인 파일을 '그대로' 라고 적지 않았는지)
  for (const n of [...asisNames(), ...Object.keys(OPEN)]) {
    const d = mk(); w(d, n, { now: 1, lastRun: 9 });
    const rc = SR.reconcileForApply(n, '{"bak":1,"lastRun":1}', d);
    assert.equal(rc.content, '{"bak":1,"lastRun":1}', `${n} — 표는 '그대로' 인데 코드가 내용을 바꿉니다`);
    assert.equal(rc.keep, undefined, n);
  }
  // 지금 것 유지: 있으면 쓰지 않고(사유) · 없으면 백업 그대로
  for (const [n, why] of SR.RESTORE_KEEP_CURRENT) {
    const d = mk();
    assert.deepEqual(SR.reconcileForApply(n, '{"bak":1}', d), { content: '{"bak":1}' }, `${n} — 지금 파일이 없으면 백업 그대로(재해 복구)`);
    w(d, n, '{"now":1}');
    assert.deepEqual(SR.reconcileForApply(n, '{"bak":1}', d), { keep: why }, n);
  }
  // backup/service.js 의 '설정 + 실행 결과가 섞인 스토어' 는 전부 합침이거나, 그대로 두는 까닭이 표에 있다
  const svc = await import('../src/backup/service.js');
  for (const n of svc.MIXED_STATE_FILES) {
    assert.ok(Object.hasOwn(MERGE, n) || ['remote-access.json', 'agent-deploy-targets.json', 'central-svcmon-assign.json', 'bareos-jobs.json', 'san-flows.json'].includes(n),
      `${n} — 설정과 실행 결과가 섞인 스토어입니다. 실행 필드가 다음 실행을 정하면 RESTORE_RUN_FIELDS_CURRENT(또는 전용 reconcile)에 넣으세요`);
  }
  for (const n of SR.RESTORE_RUN_FIELDS_CURRENT) assert.ok(svc.MIXED_STATE_FILES.has(n) && Object.hasOwn(MERGE, n), n);
  // 실행 필드 규칙은 service.js 와 같은 글자(두 벌 — 대조)
  const reOf = (rel, name) => new RegExp(`const ${name} = (/[^\\n]+?/);`).exec(fs.readFileSync(path.join(SRC, rel), 'utf8'))?.[1];
  assert.equal(reOf('backup/stagedRestore.js', 'RUN_FIELD_R'), reOf('backup/service.js', 'RUN_FIELD_RE'));
  assert.ok(reOf('backup/service.js', 'RUN_FIELD_RE'));
});

test('기동 순서 — 적용 모듈이 새로 싣는 두 판정 모듈도 config 를 싣지 않는 leaf 다', () => {
  const importsOf = (rel) => [...fs.readFileSync(path.join(SRC, rel), 'utf8').matchAll(/^import\s[^;]*?from\s+'([^']+)'|^import\s+'([^']+)'/gm)].map((x) => x[1] || x[2]);
  assert.deepEqual(importsOf('backup/stagedRestore.js').filter((s) => !s.startsWith('node:')),
    ['../util/atomicWrite.js', '../bmusage/onboard/keyBundle.js', '../rma/signing.js', '../bareos/groupRetention.js']);
  assert.deepEqual(importsOf('rma/signing.js').filter((s) => !s.startsWith('node:')), [], 'rma/signing.js 가 다른 모듈을 싣습니다 — 예약 복원이 config 보다 먼저 돌지 못합니다');
  assert.deepEqual(importsOf('bareos/groupRetention.js'), ['./names.js']);
  assert.deepEqual(importsOf('bareos/names.js'), []);
});

/* ══ ② 회귀 ═════════════════════════════════════════════════════════════════════════════════ */

const grp = (keep, vmIds = ['vm-1', 'vm-2'], over = {}) => ({ groups: [{ id: 'g1', name: '주간', vcenterId: 'vc1', vmIds, schedule: { mode: 'daily', time: '02:00' }, storage: 'File', pool: 'Full', keep, lastKey: '2026-11-10 02:00', ...over }] });

test('F1 Bareos 백업 그룹 — 복원이 보관 개수를 줄이지 않는다(OTP 저장 · 지워질 범위)', () => {
  const keepOf = (bak, cur) => JSON.parse(SR.reconcileBareosGroupsText(J(bak), cur == null ? null : J(cur)).text).groups[0].keep;
  assert.equal(keepOf(grp(3), grp(30)), 30, '줄임(30 → 3) — 지금 값');
  assert.equal(keepOf(grp(7), grp(null)), null, '처음 정함(제한 없음 → 7) — 제한 없음');
  assert.equal(keepOf(grp(5, ['vm-1', 'vm-2']), grp(5, ['vm-1'])), null, '기록이 있을 수 있는 VM 을 더함 — 제한 없음');
  assert.equal(keepOf(grp(3), { groups: [] }), null, '지금 원장에 없는 그룹(백업 뒤에 지움) — 보관 개수 없이 되살린다');
  // OTP 를 받지 않는 저장은 그대로
  assert.equal(keepOf(grp(30), grp(3)), 30, '늘리기');
  assert.equal(keepOf(grp(null), grp(3)), null, '제한 없음으로 풀기');
  assert.equal(keepOf(grp(5), grp(5)), 5, '같음');
  assert.equal(keepOf(grp(5, ['vm-1']), grp(5, ['vm-1', 'vm-2'])), 5, 'VM 을 뺌');
  // 재해 복구(지금 파일 없음 · 깨짐) — 백업 그대로
  assert.equal(keepOf(grp(3), null), 3);
  assert.equal(JSON.parse(SR.reconcileBareosGroupsText(J(grp(3)), '{깨짐').text).groups[0].keep, 3);
  // 결과는 언제나 '저장 라우트가 OTP 를 받지 않는 저장' 이다(같은 판정 함수)
  for (const [bak, cur] of [[grp(3), grp(30)], [grp(7), grp(null)], [grp(5, ['a', 'b']), grp(5, ['a'])], [grp(2, ['a', 'b', 'c']), grp(9, ['a'])]]) {
    const g = JSON.parse(SR.reconcileBareosGroupsText(J(bak), J(cur)).text).groups[0];
    assert.deepEqual(keepOtpReasons(cur.groups[0], { keep: g.keep, vmIds: g.vmIds }), [], J([bak.groups[0].keep, cur.groups[0].keep]));
  }
  // 회차 기록(v2.830 S7)은 그대로 지킨다
  const out = SR.reconcileBareosGroupsText(J(grp(5, undefined, { lastKey: '2026-11-01 02:00', sending: { at: 1 } })), J(grp(5, undefined, { lastKey: '2026-11-16 02:00' })));
  assert.equal(JSON.parse(out.text).groups[0].lastKey, '2026-11-16 02:00'); assert.equal(JSON.parse(out.text).groups[0].sending, null); assert.equal(out.kept, 1);
  // 실제 적용 — 경고에 그룹 이름
  const d = mk(); w(d, 'bareos-groups.json', grp(30));
  const res = restore(d, { 'bareos-groups.json': grp(3) });
  assert.equal(r(d, 'bareos-groups.json').groups[0].keep, 30);
  assert.match(res.warnings.find((x) => x.file === 'bareos-groups.json')?.reason || '', /보관 개수.*주간.*본인 OTP/);
});

test('F2 실행 중 스캔 기록은 복원하지 않는다 — 끝난 스캔을 다시 돌리지 않는다(실제 scanJournal)', () => {
  const d = mk();
  const snap = child(d, `import fs from 'node:fs'; import path from 'node:path'; import { scanStarted, scanFinished } from '${u('util/scanJournal.js')}';
    scanStarted('idrac-scan', 'cycle', { label: 'iDRAC 대역 스캔', trigger: 'timer' });
    const mid = fs.readFileSync(path.join(process.env.CONFIG_DIR, 'scan-journal.json'), 'utf8');
    scanFinished('idrac-scan', 'cycle'); console.log('OUT ' + JSON.stringify({ mid }));`);
  assert.match(snap.mid, /idrac-scan/, '전제: 스캔 도중의 기록 파일');
  const res = restore(d, { 'scan-journal.json': snap.mid, 'ui.json': { a: 1 } });
  assert.deepEqual(res.staged.dropped.map((x) => x.file), ['scan-journal.json']);
  assert.deepEqual(res.applied, ['ui.json']);
  const boot = child(d, `import { isResumePending, registerScanResumer, processScanResumes } from '${u('util/scanJournal.js')}';
    const pending = isResumePending('idrac-scan', 'cycle'); let n = 0;
    registerScanResumer('idrac-scan', async () => { n += 1; return { outcome: 'covered', note: 't' }; });
    await processScanResumes(); console.log('OUT ' + JSON.stringify({ pending, resumed: n }));`);
  assert.deepEqual(boot, { pending: false, resumed: 0 }, '복원한 기록 때문에 끝난 스캔이 다시 돌았습니다');
});

test('F3 인증 실패 정지는 복원으로 풀리지 않는다(실제 authGuard)', () => {
  const rec = (credHash, attempts = 1) => ({ credHash, since: 1, at: 2, attempts, reason: 'HTTP 401' });
  const m = (bak, cur) => JSON.parse(SR.reconcileAuthStopsText(J(bak), cur == null ? null : J(cur)).text);
  assert.deepEqual(m({}, { a: rec('h1') }), { a: rec('h1') }, '지금에만 있는 정지 — 남긴다');
  assert.deepEqual(m({ b: rec('h2') }, {}), { b: rec('h2') }, '백업에만 있는 정지 — 남긴다(더 닫는 쪽)');
  assert.deepEqual(m({ a: rec('h1', 1) }, { a: rec('h1', 7) }), { a: rec('h1', 7) }, '같은 자격 — 지금 기록(더 늦은 시도 수)');
  assert.deepEqual(m({ a: rec('old') }, { a: rec('new') }), { a: rec('old') }, '다른 자격 — 함께 복원되는 등록부의 자격에 맞는 백업 기록');
  assert.equal(SR.reconcileAuthStopsText('{}', J({ a: rec('h1'), b: rec('h2') })).keptStops, 2);
  assert.equal(SR.reconcileAuthStopsText(J({ a: rec('h1') }), null).text, J({ a: rec('h1') }), '지금 파일 없음 — 백업 그대로');
  assert.equal(SR.reconcileAuthStopsText(J({ a: rec('h1') }), '[1]').text, J({ a: rec('h1') }), '지금 파일이 객체가 아님 — 백업 그대로');
  // 실제 수집기 정지 기록으로
  const d = mk();
  const dev = (id) => `{ id: '${id}', username: 'svc-mon', password: 'wrong-pw' }`;
  child(d, `import { createAuthGuard } from '${u('util/authGuard.js')}'; const g = createAuthGuard({ file: 'storage-auth-stops.json' });
    g.markAuthStopped('stor-1', ${dev('stor-1')}, 'HTTP 401'); g.markAuthStopped('stor-2', ${dev('stor-2')}, 'HTTP 401'); console.log('OUT {}');`);
  restore(d, { 'storage-auth-stops.json': {} });   // 백업 = 정지 전
  const boot = child(d, `import { createAuthGuard } from '${u('util/authGuard.js')}'; const g = createAuthGuard({ file: 'storage-auth-stops.json' });
    console.log('OUT ' + JSON.stringify({ s1: !!g.authStopFor(${dev('stor-1')}), s2: !!g.authStopFor(${dev('stor-2')}), changed: !!g.authStopFor({ id: 'stor-1', username: 'svc-mon', password: 'fixed-pw' }) }));`);
  assert.equal(boot.s1 && boot.s2, true, '복원 뒤 정지가 풀려 같은 틀린 계정으로 다시 로그인합니다');
  assert.equal(boot.changed, false, '자격증명이 바뀌면 스스로 재개하는 규칙은 그대로');
});

test('F4 이미 한 일의 기록 — 지금 파일이 있으면 그대로 · 없으면(재해 복구) 백업 판본', async () => {
  const { clockOf, dueOf } = await import('../src/bareos/rehearsal.js');
  const c = clockOf(NOW);
  const policy = { enabled: true, weekday: c.weekday, time: '00:00' };
  const d = mk();
  w(d, 'bareos-rehearsal-state.json', { weeks: { dir1: c.day }, lastAt: {}, triedAt: {}, runs: [] });   // 오늘 이미 돌았다
  w(d, 'vm-hygiene-state.json', { lastSentDay: c.day });
  w(d, 'diskbad-cursors.json', { s1: { pos: 900 } });
  const bak = { 'bareos-rehearsal-state.json': { weeks: { dir1: '2026-01-01' }, lastAt: {}, triedAt: {}, runs: [] }, 'vm-hygiene-state.json': { lastSentDay: '2026-01-01' },
    'diskbad-cursors.json': { s1: { pos: 10 } }, 'provision-runs.json': { jobs: [{ id: 'old' }] }, 'ui.json': { theme: 'dark' } };
  const res = restore(d, bak);
  assert.deepEqual(res.kept.map((k) => k.file).sort(), ['bareos-rehearsal-state.json', 'diskbad-cursors.json', 'vm-hygiene-state.json']);
  assert.ok(res.kept.every((k) => typeof k.reason === 'string' && k.reason.length > 10));
  assert.deepEqual(res.applied.sort(), ['provision-runs.json', 'ui.json'], '지금 파일이 없는 실행 기록 · 설정은 적용');
  assert.equal(res.ok, true); assert.deepEqual(res.failed, []);
  assert.equal(dueOf(policy, r(d, 'bareos-rehearsal-state.json').weeks.dir1, NOW), false, '복원 뒤 같은 날 복원 검증이 다시 돕니다');
  assert.equal(r(d, 'vm-hygiene-state.json').lastSentDay, c.day);
  assert.equal(r(d, 'diskbad-cursors.json').s1.pos, 900);
  assert.deepEqual(SR.stagedRestoreStatus({ configDir: d }).last.kept.map((k) => k.file).sort(), res.kept.map((k) => k.file).sort(), '상태 응답에 실린다(조용히 빼지 않는다)');
  // 손상 · 읽기 오류인 지금 파일도 덮지 않는다(그 모듈 로더가 '오늘은 멈춤' 으로 닫아 둔 것을 옛 기록으로 풀지 않는다)
  const d2 = mk(); w(d2, 'bareos-rehearsal-state.json', '{깨짐'); fs.mkdirSync(path.join(d2, 'vm-hygiene-state.json'));
  const res2 = restore(d2, bak);
  assert.equal(fs.readFileSync(path.join(d2, 'bareos-rehearsal-state.json'), 'utf8'), '{깨짐');
  assert.ok(res2.kept.some((k) => k.file === 'vm-hygiene-state.json'));
  // 재해 복구 — 새 서버(지금 파일 없음)에는 전부 적용
  const d3 = mk(); const res3 = restore(d3, bak);
  assert.deepEqual(res3.kept, []); assert.equal(res3.applied.length, 5);
  assert.equal(r(d3, 'bareos-rehearsal-state.json').weeks.dir1, '2026-01-01');
});

test('F4 마지막 실행 시각으로 다음 실행을 정하는 스토어 — 실행 필드는 지금 것(실제 일일 보고 틱)', () => {
  const run = (bak, cur) => JSON.parse(SR.reconcileRunFieldsText(J(bak), cur == null ? null : J(cur)).text);
  // 최상위(os-scan · daily-report)
  assert.deepEqual(run({ enabled: true, hour: 8, lastRunTs: 1, lastRunBy: 'a' }, { enabled: false, hour: 9, lastRunTs: 50, lastRunBy: 'b', lastManualTs: 7 }),
    { enabled: true, hour: 8, lastRunTs: 50, lastRunBy: 'b', lastManualTs: 7 });
  // 배열(guest-scans · capture-monitors) — id 로 맞춘다. 지금에 없는 항목 · 지금에만 있는 항목은 백업 뜻 그대로
  assert.deepEqual(run([{ id: 'j1', intervalMin: 60, lastRun: 1 }, { id: 'gone', lastRun: 2 }], [{ id: 'new', lastRun: 9 }, { id: 'j1', intervalMin: 5, lastRun: 77, lastErr: 'x' }]),
    [{ id: 'j1', intervalMin: 60, lastRun: 77, lastErr: 'x' }, { id: 'gone', lastRun: 2 }]);
  // 키로 묶인 객체(idrac-scan-ranges) · 깊은 곳
  assert.deepEqual(run({ entries: { a: { ranges: ['10.0.0.0/24'], lastRun: { at: 1 } }, b: { lastRun: null } } }, { entries: { a: { ranges: ['x'], lastRun: { at: 9 } } } }),
    { entries: { a: { ranges: ['10.0.0.0/24'], lastRun: { at: 9 } }, b: { lastRun: null } } });
  // 설정 값은 건드리지 않는다(last 로 시작하지만 실행 필드가 아닌 이름 — lastname · latest)
  assert.deepEqual(run({ lastname: 'a', latest: 1, useCount: 1 }, { lastname: 'b', latest: 2, useCount: 5 }), { lastname: 'a', latest: 1, useCount: 5 });
  assert.equal(SR.reconcileRunFieldsText('{"lastRun":1}', null).text, '{"lastRun":1}', '지금 파일 없음 — 백업 그대로');
  assert.equal(SR.reconcileRunFieldsText('{"lastRun":1}', '{깨짐').text, '{"lastRun":1}');
  // 실제 일일 보고 — 오늘 이미 보냈는데 복원 뒤 다시 보내지 않는다
  const d = mk();
  w(d, 'daily-report.json', { enabled: true, hour: 0, minute: 0, lastRunTs: NOW, lastRunBy: 'timer' });
  restore(d, { 'daily-report.json': { enabled: true, hour: 0, minute: 0, lastRunTs: NOW - 3 * 86_400_000, lastRunBy: 'timer' } });
  const tick = child(d, `import { dailyReportTick } from '${u('reports/dailyReport.js')}'; let ran = 0;
    const x = await dailyReportTick(${NOW} + 60_000, async () => { ran += 1; return { ok: true, results: [] }; }); console.log('OUT ' + JSON.stringify({ ran, skipped: x?.skipped || null }));`);
  assert.deepEqual(tick, { ran: 0, skipped: 'not-due' }, '복원 뒤 같은 날 일일 보고가 다시 나갑니다');
});

test('F5 VM 백업 잡 — 정의는 백업 것 · 실행 원장은 지금 것(실제 vmclone/store)', () => {
  const job = (over) => ({ id: 'j1', vcenterId: 'vc1', vmId: 'vm-9', vmName: 'db01', dest: { type: 'datastore', datastoreName: 'ds1' }, schedule: { mode: 'interval', hours: 24 }, keep: 3, enabled: true, ...over });
  const cur = { version: 1, jobs: [job({ keep: 9, lastRun: { at: NOW - 60_000, ok: true }, clones: [{ name: 'c2', ref: 'vm-102', at: NOW - 60_000 }], history: [{ at: NOW - 60_000 }] })], ops: [{ id: 'op9' }] };
  const bak = { version: 1, jobs: [job({ lastRun: { at: NOW - 3 * 86_400_000, ok: true }, clones: [{ name: 'c1', ref: 'vm-101', at: 1 }], running: { at: 1, boot: 'old', snapName: 'portal-bk' } }),
    job({ id: 'j2', running: { at: 1, boot: 'old' }, lastRun: { at: 5 } })], ops: [] };
  const out = JSON.parse(SR.reconcileVmCloneText(J(bak), J(cur)).text);
  assert.equal(out.jobs[0].keep, 3, '정의는 백업 것');
  assert.deepEqual(out.jobs[0].clones.map((c) => c.name), ['c2'], '클론 원장은 지금 것');
  assert.equal(out.jobs[0].lastRun.at, NOW - 60_000);
  assert.equal(out.jobs[0].running, undefined, '백업 때 돌던 실행 표지');
  assert.equal(out.jobs[0].history.length, 1);
  assert.equal(out.jobs[1].running, undefined, '백업에만 있는 잡 — 실행 표지만 비운다');
  assert.equal(out.jobs[1].lastRun.at, 5);
  assert.deepEqual(out.ops, [{ id: 'op9' }]);
  // 지금 잡이 돌던 중이면(이번 재시작이 끊은 실행) 그 표지는 남는다 — 남은 스냅샷을 정리해야 한다
  const cur2 = { ...cur, jobs: [{ ...cur.jobs[0], running: { at: NOW, boot: 'b1', snapName: 's' } }] };
  assert.equal(JSON.parse(SR.reconcileVmCloneText(J(bak), J(cur2)).text).jobs[0].running.boot, 'b1');
  // 재해 복구 — 백업 그대로(실행 표지만 비움)
  const dr = JSON.parse(SR.reconcileVmCloneText(J(bak), null).text);
  assert.deepEqual(dr.jobs[0].clones.map((c) => c.name), ['c1']); assert.equal(dr.jobs[0].running, undefined); assert.deepEqual(dr.ops, []);
  assert.equal(SR.reconcileVmCloneText('{"jobs":[{"id":"a","keep":1}]}', null).text, '{"jobs":[{"id":"a","keep":1}]}', '바꿀 것이 없으면 글자 그대로');
  // 실제 모듈
  const d = mk(); w(d, 'vm-clone.json', cur);
  restore(d, { 'vm-clone.json': bak });
  const boot = child(d, `import { listJobs, isDue, interruptedRunOf } from '${u('vmclone/store.js')}'; const j = listJobs().find((x) => x.id === 'j1');
    console.log('OUT ' + JSON.stringify({ due: isDue(j, ${NOW}), clones: (j.clones || []).map((c) => c.name), interrupted: !!interruptedRunOf(j), keep: j.keep }));`);
  assert.deepEqual(boot, { due: false, clones: ['c2'], interrupted: false, keep: 3 });
});

test('F6 호스트 접근 제어 — 초안만 되돌리고 이 호스트의 적용 기록 · 확정 대기는 지금 것(실제 hostaccess/settings)', () => {
  const draft = { ssh: { mode: 'allowlist', allow: ['10.0.0.0/24'] } };
  const cur = { draft: { ssh: { mode: 'open' } }, applied: { at: 5, by: 'owner', fingerprint: 'NEW', rich: ['rule-new'], sshdStopped: true }, pending: null, revertedAt: 3 };
  const bak = { draft, applied: { at: 1, by: 'owner', fingerprint: 'OLD', rich: ['rule-old'], sshdStopped: false }, pending: { at: 1, deadline: 2, by: 'owner', fingerprint: 'X', rich: ['rule-x'] } };
  const m = SR.reconcileHostAccessText(J(bak), J(cur));
  const out = JSON.parse(m.text);
  assert.deepEqual(out.draft, draft, '초안은 백업 것');
  assert.equal(out.applied.fingerprint, 'NEW'); assert.equal(out.applied.sshdStopped, true); assert.equal(out.pending, null); assert.equal(out.revertedAt, 3);
  assert.deepEqual([m.keptState, m.droppedPending], [true, true]);
  // 지금 확정 대기 중이면 그 대기는 남는다(자동 되돌림 기한을 잇는다)
  assert.equal(JSON.parse(SR.reconcileHostAccessText(J(bak), J({ ...cur, pending: { at: 9, deadline: 99, rich: [] } })).text).pending.deadline, 99);
  // 지금 파일이 없으면 백업 그대로이되 확정 대기는 되살리지 않는다
  const dr = SR.reconcileHostAccessText(J(bak), null);
  assert.equal(JSON.parse(dr.text).applied.fingerprint, 'OLD'); assert.equal(JSON.parse(dr.text).pending, null); assert.equal(dr.droppedPending, true);
  assert.equal(SR.reconcileHostAccessText(J({ draft, applied: null, pending: null }), null).text, J({ draft, applied: null, pending: null }));
  // 실제 로더
  const d = mk(); w(d, 'host-access.json', cur);
  const res = restore(d, { 'host-access.json': bak });
  assert.match(res.warnings.find((x) => x.file === 'host-access.json')?.reason || '', /초안만.*확정 대기는 되살리지/);
  const boot = child(d, `import { loadHostAccess } from '${u('hostaccess/settings.js')}'; const st = loadHostAccess();
    console.log('OUT ' + JSON.stringify({ pending: !!st.pending, fp: st.applied?.fingerprint || null, sshd: st.applied?.sshdStopped ?? null }));`);
  assert.deepEqual(boot, { pending: false, fp: 'NEW', sshd: true });
});

const sched = (id, t, args, over = {}) => ({ id, name: id, test: t, args, intervalSec: 60, instance: '', enabled: true, updatedAt: 1, ...over });
test('결정 ① 원격 명령 점검 스케줄 — 셸 점검(script · ssh)은 지금 같은 내용으로 켜져 있을 때만 켠 채 복원(실제 rma/schedules)', async () => {
  const { scheduleSignRequired, SCHEDULE_SIGNED_TESTS } = await import('../src/rma/signing.js');
  assert.deepEqual([...SCHEDULE_SIGNED_TESTS], ['script', 'ssh'], '전제: 셸을 주기 실행하는 점검 집합(바뀌면 이 시험의 입력도 맞춘다)');
  const sh = sched('t_sh', 'script', { path: '/opt/a.sh', timeoutSec: 5 });
  const file = (tests, version = 3) => ({ version: 1, agents: { edge1: { version, tests } } });
  const rec = (bak, cur) => { const x = SR.reconcileRmaSchedulesText(J(bak), cur == null ? null : J(cur)); return { ...x, a: JSON.parse(x.text).agents.edge1 }; };
  const en = (x) => x.a.tests.map((t) => `${t.id}:${t.enabled !== false}`);
  const ping = sched('t_ping', 'ping', { host: '10.0.0.1' });
  // 지웠다 → 꺼서 복원 · 버전은 지금보다 크게(엣지가 다시 받는다)
  let x = rec(file([ping, sh]), file([ping], 5));
  assert.deepEqual(en(x), ['t_ping:true', 't_sh:false']); assert.equal(x.disabled, 1); assert.equal(x.a.version, 6);
  // 지금 같은 내용으로 켜져 있다 → 글자 그대로
  x = rec(file([ping, sh]), file([{ ...sh, args: { timeoutSec: 5, path: '/opt/a.sh' }, name: '다른 이름' }], 9));
  assert.equal(x.disabled, 0); assert.equal(x.text, J(file([ping, sh])));
  // 껐다 · 인수 · 주기 · 인스턴스 · 점검 종류를 고쳤다 → 꺼서 복원
  for (const now of [{ ...sh, enabled: false }, { ...sh, args: { path: '/opt/b.sh', timeoutSec: 5 } }, { ...sh, intervalSec: 3600 }, { ...sh, instance: 'i2' }, { ...sh, test: 'ping', args: { host: 'x' } }]) {
    assert.deepEqual(en(rec(file([sh]), file([now]))), ['t_sh:false'], J(now));
  }
  assert.deepEqual(en(rec(file([sched('t_s', 'ssh', { host: 'h', credentialId: 'c', command: 'uptime' })]), file([]))), ['t_s:false'], 'ssh 점검');
  // 셸이 아닌 점검 · 백업에서 이미 꺼진 셸 점검은 그대로
  assert.equal(rec(file([ping, { ...sh, enabled: false }]), file([])).disabled, 0);
  // 법인 이름 대소문자 · 재해 복구 · 손상
  assert.equal(SR.reconcileRmaSchedulesText(J({ agents: { EDGE1: { version: 1, tests: [sh] } } }), J({ agents: { edge1: { version: 1, tests: [sh] } } })).disabled, 0);
  assert.equal(SR.reconcileRmaSchedulesText(J(file([sh])), null).text, J(file([sh])), '지금 파일 없음(재해 복구) — 백업 그대로');
  assert.equal(SR.reconcileRmaSchedulesText(J(file([sh])), '{깨짐').text, J(file([sh])));
  assert.equal(scheduleSignRequired('script') && scheduleSignRequired('ssh') && !scheduleSignRequired('ping'), true);
  // 실제 모듈 — 엣지에 내려가는 배정
  const d = mk(); w(d, 'rma-schedules.json', file([ping], 5));
  const res = restore(d, { 'rma-schedules.json': file([ping, sh]) });
  assert.match(res.warnings.find((y) => y.file === 'rma-schedules.json')?.reason || '', /1개.*꺼진 채로.*본인 OTP/);
  const boot = child(d, `import { scheduleFor, assignForInstance } from '${u('rma/schedules.js')}'; const s = scheduleFor('edge1');
    console.log('OUT ' + JSON.stringify({ version: s.version, stored: s.tests.map((t) => t.test + ':' + (t.enabled !== false)), sent: assignForInstance(s, 'default', ['default']).tests.map((t) => t.test) }));`);
  assert.deepEqual(boot, { version: 6, stored: ['ping:true', 'script:false'], sent: ['ping'] }, '지운 셸 점검이 엣지에 다시 내려갑니다');
});

test('결정 ② 통합 계정 — 지운 계정은 되살리지 않고 범위는 좁은 쪽(실제 브로커)', () => {
  const c = (id, hosts, agents, over = {}) => ({ id, name: id, kind: 'password', username: 'root', password: `pw-${id}`, hosts, agents, createdAt: 1, ...over });
  const f = (items) => ({ version: 1, items });
  const rec = (bak, cur) => { const x = SR.reconcileCredentialsText(J(bak), cur == null ? null : J(cur)); return { ...x, items: JSON.parse(x.text).items }; };
  let x = rec(f([c('k', ['10.1.0.0/16', '10.1.0.5'], ['*']), c('gone', ['*'], ['*'])]), f([c('k', ['10.1.0.5'], ['edge1'], { password: 'new-pw' }), c('newer', ['*'], ['*'])]));
  assert.deepEqual(x.items.map((i) => i.id), ['k'], '지운 계정은 되살리지 않는다(지금에만 있는 계정은 예전처럼 백업 판본에 없다)');
  assert.deepEqual([x.items[0].hosts, x.items[0].agents], [['10.1.0.5'], ['edge1']], '범위는 좁은 쪽');
  assert.equal(x.items[0].password, 'pw-k', '비밀 · 이름은 백업 내용');
  assert.deepEqual([x.dropped, x.narrowed], [1, 1]);
  // 지금이 전부 허용이면 백업 범위 · 글자 그대로 겹치는 항목만 · 겹치는 것이 없으면 빈 범위(브로커가 내주지 않는다)
  assert.deepEqual(rec(f([c('k', ['a.corp', 'b.corp'], ['edge1'])]), f([c('k', ['*'], ['*'])])).items[0].hosts, ['a.corp', 'b.corp']);
  assert.deepEqual(rec(f([c('k', ['a.corp', 'B.corp'], ['edge1', 'edge2'])]), f([c('k', ['b.corp', 'c.corp'], ['EDGE2'])])).items[0], { ...c('k', ['B.corp'], ['edge2']) });
  assert.deepEqual(rec(f([c('k', ['10.0.0.0/8'], ['edge1'])]), f([c('k', ['10.1.0.0/16'], ['edge1'])])).items[0].hosts, [], 'CIDR 포함 관계는 따지지 않는다 — 더 좁아질 뿐');
  // 바뀐 것이 없으면 글자 그대로 · 재해 복구 · 손상
  const same = f([c('k', ['10.1.0.5'], ['edge1'])]);
  assert.equal(SR.reconcileCredentialsText(J(same), J(same)).text, J(same));
  assert.equal(SR.reconcileCredentialsText(J(same), null).text, J(same), '지금 파일 없음(재해 복구) — 백업 그대로');
  assert.equal(SR.reconcileCredentialsText(J(same), '{깨짐').text, J(same));
  // 실제 브로커
  const d = mk(); w(d, 'credentials.json', f([c('cred_keep', ['10.1.0.5'], ['edge1'])]));
  const res = restore(d, { 'credentials.json': f([c('cred_keep', ['10.1.0.0/16', '10.1.0.5'], ['*']), c('cred_gone', ['*'], ['*'])]) });
  assert.match(res.warnings.find((y) => y.file === 'credentials.json')?.reason || '', /지운 통합 계정 1개.*좁은 쪽/);
  const boot = child(d, `import { brokerFetch } from '${u('security/credentialStore.js')}';
    console.log('OUT ' + JSON.stringify({ gone: brokerFetch('cred_gone', { agent: 'edge9', host: '10.9.9.9' }).ok, wideHost: brokerFetch('cred_keep', { agent: 'edge1', host: '10.1.200.7' }).ok,
      otherAgent: brokerFetch('cred_keep', { agent: 'edge2', host: '10.1.0.5' }).ok, still: brokerFetch('cred_keep', { agent: 'edge1', host: '10.1.0.5' }).ok }));`);
  assert.deepEqual(boot, { gone: false, wideHost: false, otherAgent: false, still: true });
});

test('재해 복구 — 지금 파일이 하나도 없는 새 서버에는 (복원 제외만 빼고) 전부 백업 그대로 들어간다', () => {
  const d = mk();
  const files = {
    'bareos-groups.json': grp(3), 'storage-auth-stops.json': { a: { credHash: 'h', since: 1, at: 1, attempts: 1, reason: 'x' } }, 'daily-report.json': { enabled: true, lastRunTs: 5 },
    'vm-clone.json': { version: 1, jobs: [{ id: 'j', clones: [{ name: 'c1' }], lastRun: { at: 1 } }], ops: [] }, 'host-access.json': { draft: { a: 1 }, applied: { fingerprint: 'F' }, pending: null },
    'rma-schedules.json': { version: 1, agents: { edge1: { version: 2, tests: [sched('t', 'script', { path: '/a.sh' })] } } },
    'credentials.json': { version: 1, items: [{ id: 'c1', hosts: ['*'], agents: ['*'], password: 'p' }] },
    'bareos-rehearsal-state.json': { weeks: { d: '2026-01-01' } }, 'veeam-backup-runs.json': { runs: [] }, 'svcmon.json': { targets: [] }, 'scan-journal.json': { active: [] },
  };
  const res = restore(d, files);
  assert.deepEqual(res.staged.dropped.map((x) => x.file), ['scan-journal.json']);
  assert.deepEqual(res.failed, []); assert.deepEqual(res.kept, []); assert.deepEqual(res.warnings.filter((x) => !/OTP 를 묻지|세션|AD/.test(x.reason)), []);
  assert.equal(res.applied.length, Object.keys(files).length - 1);
  for (const [name, v] of Object.entries(files)) {
    if (name === 'scan-journal.json') { assert.equal(has(d, name), false); continue; }
    assert.deepEqual(r(d, name), name === 'bareos-groups.json' ? { groups: [{ ...v.groups[0], sending: null }] } : v, `${name} — 새 서버에서 백업과 다릅니다`);
  }
});

/* ══ ③ 공개 API 자기점검 ════════════════════════════════════════════════════════════════════ */

test('공개 API GET /api/v1/ — 경로의 allowed 는 실제 호출 결과와 같다(범위 키 · 전체 범위 전용 경로)', () => {
  const dir = mk();
  const boot = `
    const express = (await import('express')).default;
    const { store } = await import(${JSON.stringify(path.join(SRC, 'store.js'))});
    const v1 = (await import(${JSON.stringify(path.join(SRC, 'routes/publicApi.js'))})).default;
    const keys = await import(${JSON.stringify(path.join(SRC, 'publicapi/keys.js'))});
    await store.refresh({ force: true });
    const app = express(); app.use('/api/v1', v1);
    const srv = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
    const base = 'http://127.0.0.1:' + srv.address().port + '/api/v1';
    const call = async (p, key) => { const res = await fetch(base + p, { headers: { 'X-Api-Key': key } }); let body = null; try { body = await res.json(); } catch { body = null; } return { status: res.status, code: body?.code || null, body }; };
    const vc = String(store.get().vcenters[0].id);
    const mkKey = (name, vcenters) => keys.issueApiKey({ name, groups: ['inventory', 'capacity', 'faults'], vcenters }).plaintext;
    const scoped = mkKey('scoped', [vc]); const full = mkKey('full', []);
    const out = {};
    for (const [k, key] of [['scoped', scoped], ['full', full]]) {
      const cat = await call('/', key);
      const eps = cat.body.data.endpoints;
      const rows = [];
      for (const e of eps) { const live = await call(e.path, key); rows.push({ path: e.path, allowed: e.allowed, deniedBy: e.deniedBy || null, status: live.status, code: live.code }); }
      out[k] = { rows, note: cat.body.meta.note };
    }
    srv.close();
    console.log('OUT ' + JSON.stringify(out));
  `;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', boot], { env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUTH_ENABLED: 'false' }, encoding: 'utf8', cwd: ROOT, timeout: 180_000 });
  const line = (res.stdout || '').split('\n').filter((l) => l.startsWith('OUT ')).pop();
  assert.ok(line, `자식 프로세스 실패: ${(res.stderr || res.stdout || '').slice(-1500)}`);
  const out = JSON.parse(line.slice(4));
  // 범위 키: allowed 가 실제 게이트와 같다 — 예전에는 전체 범위 전용 경로(스토리지 · 부품 장애)가 allowed:true 였다
  const denied = out.scoped.rows.filter((x) => !x.allowed);
  assert.deepEqual(denied.filter((x) => x.deniedBy === 'needs-full-scope').map((x) => x.path).sort(), ['/capacity/storage', '/capacity/storage-growth', '/faults/parts']);
  for (const x of [...out.scoped.rows, ...out.full.rows]) {
    if (x.allowed) { assert.notEqual(x.status, 403, `${x.path} — allowed:true 인데 실제 호출은 403(${x.code})`); assert.equal(x.deniedBy, null); }
    else { assert.equal(x.status, 403, `${x.path} — allowed:false 인데 ${x.status}`); assert.equal(x.code, x.deniedBy, `${x.path} — deniedBy 가 실제 거절 코드와 다릅니다`); }
  }
  assert.ok(out.scoped.rows.filter((x) => x.allowed).length >= 4, '범위 키로 되는 경로(인벤토리 · 데이터스토어 · 알람)는 그대로 allowed');
  // 전체 범위 키: 분류가 없는 SAN 만 거절(group-denied) · 스토리지 · 부품 장애는 allowed
  assert.deepEqual([...new Set(out.full.rows.filter((x) => !x.allowed).map((x) => x.deniedBy))], ['group-denied']);
  assert.equal(out.full.rows.find((x) => x.path === '/capacity/storage').allowed, true);
  assert.match(out.scoped.note, /needs-full-scope/);
});

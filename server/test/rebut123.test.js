/**
 * rebut123.test.js — 전체 점검 123회차: 112회차(설정 화면 스윕) · 115회차(107 반증) · 메인 직접 수정(읽기 오류 문구 · 설정 상태 배지)에 대한 적대적 재검토(반증).
 *
 *  S1 설정 상태 배지(메인 수정의 형제 누락 — 재현: 파일 자리에 폴더 = EISDIR): vCenter · NSX 만 고쳐져 있었다. 법인 · 정기 백업 · 디렉터리 사용량 · 게스트 파티션(guest-disk) ·
 *     AD · 호스트 접근 제어 · 알림 · 메일 · AI 검색 · 업그레이드는 읽기 오류 동안 '등록된 법인 없음 · 정기 백업 꺼짐 · 리포트 대상 없음 · 꺼짐 · 사용 안 함 · 알림 채널 없음 ·
 *     SMTP 미설정'(또는 표시 없음)이라고 말했고, 중계 서버는 읽기 오류에 '손상 보존본 확인' 이라고 말했다(보존본이 없다).
 *  U1 업그레이드 설정(112회차 분류표 'out' 대조 — 재현): 기동 때 upgrade.json 이 읽기 오류면 UpgradeManager 는 env 기본값으로 시작하고, 다시 읽힌 뒤에도
 *     재시작 · 저장까지 그 값으로 돌았다(settings.js 의 30초 재읽기는 매니저에 닿지 않는다). 조회(status)는 표지 없이 그 값을 줘 화면 폼이 env 기본값으로 채워졌고,
 *     그 폼의 저장이 원격 소스 주소를 env 값으로 되돌리며 저장된 토큰을 폐기했다.
 *  T1 분류표(settingsUnreadSweep112) — 'out' 5개 대조 결과를 옮겼다(그 표의 자기 검사는 그 파일이 한다 · 여기서는 화면 · 라우트 배선만).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');
const WEB = path.join(HERE, '..', '..', 'web', 'src');
const TMP_DIRS = [];
const mk = (tag) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `rebut123-${tag}-`)); TMP_DIRS.push(d); return d; };
after(() => { for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } } });
// 이 프로세스가 직접 들이는 모듈(U1 · A1)의 설정 폴더 — config 를 처음 들이기 전에 정한다(S1 은 파일마다 새 프로세스).
const CFG = mk('cfg');
process.env.CONFIG_DIR = CFG; process.env.DATA_DIR = CFG; process.env.DATA_SOURCE = 'mock';
for (const k of ['UPGRADE_ENABLED', 'UPGRADE_WATCH_DIR', 'EDGE_MODE', 'CENTRAL_URL']) delete process.env[k];
process.env.UPGRADE_REMOTE_BASE = 'https://env.example.invalid/dl';
/** 그 파일 이름만 EIO — 파일은 그대로 있는 읽기 오류(권한 · 디스크). 돌려주는 함수가 주입을 푼다. */
function eio(name) {
  const prev = fs.readFileSync;
  fs.readFileSync = (f, ...a) => { if (path.basename(String(f)) === name) { const e = new Error('EIO: i/o error, read'); e.code = 'EIO'; throw e; } return prev.call(fs, f, ...a); };
  return () => { fs.readFileSync = prev; };
}

/* ── S1: 설정 상태 배지 — 모듈이 기동 때 한 번 읽고 캐시하므로 파일마다 새 프로세스 ───────────────────────────────────── */
function badges(unreadableFile) {
  const d = mk('ss');
  if (unreadableFile) fs.mkdirSync(path.join(d, unreadableFile));   // 파일 자리에 폴더 — readFileSync 가 EISDIR(읽기 오류 · 원본을 옮기지 않는다)
  const env = { ...process.env, CONFIG_DIR: d, DATA_DIR: d, PORT: '4000', DATA_SOURCE: 'mock' };
  for (const k of ['UPGRADE_ENABLED', 'UPGRADE_WATCH_DIR', 'UPGRADE_REMOTE_BASE', 'EDGE_MODE', 'CENTRAL_URL']) delete env[k];
  const code = `
    const { buildSettingsStatus } = await import(${JSON.stringify(path.join(SRC, 'settingsStatus', 'grade.js'))});
    const { settingsStatusSources } = await import(${JSON.stringify(path.join(SRC, 'settingsStatus', 'sources.js'))});
    const w = console.warn; const e = console.error; console.warn = () => {}; console.error = () => {};
    const r = buildSettingsStatus(settingsStatusSources(), { superAdmin: true });
    console.warn = w; console.error = e;
    process.stdout.write('\\n@@' + JSON.stringify(r.items) + '\\n');
    process.exit(0);
  `;
  const p = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env, encoding: 'utf8', cwd: path.join(HERE, '..') });
  const m = /@@(.*)/.exec(p.stdout || '');
  assert.ok(m, `배지 계산 실패(${unreadableFile || '기준'}): ${(p.stderr || '').slice(-300)}`);
  return JSON.parse(m[1]);
}

test('S1 설정 상태: 설정 파일 읽기 오류는 등록 없음 · 꺼짐 · 사용 안 함 · 미설정이 아니라 주의(읽기 오류 — 원본은 그대로) — 형제 11개 + vCenter · NSX', () => {
  const base = badges(null);
  // 기준(파일 없음 = 정말 비어 있다)은 예전 판정 그대로 — 과잉 주의 변이를 잡는다
  assert.deepEqual(base['datacenter-admin'], { grade: 'unset', text: '등록된 법인 없음' });
  assert.deepEqual(base.backup, { grade: 'unset', text: '정기 백업 꺼짐' });
  assert.deepEqual(base['dir-usage'], { grade: 'off', text: '리포트 대상 없음' });
  assert.deepEqual(base['guest-partition'], { grade: 'off', text: '꺼짐' });
  assert.deepEqual(base['auth-ad'], { grade: 'off', text: '사용 안 함' });
  assert.equal(base['host-access'], undefined);
  assert.deepEqual(base.alerts, { grade: 'unset', text: '알림 채널 없음' });
  assert.deepEqual(base.mail, { grade: 'unset', text: 'SMTP 미설정' });
  assert.deepEqual(base['ai-search'], { grade: 'off', text: '사용 안 함' });
  assert.deepEqual(base.proxy, { grade: 'off', text: '중계 서버 없음' });

  const READ = '설정 파일을 읽지 못함(읽기 오류 — 원본은 그대로)';
  const cases = {
    'datacenter-admin': ['datacenters.json', READ],
    backup: ['backup.json', READ],
    'dir-usage': ['dirusage.json', READ],
    'guest-partition': ['guest-disk.json', '설정을 읽지 못함'],   // 규칙이 이미 주의 문구를 낸다(손상 보존본을 말하지 않는다)
    'auth-ad': ['auth.json', READ],
    'host-access': ['host-access.json', READ],
    alerts: ['alerts.json', READ],
    mail: ['mail.json', READ],
    'ai-search': ['llm.json', READ],
    upgrade: ['upgrade.json', READ],
    proxy: ['remote-access.json', READ],   // 예전: '설정 파일을 읽지 못함(손상 보존본 확인)' — 읽기 오류에는 보존본이 없다
    // 메인 수정(vCenter · NSX)도 실제 사실 함수로 본다 — mainFix115 는 손으로 만든 사실과 소스 대조만 한다
    'vcenter-admin': ['vcenters.json', '등록부를 읽지 못함(읽기 오류 — 원본은 그대로)'],
    'nsx-admin': ['nsx.json', '등록부를 읽지 못함(읽기 오류 — 원본은 그대로)'],
  };
  for (const [key, [file, text]] of Object.entries(cases)) {
    const it = badges(file)[key];
    assert.deepEqual(it, { grade: 'warn', text }, `${key}(${file})`);
    assert.doesNotMatch(it.text, /없음|꺼짐|사용 안 함|미설정|손상 보존본/, key);
  }
});

test('S1 판정 코어: readError 는 손상과 문구를 가르고 · 규칙이 이미 낸 주의 문구는 둔다 · 손상(보존본)은 예전 문구', async () => {
  const { buildSettingsStatus } = await import('../src/settingsStatus/grade.js');
  const one = (k, facts) => buildSettingsStatus({ [k]: () => facts }).items[k] ?? null;
  assert.equal(one('alerts', { loadError: true, readError: true, channels: null }).text, '설정 파일을 읽지 못함(읽기 오류 — 원본은 그대로)');
  assert.equal(one('alerts', { loadError: true, readError: false, channels: 0 }).text, '설정 파일을 읽지 못함(손상 보존본 확인)');
  assert.deepEqual(one('alerts', { loadError: false, readError: false, channels: 0 }), { grade: 'unset', text: '알림 채널 없음' });
  assert.equal(one('alerts', { loadError: false, readError: false, channels: 2 }), null);
  assert.equal(one('host-access', { pendingOverdue: true, loadError: false, readError: false }).text, '적용 확인 기한 지남');
  assert.equal(one('host-access', { pendingOverdue: false, loadError: true, readError: true }).grade, 'warn');
  assert.equal(one('vcenter-admin', { loadError: true, readError: true, count: null, authStopped: 0 }).text, '등록부를 읽지 못함(읽기 오류 — 원본은 그대로)');   // 메인 수정 문구 유지
  assert.equal(one('mail', { loadError: true, readError: true, configured: null, authStopped: true }).text, 'SMTP 인증 실패로 발송 정지');   // 이미 주의면 그 문구
});

/* ── U1: 업그레이드 설정 — 기동 때 읽기 오류 → 다시 읽힌 뒤 ───────────────────────────────────────────────────────── */
test('U1 업그레이드: 기동 때 upgrade.json 읽기 오류 → 다시 읽히면 매니저가 저장된 설정으로 돌아온다(env 기본값에 머물지 않는다) · 그동안은 표지', async () => {
  fs.writeFileSync(path.join(CFG, 'upgrade.json'), JSON.stringify({ enabled: false, remoteBase: 'https://mirror.example.invalid/portal', token: 'saved-token-123', autoApply: false }));

  const RD = await import('../src/util/jsonFileRead.js');
  let NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;   // 실제 시각에서 정시 경계로 고정(재읽기 간격 판정)
  RD._setJsonFileLoadClockForTest(() => NOW);
  let restore = eio('upgrade.json');
  const log = console.log; console.log = () => {};
  try {
    const st = await import('../src/upgrade/settings.js');
    const { UpgradeManager } = await import('../src/upgrade/manager.js');
    const { unreadMark } = await import('../src/routes/settingsUnreadMark.js');
    const m = new UpgradeManager();
    // 못 읽은 채 시작: env 기본값 + 표지
    assert.equal(m.settingsUnread, true);
    assert.equal(m.status().remoteBase, 'https://env.example.invalid/dl');
    assert.equal(m.syncSettingsAfterUnread(), true, '아직 못 읽는다');
    assert.equal(unreadMark(st.upgradeSettingsWriteRefusal()).loadError?.readError, true, '조회 표지');
    assert.doesNotMatch(unreadMark(st.upgradeSettingsWriteRefusal()).loadError.reason, /upgrade\.json|\//, '표지 사유에 파일 이름 · 경로가 없다');

    // 다시 읽힘(권한 · 디스크를 고쳤다) + 재읽기 간격
    restore(); restore = () => {};
    NOW += RD.READ_RETRY_MS + 1_000;
    assert.equal(m.syncSettingsAfterUnread(), false, '읽혔다');
    assert.equal(m.settingsUnread, false);
    const s = m.status();
    assert.equal(s.remoteBase, 'https://mirror.example.invalid/portal', '저장된 원격 소스 주소(수정 전: env 기본값에 머물렀다)');
    assert.equal(s.autoApply, false);
    assert.equal(m.settings.token, 'saved-token-123', '저장된 토큰');
    assert.deepEqual(unreadMark(st.upgradeSettingsWriteRefusal()), {}, '표지 해제');
    // 화면이 다시 채운 폼(저장된 주소)으로 저장하면 토큰은 폐기되지 않는다 — 수정 전 판본은 env 주소 폼이라 폐기였다
    assert.equal(st.upgradeTokenDropped(st.loadSettings(), { remoteBase: s.remoteBase }), false);
    assert.equal(st.upgradeTokenDropped(st.loadSettings(), { remoteBase: 'https://env.example.invalid/dl' }), true, '전제: env 주소 폼의 저장은 토큰을 폐기한다');
    assert.equal(m.syncSettingsAfterUnread(), false, '두 번째 호출은 아무 일도 하지 않는다');
  } finally {
    restore(); console.log = log; RD._setJsonFileLoadClockForTest();
  }
});

test('U1 배선: 업그레이드 조회 둘이 표지를 싣고(다시 읽힘 확인 먼저) · 화면이 저장을 잠그고 폼을 다시 채운다', () => {
  const route = fs.readFileSync(path.join(SRC, 'routes', 'upgrade.js'), 'utf8');
  assert.match(route, /const statusView = \(\) => \{ upgradeManager\.syncSettingsAfterUnread\(\); return \{ \.\.\.upgradeManager\.status\(\), \.\.\.unreadMark\(upgradeSettingsWriteRefusal\(\)\) \}; \};/);
  assert.equal((route.match(/res\.json\(statusView\(\)\);/g) || []).length, 2, 'GET /status · GET /settings');
  const mgr = fs.readFileSync(path.join(SRC, 'upgrade', 'manager.js'), 'utf8');
  assert.match(mgr, /if \(this\.settingsUnread\) this\.#armUnreadRetry\(\);/, 'start() 가 읽힐 때까지 다시 본다(화면을 열지 않아도)');
  const web = fs.readFileSync(path.join(WEB, 'views', 'Upgrade.jsx'), 'utf8');
  assert.match(web, /if \(seedKind\.current === null \|\| shouldReseed\(seedKind\.current, le\)\) \{ seedKind\.current = unreadKind\(le\); setForm\(blankForm\(s\)\);/);
  assert.match(web, /disabled=\{busy \|\| saveLocked\} onClick=\{saveSettings\}/);
  assert.match(web, /if \(saveLockedByUnread\(unreadMarkOf\(status\)\)\) return;/);
  assert.doesNotMatch(web, /setForm\(\(f\) => f \|\| blankForm\(s\)\)/, '처음 받은 값을 끝까지 드는 꼴이 남아 있지 않다');
});

/* ── A1: 첨부 전체 상한 설정(112회차 분류표 'left' 대조) ─────────────────────────────────────────────────────────── */
test('A1 첨부 상한: 설정 파일 읽기 오류 동안 조회가 표지를 싣고(기본 상한) · 화면이 저장을 잠그고 손상 문구를 쓰지 않는다 · 읽히면 풀린다', async () => {
  fs.writeFileSync(path.join(CFG, 'attach-settings.json'), JSON.stringify({ maxTotalMB: 9000 }));
  const RD = await import('../src/util/jsonFileRead.js');
  let NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000 + 7_200_000;
  RD._setJsonFileLoadClockForTest(() => NOW);
  const A = await import('../src/attach/store.js');
  const { unreadMark } = await import('../src/routes/settingsUnreadMark.js');
  A._resetAttachCache();
  let restore = eio('attach-settings.json');
  try {
    assert.notEqual(A.loadAttachSettings().maxTotalMB, 9000, '전제: 못 읽은 동안은 기본 상한');
    const mark = unreadMark(A.attachSettingsWriteRefusal(), 'settingsLoadError');
    assert.equal(mark.settingsLoadError?.readError, true);
    assert.equal(mark.settingsLoadError.code, 'EIO');
    assert.doesNotMatch(mark.settingsLoadError.reason, /attach-settings|\//);
    restore(); restore = () => {};
    NOW += RD.READ_RETRY_MS + 1_000;
    assert.deepEqual(unreadMark(A.attachSettingsWriteRefusal(), 'settingsLoadError'), {});
    assert.equal(A.loadAttachSettings().maxTotalMB, 9000);
  } finally { restore(); RD._setJsonFileLoadClockForTest(); A._resetAttachCache(); }
  const route = fs.readFileSync(path.join(SRC, 'routes', 'api', 'attach.js'), 'utf8');
  assert.match(route, /loadError: attachSettingsError\(\), \.\.\.unreadMark\(attachSettingsWriteRefusal\(\), 'settingsLoadError'\)/);
  const web = fs.readFileSync(path.join(WEB, 'views', 'attach', 'AttachAdmin.jsx'), 'utf8');
  assert.match(web, /\{unread\s*\? <SettingsUnreadBanner le=\{unread\} what="첨부 전체 상한 설정" save="상한 저장" onRecheck=\{load\}/);
  assert.match(web, /disabled=\{busy \|\| !cap \|\| saveLocked\} onClick=\{save\}/);
  assert.match(web, /if \(saveLocked\) return;/);
});

/* ── 112회차 반증: 화면 배선(순수 판정 · 렌더는 web/src/views/rebut123.test.js) ─────────────────────────────────────── */
test('112 반증 배선: 사용량 메일 지금 보내기가 표지만 지우지 않는다 · 디스크 점검 배너에 다시 확인 · 권한 화면 잠금', () => {
  const mail = fs.readFileSync(path.join(WEB, 'views', 'tools', 'StorageUsageTool.jsx'), 'utf8');
  assert.match(mail, /if \(r\?\.status\) \{ if \(unreadKind\(unreadMarkOf\(r\.status\)\) !== unreadKind\(unreadMarkOf\(data\.status\)\)\) await load\(\); else setData\(/);
  const dbad = fs.readFileSync(path.join(WEB, 'views', 'tools', 'DiskBadTool.jsx'), 'utf8');
  assert.match(dbad, /<SettingsUnreadBanner le=\{unread\} what="디스크 배드 섹터 점검 설정"[^>]*onRecheck=\{reload\}/);
  const ua = fs.readFileSync(path.join(WEB, 'views', 'UserAdmin.jsx'), 'utf8');
  assert.match(ua, /const permLocked = saveLockedByUnread\(unreadMarkOf\(perms\), \{ corruptLocks: true \}\);/);
  assert.match(ua, /disabled=\{!permDirty \|\| permLocked\} onClick=\{savePerms\}/);
  assert.match(ua, /if \(shouldReseed\(unreadKind\(unreadMarkOf\(permsRef\.current\)\), unreadMarkOf\(p\)\)\) setPermDirty\(false\);/);
});

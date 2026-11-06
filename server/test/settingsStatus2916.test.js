// v2.916 — 설정 메뉴 상태 배지(GET /api/admin/settings/status · settingsStatus/grade.js · sources.js).
// 사용자 요청: '설정 메뉴를 클로드 디자인 사용해서 개편 — 효율적이고 직관적으로' → 시안 A안 + B의 상태 요약 · 배지는 '항목별 미설정 전부'.
// 고정하는 것:
//   ① 등급 규칙 — 미설정(unset) · 꺼짐(off: opt-in 미사용, 미설정 아님) · 주의(warn) · 새 버전(new). 정상은 싣지 않는다.
//   ② 못 읽은 값은 0 이 아니다 — 사실 함수가 던지거나 객체가 아니면 그 항목만 unknown, 수가 null 이면 미설정으로 보지 않는다.
//   ③ 슈퍼 전용 항목(아이실론)은 슈퍼 관리자에게만(불리언도 정보다).
//   ④ sources.js 는 파일 · 메모리 값만 — 외부 호출 · SQLite · 디렉터리 훑기 · 기록을 지우는 인증 정지 판정(authStopFor)이 없다(원문 대조).
//   ⑤ 규칙의 키는 설정 화면(Settings.jsx SUB)의 키이고, 슈퍼 전용 목록은 화면의 superOnly 와 같다.
//   ⑥ 라우트 — viewer · 소유자 아닌 admin · 범위가 지정된 소유자는 403, 소유자(전체 범위)는 200 + items. 응답에 비밀이 실리지 않는다.
//   ⑦ 반증(v2.916) 반영 — D1 저장 직후 반영(no-store · ETag 없음 · fresh=1) · D2 손상 보존본만 있으면 주의 · D3 중계 서버 꺼짐이 켜진다 ·
//      D4 인증이 꺼진 설치에서 listUsers 를 부르지 않는다 · D5 자가진단 '못 함' 은 unknown · D6 GPU 게스트는 복호 없는 '켜짐' 만.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ss2916-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(HERE, '..', '..', p), 'utf8');

const { RULES, SUPER_ONLY, buildSettingsStatus } = await import('../src/settingsStatus/grade.js');

const one = (k, facts, who) => buildSettingsStatus({ [k]: () => facts }, who).items[k] || null;

test('① 등급 규칙 — 미설정 · 꺼짐 · 주의 · 새 버전, 정상은 싣지 않는다', () => {
  assert.equal(one('vcenter-admin', { count: 0, authStopped: 0 }).grade, 'unset');
  assert.equal(one('vcenter-admin', { count: 3, authStopped: 0 }), null, '정상은 표시 없음');
  assert.deepEqual(one('vcenter-admin', { count: 3, authStopped: 2 }), { grade: 'warn', text: '인증 실패로 수집 정지 2대', count: 2 });
  assert.equal(one('mail', { configured: false }).grade, 'unset');
  assert.equal(one('mail', { configured: true, authStopped: true }).grade, 'warn');
  assert.equal(one('alerts', { channels: 0 }).grade, 'unset');
  assert.equal(one('backup', { scheduleEnabled: false }).grade, 'unset');
  assert.equal(one('secrets', { mode: 'plain' }).grade, 'unset');
  assert.equal(one('secrets', { mode: 'sealed', locked: true }).grade, 'warn', '정책 잠김은 주의(평문 미설정보다 먼저)');
  // opt-in 은 꺼짐이지 미설정이 아니다
  for (const k of ['nsx-admin', 'horizon-admin', 'veeam', 'collectors']) assert.equal(one(k, { count: 0 }).grade, 'off', k);
  for (const k of ['vmseries', 'sansw-perf', 'guest-partition', 'gpu-guest', 'ai-search']) assert.equal(one(k, { enabled: false }).grade, 'off', k);
  assert.equal(one('auth-ad', { enabled: false, warnings: 0 }).grade, 'off');
  assert.equal(one('auth-ad', { enabled: true, warnings: 1 }).grade, 'warn');
  // 등록부 손상은 꺼짐 · 미설정보다 먼저 주의
  assert.equal(one('veeam', { loadError: true, count: null }).grade, 'warn');
  assert.equal(one('bareos', { loadError: true, directors: null }).grade, 'warn');
  assert.equal(one('peer-trust', { loadError: false, pending: 3, changed: 1 }).text, '승인 대기 3건(변경 1)');
  assert.equal(one('security-self-check', { risk: 1, warn: 2 }).text, '위험 1 · 경고 2');
  assert.equal(one('security-self-check', { risk: 0, warn: 0 }), null);
  assert.deepEqual(one('upgrade', { available: true, latest: '2.999.0', remoteConfigured: true }), { grade: 'new', text: '새 버전 2.999.0' });
  assert.equal(one('upgrade', { available: false, remoteConfigured: false, watchDir: false }).grade, 'unset');
  assert.equal(one('upgrade', { available: false, remoteConfigured: false, watchDir: true }), null, '감시 폴더만 있어도 소스가 있다');
  assert.equal(one('host-access', { pendingOverdue: true }).grade, 'warn');
  // D5: 점검을 못 한 항목만 있으면 '?'
  assert.deepEqual(one('security-self-check', { risk: 0, warn: 0, unknown: 2 }), { grade: 'unknown', text: '확인하지 못한 점검 2개', count: 2 });
  // D2: 손상 보존본만 남은 설정은 미설정 · 꺼짐이 아니라 주의(규칙이 낸 주의 문구는 그대로)
  assert.equal(one('mail', { loadError: true, configured: false }).grade, 'warn');
  assert.equal(one('nsx-admin', { loadError: true, count: 0 }).grade, 'warn');
  assert.equal(one('vcenter-admin', { loadError: true, count: 0 }).text, '설정 파일을 읽지 못함(손상 보존본 확인)');
  assert.equal(one('veeam', { loadError: true }).text, '등록부를 읽지 못함');
});

test('② 못 읽은 값은 0 이 아니다 — 던지면 unknown · null 수는 미설정이 아니다 · 다른 항목은 계속', () => {
  const r = buildSettingsStatus({
    'vcenter-admin': () => { throw new Error('boom'); },
    mail: () => null,
    'datacenter-admin': () => ({ count: null }),
    alerts: () => ({ channels: 0 }),
  });
  assert.equal(r.items['vcenter-admin'].grade, 'unknown');
  assert.equal(r.items.mail.grade, 'unknown', '객체가 아니면 unknown');
  assert.equal(r.items['datacenter-admin'], undefined, '수를 모르면 미설정이라 단정하지 않는다');
  assert.equal(r.items.alerts.grade, 'unset', '한 항목이 던져도 다른 항목은 판정한다');
  assert.equal(one('vcenter-admin', { count: 2, authStopped: null }), null, '정지 수를 모르면 주의로 만들지 않는다');
  assert.equal(one('diagnostics', { collectionErrors: undefined }), null);
});

test('③ 슈퍼 전용 항목은 슈퍼 관리자에게만', () => {
  const src = { 'isilon-dirusage': () => ({ loadError: false, targets: 0 }) };
  assert.equal(buildSettingsStatus(src, { superAdmin: false }).items['isilon-dirusage'], undefined);
  assert.equal(buildSettingsStatus(src, { superAdmin: true }).items['isilon-dirusage'].grade, 'off');
});

test('④ sources.js 는 파일 · 메모리 값만 — 외부 호출 · SQLite · 디렉터리 훑기 · 기록을 지우는 판정이 없다', () => {
  const body = stripComments(read('server/src/settingsStatus/sources.js'));
  const FORBIDDEN = /\b(hostAccessStatus|logStatus|perfDbStats|latestAll|targetRows|ensureIsiduDemo|buildUsageReport|listBackups|testConnection|testServer|relayTest|authStopFor|fetch|resilientFetch|sshExec|runSsh|getDb|openDb|readdirSync|readdir|execFile|spawn|ldapBind)\b/g;
  assert.deepEqual([...body.matchAll(FORBIDDEN)].map((m) => m[0]), []);
  assert.doesNotMatch(body, /\bawait\b|async /, '동기 함수만(라우트가 기다릴 외부 작업이 없다)');
  // 판정은 grade.js 하나 — sources.js 에 등급 문자열이 없다
  assert.doesNotMatch(body, /'(unset|warn|off|unknown)'/);
});

test('⑤ 규칙 키는 설정 화면의 키 · 슈퍼 전용 목록은 화면의 superOnly 와 같다', () => {
  const jsx = read('web/src/views/Settings.jsx');
  const keys = [...jsx.matchAll(/^ {2}\{ k: '([a-z0-9-]+)'/gm)].map((m) => m[1]);
  assert.ok(keys.length >= 51);
  assert.deepEqual(Object.keys(RULES).filter((k) => !keys.includes(k)), [], '화면에 없는 키의 규칙');
  const superKeys = [...jsx.matchAll(/^ {2}\{ k: '([a-z0-9-]+)'.*superOnly: true/gm)].map((m) => m[1]);
  assert.deepEqual([...SUPER_ONLY].sort(), superKeys.sort());
  const src = read('server/src/settingsStatus/sources.js');
  const srcKeys = [...stripComments(src).matchAll(/^ {4}'?([a-z0-9-]+)'?: \(\) =>/gm)].map((m) => m[1]);
  assert.deepEqual([...srcKeys].sort(), Object.keys(RULES).sort(), '규칙마다 사실 함수가 하나씩');
});

/* ── ⑥ 라우트 ─────────────────────────────────────────────────────────── */
const USERS = {
  view: { username: 'view1', role: 'viewer', scope: null },
  own: { username: 'own1', role: 'admin', scope: null },
  sup: { username: 'own3', role: 'admin', superAdmin: true, scope: null },
  adm: { username: 'adm2', role: 'admin', scope: null },
  scopedOwn: { username: 'own2', role: 'admin', scope: { vcenters: ['vc-x'], regions: [] } },
};
let srv; let base;
before(async () => {
  const express = (await import('express')).default;
  const { adminRouter } = await import('../src/routes/admin.js');
  const sec = await import('../src/security/securitySettings.js');
  sec.saveSessionSecurity({ settingsOwners: ['own1', 'own2', 'own3'] });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api/admin', adminRouter);
  app.use((err, _req, res, _next) => { res.status(500).json({ error: 'internal', msg: err.message }); }); // eslint-disable-line no-unused-vars
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${srv.address().port}/api`;
});
after(() => { try { srv?.close(); } catch { /* */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

async function get(u, p) {
  const r = await fetch(base + p, { headers: { 'x-u': u } });
  let j = null; try { j = await r.json(); } catch { /* */ }
  return { s: r.status, j };
}

test('⑥ 라우트 — 설정 소유자 ∧ 전체 범위만 · 항목 등급만 싣는다', async () => {
  assert.equal((await get('view', '/admin/settings/status')).s, 403);
  assert.equal((await get('adm', '/admin/settings/status')).s, 403, '소유자 아닌 admin');
  assert.equal((await get('scopedOwn', '/admin/settings/status')).s, 403, '범위가 지정된 소유자(SMTP 유무 · 비밀 정책도 정보)');
  const ok = await get('own', '/admin/settings/status');
  assert.equal(ok.s, 200);
  assert.equal(ok.j.ok, true);
  assert.equal(typeof ok.j.items, 'object');
  // 빈 설정 폴더: 법인 · SMTP · 알림 채널은 미설정, opt-in 은 꺼짐
  assert.equal(ok.j.items['datacenter-admin']?.grade, 'unset');
  assert.equal(ok.j.items.mail?.grade, 'unset');
  assert.equal(ok.j.items.alerts?.grade, 'unset');
  assert.equal(ok.j.items.vmseries?.grade, 'off');
  assert.equal(ok.j.items['isilon-dirusage'], undefined, '슈퍼 전용 항목은 슈퍼 관리자가 아니면 싣지 않는다');
  for (const [k, v] of Object.entries(ok.j.items)) {
    assert.deepEqual(Object.keys(v).filter((x) => !['grade', 'text', 'count'].includes(x)), [], `${k}: 아는 필드만`);
    assert.ok(['unset', 'off', 'warn', 'new', 'unknown'].includes(v.grade), `${k}: ${v.grade}`);
  }
  const sup = await get('sup', '/admin/settings/status');
  assert.equal(sup.s, 200);
  assert.equal(sup.j.items['isilon-dirusage']?.grade, 'off', '슈퍼 관리자에게는 아이실론 항목도');
  // 캐시가 슈퍼 · 일반 응답을 섞지 않는다(extraKey)
  assert.equal((await get('own', '/admin/settings/status')).j.items['isilon-dirusage'], undefined);
  const src = read('server/src/routes/admin/settingsStatus.js');
  assert.match(src, /adminRouter\.get\('\/settings\/status', adminOnly, requireSettingsOwner,/);
});

test('⑦ 반증 반영 — 저장 직후 반영 · 손상 보존본 · 중계 서버 · 인증 꺼짐 · GPU 게스트', async () => {
  // D1: 캐시 응답이 아니다(no-store · ETag 없음) — 저장 직후 '다시 읽기'(fresh=1) 는 바로 새 값
  const r1 = await fetch(`${base}/admin/settings/status`, { headers: { 'x-u': 'own' } });
  assert.equal(r1.headers.get('cache-control'), 'no-store');
  assert.equal((await r1.json()).items['datacenter-admin']?.grade, 'unset');
  // ETag 가 스냅샷 세대 키가 아니라 본문에서 나온다(express 기본) — 옛 ETag 를 보내도 새로 계산한 본문은 200
  const r1b = await fetch(`${base}/admin/settings/status?fresh=1`, { headers: { 'x-u': 'own', 'if-none-match': r1.headers.get('etag') || '' } });
  assert.equal(r1b.status, 200, '저장해도 304 로 옛 본문이 남던 결함(memoJson 의 세대 키 ETag)');
  const ds = await import('../src/datacenter/store.js');
  assert.equal(ds.addDatacenter({ id: 'kr', name: '한국' }).ok, true);
  assert.equal((await get('own', '/admin/settings/status?fresh=1')).j.items['datacenter-admin'], undefined, '법인을 등록하면 바로 미설정이 사라진다');
  // D3: 빈 설정의 중계 서버는 '꺼짐'(기본 프록시 한 줄을 등록으로 세지 않는다)
  assert.equal((await get('own', '/admin/settings/status?fresh=1')).j.items.proxy?.grade, 'off');
  // D2: 파일이 없고 손상 보존본만 있으면 '등록 없음(꺼짐)' 이 아니라 주의
  fs.writeFileSync(path.join(tmp, 'nsx.json.corrupt.1700000000000'), '{broken');
  const d2 = (await get('own', '/admin/settings/status?fresh=1')).j.items['nsx-admin'];
  assert.equal(d2?.grade, 'warn');
  // D4 · D6 · 손상 판정 대상 — 원문 대조
  const body = stripComments(read('server/src/settingsStatus/sources.js'));
  assert.match(body, /config\.auth\.enabled \? listUsers\(\) : null/, '인증이 꺼진 설치에서 listUsers 는 초기 관리자 비밀번호 파일을 만든다');
  assert.match(body, /gpuGuestEnabledLight\(\)/);
  assert.doesNotMatch(body, /loadGpuGuestSettings/, '게스트 비밀번호 전부를 복호하는 로더를 배지 계산에 쓰지 않는다');
  for (const f of ['datacenters.json', 'vcenters.json', 'nsx.json', 'horizon.json', 'backup.json', 'dirusage.json', 'guest-disk.json', 'gpu-guest.json', 'auth.json', 'alerts.json', 'mail.json', 'llm.json']) {
    assert.ok(body.includes(`damaged('${f}')`), `로드 오류 표지가 없는 로더(${f})는 손상 보존본을 따로 본다`);
  }
  const gpu = await import('../src/gpu/settings.js');
  assert.equal(gpu.gpuGuestEnabledLight(), false, '파일 없음 = 기본(꺼짐)');
  fs.writeFileSync(path.join(tmp, 'gpu-guest.json'), JSON.stringify({ enabled: true }));
  assert.equal(gpu.gpuGuestEnabledLight(), true);
  fs.writeFileSync(path.join(tmp, 'gpu-guest.json'), '{bad');
  assert.throws(() => gpu.gpuGuestEnabledLight(), '파싱 실패는 던진다(→ 배지 ?) — 0/꺼짐으로 바꾸지 않는다');
  fs.rmSync(path.join(tmp, 'gpu-guest.json'));
});

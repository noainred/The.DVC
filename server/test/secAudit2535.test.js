/**
 * secAudit2535.test.js — 자격증명·비밀 추적 감사(v2.535) 회귀 고정.
 *
 * 대상: v2.503 마지막 보안 감사 이후 신규/변경 구간의 **비밀 취급**.
 * 상세는 `docs/AUDIT-2026-09-16.md`.
 *
 * ⚠ 소스 문자열을 검사하는 테스트는 **주석을 먼저 걷어낸다** — v2.531.1 에서 결함을 설명하려고
 *   주석에 적어 둔 패턴을 '실제 사용' 으로 읽어 방금 고친 코드를 '아직 결함' 이라 보고한 적이 있다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { stripComments } from './_stripComments.js';

const SRC = new URL('../src/', import.meta.url).pathname;
const ROOT = new URL('../../', import.meta.url).pathname;

/** 주석(블록·행) 제거 — 문자열 검사 전 필수. */
const codeOf = stripComments;   // v2.613 TESTDOC2613-08

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}
const rel = (p) => p.slice(SRC.length);

/* ── ① 우연히 성립하는 소유자 게이트 금지 ──────────────────────────────────────
 *
 * v2.534 까지 `routes/api/pdu.js` 의 평문 비밀번호 CSV 내보내기는
 *   `if (withPw && !req.user?.isSettingsOwner) return requireSettingsOwner(...)`
 * 였다. 그런데 `req.user` 는 `isSettingsOwner` 를 **담지 않는다**(아래 ② 가 고정) —
 * `isSettingsOwner` 는 `routes/auth.js` 의 로그인·`/auth/me` **응답 필드**일 뿐이다.
 * 즉 조건이 언제나 참이라 결과적으로 닫혀 있었다 — **우연히** 안전했다. 누군가 그 필드를
 * 미들웨어로 올리면 그 순간 평문 자격증명 덤프가 소유자 검사 없이 나간다.
 * v2.500 C-1('경로 문자열 비교로 보안 게이트를 만들지 말 것')과 같은 유형이다.
 */
test('★ 라우트에서 `req.user.isSettingsOwner` 를 게이트 조건으로 쓰지 않는다', () => {
  const bad = [];
  for (const f of walk(path.join(SRC, 'routes'))) {
    const code = codeOf(fs.readFileSync(f, 'utf8'));
    if (/user\??\.isSettingsOwner/.test(code)) bad.push(rel(f));
  }
  assert.deepEqual(bad, [],
    `소유자 경계는 requireSettingsOwner 로만 강제한다 — req.user 는 그 필드를 담지 않으므로 우연히 닫히는 게이트가 된다: ${bad.join(', ')}`);
});

test('`resolveTokenUser` 는 isSettingsOwner 를 돌려주지 않는다(위 ① 이 성립하는 이유)', () => {
  const code = codeOf(fs.readFileSync(path.join(SRC, 'auth/auth.js'), 'utf8'));
  const fn = code.slice(code.indexOf('export function resolveTokenUser'));
  const body = fn.slice(0, fn.indexOf('\nexport '));
  assert.ok(!/isSettingsOwner/.test(body),
    'req.user 에 isSettingsOwner 를 넣으려면 소유자 게이트를 쓰는 모든 라우트를 먼저 확인할 것');
});

/* ── ② 평문 자격증명 덤프는 예외 없이 설정 소유자 전용 ───────────────────────── */

test('★ 비밀번호 포함 CSV 내보내기는 `requireSettingsOwner` 를 **무조건** 통과한다', () => {
  // 비밀을 함께 내보낼 수 있는 경로(스토리지·PDU). SAN 스위치는 아래 ③ 이 '옵션 자체가 없음' 을 고정한다.
  for (const f of ['routes/api/storageMon.js', 'routes/api/pdu.js']) {
    const code = codeOf(fs.readFileSync(path.join(SRC, f), 'utf8'));
    assert.ok(/if \(withPw\) return requireSettingsOwner\(/.test(code),
      `${f}: 'if (withPw) return requireSettingsOwner(' 형태여야 한다(조건을 더 붙이면 우연히 열릴 수 있다)`);
  }
});

test('SAN 스위치 CSV 내보내기에는 비밀번호 옵션이 아예 없다', () => {
  const code = codeOf(fs.readFileSync(path.join(SRC, 'routes/api/sanSwitch.js'), 'utf8'));
  const seg = code.slice(code.indexOf("'/tools/sanswitch/devices/export.csv'"));
  const route = seg.slice(0, seg.indexOf('});') + 3);
  assert.ok(/listDevices\(\)/.test(route), '비밀번호가 제거된 listDevices() 를 써야 한다');
  assert.ok(!/includePasswords|WithSecrets|passwords/.test(route),
    'SAN 스위치는 비밀번호 내보내기를 지원하지 않는다 — 추가하려면 requireSettingsOwner 게이트를 함께 넣을 것');
});

/* ── ③ 비밀 파일 위생 ──────────────────────────────────────────────────────── */

test('SECRET_FILES ⊆ .gitignore (등록만 하고 차단을 잊는 사고 방지 — v2.500 C/M4)', async () => {
  const { SECRET_FILES } = await import('../src/security/secretVault.js');
  const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  const missing = SECRET_FILES.filter((f) => !gi.includes(f));
  assert.deepEqual(missing, [], `.gitignore 에 없는 비밀 파일: ${missing.join(', ')}`);
});

test('★ 모든 SQLite 모듈은 파일 권한 0600 을 건다(v2.503 S-5 규칙)', () => {
  const bad = [];
  for (const f of walk(SRC)) {
    const code = fs.readFileSync(f, 'utf8');
    // node:sqlite 로 DB 파일을 직접 여는 모듈만 대상.
    if (!/new DatabaseSync\(/.test(codeOf(code))) continue;
    // ⚠ 제외: `upgrade/dbCheckpoint.js` 는 **이미 존재하는** .db 만 연다
    //   (`readdirSync(...).filter(f => f.endsWith('.db'))` + `existsSync(`${p}-wal`)` 가드) —
    //   파일을 만들지 않으므로 권한을 정하지 않는다. 감사에서 확인한 사실이다.
    if (rel(f) === 'upgrade/dbCheckpoint.js') continue;
    // ⚠ 정규식에 `[^)]*` 를 쓰지 말 것 — `chmodSync(FILE(), 0o600)` 처럼 인자에 괄호가 있으면
    //   첫 `)` 에서 멈춰 **멀쩡한 4개 모듈을 누락으로 오판**한다(v2.535 에 실제로 그랬다).
    if (!/chmodSync\([\s\S]{0,80}?0o600/.test(code)) bad.push(rel(f));
  }
  assert.deepEqual(bad, [], `DB 파일 권한 0600 누락: ${bad.join(', ')}`);
});

/* ── ④ 접속처가 바뀌면 저장 비밀을 승계하지 않는다 ─────────────────────────────
 *
 * SSH 장비 등록부 3종(스토리지·SAN 스위치·PDU)은 **host 변경 시** 비번을 버린다.
 * ⚠ 정직 기록: 이 셋은 `sshPort`·`username` 변경은 보지 않는다(v2.503 S-1 은 idKeys 를
 *   '최종 요청 대상을 만드는 모든 필드' 로 규정한다). 감사 판정은 **low** 였다 —
 *   포트만 바꿔 빼내려면 그 장비 IP 에서 포트를 장악해야 하고, username 변경은 같은
 *   호스트로만 간다. 그래도 규칙과 어긋나므로 `docs/AUDIT-2026-09-16.md` 에 남겼다.
 *   여기서는 **이미 있는 방어가 사라지지 않는 것**을 고정한다.
 */
test('★ SSH 장비 등록부 3종은 host 변경 시 저장 비밀번호를 버린다', () => {
  const cases = [
    // v2.607(SEC2607-07): 판정이 공용 accessMoved(host·username·port) + dropCarriedSecrets 로 넓어졌다 — host 가 키 목록에 있어야 한다.
    ['storage/registry.js', /accessMoved\([\s\S]{0,400}\['host',[\s\S]{0,200}dropCarriedSecrets\(dev,/],
    ['sanswitch/registry.js', /accessMoved\([\s\S]{0,600}\['host',[\s\S]{0,200}dropCarriedSecrets\(dev,/],
    // PDU 는 normalize() 안에서 처리한다 — host 가 바뀌면 '' 로 만든다.
    ['pdu/registry.js', /input\.host[\s\S]{0,160}e\.host[\s\S]{0,40}\?\s*''/],
  ];
  for (const [f, re] of cases) {
    const code = codeOf(fs.readFileSync(path.join(SRC, f), 'utf8'));
    assert.ok(re.test(code), `${f}: host 변경 시 비밀 이월 금지 코드가 없다(uagmon M3 · v2.503 S-2)`);
  }
});

test('자격증명 스토어는 secretCarry 판정을 공유한다(v2.503 S-2 — 6개 파일 고정)', () => {
  for (const f of ['vcenter/registry.js', 'nsx/registry.js', 'idrac/registry.js',
    'horizon/horizon.js', 'collector/registry.js', 'gpu/physicalRegistry.js']) {
    const code = codeOf(fs.readFileSync(path.join(SRC, f), 'utf8'));
    assert.ok(/secretCarry/.test(code), `${f}: util/secretCarry.js 를 쓰지 않는다`);
  }
});

/* ── ⑤ 로그·오류에 비밀이 새지 않는다 ───────────────────────────────────────── */

test('감사로그에 요청 본문을 통째로 싣지 않는다(비밀 필드 동반 위험)', () => {
  const bad = [];
  for (const f of walk(path.join(SRC, 'routes'))) {
    const code = codeOf(fs.readFileSync(f, 'utf8'));
    for (const m of code.matchAll(/logAudit\(\{[^}]*\}/g)) {
      if (/JSON\.stringify\(\s*(req\.body|body|input)\b/.test(m[0])) bad.push(`${rel(f)}: ${m[0].slice(0, 90)}`);
    }
  }
  assert.deepEqual(bad, [], `감사로그가 요청 본문을 그대로 직렬화한다: ${bad.join(' | ')}`);
});

test('오류 메시지·응답 사유에 비밀번호 변수를 끼워 넣지 않는다', () => {
  const bad = [];
  for (const f of walk(SRC)) {
    const code = codeOf(fs.readFileSync(f, 'utf8'));
    // `${...password...}` 형태가 오류/사유 문자열에 들어가는 경우만 본다.
    for (const m of code.matchAll(/(?:new Error\(|reason: *)`[^`]*\$\{[^}]*\b(?:password|passwd|privateKey|passphrase)\b[^}]*\}[^`]*`/g)) {
      bad.push(`${rel(f)}: ${m[0].slice(0, 100)}`);
    }
  }
  assert.deepEqual(bad, [], `오류 문구가 비밀 값을 되울린다: ${bad.join(' | ')}`);
});

/* ── ⑥ 인증 실패 정지는 도구마다 있어야 한다(v2.535 감사 medium) ─────────────────
 *
 * `horizon/sessionCollect.js:82` 는 401/403 을 `kind:'auth'` 로 정확히 분류하는데 v2.534 까지
 * **아무도 소비하지 않았다** — 폴러는 화면 표시용 errors 에 담기만 하고 다음 주기에 같은 AD
 * 계정으로 다시 로그인했다(주기 기본 5분·하한 60초 → 서버 1대당 하루 288~1,440회 실패 로그인).
 * 그것이 **AD 서비스 계정을 스스로 잠그는 경로**다. 스토리지에는 v2.528 부터 방어가 있었다.
 */
test('★ 공용 authGuard 코어가 있고 스토리지·Horizon 이 **같은 것**을 쓴다', () => {
  const st = codeOf(fs.readFileSync(path.join(SRC, 'storage/authGuard.js'), 'utf8'));
  const hz = codeOf(fs.readFileSync(path.join(SRC, 'horizon/sessionPoller.js'), 'utf8'));
  assert.ok(/from '\.\.\/util\/authGuard\.js'/.test(st), '스토리지가 공용 코어를 쓰지 않는다');
  assert.ok(/from '\.\.\/util\/authGuard\.js'/.test(hz), 'Horizon 이 공용 코어를 쓰지 않는다');
  // ⚠ 파일은 도구마다 달라야 한다 — 한 파일에 섞으면 두 도구의 id 가 충돌해 엉뚱한 대상이 멈춘다.
  assert.ok(/'storage-auth-stops\.json'/.test(st));
  assert.ok(/'horizon-auth-stops\.json'/.test(hz));
  assert.ok(!/'storage-auth-stops\.json'/.test(hz), '두 도구가 같은 정지 파일을 쓰면 안 된다');
});

test('★ Horizon 은 401/403 에서 **주기** 수집만 멈춘다(수동 실행은 막지 않는다)', () => {
  const hz = codeOf(fs.readFileSync(path.join(SRC, 'horizon/sessionPoller.js'), 'utf8'));
  assert.ok(/const periodic = trigger !== 'manual'/.test(hz),
    "수동 실행을 막으면 비밀번호를 고쳤는지 확인할 길이 없어진다(authGuard 규칙 3)");
  assert.ok(/periodic[\s\S]{0,60}authStopFor\(srv\)/.test(hz), '주기 실행에서만 건너뛰어야 한다');
  assert.ok(/kind === 'auth'[\s\S]{0,80}markAuthStopped/.test(hz), '401/403 이면 정지 기록을 남겨야 한다');
  assert.ok(/r\?\.ok[\s\S]{0,60}clearAuthStop/.test(hz), '성공하면 정지를 해제해야 한다');
});

test('★ 조용히 멈추지 않는다 — 정지 사실이 레코드로 나간다', () => {
  const hz = codeOf(fs.readFileSync(path.join(SRC, 'horizon/sessionPoller.js'), 'utf8'));
  assert.ok(/kind: 'auth-stopped'/.test(hz) && /authStopped: stop/.test(hz),
    "말없이 건너뛰면 사용자는 '수집이 되는 줄' 안다(authGuard 규칙 1)");
  // 화면이 그 kind 를 해석할 수 있어야 한다 — 서버 라벨과 웹 조치 문구 양쪽.
  const label = codeOf(fs.readFileSync(path.join(SRC, 'horizon/sessionCollect.js'), 'utf8'));
  assert.ok(/'auth-stopped':/.test(label), '서버 KIND_LABEL 에 없으면 화면이 원시 키를 보여준다');
  const web = codeOf(fs.readFileSync(new URL('../../web/src/views/tools/horizonSessionText.js', import.meta.url).pathname, 'utf8'));
  assert.ok(/'auth-stopped': 'red'/.test(web), '웹 KIND_TONE 누락 — 배지가 회색(정보)으로 보인다');
  assert.ok(/'auth-stopped': '[^']*자동으로 재개/.test(web), '재개 방법을 말하지 않으면 사용자가 복구하지 못한다');
});

test('실패 주기의 수치는 null 이다(0 은 "사용자 0명" 이라는 거짓)', () => {
  const hz = codeOf(fs.readFileSync(path.join(SRC, 'horizon/sessionPoller.js'), 'utf8'));
  const seg = hz.slice(hz.indexOf("kind: 'auth-stopped'"));
  const block = seg.slice(0, seg.indexOf('};') + 2);
  for (const k of ['sessions', 'connected', 'users']) {
    assert.ok(new RegExp(`${k}: null`).test(block), `auth-stopped 레코드의 ${k} 는 null 이어야 한다`);
  }
});

/* ── ⑦ 런타임 상태 파일도 .gitignore 대상 ─────────────────────────────────────
 * 평문 비밀은 없지만 내부 host·자격증명 **지문**(계정명 + 비번 길이 + 16비트 해시)이 들어간다.
 * 기본 CONFIG_DIR 이 server/config 라 개발 호스트에서 `git add -A` 하면 그대로 올라간다.
 */
test('★ 신규 런타임 상태 파일이 .gitignore 에 있다', () => {
  const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  const need = [
    'server/config/horizon-sessions.json', 'server/config/horizon-session-activity.json',
    'server/config/horizon-auth-stops.json', 'server/config/storage-auth-stops.json',
    'server/config/storage-growth-settings.json', 'server/config/vmseries.json',
    'server/config/vmseries/',
  ];
  const missing = need.filter((f) => !gi.includes(f));
  assert.deepEqual(missing, [], `.gitignore 누락: ${missing.join(', ')}`);
});

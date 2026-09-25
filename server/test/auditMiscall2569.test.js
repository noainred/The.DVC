/**
 * 감사 로그가 `logAudit(req, …)` 오용으로 오염돼 화면이 죽던 결함(v2.569).
 *
 * 사용자 신고(v2.568 실화면): 설정 › 감사 로그가
 *   `Minified React error #31 … object with keys {username, role, name, scope, mustEnrollOtp}`
 * 로 탭 전체가 죽었다. 그 키 집합은 `auth/auth.js resolveTokenUser` 의 반환 = `req.user` 다.
 *
 * 원인: 라우트 11곳이 `logAudit(req, '액션', {…})` 로 불러 **express req 를 옵션 객체 자리에**
 * 넘겼다. `logAudit` 은 첫 인자를 구조분해하므로 `user = req.user`(객체)가 파일에 저장됐고,
 * `action` 은 `req.action`(undefined)이라 **누가·무엇을 했는지 둘 다 잃었다**.
 *
 * 세 축을 각각 고정한다 — 하나라도 빠지면 재발한다:
 *  ① 쓰기: 객체가 와도 문자열로 저장(오용은 console.warn 으로 드러낸다 — 조용한 통과 금지)
 *  ② 읽기: **이미 저장된** 오염 줄도 소독(운영 파일은 고칠 수 없다)
 *  ③ 소스: `logAudit(req` 호출이 0건
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { stripComments } from './_stripComments.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2569-'));
process.env.CONFIG_DIR = dir;
const { logAudit, listAudit } = await import('../src/audit.js');

const REQ_USER = { username: 'JunHo', role: 'admin', name: '준호', scope: {}, mustEnrollOtp: false };

test('① 오용 호출 — req 를 넘겨도 user 는 문자열이고 action 이 보존된다', () => {
  const warns = [];
  const orig = console.warn; console.warn = (m) => warns.push(String(m));
  try {
    logAudit({ user: REQ_USER, headers: {}, method: 'POST', ip: '10.0.0.1' }, 'bm-usage.collect', { ok: true });
  } finally { console.warn = orig; }
  const e = listAudit({}).items[0];
  assert.equal(typeof e.user, 'string', 'user 가 객체로 저장되면 화면이 React #31 로 죽는다');
  assert.equal(e.user, 'JunHo', '아는 이름은 되살린다(지어내지 않는다)');
  assert.equal(e.action, 'bm-usage.collect', 'action 을 잃으면 감사 기록이 무의미하다');
  assert.ok(warns.some((w) => /logAudit\(req/.test(w)), '오용을 조용히 넘기면 안 된다');
});

test('② 읽기 소독 — 이미 저장된 오염 줄도 문자열로 되돌린다', () => {
  // 운영 파일에 남아 있는 과거 줄을 그대로 재현(이 줄은 고칠 수 없다)
  fs.appendFileSync(path.join(dir, 'audit.ndjson'),
    JSON.stringify({ at: new Date().toISOString(), user: REQ_USER, target: '', detail: '', ip: '' }) + '\n');
  const r = listAudit({});
  for (const e of r.items) {
    for (const k of ['user', 'action', 'target', 'detail', 'ip']) {
      assert.equal(typeof e[k], 'string', `${k} 가 문자열이 아니면 화면이 죽는다`);
    }
  }
  // users 목록도 <option>{u}</option> 로 렌더되므로 같은 조건
  for (const u of r.users) assert.equal(typeof u, 'string', 'users 에 객체가 섞이면 필터 드롭다운이 죽는다');
});

test('③ 소스 — logAudit(req, …) 오용이 한 건도 없다', () => {
  const hits = [];
  (function walk(d) {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) { if (!/node_modules/.test(p)) walk(p); continue; }
      if (!f.name.endsWith('.js')) continue;
      // logAudit 을 정의하는 모듈 자신은 제외 — 오용 감지 경고 **문구**에 그 형태가 들어 있다.
      if (p.endsWith(`${path.sep}audit.js`)) continue;
      // 주석을 먼저 제거한다 — 규칙을 설명하는 주석이 통과/실패 근거가 되면 안 된다(v2.535 규약).
      // ⚠ 개행은 **보존**한다 — 지우면 줄 번호가 밀려 엉뚱한 줄을 지목한다(이 테스트 초판의 실제 오탐).
      const src = stripComments(fs.readFileSync(p, 'utf8'));   // v2.613 TESTDOC2613-08: 코어(개행 보존)
      src.split('\n').forEach((ln, i) => { if (/logAudit\(\s*req\b/.test(ln)) hits.push(`${p}:${i + 1}`); });
    }
  })(new URL('../src', import.meta.url).pathname);
  assert.deepEqual(hits, [], 'logAudit 은 옵션 객체 하나로 부른다');
});

test('④ 정상 호출은 그대로 — 회귀 없음', () => {
  logAudit({ user: 'admin', action: '정상 기록', target: 'x', detail: 'd', ip: '1.2.3.4' });
  const e = listAudit({}).items[0];
  assert.deepEqual(
    { user: e.user, action: e.action, target: e.target, detail: e.detail, ip: e.ip },
    { user: 'admin', action: '정상 기록', target: 'x', detail: 'd', ip: '1.2.3.4' },
  );
});

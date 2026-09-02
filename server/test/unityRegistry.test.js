import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unity-reg-'));
process.env.CONFIG_DIR = tmp;

let reg;
before(async () => { reg = await import('../src/unity/registry.js'); });
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

test('addUnity: 등록 + 비밀번호 마스킹(hasPassword 만 노출)', () => {
  const r = reg.addUnity({ id: 'u1', name: 'Seoul Unity', host: 'https://10.0.0.10', username: 'admin', password: 'secret' });
  assert.equal(r.ok, true);
  assert.equal(r.unity.id, 'u1');
  assert.equal(r.unity.password, undefined, '응답에 비밀번호가 있으면 안 된다');
  assert.equal(r.unity.hasPassword, true);
  // 목록도 동일하게 마스킹
  const list = reg.listRegistry();
  assert.equal(list.length, 1);
  assert.equal(list[0].password, undefined);
});

test('addUnity: 필수값/형식 검증', () => {
  assert.equal(reg.addUnity({}).ok, false);
  assert.match(reg.addUnity({ id: '', name: 'x', host: 'https://a', username: 'u' }).reason, /id/);
  // host 는 http(s) 스킴 필수
  assert.match(reg.addUnity({ id: 'z', name: 'x', host: '10.0.0.9', username: 'u' }).reason, /host/);
  // 중복 id 거부
  assert.match(reg.addUnity({ id: 'u1', name: 'dup', host: 'https://10.0.0.11', username: 'admin' }).reason, /이미 존재/);
});

test('addUnity: SSRF 가드 — 루프백/링크로컬 거부', () => {
  const loop = reg.addUnity({ id: 'bad1', name: 'loop', host: 'https://127.0.0.1', username: 'admin', password: 'p' });
  assert.equal(loop.ok, false, '루프백은 거부되어야 한다');
  assert.match(loop.reason, /host 거부/);
  const link = reg.addUnity({ id: 'bad2', name: 'link', host: 'https://169.254.169.254', username: 'admin', password: 'p' });
  assert.equal(link.ok, false, '링크로컬(메타데이터 주소)은 거부되어야 한다');
});

test('updateUnity: 빈 비밀번호는 기존 값 유지', () => {
  const r = reg.updateUnity('u1', { name: 'Seoul Unity 480F', host: 'https://10.0.0.10', username: 'admin', password: '' });
  assert.equal(r.ok, true);
  assert.equal(r.unity.name, 'Seoul Unity 480F');
  assert.equal(r.unity.hasPassword, true, '빈 비번을 보내면 기존 비번이 유지돼야 한다');
});

test('저장 파일은 0600 권한', () => {
  const st = fs.statSync(path.join(tmp, 'unity.json'));
  assert.equal(st.mode & 0o777, 0o600);
});

test('testConnection: 자격증명 누락 시 validate 단계에서 즉시 실패(네트워크 접근 없음)', async () => {
  const r = await reg.testConnection({ host: 'https://10.0.0.10', username: 'admin' }); // password 없음
  assert.equal(r.ok, false);
  assert.equal(r.step, 'validate');
  assert.equal(r.stepLabel, '입력값');
});

test('testConnection: SSRF 차단 대상은 validate 에서 거부', async () => {
  const r = await reg.testConnection({ host: 'https://127.0.0.1', username: 'admin', password: 'p' });
  assert.equal(r.ok, false);
  assert.equal(r.step, 'validate');
  assert.match(r.reason, /host 거부/);
});

test('hintFor: 302(SSO 리다이렉트)는 "Unity 가 아님" 안내로 이어진다', () => {
  const h = reg.hintFor('reach', Object.assign(new Error('SSO 로그인 페이지로 리다이렉트됨'), { code: 'REDIRECT' }));
  assert.match(h, /Unity Unisphere REST 가 아닙니다/);
  // 실측 사례: 대상이 Unity 가 아니면 /cas/login 으로 302 된다. 이 안내가 없으면 원인 파악 불가.
  const notJson = reg.hintFor('reach', Object.assign(new Error('JSON 이 아닌 응답'), { code: 'NOT_JSON' }));
  assert.match(notJson, /Unity Unisphere REST 가 아닙니다/);
});

test('hintFor: 401/403/타임아웃은 각각 다른 조치 안내', () => {
  assert.match(reg.hintFor('auth', Object.assign(new Error('인증 실패'), { code: '401' })), /계정\/비밀번호/);
  assert.match(reg.hintFor('auth', Object.assign(new Error('권한 부족'), { code: '403' })), /권한/);
  assert.match(reg.hintFor('reach', new Error('The operation was aborted due to timeout')), /방화벽/);
});

test('removeUnity: 삭제 + 없는 id 는 실패', () => {
  assert.equal(reg.removeUnity('u1').ok, true);
  assert.equal(reg.removeUnity('u1').ok, false);
  assert.equal(reg.listRegistry().length, 0);
});

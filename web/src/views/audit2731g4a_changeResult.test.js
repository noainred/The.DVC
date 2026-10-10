/**
 * v2.731 점검 1회차 G4a · A5-01 — 변경 요청(putJson·patchJson·delJson)의 400·409 본문을 성공으로 처리하지 않는다.
 *
 * 결함: api.js 의 sendJson 은 400·409 를 **던지지 않고 본문을 돌려준다**(IPMS 등이 400 본문의 invalid[]·field 를 읽는다 —
 * 그 규약은 바꾸지 않는다). 그런데 svcmon 대상·점검 수정·이름 바꾸기·로그 설정, RMA 접속 IP·원격·분배·비밀번호·스케줄,
 * 자격증명 볼트 수정, vCenter 로그 설정이 그 반환값을 성공으로 처리했다 — 서버가 거부해도 창이 닫히고 '저장됨'·
 * '비밀번호를 해제했습니다(무서명)' 이 떴다(반대 방향의 거짓).
 *
 * 여기서 고정하는 것:
 *  ① 판정 헬퍼(changeResult.js)가 서버가 실제로 쓰는 실패 본문 모양({ok:false,reason} · {error})을 실패로, 성공 본문
 *     ({ok:true,…} · 객체 · 설정 객체)을 성공으로 읽는다.
 *  ② 실제 api.js putJson 이 400 본문을 돌려줄 때 requireChanged 가 서버 사유로 던진다(화면의 catch 가 그 문구를 보인다).
 *  ③ 배정 화면 5개의 putJson·patchJson·delJson 호출이 **전부** requireChanged 를 거친다(소스 스윕 — 주석 제거 후).
 *     컴포넌트 안 핸들러는 DOM 없이 부를 수 없어 배선은 소스로 본다(웹 테스트 환경이 node 다).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { changeFailText, requireChanged } from './changeResult.js';
import { stripComments } from '../test/_stripComments.js';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('① 변경 응답 판정 — 서버 실패 본문 모양', () => {
  it('{ok:false, reason} 은 사유로, {error} 만 오는 라우트(svcmon)는 error 로 실패다', () => {
    expect(changeFailText({ ok: false, reason: '비밀번호가 너무 깁니다(최대 256자).' })).toBe('비밀번호가 너무 깁니다(최대 256자).');
    expect(changeFailText({ error: '이름을 입력하세요.' })).toBe('이름을 입력하세요.');
    expect(changeFailText({ ok: false, error: 'forbidden', reason: '전체 범위 계정만 바꿀 수 있습니다.' })).toBe('전체 범위 계정만 바꿀 수 있습니다.');
    expect(changeFailText({ error: 'conflict', reason: '다른 관리자가 먼저 바꿨습니다.' })).toBe('다른 관리자가 먼저 바꿨습니다.');
  });
  it('사유가 없는 ok:false 는 호출부 문구(없으면 일반 문구)로 실패다 — 성공으로 떨어지지 않는다', () => {
    expect(changeFailText({ ok: false })).toMatch(/받아들이지 않았습니다/);
    expect(changeFailText({ ok: false }, '삭제할 점검을 찾지 못했습니다.')).toBe('삭제할 점검을 찾지 못했습니다.');
    expect(changeFailText({ ok: false, reason: '   ' }, 'X')).toBe('X');
  });
  it('성공 본문은 실패가 아니다(ok:true · 대상 객체 · 설정 객체 · 배열 · 빈 본문)', () => {
    expect(changeFailText({ ok: true, hasPassword: false })).toBeNull();
    expect(changeFailText({ ok: true, error: 'ignored-when-ok' })).toBeNull();
    expect(changeFailText({ target: { id: 't1', name: 'a' } })).toBeNull();
    expect(changeFailText({ enabled: true, pollIntervalMin: 5, retentionDays: 30 })).toBeNull();
    expect(changeFailText({ error: null, files: [] })).toBeNull();
    expect(changeFailText([])).toBeNull();
    expect(changeFailText({})).toBeNull();
    expect(changeFailText(null)).toBeNull();
    expect(changeFailText(undefined)).toBeNull();
  });
  it('requireChanged 는 성공이면 본문을 그대로 돌려주고, 실패면 사유를 메시지로 던진다(본문을 함께 싣는다)', () => {
    const ok = { ok: true, mode: 'active-standby' };
    expect(requireChanged(ok)).toBe(ok);
    let e = null;
    try { requireChanged({ ok: false, reason: '롱폴 범위 밖' }); } catch (x) { e = x; }
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe('롱폴 범위 밖');
    expect(e.changeRejected).toBe(true);
    expect(e.body).toEqual({ ok: false, reason: '롱폴 범위 밖' });
  });
});

describe('② 실제 api.js putJson — 400 본문을 돌려받아도 화면은 실패로 처리한다', () => {
  const store = () => { const mem = new Map(); return { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) }; };
  let saved;
  beforeEach(() => {
    saved = { fetch: globalThis.fetch, ls: globalThis.localStorage, ss: globalThis.sessionStorage };
    globalThis.localStorage = store(); globalThis.sessionStorage = store();
  });
  afterEach(() => { globalThis.fetch = saved.fetch; globalThis.localStorage = saved.ls; globalThis.sessionStorage = saved.ss; vi.restoreAllMocks(); });
  it('putJson 은 400 을 던지지 않는다(규약) · requireChanged 가 서버 사유로 던진다', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: false, reason: '비밀번호가 너무 깁니다(최대 256자).' }), { status: 400, headers: { 'Content-Type': 'application/json' } }));
    const { putJson } = await import('../api.js');
    const r = await putJson('/tools/rma/agents/x/password', { password: 'a'.repeat(300) });
    expect(r.ok).toBe(false); // api.js 규약 — 바꾸지 않았다
    await expect(Promise.resolve().then(() => requireChanged(r))).rejects.toThrow('비밀번호가 너무 깁니다(최대 256자).');
  });
  it('svcmon 모양({error}, 400)도 같다', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: '같은 이름의 폴더가 이미 있습니다.' }), { status: 400, headers: { 'Content-Type': 'application/json' } }));
    const { putJson } = await import('../api.js');
    const r = await putJson('/svcmon/folders/rename', { kind: 'infra', path: 'a', newName: 'b' });
    expect(() => requireChanged(r)).toThrow('같은 이름의 폴더가 이미 있습니다.');
  });
});

describe('③ 배정 화면의 변경 호출은 전부 requireChanged 를 거친다(주석 제거 후 소스)', () => {
  const FILES = [
    'SvcMonitor.jsx',
    'svcmon/TestWizard.jsx',
    'tools/RemoteCommand.jsx',
    'tools/CredentialManager.jsx',
    'VcenterLogs.jsx',
  ];
  for (const f of FILES) {
    it(f, () => {
      const src = stripComments(fs.readFileSync(path.join(here, f), 'utf8'));
      const calls = [...src.matchAll(/\b(putJson|patchJson|delJson)\(/g)].length;
      const wrapped = [...src.matchAll(/requireChanged\(\s*await\s+(putJson|patchJson|delJson)\(/g)].length;
      expect(calls, `${f}: 변경 호출이 있어야 한다`).toBeGreaterThan(0);
      expect(wrapped, `${f}: putJson·patchJson·delJson ${calls}곳 중 ${wrapped}곳만 requireChanged 를 거친다`).toBe(calls);
      expect(src).toMatch(/import \{[^}]*requireChanged[^}]*\} from '[./]*changeResult\.js'/);
    });
  }
  it('RMA 비밀번호 저장은 실패 본문(hasPassword 없음)을 \'해제했습니다\' 로 말하지 않는다 — 판정 뒤에만 문구를 고른다', () => {
    const src = stripComments(fs.readFileSync(path.join(here, 'tools/RemoteCommand.jsx'), 'utf8'));
    expect(src).toMatch(/const r = requireChanged\(await putJson\(`\/tools\/rma\/agents\/\$\{encodeURIComponent\(group\.agent\)\}\/password`/);
  });
  it('vCenter 로그 설정은 실패 본문으로 폼(setS)을 덮지 않는다', () => {
    const src = stripComments(fs.readFileSync(path.join(here, 'VcenterLogs.jsx'), 'utf8'));
    expect(src).toMatch(/const r = requireChanged\(await putJson\('\/admin\/vclogs\/settings', s\)\); setS\(r\)/);
  });
});

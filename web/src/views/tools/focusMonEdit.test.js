/**
 * focusMonEdit.test.js — v2.980 서버 집중 모니터링 '등록된 서버 수정'(사용자 요청 2026-11-12 "등록된 서버 수정하는 기능 추가").
 *  · editFormOf: 등록 값 그대로(포트는 글자 · 없으면 22)
 *  · editChanges: 바뀐 칸만 · 담당 노드 대소문자 무시 · 포트 '022' = 22 · 빈 포트 = 22(서버와 같은 규칙) · 접속처 판정
 *  · editNotes: 이름만이면 없음 · 접속처면 시험 결과 지움 · 수집 중이면 다시 연결 · 노드면 공개키 · IP 면 기록이 이어짐
 *  · editResultText: 바뀐 칸 · 지운 시험 결과를 말한다 · 바뀐 것 없음 · 실패 사유
 *  · 화면: 저장은 r.ok === false 를 본다 · 포트를 22 로 조용히 바꾸지 않는다 · 수정 칸은 줄 아래 한 줄(정렬해도 함께)
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { editFormOf, editChanges, editNotes, editResultText, EDIT_FIELDS } from './focusMonText.js';

const T = { id: 'fm-1', name: 'web-01', host: '10.2.0.1', port: 22, username: 'dvcmon', agent: 'Edge-PL' };

describe('editFormOf · editChanges', () => {
  it('등록 값 그대로 · 포트는 글자', () => {
    expect(editFormOf(T)).toEqual({ name: 'web-01', host: '10.2.0.1', port: '22', username: 'dvcmon', agent: 'Edge-PL', group: '' }); // v2.982 그룹 칸
    expect(editFormOf({ name: 'x', host: '10.0.0.1' }).port).toBe('22');
    expect(EDIT_FIELDS).toEqual(['name', 'host', 'port', 'username', 'agent', 'group']);
  });
  it('그대로면 바뀐 칸 없음 — 노드 대소문자 · 포트 022 · 앞뒤 공백은 같다', () => {
    expect(editChanges(T, editFormOf(T))).toEqual({ changes: [], endpoint: false });
    expect(editChanges(T, { ...editFormOf(T), agent: 'edge-pl', port: '022', name: ' web-01 ' }).changes).toEqual([]);
    expect(editChanges({ ...T, port: 22 }, { ...editFormOf(T), port: '' }).changes, '빈 포트 = 22(서버 규칙)').toEqual([]);
  });
  it('이름만 = 접속처 아님 · IP · 노드 = 접속처 · 바뀐 값을 글로', () => {
    const a = editChanges(T, { ...editFormOf(T), name: 'web-01a' });
    expect(a.endpoint).toBe(false);
    expect(a.changes).toEqual([{ k: 'name', label: '이름', from: 'web-01', to: 'web-01a' }]);
    const b = editChanges(T, { ...editFormOf(T), host: '10.2.0.77', agent: '' });
    expect(b.endpoint).toBe(true);
    expect(b.changes.map((c) => `${c.label} ${c.from} → ${c.to}`)).toEqual(['IP 10.2.0.1 → 10.2.0.77', '담당 노드 엣지 Edge-PL → 중앙']);
    const c = editChanges(T, { ...editFormOf(T), port: 'abc' });
    expect(c.changes[0]).toMatchObject({ k: 'port', from: '22', to: 'abc' });
    expect(c.endpoint).toBe(true);
  });
});

describe('editNotes', () => {
  it('이름만이면 안내 없음', () => {
    expect(editNotes(T, { ...editFormOf(T), name: 'zz' }, { inSession: true })).toEqual([]);
  });
  it('접속처가 바뀌면 시험 결과를 지운다 · 수집 중이면 다시 연결 · 노드면 그 노드의 공개키 · IP 면 기록이 이어진다', () => {
    const n = editNotes(T, { ...editFormOf(T), host: '10.2.0.9', agent: '' }, { inSession: true });
    expect(n[0]).toMatch(/수집 중인 서버입니다 — 저장하면 새 접속처로 다시 연결/);
    expect(n.join('\n')).toMatch(/예전 접속처의 연결 시험 결과 · 상태를 지웁니다/);
    expect(n.join('\n')).toMatch(/그 서버 계정의 authorized_keys 에 중앙의 공개키가 있어야/);
    expect(n.join('\n')).toMatch(/기록은 이 서버 줄로 이어집니다/);
    const only = editNotes(T, { ...editFormOf(T), username: 'root' });
    expect(only).toHaveLength(1);
    expect(only[0]).toMatch(/시험 결과/);
  });
  it('화면 글에 백틱 · 영문 대문자 변환이 없다', () => {
    const all = editNotes(T, { ...editFormOf(T), host: '10.2.0.9', agent: '' }, { inSession: true }).join('');
    expect(all).not.toMatch(/`/);
  });
});

describe('editResultText', () => {
  it('바뀐 칸 · 지운 시험 결과를 말한다', () => {
    expect(editResultText({ ok: true, target: { name: 'web-01a' }, changes: [{ k: 'name' }], cleared: false })).toBe('web-01a 을(를) 고쳤습니다(이름).');
    expect(editResultText({ ok: true, target: { name: 'w' }, changes: [{ k: 'host' }, { k: 'agent' }], cleared: true }))
      .toBe('w 을(를) 고쳤습니다(IP · 담당 노드) — 접속처가 바뀌어 예전 연결 시험 결과를 지웠습니다. ‘시험’ 으로 확인하세요.');
    expect(editResultText({ ok: true, changes: [] })).toMatch(/바뀐 값이 없습니다/);
    expect(editResultText({ ok: false, reason: '같은 노드 · 주소 · 포트 · 계정의 대상이 이미 있습니다.' })).toMatch(/이미 있습니다/);
  });
});

describe('화면 소스 — 수정 줄', () => {
  const src = fs.readFileSync(new URL('./FocusMonTool.jsx', import.meta.url), 'utf8');
  const save = src.slice(src.indexOf('const saveEdit = '), src.indexOf('const saveEdit = ') + 900);
  it('저장은 r.ok === false 를 보고 · 포트를 글자 그대로 보낸다(조용히 22 로 바꾸지 않는다)', () => {
    expect(save).toMatch(/putJson\(`\/tools\/focus-mon\/targets\/\$\{encodeURIComponent\(t\.id\)\}`/);
    expect(save).toMatch(/if \(r\?\.ok === false\) return r;/);
    expect(save).toMatch(/port: String\(f\.port\)\.trim\(\)/);
    expect(save).not.toMatch(/Number\(f\.port\)/);
  });
  it('수정 칸은 그 줄 바로 아래 한 줄(Fragment 로 묶어 정렬해도 함께 움직인다) · 정렬 키는 등록 값 · 데모 서버에는 수정 단추가 없다', () => {
    expect(src).toMatch(/<React\.Fragment key=\{t\.id\}>\s*<tr className=\{ed \? 'fm-editing' : undefined\}>/);
    expect(src).toMatch(/<\/tr>\s*\{edRow\}\s*<\/React\.Fragment>/);
    expect(src).toMatch(/<tr className="fm-editrow">\s*<td colSpan=\{6\}>/);
    expect(src).toMatch(/<td data-sort=\{t\.name\} style=/);
    expect(src).toMatch(/\{!t\.demo \? <button[^>]*onClick=\{\(\) => setEdit\(ed \? null : \{ id: t\.id, form: editFormOf\(t\) \}\)\}>\{ed \? '수정 닫기' : '수정'\}<\/button> : null\}/);
  });
});

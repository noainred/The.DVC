/**
 * 7b단계 서버 등록 화면 문구 — 판정은 서버 값 그대로(action · bucket · rttHigh) · 모르는 수는 '—' · 제안 CSV 는 템플릿 열 순서 + 수식 가드 ·
 * base64 는 큰 파일도 조각으로 · 키 관리 버튼은 소유자 등급만 · 화면 문구에 백틱 없음.
 */
import { describe, it, expect } from 'vitest';
import * as T from './bmOnboardText.js';

describe('bmOnboardText', () => {
  it('요약 칩 — 서버 summary 그대로 · 모르는 수는 —', () => {
    const c = T.summaryChips({ new: 3, update: 1, warn: 2, reject: 4, unchanged: 0 });
    expect(c.map((x) => x.text)).toEqual(['신규 3', '갱신 1', '경고 2', '거부 4', '변화 없음 0']);
    expect(T.summaryChips({}).every((x) => x.text.endsWith('—'))).toBe(true);
    expect(T.applicable({ new: 0, update: 0 })).toBe(false);
    expect(T.applicable({ new: 0, update: 2 })).toBe(true);
  });
  it('엣지 반영 — 인출 기록이 없으면 모름(반영됨 · 대기로 지어내지 않는다)', () => {
    expect(T.edgeSyncText({}).text).toMatch(/^모름/);
    expect(T.edgeSyncText({ pulledAt: 1, inSync: true }).text).toBe('반영됨');
    expect(T.edgeSyncText({ pulledAt: 1, inSync: false }).tone).toBe('warn');
  });
  it('수집 건강 RTT — 서버 rttHigh 그대로 · 없음(엣지 행)은 null · 모르면 모름', () => {
    expect(T.rttLine({ via: 'edge' })).toBe(null);
    expect(T.rttLine({ rttHigh: true, rttMs: 912 })).toEqual({ text: '중앙 직접 · RTT 912ms — 엣지 수집 권장', tone: 'warn' });
    expect(T.rttLine({ rttHigh: false, rttMs: 35 }).tone).toBe('muted');
    expect(T.rttLine({ rttHigh: null, rttMs: null }).text).toMatch(/모름/);
    // 화면이 800 을 다시 판정하지 않는다 — 서버가 false 면 1000ms 여도 경고가 아니다
    expect(T.rttLine({ rttHigh: false, rttMs: 1000 }).tone).toBe('muted');
  });
  it('제안 CSV — 템플릿 열 순서 · 수식 가드 · 제안 없는 행 제외', () => {
    const csv = T.suggestCsv([{ suggest: { name: '=evil', corp: 'KR', service_tag: 'T1', os_host: 'a.b.c', collect_via: 'auto' } }, { name: 'x' }]);
    const lines = csv.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toBe(T.TEMPLATE_COLUMNS.join(','));
    expect(lines).toHaveLength(2);
    expect(lines[1].startsWith("'=evil,KR,,,T1,a.b.c")).toBe(true);
  });
  it('base64 — 큰 버퍼도 조각으로(호출 스택 초과 없음) · 값 보존', () => {
    const u8 = new Uint8Array(300_000).map((_, i) => i % 251);
    const b = T.bufToBase64(u8.buffer);
    const back = Uint8Array.from(atob(b), (ch) => ch.charCodeAt(0));
    expect(back.length).toBe(u8.length);
    expect(back[299_999]).toBe(u8[299_999]);
  });
  it('기타 — 행 사유 · 숫자 · 지문 줄임 · 소유자 등급 · 백틱 없음', () => {
    expect(T.rowNote({ action: 'reject', reason: 'x' })).toBe('x');
    expect(T.rowNote({ action: 'new', warnings: [{ text: 'a' }, { text: 'b' }] })).toBe('a / b');
    expect(T.numOr(null)).toBe('—'); expect(T.numOr(0)).toBe('0');
    expect(T.shortFp('SHA256:abcdefghijklmnopqrstuvwxyz0123456789').length).toBeLessThan(30);
    expect(T.canManageKeys({ settingsOwnerTier: true }, true)).toBe(true);
    expect(T.canManageKeys({ settingsOwnerTier: false, isSettingsOwner: true }, true)).toBe(false);
    expect(T.canManageKeys({ settingsOwnerTier: true }, false)).toBe(false);
    for (const v of [...Object.values(T.MISS_REASON_TEXT), ...Object.values(T.BUCKET_TEXT)]) expect(v.includes('`')).toBe(false);
    expect(T.ymd(null)).toBe('—');
  });
  it('7b r2 — bm-storage 인증 선택: 바뀌지 않으면 참조 칸을 보내지 않는다(서버가 묶음으로 보지 않게) · 떼기는 빈 값 · 키/계정 고르기', () => {
    expect(T.authChoiceOf({ keyRef: 'k_1' })).toBe('key:k_1');
    expect(T.authChoiceOf({ credRef: 'a_1' })).toBe('acc:a_1');
    expect(T.authChoiceOf(null)).toBe('');
    expect(T.authBodyOf('key:k_1', { keyRef: 'k_1' })).toEqual({});
    expect(T.authBodyOf('', { keyRef: 'k_1' })).toEqual({ keyRef: '', credRef: '' });
    expect(T.authBodyOf('acc:a_2', { keyRef: 'k_1' })).toEqual({ credRef: 'a_2', keyRef: '' });
    expect(T.authBodyOf('', null)).toEqual({});
    expect(T.HOSTKEY_OBSERVE_NOTE).toMatch(/observe/);
    expect(T.BUCKET_ORDER).toContain('untracked');
    expect(T.MISS_REASON_TEXT['registry-only']).toMatch(/성능 수집 대상이 아닙니다/);
  });
  it('4회차 D1 — 회전 결과: 서버 경고(새 키로 막히는 수집 기능)를 문구 그대로 붙이고 주의 색 · 경고가 없으면 예전 문구 그대로', () => {
    const base = { ok: true, servers: ['s1', 's2'], accounts: 1, retestAdvised: true };
    expect(T.rotateResultText(base)).toEqual({ text: '회전했습니다 — 서버 2대 · 공통 계정 1개가 새 키를 씁니다. 서버마다 ‘연결 시험’ 을 다시 하세요(자동 재시험 없음).', tone: 'ok' });
    const w = T.rotateResultText({ ...base, warnings: [{ code: 'key-feature', features: ['bm-usage'], text: '새 키의 기능에 베어메탈 사용률 이(가) 없어 …' }] });
    expect(w.tone).toBe('warn');
    expect(w.text).toMatch(/다시 하세요\(자동 재시험 없음\)\. 주의: 새 키의 기능에 베어메탈 사용률/);
    expect(T.rotateResultText({ ok: true, servers: [], accounts: 0, retestAdvised: false })).toEqual({ text: '회전했습니다 — 서버 0대 · 공통 계정 0개가 새 키를 씁니다.', tone: 'ok' });
    expect(T.rotateResultText({ ...base, accounts: undefined, warnings: [{ code: 'x' }] }).text).toMatch(/공통 계정 —개/);   // 모르는 수는 — · 문구 없는 경고는 붙이지 않는다
    expect(T.rotateResultText({ ...base, warnings: [{ code: 'x' }] }).tone).toBe('ok');
  });
  it('6회차 B4 — bm-storage 인증 목록: 서버 selectable 그대로(웹 판정 없음) · 지금 설정은 남김 · 뺀 수 · 법인 귀속 없음 안내 · 못 읽으면 비움', () => {
    const r = { ok: true, corpless: true, keys: [{ id: 'a', name: 'k-vcA', selectable: false, issue: 'key-folder' }, { id: 'g', name: 'k-global', selectable: true }, { id: 'b', name: 'k-vcB', selectable: false, current: true }],
      accounts: [{ id: 'x', name: 'a-ops', selectable: false, issue: 'key-folder' }, { id: 'y', name: 'b-ops', selectable: true }] };
    const v = T.authChoicesView(r);
    expect(v.keys.map((k) => [k.name, k.fit])).toEqual([['k-global', true], ['k-vcB', false]]);
    expect(v.accounts.map((a) => a.name)).toEqual(['b-ops']);
    expect(v.hidden).toBe(2);
    expect(T.authChoicesNote(v)).toMatch(/2개는 목록에서 뺐습니다/);
    expect(T.authChoicesNote(v)).toMatch(/서버 등록\(CSV\)에서 법인을 정한 뒤/);
    expect(T.authChoicesNote(T.authChoicesView({ ...r, corpless: false }))).not.toMatch(/법인 귀속이 없어/);
    expect(T.authChoicesNote(T.authChoicesView({ ok: true, keys: [{ id: 'g', selectable: true }] }))).toBe('');
    const bad = T.authChoicesView(null);
    expect([bad.keys.length, bad.accounts.length, bad.error]).toEqual([0, 0, true]);
    expect(T.authChoicesNote(bad)).toMatch(/읽지 못했습니다/);
    for (const t of [T.authChoicesNote(v), T.authChoicesNote(bad)]) expect(t.includes('`')).toBe(false);
  });
});

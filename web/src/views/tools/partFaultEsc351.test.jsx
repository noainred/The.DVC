// 부품 장애 알림 단계 올리기 · 당직(v3.51 · 시안 ⑪) — 행 표지 · 편집 모델 왕복 · 설정 패널 렌더 · 화면 연결.
//   반증 B(B1~B15)와 웹 변이 생존(M13 · M14 · M16 · M17 · M19~M24)을 막는다. 클릭 동작은 jsdom 이 없어 소스 꼴로 고정하고 Chromium 으로 확인한다.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { stripComments } from '../../test/_stripComments.js';
import { escMarkView, escToForm, formToEsc, newPolicy, newOncall, nextOncallAgent, oncallDupOf, agentLabel, escRunText, escRunResults, ESC_NOTE, ESC_ONCALL_NOTE, ESC_STATE_LABEL } from './partFaultEscText.js';

const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const read = (p) => stripComments(fs.readFileSync(new URL(p, import.meta.url), 'utf8'));
const DAY7 = () => Array.from({ length: 7 }, () => ({ name: '', email: '' }));

describe('행 표지', () => {
  it('간 단계는 ‘보냄’ · 가지 않은 단계는 ‘안 감’(다시 시도 · 그만둠) · 아직이면 ‘2단계 대기’(1단계가 나갔다고 말하지 않는다)', () => {
    const on = { canAck: true, enabled: true };
    expect(escMarkView({ ackId: 'a', covered: true, step: 3, acked: false }, on)).toMatchObject({ text: '3단계 보냄', tone: 'amber', canAck: true });
    const wait = escMarkView({ ackId: 'a', covered: true, step: null, acked: false }, on);
    expect(wait).toMatchObject({ text: '2단계 대기', canAck: true });
    expect(wait.text).not.toContain('1단계');
    // 반증 B1 — 받는 곳이 없어 가지 않았으면 ‘보냄’ 이 아니다
    const t = escMarkView({ ackId: 'a', covered: true, step: null, tried: 3, acked: false }, on);
    expect(t).toMatchObject({ text: '3단계 안 감', tone: 'red', canAck: true });
    expect(t.title).toContain('다음 회차에 다시 보냅니다');
    const g = escMarkView({ ackId: 'a', covered: true, step: 2, tried: 3, gaveUp: true, acked: false }, on);
    expect(g.title).toContain('그만뒀습니다'); expect(g.title).toContain('2단계까지는 갔습니다');
  });
  it('꺼짐 · 정책 밖 — 확인 단추 없음 · 이미 간 단계와 확인함은 보인다(M13) · 확인 단추는 쓰기 계정 · 열쇠가 있을 때만(M21)', () => {
    expect(escMarkView({ ackId: 'a', covered: true, step: null }, { canAck: true, enabled: false })).toBe(null);
    expect(escMarkView({ ackId: 'a', covered: false, step: null }, { canAck: true, enabled: true })).toBe(null);
    expect(escMarkView({ ackId: 'a', covered: false, step: 2 }, { canAck: true, enabled: true })).toMatchObject({ text: '2단계 보냄', canAck: false });
    expect(escMarkView({ ackId: 'a', covered: true, step: null, tried: 2 }, { canAck: true, enabled: false })).toMatchObject({ text: '2단계 안 감', canAck: false });
    const ack = escMarkView({ ackId: 'a', acked: true, ackBy: 'oper1', ackedAt: 1 }, { canAck: true, enabled: false });
    expect(ack).toMatchObject({ text: '확인함 · oper1', canAck: false });
    expect(ack.title).toContain('oper1');
    expect(escMarkView({ ackId: 'a', covered: true, step: 2 }, { canAck: false, enabled: true }).canAck).toBe(false);
    expect(escMarkView({ covered: true, step: 2 }, { canAck: true, enabled: true }).canAck).toBe(false);
    expect(escMarkView(null)).toBe(null);
  });
  it('상태 이름은 부품 장애 화면과 같다(M14 — 서버 PART_STATE_LABEL 대조)', () => {
    const src = fs.readFileSync(new URL('../../../../server/src/partfault/types.js', import.meta.url), 'utf8');
    const m = /PART_STATE_LABEL = Object\.freeze\(\{([^}]*)\}/.exec(src)[1];
    for (const [k, v] of Object.entries(ESC_STATE_LABEL)) expect(m).toContain(`${k}: '${v}'`);
  });
});

describe('편집 모델', () => {
  it('서버 설정 ↔ 칸 왕복 · 메일은 쉼표 · 줄바꿈(조용히 자르지 않음 — M17) · 수집 주체는 소문자(공백 있는 이름 그대로) · 빈 분은 수가 아닌 값', () => {
    const s = { enabled: true, policies: [{ id: 'p1', name: '이상', agents: ['pl-edge'], states: ['fault'], steps: [{ afterMin: 15, emails: ['a@example.test', 'b@example.test'], channels: false, oncall: false }, { afterMin: 30, emails: [], channels: true, oncall: true }] }], oncall: { '*': { days: Array.from({ length: 7 }, (_, i) => ({ name: `n${i}`, email: '' })) } } };
    const f = escToForm(s);
    expect(f.policies[0].steps[0].emailsText).toBe('a@example.test, b@example.test');
    expect(formToEsc(f)).toEqual(s);
    const g = { ...f, policies: [{ ...f.policies[0], agentsText: 'PL-Edge;  us-east\nKR Seoul', steps: [{ afterMin: '', emailsText: Array.from({ length: 25 }, (_, i) => `m${i}@example.test`).join('\n'), channels: true, oncall: false }] }] };
    const b = formToEsc(g);
    expect(b.policies[0].agents).toEqual(['pl-edge', 'us-east', 'kr seoul']);
    expect(b.policies[0].steps[0].emails.length).toBe(25);   // 상한(10)은 서버가 거절 사유로
    expect(b.policies[0].steps[0].afterMin).toBe(0);
    // 당직표 키도 소문자(M16)
    expect(Object.keys(formToEsc({ oncall: [{ agent: 'PL-Edge', days: DAY7() }] }).oncall)).toEqual(['pl-edge']);
    expect(newPolicy().steps.map((x) => x.afterMin)).toEqual(['15', '30']);
    expect([agentLabel('*'), agentLabel(''), agentLabel('pl-edge')]).toEqual(['모두', '이 포탈(중앙 수집)', 'pl-edge']);
  });
  it('같은 수집 주체의 당직표가 겹치면 막는다 · 새 표는 아직 없는 주체로 · 다 쓰면 더하기 없음(반증 B2)', () => {
    const f = { oncall: [newOncall('*'), newOncall(''), newOncall('')] };
    f.oncall[2].days[1] = { name: '김철수', email: 'kim@example.test' };
    expect(oncallDupOf(f)).toBe('이 포탈(중앙 수집)');
    expect(oncallDupOf({ oncall: [newOncall('PL-Edge'), newOncall('pl-edge')] })).toBe('pl-edge');
    expect(oncallDupOf({ oncall: [newOncall('*'), newOncall('')] })).toBe('');
    // 겹쳐도 뒤 표가 앞 표를 덮지 않는다(화면이 저장을 막지만 순수 함수도 덮지 않는다)
    expect(formToEsc({ oncall: [{ agent: '', days: [{ name: 'A', email: '' }, ...DAY7().slice(1)] }, { agent: '', days: DAY7() }] }).oncall[''].days[0].name).toBe('A');
    expect(nextOncallAgent({ oncall: [] }, ['pl-edge'])).toBe('*');
    expect(nextOncallAgent({ oncall: [newOncall('*')] }, ['pl-edge'])).toBe('');
    expect(nextOncallAgent({ oncall: [newOncall('*'), newOncall('')] }, ['pl-edge'])).toBe('pl-edge');
    expect(nextOncallAgent({ oncall: [newOncall('*'), newOncall(''), newOncall('pl-edge')] }, ['pl-edge'])).toBe(null);
  });
  it('회차 줄 — 시도 · 감 · 안 감을 가른다 · 보내지 않은 이유 · 주기는 API 값(숫자를 박지 않음 — B10) · 결과 줄', () => {
    expect(escRunText(null)).toBe('아직 돌지 않았습니다.');
    expect(escRunText(null, 60_000)).toContain('60초 안에');
    expect(escRunText(null, 30_000)).toContain('30초 안에');
    const t = escRunText({ at: 0, enabled: true, sent: 20, delivered: 0, failed: 20, deferred: 3, held: 2, overCap: 1, errors: ['진행 기록을 쓰지 못했습니다'] });
    for (const s of ['시도 20 · 감 0 · 안 감 20', '다음 회차로 미룸 3', '정비 창 보류 2', '기록 상한을 넘어 보내지 않음 1', '진행 기록을 쓰지 못했습니다']) expect(t).toContain(s);
    expect(escRunText({ at: 0, enabled: true, why: 'demo', sent: 0 })).toContain('데모 점검이라 보내지 않음');
    expect(escRunText({ at: 0, enabled: true, why: 'partfault-off', sent: 0 })).toContain('부품 장애 점검이 꺼져');
    expect(escRunResults({ results: [{ part: 'synth-db-01 · PSU 1', step: 3, result: '받는 곳 없음', delivered: false }, { part: 'x', step: 2, result: '메일 1명', delivered: true }] }).map((x) => [x.text, x.ok]))
      .toEqual([['synth-db-01 · PSU 1 · 3단계 · 받는 곳 없음', false], ['x · 2단계 · 메일 1명', true]]);
    expect(escRunResults(null)).toEqual([]);
  });
  it('안내문 — 1단계가 나갔다고 단정하지 않음(B6) · 요일마다 ‘모두’ 표로 대체(B12)', () => {
    expect(ESC_NOTE).not.toContain('1분'); expect(ESC_NOTE).toContain('정책 대상으로 처음 본 때부터');
    expect(ESC_ONCALL_NOTE).toContain('그 요일 당직이 없으면'); expect(ESC_ONCALL_NOTE).toContain('이 포탈 서버의 시각');
  });
});

describe('렌더 · 연결', () => {
  const D = { ok: true, settings: { enabled: false, policies: [{ id: 'p1', name: '이상', agents: [], states: ['fault'], steps: [{ afterMin: 15, emails: [], channels: true, oncall: false }] }], oncall: { '*': { days: DAY7() } } }, agents: ['pl-edge'], run: null, tickMs: 60_000, limits: { steps: 4, policies: 20 } };
  it('설정 패널 — 정책 · 단계(2단계부터) · 당직표 7요일 · 파일 못 읽음이면 저장 잠금 · 결과 줄', async () => {
    const { default: P } = await import('./PartFaultEscalation.jsx');
    const html = renderToStaticMarkup(React.createElement(P, { initial: D }));
    const t = text(html);
    expect(t).toContain('알림 단계 올리기 · 당직'); expect(t).toContain('1단계 — 지금 부품 장애 알림'); expect(t).toContain('2단계');
    expect(t).toContain('60초 안에');
    expect((html.match(/당직 메일"/g) || []).length).toBe(7);
    expect(html).toMatch(/<button type="button" class="login-btn bmd-btn">저장<\/button>/);
    expect(html).toContain('class="logout-btn pfe-add"');
    const locked = renderToStaticMarkup(React.createElement(P, { initial: { ...D, unreadable: true } }));
    expect(locked).toMatch(/<button type="button" class="login-btn bmd-btn" disabled="">저장<\/button>/);
    expect(text(locked)).toContain('설정 파일을 읽지 못했습니다');
    const withRes = text(renderToStaticMarkup(React.createElement(P, { initial: { ...D, run: { at: 0, enabled: true, sent: 1, delivered: 0, failed: 1, results: [{ part: 'synth · PSU 1', step: 2, result: '채널 안 감', delivered: false }] } } })));
    expect(withRes).toContain('마지막 회차 보낸 결과 1건 · 안 감 1'); expect(withRes).toContain('synth · PSU 1 · 2단계 · 채널 안 감');
  });
  it('당직표가 겹친 설정을 받으면 저장 잠금 · 사유(B2) · 겹친 주체는 다른 표에서 고를 수 없다', async () => {
    const { default: P } = await import('./PartFaultEscalation.jsx');
    // 서버는 겹친 키를 줄 수 없으므로 칸 상태로 — escToForm 결과에 표를 하나 더 붙인 꼴을 initial 로 흉내 낸다
    const html = renderToStaticMarkup(React.createElement(P, { initial: { ...D, settings: { ...D.settings, oncall: { '*': { days: DAY7() }, '': { days: DAY7() } } } } }));
    expect(html).toMatch(/<option value="" disabled="">이 포탈\(중앙 수집\)<\/option>/);
    expect(html).toMatch(/<option value="\*" disabled="">모두<\/option>/);
    const src = read('./PartFaultEscalation.jsx');
    expect(src).toMatch(/disabled=\{busy \|\| !!d\.unreadable \|\| !!dup\}/);
  });
  it('패널 동작(소스 꼴) — 저장 실패 사유 유지(M19) · 서버 응답으로 칸 바꿈(M24) · 저장 뒤 목록 다시 읽기(B3) · 저장 중 칸 잠금(B15) · 고치면 거절 사유 지움(B14)', () => {
    const src = read('./PartFaultEscalation.jsx');
    expect(src).toMatch(/catch \(e\) \{ setMsg\(\{ ok: false, text: e\?\.message \|\| String\(e\) \}\); \}/);
    expect(src).toMatch(/setFormRaw\(escToForm\(r\.settings\)\)/);
    expect(src).toMatch(/onSaved\?\.\(\);/);
    expect(src).toMatch(/<fieldset className="pfe-fs" disabled=\{busy\}>/);
    expect(src).toMatch(/if \(msg && !msg\.ok\) setMsg\(null\);/);
    expect(src).toMatch(/const save = async \(\) => \{\n\s*if \(dup\) \{ setMsg\(\{ ok: false/, '단추 잠금과 별도로 저장 함수도 겹침을 막는다(변이 M25)');
  });
  it('부품 장애 화면 — 확인은 열쇠로 · 연타 막이(M20) · 결과는 그 행에 · 성공 · 실패 모두 다시 읽기(M23 · B4) · 설정 단추는 관리자만(M22) · 저장 뒤 다시 읽기', () => {
    const src = read('./PartFaults.jsx');
    expect(src).toMatch(/postJson\('\/tools\/part-faults\/ack', \{ ackId: id \}\)/);
    expect(src).toMatch(/escMarkView\(p\.esc, \{ canAck: !!data\?\.canAck, enabled: !!data\?\.escalation\?\.enabled \}\)/);
    expect(src).toMatch(/ev\?\.canAck \? <button type="button" className="btn btn-sm" disabled=\{busy\} onClick=\{\(\) => ackRow\(p\)\}>확인<\/button>/);
    expect(src).toMatch(/finally \{ setBusy\(false\); \}\n\s*await load\(\);/);
    expect(src).toMatch(/const am = ackMsg && p\.esc\?\.ackId === ackMsg\.id \? ackMsg : null;/);
    expect(src).toMatch(/tab === 'open' && !isEdge && settings \? \(/);
    expect(src).toMatch(/tab === 'open' && !isEdge && settings && escOpen \? <PartFaultEscalation onSaved=\{load\} onDirty=/);
    expect(src).toMatch(/if \(escOpen && escDirty\.current && !window\.confirm\('알림 단계 · 당직에 저장하지 않은 변경이 있습니다/, '바뀐 칸이 있을 때만 닫기 전에 묻는다(변이 M41)');
  });
});

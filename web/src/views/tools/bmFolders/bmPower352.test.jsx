// 물리서버 원격 전원 · 위치 LED(⑦ ⑥) · 장애 바로 받기(⑬)(v3.52) — 화면 글자 · 구역 · 설정 창 렌더 · 연결. 집행은 서버(시험은 server/test/bmPower352 · bmEvents352).
//   반증 B(B1~B18)와 웹 변이 생존(확인 칸 렌더 0 · 잠금 글자만 봄 · 창 연결 대조 없음)을 막는다. 클릭은 jsdom 이 없어 initialPick · initialForm 으로 상태를 그린다.
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { stripComments } from '../../../test/_stripComments.js';
import { powerButtons, confirmIssue, powerResultText, powerFailText, POWER_STATUS, POWER_OFF_NOTE, syncSummary, evtSevLabel, EVT_NOTE, EVT_SEV_ORDER } from './powerText.js';
import { LED_NOTE } from './opsText.js';

const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const read = (p) => stripComments(fs.readFileSync(new URL(p, import.meta.url), 'utf8'));
const ACTS = { on: { label: '켜기', force: false }, shutdown: { label: '정상 종료', force: false }, restart: { label: '정상 재시작', force: false }, forceRestart: { label: '강제 재시작', force: true }, forceOff: { label: '강제 끄기', force: true } };
const PS = (over = {}) => ({ enabled: true, allowForce: false, canUse: true, canPower: true, otpRequired: true, actions: ACTS, ...over });

describe('글자', () => {
  it('단추 — 강제 동작은 허용됐을 때만 · 순서 고정', () => {
    expect(powerButtons({ actions: ACTS, allowForce: false }).map((b) => b.k)).toEqual(['on', 'shutdown', 'restart']);
    expect(powerButtons({ actions: ACTS, allowForce: true }).filter((b) => b.force).map((b) => b.label)).toEqual(['강제 재시작', '강제 끄기']);
    expect(powerButtons(null)).toEqual([]);
  });
  it('확인 칸 — 이름 그대로 · 사유 4자 · OTP(필요할 때만)', () => {
    const ok = { confirm: 'synth-db-01', reason: '점검 작업', otp: '123456' };
    expect(confirmIssue(ok, 'synth-db-01', true)).toBe('');
    expect(confirmIssue({ ...ok, confirm: 'synth-db' }, 'synth-db-01', true)).toContain('서버 이름을 그대로');
    expect(confirmIssue({ ...ok, reason: 'abc' }, 'synth-db-01', true)).toContain('4자 이상');
    expect(confirmIssue({ ...ok, otp: '12' }, 'synth-db-01', true)).toContain('OTP');
    expect(confirmIssue({ ...ok, otp: '' }, 'synth-db-01', false)).toBe('');
    expect(confirmIssue(ok, '', false)).toContain('이름을 몰라');
  });
  it('결과 — 받음은 끝남이 아니다 · 데모는 받음이라 하지 않음(B6) · 같은 문장 두 번 없음(B7) · 태그 대조 못 함', () => {
    const a = powerResultText({ ok: true, status: 'accepted', reset: 'GracefulShutdown', before: 'On', via: 'local', tagChecked: false }, '정상 종료');
    expect(a.ok).toBe(true); expect(a.text).toContain('끝났다는 뜻이 아닙니다'); expect(a.text).toContain('GracefulShutdown'); expect(a.text).toContain('서비스 태그는 대조하지 못했습니다');
    const demo = powerResultText({ ok: true, status: 'accepted', via: 'demo', message: '데모 — 장비에 보내지 않았습니다.' }, '강제 끄기');
    expect(demo.text).toContain('데모: 장비에 보내지 않았습니다'); expect(demo.text).not.toContain('받았습니다');
    const t = powerResultText({ ok: false, status: 'timeout', message: '장비가 시한 안에 답하지 않았습니다 — 요청이 장비에 닿았는지 모릅니다' });
    expect(t.text.match(/닿았는지 모릅니다/g).length).toBe(1);
    expect(powerResultText({ ok: false, status: 'edge-fail' }).text).toContain('닿았는지 모릅니다');
    expect(powerResultText({ ok: false, status: 'tag-mismatch' }).text).toContain('서비스 태그가 등록과 달라');
    expect(powerResultText({ ok: false, status: 'error', message: 'Destination refused' }).text).toContain('Destination refused');
    expect(powerResultText(null).ok).toBe(false);
    expect(Object.keys(POWER_STATUS)).toEqual(expect.arrayContaining(['old-version', 'rate', 'force-off', 'tag-mismatch']));
  });
  it('브라우저 쪽 실패 — 서버 사유가 있는 4xx 는 사유 · 끊김 · 5xx · 시한은 ‘모름’(B5)', () => {
    const otp = powerFailText({ status: 403, body: { ok: false, reason: 'OTP 인증 실패 — 틀림' }, message: 'OTP 인증 실패 — 틀림' }, '정상 종료');
    expect([otp.unknown, otp.text]).toEqual([false, '정상 종료 — 보내지 않았습니다 — OTP 인증 실패 — 틀림']);
    for (const e of [new TypeError('Failed to fetch'), { status: 504, body: null, message: '/tools/bm-folders/power -> 504' }, { name: 'TimeoutError', message: 'signal timed out' }]) {
      const x = powerFailText(e, '정상 종료');
      expect(x.unknown).toBe(true); expect(x.text).toContain('닿았는지 모릅니다');
    }
  });
  it('⑬ — 결과 한 줄 · 등급 이름 · 정렬 순서(B12) · 안내(이벤트 글자로 판정하지 않음 · 인벤토리를 다시 읽음)', () => {
    expect(syncSummary([{ status: 'subscribed' }, { status: 'subscribed' }, { status: 'error' }])).toBe('3대 — 걸림 2 · 실패 1');
    expect(syncSummary([])).toContain('대상 서버 없음');
    expect([evtSevLabel('critical'), evtSevLabel('warning'), evtSevLabel('ok'), evtSevLabel('constructor')]).toEqual(['위험', '주의', '정보', '모름']);
    expect(['critical', 'warning', 'ok', ''].map((k) => EVT_SEV_ORDER[k])).toEqual([0, 1, 2, 3]);
    expect(EVT_NOTE).toContain('이벤트 글자로 판정하지 않습니다'); expect(EVT_NOTE).toContain('인벤토리를 주기를 기다리지 않고 다시 읽고');
    expect(LED_NOTE).toContain('쓰기 권한이 있는 계정');
  });
});

describe('구역 · 창 렌더', () => {
  const r = { key: 'st:SYNTH01', kind: 'bm', name: 'synth-db-01', corp: 'vc-a' };
  beforeEach(async () => { (await import('./PowerSection.jsx'))._resetPowerUiForTest(); });
  it('전원 구역 — 쓸 수 없는 계정은 그리지 않음 · 꺼짐 · 설정 못 읽음(B10) · LED 는 쓰기 범위(B14) · 전원은 canPower · 강제는 허용 때만', async () => {
    const { default: P } = await import('./PowerSection.jsx');
    expect(renderToStaticMarkup(React.createElement(P, { r, writable: true, initial: PS({ canUse: false }) }))).toBe('');
    expect(renderToStaticMarkup(React.createElement(P, { r: { ...r, kind: 'esxi' }, writable: true, initial: PS() }))).toBe('');
    expect(text(renderToStaticMarkup(React.createElement(P, { r, writable: true, initial: PS({ enabled: false }) })))).toContain(POWER_OFF_NOTE);
    expect(text(renderToStaticMarkup(React.createElement(P, { r, writable: true, initial: PS({ enabled: false, unreadable: true }) })))).toContain('설정 파일을 읽지 못해 꺼짐으로 봅니다');
    const on = text(renderToStaticMarkup(React.createElement(P, { r, writable: true, initial: PS() })));
    for (const s of ['위치 LED', '깜빡임', '정상 종료', '정상 재시작']) expect(on).toContain(s);
    expect(on).not.toContain('강제');
    const ro = text(renderToStaticMarkup(React.createElement(P, { r, writable: false, initial: PS({ canPower: false }) })));
    expect(ro).toContain('조회 전용이라 LED 를 바꿀 수 없습니다'); expect(ro).not.toContain('깜빡임'); expect(ro).not.toContain('정상 종료');
    const op = text(renderToStaticMarkup(React.createElement(P, { r, writable: true, initial: PS({ canPower: false }) })));
    expect(op).toContain('깜빡임'); expect(op).not.toContain('정상 종료');
    const nocorp = text(renderToStaticMarkup(React.createElement(P, { r: { ...r, corp: '' }, writable: false, initial: PS({ canPower: false }) })));
    expect(nocorp).toContain('전체 범위 관리자만');
    const force = renderToStaticMarkup(React.createElement(P, { r, writable: true, initial: PS({ allowForce: true }) }));
    expect((force.match(/bmd-pw-force/g) || []).length).toBe(2);
  });
  it('확인 칸 — 이름 · 사유 · OTP 가 맞아야 보내기가 열린다 · 강제 경고 · OTP 칸은 필요할 때만', async () => {
    const { default: P } = await import('./PowerSection.jsx');
    const pick = { k: 'forceOff', label: '강제 끄기', force: true };
    const go = (form, ps = PS({ allowForce: true })) => renderToStaticMarkup(React.createElement(P, { r, writable: true, initial: ps, initialPick: pick, initialForm: form }));
    const btn = (html) => /<button type="button" class="login-btn bmd-btn bmd-pw-go-force"( disabled="")?>강제 끄기 보내기<\/button>/.exec(html);
    const ok = { confirm: 'synth-db-01', reason: '점검 작업', otp: '123456' };
    expect(btn(go(ok))[1]).toBeUndefined();
    expect(btn(go({ ...ok, confirm: 'synth-db' }))[1]).toBe(' disabled=""');
    expect(btn(go({ ...ok, reason: 'ab' }))[1]).toBe(' disabled=""');
    expect(btn(go({ ...ok, otp: '' }))[1]).toBe(' disabled=""');
    expect(btn(go({ ...ok, otp: '' }, PS({ allowForce: true, otpRequired: false })))[1]).toBeUndefined();
    const t = text(go(ok));
    expect(t).toContain('운영체제를 기다리지 않습니다'); expect(t).toContain('강제 끄기 — synth-db-01');
    expect(go(ok)).toContain('aria-label="OTP"');
    expect(go(ok, PS({ allowForce: true, otpRequired: false }))).not.toContain('aria-label="OTP"');
    expect(renderToStaticMarkup(React.createElement(P, { r, writable: true, initial: PS({ canPower: false }), initialPick: pick, initialForm: ok }))).not.toContain('강제 끄기 보내기');
  });
  it('원격 전원 설정 창 — 켜기 · 강제(켜기 아래) · OTP · 파일 못 읽음이면 저장 잠금(단추가 잠긴다)', async () => {
    const { default: S } = await import('./RemotePowerSettings.jsx');
    const html = renderToStaticMarkup(React.createElement(S, { onClose: () => {}, initial: { ok: true, settings: { enabled: false, allowForce: false }, otpRequired: true } }));
    expect(text(html)).toContain('원격 전원 · 위치 LED 켜기'); expect(html).toContain('aria-label="OTP"');
    expect(html).toMatch(/<input type="checkbox" disabled=""\/> 강제 재시작 · 강제 끄기 허용/);
    const locked = renderToStaticMarkup(React.createElement(S, { onClose: () => {}, initial: { ok: true, unreadable: true, settings: { enabled: false, allowForce: false } } }));
    expect(text(locked)).toContain('설정 파일을 읽지 못했습니다');
    expect(locked).toMatch(/<button type="button" class="login-btn bmd-btn" disabled="">저장<\/button>/);
  });
  it('이벤트 구독 창 — 받는 주소 · 비밀은 보이지 않음 · 결과 표 · 200 넘으면 남은 수(B4) · 버린 수(B13) · 받은 이벤트 · 엣지 안내 · 긴 체크 글자 줄바꿈(B2)', async () => {
    const { default: S } = await import('./EventSubSettings.jsx');
    const many = Array.from({ length: 230 }, (_, i) => ({ id: `s${i}`, name: `synth-db-${i}`, status: 'subscribed', removed: 0 }));
    const d = { ok: true, settings: { enabled: true, base: 'https://portal.example.test:8443', hasSecret: true }, destinationPreview: 'https://portal.example.test:8443/api/bm-events/in/…', otpRequired: true, edge: true,
      status: { received: 3, rejected: 1, dropped: 5, checks: 1, lastAt: 1, recent: [{ rx: 1, id: 's1', name: 'synth-db-01', sev: 'critical', msgId: 'PSU0003', msg: 'PSU 1 lost' }] },
      sync: { running: false, unsubscribe: false, results: [{ id: 's1', name: 'synth-db-01', status: 'subscribed', removed: 1 }, { id: 's2', name: 'synth-db-02', status: 'not-supported', removed: 0, message: '장비가 이벤트 구독(EventService)을 알려 주지 않았습니다.' }] } };
    const html = renderToStaticMarkup(React.createElement(S, { onClose: () => {}, initial: d }));
    const t = text(html);
    for (const s of ['/api/bm-events/in/…', '비밀 새로 만들기', '2대 — 걸림 1 · 지원 안 함 1', '옛 구독 1개 지움', 'PSU0003 — PSU 1 lost', '위험', '3건 받음 · 거절 1건', '32건이 넘어 버림 5건', '법인 엣지']) expect(t).toContain(s);
    expect(html).toContain('aria-label="OTP"');
    expect((html.match(/pfe-on bmd-wrapline/g) || []).length).toBe(2);
    expect(html).toMatch(/data-sort="0">위험/);
    const big = text(renderToStaticMarkup(React.createElement(S, { onClose: () => {}, initial: { ...d, sync: { running: false, results: many } } })));
    expect(big).toContain('나머지 30대');
  });
  it('연결 — 드로어(쓰기 범위 넘김) · 관리자 단추 둘 → 창 · 엣지 화면의 이벤트 구독(B1) · 진행 중 창 닫기 막음(B18) · 걸기에도 확인(B17)', () => {
    expect(read('./BmDrawer.jsx')).toMatch(/<PowerSection key=\{`pw:\$\{r\.key\}`\} r=\{r\} writable=\{writable\} \/>/);
    const src = read('../BmFolders.jsx');
    expect(src).toMatch(/\{d\.canFleet \? <button[^\n]*onClick=\{\(\) => setPowerCfg\(true\)\}/);
    expect(src).toMatch(/\{d\.canFleet \? <button[^\n]*onClick=\{\(\) => setEvtCfg\(true\)\}/);
    expect(src).toMatch(/\{powerCfg \? <RemotePowerSettings onClose=\{\(\) => setPowerCfg\(false\)\} \/> : null\}/);
    expect(src).toMatch(/\{evtCfg \? <EventSubSettings onClose=\{\(\) => setEvtCfg\(false\)\} \/> : null\}/);
    const ev = read('./EdgeView.jsx');
    expect(ev).toMatch(/\{d\.canFleet \? <button[^\n]*onClick=\{\(\) => setEvtCfg\(true\)\}/);
    expect(ev).toMatch(/\{evtCfg \? <EventSubSettings onClose=\{\(\) => setEvtCfg\(false\)\} \/> : null\}/);
    expect(read('./EventSubSettings.jsx')).toMatch(/onClose=\{\(\) => \{ if \(!busy\) onClose\(\); \}\}/);
    expect(read('./RemotePowerSettings.jsx')).toMatch(/onClose=\{\(\) => \{ if \(!busy\) onClose\(\); \}\}/);
    expect(read('./EventSubSettings.jsx')).toMatch(/if \(!window\.confirm\(unsubscribe \?/);
    const ps = read('./PowerSection.jsx');
    expect(ps).toMatch(/if \(e\.key === 'Escape'\) \{ e\.preventDefault\(\); e\.stopPropagation\(\); e\.nativeEvent\?\.stopPropagation\?\.\(\); closeConfirm\(\); \}/);
    expect(ps).toMatch(/\} catch \(e\) \{[^}]*?\}[^}]*?if \(ft\.unknown\)[^\n]*\n\s*if \(kind === 'power'\) setF\(\(x\) => \(\{ \.\.\.x, otp: '' \}\)\);/, '실패(틀린 OTP 403 포함)에도 OTP 를 비운다(B11)');
    expect(ps).toMatch(/const _inflight = new Set\(\);/);
  });
});

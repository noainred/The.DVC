// v3.49 — 물리서버 운영 화면(⑩ 건강 점수 · ⑥ 위치 LED · ⑤ 하드웨어 이벤트 로그 · ⑫ 제조사 케이스 · ④ 보안 권고): 글자 · 렌더 · 소스 스윕.
//   점수만 보이지 않고 사유를 늘 같이 · 못 읽은 항목은 따로(못 읽어서 100 점처럼 보이지 않게) · LED 못 읽음은 꺼짐이 아니다 ·
//   이벤트 로그는 단추로 읽는다(넘길 때마다 장비에 묻지 않게) · 권고 표가 비면 ‘대조하지 않음’(‘걸린 것 없음’ 이 아니다) · 문구에 백틱 없음.
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { stripComments } from '../../../test/_stripComments.js';
import { healthCell, healthView, healthItemText, ledText, filterHwLog, hwLogHead, advisoryView, caseStatusText, HWLOG_WHY, HWLOG_STATUS, ledgerApplyState, LED_NOTE, HWLOG_SCOPE_NOTE } from './opsText.js';
import { chkChips, chkCounts, chkQuickMatch, CHK_QUICK } from './checkText.js';

vi.mock('../../../api.js', async (orig) => {
  const real = await orig();
  return { ...real, fetchJson: () => new Promise(() => {}), postJson: () => new Promise(() => {}), downloadFile: () => Promise.resolve(), can: () => true, canCsv: () => true };
});
const read = (rel) => stripComments(fs.readFileSync(new URL(rel, import.meta.url), 'utf8'));
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const RULES = { fault: { per: 12, cap: 36 }, warrantyExpired: { per: 10, cap: 10 }, warrantySoon: { per: 3, cap: 3 }, fwBehind: { per: 3, cap: 12 }, biosDiff: { per: 2, cap: 8 } };

describe('⑩ 건강 점수 글자', () => {
  it('칸 — 점수 · 단계 색 · 못 읽은 수 · 사유가 든 설명 · 점수 없음은 —', () => {
    expect(healthCell({ s: 79, b: 'warn', u: 1, d: [['fault', 12, 1], ['fw', 6, 2], ['warranty', 3, null, 'soon']] })).toEqual({
      score: 79, band: 'warn', label: '79', color: 'amber', unknown: 1,
      title: '79점(주의) — −12 부품 장애 1건 · −6 펌웨어 2개가 기준보다 뒤처짐 · −3 보증 곧 끝남 · 못 읽은 항목 1개는 점수에 넣지 않았습니다',
    });
    expect(healthCell({ s: 100, b: 'ok', u: 0 }).title).toBe('100점(양호) — 감점 없음');
    expect(healthCell({ b: 'none', u: 4 })).toMatchObject({ score: null, label: '—', color: 'gray', title: '견준 항목이 없어 점수를 내지 않았습니다 — 못 읽은 항목 4개.' });
    expect(healthCell(null)).toBe(null); expect(healthCell({ s: 50, b: 'evil' }).band).toBe('none');
    expect(healthItemText(['bios', 4, 2])).toBe('−4 BIOS 설정 2개가 묶음과 다름');
  });
  it('구역 — 감점 줄 · 감점 0 으로 견준 것 · 못 읽은 것의 이름 · 규칙(응답 값)', () => {
    const v = healthView({ kind: 'bm', faults: 0, chk: { w: 'ok', fw: 'behind', fwn: 2, bios: 'unplaced' }, hs: { s: 94, b: 'ok', u: 1, uk: ['bios'], d: [['fw', 6, 2]], z: [['fault'], ['warranty', 'ok']] } }, RULES);
    expect(v.lines.map((l) => l.text)).toEqual(['−6 펌웨어 2개가 기준보다 뒤처짐']);
    expect(v.judged).toEqual(['0 부품 장애 없음', '0 보증 안']);
    expect(v.unknownText).toEqual(['BIOS 설정(미분류 · 못 읽음)']);
    expect(v.ruleText).toContain('부품 장애 건당 12(최대 36)');
    expect(healthView({ kind: 'bm', faults: null, chk: {}, hs: { b: 'none', u: 4, uk: ['fault', 'warranty', 'fw', 'bios'] } }).unknownText.length).toBe(4);
    expect(healthView({ kind: 'esxi', faults: 0, chk: { w: 'ok' }, hs: { s: 100, b: 'ok', u: 0, uk: [], z: [['fault'], ['warranty', 'ok']] } }).unknownText).toEqual([], 'ESXi 행은 펌웨어 · BIOS 를 모름으로 세지 않는다');
    // 견줌 · 모름은 서버 값(z · uk)만 — 웹이 chk 로 다시 판정하지 않는다(견준 줄 0 인 갈림은 서버가 uk 에 넣는다 · v3.49 반증 A1)
    const sp = healthView({ kind: 'bm', faults: 0, chk: { w: 'ok', fw: 'split', fwj: 0, bios: 'split', biosj: 2 }, hs: { s: 100, b: 'ok', u: 1, uk: ['fw'], z: [['fault'], ['warranty', 'ok'], ['bios', 'split']] } });
    expect(sp.judged).toEqual(['0 부품 장애 없음', '0 보증 안', '0 BIOS 설정(값이 갈려 감점하지 않음)']);
    expect(sp.unknownText).toEqual(['펌웨어(기준 없음 · 못 읽음)']);
    expect(healthView({ hs: { s: 100, b: 'ok', u: 0, z: [['constructor'], ['fw', '__proto__'], 'x'], uk: ['constructor', 7] } })).toMatchObject({ judged: [], unknownText: [] });
    expect(healthView({ hs: null })).toBe(null);
  });
});

describe('⑥ · ⑤ · ⑫ · ④ 글자', () => {
  it('LED — 못 읽음은 꺼짐이 아니다', () => {
    expect([ledText('on'), ledText('blink'), ledText('off'), ledText(''), ledText(undefined), ledText('constructor')]).toEqual(['켜짐', '깜빡임', '꺼짐', '못 읽음', '못 읽음', '못 읽음']);
  });
  it('이벤트 로그 — 찾기(내용 · 부품 · 코드 · 대소문자 무시) · 등급 거르기 · 머리 글(일부만 읽음)', () => {
    const rows = [{ sev: 'critical', msg: 'PSU 2 lost', sensor: 'Power Supply', code: 'PSU0003' }, { sev: 'ok', msg: 'restored', sensor: 'Power Supply', code: 'PSU0001' }, { sev: 'warning', msg: 'Drive 4', sensor: 'Drive Slot', code: 'PDR1016' }];
    expect(filterHwLog(rows, { q: 'power' }).length).toBe(2);
    expect(filterHwLog(rows, { q: 'pdr1016' }).length).toBe(1);
    expect(filterHwLog(rows, { sev: 'critical' }).map((r) => r.code)).toEqual(['PSU0003']);
    expect(filterHwLog(rows, { q: 'x'.repeat(500) }).length).toBe(0);
    expect(hwLogHead({ rows: [1, 2], read: 1000, total: 1500, stopped: 'max' })).toBe('최근 2건 · 읽은 1000건 · 장비 전체 1500건 — 읽을 쪽 수 상한에 닿아 일부만 읽었습니다(장비가 정렬을 알려 주지 않으면 가장 새 기록이 빠졌을 수 있습니다).');
    expect(hwLogHead({ rows: [1], read: 1, total: 1, stopped: '' })).toBe('최근 1건 · 읽은 1건');
    expect(hwLogHead({ why: 'esxi' })).toBe('');
    expect(Object.keys(HWLOG_WHY)).toEqual(['esxi', 'no-source', 'old-version', 'not-found', 'edge-fail']);
    expect(HWLOG_STATUS.auth).toContain('자동으로 다시 시도하지 않습니다');
  });
  it('케이스 상태 · 권고 — 표가 비면 대조하지 않음(걸린 것 없음이 아니다) · 못 읽음 · 걸림(심각도 색)', () => {
    expect(['open', 'parts', 'replaced', 'closed', 'evil'].map(caseStatusText)).toEqual(['접수', '부품 오는 중', '교체함', '끝남', '모름']);
    expect(advisoryView({ state: 'no-table' }).badge.label).toBe('대조 안 함');
    expect(advisoryView({ state: 'no-table' }).why).toContain('인터넷에서 가져오지 않습니다');
    expect(advisoryView({ state: 'no-fw' }).badge.label).toBe('판정 안 함');
    expect(advisoryView(null, { unreadable: true }).badge.label).toBe('표 못 읽음');
    expect(advisoryView({ state: 'clear', checked: 3, unknown: 1 }).why).toBe('올라온 권고 표와 견줬고 걸린 것이 없습니다(견준 줄 2개). 맞는 권고 줄 가운데 1개는 순서를 정할 수 없어(숫자 꼴이 아닌 버전 · 서버 안에서 버전이 섞인 구성요소) 따로 셉니다.');
    // 맞는 줄이 없음 · 모두 모름은 ‘걸린 권고 없음’ 이 아니다(반증 B2)
    expect(advisoryView({ state: 'unmatched', checked: 0 }).badge.label).toBe('해당 권고 없음');
    expect(advisoryView({ state: 'unmatched', checked: 0 }).why).toContain('안전하다는 뜻이 아닙니다');
    expect(advisoryView({ state: 'unknown', checked: 2, unknown: 2 }).badge.label).toBe('판정 못 함');
    // 걸린 수는 자르기 전 수(반증 A7)
    const many = advisoryView({ state: 'hit', total: 80, hits: Array.from({ length: 50 }, (_, i) => ({ id: `Z${i}`, sev: 'low' })) });
    expect([many.badge.label, many.why]).toEqual(['권고 80건', '설치 버전이 권고의 고친 버전보다 낮습니다. 앞 50건만 보입니다.']);
    const hit = advisoryView({ state: 'hit', hits: [{ id: 'SYN-1', sev: 'critical', label: 'BIOS', installed: '2.19.1', fixed: '2.20.0' }], unknown: 0 });
    expect([hit.badge.label, hit.badge.color, hit.rows[0].sevLabel]).toEqual(['권고 1건', 'red', '위험']);
    expect(advisoryView({ state: 'hit', hits: [{ id: 'A', sev: 'low' }] }).badge.color).toBe('amber');
    expect(advisoryView({ state: 'hit', hits: [{ id: 'A', sev: 'high' }] }).badge.color).toBe('red', '높음도 빨강');
    expect(advisoryView({ state: 'clear', checked: 1 }).badge.color).toBe('gray', '걸린 것 없음은 초록(안전)으로 칠하지 않는다');
  });
});

describe('v3.49 반증 반영 — 순수', () => {
  it('권고 표 창 적용 단추 — 검증 전 · 오류 행 · 0줄(표 비우기) · 바쁨 · CSV 권한', () => {
    expect(ledgerApplyState({ checked: false, rows: 3 })).toMatchObject({ disabled: true, label: '적용' });
    expect(ledgerApplyState({ checked: true, errors: 1, rows: 3 })).toMatchObject({ disabled: true, title: '오류 행을 고친 뒤 다시 검증하십시오' });
    expect(ledgerApplyState({ checked: true, errors: 0, rows: 3 })).toMatchObject({ disabled: false, label: '적용', empty: false });
    expect(ledgerApplyState({ checked: true, errors: 0, rows: 0 })).toMatchObject({ disabled: false, label: '표 비우기', empty: true });
    expect(ledgerApplyState({ checked: true, rows: 3, busy: true }).disabled).toBe(true);
    expect(ledgerApplyState({ checked: true, rows: 3, csvOk: false }).disabled).toBe(true);
    const adv = read('./AdvisoryLedger.jsx');
    expect(adv).toMatch(/disabled=\{ap\.disabled\}/); expect(adv).toMatch(/if \(!dryRun\) setRes\(null\)/);
    expect(adv).toMatch(/expect: res\?\.base/);
  });
  it('목록 보안 권고 칩 — 표가 있을 때만 · 걸린 서버 수 · 빠른 거르기', () => {
    const rows = [{ kind: 'bm', chk: { adva: 'hit' } }, { kind: 'bm', chk: { adva: 'clear' } }, { kind: 'bm', chk: { adva: 'unknown' } }, { kind: 'esxi', chk: {} }];
    expect(chkChips(chkCounts(rows)).find((x) => x[0] === 'adv:hit')?.slice(0, 3)).toEqual(['adv:hit', '보안 권고', 1]);
    expect(chkChips(chkCounts([{ kind: 'bm', chk: { adva: 'no-table' } }])).some((x) => x[0] === 'adv:hit')).toBe(false);
    expect(CHK_QUICK).toContain('adv:hit');
    expect([chkQuickMatch(rows[0], 'adv:hit'), chkQuickMatch(rows[1], 'adv:hit')]).toEqual([true, false]);
  });
  it('보증 감점 줄은 상태로 끝남 · 곧 끝남을 가른다 · 점수 없음(부족) 칸 설명 · 문구에 다음 판 약속 · 숫자 주기 없음', () => {
    expect(healthItemText(['warranty', 3, null, 'soon'])).toBe('−3 보증 곧 끝남');
    expect(healthItemText(['warranty', 10, null, 'expired'])).toBe('−10 보증 끝남');
    expect(healthCell({ b: 'none', u: 3, few: 1, z: [['fault']] }).title).toBe('견준 항목이 1개뿐이라 점수를 내지 않았습니다 — 못 읽은 항목 3개.');
    expect(healthCell({ b: 'constructor', s: 90 }).band).toBe('none');
    expect(LED_NOTE).not.toMatch(/다음 판|웹 화면/);
    expect(HWLOG_SCOPE_NOTE).not.toMatch(/\d+\s*분/);
    expect(hwLogHead({ rows: [{}], read: 1000, total: 1024, gap: 24, stopped: '' })).toContain('가운데 24건은 읽지 않음');
    expect(hwLogHead({ rows: [], read: 0, stopped: 'constructor' })).toBe('최근 0건 · 읽은 0건');
    expect(HWLOG_STATUS['auth-stopped']).toContain('장비에 묻지 않았습니다');
    expect(healthView({ hs: { s: 100, b: 'ok', u: 0, uk: [], z: [['fw', 'differ']] } }).judged).toEqual(['0 펌웨어(기준과 다르나 순서를 몰라 감점하지 않음)']);
  });
});

describe('구역 렌더', () => {
  const R = { key: 'st:SYNTH01', kind: 'bm', name: 'synth-db-01', faults: 1, chk: { w: 'ok', fw: 'ok', bios: 'ok' }, hs: { s: 88, b: 'warn', u: 0, uk: [], d: [['fault', 12, 1]], z: [['warranty', 'ok'], ['fw', 'ok'], ['bios', 'ok']] } };
  it('건강 점수 — 점수 · 단계 · 감점 사유 · 규칙', async () => {
    const { HealthSection } = await import('./OpsSections.jsx');
    const t = text(renderToStaticMarkup(React.createElement(HealthSection, { r: R, rules: RULES })));
    expect(t).toContain('건강 점수 88 · 주의'); expect(t).toContain('−12 부품 장애 1건'); expect(t).toContain('0 보증 안'); expect(t).toContain('부품 장애 건당 12');
    expect(renderToStaticMarkup(React.createElement(HealthSection, { r: { ...R, hs: undefined } }))).toBe('');
    expect(t).toContain('보안 권고는 점수에 넣지 않고');
    // 나쁨 · 못 읽은 항목 줄 · 점수 없음(부족) 안내 — 반증 B17 의 생존 변이(드머리 나쁨→양호 · 못 읽음 줄 삭제)
    const bad = text(renderToStaticMarkup(React.createElement(HealthSection, { r: { ...R, hs: { s: 34, b: 'bad', u: 1, uk: ['bios'], d: [['fault', 36, 3], ['warranty', 10, null, 'expired'], ['fw', 12, 4]], z: [] } }, rules: RULES })));
    expect(bad).toContain('건강 점수 34 · 나쁨'); expect(bad).toContain('−10 보증 끝남'); expect(bad).toContain('못 읽어서 점수에 넣지 않은 것: BIOS 설정(미분류 · 못 읽음)');
    const few = text(renderToStaticMarkup(React.createElement(HealthSection, { r: { ...R, hs: { b: 'none', u: 3, uk: ['warranty', 'fw', 'bios'], few: 1, z: [['fault']] } }, rules: { ...RULES, min: { judged: 2, share: 0.5 } } })));
    expect(few).toContain('건강 점수 판정 못 함'); expect(few).toContain('견준 항목이 부족해 점수를 내지 않았습니다'); expect(few).toContain('0 부품 장애 없음');
    expect(few).toContain('견준 항목이 2개 미만이거나 볼 항목의 절반 미만이면 점수를 내지 않습니다');
  });
  it('이벤트 로그 — 처음에는 읽지 않고 단추 · 읽는 범위 안내 · ESXi 행은 단추 없음', async () => {
    const { HwLogSection } = await import('./OpsSections.jsx');
    const html = renderToStaticMarkup(React.createElement(HwLogSection, { r: R }));
    expect(text(html)).toContain('기록 읽기'); expect(text(html)).toContain('시스템 이벤트 로그(SEL)만 읽습니다');
    expect(html).not.toContain('<table');
    const esxi = renderToStaticMarkup(React.createElement(HwLogSection, { r: { ...R, kind: 'esxi' } }));
    expect(esxi).not.toContain('<button'); expect(text(esxi)).toContain(HWLOG_WHY.esxi);
  });
  it('케이스 — 읽는 중 · 접수 자료 받기 단추 · 접수하지 않는다는 안내 · ESXi 행은 그리지 않음', async () => {
    const { CaseSection } = await import('./OpsSections.jsx');
    const t = text(renderToStaticMarkup(React.createElement(CaseSection, { r: R })));
    expect(t).toContain('접수 자료 받기'); expect(t).toContain('포탈은 제조사에 직접 접수하지 않습니다'); expect(t).toContain('읽는 중');
    expect(renderToStaticMarkup(React.createElement(CaseSection, { r: { ...R, kind: 'esxi' } }))).toBe('');
    // 응답별 — 쓰기 못 하는 계정에는 적기 칸 · 고치기 단추가 없다(반증 B17) · 끝난 케이스에만 지우기 · 단추는 시각 칸 아래 줄(반증 B4)
    const cases = [{ id: 'c-1', part: '디스크 Bay 4', caseNo: 'SR-1', status: 'closed', at: 1, by: 'oper1' }, { id: 'c-2', part: 'PSU 2', caseNo: '', status: 'open', at: 2, by: 'oper1' }];
    const ro = renderToStaticMarkup(React.createElement(CaseSection, { r: R, initial: { ok: true, cases, canWrite: false, statuses: ['open', 'parts', 'replaced', 'closed'] } }));
    expect(ro).not.toContain('aria-label="부품"'); expect(text(ro)).not.toContain('고치기'); expect(text(ro)).toContain('이 법인의 쓰기 권한');
    const rw = renderToStaticMarkup(React.createElement(CaseSection, { r: R, initial: { ok: true, cases, canWrite: true, statuses: ['open', 'parts', 'replaced', 'closed'] } }));
    expect(rw).toContain('aria-label="부품"'); expect((rw.match(/>고치기</g) || []).length).toBe(2); expect((rw.match(/>지우기</g) || []).length).toBe(1);
    expect(rw).toContain('class="bmd-case-acts"'); expect((rw.match(/<th[\s>]/g) || []).length).toBe(3);
    expect(text(renderToStaticMarkup(React.createElement(CaseSection, { r: R, initial: { ok: true, why: 'no-tag', cases: [] } })))).toContain('서비스 태그를 모르는 서버');
  });
  it('이벤트 로그 응답별 — 일부만 읽은 오류(행 있음)에는 ‘못 읽었습니다’ 를 덧붙이지 않는다 · 건너뛴 수 · 인증 정지', async () => {
    const { HwLogSection } = await import('./OpsSections.jsx');
    const rows = [{ at: 2, sev: 'critical', code: 'C1', sensor: 'Sys', msg: 'evt' }];
    const part = text(renderToStaticMarkup(React.createElement(HwLogSection, { r: R, initial: { ok: true, via: 'local', status: 'error', read: 1, total: 1024, gap: 24, stopped: 'error', counts: { critical: 1, warning: 0, ok: 0, other: 0 }, rows } })));
    expect(part).not.toContain(HWLOG_STATUS.error); expect(part).toContain('가운데 24건은 읽지 않음'); expect(part).toContain('도중에 오류가 나 일부만 읽었습니다');
    const stop = text(renderToStaticMarkup(React.createElement(HwLogSection, { r: R, initial: { ok: true, via: 'local', status: 'auth-stopped', rows: [] } })));
    expect(stop).toContain('장비에 묻지 않았습니다');
  });
  it('보안 권고 — 걸림 표(링크는 새 탭 · noopener) · 비었으면 대조 안 함 · 읽는 중에는 그리지 않음', async () => {
    const { AdvisorySection } = await import('./OpsSections.jsx');
    const hit = renderToStaticMarkup(React.createElement(AdvisorySection, { r: R, chk: { d: { adv: { state: 'hit', hits: [{ id: 'SYN-1', sev: 'high', label: 'BIOS', installed: '2.19.1', fixed: '2.20.0', url: 'https://example.test/a' }], unknown: 0 } } } }));
    expect(hit).toContain('href="https://example.test/a"'); expect(hit).toContain('rel="noreferrer noopener"'); expect(text(hit)).toContain('권고 1건');
    expect(text(renderToStaticMarkup(React.createElement(AdvisorySection, { r: R, chk: { d: { adv: { state: 'no-table' } } } })))).toContain('대조 안 함');
    expect(renderToStaticMarkup(React.createElement(AdvisorySection, { r: R, chk: { d: null } }))).toBe('');
  });
});

describe('소스 스윕', () => {
  it('드로어에 운영 구역이 붙는다 · 이벤트 로그 · 케이스는 서버 키로 새로 만든다(늦은 응답이 다른 서버에 남지 않게) · 목록에 건강 점수 열 · 권고 표 단추는 canFleet', () => {
    const dr = read('./BmDrawer.jsx');
    expect(dr).toMatch(/afterGlance=\{<HealthSection r=\{r\} rules=\{healthRules\} \/>\}/);
    expect(dr).toMatch(/<HwLogSection key=\{`hl:\$\{r\.key\}`\} r=\{r\} \/>/);
    expect(dr).toMatch(/<CaseSection key=\{`cs:\$\{r\.key\}`\} r=\{r\} \/>/);
    expect(dr).toMatch(/<AdvisorySection r=\{r\} chk=\{chk\} \/>/);
    expect(dr).toMatch(/ledText\(det\?\.idrac\?\.led \?\? d\.led \?\? ''\)/);
    const list = read('../BmFolders.jsx');
    expect(list).toMatch(/>부품 장애 · 건강<\/th>/); expect(list).toMatch(/<div className="bmf-hs-row">/); expect(list).toMatch(/d\.canFleet \? <button[^>]*onClick=\{\(\) => setAdvLedger\(true\)\}/);
    expect(list).toMatch(/healthRules=\{d\.check\?\.health\?\.rules \? \{ \.\.\.d\.check\.health\.rules, min: d\.check\.health\.min \|\| null \} : null\}/);
    // 목록 칸의 ‘못 읽음 N’ · 400px 카드 건강 배지(반증 B13 · B17)
    expect(list).toMatch(/h\.unknown \? <span className="muted bmf-hs-u">못 읽음 \{h\.unknown\}<\/span>/);
    expect(list).toMatch(/h && h\.score != null \? <span className="l2" title=\{h\.title\}><span className=\{`badge \$\{h\.color\}`\}>건강 \{h\.label\}<\/span>/);
    // 이벤트 로그 요청은 서버 시한보다 길게 · 다시 보내지 않는다(반증 B10) · 접수 자료 파일 이름은 서버가 정한다(반증 B15)
    const ops = read('./OpsSections.jsx');
    expect(ops).toMatch(/fetchJson\('\/tools\/bm-folders\/hwlog', \{ key: r\.key \}, undefined, \{ timeoutMs: 60_000, retries: 0 \}\)/);
    expect(ops).toMatch(/downloadFile\(`\/tools\/bm-folders\/case-bundle\?key=\$\{encodeURIComponent\(r\.key\)\}`\)\.catch/);
    expect(ops).toMatch(/form\.id \? '고친 내용을 저장했습니다\.' : '케이스를 적었습니다\.'/);
    expect(ops).toMatch(/scrollIntoView/);
    // 클릭 · effect 가 도는 부분(SSR 시험이 그려 볼 수 없는 것)은 소스로 고정 — 거르기 · 늦은 응답 버림 · 연타 잠금 · 저장 · 지우기 뒤 다시 읽기
    expect(ops).toMatch(/filterHwLog\(d\.rows, \{ q, sev \}\)/);
    expect(ops).toMatch(/if \(alive\) setSt\(\{ d: x, err: '' \}\)/);
    expect(ops).toMatch(/disabled=\{st\.busy\} onClick=\{read\}/);
    expect((ops.match(/setRev\(\(n\) => n \+ 1\)/g) || []).length).toBe(2);
  });
  it('이벤트 로그는 열 때 읽지 않는다(단추) · 문구에 백틱 없음 · 대문자 변환 없음', () => {
    const ops = read('./OpsSections.jsx'); const txt = read('./opsText.js'); const adv = read('./AdvisoryLedger.jsx');
    const hl = ops.slice(ops.indexOf('export function HwLogSection'), ops.indexOf('export function CaseSection'));
    expect(hl).not.toMatch(/useEffect/); expect(hl).toMatch(/onClick=\{read\}/);
    for (const s of [ops, txt, adv]) {
      expect(s).not.toMatch(/text-transform/);
      for (const q of s.match(/'[^'\n]*'/g) || []) if (/[가-힣]/.test(q)) expect(q.slice(1, -1)).not.toContain('`');
      for (const j of s.match(/>[^<>{}\n]*[가-힣][^<>{}\n]*</g) || []) expect(j).not.toContain('`');
    }
  });
});

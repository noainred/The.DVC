// v3.45 물리서버 점검 글자 · 배치(checkText.js — 시안 docs/design/bm-feature-proposals ① ② ③). 판정은 서버(bmcheck)가 하고 여기는 상태 코드를 줄로 옮긴다:
//   못 읽은 것 · 판정하지 않은 것은 정상에도 문제에도 넣지 않고 따로 센다 · ‘뒤처짐’ ‘다수 값’ 이 옳고 그름이 아니라는 말을 화면에 쓴다.
import { describe, it, expect } from 'vitest';
import {
  daysText, monthsText, chkQuickMatch, CHK_QUICK, chkCounts, chkChips, chkAsideText, chkNotices, chkSignals, warrantyView, fwView, biosView, biosLabel,
  importSummaryText, importRowNote, IMPORT_ACTION, WTY_TEXT, FW_TEXT, FW_ROW_TEXT, BIOS_TEXT, BIOS_ROW_TEXT,
} from './checkText.js';
import { filterRows, cleanView } from '../bmFoldersText.js';
import { bmSignalRows, noSignalText } from './drawerText.js';

const row = (chk, o = {}) => ({ key: 'k', kind: 'bm', name: 'n', cpu: 10, mem: 10, powered: true, faults: 0, chk, ...o });

describe('날짜 글자', () => {
  it('남은 일수 — 남음 · 오늘 · 지남 · 모르면 빈 글자(0 을 지어내지 않는다)', () => {
    expect(daysText(108)).toBe('108일 남음'); expect(daysText(0)).toBe('오늘 끝남'); expect(daysText(-12)).toBe('12일 지남');
    expect(daysText(null)).toBe(''); expect(daysText('')).toBe(''); expect(daysText(undefined)).toBe('');
  });
  it('사용 기간 — 년 · 개월', () => {
    expect(monthsText(56)).toBe('4년 8개월'); expect(monthsText(8)).toBe('8개월'); expect(monthsText(24)).toBe('2년'); expect(monthsText(0)).toBe('1개월 미만');
    expect(monthsText(null)).toBe(''); expect(monthsText(-1)).toBe(''); expect(monthsText('')).toBe('');
  });
});

describe('목록 — 거르기 · 요약', () => {
  const rows = [
    row({ w: 'expired', wd: -3, fw: 'behind', fwn: 2, bios: 'diff', biosn: 1 }, { key: 'a' }), row({ w: 'soon', wd: 30, fw: 'ok', bios: 'ok' }, { key: 'b' }),
    row({ w: 'unknown', fw: 'unread', bios: 'unplaced' }, { key: 'c' }), row({ w: 'ok', wd: 400, fw: 'unsent', bios: 'unsent' }, { key: 'd' }),
    row({ w: 'ok', wd: 500, fw: 'none', bios: 'none' }, { key: 'e' }), row(undefined, { key: 'f' }), row({ w: 'unknown' }, { key: 'g', kind: 'esxi' }),
  ];
  it('빠른 거르기 — 그 상태의 행만 · 점검 열쇠가 아니면 관여하지 않는다', () => {
    expect(filterRows(rows, '', 'wty:expired').map((r) => r.key)).toEqual(['a']);
    expect(filterRows(rows, '', 'wty:soon').map((r) => r.key)).toEqual(['b']);
    expect(filterRows(rows, '', 'wty:unknown').map((r) => r.key)).toEqual(['c', 'g']);
    expect(filterRows(rows, '', 'fw:behind').map((r) => r.key)).toEqual(['a']);
    expect(filterRows(rows, '', 'bios:diff').map((r) => r.key)).toEqual(['a']);
    expect(filterRows(rows, '', '').length).toBe(7);
    expect(chkQuickMatch(rows[0], 'fault')).toBeNull(); expect(chkQuickMatch(rows[0], '')).toBeNull();
    expect(chkQuickMatch({}, 'wty:unknown')).toBe(false); expect(chkQuickMatch(null, 'fw:behind')).toBe(false);   // 판정 키가 없는 행은 모름으로 세지 않는다
  });
  it('저장한 보기는 점검 거르기를 기억한다(모르는 값은 버린다)', () => {
    for (const q of CHK_QUICK) expect(cleanView({ name: 'v', state: { quick: q } }).state.quick).toBe(q);
    expect(cleanView({ name: 'v', state: { quick: 'wty:evil' } }).state.quick).toBe('');
  });
  it('요약 — 판정 키가 없는 행은 na 로 따로(정상에 넣지 않는다) · 펌웨어 · BIOS 는 베어메탈만', () => {
    const c = chkCounts(rows);
    expect(c.n).toBe(7); expect(c.bm).toBe(6);
    expect(c.w).toEqual({ expired: 1, soon: 1, ok: 2, unknown: 2, na: 1 });
    expect(c.fw).toEqual({ behind: 1, ok: 1, split: 0, none: 1, unread: 1, unsent: 1, na: 1 });
    expect(c.bios).toEqual({ diff: 1, ok: 1, split: 0, none: 1, unread: 0, unsent: 1, unplaced: 1, na: 1 });
    // 갈림(split)은 뒤처짐 · 다름에도, 정상에도 넣지 않고 따로 센다
    const sp = chkCounts([row({ w: 'ok', fw: 'split', bios: 'split' }), row({ w: 'ok', fw: 'ok', bios: 'ok' })]);
    expect([sp.fw.split, sp.fw.ok, sp.fw.behind, sp.bios.split, sp.bios.ok, sp.bios.diff]).toEqual([1, 1, 0, 1, 1, 0]);
    expect(chkAsideText(sp)).toBe('펌웨어 갈림(판정 못 함) 1 / BIOS 갈림(다수 없음) 1');
    expect(filterRows([row({ fw: 'split', bios: 'split' })], '', 'fw:behind')).toEqual([]);   // 갈림은 뒤처짐 거르기에 잡히지 않는다
    expect(chkCounts(null)).toMatchObject({ n: 0, bm: 0 });
    // 상태 글자 'na' 가 서버에서 와도 그 칸을 올리지 않는다(자기 이름과 겹치는 값)
    expect(chkCounts([row({ w: 'na', fw: 'na', bios: 'na' })]).w).toEqual({ expired: 0, soon: 0, ok: 0, unknown: 0, na: 1 });
  });
  it('칩 — 개수가 0 이어도 보이고(0 이 정보다) 판정이 아예 없으면 뺀다 · 기준 일수는 서버 값', () => {
    const chips = chkChips(chkCounts(rows), 90);
    expect(chips.map((x) => [x[0], x[1], x[2]])).toEqual([['wty:expired', '보증 끝남', 1], ['wty:soon', '보증 곧 끝남', 1], ['wty:unknown', '보증 모름', 2], ['fw:behind', '펌웨어 뒤처짐', 1], ['bios:diff', 'BIOS 다름', 1]]);
    expect(chips[1][3]).toBe('보증 만료일까지 90일 이하로 남은 서버');
    expect(chkChips(chkCounts(rows), null)[1][3]).toBe('보증 만료일이 가까운 서버');   // 숫자를 화면에 박지 않는다
    expect(chkChips(chkCounts([row({ w: 'ok', fw: 'ok', bios: 'ok' })]), 90).map((x) => x[2])).toEqual([0, 0, 0, 0, 0]);
    expect(chkChips(chkCounts([row(undefined), row(undefined)]), 90)).toEqual([]);          // 판정 키가 하나도 없다(원장 · 찾기를 못 읽음)
    expect(chkChips(chkCounts([row({ w: 'unknown' }, { kind: 'esxi' })]), 90).map((x) => x[0])).toEqual(['wty:expired', 'wty:soon', 'wty:unknown']);   // ESXi 만 — 펌웨어 · BIOS 칩 없음
    expect(chkChips(chkCounts([]), 90)).toEqual([]);
  });
  it('따로 센 것 — 못 읽음 · 보내지 않음 · 기준 없음 · 미분류', () => {
    // BIOS ‘견줄 서버 없음’ 도 따로 센 것에 든다(반증 B8 — 펌웨어 기준 없음은 세는데 BIOS 는 빠져 판정되지 않은 서버가 어디에도 없었다)
    expect(chkAsideText(chkCounts(rows))).toBe('펌웨어 못 읽음 1 · 엣지에서 받지 못함 1 / 펌웨어 기준 없음 1 / BIOS 못 읽음 0 · 엣지에서 받지 못함 1 / BIOS 견줄 서버 없음 1 / BIOS 미분류(판정 안 함) 1');
    expect(chkAsideText(chkCounts([row({ w: 'ok', fw: 'ok', bios: 'ok' })]))).toBe('');
    expect(chkAsideText(null)).toBe('');
  });
  it('목록 안내 — 서버가 판정하지 않았다고 실어 준 표지를 글자로(칩이 사라질 뿐 아무 말이 없지 않게 — 반증 B5)', () => {
    expect(chkNotices({ soonDays: 90, assets: { n: 3, at: 1 } })).toEqual([]);
    expect(chkNotices({ assets: { unreadable: true } })).toEqual(['자산 원장 파일을 읽지 못해 보증을 판정하지 않았습니다 — 원장이 비었다는 뜻이 아닙니다(서비스 점검에서 확인).']);
    expect(chkNotices({ assets: {}, noHw: true, baselineUnreadable: true })).toEqual(['하드웨어 정보를 찾지 못해 펌웨어 · BIOS 를 판정하지 않았습니다.', '관리자 지정 펌웨어 기준 파일을 읽지 못해 다수 버전으로만 대조했습니다(서비스 점검에서 확인).']);
    expect(chkNotices(null)).toEqual([]); expect(chkNotices(undefined)).toEqual([]); expect(chkNotices('x')).toEqual([]);
  });
});

describe('드로어 신호', () => {
  it('보증 끝남(주의) · 곧 끝남 · 펌웨어 뒤처짐 · BIOS 다름 — 모름 · 못 읽음은 신호가 아니다', () => {
    const s = chkSignals(row({ w: 'expired', wd: -3, fw: 'behind', fwn: 2, bios: 'diff', biosn: 1 }));
    expect(s.map((x) => [x.kind, x.tone, x.badge])).toEqual([['wty', 'warn', '보증 끝남'], ['fw', 'info', '펌웨어 뒤처짐 2'], ['bios', 'info', 'BIOS 다름 1']]);
    expect(s[0].label).toBe('보증 끝남 — 3일 지남');
    expect(s[1].fact).toMatch(/올려야 한다는 판정은 아닙니다/); expect(s[2].fact).toMatch(/옳다는 뜻은 아닙니다/);
    expect(chkSignals(row({ w: 'soon', wd: 30 }))[0]).toMatchObject({ kind: 'wty', tone: 'info', badge: '보증 30일 남음', label: '보증 곧 끝남 — 30일 남음' });
    expect(chkSignals(row({ w: 'soon' }))[0].badge).toBe('보증 곧 끝남');
    expect(chkSignals(row({ w: 'unknown', fw: 'unread', bios: 'unplaced' }))).toEqual([]);
    expect(chkSignals(row({ w: 'ok', fw: 'ok', bios: 'ok' }))).toEqual([]);
    expect(chkSignals(row({ fw: 'none', bios: 'unsent' }))).toEqual([]);
    expect(chkSignals(row({ fw: 'split', bios: 'split' }))).toEqual([]);   // 갈림은 ‘판정하지 못함’ 이다 — 봐야 할 것으로 올리지 않는다(구역 · 따로 센 것 줄이 말한다)
    expect(chkSignals(row(undefined))).toEqual([]); expect(chkSignals(null)).toEqual([]);
    expect(new Set(s.map((x) => x.kind)).size).toBe(s.length);   // React key
  });
  it('드로어 신호 줄에 실린다 — 기존 신호 뒤에 · 신호 없음 문구는 판정이 선 것만 나열한다', () => {
    const r = row({ w: 'expired', wd: -1, fw: 'ok', bios: 'unplaced' }, { faults: 1 });
    expect(bmSignalRows(r).map((x) => x.kind)).toEqual(['fault', 'wty']);
    expect(noSignalText(row({ w: 'ok', fw: 'ok', bios: 'ok' }))).toBe('신호 없음 — 부품 장애 · 사용률 값 없음(CPU · 메모리 둘 다) · 전원 꺼짐 · 임시 키 · 보증 만료 · 펌웨어 뒤처짐 · BIOS 다름에 해당하는 것이 없습니다.');
    // 보증 모름 · 펌웨어 기준 없음 · BIOS 미분류는 '본 것' 이 아니다
    expect(noSignalText(row({ w: 'unknown', fw: 'none', bios: 'unplaced' }))).toBe('신호 없음 — 부품 장애 · 사용률 값 없음(CPU · 메모리 둘 다) · 전원 꺼짐 · 임시 키에 해당하는 것이 없습니다.');
    expect(noSignalText(row({ fw: 'unread', bios: 'unsent' }))).not.toMatch(/펌웨어|BIOS|보증/);
    expect(noSignalText(row({ w: 'ok', fw: 'split', bios: 'split' }))).toBe('신호 없음 — 부품 장애 · 사용률 값 없음(CPU · 메모리 둘 다) · 전원 꺼짐 · 임시 키 · 보증 만료에 해당하는 것이 없습니다.');
  });
});

describe('보증 · 계약 구역', () => {
  const W = { state: 'ok', end: '2027-03-14', daysLeft: 108, type: 'ProSupport', purchase: '2022-03-15', ageMonths: 56, contract: 'SYNTH-C1', eos: '2026-01-01', eosPassed: true, note: '비고' };
  it('값 줄 — 계약 번호 · 비고는 관리자 판본에만 줄이 있다(빈 칸으로도 보이지 않게)', () => {
    const v = warrantyView(W, { soonDays: 90, admin: true });
    expect(v.badge).toEqual({ label: '보증 안', color: 'green' }); expect(v.head).toBe('2027-03-14 · 108일 남음');
    expect(v.kv.map((x) => [x.label, x.value, x.sub || ''])).toEqual([['보증 만료', '2027-03-14', '108일 남음'], ['보증 종류', 'ProSupport', ''], ['구매일', '2022-03-15', ''], ['사용 기간', '4년 8개월', ''],
      ['유지보수 계약', 'SYNTH-C1', ''], ['지원 종료(제조사)', '2026-01-01', '지났습니다'], ['비고', '비고', '']]);
    const u = warrantyView({ ...W, contract: '', note: '' }, { soonDays: 90, admin: false });
    expect(u.kv.map((x) => x.label)).toEqual(['보증 만료', '보증 종류', '구매일', '사용 기간', '지원 종료(제조사)']);
  });
  it('없는 값은 — 로 · 모름은 이유를 쓴다(끝남에도 정상에도 넣지 않는다) · 곧 끝남의 기준 일수는 서버 값', () => {
    const none = warrantyView({ state: 'unknown', why: 'no-entry', end: '', daysLeft: null, type: '', purchase: '', ageMonths: null, contract: '', eos: '', eosPassed: null, note: '' }, { soonDays: 90, admin: true });
    expect(none.badge).toEqual({ label: '보증 모름', color: 'gray' }); expect(none.head).toBe('');
    expect(none.kv.filter((x) => x.label !== '비고').every((x) => x.value === '—' && x.dim)).toBe(true);
    expect(none.kv.some((x) => x.sub)).toBe(false);
    expect(none.note).toBe('자산 원장에 이 서버가 없습니다 — 끝남에도 정상에도 넣지 않습니다.');
    expect(warrantyView({ state: 'unknown', why: 'no-end', end: '', type: 'Basic' }, {}).note).toMatch(/보증 만료일이 없습니다/);
    expect(warrantyView({ state: 'soon', end: '2026-12-01', daysLeft: 5 }, { soonDays: 90 }).note).toBe('보증 만료일까지 90일 이하로 남으면 ‘곧 끝남’ 으로 봅니다.');
    expect(warrantyView({ state: 'soon', end: '2026-12-01', daysLeft: 5 }, {}).note).toBe('');
    expect(warrantyView({ state: 'expired', end: '2026-01-01', daysLeft: -300 }, {}).badge).toEqual({ label: '보증 끝남', color: 'red' });
    expect(warrantyView({ state: 'ok', end: '2030-01-01', daysLeft: 1000, eos: '2031-01-01', eosPassed: false }, {}).kv.find((x) => x.label === '지원 종료(제조사)').sub).toBe('');
  });
  it('원장을 못 읽었으면 판정하지 않았다고 쓴다(빈 원장 = 전부 모름으로 보이지 않게)', () => {
    const v = warrantyView(null, { unreadable: true });
    expect(v).toMatchObject({ state: 'na', badge: null, kv: [] }); expect(v.note).toMatch(/원장이 비었다는 뜻이 아닙니다/);
    expect(warrantyView({ state: 'ok', end: '2030-01-01' }, { unreadable: true }).state).toBe('na');
    expect(warrantyView(null, {}).note).toBe('보증 값을 받지 못했습니다.');
  });
});

describe('펌웨어 기준선 구역', () => {
  const FW = { state: 'behind', behind: 2, ahead: 1, judged: 4, skipped: 3, peers: 9, rows: [
    { key: 'BIOS|bios', type: 'BIOS', label: 'BIOS', installed: '2.19.1', mixed: false, baseline: '2.21.2', basis: 'majority', state: 'behind', peers: 7, known: 9 },
    { key: 'iDRAC|x', type: 'iDRAC', label: 'iDRAC', installed: '7.00.00.183', mixed: false, baseline: '7.00.00.171', basis: 'admin', state: 'ahead' },
    { key: 'PSU|p', type: 'PSU', label: 'PS1', installed: '00.1D.7D', mixed: false, baseline: '00.1D.7E', basis: 'majority', state: 'differ', peers: 5, known: 9 },
    { key: 'NIC|n', type: 'NIC', label: 'NIC', installed: null, mixed: true, baseline: null, basis: null, state: 'mixed' },
    { key: 'HBA|h', type: 'HBA', label: 'HBA', installed: '1.0', mixed: false, baseline: null, basis: null, state: 'none', tie: true },
  ] };
  it('줄 — 설치 · 기준 · 기준의 근거 · 상태(높은 것은 뒤처짐이 아니다)', () => {
    const v = fwView(FW);
    expect(v.badge).toEqual({ label: '뒤처짐 2', color: 'amber' }); expect(v.head).toBe('기준과 다른 구성요소 2개');
    expect(v.rows.map((x) => [x.label, x.installed, x.baseline, x.basis, x.stateText, x.badge])).toEqual([
      ['BIOS', '2.19.1', '2.21.2', '다수 버전 · 9대 중 7대', '뒤처짐', 'amber'], ['iDRAC', '7.00.00.183', '7.00.00.171', '관리자 지정', '기준보다 높음', 'blue'],
      ['PS1', '00.1D.7D', '00.1D.7E', '다수 버전 · 9대 중 5대', '다름', 'amber'], ['NIC', '섞임', '—', '기준 없음', '섞임', 'gray'], ['HBA', '1.0', '—', '버전이 갈림 — 다수 없음', '판정 안 함', 'gray']]);
    expect(v.note).toMatch(/올려야 한다는 판정이 아닙니다/); expect(v.note).toMatch(/펌웨어를 읽은 9대/); expect(v.note).toMatch(/3개는 대조하지 않습니다/);
    expect(v.rows[1].basisKind).toBe('admin'); expect(v.rows[0].raw).toBe(FW.rows[0]);
    expect(v.rows.map((x) => x.baseSub)).toEqual(['기준 2.21.2 · 다수 버전 · 9대 중 7대', '기준 7.00.00.171 · 관리자 지정', '기준 00.1D.7E · 다수 버전 · 9대 중 5대', '기준 없음', '버전이 갈림 — 다수 없음']);
    expect(fwView(FW, { baselineUnreadable: true }).note).toMatch(/다수 버전으로만 대조했습니다/);
    expect(fwView({ ...FW, state: 'ok', behind: 0 }).badge).toEqual({ label: '뒤처진 것 없음', color: 'green' });
  });
  it('못 읽음 · 보내지 않음 · 기준 없음은 이유를 쓰고 같음에도 뒤처짐에도 넣지 않는다', () => {
    const u = fwView({ state: 'unread', rows: [], behind: 0 });
    expect(u.badge).toEqual({ label: '못 읽음', color: 'gray' }); expect(u.rows).toEqual([]); expect(u.why).toMatch(/같음에도 뒤처짐에도 넣지 않습니다/); expect(u.note).toBe('');
    // ‘엣지가 보내지 않았다’ 고 단정하지 않는다 — 중앙이 그 엣지 이름을 확인하지 못해 받지 않은 경우도 같은 상태다(반증 A19)
    expect(fwView({ state: 'unsent', rows: [] }).why).toMatch(/엣지에서 펌웨어 목록을 받지 못했습니다\(엣지 판이 낮거나 · 그 엣지가 아직 읽지 못했거나 · 중앙이 그 엣지의 이름을 확인하지 못했습니다\)/);
    expect(fwView({ state: 'unsent', rows: [] }).badge).toEqual({ label: '엣지에서 받지 못함', color: 'gray' });
    // 갈림: 뒤처진 것 없음이라 하지 않는다 · 판정하지 못한 수를 쓴다(수가 없으면 수 없이)
    const sp = fwView({ state: 'split', behind: 0, open: 2, rows: [FW.rows[3], FW.rows[4]] });
    expect(sp.badge).toEqual({ label: '갈림 — 판정 못 함', color: 'gray' }); expect(sp.head).toBe('판정하지 못한 구성요소 2개');
    expect(sp.why).toBe('뒤처진 구성요소는 없지만, 같은 모델 서버끼리 버전이 갈려 다수가 없거나 이 서버 안에서 버전이 섞인 구성요소가 2개 있습니다 — ‘뒤처진 것 없음’ 으로 보지 않습니다.');
    // 수를 모르면 단위를 붙이지 않는다(값 없는 ‘—개’ 를 만들지 않는다 — 반증 B13)
    expect(fwView({ state: 'split', rows: [] }).why).toMatch(/구성요소가 있습니다/); expect(fwView({ state: 'split', rows: [] }).head).toBe('판정하지 못한 구성요소 있음');
    // 기준보다 높은 구성요소만 있으면 ‘다른 구성요소 없음’ 이라 하지 않는다(반증 B7)
    expect(fwView({ state: 'ok', behind: 0, ahead: 1, rows: [FW.rows[1]] }).head).toBe('뒤처진 것 없음 · 기준보다 높은 구성요소 1개');
    expect(fwView({ state: 'ok', behind: 0, ahead: 0, rows: [FW.rows[1]] }).head).toBe('기준과 다른 구성요소 없음');
    expect(fwView({ state: 'ok', behind: 0, rows: [FW.rows[1]] }).head).toBe('기준과 다른 구성요소 없음');
    // ‘기준 없음’ 의 이유는 상황마다(반증 B9): 대조하는 구성요소가 없다 · 같은 모델이 이 서버뿐이다 · 그 밖
    expect(fwView({ state: 'none', rows: [], peers: 3 }).why).toMatch(/대조하는 구성요소\(BIOS · iDRAC · NIC · 저장장치 컨트롤러 · HBA\)가 없습니다/);
    expect(fwView({ state: 'none', rows: [], peers: 3 }).why).not.toMatch(/관리자가 기준을 지정/);
    const lone = fwView({ state: 'none', rows: [FW.rows[4]], peers: 1 });
    expect(lone.why).toBe('같은 법인에 같은 모델 서버가 이 서버뿐이라 다수 버전이 없습니다 — 관리자가 기준을 지정하면 대조합니다.');
    expect(lone.note).not.toMatch(/1대로 냅니다/);   // 혼자인데 ‘다수 버전은 1대로 냅니다’ 라고 쓰지 않는다
    // 인벤토리 읽은 시각을 그대로 넘긴다(없으면 null — 0 으로 만들지 않는다)
    expect(fwView(FW, { invAt: 123 }).invAt).toBe(123); expect(fwView(FW, { invAt: '' }).invAt).toBeNull(); expect(fwView(FW).invAt).toBeNull(); expect(fwView(null, { invAt: 5 }).invAt).toBeNull();
    expect(fwView({ state: 'none', rows: [FW.rows[4]] }).why).toMatch(/대조할 기준이 없습니다/);
    expect(fwView(null).why).toBe('펌웨어 대조 값을 받지 못했습니다.'); expect(fwView(null, { noHw: true }).why).toMatch(/하드웨어 정보를 찾지 못해/);
    expect(fwView(null).badge).toBeNull();
  });
});

describe('BIOS 설정 편차 구역', () => {
  const B = { state: 'diff', diff: 2, group: { size: 9, known: 8 }, rows: [
    { k: 'BootMode', v: 'Uefi', major: 'Uefi', majorN: 8, known: 8, state: 'same' }, { k: 'SysProfile', v: 'PerfPerWattOptimizedDapc', major: 'PerfOptimized', majorN: 7, known: 8, state: 'diff' },
    { k: 'MemOpMode', v: null, major: 'OptimizerMode', majorN: 8, known: 8, state: 'unread' }, { k: 'ProcTurboMode', v: 'Enabled', major: 'Disabled', majorN: 7, known: 8, state: 'diff' },
    { k: 'SecureBoot', v: 'Enabled', major: null, majorN: 0, known: 8, state: 'tie' }, { k: 'UnknownKey', v: 'x', major: 'x', majorN: 8, known: 8, state: 'same' },
  ] };
  it('다른 설정이 먼저 — 다름 → 다수 없음 → 값 없음 → 같음(같은 것 안에서는 서버 순서)', () => {
    const v = biosView(B, { path: 'SVC\\DB', model: 'R750' });
    expect(v.badge).toEqual({ label: '다른 설정 2', color: 'amber' });
    expect(v.head).toBe('같은 폴더 · 같은 모델 9대(이 서버 포함) 중 설정을 읽은 8대로 견줌');
    expect(v.rows.map((x) => [x.label, x.value, x.major, x.majorSub, x.stateText])).toEqual([
      ['System Profile', 'PerfPerWattOptimizedDapc', 'PerfOptimized', '7대', '다름'], ['Turbo Mode', 'Enabled', 'Disabled', '7대', '다름'],
      ['Secure Boot', 'Enabled', '—', '', '다수 없음'], ['Memory Operating Mode', '—', 'OptimizerMode', '8대', '값 없음'],
      ['Boot Mode', 'Uefi', 'Uefi', '8대', '같음'], ['UnknownKey', 'x', 'x', '8대', '같음']]);
    expect(v.note).toBe('다수 값이 옳다는 뜻은 아닙니다 — 같은 일을 하는 서버끼리 다른 점만 보여 줍니다.');
    expect(v.rows.map((x) => x.majorText)).toEqual(['다수 PerfOptimized · 7대', '다수 Disabled · 7대', '다수 없음', '다수 OptimizerMode · 8대', '다수 Uefi · 8대', '다수 x · 8대']);
    expect(biosView({ ...B, group: { size: 9, known: 9 } }).head).toBe('같은 폴더 · 같은 모델 9대(이 서버 포함)를 견줌');
    expect(biosLabel('ProcVirtualization')).toBe('Virtualization Technology'); expect(biosLabel('Nope')).toBe('Nope'); expect(biosLabel(null)).toBe('');
  });
  it('미분류 · 못 읽음 · 보내지 않음 · 견줄 서버 없음은 이유를 쓴다', () => {
    const u = biosView({ state: 'unplaced', rows: [], diff: 0, group: { size: 0, known: 0 } });
    expect(u.badge).toEqual({ label: '미분류 — 판정 안 함', color: 'gray' }); expect(u.head).toBe(''); expect(u.why).toMatch(/폴더에 넣으면/); expect(u.note).toBe('');
    expect(biosView({ state: 'unread', rows: [], group: { size: 3, known: 2 } }).why).toMatch(/같음에도 다름에도 넣지 않습니다/);
    expect(biosView({ state: 'unsent', rows: [] }).why).toMatch(/엣지에서 BIOS 설정을 받지 못했습니다/);
    const sp = biosView({ state: 'split', diff: 0, open: 3, rows: [B.rows[0], B.rows[4]], group: { size: 2, known: 2 } });
    expect(sp.badge).toEqual({ label: '갈림 — 다수 없음', color: 'gray' }); expect(sp.why).toMatch(/‘다른 설정 없음’ 으로 보지 않습니다/);
    // 견주지 않은 상태 옆에 ‘N대와 견줌’ 이라 쓰지 않는다 · ‘견줄 서버 없음’ 의 이유는 묶음 크기 · 읽은 대수에 맞게(반증 B6)
    const alone = biosView({ state: 'none', rows: [B.rows[4]], group: { size: 1, known: 1 } });
    expect([alone.head, alone.why]).toEqual(['', '같은 폴더에 같은 모델 서버가 이 서버뿐입니다 — 2대 이상 있어야 견줍니다.']);
    const pair = biosView({ state: 'none', rows: [B.rows[4]], group: { size: 2, known: 1 } });
    expect([pair.head, pair.why]).toEqual(['', '같은 폴더 · 같은 모델의 다른 서버 BIOS 설정을 읽지 못해 견줄 값이 없습니다.']);
    expect(biosView({ state: 'none', rows: [], group: { size: 3, known: 3 } }).why).toMatch(/견줄 수 있는 설정이 없습니다/);
    expect(biosView({ state: 'unread', rows: [], group: { size: 2, known: 1 } }).head).toBe('');
    expect(biosView({ state: 'unsent', rows: [], group: { size: 2, known: 1 } }).head).toBe('');
    expect(biosView({ state: 'ok', rows: [B.rows[0]], diff: 0, group: { size: 2, known: 2 } }).badge).toEqual({ label: '다른 설정 없음', color: 'green' });
    expect(biosView(null).why).toBe('BIOS 설정 값을 받지 못했습니다.'); expect(biosView(null, { noHw: true }).why).toMatch(/하드웨어 정보를 찾지 못해/);
  });
});

describe('자산 원장 올리기 글자 · 상태 표', () => {
  it('요약 — 바꾸기일 때만 지움을 쓴다', () => {
    expect(importSummaryText({ add: 1, update: 2, same: 3, error: 4, remove: 5 })).toBe('더함 1 · 바꿈 2 · 같음 3 · 오류 4');
    expect(importSummaryText({ add: 1, update: 2, same: 3, error: 4, remove: 5 }, { replace: true })).toBe('더함 1 · 바꿈 2 · 같음 3 · 오류 4 · 지움 5');
    expect(importSummaryText(null)).toBe('');
    expect(Object.keys(IMPORT_ACTION)).toEqual(['add', 'update', 'same', 'error']);
  });
  it('결과 표의 사유 칸 — 오류 사유, 또는 바뀌는 칸(지워지는 칸은 그렇게 밝힌다)', () => {
    expect(importRowNote({ action: 'error', reason: '서비스 태그가 비어 있습니다.' })).toBe('서비스 태그가 비어 있습니다.');
    expect(importRowNote({ action: 'update', fields: ['보증 만료일', '계약 번호'], cleared: ['계약 번호'] })).toBe('바뀌는 칸: 보증 만료일 · 계약 번호(지움)');
    expect(importRowNote({ action: 'update', fields: ['비고'], cleared: [] })).toBe('바뀌는 칸: 비고');
    expect(importRowNote({ action: 'update' })).toBe(''); expect(importRowNote({ action: 'add' })).toBe(''); expect(importRowNote({ action: 'same', fields: ['x'] })).toBe(''); expect(importRowNote(null)).toBe('');
  });
  it('상태마다 글자와 배지 색이 있다(색만으로 가르지 않는다) · 문구에 백틱이 없다', () => {
    for (const t of [WTY_TEXT, FW_TEXT, FW_ROW_TEXT, BIOS_TEXT, BIOS_ROW_TEXT, IMPORT_ACTION]) for (const v of Object.values(t)) { expect(v.label).toBeTruthy(); expect(v.badge).toMatch(/^(red|amber|green|gray|blue)$/); expect(v.label).not.toContain('`'); }
    // 글자 함수가 **내놓는 글자 전부**에 백틱이 없다(이름표만 보면 설명 · 이유 문구는 보지 않는다 — 반증 T2)
    const out = JSON.stringify([
      chkChips(chkCounts([row({ w: 'ok', fw: 'ok', bios: 'ok' })]), 90), chkAsideText(chkCounts([row({ fw: 'unread', bios: 'unplaced' }), row({ fw: 'split', bios: 'split' }), row({ fw: 'none', bios: 'none' }), row({ fw: 'unsent', bios: 'unsent' })])),
      chkNotices({ assets: { unreadable: true }, noHw: true, baselineUnreadable: true }), chkSignals(row({ w: 'expired', wd: -1, fw: 'behind', fwn: 1, bios: 'diff', biosn: 1 })), chkSignals(row({ w: 'soon', wd: 3 })),
      ...['expired', 'soon', 'ok', 'unknown'].map((st) => warrantyView({ state: st, why: 'no-end', end: '2027-01-01', daysLeft: 3 }, { soonDays: 90, admin: true })), warrantyView(null, { unreadable: true }), warrantyView(null),
      ...['ok', 'behind', 'split', 'none', 'unread', 'unsent'].map((st) => fwView({ state: st, behind: 1, open: 1, peers: 3, skipped: 2, rows: [] }, { baselineUnreadable: true })), fwView(null), fwView(null, { noHw: true }),
      ...['ok', 'diff', 'split', 'none', 'unread', 'unsent', 'unplaced'].map((st) => biosView({ state: st, diff: 1, rows: [], group: { size: 3, known: 2 } })), biosView(null), biosView(null, { noHw: true }),
      importRowNote({ action: 'update', fields: ['a'], cleared: ['a'] }), importSummaryText({ add: 1, update: 1, same: 1, error: 1, remove: 1 }, { replace: true }),
    ]);
    expect(out).not.toContain('`'); expect(out.length).toBeGreaterThan(2000);
  });
});

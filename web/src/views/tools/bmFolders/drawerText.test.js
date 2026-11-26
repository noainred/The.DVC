// v3.44 — 물리서버 상세 드로어 글자 · 배치(drawerText.js · 시안 docs/design/bm-drawer). 판정은 서버가 하고 여기는 그 값을 줄로 옮길 뿐이다:
//   못 읽은 값은 0 이 아니다('—' · 단위 없음 · 정상에도 장애에도 넣지 않는다).
import { describe, it, expect } from 'vitest';
import {
  rowTone, rowDotTitle, noUsage, powerText, bmSignalRows, bmUnknowns, noSignalText, neighborOfKey, freshNote, bmTiles, bmKvRows, specCells, partGroups, trendView, tickText, orderRows,
  TMPKEY_NOTE, SIG_BADGE, SIG_DOT,
} from './drawerText.js';
import { whyOf } from './whyText.js';

const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR;   // 실제 시각에서 정시 경계로(고정 epoch · Date.now() 직접 둘 다 쓰지 않는다)
const row = (o = {}) => ({ key: 'st:AAA1111', kind: 'bm', corp: 'vc-kr2', name: 'SELSBPDPS09', serviceTag: 'AAA1111', model: 'PowerEdge R740xd', src: 'collector', agent: '수집 서버 KR2',
  path: 'KR2_Service\\SBP\\DP\\Airflow', place: 'manual', powered: true, cpu: 37, mem: 62, usrc: { cpu: 'os', mem: 'os' }, watts: 462, faults: 0, cores: 32, memGB: 512, ...o });

describe('상태 점 · 전원 글자', () => {
  it('장애 > 사용률 못 읽음 > 꺼짐 > 정상 순으로 한 가지만', () => {
    expect(rowTone(row())).toBe('green');
    expect(rowTone(row({ faults: 2, cpu: null, mem: null, powered: false }))).toBe('red');
    expect(rowTone(row({ cpu: null, mem: null, powered: false }))).toBe('none');
    expect(rowTone(row({ powered: false }))).toBe('gray');
  });
  it('못 읽은 부품 장애(null)는 장애가 아니다 · 한쪽 지표만 있어도 사용률은 있다', () => {
    expect(rowTone(row({ faults: null }))).toBe('green');
    expect(noUsage(row({ cpu: null }))).toBe(false);
    expect(noUsage(row({ cpu: null, mem: null }))).toBe(true);
    expect(noUsage(row({ cpu: 0, mem: null }))).toBe(false);   // 0 은 값이다
  });
  it('전원: true 켜짐 · false 꺼짐 · 그 밖은 모름(켜짐으로 치지 않는다)', () => {
    expect(powerText({ powered: true })).toBe('켜짐');
    expect(powerText({ powered: false })).toBe('꺼짐');
    expect(powerText({ powered: null })).toBe('모름');
    expect(powerText({})).toBe('모름');
    expect(powerText(null)).toBe('모름');
  });
});

describe('신호 줄 — 행에 이미 있는 값만', () => {
  it('아무 것도 해당하지 않으면 0줄 · 글자는 실제로 본 것만 나열한다', () => {
    expect(bmSignalRows(row())).toEqual([]);
    expect(noSignalText(row())).toBe('신호 없음 — 부품 장애 · 사용률 값 없음(CPU · 메모리 둘 다) · 전원 꺼짐 · 임시 키에 해당하는 것이 없습니다.');
    // 값이 없던 것(부품 장애 · 전원)을 '해당 없음' 이라고 하지 않는다(반증 A9)
    expect(noSignalText(row({ faults: null, powered: null }))).toBe('신호 없음 — 사용률 값 없음(CPU · 메모리 둘 다) · 임시 키에 해당하는 것이 없습니다.');
    expect(noSignalText(row({ faults: null }))).not.toMatch(/부품 장애/);
    expect(noSignalText(row({ powered: undefined }))).not.toMatch(/전원/);
    expect(noSignalText(row({ powered: false }))).toMatch(/전원 꺼짐/);   // 읽은 값이면 본 것이다
  });
  it('부품 장애 N건 — 건수와 바로가기', () => {
    const [s] = bmSignalRows(row({ faults: 3 }));
    expect(s).toMatchObject({ kind: 'fault', tone: 'crit', badge: '부품 장애 3건', link: ['#/tools/part-faults', '부품 장애'] });
  });
  it('값이 없는 것(부품 장애 · 전원)은 신호가 아니다 — 따로 밝힌다(구조적으로 비는 경로가 있다: ESXi 행 · 엣지 수집 · 기능 꺼짐)', () => {
    // 반증 A2: 서버마다 뜨는 '전원 모름' · '부품 장애 못 읽음' 줄이 봐야 할 것을 가렸고, '읽지 못했다' 는 단정이었다
    expect(bmSignalRows(row({ faults: null }))).toEqual([]);
    expect(bmSignalRows(row({ faults: undefined }))).toEqual([]);
    expect(bmSignalRows(row({ faults: '' }))).toEqual([]);          // '' 는 0 이 아니다
    expect(bmSignalRows(row({ powered: null }))).toEqual([]);
    expect(bmSignalRows(row({ powered: undefined }))).toEqual([]);
    expect(bmUnknowns(row())).toEqual([]);
    expect(bmUnknowns(row({ faults: 0 }))).toEqual([]);             // 0 은 읽은 값이다
    expect(bmUnknowns(row({ faults: null }))).toEqual(['부품 장애']);
    expect(bmUnknowns(row({ faults: '' }))).toEqual(['부품 장애']);
    expect(bmUnknowns(row({ powered: null }))).toEqual(['전원']);
    expect(bmUnknowns(row({ powered: undefined }))).toEqual(['전원']);
    expect(bmUnknowns(row({ powered: false }))).toEqual([]);        // 꺼짐은 읽은 값이다
    expect(bmUnknowns(row({ faults: undefined, powered: 'on' }))).toEqual(['부품 장애', '전원']);   // true/false 가 아니면 모름
    expect(bmUnknowns(null)).toEqual(['부품 장애', '전원']);
  });
  it('사용률 값 없음 — 서버 사유 코드의 글자(whyText)를 그대로 · 등급은 사유 분류', () => {
    const [s] = bmSignalRows(row({ cpu: null, mem: null, why: { code: 'edge-no-record' } }));
    const w = whyOf('edge-no-record');
    expect(s).toMatchObject({ kind: 'usage', tone: 'crit', label: `사용률 값 없음 — ${w.s}`, fact: w.l, desc: w.a });
    expect(s.badge).toBe('사용률 값 없음 · 엣지 값 없음');
    expect(bmSignalRows(row({ cpu: null, mem: null, why: { code: 'corp-off' } }))[0].tone).toBe('info');
    expect(bmSignalRows(row({ cpu: null, mem: null, why: { code: 'unknown' } }))[0].tone).toBe('none');
  });
  it('오래됨은 마지막 값 시각으로 얼마나 됐는지 배지에 붙는다', () => {
    const [s] = bmSignalRows(row({ cpu: null, mem: null, why: { code: 'stale', at: NOW - 2 * HOUR } }), NOW);
    expect(s.tone).toBe('warn');
    expect(s.badge).toBe('사용률 값 없음 · 오래됨 · 2시간 0분 전');
  });
  it('사유 코드를 받지 못했으면 원인을 단정하지 않는다', () => {
    const [s] = bmSignalRows(row({ cpu: null, mem: null }));
    expect(s).toMatchObject({ kind: 'usage', tone: 'none', label: '사용률 값 없음' });
    expect(s.fact).toMatch(/단정하지 않습니다/);
  });
  it('한쪽 지표라도 있으면 사용률 신호를 내지 않는다', () => {
    expect(bmSignalRows(row({ cpu: null, why: { code: 'stale' } }))).toEqual([]);
  });
  it('꺼진 서버: 전원 줄 하나만(꺼져 있음 사유를 두 줄로 쓰지 않는다)', () => {
    const s = bmSignalRows(row({ powered: false, cpu: null, mem: null, why: { code: 'powered-off' } }));
    expect(s.map((x) => x.kind)).toEqual(['off']);
    // 꺼졌는데 사유가 다른 것이면 둘 다 말한다
    expect(bmSignalRows(row({ powered: false, cpu: null, mem: null, why: { code: 'no-idrac' } })).map((x) => x.kind)).toEqual(['usage', 'off']);
    // 전원을 모르는데 사유가 '꺼져 있음' 이면 사유 줄을 지우지 않는다(전원 줄이 대신 말해 주지 못한다)
    expect(bmSignalRows(row({ powered: null, cpu: null, mem: null, why: { code: 'powered-off' } })).map((x) => x.kind)).toEqual(['usage']);
    expect(bmSignalRows(row({ powered: undefined, cpu: null, mem: null, why: { code: 'powered-off' } })).map((x) => x.kind)).toEqual(['usage']);
  });
  it('상태 점 설명은 그 서버의 사실 — 값이 없는 것을 켜짐 · 장애 없음이라고 하지 않는다', () => {
    expect(rowDotTitle(row())).toBe('전원 켜짐 · 부품 장애 없음');
    expect(rowDotTitle(row({ powered: null, faults: null }))).toBe('전원 모름 · 부품 장애 값 없음');
    expect(rowDotTitle(row({ powered: false, faults: 2 }))).toBe('전원 꺼짐 · 부품 장애 2건');
    expect(rowDotTitle(row({ cpu: null, mem: null }))).toBe('전원 켜짐 · 부품 장애 없음 · 사용률 값 없음');
    expect(rowDotTitle(row({ cpu: null }))).not.toMatch(/사용률/);   // 한쪽이라도 있으면 값이 있다
    expect(rowDotTitle(row({ faults: '' }))).toMatch(/부품 장애 값 없음/);
  });
  it('임시 키 — 표의 태그 없음 배지와 같은 설명', () => {
    const [s] = bmSignalRows(row({ tmpKey: true }));
    expect(s).toMatchObject({ kind: 'tmpkey', tone: 'info', fact: TMPKEY_NOTE });
  });
  it('여러 신호는 장애 → 사용률 → 전원 → 임시 키 순서 · kind 가 겹치지 않는다(React key)', () => {
    const s = bmSignalRows(row({ faults: 1, cpu: null, mem: null, why: { code: 'no-record' }, powered: false, tmpKey: true }));
    expect(s.map((x) => x.kind)).toEqual(['fault', 'usage', 'off', 'tmpkey']);
    expect(new Set(s.map((x) => x.kind)).size).toBe(s.length);
  });
  it('등급마다 배지 색 · 점 색이 정해져 있다(none 은 빈 원 — 색 없음)', () => {
    for (const t of ['crit', 'warn', 'info', 'none']) expect(SIG_BADGE[t]).toBeTruthy();
    expect(SIG_DOT.none).toBe('');
    expect(SIG_DOT.crit).toBe('var(--red)');
  });
});

describe('이웃(‹ › · ↑↓)', () => {
  const rows = [{ key: 'a' }, { key: 'b' }, { key: 'c' }];
  it('가운데 · 처음 · 끝', () => {
    expect(neighborOfKey(rows, 'b')).toMatchObject({ prev: { key: 'a' }, next: { key: 'c' }, index: 1, total: 3 });
    expect(neighborOfKey(rows, 'a')).toMatchObject({ prev: null, next: { key: 'b' }, index: 0 });
    expect(neighborOfKey(rows, 'c')).toMatchObject({ prev: { key: 'b' }, next: null, index: 2 });
  });
  it('목록에 없거나 목록이 없으면 잠긴다(index −1)', () => {
    expect(neighborOfKey(rows, 'x')).toEqual({ prev: null, next: null, index: -1, total: 3, gone: false });
    expect(neighborOfKey(null, 'a')).toEqual({ prev: null, next: null, index: -1, total: 0, gone: false });
    expect(neighborOfKey(rows, 'b').gone).toBe(false);
  });
  it('방금까지 있던 자리를 알면 목록에서 빠진 뒤에도 그 자리 앞뒤로 이어 간다(넣기 · 옮기기 · 빼기 뒤)', () => {
    // b 가 1번 자리에 있다가 빠졌다 → 남은 목록 [a, c]: 이전 = a · 다음 = c(빠진 자리에 올라온 서버)
    const left = [{ key: 'a' }, { key: 'c' }];
    expect(neighborOfKey(left, 'b', 1)).toEqual({ prev: { key: 'a' }, next: { key: 'c' }, index: -1, total: 2, gone: true });
    // 맨 앞에서 빠짐 → 이전 없음 · 다음 = 새 맨 앞
    expect(neighborOfKey([{ key: 'b' }, { key: 'c' }], 'a', 0)).toMatchObject({ prev: null, next: { key: 'b' }, gone: true });
    // 맨 끝에서 빠짐 → 다음 없음 · 이전 = 새 맨 끝
    expect(neighborOfKey([{ key: 'a' }, { key: 'b' }], 'c', 2)).toMatchObject({ prev: { key: 'b' }, next: null, gone: true });
    // 목록이 더 줄었으면(자리가 길이를 넘는다) 끝에 붙인다 — 범위 밖을 읽지 않는다
    expect(neighborOfKey([{ key: 'a' }], 'c', 7)).toMatchObject({ prev: { key: 'a' }, next: null, gone: true });
    expect(neighborOfKey([], 'c', 2)).toMatchObject({ prev: null, next: null, gone: true, total: 0 });
    // 자리를 모르면(−1 · 정수가 아님) 이어 가지 않는다
    expect(neighborOfKey(left, 'b', -1).gone).toBe(false);
    expect(neighborOfKey(left, 'b', 1.5)).toMatchObject({ prev: null, next: null, gone: false });
    expect(neighborOfKey(left, 'b', NaN).gone).toBe(false);
    // 목록에 있으면 옛 자리는 쓰지 않는다
    expect(neighborOfKey(rows, 'c', 0)).toMatchObject({ prev: { key: 'b' }, next: null, index: 2, gone: false });
  });
  it('표가 알려 준 순서로 다시 놓는다 — 순서에 없는 행(상한으로 잘림)은 빼고, 순서를 모르면 그대로', () => {
    expect(orderRows(rows, ['c', 'a']).map((x) => x.key)).toEqual(['c', 'a']);
    expect(orderRows(rows, ['c', 'zz', 'a']).map((x) => x.key)).toEqual(['c', 'a']);
    expect(orderRows(rows, null)).toBe(rows);
    expect(orderRows(rows, [])).toEqual([]);
    expect(orderRows(null, ['a'])).toEqual([]);
  });
});

describe('드로어 안 쓰기 결과 알림', () => {
  it('연 뒤 · 넘긴 뒤에 새로 온 알림만 — 그때 이미 있던 알림 · 글자 없는 알림은 그리지 않는다', () => {
    const old = { ok: true, text: '옮겼습니다' };
    const fail = { ok: false, text: '쓰기 권한이 없습니다' };
    expect(freshNote(old, old)).toBeNull();          // 열 때 이미 있던 것(이전 서버의 결과)
    expect(freshNote(fail, old)).toBe(fail);          // 그 뒤에 온 것
    expect(freshNote(fail, null)).toBe(fail);
    expect(freshNote(null, old)).toBeNull();
    expect(freshNote({ ok: false, text: '' }, old)).toBeNull();
    expect(freshNote({ ...old }, old)).toEqual(old);  // 글자가 같아도 새 객체면 새 결과다(같은 동작을 두 번)
  });
});

describe('타일 4장', () => {
  it('값 · 출처 · 용량', () => {
    const t = bmTiles(row({ hw: { cpu: { sockets: 2, cores: 32 } } }));
    expect(t.cpu).toEqual({ pct: 37, src: 'os', sub: '32코어 · 2×16C' });
    expect(t.mem).toEqual({ pct: 62, src: 'os', sub: '512 GB' });
    expect(t.power).toEqual({ watts: 462, sub: '전원 켜짐' });
    expect(t.fault).toEqual({ state: 'ok', n: 0 });
    expect(t.usage.cap).toBe('32코어 · 512 GB');
  });
  it('못 읽은 값은 null(0 이 아니다) · 출처 표지도 붙이지 않는다', () => {
    const t = bmTiles(row({ cpu: null, mem: '', watts: null, faults: null, cores: null, memGB: null, powered: null }));
    expect(t.cpu.pct).toBeNull(); expect(t.cpu.src).toBe(''); expect(t.cpu.sub).toBe('코어 수 모름');
    expect(t.mem.pct).toBeNull(); expect(t.mem.sub).toBe('용량 모름');
    expect(t.power).toEqual({ watts: null, sub: '전원 모름' });
    expect(t.fault).toEqual({ state: 'unread', n: null });
    expect(t.usage.cap).toBe('용량 모름');
  });
  it('0 은 값이다(0% · 0 W · 장애 0건)', () => {
    const t = bmTiles(row({ cpu: 0, mem: 0, watts: 0, faults: 0 }));
    expect(t.cpu.pct).toBe(0); expect(t.mem.pct).toBe(0); expect(t.power.watts).toBe(0); expect(t.fault.state).toBe('ok');
  });
  it('장애가 있으면 bad · 지표마다 출처를 모르는 행은 mixed', () => {
    expect(bmTiles(row({ faults: 2 })).fault).toEqual({ state: 'bad', n: 2 });
    expect(bmTiles(row({ usrc: { mixed: true } })).cpu.src).toBe('mixed');
    expect(bmTiles(row({ usrc: undefined })).cpu.src).toBe('');
  });
  it('소켓이 하나면 사양 글자가 코어 수와 같아 되풀이하지 않는다', () => {
    expect(bmTiles(row({ cores: 16, hw: { cpu: { sockets: 1, cores: 16 } } })).cpu.sub).toBe('16코어');
  });
  it('행에 용량이 없으면 같은 행의 iDRAC 요약으로 — 아래 하드웨어 요약은 32코어인데 타일만 모름이 되지 않게', () => {
    // 반증 A14: 사용률을 못 받은 서버(cores · memGB null)는 타일이 '코어 수 모름 · 용량 모름' 이었고 같은 화면 아래에는 값이 있었다
    const t = bmTiles(row({ cores: null, memGB: null, hw: { cpu: { sockets: 2, cores: 32 }, mem: { gib: 512, dimms: 8 } } }));
    expect(t.cpu.sub).toBe('32코어 · 2×16C');
    expect(t.mem.sub).toBe('512 GB');
    expect(t.usage.cap).toBe('32코어 · 512 GB');
    // 행 값이 있으면 행 값이 먼저다(사용률을 잰 쪽의 용량)
    const u = bmTiles(row({ cores: 24, memGB: 256, hw: { cpu: { sockets: 2, cores: 32 }, mem: { gib: 512 } } }));
    expect(u.cpu.sub).toMatch(/^24코어/);
    expect(u.mem.sub).toBe('256 GB');
    // 둘 다 없으면 모름(0 으로 쓰지 않는다)
    const n = bmTiles(row({ cores: '', memGB: '', hw: null }));
    expect(n.cpu.sub).toBe('코어 수 모름'); expect(n.mem.sub).toBe('용량 모름'); expect(n.usage.cap).toBe('용량 모름');
  });
});

describe('식별 · 배치 값 줄', () => {
  const corpName = (id) => ({ 'vc-kr2': 'KR2' }[id] || id);
  it('전체 범위 판본 — 서비스 태그 줄이 있다', () => {
    const kv = bmKvRows(row(), { corpName, scoped: false });
    expect(kv.map((x) => x.label)).toEqual(['법인', '종류', '폴더', '모델', '서비스 태그', '전원', '받는 길']);
    expect(kv[0].value).toBe('KR2');
    expect(kv[2]).toMatchObject({ value: 'KR2_Service › SBP › DP › Airflow', badge: '손 등록', full: true, note: '' });
    expect(kv[6]).toMatchObject({ src: 'collector', agent: '수집 서버 KR2' });
  });
  it('범위 계정 판본 — 서비스 태그 줄을 만들지 않는다(서버가 싣지 않은 값을 빈 칸으로도 보이지 않게)', () => {
    const kv = bmKvRows(row({ serviceTag: undefined, agent: undefined }), { corpName, scoped: true });
    expect(kv.map((x) => x.label)).not.toContain('서비스 태그');
    expect(kv.find((x) => x.label === '받는 길').agent).toBe('');
  });
  it('미분류 · 법인 미지정 · 자동 규칙 자리의 안내', () => {
    expect(bmKvRows(row({ place: null, path: '' })).find((x) => x.label === '폴더')).toMatchObject({ value: '(미분류)', note: '아직 폴더가 없습니다', badge: '' });
    const noCorp = bmKvRows(row({ corp: '', place: null, path: '' }));
    expect(noCorp[0].value).toBe('(미지정)');
    expect(noCorp.find((x) => x.label === '폴더').note).toBe('법인을 몰라 폴더에 넣을 수 없습니다');
    expect(bmKvRows(row({ place: 'rule' })).find((x) => x.label === '폴더')).toMatchObject({ badge: '자동 규칙', note: '규칙이 넣은 자리입니다(옮기면 손 등록이 됩니다)' });
  });
  it('ESXi 호스트 종류 · 값이 없는 모델은 — 로', () => {
    const kv = bmKvRows(row({ kind: 'esxi', model: '' }));
    expect(kv[1].value).toBe('ESXi 호스트');
    expect(kv.find((x) => x.label === '모델')).toMatchObject({ value: '—', muted: true });
  });
});

describe('하드웨어 요약 5칸', () => {
  const sum = { cpu: { sockets: 2, cores: 32, threads: 64 }, mem: { gib: 512, dimms: 8 }, disk: { n: 12, ssd: 0, hdd: 12, gb: 48000 }, nic: { ports: 8, speeds: [[10, 4]] }, hba: { n: 0 } };
  it('요약이 없으면 null(화면이 이유를 말한다)', () => {
    expect(specCells(null)).toBeNull();
    expect(specCells(undefined, { nics: [] })).toBeNull();
  });
  it('값이 다 있는 서버', () => {
    const c = specCells(sum, { nics: [{}, {}, {}] });
    expect(c.map((x) => x.k)).toEqual(['CPU', '메모리', '디스크', 'NIC', 'FC HBA']);
    expect(c[0]).toMatchObject({ v: '2×16C', s: '32코어 / 64스레드' });
    expect(c[1]).toMatchObject({ v: '512 GB', s: 'DIMM 8개' });
    expect(c[2]).toMatchObject({ v: '48 TB', s: 'HDD 12' });
    expect(c[3]).toMatchObject({ v: '10G×4', s: '어댑터 3' });
    expect(c[4]).toMatchObject({ v: '없음', s: '읽었고 0개', plain: true });
  });
  it('부품 목록이 없으면(엣지 요약만) NIC 아래 줄은 요약의 포트 수', () => {
    expect(specCells(sum)[3]).toMatchObject({ v: '10G×4', s: '8포트' });
    // 속도를 못 읽어 값 칸이 이미 포트 수면 아래 줄에 되풀이하지 않는다
    expect(specCells({ ...sum, nic: { ports: 4 } })[3]).toMatchObject({ v: '4포트', s: '' });
    expect(specCells({ ...sum, nic: { ports: 4 } }, { nics: [{}] })[3]).toMatchObject({ v: '4포트', s: '어댑터 1' });
  });
  it('속도 묶음이 여럿이면 값 칸에는 첫 묶음만 · 나머지는 아래 줄(칸 폭에서 잘리지 않게)', () => {
    const mixed = { ...sum, nic: { ports: 4, speeds: [[25, 2], [1, 2]] } };
    expect(specCells(mixed, { nics: [{}, {}] })[3]).toMatchObject({ v: '25G×2', s: '1G×2 · 어댑터 2' });
    expect(specCells(mixed)[3]).toMatchObject({ v: '25G×2', s: '1G×2 · 4포트' });
    // 형식이 아닌 속도 항목은 버린다(지어내지 않는다)
    expect(specCells({ ...sum, nic: { ports: 2, speeds: [[0, 2], ['x'], [10, null]] } })[3]).toMatchObject({ v: '2포트', s: '' });
  });
  it('못 읽은 칸은 — (읽었고 0개인 없음과 다르다)', () => {
    const c = specCells({ cpu: null, mem: null, disk: null, nic: null, hba: null });
    expect(c.map((x) => x.v)).toEqual(['—', '—', '—', '—', '—']);
    expect(c.every((x) => x.s === '')).toBe(true);
    expect(c.some((x) => x.plain)).toBe(false);
    expect(specCells({ ...sum, disk: { n: 0 } })[2]).toMatchObject({ v: '없음', s: '읽었고 0개', plain: true });
  });
  it('디스크 용량 합을 못 냈으면 개수 · FC 가 있으면 개수와 포트', () => {
    expect(specCells({ ...sum, disk: { n: 4, ssd: 2, hdd: 1, gb: null } })[2]).toMatchObject({ v: '4개', s: 'SSD 2 · HDD 1 · 기타 1' });
    expect(specCells({ ...sum, hba: { n: 2, ports: 4 } })[4]).toMatchObject({ v: 'FC 2', s: '4포트' });
    expect(specCells({ ...sum, hba: { n: 1 } })[4]).toMatchObject({ v: 'FC 1', s: '' });
  });
});

describe('부품 목록', () => {
  it('상세가 없으면 null', () => { expect(partGroups(null)).toBeNull(); });
  it('종류 6개 · 묶음 개수 · 모델 칸과 사양 칸', () => {
    const g = partGroups({
      cpus: [{ n: 2, model: 'Intel(R) Xeon(R) Gold 6246R CPU @ 3.40GHz', cores: 16, threads: 32, mhz: 4000 }],
      dimms: [{ n: 8, gb: 64, type: 'DDR4', mhz: 2933, maker: 'Micron Technology' }],
      disks: [{ n: 11, model: 'ST4000NM016A-2HZ', gb: 4000, media: 'HDD', proto: 'SATA' }, { n: 1, model: 'TOSHIBA MG04ACA4', gb: 4000, media: 'HDD', proto: 'SATA' }],
      ctrls: [{ n: 1, model: 'PERC H730P Adapter', fw: '25.5.9.0001' }, { n: 1, model: 'C620 Series Chipset Family SATA Controller [AHCI mode]', fw: '' }],
      nics: [{ model: 'BRCM GbE 4P 5720-t rNDC', ports: 4, up: 0, speeds: [] }, { model: 'Intel(R) 10GbE 2P X710 Adapter', ports: 2, up: 2, speeds: [10] }],
      hbas: [],
    });
    expect(g.map((x) => x.k)).toEqual(['CPU', '메모리(DIMM)', '디스크', '스토리지 컨트롤러', 'NIC', 'FC HBA']);
    expect(g[0].rows[0]).toEqual({ n: '2 ×', m: 'Intel(R) Xeon(R) Gold 6246R CPU @ 3.40GHz', x: '16코어/32스레드 · 최대 4.0GHz' });
    expect(g[1].rows[0]).toEqual({ n: '8 ×', m: '64 GB DDR4 2933MHz', x: 'Micron Technology' });
    expect(g[2].rows).toEqual([{ n: '11 ×', m: 'ST4000NM016A-2HZ', x: '4 TB · HDD(SATA)' }, { n: '', m: 'TOSHIBA MG04ACA4', x: '4 TB · HDD(SATA)' }]);
    expect(g[3].rows[0]).toEqual({ n: '', m: 'PERC H730P Adapter', x: '펌웨어 25.5.9.0001' });
    expect(g[3].rows[1].x).toBe('');
    expect(g[4].rows[0]).toEqual({ n: '', m: 'BRCM GbE 4P 5720-t rNDC', x: '4포트 · 링크 업 0' });   // 링크 업 0 은 값이다
    expect(g[4].rows[1].x).toBe('2포트 · 링크 업 2 · 10G');
    expect(g[5].rows).toEqual([]);   // 읽었고 없음
  });
  it('못 읽은 종류는 null(없음 [] 과 다르다) · 모르는 모델 · 크기는 그렇게 쓴다', () => {
    const g = partGroups({ cpus: null, dimms: [{ n: 1 }], disks: [{ n: 1 }], ctrls: undefined, nics: [{ ports: null, up: null }], hbas: null });
    expect(g[0].rows).toBeNull();
    expect(g[1].rows[0]).toEqual({ n: '', m: '크기 모름', x: '' });
    expect(g[2].rows[0]).toEqual({ n: '', m: '모델 모름', x: '' });
    expect(g[3].rows).toBeNull();
    expect(g[4].rows[0]).toEqual({ n: '', m: '모델 모름', x: '' });
    expect(g[5].rows).toBeNull();
  });
});

describe('24시간 추이 그림', () => {
  const fmt = (ts, withDate) => `${withDate ? 'D ' : ''}${Math.round((ts - NOW) / HOUR)}h`;
  const pts = (vals) => vals.map(([cpu, mem], i) => ({ ts: NOW + i * HOUR, cpu, mem }));
  it('행이 없으면 null', () => {
    expect(trendView([])).toBeNull();
    expect(trendView(null)).toBeNull();
    expect(trendView([{ cpu: 1 }])).toBeNull();   // 시각 없는 점은 그리지 않는다
    // 시각이 null · '' 인 점도 버린다 — Number(null) · Number('') 은 0(1970년)이라 눈금이 '1/1 9시' 가 됐다(반증 A13)
    expect(trendView([{ ts: null, cpu: 1, mem: 1 }, { ts: '', cpu: 2, mem: 2 }, { ts: 0, cpu: 3, mem: 3 }])).toBeNull();
    const v = trendView([{ ts: null, cpu: 99, mem: 99 }, { ts: NOW, cpu: 10, mem: 20 }, { ts: NOW + HOUR, cpu: 30, mem: 40 }], { w: 100, top: 0, h: 100 });
    expect(v.n).toBe(2);
    expect(v.cpu).toBe('M0.0,90.0 L100.0,70.0');
  });
  it('가로축 눈금 글자 — 첫 눈금만 날짜 · 브라우저 지역 시각 · 못 쓰는 시각은 빈 글자', () => {
    // 지역 시각으로 만든 날짜를 넣는다(시험기의 시간대와 무관하게 같은 글자가 나온다)
    const t = new Date(2026, 10, 25, 18, 0, 0).getTime();
    expect(tickText(t)).toBe('18시');
    expect(tickText(t, true)).toBe('11/25 18시');
    expect(tickText(new Date(2026, 0, 5, 3, 0, 0).getTime(), true)).toBe('1/5 03시');   // 시각은 두 자리 · 월 · 일은 그대로
    expect(tickText(NaN)).toBe('');
    expect(tickText('x', true)).toBe('');
  });
  it('값은 0~100 을 세로로 · 마지막 값 · 점 개수', () => {
    const v = trendView(pts([[0, 100], [50, 50], [100, 0]]), { w: 200, top: 10, h: 100, fmt });
    expect(v.cpu).toBe('M0.0,110.0 L100.0,60.0 L200.0,10.0');
    expect(v.mem).toBe('M0.0,10.0 L100.0,60.0 L200.0,110.0');
    expect(v).toMatchObject({ lastCpu: 100, lastMem: 0, n: 3, y0: 110, y50: 60, y100: 10, w: 200, gaps: [] });
  });
  it('못 읽은 점은 선을 끊는다(0 으로 그리지 않는다) · 둘 다 없는 구간은 띠', () => {
    const v = trendView(pts([[10, 20], [null, null], [null, null], [30, 40], [50, 60]]), { w: 400, top: 0, h: 100, fmt });
    expect(v.cpu).toBe('M0.0,90.0 M300.0,70.0 L400.0,50.0');
    expect(v.gaps).toEqual([{ x: 0, w: 300 }]);   // 앞뒤 읽힌 점 사이 전체
    expect(v.lastCpu).toBe(50);
  });
  it('한쪽 지표만 없는 점은 그 선만 끊고 띠는 만들지 않는다', () => {
    const v = trendView(pts([[10, 20], [null, 30], [30, 40]]), { w: 200, top: 0, h: 100, fmt });
    expect(v.cpu).toBe('M0.0,90.0 M200.0,70.0');
    expect(v.mem).toBe('M0.0,80.0 L100.0,70.0 L200.0,60.0');
    expect(v.gaps).toEqual([]);
  });
  it('처음 · 끝이 비어 있으면 가장자리까지 띠 · 마지막 값은 마지막으로 읽힌 값', () => {
    const v = trendView(pts([[null, null], [10, 20], [null, null]]), { w: 200, top: 0, h: 100, fmt });
    expect(v.gaps).toEqual([{ x: 0, w: 100 }, { x: 100, w: 100 }]);
    expect(v.lastCpu).toBe(10); expect(v.lastMem).toBe(20);
  });
  it('전부 못 읽었으면 선이 없고 마지막 값은 null(— 로 쓴다)', () => {
    const v = trendView(pts([[null, null], [null, null]]), { w: 200, top: 0, h: 100, fmt });
    expect(v.cpu).toBe(''); expect(v.mem).toBe(''); expect(v.lastCpu).toBeNull(); expect(v.lastMem).toBeNull();
    expect(v.gaps).toEqual([{ x: 0, w: 200 }]);
  });
  it('범위를 벗어난 값은 0~100 으로 자른다 · 빈 문자열은 값이 아니다', () => {
    const v = trendView(pts([[150, -20], ['', ''], [50, 50]]), { w: 200, top: 0, h: 100, fmt });
    expect(v.cpu).toBe('M0.0,0.0 M200.0,50.0');
    expect(v.mem).toBe('M0.0,100.0 M200.0,50.0');
  });
  it('눈금 5개 — 첫 눈금만 날짜를 붙이고 양 끝은 안쪽으로 맞춘다', () => {
    const v = trendView(pts([[1, 1], [2, 2], [3, 3], [4, 4], [5, 5]]), { w: 400, top: 0, h: 100, fmt });
    expect(v.ticks.map((t) => t.text)).toEqual(['D 0h', '1h', '2h', '3h', '4h']);
    expect(v.ticks.map((t) => t.x)).toEqual([0, 100, 200, 300, 400]);
    expect(v.ticks.map((t) => t.anchor)).toEqual(['start', 'middle', 'middle', 'middle', 'end']);
  });
  it('점이 하나뿐이어도 0 으로 나누지 않는다', () => {
    const v = trendView(pts([[10, 20]]), { w: 200, top: 0, h: 100, fmt });
    expect(v.cpu).toBe('M0.0,90.0');
    expect(v.n).toBe(1);
  });
});

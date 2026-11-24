import { describe, it, expect } from 'vitest';
import { rowsOf, aggregate, filterRows, parseQuery, highlight, previewAssign, resultNote, foldersByName, trimPath, pathText, ageText, INTRO } from './bmFoldersText.js';

const R = (key, corp, path, place, extra = {}) => ({ key, corp, path, place, name: key, kind: 'bm', ...extra });

describe('bmFoldersText', () => {
  const servers = [R('a1', 'A', 'DB', 'manual'), R('a2', 'A', 'DB\\Oracle', 'manual'), R('a3', 'A', '', null), R('b1', 'B', 'DB', 'rule'), R('n1', '', '', null)];

  it('고른 노드의 서버 — 폴더는 하위 포함/제외 · 미분류 · 법인 미지정 · 폴더 이름별(전 법인)', () => {
    expect(rowsOf(servers, { type: 'folder', corp: 'A', path: 'DB' }).map((r) => r.key)).toEqual(['a1', 'a2']);
    expect(rowsOf(servers, { type: 'folder', corp: 'A', path: 'DB' }, { sub: false }).map((r) => r.key)).toEqual(['a1']);
    expect(rowsOf(servers, { type: 'un', corp: 'A' }).map((r) => r.key)).toEqual(['a3']);
    expect(rowsOf(servers, { type: 'nocorp' }).map((r) => r.key)).toEqual(['n1']);
    expect(rowsOf(servers, { type: 'name', path: 'DB' }).map((r) => r.key)).toEqual(['a1', 'a2', 'b1']);
    expect(rowsOf([R('x', 'A', 'DB2', 'manual')], { type: 'folder', corp: 'A', path: 'DB' })).toEqual([]);   // '\\' 경계
  });

  it('합계 — 용량 가중 · 못 읽음/용량 모름은 빼고 따로 센다 · 전력은 읽은 서버만 · 장애 모름은 장애에도 정상에도 넣지 않는다', () => {
    const a = aggregate([
      { cpu: 50, mem: 40, cores: 30, memGB: 100, watts: 400, faults: 0, powered: true },
      { cpu: 10, mem: 80, cores: 10, memGB: 300, watts: null, faults: 2, powered: true },
      { cpu: null, mem: null, cores: 8, memGB: 64, watts: '', faults: null, powered: null },
      { cpu: 90, mem: null, cores: null, memGB: null, faults: 0, powered: false },
    ]);
    expect(a.cpu).toBe(40);   // (50×30 + 10×10) ÷ 40
    expect(a.mem).toBe(70);   // (40×100 + 80×300) ÷ 400
    expect([a.usageN, a.usageMissing, a.noCap]).toEqual([2, 1, 1]);
    expect([a.watts, a.wattsN]).toEqual([400, 1]);
    expect([a.faults, a.faultsUnknown, a.on, a.off, a.powerUnknown]).toEqual([1, 1, 2, 1, 1]);
    expect(aggregate([]).cpu).toBe(null);
  });

  it('표 거르기 — 글자 전부 · 빠른 조건(장애 · 못 읽음 · 꺼짐)', () => {
    const rows = [{ name: 'kr-db-01', model: 'R650', faults: 1, cpu: 5, powered: true }, { name: 'kr-web', model: 'R750', faults: 0, cpu: null, mem: null, powered: false }];
    expect(filterRows(rows, 'kr r650').map((r) => r.name)).toEqual(['kr-db-01']);
    expect(filterRows(rows, '', 'fault').length).toBe(1);
    expect(filterRows(rows, '', 'unread').map((r) => r.name)).toEqual(['kr-web']);
    expect(filterRows(rows, '', 'off').map((r) => r.name)).toEqual(['kr-web']);
  });

  it('찾기 입력 — 쉼표 · 앞의 - 는 제외 · 소문자 · 중복 제거 · 64자', () => {
    expect(parseQuery('DB, ora , -Bak, db,, -')).toEqual({ include: ['db', 'ora'], exclude: ['bak'] });
    expect(parseQuery(`${'x'.repeat(80)}`).include[0].length).toBe(64);
    expect(highlight('kr-DB-db', ['db'])).toEqual([{ text: 'kr-', hit: false }, { text: 'DB', hit: true }, { text: '-', hit: false }, { text: 'db', hit: true }]);
  });

  it('등록 미리보기 — 법인별 전 → 후 · 새 폴더 · 다른 폴더는 옮기기 켤 때만 · 조회 전용 법인은 건너뜀', () => {
    const corps = [{ vcenterId: 'A', writable: true, folders: [{ path: 'DB' }] }, { vcenterId: 'B', writable: true, folders: [] }, { vcenterId: 'C', writable: false, folders: [] }];
    const picked = [R('x1', 'A', '', null), R('x2', 'A', 'WEB', 'manual'), R('x3', 'B', '', null), R('x4', 'C', '', null), R('a1', 'A', 'DB', 'manual')];
    const p = previewAssign(picked, 'DB', corps, servers);
    expect(p.list).toEqual([{ corp: 'A', before: 1, add: 1, newFolder: false }, { corp: 'B', before: 1, add: 1, newFolder: true }]);
    expect(p.skipped).toEqual({ readOnly: 1, inOther: 1, same: 1 });
    expect(previewAssign(picked, 'DB', corps, servers, { moveExisting: true }).total).toBe(3);
  });

  it('결과 알림 — 0건이면 성공이 아니라 경고 · 건너뜀 사유를 밝힌다', () => {
    expect(resultNote('등록했습니다.', { added: 0, skipped: { inOther: 2 } })).toEqual({ ok: false, warn: true, text: '바뀐 서버가 없습니다 — 건너뜀: 이미 다른 폴더 2.' });
    expect(resultNote('등록했습니다.', { added: 3, skipped: { readOnly: 1 } }).text).toBe('등록했습니다. (건너뜀: 조회 전용 법인 1)');
  });

  it('폴더 이름별 합침 · 경로 정리 · 경로 글자 · 나이 · 문구에 백틱 없음', () => {
    const l = foldersByName([{ folders: [{ path: 'DB', name: 'DB', depth: 1, total: 3, faults: 1 }] }, { folders: [{ path: 'DB', name: 'DB', depth: 1, total: 2, faults: 0 }] }]);
    expect(l).toEqual([{ path: 'DB', name: 'DB', depth: 1, total: 5, corps: 2, faults: 1 }]);
    expect(trimPath('  DB\\Oracle\\\\ ')).toBe('DB\\Oracle');
    expect(pathText('DB\\Oracle')).toBe('DB › Oracle');
    expect(ageText(null)).toBe('—');
    expect(ageText(10_000_000 - 7_200_000, 10_000_000)).toBe('2시간 전');
    expect(ageText(10_000_000 - 3_600_000, 10_000_000)).toBe('60분 전');
    expect(INTRO.includes('`')).toBe(false);
  });
});

import { mapGroups, cellTone, parseViews, upsertView, cleanView, VIEWS_MAX } from './bmFoldersText.js';

describe('bmFoldersText v2.987 — 맵 · 저장한 보기', () => {
  const rows = [
    { key: 'a', corp: 'A', path: 'DB', place: 'manual', model: 'R650', cpu: 10 },
    { key: 'b', corp: 'A', path: '', place: null, model: '', cpu: null },
    { key: 'c', corp: 'B', path: 'DB', place: 'rule', model: 'R650', cpu: 95, faults: 2 },
  ];
  it('묶기 — 폴더는 법인마다 따로 · 미분류는 맨 뒤 · 법인 · 모델', () => {
    const f = mapGroups(rows, 'folder');
    expect(f.map((g) => [g.label, g.rows.length, g.un, g.corp])).toEqual([['DB', 1, false, 'A'], ['DB', 1, false, 'B'], ['(미분류)', 1, true, 'A']]);
    expect(mapGroups(rows, 'corp', (x) => `법인${x}`).map((g) => g.label)).toEqual(['법인A', '법인B']);
    expect(mapGroups(rows, 'model').map((g) => [g.label, g.un])).toEqual([['R650', false], ['(모델 모름)', true]]);
  });
  it('칸 색 — 20% 단위 5단 · 못 읽음은 na(0 으로 칠하지 않음) · 꺼짐 · 장애는 색과 따로 테두리 · 전력은 최대 대비', () => {
    expect(cellTone({ cpu: 10 }, 'cpu').tone).toBe('u1');
    expect(cellTone({ cpu: 0 }, 'cpu').tone).toBe('u1');
    expect(cellTone({ cpu: 95, faults: 2 }, 'cpu')).toEqual({ tone: 'u5', bad: true, label: '95%' });
    expect(cellTone({ cpu: null }, 'cpu').tone).toBe('na');
    expect(cellTone({ cpu: '' }, 'cpu').tone).toBe('na');
    expect(cellTone({ cpu: 50, powered: false }, 'cpu').tone).toBe('off');
    expect(cellTone({ faults: null }, 'fault').tone).toBe('na');
    expect(cellTone({ faults: 0 }, 'fault').tone).toBe('u1');
    expect(cellTone({ watts: 300 }, 'watts', 600).tone).toBe('u3');
    expect(cellTone({ watts: 0 }, 'watts', 600).tone).toBe('na');
  });
  it('저장한 보기 — 망가진 글자는 빈 목록 · 아는 필드만 · 같은 이름은 바꿈 · 상한', () => {
    expect(parseViews('{oops')).toEqual([]);
    expect(parseViews(JSON.stringify([{ name: 'x', state: { sel: { type: 'evil' }, view: 'map', quick: 'rm -rf', extra: 1 } }]))).toEqual([
      { name: 'x', state: { sel: { type: 'all' }, view: 'map', treeMode: 'corp', q: '', quick: '', sub: true, groupBy: 'folder', colorBy: 'cpu' } }]);
    expect(cleanView({ name: '', state: {} })).toBe(null);
    let l = [];
    l = upsertView(l, 'DB', { sel: { type: 'folder', corp: 'A', path: 'DB' }, view: 'map', colorBy: 'mem' });
    l = upsertView(l, 'DB', { sel: { type: 'corp', corp: 'A' } });
    expect(l.length).toBe(1); expect(l[0].state.sel).toEqual({ type: 'corp', corp: 'A' });
    for (let i = 0; i < 30; i += 1) l = upsertView(l, `v${i}`, {});
    expect(l.length).toBe(VIEWS_MAX); expect(l[0].name).toBe('v29');
  });
});

import { renameNote, removeNote } from './bmFoldersText.js';

describe('bmFoldersText v2.987 — 이름 바꾸기 · 지우기 알림은 응답 값으로', () => {
  it('빈 폴더를 바꾸거나 지워도 경고가 아니다 · 옮긴 규칙 수는 응답 값 · 못 옮겼으면 경고', () => {
    expect(renameNote({ path: 'X', moved: 0 })).toEqual({ ok: true, text: '폴더 이름을 바꿨습니다.' });
    expect(renameNote({ moved: 3, svcRules: 2 }).text).toBe('폴더 이름을 바꿨습니다 — 서비스 인벤토리의 물리서버 폴더 규칙 2개도 새 경로로 옮겼습니다.');
    const bad = renameNote({ moved: 1, svcRules: 0, svcRulesNotMoved: '서비스 인벤토리 저장 실패(디스크 쓰기)' });
    expect([bad.ok, bad.warn, bad.text.includes('옮기지 못했습니다')]).toEqual([false, true, true]);
    expect(removeNote('DB', { removed: 0, svcRules: 0 })).toEqual({ ok: true, text: '폴더 ‘DB’ 을(를) 지웠습니다.' });
    expect(removeNote('DB', { removed: 2, svcRules: 1 }).text).toBe('폴더 ‘DB’ 을(를) 지웠습니다 — 2대가 (미분류)로 돌아갔습니다. 서비스 인벤토리의 물리서버 폴더 규칙 1개가 아직 이 경로를 가리킵니다 — 서비스 인벤토리 › 소속 규칙에서 정리하십시오.');
    expect([renameNote({}).text, removeNote('x', {}).text].some((s) => s.includes('`'))).toBe(false);
  });
});

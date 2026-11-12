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

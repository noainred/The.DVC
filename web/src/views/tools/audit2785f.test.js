// v2.785(GR R-B2 · R-B3) — 백업 표시(중요도·백업 필요) 웹 쪽.
//  R-B2 표시 파일(backup-marks.json)을 못 읽었으면 서머리·세부 상단 수는 0 이 아니라 '—' · 이유를 분명히 알린다 · 주의 목록에 한 줄 ·
//       세부 '백업 필요'·'백업 필요·미백업'·중요도 칩 수도 '—'. 재시작 뒤 손상 사본만 남았으면(marksCorruptKept) 그 사실을 알린다.
//  R-B3 세부내용 저장 직후 재조회는 저장한 vCenter·옵션이 지금 고른 것과 같을 때만 — 렌더 시점 load 클로저로 다시 읽으면 vCenter 를 바꾼 뒤
//       이전 vCenter 의 표가 새 선택 아래 덮였다(늦게 온 이전 응답).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { marksLine, marksNotice, filterCountText, detailLoadKey, fmtNum, attentionList } from './backupViewText.js';

const read = (f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8');

describe('R-B2 표시 수 — 못 읽으면 0 이 아니라 모름', () => {
  it('세부 행 marks null + 못 읽음 → 모든 값 null(\'—\') · unknown', () => {
    const m = marksLine(null, true);
    expect(m).toMatchObject({ high: null, mid: null, low: null, need: null, needGap: null, unknown: true });
    for (const k of ['high', 'mid', 'low', 'need', 'needGap']) expect(fmtNum(m[k])).toBe('—');
  });
  it('서머리 합계(서버가 null 로 낸 값)는 0 으로 바꾸지 않는다', () => {
    const m = marksLine({ high: null, mid: null, low: null, need: null, needGap: null, needGapUnknown: 0 }, true);
    expect(fmtNum(m.high)).toBe('—');
    expect(fmtNum(m.need)).toBe('—');
    // 못 읽음 표지가 없어도 null 은 null
    expect(marksLine({ high: null, mid: 1, low: 0, need: null, needGap: 0 }).high).toBe(null);
  });
  it('읽은 값은 그대로 · 데이터 없음(옛 응답)은 null', () => {
    expect(marksLine({ high: 1, mid: 0, low: 2, need: 3, needGap: null })).toEqual({ high: 1, mid: 0, low: 2, need: 3, needGap: null, method: null });   // v2.803 옛 응답(method 없음)은 null
    expect(marksLine(null)).toBe(null);
    expect(marksLine({ high: 1, mid: 0, low: 0, need: 2, needGap: 1, needGapUnknown: 2 }).needGapUnknown).toBe(2);
  });
  it('안내 문구 — 못 읽음은 bad · 손상 사본만 남음은 warn · 정상은 null · 백틱 없음', () => {
    const a = marksNotice({ marksUnreadable: true });
    expect(a.tone).toBe('bad');
    expect(a.text).toContain('backup-marks.json');
    expect(a.text).toContain('—');
    const b = marksNotice({ marksCorruptKept: true });
    expect(b.tone).toBe('warn');
    expect(b.text).toContain('backup-marks.json.corrupt');
    expect(marksNotice({ marksUnreadable: true, marksCorruptKept: true }).tone).toBe('bad');
    expect(marksNotice({})).toBe(null);
    expect(marksNotice(null)).toBe(null);
    for (const x of [a, b]) expect(x.text).not.toMatch(/`/);
  });
  it('세부 보기 칩 — 표시 기준 칩만 \'—\'(Veeam·스냅샷 칩은 그대로)', () => {
    const counts = { all: 5, veeam: 2, need: 0, needgap: 0, 'crit-high': 0 };
    expect(filterCountText('need', counts, true)).toBe('—');
    expect(filterCountText('needgap', counts, true)).toBe('—');
    expect(filterCountText('crit-high', counts, true)).toBe('—');
    expect(filterCountText('veeam', counts, true)).toBe(2);
    expect(filterCountText('need', counts, false)).toBe(0);
    expect(filterCountText('bareos', { bareos: 0 }, false, true)).toBe('—');   // v2.830 W2: Bareos 원장을 못 읽으면 Bareos 칩은 모름
    expect(filterCountText('bareos-missing', { 'bareos-missing': 0 }, false, true)).toBe('—');
    expect(filterCountText('bareos', { bareos: 3 }, false, false)).toBe(3);
  });
  it('주의 목록 — 표시 수를 모르는 행이 있으면 정보 한 줄(미백업 경고가 소리 없이 사라지지 않게)', () => {
    const ok = { id: 'v1', name: 'VC1', veeamState: 'ok', snap: 1, snapStale: 0 };
    const att = attentionList([{ ...ok, marks: null }, { ...ok, id: 'v2', name: 'VC2', marks: null }]);
    const it1 = att.find((a) => a.id === 'marks-unknown');
    expect(it1).toBeTruthy();
    expect(it1.tone).toBe('info');
    expect(it1.title).toContain('모름');
    // 옛 응답(marks 키 없음)·읽은 행은 넣지 않는다
    expect(attentionList([ok, { ...ok, id: 'v3', marks: { need: 0, needGap: 0 } }]).some((a) => a.id === 'marks-unknown')).toBe(false);
  });
  it('화면 소스 — 서머리·세부 상단은 marksLine(…, 못 읽음) · 안내는 marksNotice · 칩은 filterCountText', () => {
    // v2.837: Summary 는 시안 ① 에 맞춰 업무 중요도 카드를 뺐다(Detail 에 그대로) — 표시 파일을 못 읽으면 안내 한 줄 + 정책 수 '—'(bundlesOf null)
    const sum = read('./BackupSummaryTool.jsx');
    expect(sum).toMatch(/\{data\.marksUnreadable && <div className="card"/);
    expect(sum).not.toMatch(/fmtNum\(t\.marks\[/);
    const det = read('./BackupDetailTool.jsx');
    expect(det).toMatch(/marksLine\(r\.marks, data\.marksUnreadable\)/);
    expect(det).toMatch(/marksNotice\(data\)/);
    expect(det).toMatch(/filterCountText\(k, counts, marksUnknown[,)]/);   // v2.830 버그 점검 W2: 뒤에 Bareos 원장 못 읽음 인자가 붙는다
    expect(det).toMatch(/const writable = data\?\.writable === true && !data\?\.marksUnreadable/);
  });
});

describe('R-B3 저장 직후 재조회 — 지금 고른 vCenter·옵션과 같을 때만', () => {
  it('detailLoadKey — vCenter·전원·제외가 같아야 같은 키(오래된 백업 기준은 화면 계산이라 키에 넣지 않는다)', () => {
    const o = { power: 'all', excl: true, rpoDays: 1 };
    expect(detailLoadKey('a:vc1', o)).toBe(detailLoadKey('a:vc1', { ...o, rpoDays: 7 }));
    expect(detailLoadKey('a:vc1', o)).not.toBe(detailLoadKey('a:vc2', o));
    expect(detailLoadKey('a:vc1', o)).not.toBe(detailLoadKey('a:vc1', { ...o, power: 'on' }));
    expect(detailLoadKey('a:vc1', o)).not.toBe(detailLoadKey('a:vc1', { ...o, excl: false }));
  });
  it('saveMarks 는 렌더 시점 load 를 부르지 않는다 — 저장 키와 지금 키가 같을 때만 최신 load 로(reloadRef)', () => {
    const det = read('./BackupDetailTool.jsx');
    const i = det.indexOf('const saveMarks = useCallback(');
    expect(i).toBeGreaterThan(0);
    const body = det.slice(i, det.indexOf('\n  }, [', i));
    expect(body).toMatch(/const savedKey = detailLoadKey\(vcId, opts\)/);
    expect(body).toMatch(/if \(savedKey === keyRef\.current\) reloadRef\.current\(\)/);
    expect(body).not.toMatch(/(^|[^.\w])load\(true\)/m);
    expect(det).toMatch(/keyRef\.current = detailLoadKey\(vcId, opts\)/);
    expect(det).toMatch(/reloadRef\.current = \(\) => load\(true\)/);
  });
});

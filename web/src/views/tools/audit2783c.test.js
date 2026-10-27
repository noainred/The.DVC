// v2.783(점검 Q3) 백업 서머리 회귀:
//  · L-B3 '스냅샷만' 보기·칩 수는 Veeam 을 **아는** VM 만 — 'Veeam 모름'(v 키 없음 · 첫 수집 전·한 번도 못 읽은 서버) + 스냅샷 VM 을 세지 않는다
//    (요약 sOnly 는 null(모름)인데 칩·CSV 는 '스냅샷만' 이던 어긋남). 웹 vmMatches 와 서버 vmViewMatches 는 한 쌍.
//  · L-B4 주의 목록 — 잘린 항목이 전부 이미 보인 행의 다른 문제면 '외 N곳'(행 수)이 0 이라 안내 없이 사라졌다 → '외 N건(보인 곳의 다른 문제)'.
import { describe, it, expect } from 'vitest';
import { vmMatches, filterCounts, attentionList } from './backupViewText.js';
import { vmViewMatches } from '../../../../server/src/veeam/backupStatus.js';

const NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;

describe('v2.783 L-B3 스냅샷만 — Veeam 모름은 넣지 않는다', () => {
  const unknownSnap = { id: 'u', s: { ev: { ts: NOW - 3_600_000, n: 1 } } };           // v 키 없음 = Veeam 모름
  const absentSnap = { id: 'a', v: null, s: { ev: { ts: NOW - 3_600_000, n: 1 } } };   // Veeam 에 없음(확인됨)
  const veeamSnap = { id: 'b', v: { state: 'ok', lb: NOW - 3_600_000, lr: 'Success' }, s: { ev: { ts: NOW, n: 1 } } };

  it('모름 + 스냅샷 VM 은 스냅샷만이 아니다(웹·서버 같은 답)', () => {
    for (const fn of [vmMatches, vmViewMatches]) {
      expect(fn(unknownSnap, 'snaponly', { now: NOW })).toBe(false);
      expect(fn(absentSnap, 'snaponly', { now: NOW })).toBe(true);
      expect(fn(veeamSnap, 'snaponly', { now: NOW })).toBe(false);
      expect(fn(unknownSnap, 'none', { now: NOW })).toBe(false);
    }
  });

  it('칩 수(filterCounts)도 같다 — 모름 VM 은 전체에만', () => {
    expect(filterCounts([unknownSnap, absentSnap, veeamSnap], { now: NOW })).toMatchObject({ all: 3, snaponly: 1, veeam: 1, none: 0 });
  });
});

describe('v2.783 L-B4 주의 목록 — 잘린 항목이 이미 보인 행의 것이어도 알린다', () => {
  it('6곳 모두 Veeam 읽기 실패 + 그중 한 곳에 스냅샷 잔존 → 6줄 + 외 1건(보인 곳의 다른 문제)', () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({ id: `vc${i}`, name: `VC${i}`, veeamState: 'veeam-failed', snap: 3, snapStale: i === 0 ? 3 : 0 }));
    const att = attentionList(rows);
    expect(att.filter((a) => !a.more)).toHaveLength(6);
    const more = att.find((a) => a.more);
    expect(more).toMatchObject({ id: 'more', more: 1, title: '외 1건(보인 곳의 다른 문제)' });
    expect(JSON.stringify(att)).not.toMatch(/`/);
  });

  it('안 나온 행이 있으면 예전처럼 행 수(외 N곳) · 넘치지 않으면 줄 없음', () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({ id: `vc${i}`, name: `VC${i}`, veeamState: 'veeam-failed', snap: 3, snapStale: i === 0 ? 3 : 0 }));
    expect(attentionList(rows).find((a) => a.more)).toMatchObject({ more: 2, title: '외 2곳' });
    const few = rows.slice(0, 3);
    expect(attentionList(few).some((a) => a.more)).toBe(false);
  });
});

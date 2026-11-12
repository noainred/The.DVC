import { describe, it, expect } from 'vitest';
import { edgeFolderRows, edgeRowsOf, edgeCopyNote } from './edgeViewText.js';

describe('v2.994 엣지 포탈 물리서버 폴더(설계 bm-folders §11)', () => {
  const corps = [{ vcenterId: 'kr', name: 'KR', folders: ['DB', 'DB\\Oracle', 'WEB'], services: [{ prefix: 'DB', service: 'DB 서비스' }, { prefix: 'DB\\Oracle', service: 'Oracle' }] }];
  const servers = [{ key: 'a', corp: 'kr', path: 'DB\\Oracle', name: 'ora1' }, { key: 'b', corp: 'kr', path: 'DB', name: 'db1' }, { key: 'c', corp: 'kr', path: '', name: 'x' }];
  it('트리 — 하위 포함 대수 · 가장 긴 접두의 서비스 · 미분류', () => {
    const t = edgeFolderRows(corps, servers)[0];
    expect(t.n).toBe(3); expect(t.unplaced).toBe(1);
    expect(t.folders.map((f) => [f.path, f.n, f.service, f.depth])).toEqual([['DB', 2, 'DB 서비스', 0], ['DB\\Oracle', 1, 'Oracle', 1], ['WEB', 0, '', 0]]);
  });
  it('고르기 — 폴더(하위 포함) · 미분류 · 거르기', () => {
    expect(edgeRowsOf(servers, { corp: 'kr', path: 'DB' }).map((s) => s.key)).toEqual(['a', 'b']);
    expect(edgeRowsOf(servers, { corp: 'kr', path: '\u0000' }).map((s) => s.key)).toEqual(['c']);
    expect(edgeRowsOf(servers, {}, 'ORA').map((s) => s.key)).toEqual(['a']);
  });
  it('사본 문구 — 받은 적 없음 · 나이 · 실패해도 지난 사본 · 손상', () => {
    const now = 10_000_000;
    expect(edgeCopyNote({}, now).text).toBe('중앙 사본을 아직 받지 않았습니다');
    expect(edgeCopyNote({ copy: { savedAt: now - 120_000 } }, now).text).toBe('사본 2분 전 받음');
    expect(edgeCopyNote({ copy: { savedAt: now - 120_000 }, pull: { last: { at: now - 60_000, ok: false } } }, now).warn).toContain('지난 사본을 그대로');
    expect(edgeCopyNote({ copyError: 'x' }, now).text).toBe('사본을 읽지 못했습니다');
  });
});

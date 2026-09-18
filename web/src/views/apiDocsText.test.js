/**
 * 공개 API 안내 페이지 문구·판정 회귀 — v2.564.
 *
 * ⚠ 이 저장소의 웹 테스트는 node 환경(DOM 없음)이라 컴포넌트 렌더를 못 본다 —
 *   그래서 판정·문구를 순수 모듈로 빼고 여기서 고정한다(v2.398 규약).
 */
import { describe, it, expect } from 'vitest';
import {
  INTRO, SCOPE_NOTE, SAMPLE_NOTE, KEY_NOTE, TRY_NOTE,
  scopeBadge, filterEndpoints, statusTone, tryResultNote, responseHints,
  disabledNote, parseRich,
} from './apiDocsText.js';

const EPS = [
  { path: '/inventory/summary', summary: '전체 요약', group: 'inventory', fields: ['vms', 'hosts'], scoped: true },
  { path: '/capacity/storage', summary: '스토리지 용량', group: 'capacity', fields: ['usedPct', 'totalBytes'], requiresFullScope: true },
  { path: '/faults/alarms', summary: '알람', group: 'faults', fields: ['name', 'entity'], scoped: true },
];

describe('parseRich — 굵게 + 백틱', () => {
  it('굵게 안의 백틱을 글자로 남기지 않는다 (v2.564 초판 결함)', () => {
    // 실제 CONTRACT_NOTES 의 형태다. BoldText 는 이것을 못 해석해 백틱 18개가 그대로 보였다.
    const t = parseRich('읽지 못한 값은 **0 이 아니라 `null`** 입니다.');
    expect(t.map((x) => x.v).join('')).not.toContain('`');
    expect(t.map((x) => x.v).join('')).not.toContain('*');
    const code = t.find((x) => x.code);
    expect(code).toEqual({ v: 'null', bold: true, code: true });
  });

  it('굵게 밖의 백틱도 코드로 만든다', () => {
    const t = parseRich('`meta.truncated` 를 보세요.');
    expect(t[0]).toEqual({ v: 'meta.truncated', bold: false, code: true });
    expect(t[1].v).toBe(' 를 보세요.');
  });

  it('원문을 한 글자도 잃지 않는다 (표시 문자만 제거)', () => {
    const src = '앞 **굵게** 중간 `코드` 뒤 **`둘 다`** 끝';
    const joined = parseRich(src).map((x) => x.v).join('');
    expect(joined).toBe('앞 굵게 중간 코드 뒤 둘 다 끝');
  });

  it('⚠ 짝이 맞지 않는 표시는 글자 그대로 둔다 — 억지로 해석하지 않는다', () => {
    expect(parseRich('열기만 ** 했다').map((x) => x.v).join('')).toBe('열기만 ** 했다');
    expect(parseRich('백틱 ` 하나').map((x) => x.v).join('')).toBe('백틱 ` 하나');
  });

  it('빈 값·null 을 안전하게 다룬다', () => {
    expect(parseRich('')).toEqual([]);
    expect(parseRich(null)).toEqual([]);
    expect(parseRich(undefined)).toEqual([]);
  });

  it('빈 토큰을 만들지 않는다 (렌더가 빈 <b> 를 찍지 않게)', () => {
    for (const t of parseRich('**A**`B`**C**')) expect(t.v).not.toBe('');
  });
});

describe('scopeBadge — scoped 와 requiresFullScope 는 반대말이다', () => {
  it('전체 범위 키만 받는 자원은 bad 로 경고한다', () => {
    const b = scopeBadge(EPS[1]);
    expect(b.tone).toBe('bad');
    expect(b.title).toContain('403');
  });
  it('범위 적용 자원은 ok 다', () => {
    expect(scopeBadge(EPS[0]).tone).toBe('ok');
  });
  it('둘 다 아니면 muted — 초록(정상)으로 칠하지 않는다', () => {
    expect(scopeBadge({ path: '/x' }).tone).toBe('muted');
  });
  it('null 에 문구를 지어내지 않는다', () => {
    expect(scopeBadge(null)).toBeNull();
  });
});

describe('filterEndpoints', () => {
  it('필드 이름으로도 찾힌다 ("usedPct 어디 있지?")', () => {
    expect(filterEndpoints(EPS, 'usedPct').map((e) => e.path)).toEqual(['/capacity/storage']);
  });
  it('여러 단어는 AND 다', () => {
    expect(filterEndpoints(EPS, 'capacity 용량')).toHaveLength(1);
    expect(filterEndpoints(EPS, 'capacity 알람')).toHaveLength(0);
  });
  it('빈 검색어는 전체를 준다 (0건이 아니다)', () => {
    expect(filterEndpoints(EPS, '   ')).toHaveLength(3);
    expect(filterEndpoints(EPS, null)).toHaveLength(3);
  });
  it('입력이 없어도 던지지 않는다', () => {
    expect(filterEndpoints(null, 'x')).toEqual([]);
  });
});

describe('statusTone', () => {
  it('2xx ok · 4xx warn · 5xx bad', () => {
    expect(statusTone(200)).toBe('ok');
    expect(statusTone(403)).toBe('warn');
    expect(statusTone(503)).toBe('bad');
  });
  it('⚠ 상태가 없으면 muted 다 — 초록 폴백 금지', () => {
    expect(statusTone(null)).toBe('muted');
    expect(statusTone('')).toBe('muted');       // Number('') === 0 함정
    expect(statusTone(undefined)).toBe('muted');
  });
});

describe('tryResultNote — 실패를 한 문구로 덮지 않는다', () => {
  it('코드마다 다른 조치를 말한다', () => {
    const revoked = tryResultNote(401, { code: 'revoked' });
    const noGroups = tryResultNote(403, { code: 'no-groups' });
    expect(revoked.hint).not.toBe(noGroups.hint);
    expect(revoked.hint).toContain('발급');
    expect(noGroups.hint).toContain('분류');
  });
  it('needs-full-scope 는 키를 의심하라고 말하지 않는다', () => {
    const h = tryResultNote(403, { code: 'needs-full-scope' }).hint;
    expect(h).toContain('범위');
    expect(h).not.toContain('폐기');
  });
  it('not-collected 를 장애라고 말하지 않는다', () => {
    expect(tryResultNote(503, { code: 'not-collected' }).hint).toContain('장애가 아닙니다');
  });
  it('보내지도 못한 것(status 0)을 서버 오류라 하지 않는다', () => {
    const r = tryResultNote(0, null);
    expect(r.title).toContain('보내지 못했습니다');
    expect(r.hint).toMatch(/CORS|네트워크/);
  });
  it('성공은 힌트를 만들지 않는다', () => {
    expect(tryResultNote(200, { ok: true })).toEqual({ tone: 'ok', title: '200 성공', hint: '' });
  });
  it('모르는 코드에 문구를 지어내지 않는다', () => {
    expect(tryResultNote(418, { code: 'teapot' }).hint).toBe('');
  });
});

describe('responseHints — 계약을 그 자리에서 말한다', () => {
  it('상한에 걸린 목록을 전체라고 말하지 않는다', () => {
    const h = responseHints({ meta: { truncated: true, limit: 500, omitted: 42 }, data: [] });
    expect(h[0]).toContain('42건이 빠졌습니다');
    expect(h[0]).toContain('전체가 아닙니다');
  });
  it('null 필드를 짚어 준다 — 0 과 다르다는 것을 말한다', () => {
    const h = responseHints({ meta: {}, data: [{ a: 1, usedBytes: null }] });
    expect(h.join(' ')).toContain('usedBytes');
    expect(h.join(' ')).toContain('읽지 못했다');
  });
  it('범위로 걸러진 결과임을 밝힌다', () => {
    expect(responseHints({ meta: { scopedToVcenters: 3 }, data: [] }).join(' ')).toContain('3곳');
  });
  it('⚠ truncated 가 false 면 상한 문구를 만들지 않는다', () => {
    expect(responseHints({ meta: { truncated: false, limit: 500 }, data: [{ a: 1 }] })).toEqual([]);
  });
  it('본문이 없거나 이상해도 던지지 않는다', () => {
    expect(responseHints(null)).toEqual([]);
    expect(responseHints('문자열')).toEqual([]);
  });
});

describe('disabledNote — 꺼진 것과 못 읽은 것을 구분한다', () => {
  it('두 문구가 다르다 (조치가 다르다)', () => {
    expect(disabledNote('off')).not.toBe(disabledNote('error'));
    expect(disabledNote('off')).toContain('꺼 두었습니다');
  });
});

describe('문구 계약', () => {
  const ALL = [INTRO, SCOPE_NOTE, SAMPLE_NOTE, KEY_NOTE, TRY_NOTE,
    disabledNote('off'), disabledNote('error')];

  it('⚠ 백틱을 쓰지 않는다 — 렌더가 `**강조**` 만 해석하는 곳과 섞이면 글자로 샌다', () => {
    // 이 화면의 Rich 는 백틱을 해석하지만, 이 상수들은 BoldText 를 쓰는 화면으로 옮겨질 수
    // 있다. 값 인용은 홑화살괄호로 한다(v2.553 규약).
    for (const s of ALL) expect(s).not.toContain('`');
  });

  it('강조 표시의 짝이 맞는다', () => {
    for (const s of ALL) expect((s.match(/\*\*/g) || []).length % 2).toBe(0);
  });

  it('이 페이지가 무엇을 보여주지 않는지 말한다', () => {
    expect(SCOPE_NOTE).toMatch(/공개/);
    expect(SAMPLE_NOTE).toContain('실제 데이터가 아닙니다');
  });
});

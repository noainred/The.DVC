/**
 * apiKeyText.test.js — 설정 › 연동 키 문구·판정 회귀(v2.562).
 * 판정이 두 곳에 있으면 KPI 합계와 표의 색이 어긋난다 — 이 파일이 소유자를 고정한다.
 */
import { describe, it, expect } from 'vitest';
import {
  keyState, expiryNote, scopeText, groupsText, kpisOf, kpiIdentityOk,
  lastUsedText, fullScopeWarning, curlExample, rpmNote, staleGroups,
  DIRECTION_NOTE, ONCE_NOTE, READONLY_NOTE, KEY_STATES,
} from './apiKeyText.js';

const NOW = 1_800_000_000_000;   // 고정 기준 시각 — Date.now() 를 쓰면 시각에 따라 깨진다(v2.517 규약)

describe('keyState — 판정 순서가 계약', () => {
  it('폐기가 만료를 이긴다(폐기는 되돌릴 수 없다)', () => {
    expect(keyState({ revokedAt: NOW - 1, expiresAt: NOW - 2, groups: ['inventory'] }, NOW)).toBe('revoked');
  });
  it('만료는 분류 유무보다 먼저', () => {
    expect(keyState({ expiresAt: NOW - 1, groups: [] }, NOW)).toBe('expired');
  });
  it('분류가 비면 no-groups — 전부 허용이 아니다', () => {
    expect(keyState({ groups: [] }, NOW)).toBe('no-groups');
  });
  it('무기한 + 분류 있으면 live', () => {
    expect(keyState({ expiresAt: null, groups: ['inventory'] }, NOW)).toBe('live');
  });
  it('상태 라벨이 전부 선언돼 있다(화면이 코드를 그대로 보여주지 않게)', () => {
    for (const s of ['live', 'revoked', 'expired', 'no-groups']) expect(KEY_STATES[s]?.label).toBeTruthy();
  });
});

describe('expiryNote — null 을 0 으로 읽지 않는다', () => {
  it('무기한은 “오늘 만료” 가 아니다', () => {
    const r = expiryNote(null, NOW);
    expect(r.kind).toBe('none');
    expect(r.days).toBeNull();
    expect(r.text).not.toMatch(/0일/);
  });
  it('빈 문자열도 무기한이다(Number("") === 0 함정)', () => {
    expect(expiryNote('', NOW).kind).toBe('none');
  });
  it('지난 만료는 past 이고 남은 일수를 양수로 말하지 않는다', () => {
    const r = expiryNote(NOW - 3 * 86_400_000, NOW);
    expect(r.kind).toBe('past');
    expect(r.text).toMatch(/3일 전/);
  });
  it('14일 이내는 soon', () => {
    expect(expiryNote(NOW + 5 * 86_400_000, NOW).kind).toBe('soon');
    expect(expiryNote(NOW + 40 * 86_400_000, NOW).kind).toBe('far');
  });
  it('읽을 수 없는 값은 지어내지 않는다', () => {
    expect(expiryNote('내일', NOW).days).toBeNull();
  });
});

describe('scopeText — 빈 배열은 전체다(도구 권한과 방향이 반대)', () => {
  it('빈 범위 = 전체', () => {
    expect(scopeText([])).toMatch(/전체/);
    expect(scopeText(null)).toMatch(/전체/);
  });
  it('지정한 개수를 밝힌다', () => {
    expect(scopeText(['a', 'b'])).toMatch(/2곳/);
  });
});

describe('groupsText — 빈 허용목록의 뜻을 숨기지 않는다', () => {
  const cat = [{ key: 'inventory', label: '인벤토리 지표' }];
  it('빈 목록은 “아무것도 조회할 수 없다” 고 말한다', () => {
    expect(groupsText([], cat)).toMatch(/아무것도 조회할 수 없습니다/);
  });
  it('라벨로 바꿔 보여준다(코드를 그대로 쓰지 않는다)', () => {
    expect(groupsText(['inventory'], cat)).toBe('인벤토리 지표');
  });
  /*
   * ⚠ 분류를 없앤 릴리스 뒤에는 옛 키가 사라진 분류를 들고 있다. 코드만 보여주면 사용자는
   *   **아직 유효한 분류**로 읽는다(v2.562 스크린샷 판독에서 실제로 ‘portal’ 이 그랬다).
   */
  it('카탈로그에 없는 키는 라벨인 척하지 않고 (무효) 를 붙인다', () => {
    expect(groupsText(['nope'], cat)).toBe('nope(무효)');
    expect(groupsText(['inventory', 'portal'], cat)).toBe('인벤토리 지표 · portal(무효)');
  });
});

describe('staleGroups — 없는 분류를 각주 한 번으로 모은다', () => {
  const cat = [{ key: 'inventory', label: '인벤토리 지표' }];
  it('중복을 합치고 순서를 유지한다', () => {
    expect(staleGroups([{ groups: ['inventory', 'portal'] }, { groups: ['portal', 'nope'] }], cat))
      .toEqual(['portal', 'nope']);
  });
  it('전부 유효하면 빈 배열 — 없는 문제를 만들지 않는다', () => {
    expect(staleGroups([{ groups: ['inventory'] }], cat)).toEqual([]);
    expect(staleGroups([], cat)).toEqual([]);
    expect(staleGroups(null, cat)).toEqual([]);
  });
});

describe('KPI — 칸이 겹치지 않고 합계가 맞는다', () => {
  const keys = [
    { groups: ['inventory'] },
    { groups: ['inventory'], revokedAt: NOW - 1 },
    { groups: ['inventory'], expiresAt: NOW - 1 },
    { groups: [] },
    { groups: ['capacity'], expiresAt: NOW + 86_400_000 },
  ];
  it('항등식 합계 = 사용중 + 폐기 + 만료 + 분류없음', () => {
    const k = kpisOf(keys, NOW);
    expect(k).toEqual({ total: 5, live: 2, revoked: 1, expired: 1, 'no-groups': 1 });
    expect(kpiIdentityOk(k)).toBe(true);
  });
  it('한 칸을 빼면 항등식이 깨진다(화면에서 칸을 지우지 못하게)', () => {
    const k = kpisOf(keys, NOW);
    expect(kpiIdentityOk({ ...k, revoked: 0 })).toBe(false);
  });
});

describe('lastUsedText — 안 쓴 것과 오래 안 쓴 것을 구분한다', () => {
  it('한 번도 안 쓴 키를 “오래 안 씀” 이라 하지 않는다', () => {
    const r = lastUsedText(null, 0, NOW);
    expect(r.kind).toBe('never');
    expect(r.text).not.toMatch(/일 전/);
  });
  it('누적 횟수를 함께 말한다', () => {
    expect(lastUsedText(NOW - 30 * 60_000, 1234, NOW).text).toMatch(/누적 1,234회/);
  });
  it('읽을 수 없는 시각은 unknown', () => {
    expect(lastUsedText('언젠가', 1, NOW).kind).toBe('unknown');
  });
  it('이틀 넘으면 stale', () => {
    expect(lastUsedText(NOW - 5 * 86_400_000, 1, NOW).kind).toBe('stale');
  });
});

describe('fullScopeWarning — 403 을 미리 말한다', () => {
  const eps = [
    { path: '/capacity/storage', requiresFullScope: true },
    { path: '/capacity/storage-growth', requiresFullScope: true },
    { path: '/inventory/summary', requiresFullScope: false },
  ];
  it('전체 범위 키에는 경고하지 않는다(없는 문제를 만들지 않는다)', () => {
    expect(fullScopeWarning([], eps)).toBeNull();
  });
  it('범위 키에는 막히는 경로를 개수와 함께 밝힌다', () => {
    const w = fullScopeWarning(['vc1'], eps);
    expect(w.blocked).toEqual(['/capacity/storage', '/capacity/storage-growth']);
    expect(w.text).toMatch(/2개 경로/);
    expect(w.text).toMatch(/장비 0대/);   // 왜 빈 목록을 주지 않는지 말한다
  });
  it('막히는 경로가 없으면 경고하지 않는다', () => {
    expect(fullScopeWarning(['vc1'], [{ path: '/x', requiresFullScope: false }])).toBeNull();
  });
});

describe('문구 위생', () => {
  const all = [DIRECTION_NOTE, ONCE_NOTE, READONLY_NOTE,
    groupsText([], []), scopeText([]), expiryNote(null, NOW).text,
    fullScopeWarning(['a'], [{ path: '/p', requiresFullScope: true }]).text,
    rpmNote(120), lastUsedText(null, 0, NOW).text];
  it('백틱을 쓰지 않는다(BoldText 가 해석하지 못해 글자로 샌다)', () => {
    for (const t of all) expect(t).not.toContain('`');
  });
  it('조치문에 “ — ” 를 두 번 넣지 않는다(3단 제목이 된다)', () => {
    for (const t of all) expect((t.match(/ — /g) || []).length).toBeLessThanOrEqual(1);
  });
  it('1회 표시 경고가 재발급 사실을 말한다', () => {
    expect(ONCE_NOTE).toMatch(/재발급/);
    expect(ONCE_NOTE).toMatch(/한 번만/);
  });
  it('방향 안내가 자동 차단임을 말한다(거부 기본값)', () => {
    expect(DIRECTION_NOTE).toMatch(/자동으로 차단/);
  });
  it('조회 전용임을 말한다', () => {
    expect(READONLY_NOTE).toMatch(/조회 전용/);
  });
});

describe('curlExample · rpmNote', () => {
  it('끝 슬래시를 두 번 붙이지 않는다', () => {
    expect(curlExample('https://p.example/')).toBe('curl -H "X-Api-Key: <발급한 키>" https://p.example/api/v1/inventory/summary');
  });
  it('예시에 실제 키를 넣지 않는다', () => {
    expect(curlExample('https://p.example')).not.toMatch(/dvcapi_[A-Za-z0-9_-]{10,}/);
  });
  it('상한을 읽지 못하면 숫자를 지어내지 않는다', () => {
    expect(rpmNote(null)).toMatch(/읽지 못했습니다/);
    expect(rpmNote(0)).toMatch(/읽지 못했습니다/);
    expect(rpmNote(120)).toMatch(/분당 120회/);
  });
});

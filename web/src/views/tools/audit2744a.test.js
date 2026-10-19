/**
 * views/tools/audit2744a.test.js — 점검 3회차(v2.744) 그룹 GA 의 화면 쪽(VM 수량 추이 · 스토리지 변경 이력).
 *
 * WEB-01: VM 수량 추이(VmTrackTool)는 vCenter·기간을 바꿀 때 이전 결과·오류를 먼저 비우는가 — 비우지 않으면 새 조회가 끝날 때까지
 *   이전 vCenter·기간의 차트·숫자가 새 선택의 값처럼 보인다(StorageTrackTool 은 이미 그렇게 한다 — 형제 비대칭).
 * DB-01(화면 쪽): 스토리지 변경 이력의 DS 피벗 검색은 글자마다 서버를 부르지 않고 입력이 멈춘 뒤 300ms 에 한 번만 부르는가.
 *
 * 이 저장소의 vitest 는 node 환경(DOM 없음)이라 효과(useEffect)를 렌더로 돌릴 수 없다 — 그래서 소스를 주석을 지운 뒤 검사한다.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../../test/_stripComments.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (f) => stripComments(fs.readFileSync(path.join(here, f), 'utf8'));

/** deps 배열이 정확히 deps 인 useEffect 의 본문(화살표 함수 몸통)을 돌려준다. 없으면 null. */
function effectBody(code, deps) {
  const re = /useEffect\(\s*\(\)\s*=>\s*\{([\s\S]*?)\}\s*,\s*\[([^\]]*)\]\s*\)/g;
  for (const m of code.matchAll(re)) {
    const got = m[2].split(',').map((x) => x.trim()).filter(Boolean);
    if (got.length === deps.length && deps.every((d) => got.includes(d))) return m[1];
  }
  return null;
}

describe('WEB-01 VM 수량 추이 — 조회 범위가 바뀌면 이전 값을 비운다', () => {
  const code = src('VmTrackTool.jsx');
  it('[days, vcenterId] 효과가 setData(null)·setError(null) 를 load() 보다 먼저 부른다', () => {
    const body = effectBody(code, ['days', 'vcenterId']);
    expect(body, '[days, vcenterId] 효과가 있어야 한다').toBeTruthy();
    const iData = body.indexOf('setData(null)');
    const iErr = body.indexOf('setError(null)');
    const iLoad = body.indexOf('load()');
    expect(iData).toBeGreaterThanOrEqual(0);
    expect(iErr).toBeGreaterThanOrEqual(0);
    expect(iLoad).toBeGreaterThan(Math.max(iData, iErr));
  });
  it('형제 화면(StorageTrackTool)과 같은 규칙이다 — 그쪽도 비우고 시작한다', () => {
    const body = effectBody(src('StorageTrackTool.jsx'), ['days', 'vcenterId']);
    expect(body).toBeTruthy();
    expect(body).toMatch(/setData\(null\)[\s\S]*setError\(null\)[\s\S]*refresh\(\)/);
  });
});

describe('DB-01 스토리지 변경 이력 — DS 피벗 검색은 300ms 디바운스', () => {
  const code = src('StorageTrackTool.jsx');
  it('디바운스 간격은 300ms 다', () => {
    expect(code).toMatch(/const SEARCH_DEBOUNCE_MS = 300;/);
  });
  it('검색어(q)가 바뀌면 타이머로 적용값(qApplied)을 늦게 바꾸고, 이전 타이머는 지운다', () => {
    const body = effectBody(code, ['q']);
    expect(body, '[q] 효과가 있어야 한다').toBeTruthy();
    expect(body).toMatch(/setTimeout\(\s*\(\)\s*=>\s*setQApplied\(q\)\s*,\s*SEARCH_DEBOUNCE_MS\s*\)/);
    expect(body).toMatch(/clearTimeout\(/);
  });
  it('ds-pivot 조회는 적용값만 보내고, 그 효과는 원문 q 에 의존하지 않는다(글자마다 서버를 부르지 않는다)', () => {
    const i = code.indexOf("'/tools/vm-track/ds-pivot'");
    expect(i).toBeGreaterThan(0);
    const seg = code.slice(i, i + 400);
    expect(seg).toMatch(/q:\s*qApplied/);
    const deps = /\}\s*,\s*\[([^\]]*)\]\s*\)/.exec(seg);
    expect(deps).toBeTruthy();
    const list = deps[1].split(',').map((x) => x.trim());
    expect(list).toContain('qApplied');
    expect(list).not.toContain('q');
  });
  it('쪽 번호 초기화도 적용값 기준이다(입력 중에 페이지가 매 글자 0 으로 튀지 않게)', () => {
    expect(effectBody(code, ['vcenterId', 'days', 'qApplied', 'changedOnly', 'view'])).toMatch(/setPage\(0\)/);
  });
});

describe('RECENT-01(화면 쪽) 경영 보기 VM 추이 — 점검중 vCenter 를 뺀 칸은 그렸고, 그 사실을 말한다', async () => {
  const { trendNote } = await import('../execOverviewText.js');
  it('점검중 제외 칸이 있으면 각주가 칸 수와 함께 말한다(부분 합 칸은 따로)', () => {
    const t = { series: [{ ts: 1, v: 10 }, { ts: 2, v: 9, maintExcluded: 1 }, { ts: 3, v: null, partial: true }, { ts: 4, v: 9, maintExcluded: 2 }], partial: 1 };
    const note = trendNote('virtual', t);
    expect(note).toContain('일부만 집계된 1칸은 그리지 않았습니다');
    expect(note).toContain('2칸은 점검중 vCenter 를 뺀 값입니다');
  });
  it('점검중 제외가 없으면 그 문구를 붙이지 않는다', () => {
    expect(trendNote('virtual', { series: [{ ts: 1, v: 10 }, { ts: 2, v: 11 }], partial: 0 })).not.toContain('점검중');
  });
});

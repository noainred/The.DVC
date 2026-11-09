/**
 * sanStorage2948.test.js — v2.948 'SAN 스토리지 성능' 화면 규약 회귀(소스 스윕 · 전량 verify 에서 잡힌 5건을 되돌리지 않게).
 *  ① 상세 화면 폴링은 usePolling — 실시간 창만 주기 · 과거 창은 0(1회) · 수제 setInterval 없음
 *  ② usePolling 의 `intervalMs ≤ 0` 는 1회만 읽고 다시 예약하지 않는다(탭 가시화에도) — 과거 창 · 무거운 조회 규약
 *  ③ 표는 STable(날 <table> 없음) · PUT 반환값(ok:false) 판정 · 설정 메뉴 경로는 현재 묶음 이름
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(HERE, rel), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');

describe('① 상세 폴링', () => {
  const tool = strip(read('./SanStorageTool.jsx'));
  it('usePolling 으로 읽고 실시간 창만 주기 — 과거 창은 0', () => {
    // v2.954: 실시간 판정은 `live`(= 실시간 창 · 최신 창 · 임의 구간 아님) 한 변수로 — 폴링 · 알약 · 창 이동이 같은 값을 본다
    expect(tool).toMatch(/const live = range\.live && back === 0 && !custom;/);
    expect(tool).toMatch(/usePolling\(arrayKey \? '\/tools\/san-storage\/array' : null, query, live \? LIST_POLL_MS : 0, HEAVY_FETCH_OPTS\)/);
    expect(tool).not.toMatch(/\bsetInterval\(/);
    // 조회 파라미터는 useMemo — 과거 창의 from/to 가 매 렌더 바뀌면 폴러가 데이터를 비우고 계속 다시 읽는다
    // v2.954: 임의 구간(custom)이 있으면 from/to · 없으면 rangeQuery — 의존성에 custom 포함
    expect(tool).toMatch(/const query = useMemo\(\(\) => \(\{ key: arrayKey, datacenterId: dcId \|\| NONE_DC, \.\.\.\(custom \? \{ from: custom\.from, to: custom\.to \} : rangeQuery\(rangeK, \{ back \}\)\) \}\), \[arrayKey, dcId, rangeK, back, custom\]\)/);
  });
});

describe('② usePolling intervalMs ≤ 0 = 1회', () => {
  const api = read('../../api.js');
  const body = api.slice(api.indexOf('export function usePolling('));
  it('schedule 은 주기가 없으면 예약하지 않고, 탭 가시화 재조회도 주기가 있을 때만', () => {
    expect(body).toMatch(/const schedule = \(\) => \{\n\s*if \(!\(intervalMs > 0\)\) return;/);
    expect(body).toMatch(/const onVisible = \(\) => \{ if \(intervalMs > 0 && active && !forbidden/);
    // 첫 조회는 주기와 무관하게 1회 — tick().then(schedule) 구조 유지
    expect(body).toMatch(/tick\(\)\.then\(\(\) => \{ if \(active && !forbidden\) schedule\(\); \}\);/);
  });
});

describe('③ 표 · 저장 · 문구 규약', () => {
  it('날 <table> 없음 · PUT 반환값 판정 · 설정 경로', () => {
    for (const f of ['./SanStorageTool.jsx', './SanStorageCheck.jsx', './SanStorageMapping.jsx']) {
      const s = strip(read(f));
      expect(s, f).not.toMatch(/<table[\s>]/);
    }
    expect(strip(read('./SanStorageCheck.jsx'))).toMatch(/const r = await putJson\('\/tools\/san-storage\/check-settings'[\s\S]{0,80}if \(r\?\.ok === false\)/);
    expect(strip(read('./SanStorageMapping.jsx'))).toMatch(/const r = await putJson\('\/tools\/san-storage\/mapping'[\s\S]{0,80}if \(r\?\.ok === false\)/);
    expect(strip(read('./SanStorageTool.jsx'))).not.toMatch(/설정 › 수집 › /);
    expect(strip(read('./SanStorageTool.jsx'))).toMatch(/설정 › 수집 주기·임계 › SAN 스위치 포트 사용량/);
  });
});

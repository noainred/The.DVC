/**
 * commonCatalogText.test.js — 포탈 점검 › 공통 기능 화면 판정 · 문구 회귀(v3.10 · 설계 docs/design/common-catalog).
 *
 * 고정하는 것:
 *  ① 구분 집합 == 서버 `portalcheck/commonCatalog.js COMMON_SCOPES`(한쪽만 늘면 화면이 ‘구분 모름’ 을 보이거나 서버가 모듈을 버린다).
 *  ② 못 읽은 값은 0 이 아니다 — 개수 null 은 ‘—’ 이고 ‘사용처 0’·‘테스트 0’ 에 세지 않는다.
 *  ③ 찾기 — 경로 · 내보내는 이름 · 설명 · 대소문자 무시. 조건(구분 · 숫자 카드)과 함께 건다. 모르는 조건은 표를 비우지 않는다.
 *  ④ 상태 문구 — 없음 · 못 읽음은 ‘0개’ 라고 말하지 않는다. 찾는 것이 없으면 찾은 범위를 밝힌다.
 *  ⑤ 문구에 백틱 0.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SCOPE_IDS, SCOPE_LABEL, scopeLabel, baseName, dirName, countText, kpiOf, chipCounts, matchesQuery, matchesFilter,
  applyFilter, exportsView, areaLabel, areaNote, builtText, footnoteText, statusView, emptyView, filterLabel, shownText,
} from './commonCatalogText.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..', '..');

const M = (over) => ({ file: 'server/src/util/x.js', scope: 'server-util', summary: '', exports: [], users: 1, areas: 1, tests: 1, twin: null, ...over });
const LIST = [
  M({ file: 'server/src/util/deadline.js', summary: '작업 시한 — 단일 관문', exports: ['deadlineMs', 'withDeadline'], users: 20, areas: 12, tests: 1 }),
  M({ file: 'server/src/util/numOrNull.js', exports: ['numOrNull'], users: 283, areas: 59, tests: 5, twin: 'web/src/numOrNull.js' }),
  M({ file: 'web/src/numOrNull.js', scope: 'web-top', exports: ['numOrNull'], users: 131, areas: 11, tests: 2, twin: 'server/src/util/numOrNull.js' }),
  M({ file: 'server/src/util/parseWorker.js', users: 0, areas: 0, tests: 0 }),
  M({ file: 'web/src/components/Select.jsx', scope: 'web-components', exports: ['default'], users: 193, areas: 11, tests: 0 }),
  M({ file: 'web/src/hooks/broken.js', scope: 'web-hooks', users: null, areas: null, tests: null }),
  M({ file: 'server/src/config.js', scope: 'outside', summary: '요청 시한 env 정규화', users: 507, areas: 87, tests: 173 }),
  M({ file: 'web/src/views/unitText.js', scope: 'outside', users: 41, areas: 7, tests: 0 }),
];

describe('공통 기능 화면 문구', () => {
  it('① 구분 집합이 서버와 같다', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server', 'src', 'portalcheck', 'commonCatalog.js'), 'utf8');
    const m = src.match(/COMMON_SCOPES = Object\.freeze\(\[([^\]]+)\]\)/);
    expect(m, 'COMMON_SCOPES 선언을 찾지 못했다').toBeTruthy();
    const server = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    expect(server).toEqual([...SCOPE_IDS]);
    expect(Object.keys(SCOPE_LABEL)).toEqual([...SCOPE_IDS]);
    expect(scopeLabel('nope')).toBe('구분 모름');
  });

  it('② 못 읽은 값은 0 이 아니다', () => {
    expect(countText(null)).toBe('—');
    expect(countText('')).toBe('—');
    expect(countText(undefined)).toBe('—');
    expect(countText(0)).toBe('0');
    expect(countText(4088)).toBe('4,088');
    const k = kpiOf(LIST);
    // broken.js(users · tests null)는 ‘사용처 0’·‘테스트 0’ 에 들어가지 않는다.
    expect(k).toMatchObject({ total: 8, common: 6, outside: 2, outsideServer: 1, outsideWeb: 1, unused: 1, notest: 2, twins: 1 });
    expect(k.twinNames).toEqual(['numOrNull']);
    // 공용 위치 밖 모듈의 테스트 0 은 세지 않는다(문서 요약 표와 같은 기준).
    expect(matchesFilter(LIST[7], 'notest')).toBe(false);
    expect(kpiOf(null)).toMatchObject({ total: 0, common: 0, outside: 0, unused: 0, notest: 0, twins: 0 });
  });

  it('③ 찾기 · 거르기', () => {
    expect(applyFilter(LIST, { q: '시한' }).map((m) => baseName(m.file))).toEqual(['config.js', 'deadline.js']);
    expect(applyFilter(LIST, { q: 'WITHDEADLINE' }).map((m) => m.file)).toEqual(['server/src/util/deadline.js']);
    expect(applyFilter(LIST, { q: 'components/' }).length).toBe(1);
    expect(applyFilter(LIST, { q: '  ' }).length).toBe(LIST.length);
    expect(matchesQuery({ file: null, exports: null, summary: null }, 'x')).toBe(false);
    // 기본 순서 — 사용처 많은 순, 못 읽은 값은 맨 뒤.
    const all = applyFilter(LIST, {});
    expect(all[0].file).toBe('server/src/config.js');
    expect(all[all.length - 1].file).toBe('web/src/hooks/broken.js');
    expect(applyFilter(LIST, { filter: 'outside' }).length).toBe(2);
    expect(applyFilter(LIST, { filter: 'common' }).length).toBe(6);
    expect(applyFilter(LIST, { filter: 'unused' }).map((m) => baseName(m.file))).toEqual(['parseWorker.js']);
    expect(applyFilter(LIST, { filter: 'notest' }).map((m) => baseName(m.file))).toEqual(['Select.jsx', 'parseWorker.js']);
    expect(applyFilter(LIST, { filter: 'twin' }).length).toBe(2);
    expect(applyFilter(LIST, { filter: 'web-top', q: 'numornull' }).length).toBe(1);
    // 모르는 조건으로 표가 비지 않는다.
    expect(applyFilter(LIST, { filter: 'whatever' }).length).toBe(LIST.length);
    expect(chipCounts(LIST)).toEqual({ all: 8, 'server-util': 3, 'web-components': 1, 'web-hooks': 1, 'web-util': 0, 'web-top': 1, outside: 2 });
    // 원본 배열을 바꾸지 않는다(화면이 같은 배열을 여러 번 거른다).
    expect(LIST[0].file).toBe('server/src/util/deadline.js');
  });

  it('경로 · 내보내는 이름 · 영역', () => {
    expect(baseName('server/src/util/deadline.js')).toBe('deadline.js');
    expect(dirName('server/src/util/deadline.js')).toBe('server/src/util/');
    expect(dirName('x.js')).toBe('');
    expect(exportsView(['a', 'b', 'c', 'd', 'e', 'f'])).toEqual({ shown: ['a', 'b', 'c', 'd'], more: 2, total: 6 });
    expect(exportsView(null)).toEqual({ shown: [], more: 0, total: 0 });
    expect(areaLabel('server:storage')).toBe('storage');
    expect(areaLabel('web:views/tools')).toBe('views/tools');
    expect(areaLabel('scripts')).toBe('scripts');
    expect(areaNote('server/src/util/x.js')).toMatch(/server\/src/);
    expect(areaNote('web/src/api.js')).toMatch(/web\/src/);
  });

  it('④ 상태 · 빈 결과 · 안내 문구', () => {
    expect(statusView('ok')).toBeNull();
    expect(statusView('missing').title).toMatch(/실려 있지 않습니다/);
    expect(statusView('unreadable').body).toMatch(/0개라는 뜻이 아닙니다/);
    // 모르는 상태도 ‘못 읽음’ 으로 — 목록이 있는 것처럼 그리지 않는다.
    expect(statusView('weird').tone).toBe('red');
    expect(statusView(undefined)).not.toBeNull();
    const e = emptyView({ q: 'retryBackoff', filter: 'all', kpi: { outside: 77 } });
    expect(e.title).toBe('‘retryBackoff’ 와 맞는 공용 모듈이 없습니다');
    expect(e.body).toMatch(/공용 위치 밖 77개도 함께/);
    expect(emptyView({ q: 'x', filter: 'web-hooks', kpi: {} }).body).toMatch(/조건\(웹 훅\) 안에서만/);
    expect(emptyView({ q: '', filter: 'unused' }).title).toBe('이 조건에 맞는 모듈이 없습니다');
    expect(builtText({ version: '3.10.0', fileCount: 4090 })).toBe('v3.10.0 빌드 때 소스 4,090개 파일에서 만든 목록 · 이 포탈에서 다시 만들 수 없습니다');
    // 못 읽은 값은 지어내지 않는다.
    expect(builtText({ version: '', fileCount: null })).toBe('빌드할 때 소스에서 만든 목록 · 이 포탈에서 다시 만들 수 없습니다');
    expect(footnoteText({ count: 8 })).toMatch(/동적 import 8건은 세지 못했습니다/);
    expect(footnoteText(null)).toMatch(/동적 import 는 세지 못합니다/);
    expect(filterLabel('twin')).toBe('서버 · 웹 두 벌');
    expect(filterLabel('server-util')).toBe('서버 유틸');
    expect(shownText({ total: 231, matched: 231, shown: 50 })).toBe('231개 중 50개 표시 · 제목을 누르면 정렬');
    expect(shownText({ total: 231, matched: 3, shown: 3 })).toBe('231개 중 3개');
    expect(shownText({ total: 231, matched: 120, shown: 50 })).toBe('231개 중 120개가 맞고 50개 표시');
  });

  it('⑤ 문구에 백틱이 없다', () => {
    const texts = [
      statusView('missing'), statusView('unreadable'), emptyView({ q: 'a', filter: 'all', kpi: { outside: 1 } }),
    ].flatMap((v) => [v.title, v.body]).concat([
      builtText({ version: '1', fileCount: 1 }), footnoteText({ count: 0 }), footnoteText({ count: 3 }), areaNote('server/x'), areaNote('web/x'), areaNote('x'),
      ...Object.values(SCOPE_LABEL),
    ]);
    for (const t of texts) expect(t.includes('`'), t).toBe(false);
  });
});

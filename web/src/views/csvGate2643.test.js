/**
 * v2.643 — CSV 가져오기/내보내기 표시 게이팅 회귀(서버 `requirePerm('data.csv')` 의 화면 짝).
 *
 * 사용자 결정: "가져오기+내보내기 전부 — 조회용 표 CSV(GPU·게스트디스크·시리얼 조회 등)도 포함. 화면 버튼도 숨김/잠금."
 * ① 소스 스윕: CSV·텍스트·엑셀 파일 가져오기/내보내기/샘플 트리거가 있는 .jsx 는 `canCsv` 를 참조해야 한다
 *    (새 화면에 CSV 버튼을 더하면서 게이팅을 잊으면 operator·viewer 가 누르고 403 을 받는다 — 스윕이 먼저 깨진다).
 *    ⚠ 이 스윕은 '참조가 있다' 까지만 본다 — 같은 파일의 두 번째 버튼을 빠뜨린 것은 못 잡는다(정직 기록).
 * ② api.js `canCsv`·`can('data.csv')` 판정(역할·super_admin·권한 끄기).
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../test/_stripComments.js';
import { canCsv, can, setCurrentUser, CSV_DENIED_NOTE } from '../api.js';
import { menuGroups, pageShown } from './tools/ipamPages.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 사용자에게 보이는 CSV 트리거의 표지(주석 제거 후 검사).
const TRIGGER = /export\.csv|sample\.csv|\/import'|\/import`|export\.txt|\.xlsx|text\/csv|BulkDeviceIo|CvpBulkIo|CsvBulkModals/;

// 표지가 있어도 사용자 트리거가 아닌 파일 — 사유와 함께 적는다(조용한 예외 금지).
const ALLOW = new Map([
  // 현재 비어 있다. 예: ['views/foo.jsx', '경로 상수만 정의하고 버튼은 호출부(bar.jsx)가 게이팅한다'],
]);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); }
    else if (e.name.endsWith('.jsx') && !/\.test\.jsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

describe('v2.643 CSV 트리거 소스 스윕', () => {
  const files = walk(SRC);
  const hits = files
    .map((f) => ({ rel: path.relative(SRC, f).split(path.sep).join('/'), src: stripComments(fs.readFileSync(f, 'utf8')) }))
    .filter((x) => TRIGGER.test(x.src));

  it('스윕 대상이 실제로 잡힌다(정규식이 조용히 0건이 되지 않게)', () => {
    expect(hits.length).toBeGreaterThanOrEqual(30);
    const rels = hits.map((h) => h.rel);
    for (const must of ['components/CsvBulkModals.jsx', 'views/tools/BulkDeviceIo.jsx', 'views/tools/IpamCsv.jsx', 'views/svcmon/CsvTab.jsx']) {
      expect(rels).toContain(must);
    }
  });

  it('CSV 트리거가 있는 파일은 canCsv 를 참조한다(허용 목록 제외)', () => {
    const missing = hits.filter((h) => !ALLOW.has(h.rel) && !/\bcanCsv\b/.test(h.src)).map((h) => h.rel);
    expect(missing).toEqual([]);
  });

  it('허용 목록의 항목은 실재하고 사유가 있다', () => {
    for (const [rel, why] of ALLOW) {
      expect(fs.existsSync(path.join(SRC, rel))).toBe(true);
      expect(String(why).length).toBeGreaterThan(10);
    }
  });
});

describe('v2.643 api.js canCsv / can(data.csv)', () => {
  afterEach(() => setCurrentUser(null));

  it('사용자를 모르면 false(버튼을 지어내지 않는다)', () => {
    setCurrentUser(null);
    expect(canCsv()).toBe(false);
  });
  it('viewer·operator 는 권한 배열과 무관하게 false', () => {
    setCurrentUser({ username: 'v', role: 'viewer', permissions: ['tools', 'data.csv'] });
    expect(canCsv()).toBe(false);
    setCurrentUser({ username: 'o', role: 'operator', permissions: ['tools', 'data.csv'] });
    expect(canCsv()).toBe(false);
  });
  it('admin 은 data.csv 가 있으면 true, 없으면 false', () => {
    setCurrentUser({ username: 'a', role: 'admin', permissions: ['tools', 'data.csv'] });
    expect(canCsv()).toBe(true);
    setCurrentUser({ username: 'a', role: 'admin', permissions: ['tools'] });
    expect(canCsv()).toBe(false);
  });
  it('super_admin 은 권한 배열과 무관하게 true', () => {
    setCurrentUser({ username: 's', role: 'admin', superAdmin: true, permissions: [] });
    expect(canCsv()).toBe(true);
  });
  it("can('data.csv') 는 admin 이어도 권한을 본다 · can('tools') 는 admin 이면 통과", () => {
    setCurrentUser({ username: 'a', role: 'admin', permissions: ['tools'] });
    expect(can('data.csv')).toBe(false);
    expect(can('tools')).toBe(true);
    setCurrentUser({ username: 'a', role: 'admin', permissions: [] });
    expect(can('tools')).toBe(true);
  });
  it('안내 문구는 백틱·별표 없이 한 줄', () => {
    expect(CSV_DENIED_NOTE).not.toMatch(/[`*\n]/);
  });
});

describe('v2.643 IP관리 서브메뉴의 CSV 페이지', () => {
  const keys = (opts) => menuGroups('yes', opts).flatMap((g) => g.pages.map((p) => p.k));
  it('csvOk=false 면 메뉴에서 뺀다 · 생략하면 예전처럼 보인다', () => {
    expect(keys({ csvOk: false })).not.toContain('csv');
    expect(keys({ csvOk: true })).toContain('csv');
    expect(keys()).toContain('csv');
    expect(pageShown('csv', 'yes', { csvOk: false })).toBe(false);
    expect(pageShown('list', 'yes', { csvOk: false })).toBe(true);
  });
});

// v3.14.0 ⑮ 서버 집중 모니터링 앱 단위 묶음 — 순수 함수 · 화면 소스(시안 Apps · 사용자 "기본값대로 모두 구현해줘").
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { APP_COLORS, APP_REST_COLOR, appColor, appIoText, appIoTitle, appMemText, appUserText, appMembersNote } from './focusMonAppsText.js';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

describe('앱 묶음 글 · 색', () => {
  it('색은 서버가 고른 위 5개의 자리 · 그 밖은 나머지 회색', () => {
    const keys = ['a.service', 'b.service', 'c.service', 'd.service', 'e.service'];
    expect(keys.map((k) => appColor(k, keys))).toEqual(APP_COLORS);
    expect(appColor('z.service', keys)).toBe(APP_REST_COLOR);
    expect(appColor('a.service', null)).toBe(APP_REST_COLOR);
  });
  it('디스크 — 못 읽음 ‘—’(0 아님) · 일부 ‘(부분)’', () => {
    expect(appIoText({ io: 'none' })).toBe('—');
    expect(appIoText({ io: 'all', rb: 12.34, wb: 0.5 })).toBe('12.3 · 0.5 MB/s');
    expect(appIoText({ io: 'part', rb: 150, wb: 2 })).toBe('150 · 2 MB/s(부분)');
    expect(appIoTitle({ io: 'none' })).toMatch(/모름/);
  });
  it('메모리 · 계정 · 펼침 아래 줄', () => {
    expect(appMemText(null)).toBe('—'); expect(appMemText(512)).toBe('512 MB'); expect(appMemText(2048)).toBe('2 GB');
    expect(appUserText({ u: 'oracle', un: 3 })).toBe('oracle 외 2'); expect(appUserText({ u: null })).toBe('—');
    expect(appMembersNote({ n: 36 }, 6)).toMatch(/상위 30 밖에 30개/); expect(appMembersNote({ n: 2 }, 2)).toBe('');
  });
});

describe('화면 소스', () => {
  it('프로세스 탭 보기 단추에 ‘앱 단위’ · 기본은 상위 30 · 고른 보기와 기준은 기억한다(컨펌 ②)', () => {
    const tool = read('./FocusMonTool.jsx'); const apps = read('./FocusMonApps.jsx');
    expect(tool).toMatch(/\['apps', '앱 단위'\]/);
    expect(tool).toMatch(/lsGet\('fm\.procs\.view', 'all'\)/);
    expect(apps).toMatch(/lsGet\('fm\.apps\.by', 'sv'\)/);
    expect(tool).toMatch(/ids\.length > 0 && mode !== 'apps'\)/); // 앱 단위를 보는 동안 프로세스 목록을 묻지 않는다
  });
  it('서버 응답 열쇠 이름과 같다(rates.APP_* 세 이름)', () => {
    const rates = read('../../../../server/src/focusmon/rates.js');
    expect(rates).toMatch(/APP_KERNEL = '커널 스레드'/); expect(rates).toMatch(/APP_SESSION = '사용자 세션'/); expect(rates).toMatch(/APP_NOSVC = '서비스 없음'/);
    const apps = read('./FocusMonApps.jsx');
    for (const k of ['커널 스레드', '사용자 세션', '서비스 없음']) expect(apps).toContain(k);
  });
});

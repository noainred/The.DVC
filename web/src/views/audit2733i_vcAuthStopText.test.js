/**
 * audit2733i_vcAuthStopText.test.js — 인증 정지로 조회하지 않은 vCenter 문구(v2.733 점검 3회차 C3-01).
 * 서버는 정지된 vCenter 에 로그인하지 않고 결과를 비운다(null) — 화면이 그것을 '이력 없음(—)' 과 구분해 말하는지 고정한다.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authStoppedList, authStopNote, authStopCell, authStopSingleText, plainText } from './vcAuthStopText.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

describe('vcAuthStopText', () => {
  it('맵이 비었거나 모양이 아니면 아무것도 말하지 않는다', () => {
    expect(authStopNote(undefined)).toBe('');
    expect(authStopNote({})).toBe('');
    expect(authStopNote([])).toBe('');
    expect(authStoppedList(null)).toEqual([]);
  });

  it('여러 vCenter — 개수·이름·시도 수를 밝히고 조치를 말한다(시도 수를 모르면 지어내지 않는다)', () => {
    const t = authStopNote({ 'vc-b': { attempts: 3 }, 'vc-a': { attempts: null }, 'vc-c': { attempts: '' } });
    expect(t).toContain('**인증 실패로 멈춘 vCenter** 3곳');
    expect(t).toContain('‘vc-a’ · ‘vc-b’ 실패 3회 · ‘vc-c’');   // 정렬 · 0·빈 값은 시도 수를 붙이지 않는다
    expect(t).not.toContain('실패 0회');
    expect(t).toContain('연결 테스트가 성공하면 다시 조회합니다');
  });

  it('6곳 이상이면 5곳만 적고 나머지는 개수로', () => {
    const m = Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((x) => [`vc-${x}`, { attempts: 1 }]));
    const t = authStopNote(m);
    expect(t).toContain('7곳');
    expect(t).toContain(' 외 2곳');
    expect(t).not.toContain('‘vc-f’');
  });

  it('칸 문구는 이력 없음(—)과 다르고, 단일 응답 문구는 강조만 쓴다', () => {
    const c = authStopCell({ attempts: 2 });
    expect(c.text).toBe('인증 정지');
    expect(c.text).not.toBe('—');
    expect(c.title).toContain('(실패 2회)');
    expect(authStopCell(null).title).not.toMatch(/실패 \d+회/);
    expect(authStopSingleText(null)).toBe('');
    expect(authStopSingleText({ attempts: 1 })).toMatch(/^\*\*vCenter 인증 실패로 조회를 멈췄습니다\*\*\(실패 1회\)/);
    expect(plainText('**a** b')).toBe('a b');
  });

  it('문구 모듈에 백틱이 없다(BoldText 는 **강조** 만 해석한다)', () => {
    const src = fs.readFileSync(path.join(HERE, 'vcAuthStopText.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // 템플릿 리터럴 구분자 외의 백틱(문구 안 백틱)은 \` 형태로만 들어갈 수 있다.
    expect(src.includes('\\`')).toBe(false);
  });

  it('세 화면이 서버의 authStopped 를 그린다(스파크라인·VM 트리 기간 사용률·호스트/클러스터 추이·유휴 VM 평균)', () => {
    const read = (rel) => fs.readFileSync(path.join(HERE, rel), 'utf8');
    const cap = read('tools/CapacityTools.jsx');
    expect(cap).toMatch(/r\.authStopped/);                         // 배치 응답의 vCenter 별 정지를 모은다
    expect(cap).toMatch(/stop=\{spark\.stops\[v\.vcenterId\]\}/); // 행 칸이 '—' 대신 정지를 말한다
    expect(cap).toMatch(/authStopNote\(spark\.stops\)/);           // 각주
    const vcd = read('VCenterDetail.jsx');
    expect(vcd).toMatch(/d\.authStopped/);                          // 추이 탭
    expect(vcd).toMatch(/authStopSingleText\(/);
    expect(vcd).toMatch(/usageInfo\.authStopped/);                  // 트리 행
    const vf = read('tools/VmFinderTool.jsx');
    expect(vf).toMatch(/authStopNote\(data\.authStopped\)/);
  });
});

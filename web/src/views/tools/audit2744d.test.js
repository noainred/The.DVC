/**
 * audit2744d.test.js — v2.744 감사 EDGE-01: 파트 장애 보류 사유 '수집 서버 등록부 손상'(registry-unreadable) 문구.
 *
 * 서버 전이(server/src/partfault/transition.js HOLD_REGISTRY_UNREADABLE)가 내는 코드와 이 화면 문구가 1:1 이어야 한다 —
 * 문구가 없으면 행의 보류 칸이 비고 배너 합계에서도 빠져 '왜 열려 있나' 를 말하지 못한다(조용한 누락).
 * 이 사유는 '재배정·등록 삭제(unassigned)' 와 조치가 다르다 — 사람이 닫을 일이 아니라 그 수집 서버의 등록 파일을 고칠 일이다.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { holdText, holdNote } from './partFaultText.js';

const here = path.dirname(new URL(import.meta.url).pathname);

describe('v2.744 EDGE-01 — registry-unreadable 보류 문구', () => {
  it('서버 전이 코드와 같은 글자의 문구가 있다', () => {
    const src = fs.readFileSync(path.join(here, '../../../../server/src/partfault/transition.js'), 'utf8');
    const m = /HOLD_REGISTRY_UNREADABLE\s*=\s*HOLD_REASON\.registryUnreadable\s*\|\|\s*'([^']+)'/.exec(src);
    expect(m, '서버 상수 정의를 찾는다').toBeTruthy();
    const code = m[1];
    expect(code).toBe('registry-unreadable');
    const t = holdText(code);
    expect(t).toMatch(/등록부/);
    expect(t).not.toMatch(/재배정|삭제|닫기/);   // unassigned 의 조치를 안내하지 않는다
  });

  it('배너가 개수를 세고 해소로 처리하지 않았다고 말한다 · unassigned 와 따로 센다', () => {
    const note = holdNote([
      { holdReason: 'registry-unreadable' }, { holdReason: 'registry-unreadable' }, { holdReason: 'unassigned' },
    ]);
    expect(note).toMatch(/판정 보류 3건/);
    expect(note).toMatch(/장비 등록부 손상 2건/);
    expect(note).toMatch(/더는 보고하지 않는 장비 1건/);
    expect(note).toMatch(/해소로 처리하지 않았습니다/);
  });

  it('문구에 백틱이 없다(BoldText 는 별표 강조만 해석한다)', () => {
    expect(holdText('registry-unreadable')).not.toMatch(/`/);
    expect(holdNote([{ holdReason: 'registry-unreadable' }])).not.toMatch(/`/);
  });
});

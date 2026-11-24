// 161회차 추정 E1(메인 확정 · Chromium 실측): 스냅샷 표의 최소 폭 1,180px 이 1440px 화면(사이드바 펼침)의 표 상자 1,122px 보다 58px 넓어,
//   정상 상태에서도 오른쪽(신호 칩 셋째 · ‘VM 상세 열기’ · 보류 안내 끝)이 상자 안 가로 스크롤 뒤에 가려졌다(v2.780 과 같은 꼴 — 1440 에서 표 열이 숨음).
//   161회차가 ‘만든 계정’ 줄을 접게 한 뒤에는 칸들이 줄어들 수 있다 — 최소 폭을 1,120px 로 내리면 1440 에서 표 = 상자(1,122 · 가로 스크롤 0 · 상자 밖 요소 0개).
//   1280 이하에서는 예전처럼 상자 안에서 가로로 민다(문서 가로 넘침 없음). 배치는 브라우저로만 확인된다 — 여기서는 최소 폭이 다시 커지지 않게만 고정한다.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { stripComments } from '../../../test/_stripComments.js';

const SRC = stripComments(fs.readFileSync(new URL('./SnapshotTool.jsx', import.meta.url), 'utf8'));

describe('161 E1 — 스냅샷 표 최소 폭은 1440 화면의 표 상자(1,122px) 안', () => {
  it('본표(snp-tbl 첫 표)의 minWidth 가 1,122 이하다', () => {
    const all = [...SRC.matchAll(/<STable className="snp-tbl" minWidth=\{(\d+)\}>/g)].map((m) => Number(m[1]));
    expect(all.length).toBeGreaterThanOrEqual(2);   // 본표 · ‘정리된 것’ 표
    for (const w of all) expect(w).toBeLessThanOrEqual(1122);
  });
});

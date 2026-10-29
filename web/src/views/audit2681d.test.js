/**
 * v2.681 감사(R2C-03~05) 회귀 — IP 스캔 설정 재적재 · PDU 재조회 · 저장소 접근.
 * v2.747: version_6/ 에서 옮겼다 — V5·V6 셸 삭제로 R2C-01(V6 법인 카드)·R2C-02(V5 Overview) 검사는 지웠다.
 * 순수 함수는 값으로, 컴포넌트 전용 수정은 소스로 고정한다(웹 테스트는 node 환경이라 렌더를 못 한다).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { stripComments } from '../test/_stripComments.js';

const read = (p) => stripComments(fs.readFileSync(new URL(p, import.meta.url), 'utf8'));

describe('R2C-03 IP 스캔 설정 — 첫 조회 실패 뒤 폴링 성공이 폼을 채운다', () => {
  const src = read('../views/tools/IpScanSettings.jsx');
  it('성공 경로가 오류를 지우고, 폼을 채운 에이전트가 다르면 다시 채운다', () => {
    expect(src).toMatch(/else if \(formForRef\.current !== ag\) \{ d\.load\(r\.settings\); setSFor\(ag\); \}\s*formForRef\.current = ag;\s*setLoadErr\(null\);/);
  });
});

describe('R2C-04 PDU — 재조회 동안 직전 데이터를 그린다', () => {
  const src = read('../views/tools/PduTool.jsx');
  it('직전 데이터 ref + data = pollData ?? 직전', () => {
    expect(src).toMatch(/if \(pollData\) lastDataRef\.current = pollData;/);
    expect(src).toMatch(/const data = pollData \?\? lastDataRef\.current;/);
  });
});

describe('R2C-05 localStorage 접근은 try 안에서', () => {
  it('App 랜딩 탭 읽기·저장', () => {
    const src = read('../App.jsx');
    expect(src).toMatch(/try \{\s*const saved = localStorage\.getItem\(LANDING_KEY\);/);
    expect(src).toMatch(/try \{ localStorage\.setItem\(LANDING_KEY, id\); \} catch/);
  });
  it('SvcMonitor 왼쪽 폭', () => {
    expect(read('../views/SvcMonitor.jsx')).toMatch(/try \{ return Number\(localStorage\.getItem\(LEFT_W_KEY\)\)/);
  });
});

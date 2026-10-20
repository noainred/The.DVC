/**
 * v2.628 감사(WEB2628-02·06·07) 회귀 — Summary 법인 기여도 계산 + 베어메탈 사용률·원격 접속 화면 소스 검사.
 * v2.747: version_6/ 에서 옮겼다 — V6 셸 삭제로 V6 전용(총 소비전력 타일·서버 메뉴·게이지·V6 Overview) 검사는 지웠다.
 * 순수 함수는 값으로, 컴포넌트 전용 수정은 소스로 고정한다(웹 테스트는 node 환경이라 렌더를 못 한다).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { stripComments } from '../test/_stripComments.js';
import { corpContribution, vcStatusLabel } from './corpContribution.js';

const read = (p) => stripComments(fs.readFileSync(new URL(p, import.meta.url), 'utf8'));

describe('WEB2628-02 법인별 기여도 합계', () => {
  const S = { byVcenter: [
    { id: 'a', status: 'connected', hosts: 3, vms: 10, powerKw: 1.5 },
    { id: 'b', status: 'pending', hosts: 0, vms: 0, powerKw: 0 },
    { id: 'c', status: 'unreachable', hosts: 0, vms: 0, powerKw: 0 },
    { id: 'd', hosts: 2, vms: 4, powerKw: 1 }, // status 없는 옛 응답 — 연결로 본다
  ] };
  it('연결되지 않은 행은 수치가 null 이고 상태 라벨을 단다', () => {
    const c = corpContribution(S);
    const b = c.rows.find((r) => r.id === 'b');
    expect(b.hosts).toBe(null); expect(b.powerKw).toBe(null); expect(b.statusLabel).toBe('첫 수집 중');
    expect(c.rows.find((r) => r.id === 'c').statusLabel).toBe('연결 불가');
    expect(c.rows.find((r) => r.id === 'a').statusLabel).toBe(null);
  });
  it('합계는 연결된 행만, 뺀 개수를 돌려준다', () => {
    const c = corpContribution(S);
    expect(c.total.hosts).toBe(5);
    expect(c.total.powerKw).toBe(2.5);
    expect(c.excluded).toBe(2);
    expect(c.missing.hosts).toBe(2);
  });
  it('상태 라벨 판정', () => {
    expect(vcStatusLabel('disabled')).toBe('비활성');
    expect(vcStatusLabel('connected')).toBe(null);
    expect(vcStatusLabel(undefined)).toBe(null);
  });
  it('값이 있는 행만 합한다 — 전부 없으면 null(옛 v6Data.test)', () => {
    expect(corpContribution({ byVcenter: [{ id: 'x', hosts: 2, powerKw: null }, { id: 'y', hosts: 3, powerKw: 2 }] }).total).toMatchObject({ hosts: 5, powerKw: 2 });
    expect(corpContribution({ byVcenter: [{ powerKw: null }] }).total.powerKw).toBe(null);
  });
  it('Summary 화면이 뺀 개수를 합계 행에 말한다', () => {
    const src = read('./Summary.jsx');
    // v2.721(감사 R2-04): 표시 조건은 contribNote 문장 자체(excluded 를 포함한 모든 사유를 그 함수가 말한다).
    expect(src).toMatch(/contribNote\(contrib\) &&/);
    expect(src).toMatch(/r\.statusLabel/);
  });
});

describe('WEB2628-06·07 컴포넌트 소스', () => {
  it('BmUsage load 는 세대 가드가 있고 숫자 칸은 서버 값으로 되돌린다', () => {
    const src = read('../views/tools/BmUsage.jsx');
    expect(src).toMatch(/const gen = \+\+loadGen\.current/);
    expect(src).toMatch(/if \(gen !== loadGen\.current\) return;/);
    expect(src).toMatch(/loadGen\.current \+= 1/);
    expect(src).toMatch(/input\.value = String\(Math\.round\(v \/ scale\)\)/);
  });
  it('RemoteAccess — 목록 실패를 없음으로 보이지 않고, 데이터가 있으면 전체 오류로 바꾸지 않는다', () => {
    const src = read('../views/RemoteAccess.jsx');
    expect(src).not.toMatch(/\.catch\(\(\) => setProxies\(\[\]\)\)/);
    expect(src).toMatch(/if \(error && !data\) return <ErrorBox/);
    expect(src).not.toMatch(/if \(error\) return <ErrorBox/);
    expect((src.match(/<STable minWidth=\{\d+\}/g) || []).length).toBe(2);
  });
});

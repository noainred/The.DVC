/**
 * v2.628 감사(WEB2628-01~07) 회귀 — V6 Summary·Overview 계산 + 베어메탈 사용률·원격 접속 화면 소스 검사.
 * 순수 함수는 값으로, 컴포넌트 전용 수정은 소스로 고정한다(웹 테스트는 node 환경이라 렌더를 못 한다).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { stripComments } from '../test/_stripComments.js';
import { totalTiles, corpContribution, serverCorpRows, usageGauges, vcStatusLabel } from './v6Data.js';

const read = (p) => stripComments(fs.readFileSync(new URL(p, import.meta.url), 'utf8'));
const powerOf = (s) => totalTiles(s).find((t) => t.label === '총 소비전력');

describe('WEB2628-01 총 소비전력', () => {
  it('보고 호스트 0대면 0 kW 가 아니라 —', () => {
    const t = powerOf({ power: { kw: 0, watts: 0, reporting: 0 }, counts: { hosts: 10 } });
    expect(t.value).toBe('—');
    expect(t.note).toMatch(/보고 호스트 없음/);
  });
  it('reporting 이 없는 옛 응답의 0 도 — (양수만 값으로 믿는다)', () => {
    expect(powerOf({ power: { kw: 0 } }).value).toBe('—');
    expect(powerOf({ power: { kw: 3.5 } }).value).toBe('3.5 kW');
  });
  it('일부만 보고하면 부분 합이라고 밝힌다', () => {
    const t = powerOf({ power: { kw: 12.3, reporting: 4 }, counts: { hosts: 10 } });
    expect(t.value).toBe('12.3 kW');
    expect(t.note).toBe('보고 4/10대 합계');
    expect(powerOf({ power: { kw: 12.3, reporting: 10 }, counts: { hosts: 10 } }).note).toBe('');
  });
});

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
  it('Summary 화면이 뺀 개수를 합계 행에 말한다', () => {
    const src = read('./pages/Summary.jsx');
    expect(src).toMatch(/contrib\.excluded/);
    expect(src).toMatch(/r\.statusLabel/);
  });
});

describe('WEB2628-04 호스트당 VM', () => {
  it('VM 수를 모르면 0 이 아니라 null', () => {
    expect(serverCorpRows({ sites: [{ id: 'x', metrics: { hosts: 4, vms: null } }] })[0].perHost).toBe(null);
    expect(serverCorpRows({ sites: [{ id: 'x', metrics: { hosts: 4, vms: 10 } }] })[0].perHost).toBe(2.5);
  });
});

describe('WEB2628-05 게이지 문구 분모', () => {
  it('서버가 준 읽은 호스트 용량을 분모로 쓰고 전체 용량은 따로 밝힌다', () => {
    const [cpu, mem] = usageGauges({ cpuUsedGhz: 50, cpuTotalGhz: 200, cpuTotalReadableGhz: 100, cpuUsagePct: 50,
      memUsedGB: 10, memTotalGB: 100, memTotalReadableGB: 40, memUsagePct: 25, hostsUsageExcluded: 3 });
    expect(cpu.used).toBe('50 / 100 GHz');
    expect(cpu.note).toMatch(/전체 200 GHz/);
    expect(mem.used).toBe('10 / 40 GB');
  });
  it('읽은 호스트 용량이 없는 옛 응답은 전체 용량임을 밝힌다', () => {
    const [cpu] = usageGauges({ cpuUsedGhz: 50, cpuTotalGhz: 200, cpuUsagePct: 50, hostsUsageExcluded: 3 });
    expect(cpu.used).toBe('50 / 200 GHz');
    expect(cpu.note).toMatch(/끊긴 호스트 포함 전체 용량/);
  });
  it('제외가 없으면 추가 문구가 없다', () => {
    const [cpu] = usageGauges({ cpuUsedGhz: 50, cpuTotalGhz: 100, cpuTotalReadableGhz: 100, cpuUsagePct: 50, hostsUsageExcluded: 0 });
    expect(cpu.used).toBe('50 / 100 GHz'); expect(cpu.note).toBe('');
  });
});

describe('WEB2628-03·06·07 컴포넌트 소스', () => {
  it('Overview 는 /alarms 오류를 받아 표시한다', () => {
    const src = read('./pages/Overview.jsx');
    expect(src).toMatch(/error:\s*alarmsErr\s*\}\s*=\s*usePolling\(canAlarms/);
    expect(src).toMatch(/alarmsErr && !alarms \? <ErrorBox/);
  });
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

// v2.766 점검 R1 수정 그룹 G3 — 웹 화면. A3-01·A3-03 은 veeamBadge.test.js(agentAfterVcToggle·formAfterSave),
// 여기서는 A3-05 순수 함수와 A3-02·A3-04 JSX 소스 검사(node 환경이라 렌더할 수 없다 — audit2611d 와 같은 방식).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { veeamBasisText } from './VeeamParts.jsx';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..');
// 주석을 지운 소스(주석 속 설명이 통과 근거가 되지 않게 — v2.535 규약).
const code = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8')
  .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|\s)\/\/[^\n]*/g, '$1');

describe('R1-A3-05 Veeam 상세 근거 문구 — 성공한 적 없는 서버에 마지막 성공분이라 말하지 않는다', () => {
  it('실패 중이고 마지막 성공이 있으면 마지막 성공분 · 없으면 성공한 적 없음', () => {
    const now = Date.UTC(2026, 9, 23, 3);
    expect(veeamBasisText([{ name: 'A', ok: false, lastOkTs: now }])).toBe('A(읽기 실패 — 마지막 성공분)');
    expect(veeamBasisText([{ name: 'B', ok: false, lastOkTs: null }])).toBe('B(읽기 실패 — 성공한 적 없음)');
    expect(veeamBasisText([{ name: 'B', ok: false }])).toBe('B(읽기 실패 — 성공한 적 없음)');
  });
  it('성공·아직 안 읽음(ok null)은 이름만 · 여러 대는 쉼표 · 비면 빈 문자열', () => {
    expect(veeamBasisText([{ name: 'A', ok: true, lastOkTs: 1 }, { name: 'C', ok: null, lastOkTs: null }, { name: 'B', ok: false, lastOkTs: null }]))
      .toBe('A, C, B(읽기 실패 — 성공한 적 없음)');
    expect(veeamBasisText([])).toBe('');
    expect(veeamBasisText(undefined)).toBe('');
  });
  it('화면은 이 함수 하나로 그린다(예전 인라인 판정이 남아 있지 않다)', () => {
    const s = code('views/VeeamParts.jsx');
    expect(s).toMatch(/const basis = veeamBasisText\(d\?\.servers\)/);
    expect(s).not.toMatch(/s\.ok === false \? '\(읽기 실패 — 마지막 성공분\)' : ''/);
    expect(veeamBasisText([{ name: 'x', ok: false }, { name: 'y', ok: false, lastOkTs: 1 }])).not.toMatch(/`/);
  });
});

describe('R1-A3-04 vCenter 로그 보관 — 늦게 온 이전 상태 응답은 버린다', () => {
  const s = code('views/VcenterLogs.jsx');
  it('loadStatus 는 순번을 올리고 응답·오류 모두 최신 순번일 때만 반영한다', () => {
    const body = s.slice(s.indexOf('const loadStatus'), s.indexOf('useEffect(() => { loadStatus()'));
    expect(body).toMatch(/const my = \+\+statusSeq\.current/);
    expect(body).toMatch(/\.then\(\(r\) => \{ if \(my !== statusSeq\.current\) return; setSt\(r\)/);
    expect(body).toMatch(/\.catch\(\(e\) => \{ if \(my !== statusSeq\.current\) return; setErr/);
    expect(body).toMatch(/return fetchJson\(/);
  });
  it('순번 ref 는 조기 return 위에 있고 언마운트 때 순번을 올린다', () => {
    const fn = s.slice(s.indexOf('export default function VcenterLogs'));
    const early = fn.indexOf('if (err) return');
    expect(fn.indexOf('const statusSeq = useRef(0)')).toBeGreaterThan(-1);
    expect(fn.indexOf('const statusSeq = useRef(0)')).toBeLessThan(early);
    expect(fn).toMatch(/clearInterval\(t\); statusSeq\.current \+= 1;/);
  });
});

describe('R1-A3-02 ESXi 호스트 CPU 카드 부제 — 사실에 맞는 문구', () => {
  const s = code('views/Hosts.jsx');
  it('같은 기준이라 하지 않고 같은 임계값 · 점검 중 호스트 포함이라 말한다(서버 high-cpu 는 점검 호스트를 뺀다)', () => {
    expect(s).not.toMatch(/서버 경보\(high-cpu\)와 같은 기준/);
    expect(s).toMatch(/sub: `서버 경보와 같은 임계값\(\$\{CPU_ATTENTION_PCT\}% 초과\) · 점검 중 호스트 포함`/);
  });
});

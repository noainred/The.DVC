// v2.611 수정 그룹 D — 웹 화면(CVP·iDRAC 제외). 순수 판정은 virtRatioText.test.js,
// 여기서는 JSX 소스 검사(node 환경이라 렌더할 수 없다 — audit2606e 와 같은 방식).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..');
// 주석을 지운 소스(주석 속 설명이 통과 근거가 되지 않게 — v2.535 규약).
const code = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8')
  .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|\s)\/\/[^\n]*/g, '$1');

describe('WEB2611-06 가상화율 — 분모 0 을 초록 정상으로 칠하지 않는다', () => {
  const s = code('views/Summary.jsx');
  it('판정은 virtRatioText 하나가 소유한다', () => {
    expect(s).toMatch(/from '\.\/virtRatioText\.js'/);
    expect(s).toMatch(/ratioBadge\(vc\.ratio, kind\)/);
    expect(s).toMatch(/ratioLabel\(/);
  });
  it('예전 인라인 판정(분모 0 → 0, 배지 amber/green 이분)이 남아 있지 않다', () => {
    expect(s).not.toMatch(/vc\.ratio > HI \? 'amber' : 'green'/);
    expect(s).not.toMatch(/:\s*0\)\s*;?\s*\n?\s*:\s*\(vc\)/);
    expect(s).not.toMatch(/\(vc\[key\] \|\| 0\)\.toLocaleString/);
    expect(s).not.toMatch(/`\$\{al\.vcpuPerCore\} : 1`/);
  });
});

describe('WEB2611-07 세대 가드 — 늦게 온 이전 응답은 버린다', () => {
  it('감사 로그: 디바운스 + active 플래그', () => {
    const s = code('views/Audit.jsx');
    expect(s).toMatch(/setTimeout\(\(\) => setQDeb\(q\), 300\)/);
    expect(s).toMatch(/let active = true/);
    expect(s).toMatch(/return \(\) => \{ active = false; \}/);
    expect(s).toMatch(/\[user, qDeb, limit\]/);
  });
  it('라이선스 만료: 세대 ref', () => {
    const s = code('views/tools/LicenseTools.jsx');
    expect(s).toMatch(/const gen = \+\+licGen\.current/);
    expect(s).toMatch(/gen === licGen\.current/);
  });
  it('실제 OS 스캔 결과: 세대 ref + 실패를 빈 목록으로 만들지 않음', () => {
    const s = code('views/tools/GuestOsTools.jsx');
    expect(s).toMatch(/const gen = \+\+resGen\.current/);
    expect(s).not.toMatch(/catch\(\(\) => \{ setRows\(\[\]\)/);
    expect(s).toMatch(/setResErr\(/);
  });
  it('NIC 속도·모델: 두 곳 모두 active 플래그', () => {
    const s = code('views/tools/NicTools.jsx');
    expect((s.match(/let active = true/g) || []).length).toBe(2);
    expect(s).not.toMatch(/const load = \(\) =>/);
  });
  it('VMware 구성 백업: vCenter 를 바꾼 뒤 실패하면 이전 미리보기를 비운다', () => {
    const s = code('views/DavinciChecks.jsx');
    expect(s).toMatch(/if \(active\) \{ setPreview\(null\);/);
    expect(s).not.toMatch(/\.then\(setPreview\)/);
  });
});

describe('WEB2611-08 조회·삭제 실패를 없음·무반응으로 보이지 않게', () => {
  const files = [
    'views/gpu-guest/PhysicalGpuManager.jsx',
    'views/VmProvision.jsx',
    'views/RemoteAccess.jsx',
    'views/ProxySettings.jsx',
    'views/AgentDeploy.jsx',
  ];
  it.each(files)('%s: delJson(...).catch(() => {}) 0건', (f) => {
    expect(code(f)).not.toMatch(/delJson\([^;]*?\)\.catch\(\(\) => \{\}\)/);
  });
  it('물리 GPU 목록 조회 실패는 loadErr 로 따로 든다', () => {
    const s = code('views/gpu-guest/PhysicalGpuManager.jsx');
    expect(s).not.toMatch(/fetchJson\('\/admin\/gpu-physical'\)\.then\(setD\)\.catch\(\(\) => \{\}\)/);
    expect(s).toMatch(/setLoadErr\(/);
    expect(s).not.toMatch(/postJson\('\/admin\/gpu-physical\/poll', \{\}\)\.catch\(\(\) => \{\}\)/);
  });
  it('저장된 작업 조회 실패를 빈 목록으로 만들지 않는다', () => {
    const s = code('views/VmProvision.jsx');
    expect(s).not.toMatch(/setData\(\{ total: 0, items: \[\], vcenters: \[\] \}\)/);
    expect(s).toMatch(/저장된 작업이 없다는 뜻이 아닙니다/);
  });
});

describe('WEB2611-09·10', () => {
  it('GPU 진단 mem 결측은 단위 없이 —', () => {
    const s = code('views/GpuGuestDiag.jsx');
    expect(s).not.toMatch(/r\.mem \?\? '-'\}%/);
    expect(s).toMatch(/unitText\(r\.mem, '%'\)/);
    expect(s).toMatch(/unitText\(r\.gpus, 'GPU'\)/);
  });
  it('긴 경로 <code> 는 줄바꿈 지점을 준다', () => {
    expect(code('views/SanSwitchPerf.jsx')).toMatch(/<code style=\{\{ overflowWrap: 'anywhere' \}\}>\{db\.file\}/);
    expect(code('views/SecuritySelfCheck.jsx')).toMatch(/<code style=\{\{ overflowWrap: 'anywhere' \}\}>\{c\.evidence\}/);
  });
});

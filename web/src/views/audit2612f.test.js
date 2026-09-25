// v2.612 수정 그룹 F — 웹 화면. 순수 판정은 hzListText·droppedSecretText·scanRunText·queryKeyText 테스트,
// 여기서는 JSX 소스 검사(node 환경이라 렌더할 수 없다 — audit2611d 와 같은 방식).
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

describe('WEB2612-01 IPAM — 서브넷·시트 조회 실패를 0개·빈 시트로 삼키지 않는다', () => {
  const s = code('views/tools/IpamCore.jsx');
  it('빈 목록 폴백이 없다', () => {
    expect(s).not.toMatch(/catch\(\(\) => \(\{ subnets: \[\] \}\)\)/);
    expect(s).not.toMatch(/setSubnets\(\[\]\)/);
    expect(s).not.toMatch(/sheet\?base=[^\n]*\.catch\(\(\) => null\)/);
  });
  it('실패 상태를 두고 KPI 는 — 로 말한다', () => {
    expect(s).toMatch(/setSubnetsErr\(e\?\.message/);
    expect(s).toMatch(/setSheetErr\(err\)/);
    expect(s).toMatch(/value=\{subnetsErr \? '—' : subnets\.length\}/);
  });
});

describe('WEB2612-02 스토리지 증가량 — 늦게 온 이전 기간 응답은 버린다', () => {
  const s = code('views/tools/StorageGrowthTool.jsx');
  it('then·catch·finally 모두 세대 확인', () => {
    expect(s).toMatch(/const gen = \+\+loadGen\.current/);
    expect((s.match(/gen === loadGen\.current/g) || []).length).toBe(3);
  });
});

describe('WEB2612-03 베어메탈 상세 — 다른 서버·기간 응답을 버리고 실패를 패널에서 말한다', () => {
  const s = code('views/tools/BmUsage.jsx');
  it('세대 가드', () => {
    expect(s).toMatch(/const gen = \+\+detailGen\.current/);
    expect(s).toMatch(/if \(gen === detailGen\.current\) setDetail\(d\)/);
    expect(s).toMatch(/finally \{ if \(gen === detailGen\.current\) setDetailLoading\(false\)/);
  });
  it('실패하면 영원히 불러오는 중이 아니라 사유', () => {
    expect(s).toMatch(/setDetailErr\(e\?\.message/);
    expect(s).toMatch(/!detail && !detailErr && <p/);
    expect(s).toMatch(/추이를 읽지 못했습니다/);
  });
});

describe('WEB2612-04 Horizon 등록 목록 — 요약은 hzSummary 하나', () => {
  const s = code('views/tools/LicenseTools.jsx');
  it('403 이 아닌 실패를 기록하고 0대로 칠하지 않는다', () => {
    expect(s).toMatch(/else setHzErr\(/);
    expect(s).toMatch(/hzSummary\(hz, hzErr\)\.label/);
    expect(s).not.toMatch(/\(\{\(hz \|\| \[\]\)\.length\}대 등록\)/);
  });
});

describe('WEB2612-06 스캔 잡 결과 — 잡 표·로그가 HPE·계정 없음을 말한다', () => {
  it('잡 표와 로그 모달이 scanJobResultText 를 쓴다', () => {
    expect(code('views/idrac/IdracScanJobs.jsx')).toMatch(/scanJobResultText\(j\.result\)/);
    expect(code('views/idrac/ScanJobLogModal.jsx')).toMatch(/scanJobResultText\(d\.result\)/);
    expect(code('views/idrac/IdracScanJobs.jsx')).not.toMatch(/발견 \{j\.result\?\.foundCount \?\? 0\}/);
  });
});

describe('WEB2612-08 보고서 관리 섹션 — 설정 조회 실패를 삼키지 않는다', () => {
  const s = code('views/ToolsReports.jsx');
  it('두 조회 모두 오류 상태로', () => {
    expect(s).not.toMatch(/fetchJson\('\/admin\/report\/daily'\)\.then\(setSched\)\.catch\(\(\) => \{\}\)/);
    expect(s).not.toMatch(/fetchJson\('\/admin\/alerts'\)[^\n]*\.catch\(\(\) => \{\}\)/);
    expect(s).toMatch(/adminLoadErr\('일일 보고 설정', schedErr\)/);
    expect(s).toMatch(/adminLoadErr\('알림 채널 설정', cfgErr\)/);
  });
});

describe('WEB2612-09 다열 표 — minWidth 를 준다(400px 에서 열이 짜부라지지 않게)', () => {
  const cases = [
    ['views/tools/LinkCheck.jsx', 2], ['views/tools/PortalCheck.jsx', 1], ['views/tools/SanHealthCheck.jsx', 2],
    ['views/tools/PartFaults.jsx', 2], ['views/idrac/IdracDetailModal.jsx', 3],
  ];
  for (const [f, n] of cases) {
    it(f, () => {
      expect((code(f).match(/<STable[^>]*minWidth=\{\d+\}/g) || []).length).toBeGreaterThanOrEqual(n);
    });
  }
});

describe('RECENT2612-06 필터를 바꾼 뒤 실패하면 이전 선택의 행을 남기지 않는다', () => {
  it('실제 OS 스캔 결과', () => {
    const s = code('views/tools/GuestOsTools.jsx');
    expect(s).toMatch(/if \(!keepRowsOnError\(rowsKey\.current, key\)\) \{ rowsKey\.current = null; setRows\(null\)/);
  });
  it('저장된 프로비저닝 작업', () => {
    const s = code('views/VmProvision.jsx');
    expect(s).toMatch(/if \(!keepRowsOnError\(dataKey\.current, key\)\) \{ dataKey\.current = null; setData\(null\)/);
  });
});

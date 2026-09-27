// v2.630 그룹 e — R2630-02 · UI2630-01(R2630-05) · UI2630-02 · UI2630-03(웹).
// 기준 시각을 쓰지 않는다(순수 판정만). 소스 스윕은 주석을 먼저 지운다(web/src/test/_stripComments.js).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../test/_stripComments.js';
import { contribRowKind, corpContribution, contribNote } from '../version_6/v6Data.js';
import { scopeOmitNote, roomSparkScopeNote } from './scopeOmitText.js';
import { listOmittedNote, reclaimMeta, toolsKpiMeta, reclaimBasisNote } from './toolsReportText.js';
import { edgeCardKind, edgeCardWarn, edgeCardMeta, edgeNoReportTotal } from './svcmon/edgeCardText.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (rel) => stripComments(fs.readFileSync(path.join(here, rel), 'utf8'));

describe('R2630-02 V6 기여도 — 점검 중이어도 값이 없으면 직전 값이 아니다', () => {
  it('점검 중 · 호스트·VM 0 → none(값 모름), 값이 있으면 carried', () => {
    expect(contribRowKind({ status: 'maintenance', hosts: 0, vms: 0 })).toBe('none');
    expect(contribRowKind({ status: 'maintenance' })).toBe('none');
    expect(contribRowKind({ status: 'maintenance', hosts: 3, vms: 0 })).toBe('carried');
    expect(contribRowKind({ status: 'maintenance', hosts: 0, vms: 7 })).toBe('carried');
  });
  it('합계에서 빼고 행 수치는 null · 라벨에 직전 값이라 말하지 않는다', () => {
    const c = corpContribution({ byVcenter: [
      { id: 'a', status: 'connected', hosts: 5, vms: 10 },
      { id: 'm', status: 'maintenance', hosts: 0, vms: 0 },
    ] });
    const m = c.rows.find((r) => r.id === 'm');
    expect(m.hosts).toBe(null);
    expect(m.statusLabel).toBe('점검 중');
    expect(c.total.hosts).toBe(5);
    expect(c.excluded).toBe(1);
    expect(c.carried).toBe(0);
    expect(contribNote(c)).toMatch(/점검 중/);
  });
});

describe('UI2630-01 범위 계정 제외 안내', () => {
  it('범위 계정 + 뺀 개수 > 0 일 때만 문구', () => {
    expect(scopeOmitNote({ scoped: true, omittedOutOfScope: 3 })).toMatch(/서버 3대/);
    expect(scopeOmitNote({ scoped: true, omittedOutOfScope: 0 })).toBe(null);
    expect(scopeOmitNote({ omittedOutOfScope: 3 })).toBe(null); // 전체 범위 계정 — 필드가 와도 scoped 없으면 말하지 않는다
    expect(scopeOmitNote(null)).toBe(null);
    expect(scopeOmitNote({ scoped: true, omittedOutOfScope: -1 })).toBe(null);
    expect(scopeOmitNote({ scoped: true, omittedOutOfScope: '' })).toBe(null);
    expect(scopeOmitNote({ scoped: true, omittedOutOfScope: { x: 1 } })).toMatch(/일부/); // 개수를 지어내지 않는다
    expect(scopeOmitNote({ scoped: true, omittedOutOfScope: 2 }, '스캔 발견 장비')).toMatch(/스캔 발견 장비 2대/);
  });
  it('월보드 추이 그룹 제외', () => {
    expect(roomSparkScopeNote({ scoped: true, omittedOutOfScope: 2 })).toMatch(/2곳/);
    expect(roomSparkScopeNote({ scoped: true, omittedOutOfScope: 0 })).toBe(null);
    expect(roomSparkScopeNote({})).toBe(null);
  });
  it('iDRAC·서버 분석·NIC·전산실 온도 화면이 범위 안내를 그린다(소스)', () => {
    const hw = src('tools/HardwareTools.jsx');
    // 하드웨어 집계·드릴·서버 정보·파트·미지원·온도·펌웨어·GPU = 9곳
    expect((hw.match(/<ScopeOmitBanner /g) || []).length).toBeGreaterThanOrEqual(9);
    expect(hw).toMatch(/omittedOutOfScope: d\.omittedOutOfScope/); // 파트 드릴이 범위 필드를 옮긴다
    expect(hw).toMatch(/setScopeMeta\(/);                          // /admin/idrac 목록만 꺼내 범위 필드를 버리지 않는다
    expect((src('tools/NicTools.jsx').match(/<ScopeOmitBanner /g) || []).length).toBe(2);
    const rt = src('tools/RoomTemp.jsx');
    expect(rt).toMatch(/<ScopeOmitBanner data=\{data\}/);
    expect(rt).toMatch(/roomSparkScopeNote\(sparks\)/);
    expect(src('IdracAdmin.jsx')).toMatch(/<ScopeOmitBanner data=\{data\}/);
  });
});

describe('UI2630-02 운영 리포트 부가 문구', () => {
  it('목록 잘림은 개수와 상한을 밝힌다', () => {
    expect(listOmittedNote(12, 500)).toMatch(/외 12대.*500대/);
    expect(listOmittedNote(0, 500)).toBe(null);
    expect(listOmittedNote(null, 500)).toBe(null);
    expect(listOmittedNote(4, null)).toMatch(/외 4대/);
  });
  it('회수 가능 설명은 서버 계산과 같고 겹친 몫을 밝힌다', () => {
    expect(reclaimMeta({})).toBe('정지 VM 디스크 + 정지 VM 에 속하지 않은 스냅샷 델타');
    expect(reclaimMeta({ snapshotInPoweredOffGB: 60 })).toMatch(/겹친 60 GB 제외/);
    expect(reclaimMeta({ snapshotInPoweredOffGB: 0 })).not.toMatch(/겹친/);
  });
  it('Tools 미수집 · 인사이트 순간값', () => {
    expect(toolsKpiMeta({ toolsNotCollected: 5 })).toMatch(/미수집 5대/);
    expect(toolsKpiMeta({ toolsNotCollected: 0 })).toBe(null);
    expect(reclaimBasisNote({ reclaimableRamGB: 64, reclaimBasis: 'instant' })).toMatch(/64 GB RAM · 순간 사용률 기준/);
    expect(reclaimBasisNote({ reclaimableRamGB: 64 })).toBe('64 GB RAM');
    expect(reclaimBasisNote({})).toBe('RAM —');
  });
  it('화면이 헬퍼를 쓴다(소스) · 옛 설명 문구가 남지 않는다', () => {
    const tr = src('ToolsReports.jsx');
    expect(tr).toMatch(/reclaimMeta\(s, tb\)/);
    expect(tr).toMatch(/needUpgradeOmitted/);
    expect(tr).toMatch(/oldOmitted/);
    expect(tr).toMatch(/toolsKpiMeta\(s\)/);
    expect(tr).not.toMatch(/meta="정지 VM 디스크 \+ 스냅샷 델타"/);
    expect(src('tools/InsightsThreats.jsx')).toMatch(/reclaimBasisNote\(rs\)/);
  });
  it('문구에 백틱이 없다', () => {
    for (const s of [listOmittedNote(3, 5), reclaimMeta({ snapshotInPoweredOffGB: 2 }), toolsKpiMeta({ toolsNotCollected: 1 }), reclaimBasisNote({ reclaimableRamGB: 1, reclaimBasis: 'instant' }),
      scopeOmitNote({ scoped: true, omittedOutOfScope: 1 }), roomSparkScopeNote({ scoped: true, omittedOutOfScope: 1 }), edgeCardWarn({ noReport: true })]) {
      expect(s).not.toMatch(/`/);
    }
  });
});

describe('UI2630-03 성능점검 — 배정만 있고 보고 없는 엣지', () => {
  it('판정', () => {
    expect(edgeCardKind({ agent: 'a', noReport: true })).toBe('no-report');
    expect(edgeCardKind({ agent: 'a', assignedOnly: true, silent: true })).toBe('no-report');
    expect(edgeCardKind({ agent: 'a', silent: true, rows: 3 })).toBe('silent');
    expect(edgeCardKind({ agent: 'a', counts: { ok: 1 } })).toBe('live');
  });
  it('값이 없으면 0 을 지어내지 않는다', () => {
    expect(edgeCardMeta({ agent: 'a', noReport: true })).toBe('항목 — · 보고 —행 · 보고 기록 없음');
    expect(edgeCardWarn({ silent: true })).toMatch(/무보고 —/);
    expect(edgeCardWarn({ silent: true })).not.toMatch(/NaN|undefined/);
    expect(edgeCardWarn({ counts: {} })).toBe(null);
  });
  it('합계 — 서버 필드가 있으면 그것, 없으면 행으로 센다', () => {
    expect(edgeNoReportTotal({ assignedNoReport: 2 }, [])).toMatch(/보고 없음 2/);
    expect(edgeNoReportTotal({}, [{ noReport: true }, { counts: {} }])).toMatch(/보고 없음 1/);
    expect(edgeNoReportTotal({}, [{ counts: {} }])).toBe('');
  });
  it('카드가 no-report 행을 counts 없이 그린다(소스)', () => {
    const s = src('SvcMonitor.jsx');
    expect(s).toMatch(/edgeCardKind\(e\) !== 'live'/);
    expect(s).not.toMatch(/무보고 \{Math\.round/);
    expect(s).toMatch(/edgeNoReportTotal\(/);
  });
});

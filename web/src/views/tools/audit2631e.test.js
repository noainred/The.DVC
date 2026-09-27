// v2.631 감사 그룹 e — R2631-04 · A6-2631-04(화면) · A6-2631-05 · A6-2631-06 웹 회귀.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../../test/_stripComments.js';
import { linkSettingsSig, serverChangedWhileEditing, SERVER_CHANGED_NOTE } from './linkCheckDirty.js';
import { edgeClockAheadMark, edgeClockFootnote, edgeClockAheadOf, rmaLateMark } from './edgeLateText.js';
import { partialVmsNote } from './guestDiskText.js';
import { scopeOmitNote } from '../scopeOmitText.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(HERE, rel), 'utf8');
const code = (rel) => stripComments(read(rel));

describe('R2631-04 통신 점검 설정 편집 표시', () => {
  const base = { enabled: true, intervalMs: 300000, concurrency: 6, sampleRetentionDays: 90, eventRetentionDays: 30, kinds: ['a', 'b'] };
  it('서명은 키 순서에 무관하고 값이 바뀌면 달라진다', () => {
    const reordered = { kinds: ['a', 'b'], eventRetentionDays: 30, sampleRetentionDays: 90, concurrency: 6, intervalMs: 300000, enabled: true };
    expect(linkSettingsSig(base)).toBe(linkSettingsSig(reordered));
    expect(linkSettingsSig({ ...base, intervalMs: 600000 })).not.toBe(linkSettingsSig(base));
    expect(linkSettingsSig(null)).toBe(null);
  });
  it('편집 중에만, 기준이 있을 때만 서버 변경을 말한다', () => {
    const sig = linkSettingsSig(base);
    expect(serverChangedWhileEditing(true, sig, { ...base, concurrency: 8 })).toBe(true);
    expect(serverChangedWhileEditing(true, sig, base)).toBe(false);
    expect(serverChangedWhileEditing(false, sig, { ...base, concurrency: 8 })).toBe(false);
    expect(serverChangedWhileEditing(true, null, { ...base, concurrency: 8 })).toBe(false);
    expect(serverChangedWhileEditing(true, sig, null)).toBe(false);
  });
  it('문구에 백틱이 없다', () => { expect(SERVER_CHANGED_NOTE).not.toMatch(/`/); });
  it('LinkCheck 는 닫기·취소에서 편집 표시를 내리고 서버 변경을 알린다', () => {
    const s = code('LinkCheck.jsx');
    // 닫기 버튼이 resetForm 을 부른다
    expect(s).toMatch(/if \(showSettings && data\?\.settings\) resetForm\(data\.settings\)/);
    // resetForm 이 편집 표시를 내린다
    expect(s).toMatch(/const resetForm = \(settings\) => \{\s*formDirty\.current = false;/);
    expect(s).toMatch(/serverChangedWhileEditing\(/);
    expect(s).toMatch(/SERVER_CHANGED_NOTE/);
    expect(s).toMatch(/편집 취소/);
  });
});

describe('A6-2631-04 엣지 시계 빠름 표지', () => {
  it('필드가 없거나 0·음수·문자열이면 표시하지 않는다', () => {
    for (const v of [undefined, null, 0, -5000, '90000', NaN]) {
      expect(edgeClockAheadMark({ edgeClockAheadMs: v })).toBe(null);
      expect(edgeClockAheadOf({ edgeClockAheadMs: v })).toBe(null);
    }
    expect(edgeClockAheadMark(null)).toBe(null);
  });
  it('분 단위로 짧게 말한다', () => {
    const m = edgeClockAheadMark({ edgeClockAheadMs: 180_000 });
    expect(m.label).toBe('엣지 시계 +3분');
    expect(m.title).toMatch(/빠릅니다/);
    expect(edgeClockAheadMark({ edgeClockAheadMs: 7_200_000 }).label).toBe('엣지 시계 +2시간');
  });
  it('각주는 해당 장비가 있을 때 한 번, 개수를 밝힌다', () => {
    expect(edgeClockFootnote([{}, null, { edgeClockAheadMs: 0 }])).toBe('');
    const t = edgeClockFootnote([{ edgeClockAheadMs: 9000 }, {}, { edgeClockAheadMs: 60000 }], '스위치');
    expect(t).toMatch(/스위치 2대/);
    expect(t).toMatch(/NTP/);
    expect(t).not.toMatch(/`/);
  });
  it('스토리지·SAN·PDU 화면이 행 표지와 각주를 쓴다', () => {
    for (const f of ['StorageMonTool.jsx', 'SanSwitchTool.jsx', 'PduTool.jsx']) {
      const s = code(f);
      expect(s, f).toMatch(/edgeClockAheadMark\(s\)/);
      expect(s, f).toMatch(/edgeClockFootnote\(/);
    }
  });
});

describe('A6-2631-04 RMA 늦게 도착한 결과', () => {
  it('late 가 true 일 때만', () => {
    expect(rmaLateMark(null)).toBe(null);
    expect(rmaLateMark({ ok: true })).toBe(null);
    expect(rmaLateMark({ late: 'yes' })).toBe(null);
    const m = rmaLateMark({ late: true, lateAfterMs: 120_000 });
    expect(m.label).toBe('늦게 도착');
    expect(m.title).toMatch(/이미 실행됐습니다/);
    expect(m.title).toMatch(/2분/);
    expect(rmaLateMark({ late: true }).title).not.toMatch(/기한 뒤 약/);
  });
  it('이력 행·결과 창·실행 창이 늦은 도착을 싣는다', () => {
    const s = code('RemoteCommand.jsx');
    expect(s).toMatch(/rmaLateMark\(h\)/);
    expect(s).toMatch(/rmaLateMark\(r\)/);
    expect(s).toMatch(/state\.job\.late \? \{ late: true \}/);
  });
});

describe('A6-2631-04 게스트 디스크 부분 합', () => {
  it('필드가 없으면 빈 문자열', () => {
    expect(partialVmsNote(null)).toBe('');
    expect(partialVmsNote({})).toBe('');
    expect(partialVmsNote({ partialVms: 0 })).toBe('');
    expect(partialVmsNote({ partialVms: '3' })).toBe('');
  });
  it('개수와 처리 방식을 나눠 말한다', () => {
    const t = partialVmsNote({ partialVms: 5, partialHeld: 2, partialShown: 3, partialStale: 0 });
    expect(t).toMatch(/VM 5대/);
    expect(t).toMatch(/직전 온전한 값 유지 2대/);
    expect(t).toMatch(/부분 합을 표지와 함께 표시 3대/);
    expect(t).not.toMatch(/직전 행 그대로/);
    expect(t).toMatch(/추이에 적재하지 않았습니다/);
    expect(t).not.toMatch(/`/);
  });
  it('화면이 문구를 쓴다', () => {
    expect(code('GuestDiskReport.jsx')).toMatch(/partialVmsNote\(poller\.lastResult\)/);
  });
});

describe('A6-2631-05 V4 물리·설비의 범위 제외 안내', () => {
  it('Facility 가 room-temp·idrac 응답의 제외를 scopeOmitNote 로 말한다', () => {
    const s = code('../../version_4/pages/Facility.jsx');
    expect(s).toMatch(/scopeOmitNote\(room\.data, '서버'\)/);
    expect(s).toMatch(/scopeOmitNote\(polls\.idrac\.data, 'iDRAC 서버'\)/);
  });
});

describe('A6-2631-06 범위 제외 문구 단일 소스', () => {
  it('why 로 근거를 바꿀 수 있고 기본은 예전 문구', () => {
    const d = { scoped: true, omittedOutOfScope: 3 };
    expect(scopeOmitNote(d, '서버')).toMatch(/^내 조회 범위 밖\(또는 법인 귀속이 없는\) 서버 3대는 제외/);
    expect(scopeOmitNote(d, '복제 잡', '개', { why: '조회 범위 밖 vCenter 의' })).toMatch(/^조회 범위 밖 vCenter 의 복제 잡 3개는 제외/);
    expect(scopeOmitNote(d, '서버', '대', null)).toMatch(/^내 조회 범위 밖/);
    expect(scopeOmitNote({ scoped: true, omittedOutOfScope: '3' }, 'NSX Manager', '개', { why: 'x' })).toMatch(/^x NSX Manager 일부는/);
  });
  it('인라인 판정 사본이 없다', () => {
    for (const f of ['../NsxAdmin.jsx', '../gpu-guest/PhysicalGpuManager.jsx', 'VmCloneTool.jsx']) {
      const s = code(f);
      expect(s, f).not.toMatch(/omittedOutOfScope\s*>/);
      expect(s, f).toMatch(/<ScopeOmitBanner /);
    }
  });
});

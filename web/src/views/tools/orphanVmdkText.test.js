// v2.505 — 고아 VMDK 화면 문구·판정 회귀 고정(node 환경 — 순수 함수만).
//
// 이 화면의 문구는 사람이 **파일을 지울지 결정하는 근거**다. 그래서 여기서 고정하는 것은
// '표시가 예쁜가' 가 아니라 **위험한 표현을 쓰지 않는가**다.
import { describe, it, expect } from 'vitest';
import {
  fmtBytes, summaryText, basisText, verdictLabel, verdictTone,
  confidenceTone, confidenceLabel, scanStateNote, truncatedNote,
  excludedByReason, excludeLabel, HOLD_HOURS,
} from './orphanVmdkText.js';

const GB = 1024 ** 3;

describe('크기 표기', () => {
  it('단위를 올려 읽기 쉽게', () => {
    expect(fmtBytes(0)).toBe('0 B');
    expect(fmtBytes(512)).toBe('512 B');
    expect(fmtBytes(1536)).toBe('1.5 KB');
    expect(fmtBytes(40 * GB)).toBe('40.0 GB');
    expect(fmtBytes(3 * 1024 ** 4)).toBe('3.0 TB');
  });
  it('모르는 값은 빈칸이 아니라 —(0 과 구분)', () => {
    expect(fmtBytes(null)).toBe('—');
    expect(fmtBytes('x')).toBe('—');
    expect(fmtBytes(-1)).toBe('—');
    expect(fmtBytes(0)).not.toBe('—');
  });
});

describe("요약 — '삭제 대상' 이라고 쓰지 않는다", () => {
  const r = { summary: { orphanDisks: 2, orphanBytes: 90 * GB, unregisteredDisks: 1, unregisteredBytes: 20 * GB, holdDisks: 0, holdBytes: 0, scannedVmdkFiles: 50, ownedVmdkFiles: 44 } };
  it('건수·용량과 함께 확인 필요임을 밝힌다', () => {
    const t = summaryText(r);
    expect(t).toContain('소유 VM 없음 2개');
    expect(t).toContain('90.0 GB');
    expect(t).toContain('확인 필요');
  });
  it('삭제·회수를 단정하는 표현이 없다', () => {
    const t = summaryText(r);
    expect(t).not.toMatch(/삭제하면|삭제 가능|회수 가능|지워도|안전하게/);
  });
  it('후보가 없으면 그 사실을 분명히 말한다', () => {
    const t = summaryText({ summary: { orphanDisks: 0, unregisteredDisks: 0, holdDisks: 0, scannedVmdkFiles: 12, ownedVmdkFiles: 12, orphanBytes: 0, unregisteredBytes: 0, holdBytes: 0 } });
    expect(t).toContain('없습니다');
    expect(t).toContain('12개');
  });
  it('요약이 없으면 빈 문자열', () => {
    expect(summaryText(null)).toBe('');
    expect(summaryText({})).toBe('');
  });
});

describe('대조 근거 — 무엇과 무엇을 비교했는지 숫자로', () => {
  it('파일 수·소유 확인 수·VM 수를 함께 밝힌다', () => {
    const t = basisText({ totalFiles: 1234, dsVmCount: 10, vmsWithLayout: 9, summary: { scannedVmdkFiles: 80, ownedVmdkFiles: 70, excludedFiles: 3 } });
    expect(t).toContain('1,234');
    expect(t).toContain('소유 확인 70');
    expect(t).toContain('VM 10대');
    expect(t).toContain('확보 9대');
    expect(t).toContain('제외 3');
  });
  it('데모 모드에서는 근거를 만들지 않는다', () => {
    expect(basisText({ mock: true })).toBe('');
    expect(basisText(null)).toBe('');
  });
});

describe('판정 라벨', () => {
  it('세 가지를 구분한다', () => {
    expect(verdictLabel('orphan')).toBe('소유 VM 없음');
    expect(verdictLabel('unregistered')).toBe('미등록 VM 폴더');
    expect(verdictLabel('hold')).toBe('판정 보류');
    expect(verdictTone('orphan')).toBe('red');
    expect(verdictTone('hold')).toBe('blue');
  });
  it('모르는 값에 안전', () => {
    expect(verdictLabel('')).toBe('—');
    expect(verdictLabel('zzz')).toBe('zzz');
  });
});

describe('신뢰도 — 낮으면 눈에 띄어야 한다', () => {
  it('none/low 는 빨강(숫자를 그대로 믿으면 안 되는 상태)', () => {
    expect(confidenceTone('none')).toBe('red');
    expect(confidenceTone('low')).toBe('red');
    expect(confidenceTone('high')).toBe('green');
    expect(confidenceTone('medium')).toBe('blue');
  });
  it('라벨이 상태를 그대로 말한다', () => {
    expect(confidenceLabel('none')).toBe('신뢰 불가');
    expect(confidenceLabel('low')).toBe('신뢰도 낮음');
    expect(confidenceLabel('high')).toBe('대조 완료');
  });
});

describe('상태 문구 — 네 경우를 구분한다', () => {
  it('데이터스토어를 고르기 전', () => {
    expect(scanStateNote({}).kind).toBe('pick');
  });
  it('고른 뒤 스캔 전', () => {
    expect(scanStateNote({ ds: 'ds-1' }).kind).toBe('idle');
  });
  it('불러오는 중에는 문구를 띄우지 않는다(깜빡임 방지)', () => {
    expect(scanStateNote({ ds: 'ds-1', loading: true })).toBe(null);
  });
  it('오류와 데모를 구분한다', () => {
    expect(scanStateNote({ ds: 'ds-1', error: '권한 없음' }).kind).toBe('error');
    expect(scanStateNote({ ds: 'ds-1', result: { mock: true, reason: '데모' } }).kind).toBe('mock');
  });
  it('결과가 있으면 문구 없이 결과를 그린다', () => {
    expect(scanStateNote({ ds: 'ds-1', result: { mock: false } })).toBe(null);
  });
});

describe('절단 경고 — 조용히 자르지 않는다', () => {
  it('잘렸으면 결론을 내리지 말라고 말한다', () => {
    const t = truncatedNote({ truncated: true });
    expect(t).toContain('잘렸');
    expect(t).toContain('결론');
  });
  it('안 잘렸으면 빈 문자열(소음 방지)', () => {
    expect(truncatedNote({ truncated: false })).toBe('');
    expect(truncatedNote(null)).toBe('');
  });
});

describe('제외 사유 집계 — 왜 빠졌는지 숨기지 않는다', () => {
  it('사유별로 묶고 용량 큰 순으로', () => {
    const rows = excludedByReason([
      { reason: 'fcd', sizeBytes: 10 * GB },
      { reason: 'fcd', sizeBytes: 5 * GB },
      { reason: 'ctk', sizeBytes: 1024 },
    ]);
    expect(rows[0]).toMatchObject({ reason: 'fcd', files: 2, sizeBytes: 15 * GB });
    expect(rows[1].reason).toBe('ctk');
  });
  it('사유 라벨이 한국어로 설명된다', () => {
    expect(excludeLabel('fcd')).toContain('쿠버네티스');
    expect(excludeLabel('ctk')).toContain('CBT');
    expect(excludeLabel('nope')).toBe('nope');
  });
  it('빈 입력에 안전', () => {
    expect(excludedByReason()).toEqual([]);
    expect(excludedByReason(null)).toEqual([]);
  });
});

describe('보류 창 선택지', () => {
  it("'끔' 을 포함하고 기본 24시간이 있다", () => {
    const keys = HOLD_HOURS.map(([h]) => h);
    expect(keys).toContain(0);
    expect(keys).toContain(24);
  });
});

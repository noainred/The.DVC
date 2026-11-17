/**
 * 96회차 반증 — 화면 문구(순수 함수).
 *  R1 로그 설정 읽기 오류로 건너뛴 수집을 '수집 꺼짐' · '켜고 저장하세요' 로 말하지 않는다
 *  R2 스캔 대역 GET 의 loadError 를 빈 목록 대신 사유로
 *  ⓐ 교체 판정 미지원 엣지(replaceRule false)를 엣지 현황 문구가 센다
 */
import { describe, it, expect } from 'vitest';
import { vcLogRunText, vcLogCollectText, vcLogSettingsUnreadableText } from './VcenterLogs.jsx';
import { scanRangesLoadErrorText } from './idrac/IdracScanRanges.jsx';
import { edgeNote } from './tools/partFaultText.js';

const fmt = () => 'T';

describe('96회차 R1 로그 설정 읽기 오류', () => {
  it('상태 줄 · 지금 수집 결과가 수집 꺼짐이 아니라 설정을 못 읽어 건너뜀', () => {
    const lr = { at: 1, collected: 0, skipped: true, settingsUnreadable: true };
    expect(vcLogRunText(lr, fmt)).toMatch('설정 파일을 읽지 못해');
    expect(vcLogRunText(lr, fmt)).not.toMatch('수집 꺼짐');
    expect(vcLogCollectText({ ok: true, ...lr }, fmt)).toMatch('읽지 못해 수집하지 않았습니다');
    expect(vcLogCollectText({ ok: true, ...lr }, fmt)).not.toMatch('켜고');
    // 진짜 꺼짐은 예전 그대로
    expect(vcLogRunText({ at: 1, collected: 0, skipped: true }, fmt)).toBe('최근 확인 T · 수집 꺼짐');
  });
  it('배너 문구는 표지가 있을 때만', () => {
    expect(vcLogSettingsUnreadableText({})).toBe('');
    expect(vcLogSettingsUnreadableText({ settingsUnreadable: true, settingsReason: '읽기 오류입니다.' })).toMatch('기본값');
  });
});

describe('96회차 R2 스캔 대역 읽기 오류', () => {
  it('loadError 가 있으면 사유 · 없으면 null', () => {
    expect(scanRangesLoadErrorText({ ranges: [] })).toBe(null);
    expect(scanRangesLoadErrorText({ ranges: [], loadError: { readError: true, reason: '스캔 대역 파일을 읽지 못했습니다.' } })).toMatch('대역이 없다는 뜻이 아닙니다');
  });
});

describe('96회차 ⓐ 교체 판정 미지원 엣지', () => {
  it('정상 보고 중 replaceRule false 만 센다 · 옛 중앙(키 없음)은 세지 않는다', () => {
    const edges = { rows: [{ agent: 'a', kind: 'fresh', replaceRule: false }, { agent: 'b', kind: 'fresh', replaceRule: true }, { agent: 'c', kind: 'fresh' }], counts: { fresh: 3 } };
    expect(edgeNote(edges).text).toMatch('교체 판정 미지원 1곳');
    expect(edgeNote({ rows: [{ agent: 'c', kind: 'fresh' }], counts: { fresh: 1 } }).text).not.toMatch('교체 판정');
  });
});

import { backdropClose } from '../components/backdropClose.js';
describe('96회차 W1 반증: backdropClose — 배경에서 누르고 창 안에서 뗀 click(공통 조상 = 배경)도 닫지 않는다', () => {
  const ov = () => ({ dataset: {} });
  it('누름 배경 · 뗌 창 안 → 닫지 않음 · 누름 · 뗌 배경 → 닫음(터치 탭의 호환 마우스 사건 순서)', () => {
    let n = 0; const p = backdropClose(() => { n += 1; }); const o = ov();
    p.onMouseDown({ currentTarget: o, target: o }); p.onMouseUp({ currentTarget: o, target: { inner: true } }); p.onClick({ currentTarget: o, target: o });
    expect(n).toBe(0);
    p.onMouseDown({ currentTarget: o, target: o }); p.onMouseUp({ currentTarget: o, target: o }); p.onClick({ currentTarget: o, target: o });
    expect(n).toBe(1);
  });
});

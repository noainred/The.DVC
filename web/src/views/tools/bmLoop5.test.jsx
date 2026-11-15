/**
 * 베어메탈 사용률 점검 반복 5회차(기준판 2d8d9e5a7) — 웹 쪽 문구 고정.
 *   D1 엣지 보관분이 엣지 상한에서 잘렸으면 엣지 표가 밝힌다(범위 계정은 대수 없이) · 정비 창 배포 현황이 태그 창은 받은 대상만임을 밝힌다
 *   D3 마지막 주기 알림은 넣은 수와 받은 결과(보냄 · 실패 · 안 보냄 · 보내는 중 · 재시도 예약)를 나눠서 — 실패를 ‘발송’ 으로 세지 않는다
 *   서버 쪽은 server/test/bmUsageLoop5.test.js.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { alertCycleText, edgeTruncatedText } from './bmUsageText.js';
import { deployTruncatedNote } from './bmMaintText.js';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const src = (f) => fs.readFileSync(path.join(HERE, f), 'utf8');

describe('D3 알림 한 줄', () => {
  it('넣은 수 · 보냄 · 실패(재시도 예약) · 안 보냄 · 보내는 중 · 상한 생략', () => {
    expect(alertCycleText({ queued: 3, capped: 0, over: 3 }, { sent: 1, failed: 1, retry: 1, skipped: 0, pending: 1 })).toBe('알림 3건 — 보냄 1 · 실패 1(재시도 예약 1) · 보내는 중 1');
    expect(alertCycleText({ queued: 2, capped: 4, over: 6 }, { sent: 0, failed: 0, skipped: 2, pending: 0 })).toBe('알림 2건 — 보냄 0 · 안 보냄 2(억제 · 채널 꺼짐 등) (상한으로 4건 생략)');
    expect(alertCycleText({ queued: 1, over: 1 }, null)).toBe('알림 1건');
    expect(alertCycleText({ queued: 0, over: 0 }, null)).toBe(null);
    expect(alertCycleText(null, null)).toBe(null);
  });
  it('옛 서버(queued 없음 · sent 만)는 예전 문구 · 백틱 없음', () => {
    expect(alertCycleText({ sent: 2, capped: 0, over: 2 })).toBe('알림 2건 발송');
    expect(alertCycleText({ queued: 1, over: 1 }, { sent: 0, failed: 1, retry: 1, skipped: 1, pending: 0 })).not.toMatch(/`/);
  });
  it('화면은 이 함수로 그린다(‘알림 n건 발송’ 을 넣은 수로 말하지 않는다)', () => {
    const p = src('BmUsage.jsx');
    expect(p).toMatch(/alertCycleText\(st\.last\?\.alerts, st\.alertState\?\.delivery\)/);
    expect(p).not.toMatch(/알림 \{st\.last\.alerts\.sent\}건 발송/);
  });
});

describe('D1 엣지 상한 잘림', () => {
  it('관리자 · 전체 범위는 대수 · 범위 계정(true)은 사실만 · 안 잘렸으면 null', () => {
    expect(edgeTruncatedText({ truncated: 600, targets: new Array(400).fill({}) })).toBe('1,000대 중 400대만 가져옴(엣지 상한)');
    expect(edgeTruncatedText({ truncated: true, targets: [{}] })).toBe('엣지 상한으로 일부만 가져옴');
    expect(edgeTruncatedText({ truncated: 0, targets: [] })).toBe(null);
    expect(edgeTruncatedText({})).toBe(null);
  });
  it('배포 현황 — 태그 창은 받은 대상만(그 수) · 없으면 null', () => {
    expect(deployTruncatedNote({ targetsTruncated: 600 })).toMatch(/600대/);
    expect(deployTruncatedNote({})).toBe(null);
    expect(deployTruncatedNote({ targetsTruncated: 600 })).not.toMatch(/`/);
  });
  it('엣지 표 · 배포 현황 표가 그 문구를 그린다', () => {
    expect(src('BmUsage.jsx')).toMatch(/edgeTruncatedText\(r\)/);
    expect(src('BmMaintPanel.jsx')).toMatch(/deployTruncatedNote\(e\)/);
  });
});

/**
 * linkCheckText 회귀(v2.552) — 이 화면이 만들 수 있는 **최악의 거짓**을 막는 것이 목적이다:
 *   ① 측정값 없는 링크를 '정상' 으로 칠하기  ② null 을 0 으로 말하기
 *   ③ 미시도 단계를 '실패' 라 말하기        ④ 같은 문구를 행마다 반복하기
 */
import { describe, it, expect } from 'vitest';
import {
  STATE_LABEL, stateTone, rowState, cmpVersion, msText, ageText, certText,
  kpisOf, headerNote, runResultText, EVENT_LABEL, eventTone, tableFootnotes, pairNote,
  phaseTrail, trailFromLatest,
} from './linkCheckText.js';

describe('rowState — 빈 칸을 정상이라 말하지 않는다', () => {
  it('측정값이 있으면 그 판정을 쓴다', () => {
    expect(rowState({ latest: { ok: true } }).state).toBe('ok');
    expect(rowState({ latest: { ok: false, summary: 'TCP 거부' } }).state).toBe('fail');
  });
  it('측정값이 없으면 ok 가 아니라 no-data 이고 이유를 말한다', () => {
    const r = rowState({ by: 'central' }, { enabled: true });
    expect(r.state).toBe('no-data');
    expect(r.why.length).toBeGreaterThan(0);
  });
  it('점검이 꺼져 있으면 그것을 첫 원인으로 말한다(조치가 다르다)', () => {
    expect(rowState({ by: 'central' }, { enabled: false }).why).toMatch(/꺼져/);
  });
  it('엣지 구버전은 "기다리면 된다" 고 말하지 않는다', () => {
    const r = rowState({ by: 'edge', from: 'GM1', edgeVersion: '2.550.0' }, { enabled: true });
    expect(r.state).toBe('no-data');
    expect(r.why).toMatch(/구버전/);
    expect(r.fix).toMatch(/업그레이드/);
    expect(r.fix).not.toMatch(/기다/);
  });
  it('버전이 충분하고 보고가 없으면 기다리면 된다고 말한다', () => {
    const r = rowState({ by: 'edge', from: 'GM1', edgeVersion: '2.552.0' }, { enabled: true });
    expect(r.fix).toMatch(/기다/);
  });
  it('엣지 버전을 모르면 원인을 단정하지 않는다', () => {
    const r = rowState({ by: 'edge', from: 'GM1' }, { enabled: true });
    expect(r.why).toMatch(/확인되지 않았/);
  });
  it('오래된 보고는 "지금 값이 맞는지 모른다" 고 말한다', () => {
    const r = rowState({ by: 'edge', from: 'GM1', edgeVersion: '2.552.0', edgeReport: { stale: true } }, { enabled: true });
    expect(r.why).toMatch(/오래/);
  });
  it('비활성 대상은 disabled 이고 no-data 와 구분된다', () => {
    expect(rowState({ enabled: false }).state).toBe('disabled');
    expect(STATE_LABEL.disabled).not.toBe(STATE_LABEL['no-data']);
  });
  it('no-data 색은 초록도 빨강도 아니다', () => {
    expect(stateTone('no-data')).toMatch(/muted/);
    expect(stateTone('ok')).not.toBe(stateTone('fail'));
  });
});

describe('null 을 0 으로 말하지 않는다', () => {
  it('msText', () => {
    expect(msText(null)).toBe('—');
    expect(msText(undefined)).toBe('—');
    expect(msText('')).toBe('—');            // Number('') === 0 함정
    expect(msText(0)).toBe('0ms');
    expect(msText(1500)).toBe('1.50초');
  });
  it('ageText — 없으면 "없음"', () => {
    expect(ageText(null)).toBe('없음');
    expect(ageText(Date.now() - 120_000)).toMatch(/분 전/);
  });
  it('certText — 만료일을 모르면 유효하다고 말하지 않는다', () => {
    expect(certText(null).text).toBe('—');
    expect(certText('').text).toBe('—');
    expect(certText(-2).text).toMatch(/지남/);
    expect(certText(10).tone).toMatch(/warn/);
    expect(certText(400).text).toMatch(/남음/);
  });
  it('정상률 분모가 0 이면 null(0% 가 아니다)', () => {
    expect(kpisOf([{ by: 'edge' }], { enabled: true }).okPct).toBe(null);
  });
});

describe('KPI — no-data 를 정상에도 실패에도 넣지 않는다', () => {
  it('네 칸이 겹치지 않고 합이 전체와 같다', () => {
    const k = kpisOf([{ latest: { ok: true } }, { latest: { ok: false } }, { by: 'edge' }, { enabled: false }], { enabled: true });
    expect(k).toMatchObject({ total: 4, ok: 1, fail: 1, nodata: 1, disabled: 1, measured: 2, okPct: 50 });
    expect(k.ok + k.fail + k.nodata + k.disabled).toBe(k.total);
  });
});

describe('배너 — 긴 설명은 한 번만', () => {
  it('꺼져 있으면 그 사실을 말한다', () => {
    expect(headerNote({ enabled: false, links: [] }).join(' ')).toMatch(/꺼져/);
  });
  it('측정 없음이 있으면 정상이 아니라고 말한다', () => {
    const n = headerNote({ enabled: true, links: [{ by: 'edge' }] });
    expect(n.join(' ')).toMatch(/정상이라는 뜻이 아닙니다/);
  });
  it('기록 실패를 숨기지 않는다', () => {
    const n = headerNote({ enabled: true, links: [], poller: { last: { at: 1, dbOk: false, dbError: 'disk full' } } });
    expect(n.join(' ')).toMatch(/기록에 실패/);
  });
  it('문제가 없으면 배너가 비어 있다(같은 말로 화면을 덮지 않는다)', () => {
    expect(headerNote({ enabled: true, links: [{ latest: { ok: true } }], poller: { last: { at: 1, dbOk: true } } })).toEqual([]);
  });
});

describe('지금 점검 결과 — 중앙과 엣지를 나눠 말한다', () => {
  it('엣지 측정분은 다음 주기라고 밝힌다', () => {
    expect(runResultText({ ok: true, checked: 2, failed: 0, edgePending: 7 })).toMatch(/다음 주기/);
  });
  it('중복 실행을 실패라 말하지 않는다', () => {
    expect(runResultText({ ok: false, skipped: 'already-running' })).toMatch(/진행 중/);
  });
  it('꺼짐과 실패를 구분한다', () => {
    expect(runResultText({ ok: false, skipped: 'disabled' })).toMatch(/꺼져/);
    expect(runResultText({ ok: false, error: 'boom' })).toMatch(/boom/);
  });
});

describe('로그 라벨 — 첫 점검을 복구라 말하지 않는다', () => {
  it('first 와 recovered 가 다른 말이다', () => {
    expect(EVENT_LABEL.first).not.toBe(EVENT_LABEL.recovered);
    expect(EVENT_LABEL.first).toMatch(/첫/);
  });
  it('실패 시작이 가장 강한 색이다', () => {
    expect(eventTone('fail-start', false)).not.toBe(eventTone('fail', false));
  });
});

describe('행에는 짧은 표지, 긴 설명은 각주 1회(v2.509)', () => {
  it('짧은 표지는 한 줄이고 긴 설명과 다르다', () => {
    const r = rowState({ by: 'edge', from: 'GM1' }, { enabled: true });
    expect(r.whyShort.length).toBeLessThan(20);
    expect(r.why.length).toBeGreaterThan(r.whyShort.length);
    expect(r.reason).toBe('edge-unknown-version');
  });
  it('같은 사유가 여러 행이어도 각주는 1회다', () => {
    const rows = Array.from({ length: 6 }, () => ({ by: 'edge', from: 'GM1' }));
    const f = tableFootnotes(rows, { enabled: true });
    const hits = f.filter((x) => x.includes('한 번도 export')).length;
    expect(hits).toBe(1);
  });
  it('측정된 행의 사유는 그 행의 요약이다(반복 문단이 아니다)', () => {
    const r = rowState({ latest: { ok: false, summary: 'a → b TCP 단계 실패' } });
    expect(r.whyShort).toBe('a → b TCP 단계 실패');
    expect(r.reason).toBe('');
  });
});

describe('각주 — 그 종류가 있을 때만', () => {
  it('no-data 가 없으면 그 문구를 만들지 않는다', () => {
    const f = tableFootnotes([{ latest: { ok: true }, by: 'central' }], { enabled: true });
    expect(f.join(' ')).not.toMatch(/측정 없음/);
  });
  it('엣지 링크가 있으면 측정 주체를 설명한다', () => {
    expect(tableFootnotes([{ by: 'edge', from: 'a' }], { enabled: true }).join(' ')).toMatch(/엣지가 재서 올립니다/);
  });
  it('짝 이름 오류·담당 미지정도 각각 밝힌다', () => {
    expect(tableFootnotes([{ unassigned: true, latest: { ok: true } }], { enabled: true }).join(' ')).toMatch(/remoteAgent/);
    expect(tableFootnotes([{ unknownTo: true, latest: { ok: true } }], { enabled: true }).join(' ')).toMatch(/등록부에 없는/);
  });
});

describe('엣지↔엣지 짝 — 전량을 자동으로 켜지 않는 이유를 말한다', () => {
  it('가능한 방향 수를 산수로 보여준다', () => {
    expect(pairNote(['a', 'b', 'c'], [])).toMatch(/6개/);
    expect(pairNote(['a'], [])).toMatch(/0개/);
  });
});

describe('단계 표지 — 미시도를 실패라 말하지 않는다', () => {
  it('phaseTrail: 키가 없으면 untried', () => {
    const t = phaseTrail({ dns: { ok: true, ms: 1 } });
    expect(t[0].state).toBe('ok');
    expect(t[1].state).toBe('untried');
  });
  it('trailFromLatest: 실패 단계 뒤는 untried', () => {
    const t = trailFromLatest({ ok: false, phase: 'tcp', reached: 'tcp', dnsMs: 1, tcpMs: 5 });
    expect(t.map((x) => x.state)).toEqual(['ok', 'fail', 'untried', 'untried', 'untried', 'untried']);
  });
  it('trailFromLatest: 전부 통과하면 전부 ok', () => {
    const t = trailFromLatest({ ok: true, reached: 'identity', dnsMs: 1, tcpMs: 2, tlsMs: 3, httpMs: 4 });
    expect(t.every((x) => x.state === 'ok')).toBe(true);
  });
  it('trailFromLatest: 하지 않은 단계를 정상이라 칠하지 않는다(http 링크의 TLS)', () => {
    // v2.552 Chromium 판독에서 잡은 결함 — reached 가 auth 여도 tls 를 잰 적이 없으면 ok 가 아니다
    const t = trailFromLatest({ ok: false, phase: 'auth', reached: 'auth', dnsMs: 0, tcpMs: 1, tlsMs: null, httpMs: 15 });
    expect(t.map((x) => x.state)).toEqual(['ok', 'ok', 'skip', 'ok', 'fail', 'untried']);
  });
  it('trailFromLatest: skip 과 untried 는 다른 상태다', () => {
    const t = trailFromLatest({ ok: true, reached: 'identity', dnsMs: 1, tcpMs: 2, tlsMs: null, httpMs: 4 });
    expect(t[2].state).toBe('skip');
    expect(t.some((x) => x.state === 'untried')).toBe(false);
  });
  it('trailFromLatest: 값이 없으면 전부 untried(정상이 아니다)', () => {
    expect(trailFromLatest(null).every((x) => x.state === 'untried')).toBe(true);
  });
  it('reached 가 없는 구버전 행은 ms 가 있는 단계만 도달로 본다', () => {
    const t = trailFromLatest({ ok: true, dnsMs: 1, tcpMs: 2 });
    expect(t.map((x) => x.state)).toEqual(['ok', 'ok', 'untried', 'untried', 'untried', 'untried']);
  });
});

describe('cmpVersion', () => {
  it('형식이 아니면 null(추측하지 않는다)', () => {
    expect(cmpVersion('2.552.0', '2.552.0')).toBe(0);
    expect(cmpVersion('2.551.9', '2.552.0')).toBeLessThan(0);
    expect(cmpVersion('', '2.552.0')).toBe(null);
    expect(cmpVersion('abc', '2.552.0')).toBe(null);
  });
});

/* ══════════════ v2.554 — 엣지 미보고를 '기다리면 된다' 로 덮지 않는다 ═════════ */
describe('v2.554 — 엣지 보고가 오지 않을 때', () => {
  const NOW2 = 1_700_000_000_000;
  const edgeRow = { by: 'edge', from: 'GM1', kind: 'edge->central', enabled: true, latest: null, edgeReport: null, edgeVersion: '2.553.0' };

  it('첫 주기 안에는 "첫 보고 대기" 다(없는 문제를 만들지 않는다)', () => {
    const s = rowState(edgeRow, { enabled: true, runningSinceTs: NOW2 - 60_000, intervalMs: 300_000, now: NOW2 });
    expect(s.reason).toBe('edge-waiting');
  });

  it('⚠⚠ 주기의 3배를 넘게 돌았는데 보고가 없으면 문구가 바뀐다(기다려서 될 일이 아니다)', () => {
    const s = rowState(edgeRow, { enabled: true, runningSinceTs: NOW2 - 40 * 60_000, intervalMs: 300_000, now: NOW2 });
    expect(s.reason).toBe('edge-silent');
    expect(s.why).toContain('기다려서 될 상태가 아닙니다');
    // 조치 셋을 모두 말한다 — 조치가 서로 다르다.
    expect(s.fix).toContain('개별 토큰');
    expect(s.fix).toContain('0개');
    expect(s.fix).toContain('엣지 로그');
  });

  it('⚠ runningSinceTs 가 없으면 escalate 하지 않는다', () => {
    const s = rowState(edgeRow, { enabled: true, runningSinceTs: null, intervalMs: 300_000, now: NOW2 });
    expect(s.reason).toBe('edge-waiting');
  });

  it('엣지가 "잴 링크가 없다" 고 답했으면 그 사유를 그대로 쓴다(추측하지 않는다)', () => {
    const s = rowState({ ...edgeRow, edgeReport: { at: NOW2, stale: false, note: '이 엣지가 잴 링크가 없습니다(종류를 껐거나 담당 vCenter·짝이 없습니다).' } }, { enabled: true, now: NOW2 });
    expect(s.reason).toBe('edge-no-link');
    expect(s.why).toContain('잴 링크가 없다고 답했습니다');
    expect(s.fix).toContain('AGENT_NAME');
  });

  it('구버전 엣지는 note 가 없으므로 예전 문구로 떨어진다(그 차이가 드러난다)', () => {
    const s = rowState({ ...edgeRow, edgeReport: { at: NOW2, stale: false } }, { enabled: true, now: NOW2 });
    expect(s.reason).toBe('edge-no-link');
    expect(s.whyShort).toBe('이 링크만 없음');
  });

  it('구버전 엣지 판정이 escalate 보다 먼저다(업그레이드가 조치다)', () => {
    const s = rowState({ ...edgeRow, edgeVersion: '2.540.0' }, { enabled: true, runningSinceTs: NOW2 - 40 * 60_000, intervalMs: 300_000, now: NOW2 });
    expect(s.reason).toBe('edge-old');
  });
});

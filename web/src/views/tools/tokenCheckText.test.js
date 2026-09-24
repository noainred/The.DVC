/**
 * tokenCheckText.test.js — 토큰 점검 화면 문구 회귀(v2.560).
 *
 * 이 화면이 만들 수 있는 거짓을 문구 수준에서 고정한다. 판정(행 상태·KPI)은 서버가 소유하므로
 * (`portalcheck/tokenScan.js rowStateOf`) 여기서는 **읽기만** 하는지와 문구의 정직성을 본다.
 */
import { describe, it, expect } from 'vitest';
import {
  ROW_STATE, ROW_LABEL, ROW_TONE, rowState, PROBE_LABEL, PROBE_TONE,
  EDGE_FACT_LABEL, EDGE_FACT_TONE, DUP_LABEL, dupText, scopeLabel,
  FINDING_TEXT, findingLine, findingGroupLine, agentsText, fpText, fpLimitNote, bannerText, okRateText,
  tableFootnotes, runSummary, evidenceText, centralAxisText, reasonTail, mergeRunResult, limitsText,
  edgeReportCell,
} from './tokenCheckText.js';

describe('행 상태는 서버 값을 읽기만 한다', () => {
  it('서버가 준 state 를 그대로 쓴다', () => {
    expect(rowState({ state: 'ok' })).toBe(ROW_STATE.OK);
    expect(rowState({ state: 'fault' })).toBe(ROW_STATE.FAULT);
    expect(rowState({ state: 'warn' })).toBe(ROW_STATE.WARN);
  });
  it('값이 없거나 모르는 값이면 확인 불가다 — 초록으로 칠하는 폴백을 만들지 않는다', () => {
    expect(rowState({})).toBe(ROW_STATE.UNKNOWN);
    expect(rowState(null)).toBe(ROW_STATE.UNKNOWN);
    expect(rowState({ state: 'green' })).toBe(ROW_STATE.UNKNOWN);
    // 점검을 돌리지 않은 행에 probe.state 만 있어도 여기서 판정하지 않는다(복제 금지).
    expect(rowState({ probe: { state: 'ok' } })).toBe(ROW_STATE.UNKNOWN);
  });
  it('네 상태 모두 라벨·색이 있다', () => {
    for (const s of Object.values(ROW_STATE)) {
      expect(ROW_LABEL[s]).toBeTruthy();
      expect(ROW_TONE[s]).toBeTruthy();
    }
  });
});

describe('근거 강도 — 증명과 추정을 섞지 않는다', () => {
  it('200 일 때만 증명이라 말한다', () => {
    expect(evidenceText({ probe: { state: 'ok' } })).toContain('증명');
    for (const st of ['token-mismatch', 'edge-no-token', 'skip-no-token', 'wrong-edge', 'unreachable', 'timeout', 'http', 'old-route', 'not-run']) {
      expect(evidenceText({ probe: { state: st } })).not.toContain('증명');
    }
  });
  it("토큰 거부는 '다르다' 까지만 말하고 '무엇과 다른지' 는 지어내지 않는다", () => {
    const s = evidenceText({ probe: { state: 'token-mismatch' } });
    expect(s).toContain('다릅니다');
    expect(s).toContain('알 수 없습니다');
  });
  it("'토큰 없음' 을 인증 실패라 말하지 않는다", () => {
    const s = evidenceText({ probe: { state: 'skip-no-token' } });
    expect(s).not.toContain('거부');
    expect(s).toContain('없습니다');
  });
  it('모든 프로브 상태에 라벨·색이 있다', () => {
    for (const st of Object.keys(PROBE_LABEL)) expect(PROBE_TONE[st]).toBeTruthy();
  });
});

describe('중앙 토큰 축 — 한계를 항상 말한다', () => {
  it('보고가 없으면 중앙이 해시만 갖고 있다는 사실을 말한다', () => {
    const s = centralAxisText({});
    expect(s).toContain('해시');
    expect(s).not.toContain('증명');
  });
  it('구버전이면 업그레이드를 말한다(기다리면 된다고 하지 않는다)', () => {
    const s = centralAxisText({ capability: 'old-version' });
    expect(s).toContain('구버전');
    expect(s).toContain('업그레이드');
  });
  it('개별 토큰 + 이름 일치만 증명이다', () => {
    expect(centralAxisText({ edge: { fact: 'agent', selfProbe: {} } })).toContain('증명');
    expect(centralAxisText({ edge: { fact: 'shared', selfProbe: {} } })).not.toContain('증명');
    expect(centralAxisText({ edge: { fact: 'rejected', selfProbe: {} } })).not.toContain('증명');
  });
  it('공유 토큰을 결함이라 말하지 않되 기능 결손을 밝힌다', () => {
    const s = centralAxisText({ edge: { fact: 'shared', selfProbe: {} } });
    expect(s).toContain('결함은 아니지만');
    expect(s).toContain('403');
  });
  it('토큰 뒤바뀜은 상대 이름을 적는다', () => {
    const s = centralAxisText({ edge: { fact: 'agent-wrong-name', selfProbe: { yourAgent: 'MI' } } });
    expect(s).toContain('MI');
    expect(s).toContain('뒤바뀌');
  });
  it('모든 사실값에 라벨·색이 있다', () => {
    for (const f of Object.keys(EDGE_FACT_LABEL)) expect(EDGE_FACT_TONE[f]).toBeTruthy();
  });
});

describe('중복 문구', () => {
  it('공유 토큰 강화 모드면 위험을 다르게 말하되 괜찮다고 하지 않는다', () => {
    const d = { kind: 'collector-equals-central', short: 'aaaa1111', len: 30, members: [{ scope: 'collector', agent: 'A' }, { scope: 'shared-central', agent: '(공유)' }] };
    const off = dupText(d, {});
    const on = dupText(d, { requireAgentToken: true });
    expect(off).toContain('권한 상승');
    expect(on).not.toContain('**권한 상승 — 즉시 고치세요.**');
    expect(on).toContain('끄는 순간');
    expect(on).toContain('바꾸세요');
  });
  it('모든 중복 종류에 라벨이 있다', () => {
    for (const k of ['collector-equals-central', 'cross-edge', 'deploy-target', 'same-edge-multi-role', 'by-design']) {
      expect(DUP_LABEL[k]).toBeTruthy();
      expect(dupText({ kind: k, members: [] })).toBeTruthy();
    }
  });
  it('scope 라벨이 원문 키를 그대로 노출하지 않는다', () => {
    for (const s of ['collector', 'shared-central', 'self-collector', 'deploy-collector', 'deploy-central']) {
      expect(scopeLabel(s)).not.toBe(s);
    }
  });
});

describe('지문 표기 — 값이 없으면 단위를 붙이지 않는다', () => {
  it('미설정은 —', () => {
    expect(fpText(null)).toBe('—');
    expect(fpText({ set: false })).toBe('—');
  });
  it('길이가 결측이면 0자 라고 쓰지 않는다', () => {
    // ⚠ Number(null)===0 · Number('')===0 함정. 0자로 찍히면 '빈 토큰' 이라는 거짓이다.
    expect(fpText({ set: true, short: 'abcd1234', len: null })).toBe('abcd1234');
    expect(fpText({ set: true, short: 'abcd1234', len: '' })).toBe('abcd1234');
    expect(fpText({ set: true, short: 'abcd1234', len: 43 })).toBe('abcd1234 · 43자');
    expect(fpText({ set: true, short: 'abcd1234', len: 43, space: true })).toContain('앞뒤 공백');
  });
  it('지문의 한계를 항상 말한다', () => {
    const s = fpLimitNote();
    expect(s).toContain('8자');
    expect(s).toContain('다르면 확실히 다르고');
  });
});

describe('배너 — 측정 전을 정상이라 말하지 않는다', () => {
  it('엣지가 없으면 그 사실을 말한다', () => {
    expect(bannerText({ kpis: { total: 0 } }).tone).toBe('gray');
  });
  it('측정 0 이면 저장값 대조뿐이라고 말한다', () => {
    const b = bannerText({ kpis: { total: 3, measured: 0 }, findingCounts: {} });
    expect(b.tone).toBe('gray');
    expect(b.text).toContain('지금 점검');
    expect(b.text).not.toContain('정상입니다');
  });
  it('결함이 있으면 빨강', () => {
    expect(bannerText({ kpis: { total: 3, measured: 3, fault: 2 }, findingCounts: { fault: 2 } }).tone).toBe('red');
    // 두 축에 안 걸리는 새 결함 코드가 생겨도 조용히 초록이 되지 않는다(폴백).
    const b = bannerText({ kpis: { total: 3, measured: 3, fault: 0, dupFault: 0 }, findingCounts: { fault: 1 } });
    expect(b.tone).toBe('red');
    expect(b.text).toContain('결함 발견 1건');
  });
  it('확인 불가만 있으면 초록이 아니다', () => {
    const b = bannerText({ kpis: { total: 3, measured: 2 }, findingCounts: { unknown: 1 } });
    expect(b.tone).toBe('amber');
    expect(b.text).toContain('뜻이 아닙니다');
  });
  it('전부 정상일 때만 초록', () => {
    expect(bannerText({ kpis: { total: 3, measured: 3 }, findingCounts: {} }).tone).toBe('green');
  });
});

describe('정상률 — 0% 와 미측정을 구분한다', () => {
  it('null 은 —', () => {
    expect(okRateText({ okRate: null })).toBe('—');
    expect(okRateText({})).toBe('—');
    expect(okRateText({ okRate: '' })).toBe('—');
  });
  it('0 은 0%', () => { expect(okRateText({ okRate: 0 })).toBe('0%'); });
});

describe('각주 — 해당 종류가 있을 때만', () => {
  it('항상 나오는 것은 지문 한계뿐이다', () => {
    const f = tableFootnotes({ rows: [{ registered: true, edge: {}, probe: { state: 'ok' } }] }, {});
    expect(f).toHaveLength(1);
  });
  it('등록부 없는 행이 있으면 그 사실을 설명한다', () => {
    const f = tableFootnotes({ rows: [{ registered: false, edge: {}, probe: { state: 'ok' } }] }, {});
    expect(f.join(' ')).toContain('등록부 없음');
  });
  it('보고가 없는 행이 있으면 최소 버전을 서버 값으로 적는다(숫자를 박지 않는다)', () => {
    const f = tableFootnotes({ rows: [{ registered: true, probe: { state: 'ok' } }] }, { minEdgeVersion: '9.9.9' });
    expect(f.join(' ')).toContain('9.9.9');
  });
  it('토큰 거부 행이 있으면 다음 단서를 안내한다', () => {
    const f = tableFootnotes({ rows: [{ registered: true, edge: {}, probe: { state: 'token-mismatch' } }] }, {});
    expect(f.join(' ')).toContain('portal.env');
  });
  it('배포 대상이 있으면 찔러보지 않는다는 사실을 밝힌다', () => {
    const f = tableFootnotes({ rows: [{ registered: true, edge: {}, probe: { state: 'ok' }, deploy: { present: true } }] }, {});
    expect(f.join(' ')).toContain('저장값끼리만');
  });
});

describe('실행 요약 — 건너뛴 것을 밝힌다', () => {
  it('예산 초과를 조용히 빼지 않는다', () => {
    const s = runSummary({ probed: 10, budgetExceeded: 3, ms: 12_345 });
    expect(s).toContain('10곳 점검');
    expect(s).toContain('3곳은 시도하지 않았습니다');
  });
  it('0 은 표시하지 않는다(없는 문제를 만들지 않는다)', () => {
    expect(runSummary({ probed: 2, budgetExceeded: 0, failed: 0, ms: 500 })).not.toContain('시도하지 않았');
  });
  it('빈 응답에 문장을 지어내지 않는다', () => { expect(runSummary(null)).toBe(''); });
});

describe('발견 문구', () => {
  it('모든 코드에 제목과 조치가 있다', () => {
    for (const [code, v] of Object.entries(FINDING_TEXT)) {
      expect(v.title, code).toBeTruthy();
      expect(v.fix, code).toBeTruthy();
      expect(v.title, code).not.toContain('`');
      expect(v.fix, code).not.toContain('`');
    }
  });
  it('모르는 코드는 문장을 지어내지 않는다', () => {
    expect(findingLine({ code: 'nope', agent: 'A' })).toContain('nope');
  });
  it('위생 항목은 어느 파일을 고칠지 구분해 적는다', () => {
    const a = findingLine({ code: 'hygiene-space', agent: 'A', facts: { where: 'central-collector' } });
    const b = findingLine({ code: 'hygiene-space', agent: 'A', facts: { where: 'edge-collector' } });
    expect(a).toContain('중앙 등록값');
    expect(b).toContain('엣지의 수집 토큰');
    expect(a).not.toBe(b);
  });
});

describe('같은 문장을 반복하지 않는다 — 묶은 줄', () => {
  it('여러 엣지가 같은 코드면 한 줄에 개수와 대상을 적는다', () => {
    const line = findingGroupLine({ code: 'edge-shared-token', grade: 'warn', count: 5, agents: ['GM2', 'MI', 'NB', 'SN', 'WA'], facts: {} });
    expect(line).toContain('5곳');
    expect(line).toContain('GM2 · MI · NB · SN · WA');
    // 제목과 조치가 한 번만 나온다.
    expect(line.split('공유 중앙 토큰을 쓰고 있습니다').length - 1).toBe(1);
  });
  it('1곳이면 개수를 적지 않는다(없는 강조를 만들지 않는다)', () => {
    const line = findingGroupLine({ code: 'edge-shared-token', grade: 'warn', count: 1, agents: ['MI'], facts: {} });
    expect(line).not.toContain('1곳');
    expect(line).toContain('MI');
  });
  it('엣지 목록이 길면 자르고 자른 개수를 밝힌다', () => {
    const many = Array.from({ length: 28 }, (_, i) => `E${i}`);
    const line = findingGroupLine({ code: 'edge-shared-token', grade: 'warn', count: 28, agents: many, facts: {} });
    expect(line).toContain('외 20곳');
    expect(agentsText(many)).toContain('외 20곳');
    expect(agentsText([])).toBe('');
  });
  it('위생 항목은 어느 파일인지 유지한다', () => {
    const line = findingGroupLine({ code: 'hygiene-space', grade: 'warn', count: 2, agents: ['A', 'B'], facts: { where: 'edge-collector' } });
    expect(line).toContain('엣지의 수집 토큰');
  });
  it('모르는 코드는 문장을 지어내지 않는다', () => {
    expect(findingGroupLine({ code: 'nope', grade: 'warn', count: 1, agents: ['A'] })).toContain('nope');
  });
  it('조치 문구에 em-dash 가 두 번 이상 나오지 않는다(3단 대시로 읽기 어려워진다)', () => {
    for (const [code, v] of Object.entries(FINDING_TEXT)) {
      expect(String(v.fix).includes(' — '), code).toBe(false);
    }
  });
});

describe('배너는 두 축을 나눠 말한다', () => {
  it('중복만 있으면 KPI 결함 칸(0)과 모순되지 않게 적는다', () => {
    const b = bannerText({ kpis: { total: 6, measured: 0, fault: 0, dupFault: 2 }, findingCounts: { fault: 2 } });
    expect(b.tone).toBe('red');
    expect(b.text).toContain('중복 토큰 2건');
    expect(b.text).not.toContain('결함 2건');
  });
  it('엣지 결함이 있으면 그 개수를 쓴다', () => {
    const b = bannerText({ kpis: { total: 6, measured: 3, fault: 1, dupFault: 0 }, findingCounts: { fault: 1 } });
    expect(b.text).toContain('엣지 1곳에 결함');
  });
  it('둘 다면 둘 다 말한다', () => {
    const b = bannerText({ kpis: { total: 6, measured: 3, fault: 1, dupFault: 2 }, findingCounts: { fault: 3 } });
    expect(b.text).toContain('엣지 1곳에 결함');
    expect(b.text).toContain('중복 토큰 2건');
  });
});

describe('사유를 이어 붙일 때 문장이 깨지지 않는다', () => {
  it('끝 마침표를 겹치지 않고 대시를 3단으로 만들지 않는다', () => {
    // ⚠ v2.560 스크린샷 판독에서 잡은 결함: `…않습니다..` 와 `A — B — C` 가 찍혔다.
    const s = centralAxisText({ edge: { fact: 'not-run', selfProbe: { reason: 'CENTRAL_URL 이 설정되지 않았습니다 — 이 엣지는 중앙으로 보고하지 않습니다.' } } });
    expect(s).not.toContain('..');
    expect(s.split(' — ').length - 1).toBeLessThanOrEqual(1);
    expect(s).toContain('(CENTRAL_URL');
  });
  it('사유가 없으면 괄호를 만들지 않는다', () => {
    expect(reasonTail('')).toBe('.');
    expect(reasonTail(null)).toBe('.');
    expect(centralAxisText({ edge: { fact: 'unknown', selfProbe: {} } })).toBe('확인하지 못했습니다.');
  });
});

describe('v2.600 WEB2600-01·03 — 점검 결과 표시', () => {
  it('점검을 돌렸는데 전부 응답이 없으면 \'돌리지 않았다\' 고 말하지 않는다', () => {
    const scan = { kpis: { total: 2, measured: 0, fault: 0 }, findingCounts: {},
      rows: [{ probe: { state: 'unreachable' } }, { probe: { state: 'timeout' } }] };
    const b = bannerText(scan);
    expect(b.tone).toBe('amber');
    expect(b.text).toContain('엣지 2곳이 응답하지 않았습니다');
    expect(b.text).not.toContain('아직 통신 점검을 돌리지 않았습니다');
    expect(b.text).not.toContain('정상입니다');
  });
  it('토큰이 없어 건너뛴 것도 따로 말한다', () => {
    const b = bannerText({ kpis: { total: 1, measured: 0 }, findingCounts: {}, rows: [{ probe: { state: 'skip-no-token' } }] });
    expect(b.text).toContain('수집 토큰이 없어');
  });
  it('프로브가 한 번도 없으면 예전처럼 \'지금 점검\' 을 안내한다', () => {
    const b = bannerText({ kpis: { total: 1, measured: 0 }, findingCounts: {}, rows: [{ probe: { state: 'not-run' } }, {}] });
    expect(b.tone).toBe('gray');
    expect(b.text).toContain('지금 점검');
  });
  it('POST 응답을 얹어도 GET 이 준 limits·centralAuth 가 남는다', () => {
    const prev = { rows: [1], limits: { concurrency: 4, timeoutMs: 8000 }, centralAuth: { requireAgentToken: true }, running: '' };
    const merged = mergeRunResult(prev, { ok: true, probed: 3, rows: [1, 2], limits: undefined });
    expect(merged.limits).toEqual({ concurrency: 4, timeoutMs: 8000 });
    expect(merged.centralAuth.requireAgentToken).toBe(true);
    expect(merged.rows).toEqual([1, 2]);
    expect(merged.probed).toBe(3);
  });
  it('limits 가 없으면 단위를 붙이지 않는다(0초·?곳 금지)', () => {
    expect(limitsText(undefined)).toBe('동시 — · 요청 시한 —');
    expect(limitsText({ concurrency: 4, timeoutMs: 8000 })).toBe('동시 4곳 · 요청 시한 8초');
  });
});

describe('edgeReportCell (v2.601 WEB2601-03 — 받지 못한 보고를 N초 전 으로 쓰지 않는다)', () => {
  const ago = (ts) => `${ts}ago`;
  it('한 번도 받지 못했고 마지막 시도가 실패면 시각 없이 실패', () => {
    const c = edgeReportCell({ at: 1000, ok: false, kind: 'auth', tokens: null, version: '', said: '',
      lastAttempt: { at: 1000, ok: false, kind: 'auth', reason: '토큰 불일치' } }, '', ago);
    expect(c.text).not.toContain('ago');
    expect(c.text).toContain('토큰 거부');
    expect(c.sortAt).toBe(0); expect(c.tone).toBe('red');
  });
  it('보고를 받은 뒤 실패하면 이전 보고 시각 + 이후 실패', () => {
    const c = edgeReportCell({ at: 500, ok: false, tokens: {}, version: '2.600.0',
      lastAttempt: { at: 900, ok: false, kind: 'unreachable', reason: 'ECONNREFUSED' } }, '', ago);
    expect(c.text).toBe('500ago · 이후 실패(닿지 못함)');
    expect(c.sortAt).toBe(500);
  });
  it('정상 보고는 시각만, 시도 기록이 없으면 없음/구버전', () => {
    expect(edgeReportCell({ at: 700, ok: true, tokens: {}, lastAttempt: { ok: true } }, '', ago).text).toBe('700ago');
    expect(edgeReportCell(null, 'old-version', ago).text).toBe('구버전');
    expect(edgeReportCell(null, '', ago).text).toBe('없음');
  });
});

describe('edgeReportCell — 서버 reportAt 을 판정 근거로 (v2.601 WEB2601-03 후속)', () => {
  const ago = (ts) => `${ts}ago`;
  it('reportAt 이 null 이면 내용이 남아 있어도 받은 보고가 아니다', () => {
    const c = edgeReportCell({ at: 900, reportAt: null, ok: false, version: '2.600.0', lastAttempt: { ok: false, kind: 'timeout' } }, '', ago);
    expect(c.text).toBe('없음 · 실패(시한 초과)');
  });
  it('보고 시각은 at(마지막 시도) 이 아니라 reportAt', () => {
    const c = edgeReportCell({ at: 900, reportAt: 500, ok: false, lastAttempt: { ok: false, kind: 'auth' } }, '', ago);
    expect(c.text).toBe('500ago · 이후 실패(토큰 거부)');
    expect(edgeReportCell({ at: 800, reportAt: 800, ok: true, lastAttempt: { ok: true } }, '', ago).text).toBe('800ago');
  });
});

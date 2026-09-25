/**
 * edgeLogText.js 회귀(v2.549) — 고정하는 것은 **이 화면이 만들 수 있는 거짓**이다.
 * 웹 테스트는 node 환경(DOM 없음)이라 컴포넌트 렌더가 아니라 판정·문구를 본다.
 */
import { describe, it, expect } from 'vitest';
import {
  EDGE_KIND_LABEL, EDGE_KIND_TONE, toneVar, ageText, msText, edgeHint, FETCH_KIND_TEXT,
  fetchResultText, jobText, storeNote, logNote, maskNote, logRedactNote, lastAttemptNote, tableFootnotes,
  groupStatus, statusSummary, levelTone, identityNote, unregisteredNote,
} from './edgeLogText.js';

const NOW = 1_700_000_000_000;

describe('엣지 행 판정', () => {
  it('아직 안 가져온 것을 이상이라 말하지 않는다', () => {
    const h = edgeHint({ kind: 'ready' });
    expect(h.can).toBe(true);
    expect(h.text).toContain('이상이 아닙니다');
    expect(EDGE_KIND_TONE.ready).toBe('idle');
  });

  it('구버전·비활성·URL 없음은 눌러도 안 된다고 말한다', () => {
    for (const k of ['old-version', 'disabled', 'no-url']) {
      expect(edgeHint({ kind: k }, { minVersion: '2.549.0' }).can).toBe(false);
    }
    expect(edgeHint({ kind: 'old-version' }, { minVersion: '2.549.0' }).text).toContain('2.549.0');
  });

  it('버전 미상은 "모른다" 이고 시도는 할 수 있다', () => {
    const h = edgeHint({ kind: 'unknown-version' });
    expect(h.can).toBe(true);
    expect(h.text).toContain('버전을 모릅니다');
    expect(h.text).not.toContain('꺼져');
  });

  it('모든 kind 에 라벨과 톤이 있다', () => {
    for (const k of Object.keys(EDGE_KIND_LABEL)) expect(EDGE_KIND_TONE[k]).toBeTruthy();
  });
});

describe('가져오기 결과', () => {
  it('실패 원인마다 다른 조치를 말한다 — 한 문구로 덮지 않는다', () => {
    const texts = Object.values(FETCH_KIND_TEXT);
    expect(new Set(texts).size).toBe(texts.length);
    expect(FETCH_KIND_TEXT.auth).toContain('COLLECTOR_TOKEN');
    expect(FETCH_KIND_TEXT.auth).toContain('다시 눌러도 결과는 같습니다');
    expect(FETCH_KIND_TEXT['old-version']).toContain('업그레이드');
    expect(FETCH_KIND_TEXT.unreachable).toContain('닿지 못했습니다');
    // ⚠ 폴백 등록 사실은 `queued` 분기가 **한 번만** 말한다(v2.549 판독에서 같은 문장이 두 번 떴다).
    expect(FETCH_KIND_TEXT.unreachable).not.toContain('폴백');
    expect(FETCH_KIND_TEXT.timeout).not.toContain('폴백');
  });

  it('실패했는데 보관분을 보여줄 때는 "지금 상태가 아니다" 를 반드시 말한다', () => {
    const r = fetchResultText({ ok: false, kind: 'unreachable', queued: { state: 'pending' }, snap: { at: NOW - 600_000 } }, { now: NOW });
    expect(r.tone).toBe('bad');
    expect(r.text).toContain('지금 상태가 아닙니다');
    expect(r.text).toContain('폴백');
  });

  it('성공은 줄 수와 소요를 말한다', () => {
    const r = fetchResultText({ ok: true, ms: 1200, snap: { logs: { count: 400 } } });
    expect(r.tone).toBe('ok');
    expect(r.text).toContain('400줄');
    expect(r.text).toContain('1.2초');
  });
});

describe('폴백 대기', () => {
  it('대기 없음이면 문구를 만들지 않는다', () => {
    expect(jobText({ state: 'none' })).toBe('');
    expect(jobText({})).toBe('');
  });
  it('인출됨은 회신 대기라고 말한다', () => {
    const s = jobText({ state: 'claimed', at: NOW, tries: 2, deadline: NOW + 30_000 }, { now: NOW, jobs: { maxTries: 2 } });
    expect(s).toContain('인출');
    expect(s).toContain('마지막 시도');
  });
});

describe('각주', () => {
  it('해당 종류가 없으면 줄도 없다(같은 말이 화면을 덮지 않게)', () => {
    expect(tableFootnotes({})).toEqual([]);
    expect(tableFootnotes({ have: 3, ready: 2 })).toEqual([]);
  });
  it('있는 종류만 조치를 한 번 적는다', () => {
    const f = tableFootnotes({ 'old-version': 2, disabled: 1 }, { minVersion: '2.549.0' });
    expect(f).toHaveLength(2);
    expect(f[0]).toContain('2.549.0');
    expect(f.join(' ')).toContain('활성화');
  });
});

describe('실패 행', () => {
  it('보관분이 있으면 "지금 상태가 아니다" 를 말한다', () => {
    expect(edgeHint({ kind: 'failed', hasData: true, last: { error: 'e' } }).text).toContain('지금 상태가 아닙니다');
    expect(edgeHint({ kind: 'failed', hasData: false, last: { error: 'e' } }).text).toContain('보관된 로그는 없습니다');
  });
});

describe('마지막 시도', () => {
  it('실패 기록을 보관분으로 말하지 않는다', () => {
    expect(lastAttemptNote(null)).toBe('');
    expect(lastAttemptNote({ ok: true, at: NOW })).toBe('');
    const s = lastAttemptNote({ ok: false, at: NOW - 120_000, error: 'ECONNREFUSED' }, { now: NOW });
    expect(s).toContain('실패');
    expect(s).toContain('ECONNREFUSED');
  });
});

describe('보관소', () => {
  it('비었을 때 "재시작해서 비었다" 와 "한 번도 안 가져왔다" 를 구분한다', () => {
    const restarted = storeNote({ agents: 0, sinceAt: NOW - 60_000 }, { rows: [1, 2], now: NOW });
    expect(restarted.kind).toBe('empty-restarted');
    expect(restarted.text).toContain('재시작');
    const fresh = storeNote({ agents: 0, sinceAt: NOW - 5 * 3_600_000 }, { rows: [1, 2], now: NOW });
    expect(fresh.kind).toBe('empty-fresh');
    expect(fresh.text).toContain('이상이 아닙니다');
  });

  it('보관분이 있으면 메모리에만 있다는 사실을 말한다 — 숫자는 서버 값을 쓴다', () => {
    const s = storeNote({ agents: 3, keepPerAgent: 10, sinceAt: NOW - 3_600_000 }, { now: NOW });
    expect(s.kind).toBe('have');
    expect(s.text).toContain('메모리');
    expect(s.text).toContain('10건');
  });
});

describe('로그 구획', () => {
  it('비었다를 "아무 일도 없었다" 로 말하지 않는다', () => {
    const r = logNote({ logs: { count: 0 } });
    expect(r.text).toContain('아무 일도 없었다는 뜻이 아닙니다');
  });
  it('자른 줄 수를 밝힌다(조용한 상한 금지)', () => {
    const r = logNote({ logs: { count: 400, truncated: true, omitted: 133 } }, { limits: { maxLimit: 1000 } });
    expect(r.text).toContain('133줄');
    expect(r.text).toContain('1000줄');
  });
  it('가림 개수는 0 이면 문구를 만들지 않는다', () => {
    expect(maskNote({ maskedFields: 0 })).toBe('');
    expect(maskNote({ maskedFields: 3 })).toContain('3개');
  });
  it('로그 가림의 한계를 항상 말한다', () => {
    expect(logRedactNote()).toContain('남을 수 있');
  });
});

describe('진행상태 요약', () => {
  it('전부 읽었어도 "정상" 이라고 말하지 않는다', () => {
    const s = statusSummary({ status: [{ ok: true }, { ok: true }] });
    expect(s.kind).toBe('ok');
    expect(s.text).toContain("'정상' 이라는 뜻은 아닙니다");
  });
  it('확인 불가를 "꺼짐" 이라 하지 않는다', () => {
    const s = statusSummary({ status: [{ ok: true }, { ok: false }] });
    expect(s.kind).toBe('partial');
    expect(s.failed).toBe(1);
    expect(s.text).toContain("'꺼짐' 이 아닙니다");
  });
  it('상태가 없는 보관분은 그렇다고 말한다', () => {
    expect(statusSummary({ status: null }).kind).toBe('none');
  });
  it('그룹 라벨은 서버가 준 것만 쓴다', () => {
    const g = groupStatus([{ key: 'a', group: 'push', ok: true }, { key: 'b', group: 'push', ok: false }], { push: '중앙 전송' });
    expect(g).toHaveLength(1);
    expect(g[0].label).toBe('중앙 전송');
    expect(g[0].failed).toBe(1);
  });
});

describe('정체 대조·잡다', () => {
  it('이름이 다르면 그 사실을 말한다', () => {
    expect(identityNote({ agent: 'E1', last: { node: { agent: 'E1' } } })).toBe('');
    expect(identityNote({ agent: 'E1', last: { node: { agent: 'OTHER' } } })).toContain('AGENT_NAME');
  });
  it('등록부에 없는 행은 새로 가져올 수 없다고 말한다', () => {
    expect(unregisteredNote({})).toBe('');
    expect(unregisteredNote({ unregistered: true })).toContain('등록부에 없는 이름');
  });
  it('값이 없으면 —, 0 으로 만들지 않는다', () => {
    expect(ageText(null)).toBe('—');
    expect(ageText(0)).toBe('—');
    expect(msText(null)).toBe('—');
    expect(msText(0)).toBe('0ms');
  });
  it('레벨 색', () => {
    expect(levelTone('error')).toBe('bad');
    expect(levelTone('warn')).toBe('warn');
    expect(levelTone('log')).toBe('idle');
    expect(toneVar('bad')).toContain('--red'); // v2.613 DEPS2613-11: 공용 toneVar(테마 토큰 --red)
  });
});

describe('마크다운 누출 방지', () => {
  it('BoldText 가 못 그리는 마크다운(백틱)을 문구에 넣지 않는다', () => {
    const all = [
      ...Object.values(FETCH_KIND_TEXT),
      ...Object.values(EDGE_KIND_LABEL),
      logRedactNote(),
      edgeHint({ kind: 'ready' }).text,
      edgeHint({ kind: 'old-version' }, { minVersion: '2.549.0' }).text,
      storeNote({ agents: 0, sinceAt: NOW }, { now: NOW }).text,
      logNote({ logs: { count: 0 } }).text,
      maskNote({ maskedFields: 1 }),
      identityNote({ agent: 'a', last: { node: { agent: 'b' } } }),
      unregisteredNote({ unregistered: true }),
    ];
    for (const s of all) expect(s).not.toContain("\u0060");   // BoldText 는 **강조** 만 그린다 — 백틱은 글자로 샌다
  });
});

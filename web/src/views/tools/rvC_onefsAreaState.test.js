/**
 * 검토 I-03(v2.730) — OneFS 영역 배지 판정. 전체 성공만 초록, 첫 성공 뒤 멈춤은 호박색 '부분', 첫 요청 전 멈춤은 '미시도',
 * 구버전 수집기 요약에서 마지막으로 시도한 영역은 '완료 여부 미상'(거짓 초록 금지).
 * 입력은 서버 수집기(storage/areasCollector.js)가 실제로 내는 모양 그대로다(server/test/rvC_onefsAreas.test.js 와 짝).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { areaState, areaStates, areasStopNoteFull, areasEndpointText, AREA_KIND, STOP_CAUSE } from './onefsAreaState.js';
import { stripComments } from '../../test/_stripComments.js';

/** v2.729 까지의 인라인 판정(StorageMonTool.jsx) — 재현 기록용. */
const oldTone = (a) => (a.notTried ? 'amber' : a.skipped ? 'gray' : a.failed === 0 ? 'green' : a.ok > 0 ? 'amber' : 'red');

const PARTIAL_DEADLINE = { area: 'cluster', ok: 1, failed: 0, expectedEndpoints: 3, attempted: 1, notTriedEndpoints: 2, partial: true, stopReason: 'deadline' };
const NOT_TRIED_NEW = { area: 'cluster', ok: 0, failed: 0, skipped: true, notTried: true, expectedEndpoints: 3, attempted: 0, notTriedEndpoints: 3, partial: false, stopReason: 'deadline', error: '영역 수집 시한 초과로 이번 주기에는 시도하지 않았습니다' };
const FULL_OK = { area: 'node', ok: 1, failed: 0, expectedEndpoints: 1, attempted: 1, notTriedEndpoints: 0, partial: false };
const AUTH_PARTIAL = { area: 'cluster', ok: 1, failed: 1, expectedEndpoints: 3, attempted: 2, notTriedEndpoints: 1, partial: true, stopReason: 'auth', error: '인증 실패(401) — 계정/비밀번호 확인' };
const TRANSPORT_STOP = { area: 'filesystem', ok: 0, failed: 1, expectedEndpoints: 2, attempted: 1, notTriedEndpoints: 1, partial: true, stopReason: 'transport', error: '연결 거부' };

describe('onefsAreaState (검토 I-03)', () => {
  it('재현: 예전 판정은 첫 성공 뒤 시한·첫 요청 전 시한을 초록으로 칠했다', () => {
    expect(oldTone({ area: 'cluster', ok: 1, failed: 0 })).toBe('green');
    expect(oldTone({ area: 'cluster', ok: 0, failed: 0 })).toBe('green');
  });

  it('첫 성공 뒤 시한 → 호박색 부분 수집(예정·성공 수와 미시도 수를 말한다)', () => {
    const s = areaState(PARTIAL_DEADLINE);
    expect(s.kind).toBe(AREA_KIND.PARTIAL);
    expect(s.tone).toBe('amber');
    expect(s.suffix).toBe(' 부분 1/3');
    expect(s.title).toContain('엔드포인트 2개');
    expect(s.title).toContain(STOP_CAUSE.deadline);
    expect(s.title).toContain('정상으로 보지 않습니다');
    expect(s.clickable).toBe(true); // 읽은 원문은 열어 볼 수 있다
  });

  it('첫 요청 전 중단 → 미시도(새 모양·구버전 {ok:0,failed:0} 모두), 비활성과 구분', () => {
    const a = areaState(NOT_TRIED_NEW);
    expect(a.kind).toBe(AREA_KIND.NOT_TRIED);
    expect(a.suffix).toBe(' (미시도)');
    expect(a.title).toContain('엔드포인트 3개');
    expect(a.clickable).toBe(false);
    const legacyZero = areaState({ area: 'cluster', ok: 0, failed: 0 });
    expect(legacyZero.kind).toBe(AREA_KIND.NOT_TRIED);
    expect(legacyZero.tone).not.toBe('green');
    expect(areaState({ area: 'file', ok: 0, failed: 0, skipped: true, error: '경로 인자 필요' }).kind).toBe(AREA_KIND.DISABLED);
  });

  it('전체 성공만 초록', () => {
    const s = areaState(FULL_OK);
    expect(s.kind).toBe(AREA_KIND.OK);
    expect(s.tone).toBe('green');
    expect(s.suffix).toBe('');
    expect(s.title).toContain('모두 시도');
    // 예정보다 시도가 적으면(값만 남고 플래그가 빠진 경우라도) 초록이 아니다
    expect(areaState({ area: 'x', ok: 2, failed: 0, expectedEndpoints: 3 }).tone).not.toBe('green');
  });

  it('401 뒤 중단 · 연속 전송 오류도 같은 기준', () => {
    const a = areaState(AUTH_PARTIAL);
    expect(a.kind).toBe(AREA_KIND.PARTIAL);
    expect(a.title).toContain(STOP_CAUSE.auth);
    expect(a.title).toContain('401');
    const t = areaState(TRANSPORT_STOP);
    expect(t.kind).toBe(AREA_KIND.STOPPED_FAILED);
    expect(t.tone).toBe('red');
    expect(t.suffix).toBe(' 중단 0/2');
    expect(t.title).toContain(STOP_CAUSE.transport);
  });

  it('부분·실패가 섞이지 않은 끝까지 시도한 영역은 예전과 같다', () => {
    expect(areaState({ area: 'q', ok: 1, failed: 1, expectedEndpoints: 2, attempted: 2, notTriedEndpoints: 0, partial: false }).suffix).toBe(' 1/2');
    expect(areaState({ area: 'q', ok: 1, failed: 1, expectedEndpoints: 2, attempted: 2, notTriedEndpoints: 0, partial: false }).tone).toBe('amber');
    expect(areaState({ area: 'q', ok: 0, failed: 2 }).tone).toBe('red');
  });

  it('구버전 요약 — 멈춘 경우 마지막으로 시도한 영역만 완료 여부 미상, 그 앞은 예전 판정', () => {
    const extra = { areasStopped: 'deadline', areasNotTried: 2, areas: [
      { area: 'cluster', ok: 3, failed: 0 },
      { area: 'node', ok: 1, failed: 0 },                       // 멈춘 영역일 수 있다 — 끝까지 갔는지 모른다
      { area: 'hardware', ok: 0, failed: 0, skipped: true, notTried: true, error: '시한' },
      { area: 'capacity', ok: 0, failed: 0, skipped: true, notTried: true, error: '시한' },
      { area: 'file', ok: 0, failed: 0, skipped: true, error: '비활성' },
    ] };
    const st = areaStates(extra);
    expect(st.map((s) => s.kind)).toEqual([AREA_KIND.OK, AREA_KIND.UNKNOWN, AREA_KIND.NOT_TRIED, AREA_KIND.NOT_TRIED, AREA_KIND.DISABLED]);
    expect(st[1].tone).toBe('amber');
    expect(st[1].suffix).toBe(' (완료 여부 미상)');
    // 멈추지 않았으면 구버전 판정 그대로(마지막 영역도 초록)
    expect(areaStates({ areas: [{ area: 'a', ok: 1, failed: 0 }, { area: 'b', ok: 2, failed: 0 }] }).map((s) => s.tone)).toEqual(['green', 'green']);
    // 구버전 401 멈춤 영역에서 시도분이 전부 실패면 빨강(예전과 같다)
    expect(areaStates({ areasStopped: 'auth', areas: [{ area: 'cluster', ok: 0, failed: 1 }] })[0].tone).toBe('red');
    // 새 모양 요약에는 '완료 여부 미상' 을 붙이지 않는다(판정 근거가 있다)
    expect(areaStates({ areasStopped: 'deadline', areas: [FULL_OK, NOT_TRIED_NEW] }).map((s) => s.kind)).toEqual([AREA_KIND.OK, AREA_KIND.NOT_TRIED]);
  });

  it('멈춤 안내는 부분 영역 수·미시도 엔드포인트 수를 덧붙이고, 구버전이면 미상 뜻을 한 번만 말한다', () => {
    const n = areasStopNoteFull({ areasStopped: 'deadline', areasNotTried: 35, areasPartial: 1, areasNotTriedEndpoints: 65 });
    expect(n.text).toContain('35개');
    expect(n.text).toContain('**1개**');
    expect(n.text).toContain('**65개**');
    expect(areasStopNoteFull({})).toBeNull();
    const legacy = areasStopNoteFull({ areasStopped: 'deadline', areasNotTried: 2, areas: [{ area: 'cluster', ok: 1, failed: 0 }] });
    expect(legacy.text).toContain('완료 여부 미상');
    for (const k of ['auth', 'deadline', 'transport', 'xyz']) {
      const x = areasStopNoteFull({ areasStopped: k, areasNotTried: 1, areasPartial: 1, areasNotTriedEndpoints: 2 });
      expect(x.text + x.fix).not.toContain('`');
    }
  });

  it('머리글 엔드포인트 표기 — 예정 수를 알면 시도/예정, 값이 없으면 단위 없이', () => {
    expect(areasEndpointText({ areasEndpoints: 1, areasExpectedEndpoints: 66 })).toBe('1/66개');
    expect(areasEndpointText({ areasEndpoints: 66 })).toBe('66개');
    expect(areasEndpointText({})).toBe('—');
    expect(areasEndpointText({ areasEndpoints: 1, areasExpectedEndpoints: 66, areasDropped: 5 })).toContain('5건');
  });

  it('이상 입력에도 던지지 않는다(문자열·객체 원소·숫자 문자열)', () => {
    expect(() => areaStates({ areas: [null, 'x', 7, { area: 'c', ok: '1', failed: '0' }] })).not.toThrow();
    expect(areaStates({ areas: 'nope' })).toEqual([]);
    expect(areaStates(null)).toEqual([]);
    expect(areaStates({ areas: [{ area: 'c', ok: '1', failed: '0' }] })[0].tone).toBe('green');
  });

  it('문구에 백틱이 없다', () => {
    const all = [PARTIAL_DEADLINE, NOT_TRIED_NEW, FULL_OK, AUTH_PARTIAL, TRANSPORT_STOP, { area: 'x', ok: 1, failed: 0 }]
      .map((a) => areaState(a, { legacyStop: true }));
    for (const s of all) expect(s.title + s.suffix).not.toContain('`');
  });

  it('StorageMonTool 은 배지 색을 인라인으로 판정하지 않고 이 모듈을 쓴다', () => {
    const src = stripComments(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'StorageMonTool.jsx'), 'utf8'));
    expect(src).toMatch(/from '\.\/onefsAreaState\.js'/);
    expect(src).toMatch(/areaStates\(/);
    expect(src).not.toMatch(/a\.failed === 0 \? 'green'/);
    expect(src).not.toMatch(/areaBadgeSuffix\(/);
  });
});

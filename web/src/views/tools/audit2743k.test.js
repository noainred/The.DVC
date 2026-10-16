/**
 * audit2743k.test.js — v2.743 점검 그룹 GK 웹 회귀(WEB-03): CVP '지금 수집' 응답 문구·톤.
 *
 * 서버(routes/api/cvp.js /tools/cvp/collect)는 폴러가 수집 중이면 `{ok:true, direct:0, busy:true, directBusy:N, reason}` 을 준다.
 * 예전 collectSummary 는 busy·reason·skippedNonDemo 를 읽지 않아 '중앙 직접 수집 대상은 없습니다' 를 **초록 성공 배너**로 보였고,
 * 수집을 시작만 한 경우에도 '지금 수집했습니다' 라고 말했다. 판정·문구는 cvpText.collectResult 하나이고 CvpTool 이 그대로 쓴다.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../../test/_stripComments.js';
import * as T from './cvpText.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

describe('WEB-03 지금 수집 — busy 는 대상 없음이 아니다', () => {
  it('busy 응답: 시작하지 않았다 + 서버 사유 · 주의 톤(초록 아님)', () => {
    const r = { ok: true, direct: 0, requested: 0, busy: true, directBusy: 3, reason: '이전 수집이 진행 중입니다 — 끝난 뒤 다시 누르세요' };
    const m = T.collectResult(r);
    expect(m.tone).toBe('warn');
    expect(m.ok).toBe(false);
    expect(m.text).toContain('중앙 직접 3대는 **시작하지 않았습니다**');
    expect(m.text).toContain('진행 중');
    expect(m.text).not.toContain('중앙 직접 수집 대상은 없습니다'); // 수정 전 문구 그대로
  });
  it('구버전 서버(directBusy·reason 없음)도 대상 없음이라 말하지 않는다', () => {
    const m = T.collectResult({ ok: true, direct: 0, requested: 1, busy: true });
    expect(m.tone).toBe('warn');
    expect(m.text).toContain('중앙 직접 수집은 **시작하지 않았습니다**');
    expect(m.text).toContain('엣지 위임 1대');
  });
  it('direct>0 은 수집을 시작했다(지금 수집했다가 아니다) · 성공 톤', () => {
    const m = T.collectResult({ ok: true, direct: 2, requested: 0 });
    expect(m.tone).toBe('ok');
    expect(m.ok).toBe(true);
    expect(m.text).toContain('중앙 직접 2대는 수집을 시작했습니다');
    expect(m.text).not.toContain('지금 수집했습니다');
  });
  it('데모 계정이 뺀 엣지 위임 대수를 밝힌다(조용히 빼지 않는다)', () => {
    const t = T.collectSummary({ ok: true, direct: 0, requested: 1, skippedNonDemo: 4 });
    expect(t).toContain('요청하지 않았습니다');
    expect(t).toContain('4대');
    expect(T.collectSummary({ ok: true, direct: 1, requested: 0 })).not.toContain('요청하지 않았습니다');
  });
  it('거부(ok:false)는 실패 톤 + 사유', () => {
    const m = T.collectResult({ ok: false, reason: '없는(또는 꺼진) CVP 서버입니다.' });
    expect(m.tone).toBe('bad');
    expect(m.ok).toBe(false);
    expect(m.text).toContain('없는(또는 꺼진) CVP 서버입니다');
  });
  it('대상이 정말 없으면 그대로 대상 없음(바뀌지 않는다)', () => {
    const m = T.collectResult({ ok: true, direct: 0, requested: 0 });
    expect(m.tone).toBe('ok');
    expect(m.text).toContain('중앙 직접 수집 대상은 없습니다');
    expect(m.text).toContain('엣지 위임 대상은 없습니다');
  });
  it('문구에 백틱이 없다', () => {
    for (const r of [{ busy: true, direct: 0, directBusy: 1 }, { direct: 1 }, { ok: false, reason: 'x' }, { direct: 0, skippedNonDemo: 2 }]) {
      expect(T.collectSummary(r)).not.toMatch(/`/);
    }
  });
});

describe('WEB-03 CvpTool — 배너는 collectResult 의 톤을 그린다', () => {
  const src = stripComments(fs.readFileSync(path.join(HERE, 'CvpTool.jsx'), 'utf8'));
  it('지금 수집 성공 경로가 ok:true 를 고정하지 않는다', () => {
    expect(src).toMatch(/setMsg\(collectResult\(r\)\)/);
    expect(src).not.toMatch(/setMsg\(\{\s*ok:\s*true,\s*text:\s*collectSummary\(/);
  });
  it('주의 톤(warn)을 그린다', () => {
    expect(src).toMatch(/msg\.tone === 'warn' \? 'var\(--amber\)'/);
  });
});

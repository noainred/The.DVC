/**
 * views/audit2785d.test.js — v2.785 점검(GE 묶음) 웹 회귀.
 *  ① A-B2 개별 토큰 자동 적용: 409 본문 {ok:false, reason, jobId} 에서 r.job.id 로 TypeError(영어)가 나던 것.
 *  ② O-B1 토큰 점검 ②·③ 칸: 낡은 200·등록값이 바뀐 뒤의 결과를 '같음(증명)' 으로 그리지 않고 나이를 적는다.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyStartOutcome } from './edgeTokenApplyText.js';
import { probeAgeLine, sameTokenCell } from './tools/tokenProbeAge.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(HERE, rel), 'utf8');

describe('① A-B2 자동 적용 시작 응답', () => {
  it('정상 시작이면 그 작업을 따라간다', () => {
    expect(applyStartOutcome({ ok: true, job: { id: 'j1', state: 'running' } })).toEqual({ job: { id: 'j1', state: 'running' }, pollId: 'j1', error: '' });
  });
  it('409(이미 진행 중)면 서버 사유를 보이고 진행 중인 작업을 따라간다 — 예외를 던지지 않는다', () => {
    const o = applyStartOutcome({ ok: false, reason: '이 엣지에 이미 진행 중인 작업이 있습니다.', jobId: 'j9' });
    expect(o.job).toBe(null);
    expect(o.pollId).toBe('j9');
    expect(o.error).toMatch(/이미 진행 중/);
    expect(o.error).not.toMatch(/Cannot read|undefined/);
  });
  it('작업 id 가 없는 거부·빈 응답도 한국어 사유 하나로', () => {
    expect(applyStartOutcome({ ok: false, reason: '엣지 이름 형식이 올바르지 않습니다.' })).toEqual({ job: null, pollId: null, error: '엣지 이름 형식이 올바르지 않습니다.' });
    expect(applyStartOutcome(null).error).toBe('적용을 시작하지 못했습니다.');
    expect(applyStartOutcome({}).pollId).toBe(null);
    expect(applyStartOutcome({ ok: true }).error).toMatch(/작업 정보가 없습니다/);
  });
  it('화면은 r.job.id 를 바로 읽지 않고 이 함수를 거친다', () => {
    const src = read('EdgeTokenApply.jsx');
    const body = src.slice(src.indexOf('const start = async'), src.indexOf('const running ='));
    expect(body).toMatch(/applyStartOutcome\(r\)/);
    expect(body).not.toMatch(/r\.job\.id/);
  });
});

describe('② O-B1 토큰 점검 프로브 나이', () => {
  const now = Date.now();
  const ago = (ts) => `${Math.floor((now - ts) / 60_000)}분 전`;
  it('신선한 200 은 같음(증명) + 회색 나이', () => {
    const p = { state: 'ok', at: now - 5 * 60_000, stale: false, ageMs: 300_000 };
    expect(sameTokenCell(p)).toEqual({ text: '같음(증명)', tone: 'green' });
    expect(probeAgeLine(p, ago)).toEqual({ text: '5분 전', tone: 'gray', title: '' });
  });
  it('낡은 200 은 증명이라 말하지 않고 낡음을 적는다', () => {
    const p = { state: 'ok', at: now - 90 * 60_000, stale: true };
    expect(sameTokenCell(p).text).not.toMatch(/증명/);
    expect(sameTokenCell(p).tone).not.toBe('green');
    const line = probeAgeLine(p, ago);
    expect(line.text).toBe('90분 전 · 낡음');
    expect(line.tone).toBe('amber');
  });
  it('등록값이 바뀐 뒤면 그 사실을 적는다(서버가 not-run + changed 로 준다)', () => {
    const p = { state: 'not-run', at: now - 60_000, changed: true, changedWhat: 'token', reason: '지난 점검 뒤 등록부의 수집 토큰이 바뀌었습니다' };
    expect(probeAgeLine(p, ago).text).toBe('등록 토큰 바뀜 · 다시 점검 필요');
    expect(probeAgeLine({ ...p, changedWhat: 'url' }, ago).text).toMatch(/URL/);
    expect(sameTokenCell(p).text).toBe('확인 불가');
  });
  it('결과·시각이 없으면 아무것도 그리지 않는다', () => {
    expect(probeAgeLine(null, ago).text).toBe('');
    expect(probeAgeLine({ state: 'ok' }, ago).text).toBe('');
    expect(probeAgeLine({ state: 'not-run', at: now }, ago).text).toBe('');
  });
  it('나오는 문구에 백틱이 없다(BoldText)', () => {
    const outs = [
      probeAgeLine({ state: 'ok', at: now - 1, stale: true }, ago), probeAgeLine({ state: 'not-run', changed: true, changedWhat: 'token+url' }, ago),
      sameTokenCell({ state: 'ok', stale: true }), sameTokenCell({ state: 'token-mismatch', stale: true }),
      applyStartOutcome({ ok: false, jobId: 'x' }), applyStartOutcome({ ok: true }),
    ];
    for (const o of outs) expect(JSON.stringify(o)).not.toContain('`');
  });
  it('표는 ②·③ 칸에 이 함수를 쓴다(같음(증명) 직접 그리기 금지)', () => {
    const src = read('tools/PortalCheck.jsx');
    expect(src).toMatch(/probeAgeLine\(r\.probe, ago\)/);
    expect(src).toMatch(/sameTokenCell\(r\.probe\)/);
    expect(src).not.toMatch(/<Badge text="같음\(증명\)"/);
  });
});

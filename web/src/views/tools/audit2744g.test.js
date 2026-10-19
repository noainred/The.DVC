// v2.744 감사 수정 그룹 GG — IP 관리상태 일괄 적용의 무효 IP(WEB-02).
// 예전 화면은 입력을 공백·쉼표로 나누기만 하고 보냈고, 서버는 무효 토큰(10.250.1.300 · 10.250.1)을 조용히 버리고 나머지만 적용해
// {ok:true} 를 줬다 — 화면은 창을 닫았다. 이제 화면은 서버(splitBatchIps)와 같은 판정으로 저장 전에 무효 값을 보이고 저장을 막으며,
// 서버가 400 + invalid 로 돌려주면 창을 닫지 않고 그 목록을 그대로 보인다.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { splitBulkIps, canonIp, bulkInvalidText, invalidOfResponse } from './ipamBulkText.js';
import { OverrideEditor } from './IpamEditors.jsx';
import { stripComments } from '../../test/_stripComments.js';

const h = React.createElement;

describe('① 판정이 서버와 같다(번들 경계 사본 대조)', async () => {
  const ipv4 = await import('../../../../server/src/util/ipv4.js');
  const ov = await import('../../../../server/src/ipam/overrides.js');
  const TOKENS = [
    '10.250.1.5', '10.250.1.300', '10.250.1', '010.250.1.6', ' 10.0.0.1 ', '0.0.0.0', '255.255.255.255', '256.0.0.1',
    '1.2.3.4.5', '1..2.3', '1.2.3.', '.1.2.3', '0x10.0.0.1', '1e2.0.0.1', '+1.2.3.4', '-1.2.3.4', '١.٢.٣.٤', '10.0.0.1/24',
    'fe80::1', 'esx01.corp.local', '', ' ', '00000000010.0.0.1', '10.0.0.0001',
  ];
  it.each(TOKENS)('canonIp(%j) 가 서버 util/ipv4.canonIp 와 같다', (t) => {
    expect(canonIp(t)).toBe(ipv4.canonIp(t));
  });
  const INPUTS = [
    '10.250.1.5, 10.250.1.300, 10.250.1',
    '10.250.1.5,10.250.1.5\n010.250.1.5\t10.250.1.6',
    '  ,, \n ',
    ['10.250.1.5', ' bad ', '', null, '999.1.1.1', '10.250.1.5'],
    'a,b,a, 10.0.0.1 ,c',
    TOKENS.join(' '),
  ];
  it.each(INPUTS.map((x, i) => [i, x]))('splitBulkIps 가 서버 splitBatchIps 와 같다 — %i', (_i, input) => {
    expect(splitBulkIps(input)).toEqual(ov.splitBatchIps(input));
  });
  it('결함 입력: 유효 1개 · 무효 2개로 나눈다', () => {
    const r = splitBulkIps('10.250.1.5, 10.250.1.300, 10.250.1');
    expect(r.ips).toEqual(['10.250.1.5']);
    expect(r.invalid).toEqual(['10.250.1.300', '10.250.1']);
    expect(r.tokens).toHaveLength(3);
  });
});

describe('② 문구', () => {
  it('무효가 없으면 null · 있으면 값과 개수를 말한다', () => {
    expect(bulkInvalidText([])).toBeNull();
    expect(bulkInvalidText(null)).toBeNull();
    const t = bulkInvalidText(['10.250.1.300', '10.250.1']);
    expect(t).toContain('2개');
    expect(t).toContain('10.250.1.300');
    expect(t).toContain('10.250.1');
    const s = bulkInvalidText(['x'], 1, { server: true });
    expect(s).toContain('아무 IP 도 저장되지 않았습니다');
  });
  it('서버 목록이 상한으로 잘렸으면 전체 개수와 나머지 개수를 밝힌다', () => {
    const list = Array.from({ length: 50 }, (_, i) => `bad${i}`);
    const t = bulkInvalidText(list, 80, { server: true });
    expect(t).toContain('80개');
    expect(t).toContain('외 30개');
  });
  it('긴 토큰은 줄여 보인다 · 백틱·별표 강조 없음', () => {
    const t = bulkInvalidText(['x'.repeat(500)]);
    expect(t.length).toBeLessThan(300);
    for (const v of [t, bulkInvalidText(['a'], 1, { server: true })]) { expect(v).not.toContain('`'); expect(v).not.toContain('**'); }
  });
  it('invalidOfResponse — 서버 400 본문에서 목록을 꺼낸다(없으면 null)', () => {
    expect(invalidOfResponse(null)).toBeNull();
    expect(invalidOfResponse({ ok: false, reason: 'x' })).toBeNull();
    expect(invalidOfResponse({ ok: false, invalid: ['a', 'b'], invalidCount: 7 })).toEqual({ invalid: ['a', 'b'], invalidCount: 7 });
    expect(invalidOfResponse({ ok: false, invalid: ['a'] })).toEqual({ invalid: ['a'], invalidCount: 1 });
  });
});

describe('③ 편집기 — 무효 값이 있으면 저장 전에 보이고 저장 버튼을 잠근다', () => {
  it('렌더: 무효 2개 안내 + 저장 버튼 disabled + 일괄 개수는 유효 IP 기준', () => {
    const html = renderToStaticMarkup(h(OverrideEditor, { row: { __new: true, ip: '10.250.1.5, 10.250.1.300, 10.250.1' }, vcenters: [], onClose: () => {}, onSaved: () => {} }));
    expect(html).toContain('IPv4 주소가 아닌 값 2개');
    expect(html).toContain('10.250.1.300');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>일괄 적용 \(1개\)<\/button>/);
  });
  it('렌더: 유효 IP 만이면 안내 없음 · 버튼 활성', () => {
    const html = renderToStaticMarkup(h(OverrideEditor, { row: { __new: true, ip: '10.250.1.5, 10.250.1.6' }, vcenters: [], onClose: () => {}, onSaved: () => {} }));
    expect(html).not.toContain('IPv4 주소가 아닌 값');
    expect(html).toMatch(/<button(?![^>]*disabled)[^>]*>일괄 적용 \(2개\)<\/button>/);
  });
  it('소스: 저장 실패 응답의 invalid 를 버리지 않고, 실패면 창을 닫지 않는다', () => {
    const src = stripComments(fs.readFileSync(new URL('./IpamEditors.jsx', import.meta.url), 'utf8'));
    expect(src).toMatch(/invalidOfResponse\(e\?\.body\)/); // postJson 400 은 HttpError.body 에 본문
    expect(src).toMatch(/if \(r\.ok\) \{ onSaved\(\); return; \}/);
    expect(src).not.toMatch(/String\(ip\)\.split\(/); // 나누기만 하던 예전 판정이 남아 있지 않다
  });
});

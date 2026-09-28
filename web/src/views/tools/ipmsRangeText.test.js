// v2.637 IPMS 설정 — 웹 판정 모듈 + 화면 소스 계약. 서버 판정과의 대조는 server/test/ipms2637.test.js ③ 이 한다.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkRangeList, ipmsSettingsErrors, listSummaryText, sameIpmsSettings, serverInvalidText, vcDirty, vcenterOptionLabel, vcenterOptions,
} from './ipmsRangeText.js';
import { stripComments } from '../../test/_stripComments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

describe('ipmsRangeText', () => {
  it('빈 마스크는 오류다 — /0 으로 읽히면 IPv4 전체가 숨겨진다', () => {
    const c = checkRangeList(['10.0.0.0/']);
    expect(c.valid).toEqual([]);
    expect(c.invalid[0].reason).toMatch(/마스크가 비어/);
    expect(listSummaryText(c)).toBe('유효한 줄 없음');
    expect(listSummaryText(checkRangeList([]))).toBe('비어 있음');
    expect(listSummaryText(checkRangeList(['10.0.0.0/24']))).toBe('유효 1줄 · 약 256 IP');
  });
  it('저장 오류는 모든 vCenter 목록을 본다 — 선택기에 보이는 하나만 보면 다른 vCenter 의 오류를 놓친다', () => {
    const e = ipmsSettingsErrors({ global: ['1.1.1.1'], publicRanges: [], privateRanges: ['x'], vcenters: { a: ['10.0.0.1'], b: ['', '10.0.0.0/33'] } }, (id) => `이름-${id}`);
    expect(e.map((x) => `${x.where}:${x.line}`)).toEqual(['사설 대역:1', 'vCenter별 무시 대역 · 이름-b:2']);
  });
  it('빈 줄·공백 차이는 변경이 아니다(초안은 빈 줄을 품고 서버 값은 정리본)', () => {
    const base = { global: ['1.1.1.1'], publicRanges: [], privateRanges: [], vcenters: { a: ['10.0.0.1'] } };
    expect(sameIpmsSettings({ ...base, global: ['1.1.1.1', ''], vcenters: { a: [' 10.0.0.1 '], b: [''] } }, base)).toBe(true);
    expect(sameIpmsSettings({ ...base, global: ['1.1.1.2'] }, base)).toBe(false);
    expect(vcDirty({ vcenters: { a: ['10.0.0.1', ''] } }, base, 'a')).toBe(false);
    expect(vcDirty({ vcenters: { a: ['10.0.0.2'] } }, base, 'a')).toBe(true);
  });
  it('vCenter 선택지는 삭제된 vCenter(설정에만 남음)와 초안에만 있는 키를 포함하고 표시한다', () => {
    const base = { vcenters: { gone: ['10.5.5.5'] } };
    const value = { vcenters: { gone: ['10.5.5.5'], a: ['10.0.0.1'], draftOnly: ['10.7.7.7'] } };
    const o = vcenterOptions([{ id: 'a', name: 'VC-A' }], value, base, ['gone']);
    expect(o.map((x) => [x.id, x.orphan, x.dirty, x.ignoreCount])).toEqual([['a', false, true, 1], ['gone', true, false, 1], ['draftOnly', true, true, 1]]);
    expect(vcenterOptionLabel(o[0])).toBe('● VC-A · 무시 1');
    expect(vcenterOptionLabel(o[1])).toBe('gone (삭제된 vCenter) · 무시 1');
  });
  it('서버 400 항목은 어디의 몇 행인지로 말한다', () => {
    expect(serverInvalidText({ field: 'vcenters', vcenterId: 'a', line: 2, value: 'x', reason: '형식 아님' }, () => 'VC-A')).toBe('vCenter별 무시 대역 · VC-A — 2행 ‘x’ — 형식 아님');
    expect(serverInvalidText({ field: 'global', line: 1, value: 'y', reason: 'r' })).toBe('전체 무시 대역 — 1행 ‘y’ — r');
  });
});

describe('IpmsSettings 소스 계약', () => {
  const src = stripComments(fs.readFileSync(path.join(HERE, 'IpamSettings.jsx'), 'utf8'));
  const fn = src.slice(src.indexOf('export function IpmsSettings('), src.indexOf('export function ipScanAccept('));
  it('저장 실패는 서버 사유(reason)와 줄 목록(invalid)을 보인다 — r.error 만 읽으면 400 이 "저장 실패" 로 뭉개진다', () => {
    expect(fn).toMatch(/r\.reason \|\| r\.error/);
    expect(fn).toMatch(/r\.invalid/);
  });
  it('vCenter 목록 조회 실패를 삼키지 않는다 — 빈 선택기로 입력하면 vcenters[""] 에 저장돼 어디에도 적용되지 않는다', () => {
    expect(fn).not.toMatch(/fetchJson\('\/vcenters'\)[^;]*\.catch\(\(\) => \{\}\)/);
    expect(fn).toMatch(/setVcsErr/);
    expect(fn).toMatch(/disabled=\{!vc\}/);
  });
  it('형식 오류가 있으면 저장 버튼을 잠근다(서버도 400)', () => {
    expect(fn).toMatch(/disabled=\{saving \|\| errors\.length > 0\}/);
    expect(fn).toMatch(/scanCheck\.invalid\.length > 0/);
  });
});

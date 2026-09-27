// v2.630 감사 그룹 f — 설정 폼·등록 폼·폴링 회귀(WEB2630-01~06).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../test/_stripComments.js';
import { pollMinutesOf, pollIsOff, pollIntervalPatch, changedIntervalBody } from './settingsFormDiff.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (rel) => stripComments(fs.readFileSync(path.join(here, rel), 'utf8'));

describe('WEB2630-01 업그레이드 확인 주기', () => {
  it('0(끔)은 0 으로, 없으면 빈 칸 — 60 으로 채우지 않는다', () => {
    expect(pollMinutesOf(0)).toBe(0);
    expect(pollMinutesOf(null)).toBe('');
    expect(pollMinutesOf(undefined)).toBe('');
    expect(pollMinutesOf(3_600_000)).toBe(60);
    expect(pollIsOff(0)).toBe(true);
    expect(pollIsOff('')).toBe(false);
    expect(pollIsOff(60)).toBe(false);
  });
  it('바뀌지 않은 주기는 보내지 않는다', () => {
    expect(pollIntervalPatch(0, 0)).toBeUndefined();        // 끔 그대로 → 다른 칸만 저장해도 켜지지 않는다
    expect(pollIntervalPatch('', 0)).toBeUndefined();       // 빈 칸 = 미지정
    expect(pollIntervalPatch(60, 0)).toBe(3_600_000);       // 바꾼 경우만
    expect(pollIntervalPatch('0', 60)).toBe(0);             // 명시적 끔
    expect(pollIntervalPatch('abc', 0)).toBeUndefined();
  });
  it('Upgrade.jsx 가 판정 모듈을 쓰고 60 대체가 없다', () => {
    const s = src('Upgrade.jsx');
    expect(s).not.toMatch(/pollIntervalMs\s*\/\s*60000\)\s*:\s*60/);
    expect(s).toMatch(/pollMinutesOf\(s\.pollIntervalMs\)/);
    expect(s).toMatch(/pollIntervalPatch\(form\.pollMinutes,\s*pollInit\)/);
  });
});

describe('WEB2630-02 PDU 수집 주기는 바꾼 칸만', () => {
  it('changedIntervalBody', () => {
    const init = { pollMs: 300, pushMs: 300, configPullMs: 300 };
    expect(changedIntervalBody(init, { ...init })).toEqual({});
    expect(changedIntervalBody(init, { ...init, pollMs: '600' })).toEqual({ pollMs: 600_000 });
    expect(changedIntervalBody(init, { ...init, pushMs: '' })).toEqual({ pushMs: '' });
  });
  it('PduTool 모달이 전 칸을 보내지 않고 응답 ok 를 본다', () => {
    const s = src('tools/PduTool.jsx');
    expect(s).toMatch(/changedIntervalBody\(initial,\s*vals\)/);
    expect(s).not.toMatch(/Object\.entries\(vals\)\.map/);
    expect(s).toMatch(/if \(r && r\.ok\)/);
  });
});

describe('WEB2630-03 목록에 없는 저장값 옵션', () => {
  it('SAN 스위치·PDU·베어메탈 스토리지 폼이 missingChoice 를 쓴다', () => {
    const san = src('tools/SanSwitchTool.jsx');
    expect(san).toMatch(/missingChoice\(\(data\.datacenters \|\| \[\]\)\.map\(\(d\) => d\.id\), form\.datacenterId\)/);
    expect(san).toMatch(/missingChoice\(data\.agents \|\| \[\], form\.agent\)/);
    const pdu = src('tools/PduTool.jsx');
    expect(pdu).toMatch(/missingChoice\(\(data\.datacenters \|\| \[\]\)\.map\(\(d\) => d\.id\), form\.datacenterId\)/);
    expect(pdu).toMatch(/missingChoice\(data\.agents \|\| \[\], form\.agent\)/);
    expect(src('tools/BmStorageTool.jsx')).toMatch(/missingChoice\(agents \|\| \[\], form\.agent\)/);
  });
});

describe('WEB2630-04 403 이면 폴링 중단 + 오류 객체 보존', () => {
  for (const f of ['tools/StorageMonTool.jsx', 'tools/SanSwitchTool.jsx']) {
    it(f, () => {
      const s = src(f);
      expect(s).toMatch(/status === 403 && pollRef\.current\) \{ clearInterval\(pollRef\.current\)/);
      expect(s).toMatch(/pollRef\.current = setInterval\(load, 30_000\)/);
      expect(s).not.toMatch(/catch \(e\) \{ setError\(e\.message\); \}\s*\};\s*useEffect\(\(\) => \{\s*load\(\);/);
      expect(s).not.toMatch(/fetchJson\('\/tools\/storage'\)[^\n]*setErr\(e\.message\)/);
    });
  }
});

describe('WEB2630-05 LinkCheck 편집 중 폼 보존', () => {
  it('load 가 편집 중 폼을 덮지 않는다', () => {
    const s = src('tools/LinkCheck.jsx');
    expect(s).toMatch(/setForm\(\(f\) => \(f && formDirty\.current \? f : linkFormFromSettings\(d\.settings\)\)\)/);
    expect(s).not.toMatch(/onChange=\{[^}]*setForm\(\{/);
  });
});

describe('WEB2630-06 DatacenterAdmin vCenter 조회 실패', () => {
  it('실패를 삼키지 않고 개수를 — 로 둔다', () => {
    const s = src('DatacenterAdmin.jsx');
    expect(s).not.toMatch(/\.catch\(\(\) => \{\}\)\)/);
    expect(s).toMatch(/setVcErr\(/);
    expect(s).toMatch(/vcErr \? '—' : \(countByDc\[d\.id\] \|\| 0\)/);
  });
});

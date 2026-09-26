/**
 * audit2621f.test.js — v2.621 감사 그룹 F(웹) 회귀 고정.
 *   WEB-04: 서버 목록 '유형' 배지·CSV·벤더 필터가 BMC 벤더(serverVendorText.js)를 쓴다 — HPE 가 'iDRAC' 으로 보이지 않고,
 *           구버전 엣지(벤더 필드 없음) 행을 Dell 로 단정하지 않는다.
 *   WEB-05: 미지원 서버 '인증' 칸이 로그인을 시도하지 않은 장비(noCreds)를 '통과' 로 칠하지 않는다.
 *   WEB-06: 400px 넘침 2곳(법인별 온도 필터 행 · 패키지 탭 저장소 URL).
 *   WEB-07: 패키지 설정 폼이 유효값이 아니라 웹 지정값만 채우고, 기본값을 굳히지 않는다.
 * 판정은 순수 함수로 대조하고, 화면이 그 함수를 쓰는지는 소스로 본다(node 환경 — 렌더 불가). 주석은 먼저 지운다.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../../test/_stripComments.js';
import {
  serverVendorOf, serverVendorBadge, serverCsvType, serverCsvVendor, bmcLabel,
  vendorCounts, vendorFilterOptions, matchesVendor, unsupportedAuthBadge,
} from './serverVendorText.js';
import { pkgFormFromResponse, pkgSavePayload, pkgPlaceholder } from '../pkgSettingsText.js';

const TOOLS = path.dirname(fileURLToPath(import.meta.url));
const code = (rel) => stripComments(fs.readFileSync(path.join(TOOLS, rel), 'utf8'));

describe('WEB-04 서버 벤더 판정', () => {
  const local = (v) => ({ id: 'a', type: 'idrac', ...(v !== undefined ? { vendor: v } : {}) });
  const remote = (v) => ({ id: 'r', type: 'idrac', remote: true, ...(v !== undefined ? { vendor: v } : {}) });

  it('HPE 는 HPE iLO, Dell 은 iDRAC, OME 는 OME', () => {
    expect(serverVendorBadge(local('hpe')).label).toBe('HPE iLO');
    expect(serverVendorBadge(remote('hpe')).label).toBe('HPE iLO');
    expect(serverVendorBadge(local('dell')).label).toBe('iDRAC');
    expect(serverVendorBadge({ type: 'ome' }).label).toBe('OME');
  });
  it('중앙 등록부 행은 벤더가 없으면 Dell(등록부 규약), 원격 행은 벤더가 없으면 미상 — Dell 로 단정하지 않는다', () => {
    expect(serverVendorOf(local(undefined))).toBe('dell');
    expect(serverVendorOf(local(''))).toBe('dell');
    expect(serverVendorOf(remote(undefined))).toBe('unknown');
    expect(serverVendorOf(remote(''))).toBe('unknown');
    const b = serverVendorBadge(remote(''));
    expect(b.label).toBe('벤더 미상');
    expect(b.label).not.toMatch(/iDRAC/);
    expect(b.title).toMatch(/엣지/);
  });
  it('모르는 벤더 글자·비객체는 미상(원격)으로 — 값을 지어내지 않는다', () => {
    expect(serverVendorOf(remote('lenovo'))).toBe('unknown');
    expect(serverVendorOf(null)).toBe('unknown');
    expect(serverVendorOf(remote({ toString: () => 'hpe' }))).toBe('unknown');
  });
  it('CSV: type 은 BMC 종류, vendor 열은 벤더(미상은 unknown)', () => {
    expect([serverCsvType(local('hpe')), serverCsvVendor(local('hpe'))]).toEqual(['iLO', 'HPE']);
    expect([serverCsvType(local('dell')), serverCsvVendor(local('dell'))]).toEqual(['iDRAC', 'Dell']);
    expect([serverCsvType(remote('')), serverCsvVendor(remote(''))]).toEqual(['BMC', 'unknown']);
    expect([serverCsvType({ type: 'ome' }), serverCsvVendor({ type: 'ome' })]).toEqual(['OME', 'Dell']);
  });
  it('상세 제목용 이름', () => {
    expect(bmcLabel(local('hpe'))).toBe('HPE iLO');
    expect(bmcLabel(local())).toBe('iDRAC');
    expect(bmcLabel(remote())).toBe('BMC');
  });
  it('벤더 필터: 종류가 둘 이상일 때만 선택지, 0 인 종류는 뺀다, 개수를 붙인다', () => {
    const list = [local('hpe'), local('dell'), local('dell'), remote('')];
    expect(vendorCounts(list)).toEqual({ dell: 2, hpe: 1, unknown: 1, ome: 0 });
    const opts = vendorFilterOptions(list);
    expect(opts.map((o) => o.key)).toEqual(['dell', 'hpe', 'unknown']);
    expect(opts[0].label).toBe('Dell iDRAC 2');
    expect(vendorFilterOptions([local('dell'), local()])).toEqual([]);
    expect(vendorFilterOptions(null)).toEqual([]);
    expect(list.filter((s) => matchesVendor(s, 'hpe'))).toHaveLength(1);
    expect(list.filter((s) => matchesVendor(s, ''))).toHaveLength(4);
  });
  it('HardwareTools 서버 목록이 이 판정을 쓴다 — type 만 보고 iDRAC 이라 적지 않는다', () => {
    const s = code('HardwareTools.jsx');
    const body = s.slice(s.indexOf('function ServerListBody'), s.indexOf('function ModelServersModal'));
    expect(body).toMatch(/serverVendorBadge\(s\)/);
    expect(body).toMatch(/serverCsvType\(s\)/);
    expect(body).toMatch(/serverCsvVendor\(s\)/);
    expect(body).toMatch(/'vendor'/); // CSV 머리글
    expect(body).toMatch(/vendorFilterOptions\(servers\)/);
    expect(body).not.toMatch(/s\.type === 'ome' \? 'OME' : 'iDRAC'/);
    expect(body).not.toMatch(/>iDRAC</);
    // 상세로 벤더·원격 여부를 넘긴다(상세 제목의 근거).
    expect(s).toMatch(/setDetail\(\{[^}]*vendor: s\.vendor[^}]*remote: s\.remote/);
  });
});

describe('WEB-05 미지원 서버 인증 칸', () => {
  it('noCreds 는 통과가 아니다 — 회색 "시도 안 함(계정 없음)"', () => {
    const b = unsupportedAuthBadge({ noCreds: true, authFailed: false });
    expect(b.label).toBe('시도 안 함(계정 없음)');
    expect(b.cls).toBe('gray');
    expect(b.label).not.toMatch(/통과/);
  });
  it('판정 순서: noCreds → 거부 → 통과(참 값만 참)', () => {
    expect(unsupportedAuthBadge({ noCreds: true, authFailed: true }).label).toBe('시도 안 함(계정 없음)');
    expect(unsupportedAuthBadge({ authFailed: true }).label).toBe('거부');
    expect(unsupportedAuthBadge({ noCreds: 'true', authFailed: false }).label).toBe('통과');
    expect(unsupportedAuthBadge({}).cls).toBe('green');
  });
  it('HardwareTools 미지원 표가 이 판정을 쓴다', () => {
    const s = code('HardwareTools.jsx');
    const body = s.slice(s.indexOf('function UnsupportedServers'), s.indexOf('function ServerTempFinder'));
    expect(body).toMatch(/<UnsupportedAuthBadge r=\{r\} \/>/);
    expect(body).not.toMatch(/r\.authFailed \?/);
    expect(s).toMatch(/unsupportedAuthBadge\(r\)/);
  });
});

describe('WEB-06 400px 넘침', () => {
  it('법인별 온도 필터 행(선택·검색·↻)이 줄바꿈된다', () => {
    const s = code('HardwareTools.jsx');
    const body = s.slice(s.indexOf('function ServerTempFinder'), s.indexOf('function ServerFirmwareFinder'));
    const i = body.indexOf('<select className="select select-sm" value={kind}');
    expect(i).toBeGreaterThan(0);
    const row = body.slice(body.lastIndexOf('<div', i), i);
    expect(row).toMatch(/flexWrap: 'wrap'|className="[^"]*\bwrap\b/);
  });
  it('패키지 탭의 저장소 URL code 는 아무 곳에서나 줄바꿈된다', () => {
    const s = code('../AgentDeploy.jsx');
    for (const expr of ['{pkg?.settings?.defaults?.baseUrl}', '{pkg?.baseUrl}']) {
      const i = s.indexOf(expr);
      expect(i).toBeGreaterThan(0);
      const open = s.slice(s.lastIndexOf('<code', i), i);
      expect(open).toMatch(/overflowWrap: 'anywhere'/);
    }
  });
});

describe('WEB-07 패키지 설정 폼', () => {
  const resp = (ov, eff = { baseUrl: 'https://env.example/dl', dir: '/opt/pkgs' }) => ({
    baseUrl: eff.baseUrl, dir: eff.dir,
    settings: { baseUrl: eff.baseUrl, dir: eff.dir, overridden: ov, defaults: { baseUrl: 'https://env.example/dl', dir: '/opt/pkgs' } },
  });
  it('지정되지 않은 칸은 비운다(유효값 = 환경변수 기본으로 채우지 않는다)', () => {
    const f = pkgFormFromResponse(resp({ baseUrl: false, dir: false }));
    expect(f.baseUrl).toBe('');
    expect(f.dir).toBe('');
  });
  it('저장 경로만 바꿔 저장해도 URL 은 지정되지 않는다(빈 값 = 지정 해제)', () => {
    const f = pkgFormFromResponse(resp({ baseUrl: false, dir: false }));
    const body = pkgSavePayload({ ...f, dir: '/data/pkgs' });
    expect(body).toEqual({ baseUrl: '', dir: '/data/pkgs' });
  });
  it('웹 지정값은 채운다', () => {
    const f = pkgFormFromResponse(resp({ baseUrl: true, dir: false }, { baseUrl: 'https://mirror.corp/dl', dir: '/opt/pkgs' }));
    expect(f.baseUrl).toBe('https://mirror.corp/dl');
    expect(f.dir).toBe('');
  });
  it('지정 여부를 모르면(서버가 overridden 을 안 줌) 바뀐 칸만 보낸다', () => {
    const f = pkgFormFromResponse({ baseUrl: 'https://env.example/dl', dir: '/opt/pkgs' });
    expect(f.baseUrl).toBe('https://env.example/dl');
    expect(pkgSavePayload({ ...f, dir: '/data/pkgs' })).toEqual({ dir: '/data/pkgs' });
    expect(pkgSavePayload(f)).toEqual({});
  });
  it('placeholder 는 환경변수 기본값', () => {
    expect(pkgPlaceholder(resp({ baseUrl: false, dir: false }), 'baseUrl', 'x')).toBe('기본값: https://env.example/dl');
    expect(pkgPlaceholder(null, 'dir', '/etc/x')).toBe('/etc/x');
  });
  it('AgentDeploy 가 이 판정을 쓴다 — 유효값 채우기·전체 전송으로 돌아가지 않는다', () => {
    const s = code('../AgentDeploy.jsx');
    expect(s).toMatch(/setPkgCfg\(pkgFormFromResponse\(p\)\)/);
    expect(s).toMatch(/putJson\('\/admin\/packages\/settings', pkgSavePayload\(pkgCfg\)\)/);
    expect(s).not.toMatch(/setPkgCfg\(\{ baseUrl: p\.baseUrl/);
  });
});

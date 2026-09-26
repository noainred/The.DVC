// v2.621 감사 그룹 E — 웹 화면 결함 회귀(WEB-01·RECENT-01·WEB-02·WEB-03·WEB-08·RECENT-08).
// 가능한 곳은 실제 모듈을 호출한다 — ErrorBox 는 react-dom/server 로 실제 렌더해 '던지지 않는다' 를 본다
// (예전에는 Error 객체를 받으면 React #31 로 도구 탭 전체가 ErrorBoundary 로 떨어졌다).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { ErrorBox } from '../components/primitives.jsx';
import { errorBoxInput, ERROR_BOX_UNKNOWN_TEXT } from '../components/accessDeniedText.js';
import { HttpError, noteHttpError } from '../api.js';
import { storageUsageUnknownNote, physicalServersKpi } from './vcCardText.js';
import { infraTotals } from '../version_5/overviewData.js';
import { vcRangesGate } from './tools/IpamSettings.jsx';
import { scanJobsView } from './IdracAdmin.jsx';
import { stripComments } from '../test/_stripComments.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const render = (props) => renderToString(createElement(ErrorBox, props)).replace(/<!-- -->/g, ''); // SSR 텍스트 경계 표식 제거

describe('WEB-01/RECENT-01 — ErrorBox 는 Error·HttpError 객체를 받아도 죽지 않는다', () => {
  it('정규화(순수): 문자열은 그대로, 객체는 message 문구 + 상태코드가 있으면 그 객체가 HTTP 정보', () => {
    expect(errorBoxInput('boom')).toEqual({ text: 'boom', perm: null, http: null });
    expect(errorBoxInput(null)).toEqual({ text: '', perm: null, http: null });
    const e403 = new HttpError('forbidden', { status: 403, path: '/admin/x', body: { error: 'forbidden', requiredRole: ['admin'] } });
    const n = errorBoxInput(e403);
    expect(n.text).toBe('forbidden');
    expect(n.perm).toBe(e403);
    expect(n.http).toBe(e403);
    const e404 = new HttpError('없음', { status: 404 });
    expect(errorBoxInput(e404)).toMatchObject({ text: '없음', perm: null, http: e404 }); // 403 이 아니면 AccessDenied 가 아니다(계약)
    expect(errorBoxInput(new Error('plain'))).toEqual({ text: 'plain', perm: null, http: null });
    expect(errorBoxInput({}).text).toBe(ERROR_BOX_UNKNOWN_TEXT); // '[object Object]' 를 그리지 않는다
    expect(errorBoxInput({ reason: '사유' }).text).toBe('사유');
    expect(errorBoxInput(42).text).toBe('42');
  });

  it('403 HttpError 객체(error= / message= 둘 다) → 던지지 않고 권한 안내(AccessDenied)', () => {
    const e = new HttpError('forbidden', { status: 403, path: '/admin/net/history', body: { error: 'forbidden', requiredRole: ['admin'] } });
    for (const props of [{ error: e }, { message: e }]) {
      let html;
      expect(() => { html = render(props); }).not.toThrow();
      expect(html).toContain('access-denied');
      expect(html).toContain('이 기능에 대한 권한이 없습니다');
      expect(html).not.toContain('[object');
    }
  });

  it('404·400·409 HttpError 와 plain Error → 던지지 않고 `오류: <문구>`', () => {
    for (const e of [new HttpError('대상 없음', { status: 404 }), new HttpError('잘못된 요청', { status: 400 }), new Error('plain 실패')]) {
      let html;
      expect(() => { html = render({ error: e }); }).not.toThrow();
      expect(html).toContain('error-box');
      expect(html).toContain(e.message);
      expect(html).not.toContain('access-denied');
    }
  });

  it('500 HttpError 객체(사이드 채널 메모 없이도) → 일시적 미가용 안내', () => {
    const e = new HttpError('boom-2621-unique', { status: 500 });
    let html;
    expect(() => { html = render({ error: e }); }).not.toThrow();
    expect(html).not.toContain('error-box');
    expect(html).toContain('서비스에 일시적으로 연결할 수 없습니다');
  });

  it('문자열 계약(기존 경로)은 그대로 — 사이드 채널 403 은 AccessDenied', () => {
    const e = new HttpError('scoped-deny-2621', { status: 403, path: '/x', body: { ok: false, reason: 'scoped-deny-2621' } });
    noteHttpError('scoped-deny-2621', e);
    expect(render({ message: 'scoped-deny-2621' })).toContain('access-denied');
    expect(render({ message: '평범한 오류' })).toContain('오류: 평범한 오류');
  });

  it('소스: 트래픽 연속 모니터링은 403 이면 30초 폴링을 멈춘다', () => {
    const src = stripComments(read('./NetTrafficAnalysis.jsx'));
    expect(src).toMatch(/if \(denied\.current\) return; fetchJson\('\/admin\/net\/monitors'\)/);
    expect(src).toMatch(/if \(e\?\.status === 403\) denied\.current = true;/);
  });

  it('소스: ErrorBox 가 정규화 함수를 거쳐 판정한다(원문을 그대로 그리지 않는다)', () => {
    const src = stripComments(read('../components/primitives.jsx'));
    const body = src.slice(src.indexOf('export function ErrorBox'), src.indexOf('export function ErrorBox') + 1200);
    expect(body).toMatch(/errorBoxInput\(message\)/);
    expect(body).not.toMatch(/오류: \{message\}/);
  });
});

describe('WEB-02 — IPMS 설정 스캔 대역: 읽지 못했으면 저장·스캔을 잠근다', () => {
  it('미로드·실패는 잠그고 사유를 말한다', () => {
    expect(vcRangesGate(null, null)).toMatchObject({ locked: true, failed: false });
    const f = vcRangesGate(null, 'HTTP 500');
    expect(f).toMatchObject({ locked: true, failed: true });
    expect(f.note).toContain('HTTP 500');
    expect(f.note).not.toContain('`');
  });
  it('한 번 읽은 뒤의 재조회 실패는 잠그지 않고 사유만', () => {
    expect(vcRangesGate({ ranges: [] }, null)).toEqual({ locked: false, failed: false, note: null });
    expect(vcRangesGate({ ranges: [] }, 'timeout')).toMatchObject({ locked: false, failed: true });
  });
  it('소스: 조회 실패를 삼키지 않고 두 버튼이 잠금을 본다', () => {
    const src = stripComments(read('./tools/IpamSettings.jsx'));
    expect(src).not.toMatch(/vc-ranges'\)\.then\(setVcRanges\)\.catch\(\(\) => \{\}\)/);
    expect(src).toMatch(/disabled=\{scanBusy \|\| !vc \|\| scanGate\.locked\}[^>]*onClick=\{saveScanRanges\}/);
    expect(src).toMatch(/disabled=\{scanBusy \|\| scanGate\.locked\}[^>]*onClick=\{scanNow\}/);
  });
});

describe('WEB-03 — 개요 스토리지 KPI: 사용량 미상 DS 를 합계에서 뺀 사실을 말한다', () => {
  it('문구(한 모듈이 소유) — 0·결측이면 붙이지 않는다', () => {
    expect(storageUsageUnknownNote({ datastoresUsageUnknown: 7 })).toBe('사용량 미상 DS 7개는 용량·사용량 합계에서 뺐습니다');
    expect(storageUsageUnknownNote({ datastoresUsageUnknown: 0 })).toBeNull();
    expect(storageUsageUnknownNote({})).toBeNull();
    expect(storageUsageUnknownNote({ datastoresUsageUnknown: null })).toBeNull();
    expect(storageUsageUnknownNote(null)).toBeNull();
  });
  it('V5 infraTotals 가 전체·범위 모드 모두 문구를 싣는다', () => {
    const ov = {
      global: { vcenters: 1, hosts: 2, vms: 3, vmsPoweredOn: 1, storageUsedTB: 600, storageTotalTB: 900, storageUsagePct: 66.7, datastores: 38, datastoresUsageUnknown: 7 },
      sites: [{ id: 'a', status: 'connected', metrics: { hosts: 2, storageUsedTB: 1, storageTotalTB: 2, storageUsagePct: 50, datastoresUsageUnknown: 3 } }],
    };
    expect(infraTotals(ov).storageNote).toContain('7개');
    expect(infraTotals(ov, 'a').storageNote).toContain('3개');
    expect(infraTotals({ ...ov, global: { ...ov.global, datastoresUsageUnknown: 0 } }).storageNote).toBeNull();
  });
  it('소스: 개요 네 화면이 같은 함수를 쓴다', () => {
    for (const rel of ['./Overview.jsx', '../version_4/pages/Overview.jsx', '../console/pages/ConsoleOverview.jsx', '../version_5/pages/Overview.jsx']) {
      const src = stripComments(read(rel));
      expect(src, rel).toMatch(/storageUsageUnknownNote|storageNote/);
    }
  });
});

describe('WEB-08 — 물리 서버 KPI 를 ESXi 호스트 수로 대체하지 않는다', () => {
  it('iDRAC 수가 있으면 그 값, 0·null 이면 null + 이유', () => {
    expect(physicalServersKpi({ servers: 70 })).toEqual({ value: 70, note: null });
    expect(physicalServersKpi({ servers: 0 })).toEqual({ value: null, note: 'iDRAC 등록 없음' });
    expect(physicalServersKpi(null)).toEqual({ value: null, note: '물리 서버 집계 없음' });
    expect(physicalServersKpi(undefined).value).toBeNull();
    expect(physicalServersKpi({}).value).toBeNull();
  });
  it('소스: V4 두 곳이 `physical.servers || hosts` 대체를 쓰지 않는다', () => {
    for (const rel of ['../version_4/pages/Overview.jsx', '../version_4/V4App.jsx']) {
      const src = stripComments(read(rel));
      expect(src, rel).not.toMatch(/physical\?\.servers\s*\|\|/);
      expect(src, rel).toMatch(/physicalServersKpi\(/);
    }
  });
});

describe('RECENT-08 — iDRAC 스캔 현황 403 을 "진행 중인 스캔이 없습니다" 로 보이지 않는다', () => {
  it('권한 없음 / 조회 실패 / 일시 실패 / 정상을 나눈다', () => {
    const d = scanJobsView({ loaded: false, err: 'forbidden', denied: true });
    expect(d.mode).toBe('denied');
    expect(d.note).toContain('권한이 없습니다');
    expect(d.note).toContain('없다는 뜻이 아닙니다');
    const f = scanJobsView({ loaded: false, err: 'HTTP 502' });
    expect(f.mode).toBe('failed');
    expect(f.note).toContain('HTTP 502');
    expect(scanJobsView({ loaded: false })).toEqual({ mode: 'loading', note: null });
    expect(scanJobsView({ loaded: true, err: 'timeout' })).toMatchObject({ mode: 'jobs' });
    expect(scanJobsView({ loaded: true, err: 'timeout' }).note).toContain('마지막으로 불러온');
    expect(scanJobsView({ loaded: true })).toEqual({ mode: 'jobs', note: null });
  });
  it('소스: scan-jobs 실패를 삼키지 않고 403 이면 폴링을 멈춘다', () => {
    const src = stripComments(read('./IdracAdmin.jsx'));
    expect(src).not.toMatch(/scan-jobs'\)\.then\([^\n]*\)\.catch\(\(\) => \{\}\)/);
    expect(src).toMatch(/if \(sjDenied\.current\) return/);
    expect(src).toMatch(/scanJobsView\(\{ loaded: !!scanJobs\.loaded/);
  });
});

/**
 * rvA_guestDiskCsv.test.js — 검토 I-10: 게스트 디스크 CSV 가 `/api` 를 두 번 붙이던 결함.
 *
 * ⚠ 헬퍼를 mock 하지 않는다 — **실제 `api.js downloadFile`** 을 부르고 전역 fetch 만 합성 응답으로 바꿔
 *   '나가는 URL' 을 본다(헬퍼 전체를 mock 하면 잘못된 인자를 그대로 통과시킨다).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { downloadFile, HttpError, setUnauthorizedHandler, getToken } from '../../api.js';
import { downloadFailText } from '../downloadFailText.js';
import { guestDiskParams, guestDiskCsvPath } from './guestDiskCsv.js';
import { stripComments } from '../../test/_stripComments.js';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const SRC = path.resolve(HERE, '../..');
const BOM = '﻿';

/** 합성 응답 — 실제 Response 를 쓴다(blob·headers·json 동작이 브라우저와 같다). */
const csvRes = (body, name = 'guest-disk-reclaim-2026-10-09.csv') => new Response(body, {
  status: 200, headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}"` },
});
const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const store = () => { const mem = new Map(); return { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) }; };

let saved; let calls; let created; let anchors; let unauthorized;
beforeEach(() => {
  saved = { fetch: globalThis.fetch, ls: globalThis.localStorage, ss: globalThis.sessionStorage, doc: globalThis.document, cou: URL.createObjectURL, rou: URL.revokeObjectURL };
  globalThis.localStorage = store(); globalThis.sessionStorage = store();
  globalThis.localStorage.setItem('vmportal.token', 'tok-1');
  calls = []; created = []; anchors = []; unauthorized = 0;
  setUnauthorizedHandler(() => { unauthorized += 1; });
  globalThis.document = {
    createElement: () => { const a = { href: '', download: '', clicked: 0, click() { this.clicked += 1; }, remove() {} }; anchors.push(a); return a; },
    body: { appendChild: () => {} },
  };
  URL.createObjectURL = (blob) => { created.push(blob); return `blob:test/${created.length}`; };
  URL.revokeObjectURL = () => {};
});
afterEach(() => {
  globalThis.fetch = saved.fetch; globalThis.localStorage = saved.ls; globalThis.sessionStorage = saved.ss; globalThis.document = saved.doc;
  URL.createObjectURL = saved.cou; URL.revokeObjectURL = saved.rou;
  setUnauthorizedHandler(() => {});
});
const withFetch = (resFn) => { globalThis.fetch = async (url, init) => { calls.push({ url, init }); return resFn(url); }; };

describe('I-10 조회 조건 → CSV 경로(순수)', () => {
  it('네 필터와 vCenter 선택을 그대로 싣고 /api 를 붙이지 않는다', () => {
    const p = guestDiskParams({ minReclaimStr: '100', maxRatioStr: '40', factorStr: '1.5', scope: 'vc-nj' });
    expect(p).toEqual({ minReclaimGB: 100, maxRatioPct: 40, usageFactor: 1.5, vcenterId: 'vc-nj' });
    const u = guestDiskCsvPath(p);
    expect(u.startsWith('/tools/guest-disk/export.csv?')).toBe(true);
    expect(u).not.toMatch(/^\/api\//);
    const q = new URLSearchParams(u.split('?')[1]);
    expect(Object.fromEntries(q)).toEqual({ minReclaimGB: '100', maxRatioPct: '40', usageFactor: '1.5', vcenterId: 'vc-nj' });
  });
  it('빈 칸·공백·숫자 아님은 0%·0 으로 읽지 않는다(배율 1·전체 범위는 싣지 않는다)', () => {
    expect(guestDiskParams({ minReclaimStr: '', maxRatioStr: '  ', factorStr: '', scope: '' })).toEqual({ minReclaimGB: 0 });
    expect(guestDiskParams({ minReclaimStr: 'abc', maxRatioStr: 'x', factorStr: '1', scope: '' })).toEqual({ minReclaimGB: 0 });
    expect(guestDiskParams({ minReclaimStr: '5', maxRatioStr: '0', factorStr: '0', scope: '' })).toEqual({ minReclaimGB: 5, maxRatioPct: 0 });
    expect(guestDiskCsvPath(null)).toBe('/tools/guest-disk/export.csv?minReclaimGB=0');
    expect(guestDiskCsvPath({ minReclaimGB: 0, vcenterId: 'a&b=c' })).toBe('/tools/guest-disk/export.csv?minReclaimGB=0&vcenterId=a%26b%3Dc');
  });
});

describe('I-10 실제 downloadFile 을 거친 요청 URL', () => {
  it('정확히 한 번 /api/tools/guest-disk/export.csv?… 로 나가고 /api/api/ 는 없다 · BOM·파일명·인증 헤더 유지', async () => {
    withFetch(() => csvRes(`${BOM}vCenter,VM\nNJ,vm-1\n`));
    const params = guestDiskParams({ minReclaimStr: '200', maxRatioStr: '30', factorStr: '2', scope: 'vc-seoul' });
    const name = await downloadFile(guestDiskCsvPath(params));
    expect(calls).toHaveLength(1);
    const url = String(calls[0].url);
    expect(url).not.toContain('/api/api/');
    expect(url.split('?')[0]).toBe('/api/tools/guest-disk/export.csv');
    expect(Object.fromEntries(new URLSearchParams(url.split('?')[1]))).toEqual({ minReclaimGB: '200', maxRatioPct: '30', usageFactor: '2', vcenterId: 'vc-seoul' });
    expect(calls[0].init.headers.Authorization).toBe('Bearer tok-1');
    expect(name).toBe('guest-disk-reclaim-2026-10-09.csv');           // Content-Disposition 의 이름
    expect(anchors).toHaveLength(1);
    expect(anchors[0].download).toBe(name);
    expect(anchors[0].clicked).toBe(1);
    const bytes = new Uint8Array(await created[0].arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);          // BOM 이 그대로 저장된다(엑셀 한글)
  });
  it('403 은 권한 정보를 보존해 던지고 파일을 만들지 않는다 — 화면 문구는 권한 안내', async () => {
    withFetch(() => jsonRes(403, { error: 'forbidden', requiredPerm: ['data.csv'] }));
    let err = null;
    try { await downloadFile(guestDiskCsvPath(guestDiskParams({}))); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(403);
    expect(err.requiredPerm).toEqual(['data.csv']);
    expect(created).toHaveLength(0);
    expect(anchors).toHaveLength(0);
    expect(downloadFailText(err)).toMatch(/권한이 없습니다 \(필요 권한: data\.csv\)/);
    expect(String(calls[0].url)).not.toContain('/api/api/');
  });
  it('401 은 토큰을 지우고 로그인 처리기로 넘긴다(파일 없음)', async () => {
    withFetch(() => jsonRes(401, { error: 'unauthorized' }));
    await expect(downloadFile(guestDiskCsvPath(guestDiskParams({})))).rejects.toThrow(/세션이 만료/);
    expect(unauthorized).toBe(1);
    expect(getToken()).toBe(null);
    expect(created).toHaveLength(0);
  });
  it('(재현 기록) 예전 인자 /api/tools/… 는 실제 헬퍼에서 /api/api/ 가 된다 — 헬퍼 계약은 /api 이후 경로', async () => {
    withFetch(() => jsonRes(404, { error: 'not found' }));
    await expect(downloadFile('/api/tools/guest-disk/export.csv?minReclaimGB=0')).rejects.toMatchObject({ status: 404 });
    expect(String(calls[0].url)).toBe('/api/api/tools/guest-disk/export.csv?minReclaimGB=0');
  });
});

describe('I-10 소스 스윕(보조)', () => {
  const CALLEES = ['downloadFile', 'postDownload', 'fetchJson', 'postJson', 'putJson', 'patchJson', 'delJson', 'sendJson', 'usePolling', 'pollFetch'];
  const RE = new RegExp(`\\b(${CALLEES.join('|')})\\(\\s*[\`'"]\\/api\\/`);
  it('웹 화면 어디에서도 api.js 헬퍼에 /api/ 로 시작하는 경로를 넘기지 않는다', () => {
    const bad = [];
    const walk = (d) => {
      for (const n of fs.readdirSync(d)) {
        const p = path.join(d, n);
        if (fs.statSync(p).isDirectory()) { if (n !== 'vendor' && n !== 'node_modules') walk(p); continue; }
        if (!/\.(jsx?|tsx?)$/.test(n) || /\.test\./.test(n) || p.endsWith(`${path.sep}api.js`)) continue;
        const s = stripComments(fs.readFileSync(p, 'utf8'));
        s.split('\n').forEach((l, i) => { if (RE.test(l)) bad.push(`${path.relative(SRC, p)}:${i + 1}`); });
      }
    };
    walk(SRC);
    expect(bad).toEqual([]);
  });
  it('GuestDiskReport 의 CSV 버튼은 guestDiskCsvPath 로 경로를 만들고, 조회와 같은 조건 함수(guestDiskParams)를 쓴다', () => {
    const s = stripComments(fs.readFileSync(path.join(HERE, 'GuestDiskReport.jsx'), 'utf8'));
    expect(s).toMatch(/downloadFile\(guestDiskCsvPath\(/);
    expect(s).toMatch(/guestDiskParams\(/);
    expect(s).not.toMatch(/export\.csv\?\$\{/);
  });
  it('(리드 요청 · I-01 연계) 결측 정렬값을 음수·0 sentinel 로 두지 않는다 — 빈 값은 정렬기가 방향과 무관하게 뒤로 보낸다', () => {
    const s = stripComments(fs.readFileSync(path.join(HERE, 'GuestDiskReport.jsx'), 'utf8'));
    expect(s).not.toMatch(/data-sort=\{[^}]*\?\s*-1\s*:/);
    expect(s).not.toMatch(/data-sort=\{[^}]*\|\|\s*0\s*\}/);
    expect(s).toMatch(/data-sort=\{r\.ratioPct == null \? '' : r\.ratioPct\}/);
  });
});

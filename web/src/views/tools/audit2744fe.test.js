/**
 * views/tools/audit2744fe.test.js — v2.744 최종 검토 수정 그룹 FE(웹).
 *
 *  · RV-GI-R1-01  라이선스 만료 표: GI-R1 이 '라이선스'·'소스' 칸에 **언제나** min-width 140px 를 걸어, 표가 칸에 들어갈 수 있는 폭에서도
 *                 표 최소 폭이 약 1042px 가 됐다 — 1280px(래퍼 996px) 48px · 1200px(펼침 916px) 128px · 1024px(레일 912px) 132px 가 래퍼 밖으로
 *                 밀려 '상태' 열이 잘렸다(Chromium 재현). 하한을 표 칸 폭(컨테이너 단위 cqi)이 기준보다 좁을 때만 거는 계단으로 바꿨다.
 *                 여기서는 렌더된 min-width 식을 칸 폭마다 계산해, Chromium 으로 잰 목 데이터의 나머지 열 합(706px)과 칸 여백(28px)으로
 *                 표 최소 폭이 칸 안에 드는지(1024·1200·1280·1440) · 좁은 칸(400·600·720)에서는 하한이 그대로인지(LEFT-04 행 높이)를 고정한다.
 *                 실제 렌더 폭은 리드·그룹이 Chromium 으로 잰다(결과 기록: scratchpad audit2744/final/fix/FE/result.json).
 *  · RA-R2        VM 수량 추이 '이 조건으로 다시 조회' 가 진행 표시·잠금 없이 load() 만 불러, 연타한 만큼 같은 조회가 나가고 같은 오류로 끝나면
 *                 화면이 그대로였다(Chromium 재현 — 세 번 누르면 요청 3건). 진행 중이면 버튼을 잠그고 글자를 바꾸며 요청은 하나만 낸다.
 *  · RX-IP-02     /24 제안 요약의 hostMgmtRejected 문구가 IPv4 가 아닌 관리 IP(IPv6 등)까지 '비정규 표기·0.0.0.0' 탓으로 돌렸다.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Lic from './LicenseTools.jsx';
import * as VmTrack from './VmTrackTool.jsx';
import { suggestSummaryText } from './ipScanDcText.js';
import { stripComments } from '../../test/_stripComments.js';

const h = React.createElement;
const here = path.dirname(fileURLToPath(import.meta.url));

// ── RV-GI-R1-01 ────────────────────────────────────────────────────────────────────────────────────────────
// Chromium 실측(목 데이터, 사이드바 펼침 236px / 레일 64px / 서랍): 표 래퍼(.table-wrap) 폭.
const WRAP = { 'w1440': 1156, 'w1280': 996, 'w1200(펼침)': 916, 'w1024(레일)': 912, 'w720(레일)': 608, 'w600(서랍)': 552, 'w400(서랍)': 352 };
// 같은 실측의 나머지 7열 합(1042 − 2×168)과 칸 여백(168 − 140). 운영 데이터는 버전·제품군 문자열에 따라 다를 수 있다(정직 기록).
const OTHERS = 706;
const CELL_PAD = 28;

/** 렌더된 min-width 값을 칸(컨테이너) 폭 cqi 에서 계산한다 — 상수 px 이거나 clamp(0px, calc((Tpx - 100cqi) * K), Mpx) 계단만 안다. */
function minWidthAt(value, cqi) {
  const v = String(value).trim();
  let m = /^(\d+(?:\.\d+)?)px$/.exec(v);
  if (m) return Number(m[1]);
  m = /^clamp\(0px, calc\(\((\d+(?:\.\d+)?)px - 100cqi\) \* (\d+)\), (\d+(?:\.\d+)?)px\)$/.exec(v);
  if (!m) throw new Error(`모르는 min-width 식: ${v}`);
  const [T, K, M] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return Math.min(M, Math.max(0, (T - cqi) * K));
}

describe('RV-GI-R1-01 라이선스 만료 표 — 하한은 좁은 칸에서만, 1024·1200·1280·1440px 에서 상태 열이 칸 안에 든다', () => {
  const data = {
    items: [
      { family: 'vSphere', name: 'vSphere 8 Enterprise Plus', source: 'vCenter', where: 'vcenter-us-east-01', key: 'XXXXX-AAAAA', productVersion: '8.0', used: 12, total: 20, expires: '2026-12-31', daysLeft: 100, status: 'ok' },
      { family: 'NSX', name: 'NSX Data Center Advanced', source: 'NSX', where: 'nsx-mgr-01', key: 'ZZZZZ-CCCCC', productVersion: '4.1', used: 1, total: 2, expires: '2025-09-30', daysLeft: -10, status: 'expired' },
    ],
    summary: { ok: 1, expired: 1 }, families: ['vSphere', 'NSX'], total: 2, horizonServers: 0, collectionErrors: [],
  };
  const html = renderToStaticMarkup(h(Lic.LicenseExpiry, { scope: '', isAdmin: false, initialData: data }));
  const wrapStyles = [...html.matchAll(/style="([^"]*overflow-wrap:anywhere[^"]*)"/g)].map((m) => m[1]);
  const minOf = (st) => {
    const m = /(?:^|;)min-width:([^;]+)/.exec(st);
    if (!m) throw new Error(`min-width 없음: ${st}`);
    return m[1];
  };

  it('줄바꿈 칸(라이선스·소스) 4개 모두 같은 min-width 식을 갖는다', () => {
    expect(wrapStyles.length).toBe(4);
    const exprs = new Set(wrapStyles.map(minOf));
    expect(exprs.size).toBe(1);
  });

  it('표 최소 폭(나머지 열 + 두 칸)이 데스크톱 칸 폭 안에 든다 — 상태 열이 래퍼 밖으로 밀리지 않는다', () => {
    const expr = minOf(wrapStyles[0]);
    for (const k of ['w1440', 'w1280', 'w1200(펼침)', 'w1024(레일)']) {
      const cqi = WRAP[k];
      const tableMin = OTHERS + 2 * (minWidthAt(expr, cqi) + CELL_PAD);
      expect(tableMin, `${k}: 표 최소 ${tableMin}px > 칸 ${cqi}px`).toBeLessThanOrEqual(cqi);
    }
  });

  it('좁은 칸(400·600·720px)에서는 하한(LIC_WRAP_MINW)이 그대로다 — 두 열이 머리글 폭으로 짜부라지지 않는다(LEFT-04 행 높이)', () => {
    const expr = minOf(wrapStyles[0]);
    for (const k of ['w720(레일)', 'w600(서랍)', 'w400(서랍)']) {
      expect(minWidthAt(expr, WRAP[k]), k).toBe(Lic.LIC_WRAP_MINW);
    }
    expect(Lic.LIC_WRAP_MINW).toBeGreaterThanOrEqual(120);
  });

  it('기준 폭은 가장 좁은 데스크톱 칸(912px)보다 작고, 기준 위에서 두 열에 최소 40px 이상의 내용 폭이 남는다', () => {
    expect(typeof Lic.LIC_WRAP_NARROW_PX).toBe('number');
    expect(Lic.LIC_WRAP_NARROW_PX).toBeLessThan(Math.min(WRAP['w1024(레일)'], WRAP['w1200(펼침)']));
    expect(Lic.LIC_WRAP_NARROW_PX).toBeGreaterThanOrEqual(OTHERS + 2 * (CELL_PAD + 40));
    expect(minOf(wrapStyles[0])).toBe(Lic.LIC_WRAP_MIN_CSS);
  });

  it('계단의 cqi 는 표를 감싼 inline-size 컨테이너를 본다 — 컨테이너 div 안에 table-wrap 이 있다', () => {
    expect(html).toMatch(/<div style="container-type:inline-size"><div class="table-wrap" style="[^"]*overflow:auto[^"]*"><table/);
  });
});

// ── RA-R2 ──────────────────────────────────────────────────────────────────────────────────────────────────
describe('RA-R2 VM 수량 추이 — 다시 조회는 진행 중 잠기고 요청을 하나만 낸다', () => {
  const deferred = () => { let resolve; let reject; const p = new Promise((a, b) => { resolve = a; reject = b; }); return { p, resolve, reject }; };
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it('진행 중 연타는 요청을 하나만 내고, 끝나면 다시 누를 수 있다', async () => {
    const gate = VmTrack.createRetryGate();
    const busy = []; const d = deferred(); let calls = 0;
    const task = () => { calls += 1; return d.p; };
    expect(gate.start(task, (b) => busy.push(b))).toBe(true);
    expect(gate.start(task, (b) => busy.push(b))).toBe(false);
    expect(gate.start(task, (b) => busy.push(b))).toBe(false);
    await tick();
    expect(calls).toBe(1);
    expect(busy).toEqual([true]);
    expect(gate.busy()).toBe(true);
    d.resolve();
    await tick(); await tick();
    expect(busy).toEqual([true, false]);
    expect(gate.busy()).toBe(false);
    const d2 = deferred();
    expect(gate.start(() => { calls += 1; return d2.p; }, (b) => busy.push(b))).toBe(true);
    await tick();
    expect(calls).toBe(2);
    d2.resolve(); await tick(); await tick();
  });

  it('실패(거부)·던짐으로 끝나도 잠금이 풀린다', async () => {
    const gate = VmTrack.createRetryGate();
    const busy = []; const d = deferred();
    gate.start(() => d.p, (b) => busy.push(b));
    d.reject(new Error('x'));
    await tick(); await tick();
    expect(busy).toEqual([true, false]);
    gate.start(() => { throw new Error('sync'); }, (b) => busy.push(b));
    await tick(); await tick();
    expect(busy).toEqual([true, false, true, false]);
  });

  it('조건이 바뀌면(reset) 표시를 내리고, 늦게 끝난 옛 시도가 새 시도의 표시를 지우지 않는다', async () => {
    const gate = VmTrack.createRetryGate();
    const busy = []; const old = deferred(); const neu = deferred();
    gate.start(() => old.p, (b) => busy.push(b));
    gate.reset((b) => busy.push(b));
    expect(busy).toEqual([true, false]);
    expect(gate.start(() => neu.p, (b) => busy.push(b))).toBe(true);
    old.resolve(); await tick(); await tick();
    expect(busy).toEqual([true, false, true]);
    expect(gate.busy()).toBe(true);
    neu.resolve(); await tick(); await tick();
    expect(busy).toEqual([true, false, true, false]);
  });

  it('진행 중이면 버튼이 잠기고 글자가 바뀐다 · 아니면 예전 버튼 그대로', () => {
    const on = renderToStaticMarkup(h(VmTrack.VmTrackLoadFailed, { error: 'boom', busy: true, onRetry: () => {} }));
    expect(on).toMatch(/<button[^>]*disabled=""[^>]*>↻ 다시 조회 중…<\/button>/);
    expect(on).toContain('aria-busy="true"');
    expect(on).not.toContain('이 조건으로 다시 조회<');
    const off = renderToStaticMarkup(h(VmTrack.VmTrackLoadFailed, { error: 'boom', onRetry: () => {} }));
    expect(off).toMatch(/<button[^>]*>↻ 이 조건으로 다시 조회<\/button>/);
    expect(off).not.toMatch(/<button[^>]*disabled/);
    expect(off).not.toContain('undefined');
  });

  it('다시 조회도 실패했으면 그 횟수를 말한다(같은 오류여도 눌렀다는 사실이 남는다) · 이상한 값은 말하지 않는다', () => {
    const two = renderToStaticMarkup(h(VmTrack.VmTrackLoadFailed, { error: 'boom', failedRetries: 2 }));
    expect(two).toContain('다시 조회 2번째도 실패했습니다');
    const busyTwo = renderToStaticMarkup(h(VmTrack.VmTrackLoadFailed, { error: 'boom', busy: true, failedRetries: 2 }));
    expect(busyTwo).not.toContain('번째도 실패');
    for (const bad of [0, -1, '2', NaN, null, 1.5]) {
      const t = renderToStaticMarkup(h(VmTrack.VmTrackLoadFailed, { error: 'boom', failedRetries: bad }));
      expect(t, String(bad)).not.toContain('번째도 실패');
      expect(t).not.toMatch(/NaN|undefined/);
    }
  });

  it('화면은 잠금을 거쳐 같은 조건 load 를 부르고, 조건이 바뀌면 잠금·실패 횟수를 되돌린다', () => {
    const code = stripComments(fs.readFileSync(path.join(here, 'VmTrackTool.jsx'), 'utf8'));
    expect(code).toMatch(/const retry = \(\) => retryGate\.current\.start\(\(\) => load\(/);
    expect(code).toMatch(/<VmTrackLoadFailed error=\{error\} onRetry=\{retry\} busy=\{retrying\} failedRetries=\{retryFails\} \/>/);
    expect(code).toMatch(/useEffect\(\(\) => \{ retryGate\.current\.reset\(setRetrying\); setRetryFails\(0\); setData\(null\); setError\(null\); load\(\); \}, \[days, vcenterId\]\)/);
    // 늦은 응답 버림은 그대로 useLatest 다.
    expect(code).toMatch(/const run = useLatest\(\);/);
  });
});

// ── RX-IP-02 ───────────────────────────────────────────────────────────────────────────────────────────────
describe('RX-IP-02 /24 제안 요약 — 관리 IP 를 받았지만 못 쓴 호스트를 IPv4 표기 오류로만 돌리지 않는다', () => {
  const base = { totals: { subnets: 0, vmIps: 0, hostIps: 0, hostMgmtIps: 0, idracIps: 0 }, hostIpRule: 'name-or-mgmt', omitted: 0, subnets: [] };

  it('hostMgmtRejected 문구는 IPv4 가 아닌 값(IPv6)도 함께 말한다', () => {
    const t = suggestSummaryText({ ...base, totals: { ...base.totals, hostMgmtRejected: 1 }, skipped: { hostsNoIp: 1 } });
    expect(t).toContain('1대는 관리 IP 값이 IPv4 가 아니거나 쓸 수 없는 표기');
    expect(t).toContain('IPv6');
    expect(t).not.toMatch(/쓸 수 없는 표기\(비정규 표기·0\.0\.0\.0 등\)/);
    expect(t).not.toMatch(/수집되지 않아/);
    expect(t).not.toMatch(/`|\*\*/);
  });

  it('수집되지 않은 호스트와 함께 있으면 둘을 각각 말한다(기존 분리 유지)', () => {
    const t = suggestSummaryText({ ...base, totals: { ...base.totals, hostMgmtRejected: 2 }, skipped: { hostsNoIp: 3 } });
    expect(t).toContain('1대는 관리 IP 도 수집되지 않아 뺐습니다');
    expect(t).toContain('2대는 관리 IP 값이 IPv4 가 아니거나 쓸 수 없는 표기');
  });
});

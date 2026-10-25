// v2.782(점검 K4) 회귀:
//  · F-B3 백업 서머리 '주의가 필요한 곳' — 'Veeam 연동 없음 N곳' 요약(정보)은 n개 상한에 넣지 않고 늘 맨 끝에 붙인다.
//    v2.781 은 info 를 맨 뒤로 정렬한 뒤 잘라, 목록이 넘치면 **늘** 그 요약이 잘렸고 '외 N건' 이 안내하는 '주의 필요' 보기에는 연동 없음 행이 없었다.
//    '외 N곳' 은 항목 수가 아니라 '주의 필요 보기의 행 중 목록에 안 나온 행 수'(버튼이 가는 보기와 같은 수).
//  · F-B4 용량 고갈 예측 리포트 — 이미 꽉 찬(포화) 데이터스토어를 '고갈까지' 오름차순 맨 앞에(남은 일수 null 이라 맨 뒤로 가던 것) ·
//    'R² ≥ 0.3 인 증가 추세만 표시' 문구는 사실이 아니어서(포화는 신뢰도와 관계없이 든다) 용량예측 화면과 같은 말로.
//  renderToStaticMarkup 이라 클릭·레이아웃은 보지 못한다(Chromium 확인 몫).
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { attentionList, filterRows } from './backupViewText.js';

const state = { data: null };
vi.mock('../../api.js', async (orig) => {
  const real = await orig();
  return { ...real, usePolling: () => ({ data: state.data, error: null, loading: false }) };
});

describe('v2.782 F-B3 주의가 필요한 곳 — 연동 없음 요약은 잘리지 않는다', () => {
  it('스냅샷 모름 7곳 + 연동 없음 2곳 — 경고 6줄 + 외 1곳 + 연동 없음 요약', () => {
    const rows = [...Array.from({ length: 7 }, (_, i) => ({ id: `vc${i}`, name: `VC${i}`, veeamState: 'ok', snap: null })),
      { id: 'u1', name: 'U1', veeamState: 'unlinked', snap: 1 }, { id: 'u2', name: 'U2', veeamState: 'unlinked', snap: 1 }];
    const att = attentionList(rows);
    expect(att).toHaveLength(8);
    expect(att[6]).toMatchObject({ id: 'more', more: 1, title: '외 1곳' });
    expect(att[7]).toMatchObject({ id: 'unlinked', tone: 'info', title: 'Veeam 연동 없음 2곳' });
    expect(JSON.stringify(att)).not.toMatch(/`/);
  });

  it('외 N곳 = 주의 필요 보기의 행 중 목록에 안 나온 행 수(한 행이 여러 줄을 내도 행으로 센다)', () => {
    // 행 a 는 3줄(이름 불일치·결과 오래됨·잔존) — 앞의 6줄을 a·b·c·d 가 채우고, e·f 는 목록에 없다
    const rows = [
      { id: 'a', name: 'a', veeamState: 'ok', snap: 3, hostMismatch: true, veeamStale: 1, snapStale: 1 },
      ...['b', 'c', 'd', 'e', 'f'].map((id) => ({ id, name: id, veeamState: 'ok', snap: null })),
    ];
    const att = attentionList(rows);
    const more = att.find((x) => x.id === 'more');
    const shownRows = new Set(att.filter((x) => x.id !== 'more' && x.tone !== 'info').map((x) => x.rowId));
    const warnRows = filterRows(rows, 'warn');
    expect(more).toMatchObject({ more: warnRows.filter((r) => !shownRows.has(r.id)).length, title: '외 2곳' });
    expect(att.filter((x) => x.id !== 'more')).toHaveLength(6);
  });

  it('넘치지 않으면 외 N곳 줄이 없고 연동 없음 요약은 맨 끝', () => {
    const rows = [{ id: 'x', name: 'x', veeamState: 'veeam-failed', snap: 1 }, { id: 'u', name: 'u', veeamState: 'unlinked', snap: 1 }];
    expect(attentionList(rows).map((a) => a.id)).toEqual(['x', 'unlinked']);
  });

  it('BackupSummaryTool 의 외 N곳 버튼은 주의 필요 보기로 간다(버튼 수와 보기의 행이 맞는다)', () => {
    const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'BackupSummaryTool.jsx'), 'utf8');
    expect(src).toMatch(/a\.more \? \([\s\S]{0,120}onClick=\{\(\) => setFilter\('warn'\)\}/);
  });
});

describe('v2.782 F-B4 용량 고갈 예측 리포트 — 포화 DS 가 맨 앞', () => {
  it('고갈까지 오름차순 기본 정렬에서 포화(full)가 0일보다 앞 · 증가 없음(null)은 맨 뒤', async () => {
    const { CapacityForecast } = await import('../ToolsReports.jsx');
    state.data = { generatedAt: Date.now(), config: { days: 14 }, scannedDatastores: 5, soon: [{ name: 'dsFull' }], datastores: [
      { name: 'ds40', vcenterId: 'vc1', usagePct: 50, usedGB: 500, capacityGB: 1000, slopePerDay: 10, daysToLimit: 40, r2: 0.9 },
      { name: 'dsFlat', vcenterId: 'vc1', usagePct: 10, usedGB: 10, capacityGB: 100, slopePerDay: 0, daysToLimit: null, r2: 0.5 },
      { name: 'ds5', vcenterId: 'vc1', usagePct: 90, usedGB: 900, capacityGB: 1000, slopePerDay: 20, daysToLimit: 5, r2: 0.8 },
      { name: 'dsFull', vcenterId: 'vc1', usagePct: 100, usedGB: 1000, capacityGB: 1000, current: 1000, slopePerDay: 0, daysToLimit: null, full: true, r2: 0.1 },
      { name: 'ds0', vcenterId: 'vc1', usagePct: 99, usedGB: 990, capacityGB: 1000, slopePerDay: 30, daysToLimit: 0, r2: 0.7 },
    ] };
    const html = renderToStaticMarkup(React.createElement(CapacityForecast, { scope: '' }));
    const order = [...html.matchAll(/<b>(ds\w+)<\/b>/g)].map((m) => m[1]);
    expect(order).toEqual(['dsFull', 'ds0', 'ds5', 'ds40', 'dsFlat']);
    expect(html).toContain('포화');
    expect(html).not.toContain('증가 추세가 있는 데이터스토어만 표시됩니다');
    expect(html).toContain('이미 한계에 닿은 항목은 신뢰도와 관계없이');
    expect(html).not.toMatch(/`/);
  });
});

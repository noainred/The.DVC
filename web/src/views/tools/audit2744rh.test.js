/**
 * views/tools/audit2744rh.test.js — v2.744 회귀 검토 수정 그룹 RH(웹 쪽).
 *
 *  · GI-R1  라이선스 만료 표(LEFT-04 수정분)의 '라이선스'·'소스 · where' 칸이 overflow-wrap:anywhere 만 있고 최소 폭이 없어, 표가 칸보다 넓은
 *           폭(400px)에서 자동 표 레이아웃이 그 열을 51~74px 로 짜부라뜨렸다(행 37 → 141px, 'vC/ent/er' 처럼 단어 중간 줄바꿈 — 넘침 0px 라
 *           수치 검사로는 안 잡힌다). 두 칸에 min-width(LIC_WRAP_MINW)를 주어 열의 하한을 두고 나머지는 DataTable 의 스크롤 래퍼가 넘긴다.
 *           1440px 에서 '상태' 열이 보이게 한 LEFT-04 의 의도(폭 상한·키 말줄임)는 그대로다. 실제 렌더 폭(1440/1280/400 행 높이·넘침)은 리드가
 *           Chromium 으로 본다 — 여기서는 렌더 결과(renderToStaticMarkup)에 하한·상한·스크롤 래퍼가 붙는지를 고정한다.
 *  · GI-R2  GPU 게스트 배포 '대소문자 합침' 표지의 title 이 합친 때(foldReport.at — 중앙이 설정 파일을 읽은 때)를 밝히고, 저장하면 사라진다는
 *           사실을 말한다(서버는 그 엣지 저장이 성공하면 행 folded 를 내린다 — server/test/audit2744rh.test.js).
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LicenseExpiry, LIC_KEY_MAXW, LIC_NAME_MAXW, LIC_SOURCE_MAXW, LIC_WRAP_MINW, LIC_WRAP_MIN_CSS } from './LicenseTools.jsx';
import { gpuGuestFoldNote } from '../GpuGuestSettings.jsx';

const h = React.createElement;

describe('GI-R1 라이선스 만료 표 — 줄바꿈 칸이 좁은 폭에서 한두 글자 폭으로 짜부라지지 않는다', () => {
  const data = {
    items: [
      { family: 'vSphere', name: 'vSphere 8 Enterprise Plus', source: 'vCenter', where: 'vcenter-us-east-01', key: 'XXXXX-AAAAA', productVersion: '8.0', used: 12, total: 20, expires: '2026-12-31', daysLeft: 100, status: 'ok' },
      { family: 'NSX', name: 'NSX Data Center Advanced', source: 'NSX', where: 'nsx-mgr-01', key: 'ZZZZZ-CCCCC', productVersion: '4.1', used: 1, total: 2, expires: '2025-09-30', daysLeft: -10, status: 'expired' },
    ],
    summary: { ok: 1, expired: 1 }, families: ['vSphere', 'NSX'], total: 2, horizonServers: 0, collectionErrors: [],
  };
  const html = renderToStaticMarkup(h(LicenseExpiry, { scope: '', isAdmin: false, initialData: data }));
  const nameCells = [...html.matchAll(/<b style="([^"]*)">(vSphere 8 Enterprise Plus|NSX Data Center Advanced)<\/b>/g)];
  const srcCells = [...html.matchAll(/<span class="muted" style="([^"]*)">(vCenter · vcenter-us-east-01|NSX · nsx-mgr-01)<\/span>/g)];

  it('최소 폭 상수는 단어 몇 개가 들어가는 폭이고 각 칸의 상한보다 작다', () => {
    expect(LIC_WRAP_MINW).toBeGreaterThanOrEqual(120);
    expect(LIC_WRAP_MINW).toBeLessThan(LIC_NAME_MAXW);
    expect(LIC_WRAP_MINW).toBeLessThan(LIC_SOURCE_MAXW);
  });

  it('라이선스 칸 — 모든 행에 min-width 하한 + max-width 상한 + 줄바꿈(white-space:normal)', () => {
    expect(nameCells.length, '라이선스 칸 2행').toBe(2);
    for (const [, st] of nameCells) {
      expect(st).toContain(`min-width:${LIC_WRAP_MIN_CSS}`); // v2.744(RV-GI-R1-01): 좁은 칸에서만 거는 하한 — audit2744fe 가 계단을 고정
      expect(st).toMatch(new RegExp(`max-width:${LIC_NAME_MAXW}px`));
      expect(st).toMatch(/white-space:normal/);
      expect(st).toMatch(/display:inline-block/);
    }
  });

  it('소스 · where 칸 — 모든 행에 min-width 하한 + max-width 상한 + 줄바꿈', () => {
    expect(srcCells.length, '소스 칸 2행').toBe(2);
    for (const [, st] of srcCells) {
      expect(st).toContain(`min-width:${LIC_WRAP_MIN_CSS}`); // v2.744(RV-GI-R1-01): 좁은 칸에서만 거는 하한 — audit2744fe 가 계단을 고정
      expect(st).toMatch(new RegExp(`max-width:${LIC_SOURCE_MAXW}px`));
      expect(st).toMatch(/white-space:normal/);
    }
  });

  it('overflow-wrap:anywhere 를 쓰는 칸은 반드시 min-width 를 함께 갖는다(anywhere 는 min-content 를 한 글자 폭으로 만든다)', () => {
    const spans = [...html.matchAll(/style="([^"]*overflow-wrap:anywhere[^"]*)"/g)].map((m) => m[1]);
    expect(spans.length).toBeGreaterThan(0);
    for (const st of spans) expect(st, st).toMatch(/min-width:[^;]*\d+px/);
  });

  it('표는 스크롤 래퍼 안에 있다(남는 폭은 가로 스크롤로 — 열을 짜부라뜨리지 않는다)', () => {
    const m = html.match(/<div class="table-wrap" style="([^"]*)"><table/);
    expect(m, 'DataTable 의 table-wrap 래퍼').toBeTruthy();
    expect(m[1]).toMatch(/overflow:auto/);
  });

  it('LEFT-04 의 의도는 그대로 — 키 칸은 상한 + 말줄임(전체는 title), 열 순서 불변', () => {
    const key = html.match(/<span class="muted" style="([^"]*)" title="XXXXX-AAAAA">XXXXX-AAAAA<\/span>/);
    expect(key, '키 칸').toBeTruthy();
    expect(key[1]).toMatch(new RegExp(`max-width:${LIC_KEY_MAXW}px`));
    expect(key[1]).toMatch(/text-overflow:ellipsis/);
    expect(key[1]).toMatch(/white-space:nowrap/);
    const ths = [...html.matchAll(/<th[^>]*>(.*?)<\/th>/g)].map((x) => x[1].replace(/<[^>]+>/g, '').replace(/[▲▼↕\s]+$/u, '').trim());
    expect(ths).toEqual(['제품군', '라이선스', '소스', '버전', '키', '사용/총량', '만료일', '남은 기간', '상태']);
  });
});

describe('GI-R2 GPU 게스트 합침 표지 — 합친 때(기동)를 밝히고 저장하면 사라진다고 말한다', () => {
  const row = { agent: 'edge-x', assigned: true, folded: { from: ['Edge-X'], by: 'older', keptOlder: 1, vcentersFromOlder: 0, droppedSecrets: 0 } };
  const at = Date.UTC(2026, 9, 19, 1, 2, 3);
  const report = { at, groups: [{ kept: 'edge-x', dropped: ['Edge-X'], keptBy: 'older', keptOlder: ['enabled'], keptOlderTotal: 1, vcentersFromOlder: [], vcentersFromOlderTotal: 0, droppedSecrets: [], droppedSecretsTotal: 0 }], resolved: [] };

  it('foldReport.at 이 있으면 title 에 합친 때와 "저장하면 사라진다" 를 적는다', () => {
    const t = gpuGuestFoldNote(row, report).title;
    expect(t).toContain('합친 때:');
    expect(t).toContain('2026');
    expect(t).toContain('중앙이 설정 파일을 읽은 때');
    expect(t).toContain('저장하면 이 표지는 사라집니다');
    expect(t).not.toMatch(/`|\*\*/);
  });

  it('at 이 없거나 숫자가 아니면 시각을 지어내지 않는다(1970 금지)', () => {
    for (const r of [null, { groups: report.groups }, { ...report, at: null }, { ...report, at: '2026-10-19' }, { ...report, at: 0 }]) {
      const t = gpuGuestFoldNote(row, r).title;
      expect(t).not.toContain('합친 때:');
      expect(t).not.toContain('1970');
    }
  });

  it('서버가 저장 뒤 행의 folded 를 내리면 표지가 없다(resolved 만 남은 보고)', () => {
    const after = { at, groups: [], resolved: [{ kept: 'edge-x', dropped: ['Edge-X'], at: at + 60_000 }] };
    expect(gpuGuestFoldNote({ agent: 'edge-x', assigned: true }, after)).toBe(null);
  });
});

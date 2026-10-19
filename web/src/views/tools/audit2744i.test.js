/**
 * views/tools/audit2744i.test.js — v2.744 3회차 수정 그룹 GI 의 웹 회귀.
 *  · LEFT-03  게스트 디스크 '회수 가능 합계' 카드 — 수집된 VM 이 0대면 0 GB 가 아니라 '—' + 커버리지 안내(guestDiskText.reclaimTotalCard).
 *  · LEFT-04  라이선스 만료일 표 — '키' 열은 폭 상한 + 말줄임(전체는 title), '소스 · where'·'이름' 칸은 줄바꿈 허용(1440px 에서 '상태' 열이 잘리던 것).
 *             열 순서·정렬·CSV 는 그대로.
 *  · WEB-03   통신 점검 로그 — 필터를 바꾼 조회가 실패하면 이전 필터의 행을 보이지 않는다(linkCheckText 요청 키 판정).
 *  · LEFT-08① GPU 게스트 배포 대상 — 행의 folded(대소문자만 다른 이름 합침)를 짧은 표지 + title 로 말한다(GpuGuestSettings.gpuGuestFoldNote).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { stripComments } from '../../test/_stripComments.js';
import { reclaimTotalCard, RECLAIM_NO_DATA_NOTE, RECLAIM_NO_DATA_NOTE_BARE } from './guestDiskText.js';
import { LicenseExpiry, LIC_KEY_MAXW } from './LicenseTools.jsx';
import { eventsKeyOf, eventsTagged, eventsAfterFail, eventsView, eventsFailText } from './linkCheckText.js';
import { gpuGuestFoldNote } from '../GpuGuestSettings.jsx';

const h = React.createElement;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const code = (rel) => stripComments(fs.readFileSync(path.join(HERE, rel), 'utf8'));

describe('LEFT-03 회수 가능 합계 카드 — 수집 0대는 0 GB 가 아니다', () => {
  it('collectedCount 0 + 커버리지 있음 → 값 모름 + 커버리지 안내', () => {
    const r = reclaimTotalCard({ collectedCount: 0, coverage: [{ vcenterId: 'vc1', why: 'not-collected' }], totals: { reclaimableGB: 0 } });
    expect(r.unknown).toBe(true);
    expect(r.note).toBe(RECLAIM_NO_DATA_NOTE);
    expect(r.note).toContain('수집된 VM 없음');
    expect(r.note).toContain('커버리지');
  });
  it('collectedCount 0 + 커버리지 없음 → 값 모름 + 짧은 안내(없는 표를 가리키지 않는다)', () => {
    const r = reclaimTotalCard({ collectedCount: 0, coverage: [] });
    expect(r.unknown).toBe(true);
    expect(r.note).toBe(RECLAIM_NO_DATA_NOTE_BARE);
  });
  it('한 대라도 수집했으면 예전처럼 값을 보인다(0 GB 도 값이다)', () => {
    expect(reclaimTotalCard({ collectedCount: 1, totals: { reclaimableGB: 0 } })).toEqual({ unknown: false, note: '' });
    expect(reclaimTotalCard({ collectedCount: 12 }).unknown).toBe(false);
  });
  it('필드가 없는 응답(구버전 서버)은 예전 그대로 — 모르는 것을 0대로 단정하지 않는다', () => {
    expect(reclaimTotalCard({}).unknown).toBe(false);
    expect(reclaimTotalCard(null).unknown).toBe(false);
    expect(reclaimTotalCard({ collectedCount: '0' }).unknown).toBe(false);
  });
  it('문구에 백틱·별표가 없다', () => {
    for (const t of [RECLAIM_NO_DATA_NOTE, RECLAIM_NO_DATA_NOTE_BARE]) expect(t).not.toMatch(/`|\*\*/);
  });
  it('GuestDiskReport 가 카드 값을 이 판정으로 정한다(0 GB 를 그리지 않는다)', () => {
    const s = code('GuestDiskReport.jsx');
    expect(s).toMatch(/reclaimTotalCard\(data\)/);
    expect(s).toMatch(/reclaimCard\.unknown \? '—'/);
    expect(s).toMatch(/reclaimCard\.unknown \? reclaimCard\.note/);
  });
});

describe('LEFT-04 라이선스 만료일 표 — 긴 키·소스가 상태 열을 밀어내지 않는다', () => {
  const longKey = 'ABCDE-FGHIJ-KLMNO-PQRST-UVWXY-ZZZZZ-11111-22222';
  const longWhere = 'vcenter-seoul-production-01.corp.example.local · Datacenter-Seoul-Main-Hall-A';
  const data = {
    items: [{ family: 'vCenter', name: 'VMware vSphere 8 Enterprise Plus with Add-on for Kubernetes', source: 'vCenter', where: longWhere, key: longKey, used: 1, total: 2, expires: null, daysLeft: null, status: 'perpetual' }],
    summary: { perpetual: 1 }, families: ['vCenter'], total: 1, horizonServers: 0, collectionErrors: [],
  };
  const html = renderToStaticMarkup(h(LicenseExpiry, { scope: '', isAdmin: true, initialData: data }));
  it('키 칸은 폭 상한 + 말줄임이고 전체 키는 title 로 남는다', () => {
    const m = html.match(/<span[^>]*title="([^"]*)"[^>]*>ABCDE-[^<]*<\/span>/);
    expect(m, '키 칸에 title 이 있어야 한다').toBeTruthy();
    expect(m[1]).toBe(longKey);
    expect(m[0]).toMatch(new RegExp(`max-width:${LIC_KEY_MAXW}px`));
    expect(m[0]).toMatch(/text-overflow:ellipsis/);
    expect(m[0]).toMatch(/overflow:hidden/);
    expect(LIC_KEY_MAXW).toBeGreaterThan(0);
    expect(LIC_KEY_MAXW).toBeLessThanOrEqual(200);
  });
  it('소스 · where 칸과 이름 칸은 줄바꿈된다(td 의 nowrap 을 안쪽이 푼다)', () => {
    const where = html.match(/<span[^>]*>vCenter · vcenter-seoul[^<]*<\/span>/);
    expect(where, '소스 · where 칸').toBeTruthy();
    expect(where[0]).toMatch(/white-space:normal/);
    expect(where[0]).toMatch(/max-width:\d+px/);
    const name = html.match(/<b[^>]*>VMware vSphere 8 Enterprise Plus[^<]*<\/b>/);
    expect(name, '이름 칸').toBeTruthy();
    expect(name[0]).toMatch(/white-space:normal/);
  });
  it('열 순서는 그대로다(정렬·CSV 계약)', () => {
    const ths = [...html.matchAll(/<th[^>]*>(.*?)<\/th>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').replace(/[▲▼↕\s]+$/u, '').trim());
    // 감사 기준(9a2ef1c)과 같은 열 — 라벨·순서를 바꾸지 않았다.
    const want = ['제품군', '라이선스', '소스', '버전', '키', '사용/총량', '만료일', '남은 기간', '상태'];
    expect(ths.filter((t) => want.includes(t))).toEqual(want);
  });
});

describe('WEB-03 통신 점검 로그 — 조회 실패가 이전 필터의 행을 남기지 않는다', () => {
  const A = eventsKeyOf('', 168, '');
  const B = eventsKeyOf('central->edge|x', 168, 'fail');
  const okA = eventsTagged({ rows: [{ id: 1, link_id: 'a' }, { id: 2, link_id: 'b' }], truncated: false }, A);
  it('키는 링크·기간·구분을 모두 담는다', () => {
    expect(A).not.toBe(B);
    expect(eventsKeyOf('', 24, '')).not.toBe(eventsKeyOf('', 168, ''));
    expect(eventsKeyOf('', 168, 'fail')).not.toBe(eventsKeyOf('', 168, ''));
    expect(eventsKeyOf('', '168', '')).toBe(A);
  });
  it('성공한 키의 행만 그린다', () => {
    expect(eventsView(okA, A).rows).toHaveLength(2);
    expect(eventsView(okA, A).ready).toBe(true);
  });
  it('필터를 바꾼 뒤 응답이 오기 전에는 이전 필터의 행을 보이지 않는다', () => {
    const v = eventsView(okA, B);
    expect(v.rows).toEqual([]);
    expect(v.ready).toBe(false);
  });
  it('필터를 바꾼 조회가 실패하면 행 없이 실패를 말한다(예전: 이전 필터 행이 남았다)', () => {
    const st = eventsAfterFail(okA, B, 'HTTP 500');
    const v = eventsView(st, B);
    expect(v.rows).toEqual([]);
    expect(v.failed).toBe(true);
    expect(v.stale).toBe(false);
    expect(eventsFailText(v)).toContain('이전 조건의 행은 보이지 않습니다');
    expect(eventsFailText(v)).toContain('HTTP 500');
    // 실패한 필터에서 이전 필터로 되돌아가도 실패 보관분은 그 키가 아니므로 섞이지 않는다
    expect(eventsView(st, A).rows).toEqual([]);
  });
  it('같은 필터의 다시 읽기가 실패하면 직전 결과를 남기고 그 사실을 말한다', () => {
    const st = eventsAfterFail(okA, A, 'timeout');
    const v = eventsView(st, A);
    expect(v.rows).toHaveLength(2);
    expect(v.failed).toBe(true);
    expect(v.stale).toBe(true);
    expect(eventsFailText(v)).toContain('직전 조회 결과');
  });
  it('실패 보관분 위의 같은 키 재실패는 여전히 행 없음이다', () => {
    const st = eventsAfterFail(eventsAfterFail(null, B, 'x'), B, 'y');
    expect(eventsView(st, B).rows).toEqual([]);
    expect(eventsView(st, B).stale).toBe(false);
  });
  it('실패가 아니면 안내 문구가 없고, 문구에 백틱·별표가 없다', () => {
    expect(eventsFailText(eventsView(okA, A))).toBe('');
    expect(eventsFailText(eventsView(eventsAfterFail(okA, B, 'e'), B))).not.toMatch(/`|\*\*/);
    expect(eventsFailText(eventsView(eventsAfterFail(okA, A, 'e'), A))).not.toMatch(/`|\*\*/);
  });
  it('LinkCheck 는 응답에 키를 붙이고, 실패도 보관하며, 표·빈 상태가 지금 키의 보관분만 쓴다', () => {
    const s = code('LinkCheck.jsx');
    const body = s.slice(s.indexOf('const loadEvents'), s.indexOf('useEffect(() => { loadEvents'));
    expect(body).toMatch(/eventsTagged\(r, key\)/);
    expect(body).toMatch(/setEvents\(\(prev\) => eventsAfterFail\(prev, key, msg\)\)/);
    expect(s).toMatch(/eventsView\(events, eventsKeyOf\(evLink, evHours, evKind\)\)/);
    expect(s).toMatch(/evView\.rows\.map/);
    expect(s).not.toMatch(/events\?\.rows/);
    expect(s).toMatch(/evView\.ready && !evView\.failed && evView\.rows\.length === 0/);
  });
});

describe('LEFT-08① GPU 게스트 배포 대상 — 대소문자 합침 표지', () => {
  const row = { agent: 'edge-x', assigned: true, vcenters: 2, vmCreds: 1, folded: { from: ['Edge-X'], by: 'registry', keptOlder: 2, vcentersFromOlder: 1, droppedSecrets: 0 } };
  const report = { at: 1, groups: [{ kept: 'edge-x', dropped: ['Edge-X'], keptBy: 'registry', keptOlder: ['enabled', 'collectMethod'], keptOlderTotal: 2, vcentersFromOlder: ['vc2'], vcentersFromOlderTotal: 1, droppedSecrets: [], droppedSecretsTotal: 0 }] };
  it('folded 가 없으면 표지가 없다', () => {
    expect(gpuGuestFoldNote({ agent: 'a' })).toBe(null);
    expect(gpuGuestFoldNote(null)).toBe(null);
    expect(gpuGuestFoldNote({ agent: 'a', folded: null })).toBe(null);
  });
  it('짧은 표지는 합친 이름 수와 옛 값 유지 수를 말한다', () => {
    const n = gpuGuestFoldNote(row, report);
    expect(n.short).toBe('대소문자만 다른 이름 1개를 합침 · 옛 값 유지 2');
  });
  it('title 은 합친 이름·남긴 근거·옛 값 유지 항목 경로·옮긴 vCenter 를 말한다(0개 항목은 말하지 않는다)', () => {
    const t = gpuGuestFoldNote(row, report).title;
    expect(t).toContain('Edge-X → edge-x');
    expect(t).toContain('수집 서버 등록부 이름');
    expect(t).toContain('옛 값을 유지한 항목 2개: enabled, collectMethod');
    expect(t).toContain('vCenter 를 옮김 1개: vc2');
    expect(t).not.toContain('비밀번호를 승계하지 않은');
    expect(t).not.toMatch(/`|\*\*/);
  });
  it('경로 목록이 잘렸으면 나머지 개수를 밝힌다', () => {
    const r2 = { groups: [{ ...report.groups[0], keptOlder: ['a', 'b'], keptOlderTotal: 25 }] };
    expect(gpuGuestFoldNote({ ...row, folded: { ...row.folded, keptOlder: 25 } }, r2).title).toContain('옛 값을 유지한 항목 25개: a, b 외 23개');
  });
  it('foldReport 가 없으면(구버전 중앙) 개수만 말하고 이름을 지어내지 않는다', () => {
    const t = gpuGuestFoldNote(row, null).title;
    expect(t).toContain('옛 값을 유지한 항목 2개(항목 이름은 이 응답에 없습니다)');
    expect(t).not.toContain('enabled');
  });
  it('개수를 모르면 숫자를 지어내지 않는다', () => {
    expect(gpuGuestFoldNote({ agent: 'e', folded: { from: ['E'] } }, null).short).toBe('대소문자만 다른 이름 1개를 합침 · 옛 값 유지 —');
  });
  it('GpuGuestSettings 가 응답의 foldReport 를 보관하고 선택지·대상 줄에 표지를 그린다', () => {
    const s = code('../GpuGuestSettings.jsx');
    expect((s.match(/setFoldReport\(r{1,2}\.foldReport \|\| null\)/g) || []).length).toBe(2);
    expect(s).toMatch(/gpuGuestFoldNote\(a, foldReport\)/);
    expect(s).toMatch(/title=\{fold\?\.title\}/);
    expect(s).toMatch(/title=\{selFold\.title\}/);
  });
});

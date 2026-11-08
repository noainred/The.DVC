/**
 * 다음 점검 ①(2차) — 화면: ‘식별 키가 겹치는 서버’ 표 · 결정 버튼 · 문구 · 귀속 없음 법인 고르기(F4) · 자동 채움(S2).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as K from './bmKeyOverlapText.js';
import { KeyOverlapTable } from './BmKeyOverlaps.jsx';
import { ambiguousOf, corpLabel } from './bmPerfUrl.js';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const row = (o = {}) => ({ oid: 'bm|vcB|r-b1', role: 'bm', stage: 'classify', vcenterId: 'vcB', vcName: 'B 법인', name: 'wb-b1', serviceTag: 'To Be Filled By O.E.M.', serverId: 'r-b1', fleetId: 'to be filled by o.e.m.',
  key: 'TO BE FILLED BY O.E.M.', keyKind: 'serviceTag', source: 'idrac', decidedKey: 'vcB:r-b1', decision: null, collecting: false, writable: true, idracHost: 'https://10.20.0.12', osHost: '',
  dupOf: { key: 'TO BE FILLED BY O.E.M.', name: 'wb-a1', vcenterId: 'vcA', source: 'idrac', edge: false }, ...o });

describe('문구 · 거르기', () => {
  it('상태 · 출처 · 겹친 상대(범위 밖 상대는 이름도 개수도 없이) · 백틱 없음', () => {
    expect(K.statusOf(row())).toBe('pending');
    expect(K.statusOf(row({ decision: { decision: 'add', key: 'vcB:r-b1' } }))).toBe('add');
    expect(K.sourceText('idrac')).toBe('iDRAC 등록');
    expect(K.peerText(row())).toBe('wb-a1 · vcA');
    expect(K.peerText(row({ dupOf: null }))).toMatch(/보이지 않음/);
    expect(K.peerText(row({ dupOf: { name: 'h', vcenterId: 'vcA', sameIdrac: true } }))).toMatch(/같은 iDRAC/);
    for (const s of [K.KEY_OVERLAP_HONEST, K.keyOverlapNote({ pending: 2 }), ...Object.values(K.OVERLAP_STATUS_TEXT).map((x) => x.label)]) expect(s).not.toContain('`');
    expect(K.keyOverlapNote({ pending: 0 })).toBe('');
    expect(K.keyOverlapNote({ pending: 2 })).toMatch(/2대/);
  });
  it('검색 · 법인 · 상태 · 쪽(누락 점검과 같은 쪽 크기 규칙)', () => {
    const rows = Array.from({ length: 35 }, (_, i) => row({ oid: `o${i}`, name: `s${i}`, vcenterId: i % 2 ? 'vcB' : 'vcA', decision: i === 3 ? { decision: 'exclude' } : null }));
    const v = K.overlapView(rows, { pageSize: 10, page: 2 });
    expect([v.total, v.matched, v.rows.length, v.page, v.pages, v.from, v.to]).toEqual([35, 35, 10, 2, 4, 11, 20]);
    expect(K.overlapView(rows, { corp: 'vcA' }).matched).toBe(18);
    expect(K.overlapView(rows, { status: 'exclude' }).rows.map((r) => r.name)).toEqual(['s3']);
    expect(K.overlapView(rows, { q: 's1 ' }).rows.map((r) => r.name).slice(0, 2)).toEqual(['s1', 's10']);
    expect(K.overlapView(rows, { q: '10.20.0.12' }).matched).toBe(35);
    expect(K.overlapCorps(rows)).toEqual([{ value: 'vcA', n: 18 }, { value: 'vcB', n: 17 }]);
  });
});

describe('표(SSR) — 열 · 버튼 · 권한', () => {
  it('결정 전: 수집에 추가 · 제외 유지 / 추가함: 되돌리기 + 별도 키 / 쓰기 범위 밖: 잠금 + 이유 · 비관리자는 주소 열 없음', () => {
    const html = renderToStaticMarkup(React.createElement(KeyOverlapTable, { rows: [row(), row({ oid: 'x2', decision: { decision: 'add', key: 'vcB:r-b1', by: 'opb' }, collecting: true }), row({ oid: 'x3', writable: false })], canWrite: true, showAddr: true }));
    expect((html.match(/<th[ >]/g) || []).length).toBe(7);
    expect(html).toContain('수집에 추가'); expect(html).toContain('제외 유지'); expect(html).toContain('되돌리기');
    expect(html).toContain('키 vcB:r-b1 · 수집 대상');
    expect(html).toContain('https://10.20.0.12');
    expect(html).toContain('쓰기 권한 없음');
    expect(html).toContain('To Be Filled By O.E.M.');
    const nonAdmin = renderToStaticMarkup(React.createElement(KeyOverlapTable, { rows: [row({ idracHost: undefined })], canWrite: false, showAddr: false }));
    expect((nonAdmin.match(/<th[ >]/g) || []).length).toBe(6);
    expect(nonAdmin).toContain('disabled');
  });
});

describe('반증 F4 — 귀속 없음 후보도 버튼으로(노드까지)', () => {
  it('pick 이 있는 귀속 없음 후보를 남기고(값 = -@노드) · 이름은 귀속 없음(노드) · pick 없는 빈 법인은 버린다', () => {
    const c = ambiguousOf({ body: { code: 'ambiguous-key', candidates: [{ vcenterId: 'vcB', vcName: 'B' }, { vcenterId: '', unassigned: true, agent: 'Edge-C', pick: '-@Edge-C' }, { vcenterId: '', unassigned: true, agent: '', pick: '-@' }, { vcenterId: '' }] } });
    expect(c.map((x) => x.vcenterId)).toEqual(['vcB', '-@Edge-C', '-@']);
    expect(c.map(corpLabel)).toEqual(['B(vcB)', '귀속 없음(엣지 Edge-C)', '귀속 없음(이 노드)']);
  });
});

describe('반증 S2 — 법인 자동 채움은 엣지 목록을 받았을 때만', () => {
  it('BmUsage.openDetail 은 edges 를 받은(ok · rows 배열) 때만 목록에서 법인을 채운다', () => {
    const src = fs.readFileSync(path.join(HERE, 'BmUsage.jsx'), 'utf8');
    const body = src.slice(src.indexOf('async function openDetail('), src.indexOf('function pickCorp('));
    expect(body).toMatch(/const edgesOk = !!edges && edges\.ok !== false && Array\.isArray\(edges\.rows\);/);
    expect(body).toMatch(/if \(!v && edgesOk\)/);
  });
});

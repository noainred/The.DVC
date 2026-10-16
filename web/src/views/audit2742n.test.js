/**
 * v2.742 1회차 리드 묶음 WEB — 그룹 파일 밖 연결 작업(GE1 VC-05·VC-06 · GE2 VC-02 · GI1 DEV-04 의 화면 쪽).
 *
 * 서버는 이미 고쳐 커밋됐다(같은 이름 다른 데이터센터 클러스터 행·라이선스/확장 목록 '못 읽음'·끊긴 호스트 온도·peer zone 속성 멤버).
 * 이 파일은 **화면이 그 필드를 실제로 쓰는가**를 본다 — 가능한 곳은 서버의 실제 판정 함수 출력으로 입력을 만들고(손으로 쓴 모양이 서버와
 * 어긋나지 않게), 컴포넌트는 renderToStaticMarkup 또는 함수 호출로 요소 트리를 직접 본다. 레이아웃·줄바꿈은 보지 못한다(Chromium 몫).
 * 각 묶음은 동적 import 라 한 파일을 되돌리면 그 묶음만 실패한다(변이 검증 단위).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as srvCluster from '../../../server/src/clustercfg/analyze.js';
import * as srvCore from '../../../server/src/corelicense/analyze.js';

const h = React.createElement;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(HERE, rel), 'utf8');

/** 요소 트리에서 type 이 'tr' 인 요소의 key 를 모은다(함수 컴포넌트는 그리지 않는다 — tbody 의 행은 호출한 컴포넌트가 직접 만든다). */
function trKeys(el, out = []) {
  if (Array.isArray(el)) { for (const x of el) trKeys(x, out); return out; }
  if (!el || typeof el !== 'object') return out;
  if (el.type === 'tr') out.push(el.key);
  const ch = el.props?.children;
  if (ch != null) trKeys(ch, out);
  return out;
}
const noLeak = (html) => {
  expect(html).not.toMatch(/>(null|undefined|NaN)</);
  expect(html).not.toMatch(/\[object Object\]/);
};

const cfgA = { name: 'Prod', ref: 'domain-c1', at: 1, ha: { enabled: true }, drs: { enabled: true }, evc: 'intel-x', rules: [], rulesTotal: 0 };
const cfgB = { name: 'Prod', ref: 'domain-c2', at: 1, ha: { enabled: false }, drs: { enabled: true }, evc: 'intel-x', rules: [], rulesTotal: 0 };

describe('W1 클러스터 HA·DRS 점검 표 — 같은 이름 다른 데이터센터 클러스터', () => {
  it('ref 로 나뉜 두 행은 키가 다르고 이름에 데이터센터가 붙는다(이름 키면 React 중복 키)', async () => {
    const { ClusterRowsTable } = await import('./tools/ClusterCheckTool.jsx');
    const hosts = [
      { id: 'h1', vcenterId: 'vc', cluster: 'Prod', clusterRef: 'domain-c1', vcDatacenter: 'DC-서울', connectionState: 'CONNECTED' },
      { id: 'h2', vcenterId: 'vc', cluster: 'Prod', clusterRef: 'domain-c2', vcDatacenter: 'DC-부산', connectionState: 'CONNECTED' },
    ];
    const r = srvCluster.analyzeClusters([{ id: 'vc', name: 'VC', clusterCfg: [cfgA, cfgB] }], hosts);
    expect(r.rows).toHaveLength(2);
    const keys = trKeys(ClusterRowsTable({ rows: r.rows })).filter((k) => k != null);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
    const html = renderToStaticMarkup(h(ClusterRowsTable, { rows: r.rows }));
    expect(html).toContain('Prod · DC-서울');
    expect(html).toContain('Prod · DC-부산');
    noLeak(html);
  });
  it('이름 키 vCenter(호스트에 clusterRef 없음)의 이름 겹침 — 호스트 칸은 0 이 아니라 — 이고 머리 안내가 개수를 말한다', async () => {
    const { ClusterRowsTable } = await import('./tools/ClusterCheckTool.jsx');
    const { hostsAmbiguousNote } = await import('./clustercfg/clusterCfgText.js');
    const hosts = [
      { id: 'h1', vcenterId: 'vc', cluster: 'Prod', connectionState: 'CONNECTED' },
      { id: 'h2', vcenterId: 'vc', cluster: 'Prod', connectionState: 'CONNECTED' },
    ];
    const r = srvCluster.analyzeClusters([{ id: 'vc', name: 'VC', clusterCfg: [cfgA, cfgB] }], hosts);
    expect(r.coverage.hostsAmbiguous).toBe(2);
    expect(r.rows.every((x) => x.hosts == null)).toBe(true);
    const html = renderToStaticMarkup(h(ClusterRowsTable, { rows: r.rows }));
    expect(html).toContain('같은 이름 클러스터 호스트 2대 구분 불가');
    expect(html).toContain('Prod (domain-c1)');
    expect(html).toContain('Prod (domain-c2)');
    noLeak(html);
    const note = hostsAmbiguousNote(r.coverage);
    expect(note).toContain('2대');
    expect(note).not.toMatch(/[`*]/);
    expect(hostsAmbiguousNote({ hostsAmbiguous: 0 })).toBeNull();
    expect(hostsAmbiguousNote(undefined)).toBeNull();
  });
  it('ref 를 싣지 않은 옛 구성이 같은 이름이면(nameCollision) 표 위치로 키를 가른다', async () => {
    const { ClusterRowsTable } = await import('./tools/ClusterCheckTool.jsx');
    const oldA = { ...cfgA, ref: undefined }; const oldB = { ...cfgB, ref: undefined };
    const hosts = [{ id: 'h1', vcenterId: 'vc', cluster: 'Prod' }];
    const r = srvCluster.analyzeClusters([{ id: 'vc', name: 'VC', clusterCfg: [oldA, oldB] }], hosts);
    expect(r.rows).toHaveLength(2);
    const keys = trKeys(ClusterRowsTable({ rows: r.rows })).filter((k) => k != null);
    expect(new Set(keys).size).toBe(2);
  });
  it('화면이 머리 안내를 실제로 그린다(소스 — 컴포넌트 본체는 fetch 를 해 직접 그릴 수 없다)', () => {
    const src = read('./tools/ClusterCheckTool.jsx');
    expect(src).toMatch(/hostsAmbiguousNote\(cov\)/);
    expect(src).not.toMatch(/key=\{`\$\{r\.vcenterId\}\|\$\{r\.name\}`\}/);
  });
});

describe('W2 VM·호스트 상세 창 클러스터 칸', () => {
  it('호스트 상세는 hostId 를 넘기고, 서버가 그 호스트의 ref 로 같은 이름 클러스터 중 맞는 것을 고른다', async () => {
    const { clusterOfParams } = await import('./clustercfg/clusterCfgText.js');
    const hosts = [
      { id: 'h1', vcenterId: 'vc', cluster: 'Prod', clusterRef: 'domain-c1' },
      { id: 'h2', vcenterId: 'vc', cluster: 'Prod', clusterRef: 'domain-c2' },
    ];
    const vcs = [{ id: 'vc', clusterCfg: [cfgA, cfgB] }];
    const p = clusterOfParams({ id: 'h2', vcenterId: 'vc', cluster: 'Prod' }, false);
    expect(p).toEqual({ vcenterId: 'vc', cluster: 'Prod', hostId: 'h2' });
    // 라우트(/tools/cluster-check/of)가 하는 것과 같은 대응 — clusterRef·hostId 를 opt 로.
    const got = srvCluster.clusterOf(vcs, hosts, p.vcenterId, p.cluster, p.vmId ?? null, { clusterRef: p.clusterRef ?? null, hostId: p.hostId ?? null });
    expect(got.cluster?.ref).toBe('domain-c2');
    // hostId 를 넘기지 않던 예전 인자로는 고르지 못한다(ambiguous).
    expect(srvCluster.clusterOf(vcs, hosts, 'vc', 'Prod').reason).toBe('ambiguous');
    const vp = clusterOfParams({ id: 'vc:vm-9', vcenterId: 'vc', cluster: 'Prod', clusterRef: 'domain-c1' }, true);
    expect(vp).toEqual({ vcenterId: 'vc', cluster: 'Prod', vmId: 'vc:vm-9', clusterRef: 'domain-c1' });
    expect(clusterOfParams({ id: 'h', vcenterId: 'vc', cluster: 'standalone' }, false)).toBeNull();
  });
  it('넘기는 쿼리 이름은 서버 라우트가 읽는 이름이다', async () => {
    const { clusterOfParams } = await import('./clustercfg/clusterCfgText.js');
    const route = read('../../../server/src/routes/api/clusterCheck.js');
    const p = { ...clusterOfParams({ id: 'h', vcenterId: 'vc', cluster: 'C', clusterRef: 'domain-c1' }, false), ...clusterOfParams({ id: 'vc:vm-1', vcenterId: 'vc', cluster: 'C' }, true) };
    for (const k of Object.keys(p)) expect(route, `라우트가 req.query.${k} 를 읽지 않는다`).toContain(`req.query.${k}`);
  });
  it('빈 사유 — 이름 겹침은 "아직 읽지 않았습니다" 가 아니고, 안 읽음만 기다리면 된다고 말한다', async () => {
    const { clusterMissLine } = await import('./clustercfg/clusterCfgText.js');
    const vcs = [{ id: 'vc', clusterCfg: [cfgA, cfgB] }];
    const amb = clusterMissLine(srvCluster.clusterOf(vcs, [], 'vc', 'Prod'));
    expect(amb).toContain('정하지 못했습니다');
    expect(amb).not.toContain('아직 읽지 않았습니다');
    expect(amb).not.toContain('주기적으로 읽습니다');
    const nc = clusterMissLine(srvCluster.clusterOf(vcs, [], 'vc', 'Other'));
    expect(nc).toContain('아직 읽지 않았습니다');
    expect(nc).toContain('주기적으로 읽습니다');
    expect(clusterMissLine({ cluster: { name: 'x' } })).toBeNull();
    for (const t of [amb, nc]) expect(t).not.toMatch(/[`*]/);
  });
  it('EntityDetail 이 헬퍼를 쓴다(소스 — 상세 창 섹션은 fetch 를 해 직접 그릴 수 없다)', () => {
    const src = read('../components/EntityDetail.jsx');
    const sec = src.slice(src.indexOf('function ClusterCfgSection'), src.indexOf('function VmTagsSection'));
    expect(sec).toMatch(/clusterOfParams\(item, isVm\)/);
    expect(sec).toMatch(/clusterMissLine\(d\)/);
    expect(sec).not.toContain('HA·DRS 구성을 아직 읽지 않았습니다');
  });
});

describe('W3 클러스터 N+1 표', () => {
  it('ref 가 다른 같은 이름 그룹은 키가 다르고 이름에 데이터센터가 붙는다', async () => {
    const { N1Table } = await import('./tools/InsightsThreats.jsx');
    // 서버 /tools/insights clusters 행 모양(routes/api/toolsAnalytics.js) — clusterRef·vcDatacenter·sameName.
    const base = { vcenterId: 'vcA', cluster: 'Prod', standalone: false, hosts: 3, hostsUsageExcluded: 0, maintenance: 0, clusterUnknown: 0, n1Ok: true, cpuAfterFailPct: 40, memAfterFailPct: 30, cpuUsagePct: 20, memUsagePct: 15, sameName: 2 };
    const cl = [
      { ...base, clusterRef: 'domain-c1', vcDatacenter: 'DC-A' },
      { ...base, clusterRef: 'domain-c2', vcDatacenter: 'DC-B' },
      { ...base, cluster: 'standalone', standalone: true, clusterRef: null, vcDatacenter: null, sameName: 1, n1Ok: null },
    ];
    const keys = trKeys(N1Table({ cl })).filter((k) => k != null);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(3);
    const html = renderToStaticMarkup(h(N1Table, { cl }));
    expect(html).toContain('Prod · DC-A');
    expect(html).toContain('Prod · DC-B');
    expect(html).toContain('독립 호스트(클러스터 없음)');
    noLeak(html);
  });
});

describe('W4 라이선스·확장 목록을 못 읽은 vCenter', () => {
  it('문구 키 집합은 서버 LIST_UNREAD_TEXT 와 1:1', async () => {
    const { UNREAD_WHY_LABEL } = await import('./tools/licenseUnreadText.js');
    expect(Object.keys(UNREAD_WHY_LABEL).sort()).toEqual(Object.keys(srvCore.LIST_UNREAD_TEXT).sort());
    for (const t of Object.values(UNREAD_WHY_LABEL)) expect(t).not.toMatch(/[`*]/);
  });
  it('라이선스 현황 — 못 읽은 vCenter 가 있으면 부분 합이라 말하고, 비활성은 따로 회색으로', async () => {
    const { LicensesUnreadBanner } = await import('./tools/LicenseTools.jsx');
    const { licensesUnreadNotes } = await import('./tools/licenseUnreadText.js');
    // 서버 /tools/licenses 가 만드는 unread 원소 — vcListUnread 의 why.
    const vcs = [
      { id: 'vc1', name: 'VC-서울', status: 'ok', licensesError: 'timeout' },
      { id: 'vc2', name: 'VC-부산', status: 'disabled' },
      { id: 'vc3', name: 'VC-대구', status: 'ok', licenses: [] },
    ];
    const unread = vcs.map((v) => ({ v, u: srvCore.vcListUnread(v, 'licenses') })).filter((x) => x.u).map(({ v, u }) => ({ vcenterId: v.id, vcenterName: v.name, why: u.why }));
    expect(unread.map((u) => u.why)).toEqual(['failed', 'disabled']);
    const n = licensesUnreadNotes({ unread, partial: true });
    expect(n.partialNote).toContain('VC-서울(조회 실패)');
    expect(n.partialNote).toContain('부분 합');
    expect(n.partialNote).not.toContain('VC-부산');
    expect(n.disabledNote).toContain('VC-부산');
    const html = renderToStaticMarkup(h(LicensesUnreadBanner, { data: { unread, partial: true } }));
    expect(html).toContain('부분 합');
    expect(html).toContain('비활성 vCenter 1곳');
    noLeak(html);
    expect(renderToStaticMarkup(h(LicensesUnreadBanner, { data: { unread: [], partial: false } }))).toBe('');
    expect(renderToStaticMarkup(h(LicensesUnreadBanner, { data: {} }))).toBe('');   // 구버전 서버 — 말하지 않는다
  });
  it('솔루션 버전 — 확장 목록을 못 읽었으면 "정보 없음" 이 아니라 확인 불가', async () => {
    const { SolutionsTable } = await import('./tools/LicenseTools.jsx');
    const { solutionsUnreadNote } = await import('./tools/licenseUnreadText.js');
    const vc = { id: 'vc1', status: 'unreachable' };
    const su = srvCore.vcListUnread(vc, 'solutions');
    const it = { vcenterId: 'vc1', solutions: srvCore.vcListItems(vc, 'solutions'), solutionsUnread: { why: su.why, text: srvCore.LIST_UNREAD_TEXT[su.why] } };
    const html = renderToStaticMarkup(h(SolutionsTable, { it }));
    expect(html).toContain('확인 불가');
    expect(html).not.toContain('정보 없음');
    noLeak(html);
    const ok = renderToStaticMarkup(h(SolutionsTable, { it: { vcenterId: 'vc2', solutions: [], solutionsUnread: null } }));
    expect(ok).toContain('vCenter 확장 솔루션 정보 없음');
    expect(solutionsUnreadNote({ items: [it, { solutionsUnread: { why: 'disabled' } }] })).toContain('1곳');
    expect(solutionsUnreadNote({ items: [{ solutionsUnread: null }] })).toBeNull();
  });
  it('만료일 — 비활성 vCenter 는 실패 줄이 아니라 회색 안내 하나, 나머지는 서버 실패 줄 그대로(두 번 말하지 않는다)', async () => {
    const { LicenseExpiry } = await import('./tools/LicenseTools.jsx');
    const data = {
      items: [], summary: {}, families: [], total: 0, horizonServers: 0,
      collectionErrors: [`vCenter VC-서울: 라이선스 ${srvCore.LIST_UNREAD_TEXT.failed} (timeout)`],
      vcenterLicensesUnread: [{ vcenterId: 'vc1', vcenterName: 'VC-서울', why: 'failed' }, { vcenterId: 'vc2', vcenterName: 'VC-부산', why: 'disabled' }],
    };
    const html = renderToStaticMarkup(h(LicenseExpiry, { scope: '', isAdmin: false, initialData: data }));
    expect(html).toContain('비활성 vCenter 1곳(VC-부산)');
    expect((html.match(/VC-서울/g) || []).length).toBe(1);
    noLeak(html);
  });
  it('코어 라이선스 — 라이선스 목록을 못 읽은 vCenter 는 "코어 단위 라이선스 없음" 이 아니다', async () => {
    const { reportedText, coverageNote } = await import('./corelicense/coreLicenseText.js');
    const r = srvCore.analyzeCoreLicense({ vcenters: [{ id: 'vc1', name: 'VC1', status: 'ok', licensesError: 'NoPermission' }, { id: 'vc2', name: 'VC2', status: 'ok', licenses: [] }], hosts: [], datastores: [] });
    const [row1, row2] = r.vcenters;
    expect(row1.licensesUnread).toBe('failed');
    expect(reportedText(row1).text).toContain('확인 불가');
    expect(reportedText(row1).text).not.toContain('코어 단위 라이선스 없음');
    expect(reportedText(row2).text).toBe('코어 단위 라이선스 없음');   // 읽었고 0개 — 예전 문구 그대로
    expect(r.totals.licensesUnread).toBe(1);
    expect(coverageNote(r.totals)).toContain('라이선스 목록을 읽지 못한 vCenter 1곳');
  });
});

describe('W5 지표 샘플러 — 연결 끊긴 호스트 온도', () => {
  it('lastRun·요약 둘 다 tempHostsDisconnected 를 말하고, 필드가 없으면 아무 말도 하지 않는다', async () => {
    const { samplerWithheldNote, normalizeWithheld } = await import('./samplerWithheldText.js');
    const raw = samplerWithheldNote({ at: 1, rows: 10, tempHostsDisconnected: 2 });
    expect(raw).toContain('연결이 끊긴 호스트 2대의 온도');
    expect(raw).not.toMatch(/[`*]/);
    expect(samplerWithheldNote({ staleVcenters: 0, tempHostsDisconnected: 3 })).toContain('3대');
    expect(samplerWithheldNote({ at: 1, rows: 10 })).toBeNull();
    expect(normalizeWithheld({ staleVcenters: 0 }).tempHostsDisconnected).toBe(0);
    expect(normalizeWithheld({ at: 1 }).tempHostsDisconnected).toBe(0);
  });
});

describe('W6 SAN 조닝 — peer zone 속성 멤버', () => {
  const PZ_TXT = `Effective configuration:
 cfg:	cfg1
 zone:	pz_a
		00:02:00:00:00:03:00:01
		50:06:01:60:00:00:00:a1
		10:00:00:10:9b:00:00:01
 zone:	pz_b
		00:02:00:00:00:03:00:01
		50:06:01:60:00:00:00:b1
		10:00:00:10:9b:00:00:02
`;
  it('서버 graph 의 peerZones·propertyMembers 를 짧게 밝힌다', async () => {
    const Z = await import('../../../server/src/sanswitch/zoning.js');
    const { peerZoneText } = await import('./tools/sanZoningView.js');
    const g = Z.buildZoneGraph(Z.resolveZones(Z.parseCfgShow(PZ_TXT)).zones, {});
    const t = peerZoneText(g);
    expect(t).toContain('peer zone 2개');
    expect(t).toContain('속성 멤버 2개');
    expect(t).toContain('그림에서 제외');
    expect(t).not.toMatch(/[`*]/);
    expect(peerZoneText({ peerZones: 0, propertyMembers: 0 })).toBe('');
    expect(peerZoneText({})).toBe('');   // 구버전 서버
  });
  it('조닝 패널이 그 문구를 그린다(소스 — 패널은 fetch 를 해 직접 그릴 수 없다)', () => {
    expect(read('./tools/SanZoningPanel.jsx')).toMatch(/peerZoneText\(d\.graph\)/);
  });
});

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../../test/_stripComments.js';
import {
  TABS, nText, tsMs, dateTimeText, whenText, ipSortKey, ipsText, kindLabel, kindBadge, policyLabel, policyBadge,
  isMaskedWho, whoText, reachText, probeSummaryCards, kpiCards, vcChips, emptyReason, corpsText, barPct,
  serversFootText, cellAlpha, cellBg, colTone, isOtherCorp, cellTone, shortIp, matrixView, barList, modeSplit,
  checkRows, changeTone, changesNote, flagChips, vmServerList, isFirstFor, powerText, modeText, vmMatches,
  filterCounts, searchVms, ipBadge, mismatchNote, serverHeadDesc, policyHeadText, vmListFoot, checkPolicyEntry,
  previewPolicyInput, normPolicy, samePolicy, invalidText, policyRows, violText, scopeOf, POLICY_TITLE,
  KIND_LABEL, POLICY_LABEL, FLAG_LABEL, CHANGE_TONE, TAB_LABEL, skipText, qnameText, skippedByText, historyNote,
} from './vmDnsText.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// 계약(scratchpad/vmdns-contract.md) 모양의 응답 — 서버가 없을 때 화면 판정을 고정한다.
const SERVERS = [
  { ip: '10.20.0.53', kind: 'vm', who: { name: 'NJ-DC01', vcenterId: 'vc-nj', vcenterName: 'NJ', label: 'VM' }, publicName: null, cls: 'private', vms: 1204, firstVms: 1100, corps: [{ id: 'vc-nj', name: 'NJ', vms: 1100 }, { id: 'vc-nj-irs', name: 'NJ-IRS', vms: 104 }], policy: 'approved', unapprovedVms: 0, otherCorpVms: 0, owners: 1, probe: { at: 1_000, where: 'central', udp: { ok: true, ms: 3, rcode: 0 }, tcp: { ok: true, ms: 4, rcode: 0 } } },
  { ip: '8.8.8.8', kind: 'public', who: null, publicName: 'Google Public DNS', cls: 'public', vms: 61, firstVms: 23, corps: [{ id: 'vc-nj', name: 'NJ', vms: 9 }, { id: 'vc-oc2', name: 'OC2', vms: 14 }, { id: 'vc-wa', name: 'WA', vms: 11 }], policy: 'unapproved', unapprovedVms: 61, otherCorpVms: 0, owners: 0, probe: null },
  { ip: '10.30.1.11', kind: 'vm', who: { name: 'OC2-AD02', vcenterId: 'vc-oc2', vcenterName: 'OC2', label: 'VM' }, cls: 'private', vms: 19, firstVms: 19, corps: [{ id: 'vc-wa', name: 'WA', vms: 19 }], policy: 'mixed', unapprovedVms: 5, otherCorpVms: 19, owners: 1, probe: { at: 1_000, where: 'edge-only' } },
  { ip: '10.0.0.53', kind: 'unknown', who: null, cls: 'private', vms: 12, firstVms: 12, corps: [{ id: 'vc-hm', name: 'HM', vms: 12 }], policy: 'none', unapprovedVms: 0, otherCorpVms: 0, owners: 0, probe: { at: 1_000, where: 'central', udp: { ok: false, error: 'timeout' }, tcp: { ok: false, error: 'refused' } } },
  { ip: '10.9.9.9', kind: 'vm', who: { label: '다른 법인 VM', name: null, vcenterId: null }, cls: 'private', vms: 3, firstVms: 0, corps: [{ id: 'vc-hm', name: 'HM', vms: 3 }], policy: 'none', owners: 2 },
];
const DATA = {
  generatedAt: '2026-10-05T07:00:00.000Z',
  scope: { scoped: false, omittedOutOfScope: 0 },
  vcenters: [{ id: 'vc-nj', name: 'NJ', vms: 554, reported: 500, unknown: 50, notCollected: 4 }, { id: 'vc-wa', name: 'WA', vms: 708, reported: 700, unknown: 8, notCollected: 0 }],
  kpis: { vms: 1262, reported: 1200, unknown: 58, notCollected: 4, servers: 5, serversByKind: { vm: 3, host: 0, public: 1, unknown: 1 }, unapprovedVms: 66, publicVms: 61, mismatchVms: 0, otherCorpVms: 19, singleDnsVms: 146, dhcpVms: 150, staticVms: 1050, policyCorps: 2 },
  servers: SERVERS, serversTotal: 41, serversOmitted: 36,
  matrix: { cols: [{ ip: '10.20.0.53', kind: 'vm', policy: 'approved' }, { ip: '8.8.8.8', kind: 'public', policy: 'unapproved' }, { ip: '10.30.1.11', kind: 'vm', policy: 'mixed' }],
    rows: [{ vcenterId: 'vc-nj', name: 'NJ', cells: [540, 9, 0], other: 5, total: 554 }, { vcenterId: 'vc-wa', name: 'WA', cells: [0, 11, 19], other: 673, total: 708 }] },
  domains: [{ name: 'nj.corp.example', vms: 2110 }, { name: '(도메인 없음)', vms: 289 }], search: [],
  checks: { mismatch: 0, otherCorp: 19, singleDns: 146 },
  changes: { available: true, recent: [{ ts: 1, vmId: 'vm-1', vmName: 'A', vcenterId: 'vc-nj', before: ['10.20.0.53'], after: ['8.8.8.8'], first: false }] },
  probe: { running: false, lastRunAt: null, summary: null },
};

describe('vmDnsText — 기본 표기', () => {
  it('탭 키는 계약 그대로(overview 가 기본)', () => {
    expect(TABS).toEqual(['overview', 'server', 'policy', 'changes']);
    for (const k of TABS) expect(TAB_LABEL[k]).toBeTruthy();
  });
  it('못 읽은 값은 — 이고 0 이 아니다(Number(null)===0 함정)', () => {
    expect(nText(null)).toBe('—');
    expect(nText('')).toBe('—');
    expect(nText([])).toBe('—');
    expect(nText(0)).toBe('0');
    expect(nText(1234)).toBe('1,234');
  });
  it('시각: ISO 문자열·epoch 숫자를 받고 숫자 문자열을 Date.parse 에 넘기지 않는다', () => {
    expect(tsMs('2026-10-05T07:00:00.000Z')).toBe(Date.parse('2026-10-05T07:00:00.000Z'));
    expect(tsMs(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(tsMs('12345')).toBe(12345);
    expect(tsMs(null)).toBeNull();
    expect(tsMs(0)).toBeNull();
    expect(dateTimeText(null)).toBe('—');
    const t = new Date(2026, 9, 3, 22, 14).getTime();
    expect(dateTimeText(t)).toBe('2026-10-03 22:14');
  });
  it('변경 시각 — 하루 안이면 상대 시각, 그보다 오래면 날짜·시각', () => {
    const now = new Date(2026, 9, 5, 12, 0).getTime();
    expect(whenText(now - 3 * 3_600_000, now)).toBe('3시간 전');
    expect(whenText(new Date(2026, 9, 2, 9, 5).getTime(), now)).toBe('2026-10-02 09:05');
    expect(whenText(null, now)).toBe('—');
  });
  it('IP 정렬 키는 숫자(사전순이 아니다)', () => {
    expect(ipSortKey('10.0.0.9')).toBeLessThan(ipSortKey('10.0.0.10'));
    expect(ipSortKey('abc')).toBeNull();
    expect(ipSortKey('10.0.0.256')).toBeNull();
  });
  it('주소 목록: 빈 목록은 (DNS 없음), 모름(null)은 —', () => {
    expect(ipsText(['1.1.1.1', '8.8.8.8'])).toBe('1.1.1.1, 8.8.8.8');
    expect(ipsText([])).toBe('(DNS 없음)');
    expect(ipsText(null)).toBe('—');
  });
});

describe('정체·정책 표지', () => {
  it('모든 kind·policy 에 라벨이 있고 모르는 값은 확인 불가·회색', () => {
    for (const k of ['vm', 'host', 'public', 'unknown']) { expect(KIND_LABEL[k]).toBeTruthy(); expect(kindBadge(k)).toBeTruthy(); }
    for (const p of ['approved', 'unapproved', 'mixed', 'none']) { expect(POLICY_LABEL[p]).toBeTruthy(); expect(POLICY_TITLE[p]).toBeTruthy(); }
    expect(kindLabel('zzz')).toBe('확인 불가');
    expect(kindBadge('zzz')).toBe('gray');
    expect(policyLabel(undefined)).toBe('확인 불가');
    expect(policyBadge('none')).toBe('gray');
    expect(policyBadge('approved')).toBe('green');
  });
  it('정체 문장 — 지어내지 않는다', () => {
    expect(whoText(SERVERS[0])).toBe('NJ-DC01 · NJ');
    expect(whoText(SERVERS[1])).toBe('Google Public DNS');
    expect(whoText({ kind: 'public' })).toBe('공인 주소(알려진 공인 DNS 아님)');
    expect(whoText(SERVERS[3])).toBe('등록·스캔 기록 없음');
    expect(whoText(SERVERS[4])).toBe('다른 법인 VM 외 1대');   // 범위 밖 소유자는 이름을 가린다
    expect(whoText({ kind: 'host', who: { name: 'esx01', vcenterId: 'vc-nj', vcenterName: 'NJ' } })).toBe('ESXi esx01 · NJ');
    expect(whoText(null)).toBe('—');
    expect(isMaskedWho(SERVERS[4].who)).toBe(true);
    expect(isMaskedWho(SERVERS[0].who)).toBe(false);
  });
});

describe('도달성(53)', () => {
  it('응답·실패·엣지 전용·점검 안 함을 나눈다 — 엣지 전용은 실패가 아니다', () => {
    expect(reachText(SERVERS[0].probe)).toMatchObject({ text: 'udp 3ms · tcp 4ms', tone: 'ok', where: '중앙에서' });
    expect(reachText(SERVERS[3].probe)).toMatchObject({ text: 'udp 시한 초과 · tcp 거부', tone: 'bad' });
    expect(reachText(SERVERS[2].probe)).toMatchObject({ text: '중앙에서 못 잼', tone: 'muted' });
    expect(reachText(null)).toMatchObject({ text: '점검 안 함', tone: 'muted' });
  });
  it('응답 패킷을 받으면 rcode 와 무관하게 응답(rcode 는 밝힌다) · ms 를 모르면 숫자를 지어내지 않는다', () => {
    expect(reachText({ where: 'central', udp: { ok: true, ms: 5, rcode: 'NXDOMAIN' } })).toMatchObject({ text: 'udp 5ms · rcode NXDOMAIN', tone: 'ok' });
    expect(reachText({ where: 'central', udp: { ok: true, ms: null } }).text).toBe('udp 응답');
    expect(reachText({ where: 'central', udp: { ok: false } }).text).toBe('udp 응답 없음');
    expect(reachText({ where: 'central', udp: { ok: false, error: 'timeout' }, tcp: { ok: true, ms: 9 } }).tone).toBe('ok');
  });
  it('건너뛴 주소(데모·로컬·상한·예산)는 실패가 아니라 건너뜀이고 사유를 말한다', () => {
    expect(reachText({ at: 1, where: 'central', skipped: 'mock', udp: null, tcp: null })).toMatchObject({ text: '건너뜀', tone: 'muted' });
    expect(reachText({ where: 'central', skipped: 'budget' }).where).toMatch(/다시 누르면/);
    expect(skipText('local')).toMatch(/루프백/);
    expect(skipText('zzz')).toBe('점검하지 않음(zzz)');
    expect(skipText('')).toBe('점검하지 않음');
    expect(reachText({ where: 'central', udp: { ok: false, error: 'bad-response' } }).text).toBe('udp DNS 응답 아님');
    expect(reachText({ where: 'central', udp: { ok: false, error: 'error:EPERM' } }).text).toBe('udp error:EPERM');
  });
  it('질의 이름 — . 은 루트 NS · 없으면 —', () => {
    expect(qnameText('.')).toBe('루트(NS)');
    expect(qnameText('nj.corp.example')).toBe('nj.corp.example');
    expect(qnameText(null)).toBe('—');
  });
  it('건너뜀 사유 분해', () => {
    expect(skippedByText({ skippedBy: { mock: 3, budget: 2, local: 0 } })).toBe('데모 3 · 시간 예산 2');
    expect(skippedByText(null)).toBe('');
    expect(skippedByText({ skippedBy: { zz: 1 } })).toBe('zz 1');
  });
  it('점검 요약 카드 — summary 가 없으면 —, 0 은 경고색이 아니다', () => {
    expect(probeSummaryCards(null).map((c) => c.value)).toEqual(['—', '—', '—', '—']);
    const c = probeSummaryCards({ answered: 36, failed: 0, skipped: 0, edgeOnly: 3 });
    expect(c.find((x) => x.key === 'failed')).toMatchObject({ value: '0', tone: 'muted' });
    expect(c.find((x) => x.key === 'answered').tone).toBe('ok');
    expect(probeSummaryCards({ failed: 2 }).find((x) => x.key === 'failed').tone).toBe('bad');
  });
});

describe('KPI', () => {
  it('8칸 — 모름·미수집은 별도 칸이고 0 을 경고색으로 칠하지 않는다', () => {
    const cards = kpiCards(DATA.kpis, { vcCount: 2, publicUnapproved: true });
    expect(cards.map((c) => c.key)).toEqual(['vms', 'reported', 'servers', 'unapprovedVms', 'publicVms', 'mismatchVms', 'unknown', 'notCollected']);
    const by = Object.fromEntries(cards.map((c) => [c.key, c]));
    expect(by.reported.sub).toMatch(/^95%/);
    expect(by.unapprovedVms.tone).toBe('warn');
    expect(by.mismatchVms).toMatchObject({ value: '0', tone: 'plain' });   // 0 → 경고색 아님
    expect(by.notCollected.value).toBe('4');
    expect(by.servers.sub).toBe('VM 3 · 공인 1 · 대장에 없음 1');
    expect(by.unapprovedVms.sub).toMatch(/정책이 있는 법인 2곳 \+ 공인 DNS 규칙/);
  });
  it('첫 인벤토리 수집 중(initial)이면 0 대신 — (v2.675 규약)', () => {
    const cards = kpiCards({ ...DATA.kpis, vms: 0, reported: 0 }, { initial: true });
    expect(cards.every((c) => c.value === '—')).toBe(true);
    expect(emptyReason({ ...DATA, servers: [], initial: true }).text).toMatch(/첫 인벤토리 수집 중/);
  });
  it('kpis 가 없으면 전부 — (0 이 아니다)', () => {
    const cards = kpiCards(null);
    expect(cards.every((c) => c.value === '—')).toBe(true);
    expect(cards.every((c) => c.tone === 'plain')).toBe(true);
  });
  it('정책이 없으면 비승인 판정을 하지 않았다고 말한다', () => {
    const k = kpiCards({ ...DATA.kpis, policyCorps: 0 }, { publicUnapproved: false });
    expect(k.find((c) => c.key === 'unapprovedVms').sub).toMatch(/판정하지 않았습니다/);
    const k2 = kpiCards({ ...DATA.kpis, policyCorps: 0 }, { publicUnapproved: true });
    expect(k2.find((c) => c.key === 'unapprovedVms').sub).toMatch(/공인 DNS 규칙만/);
  });
});

describe('vCenter 칩', () => {
  it('전체 + vCenter 별, 선택이 활성이고 title 이 보고·모름·미수집을 밝힌다', () => {
    const c = vcChips(DATA.vcenters, 'vc-wa');
    expect(c[0]).toMatchObject({ id: '', label: '전체', n: '1,262', active: false });
    expect(c.find((x) => x.id === 'vc-wa').active).toBe(true);
    expect(c.find((x) => x.id === 'vc-nj').title).toBe('보고 500 · 모름 50 · 미수집 4');
    expect(vcChips([], '')[0]).toMatchObject({ n: '—', active: true });
  });
});

describe('빈 상태 사유 — 기다리면 되는지·조치가 필요한지 나눈다', () => {
  const base = { ...DATA, servers: [] };
  it('서버가 있으면 null', () => { expect(emptyReason(DATA)).toBeNull(); expect(emptyReason(null)).toBeNull(); });
  it('vCenter·VM 이 없으면 첫 수집 안내', () => {
    expect(emptyReason({ ...base, vcenters: [], kpis: { vms: 0 } }).text).toMatch(/첫 수집 중/);
    expect(emptyReason({ ...base, kpis: { vms: 0 } }).tone).toBe('info');
  });
  it('전부 미수집이면 엣지 업그레이드(기다려도 안 된다)', () => {
    const r = emptyReason({ ...base, kpis: { vms: 10, reported: 0, unknown: 0, notCollected: 10 } });
    expect(r.text).toMatch(/2\.695 이전/);
    expect(r.text).toMatch(/기다려도 채워지지 않습니다/);
    expect(r.tone).toBe('warn');
  });
  it('전부 모름이면 Tools(추정이라 밝힘)', () => {
    expect(emptyReason({ ...base, kpis: { vms: 10, reported: 0, unknown: 10, notCollected: 0 } }).text).toMatch(/VMware Tools.*추정/);
  });
  it('섞여 있으면 개수를 밝힌다 · 보고했는데 주소가 비면 그렇게 말한다', () => {
    expect(emptyReason({ ...base, kpis: { vms: 10, reported: 0, unknown: 4, notCollected: 6 } }).text).toBe('DNS 를 보고한 VM 이 없습니다 — 모름 4대 · 미수집 6대.');
    expect(emptyReason({ ...base, kpis: { vms: 10, reported: 3 } }).text).toMatch(/서버 주소가 비어/);
  });
});

describe('서버 표', () => {
  it('쓰는 법인 — 2곳까지 + 외 N곳', () => {
    expect(corpsText(SERVERS[0].corps)).toBe('NJ · NJ-IRS');
    expect(corpsText(SERVERS[1].corps)).toBe('NJ · OC2 외 1곳');
    expect(corpsText([])).toBe('—');
  });
  it('막대 폭 — 0·못 읽음은 0, 작아도 최소 3', () => {
    expect(barPct(1204, 1204)).toBe(100);
    expect(barPct(1, 1204)).toBe(3);
    expect(barPct(0, 100)).toBe(0);
    expect(barPct(null, 100)).toBe(0);
    expect(barPct(5, 0)).toBe(0);
  });
  it('표 아래 문구 — 서버 상한으로 뺀 개수를 밝힌다', () => {
    expect(serversFootText(DATA, 5)).toBe('주소 41개 중 5개 표시 · 사용 VM 이 적은 36개는 서버 상한으로 목록에서 뺐습니다(CSV 에는 VM 단위로 전부 있습니다)');
    expect(serversFootText({ servers: [] }, 0)).toBe('주소 0개 표시');
  });
});

describe('법인 × DNS 매트릭스', () => {
  it('칸 강도 — 0 이면 0, 비중이 클수록 짙고 0.9 를 넘지 않는다', () => {
    expect(cellAlpha(0, 100)).toBe(0);
    expect(cellAlpha(null, 100)).toBe(0);
    expect(cellAlpha(100, 100)).toBe(0.9);
    expect(cellAlpha(10, 100)).toBeCloseTo(0.26);
    expect(cellAlpha(5, 0)).toBe(0.9);       // 합계를 모르면 비중 1
    expect(cellAlpha(10, 100)).toBeLessThan(cellAlpha(50, 100));
  });
  it('칸 배경은 테마 토큰만 쓴다(새 hex 없음)', () => {
    expect(cellBg('ok', 0)).toBe('var(--panel-deep)');
    expect(cellBg('bad', 0.5)).toBe('color-mix(in srgb, var(--red) 50%, transparent)');
    expect(cellBg('other', 0.26)).toBe('color-mix(in srgb, var(--amber) 26%, transparent)');
    expect(cellBg('zzz', 0.5)).toMatch(/var\(--text-dim\)/);
  });
  it('열 톤 — 공인·비승인 bad, 승인 ok, 법인마다 다름 mixed, 정책 없음 none', () => {
    expect(colTone({ kind: 'public', policy: 'approved' })).toBe('bad');
    expect(colTone({ kind: 'vm', policy: 'unapproved' })).toBe('bad');
    expect(colTone({ kind: 'vm', policy: 'approved' })).toBe('ok');
    expect(colTone({ kind: 'vm', policy: 'mixed' })).toBe('mixed');
    expect(colTone({ kind: 'unknown', policy: 'none' })).toBe('none');
    expect(colTone(null)).toBe('none');
  });
  it('다른 법인 — 소유 vCenter 가 다르거나 범위 밖으로 가려진 소유자 · 공인·대장에 없음은 아니다', () => {
    expect(isOtherCorp(SERVERS[2], 'vc-wa')).toBe(true);
    expect(isOtherCorp(SERVERS[2], 'vc-oc2')).toBe(false);
    expect(isOtherCorp(SERVERS[4], 'vc-hm')).toBe(true);
    expect(isOtherCorp(SERVERS[1], 'vc-nj')).toBe(false);
    expect(isOtherCorp(SERVERS[3], 'vc-hm')).toBe(false);
    expect(cellTone({ kind: 'public', policy: 'unapproved' }, 'vc-nj', SERVERS[1])).toBe('bad');
    expect(cellTone({ kind: 'vm', policy: 'mixed' }, 'vc-wa', SERVERS[2])).toBe('other');
    expect(cellTone({ kind: 'vm', policy: 'approved' }, 'vc-nj', SERVERS[0])).toBe('ok');
  });
  it('화면 모델 — 열 + 기타, 0 은 · 이고 배경이 없다, 다른 법인 칸은 amber', () => {
    const m = matrixView(DATA.matrix, SERVERS);
    expect(m.empty).toBe(false);
    expect(m.cols.map((c) => c.ip)).toEqual(['10.20.0.53', '8.8.8.8', '10.30.1.11']);
    const wa = m.rows.find((r) => r.vcenterId === 'vc-wa');
    expect(wa.cells).toHaveLength(4);                       // 3 열 + 기타
    expect(wa.cells[0]).toMatchObject({ text: '·', bg: 'var(--panel-deep)', strong: false });
    expect(wa.cells[2].tone).toBe('other');
    expect(wa.cells[1].tone).toBe('bad');
    expect(wa.cells[3].tone).toBe('none');
    expect(wa.cells[3].text).toBe('673');
    expect(matrixView(null, []).empty).toBe(true);
  });
  it('긴 주소는 줄인다', () => {
    expect(shortIp('168.126.63.1')).toBe('168.126.63.1');
    expect(shortIp('2001:db8::1234:5678')).toBe('2001:db8::12…');
  });
});

describe('아래 3장', () => {
  it('도메인 막대 — 상위 n, 최대 대비', () => {
    const b = barList(DATA.domains, 6);
    expect(b[0]).toMatchObject({ name: 'nj.corp.example', text: '2,110', pct: 100 });
    expect(b[1].pct).toBe(14);
    expect(barList(null)).toEqual([]);
  });
  it('설정 방식 — 둘 다 모르면 null(0 이 아니다)', () => {
    expect(modeSplit(DATA.kpis)).toMatchObject({ static: 1050, dhcp: 150, base: 1200, baseText: '1,200' });
    expect(modeSplit({})).toBeNull();
  });
  it('정합성 3줄 — 0 은 중립색', () => {
    const r = checkRows(DATA.checks);
    expect(r.map((x) => x.key)).toEqual(['mismatch', 'otherCorp', 'singleDns']);
    expect(r[0]).toMatchObject({ n: '0', tone: 'plain' });
    expect(r[1]).toMatchObject({ n: '19', tone: 'warn' });
    expect(checkRows(null).every((x) => x.n === '—' && x.tone === 'plain')).toBe(true);
  });
});

describe('변경 이력', () => {
  const kindOf = (ip) => ({ '8.8.8.8': 'public', '10.0.0.53': 'unknown', '10.20.0.53': 'vm' }[ip] || null);
  it('공인으로 바뀌면 bad, 공인을 빼면 good, 대장에 없는 주소로 바뀌면 warn, 첫 관측은 first', () => {
    expect(changeTone({ before: ['10.20.0.53'], after: ['8.8.8.8'] }, kindOf)).toBe('bad');
    expect(changeTone({ before: ['8.8.8.8'], after: ['10.20.0.53'] }, kindOf)).toBe('good');
    expect(changeTone({ before: ['10.20.0.53'], after: ['10.0.0.53'] }, kindOf)).toBe('warn');
    expect(changeTone({ before: ['10.20.0.53'], after: ['10.20.0.53', '10.20.0.54'] }, kindOf)).toBe('info');
    expect(changeTone({ first: true, after: ['8.8.8.8'] }, kindOf)).toBe('first');
    expect(changeTone(null)).toBe('info');
    for (const k of ['bad', 'good', 'warn', 'info', 'first']) expect(CHANGE_TONE[k].color).toMatch(/^var\(--/);
  });
  it('저장소를 못 쓰면 기록이 없다고 말하지 않는다 · 비면 첫 관측 규칙을 밝힌다', () => {
    expect(changesNote({ available: false }).text).toMatch(/기록이 없다는 뜻이 아닙니다/);
    expect(changesNote({ available: false, reason: 'SQLite 없음' }).text).toMatch(/\(SQLite 없음\)/);
    expect(changesNote({ available: true, changes: [] }, 7).text).toMatch(/^최근 7일 동안 바뀐 DNS 설정이 없습니다/);
    expect(changesNote({ available: true, recent: [{ ts: 1 }] })).toBeNull();
    expect(changesNote(null)).toBeNull();
  });
});

describe('변경 이력 수집 상태', () => {
  it('주기·보관·마지막 기록·쉬는 사유를 서버 값으로 말한다', () => {
    const now = 10_000_000;
    expect(historyNote({ intervalMs: 600_000, retentionDays: 365, lastRunAt: now - 120_000, idleReason: '' }, now)).toBe('기록 주기 10분 · 보관 365일 · 마지막 기록 확인 2분 전');
    expect(historyNote({ intervalMs: 7_200_000, retentionDays: 0, lastRunAt: null, idleReason: '첫 인벤토리 수집을 기다리는 중입니다' }, now))
      .toBe('기록 주기 2시간 · 보관 기한 없음 · 아직 기록을 확인하지 않았습니다 · 첫 인벤토리 수집을 기다리는 중입니다');
    expect(historyNote(null)).toBe('');
  });
});

describe('DNS 서버 상세', () => {
  const ip = '8.8.8.8';
  const VMS = [
    { id: 'a', name: 'WIN-A', vcenterId: 'vc-nj', vcenterName: 'NJ', powerState: 'poweredOn', osServers: ['8.8.8.8', '10.20.0.53'], nicServers: ['8.8.8.8', '10.20.0.53'], domain: 'nj.corp.example', dhcp: false, flags: ['public'] },
    { id: 'b', name: 'ULMA', vcenterId: 'vc-gm', vcenterName: 'GM2', powerState: 'poweredOff', osServers: ['10.40.1.10', '8.8.8.8'], nicServers: ['1.1.1.1'], domain: 'gm.corp.example', dhcp: true, flags: ['mismatch', 'public', 'single', 'zzz'] },
    { id: 'c', name: 'NOOS', vcenterId: 'vc-wa', powerState: 'poweredOn', osServers: [], nicServers: ['8.8.8.8'], dhcp: null, flags: ['other-corp', 'unapproved'] },
  ];
  it('판정 칩 순서 고정 · 모르는 표지도 회색으로 남긴다', () => {
    expect(flagChips(VMS[1].flags).map((f) => f.key)).toEqual(['public', 'mismatch', 'single', 'zzz']);
    expect(flagChips(['zzz'])[0]).toEqual({ key: 'zzz', label: 'zzz', badge: 'gray' });
    for (const k of Object.keys(FLAG_LABEL)) expect(flagChips([k])[0].label).toBe(FLAG_LABEL[k]);
    expect(flagChips(null)).toEqual([]);
  });
  it('서버가 준 쓰는 서버 목록(servers)이 있으면 그것이 먼저다', () => {
    expect(vmServerList({ servers: ['9.9.9.9'], osServers: ['1.1.1.1'], nicServers: ['2.2.2.2'] })).toEqual(['9.9.9.9']);
    expect(isFirstFor({ servers: ['9.9.9.9', '8.8.8.8'] }, '8.8.8.8')).toBe(false);
  });
  it('첫 DNS — OS 실제 값 먼저, 없으면 NIC(position 기준에 기대지 않는다)', () => {
    expect(vmServerList(VMS[2])).toEqual(['8.8.8.8']);
    expect(isFirstFor(VMS[0], ip)).toBe(true);
    expect(isFirstFor(VMS[1], ip)).toBe(false);
    expect(isFirstFor(VMS[2], ip)).toBe(true);
  });
  it('필터 개수 · 검색', () => {
    expect(filterCounts(VMS, ip)).toEqual({ all: 3, on: 2, first: 2, mismatch: 1, dhcp: 1, single: 1, unapproved: 1, 'other-corp': 1 });
    expect(vmMatches(VMS[1], 'dhcp', ip)).toBe(true);
    expect(searchVms(VMS, 'gm.corp').map((v) => v.id)).toEqual(['b']);
    expect(searchVms(VMS, '1.1.1.1').map((v) => v.id)).toEqual(['b']);
    expect(searchVms(VMS, 'nj win').map((v) => v.id)).toEqual(['a']);
    expect(searchVms(VMS, '').length).toBe(3);
  });
  it('전원·방식 — 모르면 —', () => {
    expect(powerText('poweredOn')).toEqual({ text: '켜짐', badge: 'green' });
    expect(powerText('poweredOff').text).toBe('꺼짐');
    expect(powerText(null)).toEqual({ text: '—', badge: '' });
    expect(modeText(true)).toBe('DHCP');
    expect(modeText(false)).toBe('고정');
    expect(modeText(null)).toBe('—');
  });
  it('주소 칩 색 — 공인 red · 다른 법인 amber · 대장에 없음·모르는 주소 gray · 그 밖 blue', () => {
    const byIp = new Map(SERVERS.map((s) => [s.ip, s]));
    expect(ipBadge('8.8.8.8', VMS[0], byIp)).toBe('red');
    expect(ipBadge('10.30.1.11', { vcenterId: 'vc-wa' }, byIp)).toBe('amber');
    expect(ipBadge('10.30.1.11', { vcenterId: 'vc-oc2' }, byIp)).toBe('blue');
    expect(ipBadge('10.0.0.53', VMS[0], byIp)).toBe('gray');
    expect(ipBadge('1.2.3.4', VMS[0], byIp)).toBe('gray');
  });
  it('NIC ≠ OS 안내는 추정이라 적고, 같으면 null', () => {
    expect(mismatchNote(VMS[1])).toMatch(/1\.1\.1\.1.*10\.40\.1\.10, 8\.8\.8\.8.*추정/);
    expect(mismatchNote(VMS[0])).toBeNull();
    expect(mismatchNote(VMS[2])).toBeNull();      // OS 값이 없으면 판정하지 않는다
  });
  it('머리 카드 설명·정책 문구', () => {
    expect(serverHeadDesc(SERVERS[1])).toMatch(/Google Public DNS/);
    expect(serverHeadDesc(SERVERS[3])).toMatch(/지어내지 않습니다/);
    expect(serverHeadDesc(SERVERS[4])).toMatch(/이름은 가립니다.*1대 더/);
    expect(serverHeadDesc(SERVERS[0])).toBe('VM ‘NJ-DC01’(NJ) 이 이 주소를 갖고 있습니다.');
    expect(policyHeadText(SERVERS[1])).toBe('비승인 — 법인 3곳에서 사용');
    expect(policyHeadText(SERVERS[2])).toBe('법인마다 다름 — 비승인 5대');
    expect(policyHeadText(SERVERS[3])).toBe('정책 없음(판정 안 함)');
    expect(policyHeadText(null)).toBe('—');
  });
  it('VM 목록 아래 문구 — 서버가 잘랐으면 밝힌다', () => {
    expect(vmListFoot({ total: 61, vms: VMS }, 3)).toBe('61대 중 3대 표시');
    expect(vmListFoot({ total: 2500, vms: new Array(500).fill({}), truncated: true }, 500)).toBe('2,500대 중 500대 표시 · 서버가 500대까지만 보냈습니다');
  });
});

describe('정책 입력 검증 미리보기', () => {
  it('정규형 IPv4·CIDR 만 받는다', () => {
    expect(checkPolicyEntry('10.20.0.53')).toMatchObject({ ok: true, value: '10.20.0.53', kind: 'ip' });
    expect(checkPolicyEntry(' 10.20.0.0/24 ')).toMatchObject({ ok: true, value: '10.20.0.0/24', kind: 'cidr', warn: null });
    expect(checkPolicyEntry('10.20.0.0/08')).toMatchObject({ ok: true, value: '10.20.0.0/8' });
  });
  it('틀린 것은 사유와 함께 거부한다', () => {
    expect(checkPolicyEntry('').ok).toBe(false);
    expect(checkPolicyEntry('010.20.0.53')).toMatchObject({ ok: false });
    expect(checkPolicyEntry('010.20.0.53').reason).toMatch(/정규형/);
    expect(checkPolicyEntry('10.20.0.256').ok).toBe(false);
    expect(checkPolicyEntry('10.20.0.1-50').reason).toMatch(/범위/);
    expect(checkPolicyEntry('10.0.0.0/').reason).toMatch(/마스크가 비어/);   // /0 로 읽히는 빈 마스크(v2.637)
    expect(checkPolicyEntry('10.0.0.0/4').ok).toBe(false);
    expect(checkPolicyEntry('10.0.0.0/33').ok).toBe(false);
    expect(checkPolicyEntry('dns.corp').ok).toBe(false);
    expect(checkPolicyEntry('x'.repeat(65)).reason).toMatch(/64자/);
  });
  it('네트워크 경계가 아니면 경고(받기는 한다 — 서버의 CIDR 대조가 호스트 비트를 무시한다)', () => {
    const r = checkPolicyEntry('10.20.0.5/24');
    expect(r.ok).toBe(true);
    expect(r.warn).toMatch(/10\.20\.0\.0\/24/);
  });
  it('여러 값·중복·이미 있는 값', () => {
    const p = previewPolicyInput('10.20.0.53, 10.20.0.54 10.20.0.53\n010.1.1.1', ['10.20.0.54']);
    expect(p.map((x) => [x.raw, x.ok, !!x.dup])).toEqual([['10.20.0.53', true, false], ['10.20.0.54', false, true], ['10.20.0.53', false, true], ['010.1.1.1', false, false]]);
    expect(previewPolicyInput('')).toEqual([]);
  });
  it('정책 비교 — 순서·빈 목록은 의미가 없고 공인 규칙 기본은 켬', () => {
    expect(normPolicy({ corps: { a: ['2', '1', '1'], b: [] } })).toEqual({ corps: { a: ['1', '2'] }, publicUnapproved: true });
    expect(samePolicy({ corps: { a: ['1', '2'] } }, { corps: { a: ['2', '1'], b: [] }, publicUnapproved: true })).toBe(true);
    expect(samePolicy({ corps: {} , publicUnapproved: false }, { corps: {} })).toBe(false);
    expect(samePolicy({ corps: { a: ['1'] } }, { corps: { a: ['1', '2'] } })).toBe(false);
  });
  it('서버 invalid 문장 · 법인 행(고아 키 포함) · 위반 표지', () => {
    expect(invalidText({ vcenterId: 'vc-nj', value: '010.1.1.1', reason: '정규형 아님' }, (id) => ({ 'vc-nj': 'NJ' }[id] || id))).toBe('NJ: ‘010.1.1.1’ — 정규형 아님');
    const rows = policyRows([{ id: 'vc-nj', name: 'NJ', vms: 554, unapprovedVms: 9 }, { id: 'vc-wa', name: 'WA', vms: 708 }], { corps: { 'vc-nj': ['10.20.0.53'], 'vc-gone': ['1.2.3.4'], 'vc-empty': [] } });
    expect(rows.map((r) => [r.id, r.orphan])).toEqual([['vc-nj', false], ['vc-wa', false], ['vc-gone', true]]);
    expect(violText(rows[0])).toEqual({ text: '위반 9대', tone: 'warn' });
    expect(violText(rows[1])).toEqual({ text: '정책 없음', tone: 'muted' });
    expect(violText(rows[2])).toMatchObject({ text: '—', tone: 'muted' });   // 서버가 주지 않으면 지어내지 않는다
    expect(violText(rows[2]).title).toMatch(/주지 않습니다/);
    expect(violText({ list: ['1.1.1.1'], viol: 0 })).toEqual({ text: '위반 없음', tone: 'ok' });
  });
  it('범위 필드는 서버 응답 그대로', () => {
    expect(scopeOf({ scope: { scoped: true, omittedOutOfScope: 3 } })).toEqual({ scoped: true, omittedOutOfScope: 3 });
    expect(scopeOf({})).toBeNull();
  });
});

describe('소스 규약', () => {
  // 주석을 먼저 지운다 — 규칙을 설명하는 주석이 통과·실패 근거가 되면 안 된다(v2.535 규약).
  const text = stripComments(fs.readFileSync(path.join(HERE, 'vmDnsText.js'), 'utf8'));
  const jsx = stripComments(fs.readFileSync(path.join(HERE, 'VmDnsTool.jsx'), 'utf8'));
  it('문구 모듈은 React·api.js 를 import 하지 않는다(순수)', () => {
    expect(text).not.toMatch(/from 'react'/);
    expect(text).not.toMatch(/from '[^']*api\.js'/);
  });
  it('화면은 폴링하지 않는다(usePolling·setInterval 0)', () => {
    expect(jsx).not.toMatch(/usePolling\(/);
    expect(jsx).not.toMatch(/setInterval\(/);
  });
  it('표는 STable + minWidth, 날 table 태그 0', () => {
    expect(jsx).not.toMatch(/<table[\s>]/);
    for (const m of jsx.matchAll(/<STable([^>]*)>/g)) expect(m[1]).toMatch(/minWidth=/);
  });
  it('하위 탭은 URL 에 싣는다(useHashTab · fallback overview)', () => {
    expect(jsx).toMatch(/useHashTab\(\{ base: \['tools', 'vm-dns'\], valid: TABS, fallback: 'overview' \}\)/);
  });
  it('관리자 버튼·CSV 버튼은 표시 게이팅을 거친다', () => {
    expect(jsx).toMatch(/hasRole\('admin'\)/);
    expect(jsx).toMatch(/canCsv\(\)/);
  });
  it('새 hex 색을 만들지 않는다(테마 토큰만)', () => {
    expect(jsx).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(text).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
  it('text-transform: uppercase 를 쓰지 않는다', () => {
    expect(jsx).not.toMatch(/uppercase/i);
  });
});

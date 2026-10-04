// v2.690: '/24 대역 가져오기' 판정 — 저장하지 않은 입력·다른 vCenter 저장분과의 중복, 추가·중복 칸 반영.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { applyImport, classifyLine, classifySubnets, countKinds, dupReasonText, idracSummaryText, otherSavedRanges, reflectDups, vmSummaryText } from './vcRangeImportText.js';

const saved = [
  { vcenterId: 'oc2', vcenterName: 'OC2', ranges: ['192.168.10.0/24', '10.94.40.0/24'] },
  { vcenterId: 'wa', vcenterName: 'WA', ranges: ['192.168.40.0/22'] },
];

describe('classifySubnets', () => {
  it('이 칸에 이미 있으면 covered, 일부만이면 partial, 다른 vCenter 저장분과 겹치면 other, 아니면 new', () => {
    const rows = classifySubnets(
      [{ cidr: '192.168.40.0/24' }, { cidr: '10.1.1.0/24' }, { cidr: '10.94.40.0/24' }, { cidr: '172.20.0.0/24' }],
      { text: '192.168.40.0/22\n10.1.1.1-10.1.1.50', saved, vc: 'wa' },
    );
    expect(rows.map((r) => r.kind)).toEqual(['covered', 'partial', 'other', 'new']);
    expect(rows[2].with).toEqual(['OC2']);
    expect(countKinds(rows)).toMatchObject({ new: 1, covered: 1, partial: 1, other: 1 });
  });
  it('지금 고른 vCenter 의 저장분은 다른 vCenter 로 세지 않는다(텍스트 박스가 그 자리를 대신한다)', () => {
    expect(otherSavedRanges(saved, 'wa').map((o) => o.name)).toEqual(['OC2']);
    expect(classifyLine('192.168.41.0/24', { text: '', others: otherSavedRanges(saved, 'wa') }).kind).toBe('new');
  });
  it('같은 창 안에서 앞 줄이 덮은 /24 는 뒤 줄에서 covered', () => {
    const rows = classifySubnets([{ cidr: '10.5.5.0/24' }, { cidr: '10.5.5.0/24' }], { text: '', saved: [], vc: 'x' });
    expect(rows.map((r) => r.kind)).toEqual(['new', 'covered']);
  });
});

describe('applyImport · reflectDups', () => {
  it('새 대역은 텍스트 박스에, 겹치는 것은 중복 칸에 — 선택하지 않은 행은 넣지 않는다', () => {
    const rows = classifySubnets([{ cidr: '10.2.0.0/24' }, { cidr: '10.94.40.0/24' }, { cidr: '10.3.0.0/24' }], { text: '10.9.0.0/24', saved, vc: 'wa' });
    const r = applyImport({ text: '10.9.0.0/24', dupText: '', rows, chosen: new Set(['10.2.0.0/24', '10.94.40.0/24']), saved, vc: 'wa' });
    expect(r.text).toBe('10.9.0.0/24\n10.2.0.0/24');
    expect(r.dupText).toBe('10.94.40.0/24');
    expect(r).toMatchObject({ added: 1, toDup: 1 });
  });
  it('확인 창을 연 뒤 텍스트 박스가 바뀌었으면 넣기 직전에 다시 판정한다', () => {
    const rows = classifySubnets([{ cidr: '10.2.0.0/24' }], { text: '', saved: [], vc: 'wa' });
    expect(rows[0].kind).toBe('new');
    const r = applyImport({ text: '10.2.0.0/23', rows, chosen: new Set(['10.2.0.0/24']), saved: [], vc: 'wa' });
    expect(r.added).toBe(0); expect(r.dupText).toBe('10.2.0.0/24');
  });
  it('중복 칸에서 고친 줄은 반영되고, 여전히 겹치거나 형식이 틀린 줄은 남는다', () => {
    const r = reflectDups({ text: '10.9.0.0/24', dupText: '10.94.41.0/24\n10.94.40.0/24\n10.0.0.0/', saved, vc: 'wa' });
    expect(r.text).toBe('10.9.0.0/24\n10.94.41.0/24');
    expect(r.dupText).toBe('10.94.40.0/24\n10.0.0.0/');
    expect(r.kept.map((k) => dupReasonText(k))).toEqual(['다른 vCenter(OC2)에 저장된 대역과 겹칩니다', '대역 형식이 아닙니다']);
  });
});

describe('문구', () => {
  it('iDRAC — 할당 없음·없는 DataCenter·대역 없음을 각각 말한다(지어내지 않는다)', () => {
    expect(idracSummaryText({ datacenterId: '' })).toMatch(/할당돼 있지 않습니다/);
    expect(idracSummaryText({ datacenterId: 'x', datacenterMissing: true })).toMatch(/등록 목록에 없습니다/);
    expect(idracSummaryText({ datacenterId: 'DC', datacenterName: 'WA', datacenterSource: 'assigned', entries: [] })).toMatch(/등록된 iDRAC 스캔 대역이 없습니다/);
    expect(idracSummaryText({ datacenterId: 'DC', datacenterName: 'WA', entries: [{ enabled: false }], subnets: [{}, {}], invalid: [{}], omitted: 3, cap: 1024 }))
      .toMatch(/\/24 2개.*꺼진 스캔 대역 1건.*읽을 수 없는 대역 1줄.*3개는 목록에 없습니다/);
  });
  it('VM — 뺀 주소·IP 없는 VM·IPv6 를 개수로 밝힌다', () => {
    const t = vmSummaryText({ subnets: [{}], totals: { vms: 10, vmsWithIp: 7, vmsNoIp: 3, ips: 9, ipv6: 2, excluded: { loopback: 1, 'link-local': 2 } } });
    expect(t).toMatch(/VM 10대 중 IPv4 가 있는 VM 7대/);
    expect(t).toMatch(/수집되지 않은 VM 3대/);
    expect(t).toMatch(/3개 주소는 뺐습니다/);
    expect(t).toMatch(/IPv6 2개/);
  });
  it('문구에 백틱·별표 강조를 쓰지 않는다(BoldText 없이 그려진다)', () => {
    const src = fs.readFileSync(new URL('./vcRangeImportText.js', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const strings = src.match(/'[^'\n]*'|`[^`]*`/g) || [];
    expect(strings.filter((s) => s.startsWith("'") && /\*\*|`/.test(s))).toEqual([]);
  });
});

describe('편집기 배선', () => {
  const src = fs.readFileSync(new URL('./VcScanRangeEditor.jsx', import.meta.url), 'utf8');
  it('버튼 두 개 · 확인 창 · 중복 대역 칸 · vCenter 를 바꾸면 중복 칸을 비운다', () => {
    expect(src).toMatch(/iDRAC 대역 가져오기/);
    expect(src).toMatch(/VM 대역 가져오기/);
    expect(src).toMatch(/<VcRangeImportModal/);
    expect(src).toMatch(/aria-label="중복 대역"/);
    expect(src).toMatch(/setDupText\(''\);[^\n]*\}, \[vc\]\)/);
  });
});

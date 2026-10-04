// v2.691: 스캔 대역·설정(에이전트별) — 가져오기·중복 칸·이전 안내 문구(순수).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { agentDupReasonText, defaultServiceNo, idracHeadText, migrationRow, migrationVisible, ownersToSaved, serviceMeta, serviceTitle } from './scanRangeImportText.js';
import { applyImport, classifySubnets } from './vcRangeImportText.js';
import { stripComments } from '../../test/_stripComments.js';

const OWNERS = [
  { owner: '__local__', label: '이 포탈에서 직접', kind: 'agent', ranges: ['10.0.0.0/24'] },
  { owner: 'Edge-OC2', label: 'Edge-OC2', kind: 'agent', ranges: ['10.39.0.0/24'] },
  { owner: 'vc:vc-mil', label: 'vCenter MIL(옮기지 않은 대역)', kind: 'vcenter', ranges: ['10.120.0.0/24'] },
  { owner: 'Edge-Empty', kind: 'agent', ranges: [] },
];

describe('소유자 → 중복 판정 입력', () => {
  it('지금 에이전트(대소문자 무시)는 빼고 · 빈 대역은 빼고 · 옮기지 않은 vCenter 대역은 남긴다', () => {
    const saved = ownersToSaved(OWNERS, 'edge-oc2');
    expect(saved.map((x) => x.vcenterName)).toEqual(['이 포탈에서 직접', 'vCenter MIL(옮기지 않은 대역)']);
  });
  it('가져오기 — 다른 에이전트 대역과 겹치는 /24 는 텍스트 칸이 아니라 중복 칸으로 간다', () => {
    const saved = ownersToSaved(OWNERS, 'Edge-WA');
    const rows = classifySubnets([{ cidr: '10.39.0.0/24' }, { cidr: '172.16.0.0/24' }, { cidr: '192.168.40.0/24' }], { text: '192.168.40.0/24', saved, vc: 'svc' });
    expect(rows.map((r) => r.kind)).toEqual(['other', 'new', 'covered']);
    expect(rows[0].with).toEqual(['Edge-OC2']);
    expect(agentDupReasonText(rows[0])).toBe('다른 스캔 대역(Edge-OC2)과 겹칩니다');
    const r = applyImport({ text: '192.168.40.0/24', dupText: '', rows, chosen: new Set(['10.39.0.0/24', '172.16.0.0/24']), saved, vc: 'svc' });
    expect(r.text.split('\n')).toEqual(['192.168.40.0/24', '172.16.0.0/24']);
    expect(r.dupText).toBe('10.39.0.0/24');
  });
});

describe('iDRAC 서비스 카드', () => {
  const services = [
    { no: 1, service: '서버팜', ranges: ['192.168.40.0/22'], enabled: false, subnets: [{}, {}, {}, {}] },
    { no: 2, service: '', ranges: ['10.94.40.0/24'], enabled: true, subnets: [{}], invalid: [{ value: 'x' }] },
  ];
  it("번호 + 이름, 이름이 없으면 '이름 없음'(지어내지 않는다)", () => {
    expect(serviceTitle(services[0])).toBe('1. 서버팜');
    expect(serviceTitle(services[1])).toBe('2. 이름 없음');
  });
  it('기본 선택은 켜진 서비스 중 첫째 · 없으면 첫째 · 서비스가 없으면 null', () => {
    expect(defaultServiceNo(services)).toBe(2);
    expect(defaultServiceNo([{ no: 1, enabled: false }])).toBe(1);
    expect(defaultServiceNo([])).toBe(null);
  });
  it('설명 — 대역 줄 수 · /24 개수 · 꺼짐 · 읽을 수 없는 줄', () => {
    expect(serviceMeta(services[0])).toBe('대역 1줄 → /24 4개 · 꺼진 스캔 대역');
    expect(serviceMeta(services[1])).toBe('대역 1줄 → /24 1개 · 읽을 수 없는 줄 1');
  });
  it('머리 문구 — DataCenter 를 못 정했으면 고르라고 · 서비스가 여럿이면 하나를 고른다고', () => {
    expect(idracHeadText({ datacenterId: '' })).toMatch(/DataCenter 를 고르세요/);
    expect(idracHeadText({ datacenterId: 'D', datacenterName: 'WA', datacenterSource: 'auto', services })).toBe('DataCenter WA(이 에이전트가 속한 DataCenter) · iDRAC 스캔 대역 서비스 2개 — 하나를 골라 불러옵니다');
    expect(idracHeadText({ datacenterId: 'D', datacenterName: 'WA', services: [] })).toMatch(/등록된 iDRAC 스캔 대역이 없습니다/);
  });
});

describe('이전 안내', () => {
  it('옮김 행은 합친 줄·켠 사실·형식 오류를 말한다 · 옮기지 않은 행은 사유', () => {
    const r = migrationRow({ vcenterId: 'a', vcenterName: 'WA', collectMode: 'site', target: 'Edge-WA', ranges: ['10.0.0.0/24', '10.0.1.0/24'], result: 'moved', merged: 1, enabledAgent: true, invalid: [{}] });
    expect(r).toMatchObject({ vcenter: 'WA', mode: '엣지 위임', target: 'Edge-WA', ranges: '10.0.0.0/24 외 1줄', tone: 'ok' });
    expect(r.result).toBe('옮김 · 2줄 · 이미 있던 1줄은 합침 · 그 에이전트 주기 스캔을 켰습니다 · 형식 오류 1줄은 옮기지 않음');
    const k = migrationRow({ vcenterId: 'b', collectMode: 'site', ranges: ['10.1.0.0/24'], result: 'kept', reason: 'no-agent' });
    expect(k).toMatchObject({ target: '옮기지 않음', tone: 'warn', result: '담당 엣지를 정할 수 없어 그대로 두었습니다' });
    expect(migrationRow({ vcenterId: 'c', collectMode: 'direct', target: '__local__', ranges: [], result: 'moved' }).target).toBe('이 포탈에서 직접');
  });
  it('보이는 조건 — 남은 대역이 있으면 항상 · 아니면 기록이 있고 다시 보지 않기 전까지', () => {
    expect(migrationVisible(null)).toBe(false);
    expect(migrationVisible({ remaining: [{}], state: { dismissedAt: 1 } })).toBe(true);
    expect(migrationVisible({ remaining: [], state: { items: [{}] } })).toBe(true);
    expect(migrationVisible({ remaining: [], state: { items: [{}], dismissedAt: 5 } })).toBe(false);
    expect(migrationVisible({ remaining: [], state: { items: [] } })).toBe(false);
  });
});

describe('화면 소스', () => {
  const scan = stripComments(fs.readFileSync(new URL('./IpScanSettings.jsx', import.meta.url), 'utf8'));
  const modal = stripComments(fs.readFileSync(new URL('./ScanRangeImportModal.jsx', import.meta.url), 'utf8'));
  it('두 가져오기 버튼 · 중복 대역 칸 · 이전 안내 · 에이전트를 바꾸면 중복 칸을 비운다', () => {
    expect(scan).toMatch(/setImportKind\('idrac'\)\}>🖥️ iDRAC 대역 가져오기/);
    expect(scan).toMatch(/setImportKind\('vm'\)\}>🧩 VM 대역 가져오기/);
    expect(scan).toMatch(/aria-label="중복 대역"/);
    expect(scan).toMatch(/<ScanRangeMigration /);
    expect(scan).toMatch(/const switchAgent = \(a\) => \{[^}]*setDupText\(''\)/);
  });
  it('iDRAC 서비스는 라디오(하나만 고른다) · 판정 코어는 classifySubnets 한 벌', () => {
    expect(modal).toMatch(/role="radiogroup"/);
    expect(modal).toMatch(/role="radio" aria-checked=\{on\}/);
    expect(modal).toMatch(/classifySubnets\(subnets, \{ text, saved, vc: SVC_KEY \}\)/);
  });
});

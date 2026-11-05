// v2.909 통합 장비 검색 — 화면 쪽 순수 모듈(접두 · 이동 주소 · 최근 항목 · 행 메타) 고정. 서버 판정과의 접두 대조는 server/test/invSearch2909.test.js.
import { describe, it, expect } from 'vitest';
import {
  splitPrefix, withKindPrefix, focusPlan, listPlan, canFilter, HANDOFF_TARGETS, readRecent, pushRecent, clearRecent, RECENT_MAX, agoText, recentKeyFor,
  highlightParts, metaParts, shownSerial, shownIp, statusTone, builtAgoText,
} from './invSearchQuery.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };

describe('접두', () => {
  it('알려진 접두만 · IPv6 · 모르는 접두는 글자 그대로', () => {
    expect(splitPrefix('vm:web')).toMatchObject({ prefix: 'vm', kind: 'vm', mode: 'all', rest: 'web' });
    expect(splitPrefix('IP: 10.1')).toMatchObject({ prefix: 'ip', kind: null, mode: 'ip', rest: '10.1' });
    expect(splitPrefix('fe80::1')).toMatchObject({ prefix: '', mode: 'all', rest: 'fe80::1' });
    expect(splitPrefix('zz:1')).toMatchObject({ prefix: '', rest: 'zz:1' });
    expect(splitPrefix(null).rest).toBe('');
  });
  it('withKindPrefix 는 접두를 바꾸고 같은 종류면 지운다', () => {
    expect(withKindPrefix('web', 'vm')).toBe('vm:web');
    expect(withKindPrefix('vm:web', 'host')).toBe('host:web');
    expect(withKindPrefix('vm:web', 'vm')).toBe('web');
  });
});

describe('이동 — 기존 상세 주소 · 검색어는 메모리 인계(URL 에 싣지 않는다 — v2.616 규약)', () => {
  it('VM · 호스트 · vCenter 는 이미 있는 상세 주소', () => {
    expect(focusPlan({ kind: 'vm', id: 'vc-1:vm-7', vcenterId: 'vc-1', name: 'a' })).toEqual({ hash: '#/vcenters/vc-1/vm/vc-1%3Avm-7', handoff: null });
    expect(focusPlan({ kind: 'host', id: 'vc1:esx-01', name: 'esx-01' })).toEqual({ hash: '#/hosts/vc1%3Aesx-01', handoff: null });
    expect(focusPlan({ kind: 'vcenter', id: 'vc1', name: 'KR' })).toEqual({ hash: '#/vcenters/vc1', handoff: null });
  });
  it('VM 인데 vCenter 를 모르면 가상머신 탭 검색으로', () => {
    expect(focusPlan({ kind: 'vm', id: 'x', vcenterId: '', name: 'srv-1' })).toEqual({ hash: '#/vms', handoff: ['vms', 'srv-1'] });
  });
  it('도구 화면은 그 화면 주소 + 장비 이름(베어메탈은 서비스 태그) 인계 · 주소에 검색어가 없다', () => {
    expect(focusPlan({ kind: 'storage', id: 'st-1', name: 'unity-a' })).toEqual({ hash: '#/tools/storage-mon/devices', handoff: ['storage-mon', 'unity-a'] });
    expect(focusPlan({ kind: 'server', id: '10.0.0.5', name: 'bm-1', serials: ['7HX2K93'] })).toEqual({ hash: '#/tools/serveranalysis/info', handoff: ['serveranalysis', '7HX2K93'] });
    expect(focusPlan({ kind: 'ip', id: '10.20.1.11', name: '10.20.1.11' })).toEqual({ hash: '#/ipam', handoff: ['ipam', '10.20.1.11'] });
    expect(focusPlan({ kind: 'pdu', id: 'p1', name: 'pdu-1' })).toEqual({ hash: '#/tools/pdu/list', handoff: null });
    expect(focusPlan({ kind: 'sanswitch', id: 's', name: 'PDU (이름 가림)', addrHidden: true }).handoff).toBe(null);
    expect(focusPlan({ kind: 'nope' })).toBe(null);
    for (const k of ['vm', 'host', 'server', 'gpu', 'storage', 'sanswitch', 'netswitch', 'pdu', 'datastore', 'vcenter', 'ip']) {
      const p = focusPlan({ kind: k, id: 'id-1', name: 'n', vcenterId: 'vc' });
      expect(p.hash.startsWith('#/')).toBe(true);
      expect(p.hash).not.toMatch(/\?/);
    }
  });
  it('모두 보기 = 그 화면 검색 칸으로 · 검색 칸이 없는 PDU 는 열기만', () => {
    expect(listPlan('vm', ' srv db ')).toEqual({ hash: '#/vms', handoff: ['vms', 'srv db'] });
    expect(listPlan('parts', '7hx')).toEqual({ hash: '#/tools/serial-lookup', handoff: ['serial-lookup', '7hx'] });
    expect(listPlan('pdu', 'x')).toEqual({ hash: '#/tools/pdu/list', handoff: null });
    expect(canFilter('pdu')).toBe(false);
    expect(canFilter('storage')).toBe(true);
    expect(listPlan('zz', 'x')).toBe(null);
  });
  it('인계 target 마다 받는 화면이 실제로 있다(소스 대조)', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const files = [];
    const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (/\.jsx?$/.test(f.name) && !/\.test\./.test(f.name)) files.push(p); } };
    walk(root);
    const src = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    const app = fs.readFileSync(path.join(root, 'App.jsx'), 'utf8');
    for (const t of HANDOFF_TARGETS) {
      const viaHook = src.includes(`useSearchHandoff('${t}'`);
      const viaTake = src.includes(`takeSearch('${t}')`);
      const viaApp = new RegExp(`INV_FILTER_TABS = \\[[^\\]]*'${t}'`).test(app);
      expect(viaHook || viaTake || viaApp, `받는 화면 없음: ${t}`).toBe(true);
    }
  });
});

describe('최근 연 항목(localStorage 10개)', () => {
  it('맨 앞 · 중복 제거 · 10개 · 저장소 오류에 조용함', () => {
    const st = mem();
    for (let i = 0; i < 12; i++) pushRecent({ kind: 'vm', name: `v${i}`, plan: { hash: `#/vcenters/vc/vm/${i}`, handoff: null } }, st, 1000 + i);
    let r = readRecent(st);
    expect(r).toHaveLength(RECENT_MAX);
    expect(r[0].name).toBe('v11');
    pushRecent({ kind: 'vm', name: 'v5', plan: { hash: '#/vcenters/vc/vm/5', handoff: null } }, st, 5000);
    r = readRecent(st);
    expect(r[0].name).toBe('v5');
    expect(r.filter((x) => x.plan.hash === '#/vcenters/vc/vm/5')).toHaveLength(1);
    pushRecent({ kind: 'storage', name: 'u', plan: { hash: '#/tools/storage-mon/devices', handoff: ['storage-mon', 'u'] } }, st, 6000);
    expect(readRecent(st)[0].plan.handoff).toEqual(['storage-mon', 'u']);
    const bad = mem(); bad.setItem('ui.invSearch.recent', JSON.stringify([{ name: 'x', plan: { hash: 'javascript:alert(1)' } }]));
    expect(readRecent(bad)).toEqual([], '주소가 #/ 로 시작하지 않으면 버린다');
    expect(clearRecent(st)).toEqual([]);
    expect(readRecent(st)).toEqual([]);
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(readRecent(broken)).toEqual([]);
    expect(() => pushRecent({ kind: 'vm', name: 'a', plan: { hash: '#/a' } }, broken)).not.toThrow();
    const junk = mem(); junk.setItem('ui.invSearch.recent', '{"a":1}');
    expect(readRecent(junk)).toEqual([]);
  });
  it('계정별 키 — 다른 계정의 최근 항목을 읽지 않는다 · 계정을 모르면 저장하지 않는다(반증 L-4)', () => {
    const st = mem();
    const ka = recentKeyFor('alice'); const kb = recentKeyFor('bob');
    expect(ka).not.toBe(kb);
    pushRecent({ kind: 'vm', name: 'secret-vm', plan: { hash: '#/vcenters/vc/vm/1', handoff: null } }, st, 1, ka);
    expect(readRecent(st, ka)).toHaveLength(1);
    expect(readRecent(st, kb)).toEqual([]);
    expect(recentKeyFor('')).toBe(null);
    expect(pushRecent({ kind: 'vm', name: 'x', plan: { hash: '#/a' } }, st, 1, null)).toEqual([]);
    expect(readRecent(st, null)).toEqual([]);
  });
  it('agoText · builtAgoText', () => {
    expect(agoText(0)).toBe('');
    expect(agoText(1000, 1000 + 30_000)).toBe('방금');
    expect(agoText(1000, 1000 + 5 * 60_000)).toBe('5분 전');
    expect(builtAgoText(1000, 1000 + 14_000)).toBe('14초 전');
  });
});

describe('행 표시', () => {
  it('highlightParts 대소문자 무시', () => {
    expect(highlightParts('SRV-DB-01', 'db')).toEqual(['SRV-', 'DB', '-01']);
    expect(highlightParts('abc', 'zz')).toEqual(['abc', '', '']);
  });
  it('값이 없으면 조각을 넣지 않는다 · 가린 주소는 (주소 가림)', () => {
    const m = metaParts({ kind: 'storage', corp: 'KR', model: '', sub: 'Unity', addr: '', addrHidden: true, serials: [] });
    expect(m.map((p) => p.t)).toEqual(['KR', 'Unity', '(주소 가림)']);
    const v = metaParts({ kind: 'vm', corp: 'KR', ips: [], sub: 'RHEL' });
    expect(v.map((p) => p.t)).toEqual(['KR', 'IP —', 'RHEL']);
  });
  it('sn: 은 걸린 시리얼 · ip: 는 걸린 IP', () => {
    expect(shownSerial({ serials: ['AAA', '7HX-2K93'] }, 'sn', '7hx2k')).toBe('7HX-2K93');
    expect(shownIp({ ips: ['10.1.1.1', '10.20.1.5'] }, '10.20')).toBe('10.20.1.5');
  });
  it('모르는 상태는 점을 그리지 않는다', () => {
    expect(statusTone('ok')).toBe('green');
    expect(statusTone('')).toBe(null);
  });
});

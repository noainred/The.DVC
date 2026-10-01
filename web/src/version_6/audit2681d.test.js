/**
 * v2.681 감사(R2C-01~05) 회귀 — V6 법인 카드 · V5 Overview 골격/범위 · IP 스캔 설정 재적재 · PDU 재조회 · 저장소 접근.
 * 순수 함수는 값으로, 컴포넌트 전용 수정은 소스로 고정한다(웹 테스트는 node 환경이라 렌더를 못 한다).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { stripComments } from '../test/_stripComments.js';
import { siteCards, siteToneCounts } from './v6Data.js';
import { infraTotals } from '../version_5/overviewData.js';

const read = (p) => stripComments(fs.readFileSync(new URL(p, import.meta.url), 'utf8'));
const m0 = { hosts: 0, vms: 0, vmsPoweredOn: 0, alarmsCritical: 0, alarmsWarning: 0 };

describe('R2C-01 V6 법인 카드 — 첫 수집 중·비활성·연결 실패는 0 이 아니다', () => {
  const cards = siteCards([
    { id: 'vc1', name: 'HG', status: 'pending', metrics: m0 },
    { id: 'vc2', name: 'AS', status: 'disabled', metrics: m0 },
    { id: 'vc3', name: 'BX', status: 'unreachable', metrics: { ...m0, cpuUsagePct: 95 } },
    { id: 'vc4', name: 'CZ', status: 'connected', metrics: { hosts: 3, vms: 10, cpuUsagePct: 50, alarmsCritical: 1 } },
  ]);
  const by = Object.fromEntries(cards.map((c) => [c.id, c]));
  it('셀 수 없는 법인은 호스트·VM·알람 null + 표지', () => {
    for (const id of ['vc1', 'vc2', 'vc3']) {
      expect(by[id].hosts).toBeNull();
      expect(by[id].vms).toBeNull();
      expect(by[id].alarms).toBeNull();
      expect(by[id].mark).toBeTruthy();
      expect(by[id].bars.every((b) => b.v == null)).toBe(true);
    }
    expect(by.vc1.mark).toBe('첫 수집 중');
    expect(by.vc3.tone).toBe('none'); // 마지막 값으로 '위험' 판정하지 않는다
  });
  it('연결된 법인은 그대로 센다', () => {
    expect(by.vc4).toMatchObject({ hosts: 3, vms: 10, alarms: 1, tone: 'ok', mark: null });
  });
  it('비활성은 판정 대기가 아니라 off 로 따로 센다', () => {
    expect(by.vc2.tone).toBe('off');
    expect(siteToneCounts(cards)).toEqual({ ok: 1, warn: 0, crit: 0, none: 2, off: 1 });
  });
  it('화면이 off 개수·표지·— 를 그린다', () => {
    const src = read('./pages/Overview.jsx');
    expect(src).toMatch(/counts\.off/);
    expect(src).toMatch(/c\.mark/);
    expect(src).toMatch(/c\.hosts == null \? '—'/);
  });
});

describe('R2C-02 V5 Overview — 골격·범위 법인', () => {
  it('첫 병합 전 골격(initial)은 수집 준비 중 패널', () => {
    expect(read('../version_5/pages/Overview.jsx')).toMatch(/if \(!ov\.global \|\| ov\.initial\)/);
  });
  it('범위 법인이 첫 수집 중이면 호스트·VM·스토리지 null + 표지', () => {
    const ov = { global: { vcenters: 2 }, sites: [{ id: 'a', name: 'A', status: 'pending', metrics: { ...m0, storageTotalTB: 0 } }] };
    const t = infraTotals(ov, 'a');
    expect(t).toMatchObject({ hosts: null, vms: null, vmsOn: null, storageTotalTB: null, statusMark: '첫 수집 중' });
  });
  it('연결된 범위 법인은 그대로', () => {
    const ov = { global: { vcenters: 1 }, sites: [{ id: 'a', name: 'A', status: 'connected', metrics: { hosts: 2, vms: 5, vmsPoweredOn: 4 } }] };
    expect(infraTotals(ov, 'a')).toMatchObject({ hosts: 2, vms: 5, vmsOn: 4 });
    expect(infraTotals(ov, 'a').statusMark).toBeUndefined();
  });
});

describe('R2C-03 IP 스캔 설정 — 첫 조회 실패 뒤 폴링 성공이 폼을 채운다', () => {
  const src = read('../views/tools/IpScanSettings.jsx');
  it('성공 경로가 오류를 지우고, 폼을 채운 에이전트가 다르면 다시 채운다', () => {
    expect(src).toMatch(/else if \(formForRef\.current !== ag\) \{ d\.load\(r\.settings\); setSFor\(ag\); \}\s*formForRef\.current = ag;\s*setLoadErr\(null\);/);
  });
});

describe('R2C-04 PDU — 재조회 동안 직전 데이터를 그린다', () => {
  const src = read('../views/tools/PduTool.jsx');
  it('직전 데이터 ref + data = pollData ?? 직전', () => {
    expect(src).toMatch(/if \(pollData\) lastDataRef\.current = pollData;/);
    expect(src).toMatch(/const data = pollData \?\? lastDataRef\.current;/);
  });
});

describe('R2C-05 localStorage 접근은 try 안에서', () => {
  it('App 랜딩 탭 읽기·저장', () => {
    const src = read('../App.jsx');
    expect(src).toMatch(/try \{\s*const saved = localStorage\.getItem\(LANDING_KEY\);/);
    expect(src).toMatch(/try \{ localStorage\.setItem\(LANDING_KEY, id\); \} catch/);
  });
  it('SvcMonitor 왼쪽 폭', () => {
    expect(read('../views/SvcMonitor.jsx')).toMatch(/try \{ return Number\(localStorage\.getItem\(LEFT_W_KEY\)\)/);
  });
});

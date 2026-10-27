// v2.802 '호스트 · 클러스터 엑셀' 창 도우미 — 권한 없는 묶음 잠금 · Veeam 은 VM 목록이 있어야 · 시트 수 · 상한 · 출처 타일('—' 은 0 이 아니다).
import { describe, it, expect } from 'vitest';
import { PARTS, initialState, partRows, pickedHosts, sheetLine, exportBody, sourceTiles } from './hostExportText.js';

const NOW = Date.UTC(2026, 9, 27, 5, 0, 0);
const status = (over = {}) => ({
  hosts: 20, max: 300, bootDays: 30, access: { hygiene: true, cluster: true, hw: true },
  clusters: [{ key: 'r:c1', name: 'AZ-Admin', hosts: 2 }, { key: 'r:c2', name: 'AZ-DataAPI', hosts: 4 }, { key: 'standalone', name: '독립 호스트', hosts: 1 }],
  sources: { inventory: { hosts: 20, at: new Date(NOW - 16_000).toISOString() }, hcfg: { read: 19, total: 20 }, clusterCfg: { read: 5, total: 5, at: NOW - 240_000 }, idrac: { matched: 15, registered: 16, total: 20 } },
  ...over,
});

describe('hostExportText', () => {
  it('처음 상태 — Veeam 만 끔 · 권한 없는 묶음은 끄고 잠근다(사유)', () => {
    const st = initialState(status());
    expect(Object.entries(st.parts).filter(([, v]) => !v).map(([k]) => k)).toEqual(['vmVeeam']);
    const s2 = status({ access: { hygiene: false, cluster: true, hw: false } });
    const rows = partRows(s2, initialState(s2));
    const by = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(by.sec.on).toBe(false); expect(by.sec.disabled).toBe(true); expect(by.sec.src).toMatch(/권한이 없어/);
    expect(by.boot.disabled).toBe(true); expect(by.hw.src).toMatch(/관리자 판본/);
    expect(by.base.fixed && by.base.on && by.base.disabled).toBe(true);
    expect(by.net.disabled).toBe(false);
  });
  it('Veeam 칸은 VM 목록을 고를 때만', () => {
    const s = status();
    const st = { ...initialState(s), parts: { ...initialState(s).parts, vm: false, vmVeeam: true } };
    const v = partRows(s, st).find((r) => r.key === 'vmVeeam');
    expect(v.disabled).toBe(true); expect(v.on).toBe(false);
    expect(exportBody(s, st).parts).not.toContain('vmVeeam');
  });
  it('대상 · 시트 수 · 상한 · 본문', () => {
    const s = status();
    const st = initialState(s);
    expect(sheetLine(s, st)).toEqual({ text: '시트 24장', ok: true, n: 20 });
    const pick = { ...st, mode: 'pick', picked: { 'r:c2': true, standalone: true } };
    expect(pickedHosts(s, pick)).toBe(5);
    expect(exportBody(s, pick)).toEqual({ parts: ['sec', 'net', 'st', 'hw', 'boot', 'vm'], clusters: ['r:c2', 'standalone'] });
    expect(sheetLine(s, { ...st, mode: 'pick', picked: {} }).ok).toBe(false);
    expect(sheetLine(status({ hosts: 301 }), st)).toMatchObject({ ok: false });
    expect(exportBody(s, st).clusters).toBeUndefined();
  });
  it('출처 타일 — 모르면 — · 권한 없는 출처는 사유 · 못 읽은 수', () => {
    const t = Object.fromEntries(sourceTiles(status(), NOW).map((x) => [x.key, x]));
    expect(t.inv.value).toBe('호스트 20대'); expect(t.inv.sub).toBe('마지막 16초 전');
    expect(t.hcfg).toMatchObject({ value: '19 / 20', sub: '아직 못 읽은 호스트 1대', tone: 'warn' });
    expect(t.ccfg).toMatchObject({ value: '5 / 5', sub: '마지막 4분 전' });
    expect(t.idrac).toMatchObject({ value: '15 / 20', sub: '등록 안 된 서버 4대 · 인벤토리 대기 1대' });
    const none = Object.fromEntries(sourceTiles(status({ sources: { inventory: { hosts: 3 } } }), NOW).map((x) => [x.key, x]));
    expect(none.hcfg.value).toBe('—'); expect(none.idrac.sub).toBe('관리자 판본에만');
  });
  it('묶음 목록 — 키 8개(base + 서버 HOST_EXPORT_PARTS — 서버 테스트가 대조)', () => {
    expect(PARTS.map((p) => p[0])).toEqual(['base', 'sec', 'net', 'st', 'hw', 'boot', 'vm', 'vmVeeam']);
  });
});

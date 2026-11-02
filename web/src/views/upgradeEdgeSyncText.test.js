// v2.859 — 업그레이드 화면 '엣지 자동 업그레이드' 칸 문구(중앙이 업그레이드되면 등록된 엣지도 모두 자동 업그레이드 · 기본 켬).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EDGE_STATE_TEXT, SYNC_OUTCOME_TEXT, EDGE_SYNC_OFF_FIX, edgeSyncSummary, noSyncText, edgeAutoCheckboxHint } from './upgradeEdgeSyncText.js';

const NOW = Date.UTC(2026, 10, 2, 13, 20, 0); // 고정 기준 시각(정시와 떨어뜨림)
const HERE = path.dirname(fileURLToPath(import.meta.url));
const serverSrc = fs.readFileSync(path.resolve(HERE, '../../../server/src/upgrade/edgeSync.js'), 'utf8');
const listOf = (name) => {
  const m = new RegExp(`export const ${name} = Object\\.freeze\\(\\[([\\s\\S]*?)\\]\\)`).exec(serverSrc);
  if (!m) throw new Error(`${name} 를 서버 소스에서 찾지 못했습니다`);
  const body = m[1].split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  return [...body.matchAll(/'([^']+)'/g)].map((x) => x[1]);
};

describe('서버 코드 ↔ 화면 문구 1:1', () => {
  it('EDGE_SYNC_STATES · EDGE_SYNC_OUTCOMES 가 웹 표와 같다', () => {
    expect(Object.keys(EDGE_STATE_TEXT).sort()).toEqual(listOf('EDGE_SYNC_STATES').sort());
    expect(Object.keys(SYNC_OUTCOME_TEXT).sort()).toEqual(listOf('EDGE_SYNC_OUTCOMES').sort());
  });
  it('문구에 백틱·별표 강조가 없다(BoldText 가 글자로 그린다)', () => {
    const all = JSON.stringify({ EDGE_STATE_TEXT, SYNC_OUTCOME_TEXT, EDGE_SYNC_OFF_FIX }) + edgeAutoCheckboxHint({ edgeSync: { intervalMs: 600_000 } }) + noSyncText({ edgeSync: { enabled: true } });
    expect(all.includes('`')).toBe(false);
    expect(all.includes('**')).toBe(false);
  });
});

describe('엣지 자동 업그레이드 요약', () => {
  it('서버가 edgeSync 를 보내지 않으면(구버전) 그리지 않는다', () => {
    expect(edgeSyncSummary({ enabled: true })).toBe(null);
  });
  it('기본(켬) — 다음 실행·주기 · 마지막 실행 · 개수 · 뒤처진 엣지 행', () => {
    const s = {
      enabled: true, edgeAutoUpgrade: true,
      edgeSync: {
        enabled: true, armed: true, intervalMs: 600_000, nextRunAt: NOW + 7 * 60_000, running: false, total: 4,
        counts: { 'up-to-date': 2, behind: 1, ahead: 0, unknown: 0, unreachable: 1, disabled: 0, waiting: 0, backoff: 0 },
        lastRun: { at: NOW - 3 * 60_000, outcome: 'pushed', version: '2.747.0', pushed: 1, ok: 1 },
        pending: [{ id: 'kr2', name: '부산', version: '2.746.0', state: 'behind', reason: null, nextAt: null }, { id: 'pl1', name: '폴란드', version: '2.740.0', state: 'unreachable', reason: 'export -> ETIMEDOUT', nextAt: null }],
      },
    };
    const a = edgeSyncSummary(s, NOW);
    expect(a.tone).toBe('ok'); expect(a.label).toMatch(/켬/);
    expect(a.next).toMatch(/7분 뒤/); expect(a.next).toMatch(/10분 주기/);
    expect(a.last).toMatch(/밀어 넣었습니다 — 1\/1대 성공 \(v2\.747\.0\)/); expect(a.lastTone).toBe('ok');
    expect(a.counts).toBe('등록 4대 · 최신 2 · 구버전 1 · 닿지 않음 1');
    expect(a.rows).toHaveLength(2);
    expect(a.rows[0].text).toBe(EDGE_STATE_TEXT.behind.label); expect(a.rows[0].version).toBe('2.746.0');
    expect(a.rows[1].tone).toBe('bad'); expect(a.rows[1].reason).toMatch(/ETIMEDOUT/);
    expect(a.fix).toBe(null);
  });
  it('설정으로 끈 경우 — 꺼짐 + 조치 · 기능 자체가 꺼진 경우는 다른 문장', () => {
    const off = edgeSyncSummary({ enabled: true, edgeAutoUpgrade: false, edgeSync: { enabled: false, armed: false, intervalMs: 0, nextRunAt: null, pending: [], counts: null, total: 0 } }, NOW);
    expect(off.label).toBe('꺼짐'); expect(off.tone).toBe('warn'); expect(off.fix).toBe(EDGE_SYNC_OFF_FIX); expect(off.next).toMatch(/꺼짐/);
    const feat = edgeSyncSummary({ enabled: false, edgeAutoUpgrade: true, edgeSync: { enabled: false, pending: [] } }, NOW);
    expect(feat.label).toMatch(/자동 업그레이드 사용이 꺼져/); expect(feat.fix).toMatch(/자동 업그레이드 사용/);
    expect(noSyncText({ edgeSync: { enabled: false } })).toMatch(/꺼져/);
    expect(noSyncText({ edgeSync: { enabled: true } })).toMatch(/기동 2분 뒤/);
  });
  it('번들을 못 구한 실행 · 일부 실패 · 백오프 행의 다음 시각', () => {
    const s = { enabled: true, edgeAutoUpgrade: true, edgeSync: { enabled: true, armed: true, intervalMs: 600_000, nextRunAt: NOW + 60_000, total: 2, counts: { 'up-to-date': 0, behind: 2, ahead: 0, unknown: 0, unreachable: 0, disabled: 0, waiting: 0, backoff: 0 },
      lastRun: { at: NOW - 60_000, outcome: 'no-bundle', behind: 2, reason: '원격 소스의 최신은 v2.748.0 — 중앙 현재 버전(v2.859.0) 번들이 아니라 받지 않습니다' }, pending: [{ id: 'a', name: 'a', version: '2.746.0', state: 'backoff', reason: 'HTTP 403', nextAt: NOW + 20 * 60_000 }] } };
    const a = edgeSyncSummary(s, NOW);
    expect(a.last).toMatch(/구하지 못했습니다 — 뒤처진 2대 · 원격 소스의 최신은/); expect(a.lastTone).toBe('bad');
    expect(a.rows[0].text).toMatch(/최근 push 실패 — 잠시 뒤 다시 \(20분 뒤 다시\)/);
    const part = edgeSyncSummary({ ...s, edgeSync: { ...s.edgeSync, lastRun: { at: NOW - 60_000, outcome: 'pushed', pushed: 3, ok: 2, version: '2.747.0' } } }, NOW);
    expect(part.lastTone).toBe('warn'); expect(part.last).toMatch(/2\/3대 성공/);
  });
  it('체크박스 설명은 서버 주기를 쓰고, 모르면 숫자를 지어내지 않는다', () => {
    expect(edgeAutoCheckboxHint({ edgeSync: { intervalMs: 600_000 } })).toMatch(/10분마다/);
    expect(edgeAutoCheckboxHint({})).toMatch(/주기적으로/);
    expect(edgeAutoCheckboxHint({})).not.toMatch(/10분/);
  });
});

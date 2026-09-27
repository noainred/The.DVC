// v2.629 그룹 f 회귀 — V6 기여도·알람 미조회·빈 구분 문구 / 스캔 대역 폼 목록 밖 값 / 403 폴링 중단 / NSX 삭제 실패 /
// bm-usage 입력 실패·보존 정리 / 전산실 추이 각주. 순수 판정은 값으로, 화면 배선은 주석을 뺀 소스로 본다.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../test/_stripComments.js';
import { corpContribution, contribRowKind, contribNote, contribTotalLabel, statusTiles, alarmsUnknownCount, emptyGroupText } from '../version_6/v6Data.js';
import { missingChoice, choiceLoadNote } from './idrac/scanRangeFormText.js';
import { sourceErrorsNote, lastPruneNote } from './tools/bmUsageText.js';
import { trendNotes } from './tools/roomTempView.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (rel) => stripComments(fs.readFileSync(path.join(here, rel), 'utf8'));
// 기준 시각은 고정값(Date.now() 금지 — CLAUDE.md).
const NOW = Date.UTC(2026, 8, 27, 3, 30, 0);

describe('A1-2629-02 V6 법인별 기여도 — 점검 중·이월 vCenter 는 값을 쓴다', () => {
  const S = { byVcenter: [
    { id: 'a', status: 'connected', hosts: 20, vms: 100 },
    { id: 'b', status: 'maintenance', hosts: 30, vms: 300 },
    { id: 'c', status: 'unreachable', hosts: 10, vms: 50 },   // LASTGOOD 이월
    { id: 'd', status: 'unreachable', hosts: 0, vms: 0 },     // 보존 창 밖 — 인벤토리 비움
    { id: 'e', status: 'pending', hosts: 0, vms: 0 },
    { id: 'f', status: 'disabled', hosts: 0, vms: 0 },
  ] };
  it('행 종류 판정', () => {
    expect(S.byVcenter.map(contribRowKind)).toEqual(['live', 'carried', 'carried', 'none', 'none', 'none']);
    expect(contribRowKind({ status: 'weird', hosts: 5 })).toBe('none');
  });
  it('합계는 상단 타일과 같은 기준(점검 중·이월 포함) — 60 호스트', () => {
    const c = corpContribution(S);
    expect(c.total.hosts).toBe(60);
    expect(c.total.vms).toBe(450);
    expect(c.carried).toBe(2);
    expect(c.excluded).toBe(3);
    expect(c.rows.find((r) => r.id === 'b').hosts).toBe(30);
    expect(c.rows.find((r) => r.id === 'b').statusLabel).toBe('점검 중 · 직전 값');
    expect(c.rows.find((r) => r.id === 'd').hosts).toBe(null);
  });
  it('머리말·합계 라벨이 두 종류를 나눠 말한다', () => {
    const c = corpContribution(S);
    expect(contribNote(c)).toMatch(/3곳은 값을 모르므로/);
    expect(contribNote(c)).toMatch(/2곳은 직전 수집 값을 합계에 포함/);
    expect(contribTotalLabel(c)).toBe('합계(3곳 제외 · 직전 값 2곳 포함)');
    expect(contribTotalLabel(corpContribution({ byVcenter: [{ id: 'a', status: 'connected', hosts: 1 }] }))).toBe('합계');
  });
  it('Summary 화면이 새 라벨을 쓴다', () => {
    const s = src('../version_6/pages/Summary.jsx');
    expect(s).toMatch(/contribTotalLabel\(contrib\)/);
    expect(s).toMatch(/contribNote\(contrib\)/);
  });
});

describe('WEB2629-04 활성 알람 — 경보 미조회 vCenter 를 밝힌다', () => {
  const G = { vcenters: 2, vcentersConnected: 2, alarms: 3, alarmsCritical: 2, alarmsWarning: 1 };
  const sites = [{ id: 'a', metrics: { alarmsCritical: 2, alarmsWarning: 1 } }, { id: 'b', collectSource: 'rest', alarmsUnknown: true, metrics: {} }];
  it('타일 note', () => {
    expect(alarmsUnknownCount(sites)).toBe(1);
    expect(alarmsUnknownCount(undefined)).toBe(null);
    expect(statusTiles(G, sites).find((t) => t.id === 'alarms').note).toMatch(/경보 미조회 vCenter 1곳/);
    expect(statusTiles(G, [sites[0]]).find((t) => t.id === 'alarms').note).toBe('');
  });
  it('Overview 가 sites 를 넘기고 상태바가 같은 판정(alarmTotals)을 쓴다', () => {
    expect(src('../version_6/pages/Overview.jsx')).toMatch(/statusTiles\(g, ov\.sites\)/);
    const app = src('../App.jsx');
    expect(app).toMatch(/alarmTotals\(vcenters\)\.unknown/);
    expect(app).not.toMatch(/\(health\?\.alarms \|\| 0\)/);
  });
});

describe('WEB2629-05 빈 구분 문구', () => {
  it('전체는 다빈치 문구가 아니다', () => {
    expect(emptyGroupText('all')).toBe('표시할 법인이 없습니다.');
    expect(emptyGroupText('irs')).toMatch(/들어간 법인이 없습니다/);
    expect(emptyGroupText('davinci')).toMatch(/없는 법인이 없습니다/);
    expect(src('../version_6/pages/Overview.jsx')).toMatch(/emptyGroupText\(group\)/);
  });
});

describe('WEB2629-02 스캔 대역 폼 — 목록에 없는 저장값', () => {
  it('missingChoice', () => {
    expect(missingChoice(['oc2', 'hq'], 'oc2')).toBe(null);
    expect(missingChoice([], 'oc2')).toEqual({ value: 'oc2', label: 'oc2 (목록에 없음)' });
    expect(missingChoice(['oc2'], 'OC2').label).toMatch(/대소문자가 다름/);
    expect(missingChoice([], '__local__', ['__local__'])).toBe(null);
    expect(missingChoice(['x'], '')).toBe(null);
  });
  it('조회 실패 안내', () => {
    expect(choiceLoadNote({})).toBe('');
    expect(choiceLoadNote({ agents: '403' })).toMatch(/스캔 수행 Agent 목록을 불러오지 못했습니다/);
  });
  it('폼·관리 화면 배선', () => {
    const r = src('./idrac/IdracScanRanges.jsx');
    expect(r).toMatch(/missingChoice\(all, form\.agent, \['__local__'\]\)/);
    expect(r).toMatch(/missingChoice\(datacenters\.map/);
    expect(r).toMatch(/choiceLoadNote\(choiceErrors\)/);
    const a = src('./IdracAdmin.jsx');
    expect(a).not.toMatch(/scan-agents'\)\.then\(setAgents\)\.catch\(\(\) => \{\}\)/);
    expect(a).not.toMatch(/\/admin\/datacenters'\)[^\n]*\.catch\(\(\) => \{\}\)/);
    expect(a).toMatch(/choiceErrors=\{choiceErr\}/);
  });
});

describe('WEB2629-03 403 이면 폴링을 멈춘다', () => {
  for (const f of ['./tools/BmStorageTool.jsx', './tools/RelayCheckTool.jsx']) {
    it(f, () => {
      const s = src(f);
      expect(s).toMatch(/status === 403\) denied\.current = true/);
      expect(s).toMatch(/if \(!denied\.current\)/);
      expect(s).toMatch(/<ErrorBox error=\{error\} \/>/);
      expect(s).not.toMatch(/setError\(e\.message\)/);
    });
  }
});

describe('WEB2629-06 NSX 삭제 실패는 배너', () => {
  it('목록이 있으면 전체 오류가 아니다', () => {
    const s = src('./NsxAdmin.jsx');
    expect(s).toMatch(/if \(error && !data\) return <ErrorBox/);
    expect(s).not.toMatch(/catch \(e\) \{ setError\(e\); \}\s*\n\s*\};\s*\n\s*const list/);
    expect(s).toMatch(/setActErr\(/);
  });
});

describe('A6-06 bm-usage 입력 실패·보존 정리', () => {
  it('sourceErrorsNote', () => {
    expect(sourceErrorsNote(null)).toBe(null);
    expect(sourceErrorsNote({ sourceErrors: [] })).toBe(null);
    const x = sourceErrorsNote({ sourceErrors: [{ source: 'idrac-registry', error: 'EACCES' }, null] });
    expect(x.head).toMatch(/\*\*1개\*\*/);
    expect(x.items[0]).toBe('iDRAC 등록부: EACCES');
  });
  it('lastPruneNote', () => {
    expect(lastPruneNote(null, NOW)).toMatch(/아직 보존 정리를 하지 않았습니다/);
    expect(lastPruneNote({ at: NOW - 120_000, ok: true, rawDeleted: 1200, dailyDeleted: 0, done: true }, NOW)).toMatch(/원시 1,200행 · 롤업 0행 삭제/);
    expect(lastPruneNote({ at: NOW - 60_000, ok: false, error: 'locked' }, NOW)).toMatch(/\*\*실패\*\* — locked/);
    expect(lastPruneNote({ at: NOW - 60_000, ok: true, skipped: true, reason: 'no-db' }, NOW)).toMatch(/건너뜀\(수집이 꺼져/);
    expect(lastPruneNote({ at: NOW - 60_000, ok: true }, NOW)).not.toMatch(/0행/);
  });
  it('화면 배선', () => {
    const s = src('./tools/BmUsage.jsx');
    expect(s).toMatch(/sourceErrorsNote\(st\.last\)/);
    expect(s).toMatch(/lastPruneNote\(st\.lastPrune\)/);
  });
});

describe('A6-07 전산실 추이 각주', () => {
  it('trendNotes', () => {
    expect(trendNotes({ stepFilled: 0 })).toEqual([]);
    expect(trendNotes(null)).toEqual([]);
    expect(trendNotes({ stepFilled: 12 })[0]).toMatch(/12개 구간은 직전 값을 이어/);
    const t = trendNotes({ truncated: true, coveredSince: Date.UTC(2026, 8, 20) });
    expect(t).toHaveLength(1);
    expect(t[0]).toMatch(/이후만 표시합니다/);
  });
  it('모달 배선', () => {
    expect(src('./tools/RoomTemp.jsx')).toMatch(/trendNotes\(d\)\.map/);
  });
});

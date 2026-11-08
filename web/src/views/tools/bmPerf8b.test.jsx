/**
 * 리눅스 성능 8b단계 — 프로세스 Top-N · 저활용 · 전력/온도 화면(문구 · 그리기) 회귀.
 * ⚠ 판정은 서버(parse/linuxTop · topStore · idle · powerAgg) — 여기서는 ① 웹 문구 표 = 서버 열거(1:1) ② 못 읽음 · 권한 · 미측정을 0 · ‘정상’ 으로 그리지 않는다
 *   ③ 서버가 준 값만 그린다(SSR) ④ 웹이 점수 · 합계 · 판정을 다시 계산하지 않고 폴링하지 않는다(소스 스윕).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as TT from './bmTopText.js';
import * as IT from './bmIdleText.js';
import * as PT from './bmPowerText.js';
import { TopBand } from './BmTopProc.jsx';
import { IdleFleetView } from './BmIdleFleet.jsx';
import { PowerFleetView } from './BmPowerFleet.jsx';
import { procHint } from '../../../../server/src/bmusage/parse/linuxTop.js';
import { IDLE_STATUS, IDLE_EXCLUDE, IDLE_METRICS, IDLE_REVIEW } from '../../../../server/src/bmusage/idleConst.js';
import { UNMEASURED } from '../../../../server/src/bmusage/powerAgg.js';
import { CHANGE_KINDS } from '../../../../server/src/bmusage/changes.js';
import { CHANGE_KIND_TEXT } from './bmPerfOpsText.js';
import { famLine } from './bmCollectText.js';

const h = React.createElement;
const HERE = path.dirname(new URL(import.meta.url).pathname);

describe('⑳ 프로세스 Top-N 문구', () => {
  it('① 서버 단서 code = 문구 표 · 변경 이벤트 종류 idle 문구', () => {
    for (const c of [['postgres', 'gpadmin'], ['airflow', 'x'], ['kswapd0', 'root'], ['sshd', 'root'], ['kworker/0:1', 'root']]) {
      const k = procHint({ comm: c[0], user: c[1] });
      expect(TT.HINT_TEXT[k]).toBeTruthy();
    }
    for (const k of CHANGE_KINDS) expect(CHANGE_KIND_TEXT[k]).toBeTruthy();
  });
  it('② 권한 · 못 읽음은 0 이 아니다 · 단위 없음', () => {
    expect(TT.valText('io', { ioPerm: true, val: null })).toBe('권한');
    expect(TT.valText('io', { val: null })).toBe('—');
    expect(TT.rssText(null)).toBe('—'); expect(TT.cpuText(undefined)).toBe('—'); expect(TT.cpuTimeText(null)).toBe('—');
    expect(TT.cpuTimeText(15_132)).toBe('4h12m'); expect(TT.rateText(212 * 1048576)).toBe('212.0 MB/s');
    expect(TT.hintText({ hint: 'gpdb', cont: true })).toMatch(/GPDB.*지속/); expect(TT.hintText({ pidReused: true })).toMatch(/PID 재사용/);
    expect(TT.sampleNotes({ ok: true, sample: null })[0]).toMatch(/표본이 없습니다.*0 으로 그리지 않습니다/);
    expect(TT.sampleNotes({ ok: true, sample: { ts: 1, src: 'proc', same: true, baseTs: 0, ioPerm: 2 } }).join(' ')).toMatch(/top 없음.*같아.*CAP_SYS_PTRACE/);
    // 반증 F3: 기준 표본 행을 못 읽음 — ‘없다’ 가 아니라 ‘못 읽었다’ 로(같아 문구 · 권한 문구를 덧붙이지 않는다)
    const bm = TT.sampleNotes({ ok: true, reason: 'base-missing', sample: { ts: 1, src: 'top', same: true, baseTs: 0 } }).join(' ');
    expect(bm).toMatch(/읽지 못했습니다.*기준 표본의 행이 없습니다.*‘없다’ 는 뜻이 아닙니다/); expect(bm).not.toMatch(/같아\(/); expect(bm).not.toMatch(/`/);
    expect(TT.footText({ sample: { cpuTotal: 10, nproc: 5, nrun: 1, nd: 0 }, rows: { cpu: [{ val: 12 }] } })).toMatch(/나머지 합계 CPU 0%/);
    expect(TT.footText({ sample: { cpuTotal: null }, rows: { cpu: [] } })).toMatch(/나머지 합계 CPU —/);
    const fb = TT.footText({ reason: 'base-missing', sample: { cpuTotal: 97.2, nproc: 382 }, rows: { cpu: [] } });
    expect(fb).toMatch(/전 프로세스 합 CPU 97.2%\(상위 행을 못 읽어 나머지는 모름\)/); expect(fb).not.toMatch(/나머지 합계/);
  });
  it('③ 띠 그리기 — 서버 값만 · 기타 상위 · 빈 띠', () => {
    const band = { res: '5m', from: 0, to: 600_000, comms: ['postgres', 'kswapd0'], points: [{ t: 0, by: { postgres: 60, kswapd0: 4 }, other: 3 }, { t: 300_000, by: { postgres: 120 }, other: 0 }] };
    const lay = TT.bandLayout(band);
    expect(lay.yMax).toBe(120); expect(lay.bars[0].segs.map((s) => s.c)).toEqual(['postgres', 'kswapd0', '기타 상위']);
    expect(TT.bandLayout({ points: [] }).bars).toEqual([]);
    const html = renderToStaticMarkup(h(TopBand, { band }));
    expect(html).toContain('postgres'); expect(html).toContain('기타 상위');
    expect(TT.bandNotes({ ok: true, res: '1h', points: [], approx: 0 }).join(' ')).toMatch(/하한.*표본이 없습니다/);
    expect(TT.bandNotes({ ok: true, res: '5m', points: [{ t: 1, by: {} }], baseMissing: 2 }).join(' ')).toMatch(/읽지 못한 표본 2개는 빼고.*0 이 아닙니다/);
  });
});

describe('㉑ 저활용 문구 · 그리기', () => {
  it('① 상태 · 제외 · 지표 · 검토 문구 = 서버 열거', () => {
    expect(Object.keys(IT.STATUS_TEXT).sort()).toEqual([...IDLE_STATUS].sort());
    expect(Object.keys(IT.EXCLUDE_TEXT).sort()).toEqual([...IDLE_EXCLUDE].sort());
    expect(Object.keys(IT.METRIC_TEXT).sort()).toEqual([...IDLE_METRICS].sort());
    expect([...IT.REVIEW_OPTIONS].sort()).toEqual([...IDLE_REVIEW].sort());
  });
  it('② 값 없음 · 모름 · 데이터 부족 · 지난 30일 모름', () => {
    expect(IT.actText({ ssh: null, focus: 0 })).toBe('—');
    expect(IT.actText({ ssh: 0, focus: 0, snap: 0 })).toBe('흔적 없음');
    expect(IT.powerText({ powerAvgW: null })).toBe('—');
    expect(IT.statusText({ status: 'excluded', reason: 'insufficient', days: 4 })).toBe('제외 · 데이터 부족(4일)');
    expect(IT.statusText({ status: 'periodic', periodic: { highDays: 4, sameWeekday: true } })).toMatch(/주기 사용\(높은 날 4일 · 같은 요일\)/);
    expect(IT.monthText({ month: null }).value).toBe('—');
    expect(IT.candPowerText({ candPowerMeasured: 0, candPowerUnmeasured: 3 }).value).toBe('—');
    expect(IT.candPowerText({ candPowerW: 4100, candPowerMeasured: 20, candPowerUnmeasured: 3 }).value).toBe('4.1 kW');
    expect(IT.droppedText({ dropped: ['power', 'act'] })).toBe('뺀 지표: 전력 · 활동 흔적');
  });
  it('③ 그리기(SSR) — 서버 값만 · 대기 · DR 제외 · 출처 표지', () => {
    const resp = { ok: true, rows: [
      { key: 'K1', name: 'bm-kr1-old17', vcenterId: 'KR', status: 'candidate', score: 92, metrics: { cpuAvg: 1.2, cpuMax: 6, memAvg: 9, diskMax: 0.4, netMax: 0.1, powerAvgW: 148, ssh: 0, focus: 0, snap: 0 }, review: { status: 'retire', by: 'kim' } },
      { key: 'K2', name: 'bm-kr1-dr02', vcenterId: 'KR', status: 'excluded', reason: 'dr', scoredStatus: 'candidate', score: 88, metrics: {} },
      { key: 'K3', name: 'bm-kr1-new03', vcenterId: 'KR', status: 'excluded', reason: 'insufficient', days: 4, score: null, metrics: {}, dropped: ['power'] },
    ], summary: { candidate: 1, watch: 0, active: 0, periodic: 0, excluded: 2, excludedBy: { insufficient: 1, dr: 1, maint: 0, 'no-score': 0 }, candPowerW: 148, candPowerMeasured: 1, candPowerUnmeasured: 0, review: { review: 0, retire: 1, keep: 0 }, reviewed: 1, month: null },
    sources: [{ node: 'edge-old', via: 'edge', old: true }], cfg: { windowDays: 30, candidate: 70, watch: 40, minDays: 21, cpuAvgPct: 5, cpuMaxPct: 20, memAvgPct: 20, diskBusyMaxPct: 5, netMaxPct: 2, powerIdlePct: 110, wCpu: 30 }, minEdgeVersion: '2.947.0' };
    const html = renderToStaticMarkup(h(IdleFleetView, { resp, canWrite: true }));
    expect(html).toContain('bm-kr1-old17'); expect(html).toContain('반납 예정'); expect(html).toContain('대기 · DR(검토 상태)');
    expect(html).toContain('데이터 부족(4일)'); expect(html).toContain('엣지가 구버전'); expect(html).toContain('2.947.0');
    expect(html).toMatch(/저활용 ≠ 불필요/); expect(html).not.toMatch(/\*\*/);
    expect(html).toContain('뺀 지표: 전력');
  });
});

describe('㉒ 전력 · 온도 문구 · 그리기', () => {
  it('① 미측정 사유 = 서버 열거 · 값 없음은 —', () => {
    expect(Object.keys(PT.UNMEASURED_TEXT).sort()).toEqual([...UNMEASURED].sort());
    expect(PT.kwText(null)).toBe('—'); expect(PT.cText(undefined)).toBe('—'); expect(PT.kwhText(null)).toBe('—');
    expect(PT.marginText({ unmapped: false, capKw: null })).toBe('상한 미설정'); expect(PT.marginText({ unmapped: true })).toBe('—');
    // 반증 F6: 미측정이 있는 랙은 여유를 판정하지 않는다 — 측정 수만
    expect(PT.marginText({ capKw: 5, marginPct: null, marginPartial: true, measured: 1, servers: 4 })).toBe('일부만 측정(1/4)');
    expect(PT.marginText({ capKw: 5, marginPct: -4, marginPartial: false })).toBe('상한 초과 4%');
    const mc = PT.powerCards({ minMargin: null, partialRacks: 2, capSet: 0, capHit: 0 }).find((c) => c.k === 'margin');
    expect(mc.value).toBe('—'); expect(mc.sub).toMatch(/다 측정된 상한 랙이 없습니다.*일부만 측정된 랙 2개는 판정하지 않음/);
    expect(PT.fanText({ fanRead: false })).toBe('못 읽음');
    expect(PT.capText({ capW: 400, capHit: true, capPct: 103 })).toBe('걸림(400 W · 103%)');
    expect(PT.unmeasuredText({ zero: 2, 'no-idrac': 1 })).toBe('iDRAC 없음 1 · 0 W 보고 2');
    expect(PT.kwhText(26_100)).toBe('26.1 MWh');
  });
  it('② 추이 좌표 — 부분 시간은 선에서 빼고 따로', () => {
    const p = PT.trendPath([{ t: 0, kw: 1 }, { t: 3_600_000, kw: 2, partial: true }, { t: 7_200_000, kw: 1.5 }]);
    expect(p.line.split('L').length).toBe(2); expect(p.partial.length).toBe(1); expect(p.max).toBe(2);
    expect(PT.trendPath([]).line).toBe('');
  });
  it('③ 그리기(SSR) — 서버 값만 · 미매핑 · 미측정 사유 · 정직 문구', () => {
    const resp = { ok: true, fleet: { measured: 962, unmeasuredN: 38, unmeasured: { 'no-idrac': 21, 'read-fail': 17, zero: 0 }, nowKw: 187.4, kwh24: 4420, kwhMonth: 26_100, peak24Kw: 203.9, peak24At: 0, racks: 24, unmappedServers: 61, minMargin: { rack: 'A-07', vcenterId: 'KR', pct: 4 }, capSet: 212, capHit: 3, hotCount: 9, fanWarn: 2, fanUnread: 1, trend: [] },
      corps: [{ vcenterId: 'KR', servers: 1000, nowKw: 187.4, unmeasuredN: 38, unmeasured: { 'no-idrac': 21, 'read-fail': 17 }, inletAvg: 23, inletMax: 31.2, fanWarn: 2 }],
      racks: [{ vcenterId: 'KR', rack: 'A-07', servers: 42, nowKw: 9.6, capKw: 10.2, marginPct: 4, low: true }, { vcenterId: 'KR', rack: '', unmapped: true, servers: 61, nowKw: 11.8, capKw: null }],
      bins: [{ lo: 27, hi: 29, n: 5 }], hot: [{ key: 'K', name: 'bm-kr1-gp06', vcenterId: 'KR', rack: 'A-07', u: 38, inletC: 31.2, maxC: 78, w: 412, capW: 400, capHit: true, capPct: 103, fanRead: true }], capHit: [], cfg: { inletWarnC: 27, capHitPct: 98 }, racksConfigured: 24 };
    const html = renderToStaticMarkup(h(PowerFleetView, { resp }));
    expect(html).toContain('187.4 kW'); expect(html).toContain('미매핑'); expect(html).toContain('읽기 실패 17'); expect(html).toContain('걸림(400 W · 103%)');
    expect(html).toMatch(/같은 함수로 지금 값을 읽습니다/); expect(html).not.toMatch(/\*\*/);
  });
});

describe('수집 건강 저장 줄 — Top-N 가족(보존 조정 근거)', () => {
  it('top + toph 개수 · 크기 · 구버전(가족 없음)은 칸 없음', () => {
    const fam = { raw: { files: 1, bytes: 1 }, h1: { files: 1, bytes: 1 }, d1: { files: 1 }, dev: { files: 0 }, dev1h: { files: 0 }, top: { files: 7, bytes: 2 * 1024 ** 3 }, toph: { files: 3, bytes: 0 } };
    expect(famLine({ mainBytes: 1, families: fam })).toMatch(/프로세스 Top-N 10개 2GB/);
    const { top: _t, toph: _h, ...old } = fam;
    expect(famLine({ mainBytes: 1, families: old })).not.toMatch(/Top-N/);
  });
});

describe('웹은 다시 판정 · 합산하지 않고 폴링하지 않는다(소스 스윕)', () => {
  it('새 화면 파일', () => {
    for (const f of ['BmTopProc.jsx', 'BmIdleFleet.jsx', 'BmPowerFleet.jsx', 'bmTopText.js', 'bmIdleText.js', 'bmPowerText.js']) {
      const s = fs.readFileSync(path.join(HERE, f), 'utf8');
      expect(s).not.toMatch(/setInterval\(/);
      expect(s).not.toMatch(/scoreIdle|gradeBelow|aggregatePower|sameAsBase|procHint\(/);
    }
    const p = fs.readFileSync(path.join(HERE, 'BmPowerFleet.jsx'), 'utf8');
    expect(p).not.toMatch(/\.reduce\(/, '전력 화면은 합을 다시 내지 않는다');
  });
});

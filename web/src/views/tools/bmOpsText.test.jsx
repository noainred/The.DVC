/**
 * v2.923(리눅스 성능 4단계) — 튜닝 · 용도 · 장애 기록 · 진단 스냅샷 탭과 함대 보기의 문구 · 그리기 회귀.
 * ⚠ 판정은 서버(tuning/judge · profiles/match · partfault/incidents · snapshot/command) — 여기서는 ① 웹 문구 표가 서버 code 열거와 1:1 인지
 *   ② 서버 함수가 만든 실제 응답을 그대로 그리는지(SSR) ③ 웹이 다시 판정하지 않는지(소스 스윕) ④ 자동 적용 버튼이 없는지 ⑤ ‘확인 불가’ ≠ ‘권고’ 를 고정한다.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as T from './bmOpsText.js';
import { TuningView, Grade, GradeLegend } from './BmTuningTab.jsx';
import { ProfileView } from './BmProfileTab.jsx';
import { FaultsView, IncidentTable } from './BmFaultsTab.jsx';
import BmSnapshotTab, { SnapshotResult, SnapshotListTable } from './BmSnapshotTab.jsx';
import { setCurrentUser } from '../../api.js';
import { PurposeFleetView, FaultsFleetView } from './BmOpsFleet.jsx';
import { TUNING_STATUS, TUNING_REASON, ROLES } from '../../../../server/src/bmusage/tuning/catalog.js';
import { GRADES } from '../../../../server/src/bmusage/tuning/sources.js';
import { CHECK_STATUS, CHECK_REASON, PROFILE_STATUS, APP_IDS, PLANNED_PROFILES } from '../../../../server/src/bmusage/profiles/index.js';
import { SNAPSHOT_CODES, SNAPSHOT_STATES, parseSnapshot } from '../../../../server/src/bmusage/snapshot/command.js';
import { tuningViewFor, profileViewFor, fleetProfileView, faultKpis, incidentRow } from '../../../../server/src/bmusage/opsView.js';
import { buildIncidents, INCIDENT_END } from '../../../../server/src/partfault/incidents.js';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const H = 3_600_000; const D = 24 * H;
const NOW = Math.floor(Date.now() / H) * H - 30 * 60_000;
const h = React.createElement;

const TU = {
  v: 1, at: NOW, os: { id: 'rocky', versionId: '9.4', pageSize: 4096, selinux: 'enforcing', removeIpc: null },
  sysctl: { 'vm.swappiness': '60', 'thp.enabled': 'always', 'tuned.active_profile': 'throughput-performance', 'kernel.numa_balancing': '1', 'vm.min_free_kbytes': '262144' },
  blkq: [{ name: 'nvme0n1', scheduler: 'none', rotational: false, nrRequests: 1023, readAheadKb: 128 }], irq: { irqbalance: 'active', nicIrqs: 16, spreadMin: 6, spreadMax: 8, cpus: 32 },
  units: { list: ['chronyd.service', 'airflow-scheduler.service'], failed: 0, capped: false }, ports: { list: [22, 8974], capped: false }, procs: { list: ['airflow'], capped: false },
  accounts: ['airflow'], kargs: {}, softnet: { cpus: 32, squeezed: 0 }, netq: [{ name: 'eno1', txqlen: 1000, rxq: 8, txq: 8 }], xfs: [], memTotalKb: 268435456, cores: 32,
  sections: { sysctl: 'ok', blkq: 'ok', irq: 'ok', osrel: 'ok', units: 'ok', ports: 'ok', procs: 'ok', acct: 'ok', kargs: 'absent', softnet: 'ok', netq: 'ok', xfs: 'absent' },
};

describe('웹 문구 표 = 서버 code 열거(1:1)', () => {
  it('튜닝 상태 · 사유 · 등급 · 역할', () => {
    expect(Object.keys(T.TUNING_STATUS_TEXT).sort()).toEqual([...TUNING_STATUS].sort());
    expect(Object.keys(T.TUNING_REASON_TEXT).sort()).toEqual([...TUNING_REASON].sort());
    expect(Object.keys(T.GRADE_TEXT).sort()).toEqual([...GRADES].sort());
    expect(Object.keys(T.ROLE_LABEL).sort()).toEqual([...ROLES].sort());
  });
  it('점검 상태 · 사유 · 프로파일 상태 · 기능 · 예정', () => {
    expect(Object.keys(T.CHECK_STATUS_TEXT).sort()).toEqual([...CHECK_STATUS].sort());
    for (const r of CHECK_REASON) expect(T.CHECK_REASON_TEXT[r], r).toBeTruthy();
    expect(Object.keys(T.PROFILE_STATUS_TEXT).sort()).toEqual([...PROFILE_STATUS].sort());
    expect(Object.keys(T.APP_LABEL).filter((k) => k !== 'none').sort()).toEqual([...APP_IDS].sort());
    expect(Object.keys(T.PLANNED_LABEL).sort()).toEqual(PLANNED_PROFILES.map((p) => p.id).sort());
  });
  it('스냅샷 code · 칸 상태 · 부품 장애 종료 사유(기존 partFaultText 재사용)', () => {
    expect(Object.keys(T.SNAP_CODE_TEXT).sort()).toEqual([...SNAPSHOT_CODES].sort());
    expect(Object.keys(T.SNAP_STATE_TEXT).sort()).toEqual([...SNAPSHOT_STATES].sort());
    expect(Object.values(INCIDENT_END).length).toBeGreaterThan(0);
  });
});

describe('문구 함수', () => {
  it('누가 정했나 · 등급 기호 · 요약 조각 · 장치 목록', () => {
    expect(T.byText('role:db')).toBe('역할 DB');
    expect(T.byText('profile:gpdb')).toBe('용도 gpdb');
    expect(T.byText('override:corp')).toBe('관리자 설정(법인)');
    expect(T.byText('none')).toBe('—');
    expect(T.gradeTokens('● / ◐')).toEqual(['●', '◐']);
    expect(T.tuningSummaryParts({ advise: 2, unknown: 5 }).map((p) => `${p.label}${p.count}`)).toEqual(['권고2', '적합0', '참고0', '확인 불가5']);
    expect(T.devicesText([{ name: 'sda', value: 'bfq', status: 'advise' }, { name: 'nvme0n1', value: 'none', status: 'ok' }])).toBe('sda bfq(권고) · nvme0n1 none');
  });
  it('‘확인 불가’ 는 ‘권고’ 가 아니다 — 낱말 · 톤 · 정렬이 다르다', () => {
    const a = T.tuningStatusView({ status: 'advise' }); const u = T.tuningStatusView({ status: 'unknown', reason: 'notRead' });
    expect(a.label).toBe('권고'); expect(u.label).toBe('확인 불가');
    expect(a.tone).not.toBe(u.tone);
    expect(u.reason).toContain('받지 못했습니다');
  });
  it('bps · KB 단위 — 값이 없으면 ‘—’(0 이 아니다)', () => {
    expect(T.bpsText(null)).toBe('—'); expect(T.bpsText(0)).toBe('0 B/s'); expect(T.bpsText(2_000_000)).toBe('2.0 MB/s');
    expect(T.kbText(undefined)).toBe('—'); expect(T.kbText(2048)).toBe('2MB');
  });
  it('권한 부족 상태 — /proc/pid/io perm · partial · dmesg perm 일 때만', () => {
    expect(T.snapPermState({ states: { io: 'ok', dmesg: 'ok' } })).toBe(false);
    expect(T.snapPermState({ states: { io: 'partial' } })).toBe(true);
    expect(T.snapPermState({ states: { io: 'ok', dmesg: 'perm' } })).toBe(true);
  });
});

describe('서버 함수가 만든 응답을 그대로 그린다(SSR)', () => {
  it('튜닝 탭 — 분류 카드 5 · 항목 26 · 근거 등급 · 출처 링크 · 자동 적용 버튼 없음 · 확인 불가 문구', () => {
    const resp = { ok: true, key: 'K', via: 'local', ...tuningViewFor({ tuning: TU, detail: { nics: [{ dropDelta: 0 }] }, manual: { role: 'db' } }) };
    const html = renderToStaticMarkup(h(TuningView, { resp }));
    for (const c of resp.categories) expect(html).toContain(c.title);
    expect((html.match(/<tr>/g) || []).length).toBeGreaterThanOrEqual(26 + 11);
    expect(html).toContain('href="https://docs.rockylinux.org/guides/virtualization/kvm_tuning/"');
    expect(html).toContain('확인 불가');
    expect(html).toContain('역할 DB');
    expect(html).not.toMatch(/<button[^>]*>[^<]*(적용|Apply|apply)/);
    expect(html).not.toMatch(/sysctl -w|tuned-adm profile|ethtool -G/);
  });
  it('근거 등급은 기호 + 낱말(◐ 만으로는 400px 에서 읽히지 않음 — Chromium 판독)', () => {
    const html = renderToStaticMarkup(h(Grade, { grade: '●/◐(확인 불가)' }));
    expect(html).toContain('<span class="bmo-g">●</span>원문');
    expect(html).toContain('<span class="bmo-g">◐</span>발췌');
    expect(html).toContain('→ 확인 불가');
    const legend = renderToStaticMarkup(h(GradeLegend));
    for (const [g, txt] of Object.entries(T.GRADE_TEXT)) expect(legend).toContain(`<span class="bmo-g">${g}</span>${txt}`);
  });
  it('튜닝 탭 — 사실이 없는 서버는 전 항목 확인 불가 · 권고 0 · 이유 안내', () => {
    const resp = { ok: true, key: 'K', via: 'edge', agent: 'EDGE1', noFacts: true, ...tuningViewFor({ tuning: null }) };
    expect(resp.counts.advise).toBe(0);
    const html = renderToStaticMarkup(h(TuningView, { resp }));
    expect(html).toContain('권고 0');
    expect(html).toContain('엣지 <b>EDGE1</b>');
    expect(html).toContain('권고로 세지 않습니다');
  });
  it('용도 탭 — 감지 근거 · 프로파일별 점검 표 · 미수집 · 프로파일 없음 OS 안내', () => {
    const resp = { ok: true, key: 'K', via: 'local', ...profileViewFor({ tuning: TU, manual: null }) };
    const html = renderToStaticMarkup(h(ProfileView, { resp, itemKey: 'K' }));
    expect(html).toContain('rocky9-base'); expect(html).toContain('airflow');
    expect(html).toContain('미수집');
    expect(html).toContain('유닛 airflow-scheduler.service');
    const ub = { ok: true, ...profileViewFor({ tuning: { ...TU, os: { id: 'ubuntu', versionId: '22.04' } } }) };
    const html2 = renderToStaticMarkup(h(ProfileView, { resp: ub, itemKey: 'K' }));
    expect(html2).toContain('Ubuntu 22.04');
    expect(html2).toContain('<b>점검하지 않습니다</b>');
  });
  it('장애 기록 탭 — 요약 5칸 · 발생 1건=1행 · 종료 사유 문구는 partFaultText 그대로 · 시간순', () => {
    const ev = (at, event, o = {}) => ({ at, event, agent: '', partKey: `idrac:T:${o.kind || 'disk'}:${o.partId || 'D1'}`, scope: 'idrac', deviceId: 'r', deviceKey: 'T', kind: 'disk', label: 'Disk 1', state: null, prevState: null, closeReason: null, ...o });
    const { incidents } = buildIncidents({ since: NOW - 90 * D, now: NOW, events: [
      ev(NOW - 10 * D, 'open', { state: 'fault' }), ev(NOW - 8 * D, 'close', { prevState: 'fault', closeReason: 'removed' }),
      ev(NOW - 2 * D, 'open', { state: 'warn', kind: 'dimm', partId: 'A3', label: 'DIMM A3' }),
    ], openRows: [{ agent: '', partKey: 'idrac:T:dimm:A3', state: 'warn', firstSeenAt: NOW - 2 * D }] });
    const resp = { ok: true, partFaultsAccess: true, available: true, kpis: faultKpis(incidents, { since: NOW - 90 * D }), incidents: incidents.map(incidentRow), labels: { state: { fault: '이상', warn: '주의' }, kind: { disk: '디스크', dimm: '메모리(DIMM)' } }, sel: [{ severity: 'Warning', at: new Date(NOW - 3 * H).toISOString(), message: 'PSU 입력 저하 10.1.2.3' }] };
    const html = renderToStaticMarkup(h(FaultsView, { resp, days: 90 }));
    for (const k of ['열린 장애', '최근 90일 발생', '평균 지속', '교체(부품 제거)', '종료 기록 없음']) expect(html).toContain(k);
    expect(html).toContain('부품 제거');
    expect(html).toContain('진행 중 — 주의');
    expect(html).toContain('SEL/LC');
    const denied = renderToStaticMarkup(h(FaultsView, { resp: { ok: true, partFaultsAccess: false, reason: '차단' }, days: 90 }));
    expect(denied).toContain('권한 없음'); expect(denied).not.toContain('<table');
  });
  it('스냅샷 결과 — 권한 부족(④ 상태) · I/O 확인 불가는 0 이 아님 · dmesg 권한 · iDRAC 경로 없음', () => {
    const out = ['##PSCPU', ' 10 root 5.0 1000 nginx', '##PSMEM', ' 10 root 5.0 1000 nginx', '##PIDS', '200', '##IO', 'readable=0', 'span=2', '##SS', 'TCP:   10 (estab 5, closed 1, orphaned 0, timewait 4)', '##DMESG', 'd:dmesg: read kernel buffer failed: Operation not permitted', '##END'].join('\n');
    const snap = { ok: true, code: 'ok', at: NOW, ms: 2300, used: 1, max: 20, stored: true, result: { ...parseSnapshot(out), idrac: null } };
    const html = renderToStaticMarkup(h(SnapshotResult, { snap }));
    expect(html).toContain('일부를 권한 때문에 읽지 못했습니다');
    expect(html).toContain('확인 불가 — 권한 부족(0 이 아닙니다)');
    expect(html).toContain('sudo 를 시도하지 않았습니다');
    expect(html).toContain('iDRAC 경로 없음');
    expect(html).toContain('이 법인 24시간 1/20회');
    const capped = renderToStaticMarkup(h(SnapshotResult, { snap: { ok: false, code: 'daily-cap', reason: '상한 20회' } }));
    expect(capped).toContain('24시간 스냅샷 상한');
  });
  it('스냅샷 탭 — viewer 에게는 실행 칸 대신 안내(서버도 403) · operator 에게는 사유 칸 + 실행 버튼(사유 없으면 잠금)', () => {
    setCurrentUser({ username: 'v', role: 'viewer' });
    const v = renderToStaticMarkup(h(BmSnapshotTab, { itemKey: 'K' }));
    expect(v).toContain('실행은 운영자(operator) 이상만'); expect(v).not.toContain('진단 스냅샷 실행</button>');
    setCurrentUser({ username: 'o', role: 'operator' });
    const o = renderToStaticMarkup(h(BmSnapshotTab, { itemKey: 'K' }));
    expect(o).toMatch(/<button[^>]*disabled=""[^>]*>진단 스냅샷 실행<\/button>/);
    expect(o).toContain('사유(필수');
    setCurrentUser(null);
  });
  it('장애 함대 표 — 서버 · 법인 머리도 정렬 대상(칸을 배열로 — Fragment 면 STable 이 칸을 못 센다)', () => {
    const row = { key: 'K', server: 'srv-a', vcenterId: 'vc-a', id: 'i1', kind: 'disk', label: 'Disk 1', openedAt: NOW - D, closedAt: null, ongoing: true, durationMs: D, state: 'warn', endReason: null, events: [] };
    const html = renderToStaticMarkup(h(IncidentTable, { rows: [row], labels: {}, withServer: true }));
    const ths = html.match(/<th(?:\s[^>]*)?>/g) || [];
    expect(ths.length).toBe(11);
    expect(ths.every((x) => x.includes('aria-sort="none"'))).toBe(true);
    expect(html).toMatch(/<th[^>]*aria-sort="none"[^>]*>서버/);
    expect(html).toMatch(/<th[^>]*aria-sort="none"[^>]*>법인/);
  });
  it('함대 — 매트릭스(OS × 기능 · 프로파일 없음) · 장애 함대 표(법인 · 종류 · 상태 필터 자리)', () => {
    const fleet = fleetProfileView([{ key: 'A', name: 'a', vcenterId: 'vc', tuning: TU }, { key: 'B', name: 'b', vcenterId: 'vc', tuning: { ...TU, os: { id: 'ubuntu', versionId: '22.04' } } }]);
    const html = renderToStaticMarkup(h(PurposeFleetView, { resp: { ok: true, ...fleet } }));
    expect(html).toContain('Rocky 9.4'); expect(html).toContain('Ubuntu 22.04'); expect(html).toContain('OS 프로파일 없음');
    expect(html).toContain('예정(만들지 않음): Ubuntu · Windows Server · Hadoop');
    const fh = renderToStaticMarkup(h(FaultsFleetView, { resp: { ok: true, partFaultsAccess: true, available: true, incidents: [], kpis: faultKpis([]) }, days: 90 }));
    expect(fh).toContain('법인 전체'); expect(fh).toContain('진행 중만');
  });
});

describe('소스 스윕 — 웹이 다시 판정하지 않는다 · 적용 경로 없음 · 백틱 문구 없음', () => {
  const files = ['BmTuningTab.jsx', 'BmProfileTab.jsx', 'BmFaultsTab.jsx', 'BmSnapshotTab.jsx', 'BmOpsFleet.jsx', 'bmOpsText.js'];
  const src = Object.fromEntries(files.map((f) => [f, fs.readFileSync(path.join(HERE, f), 'utf8')]));
  it('권장값 · 상태를 웹에서 계산하지 않는다(권장값 · 현재값 비교 · 서버 판정 함수 import 없음)', () => {
    for (const [f, s] of Object.entries(src)) {
      expect(s, f).not.toMatch(/\.current\s*[=!<>]==?\s*[\w'"]+\.rec\b/);
      expect(s, f).not.toMatch(/judgeTuning|evalRule|profileView\(|detectProfiles/);
      expect(s, f).not.toMatch(/swappiness\s*[<>=]/);
    }
  });
  it('쓰기 요청은 용도 태그(PUT purpose)와 스냅샷 실행(POST snapshot)뿐 — 튜닝 적용 요청이 없다', () => {
    const writes = Object.entries(src).flatMap(([f, s]) => [...s.matchAll(/(putJson|postJson|sendJson|patchJson)\(\s*[`'"]([^`'"]+)/g)].map((m) => `${f}:${m[1]}:${m[2]}`));
    expect(writes.sort()).toEqual(['BmProfileTab.jsx:putJson:/tools/bm-usage/purpose', 'BmSnapshotTab.jsx:postJson:/tools/bm-usage/perf/${encodeURIComponent(itemKey)}/snapshot'].sort());
  });
  it('문구 모듈에 백틱 인용 없음(BoldText 는 **강조** 만)', () => {
    const strings = [];
    const walk = (v) => { if (typeof v === 'string') strings.push(v); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
    walk([T.TUNING_REASON_TEXT, T.CHECK_REASON_TEXT, T.SNAP_CODE_TEXT, T.SNAP_STATE_TEXT, T.TUNING_HONEST, T.PROFILE_HONEST, T.FAULT_RULES_NOTE, T.SNAP_NOTE]);
    for (const s of strings) expect(s).not.toContain('`');
  });
});

describe('4단계 반증 반영(W1~W5 · R4 · R5) — 화면', () => {
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const tab = strip(fs.readFileSync(path.join(import.meta.dirname, 'BmSnapshotTab.jsx'), 'utf8'));
  it('W1 — 새 실행은 보관분 보기 상태를 비우고 시작한다(새 결과가 보인다) · W2 — 보기 응답은 세대가 맞을 때만 반영', () => {
    const doRun = tab.slice(tab.indexOf('const doRun'), tab.indexOf('const open'));
    expect(doRun.indexOf("setSel({ id: '', resp: null, err: null })")).toBeGreaterThan(-1);
    expect(doRun.indexOf("setSel({ id: '', resp: null, err: null })")).toBeLessThan(doRun.indexOf('postJson('));
    expect(doRun).toMatch(/selGen\.current \+= 1/);
    const open = tab.slice(tab.indexOf('const open'), tab.indexOf('const snaps'));
    expect(open).toMatch(/const gen = \+\+selGen\.current/);
    expect((open.match(/if \(gen === selGen\.current\) setSel/g) || []).length).toBe(2);
  });
  it('W3 — 보관분 표 결과 칸은 code 원문이 아니라 짧은 낱말(모든 code 에 낱말 · 모르는 code 는 ‘알 수 없음’)', () => {
    for (const c of SNAPSHOT_CODES) expect(T.SNAP_CODE_TEXT[c].short, c).toBeTruthy();
    const html = renderToStaticMarkup(h(SnapshotListTable, { snaps: [{ id: 'a', at: NOW, code: 'daily-cap', ok: false, reason: 'r', ms: 1000 }, { id: 'b', at: NOW, code: 'weird', ok: false, reason: 'r2', ms: null }] }));
    expect(html).toContain('하루 상한'); expect(html).not.toContain('>daily-cap<');
    expect(html).toContain('알 수 없음'); expect(html).not.toContain('>weird<');
  });
  it('W4 — 실행 칸: operator 미만은 역할 안내 · 쓰기 범위 밖(writable:false)은 조회 전용 안내 · 응답 전(writable 없음)은 잠그지 않는다(서버가 403) · 용도 태그 칸도 같은 판정', () => {
    expect(T.snapRunGate({ roleOk: false, writable: true })).toBe('role');
    expect(T.snapRunGate({ roleOk: true, writable: false })).toBe('scope');
    expect(T.snapRunGate({ roleOk: true, writable: true })).toBe('ok');
    expect(T.snapRunGate({ roleOk: true })).toBe('ok');
    expect(tab).toMatch(/snapRunGate\(\{ roleOk: hasRole\('admin', 'operator'\), writable: list\.resp\?\.writable \}\)/);
    const resp = { ok: true, key: 'K', via: 'local', ...profileViewFor({ tuning: TU, manual: null }), writable: false, canTag: false };
    const html = renderToStaticMarkup(h(ProfileView, { resp, itemKey: 'K', canTag: false, showReadOnly: true }));
    expect(html).toContain('쓰기 권한이 없어 수동 태그를 바꿀 수 없습니다');
    expect(html).not.toContain('태그 지우기');
  });
  it('W5 — 시간순 닫힘 문구는 서버가 실은 종료 사유 code(endReason)로만 고른다(웹이 closeReason 을 다시 매핑하지 않는다)', () => {
    const tl = T.faultTimeline([{ label: 'Disk 1', events: [{ at: 2, event: 'close', closeReason: 'key-migrated', endReason: 'migrated' }, { at: 1, event: 'close', closeReason: 'removed', endReason: 'removed' }, { at: 0, event: 'close', closeReason: 'x', endReason: null }] }]);
    expect(tl.map((x) => x.text)).toEqual(['Disk 1 — 닫힘 · 식별 키 변경', 'Disk 1 — 닫힘 · 부품 제거', 'Disk 1 — 닫힘 · 종료 기록 없음']);
    const src2 = strip(fs.readFileSync(path.join(import.meta.dirname, 'bmOpsText.js'), 'utf8'));
    expect(src2).not.toMatch(/closeReason\s*===/);
    // 서버 incidentRow 가 실은 값과 대조(같은 입력 — 판정은 서버 한 곳).
    const row = incidentRow({ id: 'x', label: 'Disk 1', events: [{ at: 1, event: 'close', closeReason: 'key-migrated' }] });
    expect(T.faultTimeline([row])[0].text).toBe('Disk 1 — 닫힘 · 식별 키 변경');
  });
  it('R4 · R5 — 보관 상한으로 덜어 낸 칸을 밝힌다 · dmesg 자체 오류(권한 아님)는 받지 못함 문구', () => {
    expect(T.snapTrimNote({ trimmed: ['dmesg'], dmesgDropped: 37 })).toContain('커널 로그(오래된 37줄)');
    expect(T.snapTrimNote({})).toBe('');
    const out = ['##PSCPU', ' 10 root 5.0 1000 nginx', '##PSMEM', ' 10 root 5.0 1000 nginx', '##PIDS', '1', '##IO', 'readable=1', 'span=2', '##SS', 'TCP:   1 (estab 1, closed 0, orphaned 0, timewait 0)', '##DMESG', "d:dmesg: unrecognized option '--level'", '##END'].join('\n');
    const snap = { ok: true, code: 'ok', at: NOW, result: { ...parseSnapshot(out), idrac: null, trimmed: ['dmesg'], dmesgDropped: 3 } };
    const html = renderToStaticMarkup(h(SnapshotResult, { snap }));
    expect(html).toContain(T.SNAP_STATE_TEXT.missing); expect(html).toContain('오래된 3줄');
    expect(html).not.toContain('권한 부족 — dmesg');
  });
  it('실패한 실행 · 보관분 — OS 칸을 빈 칸으로 그리지 않는다(결과가 { error } 뿐) · 보관분의 reason 은 ‘실행 사유’ 로(서버 사유와 섞지 않는다)', () => {
    const fail = renderToStaticMarkup(h(SnapshotResult, { snap: { ok: false, code: 'auth', userReason: '새벽 백업 창 확인', result: { error: 'All configured authentication methods failed', idrac: null } } }));
    expect(fail).not.toContain('CPU 상위'); expect(fail).not.toContain('프로세스 수명 평균');
    expect(fail).toContain('iDRAC 경로 없음'); expect(fail).toContain('실행 사유: 새벽 백업 창 확인');
    const tabSrc = fs.readFileSync(path.join(import.meta.dirname, 'BmSnapshotTab.jsx'), 'utf8');
    expect(tabSrc).toMatch(/userReason: sel\.resp\.snapshot\.reason \|\| '', reason: undefined/);
  });
});

// v2.606 수정 그룹 e — 웹 판정·문구(순수 모듈) + 화면 소스 검사(JSX 는 node 환경에서 렌더할 수 없다).
// 서버 쪽 단언은 server/test/audit2606e.test.js.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOverviewRows, hostUsagePct, powerSum, overviewCsv } from './vcdOverview.js';
import { pduTotals, pduTotalNote, pduPowerMark } from './tools/pduTotals.js';
import { manualPollMessage } from './idrac/manualPollText.js';
import { portZoningFallback } from './tools/sanHealthText.js';
import { topologyPayload, servicesDroppedText } from './tools/relayTopoForm.js';
import { linkFormFromSettings, linkSettingsPayload } from './tools/linkCheckForm.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..');
// 주석을 지운 소스(주석 속 설명이 검사 통과 근거가 되지 않게 — v2.535 규약). 줄 주석은 '//' 앞이 공백·줄 시작일 때만.
const code = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|\s)\/\/[^\n]*/g, '$1')
  .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '');

describe('WEB2606-01 메일 진단 숫자 칸', () => {
  const s = code('views/tools/MailDiag.jsx');
  it('빈 칸은 blankOr 로 보내지 않는다(Number(\'\') 금지)', () => {
    expect(s).toMatch(/port:\s*blankOr\(smtp\.port\)/);
    expect(s).toMatch(/timeoutMs:\s*blankOr\(smtp\.timeoutMs\)/);
    expect(s).not.toMatch(/Number\(e\.target\.value\)/);
  });
  it('타임아웃 칸에 || 20000 표시 폴백이 없다(상태와 화면이 같아야 한다)', () => {
    expect(s).not.toMatch(/timeoutMs \|\| 20000/);
  });
});

describe('WEB2606-02 끊긴 호스트 사용률 표시', () => {
  it('hostUsagePct 는 끊긴·무응답 호스트면 null', () => {
    expect(hostUsagePct({ connectionState: 'DISCONNECTED', cpuUsagePct: 0 }, 'cpuUsagePct')).toBe(null);
    expect(hostUsagePct({ connectionState: 'CONNECTED', cpuUsagePct: 42 }, 'cpuUsagePct')).toBe(42);
  });
  it('Hosts·EntityDetail(호스트) 가 hostUsagePct 를 거쳐 UsageCell 에 넘긴다', () => {
    const h = code('views/Hosts.jsx');
    expect(h).toMatch(/UsageCell pct=\{hostUsagePct\(h, 'cpuUsagePct'\)\}/);
    expect(h).toMatch(/UsageCell pct=\{hostUsagePct\(h, 'memUsagePct'\)\}/);
    const e = code('components/EntityDetail.jsx');
    expect(e).toMatch(/UsageCell pct=\{hostUsagePct\(item, 'cpuUsagePct'\)\}/);
    expect(e).toMatch(/UsageCell pct=\{hostUsagePct\(item, 'memUsagePct'\)\}/);
  });
  it("UsageCell 은 null 이면 '—'(예전 'null%')", () => {
    const p = code('components/primitives.jsx');
    const body = p.slice(p.indexOf('export function UsageCell'), p.indexOf('export function StateBadge'));
    expect(body).toMatch(/numOrNull\(pct\)/);
    expect(body).toMatch(/v == null\) return/);
  });
});

describe('WEB2606-04 프록시 설정 포트 칸', () => {
  const s = code('views/ProxySettings.jsx');
  it('Number(e.target.value)·|| 22·|| 4822·|| 20000 폴백이 없다', () => {
    expect(s).not.toMatch(/Number\(e\.target\.value\)/);
    expect(s).not.toMatch(/port \|\| 22\b/);
    expect(s).not.toMatch(/port \|\| 4822/);
    expect(s).not.toMatch(/Number\(p\.publicPortBase\) \|\| 20000/);
  });
  it('저장 요청은 blankOr 로 포트를 좁힌다', () => {
    expect(s).toMatch(/putJson\('\/remote\/config', withPorts\(cfg\)\)/);
    expect(s).toMatch(/onSave\(\{ \.\.\.withPorts\(p\)/);
  });
});

describe('WEB2606-05 PDU 부분 합', () => {
  const dev = (summary) => ({ snapshot: { summary } });
  it('총 전력은 합하되 부분 합·전력 미수집 장비 수를 함께 낸다', () => {
    const t = pduTotals([dev({ units: 2, sensors: 1, powerW: 500, unitsIncomplete: true }), dev({ units: 1, sensors: 0, powerW: 300 }), dev({ units: 1, powerW: null }), { snapshot: null }]);
    expect(t.powerW).toBe(800);
    expect(t.powerPartial).toBe(1);
    expect(t.powerMissing).toBe(2);
    expect(pduTotalNote(t)).toBe('부분 합 1대 포함 · 전력 미수집 2대 제외');
    expect(pduTotalNote(pduTotals([dev({ powerW: 100 })]))).toBe('');
  });
  it('표 전력 칸 표지', () => {
    expect(pduPowerMark({ unitsIncomplete: true })?.label).toBe('부분 합');
    expect(pduPowerMark({ powerW: 1 })).toBe(null);
  });
  it('PduTool 이 pduTotals·pduPowerMark 를 쓴다', () => {
    const s = code('views/tools/PduTool.jsx');
    expect(s).toMatch(/pduTotals\(devices\)/);
    expect(s).toMatch(/pduPowerMark\(sum\)/);
    expect(s).toMatch(/sub=\{pduTotalNote\(totals\)\}/);
  });
});

describe('WEB2606-06 vCenter 개요 전력', () => {
  const hosts = [
    { name: 'h1', cluster: 'C', connectionState: 'CONNECTED', powerWatts: 400 },
    { name: 'h2', cluster: 'C', connectionState: 'CONNECTED', powerWatts: null },
  ];
  it("전력 미수집 호스트는 null('—'), 합계는 측정 대수와 함께", () => {
    const rows = buildOverviewRows({ site: { name: 'V' }, hosts });
    const h2 = rows.find((r) => r.host === 'h2');
    expect(h2.powerW).toBe(null);          // 예전 0
    const vc = rows.find((r) => r.level === 'vCenter');
    expect(vc.powerW).toBe(400);
    expect(vc.powerHosts).toBe(1);
    expect(vc.hostCount).toBe(2);
    expect(powerSum([{ powerWatts: undefined }])).toEqual({ powerW: null, powerHosts: 0 }); // 예전 0
    expect(powerSum([{ powerWatts: 0 }])).toEqual({ powerW: 0, powerHosts: 1 });            // 보고된 0 은 값이다
  });
  it('CSV 의 h2 전력 칸은 빈 값(예전 0)', () => {
    const csv = overviewCsv(buildOverviewRows({ site: { name: 'V' }, hosts }));
    const line = csv.split('\r\n').find((l) => l.includes(',h2,'));
    expect(line).toBeTruthy();
    expect(line).not.toMatch(/,0,(?:[^,]*)$/);
  });
});

describe('WEB2606-07 늦은 응답 가드', () => {
  it('GuestDiskReport reload 는 세대 ref 로 마지막 요청만 반영한다', () => {
    const s = code('views/tools/GuestDiskReport.jsx');
    expect(s).toMatch(/const gen = \+\+reqGen\.current/);
    expect(s).toMatch(/if \(gen !== reqGen\.current\) return;/);
  });
  it('DsTrendModal 효과는 cleanup 에서 active=false', () => {
    const s = code('views/tools/DsTrendModal.jsx');
    expect(s).toMatch(/let active = true/);
    expect(s).toMatch(/if \(active\) \{ setData\(d\)/);
    expect(s).toMatch(/return \(\) => \{ active = false; \}/);
  });
});

describe('WEB2606-08 수동 1회 수집 부분 전력', () => {
  it('powerPartial > 0 이면 문구에 개수를 붙이고 amber', () => {
    const m = manualPollMessage({ lastRun: { ok: 3, failed: 0, powerPartial: 2 } });
    expect(m.tone).toBe('amber');                 // 예전 green
    expect(m.text).toMatch(/부분 전력\(적재 안 함\) 2/);
    expect(manualPollMessage({ lastRun: { ok: 3, failed: 0 } }).tone).toBe('green');
    expect(manualPollMessage({ lastRun: { ok: 3, failed: 1, powerPartial: 1 } }).tone).toBe('red');
  });
});

describe('WEB2606-10 중계 토폴로지·통신 점검 빈 칸', () => {
  it('topologyPayload 는 빈 포트 칸을 보내지 않는다', () => {
    const p = topologyPayload({ main: { portalPort: '', ssh: { port: '' } }, services: [{ key: 'a', listenPort: '', targetPort: '22' }], sites: [{ dc: 'D', edge: { ssh: { port: '' } }, irs: { ssh: { port: '2222' } } }] });
    expect(p.main.portalPort).toBe(undefined);
    expect(p.main.ssh.port).toBe(undefined);
    expect(p.services[0].listenPort).toBe(undefined);
    expect(p.services[0].targetPort).toBe(22);
    expect(p.sites[0].edge.ssh.port).toBe(undefined);
    expect(p.sites[0].irs.ssh.port).toBe(2222);
  });
  it('servicesDroppedText 는 버린 행을 말한다', () => {
    expect(servicesDroppedText({ servicesDropped: [{ key: 'portal', label: '포탈', reason: 'listen-port' }] })).toMatch(/저장하지 않은 서비스 1개: 포탈\(수신 포트/);
    expect(servicesDroppedText({ servicesDropped: [] })).toBe('');
    expect(servicesDroppedText({ servicesDropped: [{ key: 'x', reason: 'key' }], servicesReset: true })).toMatch(/기본 서비스 목록/);
  });
  it('RelayTopoTool 이 topologyPayload 를 보내고 Number(e.target.value) 를 쓰지 않는다', () => {
    const s = code('views/tools/RelayTopoTool.jsx');
    expect(s).toMatch(/putJson\('\/tools\/relaytopo', topologyPayload\(form\)\)/);
    expect(s).toMatch(/servicesDroppedText\(r\)/);
    expect(s).not.toMatch(/Number\(e\.target\.value\)/);
    expect(s).not.toMatch(/portalPort \|\| 4000/);
  });
  it('통신 점검 폼: 빈 칸은 이전 값(보내지 않음), 칸이 기본값으로 되채워지지 않는다', () => {
    const f = linkFormFromSettings({ intervalMs: 300_000, concurrency: 6, sampleRetentionDays: 365, eventRetentionDays: 30, enabled: true });
    expect(f.intervalMin).toBe('5');
    expect(f.sampleRetentionDays).toBe('365');
    const body = linkSettingsPayload({ ...f, sampleRetentionDays: '', intervalMin: '' });
    expect(body.sampleRetentionDays).toBe(undefined);   // 예전 90 으로 저장
    expect(body.intervalMs).toBe(undefined);            // 예전 1분
    expect(JSON.parse(JSON.stringify(body)).sampleRetentionDays).toBe(undefined);
    expect(linkSettingsPayload({ ...f, intervalMin: '10' }).intervalMs).toBe(600_000);
    const s = code('views/tools/LinkCheck.jsx');
    expect(s).toMatch(/linkSettingsPayload\(form\)/);
    expect(s).not.toMatch(/Number\(e\.target\.value\) \|\| (90|30|6|1)\b/);
  });
});

describe('RECENT2606-05 조닝 미수집 포트 문구', () => {
  it('zoningNote 가 있으면 상한 문구보다 먼저', () => {
    const note = '조닝 정보를 수집하지 못해 … command not found';
    expect(portZoningFallback({ verdict: 'bad' }, note, 3)).toBe(note);   // 예전: '조회 상한을 넘어'
    expect(portZoningFallback({ verdict: 'bad' }, '', 3)).toMatch(/상한/);
    expect(portZoningFallback({ verdict: 'ok' }, '', 3)).toMatch(/목록에 없어/);
  });
});

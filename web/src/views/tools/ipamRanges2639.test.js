/**
 * v2.639 — IPMS 통합 작업 그룹 W(웹 IP관리 화면) 회귀.
 *   D1 대역 정책 IP 개수(policySpecSize — ipmsRangeText.test 가 값을 고정) · D2 runNow 가 400 이면 스캔을 시작하지 않는다 ·
 *   D4/U1 vCenter 스캔 대역 편집기 한 벌(VcScanRangeEditor) · D5 IP 스캔 설정 대역 검사 · D6 스캔 상태 403 에 Loading 안 그림 ·
 *   D7 CSV 실패 문구 · U2 IpamSettings.jsx 재수출 셸 · U3 '__local__' 표시 한 벌 · U7 시각·소요 포매터 한 벌 · I2 needsLedger ·
 *   I3 관리자 아님 잠금 · I6 표 minWidth.
 * 순수 함수는 실제로 호출하고, 효과·이벤트 안에서만 드러나는 부분은 소스를 주석 제거 후 검사한다(v2.535 규약).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../../test/_stripComments.js';
import { adminWriteGate, agentLabel, fmtDt, fmtDur, LOCAL_AGENT } from './ipamShared.jsx';
import { durationText } from './ipamScanLogText.js';
import { ipamPage } from './ipamPages.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => stripComments(fs.readFileSync(path.resolve(HERE, p), 'utf8'));

describe('U3·U7·I3 — 공용 조각(ipamShared)', () => {
  it("agentLabel: '__local__'·빈 값은 '이 포탈', 그 밖은 그대로(스캔 로그 agentText 와 같은 글자)", () => {
    expect(agentLabel(LOCAL_AGENT)).toBe('이 포탈');
    expect(agentLabel('')).toBe('이 포탈');
    expect(agentLabel(undefined)).toBe('이 포탈');
    expect(agentLabel('edge-seoul')).toBe('edge-seoul');
  });
  it('fmtDur: 1시간 미만은 스캔 로그 durationText 와 글자가 같고, 그 이상은 시간·일 단위 — 못 읽은 값은 —', () => {
    for (const ms of [0, 850, 1500, 59_999, 65_000, 3_599_000]) expect(fmtDur(ms)).toBe(durationText(ms));
    expect(fmtDur(3_600_000)).toBe('1시간 0분');
    expect(fmtDur(3 * 3_600_000 + 5 * 60_000)).toBe('3시간 5분');
    expect(fmtDur(2 * 86_400_000 + 4 * 3_600_000)).toBe('2일 4시간');
    expect(fmtDur(null)).toBe('—');
    expect(fmtDur('')).toBe('—');
    expect(fmtDur(-1)).toBe('—');
    expect(fmtDur('abc')).toBe('—');
  });
  it('fmtDt: 시각 없음은 —(0 도 없음), 있으면 날짜+시각 전체', () => {
    expect(fmtDt(null)).toBe('—');
    expect(fmtDt(0)).toBe('—');
    const s = fmtDt(Date.UTC(2026, 8, 28, 3, 4, 5));
    expect(s).not.toBe('—');
    expect(s).toMatch(/2026/);
  });
  it("adminWriteGate: 'no' 만 잠근다 — 'unknown'(모름)은 서버가 집행한다", () => {
    expect(adminWriteGate('no')).toMatchObject({ locked: true });
    expect(adminWriteGate('no').note).toMatch(/관리자/);
    expect(adminWriteGate('no').note).not.toMatch(/`/);
    expect(adminWriteGate('unknown')).toEqual({ locked: false, title: undefined, note: null });
    expect(adminWriteGate('yes').locked).toBe(false);
    expect(adminWriteGate(undefined).locked).toBe(false);
  });
});

describe('I2 — needsLedger 를 읽는 곳이 있다', () => {
  it('list·policies 만 대장을 기다린다', () => {
    expect(ipamPage('list').needsLedger).toBe(true);
    expect(ipamPage('policies').needsLedger).toBe(true);
    for (const k of ['scan', 'status', 'log', 'ipms', 'csv', 'sheet', 'netmap', 'insights']) expect(!!ipamPage(k).needsLedger, k).toBe(false);
    const core = read('./IpamCore.jsx');
    expect(core).toMatch(/ipamPage\(view\)\?\.needsLedger/);
    expect(core).not.toMatch(/const ledgerWait = data \? null/);
  });
});

describe('U1·D4 — vCenter 스캔 대역 편집기는 한 벌이다', () => {
  const net = read('./IpamNet.jsx');
  const ipms = read('./IpmsSettings.jsx');
  const editor = read('./VcScanRangeEditor.jsx');
  it('v2.691: vCenter 별 스캔 대역 편집 화면(IPMS ②·대역·스캔)은 스캔 대역·설정으로 합쳐졌다 — 두 곳 모두 그 편집기를 그리지 않는다', () => {
    expect(net).not.toMatch(/<VcScanRangeEditor/);
    expect(net).not.toMatch(/export function IpamRanges\(/);
    expect(ipms).not.toMatch(/<VcScanRangeEditor/);
    expect(ipms).toMatch(/href="#\/ipam\/scan"/); // 안내는 합쳐진 페이지로 보낸다
    expect(ipms).not.toMatch(/putJson\('\/admin\/ipam\/vc-ranges'/);
    expect(ipms).not.toMatch(/aria-label="vCenter별 스캔 대역"/);
  });
  it('편집기: 초안 키는 접두(서브메뉴 키) + vCenter · 문법 검사 · 서버 400 줄 목록 · 조회 실패 잠금 · 실행 중 잠금 · 관리자 아님 잠금 · 쉼표 정규화 · 늦은 저장 응답 버림', () => {
    expect(editor).toMatch(/useIpamDraft\(`\$\{draftPrefix\}:\$\{vc \|\| '-'\}`\)/);
    expect(editor).toMatch(/checkRangeList\(scanText, \{ reversed: 'error', scanCap: SCAN_CAP \}\)/);
    expect(editor).toMatch(/\(r\.invalid \|\| \[\]\)\.map\(lineIssueText\)/);
    expect(editor).toMatch(/vcRangesGate\(vcRanges, vcRangesErr\)/);
    expect(editor).toMatch(/disabled=\{scanBusy \|\| scanGate\.locked \|\| write\.locked \|\| scanRunning\}/);
    expect(editor).toMatch(/adminWriteGate\(access\)/);
    expect(editor).toMatch(/text: normalizeRangeText\(t\)/);
    expect(editor).toMatch(/ranges: normalizeRangeText\(scanText\)/);
    expect(editor).toMatch(/vcRef\.current === vcAtSave/);
  });
});

describe('D1 — 대역 정책 폼은 ipmsRangeText.policySpecSize 를 쓴다(사본 rangeSpecSize 삭제)', () => {
  it('IpamNet 에 사본이 없다', () => {
    const net = read('./IpamNet.jsx');
    expect(net).not.toMatch(/function rangeSpecSize/);
    expect(net).not.toMatch(/0xffffff00/);
    expect(net).toMatch(/const size = policySpecSize\(spec\)/);
  });
});

describe('D2·D5 — IP 스캔 설정: 저장 400 이면 스캔을 시작하지 않고, 대역 문법 오류는 저장·스캔을 잠근다', () => {
  const scan = read('./IpScanSettings.jsx');
  it('runNow: PUT 응답 ok===false → 사유·줄 목록, POST /scan/run 은 그 뒤에만', () => {
    const fn = scan.slice(scan.indexOf('const runNow = async'), scan.indexOf('const last = status?.lastRun'));
    const iPut = fn.indexOf("putJson('/admin/ipam/scan/settings'");
    const iGuard = fn.indexOf('sv.ok === false');
    const iRun = fn.indexOf("postJson('/admin/ipam/scan/run'");
    expect(iPut).toBeGreaterThan(-1);
    expect(iGuard).toBeGreaterThan(iPut);
    expect(iRun).toBeGreaterThan(iGuard);
    expect(fn).toMatch(/\(sv\.invalid \|\| \[\]\)\.map\(\(x\) => serverInvalidText\(x\)\)/);
    expect(fn).toMatch(/return; \}/);
  });
  it('대역 칸: checkRangeList + RangeCheck + 쉼표 정규화, 오류가 있으면 저장·지금 스캔 잠금(사유 title)', () => {
    expect(scan).toMatch(/const rangeCheck = checkRangeList\(s\.ranges \|\| \[\], \{ reversed: 'error', scanCap: SCAN_CAP \}\)/);
    expect(scan).toMatch(/<RangeCheck check=\{rangeCheck\} \/>/);
    expect(scan).toMatch(/ranges: normalizeRangeText\(e\.target\.value\)\.split\('\\n'\)/);
    expect(scan).toMatch(/disabled=\{busy \|\| rangeCheck\.invalid\.length > 0\} title=\{rangeTitle\} onClick=\{save\}/);
    expect(scan).toMatch(/disabled=\{busy \|\| status\?\.running \|\| !isLocal \|\| rangeCheck\.invalid\.length > 0\} title=\{runNowTitle\} onClick=\{runNow\}/);
  });
});

describe('D6 — 스캔 상태 페이지: 조회 실패면 끝나지 않는 Loading 을 함께 그리지 않는다', () => {
  it('ScanStatusModal', () => {
    const st = read('./IpamScanStatus.jsx');
    const fn = st.slice(st.indexOf('export function ScanStatusModal('));
    expect(fn).toMatch(/\{err && !d && <ErrorBox message=\{err\} \/>\}/);
    expect(fn).toMatch(/\{!d \? \(!err && <Loading \/>\) :/);
    expect(fn).not.toMatch(/\{!d \? <Loading \/> :/);
  });
});

describe('D7·U2·U3·U7·I6 — 소스 계약', () => {
  it('D7: 스캔 결과 CSV 내려받기 실패도 downloadFailText(v2.691 — 대역·스캔 페이지에서 스캔 대역·설정으로 옮겼다)', () => {
    const scan = read('./IpScanSettings.jsx');
    expect(scan).toContain("downloadFile('/tools/ipam/scan-report.csv'");
    expect(scan).toMatch(/catch \(e\) \{ setMsg\(downloadFailText\(e\)\); \}/);
  });
  it('U2: IpamSettings.jsx 는 재수출만 한다(구현 0) — 옛 import 경로는 그대로 동작', () => {
    const shell = read('./IpamSettings.jsx');
    expect(shell.trim().split('\n').every((l) => !l.trim() || l.startsWith('export {'))).toBe(true);
    for (const f of ['IpamEditors.jsx', 'IpmsSettings.jsx', 'IpScanSettings.jsx', 'IpamScanStatus.jsx', 'VcScanRangeEditor.jsx']) expect(shell, f).toContain(`'./${f}'`);
  });
  it("U3: '__local__' 표시 삼항이 IP관리 화면에 남아 있지 않다(판정은 agentLabel 하나)", () => {
    for (const f of ['IpamNet.jsx', 'IpamCore.jsx', 'IpamCsv.jsx', 'IpScanSettings.jsx', 'IpamScanStatus.jsx', 'IpmsSettings.jsx', 'IpamEditors.jsx']) {
      const s = read(`./${f}`);
      expect(s, f).not.toMatch(/=== '__local__' \? '이 포탈'/);
      expect(s, f).not.toMatch(/=== LOCAL_AGENT \? '이 포탈'/); // 선택기의 '이 포탈에서 직접' 은 다른 문구(허용)
      expect(s, f).not.toMatch(/=== LOCAL_AGENT \? '포탈/);
    }
  });
  it('U7: 시각·소요 포매터 사본이 없다(ScanRunsTable 하나가 이력 표를 그린다)', () => {
    for (const f of ['IpamNet.jsx', 'IpamCore.jsx', 'IpScanSettings.jsx', 'IpamScanStatus.jsx']) {
      const s = read(`./${f}`);
      expect(s, f).not.toMatch(/const fmtDt = \(t\) =>/);
      expect(s, f).not.toMatch(/const fmt = \(t\) => \(t \? new Date/);
      expect(s, f).not.toMatch(/const dur = \(ms\) => \(ms == null/);
      expect(s, f).not.toMatch(/toLocaleString\('ko-KR'\)/);
    }
    const net = read('./IpamNet.jsx');
    expect((net.match(/<ScanRunsTable /g) || []).length).toBe(0); // v2.691: 대역·스캔 페이지(이력 표 한 곳)가 없어졌다
    expect(net).not.toMatch(/durationMs \/ 1000\)\.toFixed/);
    expect(read('./IpamScanStatus.jsx').match(/<ScanRunsTable /g).length).toBe(1);
  });
  it('I3: IPMS 설정에 access 를 넘긴다(v2.691 — 대역·스캔 페이지는 없어졌다)', () => {
    const core = read('./IpamCore.jsx');
    expect(core).not.toMatch(/<IpamRanges /);
    expect(core).toMatch(/<IpmsSettings asPage access=\{access\} \/>/);
  });
  it('I6: 다열 표에 STable minWidth(스크롤 래퍼) — 서브넷 시트 12열 · 대역 목록 · 정책 · 이력 · 보고 현황', () => {
    expect(read('./IpamCore.jsx')).toMatch(/<STable minWidth=\{1100\} wrap=\{false\}>\s*<thead><tr><th>\{base\}\.X<\/th>/);
    const net = read('./IpamNet.jsx');
    expect(net).toMatch(/<STable minWidth=\{860\} wrap=\{false\}>/);
    expect(read('./IpamScanStatus.jsx')).toMatch(/<STable minWidth=\{520\} wrap=\{false\}>/);
    expect(read('./IpScanSettings.jsx')).toMatch(/<STable minWidth=\{480\} wrap=\{false\}>/);
    for (const f of ['IpamNet.jsx', 'IpamCore.jsx', 'IpScanSettings.jsx', 'IpamScanStatus.jsx']) expect(read(`./${f}`), f).not.toMatch(/<STable>/);
  });
  it('U5: vCenter 칩 블록은 컴포넌트 하나', () => {
    const core = read('./IpamCore.jsx');
    expect((core.match(/<VcenterChips /g) || []).length).toBe(2);
    expect((core.match(/'🛰 네트워크 스캔'/g) || []).length).toBe(1);
  });
});

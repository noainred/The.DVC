// v2.736.2 — 업그레이드 화면 '자동 업그레이드 동작' 칸 문구(사용자 신고: 자동 업그레이드가 안 되는데 이유가 화면에 없었다).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AUTO_TEXT, STATE_TEXT, TICK_TEXT, APPLYING_NOW, SOURCE_TEXT, autoSummary, autoApplyRowText, noTickText, resultSummary, actionMsg, intervalText, inText, restoredNote,
  remoteSourceLabel, runningScanWarning, SCAN_KIND_TEXT,
} from './upgradeAutoText.js';
import { NO_RECORD_DETAIL } from './upgradeSignatureText.js';

const NOW = Date.UTC(2026, 9, 15, 2, 30, 0);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const serverSrc = fs.readFileSync(path.resolve(HERE, '../../../server/src/upgrade/autoState.js'), 'utf8');
const listOf = (name) => {
  const m = new RegExp(`export const ${name} = Object\\.freeze\\(\\[([\\s\\S]*?)\\]\\)`).exec(serverSrc);
  if (!m) throw new Error(`${name} 를 서버 소스에서 찾지 못했습니다`);
  const body = m[1].split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n'); // 줄 주석 안의 따옴표 낱말을 코드로 읽지 않는다
  return [...body.matchAll(/'([^']+)'/g)].map((x) => x[1]);
};

describe('서버 코드 ↔ 화면 문구 1:1', () => {
  it('AUTO_CODES · AUTO_STATES · TICK_OUTCOMES 가 웹 표와 같다', () => {
    expect(Object.keys(AUTO_TEXT).sort()).toEqual(listOf('AUTO_CODES').sort());
    expect(Object.keys(STATE_TEXT).sort()).toEqual(listOf('AUTO_STATES').sort());
    expect(Object.keys(TICK_TEXT).sort()).toEqual(listOf('TICK_OUTCOMES').sort());
  });
  it('문구에 백틱·별표 강조가 없다(BoldText 가 글자로 그린다)', () => {
    const all = JSON.stringify({ AUTO_TEXT, STATE_TEXT, TICK_TEXT, APPLYING_NOW, SOURCE_TEXT, NO_RECORD_DETAIL });
    expect(all.includes('`')).toBe(false);
    expect(all.includes('**')).toBe(false);
  });
});

describe('자동 업그레이드 동작 요약', () => {
  it('서버가 auto 를 보내지 않으면(구버전) 그리지 않는다', () => {
    expect(autoSummary({ enabled: true })).toBe(null);
    expect(autoSummary({ auto: { state: 'zzz' } })).toBe(null);
  });
  it('주기 0 — 자동 확인을 하지 않는다고 말하고 조치를 준다', () => {
    const s = { enabled: true, autoApply: true, auto: { state: 'manual', intervalMs: 0, nextCheckAt: null, issues: [{ code: 'no-interval' }] } };
    const a = autoSummary(s, NOW);
    expect(a.label).toBe(STATE_TEXT.manual.label);
    expect(a.next).toMatch(/확인 주기 0분/);
    expect(a.lines[0].title).toMatch(/자동 적용도 일어나지 않습니다/);
    expect(a.lines[0].fix).toMatch(/새 버전 확인/);
    expect(autoApplyRowText(s)).toMatch(/예 · 확인 주기 0분\(끔\)/);
    expect(noTickText(s)).toMatch(/자동 확인을 하지 않는 설정/);
  });
  it('동작 중 — 다음 확인 시각·주기 · 마지막 자동 확인 결과', () => {
    const s = {
      enabled: true, autoApply: true,
      auto: { state: 'on', intervalMs: 3_600_000, nextCheckAt: NOW + 25 * 60_000, issues: [] },
      lastTick: { at: NOW - 35 * 60_000, outcome: 'up-to-date', latest: '2.736.1' },
    };
    const a = autoSummary(s, NOW);
    expect(a.tone).toBe('ok');
    expect(a.next).toMatch(/25분 뒤/); expect(a.next).toMatch(/1시간 주기/);
    expect(a.tick).toMatch(/최신 — 받을 새 버전이 없었습니다 \(최신 v2\.736\.1\)/);
    expect(a.tickTone).toBe('ok');
    expect(autoApplyRowText(s)).toBe('예 · 1시간 주기');
  });
  it('동작 중이어도 마지막 확인·적용이 실패했으면 경고 톤 + 사유', () => {
    const s = { enabled: true, auto: { state: 'on', intervalMs: 3_600_000, nextCheckAt: NOW + 60_000, issues: [{ code: 'apply-failed', reason: '서명 검증 실패 — manifest 없음', at: NOW - 60_000 }] },
      lastTick: { at: NOW - 60_000, outcome: 'apply-failed', latest: '2.736.1', reason: '서명 검증 실패 — manifest 없음', restored: true } };
    const a = autoSummary(s, NOW);
    expect(a.tone).toBe('warn');
    expect(a.lines[0].reason).toMatch(/manifest 없음/);
    expect(a.tick).toMatch(/재시작 전 기록/);
    expect(a.tickTone).toBe('bad');
  });
  it('주기는 있는데 무장 시각을 모르면 시각을 지어내지 않는다 · 확인 중이면 그렇게 말한다', () => {
    expect(autoSummary({ enabled: true, auto: { state: 'on', intervalMs: 3_600_000, nextCheckAt: null, issues: [] } }, NOW).next).toMatch(/알 수 없습니다/);
    expect(autoSummary({ enabled: true, ticking: true, auto: { state: 'on', intervalMs: 3_600_000, nextCheckAt: NOW + 1, issues: [] } }, NOW).next).toBe('지금 확인 중입니다');
  });
  it('꺼짐', () => {
    const s = { enabled: false, autoApply: true, auto: { state: 'off', intervalMs: 0, nextCheckAt: null, issues: [{ code: 'disabled' }] } };
    expect(autoSummary(s, NOW).next).toMatch(/꺼짐/);
    expect(autoApplyRowText(s)).toMatch(/자동 업그레이드 꺼짐/);
  });
});

describe('버튼 결과 문구 — 확인 성공을 실패로 말하지 않는다', () => {
  it("'새 버전 확인' 응답에는 ok 가 없다 — 새 버전·최신·원격 실패를 나눠 말한다", () => {
    expect(actionMsg('check', { at: NOW, remote: { ok: true, available: true, latest: '2.736.1' } })).toMatchObject({ label: '새 버전 확인', ok: true });
    expect(actionMsg('check', { at: NOW, remote: { ok: true, available: true, latest: '2.736.1' } }).text).toMatch(/새 버전 v2\.736\.1/);
    expect(actionMsg('check', { at: NOW, remote: { ok: true, available: false, latest: '2.736.1' } })).toMatchObject({ ok: true, text: '최신입니다 (v2.736.1)' });
    expect(actionMsg('check', { at: NOW, remote: { ok: false, error: '원격 소스(versions.json) 접속 실패: ENOTFOUND' } })).toMatchObject({ ok: false });
    expect(actionMsg('check', { at: NOW, remote: { ok: false, error: '원격 소스(versions.json) 접속 실패: ENOTFOUND' } }).text).toMatch(/ENOTFOUND/);
  });
  it('적용·저장·재시작 결과', () => {
    expect(actionMsg('apply', { ok: true, version: '2.736.1', from: '2.736.0', restarting: true }).text).toBe('성공 — v2.736.0 → v2.736.1 · 재시작 중');
    expect(actionMsg('apply', { ok: false, reason: '서명 검증 실패' })).toMatchObject({ ok: false, text: '서명 검증 실패' });
    expect(actionMsg('save', { ok: true, note: '토큰을 폐기했습니다' })).toMatchObject({ ok: true, warn: true });
    expect(actionMsg('restart', { ok: true, restarting: true }).text).toBe('성공 · 재시작 중');
  });
});

describe('적용 결과 요약 · 주기·남은 시간 문구', () => {
  it('성공·이미 최신·실패 · 재시작 전 기록 표지', () => {
    expect(resultSummary({ at: NOW, ok: true, from: '2.736.0', version: '2.736.1', restarting: true, trigger: 'auto', restored: true }).text)
      .toMatch(/성공 — v2\.736\.0 → v2\.736\.1 · 재시작 · 자동\(백그라운드\).*재시작 전 기록/);
    expect(resultSummary({ at: NOW, ok: false, upToDate: true }).tone).toBe('muted');
    expect(resultSummary({ at: NOW, ok: false, code: 'no-install-dir', reason: '설치 경로(installDir)가 설정되지 않아 적용할 수 없습니다.' }).tone).toBe('bad');
    expect(resultSummary(null)).toBe(null);
    expect(restoredNote({ restored: true })).toBe('재시작 전 기록');
    expect(restoredNote({})).toBe(null);
  });
  it('주기·남은 시간', () => {
    expect(intervalText(0)).toBe(null);
    expect(intervalText(30 * 60_000)).toBe('30분');
    expect(intervalText(90 * 60_000)).toBe('1시간 30분');
    expect(intervalText(7 * 86_400_000)).toBe('7일');
    expect(inText(NOW + 30_000, NOW)).toBe('곧');
    expect(inText(NOW + 65 * 60_000, NOW)).toBe('1시간 5분 뒤');
    expect(inText(null, NOW)).toBe(null);
  });
  it('서명 칸의 기록 없음 안내 — 서명이 막은 것이 아니라 서명 단계까지 간 번들이 없다 · 앞 단계에서 멈출 수 있다(리뷰 UPG-UI-04)', () => {
    expect(NO_RECORD_DETAIL).toMatch(/^서명 확인은 받은 번들을 설치하기 직전에 합니다/);
    expect(NO_RECORD_DETAIL).toMatch(/서명 확인 단계까지 간 번들이 아직 없다/);
    expect(NO_RECORD_DETAIL).toMatch(/앞 단계\(버전 확인·다운로드 주소·설치 경로\)에서 멈추면/);
    expect(NO_RECORD_DETAIL).toMatch(/최근 적용 결과/);
    expect(NO_RECORD_DETAIL).not.toMatch(/아직 업그레이드를 시도하지 않은 것입니다/);
  });
});

describe('리뷰 확정분(v2.736.2)', () => {
  const on = (extra = {}) => ({ enabled: true, autoApply: true, auto: { state: 'on', intervalMs: 3_600_000, nextCheckAt: NOW + 60_000, issues: [] }, ...extra });
  it("UPG-UI-01 지금 적용 중이면 '프로세스가 끝났다' 고 말하지 않는다 · 재시작 전 기록일 때만 그 문장", () => {
    const live = autoSummary(on({ ticking: true, applying: true, lastTick: { at: NOW - 120_000, outcome: 'applying', latest: '2.737.0' } }), NOW);
    expect(live.tick).toMatch(new RegExp(APPLYING_NOW));
    expect(live.tick).not.toMatch(/프로세스가 끝났습니다/);
    expect(live.tickTone).toBe('muted');
    expect(live.next).toBe('지금 새 버전을 적용하는 중입니다');
    const dead = autoSummary(on({ lastTick: { at: NOW - 3_600_000, outcome: 'applying', latest: '2.737.0', restored: true } }), NOW);
    expect(dead.tick).toMatch(/프로세스가 끝났습니다/);
    expect(dead.tickTone).toBe('bad');
  });
  it("UPG-UI-02 확인할 곳이 없으면 '최신' 이 아니라 아무것도 확인하지 않았다고 · 다음 확인도 그렇게", () => {
    const s = { enabled: true, autoApply: true, auto: { state: 'blocked', intervalMs: 3_600_000, nextCheckAt: NOW + 60_000, issues: [{ code: 'no-source' }] },
      lastTick: { at: NOW - 60_000, outcome: 'no-source' } };
    const a = autoSummary(s, NOW);
    expect(a.tick).toMatch(/확인할 곳이 없어 아무것도 확인하지 않았습니다/);
    expect(a.tick).not.toMatch(/최신/);
    expect(a.tickTone).toBe('warn');
    expect(a.next).toMatch(/확인할 곳이 없어/);
  });
  it("UPG-UI-03 주기 0 이면 '다음 확인 주기에 다시 시도' 라 하지 않는다", () => {
    const issues = [{ code: 'no-interval' }, { code: 'check-failed', reason: 'HTTP 404', at: NOW - 60_000 }];
    const manual = autoSummary({ enabled: true, auto: { state: 'manual', intervalMs: 0, nextCheckAt: null, issues } }, NOW);
    const cf = manual.lines.find((l) => l.code === 'check-failed');
    expect(cf.fix).not.toMatch(/다음 확인 주기/);
    expect(cf.fix).toMatch(/새 버전 확인/);
    const periodic = autoSummary({ enabled: true, auto: { state: 'on', intervalMs: 3_600_000, nextCheckAt: NOW + 1, issues: [{ code: 'check-failed', reason: 'x' }] } }, NOW);
    expect(periodic.lines[0].fix).toMatch(/다음 확인 주기에 다시 시도합니다/);
  });
  it('UPG-UI-05 저장 전에 누른 409(자동 업그레이드 꺼짐)를 영문 원문 대신 조치로 말한다', () => {
    const m = actionMsg('check', { ok: false, reason: 'auto-upgrade disabled' });
    expect(m.ok).toBe(false);
    expect(m.text).toMatch(/설정을 저장하세요/);
    expect(m.text).not.toMatch(/auto-upgrade disabled/);
  });
  it('UPG-UI-06 적용 결과의 source 를 한글 이름으로 — 화면 실행 + auto 가 모순처럼 보이지 않게', () => {
    const t = resultSummary({ at: NOW, ok: true, from: '2.736.2', version: '2.737.0', source: 'auto', trigger: 'manual' }).text;
    expect(t).toMatch(/화면에서 실행 · 소스 자동 선택/);
    expect(t).not.toMatch(/ · auto(\b|$)/);
    expect(resultSummary({ at: NOW, ok: false, upToDate: true, source: 'collector-push' }).text).toMatch(/수집기로 받은 번들/);
    expect(resultSummary({ at: NOW, ok: false, reason: 'x', source: 'zzz' }).text).toMatch(/ · zzz/); // 모르는 코드는 그대로(지어내지 않는다)
  });
});

// v2.736.3 — 사내 미러(Nexus 등) 주소인데 '원격(GitHub) 오류' 라고 적혀 원인을 GitHub 로 오해하게 했다(사용자 캡처).
describe('remoteSourceLabel — 확인 결과 원격 행 라벨', () => {
  it('GitHub 주소만 원격(GitHub) 이다', () => {
    expect(remoteSourceLabel('https://github.com/noainred/The.DVC/releases/download/downloads/versions.json')).toBe('원격(GitHub)');
    expect(remoteSourceLabel('https://api.github.com/repos/o/r/contents/dl/versions.json')).toBe('원격(GitHub)');
  });
  it('사내 미러·모르는 주소는 GitHub 라고 지어내지 않는다', () => {
    expect(remoteSourceLabel('http://repository.example.local:8081/repository/manager-upgrade/versions.json')).toBe('원격 소스');
    expect(remoteSourceLabel('https://github.com.evil.example/versions.json')).toBe('원격 소스');
    expect(remoteSourceLabel('')).toBe('원격 소스');
    expect(remoteSourceLabel(undefined)).toBe('원격 소스');
    expect(remoteSourceLabel('not a url')).toBe('원격 소스');
  });
  it('업그레이드 화면은 이 함수로 라벨을 정한다(고정 문자열 원격(GitHub) 금지)', () => {
    const src = fs.readFileSync(path.join(HERE, 'Upgrade.jsx'), 'utf8');
    expect(src).toMatch(/label=\{remoteSourceLabel\(check\.remote\.source\)\}/);
    expect(src).not.toMatch(/label="원격\(GitHub\)"/);
  });
});

// v2.736.3 — 서버가 저장소 versions.json 을 최대 UPGRADE_CHECK_TIMEOUT_MS(상한 120초) 기다리므로, 그것을 부르는 GET 은
//   기본 시한 20초 × 재시도로 같은 조회를 겹쳐 보내면 안 된다.
describe('패키지 저장소 조회(/admin/packages) 요청 시한', () => {
  it('120초보다 길고 재시도하지 않는다', () => {
    const src = fs.readFileSync(path.join(HERE, 'AgentDeploy.jsx'), 'utf8');
    const m = /fetchJson\('\/admin\/packages',\s*\{\},\s*undefined,\s*\{\s*timeoutMs:\s*([\d_]+),\s*retries:\s*0\s*\}\)/.exec(src);
    expect(m).not.toBeNull();
    expect(Number(m[1].replace(/_/g, ''))).toBeGreaterThan(120_000);
  });
});

describe('v2.737 실행 중 스캔 — 자동 적용 대기 · 수동 적용 경고', () => {
  it('대기 중이면 무엇을 기다리고 늦어도 언제 적용하는지 말한다', () => {
    const until = NOW + 90 * 60_000;
    const r = autoSummary({ enabled: true, autoApply: true, installDir: '/opt/x', remoteConfigured: true,
      auto: { state: 'on', intervalMs: 3_600_000, armed: true, nextCheckAt: NOW + 60_000, issues: [{ code: 'deferred-scans', at: NOW - 60_000, until, scans: 2, reason: '아이실론 조사, IP 스캔' }] },
      lastTick: { at: NOW - 60_000, outcome: 'deferred', latest: '2.737.0', reason: '실행 중 스캔 2개' } }, NOW);
    const line = r.lines.find((l) => l.code === 'deferred-scans');
    expect(line.title).toMatch(/실행 중인 스캔이 끝나기를 기다리고/);
    expect(line.fix).toMatch(/^늦어도 /);
    expect(line.reason).toBe('아이실론 조사, IP 스캔');
    expect(r.tickTone).toBe('warn');
    expect(TICK_TEXT.deferred).toMatch(/기다리는 중/);
  });
  it('수동 적용 전 경고 — 도는 스캔이 없으면 null · 있으면 종류·이름·시작 시각과 "재시작 뒤 자동 재개" 를 말한다', () => {
    expect(runningScanWarning({ runningScans: [] })).toBe(null);
    expect(runningScanWarning(null)).toBe(null);
    const w = runningScanWarning({ runningScans: [{ kind: 'isidu', label: '사용자 폴더', since: NOW - 10 * 60_000 }, { kind: 'idrac-scan', label: '전체 3개 대역' }] }, NOW);
    expect(w).toMatch(/지금 스캔 2개가 돌고 있습니다/);
    expect(w).toMatch(/아이실론 디렉터리 사용량 ‘사용자 폴더’\(10분 전 시작\)/);
    expect(w).toMatch(/iDRAC 대역 스캔 ‘전체 3개 대역’/);
    expect(w).toMatch(/재시작 뒤 자동으로 다시 시작합니다/);
    expect(w.includes('`')).toBe(false);
  });
  it('스캔 종류 이름은 서버가 기록하는 종류와 1:1', () => {
    const kinds = new Set();
    for (const f of ['isidu/poller.js', 'idrac/scanPoller.js', 'ipam/scanPoller.js', 'agent/ipScanWorker.js']) {
      const src = fs.readFileSync(path.resolve(HERE, '../../../server/src', f), 'utf8');
      for (const m of src.matchAll(/(?:const (?:KIND|JKIND) = |scanStarted\()'([a-z-]+)'/g)) kinds.add(m[1]);
    }
    expect([...kinds].sort()).toEqual(Object.keys(SCAN_KIND_TEXT).sort());
  });
});

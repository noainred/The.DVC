// v2.686 — 사용자 신고(스크린샷 + curl): Connection Server 7.13.1 에서 연결 테스트가 "실시간 사용자·앱별 사용 수집은
// 이 등록으로 동작할 수 있습니다" 라고 말했는데 세션 경로는 404 였다. 버전을 읽어 놓고 "UAG·로드밸런서인지 확인" 을 안내했다.
// 고정하는 계약: 확인한 기능만 말한다 · 404 는 '이 서버에 없음' · 버전을 읽었으면 UAG 조치를 내지 않는다.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hzTestMessage, FEATURE_ORDER, FEATURE_KIND_TEXT } from './horizonAdminText.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const f = (path_, status, kind) => ({ path: path_, status, kind, attempts: [{ path: path_, status, kind }] });

/** 사용자 curl 결과 그대로(2026-10-02, 7.13.1): 라이선스·세션·앱 풀 404 · 데스크톱 풀·팜 200 · monitor(비-v1) 200. */
const REAL_7131 = {
  ok: true, loginOk: true, loginMs: 410, ms: 1319, licenses: null, first: '',
  csVersion: '7.13.1', csVersions: ['7.13.1'], probe: { path: '/rest/monitor/connection-servers', status: 200 },
  versionProbe: { kind: 'ok', path: '/rest/monitor/connection-servers', status: 200, attempts: [
    { path: '/rest/monitor/v1/connection-servers', status: 404, kind: 'not-found' },
    { path: '/rest/monitor/connection-servers', status: 200, kind: 'ok' }] },
  features: {
    license: f('/rest/config/v1/licenses', 404, 'not-found'),
    sessions: f('/rest/inventory/v1/sessions', 404, 'not-found'),
    apps: f('/rest/inventory/v1/application-pools', 404, 'not-found'),
    desktops: f('/rest/inventory/v1/desktop-pools', 200, 'ok'),
    farms: f('/rest/inventory/v1/farms', 200, 'ok'),
  },
  licenseStatus: 404,
  licenseError: '라이선스 조회 실패 (HTTP 404) — 이 커넥션 서버(버전 7.13.1)는 …',
};

describe('v2.686 — 연결 테스트는 기능별로 확인한 것만 말한다', () => {
  const m = hzTestMessage(REAL_7131);
  it('실장비 7.13.1: 주황(로그인만 됨) · 확인하지 않은 "동작할 수 있습니다" 문구 없음', () => {
    expect(m.ok).toBe(false); expect(m.warn).toBe(true);
    expect(m.text).not.toMatch(/동작할 수 있습니다/);
  });
  it('세션 404 는 실시간 사용자 수집이 동작하지 않는다고 단정한다', () => {
    const s = m.lines.find((l) => l.label.startsWith('실시간 사용자'));
    expect(s.tone).toBe('warn');
    expect(s.text).toMatch(/404/);
    expect(s.text).toMatch(/동작하지 않습니다/);
  });
  it('되는 기능(데스크톱 풀·팜)은 됨으로 보인다', () => {
    expect(m.lines.find((l) => l.label === '데스크톱 풀').tone).toBe('ok');
    expect(m.lines.find((l) => l.label === '팜').tone).toBe('ok');
  });
  it('버전을 읽었으면 출처와 함께 말하고 UAG·로드밸런서 조치를 내지 않는다', () => {
    expect(m.text).toContain('7.13.1');
    expect(m.text).toContain('/rest/monitor/connection-servers');
    expect(m.text).not.toMatch(/UAG|로드밸런서/);
    expect(m.lines.some((l) => l.label === '판정' && /주소·계정 문제가 아니라/.test(l.text))).toBe(true);
  });
  it('근거 없는 최소 버전 숫자(2006)를 말하지 않는다', () => {
    expect(m.text).not.toMatch(/2006/);
  });
  it('로그인 시간은 뒤 조회를 뺀 loginMs 다', () => {
    expect(m.lines[0].text).toContain('410ms');
    expect(m.lines[0].text).not.toContain('1319');
  });
  it('기능 줄은 정해진 순서로 전부 있다', () => {
    const labels = m.lines.map((l) => l.label);
    for (const k of FEATURE_ORDER) expect(labels.join('|')).toContain({ license: '라이선스', sessions: '실시간 사용자', apps: '앱 목록', desktops: '데스크톱 풀', farms: '팜' }[k]);
  });
  it('기능 줄은 " — " 를 한 번만 쓴다(세 토막 문장 금지 — v2.560 규약, Chromium 판독에서 발견)', () => {
    for (const l of m.lines.filter((x) => x.label !== '판정')) expect(l.text.split(' — ').length).toBeLessThanOrEqual(2);
  });
  it('화면 문구에 백틱·별표가 없다(BoldText 를 거치지 않는다)', () => {
    expect(m.text).not.toMatch(/`|\*\*/);
    for (const v of Object.values(FEATURE_KIND_TEXT)) expect(v).not.toMatch(/`|\*\*/);
  });
});

describe('v2.686 — 그 밖의 경우', () => {
  it('라이선스·세션이 모두 되면 초록', () => {
    const ok = { ...REAL_7131, licenses: 1, first: 'Horizon Enterprise', licenseStatus: undefined, licenseError: undefined,
      features: { ...REAL_7131.features, license: f('/rest/config/v1/licenses', 200, 'ok'), sessions: f('/rest/inventory/v1/sessions', 200, 'ok') } };
    const m = hzTestMessage(ok);
    expect(m.ok).toBe(true);
    expect(m.lines.find((l) => l.label === '라이선스 만료일').text).toContain('1건');
  });
  it('버전을 못 읽었으면 그때만 서버의 라이선스 404 설명(UAG 확인)을 붙인다', () => {
    const r = { ...REAL_7131, csVersion: null, csVersions: [], probe: { path: '/rest/config/v1/connection-servers', status: 404 },
      versionProbe: { kind: 'not-found', attempts: [{ path: '/rest/monitor/v1/connection-servers', status: 404, kind: 'not-found' }] },
      licenseError: '라이선스 조회 실패 (HTTP 404) — 커넥션 서버 정보도 읽지 못했으니 … UAG·로드밸런서 …' };
    const m = hzTestMessage(r);
    expect(m.lines.find((l) => l.label === '커넥션 서버').text).toMatch(/버전을 읽지 못했습니다/);
    expect(m.text).toMatch(/UAG/);
  });
  it('403 은 404 와 다르게(빨강) 말한다 — 확인하지 못한 것이다', () => {
    const r = { ...REAL_7131, features: { ...REAL_7131.features, sessions: f('/rest/inventory/v1/sessions', 403, 'forbidden') } };
    const s = hzTestMessage(r).lines.find((l) => l.label.startsWith('실시간 사용자'));
    expect(s.tone).toBe('bad');
    expect(s.text).toMatch(/403/);
  });
  it('구버전 서버 응답(features 없음)은 세션을 "확인하지 않았습니다" 로 말한다', () => {
    const m = hzTestMessage({ ok: true, loginOk: true, ms: 9, licenses: null, licenseStatus: 404, licenseError: 'L404' });
    expect(m.ok).toBe(false);
    expect(m.text).toMatch(/확인하지 않았습니다/);
    expect(m.text).not.toMatch(/동작할 수 있습니다/);
  });
});

describe('v2.686 — 등록 화면 도움말', () => {
  const src = fs.readFileSync(path.join(HERE, 'HorizonAdmin.jsx'), 'utf8');
  it('7.13.1 에서 로그인이 됐으므로 "Horizon 8(2006+)" 전제를 적지 않는다', () => {
    expect(src).not.toMatch(/2006/);
    expect(src).toMatch(/연결 테스트<\/b>가 같은 로그인으로 기능마다 확인/);
  });
  it('결과는 줄 단위로 그린다(lines)', () => {
    expect(src).toMatch(/hzMsg\.lines\.map/);
  });
});

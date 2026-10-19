// v2.744 적대적 검토 VD — VM 원격 접속 사전 점검의 원인 오표시 두 가지(RV2744F-WEB-01·WEB-02).
//
// WEB-01: probeFailState 가 403·404 를 전부 '범위 밖 대상(계정 권한)' 으로 단정했다 — mock 데모 계정 거부(demoGuest)·
//   기능 권한 거부(requiredPerm)·역할 거부(requiredRole)·OTP 등록 전 세션까지 '범위 밖' 이라 말했다.
// WEB-02: /remote/probe 가 점검을 하지 못한 200 {ok:false, method:'none'|'ssh', reason}(프록시 SSH 미설정·SSH 실패·호스트키 미신뢰)을
//   '도달 불가'(빨강) + '방화벽/포트/프록시 경로 확인' 으로 그렸고 서버 사유는 화면 어디에도 없었다.
//
// 재현은 **실제 api.js postJson** 으로 한다 — fetch 만 서버가 보내는 응답 모양으로 바꾸고, 그 모양은 서버 소스에서 확인한다(⑥).
// VmRemote.jsx 와 똑같이 성공은 `{ loading:false, ...r }`, 실패는 `probeFailState(e)` 로 상태를 만든다.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
import { probeFailState, probeRow, probeTip, probeColor, probeFooter } from './vmRemoteProbeText.js';

const SERVER = path.join(HERE, '..', '..', '..', 'server', 'src');
const read = (rel) => fs.readFileSync(path.join(SERVER, rel), 'utf8');

const GRAY = '#94a3b8';
const RED = '#f87171';
const GREEN = '#22c55e';

// 서버 소스에서 그대로 옮긴 문구(⑥ 이 소스에 실재하는지 고정한다).
const DEMO_REASON = '데모 계정은 설정을 바꿀 수 없습니다.';
const SCOPE_REASON = '범위 내 vCenter 의 VM/호스트(IP·이름)만 대상으로 할 수 있습니다.';
const VC_REASON = 'vCenter 를 찾을 수 없습니다.';
const NO_SSH_REASON = "프록시 'default'에 SSH(자동배포) 설정이 없어 사전 점검을 할 수 없습니다.";
const HOSTKEY_REASON = 'SSH 호스트키 확인 거부 — 이 장비가 내민 키(ssh-ed25519 SHA256:abc)는 승인된 키와 다릅니다. 비밀번호는 보내지 않았습니다. [SSH_HOSTKEY_UNTRUSTED]';
const SSH_FAIL_REASON = 'All configured authentication methods failed';

const store = () => { const mem = new Map(); return { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) }; };
let saved;
beforeEach(() => {
  saved = { fetch: globalThis.fetch, ls: globalThis.localStorage, ss: globalThis.sessionStorage };
  globalThis.localStorage = store(); globalThis.sessionStorage = store();
});
afterEach(() => { globalThis.fetch = saved.fetch; globalThis.localStorage = saved.ls; globalThis.sessionStorage = saved.ss; vi.restoreAllMocks(); });

/** 실제 postJson('/remote/probe') 을 서버 응답 하나로 돌려 VmRemote.jsx 와 같은 상태 객체를 만든다. */
async function probeState(status, body, { html = false } = {}) {
  globalThis.fetch = vi.fn(async () => (html
    ? new Response('<html><body>Forbidden</body></html>', { status, headers: { 'Content-Type': 'text/html' } })
    : new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })));
  const { postJson } = await import('../api.js');
  try {
    const r = await postJson('/remote/probe', { vcenterId: 'vc-1', targetHost: '10.0.0.5', targetPort: 22 });
    return { loading: false, ...r };
  } catch (e) {
    return probeFailState(e);
  }
}
const one = (q) => ({ canRemote: true, ips: ['10.0.0.5'], probes: { '10.0.0.5': q }, probePort: 22 });

describe('① WEB-01 — 403·404 를 거부 종류별로 나눈다(전부 범위 밖이라 단정하지 않는다)', () => {
  it('데모 계정 거부(demoGuest) → 데모 계정 제한, 범위 밖이라 말하지 않는다', async () => {
    const q = await probeState(403, { error: 'forbidden', demoGuest: true, reason: DEMO_REASON });
    expect(q.denied).toBe(true);
    expect(q.denyKind).toBe('demo');
    const row = probeRow(q);
    expect(row.st).toBe('denied');
    expect(row.label).toBe('데모 계정 제한');
    expect(row.text).toBe(`데모 계정 제한 — ${DEMO_REASON}`);
    const tip = probeTip(one(q));
    expect(tip).toMatch(/데모 계정/);
    expect(tip).not.toMatch(/범위 밖/);
    expect(tip).not.toMatch(/방화벽/);
    expect(probeColor(one(q))).toBe(GRAY);
    expect(probeFooter(one(q))).toMatch(/^⛔ 데모 계정/);
  });

  it('기능 권한 거부(requiredPerm) → 권한 없음(필요 권한 …), 오류 코드 forbidden 을 사유로 쓰지 않는다', async () => {
    const q = await probeState(403, { error: 'forbidden', requiredPerm: ['remote.access'] });
    expect(q.denyKind).toBe('perm');
    expect(q.reason).toBe('');
    const row = probeRow(q);
    expect(row.label).toBe('권한 없음(필요 권한 remote.access)');
    expect(row.text).not.toMatch(/forbidden/);
    const tip = probeTip(one(q));
    expect(tip).toMatch(/원격 접속 권한\(remote\.access\)/);
    expect(tip).not.toMatch(/범위 밖/);
    expect(probeColor(one(q))).toBe(GRAY);
  });

  it('역할 거부(requiredRole) → 권한 없음(필요 역할 …)', async () => {
    const q = await probeState(403, { error: 'forbidden', requiredRole: ['admin', 'operator'] });
    expect(q.denyKind).toBe('role');
    expect(probeRow(q).label).toBe('권한 없음(필요 역할 admin/operator)');
    expect(probeTip(one(q))).not.toMatch(/범위 밖/);
  });

  it('OTP 등록 전 세션(requireEnrolled) → OTP 등록 필요', async () => {
    const q = await probeState(403, { error: 'otp_enrollment_required', reason: 'OTP 등록을 마쳐야 포탈을 사용할 수 있습니다.' });
    expect(q.denyKind).toBe('enroll');
    expect(probeRow(q).label).toBe('OTP 등록 필요');
    expect(probeTip(one(q))).not.toMatch(/범위 밖/);
  });

  it('범위 밖 대상 403·범위 밖 vCenter 404(서버가 범위 사유로 준 거부)만 범위 밖이라 말한다', async () => {
    const q403 = await probeState(403, { ok: false, reason: SCOPE_REASON });
    expect(q403.denyKind).toBe('scope');
    expect(probeRow(q403).label).toBe('범위 밖 대상(계정 권한)');
    expect(probeTip(one(q403))).toBe(`이 계정의 범위 밖 대상입니다 — 네트워크 문제가 아닙니다(서버: ${SCOPE_REASON})`);
    const q404 = await probeState(404, { ok: false, reason: VC_REASON });
    expect(q404.denyKind).toBe('scope');
    expect(probeRow(q404).label).toBe('범위 밖 vCenter(계정 권한)');
    expect(probeColor(one(q404))).toBe(GRAY);
  });

  it('표지 없는 403(중간 프록시 HTML 등)은 범위라 단정하지 않는다 · 표지 없는 404 는 거부가 아니라 점검 못 함', async () => {
    const q = await probeState(403, null, { html: true });
    expect(q.denied).toBe(true);
    expect(q.denyKind).toBe('unknown');
    expect(probeRow(q).label).not.toMatch(/범위/);
    const tip = probeTip(one(q));
    expect(tip).not.toMatch(/범위|방화벽/);
    expect(tip).toMatch(/도달 여부는 확인하지 못했습니다/);
    const q404 = await probeState(404, null, { html: true });
    expect(q404.denied).toBeUndefined();
    expect(probeRow(q404).st).toBe('unchecked');
    expect(probeRow(q404).label).toBe('점검 못 함(점검 요청 실패)');
    expect(probeColor(one(q404))).toBe(GRAY);
  });
});

describe('② WEB-02 — 점검을 하지 못한 200 {ok:false} 를 도달 불가·방화벽으로 말하지 않는다', () => {
  it('프록시 SSH 미설정(method none) → 점검 못 함 + 서버 사유, 회색, 방화벽 안내 없음', async () => {
    const q = await probeState(200, { ok: false, method: 'none', proxyName: 'default', reason: NO_SSH_REASON });
    const row = probeRow(q);
    expect(row.st).toBe('unchecked');
    expect(row.label).toBe('점검 못 함(프록시 SSH 미설정)');
    expect(row.text).toBe(`점검 못 함(프록시 SSH 미설정) — ${NO_SSH_REASON}`);
    const tip = probeTip(one(q));
    expect(tip).not.toMatch(/방화벽|접속 불가|도달 불가/);
    expect(tip).toContain('사전 점검을 하지 못했습니다');
    expect(tip).toContain(NO_SSH_REASON);
    expect(probeColor(one(q))).toBe(GRAY);
    const foot = probeFooter(one(q));
    expect(foot).not.toMatch(/열린 포트가 없습니다/);
    expect(foot).toMatch(/그래도 선택한 IP로 접속을 시도할 수 있습니다/);
  });

  it('프록시 호스트키 미신뢰·프록시 SSH 실패(method ssh)도 점검 못 함 — 이유를 나눠 말한다', async () => {
    const hk = await probeState(200, { ok: false, method: 'ssh', proxyName: 'default', reason: HOSTKEY_REASON });
    expect(probeRow(hk).label).toBe('점검 못 함(프록시 호스트키 미신뢰)');
    expect(probeRow(hk).text).toContain('[SSH_HOSTKEY_UNTRUSTED]');
    const sf = await probeState(200, { ok: false, method: 'ssh', proxyName: 'default', reason: SSH_FAIL_REASON });
    expect(probeRow(sf).label).toBe('점검 못 함(프록시 SSH 실패)');
    expect(probeTip(one(sf))).not.toMatch(/방화벽/);
    expect(probeColor(one(sf))).toBe(GRAY);
  });

  it('점검 요청 자체가 실패(5xx·시한) → 점검 못 함(점검 요청 실패), 도달 불가가 아니다', async () => {
    const q500 = await probeState(500, { error: 'internal' });
    expect(probeRow(q500).st).toBe('unchecked');
    expect(probeRow(q500).label).toBe('점검 못 함(점검 요청 실패)');
    const qt = probeFailState(Object.assign(new Error('signal timed out'), { name: 'TimeoutError' }));
    expect(probeRow(qt).text).toBe('점검 못 함(점검 요청 실패) — signal timed out');
    expect(probeTip(one(qt))).not.toMatch(/방화벽/);
  });

  it('실제로 점검했고(ok:true) 닫혀 있을 때만 도달 불가 · 방화벽 · 빨강', async () => {
    const q = await probeState(200, { ok: true, method: 'ssh', proxyName: 'default', targetHost: '10.0.0.5', targetPort: 22, pingOk: false, pingMs: null, portOpen: false });
    expect(probeRow(q)).toEqual({ st: 'down', label: '도달 불가', text: '도달 불가' });
    expect(probeTip(one(q))).toBe('모든 IP 접속 불가(:22) — 방화벽/포트/프록시 경로 확인');
    expect(probeColor(one(q))).toBe(RED);
    expect(probeFooter(one(q))).toBe('⚠ 열린 포트가 없습니다. 그래도 선택한 IP로 접속을 시도할 수 있습니다.');
  });
});

describe('③ 섞인 경우 — 열림·닫힘·점검 못 함·거부가 섞여도 문구가 거짓이 되지 않는다', () => {
  const closed = { loading: false, ok: true, method: 'ssh', pingOk: false, portOpen: false };
  const noSsh = { loading: false, ok: false, method: 'none', reason: NO_SSH_REASON };
  const demo = probeFailState({ status: 403, demoGuest: true, serverReason: DEMO_REASON, body: { error: 'forbidden', demoGuest: true, reason: DEMO_REASON } });
  const scope = probeFailState({ status: 403, serverReason: SCOPE_REASON, body: { ok: false, reason: SCOPE_REASON } });

  it('닫힘 1 + 점검 못 함 1 + 데모 거부 1 → 점검한 IP 만 접속 불가라 말하고 나머지는 각자의 사실', () => {
    const ips = ['10.0.0.1', '10.0.0.2', '10.0.0.3'];
    const probes = { '10.0.0.1': closed, '10.0.0.2': noSsh, '10.0.0.3': demo };
    const tip = probeTip({ canRemote: true, ips, probes, probePort: 22 });
    expect(tip).not.toMatch(/모든 IP 접속 불가/);
    expect(tip).toMatch(/^점검한 1개 IP 접속 불가\(:22\) — 방화벽\/포트\/프록시 경로 확인/);
    expect(tip).toContain(`1개 IP 는 사전 점검을 하지 못했습니다(프록시 SSH 미설정: ${NO_SSH_REASON})`);
    expect(tip).toContain('1개 IP 는 점검 요청이 거부돼 확인하지 못했습니다(데모 계정 제한 1)');
    expect(tip).not.toMatch(/범위 밖/);
    expect(probeColor({ canRemote: true, ips, probes })).toBe(RED);
  });

  it('점검 못 함 + 범위 거부(점검한 IP 없음) → 회색 · 방화벽 안내 없음', () => {
    const ips = ['10.0.0.1', '10.0.0.2'];
    const probes = { '10.0.0.1': noSsh, '10.0.0.2': scope };
    const tip = probeTip({ canRemote: true, ips, probes, probePort: 22 });
    expect(tip).not.toMatch(/방화벽|접속 불가/);
    expect(tip).toMatch(/^사전 점검을 하지 못했습니다\(프록시 SSH 미설정/);
    expect(tip).toContain('1개 IP 는 점검 요청이 거부돼 확인하지 못했습니다(범위 밖 대상 1)');
    expect(probeColor({ canRemote: true, ips, probes })).toBe(GRAY);
  });

  it('전부 거부지만 종류가 다르면 한 원인으로 단정하지 않는다', () => {
    const ips = ['10.0.0.1', '10.0.0.2'];
    const probes = { '10.0.0.1': scope, '10.0.0.2': demo };
    const tip = probeTip({ canRemote: true, ips, probes, probePort: 22 });
    expect(tip).toBe('모든 IP 의 사전 점검 요청이 거부됐습니다(범위 밖 대상 1 · 데모 계정 제한 1) — 대상 VM 의 도달 여부는 확인하지 못했습니다');
    expect(probeColor({ canRemote: true, ips, probes })).toBe(GRAY);
    expect(probeFooter({ canRemote: true, ips, probes, probePort: 22 })).toBe(`⛔ ${tip}`);
  });

  it('열린 IP 가 하나라도 있으면 그 IP 만 말한다(초록)', () => {
    const ips = ['10.0.0.1', '10.0.0.2', '10.0.0.3'];
    const probes = { '10.0.0.1': noSsh, '10.0.0.2': { loading: false, ok: true, portOpen: true, pingOk: true, pingMs: 2 }, '10.0.0.3': demo };
    expect(probeTip({ canRemote: true, ips, probes, probePort: 22 })).toBe('접속 가능 IP: 10.0.0.2 (:22)');
    expect(probeColor({ canRemote: true, ips, probes })).toBe(GREEN);
  });
});

describe('④ VmRemote.jsx 는 이 모듈의 판정만 쓴다(행 사유 · 하단 문구를 인라인으로 다시 판정하지 않는다)', () => {
  const src = fs.readFileSync(path.join(HERE, 'VmRemote.jsx'), 'utf8');
  it('행 글자는 probeRow 의 text, 하단은 probeFooter', () => {
    expect(src).toMatch(/const \{ st, text: label \} = probeRow\(p\)/);
    expect(src).toMatch(/probeFooter\(\{ canRemote, ips, probes, probePort \}\)/);
    expect(src).not.toMatch(/st === 'denied' && p\.reason/);
    expect(src).not.toMatch(/allDenied/);
    expect(src).not.toMatch(/열린 포트가 없습니다/);
  });
});

describe('⑤ 서버가 이 경로에서 실제로 보내는 거부·점검 못 함 모양(소스 대조 — 모양이 바뀌면 판정도 함께 볼 것)', () => {
  it('remote.js /probe — 범위 403·404 는 {ok:false, reason}, 점검 못 함은 200 {ok:false, method}', () => {
    const s = read('routes/remote.js');
    expect(s).toMatch(/res\.status\(403\)\.json\(\{ ok: false, reason: issue \}\)/);
    expect(s).toMatch(/res\.status\(404\)\.json\(\{ ok: false, reason: vcIssue \}\)/);
    expect(s).toMatch(/res\.json\(\{ ok: false, method: 'none'/);
    expect(s).toMatch(/res\.json\(\{ ok: false, method: 'ssh', proxyName: proxy\.name, reason: err\.message \}\)/);
    expect(s).toContain("사전 점검을 할 수 없습니다.");
    expect(read('proxy/targetHostScope.js')).toContain(SCOPE_REASON);
    expect(read('proxy/sshExec.js')).toMatch(/SSH_HOSTKEY_ERROR_CODE = 'SSH_HOSTKEY_UNTRUSTED'/);
  });
  it('데모 계정 · 권한 · 역할 · OTP 등록 게이트의 403 본문', () => {
    const demo = read('auth/demoGuest.js');
    expect(demo).toContain(DEMO_REASON);
    expect(demo).toMatch(/res\.status\(403\)\.json\(\{ error: 'forbidden', demoGuest: true, reason \}\)/);
    expect(demo).toMatch(/'\/api\/remote'/);
    const auth = read('auth/auth.js');
    expect(auth).toMatch(/res\.status\(403\)\.json\(\{ error: 'forbidden', requiredPerm: keys \}\)/);
    expect(auth).toMatch(/res\.status\(403\)\.json\(\{ error: 'forbidden', requiredRole: roles \}\)/);
    expect(auth).toMatch(/error: 'otp_enrollment_required'/);
  });
});

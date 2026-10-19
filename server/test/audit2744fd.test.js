/**
 * v2.744 최종 검토 그룹 FD — RF-R1: 원격 접속 범위 판정이 IP 대장의 호스트 IP 판정(hostLedgerIp)을 따른다.
 *
 * 배경: 이 릴리스(GG-R2)가 IP 대장 호스트 행의 원격 접속 대상을 '행의 IP' 로 바꿨다. 이름(FQDN)으로 등록된 ESXi 의
 *   행 IP 는 관리 IP(mgmtIp — ipam/ledger.js hostLedgerIp)다. 그런데 범위 제한 계정의 원격 접속 범위 판정
 *   (proxy/targetHostScope.js targetHostScopeIssue)은 호스트를 `host.name` 으로만 대조해, 범위 안 vCenter 의 호스트를
 *   그 관리 IP 로 probe·quick-connect 하면 403 이었다(화면은 그것을 '도달 불가 — 방화벽/포트 확인' 으로 안내했다).
 *
 * 고친 규칙(넓히는 쪽이라 경계를 함께 고정한다):
 *   ① 허용 vCenter 호스트의 hostLedgerIp(이름이 IP 면 그 이름, 아니면 정규형 관리 IP)도 그 호스트로 인정한다.
 *   ② 범위 밖 vCenter 호스트의 관리 IP 는 여전히 거부한다.
 *   ③ 관리 IP 가 비정규 표기·0.0.0.0 이면 인정하지 않는다(hostLedgerIp 가 이미 null 을 준다 — 8진 해석 위험).
 *      대상 문자열이 정규형이 아니면(10.20.0.011 등) 같은 IP 로 보지 않는다.
 *   ④ 같은 IP 를 범위 밖 객체(다른 vCenter 의 호스트·VM, vCenter 귀속 없는 호스트)도 갖고 있으면 관리 IP 규칙으로는
 *      인정하지 않는다(안전한 쪽 — 그 IP 가 실제로 어느 장비인지 알 수 없다). 기존 규칙(VM IP·VM 이름·호스트 이름)은 그대로.
 *   ⑤ 전체 범위 계정(allowed=null)은 예전 그대로 무제한.
 *
 * 순수 판정은 이 프로세스에서, 라우트(probe·quick-connect·mappings)와 WS 게이트웨이 재검사(mappingAccessIssue)는
 * 실제 라우터를 띄운 자식 프로세스에서 본다(config.js 싱글턴이라 CONFIG_DIR 을 다시 가리킬 수 없다).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2744fd-'));
process.env.CONFIG_DIR = TMP;

const { targetHostScopeIssue } = await import('../src/proxy/targetHostScope.js');
const { hostLedgerIp } = await import('../src/ipam/ledger.js');
const reexp = await import('../src/routes/remote.js');

const REASON = /범위 내 vCenter/;
const N = new Set(['vc-n']);

function snapOf() {
  return {
    vms: [
      { vcenterId: 'vc-n', name: 'app-01', ipAddresses: ['10.20.0.50'] },
      { vcenterId: 'vc-n', name: 'app-02', ipAddress: '10.20.0.45' },     // 범위 안 VM IP = 범위 안 호스트 관리 IP
      { vcenterId: 'vc-x', name: 'other-01', ipAddresses: ['10.20.0.41'] }, // 범위 밖 VM 이 범위 안 호스트 관리 IP 와 같다
      { vcenterId: 'vc-x', name: 'other-02', ipAddress: '10.20.0.044' },    // 느슨한 표기(선행 0) — 숫자로는 10.20.0.44
    ],
    hosts: [
      { vcenterId: 'vc-n', name: 'esx01.corp.local', mgmtIp: '10.20.0.11' },   // 이름(FQDN) 등록 + 정규형 관리 IP
      { vcenterId: 'vc-n', name: '10.20.0.12', mgmtIp: '10.20.0.99' },         // 이름이 IP — 원장은 이름을 쓴다
      { vcenterId: 'vc-n', name: 'esx03.corp.local', mgmtIp: '010.20.0.13' },  // 비정규 표기 관리 IP
      { vcenterId: 'vc-n', name: 'esx04.corp.local', mgmtIp: '0.0.0.0' },      // 미설정 표기
      { vcenterId: 'vc-n', name: 'esx05.corp.local', mgmtIp: '10.20.0.40' },   // 범위 밖 호스트와 같은 관리 IP
      { vcenterId: 'vc-x', name: 'esx90.corp.local', mgmtIp: '10.20.0.40' },
      { vcenterId: 'vc-n', name: 'esx06.corp.local', mgmtIp: '10.20.0.41' },   // 범위 밖 VM 과 같은 IP
      { vcenterId: 'vc-n', name: 'esx07.corp.local', mgmtIp: '10.20.0.42' },   // 범위 밖 호스트 '이름' 과 같은 IP
      { vcenterId: 'vc-x', name: '10.20.0.42' },
      { vcenterId: 'vc-n', name: 'esx08.corp.local', mgmtIp: '10.20.0.43' },   // vCenter 귀속 없는 호스트와 같은 IP
      { name: 'esx-orphan.corp.local', mgmtIp: '10.20.0.43' },
      { vcenterId: 'vc-n', name: 'esx09.corp.local', mgmtIp: '10.20.0.44' },   // 범위 밖 VM 의 느슨한 표기와 숫자로 같다
      { vcenterId: 'vc-n', name: 'esx10.corp.local', mgmtIp: '10.20.0.45' },   // 범위 안 VM 과 같은 IP(둘 다 범위 안)
      { vcenterId: 'vc-n', name: 'esx11.corp.local', mgmtIp: '10.20.0.46' },   // 범위 안 두 호스트가 같은 관리 IP
      { vcenterId: 'vc-n', name: 'esx12.corp.local', mgmtIp: '10.20.0.46' },
      { vcenterId: 'vc-x', name: 'esx91.corp.local', mgmtIp: '10.30.0.21' },   // 범위 밖 호스트의 관리 IP
    ],
  };
}

test('① 범위 안 vCenter 의 FQDN 호스트를 관리 IP 로 대상 지정할 수 있다(수정 전: 거부)', () => {
  const snap = snapOf();
  assert.deepEqual(hostLedgerIp(snap.hosts[0]), { ip: '10.20.0.11', n: (10 << 24 | 20 << 16 | 11) >>> 0 }, '원장은 이 IP 를 이 호스트의 IP 로 본다');
  assert.equal(targetHostScopeIssue(snap, N, '10.20.0.11'), null, '수정 전: 범위 내 vCenter 의 VM/호스트만 … (거부)');
  assert.equal(reexp.targetHostScopeIssue(snap, N, '10.20.0.11'), null, 'routes/remote.js 재수출도 같은 판정');
  assert.equal(targetHostScopeIssue(snap, N, 'esx01.corp.local'), null, '이름 규칙은 그대로');
  assert.equal(targetHostScopeIssue(snap, N, 'ESX01.CORP.LOCAL'), null, '이름은 대소문자 무시(그대로)');
});

test('② 범위 밖 vCenter 호스트의 관리 IP 는 여전히 거부한다', () => {
  const snap = snapOf();
  assert.match(targetHostScopeIssue(snap, N, '10.30.0.21'), REASON);
  assert.match(targetHostScopeIssue(snap, N, 'esx91.corp.local'), REASON, '범위 밖 호스트 이름도 거부(그대로)');
  assert.match(targetHostScopeIssue(snap, N, '10.99.99.99'), REASON, '인벤토리에 없는 임의 IP 거부(정찰 차단 — 그대로)');
  assert.match(targetHostScopeIssue(snap, new Set(), '10.20.0.11'), REASON, '허용 vCenter 가 없는 계정은 아무 호스트도 안 된다');
});

test('③ 관리 IP 가 비정규 표기·0.0.0.0 이면 인정하지 않고, 대상이 비정규 표기여도 같은 IP 로 보지 않는다', () => {
  const snap = snapOf();
  assert.equal(hostLedgerIp(snap.hosts[2]), null, '원장 판정: 비정규 관리 IP 는 쓰지 않는다');
  assert.equal(hostLedgerIp(snap.hosts[3]), null, '원장 판정: 0.0.0.0 은 미설정');
  for (const t of ['010.20.0.13', '10.20.0.13', '8.20.0.13']) assert.match(targetHostScopeIssue(snap, N, t), REASON, t);
  assert.match(targetHostScopeIssue(snap, N, '0.0.0.0'), REASON, '0.0.0.0');
  // 정규형 관리 IP 10.20.0.11 의 비정규 표기 — inet_aton 은 10.20.0.9(8진)로 읽는다. 같은 대상으로 보지 않는다.
  for (const t of ['10.20.0.011', '010.020.000.011', '0x0a.20.0.11']) assert.match(targetHostScopeIssue(snap, N, t), REASON, t);
});

test('④ 같은 IP 를 범위 밖 객체도 갖고 있으면 관리 IP 규칙으로는 인정하지 않는다(안전한 쪽)', () => {
  const snap = snapOf();
  assert.match(targetHostScopeIssue(snap, N, '10.20.0.40'), REASON, '범위 밖 호스트의 관리 IP 와 같다');
  assert.match(targetHostScopeIssue(snap, N, '10.20.0.41'), REASON, '범위 밖 VM IP 와 같다');
  assert.match(targetHostScopeIssue(snap, N, '10.20.0.42'), REASON, '범위 밖 호스트 이름(IP)과 같다');
  assert.match(targetHostScopeIssue(snap, N, '10.20.0.43'), REASON, 'vCenter 귀속 없는 호스트와 같다');
  assert.match(targetHostScopeIssue(snap, N, '10.20.0.44'), REASON, '범위 밖 VM 의 느슨한 표기(10.20.0.044)와 숫자로 같다');
  // 범위 안 이름은 기존 규칙 그대로 허용된다(관리 IP 규칙만 막는다).
  assert.equal(targetHostScopeIssue(snap, N, 'esx05.corp.local'), null);
  // 양쪽 vCenter 를 다 볼 수 있는 계정이면 충돌이 아니다.
  assert.equal(targetHostScopeIssue(snap, new Set(['vc-n', 'vc-x']), '10.20.0.40'), null);
});

test('⑤ 범위 안끼리 겹치는 것은 충돌이 아니다 · 이름이 IP 인 호스트는 원장처럼 이름을 쓴다 · 전체 범위는 무제한', () => {
  const snap = snapOf();
  assert.equal(targetHostScopeIssue(snap, N, '10.20.0.45'), null, '범위 안 VM IP = 범위 안 호스트 관리 IP');
  assert.equal(targetHostScopeIssue(snap, N, '10.20.0.46'), null, '범위 안 두 호스트가 같은 관리 IP');
  assert.equal(targetHostScopeIssue(snap, N, '10.20.0.12'), null, '이름이 IP 인 호스트(그대로)');
  assert.deepEqual(hostLedgerIp(snap.hosts[1])?.ip, '10.20.0.12', '원장은 이름이 IP 면 이름을 쓴다');
  assert.match(targetHostScopeIssue(snap, N, '10.20.0.99'), REASON, '원장 행 IP 가 아닌 관리 IP 는 넓히지 않는다(한 벌)');
  assert.equal(targetHostScopeIssue(snap, N, '10.20.0.50'), null, '범위 안 VM IP(그대로)');
  assert.equal(targetHostScopeIssue(snap, N, 'APP-01'), null, 'VM 이름(그대로)');
  for (const t of ['10.30.0.21', '10.20.0.40', '10.99.99.99', '010.20.0.13']) assert.equal(targetHostScopeIssue(snap, null, t), null, `전체 범위 ${t}`);
});

test('⑥ 한 벌: 범위 안 호스트마다 원장 IP(hostLedgerIp)로 대상 지정하면 — 범위 밖과 겹치지 않는 한 — 허용된다', () => {
  const snap = snapOf();
  const outside = new Set();
  for (const v of snap.vms) if (!N.has(v.vcenterId)) for (const ip of (v.ipAddresses || [v.ipAddress])) outside.add(ip);
  for (const h of snap.hosts) if (!N.has(h.vcenterId)) { outside.add(h.name); const hip = hostLedgerIp(h); if (hip) outside.add(hip.ip); }
  let checked = 0;
  for (const h of snap.hosts) {
    if (!N.has(h.vcenterId)) continue;
    const hip = hostLedgerIp(h);
    if (!hip || outside.has(hip.ip) || hip.ip === '10.20.0.44') continue; // 충돌·느슨한 표기 충돌은 ④ 가 본다
    assert.equal(targetHostScopeIssue(snap, N, hip.ip), null, `${h.name} → ${hip.ip}`);
    checked += 1;
  }
  assert.ok(checked >= 4, `대조한 호스트 수 ${checked}`);
});

test('⑦ 소스: 호스트 IP 판정은 ipam/ledger.js hostLedgerIp 를 가져다 쓴다(관리 IP 규칙을 복제하지 않는다)', () => {
  const src = stripComments(fs.readFileSync(path.join(SRC, 'proxy/targetHostScope.js'), 'utf8'));
  assert.match(src, /import\s*\{[^}]*\bhostLedgerIp\b[^}]*\}\s*from\s*['"]\.\.\/ipam\/ledger\.js['"]/);
  assert.doesNotMatch(src, /mgmtIp/, '관리 IP 필드를 직접 읽지 않는다 — 판정은 hostLedgerIp 하나');
});

test('⑧ 실제 라우터: 범위 계정의 probe·quick-connect·WS 재검사가 관리 IP 를 받고 범위 밖·충돌은 거부한다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2744fd-r-'));
  fs.writeFileSync(path.join(dir, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));
  const script = `
    const SRC = ${JSON.stringify(SRC + '/')};
    const express = (await import('express')).default;
    const { store } = await import(SRC + 'store.js');
    store.snapshot = { ...(store.get() || {}), source: 'live', generatedAt: new Date().toISOString(),
      vcenters: [{ id: 'vc-n', name: 'VC-N', status: 'connected' }, { id: 'vc-x', name: 'VC-X', status: 'connected' }],
      hosts: [
        { id: 'vc-n:host-1', vcenterId: 'vc-n', name: 'esx01.corp.local', mgmtIp: '10.20.0.11', connectionState: 'CONNECTED' },
        { id: 'vc-n:host-5', vcenterId: 'vc-n', name: 'esx05.corp.local', mgmtIp: '10.20.0.40', connectionState: 'CONNECTED' },
        { id: 'vc-x:host-90', vcenterId: 'vc-x', name: 'esx90.corp.local', mgmtIp: '10.20.0.40', connectionState: 'CONNECTED' },
        { id: 'vc-x:host-91', vcenterId: 'vc-x', name: 'esx91.corp.local', mgmtIp: '10.30.0.21', connectionState: 'CONNECTED' },
      ],
      vms: [], datastores: [], networks: [], alarms: [] };
    const { remoteRouter } = await import(SRC + 'routes/remote.js');
    const { api } = await import(SRC + 'routes/api.js');
    const { mappingAccessIssue } = await import(SRC + 'proxy/sshGateway.js');
    const reg = await import(SRC + 'proxy/registry.js');
    const USERS = {
      sop: { username: 'sop', role: 'operator', scope: { vcenters: ['vc-n'] } },
      sadm: { username: 'sadm', role: 'admin', scope: { vcenters: ['vc-n'] } },
      full: { username: 'full', role: 'operator', scope: {} },
    };
    const app = express(); app.use(express.json());
    app.use((req, _r, n) => { req.user = USERS[req.headers['x-u'] || 'full']; n(); });
    app.use('/api/remote', remoteRouter); app.use('/api', api);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = 'http://127.0.0.1:' + srv.address().port;
    const call = async (u, method, p, b) => {
      const r = await fetch(base + '/api' + p, { method, headers: { 'x-u': u, 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
      const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { j = t.slice(0, 300); }
      return { s: r.status, j };
    };
    const out = {};
    try {
      const sheet = await call('sop', 'GET', '/tools/ipam/sheet?base=10.20.0');
      const row = (sheet.j.rows || []).find((r) => r.ip === '10.20.0.11');
      out.sheetRow = row ? { ownerType: row.ownerType, vcenterId: row.vcenterId } : null;
      out.probeIn = await call('sop', 'POST', '/remote/probe', { vcenterId: 'vc-n', targetHost: '10.20.0.11', targetPort: 22 });
      out.probeOut = await call('sop', 'POST', '/remote/probe', { vcenterId: 'vc-n', targetHost: '10.30.0.21', targetPort: 22 });
      out.probeConflict = await call('sop', 'POST', '/remote/probe', { vcenterId: 'vc-n', targetHost: '10.20.0.40', targetPort: 22 });
      out.probeOddForm = await call('sop', 'POST', '/remote/probe', { vcenterId: 'vc-n', targetHost: '10.20.0.011', targetPort: 22 });
      out.quickOut = (await call('sop', 'POST', '/remote/quick-connect', { protocol: 'ssh', vcenterId: 'vc-n', targetHost: '10.30.0.21' })).s;
      const qin = await call('sop', 'POST', '/remote/quick-connect', { protocol: 'ssh', vcenterId: 'vc-n', targetHost: '10.20.0.11' });
      out.quickIn = qin.s;
      const m = qin.j && qin.j.mapping ? reg.getMapping(qin.j.mapping.id) : null;
      out.wsOwner = m ? mappingAccessIssue(USERS.sop, m) : 'no-mapping';
      out.wsScopedAdmin = m ? mappingAccessIssue(USERS.sadm, m) : 'no-mapping';
      out.sadmMapOut = (await call('sadm', 'POST', '/remote/mappings', { name: 'x', protocol: 'ssh', targetHost: '10.30.0.21', targetPort: 22 })).s;
      out.sadmMapConflict = (await call('sadm', 'POST', '/remote/mappings', { name: 'y', protocol: 'ssh', targetHost: '10.20.0.40', targetPort: 22 })).s;
      out.fullProbeOut = (await call('full', 'POST', '/remote/probe', { vcenterId: 'vc-x', targetHost: '10.30.0.21', targetPort: 22 })).s;
    } finally { srv.close(); }
    console.log('@@' + JSON.stringify(out));
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ['--experimental-sqlite', '--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'live', AUTH_ENABLED: 'true' },
    encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 120_000,
  });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 0, `자식 프로세스 실패: ${(r.stderr || '').slice(-2000)}`);
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, `출력 없음: ${r.stdout.slice(-1000)} ${r.stderr.slice(-1000)}`);
  const o = JSON.parse(line.slice(2));
  assert.deepEqual(o.sheetRow, { ownerType: 'host', vcenterId: 'vc-n' }, 'IP 대장은 이 IP 를 범위 안 호스트 행으로 보여 준다');
  assert.equal(o.probeIn.s, 200, `수정 전: 403 — ${JSON.stringify(o.probeIn.j)}`);
  assert.doesNotMatch(String(o.probeIn.j?.reason || ''), REASON, '범위 판정을 통과했다(프록시 미설정 사유만 남는다)');
  assert.equal(o.probeOut.s, 403, '범위 밖 호스트 관리 IP');
  assert.equal(o.probeConflict.s, 403, '범위 밖 호스트와 겹치는 관리 IP');
  assert.notEqual(o.probeOddForm.s, 200, '비정규 표기 대상(10.20.0.011)은 통과하지 않는다');
  assert.equal(o.quickOut, 403);
  assert.equal(o.quickIn, 200, '수정 전: 403');
  assert.equal(o.wsOwner, null, 'WS 게이트웨이 재검사(소유 operator)도 같은 판정');
  assert.equal(o.wsScopedAdmin, null, 'WS 게이트웨이 재검사(범위 admin)도 같은 판정');
  assert.equal(o.sadmMapOut, 403, '범위 admin 의 상시 매핑 — 범위 밖 관리 IP 거부');
  assert.equal(o.sadmMapConflict, 403, '범위 admin 의 상시 매핑 — 충돌 IP 거부');
  assert.equal(o.fullProbeOut, 200, '전체 범위 계정은 예전 그대로');
});

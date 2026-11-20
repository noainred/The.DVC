/**
 * 165회차 — 163회차(본문 값 강제 변환 500 → 자리별 400) · 164회차(긴급중단 동안의 수집 · 기록)의 반증에서 확정된 것.
 *  G  게이트 순서(163): 모양 검사가 **소유자 등급 판정(403)보다 앞**에 놓여, 등급이 아닌 관리자의 RMA 배포 · 위험 실행 요청이 본문 모양에 따라 403 대신 400(칸 이름)을 받았다.
 *     대역 용도 저장도 범위 판정(403)보다 앞이었다. 순서는 등급 · 범위(403) → 모양(400) → OTP.
 *  L  덜 고친 자리(163): 163 의 '수정 전 500 표' 에 있던 두 자리(ipam/bulk ips · guest-partition/mail/test to)가 그대로 500 이었고,
 *     163 이 문지기를 단 라우트의 **옆 칸**은 문지기 칸이 정상이면 여전히 500 이었다(163 의 퍼징은 칸 하나만 넣고 나머지를 비워 앞 검사에서 400 으로 끝났다).
 *  R  읽는 쪽(163): 163 이전 판이 저장해 둔 틀린 모양은 그대로 던졌다 — 네트워크 모니터 목록은 늘 500 이고 지울 수도 없었고, 중계 배정은 전 사용자 원격 접속을 500 으로 만들었다.
 *  S  긴급중단 표지(164): 게스트 디스크 폴러의 '긴급중단으로 멈춤' 표지가 해제 뒤에도 남았다(다음 실제 수집이 지우는데 주기가 길고, 꺼져 있으면 주기 수집이 없다).
 *  P  반증 실패 고정(164): 해제 뒤 **실제 store.refresh** 가 스냅샷 만든 시각을 다시 찍어 보류가 풀린다(목 모드 — 164 시험은 손으로 만든 스냅샷만 썼다).
 * 실제 라우터(adminRouter · api · remoteRouter · insightsRouter)를 index.js 순서(queryNormalizer → express.json → 사용자 → 라우터)로 띄운다. 로그인은 켠 채(등급 · 범위 판정이 돌게) 요청마다 계정을 싣는다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'rebut165-'));
Object.assign(process.env, { CONFIG_DIR: DIR, DB_DIR: DIR, AUTH_ENABLED: 'true', DATA_SOURCE: 'mock', API_RATE_DISABLED: 'true',
  IPAM_WRITE_WORKER: '0' });   // P 가 실제 store.refresh 를 돌린다 — 원장 쓰기 워커가 시험 끝의 임시 폴더 정리와 겹치지 않게 주 스레드에서 쓴다
delete process.env.CENTRAL_URL;

const TRAP = { toString: 1 };   // String() · 템플릿 · Number() 가 던지는 값(JSON 으로 만들 수 있다)

const { generateSecret } = await import('../src/auth/totp.js');
fs.writeFileSync(path.join(DIR, 'users.json'), JSON.stringify({ users: [
  { username: 'own', role: 'admin' }, { username: 'fadm', role: 'admin' }, { username: 'sadm', role: 'admin', scope: { vcenters: ['vc-1'] } },
  { username: 'otpu', role: 'admin', totpEnabled: true, totpSecret: generateSecret() },
] }));
fs.writeFileSync(path.join(DIR, 'security-session.json'), JSON.stringify({ settingsOwners: ['own'] }));
// R: 163 이전 판이 받아 저장하던 모양 그대로(모듈을 올리기 전에 둔다)
fs.writeFileSync(path.join(DIR, 'capture-monitors.json'), JSON.stringify([
  { id: 'mon_ok1', name: '정상', enabled: false, mode: 'single', intervalMin: 10, iface: 'any', seconds: 10, maxPackets: 1000, hostA: { host: '10.0.0.1', username: 'u' }, hostB: {}, peer: '10.0.0.2' },
  { id: TRAP, name: '오염-id', enabled: false, mode: 'single', intervalMin: 10, iface: 'any', seconds: 10, maxPackets: 1000, hostA: { host: '10.0.0.3' }, hostB: {}, peer: '' },
  { id: 'mon_bad2', name: '오염-계정', enabled: false, mode: 'dual', intervalMin: 10, iface: 'any', seconds: 10, maxPackets: 1000, hostA: { host: '10.0.0.4', username: TRAP }, hostB: { host: '10.0.0.5', password: TRAP }, peer: '' },
]));
fs.writeFileSync(path.join(DIR, 'remote-access.json'), JSON.stringify({ proxies: [
  { id: 'p165num', name: '오염-수', proxyHost: '10.0.0.5', vcenterIds: 5 },
  { id: 'p165obj', name: '오염-객체', proxyHost: '10.0.0.6', vcenterIds: { a: 1 } },
  { id: 'p165str', name: '옛 글자', proxyHost: '10.0.0.7', vcenterIds: 'OC2, OC3' },
  { id: 'p165ok', name: '정상', proxyHost: '10.0.0.8', vcenterIds: ['vc-9'] },
] }));

const express = (await import('express')).default;
const { queryNormalizer } = await import('../src/util/queryNormalize.js');
const { store } = await import('../src/store.js');
const USERS = {
  own: { username: 'own', role: 'admin' },                                   // 설정 소유자 등급(전체 범위)
  fadm: { username: 'fadm', role: 'admin' },                                 // 전체 범위 관리자 — 소유자 등급 아님
  sadm: { username: 'sadm', role: 'admin', scope: { vcenters: ['vc-1'] } },  // 범위 관리자
  otpu: { username: 'otpu', role: 'admin' },                                 // OTP 를 등록한 전체 범위 관리자(own · fadm 은 등록하지 않았다)
};
const setInventory = () => {
  store.snapshot = { generatedAt: new Date().toISOString(), source: 'mock', vcenters: [{ id: 'vc-1', name: 'Seoul', status: 'connected' }, { id: 'vc-2', name: 'Warsaw', status: 'connected' }],
    hosts: [], datastores: [], vms: [], alarms: [], networks: [] };
};
setInventory();
const { adminRouter } = await import('../src/routes/admin.js');
const { api } = await import('../src/routes/api.js');
const { remoteRouter } = await import('../src/routes/remote.js');
const { insightsRouter } = await import('../src/routes/insights.js');

const app = express();
app.use(queryNormalizer());
app.use(express.json());
app.use((req, _res, next) => { if (req.headers['x-u']) req.user = USERS[req.headers['x-u']] || null; next(); });
app.use('/api/admin', adminRouter);
app.use('/api/remote', remoteRouter);
app.use('/api/insights', insightsRouter);
app.use('/api', api);
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => res.status(Number(err?.status) || 500).json({ ok: false, error: 'internal error' }));
const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const PORT = srv.address().port;
test.after(() => { srv.close(); try { fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* 정리 실패는 시험 결과가 아니다 */ } });

function send(user, method, url, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: PORT, path: url, method, headers: { 'x-u': user, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) } }, (res) => {
      let t = ''; res.setEncoding('utf8'); res.on('data', (c) => { t += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch { /* */ } resolve({ status: res.statusCode, body: j }); });
    });
    req.setTimeout(20_000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (data) req.write(data); req.end();
  });
}
const notText = (r, field, what) => {
  assert.equal(r.status, 400, `${what}: 400 이어야 한다(받은 것 ${r.status} ${JSON.stringify(r.body).slice(0, 160)})`);
  assert.equal(r.body?.code, 'not-text', `${what}: code`);
  assert.equal(r.body?.field, field, `${what}: 칸 이름`);
};

test('G — 등급 · 범위 판정(403)이 모양 검사(400)보다 먼저: 등급이 아닌 계정은 본문 모양과 무관하게 403', async () => {
  // 소유자 등급이 아닌 전체 범위 관리자 — 163 이전처럼 403(칸 이름을 돌려주지 않는다)
  for (const [url, body] of [
    ['/api/tools/rma/deploy', { host: TRAP, username: 'root' }],
    ['/api/tools/rma/deploy/remove', { host: TRAP, username: 'root', name: 'a' }],
    ['/api/tools/rma/run', { agent: TRAP, cmd: 'custom', args: { command: 'id' } }],
  ]) {
    const r = await send('fadm', 'POST', url, body);
    assert.equal(r.status, 403, `${url}: 등급이 아닌 계정은 403(받은 것 ${r.status} ${JSON.stringify(r.body).slice(0, 120)})`);
    assert.equal(r.body?.requiredOwner, true, `${url}: 소유자 등급 사유`);
    assert.equal(r.body?.field, undefined, `${url}: 칸 이름을 싣지 않는다`);
  }
  // 소유자 등급 — 모양이 틀리면 OTP 를 묻기 전에 400(163 그대로)
  notText(await send('own', 'POST', '/api/tools/rma/deploy', { host: TRAP, username: 'root' }), 'host', '소유자 배포');
  notText(await send('own', 'POST', '/api/tools/rma/deploy/remove', { host: TRAP, username: 'root', name: 'a' }), 'host', '소유자 제거');
  notText(await send('own', 'POST', '/api/tools/rma/run', { agent: TRAP, cmd: 'custom', args: { command: 'id' } }), 'agent', '소유자 위험 실행');
  // 위험하지 않은 프리셋은 등급을 묻지 않는다 — 등급이 아닌 관리자도 모양 오류는 400
  notText(await send('fadm', 'POST', '/api/tools/rma/run', { agent: TRAP, cmd: 'uptime' }), 'agent', '읽기 프리셋');
  notText(await send('fadm', 'POST', '/api/tools/rma/run', { agent: 'edge-1', cmd: TRAP }), 'cmd', '등급을 정하는 값');
  // 대역 용도 — 범위 계정은 403 이 먼저(163 은 base 검사를 앞에 둬 400 이었다)
  const s = await send('sadm', 'PUT', '/api/tools/ipam/subnet-note', { base: TRAP });
  assert.equal(s.status, 403, `범위 계정의 대역 용도 저장은 403(받은 것 ${s.status})`);
  assert.equal(s.body?.field, undefined);
  // 복원 검증 실행 — OTP 를 등록하지 않은 계정은 등록 안내(403)가 먼저 · 등록한 계정의 모양 오류는 400
  const n = await send('own', 'POST', '/api/tools/bareos-backup/rehearsal/run', { directorId: TRAP });
  assert.equal(n.status, 403, `OTP 미등록 계정의 복원 검증은 403(받은 것 ${n.status} ${JSON.stringify(n.body).slice(0, 120)})`);
  assert.equal(n.body?.needEnroll, true);
  notText(await send('otpu', 'POST', '/api/tools/bareos-backup/rehearsal/run', { directorId: TRAP }), 'directorId', '등록 계정의 복원 검증');
});

// [계정, 메서드, 경로, 정상 기준 본문, 덫을 넣을 칸들]
const dcBody = () => ({ id: `zz165-${Math.random().toString(36).slice(2, 8)}`, name: 'ZZ165' });
const LEFT = [
  ['POST', '/api/tools/ipam/bulk', () => ({ ips: ['10.250.1.10'], status: 'reserved' }), ['ips', 'status', 'owner', 'label', 'purpose', 'requester', 'assigner', 'deviceType', 'hostnameOverride', 'note', 'reservedUntil']],
  ['POST', '/api/tools/guest-partition/mail/test', () => ({}), ['to']],
  ['PUT', '/api/admin/security/guest-scans', () => ({ type: 'login-fails', vcenterId: 'vc-1', os: 'all', intervalMin: 60, days: 1, maxVms: 5, enabled: false }), ['name']],
  ['POST', '/api/admin/datacenters', dcBody, ['region', 'note']],
  ['PUT', '/api/admin/idrac/scan-ranges', () => ({ datacenterId: 'zz165dc', ranges: '10.250.4.0/28', username: 'root', enabled: false }), ['id', 'service', 'username', 'password', 'agent', 'iloUsername', 'iloPassword']],
  ['POST', '/api/tools/focus-mon/targets', () => ({ name: 'zz165t', host: '10.250.1.6', username: 'root' }), ['agent', 'port', 'group', 'corp']],
  ['PUT', '/api/tools/ipam/subnet-note', () => ({ base: '10.250.1', purpose: 'p', desc: 'd' }), ['base', 'purpose', 'desc']],
  ['PUT', '/api/tools/ipam/annotation', () => ({ ip: '10.250.1.10', memo: 'm', tags: ['t'] }), ['memo', 'tags']],
  ['POST', '/api/tools/ipam/policies', () => ({ spec: '10.251.0.0/28' }), ['status', 'priority', 'owner', 'label', 'deviceType', 'note']],
  ['POST', '/api/tools/pdu/devices', () => ({ name: 'zz165pdu', host: '10.250.1.3', username: 'apc' }), ['username', 'sshPort']],
  ['POST', '/api/tools/pdu/test', () => ({ name: 'zz165pdu', host: '10.250.1.3', username: 'apc' }), ['username', 'sshPort']],
  ['PUT', '/api/insights/fleet/tag', () => ({ key: 'zz165k' }), ['tag']],
];

test('L — 163 이 남긴 자리(표에 있던 두 곳 + 문지기 칸이 정상일 때의 옆 칸): 객체는 400 · 그 칸 이름', async () => {
  let n = 0;
  for (const [method, url, base, fields] of LEFT) {
    for (const f of fields) {
      for (const trap of [TRAP, { toString: null, valueOf: null }]) {
        notText(await send('own', method, url, { ...base(), [f]: trap }), f, `${method} ${url} ${f}`);
        n++;
      }
    }
  }
  assert.ok(n >= 80, `본 쌍 ${n}`);
  // 대역 정책 수정(PUT)도 생성과 같은 옆 칸 — 있는 정책에서
  const made = await send('own', 'POST', '/api/tools/ipam/policies', { spec: '10.252.0.0/28', status: 'reserved' });
  assert.equal(made.status, 200, `정책 생성 ${JSON.stringify(made.body).slice(0, 160)}`);
  const pid = made.body?.policy?.id;
  assert.ok(pid, '정책 id');
  for (const f of ['status', 'priority', 'owner', 'label', 'deviceType', 'note']) {
    notText(await send('own', 'PUT', `/api/tools/ipam/policies/${encodeURIComponent(pid)}`, { [f]: TRAP }), f, `정책 수정 ${f}`);
  }
});

test('L — 화면이 보내는 모양은 그대로 받는다(새 검사가 정상 요청을 막지 않는다 — 목록 칸 포함)', async () => {
  const ok = (r, what, want = [200, 201]) => {
    assert.ok(want.includes(r.status), `${what}: ${want.join('/')} 이어야 한다(받은 것 ${r.status} ${JSON.stringify(r.body).slice(0, 200)})`);
    assert.notEqual(r.body?.code, 'not-text', what);
  };
  ok(await send('own', 'POST', '/api/tools/ipam/bulk', { ips: ['10.250.1.20', '10.250.1.21'], status: 'reserved', owner: 'o', label: 'l', purpose: 'p', requester: 'r', assigner: 'a', deviceType: '', hostnameOverride: '', claimedVcenterId: '', note: 'n', reservedUntil: null }), '일괄 편집(목록)');
  ok(await send('own', 'POST', '/api/tools/ipam/bulk', { ips: '10.250.1.22 10.250.1.23', status: 'reserved' }), '일괄 편집(글자)');
  ok(await send('own', 'POST', '/api/tools/guest-partition/mail/test', { to: ['a@example.com'] }), '메일 시험(목록)');   // 메일 발송이 꺼져 있어 보내지 않는다(ok:false · state skipped)
  ok(await send('own', 'PUT', '/api/tools/ipam/annotation', { ip: '10.250.1.20', memo: '메모', tags: ['t1', 't2'] }), '메모(태그 목록)');
  ok(await send('own', 'PUT', '/api/tools/ipam/annotation', { ip: '10.250.1.21', memo: '메모', tags: 't1, t2' }), '메모(태그 글자)');
  ok(await send('own', 'PUT', '/api/tools/ipam/subnet-note', { base: '10.250.1', purpose: '운영', desc: '설명' }), '대역 용도');
  ok(await send('own', 'POST', '/api/tools/ipam/policies', { spec: '10.253.0.0/28', status: 'reserved', priority: 100, claimedVcenterId: '', owner: 'o', label: 'l', deviceType: '', note: 'n', enabled: true }), '대역 정책');
  ok(await send('own', 'POST', '/api/admin/datacenters', { id: 'zz165ok', name: 'ZZ', region: 'kr', note: '비고' }), '법인 등록');
  ok(await send('own', 'PUT', '/api/admin/idrac/scan-ranges', { id: undefined, datacenterId: 'zz165ok', service: '', ranges: '10.250.4.0/28', username: 'root', agent: '', dispatch: 'poll', enabled: false, mode: 'merge', iloUsername: '' }), '스캔 대역');
  ok(await send('own', 'POST', '/api/tools/focus-mon/targets', { name: 'zz165ok', host: '10.250.1.7', port: 22, username: 'dvcmon', agent: '', group: '' }), '집중 모니터링 대상');
  ok(await send('own', 'POST', '/api/tools/pdu/devices', { id: '', name: 'zz165okpdu', host: '10.250.1.8', username: 'apc', password: '', sshPort: 22, datacenterId: '', agent: '', enabled: true, note: '' }), 'PDU 등록');
  ok(await send('own', 'PUT', '/api/insights/fleet/tag', { key: 'zz165ok', tag: '' }), '서버 분류 해제');
  ok(await send('own', 'PUT', '/api/admin/security/guest-scans', { name: '조사', type: 'login-fails', vcenterId: 'vc-1', os: 'all', intervalMin: 60, days: 1, maxVms: 5, enabled: false }), '게스트 조사 예약');
});

test('R — 163 이전 판이 저장해 둔 틀린 모양: 네트워크 모니터 목록이 열리고(500 아님) 그 항목을 지울 수 있다', async () => {
  const r = await send('own', 'GET', '/api/admin/net/monitors');
  assert.equal(r.status, 200, `목록(받은 것 ${r.status} ${JSON.stringify(r.body).slice(0, 160)})`);
  const rows = r.body.monitors;
  assert.equal(rows.length, 3, '세 항목 모두 보인다(버리지 않는다)');
  for (const m of rows) assert.equal(typeof m.id, 'string', `id 는 글자(${JSON.stringify(m.id)})`);
  const healed = rows.find((m) => m.name === '오염-id');
  assert.match(healed.id, /^mon_fix[0-9a-f]{8}$/, '글자가 아니던 id 는 새 글자 id');
  assert.equal(rows.find((m) => m.name === '정상').id, 'mon_ok1', '정상 항목의 id 는 그대로');
  assert.equal(rows.find((m) => m.name === '오염-계정').id, 'mon_bad2');
  const d = await send('own', 'DELETE', `/api/admin/net/monitors/${encodeURIComponent(healed.id)}`);
  assert.equal(d.body?.ok, true, '고친 id 로 지워진다');
  const after = await send('own', 'GET', '/api/admin/net/monitors');
  assert.deepEqual(after.body.monitors.map((m) => m.name).sort(), ['오염-계정', '정상']);
  // 지운 뒤 파일에는 고친 모양만 남는다(접속 칸의 객체는 비움)
  const saved = JSON.parse(fs.readFileSync(path.join(DIR, 'capture-monitors.json'), 'utf8'));
  const bad2 = saved.find((m) => m.id === 'mon_bad2');
  assert.equal(bad2.hostA.username, '');
  assert.equal(bad2.hostB.password, '');
});

test('R — 163 이전 판이 저장해 둔 배열이 아닌 중계 배정: 중계 고르기가 던지지 않는다(전 사용자 원격 접속 500 이었다)', async () => {
  const { resolveProxy } = await import('../src/proxy/registry.js');
  assert.equal(resolveProxy('vc-1').id, 'default', '배정이 없으면 기본 중계');
  assert.equal(resolveProxy('vc-9').id, 'p165ok', '정상 배열 배정은 그대로');
  assert.equal(resolveProxy('OC2').id, 'p165str', '예전에도 던지지 않던 글자 배정은 그대로');
  assert.equal(resolveProxy(undefined).id, 'default');
  const r = await send('own', 'POST', '/api/remote/probe', { vcenterId: 'vc-1', targetHost: '10.9.9.9', targetPort: 22 });
  assert.equal(r.status, 200, `점검 라우트(받은 것 ${r.status} ${JSON.stringify(r.body).slice(0, 160)})`);   // 중계 SSH 설정이 없어 ok:false · method none — 밖으로 나가지 않는다
  assert.equal(r.body?.method, 'none');
});

test('S — 게스트 디스크 폴러: 긴급중단 표지는 긴급중단이 풀리면 끝난다(다음 실제 수집을 기다리지 않는다)', async () => {
  const ES = await import('../src/security/emergencyStop.js');
  const GD = await import('../src/guestdisk/poller.js');
  const { pollerCheck } = await import('../src/health/services.js');
  const row = () => pollerCheck(GD.guestDiskPollerStatus(), { uptimeMs: 48 * 3_600_000 });
  try {
    ES.setEmergencyStop(true, ['a', 'b']);
    const r = await GD.runGuestDiskNow('manual');
    assert.equal(r.emergencyStop, true, '긴급중단 중 수동 실행은 멈춘다(164)');
    assert.equal(GD.guestDiskPollerStatus().emergencyStop, true);
    assert.match(row().detail, /긴급중단으로 멈춤/, '중단 중에는 의도한 정지로 보인다(164)');
    ES.setEmergencyStop(false, ['a', 'b']);
    const st = GD.guestDiskPollerStatus();
    assert.equal(st.emergencyStop, undefined, '해제 뒤에는 표지가 없다');
    assert.equal(st.emergencyStopAt, undefined);
    assert.doesNotMatch(row().detail, /긴급중단/, '해제 뒤 서비스 점검이 긴급중단이라고 말하지 않는다');
    // 다시 켜도 지난 표지가 되살아나지 않는다(새로 멈춘 시도가 있어야 생긴다)
    ES.setEmergencyStop(true, ['a', 'b']);
    assert.equal(GD.guestDiskPollerStatus().emergencyStop, undefined);
  } finally { ES.setEmergencyStop(false, ['a', 'b']); }
});

test('P — 반증 실패 고정: 해제 뒤 실제 store.refresh 가 만든 시각을 다시 찍어 보류가 풀린다(목 모드 — 영영 보류되지 않는다)', async () => {
  const ES = await import('../src/security/emergencyStop.js');
  const S = await import('../src/metrics/sampler.js');
  try {
    await store.refresh();
    assert.ok(store.get().vcenters.length > 0, '목 인벤토리');
    assert.equal(S.snapshotFrozenByStop(store.get()), false);
    ES.setEmergencyStop(true, ['a', 'b']);
    const g0 = store.get().generatedAt;
    await store.refresh();
    assert.equal(store.get().generatedAt, g0, '긴급중단 중에는 스냅샷이 그대로');
    assert.equal(S.snapshotFrozenByStop(store.get()), true);
    ES.setEmergencyStop(false, ['a', 'b']);
    assert.equal(S.snapshotFrozenByStop(store.get()), true, '푼 직후(다음 병합 전)는 아직 얼어 있다(162 · 164)');
    for (let i = 0; i < 50 && Date.parse(store.get().generatedAt) <= ES.getEmergencyStatus().at; i++) await store.refresh();   // 같은 밀리초에 찍히면 한 번 더(시계에 기대지 않는다)
    assert.notEqual(store.get().generatedAt, g0, '해제 뒤 병합이 만든 시각을 새로 찍는다');
    assert.equal(S.snapshotFrozenByStop(store.get()), false, '병합 뒤에는 풀린다');
  } finally { ES.setEmergencyStop(false, ['a', 'b']); setInventory(); }
});

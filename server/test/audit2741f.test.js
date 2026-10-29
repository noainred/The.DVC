/**
 * audit2741f.test.js — v2.741 감사 수정 그룹 GE(SSH 수집기 예산 · 인증 실패 판정 · GPU 게스트) 회귀.
 *
 *  · DEV-01  인증 실패 판정(`util/authGuard.js isAuthFailureText`)이 호스트명·포트·명령 경로 속 '-401'/'-403' 을 HTTP 상태로
 *            읽어 DNS 실패·시한 초과에도 주기 수집을 영구 정지시키던 것. 숫자는 HTTP 상태 문맥이 있을 때만 인증 실패다.
 *  · DEV-02  SAN 스위치(fosSsh)·Isilon SSH 수집에 세션 예산이 없어, 명령 시한 합이 장비 시한을 넘으면 이미 받은 결과까지
 *            통째로 버리던 것(v2.528 Unity 회귀와 같은 유형). 가짜 SSH 서버로 실제 수집기를 돌리고, 예산 산수를 고정한다.
 *  · DEV-04  GPU 게스트 수집이 nvidia-smi 의 드라이버 실패 문장(stdout)을 '출력이 비어 있음(stdout 없음)' 으로 보고하던 것.
 *
 * ⚠ 환경 변수(명령 시한 1초)는 모듈 로드 시 굳으므로 **프로젝트 모듈은 전부 아래에서 동적 import** 한다.
 *   기본값 산수는 이 축척의 영향을 받지 않게 **깨끗한 환경의 자식 프로세스**로 실제 모듈을 읽어 확인한다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync, execFile } from 'node:child_process';
import { createRequire } from 'node:module';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2741f-'));
process.env.CONFIG_DIR = TMP;
process.env.SSH_HOSTKEY_POLICY = 'observe';
process.env.SSRF_ALLOW_LOOPBACK = 'true';
process.env.SANSW_CLI_TIMEOUT_MS = '1000';   // SAN 명령 시한 45초 → 1초로 축척
process.env.SSH_EXEC_TIMEOUT_MS = '1000';    // SSH exec 기본 시한 60초 → 1초로 축척(Isilon 부가 명령)
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

const SRC = new URL('../src/', import.meta.url);
const require = createRequire(import.meta.url);
const ssh2 = require('ssh2');
// ⚠ ssh2 의 ed25519 생성기는 자기 파서가 거부하는 키를 0.5% 만든다(v2.590 릴리스 CI 사고) — EC SEC1 PEM 을 쓴다.
const HOST_KEY = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'sec1', format: 'pem' });

/** 명령별로 응답하거나(문자열) 응답하지 않는(null) 가짜 SSH 서버. */
async function fakeSsh(respond) {
  const seen = [];
  const srv = new ssh2.Server({ hostKeys: [HOST_KEY] }, (client) => {
    client.on('authentication', (ctx) => ctx.accept());
    client.on('error', () => {});
    client.on('ready', () => client.on('session', (accept) => {
      const s = accept();
      s.on('exec', (acc, _rej, info) => {
        const ch = acc(); const cmd = info.command; seen.push(cmd);
        const out = respond(cmd);
        if (out == null) return; // 장비가 느린 명령 — 응답하지 않는다(클라이언트 시한까지 매달린다)
        ch.write(out); ch.exit(0); ch.end();
      });
    }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, seen, close: () => new Promise((r) => srv.close(() => r())) };
}

/* ══════════════════════ DEV-01 — 숫자 401·403 은 HTTP 상태 문맥이 있을 때만 ══════════════════════ */

test('DEV-01 ① 호스트명·포트·경로 속 401/403 은 인증 실패가 아니다(일시 장애가 수집을 영구 정지시키지 않게)', async () => {
  const { isAuthFailureText } = await import(new URL('util/authGuard.js', SRC));
  const { duCommand } = await import(new URL('isidu/parse.js', SRC));
  const MUST_NOT_STOP = [
    'getaddrinfo ENOTFOUND unity-401.corp.example',
    'connect ETIMEDOUT unity-403.corp.example:443',
    'connect ECONNREFUSED 10.0.0.5:401',                 // 포트 401
    'connect ECONNREFUSED 10.0.0.5:403',
    'SSH 수집 실패: Timed out while waiting for handshake (host san-401)',
    'getaddrinfo ENOTFOUND http-401.corp',                // 'HTTP' 낱말 + 하이픈
    'getaddrinfo EAI_AGAIN status-403.lab',               // 'status' 낱말 + 하이픈
    'getaddrinfo ENOTFOUND 401.corp',
    `SSH exec 타임아웃(7200s): ${duCommand('/ifs/data/proj-401/users', 'h')}`,
    `SSH exec 출력 상한(4096KB) 초과: ${duCommand('/ifs/data/403/archive', 'h')}`,
  ];
  for (const s of MUST_NOT_STOP) assert.equal(isAuthFailureText(s), false, `멈추면 안 됨: ${s}`);
});

test('DEV-01 ② 진짜 HTTP 401/403 문구는 그대로 인증 실패다(이 저장소 생산자가 쓰는 꼴)', async () => {
  const { isAuthFailureText } = await import(new URL('util/authGuard.js', SRC));
  const MUST_STOP = [
    'HTTP 401', 'HTTP 403', 'HTTP 403 — forbidden',                       // restCommon httpFailMessage · isilon REST
    'login HTTP 401',                                                     // fosRest
    'HTTP/1.1 401 Unauthorized', '401 Unauthorized', '403 Forbidden', '401 Authorization Required',
    'Request failed with status code 401', 'status: 403', 'status=401',
    'Redfish /redfish/v1/Systems -> 403 Forbidden', 'OME /api/SessionService/Sessions -> 401 ',  // redfish.js · ome.js
    '인증 실패(401) — 계정/비밀번호 확인', 'All configured authentication methods failed',
  ];
  for (const s of MUST_STOP) assert.equal(isAuthFailureText(s), true, `멈춰야 함: ${s}`);
});

test('DEV-01 ③ 실제 문구 생산자(describeFetchError · sshFailureSnapshot)로 만든 스냅샷이 인증 정지 대상이 아니다', async () => {
  const { describeFetchError } = await import(new URL('storage/collectors/netError.js', SRC));
  const { sshFailureSnapshot } = await import(new URL('storage/collectors/cliSsh.js', SRC));
  const { isAuthFailure } = await import(new URL('storage/authGuard.js', SRC));
  for (const code of ['ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH']) {
    for (const host of ['unity-401.lab.example', 'array-403', 'ps-403.corp']) {
      const e = new TypeError('fetch failed', { cause: Object.assign(new Error(`connect ${code} ${host}`), { code }) });
      const msg = describeFetchError(e, { host, port: 443, timeoutMs: 30_000 });
      assert.equal(isAuthFailure({ ok: false, error: msg, sections: { capacity: `오류: ${msg}` } }), false, `${code} ${host}: ${msg}`);
    }
  }
  // 시한 갈래(TimeoutError) — 포트 403 으로 등록된 장비
  const te = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  assert.equal(isAuthFailure({ ok: false, error: describeFetchError(te, { host: 'unity-401', port: 403, timeoutMs: 15_000 }) }), false);
  // SSH 이름 해석 실패 — ssh2 는 호스트명을 문구에 싣는다
  const dns = Object.assign(new Error('getaddrinfo ENOTFOUND unity-401.lab.example'), { code: 'ENOTFOUND' });
  const snap = sshFailureSnapshot({ id: 'u1', type: 'unity480', name: 'u', host: 'unity-401.lab.example' }, dns);
  assert.equal(isAuthFailure(snap), false, snap.error);
  // 대조 — 진짜 SSH 인증 거부는 여전히 정지 대상
  const authErr = Object.assign(new Error('All configured authentication methods failed'), { level: 'client-authentication' });
  assert.equal(isAuthFailure(sshFailureSnapshot({ id: 'u1', type: 'unity480', host: 'unity-401' }, authErr)), true);
});

/* ══════════════════════ DEV-02 — SSH 세션 예산(SAN fosSsh · Isilon) ══════════════════════ */

const SAN_CMDS = 'switchshow chassisshow firmwareshow licenseshow porterrshow sfpshow switchstatusshow fanshow psshow nsshow cfgshow sensorshow errdump bottleneckmon fabricshow islshow trunkshow lsan';
const SAN_SLOW = new Set(['cfgshow', 'errdump', 'bottleneckmon --show', 'fabricshow', 'islshow']);
const SWITCHSHOW = 'switchName: sw-demo\nswitchState: Online\nIndex Port Address Media Speed State Proto\n==================================================\n  0   0   010000   id    N16   Online      FC  F-Port  10:00:00:00:00:00:00:01\n';

test('DEV-02 ① SAN: 느린 명령이 장비 시한을 넘게 쌓여도 세션이 예산 안에서 끝나 앞 결과(switchshow 등)를 지킨다', async () => {
  const fos = await import(new URL('sanswitch/collectors/fosSsh.js', SRC));
  const { withDeadline } = await import(new URL('proxy/sshExec.js', SRC));
  const srv = await fakeSsh((c) => {
    if (c === 'echo $PATH') return '/fabos/bin\n';
    if (c.startsWith('ls ')) return SAN_CMDS.split(' ').join('\n') + '\n';
    if (SAN_SLOW.has(c)) return null;
    return c === 'switchshow' ? SWITCHSHOW : `${c} output\n`;
  });
  try {
    const dev = { id: 'sw-budget', type: 'brocade', host: '127.0.0.1', sshPort: srv.port, username: 'admin', password: 'x' };
    // 축척: 명령 시한 1초 · 장비 시한 3.5초 · 세션 예산 2초. 느린 명령 5개 × 1초 = 5초라 예산이 없으면 장비 시한에 걸린다.
    const t0 = Date.now();
    const snap = await withDeadline(3_500, (signal) => fos.collect(dev, { signal, budgetMs: 2_000 }), '수집 타임아웃');
    const ms = Date.now() - t0;
    assert.equal(snap.ok, true, '이미 받은 결과가 살아 있어야 한다');
    assert.equal(snap.name, 'sw-demo');
    assert.equal(snap.sections.ports, 'ok');
    assert.equal(snap.sections.counters, 'ok', 'porterrshow(앞쪽 항목)는 살아야 한다');
    assert.ok(ms < 3_500, `세션이 장비 시한 안에 끝나야 한다(${ms}ms)`);
    // 시작하지 않은 항목은 사유와 함께 밝힌다(조용한 생략 금지)
    assert.ok(snap.extra.cliSkipped >= 1, `건너뛴 항목 개수: ${snap.extra.cliSkipped}`);
    assert.ok(Array.isArray(snap.extra.cliSkippedKeys) && snap.extra.cliSkippedKeys.includes('lsanshow'), JSON.stringify(snap.extra.cliSkippedKeys));
    assert.equal(snap.sections.lsan, fos.BUDGET_SKIP_REASON);
    // 예산으로 건너뛴 항목은 시작조차 하지 않았다(가짜 서버가 그 명령을 받지 않았다)
    assert.ok(!srv.seen.includes('lsan --show'), '예산으로 건너뛴 명령이 실행됐다');
  } finally { await srv.close(); }
});

test('DEV-02 ①-b SAN: 예산 끝 무렵에 시작한 명령은 남은 시간만 기다린다(명령 시한 그대로 기다리면 예산을 넘긴다)', async () => {
  // ⚠ 이 파일의 축척(명령 시한 1초)에서는 남은 시간으로 줄인 시한이 1초 아래가 되는데, sshExec 가 exec 시한을 1초 아래로
  //   내리지 않는다(execTimeoutMs 하한). 그래서 줄인 효과가 보이지 않는다 — 명령 시한 4초인 자식 프로세스에서 잰다.
  //   자식은 동기 실행(execFileSync)이면 가짜 서버(이 프로세스)가 멈추므로 비동기로 띄운다.
  //   v2.809(불안정 수정 — 2026-10-27 release CI 실패 'cfgshow 가 시작되지 않았다'): 부하가 걸린 러너에서 cfgshow 앞의 빠른 명령 약 10개가
  //   예산 3초를 다 써 cfgshow 에 닿지 못했다(이 검증의 전제 붕괴). 장비가 가진 명령을 switchshow·cfgshow·lsan 으로 좁혀 앞 명령을 없앤다.
  const srv = await fakeSsh((c) => {
    if (c === 'echo $PATH') return '/fabos/bin\n';
    if (c.startsWith('ls ')) return 'switchshow\ncfgshow\nlsan\n';
    if (SAN_SLOW.has(c)) return null;
    return c === 'switchshow' ? SWITCHSHOW : `${c} output\n`;
  });
  try {
    const BUDGET = 3_000;   // 앞 명령(접속·switchshow) 뒤 cfgshow 는 남은 시간만 기다려야 한다. 명령 시한(4초)을 다 기다리면 4초를 넘는다.
    const childDir = fs.mkdtempSync(path.join(TMP, 'slice-'));
    const env = { ...process.env, CONFIG_DIR: childDir, SANSW_CLI_TIMEOUT_MS: '4000' };
    delete env.SSH_EXEC_TIMEOUT_MS;
    const code = `const fos = await import(${JSON.stringify(new URL('sanswitch/collectors/fosSsh.js', SRC).href)});
const dev = { id: 'sw-slice', type: 'brocade', host: '127.0.0.1', sshPort: ${srv.port}, username: 'admin', password: 'x' };
const t0 = Date.now();
const snap = await fos.collect(dev, { budgetMs: ${BUDGET} });
console.log(JSON.stringify({ ms: Date.now() - t0, name: snap.name, cmd: fos.CMD_TIMEOUT_MS, slice: fos.MIN_SLICE_MS, skipped: snap.extra?.cliSkippedKeys || [] }));`;
    const tStart = Date.now();
    const out = await new Promise((resolve, reject) => execFile(process.execPath, ['--input-type=module', '-e', code], { env, encoding: 'utf8', timeout: 30_000 },
      (err, stdout, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(stdout))));
    const r = JSON.parse(out.trim().split('\n').pop());
    assert.equal(r.cmd, 4_000); assert.equal(r.slice, 1_000);
    assert.equal(r.name, 'sw-demo');
    assert.ok(srv.seen.includes('cfgshow'), `cfgshow 가 시작되지 않았다(앞 명령이 예산을 다 썼다 — 이 검증이 무의미하다): ${JSON.stringify(srv.seen)} · 자식 ${r.ms}ms · 전체 ${Date.now() - tStart}ms`);
    assert.ok(r.ms < BUDGET + 1_000, `세션이 예산(${BUDGET}ms)을 크게 넘겼다 — 남은 시간이 아니라 명령 시한을 기다렸다: ${r.ms}ms`);
    assert.ok(r.skipped.includes('lsanshow'), JSON.stringify(r.skipped));
  } finally { await srv.close(); }
});

test('DEV-02 ② SAN: 필수 항목(switchshow)은 예산이 바닥이어도 시도한다', async () => {
  const fos = await import(new URL('sanswitch/collectors/fosSsh.js', SRC));
  const srv = await fakeSsh((c) => (c === 'echo $PATH' ? '/fabos/bin\n' : c.startsWith('ls ') ? 'switchshow\nchassisshow\n' : c === 'switchshow' ? SWITCHSHOW : `${c} output\n`));
  try {
    const dev = { id: 'sw-req', type: 'brocade', host: '127.0.0.1', sshPort: srv.port, username: 'admin', password: 'x' };
    const snap = await fos.collect(dev, { budgetMs: 1 });   // 예산 1ms — 접속하자마자 바닥
    assert.equal(snap.name, 'sw-demo', '필수 항목은 예산을 무시하고 실행한다');
    assert.equal(snap.sections.chassis, fos.BUDGET_SKIP_REASON);
    assert.ok(!srv.seen.includes('chassisshow'));
  } finally { await srv.close(); }
});

const ISI_STATUS = `Cluster Name: isi-demo
Cluster Health:     [  OK ]
Cluster Storage:  HDD                 SSD Storage
Size:             100.0T (100.0T Raw) 0 (0 Raw)
VHS Size:         0
Used:             40.0T (40%)         0 (n/a)
Avail:            60.0T (60%)         0 (n/a)

                   Health  Throughput (bps)  HDD Storage      SSD Storage
ID |IP Address     |DASR |  In   Out  Total| Used / Size     |Used / Size
---+---------------+-----+-----+-----+-----+-----------------+-----------------
  1|10.0.0.1       | OK  |  0  |  0  |  0  |20.0T/ 50.0T( 40%)|(No Storage SSDs)
  2|10.0.0.2       | OK  |  0  |  0  |  0  |20.0T/ 50.0T( 40%)|(No Storage SSDs)
`;

test('DEV-02 ③ Isilon: 부가 명령이 시한까지 매달려도 isi status 결과(용량·노드)를 지키고 건너뛴 명령을 밝힌다', async () => {
  const isi = await import(new URL('storage/collectors/isilonSsh.js', SRC));
  const { withDeadline } = await import(new URL('proxy/sshExec.js', SRC));
  const { isAuthFailure } = await import(new URL('storage/authGuard.js', SRC));
  // isi status 만 즉시 응답하고 나머지(version·users·statistics·isi_for_array)는 응답하지 않는다.
  const srv = await fakeSsh((c) => (c === 'isi status' ? ISI_STATUS : null));
  try {
    const dev = { id: 'isi-budget', type: 'isilon', name: 'isi', host: '127.0.0.1', sshPort: srv.port, username: 'root', password: 'pw' };
    // 축척: exec 기본 시한 1초 · 통계 20초 · 장비 시한 5초 · 세션 예산 1.2초. 예산이 없으면 통계 한 번(20초)에 장비 시한을 넘는다.
    const t0 = Date.now();
    const snap = await withDeadline(5_000, (signal) => isi.collectViaSsh({ ...dev, _signal: signal }, { budgetMs: 1_200 }), '수집 타임아웃');
    const ms = Date.now() - t0;
    assert.equal(snap.ok, true, snap.error);
    assert.ok(snap.capacity?.totalBytes > 0, '용량은 살아 있어야 한다');
    assert.equal(snap.nodes?.count, 2);
    assert.ok(ms < 5_000, `세션이 장비 시한 안에 끝나야 한다(${ms}ms)`);
    // 예산으로 시작하지 않은 명령을 밝힌다(개수는 Unity 와 같은 모양)
    assert.ok(snap.extra.cliSkipped >= 2, JSON.stringify(snap.extra));
    assert.ok(snap.extra.cliSkippedCmds.some((c) => c.startsWith('isi statistics')), JSON.stringify(snap.extra.cliSkippedCmds));
    assert.match(snap.sections.accounts, /^미수집\(수집 시간 예산 초과/, '계정 섹션은 실패가 아니라 미수집이다');
    assert.match(snap.extra.powerProbe?.detail || '', /예산 초과/);
    assert.equal(snap.extra.nodeSerialProbe?.reason, 'budget', '시리얼은 예산 갈래로(실패로 기억하지 않는다)');
    assert.ok(!srv.seen.some((c) => c.startsWith('isi_for_array')), '예산이 바닥이면 시리얼 명령을 시작하지 않는다');
    assert.equal(isAuthFailure(snap), false);
  } finally { await srv.close(); }
});

/** 깨끗한 환경(축척 env 없음)의 자식 프로세스에서 실제 모듈의 예산 상수를 읽는다. */
function readBudgets(extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  for (const k of ['SANSW_CLI_TIMEOUT_MS', 'SSH_EXEC_TIMEOUT_MS']) if (!(k in extraEnv)) delete env[k];
  const code = `const f = await import(${JSON.stringify(new URL('sanswitch/collectors/fosSsh.js', SRC).href)});
const i = await import(${JSON.stringify(new URL('storage/collectors/isilonSsh.js', SRC).href)});
const s = await import(${JSON.stringify(new URL('proxy/sshExec.js', SRC).href)});
console.log(JSON.stringify({ san: { cmd: f.CMD_TIMEOUT_MS, dev: f.DEVICE_TIMEOUT_MS, budget: f.SESSION_BUDGET_MS, slice: f.MIN_SLICE_MS },
  isi: { exec: s.execTimeoutMs(), dev: i.ISI_DEVICE_TIMEOUT_MS, budget: i.ISI_SESSION_BUDGET_MS, slice: i.ISI_MIN_SLICE_MS } }));`;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { env, encoding: 'utf8' }).trim().split('\n').pop());
}

test('DEV-02 ④ 기본값 산수 — 세션 예산 < 장비 시한, 필수 경로는 예산 안(명령을 늘리기 전에 이 산수를 볼 것)', () => {
  const d = readBudgets();
  // SAN: 장비 시한 120초 · 명령 45초 · 예산 100초
  assert.equal(d.san.dev, 120_000); assert.equal(d.san.cmd, 45_000);
  assert.ok(d.san.budget + 10_000 <= d.san.dev, `SAN 예산 ${d.san.budget} 은 장비 시한 ${d.san.dev} 보다 여유 있게 작아야 한다`);
  // 필수 경로 = 명령 조사(echo $PATH 15초 + ls 25초 — 6시간 캐시) + switchshow 한 번
  const src = fs.readFileSync(new URL('sanswitch/collectors/fosSsh.js', SRC), 'utf8');
  const probe = [...src.matchAll(/sh\.exec\((?:'echo \$PATH'|`ls [^`]*`),\s*([\d_]+)\)/g)].reduce((a, m) => a + Number(m[1].replace(/_/g, '')), 0);
  assert.equal(probe, 40_000, '명령 조사 시한이 바뀌었다 — 이 산수를 다시 볼 것');
  assert.ok(probe + d.san.cmd <= d.san.budget, `조사 ${probe} + switchshow ${d.san.cmd} 가 예산 ${d.san.budget} 을 넘는다`);
  assert.equal(d.san.slice, 5_000);
  // Isilon: 장비 시한 180초 · exec 60초 · 예산 150초(cliSsh 와 같은 env·같은 기본값)
  assert.equal(d.isi.dev, 180_000); assert.equal(d.isi.exec, 60_000);
  assert.equal(d.isi.budget, 150_000);
  assert.ok(d.isi.budget + 10_000 <= d.isi.dev, `Isilon 예산 ${d.isi.budget} 은 장비 시한 ${d.isi.dev} 보다 작아야 한다`);
  assert.ok(d.isi.exec <= d.isi.budget, '필수 isi status 시한이 예산 안이어야 한다');
  assert.equal(d.isi.slice, 5_000);
});

test('DEV-02 ⑤ 장비 시한을 줄이거나 예산을 크게 잡아도 예산은 장비 시한보다 작게 묶인다', () => {
  const small = readBudgets({ SANSW_DEVICE_TIMEOUT_MS: '30000', STORAGE_DEVICE_TIMEOUT_MS: '30000' });
  assert.ok(small.san.budget < small.san.dev, JSON.stringify(small.san));
  assert.ok(small.isi.budget < small.isi.dev, JSON.stringify(small.isi));
  const big = readBudgets({ SANSW_CLI_SESSION_BUDGET_MS: '999999', STORAGE_CLI_SESSION_BUDGET_MS: '999999' });
  assert.ok(big.san.budget < big.san.dev, JSON.stringify(big.san));
  assert.ok(big.isi.budget < big.isi.dev, JSON.stringify(big.isi));
});

/* ══════════════════════ DEV-04 — CSV 가 아닌 stdout 을 '비어 있음' 이라 말하지 않는다 ══════════════════════ */

test('DEV-04 nvidia-smi 드라이버 실패 문장(stdout)은 그 문장을 사유로 싣는다 — 비어 있다고 말하지 않는다', async () => {
  const { collectVmGpu } = await import(new URL('gpu/guestops.js', SRC));
  let OUT = ''; let ERR = '';
  const srv = http.createServer((req, res) => { res.writeHead(200); res.end(req.url.startsWith('/out') ? OUT : ERR); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const c = {
    vc: { host: '127.0.0.1' }, sc: { guestOperationsManager: 'gom' },
    retrieveObjectProps: async () => [{ props: { processManager: 'pm', fileManager: 'fm' } }],
    callRaw: async (xml) => {
      if (xml.includes('<StartProgramInGuest')) return '<returnval>123</returnval>';
      if (xml.includes('<ListProcessesInGuest')) return '<endTime>2026</endTime>';
      if (xml.includes('<InitiateFileTransferFromGuest')) {
        const isOut = /\.out<\/guestFilePath>/.test(xml);
        return `<returnval><url>http://127.0.0.1:${port}/${isOut ? 'out' : 'err'}</url><size>${Buffer.byteLength(isOut ? OUT : ERR)}</size></returnval>`;
      }
      return '';
    },
  };
  const run = async () => {
    try { await collectVmGpu(c, 'vm-1', { username: 'u', password: 'p' }, { isWindows: false, timeoutMs: 5_000 }); return null; }
    catch (e) { return e; }
  };
  try {
    for (const msg of [
      "NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver. Make sure that the latest NVIDIA driver is installed and running.",
      'Failed to initialize NVML: Driver/library version mismatch',
    ]) {
      OUT = `\n${msg}\n`; ERR = '';
      const e = await run();
      assert.ok(e, '수집은 실패여야 한다');
      assert.doesNotMatch(e.message, /비어 있음|stdout 없음/, `비어 있지 않은 stdout 을 '없다' 고 말했다: ${e.message}`);
      assert.ok(e.message.includes(msg.slice(0, 40)), `stdout 첫 줄을 사유로 실어야 한다: ${e.message}`);
      assert.equal(e.guestDiag, true);
    }
    // 대조 — stderr 가 있으면 그것이 먼저다(기존 규칙)
    OUT = 'No devices were found\n'; ERR = 'nvidia-smi: command not found\n';
    assert.match((await run()).message, /^게스트 오류: nvidia-smi: command not found/);
    // 대조 — 정말 비었으면 예전 문구 그대로
    OUT = ''; ERR = '';
    assert.match((await run()).message, /출력이 비어 있음/);
  } finally { await new Promise((r) => srv.close(() => r())); }
});

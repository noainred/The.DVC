/**
 * 2026-09-01 보안/버그 수정 회귀 테스트.
 *
 * 고정하는 결함(전부 이 저장소에서 실제로 발견된 것):
 *  B1/B2 WS 게이트웨이(sshGateway·guacdTunnel)의 `user` 가 `if (config.auth.enabled) {}`
 *        블록 '안'에서 const 로 선언돼 있어, 블록 밖의 wss.handleUpgrade(... user) 줄이
 *        ReferenceError 로 죽었다. **그 줄에 도달하는 모든 경우**가 대상이다 — 인증 off,
 *        그리고 인증 on + 토큰·OTP·권한 검사를 모두 통과한 정상 세션. 즉 권한 있는 사용자의
 *        SSH/RDP 접속이 전부 실패했다(거부 경로는 그 전에 return 하므로 영향 없음).
 *        uncaughtException 핸들러가 로그만 남기고 계속 실행하므로 겉으로는 '원격 콘솔이 그냥
 *        안 됨'으로만 보였고, 소켓이 정리되지 않아 FD 도 남았다.
 *  S3    전역 에러 핸들러 부재 — express finalhandler 는 NODE_ENV 미설정 시 'development' 로
 *        판정해 500 응답 본문에 스택 트레이스를 그대로 싣는다.
 *  S6    central 자격증명 스토어 3종이 로드 실패를 조용히 빈 값으로 넘겨(preserveCorrupt 없음)
 *        다음 저장이 온전한 원본을 영구 소거할 수 있었다.
 *  S7/S8 /api/upgrade(함대 업그레이드)·/api/ping 에 auditMiddleware 누락.
 *  B4    소스 5개가 UTF-8 을 latin-1 로 읽어 재인코딩한 모지바케 — 사용자에게 나가는 403
 *        메시지까지 깨져 있었다.
 *  B5    엣지 폴러 5종에 재진입 가드 없음(CLAUDE.md 성능 불변조건).
 *
 * CONFIG_DIR 을 임시 디렉터리로 먼저 지정한 뒤 동적 import 한다(atomicStores.test.js 와 동일 이유).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'secfix-20260901-'));
process.env.CONFIG_DIR = CFG;
// ⚠ AUTH_ENABLED=false 로 고정해야 이 결함을 재현한다 — 인증이 켜져 있고 토큰이 없으면
// 게이트웨이는 401 로 조기 return 하므로 문제의 handleUpgrade 줄까지 가지 않는다. 결함은
// **handleUpgrade 에 도달하는 모든 경우**(인증 off, 또는 인증 on + 검사 통과한 정상 세션)에
// 터졌다 — 즉 정상 사용자의 SSH/RDP 접속이 전부 실패하던 결함이다. config 는 import 시점에
// env 를 읽으므로 어떤 import 보다 먼저 설정해야 한다.
process.env.AUTH_ENABLED = 'false';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const corruptBackups = (base) => fs.readdirSync(CFG).filter((n) => n.startsWith(`${base}.corrupt.`));

// ─── B1/B2: WS 게이트웨이 upgrade 가 ReferenceError 없이 성립하는지 ─────────────────
// 예전 코드는 `user` 를 if 블록 안에서 선언해 handleUpgrade 줄에서 던졌다. 인증을 끈 상태로
// upgrade 를 보내면 그 줄에 바로 도달하므로 결함이 그대로 재현된다(수정 전 이 테스트는 실패,
// 수정 후 101 Switching Protocols).
async function upgradeAttempt(attach, pathname) {
  const server = http.createServer((_req, res) => res.end('ok'));
  attach(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const reply = await new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(
        `GET ${pathname} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n`
        + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
        + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
      );
    });
    let buf = '';
    sock.on('data', (d) => { buf += d.toString(); });
    sock.on('close', () => resolve(buf));
    sock.on('error', reject);
    setTimeout(() => { sock.destroy(); resolve(buf); }, 5_000).unref?.();
  });
  await new Promise((r) => server.close(r));
  return reply;
}

test('sshGateway: upgrade 가 101 로 성립한다(ReferenceError 로 끊기지 않음)', async () => {
  const { attachSshGateway } = await import('../src/proxy/sshGateway.js');
  const reply = await upgradeAttempt(attachSshGateway, '/api/remote/ssh');
  assert.match(reply, /^HTTP\/1\.1 101 /, `101 이어야 하는데 받은 응답: ${JSON.stringify(reply)}`);
});

test('guacdTunnel: upgrade 가 101 로 성립한다(ReferenceError 로 끊기지 않음)', async () => {
  const mod = await import('../src/proxy/guacdTunnel.js');
  const attach = mod.attachRdpGateway || mod.attachGuacdTunnel;
  assert.equal(typeof attach, 'function', 'RDP 게이트웨이 attach 함수를 찾지 못했습니다.');
  const reply = await upgradeAttempt(attach, '/api/remote/rdp');
  assert.match(reply, /^HTTP\/1\.1 101 /, `101 이어야 하는데 받은 응답: ${JSON.stringify(reply)}`);
});

test('WS 게이트웨이의 user 선언은 if 블록 밖에 있어야 한다', () => {
  for (const f of ['proxy/sshGateway.js', 'proxy/guacdTunnel.js']) {
    const s = read(f);
    assert.ok(/\n\s*let user = null;\n\s*if \(config\.auth\.enabled\)/.test(s),
      `${f}: 'let user = null;' 가 if (config.auth.enabled) 바로 앞(블록 밖)에 있어야 합니다.`);
    assert.ok(!/if \(config\.auth\.enabled\) \{[\s\S]{0,400}?\n\s*const user =/.test(s),
      `${f}: user 를 if 블록 안에서 const 로 선언하면 handleUpgrade 콜백에서 ReferenceError 가 납니다.`);
  }
});

// ─── S6: central 스토어 3종의 손상 파일 보존 ────────────────────────────────────────
test('central/assignments: 손상 파일은 .corrupt 로 보존하고 빈 목록으로 기동', async () => {
  fs.writeFileSync(path.join(CFG, 'agent-assignments.json'), '{"assignments": [{"agent":"a"', { mode: 0o600 });
  const m = await import('../src/central/assignments.js');
  assert.deepEqual(m.loadAssignments(), []);
  assert.ok(corruptBackups('agent-assignments.json').length >= 1,
    '손상 원본이 .corrupt 로 보존되지 않으면 다음 save() 가 iDRAC 자격증명 전량을 덮어씁니다.');
});

test('central/agentUsers: 손상 파일은 .corrupt 로 보존', async () => {
  fs.writeFileSync(path.join(CFG, 'central-agent-users.json'), '{"edge-1": {"users": [', { mode: 0o600 });
  await import('../src/central/agentUsers.js'); // 로드는 모듈 최상위에서 일어난다
  assert.ok(corruptBackups('central-agent-users.json').length >= 1);
});

test('central/agentGpuGuestConfig: 손상 파일은 .corrupt 로 보존', async () => {
  fs.writeFileSync(path.join(CFG, 'central-agent-gpu-guest.json'), '{"edge-1": {"vcenters":', { mode: 0o600 });
  await import('../src/central/agentGpuGuestConfig.js');
  assert.ok(corruptBackups('central-agent-gpu-guest.json').length >= 1);
});

test('central/assignments: 결과 파일도 원자적으로 쓴다', () => {
  const s = read('central/assignments.js');
  assert.ok(s.includes('atomicWriteFileSync(RESULT_FILE'),
    'agent-results.json 을 직접 writeFileSync 로 쓰면 절단본이 남아 다음 기동이 빈 값으로 시작합니다.');
});

// ─── S3 / S7 / S8: index.js 의 에러 핸들러·감사 미들웨어 ──────────────────────────────
test('index.js: 4-인자 전역 에러 핸들러가 등록되어 있다', () => {
  const s = read('index.js');
  assert.ok(/app\.use\(\(err, req, res, _?next\) =>/.test(s),
    '전역 에러 핸들러가 없으면 express finalhandler 가 500 본문에 스택 트레이스를 싣는다.');
  assert.ok(s.includes("'internal error'"), '500 응답은 내부 상세 대신 고정 문구여야 한다.');
});

test('index.js: /api/upgrade·/api/ping 에 auditMiddleware 가 걸려 있다', () => {
  const s = read('index.js');
  for (const mount of ['/api/upgrade', '/api/ping']) {
    const line = s.split('\n').find((l) => l.includes(`app.use('${mount}'`));
    assert.ok(line, `${mount} mount 를 찾지 못했습니다.`);
    assert.ok(line.includes('auditMiddleware'),
      `${mount} 는 상태변경(관리자 전용)이 있으므로 감사 추적이 필요합니다.`);
  }
});

test('packaging: systemd 유닛이 NODE_ENV=production 을 고정한다', () => {
  const unit = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'packaging', 'offline', 'vmware-portal.service'),
    'utf8',
  );
  assert.ok(/^Environment=NODE_ENV=production$/m.test(unit));
});

// ─── B5: 엣지 폴러 재진입 가드 ────────────────────────────────────────────────────
test('엣지 폴러 5종에 재진입 가드(single-flight)가 있다', () => {
  const files = [
    'agent/gpuGuestConfigPull.js', 'agent/storageConfigPull.js', 'agent/usersConfigPull.js',
    'agent/configPush.js', 'agent/gpuGuestPush.js',
  ];
  for (const f of files) {
    const s = read(f);
    assert.ok(/let running = false;/.test(s), `${f}: 재진입 가드 변수(running)가 없습니다.`);
    assert.ok(/if \(running\) return /.test(s), `${f}: running 가드로 조기 반환하지 않습니다.`);
    assert.ok(/finally \{ running = false; \}/.test(s), `${f}: finally 에서 가드를 풀지 않으면 영구 정지합니다.`);
  }
});

// ─── B7: 인시던트 일자 집계는 서버 로컬 시간 ──────────────────────────────────────────
test('insights/incidents: 일자 집계에 UTC(toISOString) 를 쓰지 않는다', () => {
  const s = read('insights/incidents.js');
  assert.ok(!/const day = new Date\(e\.ts\)\.toISOString\(\)/.test(s),
    'KST(UTC+9)에서 00~08시 인시던트가 전날 칸에 들어간다.');
  assert.ok(/function localDay\(/.test(s) && /const day = localDay\(e\.ts\)/.test(s));
});

// ─── B4: 모지바케 재발 방지 ────────────────────────────────────────────────────────
test('소스에 이중 인코딩(모지바케) 문자열이 없다', () => {
  // 모지바케는 UTF-8 바이트를 latin-1 로 읽은 결과라 항상 U+0080..U+00FF 연속 구간으로 나타나고,
  // 그 구간을 latin-1 로 되돌리면 UTF-8 로 디코딩된다. 정상 문자(× · ° é)는 디코딩에 실패하므로
  // 오탐이 아니다. 단, '15.4×·VM' 같은 우연한 2글자 조합은 디코딩에 성공할 수 있어(히브리
  // 문장부호 등) 한글이 나온 경우만 실패로 본다 — 이 저장소의 손상은 전부 한글 주석/메시지였다.
  const run = new RegExp(`[${String.fromCharCode(0x80)}-${String.fromCharCode(0xff)}]{4,}`, 'g');
  const bad = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(js|jsx|mjs)$/.test(e.name)) continue;
      const s = fs.readFileSync(p, 'utf8');
      for (const m of s.match(run) || []) {
        let decoded;
        try { decoded = Buffer.from(m, 'latin1').toString('utf8'); } catch { continue; }
        if (decoded.includes('�')) continue;      // 디코딩 실패 = 정상 문자
        if (!/[가-힣]/.test(decoded)) continue; // 한글이 나오지 않으면 판단 보류
        bad.push(`${path.relative(SRC, p)}: ${JSON.stringify(m.slice(0, 24))} → ${JSON.stringify(decoded.slice(0, 12))}`);
        break;
      }
    }
  };
  walk(SRC);
  assert.deepEqual(bad, [], `이중 인코딩된 한글이 남아 있습니다:\n${bad.join('\n')}`);
});

/**
 * UAG Monitor — Horizon UAG(Unified Access Gateway) 상태/세션 모니터.
 * Node 내장 모듈만 사용(외부 의존성 0). 하나의 코드로 세 가지 배포를 지원한다:
 *   · 서버/웹 모드 :  node server.js --host 0.0.0.0 --port 8123   (비밀번호 필수)
 *   · Windows 클라이언트 :  동봉 런처(UAG-Monitor.bat)가 127.0.0.1 로 띄우고 브라우저를 연다
 *   · macOS 클라이언트  :  동봉 런처(uag-monitor.command) — 동일
 *
 * 보안 규칙(포탈/pyportal 감사 불변조건 준수):
 *   - 127.0.0.1 외 바인딩은 비밀번호 설정 없이는 기동을 거부한다(공개 무인증 금지).
 *   - 모든 API 는 Bearer 헤더 인증(쿠키 미사용 → CSRF 표면 없음), 로그인 실패 잠금은 IP별.
 *   - 로컬 모드(인증 꺼짐)는 Host 가 루프백 이름이어야 하고, 상태 변경 API 는 교차출처 403 ·
 *     JSON 외 본문 415(lib/httpGuard.js — 임의 웹페이지의 단순 POST·DNS 리바인딩 차단, v2.689).
 *   - 등록 주소는 SSRF 가드(guard.js)를 통과해야 한다. TLS 완화는 대상별 옵션으로만.
 *   - 자격증명 파일은 0600 + 원자적 쓰기 + 손상 보존(store.js).
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fetchUagStats } from './lib/uag.js';
import { hostBlockReason } from './lib/guard.js';
import { Store } from './lib/store.js';
import { Auth, hashPassword } from './lib/auth.js';
import { createPoller } from './lib/poller.js';
import { loopbackHostOk, mutationVerdict } from './lib/httpGuard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version; }
  catch { return '0.0.0'; }
})();

/* ------------------------------- 인자 파싱 ------------------------------- */
const args = process.argv.slice(2);
const opt = { host: '127.0.0.1', port: 8123, data: '', open: false, poll: 0, setPassword: null };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--host') opt.host = args[++i];
  else if (a === '--port') { const v = Number(args[++i]); opt.port = Number.isFinite(v) && v >= 0 ? v : 8123; } // 0 = 임의 포트(데스크톱 앱용)
  else if (a === '--data') opt.data = args[++i];
  else if (a === '--open') opt.open = true;
  else if (a === '--poll') opt.poll = Number(args[++i]) || 0;
  else if (a === '--set-password') opt.setPassword = args[++i] ?? '';
  else if (a === '-h' || a === '--help') {
    console.log(`UAG Monitor v${VERSION}
사용법: node server.js [--host 127.0.0.1] [--port 8123] [--data <dir>] [--poll <초>] [--open]
        node server.js --set-password <비밀번호>   # 서버(비로컬) 모드용 접속 비밀번호 저장
환경변수: UAGMON_DATA(데이터 디렉터리), UAGMON_PASSWORD(비밀번호 해시 대신 임시 지정)`);
    process.exit(0);
  }
}

const DATA_DIR = opt.data || process.env.UAGMON_DATA || path.join(__dirname, 'data');
const store = new Store(DATA_DIR);
if (opt.poll > 0) store.settings.pollSeconds = Math.max(10, opt.poll);

if (opt.setPassword != null) {
  if (String(opt.setPassword).length < 8) { console.error('비밀번호는 8자 이상이어야 합니다.'); process.exit(1); }
  store.settings.passwordHash = hashPassword(opt.setPassword);
  store.save();
  console.log(`접속 비밀번호를 저장했습니다 → ${path.join(DATA_DIR, 'uag-config.json')} (0600)`);
  process.exit(0);
}

const isLoopback = ['127.0.0.1', '::1', 'localhost'].includes(String(opt.host));
const envPw = process.env.UAGMON_PASSWORD || '';
const passwordHash = envPw ? hashPassword(envPw) : (store.settings.passwordHash || '');
if (!isLoopback && !passwordHash) {
  console.error(`127.0.0.1 이 아닌 주소(${opt.host})로 열려면 접속 비밀번호가 필요합니다.
먼저 설정하세요:  node server.js --set-password <8자 이상 비밀번호>`);
  process.exit(1);
}
const auth = new Auth({ required: !isLoopback, passwordHash });

/* --------------------------------- 폴러 --------------------------------- */
// 재진입 가드 + 대상 변경 직후 재실행 예약 + 삭제된 대상 결과 버림 — lib/poller.js.
const poller = createPoller(store, (t) => fetchUagStats(t)); // per-target 10s 타임아웃 내장
const pollOnce = (o) => poller.pollOnce(o);
const pollTimer = setInterval(() => { pollOnce().catch(logPollError); }, Math.max(10, store.settings.pollSeconds) * 1000);
pollTimer.unref?.();
pollOnce().catch(logPollError);
function logPollError(err) { console.error(`[uagmon] 폴링 실패: ${err?.stack || err}`); }

/* ------------------------------ 정적 리소스 ------------------------------ */
const PUB = path.join(__dirname, 'public');
const STATIC = new Map([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
  ['/app.css', { file: 'app.css', type: 'text/css; charset=utf-8' }],
]);
const staticCache = new Map();
function serveStatic(res, entry) {
  let buf = staticCache.get(entry.file);
  if (!buf) { buf = fs.readFileSync(path.join(PUB, entry.file)); staticCache.set(entry.file, buf); }
  res.writeHead(200, {
    'Content-Type': entry.type,
    'Content-Length': buf.length,
    // 인라인 없이 self 리소스만 — 등록값 등 사용자 입력이 스크립트가 될 길을 막는다.
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:",
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(buf);
}

/* --------------------------------- HTTP --------------------------------- */
const json = (res, code, body) => {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length, 'X-Content-Type-Options': 'nosniff' });
  res.end(buf);
};

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    req.on('data', (d) => { total += d.length; if (total <= limit) chunks.push(d); });
    req.on('end', () => {
      if (total > limit) return resolve(null);
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

function summarize() {
  const rows = store.targets.map((t) => {
    const s = store.latest.get(t.id) || null;
    let state = 'unknown';
    if (s) {
      if (!s.ok) state = 'down';
      else if (s.overall === 'UP' || s.overall == null) state = 'up';
      else if (s.overall === 'DOWN') state = 'down';
      else state = 'warn';
    }
    return { ...store.redact(t), state, stats: s };
  });
  const up = rows.filter((r) => r.state === 'up').length;
  const problem = rows.filter((r) => r.state === 'down' || r.state === 'warn').length;
  const sessions = rows.reduce((a, r) => a + (r.stats?.ok ? (r.stats.totalSessions || 0) : 0), 0);
  return { version: VERSION, pollSeconds: store.settings.pollSeconds, polling: poller.polling, targets: rows, summary: { total: rows.length, up, problem, sessions } };
}

// 요청 핸들러의 모든 예외는 여기서 잡는다. 예전에는 async 핸들러가 try 밖에서 던지면
// (`GET //[ HTTP/1.1` → new URL() 의 ERR_INVALID_URL, 디스크 가득으로 store.save() 실패 …)
// 아무도 받지 않는 rejection 이 되어 Node 22 가 프로세스를 끝냈다 — 무인증 요청 한 줄로
// 서버가 죽었다(v2.689 B3). 원문(스택)은 콘솔에만 남기고 응답에는 싣지 않는다.
const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(`[uagmon] 요청 처리 실패 ${req.method} ${String(req.url).slice(0, 200)}: ${err?.stack || err}`);
    try {
      if (!res.headersSent) json(res, 500, { ok: false, error: '내부 오류가 발생했습니다.' });
      else res.destroy();
    } catch { /* 소켓이 이미 닫힘 */ }
  });
});

async function handle(req, res) {
  let url;
  try { url = new URL(req.url, 'http://x'); }
  catch { req.resume(); return json(res, 400, { ok: false, error: '잘못된 요청 주소' }); }
  const p = url.pathname;

  // 로컬(루프백) 모드는 인증이 꺼져 있다 — Host 가 루프백 이름이 아니면 거부한다.
  // DNS 리바인딩(공격자 도메인 → 127.0.0.1)은 브라우저가 Host 에 공격자 도메인을 싣는다.
  if (isLoopback && !loopbackHostOk(req.headers.host)) {
    req.resume();
    return json(res, 403, { ok: false, error: '허용되지 않은 Host 입니다. http://127.0.0.1:<포트> 로 접속하세요.' });
  }

  // 정적(인증 불필요 — 로그인 화면 자체)
  const st = STATIC.get(p);
  if (st && req.method === 'GET') return serveStatic(res, st);

  // 상태 변경 API — 교차출처 403 · JSON 외 본문 415(로그인 포함).
  if (p.startsWith('/api/')) {
    const v = mutationVerdict(req.method, req.headers, { loopback: isLoopback });
    if (v) { req.resume(); return json(res, v.code, { ok: false, error: v.error }); }
  }

  if (p === '/api/meta' && req.method === 'GET') {
    return json(res, 200, { ok: true, version: VERSION, authRequired: auth.required });
  }
  if (p === '/api/login' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body) return json(res, 400, { ok: false, error: '잘못된 요청 본문' });
    const r = auth.login(req.socket.remoteAddress || '?', String(body.password || ''));
    return json(res, r.ok ? 200 : 401, r);
  }

  // 이하 전 API 인증(비로컬 바인딩일 때) — Bearer 헤더만 인정.
  if (p.startsWith('/api/')) {
    if (!auth.check(req.headers.authorization)) return json(res, 401, { ok: false, error: '인증이 필요합니다.' });

    if (p === '/api/state' && req.method === 'GET') return json(res, 200, summarize());

    if (p === '/api/history' && req.method === 'GET') {
      const id = url.searchParams.get('id') || '';
      return json(res, 200, { ok: true, points: store.history.get(id) || [] });
    }

    if (p === '/api/poll-now' && req.method === 'POST') {
      await readBody(req); // keep-alive desync 방지 — 본문을 항상 소진
      const r = await pollOnce();
      return json(res, 200, { ok: true, ...r });
    }

    if (p === '/api/targets' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body) return json(res, 400, { ok: false, error: '잘못된 요청 본문' });
      const bad = validateTarget(body);
      if (bad) return json(res, 400, { ok: false, error: bad });
      const t = store.addTarget(body);
      pollOnce({ again: true }).catch(logPollError);
      return json(res, 201, { ok: true, target: store.redact(t) });
    }

    const mt = /^\/api\/targets\/([0-9a-f]+)$/.exec(p);
    if (mt && req.method === 'PUT') {
      const body = await readBody(req);
      if (!body) return json(res, 400, { ok: false, error: '잘못된 요청 본문' });
      const bad = validateTarget(body, true);
      if (bad) return json(res, 400, { ok: false, error: bad });
      const t = store.updateTarget(mt[1], body);
      if (!t) return json(res, 404, { ok: false, error: '대상 없음' });
      pollOnce({ again: true }).catch(logPollError);
      return json(res, 200, { ok: true, target: store.redact(t) });
    }
    if (mt && req.method === 'DELETE') {
      await readBody(req);
      return json(res, store.removeTarget(mt[1]) ? 200 : 404, { ok: true });
    }

    const tt = /^\/api\/targets\/([0-9a-f]+)\/test$/.exec(p);
    if (tt && req.method === 'POST') {
      await readBody(req);
      const t = store.targets.find((x) => x.id === tt[1]);
      if (!t) return json(res, 404, { ok: false, error: '대상 없음' });
      const r = await fetchUagStats(t);
      return json(res, 200, { ok: true, result: r });
    }

    return json(res, 404, { ok: false, error: 'not found' });
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
}

function validateTarget(body, partial = false) {
  if (!partial || body.host !== undefined) {
    const host = String(body.host || '').trim();
    if (!host) return '주소(host)가 필요합니다.';
    const bad = hostBlockReason(host);
    if (bad) return bad;
  }
  if (body.port !== undefined && body.port !== '' && !(Number(body.port) >= 1 && Number(body.port) <= 65535)) return '포트가 올바르지 않습니다.';
  if (!partial && !String(body.username || '').trim()) return 'UAG 관리 계정(username)이 필요합니다.';
  if (!partial && !String(body.password || '')) return 'UAG 관리 비밀번호가 필요합니다.';
  return null;
}

// 프로세스 수준 안전망.
//  - unhandledRejection: 로그만 남기고 계속. 요청 경로의 rejection 은 위 handle().catch 가 받으므로
//    여기 오는 것은 그 밖(폴러 등)의 것이고, rejection 은 동기 스택을 반쯤 끝낸 채 남기지 않는다.
//  - uncaughtException: 로그를 남기고 **종료**한다(계속하지 않는다). 이 서버의 영속 상태는
//    원자적으로 쓰는 uag-config.json 하나라 재시작해도 잃는 것은 인메모리 추이·로그인 세션뿐이지만,
//    반대로 계속 돌면 이벤트 핸들러가 던진 자리에서 settle 되지 않은 프라미스가 남을 수 있다 —
//    예: UAG 응답 'end' 핸들러가 던지면 그 대상의 fetch 가 끝나지 않아 poller 의 polling 이 영원히
//    true 가 되고 **모니터링이 조용히 멈춘다**. 조용히 멈춘 모니터가 재시작보다 나쁘다.
//    재기동은 systemd(Restart=always, packaging/uagmon/uag-monitor.service)·데스크톱 앱(1회 재시작)이 한다.
process.on('unhandledRejection', (reason) => {
  console.error(`[uagmon] 처리되지 않은 rejection(계속 실행): ${reason?.stack || reason}`);
});
process.on('uncaughtException', (err) => {
  console.error(`[uagmon] 처리되지 않은 예외 — 상태를 신뢰할 수 없어 종료합니다: ${err?.stack || err}`);
  process.exit(1);
});

// slowloris/유휴 keep-alive 정리(pyportal 불변조건과 동형).
server.headersTimeout = 20_000;
server.requestTimeout = 30_000;

server.listen(opt.port, opt.host, () => {
  const actualPort = server.address().port; // --port 0(임의 포트) 대응
  const shown = opt.host === '0.0.0.0' ? '<이 서버 IP>' : opt.host;
  // 기계판독용 한 줄 — 데스크톱 앱(Electron 래퍼)이 이 라인으로 포트를 받아 창을 연다.
  console.log(`UAGMON_LISTENING port=${actualPort}`);
  console.log(`UAG Monitor v${VERSION} — http://${shown}:${actualPort} (인증 ${auth.required ? 'ON' : 'OFF·로컬 전용'}, 폴링 ${store.settings.pollSeconds}s, 데이터 ${DATA_DIR})`);
  if (opt.open) openBrowser(`http://127.0.0.1:${actualPort}`);
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`포트 ${opt.port} 가 이미 사용 중입니다. 이미 실행 중인 UAG Monitor 가 있는지 확인하거나 --port 로 바꾸세요.`);
  } else {
    console.error(`서버 시작 실패: ${err.message}`);
  }
  process.exit(1);
});

function openBrowser(url) {
  try {
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* 브라우저 자동 열기 실패는 치명적이지 않음 */ }
}

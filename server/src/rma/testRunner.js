/**
 * RMA 점검 실행기(엣지, v2.418) — tests.js 카탈로그 항목 하나를 현지에서 실행해 판정을 돌려준다.
 * 가능한 한 **네이티브(Node)** 로 구현해 외부 바이너리 의존을 줄였다(tcp/dns/url/cert/disk/cpu/memory/
 * load/process/service/files). ping/trace/ntp/service 는 argv spawn(셸 없음, exec.js runCommand).
 *
 * 파일 계열은 `fileRoots`(RMA_FILE_ROOTS, 기본 /var/log) 아래 경로만 허용한다 — realpath 로 심볼릭
 * 링크 탈출까지 막는다(portal.env 등 비밀 파일 읽기 차단).
 * 반환: { status, reply, value, durationMs }  (status: ok|warn|bad|unknown)
 */
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import path from 'node:path';
import { runCommand, sshExec } from './exec.js';
import { buildTest, judge } from './tests.js';

const unknown = (reply) => ({ status: 'unknown', reply });

/** 파일 경로가 허용 루트 아래인지(realpath 기준). */
export function pathAllowed(p, roots) {
  let real;
  try { real = fs.realpathSync(p); } catch { real = path.resolve(p); } // 없는 파일은 해석 경로로 판정(존재 점검용)
  return (roots || []).some((r) => { const rr = path.resolve(r); return real === rr || real.startsWith(rr.endsWith('/') ? rr : rr + '/'); });
}

function parsePing(stdout) {
  const m = /(\d+) packets transmitted, (\d+) (?:packets )?received/.exec(stdout);
  const rtt = /= [\d.]+\/([\d.]+)\//.exec(stdout);
  return { sent: m ? Number(m[1]) : 0, received: m ? Number(m[2]) : 0, avgMs: rtt ? Math.round(Number(rtt[1])) : null };
}

async function cpuPct(sampleSec) {
  const read = () => { const c = os.cpus(); let idle = 0, total = 0; for (const x of c) { idle += x.times.idle; for (const v of Object.values(x.times)) total += v; } return { idle, total }; };
  const a = read(); await new Promise((r) => setTimeout(r, Math.max(500, sampleSec * 1000))); const b = read();
  const dt = b.total - a.total; if (dt <= 0) return null;
  return Math.round((1 - (b.idle - a.idle) / dt) * 100);
}

function globToRe(pat) { return new RegExp('^' + String(pat).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$'); }

function dirSize(p, depth = 0) {
  const st = fs.statSync(p);
  if (!st.isDirectory()) return st.size;
  if (depth > 12) return 0;
  let n = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    try { const c = path.join(p, e.name); n += e.isDirectory() ? dirSize(c, depth + 1) : fs.statSync(c).size; } catch { /* */ }
  }
  return n;
}

async function fetchUrl(url, { timeoutMs, insecure }) {
  const t0 = Date.now();
  let dispatcher;
  // v2.537: DNS 리바인딩(TOCTOU) 차단 — util/ssrfLookup.js 머리말. 예전에는 insecure 일 때만 dispatcher 를
  // 만들었고(훅 없음) 아니면 전역 fetch 였다(전역 fetch 에는 lookup 이 없다 — v2.506 문서). 이제 두 경우
  // 모두 lookup 훅이 붙은 dispatcher 를 쓴다(TLS 검증 여부는 그대로 insecure 가 정한다). undici 를
  // 못 불러오는 환경이면 예전처럼 전역 fetch 로 폴백한다(그 사실은 바꾸지 않았다).
  try {
    const { Agent } = await import('undici');
    const { withSsrfLookup } = await import('../util/ssrfLookup.js');
    dispatcher = new Agent({ connect: withSsrfLookup({ rejectUnauthorized: !insecure }) });
  } catch { /* undici 미탑재 환경 — 전역 fetch 폴백 */ }
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual', ...(dispatcher ? { dispatcher } : {}) });
  const body = await res.text().catch(() => '');
  return { status: res.status, ms: Date.now() - t0, body: body.slice(0, 256 * 1024) };
}

function certDays(host, port, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host, port, servername: host, rejectUnauthorized: false, timeout: timeoutMs }, () => {
      const c = s.getPeerCertificate();
      s.end();
      if (!c || !c.valid_to) return resolve(null);
      resolve({ days: Math.floor((new Date(c.valid_to).getTime() - Date.now()) / 86400e3), subject: c.subject?.CN || '', issuer: c.issuer?.CN || '', validTo: c.valid_to });
    });
    s.once('timeout', () => { s.destroy(); reject(new Error('timeout')); });
    s.once('error', reject);
  });
}

/**
 * 실행. spec = buildTest() ok 결과 또는 { test, args }. opts = { fileRoots, allowCustom }.
 */
export async function runTest(spec, { fileRoots = ['/var/log'], allowCustom = false, resolveCreds = null, allowSsh = false, sshTargets = [] } = {}) {
  const t0 = Date.now();
  const done = (r) => ({ ...r, durationMs: Date.now() - t0 });
  const b = spec.ok ? spec : buildTest(spec.test, spec.args || {});
  if (!b.ok) return done({ status: 'unknown', reply: b.issue });
  const a = b.args;
  try {
    switch (b.test) {
      case 'rma-itself': return done({ status: 'ok', reply: '에이전트 응답(엣지 실행 아님)' });
      case 'ping': {
        const r = await runCommand({ argv: ['ping', '-n', '-c', String(a.count), '-W', '2', a.host], timeoutMs: (a.count + 2) * 3000 });
        if (r.reason && /없습니다|spawn/.test(r.reason)) return done(unknown(r.reason));
        return done(judge.ping(parsePing(r.stdout), a));
      }
      case 'trace': {
        const r = await runCommand({ argv: ['traceroute', '-n', '-w', '2', '-m', String(a.maxHops), a.host], timeoutMs: 90_000 });
        if (r.reason && /없습니다|spawn/.test(r.reason)) return done(unknown(r.reason));
        const lines = r.stdout.split('\n').filter((l) => /^\s*\d+\s/.test(l));
        const last = lines[lines.length - 1] || '';
        const reached = lines.some((l) => l.includes(a.host)) || (last && !/\*\s*\*\s*\*/.test(last) && lines.length < a.maxHops);
        return done(reached ? { status: 'ok', reply: `${lines.length}홉 도달`, value: lines.length } : { status: 'bad', reply: `${a.maxHops}홉 내 미도달`, value: lines.length });
      }
      case 'tcp': {
        const r = await new Promise((resolve) => {
          const s = net.connect({ host: a.host, port: a.port });
          const fin = (ok, why) => { try { s.destroy(); } catch { /* */ } resolve({ ok, why, ms: Date.now() - t0 }); };
          s.setTimeout(a.timeoutMs); s.once('connect', () => fin(true)); s.once('timeout', () => fin(false, 'timeout')); s.once('error', (e) => fin(false, e.code || e.message));
        });
        return done(r.ok ? { status: 'ok', reply: `open (${r.ms}ms)`, value: r.ms } : { status: 'bad', reply: `closed/${r.why}`, value: null });
      }
      case 'dns': {
        const resolver = new dns.promises.Resolver({ timeout: 5000, tries: 2 });
        if (a.server) resolver.setServers([a.server]);
        let addrs = [];
        try { addrs = await (a.server ? resolver.resolve4(a.name) : dns.promises.lookup(a.name, { all: true }).then((l) => l.map((x) => x.address))); }
        catch (e) { return done({ status: 'bad', reply: `조회 실패: ${e.code || e.message}` }); }
        if (!addrs.length) return done({ status: 'bad', reply: '결과 없음' });
        if (a.expect && !addrs.includes(a.expect)) return done({ status: 'bad', reply: `기대 ${a.expect} ≠ ${addrs.join(',')}`, value: addrs.length });
        return done({ status: 'ok', reply: addrs.join(','), value: addrs.length });
      }
      case 'ntp': {
        const r = await runCommand({ argv: ['chronyc', 'tracking'], timeoutMs: 10_000 });
        if (!r.ok) return done(unknown(r.reason || 'chronyc 실패'));
        const m = /System time\s*:\s*([\d.]+) seconds (slow|fast)/.exec(r.stdout);
        const leap = /Leap status\s*:\s*(\S+)/.exec(r.stdout)?.[1] || '';
        if (!m) return done(unknown('chronyc 출력 형식을 읽지 못함'));
        const offMs = Math.round(Number(m[1]) * 1000);
        if (/not synch/i.test(leap)) return done({ status: 'bad', reply: `동기화 안 됨(${leap})`, value: offMs });
        return done(judge.threshold(offMs, { badAbove: a.maxOffsetMs, unit: 'ms' }));
      }
      case 'url': {
        let r;
        try { r = await fetchUrl(a.url, { timeoutMs: Math.max(a.maxMs * 2, 3000), insecure: a.insecure === 1 }); }
        catch (e) { return done({ status: 'bad', reply: `요청 실패: ${e.cause?.code || e.name || e.message}` }); }
        if (r.status !== a.expectStatus) return done({ status: 'bad', reply: `HTTP ${r.status} ≠ ${a.expectStatus} (${r.ms}ms)`, value: r.ms });
        if (a.contains && !r.body.includes(a.contains)) return done({ status: 'bad', reply: `본문에 '${a.contains}' 없음 (${r.ms}ms)`, value: r.ms });
        if (r.ms > a.maxMs) return done({ status: 'warn', reply: `HTTP ${r.status}, ${r.ms}ms > ${a.maxMs}ms`, value: r.ms });
        return done({ status: 'ok', reply: `HTTP ${r.status}, ${r.ms}ms`, value: r.ms });
      }
      case 'cert-expiry': {
        let c;
        try { c = await certDays(a.host, a.port); } catch (e) { return done({ status: 'bad', reply: `TLS 접속 실패: ${e.code || e.message}` }); }
        const j = judge.certDays(c?.days ?? null, a);
        return done({ ...j, reply: `${j.reply}${c?.subject ? ` (CN=${c.subject}, ${c.validTo})` : ''}` });
      }
      case 'disk-free': {
        const st = await fs.promises.statfs(a.path).catch(() => null);
        if (!st) return done({ status: 'bad', reply: `경로 없음/접근 불가: ${a.path}` });
        const total = st.blocks * st.bsize, free = st.bavail * st.bsize;
        const pct = total ? Math.round((free / total) * 100) : 0, gb = Math.round(free / 1e9);
        if (pct < a.minFreePct) return done({ status: 'bad', reply: `여유 ${pct}% (${gb}GB) < ${a.minFreePct}%`, value: pct });
        if (a.minFreeGB != null && gb < a.minFreeGB) return done({ status: 'bad', reply: `여유 ${gb}GB < ${a.minFreeGB}GB (${pct}%)`, value: pct });
        return done({ status: 'ok', reply: `여유 ${pct}% (${gb}GB / ${Math.round(total / 1e9)}GB)`, value: pct });
      }
      case 'cpu': { const p = await cpuPct(a.sampleSec); return done(judge.threshold(p, { badAbove: a.maxPct, unit: '%' })); }
      case 'memory': {
        const freeMB = Math.round(os.freemem() / 1048576), pct = Math.round((os.freemem() / os.totalmem()) * 100);
        if (freeMB < a.minFreeMB) return done({ status: 'bad', reply: `여유 ${freeMB}MB (${pct}%) < ${a.minFreeMB}MB`, value: freeMB });
        if (a.minFreePct != null && pct < a.minFreePct) return done({ status: 'bad', reply: `여유 ${pct}% < ${a.minFreePct}%`, value: freeMB });
        return done({ status: 'ok', reply: `여유 ${freeMB}MB (${pct}%)`, value: freeMB });
      }
      case 'load': {
        const perCore = os.loadavg()[0] / Math.max(1, os.cpus().length);
        return done(judge.threshold(Math.round(perCore * 100) / 100, { badAbove: a.maxLoadPerCore / 10, unit: '/core' }));
      }
      case 'process': {
        const r = await runCommand({ argv: ['pgrep', '-c', '-f', a.name], timeoutMs: 10_000 });
        const n = Number(String(r.stdout).trim()) || 0;
        if (n < a.min) return done({ status: 'bad', reply: `${n}개 < 최소 ${a.min}`, value: n });
        if (a.max != null && n > a.max) return done({ status: 'warn', reply: `${n}개 > 최대 ${a.max}`, value: n });
        return done({ status: 'ok', reply: `${n}개`, value: n });
      }
      case 'service': {
        const r = await runCommand({ argv: ['systemctl', 'is-active', a.unit], timeoutMs: 10_000 });
        const state = String(r.stdout).trim() || 'unknown';
        const expect = String(a.expect || 'active').toLowerCase();
        return done(state === expect ? { status: 'ok', reply: state } : { status: 'bad', reply: `${state} ≠ ${expect}` });
      }
      case 'interfaces': {
        const ifs = os.networkInterfaces();
        const r = await runCommand({ argv: ['ip', '-br', 'link'], timeoutMs: 10_000 });
        const rows = r.stdout.split('\n').map((l) => l.trim().split(/\s+/)).filter((t) => t.length >= 2 && t[0] !== 'lo');
        const want = a.iface ? rows.filter((t) => t[0].replace(/@.*/, '') === a.iface) : rows.filter((t) => !/^(veth|docker|br-|virbr)/.test(t[0]));
        if (a.iface && !want.length) return done({ status: 'bad', reply: `인터페이스 없음: ${a.iface}` });
        const down = want.filter((t) => t[1] !== 'UP').map((t) => `${t[0]}:${t[1]}`);
        void ifs;
        return done(down.length ? { status: 'bad', reply: `DOWN ${down.join(', ')}`, value: down.length } : { status: 'ok', reply: `${want.length}개 UP`, value: 0 });
      }
      case 'file-exists': case 'file-size': case 'file-age': case 'count-files': case 'text-log': {
        if (!pathAllowed(a.path, fileRoots)) return done({ status: 'unknown', reply: `허용되지 않은 경로(RMA_FILE_ROOTS: ${fileRoots.join(', ')})` });
        const exists = fs.existsSync(a.path);
        if (b.test === 'file-exists') return done((exists ? 1 : 0) === a.expect ? { status: 'ok', reply: exists ? '있음' : '없음' } : { status: 'bad', reply: exists ? '있음(없어야 함)' : '없음(있어야 함)' });
        if (!exists) return done({ status: 'bad', reply: `없음: ${a.path}` });
        if (b.test === 'file-size') { const mb = Math.round(dirSize(a.path) / 1048576); return done(judge.threshold(mb, { badAbove: a.maxMB, unit: 'MB' })); }
        if (b.test === 'file-age') { const min = Math.round((Date.now() - fs.statSync(a.path).mtimeMs) / 60000); return done(judge.threshold(min, { badAbove: a.maxAgeMin, unit: '분 경과' })); }
        if (b.test === 'count-files') {
          const re = a.pattern ? globToRe(a.pattern) : null;
          const n = fs.readdirSync(a.path).filter((f) => !re || re.test(f)).length;
          return done(judge.threshold(n, { badAbove: a.max, unit: '개' }));
        }
        // text-log: 끝에서 tailLines 줄만 읽어 패턴 일치 수
        const st = fs.statSync(a.path);
        const readBytes = Math.min(st.size, a.tailLines * 512, 8 * 1024 * 1024);
        const fd = fs.openSync(a.path, 'r'); const buf = Buffer.alloc(readBytes);
        fs.readSync(fd, buf, 0, readBytes, Math.max(0, st.size - readBytes)); fs.closeSync(fd);
        const lines = buf.toString('utf8').split('\n').slice(-a.tailLines);
        let re; try { re = new RegExp(a.pattern); } catch { return done(unknown('정규식 오류')); }
        const hits = lines.filter((l) => re.test(l));
        const j = judge.threshold(hits.length, { badAbove: a.maxMatches, unit: '건' });
        return done({ ...j, reply: `${j.reply}${hits.length ? ` — 마지막: ${hits[hits.length - 1].slice(0, 160)}` : ''}` });
      }
      case 'ssh': {
        if (!allowSsh) return done(unknown('SSH 점검은 이 엣지에서 허용되지 않았습니다(RMA_ALLOW_SSH=true 필요)'));
        const { targetAllowed } = await import('./commands.js');
        if (!targetAllowed(a.host, sshTargets)) return done(unknown(`대상 '${a.host}' 은 이 엣지의 SSH 허용 목록(RMA_SSH_TARGETS)에 없습니다`));
        if (typeof resolveCreds !== 'function') return done(unknown('계정 브로커 없음'));
        const cr = await resolveCreds(a.credentialId, a.host);
        if (!cr.ok) return done({ status: 'unknown', reply: `계정 인출 실패: ${cr.reason}` });
        const r = await sshExec({ host: a.host, port: a.port, command: a.command, timeoutMs: a.timeoutMs }, cr.secret, { maxOutput: 64 * 1024 });
        const out = (r.stdout || r.stderr || '').trim().split('\n').pop() || '';
        if (r.exitCode == null) return done({ status: 'bad', reply: r.reason || 'SSH 실패' });
        if (a.contains && !(r.stdout || '').includes(a.contains)) return done({ status: 'bad', reply: `출력에 '${a.contains}' 없음 (exit ${r.exitCode})`, value: r.exitCode });
        const st = r.exitCode === 0 ? 'ok' : r.exitCode === 1 ? 'warn' : 'bad';
        return done({ status: st, reply: `exit ${r.exitCode}${out ? ` — ${out.slice(0, 200)}` : ''}`, value: r.exitCode });
      }
      case 'script': {
        if (!allowCustom) return done(unknown('외부 스크립트는 이 엣지에서 허용되지 않았습니다(RMA_ALLOW_CUSTOM=true 필요)'));
        const r = await runCommand({ shell: a.command, timeoutMs: a.timeoutMs }, { maxOutput: 64 * 1024 });
        const out = (r.stdout || r.stderr || '').trim().split('\n').pop() || '';
        if (r.timedOut) return done({ status: 'bad', reply: `타임아웃 — ${out}`.slice(0, 200) });
        const st = r.exitCode === 0 ? 'ok' : r.exitCode === 1 ? 'warn' : 'bad';
        return done({ status: st, reply: `exit ${r.exitCode}${out ? ` — ${out.slice(0, 200)}` : ''}`, value: r.exitCode });
      }
      default: return done(unknown(`실행기 미구현: ${b.test}`));
    }
  } catch (e) { return done({ status: 'unknown', reply: `실행 오류: ${e.message}` }); }
}

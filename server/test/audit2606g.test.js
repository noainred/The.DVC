// v2.606 그룹 g — 보안(ReDoS·응답 상한·감사 크기) 회귀. 감사 입력: scratchpad/audit2606/security.json
// 성능 단언은 입력을 16,000자 이하로 두고, '옛 정규식은 느리고 새 것은 빠르다' 를 병렬 부하에서도 갈리는 상한으로 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';

process.env.SSRF_ALLOW_LOOPBACK = 'true';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2606g-'));
process.env.CONFIG_DIR = TMP;
process.env.AUDIT_MAX = '5000';

const SRC = new URL('../src/', import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, SRC), 'utf8');
const timeIt = (fn) => { const t = performance.now(); fn(); return performance.now() - t; };

// ── SEC2606-01: probeIdrac 서비스 루트·401 본문 gzip 폭탄 ─────────────────────────────
// 2MB 공백을 gzip(수 KB) — 상한(64KB/16KB)에서 멈추는지만 본다(메모리 큰 실험 금지).
const BOMB = zlib.gzipSync(Buffer.alloc(2 * 1024 * 1024, 0x20));

function startServer(mode) {
  const srv = http.createServer((q, res) => {
    q.resume();
    if (q.url === '/redfish/v1') {
      if (mode === 'root') {
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
        return res.end(BOMB);
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"Vendor":"Dell","Oem":{"Dell":{}}}');
    }
    if (mode === 'auth') {
      res.writeHead(401, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
      return res.end(BOMB);
    }
    // 정상 401(작은 Redfish 오류 JSON)
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { '@Message.ExtendedInfo': [{ Message: 'Unable to complete the operation because an invalid username and/or password is entered' }] } }));
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

async function probeWith(mode) {
  const srv = await startServer(mode);
  try {
    const { probeIdrac } = await import('../src/idrac/redfish.js');
    return await probeIdrac(`http://127.0.0.1:${srv.address().port}`, 'u', 'p', 5000);
  } finally { srv.closeAllConnections(); srv.close(); }
}

test('SEC2606-01: 서비스 루트 gzip 폭탄 → 상한에서 멈추고 응답 과대로 건너뛴다', async () => {
  const r = await probeWith('root');
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.oversized, true);
  assert.match(r.reason, /응답 과대/);
});

test('SEC2606-01: 401 본문 gzip 폭탄 → 상한에서 멈추고 응답 과대로 건너뛴다', async () => {
  const r = await probeWith('auth');
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.oversized, true);
});

test('SEC2606-01: 정상 401(작은 오류 JSON)은 예전처럼 인증 실패 + iDRAC 메시지', async () => {
  const r = await probeWith('normal');
  assert.equal(r.ok, true);
  assert.equal(r.authFailed, true);
  assert.equal(r.isIdrac, true);
  assert.match(r.authHint, /invalid username/);
});

// ── SEC2606-02: 미보호 VM 패턴 상한 ────────────────────────────────────────────────
test('SEC2606-02: patterns 는 최대 32개·64자, 버린 개수를 밝힌다', async () => {
  const { computeUnprotected, normalizePatterns, MAX_PATTERNS, MAX_PATTERN_LEN } = await import('../src/reports/unprotected.js');
  assert.equal(MAX_PATTERNS, 32);
  assert.equal(MAX_PATTERN_LEN, 64);
  const raw = [...Array.from({ length: 5300 }, (_, i) => `q${i}`), 'x'.repeat(65)].join(',');
  const n = normalizePatterns(raw);
  assert.equal(n.patterns.length, 32);
  assert.equal(n.omitted, 5300 - 32);
  assert.equal(n.tooLong, 1);
  const rows = Array.from({ length: 2000 }, (_, i) => ({ type: 'VmSnapshotCreated', user: `svc${i}`, message: 'm', entity: `vm${i}`, vcenterId: 'vc', ts: i }));
  const vms = [{ id: 'a', name: 'vm1', vcenterId: 'vc', powerState: 'POWERED_ON' }];
  const r = computeUnprotected(vms, rows, { patterns: raw });
  assert.equal(r.config.patterns.length, 32);
  assert.equal(r.config.patternsOmitted, 5300 - 32 + 1);
  // 비어 있으면(또는 쓸 것이 없으면) 기본 패턴 — 예전 동작
  const d = computeUnprotected(vms, [{ type: 'VmSnapshotCreated', user: 'VEEAM\\svc', entity: 'vm1', vcenterId: 'vc', ts: 1 }], { patterns: '' });
  assert.equal(d.summary.protectedCount, 1);
  assert.equal(d.config.patternsOmitted, 0);
});

test('SEC2606-02: 라우트는 패턴을 computeUnprotected 상한으로 넘긴다(무상한 split 금지)', () => {
  const src = read('routes/api/reports.js');
  const body = src.slice(src.indexOf("api.get('/tools/report/unprotected'"), src.indexOf("api.get('/tools/report/unprotected'") + 1400);
  assert.ok(!/patterns\s*=\s*String\(req\.query\.patterns[^)]*\)\.split/.test(body), '라우트가 patterns 를 무상한으로 split 하면 안 된다');
  assert.match(body, /computeUnprotected\(scoped\.vms, rows, \{ patterns,/);
});

test('SEC2606-02: 판정 루프에서 패턴을 행마다 다시 소문자화하지 않는다', () => {
  const src = read('reports/unprotected.js');
  const fn = src.slice(src.indexOf('export function computeUnprotected'));
  assert.ok(!/isBackupEvent\(r, patterns\)/.test(fn), 'computeUnprotected 루프는 소문자화가 끝난 목록으로 판정해야 한다');
  assert.ok(!/hay\.includes\(String\(p\)\.toLowerCase\(\)\)/.test(src));
});

// ── SEC2606-03: Digest 챌린지 파서 ────────────────────────────────────────────────
const oldParse = (headerValue) => {
  const h = String(headerValue || '');
  const idx = h.toLowerCase().indexOf('digest ');
  if (idx === -1) return null;
  const params = {};
  const body = h.slice(idx + 7);
  const re = /(\w+)\s*=\s*(?:"([^"]*)"|([^,\s]+))/g;
  let m;
  while ((m = re.exec(body))) params[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : m[3];
  return params.nonce ? params : null;
};

test('SEC2606-03: 15,000자 Digest 헤더 — 옛 파서는 느리고 새 파서는 빠르다', async () => {
  const { parseDigestChallenge } = await import('../src/idrac/digestAuth.js');
  const evil = 'Digest ' + '0'.repeat(15_000);
  const tOld = timeIt(() => oldParse(evil));
  const tNew = timeIt(() => parseDigestChallenge(evil));
  assert.ok(tOld > 150, `옛 파서 재현 실패(${tOld.toFixed(1)}ms)`);
  assert.ok(tNew < 60, `새 파서가 느리다(${tNew.toFixed(1)}ms)`);
  // 정규식 자체도 선형이어야 한다(절단 없이 16,000자)
  const src = read('idrac/digestAuth.js');
  const reSrc = /const re = (\/.*\/g);/.exec(src)[1];
  const re = new Function(`return ${reSrc}`)();
  const tRe = timeIt(() => { re.lastIndex = 0; while (re.exec('0'.repeat(16_000))); });
  assert.ok(tRe < 60, `새 정규식이 초선형이다(${tRe.toFixed(1)}ms)`);
});

test('SEC2606-03: 정상 챌린지 결과는 옛 파서와 같다(결정적 난수 대조)', async () => {
  const { parseDigestChallenge } = await import('../src/idrac/digestAuth.js');
  let seed = 2606;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const keys = ['realm', 'nonce', 'qop', 'opaque', 'algorithm', 'stale', 'domain', 'charset', 'userhash'];
  const chars = 'abcdefABCDEF0123456789/+=-._:@ ';
  const val = (quoted) => {
    let s = ''; const n = 1 + rnd(40);
    for (let i = 0; i < n; i++) { const c = chars[rnd(chars.length)]; s += (!quoted && (c === ' ' || c === ',')) ? 'x' : c; }
    return quoted ? `"${s.replace(/"/g, '')}${rnd(3) === 0 ? ', auth-int' : ''}"` : s.trim() || 'x';
  };
  const seps = [', ', ',', ' , ', ' ', ',\t'];
  for (let k = 0; k < 2000; k++) {
    const n = 1 + rnd(6);
    const parts = [];
    const ks = [...keys].sort(() => rnd(3) - 1).slice(0, n);
    if (!ks.includes('nonce') && rnd(4)) ks.push('nonce');
    for (const key of ks) parts.push(`${rnd(5) === 0 ? key.toUpperCase() : key}${rnd(4) === 0 ? ' = ' : '='}${val(rnd(2) === 0)}`);
    const prefix = ['', 'Basic realm="x", ', 'Negotiate, '][rnd(3)];
    const h = `${prefix}Digest ${parts.join(seps[rnd(seps.length)])}`;
    assert.deepEqual(parseDigestChallenge(h), oldParse(h), h);
  }
});

// ── SEC2606-04: GPU 게스트 다운로드 실패 본문 ──────────────────────────────────────
test("SEC2606-04: '<' 반복 본문 — 옛 정규식은 느리고 새 요약은 빠르며 결과는 같다", async () => {
  const { failBodySnippet } = await import('../src/gpu/guestops.js');
  const evil = '<'.repeat(16_000);
  const tOld = timeIt(() => evil.replace(/<[^>]+>/g, ' '));
  const tNew = timeIt(() => failBodySnippet('<'.repeat(65_536)));
  assert.ok(tOld > 150, `옛 정규식 재현 실패(${tOld.toFixed(1)}ms)`);
  assert.ok(tNew < 60, `새 요약이 느리다(${tNew.toFixed(1)}ms)`);
  const html = '<html><head><title>404 Not Found</title></head><body><h1>File not found</h1><p>ticket invalid</p></body></html>';
  const oldOut = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
  assert.equal(failBodySnippet(html), oldOut);
  assert.ok(!/replace\(\/<\[\^>\]\+>\/g/.test(read('gpu/guestops.js')), '무한정 태그 정규식이 남아 있으면 안 된다');
});

// ── SEC2606-05: racadm 파서 ──────────────────────────────────────────────────────
test('SEC2606-05: 숫자 16,000자 한 줄 — 옛 정규식은 느리고 새 파서는 빠르다', async () => {
  const { parseSystemPerf, LINE_MAX } = await import('../src/bmusage/parse/racadm.js');
  assert.equal(LINE_MAX, 1000);
  const line = '1'.repeat(16_000);
  const tOld = timeIt(() => [...line.matchAll(/(\d+(?:\.\d+)?)\s*%/g)]);
  const tNew = timeIt(() => parseSystemPerf(`CPU Usage ${line}\nMemory Usage ${line} %`));
  assert.ok(tOld > 150, `옛 정규식 재현 실패(${tOld.toFixed(1)}ms)`);
  assert.ok(tNew < 60, `새 파서가 느리다(${tNew.toFixed(1)}ms)`);
  // 정규식 자체도 선형이어야 한다(줄 절단 없이)
  const src = read('bmusage/parse/racadm.js');
  const reSrc = /s\.matchAll\((\/\(\?<!\[\\d\.\]\).*?\/g)\)/.exec(src)?.[1];
  assert.ok(reSrc, '앞 경계 + 자릿수 한정 정규식이어야 한다');
  const re = new Function(`return ${reSrc}`)();
  const tRe = timeIt(() => [...line.matchAll(re)]);
  assert.ok(tRe < 60, `새 정규식이 초선형이다(${tRe.toFixed(1)}ms)`);
});

test('SEC2606-05: 정상 racadm 출력 결과는 그대로다', async () => {
  const { parseSystemPerf } = await import('../src/bmusage/parse/racadm.js');
  const inline = parseSystemPerf('CPUUsage   12 %   15 %   88 %\nMemory Usage = 43.5 %\nIO Usage 7%  Peak 2026-09-17 08:00:00');
  assert.equal(inline.cpuPct, 12);
  assert.equal(inline.memPct, 43.5);
  assert.equal(inline.ioPct, 7);
  const block = parseSystemPerf('Metric Name = CPUUsage\nPeak = 91\nAverage = 30\nLast = 12\nMetric Name = MemoryUsage\nLast = 61.25 %');
  assert.equal(block.cpuPct, 12);
  assert.equal(block.usedStat.cpuPct, 'last');
  assert.equal(block.memPct, 61.3);
});

// ── SEC2606-06: 감사 로그 한 칸 상한 ─────────────────────────────────────────────
test('SEC2606-06: logAudit 는 target·detail 을 1,000자로 자르고 잘림을 밝힌다', async () => {
  const { logAudit, listAudit, AUDIT_FIELD_MAX } = await import('../src/audit.js');
  assert.equal(AUDIT_FIELD_MAX, 1000);
  logAudit({ user: 'op', action: '시리얼 조회 CSV 내보내기', target: 'T'.repeat(15_000), detail: 'D'.repeat(5000) });
  const file = path.join(TMP, 'audit.ndjson');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const e = JSON.parse(lines[lines.length - 1]);
  assert.equal(e.target.length, 1000 + '…(잘림)'.length);
  assert.ok(e.target.endsWith('…(잘림)'));
  assert.ok(e.detail.endsWith('…(잘림)'));
  assert.ok(Buffer.byteLength(lines[lines.length - 1]) < 3000);
  // 짧은 값은 그대로
  logAudit({ user: 'op', action: 'x', target: 'short', detail: '3행' });
  const e2 = JSON.parse(fs.readFileSync(file, 'utf8').trim().split('\n').pop());
  assert.equal(e2.target, 'short');
  assert.equal(typeof listAudit, 'function');
});

test('SEC2606-06: 시리얼 조회 CSV 감사 target 은 검색어 100자로 자른다(형제와 같은 규칙)', () => {
  const src = read('routes/api/serialLookup.js');
  const at = src.indexOf("action: '시리얼 조회 CSV 내보내기'");
  const seg = src.slice(at, at + 300);
  assert.match(seg, /q\.slice\(0, 100\)/);
  assert.ok(!/target: q \? `검색 '\$\{q\}'`/.test(seg), '검색어 전체를 감사 target 에 넣으면 안 된다');
});

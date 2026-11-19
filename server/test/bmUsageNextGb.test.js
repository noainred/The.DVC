/**
 * 베어메탈 사용률 — 다음 작업(2026-11-19) 그룹 B 회귀 고정. 기준판 266a350dc(v3.29.1)에서 재현한 입력을 그대로 쓴다.
 *  ④ 데모 표시 경로 한 규칙: 데모(mock) 대상 17대 중 15대는 성능 겹침이 OS 열을 싣는데(신뢰 띠 · 상세 머리 ‘OS + iDRAC’) KPI · 칩 · 표 · CSV · 스냅샷은
 *     대상 paths(['idrac'])를 읽어 ‘iDRAC 만’ 이었다 → 서버 한 곳(demoDisplayTargets)이 표시 표지(demoOs · pathsShown · missingShown)를 싣고 모두가 그것을 읽는다.
 *     대상 paths · osHost 는 그대로(SSH 0) · mock 이 아니면 아무것도 바뀌지 않는다.
 *  ⑤ 엣지 봉투 정제: (a) 행 ts · os_at · idrac_at 을 수신 시각으로 자르고 원본은 atRaw (b) 대상 · 행은 아는 필드 표(bmusage/publicFields.js — 엣지 export 와 같은 표 ·
 *     export 필드 ⟺ 표 대조) — 가짜 엣지의 password · osHost 를 버린다 (c) 16MB(수신 상한) 초과를 bad-body 가 아니라 too-large 로.
 *  ⑥ 스냅샷 실행 표지: (a) 키 · 공통 계정 참조 미해석(authError)이면 표지도 auth-unresolved(실행과 같은 함수) (b) 엣지 대행은 봉투 시각(pathBasis)을 싣는다.
 * 기준 시각: 실제 시각을 정시로 떨어뜨린 기준(docs/rules/common.md) · 주석 제거는 test/_stripComments.js.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { stripComments } from './_stripComments.js';

const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };
const rmTmpDirs = () => { for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* 늦게 flush 되는 기록기와의 경합 — exit 에서 한 번 더 */ } } };
after(() => { rmTmpDirs(); process.once('exit', () => { try { rmTmpDirs(); } catch { /* 종료 중 */ } }); });

const DIR = tmpDir('bmnextgb-');
Object.assign(process.env, {
  CONFIG_DIR: DIR, DATA_DIR: DIR, DATA_SOURCE: 'mock', AUTH_ENABLED: 'false', SSRF_ALLOW_LOOPBACK: 'true', COLLECTOR_TOKEN: 'tok-nextgb',
  EDGE_RESPONSE_MAX_BYTES: String(1_048_576),   // ⑤(c): 수신 상한을 최소(1MB)로 — 2MB 봉투로 넘긴다(env 는 모듈을 읽기 전에)
});
delete process.env.CENTRAL_URL;
const H = 3_600_000;
const NOW = Math.floor(Date.now() / H) * H - 30 * 60_000;
const SRC = new URL('../src/', import.meta.url);
const WEB = new URL('../../web/src/', import.meta.url);
const read = (u) => fs.readFileSync(u, 'utf8');
const jsonCopy = (o) => JSON.parse(JSON.stringify(o));

const T = await import('../src/bmusage/targets.js');
const PF = await import('../src/bmusage/publicFields.js');
const E = await import('../src/central/bmUsageEdgePull.js');
const RUN = await import('../src/bmusage/snapshot/run.js');
const DEMO = await import('../src/mock/demo/baremetal.js');
const HB = await import('../src/bmusage/hbaBasis.js');

/** 실제 대상 해석 — 베어메탈(두 경로 · iDRAC 만 · OS 만 · 참조 미해석) + 가상화 호스트. */
function fixtureTargets() {
  const registry = [
    { id: 'r1', host: 'https://10.1.0.1', username: 'u', password: 'p' },
    { id: 'r2', host: 'https://10.1.0.2', username: 'u', password: 'p' },
    { id: 'r4', host: 'https://10.1.0.4', username: 'u', password: 'p' },
    { id: 'r9', host: 'https://10.1.0.9', username: 'u', password: 'p' },
  ];
  const bareMetal = [
    { serverId: 'r1', fleetId: 'r1', name: 'bm-both', serviceTag: 'TAGB1', vcenterId: 'vcA', vcenter: 'A', model: 'R750' },
    { serverId: 'r2', fleetId: 'r2', name: 'bm-idrac', serviceTag: 'TAGI2', vcenterId: 'vcA', model: 'R650' },
    { serverId: '', fleetId: 'bm-osonly', name: 'bm-osonly', serviceTag: '', vcenterId: 'vcA' },
    { serverId: 'r4', fleetId: 'r4', name: 'bm-authbad', serviceTag: 'TAGA4', vcenterId: 'vcA' },
  ];
  const bmServers = [
    { id: 'o1', name: 'bm-both', host: '10.2.0.1', port: 22, username: 'mon', password: 'pw', mounts: ['/', '/data'], vcenterId: 'vcA' },
    { id: 'o3', name: 'bm-osonly', host: '10.2.0.3', port: 22, username: 'mon', password: 'pw', mounts: ['/'], vcenterId: 'vcA' },
    { id: 'o4', name: 'bm-authbad', host: '10.2.0.4', port: 22, username: 'mon', password: '', authError: '키 참조를 해석하지 못했습니다(키 없음)', authErrorCode: 'auth-unresolved', vcenterId: 'vcA' },
  ];
  const virtHosts = [{ name: 'esxi-01', fleetId: 'esxi-01', idracServerId: 'r9', serviceTag: 'TAGV9', vcenterId: 'vcA', vcenter: 'A', model: 'R760' }];
  const settings = { corps: { vcA: true }, idracTelemetry: true, osSsh: true, includeVirtualization: true };
  return T.resolveTargets({ bareMetal, registry, bmServers, virtHosts, vcenters: [{ id: 'vcA', name: 'A' }], settings });
}

/* ── ⑤ (b) 아는 필드 표 ⟺ 엣지 export ──────────────────────────────────────────── */
test('⑤b — 엣지 export(publicTarget · 실제 resolveTargets · 데모 표지 · HBA 근거)의 모든 필드가 중앙 표에 있고, 정제 왕복이 아무것도 잃지 않는다', async () => {
  // HBA 근거(osFallback 까지 — 깊이 2) 하나를 실제 기록 함수로
  HB.recordHbaBasis('TAGB1', { detail: { fc: [{ pctBasis: 'nominal', pctOver: true, pct: null }], idracFc: [{ pctBasis: 'fc-data-rate', pct: 50 }], hbaRepSrc: 'idrac' }, row: { hba_pct: 50 } }, { at: NOW, ok: true });
  const r = fixtureTargets();
  assert.deepEqual(r.targets.map((x) => x.name).sort(), ['bm-authbad', 'bm-both', 'bm-idrac', 'bm-osonly', 'esxi-01'], `전제 — 다섯 갈래가 대상 · ${JSON.stringify(r.skipped)}`);
  const demoish = DEMO.demoDisplayTargets(Array.from({ length: 3 }, (_, i) => ({ key: `DEMO${i}`, serverId: `mock-bmsrv-${i}`, name: `d${i}`, vcenterId: 'vcA', paths: ['idrac'], idrac: { regId: `mock-bmsrv-${i}` }, osHost: null, missing: ['no-os-cred'], license: { tier: 'unknown' } })));
  assert.ok(demoish.some((x) => x.demoOs), '전제 — 데모 표지가 붙은 대상이 있다(mock)');
  const spec = PF.PUBLIC_TARGET_SPEC;
  const unknown = new Set(); const nested = new Set();
  for (const x of [...r.targets, ...demoish]) {
    for (const k of Object.keys(x)) if (!Object.hasOwn(spec, k) && !PF.TARGET_PRIVATE_FIELDS.includes(k)) unknown.add(`대상.${k}`);
    const pt = T.publicTarget(x);
    for (const k of PF.TARGET_PRIVATE_FIELDS) assert.equal(Object.hasOwn(pt, k), false, `publicTarget 이 ${k} 를 뺀다`);
    for (const k of Object.keys(pt)) if (!Object.hasOwn(spec, k)) unknown.add(`공개.${k}`);
    for (const [k, v] of Object.entries(pt)) {
      if (spec[k] && typeof spec[k] === 'object' && v && typeof v === 'object') {
        for (const [k2, v2] of Object.entries(v)) {
          if (!Object.hasOwn(spec[k], k2)) nested.add(`${k}.${k2}`);
          else if (typeof spec[k][k2] === 'object' && v2) for (const k3 of Object.keys(v2)) if (!Object.hasOwn(spec[k][k2], k3)) nested.add(`${k}.${k2}.${k3}`);
        }
      }
    }
    // 왕복: 중앙 정제가 아는 필드를 하나도 잃지 않는다(값 · 꼴 그대로)
    const exp = jsonCopy(pt);
    const got = E.sanitizeBmUsageSnap({ node: { agent: 'e' }, targets: [exp] }, { receivedAt: NOW });
    assert.deepEqual(got.targets[0], exp, `${x.name} 왕복`);
    assert.equal(got.sanitizeUnknown, undefined);
  }
  assert.deepEqual([...unknown], [], '엣지 export 에 있는데 중앙 표(PUBLIC_TARGET_SPEC)에 없는 필드 — 표에 넣어야 중앙이 버리지 않는다');
  assert.deepEqual([...nested], [], '중첩 필드(license · hbaBasis)도 표에 있어야 한다');
  const hb = T.publicTarget(r.targets.find((x) => x.key === 'TAGB1')).hbaBasis;
  assert.ok(hb && hb.osFallback && hb.src === 'idrac', `전제 — 깊이 2 HBA 근거 · ${JSON.stringify(hb)}`);
  HB._resetHbaBasisForTest();
});

test('⑤b — targets.js 의 targets.push 리터럴 칸 · 펼침이 표(또는 비공개 칸)에 있다(실행하지 않은 갈래도 소스로)', () => {
  const src = stripComments(read(new URL('bmusage/targets.js', SRC)));
  const keys = new Set(); const spreads = new Set();
  let i = 0; let blocks = 0;
  while ((i = src.indexOf('targets.push({', i)) >= 0) {
    blocks += 1;
    const open = i + 'targets.push('.length;
    let depth = 0; let k = open; let q = null; const parts = []; let cur = '';
    for (; k < src.length; k += 1) {
      const ch = src[k];
      if (q) { cur += ch; if (ch === q && src[k - 1] !== '\\') q = null; continue; }
      if (ch === '\'' || ch === '"' || ch === '`') { q = ch; cur += ch; continue; }
      if ('{(['.includes(ch)) { depth += 1; if (depth === 1) continue; }
      else if ('})]'.includes(ch)) { depth -= 1; if (depth === 0) { parts.push(cur); break; } }
      if (depth === 1 && ch === ',') { parts.push(cur); cur = ''; continue; }
      cur += ch;
    }
    for (const p0 of parts) {
      const p = p0.trim();
      if (!p) continue;
      if (p.startsWith('...')) { spreads.add(p.slice(3).replace(/\s+/g, ' ')); continue; }
      const m = /^(\w+)\s*(?::|$)/.exec(p);
      assert.ok(m, `칸을 읽지 못함: ${p.slice(0, 60)}`);
      keys.add(m[1]);
    }
    i = k;
  }
  assert.ok(blocks >= 2, `targets.push 블록(베어메탈 · 가상화 호스트) — ${blocks}`);
  const bad = [...keys].filter((k) => !Object.hasOwn(PF.PUBLIC_TARGET_SPEC, k) && !PF.TARGET_PRIVATE_FIELDS.includes(k));
  assert.deepEqual(bad, [], '대상에 새 칸을 더하면 publicFields.js 에도 넣는다');
  assert.deepEqual([...spreads].sort(), ["(paths.includes('os') ? {} : regIdOf)", 'idOf(b)', 'idv'].sort(), '새 펼침이 생기면 그 칸들을 표와 대조해 이 목록을 고친다');
  for (const k of Object.keys(T.idOf({ serverId: 's', serviceTag: 'x', keyOverride: 'k' }))) assert.ok(Object.hasOwn(PF.PUBLIC_TARGET_SPEC, k), `idOf.${k}`);
});

test('⑤b — 가짜 엣지의 모르는 칸(password · osHost · idrac · 깊은 객체)은 버리고 세며, 문자열 수치는 수 · 객체 아닌 원소는 뺀다(재현 r10 의심 3)', () => {
  const s = E.sanitizeBmUsageSnap({ node: { agent: 'evil' }, targets: [
    { key: 'K1', name: 'n', vcenterId: 'vcA', paths: ['idrac', 'os', 'ssh', 7], password: 's3cret', osHost: { password: 'p', host: '10.0.0.1' }, idrac: { password: 'q' }, osRegId: 'o9',
      osMounts: '3', entAllowed: 'yes', license: { tier: 'enterprise', names: ['a', { x: 1 }], count: '2', secret: 'z' }, missing: ['no-os-cred', { a: 1 }], idracHost: null, osHostName: '',
      hbaBasis: { ports: '4', src: 'os', osFallback: { ports: 1, deep: { x: 1 } }, extra: 1 }, demoOs: 'true', osAuthUnresolved: 'x' },
    'x', null,
  ] }, { receivedAt: NOW });
  const x = s.targets[0];
  for (const k of ['password', 'osHost', 'idrac', 'osRegId']) assert.equal(Object.hasOwn(x, k), false, `${k} 는 싣지 않는다(재현 r10 — 예전 관리자 응답에 password)`);
  assert.deepEqual(x.paths, ['idrac', 'os'], '경로는 아는 값만');
  assert.equal(x.osMounts, 3); assert.equal(x.entAllowed, false); assert.equal(x.demoOs, false, '불리언은 true 만 참'); assert.equal(x.osAuthUnresolved, null);
  assert.deepEqual(x.license, { tier: 'enterprise', names: ['a'], count: 2 });
  assert.deepEqual(x.missing, ['no-os-cred']);
  assert.equal(x.idracHost, null, 'null(경로 없음)과 ’’(가림)을 가른다'); assert.equal(x.osHostName, '');
  assert.deepEqual(x.hbaBasis, { ports: 4, src: 'os', osFallback: { ports: 1 } });
  assert.equal(s.sanitizeDropped, 2, '객체 아닌 원소 2');
  assert.equal(s.sanitizeUnknown, 4, `모르는 윗 칸 수(password · osHost · idrac · osRegId — 중첩 안 모르는 칸은 버리기만) · ${s.sanitizeUnknown}`);
  assert.ok(!JSON.stringify(s).includes('s3cret') && !JSON.stringify(s).includes('"p"'), '비밀 글자가 어디에도 없다');
});

test('⑤b — 구버전 · 신버전 엣지 봉투: 없는 칸은 없는 채로(지어내지 않는다) · 아는 칸은 그대로', () => {
  // v2.554 무렵 엣지(대상 칸이 적고 행은 처음 15열만)
  const old = E.sanitizeBmUsageSnap({ node: { agent: 'old', version: '2.554.0' }, targets: [{ key: 'K', name: 'n', vcenterId: 'vcA', paths: ['idrac'], license: { tier: 'unknown', label: '미상' }, missing: [], idracHost: 'h', osHostName: null }],
    rows: [{ agent: 'old', key: 'K', ts: NOW - 60_000, name: 'n', vcenter_id: 'vcA', src: 'idrac', cpu_pct: 10, mem_pct: 20, disk_busy_pct: null, disk_used_pct: null, net_pct: 1, net_bps: 2, hba_pct: null, hba_bps: null, io_pct: 3 }] }, { receivedAt: NOW });
  assert.deepEqual(Object.keys(old.targets[0]).sort(), ['idracHost', 'key', 'license', 'missing', 'name', 'osHostName', 'paths', 'vcenterId']);
  assert.deepEqual(Object.keys(old.rows[0]).sort(), ['agent', 'cpu_pct', 'disk_busy_pct', 'disk_used_pct', 'hba_bps', 'hba_pct', 'io_pct', 'key', 'mem_pct', 'name', 'net_bps', 'net_pct', 'src', 'ts', 'vcenter_id']);
  assert.equal(old.rows[0].ts, NOW - 60_000); assert.equal(old.rows[0].atRaw, undefined, '자르지 않았으면 원본 칸도 없다');
  assert.equal(old.sanitizeUnknown, undefined);
});

/* ── ⑤ (a) 행 시각 · 열 표 ───────────────────────────────────────────────────── */
test('⑤a — 행 ts · os_at · idrac_at 은 수신 시각으로 자르고 원본은 atRaw(재현 r10 의심 2: 지금 + 30일이 그대로) · 수치 열은 수로 · 열 표 = usage_latest(PRAGMA)', async () => {
  const fut = NOW + 30 * 24 * H;
  const s = E.sanitizeBmUsageSnap({ node: { agent: 'e' }, rows: [{ key: 'K', name: 'n', ts: fut, os_at: String(fut), idrac_at: NOW - 5_000, cpu_pct: '12.5', mem_pct: 'oops', cpu_core_max_pct: '', detail_json: '{"x":1}', bogus: 1 }] }, { receivedAt: NOW });
  const r = s.rows[0];
  assert.equal(r.ts, NOW, '재현 r10 — 예전 지금 + 30일 그대로'); assert.equal(r.os_at, NOW); assert.equal(r.idrac_at, NOW - 5_000, '과거 시각은 그대로');
  assert.deepEqual(r.atRaw, { ts: fut, os_at: fut }, '원본은 따로(자른 칸만)');
  assert.equal(r.cpu_pct, 12.5, '문자열 수치 → 수'); assert.equal(r.mem_pct, null, '못 읽은 값은 null(0 이 아니다)'); assert.equal(r.cpu_core_max_pct, null);
  assert.equal(Object.hasOwn(r, 'detail_json'), false); assert.equal(Object.hasOwn(r, 'bogus'), false);
  assert.equal(s.sanitizeUnknown, 1, 'JSON 열은 세지 않고 모르는 열만');
  // 소비처(법인 사용량 · 통합 인벤토리 · CPU 최신값)는 snapAt 으로 한 번 더 자른다 — 같은 값(멱등)
  const { clampEdgeTs } = await import('../src/util/clampEdgeTs.js');
  assert.equal(clampEdgeTs(r.ts, NOW + 1_000), r.ts);
  // 열 표 = 실제 usage_latest 열(JSON 두 열 제외) — 새 열이 생기면 표에 넣어야 중앙이 버리지 않는다
  const D = await import('../src/bmusage/db.js');
  const db = await D.mainDbForMigration();
  assert.ok(db, 'bmusage DB 를 연다');
  const cols = db.prepare('PRAGMA table_info(usage_latest)').all().map((c) => c.name).filter((c) => !PF.LATEST_ROW_JSON_COLS.includes(c));
  assert.deepEqual([...cols].sort(), Object.keys(PF.LATEST_ROW_SPEC).sort(), 'LATEST_ROW_SPEC ⟺ usage_latest');
  const full = Object.fromEntries(cols.map((c) => [c, c === 'peak_src' ? 'sampler' : c === 'src_cm' ? 'oo' : ['agent', 'key', 'name', 'vcenter_id', 'src'].includes(c) ? 'v' : 1]));
  const back = E.sanitizeBmUsageSnap({ rows: [full] }, { receivedAt: NOW }).rows[0];
  assert.deepEqual(cols.filter((c) => !Object.hasOwn(back, c)), [], '모든 열이 남는다');
});

/* ── ⑤ (c) · 실제 HTTP 왕복 ──────────────────────────────────────────────────── */
async function fakeEdge(bodyOf) {
  const srv = await new Promise((r) => { const s = http.createServer((q, res) => { const b = bodyOf(q); res.writeHead(b.status || 200, { 'content-type': 'application/json' }); res.end(b.text); }).listen(0, '127.0.0.1', () => r(s)); });
  return { srv, url: `http://127.0.0.1:${srv.address().port}` };
}
test('⑤ 실제 중앙 ↔ 가짜 엣지 왕복 — 정제(password 버림 · 시각 자름) · 수신 상한 초과는 too-large(직전 보관분 유지) · 다른 상태 판정은 그대로', async () => {
  const reg = await import('../src/collector/registry.js');
  const r = fixtureTargets();
  let mode = 'ok';
  const fut = NOW + 30 * 24 * H;
  const envelope = () => ({ ok: true, node: { agent: 'edge-gb', version: '3.29.1', role: 'edge' }, at: Date.now(), enabled: true,
    settings: { intervalMs: 300_000, osSsh: true, idracTelemetry: true, corps: ['vcA'] },
    targets: r.targets.map((x) => ({ ...T.publicTarget(x), ...(x.name === 'bm-both' ? { password: 'leak-pw', osHost: { password: 'leak2' } } : {}) })),
    rows: [{ agent: 'edge-gb', key: 'TAGB1', name: 'bm-both', vcenter_id: 'vcA', ts: fut, os_at: fut, idrac_at: Date.now() - 60_000, cpu_pct: '41.5' }],
    counts: { targets: r.targets.length, os: 3 } });
  const { srv, url } = await fakeEdge(() => {
    if (mode === 'big') return { text: JSON.stringify({ ...envelope(), pad: 'x'.repeat(2 * 1_048_576) }) };
    if (mode === 'notjson') return { text: '<html>proxy</html>' };
    if (mode === 'big500') return { status: 500, text: 'y'.repeat(2 * 1_048_576) };
    return { text: JSON.stringify(envelope()) };
  });
  try {
    assert.equal(reg.addCollector({ id: 'edge-gb', name: 'edge-gb', url, token: 'tk' }, { managed: true }).ok, true);
    E._resetForTest();
    const ok = await E.pullBmUsage('edge-gb');
    assert.equal(ok.ok, true, JSON.stringify(ok).slice(0, 200));
    const snap = E.getEdgeBmUsage('edge-gb').snap;
    const both = snap.targets.find((x) => x.key === 'TAGB1');
    assert.equal(both.password, undefined); assert.equal(both.osHost, undefined);
    assert.ok(!JSON.stringify(snap).includes('leak'), '비밀 글자가 보관분 어디에도 없다');
    assert.deepEqual(both.paths, ['idrac', 'os']); assert.equal(both.osAuthUnresolved, false);
    assert.equal(snap.targets.find((x) => x.name === 'bm-authbad').osAuthUnresolved, true, '참조 미해석 표지가 봉투로 온다(⑥)');
    assert.ok(snap.rows[0].ts <= Date.now() && snap.rows[0].os_at <= Date.now(), '미래 시각을 자른다');
    assert.equal(snap.rows[0].atRaw.ts, fut); assert.equal(snap.rows[0].cpu_pct, 41.5);
    // 수신 상한 초과 — 예전 bad-body ‘응답 형식이 다릅니다(엣지가 아닌 서버…)’
    mode = 'big';
    const big = await E.pullBmUsage('edge-gb');
    assert.equal(big.ok, false); assert.equal(big.kind, 'too-large', `재현 r10 의심 1 — 예전 bad-body · ${big.reason}`);
    assert.match(big.reason, /상한/); assert.doesNotMatch(big.reason, /엣지가 아닌 서버에 닿았을/);
    const rec = E.getEdgeBmUsage('edge-gb');
    assert.equal(rec.lastAttempt.kind, 'too-large'); assert.ok(rec.snap && rec.snap.targets.length === r.targets.length, '직전 보관분은 지우지 않는다');
    mode = 'notjson';
    assert.equal((await E.pullBmUsage('edge-gb')).kind, 'bad-body', '작은 형식 오류는 그대로 bad-body');
    mode = 'big500';
    assert.equal((await E.pullBmUsage('edge-gb')).kind, 'http', '상태 코드 판정이 먼저(예전 그대로)');
  } finally { srv.close(); E._resetForTest(); }
});

test('⑤c — kind 열거 · 화면 문구 맵 다섯 곳이 too-large 를 덮는다 · 사다리가 내는 kind 는 열거 안', async () => {
  const { EDGE_PULL_KINDS } = await import('../src/central/edgePull.js');
  assert.ok(EDGE_PULL_KINDS.includes('too-large'));
  for (const f of ['views/tools/edgeLogText.js', 'views/collectors/EmptyInvModal.jsx', 'views/tools/focusMonText.js', 'views/tools/isiduText.js', 'views/tools/tokenCheckText.js']) {
    assert.match(read(new URL(f, WEB)), /^\s*'too-large':\s*/m, `${f} 에 too-large 문구가 없다`);
  }
  const src = stripComments(read(new URL('central/edgePull.js', SRC)));
  for (const m of src.matchAll(/fail\('([a-z-]+)'/g)) assert.ok(EDGE_PULL_KINDS.includes(m[1]), m[1]);
  const rc = stripComments(read(new URL('util/readCapped.js', SRC)));
  assert.equal((rc.match(/throw tooLarge\(/g) || []).length, 3, '상한 초과 세 곳이 모두 code too-large');
});

/* ── ⑥ 스냅샷 실행 표지 ──────────────────────────────────────────────────────── */
const ADM = { user: { username: 'adm', role: 'admin', scope: null } };
test('⑥a — 표지 why = 실행 code(같은 함수 snapshotOsPathIssue): auth-unresolved · no-os-path · demo-target(재현: 예전 표지 ok → 누르면 거절) · SSH 0회', async () => {
  const { snapRunGateOf } = await import('../src/routes/api/bmUsage.js');
  const { SNAPSHOT_CODE_STATUS } = await import('../src/bmusage/snapshot/command.js');
  const { WRITE_WHY } = await import('../src/routes/api/bmWriteGate.js');
  const sshNever = { withSsh: async () => { throw new Error('SSH 를 시도하면 안 된다'); }, withDeadline: async () => { throw new Error('시도 금지'); } };
  const cases = [
    { key: 'A', vcenterId: 'vcA', paths: ['os'], osHost: { host: '10.0.0.9', authError: '키 참조를 해석하지 못했습니다(키 없음)' } },
    { key: 'B', vcenterId: 'vcA', paths: ['idrac'], osHost: null },
    { key: 'C', vcenterId: 'vcA', paths: ['os'], osHost: { host: '  ' } },
    { key: 'D', vcenterId: 'vcA', paths: ['idrac'], osHost: null, demoOs: true, pathsShown: ['idrac', 'os'] },
  ];
  for (const tg of cases) {
    const g = snapRunGateOf(ADM, null, tg, RUN.snapshotOsPathIssue, 'local', RUN.snapshotPublicPathIssue);
    const run = await RUN.runSnapshotLocal({ target: tg, reason: '확인 사유', settings: {} }, sshNever);
    assert.equal(g.ok, false, `${tg.key} 표지가 닫힌다(재현: 예전 A 는 ok)`);
    assert.equal(g.why, run.code, `${tg.key} 표지 ⟺ 실행`);
    assert.ok(WRITE_WHY.includes(g.why), `${g.why} 는 WRITE_WHY 열거 안(웹 문구 1:1)`);
    assert.equal(SNAPSHOT_CODE_STATUS[run.code], 409, `${run.code} 409(예전 auth-unresolved 는 표에 없어 200 ok:false)`);
  }
  assert.equal(RUN.snapshotOsPathIssue({ key: 'E', osHost: { host: '10.0.0.1' } }), null);
  // 데모 계정 · 역할이 먼저(8회차 F2 그대로)
  assert.deepEqual(snapRunGateOf({ user: { username: 'thedvcdemp', role: 'admin', demoGuest: true } }, null, cases[0], RUN.snapshotOsPathIssue), { ok: false, why: 'demo' });
  // 엣지 스냅샷 응답 정제가 새 code 를 보존(예전 사본 SNAP_CODE_SET 에 auth-unresolved 가 없어 ssh-error 로 바뀌었다)
  assert.equal(E.sanitizeSnapshotBody({ ok: false, code: 'auth-unresolved', reason: 'x' }).code, 'auth-unresolved');
  assert.equal(E.sanitizeSnapshotBody({ ok: false, code: 'demo-target' }).code, 'demo-target');
});

test('⑥a — 엣지 대행: 공개 대상 판정(snapshotPublicPathIssue(publicTarget(x))) = 이 노드 판정(snapshotOsPathIssue(x)) — 실제 대상 해석 · 데모 표지', () => {
  const r = fixtureTargets();
  const demo = DEMO.demoDisplayTargets(Array.from({ length: 9 }, (_, i) => ({ key: `DM${i}`, serverId: `mock-bmsrv-${i}`, paths: ['idrac'], idrac: { regId: `mock-bmsrv-${i}` }, osHost: null, missing: ['no-os-cred'] })));
  const seen = new Set();
  for (const x of [...r.targets, ...demo]) {
    const want = RUN.snapshotOsPathIssue(x);
    seen.add(want);
    assert.equal(RUN.snapshotPublicPathIssue(jsonCopy(T.publicTarget(x))), want, `${x.key} ${want}`);
    // 봉투 정제를 지나도 같다
    const back = E.sanitizeBmUsageSnap({ targets: [jsonCopy(T.publicTarget(x))] }).targets[0];
    assert.equal(RUN.snapshotPublicPathIssue(back), want, `${x.key} 정제 뒤`);
  }
  assert.deepEqual([...seen].sort((a, b) => String(a).localeCompare(String(b))), ['auth-unresolved', 'demo-target', 'no-os-path', null].sort((a, b) => String(a).localeCompare(String(b))), '네 갈래를 모두 본다');
});

test('⑥b — 엣지 대행 GET 보관분: 표지 판정 근거(pathBasis = 엣지 보관분 시각) · 표지는 봉투의 osAuthUnresolved 로 닫힌다', async () => {
  const { bmSnapshotRead } = await import('../src/routes/api/bmUsage.js');
  const at = NOW - 7 * 60_000;
  const deps = {
    currentTargets: async () => ({ targets: [] }), bmAddressHosts: async () => [],
    listEdgeBmUsage: async () => [{ agent: 'edge-gb', snapAt: at, snap: { targets: [{ key: 'E1', name: 'e1', vcenterId: 'vcA', paths: ['os'], osAuthUnresolved: true }] } }],
    pullEdge: async () => ({ ok: true, code: 'ok', snapshots: [], keepDays: 7 }),
  };
  const body = await bmSnapshotRead({ ...ADM, params: { key: 'E1' }, query: { vcenterId: 'vcA' } }, null, deps);
  assert.equal(body.via, 'edge');
  assert.deepEqual(body.pathBasis, { via: 'edge', at });
  assert.deepEqual(body.actions.run, { ok: false, why: 'auth-unresolved' });
  const local = await bmSnapshotRead({ ...ADM, params: { key: 'L1' }, query: { vcenterId: 'vcA' } }, null, { ...deps,
    currentTargets: async () => ({ targets: [{ key: 'L1', vcenterId: 'vcA', paths: ['os'], osHost: { host: '10.0.0.1' } }] }), listEdgeBmUsage: async () => [],
    listLocal: async () => ({ ok: true, code: 'ok', snapshots: [], keepDays: 7 }) });
  assert.deepEqual(local.pathBasis, { via: 'local' }); assert.deepEqual(local.actions.run, { ok: true });
});

/* ── ④ 데모 표시 경로 ───────────────────────────────────────────────────────── */
test('④ 데모(mock) — currentTargets 가 표시 표지를 싣고 KPI(counts) = 겹침이 OS 열을 싣는 대상 수 · paths · osHost 그대로 · 주 조회 응답도 같은 값', async () => {
  const n = 12;
  const servers = Array.from({ length: n }, (_, i) => ({ id: `mock-bmsrv-vcA-n${String(i).padStart(2, '0')}`, name: `demo-n${i}`, host: `10.7.0.${i + 1}`, username: 'root', password: 'p' }));
  fs.writeFileSync(path.join(DIR, 'idrac.json'), JSON.stringify({ servers }));
  const poller = await import('../src/bmusage/poller.js');
  poller._setFleetForTest(async () => ({ bareMetal: servers.map((s, i) => ({ serverId: s.id, fleetId: s.id, name: s.name, serviceTag: `DMTAG${String(i).padStart(2, '0')}`, vcenterId: '' })), virtualizationHosts: [] }));
  try {
    const tg = await poller.currentTargets();
    assert.equal(tg.targets.length, n, `전제 — 데모 대상 ${n}대 · ${JSON.stringify(tg.skipped).slice(0, 200)}`);
    const rows = DEMO.demoPerfLatestRows(tg.targets.map((x) => ({ key: x.key, ts: NOW })), tg.targets);
    const osRows = rows.filter((x) => x.os_at != null).length;
    assert.equal(osRows, n - Math.ceil(n / 9), '전제 — 9 순위마다 하나는 iDRAC 만');
    assert.equal(tg.counts.os, osRows, `재현 r10 L1 — 예전 KPI OS 0 · 겹침 ${osRows}`);
    assert.equal(tg.counts.both, osRows); assert.equal(tg.counts.idrac, n);
    const shown = tg.targets.filter((x) => x.demoOs);
    assert.equal(shown.length, osRows, '표지 대상 = 겹침 대상(같은 순위 표)');
    for (const x of tg.targets) {
      assert.deepEqual(x.paths, ['idrac'], '대상 paths 는 그대로(SSH 시도 없음)');
      assert.equal(x.osHost, null, 'osHost 를 만들지 않는다');
      const row = rows.find((r) => r.key === x.key);
      assert.equal(!!x.demoOs, row.os_at != null, `${x.key} 표지 ⟺ 겹침`);
      if (x.demoOs) { assert.deepEqual(x.pathsShown, ['idrac', 'os']); assert.deepEqual(x.missingShown, []); assert.equal(RUN.snapshotOsPathIssue(x), 'demo-target'); } else assert.equal(RUN.snapshotOsPathIssue(x), 'no-os-path');
    }
    // 주 조회 응답(실제 라우트 처리기) — counts · 공개 대상 표지
    const B = await import('../src/routes/api/bmUsage.js');
    const handlers = {};
    const api = new Proxy({}, { get: (_, m) => (p, ...h) => { handlers[`${String(m).toUpperCase()} ${p}`] = h[h.length - 1]; } });
    B.registerBmUsage(api);
    const res = { statusCode: 200, body: null, headers: {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, set() { return this; }, setHeader() {}, getHeader() {} };
    await handlers['GET /tools/bm-usage']({ ...ADM, params: {}, query: {}, headers: {}, get() { return undefined; } }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body).slice(0, 300));
    assert.equal(res.body.counts.os, osRows, 'KPI OS 경로 = 칩 · 표 · CSV 가 읽는 표시 경로 수');
    assert.equal(res.body.targets.filter((x) => (x.pathsShown || x.paths).includes('os')).length, osRows);
    assert.ok(res.body.targets.every((x) => !x.osHost && !x.idrac), '비밀 칸 없음');
    // 범위 계정 갈래(counts 를 보이는 대상으로 다시 센다)도 같은 함수
    assert.deepEqual(T.pathCountsOf(res.body.targets), { idrac: n, os: osRows, both: osRows });

    // ⑤ 자기 왕복(실제 collector 라우터 = 엣지 · 실제 봉투 buildBmUsageEnvelope · 실제 중앙 pull) — 실제 export 의 칸이 표에 다 있어 아무것도 버리지 않는다(sanitizeUnknown 없음)
    const express = (await import('express')).default;
    const { collectorRouter } = await import('../src/routes/collector.js');
    const app = express(); app.use('/api/collector', collectorRouter);
    const srv = await new Promise((r) => { const s2 = app.listen(0, '127.0.0.1', () => r(s2)); });
    try {
      const reg = await import('../src/collector/registry.js');
      assert.equal(reg.addCollector({ id: 'self-gb', name: 'self-gb', url: `http://127.0.0.1:${srv.address().port}`, token: 'tok-nextgb' }, { managed: true }).ok, true);
      E._resetForTest();
      const env = await E.pullBmUsage('self-gb');
      assert.equal(env.ok, true, JSON.stringify(env).slice(0, 300));
      const snap = env.rec.snap;
      assert.equal(snap.sanitizeUnknown, undefined, '실제 봉투의 대상 · 행 칸은 전부 표에 있다');
      assert.equal(snap.targets.length, n);
      assert.equal(snap.targets.filter((x) => x.demoOs === true).length, osRows, '데모 표지가 봉투로 온다(엣지 대행 화면도 같은 값)');
      assert.equal(snap.counts.os, osRows, '봉투 counts 도 표시 경로로');
      for (const x of snap.targets) assert.equal(RUN.snapshotPublicPathIssue(x), x.demoOs ? 'demo-target' : 'no-os-path', `${x.key} 엣지 대행 표지`);
    } finally { srv.close(); E._resetForTest(); }
  } finally { poller._setFleetForTest(null); }
});

test('④ mock 이 아니면 아무것도 바뀌지 않는다(실운영 대상 · 같은 배열) · 경로 대수는 예전 규칙(paths)', async () => {
  const RS = await import('../src/runtime-settings.js');
  assert.equal(RS.setDataSource('live').ok, true);
  try {
    const list = Array.from({ length: 9 }, (_, i) => ({ key: `DM${i}`, serverId: `mock-bmsrv-${i}`, paths: ['idrac'], idrac: { regId: `mock-bmsrv-${i}` } }));
    assert.equal(DEMO.demoDisplayTargets(list), list, 'live — 입력 그대로(표지 0)');
    const r = fixtureTargets();
    assert.deepEqual(T.pathCountsOf(r.targets), { idrac: r.counts.idrac, os: r.counts.os, both: r.counts.both });
    assert.deepEqual({ idrac: r.counts.idrac, os: r.counts.os, both: r.counts.both }, { idrac: 4, os: 3, both: 2 }, '대상 해석의 경로 대수(예전과 같은 규칙)');
    assert.ok(r.targets.every((x) => !('pathsShown' in x) && !('demoOs' in x)));
  } finally { RS.setDataSource('mock'); }
});

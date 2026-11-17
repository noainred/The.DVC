/**
 * 전체 점검 84회차 — 중앙 ↔ 엣지 수신 코어(central/ 공통 · routes/central).
 *
 * F1 central/fleet.js setEdgeFleet 의 generatedAt 이 글자 길이 제한 없이 캐시 · 파일 · 응답에 남았다(/inventory 14회차 C-3 형제).
 * F2 routes/central.js narrowGpuRow · sanitizeVcLocation · register-collector 의 상주 글자가 `.slice` 로 원문을 붙잡았다(TIM2607-01 누락).
 * F3 central/token.js persistEnv 가 portal.env 를 **읽지 못하면** 빈 파일로 보고 한 줄짜리 파일로 덮어썼다(AUTH_SECRET 등 소실).
 *
 * ⚠ 저장소 server/config 오염 방지 — 모듈 import 전에 CONFIG_DIR 을 임시 폴더로 고정한다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };
const rmTmpDirs = () => { for (const d of TMP_DIRS) fs.rmSync(d, { recursive: true, force: true }); };
after(() => { rmTmpDirs(); process.once('exit', () => { try { rmTmpDirs(); } catch { /* 종료 중 */ } }); });

const CFG = tmpDir('central84-');
Object.assign(process.env, { CONFIG_DIR: CFG, DATA_SOURCE: 'live', AUTH_ENABLED: 'false' });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRCDIR = path.join(HERE, '..', 'src');

/* ── F1 ─────────────────────────────────────────────────────────────── */
test('84 F1: /fleet generatedAt 은 유한수 또는 40자 글자만 — 수 MB 글자가 캐시 · 응답에 남지 않는다', async () => {
  const fleet = await import('../src/central/fleet.js');
  fleet.resetEdgeFleet();
  fleet.setEdgeFleet('edge84', [{ fleetId: 'f1', name: 'bm1' }], 'G'.repeat(3_000_000), { verified: true });
  let row = fleet.listEdgeFleet().find((x) => x.agent === 'edge84');
  assert.equal(typeof row.generatedAt, 'string');
  assert.ok(row.generatedAt.length <= 40, `generatedAt ${row.generatedAt.length}자`);
  // 정상 입력은 그대로(엣지 fleetPush 는 ISO 글자 또는 ms 를 보낸다)
  fleet.setEdgeFleet('edge84', [{ fleetId: 'f1', name: 'bm1' }], '2026-11-17T01:02:03.456Z', { verified: true });
  row = fleet.listEdgeFleet().find((x) => x.agent === 'edge84');
  assert.equal(row.generatedAt, '2026-11-17T01:02:03.456Z');
  const ms = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  fleet.setEdgeFleet('edge84', [{ fleetId: 'f1', name: 'bm1' }], ms, { verified: true });
  assert.equal(fleet.listEdgeFleet().find((x) => x.agent === 'edge84').generatedAt, ms);
  // 객체 · 빈 글자 · 공백은 모름(null)
  for (const bad of [{ a: 1 }, ['x'], '', '   ', null]) {
    fleet.setEdgeFleet('edge84', [{ fleetId: 'f1', name: 'bm1' }], bad, { verified: true });
    assert.equal(fleet.listEdgeFleet().find((x) => x.agent === 'edge84').generatedAt, null, JSON.stringify(bad));
  }
  fleet.resetEdgeFleet();
});

test('84 F1: 상한 이전에 저장된 central-fleet.json 의 긴 generatedAt 도 올릴 때 줄인다', () => {
  const dir = tmpDir('central84-fleetload-');
  const at = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  fs.writeFileSync(path.join(dir, 'central-fleet.json'), JSON.stringify({ fleet: { edgeL: { at, generatedAt: 'Z'.repeat(500_000), baremetal: [{ fleetId: 'a', name: 'a' }] } } }));
  const script = `
    const fleet = await import(${JSON.stringify(path.join(SRCDIR, 'central/fleet.js'))});
    const r = fleet.listEdgeFleet().find((x) => x.agent === 'edgeL');
    console.log('@@' + JSON.stringify({ len: r ? String(r.generatedAt).length : -1 }));
    process.exit(0);
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, CONFIG_DIR: dir, CENTRAL_FLEET_TTL_MS: String(10 * 86_400_000) }, encoding: 'utf8', timeout: 60_000 });
  const { len } = JSON.parse(out.split('\n').find((l) => l.startsWith('@@')).slice(2));
  assert.ok(len > 0 && len <= 40, `올린 generatedAt ${len}자`);
});

/* ── F2 ─────────────────────────────────────────────────────────────── */
test('84 F2: gpu-guest-data 행의 상주 글자는 원문을 붙잡지 않는다(실측 — 잔존 힙)', () => {
  const script = `
    const c = await import(${JSON.stringify(path.join(SRCDIR, 'routes/central.js'))});
    const big = (p) => JSON.parse(JSON.stringify(p + 'A'.repeat(2 * 1024 * 1024)));
    globalThis.gc(); const h0 = process.memoryUsage().heapUsed;
    const keep = [];
    for (let i = 0; i < 8; i++) {
      keep.push(c.narrowGpuRow({ hostId: big('vc-site-1:h' + i), utilPct: 5, host: big('n'), vcenterId: big('v'), name: big('m') }));
      keep.push(c.sanitizeVcLocation({ city: big('c'), country: big('k') }).value);
    }
    globalThis.gc(); const h1 = process.memoryUsage().heapUsed;
    const r = keep[0];
    console.log('@@' + JSON.stringify({ mb: (h1 - h0) / 1e6, idLen: r.hostId.length, hostLen: r.host.length, cityLen: keep[1].city.length }));
    process.exit(0);
  `;
  const out = execFileSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: tmpDir('central84-heap-') }, encoding: 'utf8', timeout: 60_000,
  });
  const r = JSON.parse(out.split('\n').find((l) => l.startsWith('@@')).slice(2));
  assert.equal(r.idLen, 256); assert.equal(r.hostLen, 256); assert.equal(r.cityLen, 128); // 잘리는 길이는 예전 그대로
  // 수정 전: 8 × (2MB × 4 + 2MB × 2) ≈ 100MB 잔존(실측 narrowGpuRow 만 약 50MB). 수정 후: 수 MB.
  assert.ok(r.mb < 20, `잔존 힙 ${r.mb.toFixed(1)}MB — 잘린 글자가 원문을 붙잡고 있다`);
});

test('84 F2: routes/central.js 의 상주 정제 함수에 `.slice(0, N)` 글자 절단이 남지 않는다(스윕)', () => {
  const src = stripComments(fs.readFileSync(path.join(SRCDIR, 'routes/central.js'), 'utf8'));
  const body = (name) => { const i = src.indexOf(name); assert.ok(i >= 0, name); return src.slice(i, src.indexOf('\n}\n', i)); };
  for (const fn of ['export function narrowGpuRow', 'export function sanitizeVcLocation']) {
    assert.doesNotMatch(body(fn), /(?:String\([^)]*\)|x\[k\]|v\[k\])\.slice\(0,\s*\d+\)/, `${fn} 에 상주 .slice 절단`);
  }
  const reg = src.slice(src.indexOf("centralRouter.post('/register-collector'"), src.indexOf("centralRouter.post('/result'"));
  assert.doesNotMatch(reg, /b\.(datacenter|version)\.slice\(/, 'register-collector datacenter · version 은 capStr');
});

/* ── F3 ─────────────────────────────────────────────────────────────── */
test('84 F3: portal.env 를 읽지 못하면 setCentralToken 은 던지고 파일 · 실행 중 토큰을 바꾸지 않는다', async () => {
  const tok = await import('../src/central/token.js');
  const { config } = await import('../src/config.js');
  const envFile = tok.centralTokenInfo().envFile;
  const orig = 'AUTH_SECRET=keepme-84\nDATA_SOURCE=live\nCENTRAL_TOKEN=old84token\n';
  fs.writeFileSync(envFile, orig);
  const before = config.central?.token;
  const beforeEnv = process.env.CENTRAL_TOKEN;
  const realRead = fs.readFileSync;
  fs.readFileSync = function (p, ...a) {
    if (String(p) === envFile) { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; }
    return realRead.call(this, p, ...a);
  };
  try {
    assert.throws(() => tok.setCentralToken('new84token'), /읽지 못해 저장하지 않았습니다/);
  } finally { fs.readFileSync = realRead; }
  assert.equal(fs.readFileSync(envFile, 'utf8'), orig, '나머지 설정이 지워지지 않는다');
  assert.equal(config.central?.token, before, '실행 중 토큰도 그대로');
  assert.equal(process.env.CENTRAL_TOKEN, beforeEnv);
  // 읽을 수 있으면 예전처럼 그 키만 바꾸고 나머지는 둔다 · 파일이 없으면 새로 만든다
  tok.setCentralToken('new84token');
  const now = fs.readFileSync(envFile, 'utf8');
  assert.match(now, /^AUTH_SECRET=keepme-84$/m); assert.match(now, /^CENTRAL_TOKEN=new84token$/m);
  assert.equal(config.central.token, 'new84token');
  fs.rmSync(envFile);
  tok.setCentralToken('fresh84token');
  assert.match(fs.readFileSync(envFile, 'utf8'), /^CENTRAL_TOKEN=fresh84token$/m);
});

/* ── 개선 ───────────────────────────────────────────────────────────── */
test('84 개선: 엣지 토큰 적용 push 주소의 끝 슬래시는 선형 함수로 뗀다(정규식 반복 금지)', async () => {
  const src = stripComments(fs.readFileSync(path.join(SRCDIR, 'central/tokenApplyDeps.js'), 'utf8'));
  assert.doesNotMatch(src, /\.replace\(\/\\\/\+\$\//);
  const { pushTokenToEdge } = await import('../src/central/tokenApplyDeps.js');
  let seen = '';
  await pushTokenToEdge({ url: 'https://edge.invalid:4000///', token: 't', id: 'e' }, 'x', { fetchImpl: async (u) => { seen = u; return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }); } });
  assert.equal(seen, 'https://edge.invalid:4000/api/collector/central-token');
});

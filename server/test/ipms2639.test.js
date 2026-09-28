/**
 * v2.639 IPMS — 대역 문법 판정 코어 하나(`ipam/rangeSyntax.js checkRangeSpec`).
 *
 * 리드가 node 로 재현한 결함: 같은 문법 판정기가 서버에 네 벌이었다 — `rangeSyntax.checkRangeSpec`(v2.637 엄격) ·
 * `scan.js rangeSize`·`expandRange`(느슨) · `rangePolicies.specToRange`(느슨).
 *   | 입력             | rangeSize  | expandRange | checkRangeSpec |
 *   | 10.0.0.0/8/x     | 16777214   | 4096개      | 오류           |
 *   | 10.0.0.250-300   | 51         | …10.0.1.44  | 오류           |
 *   | 10.0.0.0/24.5    | 179.019    | 180개       | 오류           |
 *   | 10.0.0.1-2-3     | 2          | 2개         | 오류           |
 * 그래서 PUT /admin/ipam/vc-ranges 는 거부하는 줄을 CSV 가져오기 2종과 PUT /admin/ipam/scan/settings(검사 0)는 저장했고,
 * `/24.5` 만 있는 에이전트 대역은 엣지가 180개를 스캔한 뒤 중앙 `/ip-scan-result` 가 specToRange null → 전부 409 거부했다.
 *
 * 고정하는 것:
 *   ① 재현 4입력 + 정상 6입력을 여섯 경로에 넣어 '유효/무효' 가 전부 같다 — 경로별 크기 의미 차이는 명시 값으로 고정
 *      (`/24` → rangeSize·specToRange 254, checkRangeSpec 256 · `/32`·`/31` 은 전체 · `/20` 은 4094 로 RANGE_CAP 안).
 *   ② PUT /admin/ipam/scan/settings 를 실제 라우터로 띄워 400 + invalid(field 'ranges'·agent) / 200 + warnings.
 *      GET /tools/ipam/vc-ranges 는 저장된 옛 값 중 이제 무효인 줄을 `invalid` 로 밝힌다.
 *   ③ scan.js 소스에 자체 `split('/')`·`split('-')` 파서가 남아 있지 않다(주석 제거 후).
 *   ④ rangePolicies·vcRangesCsv·scanRangesCsv 가 rangeSyntax 를 import 한다 · CSV 오류 사유가 checkRangeSpec.reason 을 싣는다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';
import { checkRangeSpec } from '../src/ipam/rangeSyntax.js';
import { rangeSize, expandRange, RANGE_CAP } from '../src/ipam/scan.js';
import { specToRange } from '../src/ipam/rangePolicies.js';
import { analyzeVcRangesImport } from '../src/ipam/vcRangesCsv.js';
import { analyzeScanRangesImport } from '../src/ipam/scanRangesCsv.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const src = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8');

const BAD = ['10.0.0.0/8/x', '10.0.0.250-300', '10.0.0.0/24.5', '10.0.0.1-2-3'];
const GOOD = ['10.0.0.0/24', '10.0.0.1-50', '10.0.0.5', '192.168.1.1-50', '10.0.0.0/20', '10.0.0.0/32'];

/** 여섯 경로의 '유효한가' 판정. */
function verdicts(spec) {
  const vc = analyzeVcRangesImport([{ _line: 2, vcenter: 'vc1', ranges: [spec], enabled: true }], { resolveVc: () => 'vc1', hasExisting: () => false });
  const sc = analyzeScanRangesImport([{ _line: 2, agent: '__local__', range: spec }], { mode: 'replace', current: new Map(), rangeCap: RANGE_CAP });
  return {
    checkRangeSpec: checkRangeSpec(spec, { reversed: 'error' }).ok,
    rangeSize: rangeSize(spec) > 0,
    expandRange: expandRange(spec).length > 0,
    specToRange: specToRange(spec) != null,
    analyzeVcRangesImport: vc.report[0].action !== 'error',
    analyzeScanRangesImport: sc.report[0].action !== 'error',
  };
}

test('① 재현 4입력은 여섯 경로 전부 무효, 정상 6입력은 전부 유효 — 판정이 갈라지지 않는다', () => {
  for (const s of BAD) {
    const v = verdicts(s);
    for (const [k, ok] of Object.entries(v)) assert.equal(ok, false, `${s} 를 ${k} 가 유효로 봤다(수정 전 결함)`);
  }
  for (const s of GOOD) {
    const v = verdicts(s);
    for (const [k, ok] of Object.entries(v)) assert.equal(ok, true, `${s} 를 ${k} 가 무효로 봤다`);
  }
});

test('① 경로별 크기 의미는 그대로 — CIDR 은 스캔·정책에서 네트워크·브로드캐스트 제외, 판정기는 포함', () => {
  assert.equal(rangeSize('10.0.0.0/24'), 254);
  assert.equal(specToRange('10.0.0.0/24').size, 254);
  assert.equal(expandRange('10.0.0.0/24').length, 254);
  assert.equal(expandRange('10.0.0.0/24')[0], '10.0.0.1');
  assert.equal(expandRange('10.0.0.0/24').at(-1), '10.0.0.254');
  assert.equal(checkRangeSpec('10.0.0.0/24').size, 256, '판정기의 size 는 네트워크·브로드캐스트 포함');
  // /31·/32 는 전체(예전 동작)
  assert.equal(rangeSize('10.0.0.0/32'), 1); assert.equal(specToRange('10.0.0.0/32').size, 1);
  assert.equal(rangeSize('10.0.0.0/31'), 2); assert.deepEqual(expandRange('10.0.0.0/31'), ['10.0.0.0', '10.0.0.1']);
  assert.equal(rangeSize('10.0.0.0/30'), 2, '/30 은 4 − 2');
  // /20 은 4094 — RANGE_CAP(4096) 안이라 전량, /19 는 상한에서 잘린다(예전 동작)
  assert.equal(rangeSize('10.0.0.0/20'), 4094);
  assert.equal(expandRange('10.0.0.0/20').length, 4094);
  assert.equal(rangeSize('10.0.0.0/19'), 8190, 'rangeSize 는 상한 미적용(표시용)');
  assert.equal(expandRange('10.0.0.0/19').length, RANGE_CAP, 'expandRange 는 앞 RANGE_CAP 개만');
  // 범위·단일 IP 의 의미는 판정기와 같다
  assert.equal(rangeSize('192.168.1.1-50'), 50);
  assert.deepEqual(specToRange('10.0.0.1-50'), { lo: checkRangeSpec('10.0.0.1-50').lo, hi: checkRangeSpec('10.0.0.1-50').hi, size: 50 });
  assert.deepEqual(expandRange('10.0.0.5'), ['10.0.0.5']);
  // 경계 아닌 CIDR 은 판정기처럼 경계로 내려 읽는다(예전 동작 그대로)
  assert.equal(expandRange('10.0.0.5/24')[0], '10.0.0.1');
  // 뒤집힌 범위는 스캔·정책에서 무효(v2.637 규약 — 무시·분류 목록만 바꿔 읽는다)
  assert.equal(rangeSize('10.0.0.50-10.0.0.1'), 0);
  assert.equal(specToRange('10.0.0.50-10.0.0.1'), null);
  assert.equal(checkRangeSpec('10.0.0.50-10.0.0.1').ok, true, '무시 목록 판정은 여전히 바꿔 읽는다');
});

test('④ CSV 2종의 오류 사유는 checkRangeSpec.reason 을 그대로 싣는다 · 상한 경고는 판정기 size 기준', () => {
  const vc = analyzeVcRangesImport([{ _line: 2, vcenter: 'vc1', ranges: ['10.0.0.0/24', '10.0.0.0/24.5'], enabled: true }], { resolveVc: () => 'vc1', hasExisting: () => false });
  assert.equal(vc.report[0].action, 'error');
  assert.match(vc.report[0].reason, /대역 문법 오류: '10\.0\.0\.0\/24\.5'/);
  assert.match(vc.report[0].reason, new RegExp(checkRangeSpec('10.0.0.0/24.5').reason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '판정기의 사유 문구가 그대로');
  const sc = analyzeScanRangesImport([
    { _line: 2, agent: '__local__', range: '10.0.0.250-300' },
    { _line: 3, agent: '__local__', range: '10.0.0.0/20' },
    { _line: 4, agent: 'edge-a', range: '10.0.0.0/16' },
  ], { mode: 'replace', current: new Map(), rangeCap: RANGE_CAP });
  assert.equal(sc.report[0].action, 'error');
  assert.match(sc.report[0].reason, /끝 .* 보다 작습니다|마지막 옥텟/, '끝 옥텟 300 은 판정기 사유로');
  assert.equal(sc.report[1].action, 'add'); assert.equal(sc.report[1].warn, undefined, '/20 = 4096(판정기 size) 은 상한 경고 없음');
  assert.equal(sc.report[2].action, 'add'); assert.match(sc.report[2].warn, /65,536개/, '/16 은 판정기 size 로 경고');
  assert.equal(sc.summary.warn, 1);
  // 예전 `rangeSize` 주입 인자는 받아도 무시한다(호환)
  const legacy = analyzeScanRangesImport([{ _line: 2, agent: '__local__', range: '10.0.0.0/24.5' }], { mode: 'replace', current: new Map(), rangeSize: () => 180, rangeCap: RANGE_CAP });
  assert.equal(legacy.report[0].action, 'error', '느슨한 rangeSize 를 주입해도 판정은 checkRangeSpec');
});

test('③ scan.js 에는 자체 대역 파서(split(\'/\')·split(\'-\'))가 없고 numToIp 사본도 없다 · ④ 세 모듈이 rangeSyntax 를 import 한다', () => {
  const scan = stripComments(src('ipam', 'scan.js'));
  assert.equal(/\.split\(\s*['"]\/['"]\s*\)/.test(scan), false, 'scan.js 에 split(\'/\') 파서가 남아 있다');
  assert.equal(/\.split\(\s*['"]-['"]\s*\)/.test(scan), false, 'scan.js 에 split(\'-\') 파서가 남아 있다');
  assert.equal(/const\s+numToIp\s*=/.test(scan), false, 'numToIp 사본 — util/ipv4.js 를 쓴다');
  assert.match(scan, /import \{[^}]*\bnumToIp\b[^}]*\} from '\.\.\/util\/ipv4\.js'/);
  assert.match(scan, /import \{ checkRangeSpec \} from '\.\/rangeSyntax\.js'/);
  for (const f of ['rangePolicies.js', 'vcRangesCsv.js', 'scanRangesCsv.js']) {
    const s = stripComments(src('ipam', f));
    assert.match(s, /import \{[^}]*\bcheckRangeSpec\b[^}]*\} from '\.\/rangeSyntax\.js'/, `${f} 가 rangeSyntax 를 import 하지 않는다`);
    assert.equal(/\.split\(\s*['"]\/['"]\s*\)/.test(s), false, `${f} 에 split('/') 파서가 남아 있다`);
  }
  const pol = stripComments(src('ipam', 'rangePolicies.js'));
  assert.equal(/\bipToNum\b/.test(pol), false, 'rangePolicies 는 더 이상 직접 파싱하지 않는다');
  // 죽은 export 비공개화(삭제 아님) — 모듈 내부에서는 그대로 쓴다
  const csv = stripComments(src('ipam', 'scanRangesCsv.js'));
  for (const name of ['SCAN_RANGES_COLUMNS', 'SCAN_RANGES_MAX_ROWS', 'AGENT_NAME_MAX', 'normRange', 'normAgent']) {
    assert.equal(new RegExp(`export (const|function) ${name}\\b`).test(csv), false, `${name} 은 export 하지 않는다`);
    assert.ok(new RegExp(`\\b${name}\\b`).test(csv), `${name} 은 모듈 안에 남아 있다`);
  }
});

// ── ② 실제 라우터: PUT /admin/ipam/scan/settings · GET /tools/ipam/vc-ranges ───────────────────────────────
function runChild(body, { setup = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipms2639-'));
  if (setup) setup(dir);
  const script = `
    const SRC = ${JSON.stringify(SRC + '/')};
    const fs = await import('node:fs'); const path = await import('node:path');
    const express = (await import('express')).default;
    const { store } = await import(SRC + 'store.js');
    await store.refresh?.();
    const { api } = await import(SRC + 'routes/api.js');
    const { adminRouter } = await import(SRC + 'routes/admin.js');
    const app = express(); app.use(express.json({ limit: '5mb' }));
    app.use((req, _r, n) => { req.user = { username: 'full', role: 'admin', scope: null }; n(); });
    app.use('/api/admin', adminRouter); app.use('/api', api);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = 'http://127.0.0.1:' + srv.address().port;
    const call = async (method, p, b) => {
      const r = await fetch(base + '/api' + p, { method, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
      const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { j = t.slice(0, 300); }
      return { s: r.status, j };
    };
    const CFG = process.env.CONFIG_DIR;
    const readJson = (f) => { try { return JSON.parse(fs.readFileSync(path.join(CFG, f), 'utf8')); } catch { return null; } };
    const out = {};
    try { ${body} } catch (e) { out.err = String(e && e.stack || e); } finally { srv.close(); }
    console.log('@@' + JSON.stringify(out));
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUTH_ENABLED: 'false' },
    encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 180_000,
  });
  assert.equal(r.status, 0, `자식 프로세스 실패: ${(r.stderr || '').slice(-2000)}`);
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, `출력 없음: ${r.stdout.slice(-1000)} ${r.stderr.slice(-1000)}`);
  const o = JSON.parse(line.slice(2));
  assert.equal(o.err, undefined, o.err);
  return o;
}

test('② PUT /admin/ipam/scan/settings 는 형제 vc-ranges 와 같은 판정 — 400 + invalid(field·agent) · 200 + warnings · 문자열 입력도 같은 규칙', () => {
  const o = runChild(`
    const bad = await call('PUT', '/admin/ipam/scan/settings', { agent: 'edge-x', ranges: ['abc', '10.0.0.0/'] });
    out.badS = bad.s; out.badInvalid = bad.j.invalid; out.badReason = bad.j.reason;
    out.fileAfterBad = readJson('ipam-scan.json');
    const repro = await call('PUT', '/admin/ipam/scan/settings', { agent: 'edge-x', ranges: '10.0.0.0/24.5\\n10.0.0.250-300,10.0.0.1-2-3' });
    out.reproS = repro.s; out.reproLines = (repro.j.invalid || []).map((x) => x.line + ':' + x.value);
    const ok = await call('PUT', '/admin/ipam/scan/settings', { agent: 'edge-x', ranges: '10.0.0.0/24\\n10.0.0.0/24\\n10.0.0.0/16' });
    out.okS = ok.s; out.okRanges = ok.j.settings && ok.j.settings.ranges; out.okWarnings = (ok.j.warnings || []).map((w) => w.line);
    const local = await call('PUT', '/admin/ipam/scan/settings', { ranges: ['10.9.0.0/24'], enabled: false });
    out.localS = local.s; out.localAgent = local.j.agent;
    const noRanges = await call('PUT', '/admin/ipam/scan/settings', { agent: 'edge-x', enabled: true });
    out.noRangesS = noRanges.s; out.noRangesKept = noRanges.j.settings && noRanges.j.settings.ranges;
  `);
  assert.equal(o.badS, 400, '수정 전: 검사 0 으로 200 저장됐다');
  assert.deepEqual(o.badInvalid.map((x) => `${x.field}:${x.agent}:${x.line}`), ['ranges:edge-x:1', 'ranges:edge-x:2']);
  assert.match(o.badReason, /2개/);
  assert.equal(o.fileAfterBad, null, '400 이면 파일이 생기지 않는다');
  assert.equal(o.reproS, 400);
  assert.deepEqual(o.reproLines, ['1:10.0.0.0/24.5', '2:10.0.0.250-300', '3:10.0.0.1-2-3'], '문자열 입력은 [\\n,] 로 나눈다(saveScanSettings 와 같다)');
  assert.equal(o.okS, 200);
  assert.deepEqual(o.okRanges, ['10.0.0.0/24', '10.0.0.0/24', '10.0.0.0/16']);
  assert.deepEqual(o.okWarnings, [2, 3], '중복 대역 경고 + /16 스캔 상한 경고');
  assert.equal(o.localS, 200); assert.equal(o.localAgent, '__local__');
  assert.equal(o.noRangesS, 200); assert.deepEqual(o.noRangesKept, ['10.0.0.0/24', '10.0.0.0/24', '10.0.0.0/16'], 'ranges 를 안 보내면 검사도 변경도 없다');
});

test('② GET /tools/ipam/vc-ranges 는 저장된 옛 값 중 이제 무효인 줄을 invalid 로 밝힌다(ipCount 는 유효한 줄만)', () => {
  const o = runChild(`
    const r = await call('GET', '/tools/ipam/vc-ranges');
    out.s = r.s; out.rows = (r.j.ranges || []).map((e) => ({ id: e.vcenterId, ipCount: e.ipCount, invalid: e.invalid || null }));
  `, {
    setup: (dir) => fs.writeFileSync(path.join(dir, 'ipam-vcenter-ranges.json'), JSON.stringify({ vcenters: {
      'vc-old': { ranges: ['10.0.0.250-300', '10.0.0.0/24'], enabled: true },
      'vc-fine': { ranges: ['10.1.0.0/24'], enabled: true },
    } })),
  });
  assert.equal(o.s, 200);
  const old = o.rows.find((x) => x.id === 'vc-old'); const fine = o.rows.find((x) => x.id === 'vc-fine');
  assert.equal(old.ipCount, 254, '무효 줄은 0 — 유효한 /24 만 센다');
  assert.equal(old.invalid.length, 1); assert.equal(old.invalid[0].value, '10.0.0.250-300'); assert.ok(old.invalid[0].reason);
  assert.equal(fine.invalid, null, '전부 유효하면 invalid 필드 없음');
});

// ── v2.639 리드 배선: vCenter 이름 해석기·IPMS 설정 검사 루프는 한 벌 ─────────────────────────────
test('⑤ 라우트 2파일이 vcResolve.js 해석기와 settings.invalidEntries 를 쓰고 자체 사본을 갖지 않는다', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = (...p) => stripComments(fs.readFileSync(path.join(here, '..', 'src', ...p), 'utf8'));
  const ci = src('routes', 'admin', 'centralIpam.js');
  const ie = src('routes', 'api', 'ipamExport.js');
  assert.match(ci, /makeVcResolver\(/, 'vc-ranges CSV 가져오기의 vCenter 해석은 ipam/vcResolve.js');
  assert.match(ie, /makeVcResolver\(/, 'manage CSV 의 vCenter 해석도 같은 모듈');
  assert.doesNotMatch(ci, /vcs\.find\(\(x\) => String\(x\.name/, '예전 인라인 해석기(이름 겹치면 첫 항목)가 남아 있지 않다');
  assert.doesNotMatch(ie, /byName\.set\(n,/, '예전 인라인 해석기(byName 맵)가 남아 있지 않다');
  assert.match(ci, /invalidEntries\(/, 'IPMS 설정 검사 루프는 ipam/settings.js invalidEntries 하나');
  assert.doesNotMatch(ci, /for \(const x of checkRangeList\(list \|\| \[\]\)\.invalid\)/, '예전 인라인 add 루프가 남아 있지 않다');
});

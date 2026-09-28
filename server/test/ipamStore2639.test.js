/**
 * v2.639 IPMS 통합 — 그룹 A2(서버 스토어·원장·데이터센터 위생) 회귀.
 *  S1 rangeStore 쓰기 실패는 던지고 캐시가 디스크와 어긋나지 않는다(예전: console 만 · {ok:true} · 재시작하면 사라짐)
 *  S2 scanLog 손상 파일은 .corrupt 로 보존한다(예전: 조용한 [] → 다음 기록이 원본을 덮어씀)
 *  S3 '__local__' 상수 2벌(scanStore.LOCAL · scanDatacenter.LOCAL_AGENT)이 같다 — scanDatacenter 는 순수 모듈이라 import 하지 않는다
 *  S4 vcResolve.makeVcResolver — 정확 id → 대소문자 무시 id → 이름(대소문자 무시) · 모호하면 null+ambiguous
 *  S5 settings.invalidEntries 가 예전 두 구현(savedInvalidEntries 루프 · centralIpam ipamSettingsInvalid)과 같은 결과
 *  S6 ledger _ipamKey 가 ipamRevKey() 를 재사용한다(키 문자열 값은 그대로)
 *  I2 scanDatacenterSource — TTL 이 지나도 입력(파일 토큰·scanRev)이 같으면 재판정하지 않고, 바뀌면 다시 판정한다
 *     실측(합성 262,144 결과 · vCenter 33 · 수집 서버 28, scratchpad/i2/bench.mjs): TTL 만료 재호출 중앙값 167ms → 0.01ms,
 *     입력이 실제로 바뀐 뒤 1회 재판정 132ms(정렬 제거분 약 35ms). sig 는 old/new 동일.
 *  I3 scanStore 설정 파일 (mtime,size) 캐시 — 저장 직후 읽기가 새 값 · 외부 편집도 반영
 *  죽은 export 비공개화 — 바깥 호출부 0건인 이름은 더 이상 export 되지 않는다
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ipam2639-'));
process.env.CONFIG_DIR = tmp;
process.env.IPAM_WRITE_DEBOUNCE_MS = '20';
const SRC = new URL('../src/', import.meta.url);
const read = (rel) => fs.readFileSync(new URL(rel, SRC), 'utf8');

let rs, sl, ss, sd, sds, st, vr, rsyn;
before(async () => {
  rs = await import('../src/ipam/rangeStore.js');
  sl = await import('../src/ipam/scanLog.js');
  ss = await import('../src/ipam/scanStore.js');
  sd = await import('../src/ipam/scanDatacenter.js');
  sds = await import('../src/ipam/scanDatacenterSource.js');
  st = await import('../src/ipam/settings.js');
  vr = await import('../src/ipam/vcResolve.js');
  rsyn = await import('../src/ipam/rangeSyntax.js');
});
after(() => { try { ss.flushAllNow(); fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

/* ── S1 ─────────────────────────────────────────────────────────────────────── */
test('S1 rangeStore — 쓰기 실패는 던지고 캐시·디스크는 마지막 성공값 그대로다', () => {
  const FILE = path.join(tmp, 'ipam-vcenter-ranges.json');
  assert.equal(rs.saveVcRanges('vc-a', { ranges: ['10.0.0.0/24'] }).ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(FILE, 'utf8')).vcenters['vc-a'].ranges, ['10.0.0.0/24']);
  // 쓰기 실패 주입: atomicWriteFileSync 는 `fs.openSync(tmp, 'w')` 로 임시 파일을 연다(node:fs 기본 export 는 공유 객체라 패치가 닿는다).
  const realOpen = fs.openSync;
  fs.openSync = (p, ...rest) => { if (String(p).includes('ipam-vcenter-ranges.json.tmp')) { const e = new Error('ENOSPC: no space left'); e.code = 'ENOSPC'; throw e; } return realOpen(p, ...rest); };
  try {
    assert.throws(() => rs.saveVcRanges('vc-b', { ranges: ['10.1.0.0/24'] }), /ENOSPC/, '저장 실패가 {ok:true} 로 숨지 않는다');
    assert.throws(() => rs.removeVcRanges('vc-a'), /ENOSPC/, '삭제 실패도 던진다');
  } finally { fs.openSync = realOpen; }
  // 캐시(메모리)가 실패한 값으로 앞서가지 않는다 — 화면이 '저장됨' 을 보이고 재시작하면 사라지던 결함
  assert.deepEqual(rs.listVcRanges().map((e) => e.vcenterId), ['vc-a'], '실패한 vc-b 가 목록에 없다 · vc-a 삭제도 반영되지 않았다');
  assert.deepEqual(rs.rangesForVcenter('vc-b'), []);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(FILE, 'utf8')).vcenters), ['vc-a'], '디스크도 마지막 성공값');
  // 복구 뒤 정상 저장·삭제
  assert.equal(rs.saveVcRanges('vc-b', { ranges: ['10.1.0.0/24'] }).ok, true);
  assert.equal(rs.removeVcRanges('vc-a').ok, true);
  assert.deepEqual(rs.listVcRanges().map((e) => e.vcenterId), ['vc-b']);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(FILE, 'utf8')).vcenters), ['vc-b']);
  assert.ok(!Object.keys(rs).includes('loadVcRanges'), 'loadVcRanges 는 바깥 호출부 0건 — 비공개');
});

/* ── S2 ─────────────────────────────────────────────────────────────────────── */
test('S2 scanLog — 손상 파일은 .corrupt 로 보존하고 빈 버퍼로 시작한다(조용한 [] 금지)', () => {
  const FILE = path.join(tmp, sl.SCAN_LOG_FILE_NAME);
  sl._resetScanLogForTest();
  fs.writeFileSync(FILE, '[{"at":1,"event":"start"'); // 절단본
  const r = sl.listScanLog();
  assert.deepEqual(r.entries, []);
  assert.equal(r.total, 0);
  const kept = fs.readdirSync(tmp).filter((n) => n.startsWith(`${sl.SCAN_LOG_FILE_NAME}.corrupt.`));
  assert.equal(kept.length, 1, '손상 원본을 보존한다');
  assert.equal(fs.readFileSync(path.join(tmp, kept[0]), 'utf8'), '[{"at":1,"event":"start"', '보존본은 원문 그대로');
  // 다음 기록이 보존본을 덮지 않는다(새 파일로 시작)
  sl.recordScanLog({ event: 'start', ranges: 1 });
  assert.equal(JSON.parse(fs.readFileSync(FILE, 'utf8')).length, 1);
  assert.equal(fs.readdirSync(tmp).filter((n) => n.startsWith(`${sl.SCAN_LOG_FILE_NAME}.corrupt.`)).length, 1, '보존본은 그대로');
  // 배열이 아닌 JSON 도 손상이다
  sl._resetScanLogForTest();
  fs.writeFileSync(FILE, '{"not":"array"}');
  assert.deepEqual(sl.listScanLog().entries, []);
  assert.equal(fs.readdirSync(tmp).filter((n) => n.startsWith(`${sl.SCAN_LOG_FILE_NAME}.corrupt.`)).length, 2);
  // 파일이 없는 것은 손상이 아니다(보존본을 만들지 않는다)
  sl._resetScanLogForTest();
  fs.rmSync(FILE, { force: true });
  assert.deepEqual(sl.listScanLog().entries, []);
  assert.equal(fs.readdirSync(tmp).filter((n) => n.startsWith(`${sl.SCAN_LOG_FILE_NAME}.corrupt.`)).length, 2);
  assert.ok(!Object.keys(sl).includes('SCAN_LOG_MAX'), 'SCAN_LOG_MAX 는 비공개(응답 max 로만 나간다)');
  assert.ok(/preserveCorrupt\(/.test(read('ipam/scanLog.js')), '소스에 preserveCorrupt 호출이 있다(arch2582 스윕 대상)');
});

/* ── S3 ─────────────────────────────────────────────────────────────────────── */
test('S3 — scanStore.LOCAL 과 scanDatacenter.LOCAL_AGENT 는 같은 값이다(순수 모듈 경계 때문에 두 벌)', () => {
  assert.equal(sd.LOCAL_AGENT, ss.LOCAL);
  assert.equal(ss.LOCAL, '__local__');
  // scanDatacenter 는 순수여야 한다 — scanStore·config 를 import 하지 않는다(테스트가 상수 동일성으로 대신 묶는다)
  const src = read('ipam/scanDatacenter.js');
  assert.ok(!/from '\.\/scanStore\.js'|from '\.\.\/config\.js'/.test(src));
});

/* ── S4 ─────────────────────────────────────────────────────────────────────── */
test('S4 vcResolve — 정확 id · 대소문자 무시 id · 이름(대소문자·공백 무시) · 모호하면 null + 후보', () => {
  const resolve = vr.makeVcResolver([
    { id: 'vc-seoul', name: 'Seoul' },
    { id: 'vc-busan', name: 'Busan' },
    { id: 'vc-us1', name: 'US East' },
    { id: 'vc-us2', name: 'us east' }, // 이름이 대소문자만 다르게 겹친다
    { id: 'vc-noname' },
    null, { name: 'no-id' },
  ]);
  assert.deepEqual(resolve('vc-seoul'), { id: 'vc-seoul', ambiguous: false });
  assert.deepEqual(resolve(' VC-SEOUL '), { id: 'vc-seoul', ambiguous: false }, '대소문자만 다른 id');
  assert.deepEqual(resolve('busan'), { id: 'vc-busan', ambiguous: false }, '이름 대소문자 무시');
  assert.deepEqual(resolve('  Seoul '), { id: 'vc-seoul', ambiguous: false }, '앞뒤 공백 무시');
  assert.deepEqual(resolve('US East'), { id: null, ambiguous: true, candidates: ['vc-us1', 'vc-us2'] }, '겹치는 이름은 첫 항목을 고르지 않는다');
  assert.deepEqual(resolve('vc-nope'), { id: null, ambiguous: false });
  assert.deepEqual(resolve(''), { id: null, ambiguous: false });
  assert.deepEqual(resolve(null), { id: null, ambiguous: false });
  assert.deepEqual(resolve('no-id'), { id: null, ambiguous: false }, 'id 없는 항목은 후보가 아니다');
  // id 가 이름보다 먼저다 — 어떤 vCenter 의 이름이 다른 vCenter 의 id 와 같아도 id 가 이긴다
  const r2 = vr.makeVcResolver([{ id: 'vc-a', name: 'vc-b' }, { id: 'vc-b', name: 'B' }]);
  assert.deepEqual(r2('vc-b'), { id: 'vc-b', ambiguous: false });
  // 대소문자만 다른 id 가 둘이면 그것도 모호하다
  const r3 = vr.makeVcResolver([{ id: 'VC-X', name: 'x1' }, { id: 'vc-x', name: 'x2' }]);
  assert.deepEqual(r3('VC-X'), { id: 'VC-X', ambiguous: false }, '정확 일치는 그대로');
  assert.deepEqual(r3('Vc-X'), { id: null, ambiguous: true, candidates: ['VC-X', 'vc-x'] });
  assert.deepEqual(vr.makeVcResolver(null)('a'), { id: null, ambiguous: false });
});

/* ── S5 ─────────────────────────────────────────────────────────────────────── */
test('S5 settings.invalidEntries — 예전 두 구현(savedInvalidEntries 루프 · centralIpam ipamSettingsInvalid)과 같은 결과', () => {
  const { checkRangeList } = rsyn;
  // 예전 판본 ① settings.savedInvalidEntries(v2.637) — 그대로 옮겨 적었다
  const oldSaved = (settings) => {
    const out = [];
    const add = (field, list, vcenterId) => { for (const x of checkRangeList(list || []).invalid) out.push({ field, ...(vcenterId != null ? { vcenterId } : {}), ...x }); };
    add('global', settings.global); add('publicRanges', settings.publicRanges); add('privateRanges', settings.privateRanges);
    for (const [k, v] of Object.entries(settings.vcenters || {})) add('vcenters', v, k);
    return out;
  };
  // 예전 판본 ② routes/admin/centralIpam.js ipamSettingsInvalid(v2.637) — 그대로 옮겨 적었다
  const oldRoute = (body, { globals, vcKeys }) => {
    const out = [];
    const add = (field, list, vcenterId) => { for (const x of checkRangeList(list || []).invalid) out.push({ field, ...(vcenterId != null ? { vcenterId } : {}), ...x }); };
    if (globals) { add('global', body.global); add('publicRanges', body.publicRanges); add('privateRanges', body.privateRanges); }
    const vcs = body.vcenters && typeof body.vcenters === 'object' && !Array.isArray(body.vcenters) ? body.vcenters : {};
    for (const [k, v] of Object.entries(vcs)) if (!vcKeys || vcKeys.has(k)) add('vcenters', v, k);
    return out;
  };
  const bodies = [
    { global: ['10.0.0.0/', '10.0.0.0/8'], publicRanges: '8.8.8.8\n\nbad/99', privateRanges: [], vcenters: { 'vc-a': ['10.9.9.15-10.9.9.1', 'x'], 'vc-b': '172.16.0.0/12', 'vc-c': [] } },
    { global: [], vcenters: {} },
    {},
    { global: null, publicRanges: undefined, privateRanges: ['300.1.1.1'], vcenters: { 'vc-a': null } },
  ];
  // ⚠ 알려진 차이 하나(의도): vcenters 가 **배열**이면 예전 ①은 인덱스('0','1',…)를 vCenter id 로 읽었고 ②는 {} 로 봤다.
  //   배열은 vCenter 맵이 아니므로 통합본은 ②를 따른다(저장 경로 saveSettings 는 애초에 객체만 만든다 — 손상·손편집 파일에만 닿는 경우).
  const arrBody = { vcenters: ['not', 'an', 'object'], global: 'zz' };
  assert.deepEqual(st.invalidEntries(arrBody), oldRoute(arrBody, { globals: true, vcKeys: null }));
  assert.deepEqual(st.invalidEntries(arrBody).map((x) => x.field), ['global'], '배열 vcenters 는 검사하지 않는다(인덱스를 vCenter id 로 지어내지 않는다)');
  assert.equal(oldSaved(arrBody).length, 4, '예전 ①은 인덱스를 id 로 읽었다(차이를 기록한다)');
  for (const b of bodies) {
    assert.deepEqual(st.invalidEntries(b), oldSaved(b), `savedInvalidEntries 루프와 같다: ${JSON.stringify(b)}`);
    assert.deepEqual(st.invalidEntries(b, { globals: true, vcKeys: null }), oldRoute(b, { globals: true, vcKeys: null }));
    assert.deepEqual(st.invalidEntries(b, { globals: false, vcKeys: new Set(['vc-a']) }), oldRoute(b, { globals: false, vcKeys: new Set(['vc-a']) }), '범위 계정(전역 제외 · vc-a 만)');
    assert.deepEqual(st.invalidEntries(b, { globals: false }), oldRoute(b, { globals: false, vcKeys: null }));
  }
  // 실제로 잡는 것이 있다(공허한 동일성 금지)
  const inv = st.invalidEntries(bodies[0]);
  assert.ok(inv.length >= 3, `형식 오류 줄을 잡는다: ${JSON.stringify(inv)}`);
  assert.ok(inv.some((x) => x.field === 'global' && x.value === '10.0.0.0/'), '빈 마스크');
  assert.ok(inv.some((x) => x.field === 'vcenters' && x.vcenterId === 'vc-a'));
  assert.deepEqual(st.invalidEntries(bodies[0], { globals: false, vcKeys: new Set(['vc-b']) }), [], 'vc-b 만 검사하면 오류 0');
  // savedInvalidEntries 는 invalidEntries 를 쓴다(소스)
  // ⚠ `\([^)]*\)` 로 쓰면 기본 인자 `load()` 의 괄호에서 잘린다(v2.577 규약 — 괄호 깊이를 정규식으로 자르지 말 것)
  assert.match(read('ipam/settings.js'), /export function savedInvalidEntries\(settings = load\(\)\)\s*\{\s*return invalidEntries\(/);
});

/* ── S6 ─────────────────────────────────────────────────────────────────────── */
test('S6 ledger — _ipamKey 는 ipamRevKey() 를 재사용한다(리비전 조각을 두 번 적지 않는다)', () => {
  const src = read('ipam/ledger.js');
  const keyLine = src.split('\n').find((l) => l.startsWith('const _ipamKey ='));
  assert.ok(keyLine, '_ipamKey 선언');
  assert.match(keyLine, /\|\$\{ipamRevKey\(\)\}\$\{_dcKey\(/, '리비전 조각은 ipamRevKey() 하나');
  assert.ok(!/settingsRev\(\)|scanRev\(\)/.test(keyLine), '_ipamKey 줄에 인라인 리비전이 없다');
  assert.match(src, /export function ipamRevKey\(\) \{ return `s\$\{settingsRev\(\)\}\|a\$\{annotationsRev\(\)\}\|n\$\{scanRev\(\)\}\|o\$\{overridesRev\(\)\}\|p\$\{policiesRev\(\)\}`; \}/, 'ipamRevKey 값 형식은 그대로(라우트 memo 키가 본다)');
});

/* ── I3 ─────────────────────────────────────────────────────────────────────── */
test('I3 scanStore 설정 캐시 — 저장 직후 읽기가 새 값이고 외부 편집도 반영된다', () => {
  const CFG = path.join(tmp, 'ipam-scan.json');
  ss.saveScanSettings('Edge-A', { enabled: true, ranges: ['10.5.0.0/24'], intervalMs: 120_000 });
  assert.deepEqual(ss.loadScanSettings('edge-a').ranges, ['10.5.0.0/24'], '저장 직후(같은 ms) 읽기 — 캐시가 낡지 않았다');
  assert.equal(ss.loadScanSettings('edge-a').intervalMs, 120_000);
  assert.ok(ss.listScanAgents().some((a) => a.name === 'Edge-A'));
  // 두 번 연속 저장(같은 ms 일 수 있다) — 두 번째 값이 보인다
  ss.saveScanSettings('Edge-A', { ranges: ['10.6.0.0/24'] });
  ss.saveScanSettings('Edge-A', { ranges: ['10.7.0.0/24'] });
  assert.deepEqual(ss.loadScanSettings('Edge-A').ranges, ['10.7.0.0/24']);
  assert.deepEqual(JSON.parse(fs.readFileSync(CFG, 'utf8')).agents['Edge-A'].ranges, ['10.7.0.0/24'], '디스크도 같다');
  // 캐시 히트: 같은 파일 토큰이면 같은 객체(readFileSync 를 다시 하지 않는다)
  const realRead = fs.readFileSync; let reads = 0;
  fs.readFileSync = (p, ...rest) => { if (String(p) === CFG) reads++; return realRead(p, ...rest); };
  try { ss.loadScanSettings('Edge-A'); ss.listScanAgents(); ss.loadScanSettings(); } finally { fs.readFileSync = realRead; }
  assert.equal(reads, 0, '토큰이 같으면 파일을 다시 읽지 않는다');
  // 외부 편집(백업 복원·다른 프로세스): 내용과 크기가 다른 파일 → 다음 읽기가 새 값
  const ext = { agents: { 'Edge-A': { enabled: false, ranges: ['192.168.0.0/24', '192.168.1.0/24'] }, 'Edge-Z': { enabled: true, ranges: ['10.99.0.0/24'] } } };
  fs.writeFileSync(CFG, JSON.stringify(ext, null, 2));
  assert.deepEqual(ss.loadScanSettings('edge-z').ranges, ['10.99.0.0/24']);
  assert.equal(ss.loadScanSettings('Edge-A').enabled, false);
  // 파일이 없으면 캐시하지 않는다(missing 판정을 매번 다시 본다) — 지운 뒤 읽으면 기본값
  fs.rmSync(CFG);
  assert.deepEqual(ss.listScanAgents(), []);
  assert.equal(ss.loadScanSettings('Edge-A').enabled, false);
  // 죽은 export
  for (const n of ['MAX_HIST_IPS', 'cleanAliveHost', 'getAllHistoryEvents']) assert.ok(!Object.keys(ss).includes(n), `${n} 비공개`);
});

/* ── I2 ─────────────────────────────────────────────────────────────────────── */
test('I2 scanDatacenterSource — TTL 이 지나도 입력이 같으면 같은 판정을 돌려주고, 입력이 바뀌면 다시 판정한다', () => {
  ss.saveScanSettings('edge-i2', { enabled: true, ranges: ['10.20.0.0/24'] });
  sds.invalidateScanDatacenters();
  let now = Date.now();
  const m1 = sds.currentScanDatacenters([], { now });
  assert.ok(m1.map.has('edge-i2'));
  assert.equal(sds.currentScanDatacenters([], { now: now + 5_000 }), m1, 'TTL 안 — 같은 메모');
  now += 11_000;
  const m2 = sds.currentScanDatacenters([], { now });
  assert.equal(m2, m1, 'TTL 이 지났지만 입력(파일 토큰·scanRev)이 같다 — 재판정하지 않는다');
  assert.equal(m2.at, now, 'at 만 앞당긴다');
  // 스캔 결과에 새 에이전트가 나타나면(scanRev 증가) TTL 뒤 다시 판정한다
  ss.mergeScanResults([{ ip: '10.20.0.7', openPorts: [22], services: ['SSH'] }], Date.now(), 'edge-from-results');
  now += 11_000;
  const m3 = sds.currentScanDatacenters([], { now });
  assert.notEqual(m3, m1);
  assert.ok(m3.map.has('edge-from-results'), '결과에 나온 에이전트가 판정에 들어간다');
  // 스캔 설정 파일이 바뀌면(외부 편집 — invalidate 없이) TTL 뒤 다시 판정한다
  const CFG = path.join(tmp, 'ipam-scan.json');
  const cur = JSON.parse(fs.readFileSync(CFG, 'utf8'));
  cur.agents['edge-i2-ext'] = { enabled: true, ranges: ['10.21.0.0/24'] };
  fs.writeFileSync(CFG, JSON.stringify(cur, null, 2));
  now += 11_000;
  const m4 = sds.currentScanDatacenters([], { now });
  assert.notEqual(m4, m3);
  assert.ok(m4.map.has('edge-i2-ext'));
  // snapVcenters 가 바뀌면 TTL 안이라도 다시 판정한다(예전과 같다)
  const m5 = sds.currentScanDatacenters([{ id: 'vc-s', collectedBy: 'edge-i2', collectSource: 'site' }], { now: now + 1 });
  assert.notEqual(m5, m4);
  assert.ok(!Object.keys(sds).includes('scanDatacenterInputs'), 'scanDatacenterInputs 비공개');
  // 정렬 없이 에이전트 집합을 모은다(소스) — scanStore 가 적재 시점에 유지하는 목록을 쓴다
  const src = read('ipam/scanDatacenterSource.js');
  assert.ok(!/scanResultList\(/.test(src), '전체 정렬(scanResultList) 을 쓰지 않는다');
  assert.match(src, /scanResultAgents\(\)/);
});

test('I2 scanStore.scanResultAgents — 적재·에이전트 교체·정리 뒤에도 실제 결과의 에이전트 집합과 같다', () => {
  const actual = () => new Set(Object.values(ss.getScanResults()).map((r) => r.agent || ss.LOCAL));
  const same = (msg) => assert.deepEqual(new Set(ss.scanResultAgents()), actual(), msg);
  same('현재 상태');
  const t = Date.now();
  ss.mergeScanResults([{ ip: '10.30.0.1', openPorts: [22], services: ['SSH'] }, { ip: '10.30.0.2', openPorts: [80], services: ['HTTP'] }], t, 'edge-ra-1');
  same('새 IP 2건');
  assert.ok(ss.scanResultAgents().includes('edge-ra-1'));
  ss.mergeScanResults([{ ip: '10.30.0.1', openPorts: [22], services: ['SSH'] }], t + 1, 'edge-ra-2'); // 에이전트 교체
  same('에이전트 교체 뒤');
  ss.mergeScanResults([{ ip: '10.30.0.2', openPorts: [80], services: ['HTTP'] }], t + 2, 'edge-ra-2');
  same('마지막 IP 도 옮긴 뒤');
  assert.ok(!ss.scanResultAgents().includes('edge-ra-1'), '결과가 0건이 된 이름은 사라진다');
  ss.mergeScanResults([{ ip: '10.30.0.2', openPorts: [80], services: ['HTTP'] }], t - 100, 'edge-ra-old'); // 낡은 보고 — 덮지 않는다
  same('낡은 보고 뒤(집합 불변)');
  assert.ok(!ss.scanResultAgents().includes('edge-ra-old'));
  // 정리(prune): lastSeen 이 오래된 결과를 지우면 그 에이전트도 빠진다
  ss.mergeScanResults([{ ip: '10.31.0.1', openPorts: [22], services: ['SSH'] }], t - 400 * 86_400_000, 'edge-ra-stale');
  assert.ok(ss.scanResultAgents().includes('edge-ra-stale'));
  ss.pruneScanResults(30);
  same('prune 뒤');
  assert.ok(!ss.scanResultAgents().includes('edge-ra-stale'));
  // scanInfo 의 byAgent 도 같은 집계(정렬 없이)
  const info = ss.scanInfo();
  assert.deepEqual(new Set(Object.keys(info.byAgent)), actual());
  assert.equal(info.count, Object.keys(ss.getScanResults()).length);
  assert.equal(Object.values(info.byAgent).reduce((a, b) => a + b, 0), info.count);
});

/* ── 죽은 export ─────────────────────────────────────────────────────────────── */
test('죽은 export 비공개화 — 바깥 호출부 0건인 이름은 export 되지 않는다(삭제는 아니다)', async () => {
  const mc = await import('../src/ipam/manageCsv.js');
  const nm = await import('../src/ipam/netmap.js');
  const sp = await import('../src/ipam/scanPoller.js');
  for (const [m, n] of [[mc, 'MANAGE_COLUMNS'], [mc, 'MANAGE_LIMITS'], [nm, 'OS_COLORS'], [sd, 'SUGGEST_MAX'], [sp, 'runScanOnce']]) assert.ok(!Object.keys(m).includes(n), `${n} 비공개`);
  assert.equal(typeof sp.startScan, 'function', 'startScan 은 그대로(라우트가 쓴다)');
  // 이름 자체는 남아 있다(삭제 아님)
  for (const [f, n] of [['ipam/manageCsv.js', 'MANAGE_COLUMNS'], ['ipam/netmap.js', 'OS_COLORS'], ['ipam/scanDatacenter.js', 'SUGGEST_MAX'], ['ipam/scanPoller.js', 'runScanOnce'], ['ipam/scanStore.js', 'getAllHistoryEvents'], ['ipam/rangeStore.js', 'loadVcRanges']]) {
    assert.ok(read(f).includes(n), `${f} 에 ${n} 정의가 남아 있다`);
  }
});

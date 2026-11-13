/**
 * v2.992 묶음 A(설계 docs/design/bm-folders §13) — ① 사용률 지표별 출처 ② 물리서버 OS 주소 제안 ③ IP 스캔 정방향 DNS.
 * CONFIG_DIR · DATA_DIR 은 임시 폴더(저장소 server/config 를 건드리지 않는다).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-bmos2991-'));
process.env.CONFIG_DIR = TMP;
process.env.DATA_DIR = TMP;

const { srcCmOf } = await import('../src/bmusage/usage.js');
const { SRC_CM_RE } = await import('../src/bmusage/perfCols.js');
const { srcByOfRow, judgeServer } = await import('../src/corpusage/build.js');
const { usageSrcOf } = await import('../src/bmfolders/usageSrc.js');
const { sanitizeBmUsageSnap } = await import('../src/central/bmUsageEdgePull.js');
const { cleanFwdNames, forwardMany, FWD_NAMES_MAX } = await import('../src/ipam/scan.js');
const { scanNameOf } = await import('../src/ipam/ledger.js');
const OS = await import('../src/bmfolders/osSuggest.js');
const { indexOsHosts, pickOsEntry } = await import('../src/bmusage/targets.js');
const BMR = await import('../src/bmstor/registry.js');
const { registerBmOsSuggest, currentOsSuggest, fwdNamesForAgent, BM_OS_GATES } = await import('../src/routes/admin/bmOsSuggest.js');
const { adminOnly: SHARED_ADMIN } = await import('../src/routes/admin/shared.js');

// ── ① 지표별 출처 ─────────────────────────────────────────────────────────────
test('① srcCmOf — CPU · 메모리 두 글자(o · i · e · -) · 꼴 정규식과 맞는다', () => {
  assert.equal(srcCmOf({ cpu: 'os', mem: 'idrac', io: 'idrac' }), 'oi');
  assert.equal(srcCmOf({ cpu: 'idrac-ent' }), 'e-');
  assert.equal(srcCmOf({}), '--');
  for (const v of ['oi', 'e-', '--', 'oo']) assert.ok(SRC_CM_RE.test(v));
  for (const v of ['o', 'oix', 'zz', 'OI']) assert.ok(!SRC_CM_RE.test(v));
});

test('① 판정 — I/O 만 iDRAC 인 OS 행: 행 출처는 mixed 지만 지표별은 os · os (예전 판정이면 혼합으로 칠했다)', () => {
  const now = Date.now();
  const row = { ts: now, cpu_pct: 30, mem_pct: 50, src: 'idrac+os', src_cm: 'oo' };
  const j = judgeServer({ role: 'bm', row, now, freshMs: 600_000 });
  assert.equal(j.src, 'mixed');
  assert.deepEqual(j.srcBy, { cpu: 'os', mem: 'os' });
  assert.deepEqual(usageSrcOf({ state: 'ok', cpuPct: 30, memPct: 50, src: j.src, srcBy: j.srcBy }), { cpu: 'os', mem: 'os' });
});

test('① 칸이 없는 행(구버전 엣지)은 srcBy 를 싣지 않고 · mixed 면 지표별 출처를 지어내지 않는다', () => {
  const now = Date.now();
  const j = judgeServer({ role: 'bm', row: { ts: now, cpu_pct: 30, mem_pct: 50, src: 'idrac+os' }, now, freshMs: 600_000 });
  assert.equal(j.srcBy, undefined);
  assert.deepEqual(usageSrcOf({ state: 'ok', cpuPct: 30, memPct: 50, src: 'mixed' }), { cpu: null, mem: null, mixed: true });
  assert.deepEqual(usageSrcOf({ state: 'ok', cpuPct: 30, memPct: null, src: 'idrac' }), { cpu: 'idrac', mem: null });
  assert.equal(usageSrcOf({ state: 'unread' }), null);
  assert.equal(srcByOfRow({ src_cm: 'zz' }), null);
  assert.deepEqual(srcByOfRow({ src_cm: 'ie' }), { cpu: 'idrac', mem: 'idrac' });
});

test('① 가상화 호스트 — 행에 없는 지표를 vCenter 로 채우면 그 지표 출처는 vcenter', () => {
  const now = Date.now();
  const j = judgeServer({ role: 'virt', row: { ts: now, cpu_pct: 20, mem_pct: null, src: 'os', src_cm: 'o-' }, host: { cpuUsagePct: 25, memUsagePct: 61, connectionState: 'CONNECTED' }, now, freshMs: 600_000 });
  assert.deepEqual(j.srcBy, { cpu: 'os', mem: 'vcenter' });
});

test('① 엣지 행 정제 — src_cm 은 꼴이 맞을 때만(새 엣지 export 필드는 중앙 화이트리스트에도)', () => {
  const snap = { node: {}, rows: [{ key: 'a', name: 'a', src_cm: 'oi' }, { key: 'b', name: 'b', src_cm: 'x<script>' }, { key: 'c', name: 'c', src_cm: { a: 1 } }, { key: 'd', name: 'd' }] };
  const out = sanitizeBmUsageSnap(snap);
  const by = new Map(out.rows.map((r) => [r.key, r]));
  assert.equal(by.get('a').src_cm, 'oi');
  assert.equal(by.get('b').src_cm, null);
  assert.ok(by.get('c').src_cm == null);
  assert.ok(!Object.hasOwn(by.get('d'), 'src_cm'));
});

test('① 최신값 표에 src_cm 이 적히고 읽힌다(DB 왕복)', async () => {
  const DB = await import('../src/bmusage/db.js');
  if (!(await DB.available())) return; // SQLite 없는 환경 — 건너뜀(CI 는 있다)
  const ts = Date.now();
  await DB.insertUsage([{ key: 'st:SRC2991', name: 'srv', vcenterId: 'vc1', ts, cpu_pct: 10, mem_pct: 20, src: 'idrac+os', src_cm: 'oi' }], '');
  const rows = await DB.latestUsage();
  const r = (Array.isArray(rows) ? rows : rows?.rows || []).find((x) => x.key === 'st:SRC2991');
  assert.ok(r, '최신값 행');
  assert.equal(r.src_cm, 'oi');
});

// ── ③ 정방향 DNS ─────────────────────────────────────────────────────────────
test('③ cleanFwdNames — 호스트 이름 꼴만 · IPv4 꼴 버림 · 대소문자 무시 중복 제거 · 상한', () => {
  assert.deepEqual(cleanFwdNames(['kr-db-11', 'KR-DB-11', 'kr-web.corp.local.', '10.0.0.5', '-bad', 'a b', '', null, { x: 1 }, 'x'.repeat(64)]), ['kr-db-11', 'kr-web.corp.local']);
  const many = Array.from({ length: FWD_NAMES_MAX + 50 }, (_, i) => `h${i}`);
  assert.equal(cleanFwdNames(many).length, FWD_NAMES_MAX);
});

test('③ forwardMany — 스캔 대역 안(inScope) IP 만 · 시한 · 같은 IP 에 다른 이름은 conflicts', async () => {
  const table = { 'kr-db-11': ['10.0.0.11', '192.168.9.9'], 'kr-db-12': ['10.0.0.11'], 'kr-web-01': ['10.0.0.21'], slow: null };
  const lookup = (name) => (table[name] === null ? new Promise(() => {}) : table[name] ? Promise.resolve(table[name].map((address) => ({ address, family: 4 }))) : Promise.reject(Object.assign(new Error('nx'), { code: 'ENOTFOUND' })));
  const r = await forwardMany(['kr-db-11', 'kr-db-12', 'kr-web-01', 'slow', 'nope'], new Set(['10.0.0.11', '10.0.0.21']), { lookup, timeoutMs: 50 });
  assert.equal(r.byIp.get('10.0.0.11'), 'kr-db-11');   // 이름 순 먼저
  assert.equal(r.byIp.get('10.0.0.21'), 'kr-web-01');
  assert.ok(!r.byIp.has('192.168.9.9'), '대역 밖 IP 는 채택하지 않는다');
  assert.equal(r.stats.conflicts, 1);
  assert.equal(r.stats.timedOut, 1);
  assert.equal(r.stats.failed, 1);
});

test('③ forwardMany 예산 · 차단기 — DNS 가 닿지 않으면 처음 몇 개 시한 초과 뒤 멈추고 · 전체 예산을 넘기면 남은 이름은 묻지 않는다(기존 스캔 시한 보호)', async () => {
  const hang = () => new Promise(() => {});
  const names = Array.from({ length: 40 }, (_, i) => `n${String(i).padStart(2, '0')}`);
  const a = await forwardMany(names, new Set(), { lookup: hang, timeoutMs: 20, limit: 4, breakAfter: 8 });
  assert.equal(a.stats.stopped, 'unreachable');
  assert.ok(a.stats.timedOut <= 8 + 4, `시한 초과 ${a.stats.timedOut} — 차단 뒤 더 묻지 않는다`);
  assert.equal(a.stats.timedOut + a.stats.skipped, 40);
  let clock = 0;
  const lookup = async () => { clock += 1000; return [{ address: '10.0.0.1', family: 4 }]; };
  const b = await forwardMany(names, new Set(), { lookup, limit: 1, budgetMs: 5000, now: () => clock });
  assert.equal(b.stats.stopped, 'budget');
  assert.ok(b.stats.skipped > 0 && b.stats.skipped < 40);
  // 응답이 하나라도 오면(느린 DNS) 차단기는 걸리지 않는다 — 예산만
  let k = 0;
  const mixed = (n) => (k++ % 10 === 0 ? Promise.resolve([{ address: '10.0.0.9', family: 4 }]) : hang(n));
  const c = await forwardMany(names.slice(0, 12), new Set(), { lookup: mixed, timeoutMs: 10, limit: 1, breakAfter: 8 });
  assert.equal(c.stats.stopped, undefined);
});

test('③ 스캔 저장 — fwdName 은 글자만 · 바뀌면 내용 변화 · 예전 행은 칸 없음', async () => {
  const SS = await import('../src/ipam/scanStore.js');
  SS.mergeScanResults([{ ip: '10.9.0.1', openPorts: [22], services: ['SSH'], hostname: '', fwdName: 'kr-db-11' }, { ip: '10.9.0.2', openPorts: [22], services: [], hostname: 'x', fwdName: { a: 1 } }], Date.now(), 'edge-a');
  const res = SS.getScanResults();
  assert.equal(res['10.9.0.1'].fwdName, 'kr-db-11');
  assert.ok(!Object.hasOwn(res['10.9.0.2'], 'fwdName'));
  const rev = SS.scanRev();
  SS.mergeScanResults([{ ip: '10.9.0.1', openPorts: [22], services: ['SSH'], hostname: '', fwdName: 'kr-db-99' }], Date.now() + 1000, 'edge-a');
  assert.ok(SS.scanRev() > rev, '정방향 이름만 바뀌어도 내용 변화(대장 재계산)');
});

test('③ 원장 이름 — 역방향 우선 · 없으면 정방향 · 같으면 both · 다르면 differ(둘 다)', () => {
  assert.deepEqual(scanNameOf({ hostname: 'kr-db-11.corp', fwdName: 'KR-DB-11' }), { name: 'kr-db-11.corp', via: 'both' });
  assert.deepEqual(scanNameOf({ hostname: '', fwdName: 'kr-db-11' }), { name: 'kr-db-11', via: 'fwd' });
  assert.deepEqual(scanNameOf({ hostname: 'kr-app-old-05', fwdName: 'kr-app-05' }), { name: 'kr-app-old-05', via: 'differ', fwd: 'kr-app-05' });
  assert.deepEqual(scanNameOf({}), { name: '', via: '' });
});

test('③ 배정 · 중앙 스캔이 이름을 넘긴다(소스 — 개별 토큰일 때만 · 엣지 워커 · 워커 · 러너)', () => {
  const rd = (f) => fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
  const ops = rd('routes/central/opsRoutes.js');
  assert.match(ops, /const fwdNames = req\.centralAuth\?\.mode === 'agent' && req\.centralAuth\.agent \? await fwdNamesForAgent\(req\.centralAuth\.agent\)/);
  assert.match(rd('agent/ipScanWorker.js'), /fwdNames: Array\.isArray\(a\.fwdNames\) \? a\.fwdNames : undefined/);
  assert.match(rd('ipam/scanWorker.js'), /fwdNames: j\.fwdNames/);
  assert.match(rd('ipam/scanRunner.js'), /fwdNames: job\.fwdNames/);
  assert.match(rd('ipam/scanPoller.js'), /await fwdNamesFor\(LOCAL\)/);
  assert.match(rd('routes/admin/bmOsSuggest.js'), /setFwdNamesProvider\(fwdNamesForAgent\)/);
});

// ── ② OS 주소 제안 ───────────────────────────────────────────────────────────
const M = (o) => ({ kind: 'bm', key: `st:${o.tag}`, corp: o.corp ?? 'vc-kr', name: o.name, nameIsAddr: !!o.addr, serviceTag: o.tag, remoteAgent: o.agent ?? 'edge-kr', mgmtHost: o.mg || '', ...o.x });
const R = (ip, o = {}) => ({ ip, openPorts: o.ports ?? [22], hostname: o.ptr || '', ...(o.fwd ? { fwdName: o.fwd } : {}), agent: o.agent ?? 'edge-kr', lastSeen: 1 });

test('② 상태 판정 — 제안 · 고르기 · 닫힘 · 못 찾음 · 이름 없음 · 등록됨 · 다름 · 여럿', () => {
  const members = [
    M({ tag: 'A1', name: 'kr-ora-rac02' }),                     // suggest (ptr)
    M({ tag: 'A2', name: 'kr-web-07.corp.local' }),             // suggest (fwd · 도메인 뗌)
    M({ tag: 'A3', name: 'kr-db-11' }),                         // pick
    M({ tag: 'A4', name: 'kr-bak-02' }),                        // closed
    M({ tag: 'A5', name: '10.20.0.9', addr: true }),            // noname
    M({ tag: 'A6', name: 'kr-none-01' }),                       // none
    M({ tag: 'A7', name: 'kr-ora-rac01' }),                     // registered
    M({ tag: 'A8', name: 'kr-ora-rac03' }),                     // differs
    { kind: 'esxi', key: 'st:E1', corp: 'vc-kr', name: 'kr-ora-rac02' },   // ESXi 는 대상 아님
  ];
  const scanRows = [
    R('10.20.31.42', { ptr: 'KR-ORA-RAC02.corp.local' }),
    R('10.20.33.17', { fwd: 'kr-web-07' }),
    R('10.20.31.61', { ptr: 'kr-db-11' }), R('10.20.41.61', { ptr: 'kr-db-11' }),
    R('10.20.35.9', { ptr: 'kr-bak-02', ports: [443] }),
    R('10.20.31.41', { ptr: 'kr-ora-rac01' }),
    R('10.20.31.43', { fwd: 'kr-ora-rac03' }),
  ];
  const osIndex = indexOsHosts([{ id: 'o1', name: 'kr-ora-rac01', host: '10.20.31.41', vcenterId: 'vc-kr' }, { id: 'o2', name: 'kr-ora-rac03', host: '10.20.31.99', vcenterId: 'vc-kr' }], { includeAddrOnly: true });
  const r = OS.buildOsSuggest({ members, scanRows, osIndex, pickOsEntry });
  const st = Object.fromEntries(r.rows.map((x) => [x.name, x.state]));
  assert.deepEqual(st, { 'kr-ora-rac02': 'suggest', 'kr-web-07.corp.local': 'suggest', 'kr-db-11': 'pick', 'kr-bak-02': 'closed', '10.20.0.9': 'noname', 'kr-none-01': 'none', 'kr-ora-rac01': 'registered', 'kr-ora-rac03': 'differs' });
  assert.equal(r.total, 8, 'ESXi 는 세지 않는다');
  assert.deepEqual(r.rows.find((x) => x.name === 'kr-web-07.corp.local').cands[0].vias, ['fwd']);
  assert.deepEqual(r.rows.find((x) => x.name === 'kr-ora-rac02').cands[0].vias, ['dns'], '방식별 이름이 없는 옛 행은 hostname 을 역DNS 로 본다');
});

test('② 이름 출처는 방식별(v2.991 호스트명 확인 저장 형식 names{dns|mdns|netbios:{v}}) — mDNS · NetBIOS 이름도 후보 · 같은 IP 의 여러 출처는 모은다', () => {
  const members = [M({ tag: 'N1', name: 'win-db-01' })];
  const scanRows = [{ ip: '10.9.9.1', openPorts: [22], hostname: 'WIN-DB-01', names: { netbios: { v: 'WIN-DB-01', at: 1, miss: 0 }, mdns: { v: 'win-db-01.local', at: 1, miss: 0 } }, fwdName: 'win-db-01', agent: 'edge-kr', lastSeen: 1 }];
  const r = OS.buildOsSuggest({ members, scanRows });
  assert.equal(r.rows[0].state, 'suggest');
  assert.deepEqual(r.rows[0].cands[0].vias.sort(), ['fwd', 'mdns', 'netbios']);
});

test('② 같은 법인만 — 다른 엣지가 스캔한 같은 이름 IP 는 후보가 아니다 · corpsOf 가 그 법인을 수집하는 에이전트면 후보', () => {
  const members = [M({ tag: 'B1', name: 'db01', agent: 'edge-kr', corp: 'vc-kr' })];
  const scanRows = [R('10.1.0.5', { ptr: 'db01', agent: 'edge-pl' }), R('10.2.0.5', { ptr: 'db01', agent: 'edge-kr2' })];
  assert.equal(OS.buildOsSuggest({ members, scanRows }).rows[0].state, 'none');
  const corpsOf = (ag) => (ag === 'edge-kr2' ? new Set(['vc-kr']) : new Set(['vc-pl']));
  const r = OS.buildOsSuggest({ members, scanRows, corpsOf });
  assert.equal(r.rows[0].state, 'suggest');
  assert.deepEqual(r.rows[0].cands.map((c) => c.ip), ['10.2.0.5']);
});

test('② iDRAC 자기 주소는 후보에서 뺀다(iDRAC 이 서버 이름으로 DNS 에 올라 있는 현장)', () => {
  const members = [M({ tag: 'C1', name: 'kr-app-01', mg: 'https://10.3.0.7:443/redfish' })];
  const r = OS.buildOsSuggest({ members, scanRows: [R('10.3.0.7', { ptr: 'kr-app-01' }), R('10.3.0.8', { ptr: 'kr-app-01' })] });
  assert.deepEqual(r.rows[0].cands.map((c) => c.ip), ['10.3.0.8']);
  assert.equal(r.rows[0].state, 'suggest');
});

test('② 같은 이름 · 주소의 OS 등록이 여럿이면 ambiguous(어느 것인지 모름 — 제안하지 않는다)', () => {
  const members = [M({ tag: 'D1', name: 'dup01', corp: '' })];
  const osIndex = indexOsHosts([{ id: 'a', name: 'dup01', host: '10.0.0.1', vcenterId: 'vc-a' }, { id: 'b', name: 'dup01', host: '10.0.0.2', vcenterId: 'vc-b' }], { includeAddrOnly: true });
  const r = OS.buildOsSuggest({ members, scanRows: [R('10.0.0.3', { ptr: 'dup01' })], osIndex, pickOsEntry });
  assert.equal(r.rows[0].state, 'ambiguous');
});

test('② applyPlan — 제안 · 고르기만 · 고른 IP 가 SSH 열린 후보일 때만 · 중복 키 한 번', () => {
  const rows = new Map([
    ['k1', { key: 'k1', state: 'suggest', cands: [{ ip: '10.0.0.1', ssh: true }] }],
    ['k2', { key: 'k2', state: 'pick', cands: [{ ip: '10.0.0.2', ssh: true }, { ip: '10.0.0.3', ssh: false }] }],
    ['k3', { key: 'k3', state: 'differs', cands: [{ ip: '10.0.0.4', ssh: true }] }],
  ]);
  const p = OS.applyPlan(rows, [{ key: 'k1', ip: '10.0.0.1' }, { key: 'k1', ip: '10.0.0.1' }, { key: 'k2', ip: '10.0.0.3' }, { key: 'k3', ip: '10.0.0.4' }, { key: 'k9', ip: '1.1.1.1' }, { key: 'k2', ip: '10.0.0.2' }]);
  assert.deepEqual(p.ok.map((x) => [x.row.key, x.ip]), [['k1', '10.0.0.1']]);
  assert.deepEqual(p.refused.map((x) => [x.key, x.why]), [['k2', 'not-candidate'], ['k3', 'differs'], ['k9', 'gone']]);
});

test('② 정방향 이름 목록 — 그 에이전트(또는 그 법인을 수집하는 에이전트)의 물리서버 이름만', () => {
  const members = [M({ tag: 'E1', name: 'kr-a', agent: 'edge-kr', corp: 'vc-kr' }), M({ tag: 'E2', name: 'pl-a', agent: 'edge-pl', corp: 'vc-pl' }), M({ tag: 'E3', name: 'hq-a', agent: '', corp: 'vc-hq' }), M({ tag: 'E4', name: '10.0.0.1', addr: true, agent: 'edge-kr' })];
  assert.deepEqual(OS.fwdNamesFor(members, 'EDGE-KR'), ['kr-a']);
  assert.deepEqual(OS.fwdNamesFor(members, '__local__'), ['hq-a']);
  assert.deepEqual(OS.fwdNamesFor(members, 'edge-x', new Set(['vc-pl'])), ['pl-a']);
});

// ── 주소만 등록 — 수집이 접속하지 않는다 ─────────────────────────────────────
test('주소만(addrOnly) 항목은 사용률 수집 색인에서 빠진다 — 계정 없는 SSH 시도 · 엣지 위임 이탈 방지', () => {
  const list = [{ id: 'x', name: 'kr-db-11', host: '10.0.0.5', vcenterId: 'vc', addrOnly: true }, { id: 'y', name: 'kr-db-12', host: '10.0.0.6', vcenterId: 'vc', password: 'p' }];
  const idx = indexOsHosts(list);
  assert.equal(pickOsEntry(idx, { name: 'kr-db-11', vc: 'vc' }).entry, null);
  assert.equal(pickOsEntry(idx, { name: 'kr-db-12', vc: 'vc' }).entry?.id, 'y');
  assert.equal(pickOsEntry(indexOsHosts(list, { includeAddrOnly: true }), { name: 'kr-db-11', vc: 'vc' }).entry?.id, 'x');
});

test('등록부 addrOnly — 새 항목에서만 세우고 · 계정이 생기면 지운다 · 기존 항목에 true 를 줘도 세우지 않는다', () => {
  const a = BMR.applyBmServerBatch([{ name: 'addr-only-1', host: '10.77.0.1', vcenterId: 'vc', enabled: false, addrOnly: true, mounts: ['/'] }]);
  assert.equal(a.ok, true, a.reason);
  const id = a.results[0].server.id;
  assert.equal(BMR.listBmServersRaw().find((s) => s.id === id).addrOnly, true);
  BMR.saveBmServer({ id, name: 'addr-only-1', host: '10.77.0.1', password: 'secret', mounts: ['/'] });
  assert.ok(!('addrOnly' in BMR.listBmServersRaw().find((s) => s.id === id)), '비밀번호가 생기면 보통 항목');
  BMR.saveBmServer({ id, name: 'addr-only-1', host: '10.77.0.1', addrOnly: true, mounts: ['/'] });
  assert.ok(!('addrOnly' in BMR.listBmServersRaw().find((s) => s.id === id)), '기존 항목은 표지를 세우지 않는다');
  // 계정 없는 보통 항목(예전부터 있던)에 나중에 true 를 줘도 세우지 않는다 — 세우면 그 항목이 사용률 수집에서 조용히 빠진다
  const b = BMR.applyBmServerBatch([{ name: 'plain-1', host: '10.77.0.2', vcenterId: 'vc', mounts: ['/'] }]);
  const id2 = b.results[0].server.id;
  BMR.saveBmServer({ id: id2, name: 'plain-1', host: '10.77.0.2', addrOnly: true, mounts: ['/'] });
  assert.ok(!('addrOnly' in BMR.listBmServersRaw().find((s) => s.id === id2)));
});

// ── 라우트 ───────────────────────────────────────────────────────────────────
function fakeRouter() {
  const h = {};
  const reg = (m) => (p, ...fns) => { h[`${m} ${p}`] = fns[fns.length - 1]; h[`${m} ${p}:gates`] = fns.slice(0, -1); };
  return { h, get: reg('GET'), post: reg('POST') };
}
const fakeRes = () => { const r = { code: 200, body: null }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };

test('라우트 — 게이트는 형제 스캔 라우트와 같은 두 개(관리자 · 전체 범위) · 등록은 주소만 · 비활성 · addrOnly · 감사', async () => {
  const added = [];
  const members = [M({ tag: 'F1', name: 'kr-f-01' }), M({ tag: 'F2', name: 'kr-f-02' })];
  const D = {
    snap: () => ({ vcenters: [] }), members: async () => members, corpsOf: null,
    listBmServersRaw: () => [], registryLoadError: () => null,
    getScanResults: () => ({ a: R('10.5.0.1', { ptr: 'kr-f-01' }), b: R('10.5.0.2', { ptr: 'kr-f-02', ports: [80] }) }),
    applyBmServerBatch: (inputs) => { added.push(...inputs); return { ok: true, results: [] }; },
  };
  const rt = fakeRouter();
  registerBmOsSuggest(rt, { D });
  assert.equal(BM_OS_GATES[0], SHARED_ADMIN, '관리자 게이트는 공용 adminOnly');
  assert.deepEqual(rt.h['GET /ipam/scan/bm-os-suggest:gates'], [...BM_OS_GATES]);
  assert.deepEqual(rt.h['POST /ipam/scan/bm-os-suggest/apply:gates'], [...BM_OS_GATES]);
  const res = fakeRes(); await rt.h['GET /ipam/scan/bm-os-suggest']({}, res);
  assert.equal(res.body.counts.suggest, 1); assert.equal(res.body.counts.closed, 1);
  const r2 = fakeRes(); await rt.h['POST /ipam/scan/bm-os-suggest/apply']({ body: { items: [{ key: 'st:F1', ip: '10.5.0.1' }, { key: 'st:F2', ip: '10.5.0.2' }] }, user: { username: 't' } }, r2);
  assert.equal(r2.code, 200); assert.equal(r2.body.added, 1);
  assert.deepEqual(r2.body.refused, [{ key: 'st:F2', why: 'closed' }]);
  assert.equal(added.length, 1);
  assert.equal(added[0].host, '10.5.0.1'); assert.equal(added[0].enabled, false); assert.equal(added[0].addrOnly, true);
  assert.equal(BMR.bmServerInputIssue(added[0]), null, '등록부 검증을 통과하는 입력');
  for (const f of ['password', 'keyRef', 'credRef', 'bindApproved']) assert.ok(!(f in added[0]), `${f} 를 싣지 않는다`);
  // 등록부를 못 읽으면 503 · 등록 안 함
  const r3 = fakeRes(); await rt.h['POST /ipam/scan/bm-os-suggest/apply']({ body: { items: [{ key: 'st:F1', ip: '10.5.0.1' }] } }, { ...r3, status: r3.status, json: r3.json });
  const D2 = { ...D, registryLoadError: () => ({ reason: 'x' }) };
  const rt2 = fakeRouter(); registerBmOsSuggest(rt2, { D: D2 });
  const r4 = fakeRes(); await rt2.h['POST /ipam/scan/bm-os-suggest/apply']({ body: { items: [{ key: 'st:F1', ip: '10.5.0.1' }] } }, r4);
  assert.equal(r4.code, 503);
  const r5 = fakeRes(); await rt2.h['GET /ipam/scan/bm-os-suggest']({}, r5);
  assert.equal(r5.code, 503);
  // 빈 요청 · 상한
  const r6 = fakeRes(); await rt.h['POST /ipam/scan/bm-os-suggest/apply']({ body: { items: [] } }, r6); assert.equal(r6.code, 400);
  const r7 = fakeRes(); await rt.h['POST /ipam/scan/bm-os-suggest/apply']({ body: { items: Array.from({ length: 201 }, (_, i) => ({ key: `k${i}`, ip: '1.1.1.1' })) } }, r7); assert.equal(r7.code, 400);
});

test('라우트 — 실제 게이트 연결(centralIpam.js 가 adminOnly · fleetOnly 로 등록)', () => {
  const src = fs.readFileSync(new URL('../src/routes/admin/centralIpam.js', import.meta.url), 'utf8');
  assert.match(src, /registerBmOsSuggest\(adminRouter\);/);
  const own = fs.readFileSync(new URL('../src/routes/admin/bmOsSuggest.js', import.meta.url), 'utf8');
  assert.match(own, /adminRouter\.get\('\/ipam\/scan\/bm-os-suggest', adminOnly, fleetOnly,/);
  assert.match(own, /adminRouter\.post\('\/ipam\/scan\/bm-os-suggest\/apply', adminOnly, fleetOnly,/);
});

test('currentOsSuggest · fwdNamesForAgent — 주입 입력으로(실패는 이름 없이)', async () => {
  const D = { snap: () => ({}), members: async () => [M({ tag: 'G1', name: 'kr-g' })], corpsOf: null, listBmServersRaw: () => [], registryLoadError: () => null, getScanResults: () => ({}) };
  assert.equal((await currentOsSuggest(D)).rows[0].state, 'none');
  assert.deepEqual(await fwdNamesForAgent('edge-kr', D), ['kr-g']);
  assert.deepEqual(await fwdNamesForAgent('edge-kr', { ...D, members: async () => { throw new Error('x'); } }), []);
});

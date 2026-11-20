// 전체 점검 74회차 — VM 프로비저닝 · 구성 점검 계열(provision · vmcfg · hostcfg · clustercfg · contention · vmseries).
//   F1 펼치기 전 입력 상한(pad · 패턴 길이 · 추가 NIC · 항목 이름) · F2 연속 IP 가 255.255.255.255 를 넘으면 0.0.0.0 으로 돌던 것 ·
//   F3 시작 번호 0 이 1 로 바뀌던 것 · F4 contention 응답 파서의 O(n²) 지연 정규식 · F5 고른 호스트 · 데이터스토어를 못 찾으면 조용히 원본 위치 ·
//   F6 스토리지 프로파일 본문(스키마에 없는 모양) · F7 원본 vcenterId 없을 때 ReferenceError · F9 저장된 작업 파일 읽기 오류를 손상으로.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

// v3.18.8: 이 파일이 만든 임시 폴더는 시험이 끝나면 지운다(지우지 않아 전량 실행마다 /tmp 에 쌓였다 — tmpCleanup3188 이 고정).
//   exit 에서 한 번 더 지운다 — 모듈의 종료 flush(util/exitFlush.js)가 뒤늦게 다시 만든 폴더(수 MB 실측)까지.
const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };
const rmTmpDirs = () => { for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* 정리 실패는 시험 결과가 아니다(늦게 flush 되는 기록기와의 경합 — exit 에서 한 번 더) */ } } };
after(() => { rmTmpDirs(); process.once('exit', () => { try { rmTmpDirs(); } catch { /* 종료 중 */ } }); });

const TMP = tmpDir('prov-cfg-audit74-');
process.env.CONFIG_DIR = TMP;
process.env.DATA_SOURCE = 'live';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = (rel) => stripComments(fs.readFileSync(path.join(here, '../src', rel), 'utf8'));

const { expandSpec, PAD_MAX, PATTERN_MAX, EXTRA_NICS_MAX } = await import('../src/provision/spec.js');
const { parsePerfInstances } = await import('../src/contention/parse.js');
const { store } = await import('../src/store.js');
const { placementNotApplied, cleanPlacement } = await import('../src/provision/placement.js');
const saved = await import('../src/provision/saved.js');
const { createJob, getJob } = await import('../src/provision/jobs.js');

const SAVED_FILE = path.join(TMP, 'provision-saved.json');

// ── F9 은 저장 파일 상태가 다른 시험에 섞이지 않게 맨 먼저 ────────────────────────────
test('F9 저장된 작업 파일 읽기 오류(EISDIR)는 손상이 아니다 — 원본을 옮기지 않고 · 빈 목록에 표지 · 쓰기를 막는다 · 고치면 다시 읽는다', () => {
  fs.mkdirSync(SAVED_FILE);   // 파일 자리에 디렉터리 — readFileSync 가 EISDIR(루트로 돌아도 재현된다)
  const l = saved.listSaved({});
  assert.equal(l.total, 0);
  assert.equal(l.readError, true, '빈 목록이 "저장된 작업 없음" 이 아니라는 표지');
  assert.ok(l.reason && !l.reason.includes(TMP), '사유에 경로를 싣지 않는다');
  assert.ok(fs.statSync(SAVED_FILE).isDirectory(), '원본을 .corrupt 로 옮기지 않았다');
  assert.equal(fs.readdirSync(TMP).filter((f) => f.includes('.corrupt.')).length, 0);
  assert.throws(() => saved.addSaved({ spec: { namePattern: 'x' }, source: { id: 'vc-a:1', name: 'x', vcenterId: 'vc-a' }, user: { username: 'u' } }), /읽지 못했습니다/);
  assert.equal(saved.updateSaved('nope', { memo: 'm' }).readError, true);
  assert.equal(saved.removeSaved('nope').readError, true);
  assert.equal(saved.savedReadError()?.code, 'EISDIR');
  // 고치면(파일로 되돌리면) 재시작 없이 다시 읽는다(읽기 오류는 캐시하지 않는다).
  fs.rmdirSync(SAVED_FILE);
  fs.writeFileSync(SAVED_FILE, JSON.stringify([{ id: 's1', vcenterId: 'vc-a', name: 'kept', tags: [] }]));
  const l2 = saved.listSaved({});
  assert.equal(l2.total, 1);
  assert.equal(l2.items[0].name, 'kept');
  assert.equal(l2.readError, undefined);
  assert.equal(saved.savedReadError(), null);
});

// ── F1 입력 상한 ─────────────────────────────────────────────────────────────
test('F1 자릿수(pad) · 패턴 길이 · 추가 NIC 수 · 항목 이름 상한 — 넘으면 펼치지 않고 사유(빠르게)', () => {
  const t0 = Date.now();
  const p = expandSpec({ namePattern: '{n}', count: 500, pad: 100_000, guest: { ipMode: 'dhcp' } });
  assert.equal(p.vms.length, 0);
  assert.match(p.errors.join(' '), /자릿수/);
  const n = expandSpec({ namePattern: 'x'.repeat(PATTERN_MAX + 1) + '{n}', count: 2, guest: { ipMode: 'dhcp' } });
  assert.equal(n.vms.length, 0);
  assert.match(n.errors.join(' '), /이름 패턴/);
  const h = expandSpec({ namePattern: 'v{n}', count: 2, guest: { ipMode: 'dhcp', hostnamePattern: 'h'.repeat(PATTERN_MAX + 1) } });
  assert.equal(h.vms.length, 0);
  const e = expandSpec({ namePattern: 'v{n}', count: 500, guest: { ipMode: 'dhcp', extraNics: Array.from({ length: EXTRA_NICS_MAX + 1 }, () => ({ ipMode: 'dhcp' })) } });
  assert.equal(e.vms.length, 0);
  assert.match(e.errors.join(' '), /추가 NIC/);
  const nul = expandSpec({ namePattern: 'v{n}', count: 2, guest: { ipMode: 'dhcp', extraNics: [null] } });
  assert.equal(nul.vms.length, 0, 'null 원소는 TypeError(500)가 아니라 사유');
  const pv = expandSpec({ perVm: [{ name: 'a'.repeat(PATTERN_MAX + 1) }], guest: { ipMode: 'dhcp' } });
  assert.equal(pv.vms.length, 0);
  assert.ok(Date.now() - t0 < 2000, '상한은 펼치기 전에 본다');
  // 경계 안은 그대로 펼친다(예전 결과와 같다).
  const ok = expandSpec({ namePattern: 'web-{n}', count: 3, pad: PAD_MAX, guest: { ipMode: 'dhcp', extraNics: Array.from({ length: EXTRA_NICS_MAX }, () => ({ ipMode: 'dhcp' })) } });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.vms.length, 3);
  assert.equal(ok.vms[0].name, `web-${'1'.padStart(PAD_MAX, '0')}`);
  assert.equal(ok.vms[0].nics.length, EXTRA_NICS_MAX + 1);
  const plain = expandSpec({ namePattern: 'web-{n}', count: 3, pad: 2, guest: { ipMode: 'static', ipStart: '10.0.0.10' } });
  assert.deepEqual(plain.vms.map((v) => [v.name, v.ip]), [['web-01', '10.0.0.10'], ['web-02', '10.0.0.11'], ['web-03', '10.0.0.12']]);
});

test('F2 연속 IP 가 255.255.255.255 를 넘으면 0.0.0.0 으로 돌지 않고 사유(주 NIC · 추가 NIC)', () => {
  const over = expandSpec({ namePattern: 'v{n}', count: 3, guest: { ipMode: 'static', ipStart: '255.255.255.254' } });
  assert.match(over.errors.join(' '), /255\.255\.255\.255 를 넘습니다/);
  assert.ok(!over.vms.some((v) => v.ip === '0.0.0.0') || over.errors.length > 0);
  const edge = expandSpec({ namePattern: 'v{n}', count: 2, guest: { ipMode: 'static', ipStart: '255.255.255.254' } });
  assert.deepEqual(edge.errors, []);
  assert.deepEqual(edge.vms.map((v) => v.ip), ['255.255.255.254', '255.255.255.255']);
  const nic = expandSpec({ namePattern: 'v{n}', count: 3, guest: { ipMode: 'static', ipStart: '10.0.0.1', extraNics: [{ ipStart: '255.255.255.255' }] } });
  assert.match(nic.errors.join(' '), /NIC2 시작 IP/);
});

test('F3 시작 번호 0 은 0 부터 · 음수는 사유 · 비면 1', () => {
  assert.deepEqual(expandSpec({ namePattern: 'v{n}', count: 2, startIndex: 0 }).vms.map((v) => v.name), ['v0', 'v1']);
  assert.match(expandSpec({ namePattern: 'v{n}', count: 2, startIndex: -3 }).errors.join(' '), /시작 번호/);
  assert.deepEqual(expandSpec({ namePattern: 'v{n}', count: 2, startIndex: '' }).vms.map((v) => v.name), ['v1', 'v2']);
  assert.deepEqual(expandSpec({ namePattern: 'v{n}', count: 2 }).vms.map((v) => v.name), ['v1', 'v2']);
});

// ── F4 contention 파서 선형 ──────────────────────────────────────────────────
test('F4 parsePerfInstances — 정상 응답 결과는 그대로 · 닫히지 않은 <id>/<returnval> 반복은 선형(비율)', () => {
  const xml = '<returnval xsi:type="PerfEntityMetric"><entity type="VirtualMachine">vm-7</entity><sampleInfo/>'
    + '<value xsi:type="PerfMetricIntSeries"><id><counterId>6</counterId><instance></instance></id><value>100</value><value>-1</value><value>300</value></value>'
    + '<value xsi:type="PerfMetricIntSeries"><id><counterId>9</counterId><instance>scsi0:1</instance></id><value>4</value></value>'
    + '</returnval><returnval><entity type="HostSystem">host-1</entity></returnval>';
  const m = parsePerfInstances(xml, 'VirtualMachine');
  assert.deepEqual([...m.keys()], ['vm-7']);
  assert.deepEqual(m.get('vm-7').get('6').get(''), [100, 300]);
  assert.deepEqual(m.get('vm-7').get('9').get('scsi0:1'), [4]);
  assert.equal(parsePerfInstances('<returnvalX><entity type="VirtualMachine">vm-1</entity></returnvalX>', 'VirtualMachine').size, 0);

  const best = (f) => { let b = Infinity; for (let i = 0; i < 3; i++) { const t = performance.now(); f(); b = Math.min(b, performance.now() - t); } return b; };
  const badId = (n) => '<returnval><entity type="VirtualMachine">vm-1</entity>' + '<id>'.repeat(n) + '</returnval>';
  const badRv = (n) => '<returnval>'.repeat(n);
  for (const mk of [badId, badRv]) {
    // 옛 판정은 n=40,000(160KB)에서 0.96초(<id>) · 2.0초(<returnval>)였다(새 판정 0.3ms). 8배 입력의 시간 비율이 선형(≈8)에 가까워야 한다(O(n²)이면 ≈64).
    const small = mk(5_000); const big = mk(40_000);
    const a = best(() => parsePerfInstances(small, 'VirtualMachine'));
    const b = best(() => parsePerfInstances(big, 'VirtualMachine'));
    assert.ok(b < 200, `큰 입력도 짧게(${b.toFixed(1)}ms)`);
    assert.ok(b / Math.max(a, 0.5) < 24, `비율 ${(b / Math.max(a, 0.5)).toFixed(1)}`);
  }
});

// ── F5 · F6 · F7 배치 ────────────────────────────────────────────────────────
store.snapshot = {
  ...store.snapshot,
  vms: [{ id: 'vc-p74:vm-1', name: 'tpl', vcenterId: 'vc-p74', template: true, powerState: 'POWERED_OFF', guestOS: 'rhel' }],
  hosts: [{ id: 'vc-p74:host-1', name: 'esx-01', vcenterId: 'vc-p74', cluster: 'C1' }, { id: 'vc-other:host-9', name: 'esx-09', vcenterId: 'vc-other', cluster: 'C9' }],
  datastores: [{ id: 'vc-p74:datastore-1', name: 'ds-01', vcenterId: 'vc-p74' }],
};

test('F5 고른 호스트 · 데이터스토어를 원본 vCenter 에서 못 찾으면 작업을 만들지 않는다(조용히 원본 위치 금지)', () => {
  const user = { user: { username: 'admin', role: 'admin' } };
  const base = { sourceId: 'vc-p74:vm-1', namePattern: 'n74-{n}', count: 1, guest: { ipMode: 'dhcp' } };
  const h = createJob({ ...base, placement: { host: 'esx-09' } }, user);   // 다른 vCenter 의 호스트 이름
  assert.equal(h.ok, false);
  assert.match(h.reason, /호스트 'esx-09'/);
  const d = createJob({ ...base, placement: { datastore: 'ds-typo' } }, user);
  assert.equal(d.ok, false);
  assert.match(d.reason, /데이터스토어 'ds-typo'/);
  const ok = createJob({ ...base, placement: { host: 'esx-01', datastore: 'ds-01', folder: 'Prod', resourcePool: 'Batch', storageProfile: 'Gold' } }, user);
  assert.equal(ok.ok, true, ok.reason);
  assert.deepEqual(ok.job.placementNotApplied, ['folder', 'resourcePool', 'storageProfile']);
  assert.deepEqual(getJob(ok.job.id).placementNotApplied, ['folder', 'resourcePool', 'storageProfile']);
});

test('F5 · F6 placementNotApplied — 적용하지 않는 항목만(클러스터는 호스트를 고르지 않았을 때)', () => {
  assert.deepEqual(placementNotApplied({}), []);
  assert.deepEqual(placementNotApplied({ host: 'h', datastore: 'd' }), []);
  assert.deepEqual(placementNotApplied({ cluster: 'C1' }), ['cluster']);
  assert.deepEqual(placementNotApplied({ cluster: 'C1', host: 'h' }), []);
  assert.deepEqual(placementNotApplied({ folder: ' F ', resourcePool: 'P', storageProfile: 'S' }), ['folder', 'resourcePool', 'storageProfile']);
  assert.deepEqual(placementNotApplied(null), []);
  assert.deepEqual(cleanPlacement(null), { cluster: '', host: '', datastore: '', folder: '', resourcePool: '', storageProfile: '' }, 'null 은 TypeError 가 아니라 빈 배치');
});

test('F6 · F7 소스 — 스키마에 없는 profileName 본문을 보내지 않고 · 원본 vcenterId 대체값은 이 vCenter id', () => {
  const src = SRC('provision/vsphere.js');
  assert.ok(!/profileName/.test(src), 'VirtualMachineDefinedProfileSpec 에 profileName 필드는 없다');
  assert.ok(!/source\.vcenterId \|\| vcenterId\b/.test(src), '정의되지 않은 vcenterId 를 참조하지 않는다');
  assert.match(src, /source\.vcenterId \|\| vc\.id/);
  assert.match(src, /if \(placement\.host && !hostRef\) throw/);
  assert.match(src, /if \(placement\.datastore && !dsRef\) throw/);
});

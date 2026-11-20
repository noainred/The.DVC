/**
 * 결정(76~105 남긴 것 · 2026-11-20 · 사용자 "결정 필요한 것은 권장 사항으로 진행해줘") — G3 판정 정확성 · 화면.
 *  A5 `mem.minFree` 권고 문구 = 판정(물리 메모리 2% 이하) — 판정하지 않는 '수백 MB' 상한을 권고처럼 보이지 않는다(근거에 참고로만).
 *  A7 MIG 기반 vGPU 프로파일(…-<슬라이스>-<GB><시리즈>)은 'GPU 메모리 ÷ 프로파일 GB' 슬롯 수를 지어내지 않는다 — total · free null + mig 표지 ·
 *     화면 · CSV · 엑셀 문구 '슬롯 계산 안 함(MIG)' · 배치 추천은 '0대' 가 아니라 모름. 판정은 gpu/vgpuProfile.js vgpuProfileIsMig 하나(웹 미러 대조).
 *  A9 Veeam 수집 목록 잘림(truncated)이 모니터링 '보호 VM 수'(veeamCount)에도 — partial + truncated(수는 하한 · 지우지 않음) · 백업 행은
 *     '부분(목록 잘림)' · 대조에 없는 VM 은 '없음' 이 아니라 모름(veeamAbsentUnknown — 미백업 · 백업 필요 공백 판정에 넣지 않는다).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };
const rmTmpDirs = () => { for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* 정리 실패는 시험 결과가 아니다 */ } } };
after(() => { rmTmpDirs(); process.once('exit', () => { try { rmTmpDirs(); } catch { /* 종료 중 */ } }); });

const DIR = tmpDir('decide3G3-');
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
const VC_CUT = 'kr:vc31';    // Veeam 연동 · 결과 목록이 잘림
const VC_FULL = 'kr:vc32';   // Veeam 연동 · 온전한 결과
const ALL = [VC_CUT, VC_FULL];
fs.writeFileSync(path.join(DIR, 'vcenters.json'), JSON.stringify({ vcenters: ALL.map((id) => ({ id, name: id, host: `${id.split(':')[1]}.corp.local`, username: 'u', password: 'p' })) }));
const closers = [];
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch { /* */ } } });

// 모듈은 모두 첫 test() 앞에서 불러온다 — 시험 사이의 최상위 await 는 루트 after 훅을 앞당겨(닫을 서버가 아직 없을 때) 파일이 끝나지 않는다(실측).
const C = await import('../src/bmusage/tuning/catalog.js');
const J = await import('../src/bmusage/tuning/judge.js');
const P = await import('../src/gpu/vgpuProfile.js');
const AT = await import('../src/gpu/allocTree.js');
const W = await import('../../web/src/views/tools/gpuAllocText.js');
const B = await import('../src/veeam/backupCounts.js');
const BS = await import('../src/veeam/backupStatus.js');
const WB = await import('../../web/src/views/veeamBadge.js');
const WV = await import('../../web/src/views/tools/backupViewText.js');

/* ── A5 ─────────────────────────────────────────────────────────────────── */
const TU = (o = {}) => ({ v: 1, at: 1, sysctl: {}, sections: { sysctl: 'ok', blkq: 'ok', irq: 'ok', netq: 'ok', softnet: 'ok', units: 'ok', kargs: 'ok', hugepages: 'ok' }, ...o });

test('A5 — mem.minFree 권고 문구는 판정(물리 메모리 2% 이하)만 말한다 · 수백 MB 는 근거의 참고로만', () => {
  const it = C.TUNING_ITEMS.find((x) => x.id === 'mem.minFree');
  const rule = it.rec.all;
  assert.equal(rule.kind, 'maxPctMem'); assert.equal(rule.pct, 2, '판정은 그대로');
  assert.equal(rule.text, '물리 메모리 2% 이하');
  assert.equal(/MB|1~2%/.test(rule.text), false, '판정하지 않는 기준을 권고 문구에 싣지 않는다');
  assert.match(it.evidence, /not exceeding a few hundred megabytes/, '근거 인용은 그대로');
  assert.match(it.evidence, /판정하지 않는 참고/, '판정하지 않는다는 사실을 근거에 밝힌다');
  // 512GB 서버의 10GB(1.95%) — 판정은 예전과 같이 적합, 화면 권고 문구도 판정과 같은 말
  const j = J.judgeTuning({ tuning: TU({ memTotalKb: 512 * 1024 * 1024, sysctl: { 'vm.min_free_kbytes': String(10 * 1024 * 1024) } }), role: 'general' });
  const row = j.items.find((x) => x.id === 'mem.minFree');
  assert.equal(row.status, 'ok'); assert.equal(row.rec, '물리 메모리 2% 이하');
});

test('A5 스윕 — 물리 메모리 비율 판정(maxPctMem) 항목의 권고 문구는 판정 비율을 말하고 판정하지 않는 절대 상한(MB · GB)을 싣지 않는다', () => {
  let n = 0;
  for (const it of C.TUNING_ITEMS) {
    for (const rule of Object.values(it.rec || {})) {
      if (rule?.kind !== 'maxPctMem') continue;
      n++;
      assert.ok(rule.text.includes(`${rule.pct}%`), `${it.id}: 판정 비율 ${rule.pct}% 를 말한다`);
      assert.equal(/\d\s*(?:MB|GB|KB)/i.test(rule.text), false, `${it.id}: 판정하지 않는 절대 상한`);
    }
  }
  assert.ok(n >= 1);
});

/* ── A7 ─────────────────────────────────────────────────────────────────── */
const ON = 'POWERED_ON';
const vm = (id, name, gpu, host = 'esx1', vcenterId = 'vc1') => ({ id: `${vcenterId}:${id}`, name, host, vcenterId, powerState: ON, gpu });
const vg = (profile, n = 1) => ({ type: 'vgpu', count: n, vgpu: n, passthrough: 0, profile });
const PROFILES = ['grid_a100-4-20c', 'grid_a100-3-40c', 'nvidia_h100-1-10c', 'GRID_A30-2-12C', 'grid_a100d-7-80c', 'grid_a100-1-5cme',
  'grid_a100-10c', 'nvidia_l40s-48q', 'grid_t4-16q', 'grid_m60-0b', 'grid_m10-2b4', 'nvidia_l4-12q', 'weird', '', null, undefined, 'x'.repeat(200), `${'x'.repeat(130)}-4-20c`, '  grid_a100-2-10c  ',
  'synthetic_x-1-2b4'];   // 마지막은 실제 이름이 아니다 — 끝 규칙(디스플레이 수 한 자리 \d?)까지 서버 · 웹이 같은지 보는 대조용

test('A7 — MIG 꼴 판정(vgpuProfileIsMig) · 웹 미러(profileIsMig · profileFamily.mig)와 같은 입력으로 같은 값', () => {
  const mig = ['grid_a100-4-20c', 'grid_a100-3-40c', 'nvidia_h100-1-10c', 'GRID_A30-2-12C', 'grid_a100d-7-80c', '  grid_a100-2-10c  '];
  for (const p of mig) assert.equal(P.vgpuProfileIsMig(p), true, String(p));
  for (const p of ['grid_a100-10c', 'nvidia_l40s-48q', 'grid_m60-0b', 'grid_m10-2b4', 'weird', '', null, `${'x'.repeat(130)}-4-20c`]) assert.equal(P.vgpuProfileIsMig(p), false, String(p));
  for (const p of PROFILES) {
    assert.equal(W.profileIsMig(p), P.vgpuProfileIsMig(p), `웹 미러: ${String(p).slice(0, 40)}`);
    const fam = W.profileFamily(p);
    if (fam) assert.equal(fam.mig, P.vgpuProfileIsMig(p), `profileFamily.mig: ${p}`);
  }
  assert.deepEqual(W.profileFamily('grid_a100-3-40c'), { family: 'a100', mig: true }, '기존 계약 그대로');
  assert.deepEqual(W.profileFamily('grid_a40-24q'), { family: 'a40', mig: false });
});

test('A7 — MIG 기반 프로파일 GPU 는 전체 · 남은 슬롯 null + mig(지어내지 않음) · 사용 장치 수 · 할당 GB 는 그대로 · 일반 프로파일은 예전 그대로', () => {
  const h = { vcenterId: 'vc1', name: 'esx1', cluster: 'CL1', gpus: [
    { model: 'NVIDIA A100-PCIE-40GB', memGB: 40, mode: 'vgpu', vms: ['vm-1'] },
    { model: 'NVIDIA A40', memGB: 48, mode: 'vgpu', vms: ['vm-2'] },
  ] };
  const r = AT.buildHostAlloc(h, [vm('vm-1', 'mig', vg('grid_a100-4-20c')), vm('vm-2', 'tsl', vg('grid_a40-24q'))]);
  const [m, n] = r.gpus;
  assert.deepEqual(m.slots, { total: null, used: 1, free: null, profile: 'grid_a100-4-20c', mig: true }, '수정 전: total 2 · free 1(메모리 ÷ 20)');
  assert.equal(m.allocGB, 20); assert.equal(m.spareGB, m.capGB - 20, '메모리 할당 · 예비는 사실');
  assert.deepEqual(n.slots, { total: 2, used: 1, free: 1, profile: 'grid_a40-24q' }, '일반(시분할) 프로파일은 그대로');
  // 문구 — 서버(CSV · 엑셀)와 웹(계층 표)이 같은 말 · 'NaN' · 'null' · 'undefined' · '?' 를 만들지 않는다
  assert.equal(AT.MIG_SLOTS_TEXT, W.MIG_SLOTS_TEXT); assert.equal(AT.MIG_NOTE_TEXT, W.MIG_NOTE_TEXT);
  assert.equal(AT.slotsText(m.slots), `사용 1 / 전체 ${AT.MIG_SLOTS_TEXT}`);
  assert.equal(AT.gpuProfText(m), `grid_a100-4-20c · 1대 · ${AT.MIG_SLOTS_TEXT}`);
  assert.equal(AT.gpuNoteText(m), AT.MIG_NOTE_TEXT);
  const tx = W.gpuTexts(m);
  assert.equal(tx.prof, AT.gpuProfText(m)); assert.equal(tx.note, AT.gpuNoteText(m));
  for (const s of [AT.slotsText(m.slots), AT.gpuProfText(m), AT.gpuNoteText(m), tx.prof, tx.note]) assert.equal(/NaN|null|undefined|\?/.test(s), false, s);
  // 일반 프로파일 문구는 예전 그대로
  assert.equal(AT.slotsText(n.slots), '사용 1 / 전체 2'); assert.equal(AT.gpuNoteText(n), '같은 프로파일 1대 더 가능');
  assert.equal(W.gpuTexts(n).prof, 'grid_a40-24q · 1/2 슬롯');
});

test('A7 — 계층 · 평면 행(CSV · 엑셀) · 웹 배치 추천: MIG GPU 의 남은 슬롯을 0 · 수로 세지 않는다(모름)', () => {
  const host = (id, name, gpus) => ({ id: `vc1:${id}`, vcenterId: 'vc1', name, cluster: 'CL', vcDatacenter: 'DC1', connectionState: 'CONNECTED', gpus });
  const s = {
    vcenters: [{ id: 'vc1', name: 'vc' }],
    hosts: [
      host('h1', 'esx1', [{ model: 'NVIDIA A100-PCIE-40GB', memGB: 40, mode: 'vgpu', vms: ['vm-1'] }]),
      host('h2', 'esx2', [{ model: 'NVIDIA A100-PCIE-40GB', memGB: 40, mode: 'vgpu', vms: [] }]),
    ],
    vms: [vm('vm-1', 'mig', vg('grid_a100-4-20c'))],
  };
  const t = AT.buildGpuAllocTree(s);
  const g1 = t.vcenters[0].datacenters[0].clusters[0].hosts.find((h) => h.name === 'esx1').gpus[0];
  assert.equal(g1.slots.mig, true); assert.equal(g1.slots.free, null);
  const flat = AT.flatRows(t);
  const row = flat.find((x) => x.host === 'esx1' && x.vm === 'mig');
  assert.equal(row.slots, `사용 1 / 전체 ${AT.MIG_SLOTS_TEXT}`);
  for (const x of flat) for (const v of Object.values(x)) assert.equal(/NaN|undefined/.test(String(v)), false);
  // 웹 배치 추천 — 같은 프로파일 GPU 는 '남은 슬롯 모름(MIG)' 으로 세고 같은 프로파일 수는 0 이 아니라 null(화면 '—')
  const r = W.placementCandidates(t, 'grid_a100-4-20c');
  assert.equal(r.mig, true);
  assert.equal(r.skipped.migSlots, 1);
  assert.equal(r.same, null, '수정 전: 1(메모리 기준 2 - 사용 1)');
  assert.equal(r.rows.some((x) => x.kind === 'same'), false);
  assert.ok(r.rows.some((x) => x.kind === 'empty' && x.host === 'esx2'), '빈 GPU 추정(기존 — MIG 구성에 따라 다름 표기)은 그대로');
  // 일반 프로파일 배치 추천은 예전 그대로(same 은 수)
  const r2 = W.placementCandidates(t, 'grid_a100-10c');
  assert.equal(r2.mig, false); assert.equal(typeof r2.same, 'number'); assert.equal(r2.skipped.migSlots, 0);
});

/* ── A9 ─────────────────────────────────────────────────────────────────── */
const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR;
const okView = { ok: true, lastOkTs: NOW - 60_000 };

test('A9 — resultsTruncated(판정 코어 하나) · veeamCount 가 잘림을 받으면 partial + truncated(수는 하한 — 지우지 않는다)', () => {
  assert.equal(B.resultsTruncated([{ result: { truncated: ['backupObjects'] } }, { result: {} }]), true);
  for (const x of [[], null, undefined, [{ result: { truncated: [] } }], [{ result: {} }], [{}], [{ result: { truncated: true } }]]) assert.equal(B.resultsTruncated(x), false, JSON.stringify(x));
  const byVm = { 'vc:vm-1': { run: 0 }, 'vc:vm-2': { run: 1 } };
  const full = B.veeamCount({ views: [okView], byVm, vmTotal: 10 });
  assert.equal(full.partial, false); assert.equal('truncated' in full, false, '잘리지 않았으면 키 없음(정상 규모 화면 변화 없음)');
  const cut = B.veeamCount({ views: [okView], byVm, vmTotal: 10, truncated: true });
  assert.equal(cut.n, 2, '숫자는 하한으로 그대로'); assert.equal(cut.partial, true); assert.equal(cut.truncated, true);
  assert.equal(B.veeamCount({ views: [okView], byVm, vmTotal: 10, truncated: 'yes' }).partial, false, '불리언 true 만');
  const none = B.veeamCount({ views: [{ ok: false, lastOkTs: null }], byVm: null, vmTotal: 10, truncated: true });
  assert.equal(none.n, null); assert.equal('truncated' in none, false, '수를 못 낸 칸은 사유 코드만');
});

test('A9 — 백업 행: 잘린 결과면 부분 · 대조에 없는 VM 은 모름(미백업 · 나눔에 넣지 않음) · 사유 표지', () => {
  const vms = [{ id: 'vc:vm-1', name: 'a' }, { id: 'vc:vm-2', name: 'b' }, { id: 'vc:vm-3', name: 'c' }];
  const match = { byVm: { 'vc:vm-1': { lb: NOW - HOUR } } };
  const ev = { byVm: { 'vc:vm-1': 1 } };
  const sc = { n: 1, partial: false };
  const base = { vms, linked: true, match, sc, ev, now: NOW };
  const full = BS.backupRow({ ...base, vcnt: B.veeamCount({ views: [okView], byVm: match.byVm, vmTotal: 3 }) });
  assert.equal(full.veeamState, 'ok'); assert.equal('veeamTruncated' in full, false); assert.equal('veeamAbsentUnknown' in full, false);
  assert.ok(full.split, '온전한 결과면 나눔을 낸다');
  const cut = BS.backupRow({ ...base, vcnt: B.veeamCount({ views: [okView], byVm: match.byVm, vmTotal: 3, truncated: true }) });
  assert.equal(cut.veeamState, 'partial'); assert.equal(cut.veeam, 1, '수는 하한');
  assert.equal(cut.veeamTruncated, true); assert.equal(cut.veeamAbsentUnknown, true, '대조에 없는 vm-2 · vm-3 은 미백업이 아니라 모름');
  assert.equal(cut.split, null, '부재가 모름이면 나눔(Veeam 만 · 스냅샷만 · 없음)도 모름');
  assert.equal('veeamAbsentServers' in cut, false);
  const both = BS.backupRow({ ...base, vcnt: B.veeamCount({ views: [okView, { ok: null, lastOkTs: null }], byVm: match.byVm, vmTotal: 3, truncated: true }) });
  assert.equal(both.veeamAbsentServers, true, '서버 미수집과 잘림이 겹치면 둘 다 말한다');
  // 합계 — 잘린 행은 부분 행으로 센다(정상으로 세지 않는다)
  const t = BS.backupTotals([full, cut]);
  assert.equal(t.veeamPartial, 1);
  // VM 단위 — absentKnown:false 면 대조에 없는 VM 의 Veeam 칸은 null('없음')이 아니라 undefined(모름)
  assert.equal(BS.vmBackupView(vms[1], undefined, undefined, { absentKnown: !cut.veeamAbsentUnknown, now: NOW }).v, undefined);
  assert.equal(BS.vmBackupView(vms[1], undefined, undefined, { absentKnown: !full.veeamAbsentUnknown, now: NOW }).v, null);
});

test('A9 — 웹 문구: 카드 칸 · 백업 상태 · 모름 사유가 \'부분(목록 잘림)\' 을 말한다(잘리지 않았으면 예전 그대로)', () => {
  const cut = { src: 'veeam', ...B.veeamCount({ views: [okView], byVm: { 'vc:vm-1': {} }, vmTotal: 5, truncated: true }) };
  const c = WB.backupCell(cut, null, NOW);
  assert.equal(c.text, '1/5 *'); assert.equal(c.tone, 'warn');
  assert.ok(c.title.includes(WB.VEEAM_TRUNCATED_LINE)); assert.match(WB.VEEAM_TRUNCATED_LINE, /부분\(목록 잘림\)/);
  const full = WB.backupCell({ src: 'veeam', ...B.veeamCount({ views: [okView], byVm: { 'vc:vm-1': {} }, vmTotal: 5 }) }, null, NOW);
  assert.equal(full.text, '1/5'); assert.equal(full.title.includes('목록 잘림'), false);
  assert.equal(WV.veeamStateOf('partial', true).text, '부분(목록 잘림)');
  assert.equal(WV.veeamStateOf('partial').text, '일부 서버만', '잘리지 않은 부분은 예전 그대로');
  assert.equal(WV.veeamStateOf('ok', true).text, '정상', '표지는 부분 상태에만');
  assert.match(WV.absentUnknownText({ veeam: 1, veeamAbsentUnknown: true, veeamTruncated: true }), /목록 잘림/);
  assert.equal(/첫 수집 전/.test(WV.absentUnknownText({ veeam: 1, veeamAbsentUnknown: true, veeamTruncated: true })), false, '잘림만이면 서버 사유를 지어내지 않는다');
  assert.match(WV.absentUnknownText({ veeam: 1, veeamAbsentUnknown: true, veeamTruncated: true, veeamAbsentServers: true }), /첫 수집 전.*잘려/);
  assert.match(WV.absentUnknownText({ veeam: 1, veeamAbsentUnknown: true }), /^이 vCenter 를 맡은 Veeam 서버 중 아직 첫 수집 전이거나 한 번도 읽지 못한 서버가 있어, /, '예전 문구 그대로');
  assert.equal(WV.absentUnknownText({ veeam: null, veeamAbsentUnknown: true }), '');
  assert.equal(WV.absentUnknownText({ veeam: 1 }), '');
  for (const s of [c.title, WV.absentUnknownText({ veeam: 1, veeamAbsentUnknown: true, veeamTruncated: true })]) assert.equal(s.includes('`'), false, '문구에 백틱 금지');
  // 서버 문구 표 · 웹 헬퍼 1:1 — 서버 veeamState 값(partial)과 웹 표 키가 맞다
  assert.ok(WV.VEEAM_STATE.partial);
});

test('A9 라우트 — /veeam/backup-counts 는 잘린 결과로 센 vCenter 에만 partial · truncated · 백업 실행 대조(veeamMatchFor)도 같은 판정', { timeout: 60_000 }, async () => {
  const R = await import('../src/veeam/registry.js');
  const VS = await import('../src/veeam/store.js');
  const now = Date.now();   // 결과 신선도(resultMaxAgeMs)는 라우트가 실제 시각으로 본다 — 결과 ts 는 지금
  const a = R.saveServer({ name: 'VBR-CUT', host: 'vbr-cut.corp.local', username: 'svc', password: 'pw-1', vcenterIds: [VC_CUT] });
  VS.putResult(a.id, { ok: true, ts: now, jobs: [], counts: {}, notes: [], truncated: ['backupObjects'], vms: [{ n: 'k1', m: 'vm-1', h: 'vc31.corp.local', j: [], rp: 1 }] });
  const b = R.saveServer({ name: 'VBR-FULL', host: 'vbr-full.corp.local', username: 'svc', password: 'pw-2', vcenterIds: [VC_FULL] });
  VS.putResult(b.id, { ok: true, ts: now, jobs: [], counts: {}, notes: [], vms: [{ n: 'k1', m: 'vm-1', h: 'vc32.corp.local', j: [], rp: 1 }] });
  const express = (await import('express')).default;
  const { store } = await import('../src/store.js');
  const { registerVeeamBadges, veeamMatchFor } = await import('../src/routes/api/veeam.js');
  const prev = store.snapshot;
  closers.push(() => { store.snapshot = prev; });
  const vmsOf = (id) => [{ id: `${id}:vm-1`, vcenterId: id, name: 'k1' }, { id: `${id}:vm-2`, vcenterId: id, name: 'k2' }];
  store.snapshot = { source: 'live', generatedAt: NOW + 1, vcenters: ALL.map((id) => ({ id, name: id })), vms: ALL.flatMap(vmsOf), hosts: [] };
  const app = express();
  const user = { username: 'a', role: 'admin' };
  app.use((req, _res, next) => { req.user = user; next(); });
  const api = express.Router(); registerVeeamBadges(api); app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  closers.push(() => new Promise((r) => srv.close(() => r())));
  const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/veeam/backup-counts`);
  const body = await r.json();
  const cut = body.byVc[VC_CUT]; const full = body.byVc[VC_FULL];
  assert.equal(cut.src, 'veeam'); assert.equal(cut.n, 1, '수는 하한으로 그대로');
  assert.equal(cut.partial, true); assert.equal(cut.truncated, true);
  assert.equal(full.n, 1); assert.equal(full.partial, false); assert.equal('truncated' in full, false);
  // 백업 실행 계획 쪽 대조(96회차)도 같은 판정 코어 — 잘린 쪽만 표지
  assert.equal(veeamMatchFor({ id: VC_CUT }, vmsOf(VC_CUT), { user }).truncated, true);
  assert.equal('truncated' in veeamMatchFor({ id: VC_FULL }, vmsOf(VC_FULL), { user }), false);
});

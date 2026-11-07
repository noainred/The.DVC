/**
 * 7b단계 서버 등록(CSV/Excel 온보딩) — 파서(별칭 · 인코딩 · 상한 · .xlsx 값만 · 수식 결과 없음 · 병합 셀) · 분석(비밀 원문 거부 · 자격 칸 값 비노출 ·
 * 중복 · SSRF(저장 규칙 그대로) · 법인 · 범위 404/403 · 기존 항목 법인 · 수집 경로 edge/central/auto · RTT) · 결과 CSV 수식 주입 차단 ·
 * 적용(한 번 쓰기 · 직전 스냅샷 · 직렬 큐 · 정책 잠금 · 못 읽은 등록부) · 실제 라우터(업로드 · 서명 다르면 409 · 범위 계정 행 거부).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bm7bimp-'));
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = 'live';
process.env.SETTINGS_OWNERS = 'adm';
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

const F = await import('./_sshKeyFixtures.js');
const VAULT = await import('../src/security/secretVault.js');
VAULT.saveSecretsPolicy({ mode: 'encrypted', level: 1 });
const P = await import('../src/bmusage/onboard/importParse.js');
const A = await import('../src/bmusage/onboard/importAnalyze.js');
const RUN = await import('../src/bmusage/onboard/onboardRun.js');
const KS = await import('../src/bmusage/onboard/keyStore.js');
const BM = await import('../src/bmstor/registry.js');
const IDR = await import('../src/idrac/registry.js');
const ED = await import('../src/bmusage/onboard/edgeDeploy.js');
const ExcelJS = (await import('exceljs')).default;

const ED1 = F.ed25519Key();
const KEY = KS.addKey({ name: 'kr-ops-ed25519', privateKey: ED1.pem }, { by: 'adm' });
assert.equal(KEY.ok, true, KEY.reason);
const ACC = KS.saveAccount({ name: 'kr-ops', kind: 'os', corp: 'vcA', username: 'monitor', keyRef: KEY.key.id }, { by: 'adm' });
const IACC = KS.saveAccount({ name: 'kr-idrac-ro', kind: 'idrac', corp: 'vcA', username: 'ro', password: 'Idrac-Secret-77' }, { by: 'adm' });
const BACC = KS.saveAccount({ name: 'b-ops', kind: 'os', corp: 'vcB', username: 'bmon', password: 'B-pass-1' }, { by: 'adm' });
assert.ok(ACC.ok && IACC.ok && BACC.ok);

const csv = (lines) => Buffer.from(`﻿${lines.join('\r\n')}\r\n`, 'utf8');
const HDR = 'name,corp,idrac_host,idrac_cred,service_tag,os_host,os_port,os_cred,os_key,collect_via,mounts,enabled,note';
const corps = [{ id: 'vcA', name: 'KR-SEL', dc: '서울' }, { id: 'vcB', name: 'PL-WAW', dc: '바르샤바' }, { id: 'vcC', name: 'US-EAST', dc: '' }];
async function ctxOf({ view = null, write = null, full = true, isEdge = false, edgeOf = null, rttOf = null } = {}) {
  const D = await RUN.defaultOnboardDeps();
  return RUN.buildOnboardCtx({
    D, corps, isEdge, myCorps: [], edgeOf: edgeOf || ((vc) => (vc === 'vcB' ? { agent: 'edge-waw', online: true } : vc === 'vcC' ? { agent: 'edge-us', online: null } : null)),
    rttOf: rttOf || ((vc) => (vc === 'vcA' ? { rttMs: 40 } : vc === 'vcC' ? { rttMs: 870 } : null)),
    canView: (vc) => (view ? view.includes(vc) : true), canWrite: (vc) => (write ? write.includes(vc) : true), fullScope: full,
  }).ctx;
}

test('① 파서 — 별칭(한/영) · UTF-8 BOM · EUC-KR 감지 · 주석 행 · 모르는 열 경고 · 비밀 칸은 값을 읽지 않고 표시 · 상한(5,000행 · 4MB · 열)', async () => {
  const r = await P.parseOnboardFile(csv(['서버명,법인,iDRAC 주소,OS 주소,OS 계정,SSH 키,수집 경로,마운트,비밀번호,엉뚱한열', '# 설명 행', 'bm1,KR-SEL,10.20.3.11,10.20.4.11,kr-ops,kr-ops-ed25519,auto,/,,x', 'bm2,KR-SEL,,10.20.4.12,kr-ops,,central,/,hunter2,y']));
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.encoding, 'utf-8-bom');
  assert.deepEqual(r.columns.sort(), ['collect_via', 'corp', 'idrac_host', 'mounts', 'name', 'os_cred', 'os_host', 'os_key'].sort());
  assert.equal(r.rows.length, 2, '주석 행 제외');
  assert.equal(r.rows[0].cells.os_key, 'kr-ops-ed25519');
  assert.deepEqual(r.rows[1].flags.secretCols, ['비밀번호']);
  assert.equal(JSON.stringify(r).includes('hunter2'), false, '비밀 칸 값은 읽지 않는다');
  assert.ok(r.fileWarnings.some((w) => w.includes('엉뚱한열')));
  const euc = await P.parseOnboardFile(Buffer.from('bcadb9f6b8ed2cb9fdc0ce2c6f735f686f73742c6f735f637265642c6d6f756e74730d0a626d2d6575632c4b52b9fdc0ce2c31302e33302e302e352c6b722d6f70732c2f0d0a', 'hex'));
  assert.equal(euc.ok, true, euc.reason); assert.equal(euc.encoding, 'euc-kr'); assert.equal(euc.rows[0].cells.corp, 'KR법인');
  const big = ['name,corp,os_host']; for (let i = 0; i < 5001; i += 1) big.push(`s${i},KR-SEL,10.1.${Math.floor(i / 250)}.${(i % 250) + 1}`);
  assert.equal((await P.parseOnboardFile(csv(big))).code, 'too-many-rows');
  assert.equal((await P.parseOnboardFile(csv(big.slice(0, 5001)))).ok, true, '5,000행은 받는다');
  assert.equal((await P.parseOnboardFile(Buffer.alloc(P.MAX_UPLOAD_BYTES + 1, 0x41))).code, 'too-large');
  assert.equal((await P.parseOnboardFile(csv(['name,os_host', 'a,1.1.1.1']))).code, 'missing-header');
  assert.equal((await P.parseOnboardFile(csv(['name,corp,os_host,host', 'a,b,1.1.1.1,2.2.2.2']))).code, 'dup-header', 'os_host 와 별칭 host 가 둘 다면 모호');
  assert.equal((await P.parseOnboardFile(Buffer.from('x'), { fileName: 'a.xls' })).code, 'xls');
});

test('② .xlsx — 첫 시트 값만 · 수식은 결과값 · 결과 없는 수식 · 오류 값 · 병합 셀 행은 표지(분석이 거부) · 머리글 병합은 파일 거부 · 리치 텍스트', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('servers');
  ws.addRow(['name', 'corp', 'os_host', 'os_cred', 'mounts', 'note']);
  ws.addRow(['x1', 'KR-SEL', '10.20.4.21', 'kr-ops', '/', 'ok']);
  ws.addRow(['x2', 'KR-SEL', { formula: 'CONCAT("10.20.4.","22")', result: '10.20.4.22' }, 'kr-ops', '/', '']);
  ws.addRow(['x3', 'KR-SEL', { formula: 'A1&"z"' }, 'kr-ops', '/', '']);
  ws.addRow(['x4', 'KR-SEL', '10.20.4.24', 'kr-ops', '/', { error: '#N/A' }]);
  ws.addRow(['x5', 'KR-SEL', '10.20.4.25', 'kr-ops', '/', { richText: [{ text: '굵' }, { text: '게' }] }]);
  ws.addRow(['x6', 'KR-SEL', '10.20.4.26', 'kr-ops', '/', '']);
  ws.addRow(['x7', 'KR-SEL', '10.20.4.27', 'kr-ops', '/', '']);
  ws.mergeCells('B7:B8');
  wb.addWorksheet('second').addRow(['ignored']);
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  const r = await P.parseOnboardFile(buf, { fileName: 's.xlsx' });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.format, 'xlsx');
  const by = Object.fromEntries(r.rows.map((x) => [x.cells.name, x]));
  assert.equal(by.x2.cells.os_host, '10.20.4.22', '수식은 결과값');
  assert.deepEqual(by.x3.flags.noResult, ['os_host']);
  assert.deepEqual(by.x4.flags.cellError, ['note']);
  assert.equal(by.x5.cells.note, '굵게');
  assert.equal(by.x6.flags.merged, true); assert.equal(by.x7.flags.merged, true);
  assert.equal(by.x1.flags.merged, undefined);
  const a = A.analyzeOnboardRows(r.rows, await ctxOf());
  const v = Object.fromEntries(a.rows.map((x) => [x.name, x]));
  assert.equal(v.x2.action, 'new'); assert.equal(v.x3.code, 'no-result'); assert.equal(v.x4.code, 'cell-error'); assert.equal(v.x6.code, 'merged'); assert.equal(v.x7.code, 'merged');
  const wb2 = new ExcelJS.Workbook(); const w2 = wb2.addWorksheet('a'); w2.addRow(['name', 'corp', 'os_host']); w2.mergeCells('A1:B1'); w2.addRow(['a', 'b', 'c']);
  assert.equal((await P.parseOnboardFile(Buffer.from(await wb2.xlsx.writeBuffer()))).code, 'merged-header');
});

test('③ 분석 — 비밀 원문 · 키 내용 행 거부 · 자격 칸 값은 결과에 다시 싣지 않는다 · 결과 CSV 수식 주입 차단', async () => {
  const pemOneLine = ED1.pem.split('\n').slice(1, 3).join('');
  const rows = (await P.parseOnboardFile(csv([HDR,
    'p1,KR-SEL,,,,10.20.4.31,,kr-ops,,central,/,,password=Hunter2',
    `p2,KR-SEL,,,,10.20.4.32,,kr-ops,${pemOneLine},central,/,,`,
    'p3,KR-SEL,,,,10.20.4.33,,Sup3rS3cret!,,central,/,,',
    'p4,KR-SEL,,,,10.20.4.34,,kr-ops,notakey-xyz,central,/,,',
    '=cmd|calc,KR-SEL,,,,10.20.4.35,,kr-ops,,central,/,,@SUM(A1)',
  ]))).rows;
  const a = A.analyzeOnboardRows(rows, await ctxOf());
  const v = a.rows;
  assert.equal(v[0].code, 'secret-cell'); assert.match(v[0].reason, /\(note\)/);
  assert.equal(v[1].code, 'secret-cell'); assert.match(v[1].reason, /\(os_key\)/);
  assert.equal(v[2].code, 'os-cred-missing');
  assert.equal(v[3].code, 'key-missing');
  const all = JSON.stringify(v) + await RUN.resultCsv(v);
  for (const leak of ['Hunter2', 'Sup3rS3cret!', 'notakey-xyz', pemOneLine.slice(0, 30)]) assert.equal(all.includes(leak), false, `값이 다시 나왔다: ${leak}`);
  const out = await RUN.resultCsv(v);
  assert.ok(out.includes("'=cmd|calc"), '수식 주입 차단(= 앞 따옴표)');
  // 비밀 칸 이름에 값이 있는 행 — 값은 읽지 않고 그 행 거부(비어 있으면 다른 행은 그대로)
  const sc = (await P.parseOnboardFile(csv([`${HDR},password`, 'sc1,KR-SEL,,,,10.20.4.41,,kr-ops,,central,/,,,Pw-In-File-9', 'sc2,KR-SEL,,,,10.20.4.42,,kr-ops,,central,/,,,']))).rows;
  const sa = A.analyzeOnboardRows(sc, await ctxOf()).rows;
  assert.equal(sa[0].code, 'secret-col'); assert.equal(sa[1].action, 'new');
  assert.equal(JSON.stringify(sa).includes('Pw-In-File-9'), false);
  assert.equal(/(^|,)=cmd/m.test(out), false);
});

test('④ 분석 — 중복(이름 · 태그 · 주소) · SSRF(저장 규칙) · 법인(이름 · id · 데이터센터) · 범위 404/403 · 미귀속 · 기존 항목의 법인 · 경로 · RTT', async () => {
  BM.saveBmServer({ name: 'old-b', host: '10.40.0.9', username: 'bmon', mounts: ['/'], vcenterId: 'vcB' });
  BM.saveBmServer({ name: 'legacy', host: '10.40.0.8', username: 'root', mounts: ['/'] });
  const rows = (await P.parseOnboardFile(csv([HDR,
    'd1,KR-SEL,,,,10.20.5.1,,kr-ops,,central,/,,',
    'd1,KR-SEL,,,,10.20.5.2,,kr-ops,,central,/,,',
    'd3,vcA,,,,10.20.5.1,,kr-ops,,central,/,,',
    'd4,서울,,,,127.0.0.1,,kr-ops,,central,/,,',
    'd5,서울,,,,169.254.10.1,,kr-ops,,central,/,,',
    'd6,NOPE,,,,10.20.5.6,,kr-ops,,central,/,,',
    'd7,PL-WAW,,,,10.20.5.7,,b-ops,,auto,/,,',
    'd8,US-EAST,,,,10.20.5.8,,개별:mon,kr-ops-ed25519,auto,/,,',
    'old-b,PL-WAW,,,,10.40.0.9,,b-ops,,central,/,,',
    'legacy,KR-SEL,,,,10.40.0.8,,kr-ops,,central,/,,',
    'd11,KR-SEL,,,,10.20.5.11,,b-ops,,central,/,,',
    'd12,미귀속,,,,10.20.5.12,,개별:u,password,central,/,,',
    'd13,KR-SEL,,,,10.20.5.13,,kr-ops,,,,,',
  ]))).rows;
  const full = A.analyzeOnboardRows(rows, await ctxOf());
  const f = Object.fromEntries(full.rows.map((x) => [`${x.line}`, x]));
  assert.equal(f[3].code, 'dup-name'); assert.match(f[3].reason, /2행/);
  assert.equal(f[4].code, 'dup-os');
  assert.equal(f[5].code, 'os-invalid'); assert.match(f[5].reason, /루프백|loopback|127/i);
  assert.equal(f[6].code, 'os-invalid'); assert.match(f[6].reason, /링크|169\.254|link/i);
  assert.equal(f[7].code, 'corp-not-found');
  assert.equal(f[8].via, 'edge'); assert.equal(f[8].agent, 'edge-waw'); assert.ok(f[8].warnings.some((w) => w.code === 'edge-deploy'));
  assert.equal(f[9].code, 'auto-unknown', '엣지가 있는데 접속을 모르면 central 로 정하지 않는다');
  assert.equal(f[10].via, 'central'); assert.ok(f[10].warnings.some((w) => w.code === 'via-moved') === false);
  assert.equal(f[12].code, 'cred-other-corp', '다른 법인의 공통 계정');
  assert.equal(f[13].action, 'new'); assert.ok(f[13].warnings.some((w) => w.code === 'unassigned'));
  assert.ok(f[14].warnings.some((w) => w.code === 'via-default') && f[14].warnings.some((w) => w.code === 'mounts-default'));
  // 범위 계정 — vcA 만 조회 · 쓰기. vcB 는 조회 밖(=없는 법인 문구) · 미귀속 거부 · 귀속 없는 기존 항목 거부
  const sc = A.analyzeOnboardRows(rows, await ctxOf({ view: ['vcA'], write: ['vcA'], full: false }));
  const s = Object.fromEntries(sc.rows.map((x) => [`${x.line}`, x]));
  assert.equal(s[8].code, 'corp-not-found'); assert.equal(s[8].reason, A.ROW_CODE['corp-not-found'], '조회 밖 = 없는 법인과 같은 문구');
  assert.equal(s[13].code, 'unassigned-scoped');
  assert.equal(s[11].code, 'existing-unassigned');
  // 조회는 되지만 쓰기 밖 → 403 꼴
  const ro = A.analyzeOnboardRows(rows, await ctxOf({ view: ['vcA', 'vcB'], write: ['vcA'], full: false }));
  assert.equal(ro.rows.find((x) => x.line === 8).code, 'corp-forbidden');
  // RTT — 중앙 직접 800ms+ 경고(US-EAST 는 central 로 적으면)
  const rr = A.analyzeOnboardRows((await P.parseOnboardFile(csv([HDR, 'r1,US-EAST,,,,10.20.6.1,,개별:mon,kr-ops-ed25519,central,/,,']))).rows, await ctxOf({ edgeOf: () => null }));
  assert.ok(rr.rows[0].warnings.some((w) => w.code === 'rtt-high'), JSON.stringify(rr.rows[0].warnings));
});

test('⑤ 적용 — 한 번 쓰기 · 직전 스냅샷(0600) · 키 참조 · 공통 계정 · iDRAC 계정 복사(봉인) · 중앙 → 엣지 이동은 중앙 항목을 빼고 배포 목록으로', async () => {
  const before = BM.listBmServersRaw().length;
  const lines = [HDR,
    'ap1,KR-SEL,10.20.7.1,kr-idrac-ro,TAGAP1,10.20.8.1,,kr-ops,,central,/;/data,,first',
    'ap2,KR-SEL,,,,10.20.8.2,2222,개별:mon,kr-ops-ed25519,central,/,false,',
    'ap3,PL-WAW,,,,10.20.8.3,,b-ops,b-key,edge,/,,',
    'old-b,PL-WAW,,,,10.40.0.9,,b-ops,,edge,/,,',
  ];
  const ctx = await ctxOf();
  const a = await RUN.analyzeUpload(csv(lines), { ctx });
  assert.equal(a.ok, true, a.reason);
  assert.deepEqual(a.rows.map((r) => r.action), ['new', 'new', 'new', 'update'], JSON.stringify(a.rows.map((r) => [r.code, r.reason])));
  const D = await RUN.defaultOnboardDeps();
  const r = RUN.applyOnboard(a.rows, { D, by: 'adm', fileSha: a.fileSha });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.applied.os, 2); assert.equal(r.applied.idrac, 1); assert.equal(r.applied.edge, 2); assert.equal(r.applied.removed, 1, 'old-b 는 중앙에서 빠진다');
  const osAll = BM.listBmServersRaw();
  assert.equal(osAll.length, before + 2 - 1);
  const ap1 = osAll.find((x) => x.name === 'ap1');
  assert.equal(ap1.credRef, ACC.account.id); assert.equal(ap1.username, 'monitor'); assert.equal(ap1.vcenterId, 'vcA'); assert.deepEqual(ap1.mounts, ['/', '/data']);
  assert.equal(ap1.collectVia, 'central'); assert.equal(ap1.note, 'first');
  const ap2 = osAll.find((x) => x.name === 'ap2');
  assert.equal(ap2.keyRef, KEY.key.id); assert.equal(ap2.username, 'mon'); assert.equal(ap2.port, 2222); assert.equal(ap2.enabled, false);
  assert.equal(osAll.some((x) => x.name === 'old-b'), false);
  const idr = IDR.loadRegistry().find((x) => x.name === 'ap1');
  assert.equal(idr.username, 'ro'); assert.equal(idr.password, 'Idrac-Secret-77'); assert.equal(idr.vcenterId, 'vcA'); assert.equal(idr.serviceTag, 'TAGAP1');
  assert.equal(VAULT.isSealed(JSON.parse(fs.readFileSync(path.join(DIR, 'idrac.json'), 'utf8')).servers.find((x) => x.name === 'ap1').password), true, 'iDRAC 비밀번호 봉인');
  const er = ED.edgeRowsFor('edge-waw');
  assert.deepEqual(er.map((x) => x.name).sort(), ['ap3', 'old-b']);
  assert.equal(er.find((x) => x.name === 'ap3').osKey, 'b-key', '엣지 행은 키 이름만');
  assert.equal(JSON.stringify(er).includes('B-pass-1') || JSON.stringify(er).includes('BEGIN'), false, '엣지 배포 목록에 비밀 없음');
  // 스냅샷 — 적용 직전 바이트 · 0600
  const snapDir = path.join(DIR, 'onboard-prev');
  const snapOs = JSON.parse(fs.readFileSync(path.join(snapDir, 'bm-storage.json'), 'utf8'));
  assert.equal(snapOs.servers.length, before, '스냅샷은 적용 직전 상태');
  if (process.platform !== 'win32') { assert.equal(fs.statSync(snapDir).mode & 0o777, 0o700); assert.equal(fs.statSync(path.join(snapDir, 'bm-storage.json')).mode & 0o777, 0o600); }
  // 다시 같은 파일 → 변화 없음(멱등)
  const again = await RUN.analyzeUpload(csv(lines.slice(0, 3)), { ctx: await ctxOf() });
  assert.deepEqual(again.rows.map((x) => x.action), ['unchanged', 'unchanged'], JSON.stringify(again.rows.map((x) => x.changes)));
  // 엣지 배포 행을 central 로 옮기면 거부(두 곳이 여는 구간 방지)
  const back = await RUN.analyzeUpload(csv([HDR, 'ap3,PL-WAW,,,,10.20.8.3,,b-ops,,central,/,,']), { ctx: await ctxOf() });
  assert.equal(back.rows[0].code, 'edge-to-central');
});

test('⑥ 직렬 큐 · 정책 잠금 · 못 읽은 등록부 — 동시 적용 둘이 서로를 지우지 않는다 · 잠금 · 손상이면 아무것도 쓰지 않는다', async () => {
  const mk = (n, ip) => csv([HDR, `${n},KR-SEL,,,,${ip},,kr-ops,,central,/,,`]);
  const D = await RUN.defaultOnboardDeps();
  const job = (buf) => RUN.serialOnboard(async () => {
    const a = await RUN.analyzeUpload(buf, { ctx: await ctxOf() });
    await new Promise((r) => setTimeout(r, 30));   // 분석과 적용 사이에 다른 요청이 끼어들 틈
    return RUN.applyOnboard(a.rows, { D, by: 'adm' });
  });
  const [r1, r2] = await Promise.all([job(mk('q1', '10.20.9.1')), job(mk('q2', '10.20.9.2'))]);
  assert.ok(r1.ok && r2.ok);
  const names = BM.listBmServersRaw().map((x) => x.name);
  assert.ok(names.includes('q1') && names.includes('q2'), '둘 다 남는다(읽기-수정-쓰기 경쟁 없음)');
  // 같은 파일을 동시에 두 번 — 큐가 없으면 둘 다 '신규' 로 분석해 같은 서버가 두 번 생긴다. 큐가 있으면 두 번째는 '변화 없음'.
  const same = mk('qq', '10.20.9.9');
  const [s1, s2] = await Promise.all([job(same), job(same)]);
  assert.ok(s1.ok && s2.ok);
  assert.equal(BM.listBmServersRaw().filter((x) => x.name === 'qq').length, 1, '같은 서버가 두 번 등록되지 않는다(직렬 큐)');
  assert.equal(s2.nothing, true, '두 번째는 적용할 것이 없다');
  // 정책 잠금 흉내 — loadSecretsPolicy 가 잠금을 돌려주면 쓰지 않는다
  const a = await RUN.analyzeUpload(mk('q3', '10.20.9.3'), { ctx: await ctxOf() });
  const locked = RUN.applyOnboard(a.rows, { D: { ...D, VAULT: { loadSecretsPolicy: () => ({ mode: 'unavailable', locked: true }) } }, by: 'adm' });
  assert.equal(locked.code, 'SECRETS_POLICY_UNAVAILABLE');
  const broken = RUN.applyOnboard(a.rows, { D: { ...D, IDR: { ...D.IDR, registryLoadError: () => ({ reason: 'x' }) } }, by: 'adm' });
  assert.equal(broken.code, 'registry-unreadable');
  assert.equal(BM.listBmServersRaw().some((x) => x.name === 'q3'), false, '잠금 · 손상이면 아무것도 쓰지 않았다');
});

async function server(t) {
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const { store } = await import('../src/store.js');
  store.snapshot = { ...store.get(), vcenters: corps.map((c) => ({ id: c.id, name: c.name })) };
  const USERS = { adm: { username: 'adm', role: 'admin', scope: null }, sa: { username: 'sa', role: 'admin', scope: { vcenters: ['vcA'] } }, op: { username: 'op', role: 'operator', scope: null } };
  const app = express();
  app.use(express.json({ limit: '16mb' }));
  app.use((req, _res, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}/api/tools/bm-usage/onboard`;
  return async (u, method, p, body) => {
    const r = await fetch(`${base}${p}`, { method, headers: { 'x-u': u, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const txt = await r.text(); let j = {}; try { j = JSON.parse(txt); } catch { /* */ }
    return { s: r.status, j, txt };
  };
}

test('⑦ 실제 라우터 — 운영자 403 · 분석 → 적용(서명 같을 때만 · 다르면 409) · 범위 계정은 자기 법인 행만 · 응답에 계획 · 비밀 없음 · 감사', async (t) => {
  const call = await server(t);
  const file = csv([HDR, 'rt1,KR-SEL,,,,10.20.10.1,,kr-ops,,central,/,,', 'rt2,PL-WAW,,,,10.20.10.2,,b-ops,,central,/,,']);
  const body = { fileName: 'x.csv', data: file.toString('base64') };
  assert.equal((await call('op', 'POST', '/analyze', body)).s, 403);
  const an = await call('adm', 'POST', '/analyze', body);
  assert.equal(an.s, 200, an.txt);
  assert.equal(an.txt.includes('"plan"'), false, '적용 계획은 응답에 없다');
  assert.equal(an.txt.includes('B-pass-1') || an.txt.includes('Idrac-Secret-77'), false);
  assert.ok(an.j.resultCsv.startsWith('﻿행,'));
  assert.equal((await call('adm', 'POST', '/apply', { ...body, sig: 'stale' })).s, 409, '사람이 본 판정과 다르면 적용하지 않는다');
  // 범위 계정 — rt2(PL-WAW)는 조회 밖 → 거부, rt1 만 적용
  const sa = await call('sa', 'POST', '/analyze', body);
  assert.equal(sa.s, 200, sa.txt);
  assert.deepEqual(sa.j.rows.map((r) => r.action), ['new', 'reject'], JSON.stringify(sa.j.rows.map((r) => [r.code, r.reason])));
  assert.equal(sa.j.rows[1].code, 'corp-not-found');
  const ap = await call('sa', 'POST', '/apply', { ...body, sig: sa.j.sig });
  assert.equal(ap.s, 200, ap.txt);
  const names = BM.listBmServersRaw().map((x) => x.name);
  assert.ok(names.includes('rt1') && !names.includes('rt2'));
  const audit = fs.readFileSync(path.join(DIR, 'audit.ndjson'), 'utf8');
  assert.ok(audit.includes('bm-usage.onboard.apply'));
  assert.equal(audit.includes('B-pass-1') || audit.includes('Idrac-Secret-77'), false);
  // 엣지 배포 목록 — 범위 계정은 자기 법인 행만 · 남의 법인 행 빼기는 404
  const er = await call('sa', 'GET', '/edge-rows');
  assert.equal(er.s, 200);
  assert.equal(er.j.agents.some((a) => a.rows.some((r) => r.corp === 'vcB')), false);
  assert.equal((await call('sa', 'DELETE', '/edge-rows?agent=edge-waw&name=ap3')).s, 404);
  const del = await call('adm', 'DELETE', '/edge-rows?agent=edge-waw&name=ap3');
  assert.equal(del.s, 200, del.txt);
});

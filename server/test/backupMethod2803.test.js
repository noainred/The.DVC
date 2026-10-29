/**
 * v2.803 — 백업 현황 › Detail '백업 방식'(사용자 요청 "업무 중요도 다음 — Veeam · Clone · Config 백업 · 백업 안함" · 시안 https://claude.ai/artifact/D9BQPJJdZ7XQ5iLr4F525V ·
 *   결정: 사람이 정한 값만 · Clone 칸은 복제 잡 마지막 실행) + 표 열(작업 → Clone · 스냅샷은 Veeam 자리에) + CSV·엑셀 반영.
 *  · 저장소: method 검증(모르는 값 400) · 빈 값 = 지움 · 표시가 모두 비면 지운다 · 일괄에서 method 만 바꿔도 다른 표시는 그대로
 *  · 집계: markCounts.method(방식별 + 미지정) · 서머리 합계(못 읽은 행이 있으면 null)
 *  · 라우트: PUT method · 감사 · Detail 응답의 c(Clone 칸)는 백업 방식 Clone 인 VM 에만 · 잡 저장 즉시 반영(캐시 키 jobsRev) · method-* 보기
 *  · 내보내기: 예전 CSV 의 새 열 · 백업 내보내기 창 bmethod·bclone · 엑셀 폴더 트리 시트 '백업 방식'·'Clone' 열(+ sheetPr 순서)
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'backup2803-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
delete process.env.CENTRAL_URL;
const VC = 'apac:vc01';
const OUT = 'us:vc04';
fs.writeFileSync(path.join(DIR, 'vcenters.json'), JSON.stringify({ vcenters: [VC, OUT].map((id) => ({ id, name: id, host: `${id.split(':')[1]}.corp.local`, username: 'u', password: 'p' })) }));
const closers = [];
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch { /* */ } } try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });

const BM = await import('../src/veeam/backupMarks.js');
const BS = await import('../src/veeam/backupStatus.js');
const CAT = await import('../src/veeam/vmListCatalog.js');
const XS = await import('../src/vcenter/vmXlsxStyle.js');
const XL = await import('../src/veeam/vmListXlsx.js');
const CS = await import('../src/vmclone/store.js');
const ExcelJS = (await import('exceljs')).default;
const JSZip = (await import('jszip')).default;
const U = { username: 'op1' };
const H = 3_600_000;
const NOW = Math.floor(Date.now() / H) * H;

test('A 저장소 — method 검증 · 지움 · 다른 표시 유지 · 모두 비면 지운다 · 집계(방식별 + 미지정)', () => {
  BM._resetMarksForTest();
  const vms = [{ id: 'x:1', name: 'a', vcenterId: 'x' }, { id: 'x:2', name: 'b', vcenterId: 'x' }];
  assert.equal(BM.setMarks(vms, { method: 'tape' }, U).status, 400, '모르는 백업 방식');
  assert.equal(BM.setMarks(vms, { method: 'clone', crit: 'high' }, U).ok, true);
  BM.setMarks([vms[0]], { method: 'veeam' }, U);
  assert.deepEqual([BM.getMarks()['x:1'].method, BM.getMarks()['x:1'].crit], ['veeam', 'high'], 'method 만 바꿔도 중요도는 그대로');
  assert.equal(BM.markView(BM.getMarks()['x:2']).method, 'clone');
  BM.setMarks([vms[1]], { method: '', crit: '' }, U);
  assert.equal(BM.getMarks()['x:2'], undefined, '모두 비면 지운다');
  BM.setMarks([vms[1]], { method: 'none' }, U);
  assert.ok(BM.getMarks()['x:2'], 'method 하나만 있어도 남는다');
  const c = BM.markCounts([...vms, { id: 'x:3' }], BM.getMarks(), {}, { veeamKnown: true });
  assert.deepEqual(c.method, { veeam: 1, clone: 0, config: 0, none: 1, check: 0, unset: 1 });
  assert.equal(BM.markView({ crit: 'low', method: 'bogus' }).method, '', '파일의 모르는 값은 미지정');
  // 서머리 합계 — 못 읽은 행이 있으면 null(부분 합 금지)
  const t = BS.backupTotals([{ vm: 1, marks: { high: 0, mid: 0, low: 0, need: 0, needGap: 0, method: { veeam: 1, clone: 0, config: 0, none: 0, check: 0, unset: 0 } } }, { vm: 1, marks: null }]);
  assert.equal(t.marks.method, null);
  assert.deepEqual(BS.backupTotals([{ vm: 2, marks: { method: { veeam: 1, clone: 1, config: 0, none: 0, check: 0, unset: 0 } } }]).marks.method, { veeam: 1, clone: 1, config: 0, none: 0, check: 0, unset: 0 });
});

test('B 라우트 — PUT method · Detail c 는 Clone VM 에만 · 잡 저장 즉시 반영 · method 보기 · CSV · 내보내기 창 · 엑셀', async () => {
  BM._resetMarksForTest(); try { fs.rmSync(path.join(DIR, 'backup-marks.json')); } catch { /* */ }
  const express = (await import('express')).default;
  const { store } = await import('../src/store.js');
  const { registerBackupStatus, registerVeeamBadges } = await import('../src/routes/api/veeam.js');
  const { listAudit } = await import('../src/audit.js');
  const prev = store.snapshot;
  store.snapshot = { source: 'live', generatedAt: NOW, vcenters: [VC, OUT].map((id) => ({ id, name: id })), hosts: [], vms: [
    { id: `${VC}:vm-1`, vcenterId: VC, name: 'web01', folder: 'DC/vm/A', powerState: 'POWERED_ON', storageGB: 120.25 },
    { id: `${VC}:vm-2`, vcenterId: VC, name: 'db01', folder: 'DC/vm/A', powerState: 'POWERED_ON', storageGB: '' },
    { id: `${VC}:vm-3`, vcenterId: VC, name: 'cfg01', folder: 'DC/vm/B', powerState: 'POWERED_ON' },
    { id: `${OUT}:vm-1`, vcenterId: OUT, name: 'o1', powerState: 'POWERED_ON' },
  ] };
  let user = { username: 'op1', role: 'operator', scope: { vcenters: [VC] } };
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  const api = express.Router(); registerBackupStatus(api); registerVeeamBadges(api); app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  closers.push(() => new Promise((r) => srv.close(() => r())));
  const base = `http://127.0.0.1:${srv.address().port}/api`;
  const put = (body) => fetch(`${base}/tools/backup-detail/marks`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const detail = async () => (await fetch(`${base}/tools/backup-detail?vcenterId=${encodeURIComponent(VC)}`)).json();
  try {
    assert.equal((await detail()).vms.some((v) => 'c' in v), false, '처음에는 Clone 칸 자료가 없다');
    assert.equal((await put({ vcenterId: VC, vmIds: [`${VC}:vm-1`], method: 'tape' })).status, 400);
    assert.equal((await put({ vcenterId: OUT, vmIds: [`${OUT}:vm-1`], method: 'veeam' })).status, 404, '범위 밖');
    let r = await put({ vcenterId: VC, vmIds: [`${VC}:vm-1`, `${VC}:vm-2`], method: 'clone' });
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal((await put({ vcenterId: VC, vmIds: [`${VC}:vm-3`], method: 'config' })).status, 200);
    let d = await detail();
    const by = (n) => d.vms.find((v) => v.name === n);
    assert.deepEqual([by('web01').m.method, by('cfg01').m.method], ['clone', 'config']);
    assert.deepEqual([by('web01').gb, by('db01').gb, by('cfg01').gb], [120.3, null, null], 'v2.814 디스크 용량 — 빈 값·없음은 null(0 이 아니다)');
    assert.deepEqual([by('web01').c, 'c' in by('cfg01')], [{ job: false }, false], 'Clone 이면 잡 없음 · Clone 이 아니면 c 키 없음');
    // 복제 잡을 만들고 실행 기록을 남기면 캐시가 낡지 않고 바로 보인다(jobsRev)
    const job = CS.saveJob({ vcenterId: VC, vmId: `${VC}:vm-1`, vmName: 'web01', dest: { type: 'datastore', datastoreName: 'DS1' }, schedule: { mode: 'manual' } });
    d = await detail();
    assert.deepEqual(by('web01').c, { job: true, on: true, at: null, ok: null }, '아직 실행 안 함');
    CS.recordRun(job.id, { ok: false, detail: 'x', ms: 1 });
    d = await detail();
    assert.equal(by('web01').c.ok, false);
    assert.ok(Number.isFinite(by('web01').c.at));
    assert.equal(JSON.stringify(by('web01').c).includes('DS1'), false, '대상 경로·잡 이름 원문은 싣지 않는다');
    // 서머리 수 · 보기 필터
    const sum = await (await fetch(`${base}/tools/backup-summary`)).json();
    assert.deepEqual(sum.rows.find((x) => x.id === VC).marks.method, { veeam: 0, clone: 2, config: 1, none: 0, check: 0, unset: 0 });
    // v2.806 우선순위 VM — Clone 방식 VM 은 복제 잡 상태로(web01 마지막 실패 · db01 잡 없음 → cloneBad) · 방식이 실린다
    const pr = Object.fromEntries((sum.priority?.items || []).map((x) => [x.name, x]));
    assert.deepEqual([pr.web01?.method, pr.web01?.cloneBad, pr.db01?.cloneBad, pr.web01?.gap], ['clone', true, true, false], JSON.stringify(sum.priority));
    for (const [f, want] of [['method-clone', ['web01', 'db01']], ['method-config', ['cfg01']], ['method-unset', []]]) {
      assert.deepEqual(d.vms.filter((v) => BS.vmViewMatches(v, f)).map((v) => v.name).sort(), [...want].sort(), f);
    }
    // 감사
    const au = listAudit({ limit: 20 });
    const rows = (Array.isArray(au) ? au : au.rows || au.items || []).filter((x) => x.action === 'backup-marks');
    assert.ok(rows.some((x) => /2대 · 백업 방식=clone/.test(x.detail)), JSON.stringify(rows.map((x) => x.detail)));
    // viewer · 데모 거부
    user = { username: 'v', role: 'viewer', permissions: ['tools'] };
    assert.equal((await put({ vcenterId: VC, vmIds: [`${VC}:vm-3`], method: 'none' })).status, 403);
    user = { username: 'demo', role: 'operator', demoGuest: true };
    assert.equal((await put({ vcenterId: VC, vmIds: [`${VC}:vm-3`], method: 'none' })).status, 403);
    assert.equal(BM.getMarks()[`${VC}:vm-3`].method, 'config');

    // 예전 CSV — '작업' 열은 그대로 · 새 세 열은 '중요도' 앞
    user = { username: 'adm', role: 'admin' };
    store.snapshot = { ...store.snapshot, generatedAt: NOW + 1 };
    const csv = (await (await fetch(`${base}/tools/backup-detail.csv?vcenterId=${encodeURIComponent(VC)}`)).text()).replace(/^\uFEFF/, '').split('\r\n');
    assert.match(csv[0], /,작업,.*,백업 방식,Clone 마지막 실행\(UTC\),Clone 결과,중요도,백업 필요,메모$/);
    const web = csv.find((l) => l.includes(',web01,'));
    assert.match(web, /,Clone,\d{4}-\d\d-\d\dT[^,]+,실패,,,$/);
    assert.match(csv.find((l) => l.includes(',db01,')), /,Clone,,잡 없음,,,$/);
    assert.match(csv.find((l) => l.includes(',cfg01,')), /,Config 백업,,,,,$/);

    // 백업 내보내기 창 — bmethod · bclone
    const post = (p, body) => fetch(`${base}${p}?vcenterId=${encodeURIComponent(VC)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const sel = (await (await post('/veeam/vm-list.csv', { cols: ['name', 'bmethod', 'bclone'] })).text()).replace(/^\uFEFF/, '').split('\r\n');
    assert.match(sel[0], /^VM,백업 방식\(Veeam·Clone·Config 백업·백업 안함·확인 필요\),Clone 마지막 실행 /);
    assert.match(sel.find((l) => l.startsWith('web01,')), /^web01,Clone,\d{4}-\d\d-\d\d \d\d:\d\d 실패$/);
    assert.equal(sel.find((l) => l.startsWith('cfg01,')), 'cfg01,Config 백업,');
    assert.deepEqual([...CAT.needsOf(['bclone'])].sort(), ['clone', 'marks']);

    // 엑셀 폴더 트리 시트 — '백업 방식'(4) · 'Clone'(6) · 폴더 행 Clone 수 · sheetPr 순서
    const xr = await post('/veeam/vm-list.xlsx', {});
    assert.equal(xr.status, 200);
    const buf = Buffer.from(await xr.arrayBuffer());
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf);
    const ts = wb.getWorksheet('VM 목록(폴더 트리)');
    assert.deepEqual([ts.getRow(3).getCell(4).value, ts.getRow(3).getCell(6).value], ['백업 방식', 'Clone']);
    const rowOf = (n) => { let hit = null; ts.eachRow((row) => { if (row.getCell(1).value === n) hit = row; }); return hit; };
    assert.equal(rowOf('web01').getCell(4).value, 'Clone');
    assert.match(String(rowOf('web01').getCell(6).value), /^\d{4}-\d\d-\d\d \d\d:\d\d 실패$/);
    assert.ok(!rowOf('cfg01').getCell(6).value, 'Clone 이 아닌 VM 은 빈칸');
    const txt = (v) => (v && typeof v === 'object' && v.richText ? v.richText.map((x) => x.text).join('') : String(v ?? ''));   // 폴더 이름은 서식 글자(folderLabel)
    // v2.807: 폴더 행 4~6 병합 = 백업 방식 합계(하위 포함 · 0 생략 · 방식 색) · 2~3 = 백업 판단 합계 · VM 칸은 방식 색
    let folderRow = null; ts.eachRow((row) => { if (/^📁 A {2}/.test(txt(row.getCell(1).value))) folderRow = row; });
    assert.equal(txt(folderRow.getCell(4).value), 'Clone 2');
    assert.equal(folderRow.getCell(4).value.richText[0].font.color.argb, XS.METHOD_LOOK.clone.fg);
    assert.ok(ts.model.merges.includes(`D${folderRow.number}:F${folderRow.number}`) && ts.model.merges.includes(`B${folderRow.number}:C${folderRow.number}`), ts.model.merges.join(','));
    let rootRow = null; ts.eachRow((row) => { if (!rootRow && /\/ vm {2}/.test(txt(row.getCell(1).value))) rootRow = row; });
    assert.equal(txt(rootRow.getCell(4).value), 'Clone 2 · Config 백업 1', '맨 위 vCenter 행이 전체 합계');
    assert.deepEqual([rowOf('web01').getCell(4).fill.fgColor.argb, rowOf('web01').getCell(4).font.color.argb], [XS.METHOD_LOOK.clone.bg, XS.METHOD_LOOK.clone.fg]);
    assert.equal(rowOf('cfg01').getCell(4).fill.fgColor.argb, XS.METHOD_LOOK.config.bg);
    const zip = await JSZip.loadAsync(buf);
    for (const n of Object.keys(zip.files).filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f))) {
      const m = /<sheetPr\b[^>]*>([\s\S]*?)<\/sheetPr>/.exec(await zip.file(n).async('string'));
      const kids = m ? [...m[1].matchAll(/<([A-Za-z]+)\b/g)].map((k) => k[1]) : [];
      assert.ok(!(kids.includes('outlinePr') && kids.includes('pageSetUpPr') && kids.indexOf('pageSetUpPr') < kids.indexOf('outlinePr')), `${n} ${kids}`);
    }
    const sumWs = wb.getWorksheet('요약');
    let line = ''; sumWs.eachRow((row) => { if (row.getCell(1).value === '백업 방식') line = txt(row.getCell(2).value); });
    assert.equal(line, 'Veeam 0 · Clone 2 · Config 백업 1 · 백업 안함 0 · 확인 필요 0 · 미지정 0');
  } finally { store.snapshot = prev; }
});

test('C 소스 — PUT 키 목록에 method · Detail 캐시 키에 복제 잡 리비전 · Clone 칸은 실행 노드 기준(vmclone/jobState)', () => {
  const src = fs.readFileSync(new URL('../src/routes/api/veeam.js', import.meta.url), 'utf8');
  assert.match(src, /for \(const k of \['crit', 'method', 'need', 'memo'\]\)/);
  assert.match(src, /\|c\$\{jobsRev\(\)\}/);
  const js = fs.readFileSync(new URL('../src/vmclone/jobState.js', import.meta.url), 'utf8');
  assert.match(js, /edgeStateOf\(tg\.agent\)/, '엣지에 위임한 vCenter 는 엣지 보고');
});

test('D v2.804 먼저 볼 VM — 백업 안함·Clone 성공은 뺀다 · 그 밖의 방식은 이유 앞에 · 표시를 못 읽으면 그대로 · 잔존은 방식과 무관', async () => {
  const X = await import('../src/veeam/vmListXlsx.js');
  const mk = (name, extra = {}) => ({ inv: { name, snapshotCount: 0 }, view: { id: name, name, folder: 'DC/vm/A', power: 'POWERED_ON', v: null, s: { ev: null, now: extra.now || null }, ...extra.view },
    verdict: { code: 'none' }, stale: !!extra.now?.stale });
  const ok = { job: true, on: true, at: NOW - H, ok: true };
  const items = [
    mk('plain'),
    mk('none', { view: { m: { method: 'none' } } }),
    mk('cloneOk', { view: { m: { method: 'clone' }, c: ok } }),
    mk('cloneFail', { view: { m: { method: 'clone' }, c: { ...ok, ok: false } } }),
    mk('cloneNoJob', { view: { m: { method: 'clone' }, c: { job: false } } }),
    mk('cloneSkip', { view: { m: { method: 'clone' }, c: { ...ok, skipped: 'restart-interrupted' } } }),
    mk('config', { view: { m: { method: 'config' } } }),
    mk('veeam', { view: { m: { method: 'veeam' } } }),
    mk('staleNone', { view: { m: { method: 'none' } }, now: { n: 1, ts: NOW - 50 * H, stale: true } }),
  ];
  const w = X.watchList(items, { snapDays: 7, at: NOW });
  const by = Object.fromEntries(w.map((x) => [x.it.view.name, x]));
  assert.deepEqual(Object.keys(by).sort(), ['cloneFail', 'cloneNoJob', 'cloneSkip', 'config', 'plain', 'staleNone', 'veeam'].sort());
  assert.match(by.cloneFail.why, /^백업 방식 Clone · 실패 — /);
  assert.match(by.cloneNoJob.why, /^백업 방식 Clone · 잡 없음 — /);
  assert.match(by.cloneSkip.why, /^백업 방식 Clone · 건너뜀·중단 — /, '건너뛴 실행은 성공이 아니다');
  assert.match(by.config.why, /^백업 방식 Config 백업\(포탈이 확인할 수 없음\) — /);
  assert.match(by.veeam.why, /^백업 방식 Veeam 으로 정함 — /);
  assert.equal(by.plain.why.startsWith('백업 방식'), false);
  assert.equal(by.staleNone.tag, '잔존 스냅샷', '잔존은 백업 안함이어도 남는다');
  // 표시 파일을 못 읽었으면 방식으로 줄이지 않는다
  const u = X.watchList(items, { snapDays: 7, at: NOW, marksUnknown: true });
  assert.equal(u.length, items.length);
  assert.equal(u.some((x) => x.why.startsWith('백업 방식')), false);
});

test('E v2.806 우선순위 VM — 백업 안함은 미백업 아님 · Clone 은 복제 잡 상태 · Config 는 gap 유지 · 모름은 cloneBad 아님 · 서머리 캐시 키에 복제 잡 리비전', () => {
  const vms = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, name: id }));
  const marks = { a: { crit: 'high' }, b: { crit: 'high', method: 'none' }, c: { need: true, method: 'clone' }, d: { need: true, method: 'config' }, e: { method: 'clone' } };
  const cl = { c: { job: true, on: true, at: NOW, ok: true }, e: { job: true, on: true, unknown: true } };
  const by = Object.fromEntries(BS.priorityCandidates(vms, { byVm: {}, marks, veeamKnown: true, now: NOW, cloneOf: (id) => cl[id] }).map((x) => [x.id, x]));
  assert.deepEqual(Object.keys(by).sort(), ['a', 'd']);
  assert.deepEqual([by.a.gap, by.d.gap, by.d.method], [true, true, 'config']);
  // 상단 '백업 필요·미백업' 수 · 보기 필터도 같은 규칙(우선순위 표와 수가 어긋나지 않게 — v2.806 Sonnet 검증에서 2 대 1 로 발견)
  const nm = { a: { need: true }, b: { need: true, method: 'none' }, c: { need: true, method: 'clone' }, d: { need: true, method: 'config' } };
  assert.equal(BM.markCounts(vms.slice(0, 4), nm, {}, { veeamKnown: true }).needGap, 2, 'a · d 만');
  const views = ['a', 'b', 'c', 'd'].map((id) => ({ id, v: null, s: { ev: null }, m: BM.markView(nm[id]) }));
  assert.deepEqual(views.filter((v) => BS.vmViewMatches(v, 'needgap')).map((v) => v.id), ['a', 'd']);
  const src = fs.readFileSync(new URL('../src/routes/api/veeam.js', import.meta.url), 'utf8');
  assert.equal((src.match(/\|c\$\{jobsRev\(\)\}/g) || []).length, 2, '서머리·세부 둘 다');
});

test('F v2.807 엑셀 백업 방식 — 색 표는 방식 키와 같다 · 데이터 시트 칸 색 · 합계 글자(0 생략 · 미지정 · 모름)', () => {
  assert.deepEqual(Object.keys(XS.METHOD_LOOK).sort(), Object.keys(BS.METHOD_TEXT).sort(), '방식이 늘면 색도');
  assert.equal(XS.kindOf('bmethod'), 'method');
  for (const [k, t] of Object.entries(BS.METHOD_TEXT)) {
    const look = XS.cellLook(t, 'method', true);
    assert.deepEqual([look.fill.fgColor.argb, look.font.color.argb], [XS.METHOD_LOOK[k].bg, XS.METHOD_LOOK[k].fg], t);
  }
  assert.equal(XS.cellLook('', 'method', false), null, '미지정 빈칸은 색 없음');
  const txt = (v) => (v && typeof v === 'object' && v.richText ? v.richText.map((x) => x.text).join('') : String(v ?? ''));
  const a = { method: { veeam: 1200, clone: 3, config: 0, none: 40, check: 0, unset: 0 } };
  assert.equal(txt(XL.methodCountsRich(a, false)), 'Veeam 1,200 · Clone 3 · 백업 안함 40');
  assert.equal(txt(XL.methodCountsRich({ method: { veeam: 0, clone: 0, config: 0, none: 0, check: 0, unset: 5 } }, false)), '미지정 5');
  assert.equal(txt(XL.methodCountsRich(a, false, { full: true })), 'Veeam 1,200 · Clone 3 · Config 백업 0 · 백업 안함 40 · 확인 필요 0 · 미지정 0');
  assert.equal(XL.methodCountsRich(a, true), '모름', '표시 파일을 못 읽으면 0 으로 쓰지 않는다');
});

test('G v2.814 gbOf — 0 이상 유한수만 · 소수 1자리 · 그 밖은 null(못 읽은 값은 0 이 아니다)', () => {
  assert.deepEqual([null, undefined, '', ' ', 'abc', -1, NaN, Infinity].map(BS.gbOf), [null, null, null, null, null, null, null, null]);
  assert.deepEqual([0, 12.34, '40', 1024.05].map(BS.gbOf), [0, 12.3, 40, 1024.1]);
  const v = BS.vmBackupView({ id: 'x', name: 'x', storageGB: 55 }, null, null, {});
  assert.equal(v.gb, 55);
  assert.equal(BS.vmBackupView({ id: 'y', name: 'y' }, null, null, {}).gb, null);
});

// 154회차 Z3 의 남은 호출부(메인): 베어메탈 서버 등록 가져오기(bmusage/onboard/importParse.js)도 exceljs 로 .xlsx 를 읽는다.
//   154 가 공용 사전 점검에 유효성 검사 넓이 상한을 넣으면서, 이 가져오기는 **전체 열 드롭다운이 둘 이상 든 정상 양식 파일을 거부**하게 됐다(동작 회귀).
//   유효성 검사는 이 가져오기가 읽지 않는다 → exceljs 에 ignoreNodes(범위를 칸마다 전개하지 않음) + 점검 'ignored'.
//   ① 전체 열 드롭다운 둘 = 정상 파일로 읽힌다 ② 전체 시트 범위(6KB 폭탄)도 빨리 끝난다(자식 프로세스 · 힙 256MB · 시한) ③ 병합 폭탄은 여전히 거부.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import JSZip from 'jszip';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOD = path.join(HERE, '..', 'src', 'bmusage', 'onboard', 'importParse.js');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mainfull154-'));
test.after(() => { try { fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 5 }); } catch { /* 정리 실패는 시험 결과가 아니다 */ } });

async function xlsxWith(afterSheetData) {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('s');
  ws.addRow(['name', 'corp', 'os_host']);
  ws.addRow(['srv-01', 'vc-kr', '10.0.0.1']);
  const zip = await JSZip.loadAsync(Buffer.from(await wb.xlsx.writeBuffer()));
  const f = Object.keys(zip.files).find((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  zip.file(f, (await zip.file(f).async('string')).replace('</sheetData>', `</sheetData>${afterSheetData}`));
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}
const dv = (...refs) => `<dataValidations count="${refs.length}">${refs.map((r) => `<dataValidation type="list" allowBlank="1" sqref="${r}"><formula1>"a,b"</formula1></dataValidation>`).join('')}</dataValidations>`;

function parseInChild(buf, { timeoutMs = 30_000 } = {}) {
  const file = path.join(DIR, `c-${Math.random().toString(16).slice(2)}.xlsx`);
  fs.writeFileSync(file, buf);
  const script = `
    import fs from 'node:fs';
    const { parseOnboardFile } = await import(${JSON.stringify(pathToFileURL(MOD).href)});
    const t0 = Date.now();
    try { const r = await parseOnboardFile(fs.readFileSync(${JSON.stringify(file)}), { fileName: 'a.xlsx' }); console.log('OK ' + JSON.stringify({ ok: r?.ok, code: r?.code || '', reason: String(r?.reason || '').slice(0, 120), rows: Array.isArray(r?.rows) ? r.rows.length : null, ms: Date.now() - t0 })); }
    catch (e) { console.log('THREW ' + e.message); }
  `;
  const r = spawnSync(process.execPath, ['--max-old-space-size=256', '--input-type=module', '-e', script], { timeout: timeoutMs, encoding: 'utf8' });
  return { signal: r.signal, status: r.status, out: String(r.stdout || '').trim(), err: String(r.stderr || '').slice(-300) };
}

test('154 Z3(메인) — 서버 등록 가져오기: 전체 열 드롭다운이 둘 든 정상 양식 파일을 거부하지 않는다', async () => {
  const r = parseInChild(await xlsxWith(dv('A1:A1048576', 'B1:B1048576')));
  assert.equal(r.signal, null, `시한 · 중단 없이 끝나야 한다: ${r.err}`);
  assert.match(r.out, /^OK /, `정상 파일로 읽혀야 한다: ${r.out}`);
  const res = JSON.parse(r.out.slice(3));
  assert.equal(res.ok, true, `거부하면 안 된다: ${r.out}`);
  assert.equal(res.rows, 1);
});

test('154 Z3(메인) — 서버 등록 가져오기: 전체 시트 유효성 범위도 칸마다 전개하지 않는다(힙 256MB · 30초 안)', async () => {
  const r = parseInChild(await xlsxWith(dv('A1:XFD1048576')));
  assert.equal(r.signal, null, `중단(OOM · 시한)되면 안 된다: ${r.err}`);
  assert.equal(r.status, 0);
  assert.match(r.out, /^OK /, r.out);
  const res = JSON.parse(r.out.slice(3));
  assert.equal(res.ok, true, `읽지 않는 노드라 거부할 이유가 없다: ${r.out}`);
  assert.ok(res.ms < 15_000, `전개하지 않으면 금방 끝난다: ${r.out}`);
});

test('154 Z3(메인) — 병합 폭탄은 여전히 사전 점검이 거부한다(ignored 는 유효성 검사만)', async () => {
  const r = parseInChild(await xlsxWith('<mergeCells count="1"><mergeCell ref="A1:XFD1048576"/></mergeCells>'));
  assert.equal(r.signal, null);
  const res = JSON.parse(r.out.replace(/^OK /, ''));
  assert.equal(res.ok, false, r.out);
  assert.match(res.reason, /병합 셀/, r.out);
});

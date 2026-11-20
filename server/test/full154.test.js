/**
 * 전체 점검 154회차 — 3축(중앙 ↔ 엣지 · 업그레이드 · 포탈 백업/복원 · 감시 도구) 회귀 고정.
 *
 *  U1(낮음) upgrade/archive.js parseTar — GNU 긴 이름 칸(typeflag L · K)의 끝 NUL 을 `/\0+$/` 로 뗐다. 끝이 NUL 이 아닌 NUL 연속에서 O(n²)이고
 *           칸 길이 상한이 없었다(NUL 8만 개 + 글자 하나 = gzip 216B 에 2.2초 실측 — 100만 개면 수 분 동안 이벤트 루프 정지).
 *           → 칸 길이 상한(LONG_NAME_MAX_BYTES = 4096) + 끝 NUL 선형 제거. 루트 CLAUDE.md ‘끝 앵커 무제한 반복 금지’(11회차 B-32 가 bareos/console.js 만 고친 같은 꼴).
 *  U2(낮음) upgrade/archive.js parseTar — 머리말 크기 칸이 음수(8진 `-1000`)면 offset 이 뒤로 가 같은 블록을 끝없이 다시 읽었다
 *           (디렉터리 블록이면 account() 도 불리지 않아 상한에 걸리지 않는다 — 512B tar 하나로 무한 루프 · 재현: 5초 시한 초과).
 *           → 음수 크기는 손상으로 보고 던진다. 무한 루프라 **자식 프로세스 + 시한**으로 고정한다(수정 전 판본이면 시한 초과로 실패 — 시험 러너가 멈추지 않게).
 *  R1(낮음) relaycheck/poller.js runRelayChecks — 수집 서버 등록부를 못 읽은 주기(loadCollectors 가 [])에 '대상에서 빠진 항목 정리' 가 상태를 전부 지웠다
 *           (연속 실패 수 · 알림 보냄 여부 · 마지막 정상 시각 — 다시 읽힌 뒤 이미 알린 장애를 다시 알리고 복구 알림은 나가지 않는다 · 화면 ‘대상 0’).
 *           → 못 읽은 주기에는 정리하지 않고 `last.sourcesUnread`(고정 낱말)만 남긴다. 읽힌 주기의 정리는 그대로.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { stripComments } from './_stripComments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARCHIVE = path.join(HERE, '..', 'src', 'upgrade', 'archive.js');
const reqHere = createRequire(import.meta.url);
const JSZip = createRequire(reqHere.resolve('exceljs'))('jszip');   // exceljs 가 실제로 쓰는 그 JSZip(audit2741k 와 같은 방식)

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'full154-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
delete process.env.CENTRAL_URL;
delete process.env.SSRF_ALLOW_LOOPBACK;

/* ── tar 블록 만들기(체크섬은 파서가 보지 않는다) ─────────────────────────── */
function hdr(name, sizeField, type) {
  const b = Buffer.alloc(512);
  b.write(name, 0, 'utf8');
  b.write('0000644\0', 100);
  b.write(sizeField, 124, 'latin1');
  b[156] = type.charCodeAt(0);
  b.write('ustar\0' + '00', 257, 'latin1');
  return b;
}
const oct = (n) => `${n.toString(8).padStart(11, '0')}\0`;
const padTo512 = (n) => Buffer.alloc((512 - (n % 512)) % 512);
function tarWithLongName(nameBytes, body = Buffer.from('{}')) {
  return Buffer.concat([hdr('././@LongLink', oct(nameBytes.length), 'L'), nameBytes, padTo512(nameBytes.length),
    hdr('short', oct(body.length), '0'), body, padTo512(body.length), Buffer.alloc(1024)]);
}

test('154 U1 — GNU 긴 이름 칸: 상한을 넘으면 던지고 · 끝 NUL 은 선형으로 떼며 · 정상 긴 이름은 그대로 읽는다', async () => {
  const { parseTar, parseTarGz, LONG_NAME_MAX_BYTES } = await import('../src/upgrade/archive.js');
  assert.equal(LONG_NAME_MAX_BYTES, 4096, '긴 이름 칸 상한 = PATH_MAX');

  // ① 정상: 150자 경로 + NUL 종결(GNU tar 가 쓰는 모양) → 이름이 그대로 · 끝 NUL 없음
  const long = `vmware-portal/${'d'.repeat(120)}/package.json`;
  const ok = parseTar(tarWithLongName(Buffer.concat([Buffer.from(long), Buffer.alloc(1)])));
  assert.equal(ok.length, 1);
  assert.equal(ok[0].name, long, '긴 이름 + 끝 NUL 제거');
  assert.equal(ok[0].data.toString(), '{}');

  // ② 끝 NUL 여러 개도 뗀다 · 가운데 NUL 은 건드리지 않는다(예전 정규식과 같은 뜻)
  const mid = parseTar(tarWithLongName(Buffer.concat([Buffer.from('a'), Buffer.alloc(3), Buffer.from('b'), Buffer.alloc(7)])));
  assert.equal(mid[0].name, 'a\0\0\0b');

  // ③ 상한 바로 아래의 최악 꼴(NUL 연속 + 글자 하나)은 받되 금방 끝난다 · 상한을 넘으면 던진다(예전: 8만 바이트에 2.2초 · 길이 상한 없음)
  const worst = Buffer.alloc(LONG_NAME_MAX_BYTES, 0); worst[worst.length - 1] = 0x61;
  assert.equal(parseTar(tarWithLongName(worst)).length, 1);
  const over = Buffer.alloc(80_000, 0); over[over.length - 1] = 0x61;
  const gz = zlib.gzipSync(tarWithLongName(over));
  assert.ok(gz.length < 1024, `재현 입력은 1KB 미만 tgz(${gz.length}B)`);
  const t0 = process.hrtime.bigint();
  assert.throws(() => parseTarGz(gz), /긴 이름 칸이 너무 깁니다/);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 500, `상한 초과는 훑지 않고 바로 던진다(${ms.toFixed(1)}ms — 수정 전 약 2,200ms)`);
  // 링크 이름 칸(K)도 같은 함수
  const k = Buffer.concat([hdr('././@LongLink', oct(over.length), 'K'), over, padTo512(over.length), Buffer.alloc(1024)]);
  assert.throws(() => parseTar(k), /긴 이름 칸이 너무 깁니다/);

  // ④ 소스: 끝 앵커 NUL 무제한 반복이 코드에 없다(주석 제외)
  const src = stripComments(fs.readFileSync(ARCHIVE, 'utf8'));
  assert.ok(!/\\0\+\$/.test(src), 'archive.js 에 /\\0+$/ 가 남아 있다');
});

test('154 U2 — tar 머리말의 음수 크기는 손상으로 던진다(무한 루프 금지 — 자식 프로세스 · 시한 5초)', () => {
  const script = `
    const { parseTar } = await import(${JSON.stringify(pathToFileURL(ARCHIVE).href)});
    const b = Buffer.alloc(512);
    b.write('pkg/', 0, 'utf8'); b.write('0000755\\0', 100, 'latin1'); b.write('-1000\\0', 124, 'latin1'); b[156] = 0x35;
    try { parseTar(Buffer.concat([b, Buffer.alloc(1024)])); console.log('RETURNED'); }
    catch (e) { console.log('THREW ' + e.message); }
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 5_000, encoding: 'utf8' });
  assert.equal(r.signal, null, `시한 안에 끝나야 한다(수정 전: 무한 루프 → 시한 초과 ${r.signal})`);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /THREW .*크기 칸이 음수/);
});

test('154 U2 — 크기 0 · 양수 머리말은 예전 그대로(디렉터리 건너뜀 · 파일 읽음)', async () => {
  const { parseTar } = await import('../src/upgrade/archive.js');
  const body = Buffer.from('hello');
  const buf = Buffer.concat([hdr('pkg/', oct(0), '5'), hdr('pkg/a.txt', oct(body.length), '0'), body, padTo512(body.length), Buffer.alloc(1024)]);
  const e = parseTar(buf);
  assert.deepEqual(e.map((x) => [x.name, x.data.toString()]), [['pkg/a.txt', 'hello']]);
});

test('154 R1 — 수집 서버 등록부를 못 읽은 주기에는 중계 점검 상태를 지우지 않는다(읽힌 주기의 정리는 그대로)', async () => {
  const COL = path.join(DIR, 'collectors.json');
  const col = (id, host) => ({ id, name: id, url: `https://${host}:4000`, token: `tok-${id}`, enabled: true });
  const writeCols = (list) => fs.writeFileSync(COL, JSON.stringify({ collectors: list }));
  writeCols([col('edge-a', '127.0.0.1'), col('edge-b', '127.0.0.2')]);
  // 루프백은 SSRF 판정이 접속 전에 막는다 → 네트워크 없이 '실패' 결과가 바로 나온다. 알림은 끈다(상태 전이만 본다).
  fs.writeFileSync(path.join(DIR, 'relaycheck-settings.json'), JSON.stringify({
    enabled: true, alerts: false, failStreak: 1, timeoutMs: 2000, autoHosts: true, topologyHosts: false, profile: [{ port: 4067, kind: 'irs-ssh' }] }));
  const { runRelayChecks, relayCheckStatus } = await import('../src/relaycheck/poller.js');
  const keys = () => relayCheckStatus().results.map((r) => r.target.key).sort();

  // ① 두 대상 실패 → 알림 보냄 표지(alerted)
  const r1 = await runRelayChecks({ force: true });
  assert.equal(r1.ok, true); assert.equal(r1.total, 2); assert.equal(r1.fail, 2);
  assert.equal(r1.sourcesUnread, undefined, '읽힌 주기에는 표지가 없다');
  assert.deepEqual(keys(), ['127.0.0.1:4067', '127.0.0.2:4067']);
  assert.ok(relayCheckStatus().results.every((r) => r.alerted === true && r.failStreak === 1));

  // ② 등록부에서 정말 뺀 대상은 예전처럼 정리된다(읽힌 주기)
  writeCols([col('edge-a', '127.0.0.1')]);
  const r2 = await runRelayChecks({ force: true });
  assert.equal(r2.total, 1);
  assert.deepEqual(keys(), ['127.0.0.1:4067'], '읽힌 주기 — 빠진 대상 정리는 그대로');
  const before = relayCheckStatus().results[0];
  assert.equal(before.alerted, true); assert.equal(before.failStreak, 2);

  // ③ 등록부 읽기 오류(EISDIR — 97회차 F3 과 같은 재현) → 대상 0 이지만 상태는 그대로 · 표지
  fs.rmSync(COL);
  fs.mkdirSync(COL);
  const r3 = await runRelayChecks({ force: true });
  assert.equal(r3.ok, true); assert.equal(r3.total, 0, '이번 주기에 잰 대상은 0');
  assert.deepEqual(r3.sourcesUnread, ['collectors'], '못 읽은 원천을 밝힌다(고정 낱말)');
  assert.deepEqual(keys(), ['127.0.0.1:4067'], '못 읽은 주기 — 상태를 지우지 않는다(수정 전: [])');
  const kept = relayCheckStatus().results[0];
  assert.equal(kept.alerted, true, '알림 보냄 표지가 남아야 다시 읽힌 뒤 같은 장애를 또 알리지 않는다');
  assert.equal(kept.failStreak, before.failStreak);
  assert.equal(kept.lastFailAt, before.lastFailAt);
  assert.deepEqual(relayCheckStatus().last.sourcesUnread, ['collectors']);
});

/* ══════════════════════════════════════════════════════════════════════════════
 * Z1 · Z2 · Z3 — svcmon/formats.js XLSX 사전 점검(svcmon 가져오기 · 7b 서버 등록이 같은 함수를 쓴다)
 *  Z1(높음) 세 사전 점검(선언 크기 · 실제 해제 크기 · 병합)이 EOCD 의 **선언 항목 수**만큼만 중앙 디렉터리를 읽었다 — JSZip(exceljs)은 서명이 이어지는 동안
 *           전부 읽고 개수 불일치를 던지지 않는다. 두 바이트(18 → 1)로 크기 상한(SEC2629-09 · SEC2630-01)과 병합 상한(7b M-4)을 함께 지나갔다(80MB 항목을 JSZip 이 품).
 *           → 읽기 하나(zipCentral): 서명이 이어지는 동안 읽고 · 중앙 디렉터리가 EOCD 바로 앞에서 끝나며 · 읽은 수 = 선언 수일 때만 통과(밀린 offset 도 거부).
 *  Z2(높음) 병합 사전 점검 정규식이 표기 하나만 알았다(작은따옴표 · 등호 공백 · 앞선 속성 · $ · 문자 참조는 0 으로 셈 — exceljs 는 전부 전개) · 시트 이름 거르기가 exceljs 보다 좁았다.
 *           (`$A$1:$XFD$1048576` 6,464B 파일로 실제 가져오기 함수가 2.4초 뒤 프로세스 중단 — 재현) → 속성을 XML 문법대로 읽고 · 해석 못 한 표기는 거부 · 이름은 넓게.
 *  Z3(높음) exceljs 는 dataValidation sqref 범위도 칸마다 전개한다(6,494B 파일 · 실제 가져오기 함수 · 힙 256MB 에서 5.4초 뒤 프로세스 중단 재현) — 점검이 없었다.
 *           → svcmon 은 `ignoreNodes: ['dataValidations']`(읽지 않는다) · 공용 사전 점검은 넓이 합 상한(그 옵션 없이 로드하는 호출부용).
 * 전개 · 폭탄을 실제로 로드하는 확인은 **자식 프로세스 + 힙 256MB + 시한**으로 한다(수정 전 판본이면 러너가 아니라 자식이 죽는다).
 * ══════════════════════════════════════════════════════════════════════════════ */
const FORMATS = path.join(HERE, '..', 'src', 'svcmon', 'formats.js');

/** exceljs 로 만든 정상 워크북의 첫 시트 XML 을 고쳐 다시 묶는다(이름을 바꾸면 그 항목 이름으로). */
async function xlsxWith({ afterSheetData = '', rename = null, rows = [['host_name', 'ip'], ['web01', '10.0.0.1']], extra = null } = {}) {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('s');
  for (const r of rows) ws.addRow(r);
  const zip = await JSZip.loadAsync(Buffer.from(await wb.xlsx.writeBuffer()));
  const f = Object.keys(zip.files).find((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  const xml = (await zip.file(f).async('string')).replace('</sheetData>', `</sheetData>${afterSheetData}`);
  if (rename) { zip.remove(f); zip.file(rename, xml); } else zip.file(f, xml);
  if (extra) zip.file(extra.name, extra.data);
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}
const eocdOf = (buf) => buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
/** 자식 프로세스에서 실제 가져오기(parseHostMapAny)를 돌린다 — 힙 256MB · 시한. */
function importInChild(buf, { timeoutMs = 60_000 } = {}) {
  const file = path.join(DIR, `child-${Math.random().toString(16).slice(2)}.xlsx`);
  fs.writeFileSync(file, buf);
  const script = `
    import fs from 'node:fs';
    const { parseHostMapAny } = await import(${JSON.stringify(pathToFileURL(FORMATS).href)});
    const t0 = Date.now();
    try { const r = await parseHostMapAny(fs.readFileSync(${JSON.stringify(file)}), 'xlsx'); console.log('OK ' + JSON.stringify({ pairs: r.pairs, ms: Date.now() - t0 })); }
    catch (e) { console.log('THREW ' + e.message); }
  `;
  const r = spawnSync(process.execPath, ['--max-old-space-size=256', '--input-type=module', '-e', script], { timeout: timeoutMs, encoding: 'utf8' });
  return { signal: r.signal, status: r.status, out: String(r.stdout || '').trim(), err: String(r.stderr || '').slice(-300) };
}

test('154 Z1 — zip 항목 수를 속이거나 offset 을 민 파일은 사전 점검이 거부한다(JSZip 이 읽는 항목 집합과 같아야 한다)', async () => {
  const F = await import('../src/svcmon/formats.js');
  // 80MB 항목(해제 상한 64MB 초과)이 든 워크북 — 정직하면 크기 점검이 거부한다
  const big = await xlsxWith({ extra: { name: 'xl/media/big.bin', data: Buffer.alloc(80 * 1024 * 1024, 0x41) } });
  const eocd = eocdOf(big);
  const realCount = big.readUInt16LE(eocd + 10);
  assert.ok(realCount > 5 && big.length < 2 * 1024 * 1024, `재현 파일: 항목 ${realCount}개 · ${big.length}B`);
  assert.throws(() => F.assertXlsxSizeOk(big), /압축 해제 크기가 너무 큽니다/);

  // ① 선언 항목 수만 1 로(두 바이트) — JSZip 은 여전히 전부 읽는다
  const lie = Buffer.from(big); lie.writeUInt16LE(1, eocd + 8); lie.writeUInt16LE(1, eocd + 10);
  const seen = Object.keys((await JSZip.loadAsync(lie)).files).length;
  assert.equal(seen, realCount, 'JSZip 은 선언 개수(1)와 무관하게 중앙 디렉터리의 항목을 전부 읽는다 — 이 시험의 전제');
  assert.deepEqual(F.zipDeclaredSize(lie), { ok: false, reason: 'bad-cd' }, '수정 전: { ok:true, entries:1, total:<첫 항목> }');
  assert.equal(F.zipInflatedSize(lie).reason, 'bad-cd');
  assert.equal(F.xlsxMergeStats(lie).ok, false);
  assert.throws(() => F.assertXlsxSizeOk(lie), /zip 구조를 읽지 못했습니다/);
  assert.throws(() => F.assertXlsxMergesOk(lie), /zip 구조를 읽지 못했습니다/, '점검을 못 했으면 통과가 아니다');

  // ② 선언 수를 실제보다 크게 · ③ 중앙 디렉터리와 EOCD 사이에 잉여 바이트(JSZip 은 offset 을 민다 — 가짜 중앙 디렉터리 자리)
  const more = Buffer.from(big); more.writeUInt16LE(realCount + 1, eocd + 8); more.writeUInt16LE(realCount + 1, eocd + 10);
  assert.equal(F.zipDeclaredSize(more).reason, 'bad-cd');
  const small = await xlsxWith();
  const e2 = eocdOf(small);
  const shifted = Buffer.concat([small.subarray(0, e2), Buffer.alloc(64), small.subarray(e2)]);   // cdOff + cdSize < EOCD 위치
  assert.equal(F.zipDeclaredSize(shifted).reason, 'bad-cd');
  assert.throws(() => F.assertXlsxSizeOk(shifted), /zip 구조를 읽지 못했습니다/);
  // ④ 중앙 디렉터리 크기를 줄여 선언(끝이 EOCD 가 아님)
  const cut = Buffer.from(small); cut.writeUInt32LE(cut.readUInt32LE(e2 + 12) - 46, e2 + 12);
  assert.equal(F.zipDeclaredSize(cut).reason, 'bad-cd');

  // ⑤ 정상 파일은 그대로 — 항목 수가 JSZip 과 같고 세 점검을 지난다
  const okCount = Object.keys((await JSZip.loadAsync(small)).files).length;
  const z = F.zipDeclaredSize(small);
  assert.equal(z.ok, true); assert.equal(z.entries, okCount, '사전 점검이 본 항목 수 = JSZip 이 읽는 항목 수');
  assert.equal(F.assertXlsxSizeOk(small).entries, okCount);
  assert.equal(F.zipInflatedSize(small).ok, true);
  const r = await F.parseHostMapAny(small, 'xlsx');
  assert.deepEqual(r.pairs, [{ name: 'web01', ip: '10.0.0.1' }]);
});

test('154 Z2 — 병합 셀 사전 점검은 XML 로 같은 뜻인 표기를 전부 세고 · 해석 못 한 표기는 거부한다(시트 이름도 넓게)', async () => {
  const F = await import('../src/svcmon/formats.js');
  const AREA = 'A1:Z10000';   // 260,000칸 > 상한 200,000
  const over = {
    '큰따옴표(기준)': `<mergeCell ref="${AREA}"/>`,
    작은따옴표: `<mergeCell ref='${AREA}'/>`,
    '등호 주변 공백': `<mergeCell ref = "${AREA}"/>`,
    '줄바꿈 · 탭': `<mergeCell\n\tref\n=\n"${AREA}"\n/>`,
    'ref 앞의 다른 속성': `<mergeCell x="1" ref="${AREA}"/>`,
    '속성값 안의 >': `<mergeCell x=">" ref='${AREA}'/>`,
    '달러 표기': '<mergeCell ref="$A$1:$Z$10000"/>',
    '소문자 열': '<mergeCell ref="a1:z10000"/>',
  };
  for (const [name, xml] of Object.entries(over)) {
    const buf = await xlsxWith({ afterSheetData: `<mergeCells count="1">${xml}</mergeCells>` });
    const st = F.xlsxMergeStats(buf);
    assert.equal(st.ok, true, name);
    assert.equal(st.merges, 1, `${name}: 병합 1개로 센다(수정 전 0)`);
    assert.equal(st.area, 260_000, `${name}: 넓이`);
    assert.equal(st.over, true, name);
    assert.throws(() => F.assertXlsxMergesOk(buf), /병합 셀이 너무 많거나 넓습니다/, name);
  }
  // 해석하지 못한 표기 = 거부(0 으로 세지 않는다): 문자 참조 · ref 없음 · 따옴표 없는 값 · 시트 접두 · 열 전체
  const unparsed = {
    '문자 참조': '<mergeCell ref="A1:&#90;10000"/>',
    'ref 없음': '<mergeCell foo="A1:Z10000"/>',
    '열 전체': '<mergeCell ref="A:Z"/>',
    '시트 접두': '<mergeCell ref="s!A1:Z10000"/>',
    '닫히지 않은 따옴표': '<mergeCell ref="A1:Z10000/>',
  };
  for (const [name, xml] of Object.entries(unparsed)) {
    const buf = await xlsxWith({ afterSheetData: `<mergeCells count="1">${xml}</mergeCells>` });
    const st = F.xlsxMergeStats(buf);
    assert.equal(st.ok, true, name);
    assert.ok(st.unparsed >= 1, `${name}: 해석 못 함으로 센다 ${JSON.stringify(st)}`);
    assert.throws(() => F.assertXlsxMergesOk(buf), /병합 셀 표기를 해석하지 못했습니다|병합 셀이 너무/, name);
  }
  // 시트 항목 이름 — exceljs 는 이름 어디든 xl/worksheets/sheet<수>.xml 이 있으면 시트로 읽는다(앞의 / 는 뗀다)
  for (const rename of ['/xl/worksheets/sheet1.xml', 'x/xl/worksheets/sheet1.xml', `xl/worksheets/sheet1.xml.${'A'.repeat(70)}`]) {
    const buf = await xlsxWith({ afterSheetData: `<mergeCells count="1"><mergeCell ref="${AREA}"/></mergeCells>`, rename });
    assert.equal(F.xlsxMergeStats(buf).over, true, `이름 ‘${rename.slice(0, 40)}’ 의 시트도 본다(수정 전: 건너뜀)`);
  }
  // `<mergeCells` 컨테이너는 병합이 아니다 · 정상 병합은 통과하고 값도 예전처럼 읽힌다
  const fine = await xlsxWith({ afterSheetData: '<mergeCells count="2"><mergeCell ref="C1:D1"/><mergeCell ref="C2:C3"/></mergeCells>' });
  const st = F.assertXlsxMergesOk(fine);
  assert.equal(st.merges, 2); assert.equal(st.area, 4); assert.equal(st.over, false); assert.equal(st.unparsed, 0);
  assert.deepEqual((await F.parseHostMapAny(fine, 'xlsx')).pairs, [{ name: 'web01', ip: '10.0.0.1' }]);
});

test('154 Z3 — 유효성 검사(dataValidation) 범위: 공용 사전 점검은 넓이 합 상한 · svcmon 가져오기는 읽지 않는다(전체 시트 범위도 바로 끝난다)', async () => {
  const F = await import('../src/svcmon/formats.js');
  const dv = (sqref, q = '"') => `<dataValidations count="1"><dataValidation type="list" allowBlank="1" sqref=${q}${sqref}${q}><formula1>"a,b"</formula1></dataValidation></dataValidations>`;
  assert.equal(F.XLSX_MAX_VALIDATION_AREA, 1_100_000);

  // ① 전체 시트 범위(6KB 남짓) — 기본(check)은 거부 · 표기를 바꿔도 같다
  const bomb = await xlsxWith({ afterSheetData: dv('A1:XFD1048576') });
  assert.ok(bomb.length < 16 * 1024, `재현 파일은 작다(${bomb.length}B)`);
  const st = F.xlsxMergeStats(bomb);
  assert.equal(st.ok, true); assert.equal(st.dvOver, true); assert.ok(st.dvArea > F.XLSX_MAX_VALIDATION_AREA);
  assert.throws(() => F.assertXlsxMergesOk(bomb), /데이터 유효성 검사\(드롭다운 등\) 범위가 너무 넓습니다/);
  for (const [name, xml] of Object.entries({ 작은따옴표: dv('A1:XFD1048576', "'"), '달러 표기': dv('$A$1:$XFD$1048576'), '등호 공백': dv('A1:XFD1048576').replace('sqref=', 'sqref = ') })) {
    const b = await xlsxWith({ afterSheetData: xml });
    assert.throws(() => F.assertXlsxMergesOk(b), /범위가 너무 넓습니다/, name);
  }
  // 여러 범위의 합 · 해석 못 한 표기(문자 참조)도 거부
  const two = await xlsxWith({ afterSheetData: dv('B1:B1048576 C1:C1048576') });
  assert.throws(() => F.assertXlsxMergesOk(two), /범위가 너무 넓습니다/);
  const ent = await xlsxWith({ afterSheetData: dv('A1:&#88;FD1048576') });
  assert.throws(() => F.assertXlsxMergesOk(ent), /유효성 검사 범위 표기를 해석하지 못했습니다/);
  // ② 전체 열 하나 · 보통 범위는 통과(정상 파일 — 드롭다운 한 열)
  const oneCol = await xlsxWith({ afterSheetData: dv('B1:B1048576') });
  const s1 = F.assertXlsxMergesOk(oneCol);
  assert.equal(s1.dvArea, 1_048_576); assert.equal(s1.dvOver, false);
  assert.equal(F.assertXlsxMergesOk(await xlsxWith({ afterSheetData: dv('E4:L9 N4:U9 Z1') })).dvArea, 48 + 48 + 1);
  // ③ 읽지 않는 호출부(ignored)는 넓어도 던지지 않는다 — 병합 판정은 그대로 한다
  assert.equal(F.assertXlsxMergesOk(bomb, { dataValidations: 'ignored' }).dvOver, true);
  const both = await xlsxWith({ afterSheetData: `<mergeCells count="1"><mergeCell ref='A1:Z10000'/></mergeCells>${dv('A1:XFD1048576')}` });
  assert.throws(() => F.assertXlsxMergesOk(both, { dataValidations: 'ignored' }), /병합 셀이 너무/);

  // ④ 실제 svcmon 가져오기 — 전체 시트 유효성 범위가 든 파일을 값 그대로 · 바로 읽는다(수정 전: 170억 칸 전개 → 힙 고갈 또는 시한 초과)
  const r = importInChild(bomb, { timeoutMs: 60_000 });
  assert.equal(r.signal, null, `자식이 시한 안에 끝나야 한다(${r.signal} · ${r.err})`);
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /^OK /, r.out);
  const got = JSON.parse(r.out.slice(3));
  assert.deepEqual(got.pairs, [{ name: 'web01', ip: '10.0.0.1' }]);
  assert.ok(got.ms < 10_000, `유효성 범위를 전개하지 않는다(${got.ms}ms)`);
});

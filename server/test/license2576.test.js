/**
 * license2576.test.js — 오픈소스 라이선스 준수 계약 고정(v2.576).
 *
 * 배경(v2.576 라이선스 점검에서 **확정 위반 2건**을 찾았다):
 *  · F1 — `web/src/vendor/pretendardKsxFont.js` 의 임베드 폰트는 상류 Pretendard 가변폰트
 *    (글리프 14,757)를 **2,918 글리프 정적 인스턴스**로 서브셋한 것이다. OFL 1.1 의
 *    "Modified Version" 정의(*"adding to, **deleting**, or substituting … **by changing
 *    formats**"*)에 해당하는데 `name` 테이블의 패밀리명이 **`Pretendard`** 그대로였다.
 *    3조: *"No Modified Version of the Font Software may use the Reserved Font Name(s)"*
 *    (그 예약 이름은 `web/src/vendor/Pretendard-OFL.txt:2` 가 선언한다).
 *  · F2 — OFL 2조는 사본마다 라이선스를 담을 것을 요구한다(stand-alone text / human-readable
 *    headers / **machine-readable metadata fields**). 그런데 서브셋 폰트에 nameID 13·14 가
 *    **없었고**, `packaging/offline/build-package.sh:114` 는 `web/dist` 만 복사하므로
 *    `web/src/vendor/Pretendard-OFL.txt` 는 **고객에게 배포되지 않았다**(실측: `web/dist` 전체
 *    grep 결과 "Open Font License" **0건**).
 *
 * ⚠ 이 테스트는 **폰트 바이너리를 실제로 디코드**한다 — 소스 문자열 grep 으로는 base64 안의
 *   `name` 테이블을 볼 수 없다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const r = (p) => path.join(ROOT, p);

/** sfnt `name` 테이블만 읽는 최소 파서 — nameID → 문자열(첫 레코드). */
function readNameTable(buf) {
  const numTables = buf.readUInt16BE(4);
  let nameOff = -1; let nameLen = 0;
  for (let i = 0; i < numTables; i += 1) {
    const rec = 12 + i * 16;
    if (buf.toString('latin1', rec, rec + 4) === 'name') { nameOff = buf.readUInt32BE(rec + 8); nameLen = buf.readUInt32BE(rec + 12); break; }
  }
  assert.ok(nameOff > 0, 'name 테이블이 없다');
  const count = buf.readUInt16BE(nameOff + 2);
  const strOff = nameOff + buf.readUInt16BE(nameOff + 4);
  const out = new Map();
  for (let i = 0; i < count; i += 1) {
    const rec = nameOff + 6 + i * 12;
    const platformID = buf.readUInt16BE(rec);
    const nameID = buf.readUInt16BE(rec + 6);
    const len = buf.readUInt16BE(rec + 8);
    const off = strOff + buf.readUInt16BE(rec + 10);
    if (off + len > nameOff + nameLen) continue;
    const raw = buf.subarray(off, off + len);
    // platformID 3(Windows)·0(Unicode) 은 UTF-16BE 다 — 바이트를 뒤집어 UTF-16LE 로 읽는다.
    // platformID 1(Mac) 은 Mac Roman 이고 ASCII 범위는 latin1 과 같다(여기 값은 전부 ASCII).
    const val = (platformID === 3 || platformID === 0)
      ? Buffer.from(raw).swap16().toString('utf16le')
      : raw.toString('latin1');
    if (!out.has(nameID)) out.set(nameID, val);
  }
  return out;
}

function subsetFont() {
  const src = fs.readFileSync(r('web/src/vendor/pretendardKsxFont.js'), 'utf8');
  const m = src.match(/PRETENDARD_KSX_BASE64\s*=\s*'([A-Za-z0-9+/=]+)'/s);
  assert.ok(m, 'base64 폰트 리터럴을 찾지 못했다');
  return Buffer.from(m[1], 'base64');
}

test('★ F1 — 서브셋 폰트는 예약 폰트 이름 Pretendard 를 쓰지 않는다 (OFL 3조)', () => {
  const ofl = fs.readFileSync(r('web/src/vendor/Pretendard-OFL.txt'), 'utf8');
  assert.match(ofl, /Reserved Font Name/i, 'OFL 전문에 예약 이름 선언이 있어야 이 검사의 전제가 성립한다');

  const names = readNameTable(subsetFont());
  for (const [nameID, label] of [[1, 'Font Family'], [4, 'Full Name'], [6, 'PostScript']]) {
    const v = names.get(nameID) || '';
    assert.ok(v, `nameID ${nameID}(${label}) 가 비어 있다`);
    assert.ok(!/pretendard/i.test(v), `nameID ${nameID}(${label})='${v}' — 수정본이 예약 폰트 이름을 쓰고 있다(OFL 3조 위반)`);
  }
});

test('★ F2 — 서브셋 폰트에 기계판독 라이선스 고지(nameID 13·14)가 있고 원저작자 표시(0)가 보존된다', () => {
  const names = readNameTable(subsetFont());
  assert.match(names.get(13) || '', /SIL Open Font License/i, 'nameID 13(License) 이 없다 — OFL 2조의 machine-readable metadata 요건');
  assert.match(names.get(14) || '', /scripts\.sil\.org\/OFL/i, 'nameID 14(License URL) 이 없다');
  // OFL 1조는 원저작자 저작권 표시 보존을 요구한다 — 이름을 바꿀 때 지우면 안 된다.
  assert.match(names.get(0) || '', /Kil Hyung-jin/i, 'nameID 0(Copyright) 의 원저작자 표시가 사라졌다(OFL 1조)');
});

test('★ F2 — jsPDF 별칭도 예약 이름이 아니다 (PDF 폰트 리소스 이름이 된다)', () => {
  const s = stripComments(fs.readFileSync(r('web/src/views/tools/reportExport.js'), 'utf8'));   // v2.613 TESTDOC2613-08
  const calls = [...s.matchAll(/pdf\.(?:addFont|setFont)\(\s*(?:'[^']*'\s*,\s*)?'([^']+)'/g)].map((m) => m[1]);
  assert.ok(calls.length >= 2, 'addFont/setFont 호출을 찾지 못했다');
  for (const c of calls) assert.ok(!/^pretendard$/i.test(c), `jsPDF 별칭 '${c}' 가 예약 폰트 이름이다`);
});

test('★ F2·F3 — 배포되는 고지 파일이 존재하고 OFL 전문과 미확인 패키지를 담는다', () => {
  const p = r('web/public/THIRD-PARTY-NOTICES.txt');
  assert.ok(fs.existsSync(p), 'web/public/THIRD-PARTY-NOTICES.txt 가 없다 — `node scripts/third-party-notices.mjs`');
  const t = fs.readFileSync(p, 'utf8');
  // ⚠ `web/public` 이어야 한다 — vite 가 `web/dist` 로 복사하고, 오프라인 패키지는 `web/dist` 만 담는다.
  assert.match(t, /SIL OPEN FONT LICENSE Version 1\.1/i, 'OFL 전문이 빠졌다(2조: each copy contains … this license)');
  assert.match(t, /DVC Sans KSX/, '서브셋 폰트가 수정본임을 밝히는 절이 빠졌다');
  assert.match(t, /Natural Earth/i, '지도 데이터 출처 표시가 빠졌다(land-110m.json)');
  // 라이선스를 확인할 수 없는 패키지는 **숨기지 않는다**(정직 기록 — 상용 납품 실사 대상).
  assert.match(t, /라이선스를 확인할 수 없는 패키지/, '미확인 패키지 절이 빠졌다');
  assert.ok(t.length > 100_000, `고지 파일이 너무 작다(${t.length}B) — 라이선스 본문이 빠진 것으로 보인다`);
});

test('★ F5 — 루트 LICENSE 가 있고 제3자 고지 위치를 가리킨다', () => {
  const p = r('LICENSE');
  assert.ok(fs.existsSync(p), '루트 LICENSE 가 없다 — 공개 저장소에서 의도가 불분명해진다');
  const t = fs.readFileSync(p, 'utf8');
  assert.match(t, /All rights reserved/i);
  assert.match(t, /THIRD-PARTY-NOTICES\.txt/, '제3자 고지 위치를 가리켜야 한다(그 라이선스는 위 조항에 영향받지 않는다)');
});

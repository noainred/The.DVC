/**
 * 성능점검 CSV 직렬화/파싱 — 컬럼 정의는 `testSchema.js` 하나에서만 파생한다.
 *
 * 행 레이아웃: **점검 1건 = 1행**. 한 대상에 점검이 여러 개면 앞 5열(kind·path·target_name·
 * host·target_enabled)이 반복되고, 가져올 때 `(kind, path, 소문자 이름)` 으로 행을 묶어
 * `tests[]` 를 합친 뒤 **한 번에** 커밋한다. 묶지 않고 그대로 넘기면 같은 대상이 점검 수만큼
 * 중복 생성된다.
 *
 * `test_name` 이 빈 행은 '점검 없는 대상'으로 취급한다(대상만 등록).
 *
 * 형식 규칙
 * - 내보내기: UTF-8 BOM(엑셀 한글) + CRLF + 수식 인젝션 가드(`= + - @` → `'` 접두).
 * - 가져오기: BOM 제거 + 수식가드 역함수. 역함수를 빼면 왕복마다 `'` 가 한 겹 쌓인다.
 * - 유형과 무관한 컬럼은 **빈 칸으로 내보낸다**(ping 행의 warn_days 등) — 의미 없는 기본값을
 *   채워 내보내면 사용자가 그것을 설정값으로 오해한다.
 */

import { parseCsvRows, csvLine, unguardCell, CSV_BOM } from '../util/csv.js';
import { TARGET_FIELDS, TEST_FIELDS, CSV_COLUMNS, TEST_TYPES, KINDS, fieldsFor } from './testSchema.js';

/** 없으면 어떤 행도 해석할 수 없는 컬럼. */
export const REQUIRED_COLUMNS = ['kind', 'path', 'target_name', 'host'];

const BOOL_TEXT = (v) => (v ? 'true' : 'false');

/**
 * 대상 목록을 셀 배열 행으로 펼친다(헤더 1행 + 점검 1건=1행). CSV·XLSX·JSON 내보내기가
 * **같은 컬럼·같은 순서**를 쓰도록 한 곳에서 낸다(포맷마다 컬럼이 갈리면 왕복이 깨진다).
 * 첫 행은 헤더(CSV_COLUMNS).
 */
export function* targetRows(targets, { includeTests = true } = {}) {
  yield CSV_COLUMNS.slice();
  for (const t of targets) {
    const tests = includeTests ? (t.tests || []) : [];
    if (!tests.length) { yield rowCells(t, null); continue; }
    for (const x of tests) yield rowCells(t, x);
  }
}

/** 대상 1건 + 점검 1건 → 셀 배열(유형과 무관한 컬럼은 빈 칸). */
function rowCells(target, test) {
  const out = [];
  for (const f of TARGET_FIELDS) {
    const v = target[f.key];
    out.push(f.kind === 'bool' ? BOOL_TEXT(v !== false) : String(v ?? ''));
  }
  if (!test) {
    for (let i = 0; i < TEST_FIELDS.length; i += 1) out.push('');
    return out;
  }
  const usable = new Set(fieldsFor(test.type).map((f) => f.key));
  for (const f of TEST_FIELDS) {
    if (!usable.has(f.key)) { out.push(''); continue; }
    const v = test[f.key];
    if (f.kind === 'bool') out.push(BOOL_TEXT(f.key === 'enabled' ? v !== false : !!v));
    else out.push(v === undefined || v === null ? '' : String(v));
  }
  return out;
}

/**
 * 내보내기 — 줄 단위 제너레이터. 라우트가 청크로 흘려보낼 수 있게 문자열을 한 번에 만들지
 * 않는다(20만 점검 × 약 150B = 30MB 를 한 문자열로 만들면 그 자체가 동기 블로킹이다).
 */
export function* csvLines(targets, { includeTests = true } = {}) {
  yield CSV_BOM + csvLine(CSV_COLUMNS);
  for (const t of targets) {
    const tests = includeTests ? (t.tests || []) : [];
    if (!tests.length) { yield csvLine(rowCells(t, null)); continue; }
    for (const x of tests) yield csvLine(rowCells(t, x));
  }
}

/** 작은 목록용 편의 함수(샘플·테스트). 대량 내보내기는 csvLines 를 쓴다. */
export function targetsToCsv(targets, opts) {
  return [...csvLines(targets, opts)].join('\r\n') + '\r\n';
}

/**
 * 가져오기 파싱 — 저장하지 않고 `bulkAddTargets` 가 받는 모양으로만 만든다.
 * 검증(SSRF·유형·상한)은 저장소의 `cleanTarget`/`cleanTest` 가 담당한다(규칙 이중화 금지).
 *
 * @returns {{targets:object[], errors:{row:number,name:string,reason:string}[],
 *            unknownColumns:string[], rowCount:number}}
 */
export function parseTargetsCsv(input, { maxRows = 2000 } = {}) {
  const errors = [];
  let rows;
  try {
    // 헤더 1행을 더 허용한다. 셀 상한은 가장 긴 필드(body 4000자)에 맞춘다.
    rows = parseCsvRows(input, { maxRows: maxRows + 1, maxCell: 4000 });
  } catch (e) {
    return { targets: [], errors: [{ row: 0, name: '', reason: e.message }], unknownColumns: [], rowCount: 0 };
  }
  if (!rows.length) {
    return { targets: [], errors: [{ row: 0, name: '', reason: '내용이 없습니다(헤더 행이 필요합니다).' }], unknownColumns: [], rowCount: 0 };
  }

  const header = rows[0].map((h) => unguardCell(h).trim().toLowerCase());
  const idx = new Map();
  header.forEach((h, i) => { if (h && !idx.has(h)) idx.set(h, i); });
  const missing = REQUIRED_COLUMNS.filter((c) => !idx.has(c));
  if (missing.length) {
    return {
      targets: [],
      errors: [{ row: 1, name: '', reason: `필수 컬럼이 없습니다: ${missing.join(', ')} (샘플 CSV 를 내려받아 헤더를 맞추세요)` }],
      unknownColumns: [], rowCount: 0,
    };
  }
  const known = new Set(CSV_COLUMNS);
  const unknownColumns = header.filter((h) => h && !known.has(h));

  const groups = new Map();     // key -> { target, rows:number[] }
  const order = [];
  const body = rows.slice(1);

  body.forEach((cells, i) => {
    const rowNo = i + 2;        // 1행은 헤더
    const cell = (col) => {
      const j = idx.get(col);
      return j === undefined ? '' : unguardCell(cells[j] ?? '').trim();
    };
    const kind = cell('kind').toLowerCase();
    const path = cell('path');
    const name = cell('target_name');
    const host = cell('host');
    if (!name) { errors.push({ row: rowNo, name: '', reason: 'target_name 이 비어 있습니다.' }); return; }
    if (!path) { errors.push({ row: rowNo, name, reason: 'path 가 비어 있습니다.' }); return; }
    if (!host) { errors.push({ row: rowNo, name, reason: 'host 가 비어 있습니다.' }); return; }
    if (kind && !KINDS.includes(kind)) {
      errors.push({ row: rowNo, name, reason: `kind 는 ${KINDS.join('/')} 만 됩니다(입력: ${kind}).` });
      return;
    }

    const key = `${kind || 'infra'} ${path} ${name.toLowerCase()}`;
    let g = groups.get(key);
    if (!g) {
      // _row = 이 대상이 처음 나온 CSV 행 번호. 저장소 검증에서 나온 오류를 **CSV 행 번호로**
      // 되돌려 표시하기 위한 것이다(대상 순번으로 표시하면 사용자가 파일에서 그 줄을 못 찾는다).
      // cleanTarget 은 화이트리스트 방식이라 이 키는 저장되지 않는다.
      g = { target: { _row: rowNo, kind: kind || 'infra', path, name, host, tests: [] }, rows: [], host, enabled: cell('target_enabled') };
      if (g.enabled !== '') g.target.enabled = g.enabled;
      groups.set(key, g);
      order.push(key);
    } else if (g.host !== host) {
      // 같은 대상을 가리키는 행들이 서로 다른 호스트를 적었다 — 어느 쪽이 맞는지 알 수 없다.
      errors.push({ row: rowNo, name, reason: `같은 대상의 host 가 앞 행(${g.host})과 다릅니다(${host}).` });
      return;
    }
    g.rows.push(rowNo);

    const testName = cell('test_name');
    if (!testName) return;                     // 점검 없는 대상 행
    const type = cell('type').toLowerCase();
    if (!type) { errors.push({ row: rowNo, name: testName, reason: 'test_name 이 있으면 type 이 필요합니다.' }); return; }
    if (!TEST_TYPES.includes(type)) {
      errors.push({ row: rowNo, name: testName, reason: `알 수 없는 유형: ${type} (가능: ${TEST_TYPES.join(', ')})` });
      return;
    }
    const test = { name: testName, type };
    for (const f of TEST_FIELDS) {
      if (f.key === 'name' || f.key === 'type') continue;
      const v = cell(f.col);
      if (v !== '') test[f.key] = v;            // 빈 칸은 키를 만들지 않는다 → 저장소가 기본값을 채운다
    }
    g.target.tests.push(test);
  });

  return {
    targets: order.map((k) => groups.get(k).target),
    errors,
    unknownColumns,
    rowCount: body.length,
  };
}

/**
 * 샘플 CSV — 스키마에서 생성한다. 하드코딩 상수로 두면 컬럼을 추가한 날 샘플만 낡는다.
 * 값은 문서용 예시이며 사내 실제 주소를 담지 않는다(RFC5737 문서용 대역·example.com).
 */
export function sampleCsv() {
  const sample = [
    {
      kind: 'infra', path: 'A.Infra\\OC2\\워커노드', name: 'lesasbpdp01', host: '10.20.30.41', enabled: true,
      tests: [
        { name: '도달성', type: 'ping', intervalSec: 120, enabled: true },
        { name: '워커 API', type: 'tcp', port: 8080, intervalSec: 120, enabled: true },
        { name: 'SSH 배너', type: 'ssh', port: 22, keyword: 'SSH-2.0', intervalSec: 300, enabled: true },
        { name: '시각 오차', type: 'ntp', port: 123, server: 'ntp.example.com', warnMs: 1000, badMs: 5000, intervalSec: 600, enabled: true },
      ],
    },
    {
      kind: 'infra', path: 'A.Infra\\OC2\\워커노드', name: 'lesasbpdp02', host: '10.20.30.42', enabled: true,
      tests: [{ name: '도달성', type: 'ping', intervalSec: 120, enabled: true }],
    },
    {
      kind: 'service', path: 'B.Service\\포탈', name: 'portal-web', host: 'portal.example.com', enabled: true,
      tests: [
        { name: '헬스 엔드포인트', type: 'http', url: 'https://portal.example.com/health', keyword: 'ok', expectStatus: 200, warnMs: 3000, insecure: false, intervalSec: 60, enabled: true },
        { name: 'TLS 인증서 만료', type: 'cert', port: 443, warnDays: 30, intervalSec: 86400, enabled: true },
        { name: '도메인 만료', type: 'domain', record: 'example.com', warnDays: 60, intervalSec: 86400, enabled: true },
      ],
    },
    {
      kind: 'service', path: 'B.Service\\사내 DNS', name: 'dns-primary', host: '10.20.40.53', enabled: true,
      tests: [
        { name: '이름 질의', type: 'dns', record: 'portal.example.com', server: '10.20.40.53', expect: '', intervalSec: 300, enabled: true },
        { name: '53 포트', type: 'tcp', port: 53, intervalSec: 300, enabled: true },
      ],
    },
    {
      kind: 'infra', path: 'A.Infra\\OC2\\네트워크', name: 'core-switch-01', host: '10.20.0.1', enabled: false,
      tests: [{ name: '경로 추적', type: 'trace', maxHops: 15, intervalSec: 1800, enabled: false }],
    },
    // 점검 없이 대상만 등록하는 행(test_name 이 빈 행)
    { kind: 'infra', path: 'A.Infra\\OC2\\예비', name: 'spare-01', host: '10.20.30.99', enabled: false, tests: [] },
  ];
  return targetsToCsv(sample);
}

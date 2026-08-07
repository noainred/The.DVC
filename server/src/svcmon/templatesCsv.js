/**
 * 점검 템플릿 CSV 가져오기/내보내기 — 대상 CSV(`csvio.js`)와 **같은 규약**을 따른다.
 *
 * 행 레이아웃: **항목 1건 = 1행**. 한 템플릿에 항목이 여러 개면 앞 3열(template_name·
 * template_desc·template_kind)이 반복되고, 가져올 때 `(소문자 template_name)` 으로 행을 묶어
 * `items[]` 를 합친다. 항목 0개 템플릿은 항목 열이 전부 빈 1행으로 내보낸다.
 *
 * 컬럼: 템플릿 3열 + 항목 열은 `testSchema.TEST_FIELDS` 에서 **파생**한다(복사 금지 —
 * 필드를 추가한 날 CSV 만 낡는 사고 방지). 단 `name`→`item_name`, `enabled`→`item_enabled` 로
 * 개명한다 — 대상 CSV 의 `test_name`/`test_enabled` 와 헤더가 겹치면 어느 쪽 파일인지 혼동된다.
 *
 * `item.key` 는 **내보내지 않는다**. 가져오기는 `addTemplate` 가 새 key 를 발급한다 — key 를
 * 왕복시키면 CSV 로 만든 템플릿이 원본 템플릿의 적용분(tpl/tplKey 매칭)을 덮어쓸 수 있다
 * (duplicateTemplate 이 전 항목 key 를 재발급하는 것과 같은 이유).
 *
 * 형식 규칙(csvio.js 와 동일)
 * - 내보내기: UTF-8 BOM(엑셀 한글) + CRLF + 수식 인젝션 가드(`= + - @` → `'` 접두).
 * - 가져오기: BOM 제거 + 수식가드 역함수(빼면 왕복마다 `'` 가 한 겹 쌓인다).
 * - 유형과 무관한 컬럼은 빈 칸으로 내보낸다(ping 행의 warn_days 등).
 * - 빈 셀은 키를 만들지 않는다 → 등록 시 `addTemplate`(refineTest)가 기본값을 채운다.
 * - 치환 변수 `{host}{name}{path}{kind}` 는 수식가드 대상 문자(`= + - @`)로 시작하지 않으므로
 *   가드와 충돌 없이 그대로 왕복된다.
 *
 * 값 검증은 여기서 **재구현하지 않는다** — 치환 변수 허용 목록·항목 수/ping 상한·길이·SSRF 는
 * `templates.js addTemplate`(cleanItems/refineTest)가 담당한다. 이 모듈은 파싱 수준
 * (그룹핑 일관성·kind/type 화이트리스트)만 본다.
 */

import { parseCsvRows, csvLine, unguardCell, CSV_BOM } from '../util/csv.js';
import { TEST_FIELDS, TEST_TYPES, KINDS, fieldsFor } from './testSchema.js';
import { listTemplates, addTemplate, MAX_TEMPLATES, MAX_ITEMS } from './templates.js';

/** 템플릿 자체의 3열 — 항목 열 앞에 온다. */
export const TEMPLATE_COLUMNS = ['template_name', 'template_desc', 'template_kind'];

/**
 * 항목 컬럼명 — TEST_FIELDS 의 col 을 쓰되 name/enabled 만 개명한다.
 * (대상 CSV 의 test_name/test_enabled 와 구분 — 파일을 잘못 업로드했을 때 필수 컬럼 검사가
 * 곧바로 잡아낸다.)
 */
const itemColOf = (f) => (f.key === 'name' ? 'item_name' : (f.key === 'enabled' ? 'item_enabled' : f.col));
const ITEM_COL_BY_KEY = new Map(TEST_FIELDS.map((f) => [f.key, itemColOf(f)]));

/** CSV 컬럼 순서 = 템플릿 3열 + 항목 열(TEST_FIELDS 순서). */
export const TPL_CSV_COLUMNS = [...TEMPLATE_COLUMNS, ...TEST_FIELDS.map(itemColOf)];

/** 없으면 어떤 행도 해석할 수 없는 컬럼. */
export const REQUIRED_TPL_COLUMNS = ['template_name'];

/**
 * 파싱 셀 상한 — 가장 긴 text 필드(body 4000자) **+ 수식가드 접두 1자**.
 * 내보내기 `guardCell` 은 `= + - @`(탭·CR)로 시작하는 셀에 `'` 를 붙여 저장 상한보다 1자 길게
 * 만든다. 저장 상한 그대로(4000) 파싱하면 상한을 지킨 정상 body 1개가 **자기 내보내기 파일
 * 전체**를 가져오기 불가로 만든다(저장은 허용하고 왕복은 거부하는 비대칭 — 실측 재현).
 * TEST_FIELDS 에서 파생한다(필드 상한을 바꾼 날 CSV 만 낡는 사고 방지).
 */
const MAX_CELL = 1 + Math.max(...TEST_FIELDS.map((f) => (f.kind === 'text' ? (f.max || 0) : 0)));

/**
 * 기본 행 상한 — 자기 내보내기 최대 규모(템플릿 100 × 항목 50 = 5,000행)에서 파생한다.
 * 이보다 작게 잡으면(과거 기본 2000) 상한을 지킨 정상 내보내기 파일이 기본 옵션 재가져오기에서
 * 통째로 거부된다(가져오기 라우트는 기본값으로 호출한다 — routes/svcmon.js).
 */
export const DEFAULT_MAX_ROWS = MAX_TEMPLATES * MAX_ITEMS;

const BOOL_TEXT = (v) => (v ? 'true' : 'false');

/** 템플릿 1건 + 항목 1건 → 셀 배열. 유형과 무관한 컬럼은 빈 칸(csvio.rowCells 와 같은 규칙). */
function rowCells(tpl, item) {
  const out = [String(tpl?.name ?? ''), String(tpl?.desc ?? ''), String(tpl?.kind ?? '')];
  if (!item) {
    for (let i = 0; i < TEST_FIELDS.length; i += 1) out.push('');
    return out;
  }
  const usable = new Set(fieldsFor(item.type).map((f) => f.key));
  for (const f of TEST_FIELDS) {
    if (!usable.has(f.key)) { out.push(''); continue; }
    const v = item[f.key];
    if (f.kind === 'bool') out.push(BOOL_TEXT(f.key === 'enabled' ? v !== false : !!v));
    else out.push(v === undefined || v === null ? '' : String(v));
  }
  return out;
}

/**
 * 내보내기 — 줄 단위 제너레이터(csvio.csvLines 와 같은 모양 — 라우트가 청크로 흘려보낼 수 있다).
 * 템플릿은 상한이 100개 × 항목 50개 = 최대 5,000행이라 대상 CSV 만큼 크지 않지만 규약을 맞춘다.
 */
export function* templateCsvLines(templates) {
  yield CSV_BOM + csvLine(TPL_CSV_COLUMNS);
  for (const t of templates || []) {
    const items = Array.isArray(t?.items) ? t.items : [];
    if (!items.length) { yield csvLine(rowCells(t, null)); continue; }
    for (const it of items) yield csvLine(rowCells(t, it));
  }
}

/** 작은 목록용 편의 함수(샘플·테스트·다운로드 1회분). */
export function templatesToCsv(templates) {
  return [...templateCsvLines(templates)].join('\r\n') + '\r\n';
}

/**
 * 샘플 CSV — 빌트인 성격의 예시 2템플릿. 값은 문서용이며 실제 조직값을 담지 않는다
 * (호스트명은 example.com 만, 포트는 IANA 표준만). 이름은 빌트인 6종과 겹치지 않게 한다 —
 * 겹치면 '그대로 가져오기' 가 전부 skip 이 되어 샘플이 무용해진다.
 */
export function sampleTemplatesCsv() {
  const sample = [
    {
      name: '(예시) 웹 서비스',
      desc: 'HTTPS 응답·인증서 만료 — url 의 {host} 는 적용 시 대상 호스트로 치환됩니다.',
      kind: 'service',
      items: [
        { name: 'HTTPS 응답', type: 'http', url: 'https://{host}/', expectStatus: 200, warnMs: 3000, insecure: false, intervalSec: 120, enabled: true },
        { name: '인증서 만료(443)', type: 'cert', port: 443, warnDays: 30, intervalSec: 86400, enabled: true },
        { name: 'HTTPS 포트(443)', type: 'tcp', port: 443, intervalSec: 120, enabled: true },
      ],
    },
    {
      name: '(예시) Linux 서버',
      desc: 'ICMP·SSH 배너·NTP 오프셋. 표준 포트만 사용합니다.',
      kind: 'infra',
      items: [
        { name: 'PING', type: 'ping', intervalSec: 120, enabled: true },
        { name: 'SSH(22) 배너', type: 'ssh', port: 22, keyword: 'SSH-2.0', intervalSec: 300, enabled: true },
        { name: 'NTP(123) 오프셋', type: 'ntp', port: 123, server: 'ntp.example.com', warnMs: 1000, badMs: 5000, intervalSec: 600, enabled: true },
      ],
    },
  ];
  return templatesToCsv(sample);
}

/**
 * 가져오기 파싱 — 저장하지 않고 `addTemplate` 가 받는 모양으로만 만든다.
 *
 * 그룹핑: `(소문자 template_name)`. 같은 이름 행들의 desc/kind 가 앞 행과 다르면 **그 행을
 * 오류로 버린다**(어느 쪽이 맞는지 추측하지 않는다 — csvio 의 host 불일치와 같은 규칙).
 * kind 는 ''|'infra'|'service' 만(소문자 정규화, 그 외 오류). type 은 TEST_TYPES 밖이면 오류.
 * 행 번호는 **빈 행을 제외한 레코드 순번**(헤더 = 1) — 원본 텍스트 줄 번호가 아니다.
 * parseCsvRows 가 전부 공백인 레코드를 걸러내고, 따옴표 안 줄바꿈(멀티라인 desc·body)은 원본
 * 여러 줄이 1레코드가 되기 때문이다(원본 줄 번호를 주려면 parseCsvRows 가 레코드별 시작 줄을
 * 반환하도록 확장해야 한다 — 현재는 셀 배열만 반환). `_row` 는 그 템플릿이 처음 나온 행 번호 —
 * importTemplates 가 등록 오류를 CSV 행으로 되돌릴 때 쓴다(addTemplate 은 화이트리스트
 * 방식(buildTemplate)이라 이 키는 저장되지 않는다).
 *
 * @returns {{templates:{_row:number,name:string,desc:string,kind:string,items:object[]}[],
 *            errors:{row:number,name:string,reason:string}[],
 *            unknownColumns:string[], rowCount:number}}
 */
export function parseTemplatesCsv(input, { maxRows = DEFAULT_MAX_ROWS } = {}) {
  const errors = [];
  let rows;
  try {
    // 헤더 1행을 더 허용한다. 셀 상한은 저장 상한 + 수식가드 여유 1자(MAX_CELL 주석 참고).
    rows = parseCsvRows(input, { maxRows: maxRows + 1, maxCell: MAX_CELL });
  } catch (e) {
    // parseCsvRows 의 행 상한 메시지는 헤더 포함(+1) 개수를 그대로 노출하므로('최대 2001행'),
    // 사용자가 아는 데이터 행 기준으로 바꿔 보고한다.
    const reason = e.message === `CSV 행이 최대 ${maxRows + 1}행을 넘습니다.`
      ? `CSV 데이터 행이 최대 ${maxRows}행을 넘습니다(헤더 제외).`
      : e.message;
    return { templates: [], errors: [{ row: 0, name: '', reason }], unknownColumns: [], rowCount: 0 };
  }
  if (!rows.length) {
    return { templates: [], errors: [{ row: 0, name: '', reason: '내용이 없습니다(헤더 행이 필요합니다).' }], unknownColumns: [], rowCount: 0 };
  }

  const header = rows[0].map((h) => unguardCell(h).trim().toLowerCase());
  const idx = new Map();
  header.forEach((h, i) => { if (h && !idx.has(h)) idx.set(h, i); });
  const missing = REQUIRED_TPL_COLUMNS.filter((c) => !idx.has(c));
  if (missing.length) {
    return {
      templates: [],
      errors: [{ row: 1, name: '', reason: `필수 컬럼이 없습니다: ${missing.join(', ')} (템플릿 샘플 CSV 를 내려받아 헤더를 맞추세요 — 대상 CSV 와는 다른 파일입니다)` }],
      unknownColumns: [], rowCount: 0,
    };
  }
  const known = new Set(TPL_CSV_COLUMNS);
  const unknownColumns = header.filter((h) => h && !known.has(h));

  const groups = new Map();     // 소문자 이름 -> { template, desc, kind }
  const order = [];
  const body = rows.slice(1);

  body.forEach((cells, i) => {
    const rowNo = i + 2;        // 1행은 헤더
    const cell = (col) => {
      const j = idx.get(col);
      return j === undefined ? '' : unguardCell(cells[j] ?? '').trim();
    };
    const name = cell('template_name');
    if (!name) { errors.push({ row: rowNo, name: '', reason: 'template_name 이 비어 있습니다.' }); return; }
    const desc = cell('template_desc');
    const kind = cell('template_kind').toLowerCase();
    if (kind && !KINDS.includes(kind)) {
      errors.push({ row: rowNo, name, reason: `template_kind 는 ${KINDS.join('/')} 또는 빈 값만 됩니다(입력: ${kind}).` });
      return;
    }

    const key = name.toLowerCase();
    let g = groups.get(key);
    if (!g) {
      g = { template: { _row: rowNo, name, desc, kind, items: [] }, desc, kind };
      groups.set(key, g);
      order.push(key);
    } else if (g.desc !== desc) {
      // 같은 템플릿의 행들이 서로 다른 설명을 적었다 — 어느 쪽이 맞는지 알 수 없다(추측 금지).
      errors.push({ row: rowNo, name, reason: `같은 템플릿의 template_desc 가 앞 행(${g.desc || '빈 값'})과 다릅니다(${desc || '빈 값'}).` });
      return;
    } else if (g.kind !== kind) {
      errors.push({ row: rowNo, name, reason: `같은 템플릿의 template_kind 가 앞 행(${g.kind || '빈 값'})과 다릅니다(${kind || '빈 값'}).` });
      return;
    }

    const itemName = cell('item_name');
    if (!itemName) {
      // 항목 열이 **전부** 빈 행만 '항목 0개 템플릿 행'이다. 이름 셀만 지워진 항목 행
      // (type·port 등 값이 남은 행)을 같이 넘기면 점검이 무통보로 소실된다 — 사용자는
      // 저장됐다고 믿는다(cleanItems 절단 금지·unknownColumns 보고와 같은 철학).
      const filled = TEST_FIELDS
        .filter((f) => f.key !== 'name')
        .map((f) => ITEM_COL_BY_KEY.get(f.key))
        .filter((col) => cell(col) !== '');
      if (filled.length) {
        errors.push({
          row: rowNo, name,
          reason: `item_name 이 비어 있는데 항목 값이 있습니다(${filled.join(', ')}) — 항목 행이면 item_name 을 채우고, 항목 0개 템플릿 행이면 항목 열을 전부 비우세요.`,
        });
      }
      return;
    }
    const type = cell('type').toLowerCase();
    if (!type) { errors.push({ row: rowNo, name: itemName, reason: 'item_name 이 있으면 type 이 필요합니다.' }); return; }
    if (!TEST_TYPES.includes(type)) {
      errors.push({ row: rowNo, name: itemName, reason: `알 수 없는 유형: ${type} (가능: ${TEST_TYPES.join(', ')})` });
      return;
    }
    const item = { name: itemName, type };
    for (const f of TEST_FIELDS) {
      if (f.key === 'name' || f.key === 'type') continue;
      const v = cell(ITEM_COL_BY_KEY.get(f.key));
      if (v !== '') item[f.key] = v;            // 빈 칸은 키를 만들지 않는다 → addTemplate 가 기본값을 채운다
    }
    g.template.items.push(item);
  });

  return {
    templates: order.map((k) => groups.get(k).template),
    errors,
    unknownColumns,
    rowCount: body.length,
  };
}

/** preview 결과에 항상 싣는 안내 — preview 는 파싱 수준 판정뿐이다(과장 금지). */
export const PREVIEW_NOTICE = '미리보기는 파싱 수준 검증만 수행했습니다 — 항목 값 검증(치환 변수·필수값·항목/ping 상한·SSRF)은 등록 시 addTemplate 에서 이루어지므로, 미리보기 통과가 등록 성공을 보장하지 않습니다.';

/**
 * 가져오기 실행/미리보기.
 *
 * - 이미 있는 **이름**(대소문자 무시)의 템플릿은 skip 한다 — 조용한 덮어쓰기 금지(대상 CSV 와
 *   같은 철학). 같은 CSV 를 두 번 가져와도 템플릿 수가 늘지 않는다.
 * - mode='add': 실제 생성은 `templates.addTemplate` 를 호출한다(검증을 재구현하지 않는다 —
 *   치환 변수 허용 목록·항목/ping 상한·길이·리터럴 SSRF 검증이 거기 있다). 템플릿별로 독립
 *   커밋이다(addTemplate 이 호출마다 저장) — 한 템플릿이 실패해도 나머지는 생성되며, 실패는
 *   errors 로 그대로 보고한다(all-or-nothing 이 아니다).
 * - mode='preview': addTemplate 를 호출하지 않는다. templates.js 가 검증 전용 함수를 export
 *   하지 않으므로 여기서는 **파싱 수준 오류(parsed.errors)와 이름 중복(skip)만** 판정하고,
 *   실제 값 검증은 등록 시라는 것을 `notice` 로 명시한다.
 *
 * @param {ReturnType<typeof parseTemplatesCsv>} parsed
 * @param {{mode?:'preview'|'add', user?:string}} opts
 * @returns {{mode:string, create:number, skip:number,
 *            errors:{row:number,name:string,reason:string}[],
 *            results:{row:number,name:string,action:'create'|'skip'|'error',id?:string,reason?:string}[],
 *            notice?:string}}
 *   create = add 모드에서는 실제 생성 수, preview 에서는 '생성될' 수(파싱 수준 판정).
 *   errors 에는 파싱 오류(parsed.errors)와 등록 실패가 함께 담긴다.
 */
export function importTemplates(parsed, { mode = 'preview', user = '' } = {}) {
  const preview = mode !== 'add';
  const errors = [...(Array.isArray(parsed?.errors) ? parsed.errors : [])];
  const results = [];
  let create = 0;
  let skip = 0;
  const existing = new Set(listTemplates().map((t) => String(t.name ?? '').trim().toLowerCase()));

  for (const t of (Array.isArray(parsed?.templates) ? parsed.templates : [])) {
    const nameKey = String(t?.name ?? '').trim().toLowerCase();
    if (existing.has(nameKey)) {
      skip += 1;
      results.push({ row: t._row ?? 0, name: t.name, action: 'skip', reason: '같은 이름의 템플릿이 이미 있습니다(덮어쓰지 않습니다 — 바꾸려면 기존 템플릿을 수정하거나 삭제 후 가져오세요).' });
      continue;
    }
    if (preview) {
      create += 1;
      results.push({ row: t._row ?? 0, name: t.name, action: 'create' });
      continue;
    }
    try {
      // _row 는 buildTemplate 이 읽지 않는 키라 저장되지 않지만, 입력을 명시적으로 추려 넘긴다.
      const made = addTemplate({ name: t.name, desc: t.desc, kind: t.kind, items: t.items }, { user });
      create += 1;
      existing.add(nameKey);
      results.push({ row: t._row ?? 0, name: t.name, action: 'create', id: made.id });
    } catch (e) {
      errors.push({ row: t._row ?? 0, name: t.name, reason: e.message });
      results.push({ row: t._row ?? 0, name: t.name, action: 'error', reason: e.message });
    }
  }

  const out = { mode: preview ? 'preview' : 'add', create, skip, errors, results };
  if (preview) out.notice = PREVIEW_NOTICE;
  return out;
}

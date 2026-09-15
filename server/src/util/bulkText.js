/**
 * util/bulkText.js — 대량 등록용 **자유텍스트** 파싱/직렬화(순수, v2.513).
 *
 * 사용자 요청(2026-09-15): "다수의 스토리지 입력을 위한 csv 와 free text 를 사용한 import/export
 * 기능 추가하고, sample download 기능 추가" + "san switch 도 같은 메뉴".
 *
 * ── 왜 CSV 말고 자유텍스트가 따로 필요한가 ───────────────────────────────────
 * CSV 가져오기는 이미 있다(`storage/csv.js`, v2.313). 그런데 현장에서 장비 목록이 오는 형태는
 * 위키 표·메일 본문·엑셀 한 컬럼처럼 **헤더가 없고 구분자도 뒤섞인 텍스트**다. 그걸 CSV 로
 * 고쳐 만드는 일이 실제 병목이라, 붙여넣은 그대로 받는 경로를 둔다.
 *
 * ── 형식(사내 선례 `web/src/views/svcmon/bulkRows.js parseFree` 규약을 따른다) ──
 *  · 한 줄 = 한 장비. 빈 줄과 `#` 로 시작하는 줄은 건너뛴다.
 *  · **위치형**: 구분자로 쪼갠 토큰을 `fields` 순서에 대입.
 *      isilon  WA-Isilon-01  10.20.0.50  root
 *  · **키=값형**: 한 줄에 `key=value` 또는 `key: value` 가 섞여 있으면 그 줄은 키로 해석한다.
 *      name=WA-Isilon-01 host=10.20.0.50 type=isilon
 *    → 일부 필드만 아는 줄을 위치형으로 억지로 채우지 않아도 된다.
 *  · **헤더 줄**(선택): 첫 유효 줄의 토큰이 **전부** 필드명/별칭이면 그 줄을 열 순서로 쓴다.
 *    엑셀에서 헤더까지 복사해 붙이는 흔한 경우를 살린다.
 *  · 기본값(`defaults`)은 **빈 필드만** 채운다 — 줄에 적힌 값을 덮지 않는다.
 *
 * ⚠ 구분자 판정 순서가 중요하다: **탭 → `|` → 쉼표 → 연속 공백**.
 *   공백을 먼저 보면 `WA Isilon 01` 처럼 **값 안의 공백**이 열 경계로 오해된다. 탭·파이프·쉼표가
 *   하나라도 있으면 그것이 작성자의 의도이므로 공백 분리를 쓰지 않는다. 반대로 순서를 바꾸면
 *   엑셀 붙여넣기(탭)가 전부 깨진다.
 *
 * 보안·안정성(CSV 경로와 같은 계약):
 *  · 행 수·셀 길이 상한 — 붙여넣기 한 번으로 동기 파싱이 이벤트 루프를 잡지 않게.
 *  · 제어문자(개행·탭 외)는 값에서 제거 — 비밀번호·셸 인자로 흘러가는 필드가 있어서다
 *    (registry 들이 제어문자 비밀번호를 거부하지만, 여기서 먼저 걸러 오류 메시지를 명확히 한다).
 *  · 내보내기는 **비밀번호를 담지 않는다** — 호출부가 값을 비운 행을 넘긴다(CSV 규약과 동일).
 */

/** 값에서 제어문자를 제거하고 트림. 자유텍스트는 어디서 복사돼 올지 모른다(NBSP 포함). */
function clean(v) {
  return String(v ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')   // eslint-disable-line no-control-regex
    .replace(/\u00a0/g, ' ')                 // NBSP(위키·웹 표 복사에서 흔하다) → 일반 공백
    .trim();
}

/**
 * 키 이름 문자 — **유니코드 글자를 허용한다**. 별칭이 한글(`계정=root`·`타입=isilon`)이라
 * ASCII 로 제한하면 한글 키가 전부 무시된다(테스트가 잡은 실제 버그).
 */
const KEY_CH = '[\\p{L}_][\\p{L}\\p{N}_]*';

/** `key=value` / `key: value` 한 쌍. 값에 `=`·`:` 가 더 있어도 첫 구분자만 쓴다(URL·시각 값 보존). */
const KV_RE = new RegExp(`^(${KEY_CH})\\s*[=:]\\s*(.*)$`, 'u');

/**
 * 그 줄이 키=값 형식인가.
 *
 * ⚠ 단순히 `KV_RE.test` 로 판정하면 **URL 이 든 줄이 통째로 사라진다**(실측한 실제 결함):
 *   `https://10.30.0.14/` 는 `https` + `:` 라 KV 모양에 걸려 그 줄이 키형으로 해석되고,
 *   `https` 는 알려진 필드가 아니니 값이 하나도 안 잡혀 `name`·`host` 가 비고 → 행 자체가
 *   걸러졌다. 사용자가 적은 장비가 **경고도 없이** 없어진다.
 *   그래서 `:` 구분자는 **알려진 필드/별칭일 때만** 키로 인정한다(`=` 는 값에 거의 없으므로
 *   모르는 이름도 키로 본다 — 오타 키를 경고하기 위해). parseKeyed 의 규칙과 같다.
 */
function looksKeyed(tokens, aliasOf) {
  return tokens.some((t) => {
    const m = KV_RE.exec(t);
    if (!m) return false;
    return t.includes('=') ? true : !!aliasOf(m[1]);
  });
}

/**
 * 공백 분리 — **따옴표를 존중한다.** 내보내기(`rowsToFreeText`)가 공백 포함 값을 `"` 로 감싸
 * 정렬된 표로 만들기 때문에, 단순 `split(/\s+/)` 로는 그 값이 쪼개져 왕복이 깨진다
 * (테스트가 잡은 실제 버그). 사람이 직접 `"내 장비 01" 10.0.0.1` 로 적는 경우도 함께 살린다.
 */
function splitWs(s) {
  const out = [];
  let cur = '';
  let q = false;
  for (const ch of String(s)) {
    if (ch === '"') { q = !q; continue; }         // 따옴표는 경계 표시일 뿐 값에 넣지 않는다
    if (!q && /\s/.test(ch)) { if (cur) { out.push(cur); cur = ''; } continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * 줄을 토큰으로 쪼갠다. 구분자 판정 순서는 위 주석 참조(탭 → | → 쉼표 → 연속 공백).
 */
/**
 * 한 줄 → 칸 배열 + **구분자가 명시적인지**(v2.516).
 *
 * 왜 이 구분이 필요한가: 탭·`|`·쉼표는 **빈 칸을 표현할 수 있는** 구분자다(`a\t\tb` = 가운데 칸 비움).
 * 공백은 아니다(연속 공백은 그냥 한 칸 띄운 것). 그래서 호출부가 빈 토큰을 버려도 되는지 알아야 한다 —
 * 예전에는 무조건 버려서 **엑셀에서 중간 칸을 비운 채 복사하면 뒤 값이 한 칸씩 밀렸다**
 * (사용자 신고: "vfId 는 선택 사양인데 빼고 넣으면 입력이 안 된다" — vfId 칸에 다음 값인
 *  법인 'WA' 가 들어가 'Virtual Fabric ID 는 1~128' 오류가 났다. 경고도 없었다).
 *
 * @returns {{cells:string[], explicit:boolean}}
 */
export function splitCells(line) {
  const s = String(line);
  if (s.includes('\t')) return { cells: s.split('\t').map(clean), explicit: true };
  if (s.includes('|')) return { cells: s.split('|').map(clean), explicit: true };
  if (s.includes(',')) return { cells: s.split(',').map(clean), explicit: true };
  return { cells: splitWs(s.trim()).map(clean), explicit: false };
}

/** 호환용 — 빈 칸 정보가 필요 없는 곳(조언의 토큰 위치 계산 등)에서 쓴다. */
export function splitLine(line) {
  return splitCells(line).cells;
}

/**
 * 키형 줄 → 객체. 값 안의 공백을 살리려고 다음 키 직전까지를 값으로 본다.
 *
 * ⚠ `=` 와 `:` 를 다르게 취급한다 — 이유가 있다:
 *   · `=` 는 값에 거의 안 나오므로 **모르는 이름이어도 키 경계**로 본다(그래서 오타 키를 경고할 수 있다).
 *   · `:` 는 값에 흔하다 — WWN(`50:06:01:…`)·시각(`12:30`)·URL(`host:443`). 그래서 `:` 는
 *     **알려진 필드/별칭일 때만** 키 경계로 본다. 이 구분을 없애면 `note: a:b:c` 의 `a:` 가
 *     키로 오인돼 note 값이 사라진다(테스트가 잡은 실제 버그).
 */
export function parseKeyed(line, { aliasOf }) {
  const s = clean(String(line).replace(/[\t\v\f\r]+/g, ' '));
  const starts = [];
  const re = new RegExp(`(^|\\s)(${KEY_CH})\\s*([=:])`, 'gu');
  let m;
  while ((m = re.exec(s)) !== null) {
    const key = m[2]; const sep = m[3];
    if (sep === ':' && !aliasOf(key)) continue;   // 위 주석 — 값 안의 콜론을 키로 오인하지 않는다
    starts.push({ at: m.index + m[1].length, key, valueFrom: re.lastIndex });
  }
  const out = {};
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1].at : s.length;
    const field = aliasOf(starts[i].key);
    if (!field) continue;                                  // 모르는 키는 조용히 버리지 않고…
    out[field] = clean(s.slice(starts[i].valueFrom, end));
  }
  // 인식 못 한 키를 호출부가 알 수 있게 목록으로 돌려준다(조용한 무시 금지).
  const unknown = starts.map((x) => x.key).filter((k) => !aliasOf(k));
  return { values: out, unknown };
}

export const LIMITS = { maxRows: 2000, maxCell: 8192, maxLines: 20000 };

/**
 * 자유텍스트 → 행 배열.
 *
 * @param {string} text 붙여넣은 원문
 * @param {{fields:string[], aliases?:Object<string,string>, defaults?:Object,
 *          limits?:{maxRows?:number,maxCell?:number,maxLines?:number}}} spec
 *   · `fields`   위치형 대입 순서이자 허용 필드 목록
 *   · `aliases`  별칭 → 필드명(소문자 키). 필드명 자체도 자동으로 별칭이 된다
 *   · `defaults` 빈 필드에만 채우는 공통값
 * @returns {{rows:Array<Object>, error?:string, warnings:string[], headerUsed:string[]|null}}
 *   각 행에 `_line`(사람용 원문 줄 번호)이 붙는다 — 드라이런 표가 그 번호로 오류를 가리킨다.
 */
export function parseFreeRows(text, { fields, aliases = {}, defaults = {}, limits = {} } = {}) {
  const lim = { ...LIMITS, ...limits };
  const aliasMap = new Map();
  for (const f of fields) aliasMap.set(f.toLowerCase(), f);
  for (const [a, f] of Object.entries(aliases)) aliasMap.set(String(a).toLowerCase(), f);
  const aliasOf = (k) => aliasMap.get(String(k).toLowerCase()) || null;

  const raw = String(text ?? '');
  const lines = raw.split(/\r?\n/);
  if (lines.length > lim.maxLines) return { rows: [], warnings: [], headerUsed: null, error: `줄이 너무 많습니다(${lines.length} > ${lim.maxLines}). 파일을 나눠 올리세요.` };

  const warnings = [];
  const rows = [];
  let order = fields;          // 위치형 대입 순서(헤더 줄이 있으면 교체)
  let headerUsed = null;
  let sawData = false;

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i];
    if (!clean(line)) continue;
    if (/^\s*#/.test(line)) continue;                       // 주석

    // v2.516: 명시적 구분자(탭·|·쉼표)에서는 **빈 칸을 유지**한다 — 그 자체가 '이 열은 비움' 이라는
    // 정보다. 무조건 버리면 중간 칸을 비운 줄의 뒤 값이 한 칸씩 밀린다(splitCells 머리말 참조).
    // 공백 구분은 빈 토큰이 의미 없으므로 계속 버린다.
    const { cells, explicit } = splitCells(line);
    // 뒤쪽 빈 칸은 떼어낸다(`a\tb\t` 처럼 줄 끝에 구분자가 남은 경우 — 열 개수 초과 경고 오탐 방지).
    const trimmed = [...cells];
    while (trimmed.length && trimmed[trimmed.length - 1] === '') trimmed.pop();
    const tokens = explicit ? trimmed : trimmed.filter((t) => t !== '');
    // 헤더 판정·키형 판정은 **값이 있는 칸만** 본다(빈 칸이 섞이면 둘 다 거짓이 된다).
    const filled = tokens.filter((t) => t !== '');
    if (!filled.length) continue;

    // 헤더 줄 — 토큰이 **전부** 알려진 필드명/별칭일 때만.
    // (한 토큰이라도 모르면 데이터로 본다 — 'isilon WA-01 …' 같은 줄을 헤더로 삼키지 않게.
    //  장비 이름이 정확히 'name', host 가 정확히 'host' 인 경우는 현실에 없다고 본다.)
    //
    // ⚠ **파일 중간의 헤더도 받는다.** '데이터가 나오기 전' 으로 제한했더니, 세 표기를 한 파일에
    //   담은 샘플(위치형 → 키=값 → 헤더형)에서 마지막 헤더가 **데이터 행으로 파싱돼 쓰레기 행이
    //   생겼다**(`type='host'`). 샘플을 그대로 가져오면 오류가 나는 상태였다. 중간 헤더는 '여기부터
    //   열 순서가 바뀐다' 는 뜻이고, 섞어 붙여넣는 실제 사용에도 맞다. 조용히 바뀌면 혼란스러우니
    //   경고로 알린다.
    if (filled.length >= 2 && filled.every((t) => aliasOf(t))) {
      order = filled.map((t) => aliasOf(t));
      if (!headerUsed) headerUsed = order;                 // 화면이 보여 줄 '해석에 쓴 열 순서'
      if (sawData) warnings.push(`${lineNo}줄: 열 순서를 '${order.join(' ')}' 로 바꿔 이후 줄을 읽습니다.`);
      continue;
    }

    if (rows.length >= lim.maxRows) {
      warnings.push(`행 상한 ${lim.maxRows} 를 넘어 이후 줄은 읽지 않았습니다(${lines.length - i}줄 남음).`);
      break;
    }

    let values = {};
    if (looksKeyed(filled, aliasOf)) {
      const k = parseKeyed(line, { aliasOf });
      values = k.values;
      if (k.unknown.length) warnings.push(`${lineNo}줄: 알 수 없는 키 ${k.unknown.map((x) => `'${x}'`).join(', ')} — 무시했습니다.`);
      // 안전망: 키형으로 봤는데 알아본 필드가 하나도 없으면 **위치형으로 되돌린다**.
      // 그냥 두면 빈 행이 되어 호출부의 'name·host 없는 행 스킵' 에 걸려 조용히 사라진다.
      if (!Object.keys(values).length) {
        warnings.push(`${lineNo}줄: 키=값 으로 읽히지 않아 순서대로 해석했습니다.`);
        order.forEach((f, n) => { if (tokens[n] != null) values[f] = tokens[n]; });
      }
    } else {
      if (tokens.length > order.length) {
        warnings.push(`${lineNo}줄: 항목이 ${tokens.length}개인데 열은 ${order.length}개입니다 — 뒤 ${tokens.length - order.length}개를 무시했습니다.`);
      }
      order.forEach((f, n) => { if (tokens[n] != null) values[f] = tokens[n]; });
    }

    // 셀 길이 상한 — 초과는 자르고 **자른 사실을 알린다**(조용한 절단 금지).
    for (const f of Object.keys(values)) {
      if (values[f].length > lim.maxCell) {
        values[f] = values[f].slice(0, lim.maxCell);
        warnings.push(`${lineNo}줄: '${f}' 값이 ${lim.maxCell}자를 넘어 잘랐습니다.`);
      }
    }
    // 기본값은 **빈 필드만** 채운다(줄에 적힌 값을 덮지 않는다).
    const row = { _line: lineNo };
    for (const f of fields) {
      const v = values[f];
      row[f] = (v == null || v === '') ? (defaults[f] ?? '') : v;
    }
    rows.push(row);
    sawData = true;
  }

  if (!rows.length) return { rows: [], warnings, headerUsed, error: '읽을 수 있는 줄이 없습니다(빈 줄·주석만 있거나 형식을 인식하지 못했습니다).' };
  return { rows, warnings, headerUsed };
}

/**
 * 행 배열 → 자유텍스트(열 폭을 맞춘 읽기 쉬운 표). 티켓·메일에 그대로 붙이는 용도라
 * 구분자는 **연속 공백 2칸**이고, 값에 공백이 있으면 그 값만 `"` 로 감싼다(다시 가져올 때
 * 위치형 파서가 열을 헷갈리지 않게 — 파서는 쉼표/탭이 없으면 공백으로 쪼갠다).
 *
 * ⚠ 값이 비면 `-` 를 넣는다. 빈칸을 그대로 두면 열이 밀려 왕복(export→편집→import)이 깨진다.
 *   가져오기 쪽은 `-` 를 빈 값으로 되돌린다(`EMPTY_MARK`).
 */
export const EMPTY_MARK = '-';

export function rowsToFreeText(rows, fields, { header = true, comment = '' } = {}) {
  const cellOf = (r, f) => {
    const v = clean(r?.[f]);
    if (!v) return EMPTY_MARK;
    return /[\s|,]/.test(v) ? `"${v.replace(/"/g, "'")}"` : v;
  };
  const table = rows.map((r) => fields.map((f) => cellOf(r, f)));
  const head = header ? [fields.slice()] : [];
  const width = fields.map((f, i) => Math.max(...[...head, ...table].map((row) => (row[i] || '').length), f.length));
  const fmt = (row) => row.map((c, i) => String(c).padEnd(i === row.length - 1 ? 0 : width[i])).join('  ').replace(/\s+$/, '');
  const out = [];
  if (comment) for (const l of String(comment).split('\n')) out.push(`# ${l}`);
  if (header) out.push(`# ${fmt(fields)}`);   // 헤더는 주석으로 — 되가져올 때 데이터로 오해되지 않는다
  for (const row of table) out.push(fmt(row));
  return out.join('\n') + '\n';
}

/** 가져오기 시 `-`(빈칸 표시)를 빈 문자열로 되돌린다 — rowsToFreeText 의 역변환. */
export function unmark(v) {
  const s = String(v ?? '').trim();
  if (s === EMPTY_MARK) return '';
  // 내보내기가 감싼 인용부호 해제(값 안의 공백 보존용).
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') return s.slice(1, -1);
  return s;
}

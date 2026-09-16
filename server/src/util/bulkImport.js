/**
 * util/bulkImport.js — 대량 가져오기 **드라이런 판정**의 공용 코어(순수, v2.513).
 *
 * v2.313 에 스토리지가 먼저 가졌던 `storage/csv.js analyzeImport` 를 일반화한 것이다. SAN 스위치도
 * 같은 기능을 요구받았을 때(사용자: "san switch 도 같은 메뉴") 20줄을 복사하면 **두 판정이 갈라진다** —
 * 실제로 이 저장소는 그 유형의 사고를 겪었다(CLAUDE.md `version_3`↔`console` 58~87% 중복,
 * v2.506 svcmon 권한 버그를 두 곳에 고쳐야 했던 일). 그래서 코어는 여기 하나다.
 *
 * 도구마다 다른 것은 **주입**한다:
 *  · `keyOf(row)`   동일 장비 식별 키 — 스토리지는 `host+type`, SAN 스위치는 **`host` 단독**
 *                   (`sanswitch/registry.js saveDevice` 가 host 중복을 거부한다). 이걸 틀리면
 *                   멱등성이 깨져 export→편집→import 왕복이 장비를 복제하거나 덮어쓴다.
 *  · `keyLabel`     오류 문구에 쓸 키 이름('host+type' / 'host')
 *  · `quickIssue`   빠른 로컬 검사(타입 구현 여부 등)
 *  · `toInput(row)` registry 검증에 넘길 입력 객체 — **실제 저장과 같은 형태**여야 한다
 *                   (규칙 단일 소스: 드라이런 통과 = 실제 저장 성공)
 *  · `existing(row)` 이미 등록돼 있는가 → add/update 판정
 *  · `validate`     registry 의 `deviceInputIssue`(진실의 원천 — 여기서 복제하지 않는다)
 */

import { adviseRow, preflightHints } from './bulkAdvice.js';

/**
 * @returns {{report:Array, summary:{add:number,update:number,error:number,withPassword:number}}}
 *   report 항목: `{line, name, host, type, hasPassword, action:'add'|'update'|'error', reason}`
 */
export function analyzeBulkImport(rows, { keyOf, keyLabel = 'host', quickIssue, toInput, existing, validate }) {
  const seenInFile = new Map();   // 키 → 첫 등장 행 번호(파일 내 중복 검출)
  const report = [];
  const summary = { add: 0, update: 0, error: 0, withPassword: 0 };
  for (const row of rows) {
    const base = { line: row._line, name: row.name || row.host, host: row.host, type: row.type, hasPassword: !!row._hasPassword };
    const quick = quickIssue(row);
    const k = keyOf(row);
    const dupLine = seenInFile.get(k);
    let action = 'error'; let reason = null;
    if (quick) reason = quick;
    else if (dupLine) reason = `파일 내 중복 — ${dupLine}행과 같은 ${keyLabel}(어느 행이 저장될지 모호)`;
    else {
      reason = validate(toInput(row));
      if (!reason) action = existing(row) ? 'update' : 'add';
    }
    if (!dupLine) seenInFile.set(k, row._line);
    if (row._hasPassword && action !== 'error') summary.withPassword++;
    summary[action === 'error' ? 'error' : action]++;
    report.push({ ...base, action, reason });
  }
  return { report, summary };
}

/**
 * 오류 행에 **'어디를 어떻게 고쳐라'** 를 붙인다(사용자 요청 — v2.513).
 * 판정을 다시 하지 않고 `report` 를 장식만 한다 — 검증 단일 소스를 건드리지 않기 위해서다.
 *
 * @param {Array} report analyzeBulkImport 결과
 * @param {Array} rows   파싱된 행(같은 순서일 필요 없음 — `_line` 으로 맞춘다)
 * @param {{text?:string, order?:string[], format?:'csv'|'text', ctx?:object, fields?:string[]}} o
 *   · `text`   원문 전체 — 줄 번호로 해당 줄을 떼어 토큰 위치를 계산한다(없으면 위치 안내 생략)
 *   · `order`  위치형 열 순서(자유텍스트 헤더가 있으면 그 순서)
 * @returns {{report:Array, hints:Array}} report 는 `advice`·`field`·`token`·`expected` 가 붙은 새 배열
 */
export function enrichAdvice(report, rows, { text = '', order = [], format = 'text', ctx = {}, fields = [], hostForm = 'address' } = {}) {
  const lines = String(text || '').split(/\r?\n/);
  const rowByLine = new Map((rows || []).map((r) => [r._line, r]));
  const out = (report || []).map((item) => {
    if (item.action !== 'error') return { ...item };
    const row = rowByLine.get(item.line) || { _line: item.line };
    const lineText = lines[item.line - 1] ?? '';
    const a = adviseRow(row, item.reason, { lineText, order, format, ctx });
    return { ...item, field: a.field, advice: a.advice, token: a.token, expected: a.expected, current: a.current };
  });
  // `hostForm` — 도구마다 host 의 정답 형식이 다르다(Horizon 은 URL 필수). 틀린 조언을
  // 내보내지 않기 위해 호출부가 알려준다(v2.525).
  return { report: out, hints: preflightHints(rows || [], fields, { hostForm }) };
}

/**
 * '검증을 통과한 일부만 등록'(사용자 요청 — v2.513) 을 위한 행 선별.
 *
 * @param {Array} rows          파싱된 행
 * @param {Array} report        드라이런 판정
 * @param {{lines?:number[]|null, requireTested?:number[]|null}} sel
 *   · `lines`         사용자가 화면에서 고른 줄 번호(없으면 '오류 아닌 전부')
 *   · `requireTested` 연결 테스트를 통과한 줄 번호(주면 **교집합**만 남긴다)
 * @returns {{picked:Array, skipped:Array<{line:number,reason:string}>}}
 *   ⚠ 걸러낸 행은 **버리지 않고 사유와 함께 돌려준다** — 사용자가 '왜 12건만 등록됐는지' 알아야 한다.
 */
export function selectRows(rows, report, { lines = null, requireTested = null } = {}) {
  const actionOf = new Map((report || []).map((r) => [r.line, r]));
  const wanted = lines ? new Set(lines.map(Number)) : null;
  const tested = requireTested ? new Set(requireTested.map(Number)) : null;
  const picked = []; const skipped = [];
  for (const row of rows || []) {
    const rep = actionOf.get(row._line);
    if (!rep || rep.action === 'error') { skipped.push({ line: row._line, reason: rep?.reason || '검증 결과 없음' }); continue; }
    if (wanted && !wanted.has(row._line)) { skipped.push({ line: row._line, reason: '선택하지 않음' }); continue; }
    if (tested && !tested.has(row._line)) { skipped.push({ line: row._line, reason: '연결 테스트 미통과(또는 미실행)' }); continue; }
    picked.push(row);
  }
  return { picked, skipped };
}

/**
 * util/bulkAdvice.js — 대량 가져오기 실패를 **'텍스트의 어디를 어떻게 고쳐라'** 로 바꾼다(순수, v2.513).
 *
 * 사용자 요청(2026-09-15): "실패한 부분을 text 의 어떤 부분을 고치라고 조언하는 기능".
 *
 * 왜 별도 모듈인가: 검증 메시지는 registry(`deviceInputIssue`)가 만들고 그 문구는 **저장 경로의
 * 진실**이라 바꾸면 안 된다. 그런데 그 문구는 "host 형식 오류" 처럼 *무엇이* 틀렸는지만 말하고
 * *어느 줄 몇 번째 항목을* 고쳐야 하는지는 말하지 않는다. 그 간극만 여기서 채운다 —
 * 검증 로직을 복제하지 않는다(복제하면 두 판정이 갈라진다).
 *
 * 규약:
 *  · 조언은 **추측을 사실로 말하지 않는다**. 어느 필드인지 특정 못 하면 `field:null` 로 두고
 *    일반 안내만 한다(엉뚱한 열을 고치라고 하면 사용자가 멀쩡한 값을 망친다).
 *  · 원문 줄과 그 줄에서의 **토큰 위치**(`col`, 1부터)를 함께 준다 — 화면이 그 토큰만 강조한다.
 *  · 고칠 값의 **후보**(`expected`)가 유한하면 함께 준다(타입·수집방식·true/false 등).
 */

import { splitLine } from './bulkText.js';


/** 받침 유무로 조사를 고른다 — '항목를'·'하나으로' 같은 어색한 문구를 막는다. */
function hasJong(word) {
  const ch = String(word || '').trim().slice(-1);
  const code = ch.charCodeAt(0);
  if (Number.isNaN(code) || code < 0xac00 || code > 0xd7a3) return true;   // 한글 아니면 받침 있다고 본다(영문·숫자)
  return (code - 0xac00) % 28 !== 0;
}
const eulReul = (w) => (hasJong(w) ? '을' : '를');
const euRo = (w) => (hasJong(w) ? '으로' : '로');

/**
 * 검증 메시지 → 어느 필드 문제인지. registry 문구를 **부분 일치**로 본다(문구가 조금 바뀌어도
 * 조언이 죽지 않게). 매칭 실패는 null — 지어내지 않는다.
 */
const FIELD_RULES = [
  { field: 'type', re: /타입|type/i },
  { field: 'host', re: /host|ip|차단/i },
  { field: 'name', re: /표시명|name/i },
  { field: 'username', re: /계정|username|user/i },
  { field: 'password', re: /비밀번호|password/i },
  { field: 'sshPort', re: /sshport/i },
  { field: 'httpsPort', re: /httpsport/i },
  { field: 'vfId', re: /virtual fabric|vfid/i },
  { field: 'collectMethod', re: /수집\s*방식|collectmethod/i },
  { field: 'agent', re: /엣지|agent/i },
  { field: 'datacenter', re: /법인|datacenter/i },
];

export function fieldOfIssue(issue) {
  const s = String(issue || '');
  // ⚠ '파일 내 중복' 은 **값이 틀린 게 아니라 줄이 겹친 것**이다. 아래 FIELD_RULES 에 맡기면
  //   메시지에 'host' 가 들어 있어 "host 형식을 고치세요" 라는 **틀린 조언**이 나간다(실측).
  //   틀린 조언은 조언이 없는 것보다 나쁘다 — 사용자가 멀쩡한 값을 고친다.
  if (/파일 내 중복/.test(s)) return null;
  // sshPort/httpsPort 를 port 일반 규칙보다 먼저 보도록 순서에 의존한다(위 배열 순서 유지).
  for (const r of FIELD_RULES) if (r.re.test(s)) return r.field;
  return null;
}

/** 필드로 환원되지 않는 문제의 조언(중복 등). 없으면 null. */
export function specialAdvice(issue) {
  const s = String(issue || '');
  const m = s.match(/파일 내 중복 — (\d+)행/);
  if (m) return `이 줄은 ${m[1]}줄과 같은 장비를 가리킵니다 — 둘 중 **하나를 지우거나** host 를 올바른 값으로 고치세요(어느 쪽이 저장될지 모호해 저장하지 않았습니다).`;
  return null;
}

/** 필드별 '무엇으로 고쳐야 하는가' — 값 후보가 유한한 것만. 나머지는 형식 설명. */
export function expectationFor(field, { types = [], agents = [], datacenters = [] } = {}) {
  switch (field) {
    case 'type': return { kind: 'enum', values: types, hint: '구현된 타입 중 하나' };
    case 'collectMethod': return { kind: 'enum', values: ['ssh', 'api'], hint: 'ssh 또는 api' };
    case 'enabled': return { kind: 'enum', values: ['true', 'false'], hint: 'true 또는 false' };
    case 'agent': return { kind: 'enum', values: ['', ...agents], hint: '엣지 이름(비우면 중앙 직접 수집)' };
    case 'datacenter': return { kind: 'enum', values: datacenters, hint: '법인 이름 또는 ID' };
    case 'host': return { kind: 'format', hint: 'IP 또는 호스트명만 — 공백·URL(http://)·포트(:443)·선행 `-` 는 넣지 않습니다' };
    case 'name': return { kind: 'format', hint: `1~64자, < > " ' 는 쓸 수 없습니다` };
    case 'username': return { kind: 'format', hint: '접속 계정(비울 수 없습니다)' };
    case 'password': return { kind: 'format', hint: '한 줄 문자열 — 개행·탭이 섞이지 않게(붙여넣기 확인). 비우면 기존 비밀번호를 유지합니다' };
    case 'sshPort': return { kind: 'format', hint: '1~65535 정수(기본 22)' };
    case 'httpsPort': return { kind: 'format', hint: '1~65535 정수(기본 443)' };
    case 'vfId': return { kind: 'format', hint: '1~128 정수 또는 비움' };
    default: return { kind: 'none', hint: '' };
  }
}

/**
 * 그 줄에서 문제 필드가 **몇 번째 토큰**인지. 자유텍스트 위치형에서만 의미가 있고,
 * 키=값 줄이면 `key=` 를 찾아 그 위치를 돌려준다. 못 찾으면 null(강조하지 않는다).
 *
 * @param {string} lineText 원문 한 줄
 * @param {string} field 문제 필드
 * @param {string[]} order 위치형 열 순서(헤더가 있으면 그 순서)
 */
export function tokenPos(lineText, field, order = []) {
  const s = String(lineText || '');
  if (!s || !field) return null;
  const kv = new RegExp(`(^|\\s)${field}\\s*[=:]`, 'i').exec(s);
  if (kv) return { col: null, at: kv.index + kv[1].length, len: field.length, form: 'keyed' };
  const i = order.indexOf(field);
  if (i < 0) return null;
  const tokens = splitLine(s).filter((t) => t !== '');
  if (i >= tokens.length) return { col: i + 1, at: null, len: 0, form: 'missing' };  // 항목 자체가 없다
  return { col: i + 1, at: null, len: String(tokens[i]).length, form: 'positional' };
}

/**
 * 행 하나의 조언 만들기.
 *
 * @param {{_line:number, [k:string]:any}} row  파싱된 행
 * @param {string} issue  registry 검증 메시지(진실의 원천 — 그대로 보존해 함께 싣는다)
 * @param {{lineText?:string, order?:string[], format?:'csv'|'text', ctx?:object}} opts
 * @returns {{line:number, field:string|null, issue:string, advice:string,
 *            token:{col:number|null,at:number|null,len:number,form:string}|null,
 *            expected:{kind:string,values?:string[],hint:string}, current:string}}
 */
export function adviseRow(row, issue, { lineText = '', order = [], format = 'text', ctx = {} } = {}) {
  const field = fieldOfIssue(issue);
  const expected = expectationFor(field, ctx);
  const token = field ? tokenPos(lineText, field, order) : null;
  const current = field ? String(row?.[field] ?? '') : '';

  // 위치 안내 — 형식(csv/text)과 토큰 형태에 따라 말이 달라진다. 특정 못 하면 말하지 않는다.
  let where;
  if (!field) where = `${row?._line ?? '?'}줄`;
  else if (token?.form === 'keyed') where = `${row._line}줄의 \`${field}=\` 값`;
  else if (token?.form === 'missing') where = format === 'csv' ? `${row._line}줄의 '${field}' 열(값이 비어 있습니다)` : `${row._line}줄 — '${field}' 항목이 아예 없습니다(${token.col}번째 항목)`;
  else if (token?.form === 'positional') where = format === 'csv' ? `${row._line}줄의 '${field}' 열` : `${row._line}줄의 ${token.col}번째 항목`;
  else where = format === 'csv' ? `${row._line}줄의 '${field}' 열` : `${row._line}줄의 '${field}'`;

  // 필드로 환원되지 않는 문제(파일 내 중복 등)는 전용 문구를 쓴다 — 엉뚱한 열을 지목하지 않는다.
  const special = specialAdvice(issue);
  if (special) {
    return { line: row?._line ?? 0, field: null, issue: String(issue || ''),
      advice: `${row?._line ?? '?'}줄: ${special}`, token: null, expected: { kind: 'none', hint: '' }, current: '' };
  }

  const nowPart = field ? (current ? ` 현재 값은 \`${current}\` 입니다.` : ' 현재 값이 비어 있습니다.') : '';
  let fixPart = '';
  if (expected.kind === 'enum' && expected.values?.length) {
    const shown = expected.values.filter((v) => v !== '').slice(0, 8);
    fixPart = ` ${expected.hint}${euRo(expected.hint)} 고치세요 — ${shown.map((v) => `\`${v}\``).join(' · ')}${expected.values.length > shown.length + (expected.values.includes('') ? 1 : 0) ? ' …' : ''}`;
  } else if (expected.hint) {
    fixPart = ` ${expected.hint}.`;
  } else {
    fixPart = ' 오류 메시지를 보고 그 줄을 고치세요.';
  }

  return {
    line: row?._line ?? 0,
    field, issue: String(issue || ''),
    advice: `${where}${eulReul(where)} 고쳐야 합니다.${nowPart}${fixPart}`,
    token, expected, current,
  };
}

/**
 * 흔한 실수 패턴을 **검증 전에** 미리 잡아 조언한다 — registry 메시지만으로는 원인을 알기
 * 어려운 것들이다. 실제로 본 형태만 넣는다(지어낸 규칙 금지).
 *  · `https://10.0.0.1` 처럼 URL 을 host 에 넣음
 *  · `10.0.0.1:22` 처럼 host 에 포트를 붙임
 *  · 전각 공백·전각 콜론(한글 문서에서 복사하면 섞인다)
 *  · 스마트 인용부호(워드·메일에서 복사)
 * @returns {Array<{line:number, field:string, advice:string, severity:'warn'}>}
 */
export function preflightHints(rows, fields = []) {
  const out = [];
  const push = (line, field, advice) => out.push({ line, field, advice, severity: 'warn' });
  for (const r of rows || []) {
    for (const f of fields) {
      const v = String(r?.[f] ?? '');
      if (!v) continue;
      if (/[＀-￯　]/.test(v)) push(r._line, f, `${r._line}줄 '${f}' 에 전각 문자(　：Ａ 등)가 있습니다 — 반각으로 고치세요.`);
      if (/[‘’“”]/.test(v)) push(r._line, f, `${r._line}줄 '${f}' 에 스마트 인용부호(‘ ’ “ ”)가 있습니다 — 워드·메일에서 복사한 흔적입니다. 보통 따옴표로 바꾸거나 지우세요.`);
    }
    const host = String(r?.host ?? '');
    if (/^https?:\/\//i.test(host)) push(r._line, 'host', `${r._line}줄 host 에 URL 이 들어갔습니다 — \`${host.replace(/^https?:\/\//i, '').replace(/\/.*$/, '')}\` 처럼 주소만 남기세요.`);
    else if (/^[^:]+:\d+$/.test(host)) push(r._line, 'host', `${r._line}줄 host 에 포트가 붙어 있습니다 — 주소는 \`${host.split(':')[0]}\`, 포트는 sshPort/httpsPort 열에 따로 적으세요.`);
    if (/\/$/.test(host)) push(r._line, 'host', `${r._line}줄 host 끝에 \`/\` 가 있습니다 — 지우세요.`);
  }
  return out;
}

/**
 * curuser/quser.js — Windows `quser`(= `query user`) 출력 파서(v2.520, 순수 모듈).
 *
 * 사용자 요청(2026-09-15): "vcenter 별로 사용자가 설정에서 지정한 폴더의 windows 서버에서
 * 로그인한 사용자의 수를 설정에서 지정한 시간마다 수집" + "활성/연결끊김 둘 다 보여주기".
 *
 * ── 왜 이 파싱이 까다로운가(설계 근거) ──────────────────────────────────────────
 * ① **연결 끊긴 세션은 SESSIONNAME 칸이 비어 열이 밀린다.** 공백 기준으로 토큰을 끊으면
 *    STATE 자리에 IDLE TIME 이 들어와 '활성' 판정이 통째로 틀린다. 그래서 **헤더 줄의 열
 *    시작 위치**를 읽어 **고정폭으로 잘라낸다**(quser 출력은 열 정렬 고정폭이다).
 * ② **한국어 Windows 는 상태를 지역화한다** — `활성` / `연결 끊김`. 영문은 `Active` / `Disc`.
 *    열 이름도 `사용자이름`·`상태` 로 바뀌므로 **이름이 아니라 위치**로 자른다.
 * ③ 세션이 하나도 없으면 `quser` 는 **비정상 종료 + "No User exists for *"**(한국어:
 *    "사용자가 없습니다") 를 낸다. 그것은 오류가 아니라 **사용자 0명**이다 — 실패로 보고하면
 *    화면이 '수집 실패' 로 뒤덮인다.
 *
 * ⚠ 알 수 없는 상태 문자열은 `other` 로 센다(합계에는 포함, 활성/연결끊김에는 넣지 않는다).
 *   억지로 활성에 넣으면 사용자 수를 과대표시하고, 버리면 과소표시한다 — 둘 다 거짓이다.
 *   `unknownStates` 로 그 원문을 함께 올려 화면이 밝히고, 우리가 정규식을 고칠 수 있게 한다.
 */

/** 활성 상태 표기(영문·한국어). 소문자 비교. */
const ACTIVE = ['active', '활성'];
/** 연결 끊김 표기. 한국어는 공백이 있거나 없는 표기가 모두 관찰 보고된다 → 공백을 지우고 비교. */
/**
 * ⚠ 한국어 `연결 끊김` 은 **상태 열 폭(보통 6~8칸)을 넘친다** — 고정폭으로 자르면 `연결` 만
 *   남아 판정이 `other` 로 떨어진다(합성 픽스처가 실제로 잡아낸 결함). 그래서 ① 접두 `연결` 만
 *   으로도 disc 로 보고 ② 아래 `parseQuser` 가 **상태 칸 + 다음 칸을 합쳐 재판정**한다.
 */
const DISC = ['disc', 'disconnected', '연결'];
/** 헤더 줄 판별 — 열 이름은 지역화되지만 `ID` 는 공통이다. */
const HEADER_RE = /(^|\s)ID(\s|$)/;
/** '사용자 없음' 문구(영문·한국어). 이것은 오류가 아니라 0명이다. */
const NO_USER_RE = /no\s+user\s+exists|사용자가\s*없습니다|no\s+users?\s+logged/i;

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, '');

/** 상태 문자열 → 'active' | 'disc' | 'other'. 모르면 other(합계에만 센다). */
export function stateKind(raw) {
  const v = norm(raw);
  if (!v) return 'other';
  if (ACTIVE.includes(v)) return 'active';
  if (DISC.some((d) => v.startsWith(d))) return 'disc';
  return 'other';
}

/**
 * 헤더 줄에서 각 열의 **시작 컬럼 위치**를 뽑는다(고정폭 슬라이스용).
 * `quser` 헤더는 선두 1칸이 현재 세션 표시(`>`)용 여백이다.
 * @returns {number[]|null} 열 시작 오프셋 배열(최소 4열이어야 유효)
 */
export function headerOffsets(headerLine) {
  const s = String(headerLine || '');
  const offs = [];
  let inTok = false;
  for (let i = 0; i < s.length; i++) {
    const sp = s[i] === ' ' || s[i] === '\t';
    if (!sp && !inTok) { offs.push(i); inTok = true; }
    // ⚠ 열 구분은 **공백 2칸 이상**이다 — `IDLE TIME`·`LOGON TIME`·`유휴 시간` 처럼 열 이름
    //   자체에 공백 1칸이 들어가므로, 1칸에서 끊으면 없는 열이 생겨 슬라이스가 전부 밀린다.
    if (sp && inTok && (s[i + 1] === ' ' || s[i + 1] === '\t' || i + 1 >= s.length)) inTok = false;
  }
  return offs.length >= 4 ? offs : null;
}

/** 고정폭 슬라이스 — 마지막 열은 줄 끝까지. */
function sliceCols(line, offs) {
  const out = [];
  for (let i = 0; i < offs.length; i++) {
    const a = offs[i];
    const b = i + 1 < offs.length ? offs[i + 1] : line.length;
    out.push(line.slice(a, b).trim());
  }
  return out;
}

/**
 * `quser` 출력 파싱.
 *
 * @param {string} text  게스트에서 받은 stdout(+stderr 합류 가능)
 * @returns {{
 *   parsed: boolean, active: number, disc: number, other: number, total: number,
 *   users: Array<{name,session,id,state,kind,idle,logonAt,current}>,
 *   unknownStates: string[], noUsers: boolean, note: string
 * }}
 *   `parsed: false` = 형식을 읽지 못했다(**0명이 아니다**). 판정·화면은 이 둘을 구분해야 한다.
 */
export function parseQuser(text) {
  const raw = String(text || '');
  const lines = raw.split(/\r?\n/);
  const empty = {
    parsed: false, active: 0, disc: 0, other: 0, total: 0,
    users: [], unknownStates: [], noUsers: false, note: '',
  };
  if (!raw.trim()) return empty;

  // '사용자 없음' — 세션 0개다(오류가 아니다). 헤더가 없어도 이 판정이 먼저다.
  if (NO_USER_RE.test(raw)) {
    return { ...empty, parsed: true, noUsers: true, note: raw.trim().split(/\r?\n/)[0].slice(0, 200) };
  }

  const hi = lines.findIndex((l) => HEADER_RE.test(l) && /\S/.test(l) && l.trim().split(/\s{2,}/).length >= 4);
  if (hi < 0) return { ...empty, note: raw.trim().split(/\r?\n/)[0].slice(0, 200) };
  const offs = headerOffsets(lines[hi]);
  if (!offs) return { ...empty, note: lines[hi].slice(0, 200) };

  const users = [];
  const unknown = new Set();
  for (let i = hi + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const current = line.startsWith('>');
    const cols = sliceCols(line, offs);
    const name = (cols[0] || '').replace(/^>\s*/, '').trim();
    if (!name) continue;
    // 열 수가 지역화·펌웨어로 흔들려도 **ID 는 숫자**라는 성질로 위치를 검증한다.
    //  표준: [USERNAME, SESSIONNAME, ID, STATE, IDLE, LOGON]
    let session = cols[1] || ''; let id = cols[2] || ''; let st = cols[3] || '';
    let idle = cols[4] || ''; let logon = cols.slice(5).join(' ').trim();
    if (!/^\d+$/.test(id)) {
      // ID 자리가 숫자가 아니면 고정폭이 어긋난 것 — 숫자 토큰을 찾아 그 뒤를 상태로 본다.
      const toks = line.replace(/^>/, ' ').trim().split(/\s+/);
      const k = toks.findIndex((t, n) => n > 0 && /^\d+$/.test(t));
      if (k > 0) { session = toks.slice(1, k).join(' '); id = toks[k]; st = toks[k + 1] || ''; idle = toks[k + 2] || ''; logon = toks.slice(k + 3).join(' '); }
    }
    let kind = stateKind(st);
    if (kind === 'other' && st && idle) {
      // 한국어 `연결 끊김` 처럼 상태 문구가 열 폭을 넘쳐 다음 칸으로 밀린 경우 — 합쳐서 재판정한다.
      const merged = stateKind(`${st} ${idle}`);
      if (merged !== 'other') { kind = merged; st = `${st} ${idle}`.trim(); idle = ''; }
    }
    if (kind === 'other' && st) unknown.add(st.slice(0, 40));
    users.push({ name, session, id: /^\d+$/.test(id) ? Number(id) : null, state: st, kind, idle, logonAt: logon, current });
  }
  if (!users.length) {
    // 헤더는 있는데 데이터 줄이 없다 = 세션 0개(정상). 형식 미인식과 구분한다.
    return { ...empty, parsed: true, noUsers: true, note: '세션 목록이 비어 있습니다.' };
  }
  const active = users.filter((u) => u.kind === 'active').length;
  const disc = users.filter((u) => u.kind === 'disc').length;
  const other = users.length - active - disc;
  return {
    parsed: true, active, disc, other, total: users.length,
    users: users.slice(0, 200), unknownStates: [...unknown].slice(0, 10), noUsers: false, note: '',
  };
}

/**
 * 게스트에서 실행할 명령.
 *
 * ⚠ `chcp 65001` 로 **코드페이지를 UTF-8 로 강제**한다 — 한국어 Windows 의 기본 콘솔 코드페이지는
 *   CP949 라, 그대로 받아 오면 `활성`·`연결 끊김` 이 깨져 상태 판정이 통째로 `other` 로 떨어진다.
 * ⚠ `quser` 는 세션이 없으면 **비정상 종료**하므로 `2>&1` 로 그 문구까지 받아 파서가 '0명' 으로
 *   읽게 한다(종료코드로 실패 처리하면 사용자 0명인 서버가 전부 '수집 실패' 가 된다).
 */
export const QUSER_CMD = 'chcp 65001 >nul & quser 2>&1';

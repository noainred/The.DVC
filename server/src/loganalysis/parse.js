/**
 * loganalysis/parse.js — 로그 한 줄 해석(v2.583, 순수). 설정 › Log › 로그 분석의 입력층.
 *
 * 사용자 요청(2026-09-23): "지금 분석하고 있는 로그를 분석해서 개선점 도출할 수 있는 메뉴와 기능을
 * 설정에 만들어줘" — 그 로그는 중앙 서버의 systemd 저널(`journalctl -u vmware-portal`)이었고, 현장은
 * **폐쇄망이라 로그를 반출할 수 없어 화면 덤프만 가능**했다. 그래서 포탈이 **스스로** 읽는다.
 *
 * 받는 형식(붙여넣기·저널·엣지 로그가 섞여 들어온다):
 *  · journalctl 기본  — `Sep 23 11:15:13 HOST node[2372]: [gpu-guest] …`
 *  · journalctl short-iso — `2026-09-23T11:15:13+0900 HOST node[2372]: …`
 *  · 원문(-o cat · tail) — 메시지만
 *  · 포탈 링 버퍼 항목 — `{ time, level, msg }`
 *
 * 정직성:
 *  · 저널·붙여넣기에는 **로그 수준(warn/error)이 없다**(journald 는 stdout/stderr 를 같은 우선순위로
 *    받는다). 수준을 지어내지 않고 `level:'unknown'` 으로 둔다 — 문제 여부는 규칙(rules.js)과 키워드
 *    추정(`looksProblem`)이 따로 판단하고, 추정은 추정이라고 밝힌다.
 *  · 시각은 **로그에 찍힌 그대로**(`tsRaw`)를 보존한다. 기본 형식에는 연도·시간대가 없어 `ts` 는
 *    올해로 가정한 근사값이다(미래가 되면 작년으로 본다) — 정렬·구간 계산에만 쓴다.
 *  · 스택 추적 줄(`    at …`)은 앞 줄의 연속이다 — 따로 세면 오류 1건이 수십 건으로 부풀려진다.
 */

const MON = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const ISO_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[+-]\d{2}:?\d{2}|Z)?)\s+(\S+)\s+([^\s:[]+)(?:\[\d+\])?:\s?(.*)$/;
const SYSLOG_RE = /^([A-Z][a-z]{2})\s+(\d{1,2})\s(\d{2}):(\d{2}):(\d{2})\s+(\S+)\s+([^\s:[]+)(?:\[\d+\])?:\s?(.*)$/;
const CONT_RE = /^\s+(?:at\s|\.\.\.\s|\})/;
const MARKER_RE = /^--\s(?:Logs begin|Journal begins|Boot|No entries|Reboot)/i;

export const MSG_MAX = 2_000;

/** 문제로 보이는 문장(키워드 추정 — 수준이 없는 원천에서만 쓴다). */
const PROBLEM_RE = /(실패|오류|에러|거부|불일치|타임아웃|시간 초과|초과|손상|중단|끊김|불가|\berror\b|\bfail|\bdenied\b|\brefused\b|\btimed? ?out\b|\bexception\b|✗|⚠)/i;
export const looksProblem = (msg) => PROBLEM_RE.test(String(msg || ''));

/**
 * 텍스트 한 줄 → `{ ts, tsRaw, host, proc, msg, level, cont }` | null(빈 줄·저널 표지).
 * `cont:true` 면 앞 줄의 연속(스택 추적)이다 — 호출부가 앞 항목에 붙이거나 버린다.
 */
export function parseTextLine(line, { now = Date.now() } = {}) {
  const raw = String(line ?? '').replace(/\r$/, '');
  if (!raw.trim()) return null;
  if (MARKER_RE.test(raw.trim())) return null;
  if (CONT_RE.test(raw)) return { cont: true, msg: raw.trim().slice(0, MSG_MAX) };
  let m = ISO_RE.exec(raw);
  // 저널 접두가 붙은 스택 줄(`… node[1]:     at foo (x.js:1:1)`)도 연속이다 — 접두 뒤 들여쓰기로 판단한다.
  const contAfterPrefix = (msg) => /^\s+(?:at\s|\.\.\.\s)/.test(msg);
  if (m) {
    if (contAfterPrefix(m[4])) return { cont: true, msg: m[4].trim().slice(0, MSG_MAX) };
    const ts = Date.parse(m[1].replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
    return { ts: Number.isFinite(ts) ? ts : null, tsRaw: m[1], host: m[2], proc: m[3], msg: m[4].slice(0, MSG_MAX), level: 'unknown', cont: false };
  }
  m = SYSLOG_RE.exec(raw);
  if (m) {
    if (contAfterPrefix(m[8])) return { cont: true, msg: m[8].trim().slice(0, MSG_MAX) };
    const mon = MON[m[1]];
    const nowD = new Date(now);
    let ts = null;
    if (mon != null) {
      let d = new Date(nowD.getFullYear(), mon, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
      if (d.getTime() > now + 86_400_000) d = new Date(nowD.getFullYear() - 1, mon, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
      ts = d.getTime();
    }
    return { ts, tsRaw: `${m[1]} ${m[2]} ${m[3]}:${m[4]}:${m[5]}`, host: m[6], proc: m[7], msg: m[8].slice(0, MSG_MAX), level: 'unknown', cont: false };
  }
  return { ts: null, tsRaw: '', host: '', proc: '', msg: raw.trim().slice(0, MSG_MAX), level: 'unknown', cont: false };
}

/** 포탈 링 버퍼 항목(`logbuffer.js`) → 같은 모양. */
export function fromBufferEntry(e) {
  if (!e || typeof e !== 'object') return null;
  const msg = String(e.msg ?? '').slice(0, MSG_MAX);
  if (!msg.trim()) return null;
  const level = ['info', 'warn', 'error'].includes(e.level) ? e.level : 'unknown';
  const ts = Number.isFinite(Number(e.time)) ? Number(e.time) : null;
  return { ts, tsRaw: '', host: '', proc: '', msg, level, cont: false };
}

/**
 * 여러 줄 텍스트 → 항목 배열. 스택 추적 연속 줄은 앞 항목에 붙인다(개수에 넣지 않는다).
 * 상한을 넘으면 **뒤쪽(최근)을 남기고** 앞을 버린 수를 밝힌다(`dropped`).
 */
export function parseText(text, { maxLines = 200_000, now = Date.now() } = {}) {
  const lines = String(text ?? '').split('\n');
  const dropped = Math.max(0, lines.length - maxLines);
  const use = dropped ? lines.slice(lines.length - maxLines) : lines;
  const out = [];
  let cont = 0;
  let skipped = 0;
  for (const l of use) {
    const p = parseTextLine(l, { now });
    if (!p) { skipped += 1; continue; }
    if (p.cont) { cont += 1; continue; }
    out.push(p);
  }
  return { items: out, total: lines.length, dropped, continuation: cont, skipped };
}

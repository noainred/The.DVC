/**
 * bmusage/parse/racadm.js — iDRAC SSH(`racadm`) 성능 통계 출력 파서(순수, v2.554).
 *
 * 사용자 지시(2026-09-17): "엔터프라이즈 라이선스를 idarc api/ssh 로 사용할 수 있으니 시스템에
 * 부하는 있겠지만, 사용할것이냐고 물어보고 사용하겠다고 하면 기능을 구현한다."
 *
 * ── ⚠⚠ 정직 기록 — 이 출력 형식을 **실장비에서 본 적이 없다** ───────────────
 * 이 현장 iDRAC 의 `racadm systemperfstatistics` 출력을 받아 보지 못했다. Dell 의 racadm 레퍼런스
 * 원문도 이 환경의 egress 정책에서 읽지 못했다(developer.dell.com 403). 그래서 이 파서는
 * **형식에 관용적**이고, 아무것도 못 읽으면 `parsed:false` 를 준다 — 그때 화면은 '정상' 이 아니라
 * **'형식 미인식'** 으로 다루고, 수집기는 **원문(raw)을 그대로 실어 보낸다**(v2.542 `cliRaw` 규약).
 * 첫 실수집에서 그 원문을 보고 정규식을 조일 것 — **추측한 형식을 '확인했다' 고 쓰지 말 것.**
 *
 * ── 판정 규칙(되돌리지 말 것) ────────────────────────────────────────────────
 * ⚠ **0~100 밖의 수는 퍼센트가 아니다.** `Peak` 리셋 시각(`2026-09-17 08:00:00`)·표본 수·바이트가
 *   같은 줄에 섞여 온다 — 범위를 벗어난 수를 사용률로 쓰면 **오류 없이 틀린 값**이 된다
 *   (v2.550 `Number('')===0` 과 같은 계열의 사고).
 * ⚠ **`Last`(현재) 를 `Average`·`Peak` 보다 먼저 쓴다.** 5분 주기 추이에 하루 평균이나 부팅 이후
 *   최고치를 섞으면 차트가 거짓이 된다. 어느 열을 썼는지 `usedStat` 으로 밝힌다.
 * ⚠ **찾지 못한 지표는 필드를 만들지 않는다**(0 을 넣지 않는다 — '부하 없음' 이라는 거짓).
 */
const t = (v) => String(v ?? '').trim();

/** 한 줄 길이 상한(v2.606 SEC2606-05) — racadm 한 줄은 수십 자다. 넘는 줄은 앞부분만 본다(정규식 비용 한정). */
export const LINE_MAX = 1000;

/** 지표 키워드 → 우리 필드. ⚠ 한 표기로 굳히지 말 것(버전마다 흔들린다). */
const METRIC_RE = Object.freeze([
  ['cpuPct', /\bcpu\s*usage\b|\bcpuusage\b|\bsystemboardcpuusage\b/i],
  ['memPct', /\b(?:memory|mem)\s*usage\b|\bmemusage\b|\bmemoryusage\b|\bsystemboardmemusage\b/i],
  ['ioPct', /\bi\/?o\s*usage\b|\biousage\b|\bsystemboardiousage\b/i],
  ['sysPct', /\bsystem\s*usage\b|\bsysusage\b|\bsystemboardsysusage\b/i],
]);

/** 통계 종류 — 앞에 있는 것을 먼저 쓴다(현재값 우선). */
const STAT_RE = Object.freeze([
  ['last', /\b(?:last|current|instant|now)\b/i],
  ['avg', /\b(?:average|avg|mean)\b/i],
  ['peak', /\b(?:peak|max(?:imum)?)\b/i],
]);

/** 퍼센트로 쓸 수 있는 수만 남긴다(0~100). 소수 1자리로 정리. */
function pct(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return Math.round(n * 10) / 10;
}

/**
 * 한 줄에서 숫자를 뽑는다. `%` 가 붙은 수를 **먼저** 본다(퍼센트가 아닌 수와 섞이는 것을 막는다).
 * 시각(`2026-09-17 08:00:00`)·버전(`5.10.30.00`)처럼 구분자가 붙은 토큰은 제외한다.
 */
function numbersOf(line) {
  const s = t(line).slice(0, LINE_MAX);
  // v2.606(감사 SEC2606-05): 앞 경계(숫자·점 뒤에서 시작하지 않는다) + 자릿수 한정 — 예전 `(\d+(?:\.\d+)?)\s*%` 는
  //   숫자열의 모든 시작 위치에서 끝까지 훑어 O(n²) 였다('1'×32,000 한 줄 2.4초). v2.605 nlSearch 수정과 같은 모양.
  const withPct = [...s.matchAll(/(?<![\d.])(\d{1,6}(?:\.\d{1,3})?)\s*%/g)].map((m) => Number(m[1]));
  if (withPct.length) return { list: withPct, hadPct: true };
  // 날짜·시각·버전 토큰을 지운 뒤 남은 수만.
  const cleaned = s
    .replace(/\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?/g, ' ')
    .replace(/\b\d+(?:\.\d+){2,}\b/g, ' ')
    .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, ' ');
  const list = [...cleaned.matchAll(/(?<![\w.])(\d+(?:\.\d+)?)(?![\w.])/g)].map((m) => Number(m[1]));
  return { list, hadPct: false };
}

/** 줄에서 어떤 통계 종류를 말하는지(없으면 ''). */
function statOf(line) {
  for (const [k, re] of STAT_RE) if (re.test(line)) return k;
  return '';
}

/**
 * `racadm systemperfstatistics` 계열 출력 → 사용률.
 *
 * 두 형태를 모두 받는다:
 *  ① **한 줄형**(표·인라인) — `CPUUsage   12 %   15 %   88 %` / `CPU Usage = 12 %`
 *  ② **블록형** — `Metric Name = CPUUsage` 다음 줄들에 `Last = 12` · `Average = 15`
 *
 * @param {string} text stdout 원문
 * @returns {{parsed:boolean, mode:string, cpuPct?:number, memPct?:number, ioPct?:number,
 *            sysPct?:number, usedStat:object, found:string[], lines:number}}
 */
export function parseSystemPerf(text = '') {
  const raw = t(text);
  const out = { parsed: false, mode: '', usedStat: {}, found: [], lines: 0 };
  if (!raw) return out;
  const lines = raw.split(/\r?\n/).map((l) => (l.length > LINE_MAX ? l.slice(0, LINE_MAX) : l));   // v2.606 SEC2606-05
  out.lines = lines.length;

  /** 값을 넣는다 — **이미 더 좋은 통계(last > avg > peak)로 채워져 있으면 덮지 않는다.** */
  const rank = (s) => (s === 'last' ? 0 : s === 'avg' ? 1 : s === 'peak' ? 2 : 3);
  const put = (field, value, stat, mode) => {
    const v = pct(value);
    if (v == null) return false;
    const cur = out.usedStat[field];
    if (out[field] != null && rank(cur) <= rank(stat)) return false;
    out[field] = v;
    out.usedStat[field] = stat || 'unknown';
    out.parsed = true;
    if (!out.mode) out.mode = mode;
    if (!out.found.includes(field)) out.found.push(field);
    return true;
  };

  // ── ① 한 줄형 ──────────────────────────────────────────────────────────────
  for (const line of lines) {
    const field = METRIC_RE.find(([, re]) => re.test(line))?.[0];
    if (!field) continue;
    const { list } = numbersOf(line);
    if (!list.length) continue;
    // 그 줄이 통계 종류를 말하면 그것을, 아니면 **첫 수를 현재값으로 본다**(표의 첫 열이 Last 다).
    const stat = statOf(line) || 'last';
    put(field, list[0], stat, 'inline');
  }

  // ── ② 블록형 ──────────────────────────────────────────────────────────────
  // '지표 이름만 있는 줄' 로 문맥을 열고, 뒤따르는 `키 = 값` 줄에서 통계를 읽는다.
  let ctx = '';
  for (const line of lines) {
    const s = t(line);
    if (!s) { continue; }
    const field = METRIC_RE.find(([, re]) => re.test(s))?.[0];
    // 지표 이름이 있고 그 줄에 쓸 수 있는 수가 없으면 = 블록 머리.
    if (field) {
      const { list } = numbersOf(s);
      if (!list.some((x) => pct(x) != null)) { ctx = field; continue; }
      // 수가 있으면 ①에서 이미 처리했다. 문맥도 새로 연다(연속 블록 대비).
      ctx = field;
      continue;
    }
    if (!ctx) continue;
    const stat = statOf(s);
    if (!stat) continue;
    const { list } = numbersOf(s);
    if (!list.length) continue;
    put(ctx, list[0], stat, out.mode || 'block');
  }
  return out;
}

/**
 * 원문 일부만 남긴다 — 화면이 '무엇을 받았는지' 보여주되 응답이 비대해지지 않게.
 * ⚠ 비밀번호는 명령줄에 싣지 않으므로(그 계정으로 SSH 접속한 상태에서 실행) 원문에 없다.
 */
export function rawSample(text = '', limit = 2_000) {
  const s = String(text ?? '');
  return s.length > limit ? `${s.slice(0, limit)}\n…(${s.length - limit}자 더)` : s;
}

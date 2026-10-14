/**
 * isidu/parse.js — 아이실론 디렉터리 사용량(`du -A -h|-k -d 1 <경로>`) 출력 해석(순수, v2.736).
 *
 * 사용자 요청: "특수기능에 내가 지정한 아이실론의 특정 디렉터리 하위의 모든 폴더의 크기를 조사해서 Top 10 …
 *   ssh admin@192.168.1.100 'du -A -h -d 1 "/ifs/data/workspace/users/"' … /ifs/data/workspace/users/aaa 는 사용자명이 aaa".
 *
 * ── 사용자가 준 실제 출력 형식(스크린샷) ─────────────────────────────────────────
 *   ` 16K\t/ifs/data/workspace/VAPUserHome/<사용자>`  ·  ` 73G\t…`  ·  `3.9G\t…`  ·  `961K\t…`
 *   크기는 오른쪽 정렬(앞 공백) + 단위 글자(K·M·G·T…) · 10 미만이면 소수 한 자리 · 크기 뒤에 탭(또는 공백) · 전체 경로.
 *   `-d 1` 은 **조사한 디렉터리 자신의 합계 줄도** 낸다 — 그 줄은 순위에 넣지 않고 '전체' 로 쓴다.
 *
 * ── 정직 규칙 ────────────────────────────────────────────────────────────────
 *  · `-h` 값은 **반올림된 값**이다(유효숫자 두 자리 안팎). 그래서 행마다 **해상도(res)** 를 함께 싣는다 — `3.9G` 는 0.1G,
 *    `73G` 는 1G, `961K` 는 1K. 증감이 두 값의 해상도 안이면 '변화 없음' 이 아니라 **'해상도 안'** 이라고 말한다(`deltaOf`).
 *    정밀한 추이가 필요하면 `-k`(KB 단위 정수 — 해상도 1KB)를 고르게 한다.
 *  · 단위는 1024 배수다(FreeBSD/OneFS humanize_number · GNU du 모두 -h 는 1024).
 *  · 단위를 모르는 크기(‘-h’ 인데 단위 글자 없는 수 — 0 제외)는 지어내지 않고 건너뛴 줄(`skipped`)로 센다.
 *  · `du:` 로 시작하는 줄(권한 오류 등)은 표준 오류에서 따로 센다(`errLines`) — 그 폴더 크기는 실제보다 작을 수 있다.
 *  · 줄 단위 선형 해석이다(장비 출력도 외부 입력 — v2.598 INJ 규약). 줄 길이·항목 수에 상한을 둔다.
 */

export const MAX_ENTRIES = 50_000;
export const LINE_MAX = 4096;
const UNITS = Object.freeze({ B: 0, K: 1, M: 2, G: 3, T: 4, P: 5, E: 6 });
export const SIZE_MODES = Object.freeze(['h', 'k']);

/** 끝 슬래시를 떼고 연속 슬래시를 하나로(선형). '/' 하나는 그대로. */
export function normPath(p) {
  let s = String(p ?? '');
  let out = '';
  let prevSlash = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '/') { if (prevSlash) continue; prevSlash = true; } else prevSlash = false;
    out += c;
  }
  while (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

/**
 * 크기 문자열 하나 → { bytes, res } | null.
 * @param {string} tok  '3.9G' · '73G' · '961K' · '512B' · '0' · (k 모드) '4096'
 * @param {'h'|'k'} mode
 */
export function parseSizeToken(tok, mode = 'h') {
  const t = String(tok ?? '').trim();
  if (!t || t.length > 24) return null;
  if (/^\d+$/.test(t)) {
    const n = Number(t);
    if (!Number.isSafeInteger(n)) return null;
    if (mode === 'k') return { bytes: n * 1024, res: 1024 };
    if (n === 0) return { bytes: 0, res: 1 };   // GNU du -h 는 빈 폴더를 '0' 으로 쓴다(단위 없음)
    return null;                                  // -h 인데 단위 없는 수 — 단위를 지어내지 않는다
  }
  const m = /^(\d+)(?:\.(\d))?([BKMGTPE])i?B?$/i.exec(t);
  if (!m) return null;
  const pow = UNITS[m[3].toUpperCase()];
  const unit = 1024 ** pow;
  const whole = Number(m[1]);
  const frac = m[2] == null ? null : Number(m[2]);
  const value = frac == null ? whole : whole + frac / 10;
  const step = frac == null ? 1 : 0.1;
  const bytes = Math.round(value * unit);
  const res = Math.max(1, Math.round(step * unit));
  if (!Number.isFinite(bytes)) return null;
  return { bytes, res };
}

/**
 * du 표준 출력 → 하위 폴더 목록 + 루트 합계.
 * @param {string} stdout
 * @param {string} root  조사한 디렉터리(명령에 넣은 그 경로)
 * @param {{mode?:'h'|'k', stderr?:string}} [opts]
 * @returns {{
 *   entries:{name:string,bytes:number,res:number}[], total:{bytes:number,res:number}|null,
 *   skipped:number, skippedSample:string[], errLines:number, errSample:string[], truncated:boolean, lines:number
 * }}
 */
export function parseDuOutput(stdout, root, { mode = 'h', stderr = '' } = {}) {
  const rootN = normPath(root);
  const prefix = rootN === '/' ? '/' : `${rootN}/`;
  const entries = [];
  const seen = new Set();
  let total = null;
  let skipped = 0; const skippedSample = [];
  let errLines = 0; const errSample = [];
  let truncated = false;
  let lines = 0;
  const skip = (line) => { skipped += 1; if (skippedSample.length < 5) skippedSample.push(line.slice(0, 160)); };
  const text = String(stdout ?? '');
  let i = 0;
  while (i <= text.length) {
    let j = text.indexOf('\n', i);
    if (j < 0) j = text.length;
    let line = text.slice(i, j);
    i = j + 1;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.length > LINE_MAX) { skip(line); continue; }
    if (!line.trim()) { if (j >= text.length) break; continue; }
    lines += 1;
    if (/^\s*du:/.test(line)) { errLines += 1; if (errSample.length < 5) errSample.push(line.trim().slice(0, 200)); continue; }
    // 앞 공백(오른쪽 정렬) → 크기 토큰 → 구분(탭 우선, 없으면 공백 한 덩어리) → 경로
    let k = 0;
    while (k < line.length && (line[k] === ' ' || line[k] === '\t')) k++;
    let e = k;
    while (e < line.length && line[e] !== ' ' && line[e] !== '\t') e++;
    const tok = line.slice(k, e);
    let p = e;
    const tab = line.indexOf('\t', e);
    if (tab >= 0) p = tab + 1; else { while (p < line.length && line[p] === ' ') p++; }
    const rawPath = line.slice(p);
    const size = parseSizeToken(tok, mode);
    if (!size || !rawPath.startsWith('/')) { skip(line); continue; }
    const pth = normPath(rawPath);
    if (pth === rootN) { total = size; continue; }
    if (!pth.startsWith(prefix)) { skip(line); continue; }
    const name = pth.slice(prefix.length);
    if (!name || name.includes('/')) { skip(line); continue; }   // -d 1 이면 바로 아래만 온다(방어)
    if (seen.has(name)) { skip(line); continue; }
    if (entries.length >= MAX_ENTRIES) { truncated = true; continue; }
    seen.add(name);
    entries.push({ name, bytes: size.bytes, res: size.res });
  }
  for (const raw of String(stderr ?? '').split('\n')) {
    const s = raw.trim();
    if (!s) continue;
    errLines += 1;
    if (errSample.length < 5) errSample.push(s.slice(0, 200));
  }
  return { entries, total, skipped, skippedSample, errLines, errSample, truncated, lines };
}

/** 크기 내림차순(같으면 이름 오름차순 — 매번 같은 순서). 원본을 바꾸지 않는다. */
export function sortBySize(entries) {
  return [...(Array.isArray(entries) ? entries : [])].sort((a, b) => (b.bytes - a.bytes) || String(a.name).localeCompare(String(b.name)));
}

/**
 * 두 관측의 차이. 두 해상도의 반을 더한 것보다 작으면 '해상도 안'(withinRes) — 반올림 값끼리의 차이는 그만큼 흔들린다.
 * 어느 한쪽이라도 없으면 null(기준이 없으면 증감을 만들지 않는다 — 0 은 '변화 없음' 이라는 거짓).
 */
export function deltaOf(cur, prev) {
  if (!cur || !prev || !Number.isFinite(cur.bytes) || !Number.isFinite(prev.bytes)) return null;
  const d = cur.bytes - prev.bytes;
  const unc = ((Number(cur.res) || 1) + (Number(prev.res) || 1)) / 2;
  return { bytes: d, withinRes: Math.abs(d) <= unc, uncertainty: Math.round(unc) };
}

/**
 * 합계 — 하위 폴더의 합과 du 가 보고한 루트 합계는 다를 수 있다(루트 바로 아래 파일). 비중의 분모는 루트 합계 우선.
 * 합계 해상도는 각 행의 해상도 합(최악) — 반올림 값을 더하면 오차도 더해진다.
 */
export function totalsOf(entries, total) {
  let sum = 0; let resSum = 0;
  for (const e of entries || []) { sum += e.bytes; resSum += Number(e.res) || 0; }
  const denom = total && total.bytes > 0 ? total.bytes : sum;
  return { sumBytes: sum, sumRes: resSum, denomBytes: denom };
}

/** 원격 명령 — 경로는 settings.pathIssue 를 통과한 값만 온다(작은따옴표로 감싼다 — 그 경로에는 작은따옴표가 없다). */
export function duCommand(path, mode = 'h') {
  const flag = mode === 'k' ? '-k' : '-h';
  return `du -A ${flag} -d 1 '${normPath(path)}'`;
}

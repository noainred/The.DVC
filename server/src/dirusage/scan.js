/**
 * dirusage/scan.js — 폴더 사용량 Top-N 산출 (순수 모듈, v2.454).
 *
 * 요구: "엣지 서버에 마운트된 특정 폴더의 하위 폴더 사용량을 주기마다 검색해 Top 10/20 사용자를
 * 뽑고 지정한 사람에게 메일 발송."
 *
 * 집계 기준은 **하위 폴더 이름 = 사용자** 다(사용자가 선택). 예: `/mnt/share/hong`, `/mnt/share/kim`.
 * 파일 소유자(uid) 기준이 아니다 — 그쪽은 전체 파일을 훑어야 해서 수백만 파일·NFS 에서 수십 분~시간이
 * 걸린다. `du --max-depth=1` 은 디렉터리 엔트리만 읽어 같은 규모에서 수 분에 끝난다.
 *
 * 이 파일은 파싱·정렬·증감 계산만 한다(I/O 없음). 실제 실행은 RMA 엣지가 하고(commands.js `du-top`),
 * 중앙은 그 표준출력을 여기로 넘긴다.
 */

import crypto from 'node:crypto';

/** 한 번에 다룰 하위 폴더 수 상한 — 엔트리가 수만 개인 공유에서 메모리·메일 크기를 유계로 둔다. */
export const MAX_ENTRIES = 20_000;
/** Top-N 허용 범위(설정 화면 입력 검증과 공유). */
export const TOP_N_MIN = 1;
export const TOP_N_MAX = 200;

/**
 * `du -x -b --max-depth=1 <root>` 출력을 파싱한다.
 *
 * 출력 형식: `<바이트>\t<경로>` 한 줄씩, **마지막 줄이 루트 자신**의 합계다.
 * 루트 행은 total 로 따로 빼고 나머지를 항목으로 돌려준다.
 *
 * 견고성:
 *  - 권한 오류(`du: cannot read directory ...`)는 stderr 로 가지만, 섞여 들어와도 무시한다.
 *  - 경로에 공백·유니코드가 있어도 탭 기준 1회 분리라 안전하다.
 *  - 개행이 든 폴더명(리눅스에서 합법)은 파싱이 불가능하므로 그 줄은 버린다 — 조용히 버리지 않고
 *    `skipped` 로 개수를 돌려준다(요약에 표시해 "왜 합이 안 맞나"를 설명할 수 있게).
 *
 * @param {string} stdout
 * @param {string} root 스캔 루트(이 경로와 같은 행이 total)
 * @returns {{entries:{name:string,bytes:number}[], totalBytes:number|null, skipped:number, truncated:boolean}}
 */
export function parseDuOutput(stdout, root) {
  const rootNorm = stripSlash(String(root || ''));
  const entries = [];
  let totalBytes = null;
  let skipped = 0;
  let truncated = false;

  for (const rawLine of String(stdout || '').split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim()) continue;
    const tab = line.indexOf('\t');
    if (tab <= 0) { if (/^du:/.test(line)) continue; skipped++; continue; }  // `du: cannot read ...` 는 경고
    const bytes = Number(line.slice(0, tab).trim());
    const p = stripSlash(line.slice(tab + 1).trim());
    if (!Number.isFinite(bytes) || bytes < 0 || !p) { skipped++; continue; }
    if (p === rootNorm) { totalBytes = bytes; continue; }                    // 루트 자신 = 합계
    // 루트 바로 아래만 취한다(--max-depth=1 이면 원래 그렇지만 방어적으로).
    if (rootNorm && !p.startsWith(rootNorm + '/')) { skipped++; continue; }
    const name = rootNorm ? p.slice(rootNorm.length + 1) : p;
    if (!name || name.includes('/')) { skipped++; continue; }
    if (entries.length >= MAX_ENTRIES) { truncated = true; continue; }
    entries.push({ name, bytes });
  }
  return { entries, totalBytes, skipped, truncated };
}

function stripSlash(p) { return p.length > 1 && p.endsWith('/') ? p.replace(/\/+$/, '') : p; }

/**
 * 상위 N개를 뽑고 나머지를 '기타'로 묶는다.
 * 동률은 이름 오름차순으로 안정 정렬한다(같은 데이터에서 매번 같은 순서 → 메일이 흔들리지 않게).
 *
 * @returns {{top:{rank:number,name:string,bytes:number,pct:number|null}[], othersBytes:number,
 *            othersCount:number, sumBytes:number, count:number}}
 */
export function topEntries(entries, n = 20, totalBytes = null) {
  const list = (entries || []).filter((e) => e && Number.isFinite(e.bytes));
  const sorted = [...list].sort((a, b) => (b.bytes - a.bytes) || String(a.name).localeCompare(String(b.name)));
  // n 이 무효(0·NaN·음수)면 기본 20 으로 본다 — '0 = 제한 없음' 이 아니다.
  // 설정 검증(settings.targetIssue)이 1~200 을 강제하므로 여기 오는 무효값은 프로그래밍 실수뿐이고,
  // 그때 전량을 뱉는 것보다 기본값으로 수렴하는 편이 메일 크기 사고를 막는다.
  const lim = Math.max(TOP_N_MIN, Math.min(TOP_N_MAX, Math.floor(Number(n) || 20)));
  const sumBytes = list.reduce((s, e) => s + e.bytes, 0);
  // 비율의 분모는 du 가 보고한 루트 합계를 우선한다 — 하위 폴더 합과 다를 수 있다(루트 직속 파일).
  const denom = Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : (sumBytes || 0);
  const top = sorted.slice(0, lim).map((e, i) => ({
    rank: i + 1,
    name: e.name,
    bytes: e.bytes,
    pct: denom > 0 ? Math.round((e.bytes / denom) * 1000) / 10 : null,
  }));
  const rest = sorted.slice(lim);
  return {
    top,
    othersBytes: rest.reduce((s, e) => s + e.bytes, 0),
    othersCount: rest.length,
    sumBytes,
    count: list.length,
  };
}

/**
 * 직전 스캔 대비 증감을 붙인다.
 *
 * 기준선 원칙(vmtrack v2.351 사고와 같은 규칙): **직전 관측이 없으면 증감을 만들지 않는다**(null).
 * 0 으로 채우면 "변화 없음"으로 읽혀 신규 사용자가 눈에 띄지 않는다.
 *
 * @param {{name:string,bytes:number}[]} cur
 * @param {{name:string,bytes:number}[]|null} prev
 * @returns {Map<string,{deltaBytes:number|null, isNew:boolean}>}
 * v2.620(SRV2620-01): 두 인자가 전체 목록일 때의 판정이다 — Top-N 기록끼리는 compareScans 를 쓸 것.
 */
export function deltaMap(cur, prev) {
  const out = new Map();
  const prevMap = new Map((prev || []).map((e) => [e.name, e.bytes]));
  const hasPrev = Array.isArray(prev) && prev.length > 0;
  for (const e of cur || []) {
    if (!hasPrev) { out.set(e.name, { deltaBytes: null, isNew: false }); continue; }
    const p = prevMap.get(e.name);
    if (p == null) out.set(e.name, { deltaBytes: null, isNew: true });      // 신규 — 전량을 증가로 보지 않는다
    else out.set(e.name, { deltaBytes: e.bytes - p, isNew: false });
  }
  return out;
}

/**
 * 사라진 항목(직전에 있었으나 이번에 없는 폴더) — 두 인자가 **전체 목록**일 때의 판정이다.
 * v2.620(SRV2620-01): Top-N 기록끼리는 이 함수가 아니라 compareScans 를 쓴다(순위 밖 이탈을 삭제로 말한다).
 */
export function removedEntries(cur, prev) {
  if (!Array.isArray(prev) || !prev.length) return [];
  const curNames = new Set((cur || []).map((e) => e.name));
  return prev.filter((e) => !curNames.has(e.name)).map((e) => ({ name: e.name, bytes: e.bytes }));
}

/*
 * v2.620(SRV2620-01) — Top-N 끼리만 비교하면 순위 밖으로 밀린 폴더가 '사라진 폴더(삭제)' 로,
 * 순위에 올라온 기존 폴더가 '신규' 로 메일에 나갔다(재현: topN=2, a300·b200·c100 → a300·b50·c250 에서
 * b 는 50B 로 존재하는데 삭제, c 는 100→250 인데 신규). 그래서 기록에 **전체 폴더 이름의 지문 집합**
 * (이름당 sha1 앞 8자리, 정렬 후 이어 붙임 — 2만 폴더면 160KB, 보통 수백 개면 수 KB)을 남기고
 * 비교는 그 집합으로 '정말 없어졌는가/정말 새로 생겼는가' 를 판정한다. 바이트는 남기지 않는다
 * (저장 정책 'Top-N + 요약' 은 그대로 — 순위 밖 폴더의 과거 크기는 여전히 알 수 없다).
 * 지문 집합이 없는 옛 기록·truncated 기록은 단정하지 않고 '순위 진입' / '순위 밖으로 벗어남(확인 불가)'
 * 으로 따로 말한다. 32비트 지문이라 충돌이 드물게 있을 수 있다 — 충돌이면 새 폴더를 '순위 진입(기존)'
 * 으로, 지운 폴더를 '순위 밖' 으로 말한다(삭제·신규를 지어내는 쪽이 아니라 보수적인 쪽으로 틀린다).
 */
const DIGEST_LEN = 8;

/** 폴더 이름 → 8자리 지문. */
export function nameDigest(name) {
  return crypto.createHash('sha1').update(String(name)).digest('hex').slice(0, DIGEST_LEN);
}

/** 전체 항목 → 지문 집합 문자열(정렬·중복 제거 후 이어 붙임). 저장·비교 모두 이 형식이다. */
export function buildNameSet(entries) {
  const set = new Set();
  for (const e of entries || []) if (e && e.name != null) set.add(nameDigest(e.name));
  return [...set].sort().join('');
}

/** 기록(camelCase 레코드 또는 DB 행)의 지문 집합 → Set | null(없거나 형식 불일치). */
export function nameSetOf(rec) {
  const s = rec?.nameSet ?? rec?.name_set;
  if (typeof s !== 'string' || !s || s.length % DIGEST_LEN !== 0 || !/^[0-9a-f]+$/.test(s)) return null;
  const out = new Set();
  for (let i = 0; i < s.length; i += DIGEST_LEN) out.add(s.slice(i, i + DIGEST_LEN));
  return out;
}

const othersCountOf = (r) => Number(r?.othersCount ?? r?.others_count ?? NaN);
const truncatedOf = (r) => !!(r?.truncated);

/**
 * 그 기록이 '어떤 이름이 있었는가' 를 답할 수 있는 수단.
 *  - Top-N 이 전부(othersCount === 0, truncated 아님)면 Top-N 자체가 전체 목록이다.
 *  - 아니면 지문 집합(truncated 가 아닐 때만 — 잘린 목록의 부재는 증거가 아니다).
 *  - 그것도 없으면 null(모른다).
 * @returns {null | ((name:string)=>boolean)}
 */
function membershipOf(rec) {
  if (!rec) return null;
  if (truncatedOf(rec)) return null;
  const top = new Set((rec.entries || []).map((e) => e.name));
  if (othersCountOf(rec) === 0) return (n) => top.has(n);
  const set = nameSetOf(rec);
  if (!set) return null;
  return (n) => top.has(n) || set.has(nameDigest(n));
}

/**
 * 스캔 두 건을 비교한다(v2.620 SRV2620-01) — 리포트는 이 함수만 쓴다.
 * @param {object} cur  buildScanRecord() 결과(또는 같은 모양)
 * @param {object|null} prev 직전 스캔(레코드 또는 DB 행)
 * @returns {{
 *   delta: Map<string,{deltaBytes:number|null,isNew:boolean,entered?:boolean,existedBefore?:boolean|null}>,
 *   removed: {name:string,bytes:number}[],          // 전체 목록 기준으로 이번에 없다(삭제·이동)
 *   rankedOut: {name:string,bytes:number,confirmed:boolean}[],  // 순위 밖으로 벗어남(confirmed=지금도 있음 확인)
 *   enteredUnknown: number,                          // 순위 진입인데 직전 존재 여부를 모르는 수
 * }}
 */
export function compareScans(cur, prev) {
  const curTop = cur?.entries || [];
  const prevTop = prev?.entries || [];
  const delta = new Map();
  const removed = [];
  const rankedOut = [];
  let enteredUnknown = 0;
  if (!prev || !prevTop.length) {
    for (const e of curTop) delta.set(e.name, { deltaBytes: null, isNew: false });
    return { delta, removed, rankedOut, enteredUnknown };
  }
  const prevMap = new Map(prevTop.map((e) => [e.name, e.bytes]));
  const prevHas = membershipOf(prev);
  for (const e of curTop) {
    const p = prevMap.get(e.name);
    if (p != null) { delta.set(e.name, { deltaBytes: e.bytes - p, isNew: false }); continue; }
    if (prevHas && !prevHas(e.name)) { delta.set(e.name, { deltaBytes: null, isNew: true }); continue; }
    // 직전에도 있었지만 순위 밖이었다(prevHas 가 true) 또는 직전 전체 목록이 없어 모른다.
    const existedBefore = prevHas ? true : null;
    if (existedBefore == null) enteredUnknown++;
    delta.set(e.name, { deltaBytes: null, isNew: false, entered: true, existedBefore });
  }
  const curNames = new Set(curTop.map((e) => e.name));
  const curHas = membershipOf(cur);
  for (const p of prevTop) {
    if (curNames.has(p.name)) continue;
    if (curHas && !curHas(p.name)) removed.push({ name: p.name, bytes: p.bytes });
    else rankedOut.push({ name: p.name, bytes: p.bytes, confirmed: !!curHas });
  }
  return { delta, removed, rankedOut, enteredUnknown };
}

/** 바이트 → 사람이 읽는 크기. 메일·화면이 같은 표기를 쓰도록 여기 하나만 둔다. */
export function humanBytes(b) {
  if (b == null || !Number.isFinite(b)) return '—';
  const neg = b < 0;
  let v = Math.abs(b);
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  const s = i === 0 ? String(Math.round(v)) : v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2);
  return `${neg ? '-' : ''}${s} ${u[i]}`;
}

/**
 * 스캔 1건의 저장용 요약을 만든다 — **전량이 아니라 Top-N + 합계만** 저장한다.
 * 하위 폴더가 수천 개인 공유를 매 주기 전량 적재하면 vmtrack 이 피하려던 그 문제가 반복된다.
 */
export function buildScanRecord({ targetId, root, agent, ts, parsed, topN }) {
  const t = topEntries(parsed.entries, topN, parsed.totalBytes);
  return {
    targetId: String(targetId || ''),
    agent: String(agent || ''),
    root: String(root || ''),
    ts: Number(ts) || Date.now(),
    totalBytes: parsed.totalBytes,
    sumBytes: t.sumBytes,
    count: t.count,
    othersBytes: t.othersBytes,
    othersCount: t.othersCount,
    skipped: parsed.skipped,
    truncated: parsed.truncated,
    entries: t.top.map((e) => ({ name: e.name, bytes: e.bytes })),
    // v2.620(SRV2620-01): 전체 이름 지문 — 순위 밖 이탈·진입과 삭제·신규를 구분하는 근거(바이트는 없음).
    nameSet: buildNameSet(parsed.entries),
  };
}

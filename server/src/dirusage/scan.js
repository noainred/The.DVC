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

/** 사라진 항목(직전에 있었으나 이번에 없는 폴더) — 삭제·이동을 리포트에 남긴다. */
export function removedEntries(cur, prev) {
  if (!Array.isArray(prev) || !prev.length) return [];
  const curNames = new Set((cur || []).map((e) => e.name));
  return prev.filter((e) => !curNames.has(e.name)).map((e) => ({ name: e.name, bytes: e.bytes }));
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
  };
}

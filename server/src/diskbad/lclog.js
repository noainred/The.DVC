/**
 * diskbad/lclog.js — iDRAC Lifecycle 로그를 **읽기만** 한다(v3.8.0).
 *
 * 사용자 선택(2026-11-14): 실장비 확인 전이라 **보수적으로** — 확인하지 못한 기능에 기대지 않는다.
 *  · `$filter`(ID · 시각으로 걸러 받기)는 iDRAC 가 지원하는지 모른다(README §5 · §14.1 ③④) → 쓰지 않는다.
 *    `$skip` 으로 쪽을 넘기며 읽는다(PowerShell Gallery 공개 모듈이 쓰는 방식 — README §12.2 ㉔).
 *  · 정렬 방향(최신 먼저 / 오래된 것 먼저)을 모른다 → 첫 쪽의 시각으로 가늠하고, 오래된 것 먼저면 끝쪽부터 거꾸로 읽는다.
 *  · 지난번 읽은 가장 새 항목(cursor) 아래로는 다시 읽지 않는다 — 6시간 주기의 부하를 줄이는 유일한 장치다.
 *    cursor 를 못 찾고 끝까지 읽었으면 '로그가 지워졌거나 넘어갔다'(gap)로 밝힌다(조용히 이어 붙이지 않는다).
 *  · 남기는 것은 물리 · 가상 디스크 범주(PDR/VDR) 원문뿐이다. 분류는 중앙이 한다(classify.js 머리말 ③).
 *
 * ⚠ v3.8.2(실장비에서 드러난 것 — 2026-11-14 사용자 화면): 이 경로가 주는 것은 iDRAC 의 **활성 로그** 뿐이다. Dell 사용자 안내서
 *   (검색 요약으로 확인 — 원문은 열지 못함)에 따르면 Lifecycle 로그는 800KB 에 닿으면 압축 · 보관되고 그 뒤로는 활성 항목만 조회된다
 *   (보관분은 '전체 내보내기' 로만). 실제 서버 한 대가 3,853건 · 하루치였다 — 로그인 기록(USR0030 계열)이 활성 로그를 채우면
 *   과거 PDR 기록은 여기 없다. 그래서 **무엇을 읽었는지**(쪽 수 · 걸린 시간 · 기록 ID 구성)를 결과에 싣는다 — '끝까지 읽음' 이
 *   '과거 전부를 봤다' 로 읽히지 않게 화면이 그 구성을 밝힌다(diag). 판정에는 쓰지 않는다.
 *   같이 고친 것: 건수(total)를 아는데 그 전에 빈 쪽이 오면 '끝' 이 아니라 '도중에 끊김'(short) · 첫 쪽이 비면 '끝까지 읽음' 이 아니라
 *   '항목 없음'(empty — 빈 로그를 '기록 없음' 으로 말하지 않는다) · 12G/13G 의 옛 경로(`Logs/Lclog`)는 표준 경로가 404 일 때만 시도.
 *
 * ⚠ 장비 시한: 호출자(scan.js)가 `signal` 로 세션을 실제로 끊는다(withDeadline). 여기서는 그와 별도로 **쪽 사이에서**
 *   남은 예산을 보고 멈춘다 — 그러면 읽은 데까지는 결과로 남는다(일부만 읽음 — complete:false).
 */
import { redfishGetCapped } from '../idrac/redfish.js';
import { codeOf, isStorageCode, MESSAGE_MAX } from './classify.js';

const PAGE_MAX = 2_000;          // 한 쪽 항목 수 상한(장비가 이상한 값을 줘도 메모리를 지킨다)
const CODES_MAX = 2_000;         // 구성 집계에 담는 서로 다른 기록 ID 수 상한
export const TOP_CODES = 8;      // 결과에 싣는 상위 기록 ID 수
const t = (v, n) => String(v ?? '').slice(0, n);

/** Redfish LogEntry → 보관 행. 시각을 못 읽으면 null(순서 판정에 못 쓴다 — 버리지 않고 센다). */
export function entryRow(e) {
  if (!e || typeof e !== 'object') return null;
  const created = Date.parse(String(e.Created || ''));
  return {
    entryId: t(e.Id, 64), created: Number.isFinite(created) ? created : null,
    messageId: t(e.MessageId, 64), severity: t(e.Severity, 16), message: t(e.Message, MESSAGE_MAX),
  };
}

/** 첫 쪽의 정렬 방향 — 시각이 내려가면 desc, 올라가면 asc, 판단이 안 서면 unknown. */
export function orderOf(rows) {
  const ts = rows.map((r) => r?.created).filter((v) => Number.isFinite(v));
  if (ts.length < 2) return 'unknown';
  const first = ts[0]; const last = ts[ts.length - 1];
  if (first > last) return 'desc';
  if (first < last) return 'asc';
  return 'unknown';
}

/**
 * Lifecycle 로그 읽기.
 * @param {{host:string, username:string, password:string}} entry
 * @param {object} [o]
 * @param {{entryId:string, created:number}|null} [o.cursor]  지난번 읽은 가장 새 항목(없으면 처음 — 전량)
 * @param {AbortSignal|null} [o.signal]
 * @param {number} [o.budgetMs]  쪽 사이에서 볼 예산(넘으면 멈추고 일부만 읽음으로 돌려준다)
 * @param {number} [o.maxEntries]  한 번에 읽을 항목 상한
 * @param {Function} [o.getJson]  테스트 주입
 * @returns {Promise<{mgrPath:string, order:string, total:number|null, read:number, undated:number,
 *   newest:{entryId:string, created:number}|null, oldestRead:number|null, reachedEnd:boolean, foundCursor:boolean,
 *   stopped:''|'budget'|'max'|'skip'|'short'|'empty', entries:Array,
 *   pages:number, ms:number, distinct:number, top:Array<{code:string,n:number}>, firstLen:number, hasNext:boolean, path:'std'|'legacy'}>}
 */
export async function readLclog(entry, { cursor = null, signal = null, budgetMs = 8 * 60_000, maxEntries = 50_000, getJson = redfishGetCapped, now = Date.now } = {}) {
  const t0 = now();
  const G = (p) => getJson(entry, p, { signal });
  const mgrs = await G('/redfish/v1/Managers');
  const mgrPath = String((Array.isArray(mgrs?.Members) ? mgrs.Members : [])[0]?.['@odata.id'] || '/redfish/v1/Managers/iDRAC.Embedded.1');
  const mgr = mgrPath.replace(/\/+$/, '');
  let base = `${mgr}/LogServices/Lclog/Entries`;
  let pages = 0;
  const page = async (skip) => {
    const j = await G(skip > 0 ? `${base}?$skip=${skip}` : base);
    pages += 1;
    const members = Array.isArray(j?.Members) ? j.Members.slice(0, PAGE_MAX) : [];
    const count = Number(j?.['Members@odata.count']);
    return { rows: members.map(entryRow).filter(Boolean), total: Number.isFinite(count) && count >= 0 ? count : null, hasNext: typeof j?.['Members@odata.nextLink'] === 'string' };
  };
  // 반증 #9: `$skip` 을 무시하는 장비는 어느 쪽을 달라 해도 첫 쪽을 준다 — 그대로 믿으면 같은 50건을 끝까지 돌고 '끝까지 읽음' 이라 거짓말한다.
  //   다른 쪽을 달라 했는데 첫 행이 첫 쪽의 첫 행과 같으면 지원하지 않는 것으로 보고 멈춘다(일부만 읽음 — complete:false).
  const rowKey = (r) => (r ? `${r.entryId}|${r.created}` : '');
  let firstKey = '';
  const skipIgnored = (rows) => rows.length > 0 && firstKey !== '' && rowKey(rows[0]) === firstKey;

  const out = { mgrPath, order: 'unknown', total: null, read: 0, undated: 0, newest: null, oldestRead: null, reachedEnd: false, foundCursor: false, cursorUsed: false, stopped: '', entries: [],
    pages: 0, ms: 0, distinct: 0, top: [], firstLen: 0, hasNext: false, path: 'std' };
  // 읽은 항목의 기록 ID 구성(진단 — 판정에 쓰지 않는다). 로그인 기록이 활성 로그를 채웠는지 화면이 보여 준다.
  const codes = new Map();
  const done = () => {
    out.pages = pages; out.ms = Math.max(0, now() - t0); out.distinct = codes.size;
    out.top = [...codes.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_CODES).map(([code, n]) => ({ code, n }));
    return out;
  };
  let cur = cursor && Number.isFinite(cursor.created) ? cursor : null;
  /** 최신 → 과거 순으로 한 항목씩 넘긴다. false 를 돌려주면 그만 읽는다. */
  const take = (r) => {
    out.read += 1;
    const tc = codeOf(r.messageId) || '(ID 없음)';
    if (codes.has(tc) || codes.size < CODES_MAX) codes.set(tc, (codes.get(tc) || 0) + 1);
    if (!Number.isFinite(r.created)) { out.undated += 1; return true; }
    // 가장 새 항목 = 시각이 가장 큰 것(최신 먼저면 첫 항목 · 건수를 몰라 오래된 것부터 읽을 때는 마지막 항목).
    if (!out.newest || r.created > out.newest.created) out.newest = { entryId: r.entryId, created: r.created };
    // 반증 #14: 지난번 자리는 **같은 항목(Id · 시각)** 을 만났을 때만 찾은 것이다. 시각이 더 오래된 항목을 먼저 만나도 멈추지 않는다 —
    //   iDRAC 시계가 거꾸로 갔거나(RTC · 공장 초기화) 같은 주소에 다른 서버가 오면 '더 오래된 시각' 의 새 항목이 있다. 못 찾으면 끝까지 읽는다(gap).
    if (cur && r.created === cur.created && (!cur.entryId || r.entryId === cur.entryId)) { out.foundCursor = true; return false; }
    out.oldestRead = out.oldestRead == null ? r.created : Math.min(out.oldestRead, r.created);
    const code = codeOf(r.messageId);
    if (code && isStorageCode(code)) out.entries.push({ ...r, code });
    return true;
  };
  const overBudget = () => {
    if (out.read >= maxEntries) { out.stopped = 'max'; return true; }
    if (now() - t0 > budgetMs) { out.stopped = 'budget'; return true; }
    return false;
  };

  let first;
  try { first = await page(0); } catch (e) {
    // 12G/13G(iDRAC7/8)는 경로가 다르다(Dell 공식 스크립트 GetIdracLcLogsREDFISH.py — `Logs/Lclog`). 표준 경로가 없을 때만 시도한다.
    if (e?.status !== 404) throw e;
    base = `${mgr}/Logs/Lclog`; out.path = 'legacy';
    first = await page(0);
  }
  firstKey = rowKey(first.rows[0]);
  out.firstLen = first.rows.length; out.hasNext = first.hasNext;
  // 건수(Members@odata.count)는 **첫 쪽보다 클 때만** 전체 건수로 믿는다. 다음 쪽 링크가 있는데 건수가 첫 쪽 길이 이하이면 그 값은
  //   '이 쪽의 건수' 다(펌웨어마다 다를 수 있다 — Dell 공식 스크립트는 건수를 쓰지 않고 빈 쪽까지 넘긴다). 그때는 건수를 모르는 것으로 두고 빈 쪽까지 읽는다.
  out.total = (first.total != null && first.hasNext && first.total <= first.rows.length) ? null : first.total;
  out.order = orderOf(first.rows);
  // cursor 로 멈추는 것은 '최신부터 읽고 있다' 가 확실할 때만 — 방향을 모르거나(unknown) 오래된 것 먼저인데 전체 건수를 모르면
  //   첫 항목(가장 오래된 것)에서 멈춰 '이어 읽었다' 고 거짓말하게 된다. 그때는 전량을 읽는다(중앙이 중복을 거른다).
  if (!(out.order === 'desc' || (out.order === 'asc' && out.total != null))) cur = null;
  out.cursorUsed = !!cur;
  // 항목이 하나도 없으면 '끝까지 읽음' 이 아니다 — 빈 로그(또는 모양이 다른 응답)를 '기록 없음' 으로 말하지 않는다.
  if (!first.rows.length) { out.stopped = 'empty'; return done(); }

  if (out.order === 'asc' && out.total != null) {
    // 오래된 것 먼저 — 끝쪽부터 거꾸로(최신부터) 읽는다. 쪽 크기는 장비가 준 첫 쪽 길이.
    const size = first.rows.length;
    let end = out.total;
    let firstPage = true;
    while (end > 0) {
      if (!firstPage && overBudget()) return done();
      const start = Math.max(0, end - size);
      const rows = start === 0 ? first.rows.slice(0, end) : (await page(start)).rows;
      if (start > 0 && skipIgnored(rows)) { out.stopped = 'skip'; return done(); }
      firstPage = false;
      // 건수 안쪽인데 빈 쪽 — 끝이 아니라 도중에 끊긴 것이다(그 아래를 못 봤다).
      if (!rows.length) { out.stopped = 'short'; return done(); }
      for (let i = rows.length - 1; i >= 0; i -= 1) if (!take(rows[i])) return done();
      end = start;
    }
    out.reachedEnd = true;
    return done();
  }
  // 최신 먼저(또는 판단 불가 — 그대로 앞에서부터. 판단 불가일 때 cursor 로 멈추는 것은 desc 와 같은 가정이라 화면이 order 를 밝힌다).
  let rows = first.rows;
  let skip = 0;
  for (;;) {
    for (const r of rows) if (!take(r)) return done();
    skip += rows.length;
    if (out.total != null && skip >= out.total) break;
    if (overBudget()) return done();
    rows = (await page(skip)).rows;
    if (skipIgnored(rows)) { out.stopped = 'skip'; return done(); }
    if (!rows.length) {
      // 장비가 알려 준 건수보다 먼저 빈 쪽이 왔다 — '끝' 으로 치지 않는다(도중에 끊김 · 일부만 읽음).
      if (out.total != null && skip < out.total) { out.stopped = 'short'; return done(); }
      break;
    }
  }
  out.reachedEnd = true;
  return done();
}

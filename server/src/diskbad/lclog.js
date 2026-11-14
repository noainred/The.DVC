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
 * ⚠ 장비 시한: 호출자(scan.js)가 `signal` 로 세션을 실제로 끊는다(withDeadline). 여기서는 그와 별도로 **쪽 사이에서**
 *   남은 예산을 보고 멈춘다 — 그러면 읽은 데까지는 결과로 남는다(일부만 읽음 — complete:false).
 */
import { redfishGetCapped } from '../idrac/redfish.js';
import { codeOf, isStorageCode, MESSAGE_MAX } from './classify.js';

const PAGE_MAX = 2_000;          // 한 쪽 항목 수 상한(장비가 이상한 값을 줘도 메모리를 지킨다)
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
 *   stopped:''|'budget'|'max'|'skip', entries:Array}>}
 */
export async function readLclog(entry, { cursor = null, signal = null, budgetMs = 8 * 60_000, maxEntries = 50_000, getJson = redfishGetCapped, now = Date.now } = {}) {
  const t0 = now();
  const G = (p) => getJson(entry, p, { signal });
  const mgrs = await G('/redfish/v1/Managers');
  const mgrPath = String((Array.isArray(mgrs?.Members) ? mgrs.Members : [])[0]?.['@odata.id'] || '/redfish/v1/Managers/iDRAC.Embedded.1');
  const base = `${mgrPath.replace(/\/+$/, '')}/LogServices/Lclog/Entries`;
  const page = async (skip) => {
    const j = await G(skip > 0 ? `${base}?$skip=${skip}` : base);
    const members = Array.isArray(j?.Members) ? j.Members.slice(0, PAGE_MAX) : [];
    const count = Number(j?.['Members@odata.count']);
    return { rows: members.map(entryRow).filter(Boolean), total: Number.isFinite(count) && count >= 0 ? count : null };
  };
  // 반증 #9: `$skip` 을 무시하는 장비는 어느 쪽을 달라 해도 첫 쪽을 준다 — 그대로 믿으면 같은 50건을 끝까지 돌고 '끝까지 읽음' 이라 거짓말한다.
  //   다른 쪽을 달라 했는데 첫 행이 첫 쪽의 첫 행과 같으면 지원하지 않는 것으로 보고 멈춘다(일부만 읽음 — complete:false).
  const rowKey = (r) => (r ? `${r.entryId}|${r.created}` : '');
  let firstKey = '';
  const skipIgnored = (rows) => rows.length > 0 && firstKey !== '' && rowKey(rows[0]) === firstKey;

  const out = { mgrPath, order: 'unknown', total: null, read: 0, undated: 0, newest: null, oldestRead: null, reachedEnd: false, foundCursor: false, cursorUsed: false, stopped: '', entries: [] };
  let cur = cursor && Number.isFinite(cursor.created) ? cursor : null;
  /** 최신 → 과거 순으로 한 항목씩 넘긴다. false 를 돌려주면 그만 읽는다. */
  const take = (r) => {
    out.read += 1;
    if (!Number.isFinite(r.created)) { out.undated += 1; return true; }
    if (!out.newest) out.newest = { entryId: r.entryId, created: r.created };
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

  const first = await page(0);
  firstKey = rowKey(first.rows[0]);
  out.total = first.total;
  out.order = orderOf(first.rows);
  // cursor 로 멈추는 것은 '최신부터 읽고 있다' 가 확실할 때만 — 방향을 모르거나(unknown) 오래된 것 먼저인데 전체 건수를 모르면
  //   첫 항목(가장 오래된 것)에서 멈춰 '이어 읽었다' 고 거짓말하게 된다. 그때는 전량을 읽는다(중앙이 중복을 거른다).
  if (!(out.order === 'desc' || (out.order === 'asc' && out.total != null))) cur = null;
  out.cursorUsed = !!cur;
  if (!first.rows.length) { out.reachedEnd = true; return out; }

  if (out.order === 'asc' && out.total != null) {
    // 오래된 것 먼저 — 끝쪽부터 거꾸로(최신부터) 읽는다. 쪽 크기는 장비가 준 첫 쪽 길이.
    const size = first.rows.length;
    let end = out.total;
    let firstPage = true;
    while (end > 0) {
      if (!firstPage && overBudget()) return out;
      const start = Math.max(0, end - size);
      const rows = start === 0 ? first.rows.slice(0, end) : (await page(start)).rows;
      if (start > 0 && skipIgnored(rows)) { out.stopped = 'skip'; return out; }
      firstPage = false;
      for (let i = rows.length - 1; i >= 0; i -= 1) if (!take(rows[i])) return out;
      if (!rows.length) break;
      end = start;
    }
    out.reachedEnd = true;
    return out;
  }
  // 최신 먼저(또는 판단 불가 — 그대로 앞에서부터. 판단 불가일 때 cursor 로 멈추는 것은 desc 와 같은 가정이라 화면이 order 를 밝힌다).
  let rows = first.rows;
  let skip = 0;
  for (;;) {
    for (const r of rows) if (!take(r)) return out;
    skip += rows.length;
    if (out.total != null && skip >= out.total) break;
    if (overBudget()) return out;
    rows = (await page(skip)).rows;
    if (skipIgnored(rows)) { out.stopped = 'skip'; return out; }
    if (!rows.length) break;
  }
  out.reachedEnd = true;
  return out;
}

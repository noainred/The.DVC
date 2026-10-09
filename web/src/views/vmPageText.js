/**
 * VM 목록 서버 페이지(v2.730, 검토 I-02) — 판정·문구 한 벌. 화면(`Vms.jsx`)은 이 모듈의 결과를 그리기만 한다.
 *
 * 서버 계약(`server/src/inventory/vmPaging.js`): `paged=1` 로 첫 페이지, 응답의 `nextCursor` 로 다음 페이지.
 *  - 순서와 대상 집합은 첫 페이지를 계산한 스냅샷 시점에 고정된다(`page.orderAsOf`) — 값은 최신 스냅샷 것이다.
 *    그래서 순회 중 사라진 VM 은 건너뛰고(`page.vanished`), 새로 생긴 VM 은 이 순회에 없다(`page.added`).
 *    둘 다 숨기지 않고 말한다(조용한 누락 금지).
 *  - 순서 기억이 만료되면(서버 재시작·오래 머묾) 409 `cursor-stale` — 첫 페이지로 돌아가고 그 사실을 말한다.
 *  - 커서 형식·정렬·조건 불일치는 400(`cursor-invalid`·`cursor-sort-mismatch`·`cursor-query-mismatch`) — 화면이
 *    직접 만들지 않으므로 생기면 첫 페이지로 돌아간다.
 * 문구에 백틱을 쓰지 않는다(BoldText 는 별표 두 개 강조만 해석한다). 숫자는 en-US 천 단위 구분.
 */

/** 한 페이지에 받는 VM 수 — 서버 상한(5,000)보다 작게 둔다(전량을 한 번에 그리지 않는다). */
export const VM_PAGE_SIZE = 1000;

const fmt = (n) => (Number.isFinite(n) ? n.toLocaleString('en-US') : '—');
const nonNeg = (v) => (Number.isFinite(v) && v >= 0 ? v : null);

/** 페이지 순회를 처음으로 되돌릴 조건(필터·GPU 선택)의 키 — 바뀌면 커서 스택을 버린다. */
export function vmPageQueryKey(filters, gpuOnly, gpuType) {
  const f = filters && typeof filters === 'object' ? filters : {};
  const keys = Object.keys(f).sort();
  return JSON.stringify([keys.map((k) => [k, f[k]]), !!gpuOnly, gpuType || '']);
}

const STALE = new Set(['cursor-stale']);
const INVALID = new Set(['cursor-invalid', 'cursor-sort-mismatch', 'cursor-query-mismatch']);
/** usePolling 의 error(서버 reason 문자열)를 커서 오류 종류로 — 'stale' | 'invalid' | null. */
export function cursorErrorKind(error) {
  const s = typeof error === 'string' ? error : (error && typeof error.message === 'string' ? error.message : '');
  if (STALE.has(s)) return 'stale';
  if (INVALID.has(s)) return 'invalid';
  return null;
}

/** 첫 페이지로 돌아온 이유 문구. */
export function resetNoticeText(kind) {
  if (kind === 'stale') return '목록 순서 기준이 만료되어(서버 재시작 또는 오래 머묾) 첫 페이지로 돌아왔습니다.';
  if (kind === 'invalid') return '페이지 정보를 읽지 못해 첫 페이지로 돌아왔습니다.';
  return '';
}

/** 이전·다음 버튼 상태. stack = 지금까지 누른 다음 페이지 커서들(비면 첫 페이지). */
export function pageNavState(stack, data) {
  const depth = Array.isArray(stack) ? stack.length : 0;
  const nextCursor = typeof data?.nextCursor === 'string' && data.nextCursor ? data.nextCursor : null;
  return {
    pageNo: depth + 1,
    canFirst: depth > 0,
    canPrev: depth > 0,
    canNext: !!(data?.hasMore && nextCursor),
    nextCursor,
  };
}

/**
 * 몇 개를 보고 있는지·전체 몇 개인지·건너뛴 것이 있는지.
 * @returns {{ head: string, notes: string[] }}
 */
export function vmPageSummary(data) {
  const items = Array.isArray(data?.items) ? data.items : [];
  const shown = items.length;
  const total = nonNeg(data?.total);
  const pg = data?.page && typeof data.page === 'object' ? data.page : null;
  const notes = [];
  if (!pg) {
    // 서버가 페이지 정보를 주지 않았다(구버전 중앙 등) — 예전 문구 그대로 말하고 페이지 이동을 약속하지 않는다.
    const head = total != null && total > shown
      ? `전체 ${fmt(total)}개 중 ${fmt(shown)}개만 받았습니다 — 나머지는 필터로 좁혀 보세요.`
      : `전체 ${fmt(total ?? shown)}개를 모두 표시합니다.`;
    return { head, notes };
  }
  const start = nonNeg(pg.start) ?? 0;
  const next = nonNeg(pg.next);
  const orderTotal = nonNeg(pg.orderTotal);
  let head;
  if (shown === 0) {
    head = total === 0 ? '조건에 맞는 VM 이 없습니다.' : `이 페이지에 표시할 VM 이 없습니다 — 전체 ${fmt(total)}개.`;
  } else {
    const range = next != null && next > start ? ` (순서상 ${fmt(start + 1)}–${fmt(next)}번째${orderTotal != null ? ` / ${fmt(orderTotal)}` : ''})` : '';
    head = `${fmt(shown)}개 표시${range} · 전체 ${fmt(total)}개`;
  }
  const remaining = nonNeg(pg.remaining);
  if (remaining) notes.push(`아직 ${fmt(remaining)}개가 더 있습니다 — 다음 페이지로 이어 보세요.`);
  const vanished = nonNeg(pg.vanished);
  if (vanished) notes.push(`순서를 정한 뒤 사라졌거나 조건에서 벗어난 VM ${fmt(vanished)}개는 건너뛰었습니다.`);
  const added = nonNeg(pg.added);
  if (added) notes.push(`순서를 정한 뒤 새로 조건에 맞게 된 VM ${fmt(added)}개는 이 순회에 없습니다 — 처음 페이지부터 다시 보면 포함됩니다.`);
  if (typeof pg.orderAsOf === 'string' && typeof data?.snapshotAt === 'string' && pg.orderAsOf !== data.snapshotAt) {
    notes.push('순서는 첫 페이지를 받은 시점 기준이고, 표시 값은 최신 수집 값입니다.');
  }
  return { head, notes };
}

/**
 * 표 위 설명 — 서버가 나눠 보내는 기준(나눠 받을 때만, 아니면 빈 문자열). 화면(Vms.jsx)이 이 뒤에
 * '다른 열로 정렬하면 이 페이지 안에서만 정렬된다' 를 붙인다(v2.631 WEB2631-10 테스트가 그 문장을 화면 소스에서 고정한다).
 */
export function vmPageSortNote(data) {
  const pg = data?.page;
  if (!pg || !(data?.hasMore || (nonNeg(pg.start) ?? 0) > 0)) return '';
  const size = nonNeg(pg.size);
  return `CPU 사용률 높은 순으로 ${size ? `${fmt(size)}개씩 ` : ''}나눠 받습니다.`;
}

/* ── 페이지 이동 상태(화면의 useState 값) — 순수 전이 ─────────────────── */
/** 지금 조건(queryKey)의 커서 스택·안내. 조건이 바뀌었으면 첫 페이지(빈 스택)다. */
export function navView(nav, queryKey) {
  const same = !!nav && nav.key === queryKey;
  return { stack: same && Array.isArray(nav.stack) ? nav.stack : [], notice: same ? (nav.notice || null) : null };
}
/** 다음 페이지 — 커서를 쌓는다(빈 커서는 무시). */
export function navNext(nav, queryKey, cursor) {
  const { stack } = navView(nav, queryKey);
  if (typeof cursor !== 'string' || !cursor) return { key: queryKey, stack, notice: null };
  return { key: queryKey, stack: [...stack, cursor], notice: null };
}
/** 이전 페이지 · 처음. */
export function navPrev(nav, queryKey) { const { stack } = navView(nav, queryKey); return { key: queryKey, stack: stack.slice(0, -1), notice: null }; }
export function navFirst(queryKey) { return { key: queryKey, stack: [], notice: null }; }
/**
 * 커서 오류(409 만료·400 거절)를 받았을 때 — 첫 페이지로 되돌린 상태(안내 포함). 되돌릴 것이 없으면 null.
 * 첫 페이지(커서 없음)에서는 커서 오류가 날 수 없으므로 null 이다(같은 오류로 무한히 되돌리지 않게).
 */
export function navAfterError(nav, queryKey, error) {
  const kind = cursorErrorKind(error);
  const { stack } = navView(nav, queryKey);
  if (!kind || !stack.length) return null;
  return { key: queryKey, stack: [], notice: kind };
}

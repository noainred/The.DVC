/**
 * commmap/demoMask.js — 통신 지도·데이터 흐름 지도·3단 지도의 **데모 계정 판본** 입력 가림(v2.768 점검 R3-C2-2).
 *
 * mock 모드 데모 계정(요청 문맥 role admin + demoGuest)은 adminOnly 를 통과해 세 화면을 본다(v2.716 '조회 전부').
 * 그런데 입력에는 **사람이 등록한** 수집 서버(엣지 origin·이름·데이터센터)·vCenter·스토리지·SAN·PDU·iDRAC(이름·서비스태그)와
 * 실제 엣지가 남긴 수신·거부·pull·중앙→엣지 기록이 섞인다 — 형제 화면(수집 서버·엣지 로그)은 같은 이유로 데모 계정에 403 이다.
 * 화면은 그대로 열고(audit2743a 가 xfer-speed 200 을 고정한 것과 같은 판단) **데모 엣지·데모 항목만 남긴 입력**으로 조립한다
 * — 조립기(buildCommMap·buildDataFlow·buildDeviceFlow)는 손대지 않으므로 합계·상태가 남은 행과 어긋나지 않는다
 * (portalcheck/invScan.js maskInventoryForDemoGuest 와 같은 패턴 — 가린 수는 `demoMasked` 로 밝힌다).
 *
 * 순수 모듈 — 데모 판정은 호출부가 넘긴다(mock/demo/edge.js 를 여기서 import 하지 않는다: 의존 방향).
 * ⚠ 이 판본을 쓰는 라우트는 memoJson `extraKey` 에 데모 여부를 반드시 넣는다(키에 사용자 축이 없으면 관리자 판본과 섞인다).
 */

const t = (v) => String(v ?? '').trim();
const arr = (v) => (Array.isArray(v) ? v : []);

/**
 * @param {object} inp   gatherCommInputs / gatherFlowInputs 결과(있는 키만 가린다)
 * @param {object} preds
 * @param {(c:object)=>boolean} preds.isDemoCollector  수집 서버 항목이 데모 엣지인가
 * @param {(name:string)=>boolean} preds.isDemoAgent  엣지 이름(agent)이 데모 엣지인가
 * @param {(item:object)=>boolean} [preds.isDemoItem] 등록부 항목(vCenter·장비)이 데모 항목인가(기본: 없음 — 등록부는 사람이 넣는다)
 * @param {(url:string)=>boolean} [preds.isDemoOrigin] 주소가 데모 엣지 주소인가(중앙→엣지 호출 기록)
 * @returns {{ inputs: object, masked: Record<string, number> }}
 */
export function maskFlowInputsForDemoGuest(inp = {}, { isDemoCollector = () => false, isDemoAgent = () => false, isDemoItem = () => false, isDemoOrigin = () => false } = {}) {
  const out = { ...inp };
  const masked = {};
  const keep = (key, list, pred) => {
    const src = arr(list);
    const kept = src.filter((x) => { try { return !!pred(x); } catch { return false; } });
    if (src.length !== kept.length) masked[key] = (masked[key] || 0) + (src.length - kept.length);
    return kept;
  };
  const byAgent = (x) => isDemoAgent(t(x?.agent));

  if ('collectors' in inp) out.collectors = keep('collectors', inp.collectors, isDemoCollector);
  for (const k of ['vcenters', 'storage', 'sanswitch', 'pdu']) if (k in inp) out[k] = keep(k, inp[k], isDemoItem);
  if (inp.status && typeof inp.status === 'object') {
    out.status = Object.fromEntries(Object.entries(inp.status).filter(([id]) => isDemoAgent(id)));
  }
  if (inp.edgeReports && typeof inp.edgeReports === 'object') {
    out.edgeReports = Object.fromEntries(Object.entries(inp.edgeReports).filter(([id]) => isDemoAgent(id)));
  }
  if (inp.ingest && typeof inp.ingest === 'object') {
    const rows = keep('ingest', inp.ingest.rows, byAgent);
    const firsts = rows.map((r) => Number(r.firstAt)).filter((v) => v > 0);
    out.ingest = { ...inp.ingest, rows, totalBytes: rows.reduce((s, r) => s + (Number(r.wireBytes) || 0), 0), agents: rows.length,
      since: firsts.length ? Math.min(...firsts) : null };
    if ('ingestSince' in inp) out.ingestSince = out.ingest.since;
  }
  if (inp.rejects && typeof inp.rejects === 'object') {
    const rows = keep('rejects', inp.rejects.rows, byAgent);
    const recent = arr(inp.rejects.recent).filter(byAgent);
    out.rejects = { ...inp.rejects, rows, recent, total: rows.reduce((s, r) => s + (Number(r.total) || 0), 0) };
  }
  // pull 기록 — 인증 실패 칸(이름 없는 실제 요청)도 데모 엣지가 아니다 → 뺀다.
  if (inp.pulls && typeof inp.pulls === 'object') out.pulls = { ...inp.pulls, rows: keep('pulls', inp.pulls.rows, byAgent) };
  if (inp.outbound && typeof inp.outbound === 'object') {
    out.outbound = { ...inp.outbound, rows: keep('outbound', inp.outbound.rows, (o) => isDemoAgent(t(o?.tag)) || isDemoOrigin(t(o?.base) || t(o?.origin))) };
  }
  for (const k of ['storageReports', 'pduReports', 'sanReports']) if (k in inp) out[k] = arr(inp[k]).filter(byAgent);
  // 통신 점검 최신값 — 링크 id 의 끝점이 데모 엣지이거나 중앙인 것만(실제 엣지 이름이 링크 id 에 들어 있다).
  if ('latestLinks' in inp) out.latestLinks = arr(inp.latestLinks).filter((r) => t(r?.link_id).split('|').slice(1).every((n) => n === 'central' || isDemoAgent(n)));
  return { inputs: out, masked };
}

/**
 * 3단 지도의 iDRAC 입력 — 중앙 등록부(사람이 넣는다)는 데모 항목만, 엣지 위임분은 데모 엣지가 올린 것만.
 * @returns {{ idracLocal: object[], idracRemote: object[], masked: Record<string, number> }}
 */
export function maskIdracForDemoGuest(idracLocal = [], idracRemote = [], { isDemoAgent = () => false, isDemoItem = () => false } = {}) {
  const loc = arr(idracLocal); const rem = arr(idracRemote);
  const l2 = loc.filter((s) => isDemoItem(s));
  const r2 = rem.filter((s) => isDemoAgent(t(s?.collectorId)));
  const masked = {};
  if (loc.length !== l2.length) masked.idrac = loc.length - l2.length;
  if (rem.length !== r2.length) masked.idracEdge = rem.length - r2.length;
  return { idracLocal: l2, idracRemote: r2, masked };
}

/** 가린 수 둘을 합친다(키별 합). */
export function mergeMasked(...parts) {
  const out = {};
  for (const p of parts) for (const [k, v] of Object.entries(p || {})) out[k] = (out[k] || 0) + (Number(v) || 0);
  return out;
}

/** 같은 원천을 두 번 가린 결과(통신 입력·흐름 입력이 수집 서버·수신·거부를 함께 읽는다)는 키별 최댓값으로 — 두 번 세지 않게. */
export function maxMasked(a = {}, b = {}) {
  const out = {};
  for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) out[k] = Math.max(Number(a?.[k]) || 0, Number(b?.[k]) || 0);
  return out;
}

/**
 * views/tools/storageNodeText.js — 스토리지 **노드 장애 표지** 판정·문구(v2.523, 순수 모듈).
 *
 * 사용자 요청(2026-09-16): "장애표지 클릭하면 어떤 장애인지 확인하는 팝업 만들어줘"
 * (스크린샷: Isilon `OC2-A` 의 노드 열이 `24 ⚠1` — 24대 중 1대가 비정상인데 **어느 노드인지
 * 알 방법이 없었다**. 표지는 클릭되지 않는 `<b>` 였다).
 *
 * ★ 이 모듈이 지켜야 하는 정직성
 *  · **`unknown` 을 비정상으로 세지 않는다.** 수집기들이 이미 그렇게 세고 있다
 *    (`isilon.js:92` · `unity.js:42` 등 — `st !== 'unknown' && !/ok|healthy/`). 화면도 같은
 *    기준을 쓰고, '상태를 읽지 못한 노드' 수는 **따로** 밝힌다.
 *  · **노드 목록이 없으면 '어느 노드인지 모른다' 고 말한다.** 일부 수집기는 개수만 준다
 *    (`powerstore.js:92` 는 `unhealthy: 0` + health 'unknown' 목록). 목록이 비어 있는데
 *    '비정상 0대' 라고 말하면 거짓이고, 지어낸 노드를 보여주는 것도 거짓이다.
 *  · **목록 상한(64)으로 잘렸으면 밝힌다** — `count > list.length` 면 조용한 절단이다.
 */

const n0 = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** 노드 상태 문자열 → 'ok' | 'bad' | 'unknown'(수집기 판정 기준과 같게). */
export function nodeHealthKind(health) {
  const s = String(health ?? '').trim().toLowerCase();
  if (!s || s === 'unknown' || s === 'n/a' || s === '-') return 'unknown';
  if (/^(ok|healthy|normal|up|green|attention_none)$/.test(s) || /\bok\b|healthy|normal|online|up\b|green/.test(s)) return 'ok';
  return 'bad';
}
export const NODE_KIND = Object.freeze({
  ok: { label: '정상', color: 'green' },
  bad: { label: '이상', color: 'red' },
  unknown: { label: '상태 미확인', color: 'muted' },
});
export const nodeKindLabel = (k) => NODE_KIND[k] || NODE_KIND.unknown;

const pctOf = (x) => (x && Number.isFinite(Number(x.pct)) ? Number(x.pct) : null);

/** 표에 그릴 노드 행(순수). 이름이 없으면 id·ip 로 대체하고 **지어내지 않는다**. */
export function nodeRows(snap) {
  const list = Array.isArray(snap?.nodes?.list) ? snap.nodes.list : [];
  return list.map((n, i) => {
    const kind = nodeHealthKind(n.health);
    return {
      key: String(n.id ?? n.name ?? n.ip ?? i),
      label: String(n.name || (n.id != null ? `노드 ${n.id}` : '') || n.ip || `#${i + 1}`),
      ip: String(n.ip || ''),
      health: String(n.health ?? ''),
      kind,
      hddPct: pctOf(n.hdd),
      ssdPct: pctOf(n.ssd),
      inBps: Number.isFinite(Number(n.inBps)) ? Number(n.inBps) : null,
      outBps: Number.isFinite(Number(n.outBps)) ? Number(n.outBps) : null,
    };
  });
}

/**
 * 표지 요약 — 팝업 머리말. **무엇을 알고 무엇을 모르는지** 분리해서 말한다.
 * @returns {{count,unhealthy,unknown,listed,missing,badRows,tone,title,body}}
 */
export function nodeFaultSummary(snap) {
  const count = n0(snap?.nodes?.count);
  const unhealthy = n0(snap?.nodes?.unhealthy);
  const rows = nodeRows(snap);
  const badRows = rows.filter((r) => r.kind === 'bad');
  const unknown = rows.filter((r) => r.kind === 'unknown').length;
  const listed = rows.length;
  const missing = Math.max(0, count - listed);
  const section = String(snap?.sections?.nodes || '');

  let tone = unhealthy ? 'red' : 'green';
  let title = unhealthy ? `노드 ${count}대 중 ${unhealthy}대가 비정상입니다` : `노드 ${count}대 · 비정상 없음`;
  const bits = [];
  if (!listed) {
    // 개수만 알고 목록이 없다 — 어느 노드인지 **모른다**(지어내지 않는다).
    tone = unhealthy ? 'amber' : 'muted';
    bits.push('이 수집기는 **노드 개수만** 알려주고 노드별 상태 목록을 주지 않습니다 — **어느 노드인지 알 수 없습니다**.');
    if (section && section !== 'ok') bits.push(`노드 수집 상태: ${section}`);
  } else {
    if (badRows.length !== unhealthy) {
      // 요약 수치와 목록이 어긋나면 **숨기지 않고 밝힌다**(상한 절단·수집 시점 차이).
      bits.push(`요약은 ${unhealthy}대라고 하는데 목록에서 이상으로 보이는 노드는 ${badRows.length}대입니다 — 목록 상한이나 수집 시점 차이일 수 있습니다.`);
    }
    if (missing) bits.push(`노드 목록은 ${listed}대만 올라왔습니다(전체 ${count}대) — **나머지 ${missing}대는 상태를 알 수 없습니다**.`);
    if (unknown) bits.push(`상태를 읽지 못한 노드 ${unknown}대는 **비정상으로 세지 않았습니다**(정상이라는 뜻도 아닙니다).`);
  }
  return { count, unhealthy, unknown, listed, missing, badRows, tone, title, body: bits.join(' ') };
}

/** bps 를 사람 단위로(노드 표의 처리량 열). 값이 없으면 '—'. */
export function bpsText(v) {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  const n = Number(v);
  if (n < 1000) return `${n} bps`;
  const u = ['Kbps', 'Mbps', 'Gbps', 'Tbps'];
  let x = n / 1000; let i = 0;
  while (x >= 1000 && i < u.length - 1) { x /= 1000; i++; }
  return `${x.toFixed(x < 10 ? 1 : 0)} ${u[i]}`;
}

/** 표지에 붙일 접근성 문구(버튼 title). */
export function faultBadgeTitle(snap) {
  const s = nodeFaultSummary(snap);
  return s.unhealthy ? `${s.title} — 클릭하면 어느 노드인지 봅니다` : `${s.title} — 클릭하면 노드별 상태를 봅니다`;
}

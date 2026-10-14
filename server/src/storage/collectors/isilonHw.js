/**
 * storage/collectors/isilonHw.js — PowerScale(Isilon) 노드별 시리얼·제품명(v2.735.2, 사용자 요청
 * "powerscale 장비에서 각 장비의 시리얼/service tag 보이게 해줘").
 *
 * ── 경로 ─────────────────────────────────────────────────────────────────────
 *  · SSH: `isi_for_array -s isi_hw_status -i` — 각 노드의 식별 정보(SerNo·ChsSerN·Product)를 노드 이름
 *    접두(`<클러스터>-<LNN>:`)와 함께 한 번에 받는다. `isi status` 노드 표의 ID 가 LNN 이라 그 번호로 붙인다.
 *  · REST: `/platform/3/cluster/nodes` 의 노드 객체 `hardware` 하위(serial_number·product) — 이미 받는 응답이다(왕복 0).
 *
 * ⚠ 정직 기록 — **이 현장 장비의 두 출력을 본 적이 없다.** `isi_hw_status -i` 의 키(SerNo·ChsSerN·Product)와 REST 의
 *   hardware 필드 이름은 OneFS 문서·KB 기준 지식이다. 그래서 키를 후보 집합으로 읽고, 못 읽으면 값을 지어내지 않고
 *   **사유와 원문 앞부분**을 남긴다(`extra.nodeSerialProbe`) — 첫 실수집에서 그것을 보고 좁힐 것.
 *   Dell 기반 PowerScale(F200·F600·F900 등)의 SerNo 가 Dell 서비스태그인지도 확인하지 못했다 — 장비가 준 값을 그대로 보여준다.
 *   노드 이름을 바꾼 클러스터는 접두의 숫자가 LNN 이 아닐 수 있다(그때 다른 노드에 붙지 않도록 접두 이름이 '<클러스터>-<숫자>'
 *   꼴일 때만 쓴다 — 클러스터 이름은 `isi status` 에서 받아 대조한다).
 *
 * ── 비용 ─────────────────────────────────────────────────────────────────────
 *  시리얼은 바뀌지 않는다 — 장비당 **6시간에 한 번**만 묻고(성공 캐시), 실패하면 1시간 뒤에 다시 묻는다(지원하지 않는 계정·셸에서
 *  매 주기 45초를 쓰지 않게). 세션이 이미 오래 걸렸으면(장비 시한 180초 안쪽 예산) 시작하지 않고 사유를 남긴다.
 */

export const ISI_HW_CMD = 'isi_for_array -s isi_hw_status -i';
export const HW_OK_TTL_MS = 6 * 3_600_000;
export const HW_FAIL_RETRY_MS = 3_600_000;
/** 세션 안에서 이 시각(세션 시작 기준)이 지났으면 시작하지 않는다 — 장비 시한(기본 180초) 안에 끝나게. */
export const HW_START_BUDGET_MS = 100_000;
export const HW_CMD_TIMEOUT_MS = 45_000;
const CACHE_MAX = 1024;
const LINE_MAX = 600;
const VAL_MAX = 128;

const SERIAL_KEYS = ['serno', 'serial number', 'serial', 'service tag', 'servicetag'];
const CHASSIS_KEYS = ['chsserno', 'chsser', 'chssern', 'chassis serial', 'chassis serial number'];
const PRODUCT_KEYS = ['product', 'model'];

const clean = (v) => {
  const s = String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!s || /^(n\/a|none|unknown|-+)$/i.test(s)) return '';
  return s.length > VAL_MAX ? s.slice(0, VAL_MAX) : s;
};

/**
 * `isi_for_array -s isi_hw_status -i` 출력 → { byLnn: {lnn: {serial, chassisSerial, model}}, nodes, prefixes }.
 * 줄 형태: `<노드 이름>:<공백><키>: <값>` — 노드 이름은 '<클러스터>-<숫자>'. clusterName 을 주면 접두가 그 이름일 때만 받는다.
 * 선형으로 읽는다(줄 길이 상한 · indexOf — 장비 출력도 외부 입력이다, v2.598 INJ 규약).
 */
export function parseIsiHwStatus(text, { clusterName = '' } = {}) {
  const byLnn = {};
  const prefixes = new Set();
  const want = String(clusterName || '').trim().toLowerCase();
  for (const raw0 of String(text || '').split(/\r?\n/)) {
    const line = raw0.length > LINE_MAX ? raw0.slice(0, LINE_MAX) : raw0;
    const c1 = line.indexOf(':');
    if (c1 <= 0) continue;
    const prefix = line.slice(0, c1).trim();
    const dash = prefix.lastIndexOf('-');
    if (dash <= 0 || /\s/.test(prefix)) continue;
    const num = prefix.slice(dash + 1);
    if (!/^\d{1,4}$/.test(num)) continue;
    const cname = prefix.slice(0, dash).toLowerCase();
    if (want && cname !== want) continue;
    const rest = line.slice(c1 + 1);
    const c2 = rest.indexOf(':');
    if (c2 <= 0) continue;
    const key = rest.slice(0, c2).trim().toLowerCase();
    const val = clean(rest.slice(c2 + 1));
    if (!key || !val) continue;
    prefixes.add(cname);
    const lnn = String(Number(num));
    const rec = byLnn[lnn] || (byLnn[lnn] = { serial: '', chassisSerial: '', model: '' });
    if (!rec.serial && SERIAL_KEYS.includes(key)) rec.serial = val;
    else if (!rec.chassisSerial && CHASSIS_KEYS.includes(key)) rec.chassisSerial = val;
    else if (!rec.model && PRODUCT_KEYS.includes(key)) rec.model = val;
  }
  for (const k of Object.keys(byLnn)) {
    const r = byLnn[k];
    if (!r.serial && !r.chassisSerial && !r.model) delete byLnn[k];
  }
  return { byLnn, nodes: Object.keys(byLnn).length, prefixes: [...prefixes].slice(0, 4) };
}

/** REST `/platform/N/cluster/nodes` 노드 객체 → { serial, chassisSerial, model }(없으면 빈 문자열). */
export function isiNodeHwFromRest(n) {
  const hw = n && typeof n.hardware === 'object' && n.hardware ? n.hardware : {};
  const pick = (...vals) => { for (const v of vals) { const c = typeof v === 'string' || typeof v === 'number' ? clean(v) : ''; if (c) return c; } return ''; };
  return {
    serial: pick(hw.serial_number, hw.serial, n?.serial_number, n?.serial),
    chassisSerial: pick(hw.chassis_serial_number, hw.chassis_serial, hw.chassis_sn),
    model: pick(hw.product, hw.model, n?.product, n?.model),
  };
}

/* ── 캐시(장비별) ─────────────────────────────────────────────────────────── */
const _cache = new Map();   // key → { at, ok, byLnn, nodes, reason, detail, sample }
const keyOf = (device) => `${String(device?.id || '')}|${String(device?.host || '')}`;
export function _resetIsiHwCacheForTest() { _cache.clear(); }
function remember(key, rec) {
  _cache.delete(key);
  _cache.set(key, rec);
  while (_cache.size > CACHE_MAX) _cache.delete(_cache.keys().next().value);
}

/**
 * SSH 세션 안에서 노드 식별 정보를 읽는다(캐시가 살아 있으면 묻지 않는다).
 * @returns {{ ok:boolean, byLnn?:object, nodes?:number, cached:boolean, at:number, reason?:string, detail?:string, sample?:string }}
 */
export async function readIsiHwSsh(sh, device, { sessionStartedAt = Date.now(), clusterName = '', now = Date.now } = {}) {
  const key = keyOf(device);
  const c = _cache.get(key);
  const t = now();
  if (c && t < c.nextAt) return { ...c, cached: true };
  const elapsed = t - sessionStartedAt;
  if (elapsed > HW_START_BUDGET_MS) {
    // 예산 초과는 '실패' 로 기억하지 않는다 — 다음 주기에 다시 시도한다(직전 성공값이 있으면 그것을 계속 쓴다).
    if (c?.ok) return { ...c, cached: true };
    return { ok: false, cached: false, at: t, reason: 'budget', detail: `이번 수집 세션이 이미 ${Math.round(elapsed / 1000)}초 걸려 시리얼 조회를 시작하지 않았습니다` };
  }
  let rec;
  try {
    const r = await sh.exec(ISI_HW_CMD, HW_CMD_TIMEOUT_MS);
    const out = String(r?.stdout || '');
    const p = parseIsiHwStatus(out, { clusterName });
    if (p.nodes > 0) rec = { ok: true, at: t, nextAt: t + HW_OK_TTL_MS, byLnn: p.byLnn, nodes: p.nodes };
    else {
      const err = String(r?.stderr || '').trim();
      const seen = parseIsiHwStatus(out).prefixes;
      const detail = err || (seen.length && clusterName
        ? `노드 이름 접두(${seen.join(', ')})가 클러스터 이름(${clusterName})과 달라 노드 번호를 정할 수 없습니다`
        : '출력에서 노드별 SerNo 줄을 찾지 못했습니다');
      rec = { ok: false, at: t, nextAt: t + HW_FAIL_RETRY_MS, reason: out.trim() ? 'parse' : 'empty', detail: detail.slice(0, 200), sample: (out || err).slice(0, 400) };
    }
  } catch (e) {
    rec = { ok: false, at: t, nextAt: t + HW_FAIL_RETRY_MS, reason: 'exec', detail: String(e?.message || e).slice(0, 200) };
  }
  // 실패해도 직전 성공값은 버리지 않는다(시리얼은 바뀌지 않는다) — 1시간 뒤 다시 묻고, 그동안은 직전 값을 준다.
  if (!rec.ok && c?.ok) {
    const kept = { ...c, nextAt: rec.nextAt, lastError: { reason: rec.reason, detail: rec.detail, at: t } };
    remember(key, kept);
    return { ...kept, cached: true };
  }
  remember(key, rec);
  return { ...rec, cached: false };
}

/**
 * 스냅샷 노드 목록에 시리얼·제품명을 붙이고 근거를 extra 에 싣는다.
 * 읽지 못하면 노드 값은 비워 두고 `extra.nodeSerialProbe`(사유·원문 앞부분)를 싣는다 — 지어내지 않는다.
 */
export function applyIsiNodeHw(snap, hw, { source }) {
  if (!snap?.nodes || !Array.isArray(snap.nodes.list) || !snap.nodes.list.length) return snap;
  if (!hw || !hw.ok) {
    if (hw) snap.extra.nodeSerialProbe = { source, reason: hw.reason || 'unknown', detail: hw.detail || '', ...(hw.sample ? { sample: hw.sample } : {}) };
    return snap;
  }
  let read = 0;
  for (const n of snap.nodes.list) {
    const h = hw.byLnn?.[String(Number(n.id))];
    if (!h) continue;
    if (h.serial) { n.serial = h.serial; read += 1; }
    if (h.chassisSerial && h.chassisSerial !== h.serial) n.chassisSerial = h.chassisSerial;
    if (h.model && !n.model) n.model = h.model;
  }
  snap.extra.nodeSerials = { source, read, total: snap.nodes.list.length, at: hw.at || null, cached: !!hw.cached };
  if (!read) snap.extra.nodeSerialProbe = { source, reason: 'no-match', detail: '노드 번호(ID)와 맞는 시리얼 줄이 없습니다' };
  return snap;
}

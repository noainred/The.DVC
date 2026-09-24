/**
 * central/edgeLogPull.js — 중앙이 엣지에서 로그·진행상태를 **당긴다**(v2.549).
 *
 * 사용자 선택: "중앙이 당긴다(pull) + 폴백". 이 파일이 pull 쪽이다.
 *  · 대상은 **수집 서버 등록부**(`collector/registry.js`)다 — `puller.js:23` 이 이미 같은 `url`·`token`
 *    으로 `/api/collector/export` 를 60초마다 당기고 있으므로 **새 네트워크 허용이 필요 없다**.
 *  · 상시 폴링하지 않는다 — 사람이 화면에서 누를 때만 간다(로그는 대부분 볼 일이 없다).
 *
 * ── 실패를 '모름' 으로 뭉개지 않는다 ─────────────────────────────────────────
 * `kind` 로 원인을 나눈다. 조치가 전부 다르기 때문이다:
 *   `auth`(403/401 — 토큰 불일치) / `disabled`(404 — 그 엣지에 COLLECTOR_TOKEN 미설정) /
 *   `old-version`(엔드포인트 없음 = 구버전 엣지 → 업그레이드) / `unreachable`(연결 실패·시한) /
 *   `http`(그 밖 상태코드) / `bad-body`(응답이 형식과 다름)
 * ⚠ 404 는 **두 뜻**이다(엣지의 collector 가 꺼짐 / 구버전이라 이 경로가 없음) — 본문으로 가른다.
 *   구버전 엣지는 express 기본 404(HTML·`Cannot GET`)를 주고, 이 코드의 엣지는 `{ok:false,reason}` 을 준다.
 */
import { readJsonCapped, EDGE_RESPONSE_MAX_BYTES } from '../util/readCapped.js'; // v2.583: 엣지 응답 크기 상한
import { resilientFetch } from '../util/resilientFetch.js';
import { withOutboundTag } from '../util/outboundStats.js'; // v2.601 WEB2601-02: 같은 주소 엣지를 기록에서 나눈다
import { putEdgeLog } from './edgeLogStore.js';

/** 엣지 로그를 내주기 시작한 최소 버전 — 그 아래는 엔드포인트가 없다. */
export const MIN_EDGE_VERSION = '2.549.0';
const TIMEOUT_MS = Math.max(5_000, Number(process.env.EDGELOG_PULL_TIMEOUT_MS) || 20_000);

const t = (v) => String(v ?? '').trim();

/** 등록부에서 이 이름의 수집 서버를 찾는다(대소문자 무시 — 등록부가 그 규약이다). */
export async function findCollector(agent) {
  const { loadCollectors } = await import('../collector/registry.js');
  const key = t(agent).toLowerCase();
  const list = (() => { try { return loadCollectors(); } catch { return []; } })();
  return list.find((c) => t(c.name).toLowerCase() === key || t(c.id).toLowerCase() === key) || null;
}

/** 404 본문으로 '구버전' 과 '엣지에서 꺼짐' 을 가른다(둘은 조치가 정반대다). */
function kindFor404(body) {
  // 이 코드의 엣지는 JSON `{ok:false, reason:'collector 비활성화…'}` 를 준다.
  if (body && typeof body === 'object' && body.reason) return { kind: 'disabled', reason: String(body.reason) };
  return { kind: 'old-version', reason: `이 엣지에 /api/collector/edge-log 가 없습니다 — v${MIN_EDGE_VERSION} 이상으로 업그레이드해야 로그를 읽을 수 있습니다.` };
}

/**
 * 한 엣지에서 당긴다. **저장까지** 하고 결과를 돌려준다.
 * @returns {{ok:boolean, kind?:string, reason?:string, ms:number, snap?:object}}
 */
export async function pullEdgeLog(agent, { since = 0, level = '', limit = 0, withStatus = true } = {}) {
  const t0 = Date.now();
  const col = await findCollector(agent);
  if (!col) return { ok: false, kind: 'not-registered', reason: '수집 서버 등록부에 없는 이름입니다(설정 › 수집 서버에서 등록하세요).', ms: 0 };
  if (col.enabled === false) return { ok: false, kind: 'disabled-central', reason: '중앙에서 이 수집 서버를 비활성으로 두었습니다.', ms: 0 };
  if (!t(col.url)) return { ok: false, kind: 'no-url', reason: '이 수집 서버에 URL 이 없습니다.', ms: 0 };

  const qs = new URLSearchParams();
  if (Number(since) > 0) qs.set('since', String(Number(since)));
  if (level && level !== 'all') qs.set('level', String(level));
  if (Number(limit) > 0) qs.set('limit', String(Number(limit)));
  if (!withStatus) qs.set('status', '0');
  const url = `${t(col.url).replace(/\/+$/, '')}/api/collector/edge-log${qs.toString() ? `?${qs}` : ''}`;

  let res;
  try {
    res = await withOutboundTag(col.id || col.name || agent, () => resilientFetch(url, {
      headers: { Accept: 'application/json', ...(col.token ? { 'X-Collector-Token': col.token } : {}) },
      timeoutMs: TIMEOUT_MS, retries: 1,
    }));
  } catch (e) {
    const msg = String(e?.message || e);
    const ms = Date.now() - t0;
    const kind = /timeout|abort|timed out/i.test(msg) ? 'timeout' : 'unreachable';
    const rec = { ok: false, kind, reason: msg.slice(0, 300), ms };
    putEdgeLog(col.name || agent, { via: 'pull', ok: false, error: `${kind}: ${rec.reason}`, ms });
    return rec;
  }

  const ms = Date.now() - t0;
  let body = null;
  try { body = await readJsonCapped(res, EDGE_RESPONSE_MAX_BYTES, '엣지 로그 응답'); } catch { body = null; } // v2.583: 크기 상한

  if (res.status === 401 || res.status === 403) {
    const rec = { ok: false, kind: 'auth', reason: '수집 서버 토큰 불일치 — 중앙 등록값과 그 엣지의 COLLECTOR_TOKEN 을 대조하세요.', ms };
    putEdgeLog(col.name || agent, { via: 'pull', ok: false, error: rec.reason, ms });
    return rec;
  }
  if (res.status === 404) {
    const k = kindFor404(body);
    const rec = { ok: false, ...k, ms };
    putEdgeLog(col.name || agent, { via: 'pull', ok: false, error: `${k.kind}: ${k.reason}`, ms });
    return rec;
  }
  if (!res.ok) {
    const rec = { ok: false, kind: 'http', reason: `HTTP ${res.status}${body?.reason ? ` (${body.reason})` : ''}`, ms };
    putEdgeLog(col.name || agent, { via: 'pull', ok: false, error: rec.reason, ms });
    return rec;
  }
  if (!body || body.ok === false || !body.node) {
    const rec = { ok: false, kind: 'bad-body', reason: body?.reason ? String(body.reason).slice(0, 300) : '응답 형식이 다릅니다(엣지가 아닌 서버에 닿았을 수 있습니다).', ms };
    putEdgeLog(col.name || agent, { via: 'pull', ok: false, error: rec.reason, ms });
    return rec;
  }

  // ⚠ 저장 키는 **중앙이 아는 이름**(등록부 name)이다 — 엣지 본문의 `node.agent` 를 믿지 않는다.
  //   둘이 다르면 그 사실 자체가 진단이므로 화면이 나란히 보여 준다(v2.424 `identityIssue` 와 같은 목적).
  const snap = putEdgeLog(col.name || agent, { ...body, via: 'pull', ok: true, ms });
  return { ok: true, ms, snap };
}

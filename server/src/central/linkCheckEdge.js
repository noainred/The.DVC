/**
 * central/linkCheckEdge.js — 엣지가 잰 링크 결과 **수신**(v2.552).
 *
 * 엣지→중앙·엣지→vCenter·엣지↔엣지는 **중앙에서 잴 수 없다**(중앙이 그 경로로 나가지 않는다).
 * 그래서 엣지가 재서 올리고, 진실의 원천은 여전히 중앙의 `link-check.db` 다(화면·이력이 한 곳).
 *
 * ⚠⚠ **agent 는 인증된 값으로 덮어쓴다**(v2.548 F5): 본문의 `agent` 를 믿으면 엣지 하나가 남의
 *   법인 링크 상태를 위조할 수 있다. 링크 id 의 측정 주체(`from`)도 그 agent 여야 한다 —
 *   아니면 **버리고 개수를 밝힌다**(`rejected`). 조용히 받으면 '정상' 이 위조된다.
 * ⚠⚠ **상한은 링크 수만이 아니라 본문 크기·단계 수**다(v2.548 S2): 한 보고가 링크 5만 개를
 *   실으면 전이·DB 가 통째로 막힌다. 잘린 것은 `omitted` 로 밝힌다.
 * ⚠ 본문의 null·문자열 원소를 그대로 순회하면 TypeError 가 나고, **express 4 는 async 핸들러의
 *   throw 를 잡지 않아 요청이 응답 없이 매달린다**(v2.548 S1) — 원소마다 형을 확인한다.
 */
import { insertResults } from '../linkcheck/db.js';
import { PHASES } from '../linkcheck/phases.js';
import { KIND_KEYS, EDGE_KINDS } from '../linkcheck/links.js';

/** 보고 1건당 링크 상한. 링크 140개 규모를 넉넉히 덮고 폭주는 막는다. */
export const REPORT_LINK_MAX = Math.max(50, Number(process.env.LINKCHECK_REPORT_LINK_MAX) || 500);
/** 오래된 보고는 '지금 상태' 가 아니다(기본 3시간 — v2.548 규약과 같은 값). */
export const REPORT_STALE_MS = Math.max(600_000, Number(process.env.LINKCHECK_REPORT_STALE_MS) || 3 * 3_600_000);

const _reports = new Map();    // agent -> { at, version, links, ok, failed, skipped, rejected, omitted }
const t = (v) => String(v ?? '').trim();
const iOr = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : null; };

/** 단계 객체를 **아는 키만** 남겨 담는다(엣지가 보낸 임의 필드를 DB·화면에 흘리지 않게). */
function sanitizeSteps(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const ph of PHASES) {
    const s = raw[ph];
    if (!s || typeof s !== 'object') continue;
    out[ph] = {
      ok: s.ok === true,
      ms: iOr(s.ms),
      ...(s.failKind ? { failKind: t(s.failKind).slice(0, 40) } : {}),
      ...(s.error ? { error: t(s.error).slice(0, 300) } : {}),
      ...(s.status != null ? { status: iOr(s.status) } : {}),
      ...(s.certDaysLeft != null ? { certDaysLeft: iOr(s.certDaysLeft) } : {}),
      ...(s.certStatus ? { certStatus: t(s.certStatus).slice(0, 20) } : {}),
      ...(s.subject ? { subject: t(s.subject).slice(0, 120) } : {}),
      ...(s.issuer ? { issuer: t(s.issuer).slice(0, 120) } : {}),
      ...(s.protocol ? { protocol: t(s.protocol).slice(0, 20) } : {}),
      ...(s.bodySnippet ? { bodySnippet: t(s.bodySnippet).slice(0, 400) } : {}),
      ...(Array.isArray(s.addrs) ? { addrs: s.addrs.filter((a) => typeof a === 'string').slice(0, 8).map((a) => a.slice(0, 64)) } : {}),
    };
  }
  return out;
}

/**
 * 엣지 보고 수신.
 * @param {string} agent  **인증된** agent 이름(`req.centralAuth.agent`)
 * @param {object} body   `{ at, version, results:[{ link, verdict, steps, summary, skipped }] }`
 */
export async function putEdgeLinkReport(agent, body = {}) {
  const ag = t(agent);
  if (!ag) return { ok: false, reason: 'agent 를 확인할 수 없습니다.' };
  const at = Date.now();
  const raw = Array.isArray(body?.results) ? body.results : [];
  const omitted = Math.max(0, raw.length - REPORT_LINK_MAX);
  const list = raw.slice(0, REPORT_LINK_MAX);

  const toSave = [];
  let rejected = 0; let skipped = 0;
  for (const r of list) {
    if (!r || typeof r !== 'object') { rejected += 1; continue; }
    const link = (r.link && typeof r.link === 'object') ? r.link : null;
    const id = t(link?.id);
    const kind = t(link?.kind);
    if (!id || !KIND_KEYS.includes(kind)) { rejected += 1; continue; }
    /*
     * ⚠ 엣지는 **자기가 재는 종류**(EDGE_KINDS)의, **자기가 주체인**(from === agent) 링크만 올릴 수
     *   있다. 이 두 검사를 지우면 엣지 하나가 중앙 측정분이나 남의 법인 링크를 덮어쓴다.
     */
    if (!EDGE_KINDS.includes(kind)) { rejected += 1; continue; }
    if (t(link.from).toLowerCase() !== ag.toLowerCase()) { rejected += 1; continue; }

    if (r.skipped) { skipped += 1; continue; }        // 점검하지 않은 것은 적재하지 않는다
    const v = (r.verdict && typeof r.verdict === 'object') ? r.verdict : null;
    if (!v) { rejected += 1; continue; }
    const steps = sanitizeSteps(r.steps);
    const safeLink = {
      id, kind, by: 'edge', from: ag, to: t(link.to).slice(0, 128),
      host: t(link.host).slice(0, 255), port: iOr(link.port),
    };
    toSave.push({
      link: safeLink,
      ts: (() => { const n = iOr(r.ts); return (n && n > 0 && n <= at + 5 * 60_000) ? n : at; })(),
      verdict: {
        ok: v.ok === true,
        phase: t(v.phase).slice(0, 20), failKind: t(v.failKind).slice(0, 40),
        reached: t(v.reached).slice(0, 80), totalMs: iOr(v.totalMs),
      },
      steps,
      summary: t(r.summary).slice(0, 300),
      detail: { steps, link: safeLink, byEdge: ag },
      byNode: ag,
    });
  }

  const saved = await insertResults(toSave, { byNode: ag });
  const failed = toSave.filter((x) => !x.verdict.ok).length;
  _reports.set(ag, {
    at, version: t(body?.version).slice(0, 40),
    links: toSave.length + skipped, ok: toSave.length - failed, failed, skipped,
    rejected, omitted,
    dbOk: saved.ok !== false, dbError: saved.error || '',
  });
  return {
    ok: true, stored: toSave.length, events: saved.events || 0,
    skipped, rejected, omitted,
    // ⚠ 엣지가 '중앙이 받았는가' 를 화면에 말할 수 있게 그대로 되돌려 준다(v2.548 H6).
    centralEnabled: true,
  };
}

/** 그 엣지의 마지막 보고. `stale` 은 **모듈이 찍은 시각**으로 판정한다(v2.548 테스트 규약). */
export function edgeLinkReport(agent) {
  const r = _reports.get(t(agent));
  if (!r) return null;
  return { ...r, stale: (Date.now() - r.at) > REPORT_STALE_MS, ageMs: Date.now() - r.at };
}

export function allEdgeLinkReports() {
  const out = {};
  for (const ag of _reports.keys()) out[ag] = edgeLinkReport(ag);
  return out;
}

export function _resetEdgeLinkReportsForTest() { _reports.clear(); }

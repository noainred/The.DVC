/**
 * periodic/assemble.js — 회차 하나를 조립한다(설계 §4.1 · §4.7): 그 주기의 항목마다 **리더**(readers/*.js)를 부르고, 결과를 법인(vCenter) 행 ·
 * 판정 · 근거로 정리해 회차 문서를 만든다. 파일 · DB · 메일은 모른다(service.js 가 저장 · 전달).
 *
 *  · 리더는 **저장된 것만 읽는다** — vCenter 로그인 · SSH · Director · 장비 호출 금지(소스 스윕 테스트가 고정 — periodicReport3310.test.js).
 *  · 리더 하나가 던지거나 시한을 넘기면 그 항목만 '확인 불가'(사유 적음) — 회차 전체를 실패시키지 않는다.
 *  · 항목 사이에 시간 기준 양보(createYielder) — 조립이 이벤트 루프를 오래 붙잡지 않게(perf-db v2.693).
 *  · 법인 행: { vc, status, count?, text? } — vc 를 모르고 DataCenter(법인 등록)만 아는 원천은 { dc } 로 주면 그 법인의 첫 vCenter 로 붙인다
 *    (법인 · vCenter 1:1 운영 — 루트 CLAUDE.md). 둘 다 모르면 법인 미지정 행(범위 계정에는 보이지 않는다).
 */
import { createYielder } from '../util/timeSlice.js';
import { numOrNull } from '../util/numOrNull.js';
import { STATUSES, KIND_LABEL, worstOf, countsOf, overallOf } from './rules.js';
import { AXIS_LABEL } from './catalog.js';

export const READER_TIMEOUT_MS = 20_000;
const ROWS_MAX = 2_000;
const DETAIL_MAX = 30;
const TEXT_MAX = 400;

const clip = (v, n = TEXT_MAX) => (v == null ? '' : String(v).slice(0, n));
const statusOr = (s, d = 'unknown') => (STATUSES.includes(s) ? s : d);

/** 리더 하나를 시한 안에서 부른다(던지면 그 항목만 확인 불가). */
async function runReader(fn, ctx, timeoutMs) {
  let timer = null;
  try {
    const p = Promise.resolve().then(() => fn(ctx));
    const t = new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error('시한 초과'), { code: 'reader-timeout' })), timeoutMs); });
    return { ok: true, value: await Promise.race([p, t]) };
  } catch (e) {
    return { ok: false, error: e };
  } finally { if (timer) clearTimeout(timer); }
}

/**
 * 리더 결과 → 항목(순수 — 테스트가 직접 부른다).
 * @param {object} def 카탈로그 항목
 * @param {object} res 리더 결과 { status?, rows?, count?, basis?, asOf?, unknownReason?, value?, detail?, fix? }
 * @param {{vcOfDc?:(dc:string)=>string|null, knownVc?:Set<string>}} [opts]
 */
export function normalizeItem(def, res, { vcOfDc = () => null, knownVc = null } = {}) {
  const r = res && typeof res === 'object' ? res : {};
  const rows = [];
  for (const raw of Array.isArray(r.rows) ? r.rows.slice(0, ROWS_MAX) : []) {
    if (!raw || typeof raw !== 'object') continue;
    let vc = raw.vc != null && raw.vc !== '' ? String(raw.vc) : null;
    const dc = raw.dc != null && raw.dc !== '' ? String(raw.dc) : null;
    if (!vc && dc) vc = vcOfDc(dc) || null;
    if (vc && knownVc && !knownVc.has(vc)) vc = null;   // 지금 등록에 없는 vCenter — 법인 미지정 행으로(범위 계정에 보이지 않게)
    rows.push({ vc, ...(dc ? { dc } : {}), status: def.info ? 'info' : statusOr(raw.status), ...(numOrNull(raw.count) != null ? { count: numOrNull(raw.count) } : {}), text: clip(raw.text) });
  }
  let status;
  // 대상이 없음(등록된 장비 · 잡이 없음) — 정상으로 세지 않고 정보로 싣는다(해당 없음).
  if (r.na === true) return { ...normalizeItem({ ...def, info: true }, { value: `해당 없음 — ${r.basis || '대상이 없습니다'}` }), info: !!def.info, na: true };
  if (def.info) status = 'info';
  else if (STATUSES.includes(r.status)) status = r.status;
  else status = worstOf(rows.map((x) => x.status)) || (r.unknownReason ? 'unknown' : 'ok');
  // 행이 있는데 항목 판정을 따로 줬으면 더 나쁜 쪽(행이 이상인데 항목을 정상이라 하지 않게).
  if (!def.info && rows.length) status = worstOf([status, ...rows.map((x) => x.status)]) || status;
  const count = numOrNull(r.count) ?? (rows.length ? rows.reduce((a, x) => a + (x.count ?? 0), 0) : null);
  return {
    key: def.key, axis: def.axis, axisLabel: AXIS_LABEL[def.axis] || def.axis, label: def.label, tool: def.tool, info: !!def.info, fleet: !!def.fleet, rule: def.rule,
    status, count, basis: clip(r.basis), value: clip(r.value), asOf: numOrNull(r.asOf),
    unknownReason: status === 'unknown' || r.unknownReason ? clip(r.unknownReason) : '', fix: clip(r.fix || def.fix),
    detail: (Array.isArray(r.detail) ? r.detail : []).slice(0, DETAIL_MAX).map((d) => clip(d, 240)),
    rows,
  };
}

/** 스냅샷의 vCenter → 법인 목록(보고 여부 · 기준 시각). 꺼진 vCenter 는 넣지 않는다. */
export function corpsOf(snap, { dcOfVc = () => '', dcName = () => '' } = {}) {
  const out = [];
  for (const v of snap?.vcenters || []) {
    if (!v || v.status === 'disabled') continue;
    const dc = dcOfVc(v.id) || '';
    const reported = v.status !== 'unreachable' && v.status !== 'pending' && v.status !== 'maintenance' && v.maintenance !== true && v.stale !== true;
    out.push({ vc: String(v.id), name: String(v.name || v.id), dc, dcName: dc ? (dcName(dc) || dc) : '', mode: v.collectMode === 'site' ? 'edge' : 'central',
      reported, status: v.status || null,
      // 기준 시각 — 엣지 위임은 마지막 수신 · 낡은 값을 이어 쓰는 중이면 그 값의 시각 · 중앙 직접은 스냅샷 생성 시각(vCenter 별 수집 시각은 스냅샷에 싣지 않는다)
      asOf: v.collectSource === 'site' ? numOrNull(v.receivedAt) : v.stale ? numOrNull(v.staleSince) : (v.status === 'unreachable' || v.status === 'pending' ? null : (numOrNull(snap?.generatedAt) ?? (Number.isFinite(Date.parse(snap?.generatedAt)) ? Date.parse(snap.generatedAt) : null))) });
  }
  return out.sort((a, b) => (a.dcName || a.name).localeCompare(b.dcName || b.name, 'ko'));
}

/**
 * 회차 조립.
 * @param {{kind:string, slot:number|null, period:{from:number,to:number,id:string,label:string}, id:string, items:object[], readers:Record<string,Function>,
 *          snap:object, now:number, by:string, manual:boolean, prev?:object|null, dcOfVc?:Function, dcName?:Function, timeoutMs?:number, onProgress?:Function, extra?:object}} a
 */
export async function assembleRun(a) {
  const t0 = Date.now();
  const yieldNow = createYielder(15);
  const corps = corpsOf(a.snap, { dcOfVc: a.dcOfVc, dcName: a.dcName });
  const knownVc = new Set(corps.map((c) => c.vc));
  const vcByDc = new Map();
  for (const c of corps) if (c.dc && !vcByDc.has(c.dc)) vcByDc.set(c.dc, c.vc);
  const ctx = {
    kind: a.kind, now: a.now, from: a.period.from, to: a.period.to, snap: a.snap, corps, knownVc, cache: new Map(),
    vcOfDc: (dc) => vcByDc.get(String(dc)) || null, dcOfVc: a.dcOfVc || (() => ''), ...(a.extra || {}),
  };
  const items = [];
  let done = 0;
  for (const def of a.items) {
    const fn = a.readers?.[def.key];
    let item;
    if (typeof fn !== 'function') {
      item = normalizeItem(def, { status: 'unknown', unknownReason: '이 항목을 읽는 리더가 없습니다(구현 누락)' });
    } else {
      const r = await runReader(fn, ctx, a.timeoutMs ?? READER_TIMEOUT_MS);
      item = r.ok ? normalizeItem(def, r.value, { vcOfDc: ctx.vcOfDc, knownVc })
        : normalizeItem(def, { status: def.info ? 'info' : 'unknown', unknownReason: r.error?.code === 'reader-timeout' ? `읽는 데 ${Math.round((a.timeoutMs ?? READER_TIMEOUT_MS) / 1000)}초를 넘겨 멈췄습니다` : `읽지 못했습니다: ${clip(r.error?.message || r.error, 160)}` });
    }
    const pi = a.prev?.doc?.items?.find?.((x) => x.key === def.key);
    if (pi) {
      item.prev = { status: pi.status, count: numOrNull(pi.count) };
      const pr = new Map((pi.rows || []).filter((x) => x.vc).map((x) => [x.vc, x.status]));
      for (const row of item.rows) if (row.vc && pr.has(row.vc)) row.prev = pr.get(row.vc);
    } else item.prev = null;
    items.push(item);
    done++;
    a.onProgress?.({ done, total: a.items.length, axis: def.axis });
    await yieldNow();
  }
  const counts = countsOf(items);
  return {
    id: a.id, kind: a.kind, kindLabel: KIND_LABEL[a.kind], slot: a.slot ?? null, periodFrom: a.period.from, periodTo: a.period.to, periodLabel: a.period.label,
    generatedAt: a.now, by: a.by || 'schedule', manual: !!a.manual, status: 'done', asOf: a.now, durationMs: Date.now() - t0,
    items, corps, counts, overall: overallOf(items), corpsTotal: corps.length, corpsReported: corps.filter((c) => c.reported).length,
    prevId: a.prev?.id || null, mock: !!a.mock,
  };
}

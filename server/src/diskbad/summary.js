/**
 * diskbad/summary.js — 전 법인(또는 한 법인) 분석 집계(순수, v3.8.0).
 *
 * 입력은 라우트가 범위로 자른 서버 목록과 DB 전량이다. 판정은 verdict.js 하나를 부른다(복제하지 않는다).
 *
 * 정직 규칙(루트 CLAUDE.md '못 읽은 값은 0 이 아니다'):
 *  · 읽지 못한 서버의 디스크는 분자 · 분모 **둘 다** 뺀다. 법인 행에 '읽음/전체' 를 같이 싣는다.
 *  · 모델별 비율은 **지금 꽂힌 디스크**만 센다 — 교체된 디스크의 모델은 로그에 없다(README §8.2). 그 수를 '모델을 알 수 없음' 으로 따로 싣는다.
 *  · 월별 추이에는 그 달의 로그가 남아 있는 서버 비율을 같이 싣는다(과거로 갈수록 적게 잡힌다 — 화면이 밝힌다).
 *  · 데모(합성) 결과가 섞이면 `synthesized` 로 밝힌다.
 *  · v3.8.2(실장비에서 드러난 것): iDRAC 가 주는 것은 활성 로그뿐이고 로그인 기록이 그것을 채우면 하루치만 남는다. '기록 0' 이
 *    '과거에 없었다' 로 읽히지 않게, **로그가 30일 미만만 남은 서버 수**(`shortLog`) · 남은 기간의 가운데값 · 로그인 기록이 절반을 넘는
 *    서버 수(`loginHeavy`)를 합계에 싣는다. 화면이 KPI 위에 경고로 보인다.
 */
import { classOf, COUNTED, CLS, labelOfKey, refsTable, ID_TABLE, CLS_LABEL, loginShareOf, LOGIN_CODES } from './classify.js';
import { judgeServer, VERDICT, VERDICT_LABEL, CONFIDENCE_LABEL, SERVER_STATUS_LABEL } from './verdict.js';
import { REASON_LABEL } from './scan.js';

export const SHORT_LOG_DAYS = 30;
const ALERTING_MAX = 300;
const DAY_MS = 86_400_000;

/**
 * iDRAC 활성 로그가 **담고 있던 기간**(ms). 못 정하면 null.
 * 반증 3.8.2 #1: `coveredFrom`(포탈이 지금까지 본 가장 오래된 시각)으로 재면 안 된다 — 한번 내려가면 되돌아가지 않아, 활성 로그가 늘
 * 하루치인 서버도 30일 뒤에는 '30일 넘게 남음' 이 되고 경고가 스스로 꺼진다. 그래서 **로그 전체를 읽은 마지막 점검**의 범위(가장 새 항목 −
 * 가장 오래된 항목)로 잰다. 그 진단이 없는 서버(3.8.2 이전 엣지)는 첫 정상 점검 때의 범위(firstOkAt − coveredFrom)로 — 둘 다 시간이 지나도 늘지 않는다.
 * @returns {{ms:number, at:number|null}|null}
 */
export function logSpanOf(row) {
  const d = row?.readDiag;
  if (d && d.reachedEnd === true && Number.isFinite(d.oldest) && Number.isFinite(d.newest) && d.newest >= d.oldest) return { ms: d.newest - d.oldest, at: Number.isFinite(d.at) ? d.at : null };
  if (!d && row?.complete !== false && Number.isFinite(row?.firstOkAt) && Number.isFinite(row?.coveredFrom) && row.firstOkAt >= row.coveredFrom) {
    return { ms: row.firstOkAt - row.coveredFrom, at: row.firstOkAt };
  }
  return null;
}
/** 서버 한 대의 읽기 진단(화면용) — 로그인 계열 비율을 붙인다. */
export function diagView(readDiag) {
  if (!readDiag || typeof readDiag !== 'object') return null;
  return { ...readDiag, loginShare: loginShareOf(readDiag), loginCodes: LOGIN_CODES };
}

const keyOf = (agent, id) => `${String(agent || '').toLowerCase()}|${id}`;
const monthKey = (ms) => { const d = new Date(ms); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };
const monthEnd = (ym) => { const [y, m] = ym.split('-').map(Number); return Date.UTC(y, m, 1) - 1; };

/**
 * 서버 하나의 판정 묶음(서버 상세 화면과 집계가 같이 쓴다).
 * @param {object|null} row  dbr_server 행(rowServer)
 */
export function serverView(row, records, serials) {
  const recs = (records || []).map((r) => ({ created: r.created, code: r.code, cls: classOf(r.code) || CLS.other, slotKey: r.slotKey, message: r.message, entryKey: r.entryKey, severity: r.severity, baseline: r.baseline }));
  const coverage = row ? { continuousSince: row.continuousSince, lastOkAt: row.lastOkAt, complete: row.complete } : null;
  const j = judgeServer({ records: recs, drives: row ? row.drives : null, serialRows: serials || [], coverage });
  return { ...j, records: recs, coverage: row ? {
    lastScanAt: row.lastScanAt, lastOkAt: row.lastOkAt, firstOkAt: row.firstOkAt, lastStatus: row.lastStatus, lastReason: row.lastReason,
    lastStatusLabel: row.lastStatus && row.lastStatus !== 'ok' ? (REASON_LABEL[row.lastStatus] || '읽기 실패') : '',
    logOldest: row.logOldest, coveredFrom: row.coveredFrom, continuousSince: row.continuousSince, complete: row.complete, logTotal: row.logTotal,
    logOrder: row.logOrder, readLast: row.readLast, readStop: row.readStop || '', invAt: row.invAt, synthesized: row.synthesized,
    diag: diagView(row.readDiag), logSpan: logSpanOf(row), shortLogDays: SHORT_LOG_DAYS,
  } : null };
}

/**
 * @param {object} p
 * @param {Array<{agent:string, id:string, name:string, corp:{id:string,name:string,country:string|null,city:string|null}|null, excluded?:boolean}>} p.servers 범위 안의 물리 서버
 * @param {{servers:Array, records:Array, serials:Array}} p.db
 * @param {number} [p.months]
 */
export function buildFleet({ servers = [], db = { servers: [], records: [], serials: [] }, now = Date.now(), months = 18 }) {
  const rowBy = new Map(db.servers.map((r) => [keyOf(r.agent, r.serverId), r]));
  const recBy = new Map();
  for (const r of db.records) { const k = keyOf(r.agent, r.serverId); if (!recBy.has(k)) recBy.set(k, []); recBy.get(k).push(r); }
  const serBy = new Map();
  for (const s of db.serials) { const k = keyOf(s.agent, s.serverId); if (!serBy.has(k)) serBy.set(k, []); serBy.get(k).push(s); }

  const corps = new Map();
  const corpOf = (c) => {
    const id = c?.id || ''; const name = c?.name || '법인 귀속 없음';
    if (!corps.has(id)) corps.set(id, { id, name, country: c?.country || null, city: c?.city || null, servers: 0, read: 0, unread: 0, excluded: 0, disks: 0, recordSlots: 0, inUse: 0, replaced: 0, unknown: 0, records: 0, unrecoverable: 0 });
    return corps.get(id);
  };
  const models = new Map();
  const inUseList = []; const slotList = [];
  const serverRows = [];
  const reasons = {};
  const monthly = new Map();
  let synthesized = false;
  const readServers = [];
  const tot = { servers: 0, read: 0, unread: 0, excluded: 0, disks: 0, recordSlots: 0, inUse: 0, replaced: 0, unknown: 0, records: 0, unrecoverable: 0, unwatched: 0, serversWithRecords: 0,
    spanKnown: 0, shortLog: 0, loginHeavy: 0, diagKnown: 0, alertingDisks: 0, alertingServers: 0, drivesUnknownServers: 0 };
  const spans = [];
  const alertingList = [];

  for (const s of servers) {
    const c = corpOf(s.corp);
    if (s.excluded) { c.excluded += 1; tot.excluded += 1; continue; }
    c.servers += 1; tot.servers += 1;
    const k = keyOf(s.agent, s.id);
    const row = rowBy.get(k) || null;
    const v = serverView(row, recBy.get(k) || [], serBy.get(k) || []);
    if (row?.synthesized) synthesized = true;
    const read = v.status !== 'unread';
    if (!read) {
      c.unread += 1; tot.unread += 1;
      const rk = row ? (row.lastStatus === 'ok' ? 'never' : row.lastStatus || 'error') : 'never';
      reasons[rk] = (reasons[rk] || 0) + 1;
    } else {
      c.read += 1; tot.read += 1; readServers.push(row);
      // 활성 로그가 담은 기간 — 못 정한 서버는 세지 않는다(spanKnown 이 분모).
      const sp = logSpanOf(row);
      if (sp) {
        const days = sp.ms / DAY_MS;
        tot.spanKnown += 1; spans.push(days);
        if (days < SHORT_LOG_DAYS) tot.shortLog += 1;
      }
      const share = loginShareOf(row?.readDiag);
      if (share != null) { tot.diagKnown += 1; if (share >= 0.5) tot.loginHeavy += 1; }
      const watched = (v.drives || []).filter((d) => d.inVolume !== false);
      c.disks += watched.length; tot.disks += watched.length;
      tot.unwatched += v.unwatched || 0;
      for (const d of watched) {
        const m = d.model || '모델 정보 없음';
        if (!models.has(m)) models.set(m, { model: m, mounted: 0, recordDisks: 0, unrecoverable: 0 });
        models.get(m).mounted += 1;
      }
    }
    c.recordSlots += v.counts.slots; c.inUse += v.counts.inUse; c.replaced += v.counts.replaced; c.unknown += v.counts.unknown;
    c.records += v.counts.records; c.unrecoverable += v.counts.unrecoverable;
    tot.recordSlots += v.counts.slots; tot.inUse += v.counts.inUse; tot.replaced += v.counts.replaced; tot.unknown += v.counts.unknown;
    tot.records += v.counts.records; tot.unrecoverable += v.counts.unrecoverable;
    if (v.counts.slots > 0) tot.serversWithRecords += 1;
    for (const r of v.records) {
      if (!COUNTED.has(r.cls)) continue;
      const mk = monthKey(r.created);
      if (!monthly.has(mk)) monthly.set(mk, { month: mk, unrecoverable: 0, other: 0 });
      monthly.get(mk)[r.cls === CLS.unrecoverable ? 'unrecoverable' : 'other'] += 1;
    }
    const base = { agent: s.agent, serverId: s.id, serverName: s.name || row?.name || s.id, corpId: c.id, corpName: c.name, country: c.country };
    // iDRAC 가 지금 알리는 디스크 — 디스크 목록을 읽은 서버만 센다(못 읽은 서버는 따로 센다 — 0 이 아니다).
    if (read) {
      if (Array.isArray(v.alerting)) {
        if (v.alerting.length) tot.alertingServers += 1;
        tot.alertingDisks += v.alerting.length;
        for (const a of v.alerting) if (alertingList.length < ALERTING_MAX) alertingList.push({ ...base, ...a });
      } else tot.drivesUnknownServers += 1;
    }
    serverRows.push({ ...base, status: v.status, statusLabel: SERVER_STATUS_LABEL[v.status], counts: v.counts, lastScanAt: row?.lastScanAt ?? null,
      lastStatusLabel: v.coverage?.lastStatusLabel || '', coveredFrom: row?.coveredFrom ?? null, complete: row?.complete ?? null, disks: (v.drives || []).length || null,
      alerting: Array.isArray(v.alerting) ? v.alerting.length : null,
      logTotal: row?.logTotal ?? null, loginShare: loginShareOf(row?.readDiag), logSpanMs: logSpanOf(row)?.ms ?? null, continuousSince: row?.continuousSince ?? null });
    for (const sl of v.slots) {
      if (sl.total <= 0) continue;
      const item = { ...base, slotKey: sl.slotKey, label: sl.label, verdict: sl.verdict, verdictLabel: VERDICT_LABEL[sl.verdict], confidence: sl.confidence,
        confidenceLabel: CONFIDENCE_LABEL[sl.confidence], byCode: sl.byCode, total: sl.total, unrecoverable: sl.unrecoverable, predictive: sl.predictive,
        first: sl.first, last: sl.last, drive: sl.drive, evidence: sl.evidence, caveat: sl.caveat };
      slotList.push(item);
      if (sl.verdict === VERDICT.inUse) {
        inUseList.push(item);
        const m = sl.drive?.model || '모델 정보 없음';
        if (models.has(m)) { models.get(m).recordDisks += 1; models.get(m).unrecoverable += sl.unrecoverable; }
      }
    }
  }

  // 월별 — 최근 N개월(진행 중인 달 포함). 그 달 말에 로그가 남아 있던 서버 비율(읽은 서버 기준).
  const months_ = [];
  const d0 = new Date(now);
  for (let i = months - 1; i >= 0; i -= 1) {
    const ym = monthKey(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() - i, 15));
    const m = monthly.get(ym) || { month: ym, unrecoverable: 0, other: 0 };
    const end = monthEnd(ym);
    // '그 달을 봤다' 는 끊김 없이 본 구간으로 센다(coveredFrom 은 사이에 못 본 틈이 있어도 내려간다).
    const covered = readServers.filter((r) => Number.isFinite(r?.continuousSince) && r.continuousSince <= end).length;
    months_.push({ ...m, coveragePct: readServers.length ? Math.round((covered / readServers.length) * 100) : null, partial: i === 0 });
  }

  const byCorp = [...corps.values()].map((c) => ({ ...c, ratePer1000: c.disks > 0 ? Math.round((c.recordSlots / c.disks) * 10_000) / 10 : null }))
    .sort((a, b) => (b.ratePer1000 ?? -1) - (a.ratePer1000 ?? -1) || b.recordSlots - a.recordSlots);
  const unknownModel = slotList.filter((s) => s.verdict !== VERDICT.inUse).length;
  const byModel = [...models.values()].map((m) => ({ ...m, ratePct: m.mounted > 0 ? Math.round((m.recordDisks / m.mounted) * 10_000) / 100 : null, small: m.mounted < 30 }))
    .sort((a, b) => (b.ratePct ?? -1) - (a.ratePct ?? -1));
  inUseList.sort((a, b) => b.unrecoverable - a.unrecoverable || b.last - a.last);
  slotList.sort((a, b) => b.last - a.last);
  serverRows.sort((a, b) => b.counts.inUse - a.counts.inUse || b.counts.slots - a.counts.slots || String(a.serverName).localeCompare(String(b.serverName)));

  spans.sort((a, b) => a - b);
  const median = spans.length ? (spans.length % 2 ? spans[(spans.length - 1) / 2] : (spans[spans.length / 2 - 1] + spans[spans.length / 2]) / 2) : null;
  return {
    totals: { ...tot, ratePer1000: tot.disks > 0 ? Math.round((tot.recordSlots / tot.disks) * 10_000) / 10 : null,
      shortLogDays: SHORT_LOG_DAYS, medianLogDays: median == null ? null : Math.round(median * 10) / 10 },
    byCorp, byModel, unknownModel, months: months_, inUse: inUseList, slots: slotList, servers: serverRows, unreadReasons: reasons,
    alerting: alertingList.sort((a, b) => (a.level === b.level ? 0 : (a.level === 'fault' ? -1 : 1)) || Number(b.hasRecords) - Number(a.hasRecords)),
    synthesized,
  };
}

/** 화면이 문구를 복사하지 않게 서버가 내려주는 표(근거 화면 포함). */
export function labelsPayload() {
  return { refs: refsTable(), cls: CLS_LABEL, verdict: VERDICT_LABEL, confidence: CONFIDENCE_LABEL, status: SERVER_STATUS_LABEL, reason: REASON_LABEL, ids: Object.keys(ID_TABLE) };
}

export { labelOfKey };

/**
 * periodic/readers/services.js — 서비스 항목 리더(서비스 모니터 · 백업 · 통신 · 엣지 · 포탈 자체).
 * 백업 Summary · 미보호 VM 은 라우트의 계산을 공급자로 부른다(periodic/providers.js — 판정 한 벌). 그 밖은 저장소 · 메모리 상태만 읽는다.
 * Bareos 는 사전 점검 상태 파일(healthView)만 읽는다 — runAll · runDirector(Director 호출)는 부르지 않는다.
 */
import { numOrNull } from '../../util/numOrNull.js';
import { activeVcs, judge, rowsBasis, vcRow, n, latest } from './common.js';
import { periodicProvider } from '../providers.js';

/** 서비스 모니터 — 이 포탈이 도는 점검(testState) + 엣지 보고 합계(edgeTotals). 법인 귀속이 없어 전체 항목. 회차 시점 상태다. */
export async function svcmon(ctx) {
  const { listTargets } = await import('../../svcmon/store.js');
  const { getResults, executesHere } = await import('../../svcmon/poller.js');
  const { testState } = await import('../../svcmon/status.js');
  const { edgeTotals } = await import('../../central/svcmonEdge.js');
  const c = { ok: 0, warn: 0, bad: 0, stale: 0, pending: 0, disabled: 0 };
  if (executesHere()) {
    const results = getResults();
    for (const t of listTargets()) for (const x of t.tests || []) { const st = testState(t, x, results, ctx.now); if (c[st] != null) c[st]++; else c.pending++; }
  }
  const e = edgeTotals(ctx.now);
  const bad = c.bad + (e.bad || 0); const warn = c.warn + (e.warn || 0); const unk = c.stale + c.pending + (e.stale || 0) + (e.unknown || 0);
  const total = Object.values(c).reduce((a, b) => a + b, 0) + (e.rows || 0);
  if (!total) return { status: 'unknown', unknownReason: '등록된 서비스 점검이 없거나 아직 결과가 없습니다', rows: [] };
  return { status: judge({ crit: bad, warn, unknown: unk && !(c.ok + (e.ok || 0)) ? 1 : 0 }), count: bad + warn,
    basis: `점검 ${n(total)}건 — 이상 ${n(bad)} · 주의 ${n(warn)} · 오래됨 · 대기 ${n(unk)} · 엣지 ${n(e.agents)}곳${e.silent ? `(보고 없음 ${e.silent})` : ''}${e.assignedNoReport ? ` · 배정만 있고 보고 없는 엣지 ${e.assignedNoReport}` : ''} · 회차 시점 상태` };
}

/** 백업 항목 법인 행 글 — 지금 실패(연속) · 마지막 성공 7일 · 3일 넘음. */
function backupText(f, { prefix = '', rpo = true, overdue = false } = {}) {
  const rep = f.fails.filter((x) => x.streak >= 2).length;
  const parts = [`${prefix}지금 실패 ${n(f.fails.length)}${rep ? `(연속 ${n(rep)})` : ''}`];
  if (rpo) parts.push(`마지막 성공 7일 넘음 ${n(f.rpo7)}`, `3일 넘음 ${n(f.rpo3)}`);
  if (overdue) parts.push(`RPO 넘김 ${n(f.overdue)}`, `마지막 성공 7일 넘음 ${n(f.rpo7)}`);
  if (f.rpoUnknown) parts.push(`마지막 성공 모름 ${n(f.rpoUnknown)}`);
  return parts.join(' · ');
}
const repeatOf = (f) => f.fails.filter((x) => x.streak >= 2).length;

/**
 * Veeam 백업 판정(컨펌 ④ ⑤ — 2026-11-28) — VM 마다 Backup 현황 Detail 과 같은 결과(라우트 공급자 backup-observe — 시스템 계정).
 *   연속 2회 이상 실패(백업 적재로 센다) · 마지막 성공 7일 넘음은 이상 · 한 번 실패 · 3일 넘음은 주의 · 결과를 못 읽었거나 일부만 읽은 법인은 확인 불가.
 */
export async function veeam(ctx) {
  const { backupFacts } = await import('../backupService.js');
  const { backupJudge } = await import('../backupLedger.js');
  const f = await backupFacts(ctx);
  if (!f.provider.ok) return { status: 'unknown', unknownReason: `Veeam 결과를 읽지 못했습니다 — ${f.provider.reason}`, rows: [] };
  const rows = [];
  for (const [vc, x] of f.vcs) {
    const v = x.veeam;
    if (!v) continue;   // Veeam 연동이 없는 법인은 이 항목 대상이 아니다
    const st = backupJudge({ failNow: v.fails.length, failRepeat: repeatOf(v), rpo7: v.rpo7, rpo3: v.rpo3, unknown: v.unknown });
    const text = v.unknown && !v.vms ? `Veeam 결과를 읽지 못함(${v.state})` : `백업 VM ${n(v.vms)} · ${backupText(v)}${v.unknown ? ` · 결과 일부 모름(${v.state})` : ''}`;
    rows.push(vcRow(vc, st, v.fails.length + v.rpo7, text));
  }
  if (!rows.length) return { na: true, basis: 'Veeam 이 연동된 법인이 없습니다' };
  return { rows, basis: `${rowsBasis(rows)} · VM 마다 Backup 현황 Detail 과 같은 결과 · 연속 실패는 백업 적재 기준(보고서 백업 절)`, asOf: numOrNull(f.at) };
}

/**
 * Bareos 백업 · 사전 점검 — 사전 점검 상태 파일(healthView)의 법인 판정과 백업 결과(원장 — 끝난 실행 · 마지막 성공) 중 나쁜 쪽(컨펌 ④).
 *   Director 호출 없음. 조회하지 못한 법인(인증 정지 · 조회 실패 · 미설정)의 백업 결과는 확인 불가.
 */
export async function bareos(ctx) {
  const { healthView } = await import('../../bareos/health.js');
  const { backupFacts } = await import('../backupService.js');
  const { backupJudge } = await import('../backupLedger.js');
  const { worstOf } = await import('../rules.js');
  const v = healthView(() => true);
  const pre = new Map((v?.corps || []).map((c) => [String(c.vcenterId), c]));
  const f = await backupFacts(ctx);
  const ids = new Set([...pre.keys(), ...[...f.vcs].filter(([, x]) => x.bareos).map(([id]) => id)]);
  if (!ids.size) return f.provider.ok ? { na: true, basis: 'Bareos 사전 점검 · 백업 대상 법인이 없습니다' } : { status: 'unknown', unknownReason: `Bareos 백업 결과를 읽지 못했습니다 — ${f.provider.reason}`, rows: [] };
  const MAP = { ok: 'ok', warn: 'warn', bad: 'crit', unknown: 'unknown' };
  const rows = [];
  for (const id of ids) {
    const c = pre.get(id);
    const preSt = c ? (c.stale ? 'unknown' : (MAP[c.verdict] || 'unknown')) : null;
    const bad = c ? (c.items || []).filter((x) => x.status === 'bad' || x.status === 'warn').map((x) => x.key) : [];
    const b = f.vcs.get(id)?.bareos || null;
    let bkSt = null; let bkText = '';
    if (!f.provider.ok) { bkSt = 'unknown'; bkText = '백업 결과 모름(공급자 없음)'; }
    else if (b) {
      if (!b.known) { bkSt = 'unknown'; bkText = `백업 결과 모름(Director ${b.state})`; }
      else { bkSt = backupJudge({ failNow: b.fails.length, failRepeat: repeatOf(b), rpo7: b.rpo7, rpo3: b.rpo3 }); bkText = `잡 ${n(b.jobs)} · ${backupText(b)}`; }
    }
    const st = worstOf([preSt, bkSt].filter(Boolean)) || 'unknown';
    const preText = c ? `${c.directorName || ''} 사전 점검 ${c.verdict || '모름'}${c.stale ? '(오래된 기록)' : ''}${bad.length ? ` · ${bad.join(', ')}` : ''}` : '사전 점검 기록 없음';
    rows.push(vcRow(id, st, (b?.fails.length || 0) + (b?.rpo7 || 0) + (preSt && preSt !== 'ok' ? 1 : 0), `${preText}${bkText ? ` · ${bkText}` : ''}`));
  }
  return { rows, basis: `${rowsBasis(rows)} · 마지막 사전 점검 ${v?.last?.at ? 'O' : '기록 없음'} · 백업 결과는 원장(Director 호출 없음)`, asOf: numOrNull(v?.last?.at) };
}

/** 미보호 VM — 미보호 VM 리포트 계산(라우트 공급자). 이벤트를 모으지 않는 vCenter 는 확인 불가. */
export async function unprotected(ctx) {
  const p = periodicProvider('unprotected');
  if (!p) return { status: 'unknown', unknownReason: '미보호 VM 계산을 쓸 수 없습니다(라우트 공급자 미등록)', rows: [] };
  const days = Math.max(1, Math.min(90, Math.ceil((ctx.to - ctx.from) / 86_400_000)));
  const r = await p({ lookbackDays: days });
  const s = r?.summary || {};
  const unp = new Map(); for (const v of r?.unprotected || []) unp.set(v.vcenterId, (unp.get(v.vcenterId) || 0) + 1);
  // 판정 불가 VM(이벤트 없음 · 수집 꺼짐 · 심각도 거르기 등) — 목록은 1,000건 상한이라 법인별 수는 하한이다. 미보호가 없고 판정 불가가 있으면 확인 불가.
  const und = new Map(); for (const v of r?.undetermined || []) und.set(v.vcenterId, (und.get(v.vcenterId) || 0) + 1);
  const nc = new Map((s.notCollectedVcenters || []).map((x) => [String(x.vcenterId ?? x.id ?? x), x.why || x.reason || '이벤트 미수집']));
  const lag = new Set((s.laggingVcenters || []).map((x) => String(x.vcenterId ?? x.id ?? x)));
  const rows = activeVcs(ctx.snap).map((v) => {
    const id = String(v.id);
    if (nc.has(id)) return vcRow(id, 'unknown', null, `이벤트를 이 포탈이 모으지 않음(${nc.get(id)})`);
    if (lag.has(id)) return vcRow(id, 'unknown', null, '이벤트 수집이 뒤처짐');
    const k = unp.get(id) || 0; const u = und.get(id) || 0;
    return vcRow(id, k ? 'warn' : u ? 'unknown' : 'ok', k, `미보호 VM ${n(k)}대${u ? ` · 판정 불가 ${n(u)}대 이상` : ''}`);
  });
  return { rows, basis: `${rowsBasis(rows)} · 조회 ${days}일 · 보호 ${n(s.protectedCount)} · 미보호 ${n(s.unprotectedCount)} · 판정 불가 ${n(s.undeterminedCount)}${s.eventsTruncated ? ' · 이벤트 상한에서 잘림' : ''}` };
}

/**
 * VM 복제(백업식) 실패 · RPO(컨펌 ④) — 잡마다 실행 기록(위임 잡은 엣지 보고). 연속 2회 이상 실패 · 마지막 성공 7일 넘음은 이상 ·
 *   한 번 실패 · RPO 넘김(rpoOf — 기대 주기의 2배 + 1시간 · VM 백업 실패 메일과 같은 기준)은 주의. 켜진 잡이 없으면 해당 없음.
 */
export async function vmClone(ctx) {
  const { backupFacts } = await import('../backupService.js');
  const { backupJudge } = await import('../backupLedger.js');
  const f = await backupFacts(ctx);
  if (!f.cloneOk) return { status: 'unknown', unknownReason: 'VM 복제 잡 원장을 읽지 못했습니다', rows: [] };
  const rows = [];
  let jobs = 0;
  for (const [vc, x] of f.vcs) {
    const c = x.clone;
    if (!c) continue;
    jobs += c.jobs;
    const st = backupJudge({ failNow: c.fails.length, failRepeat: repeatOf(c), rpo7: c.rpo7, rpo3: c.overdue });
    rows.push(vcRow(vc, st, c.fails.length + c.overdue, `잡 ${n(c.jobs)} · ${backupText(c, { rpo: false, overdue: true })}`));
  }
  if (!jobs) return { na: true, basis: '켜진 VM 복제 잡이 없습니다' };
  return { rows, basis: `잡 ${n(jobs)}개 · ${rowsBasis(rows)}` };
}

/** 중앙 ↔ 엣지 · vCenter 통신 점검 — 마지막 판정(link_latest). 기능이 꺼져 있으면 확인 불가. */
export async function linkCheck(ctx) {
  const { linkCheckEnabled } = await import('../../linkcheck/settings.js');
  if (!linkCheckEnabled()) return { status: 'unknown', unknownReason: '통신 점검이 꺼져 있습니다(기본값)', rows: [] };
  const { latestAll } = await import('../../linkcheck/db.js');
  const { centralLinks } = await import('../../linkcheck/poller.js');
  const latestRows = await latestAll();
  if (!latestRows) return { status: 'unknown', unknownReason: '통신 점검 DB 를 열지 못했습니다', rows: [] };
  const links = new Map((centralLinks().all || []).map((l) => [String(l.id), l]));
  const acc = new Map();
  for (const r of latestRows) {
    const l = links.get(String(r.link_id));
    if (!l || l.enabled === false) continue;
    const vc = String(l.vcenterId || l.vcId || '');
    const a = acc.get(vc) || { crit: 0, ok: 0, names: [] };
    if (r.ok) a.ok++; else { a.crit++; if (a.names.length < 3) a.names.push(`${l.label || l.id} ${r.phase || ''}${r.fail_kind ? `(${r.fail_kind})` : ''}`); }
    acc.set(vc, a);
  }
  const rows = [...acc.entries()].map(([vc, a]) => ({ ...(vc ? { vc } : {}), status: a.crit ? 'crit' : 'ok', count: a.crit, text: `링크 ${a.crit + a.ok} · 실패 ${a.crit}${a.names.length ? ` — ${a.names.join(', ')}` : ''}` }));
  if (!rows.length) return { na: true, basis: '점검할 링크가 없습니다' };
  return { rows, basis: rowsBasis(rows, '대상'), asOf: latest(latestRows.map((r) => r.ts)) };
}

/** 엣지 보고 신선도 — 위임(site) vCenter 의 마지막 수신이 기준보다 오래됐는가(store.siteInventoryStale). */
export async function edgeFresh(ctx) {
  const { siteInventoryStale } = await import('../../store.js');
  const rows = [];
  for (const v of activeVcs(ctx.snap)) {
    if (v.collectSource !== 'site') continue;
    const stale = siteInventoryStale(v);
    rows.push(vcRow(v.id, stale ? 'warn' : 'ok', stale ? 1 : 0, stale ? `엣지 보고가 오래됨(마지막 수신 ${numOrNull(v.receivedAt) ? new Date(v.receivedAt).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '모름'})` : '보고 정상'));
  }
  if (!rows.length) return { na: true, basis: '엣지가 수집하는 vCenter 가 없습니다' };
  return { rows, basis: rowsBasis(rows) };
}

/** 법인 간 전송 속도(정보) — 엣지마다 마지막 판정(edgeRows). 엣지 축이라 전체 항목. */
export async function xferSpeed(ctx) {
  const { xferSpeedEnabled, loadXferSpeedSettings } = await import('../../xferspeed/settings.js');
  const s = loadXferSpeedSettings();
  if (!xferSpeedEnabled(s)) return { value: '전송 속도 측정이 꺼져 있습니다', rows: [] };
  const { latestAll, samplesSince } = await import('../../xferspeed/db.js');
  const { edgeRowsAsync } = await import('../../xferspeed/analyze.js');
  const { listCollectors } = await import('../../collector/registry.js');
  const lat = await latestAll();
  const recent = await samplesSince(ctx.now - 7 * 86_400_000, { limit: 50_000 });
  const rows0 = await edgeRowsAsync({ collectors: listCollectors(), latest: Array.isArray(lat) ? lat : (lat?.rows || []), recent: Array.isArray(recent) ? recent : (recent?.rows || []), settings: s, now: ctx.now });
  const c = {};
  for (const r of rows0 || []) c[r.state] = (c[r.state] || 0) + 1;
  return { value: `엣지 ${n((rows0 || []).length)}곳 — 정상 ${n(c.ok)} · 느림 ${n(c.slow)} · 실패 ${n(c.fail)} · 오래됨 ${n(c.stale)} · 기록 없음 ${n(c['no-data'])}`,
    detail: (rows0 || []).filter((r) => r.state === 'slow' || r.state === 'fail').slice(0, 10).map((r) => `${r.name || r.id} ${r.state}${r.reason ? ` — ${r.reason}` : ''}`), rows: [] };
}

/** HAProxy 경로 점검 — 메모리 상태(회차 시점). */
export async function relaycheck() {
  const { relayCheckStatus } = await import('../../relaycheck/poller.js');
  const st = relayCheckStatus();
  if (!st?.last?.at) return { status: 'unknown', unknownReason: '경로 점검이 아직 돌지 않았습니다(재시작 뒤 첫 주기 전)', rows: [] };
  const fail = (st.results || []).filter((r) => r && r.ok === false);
  return { status: fail.length ? 'warn' : 'ok', count: fail.length, basis: `경로 ${n(st.last.total)} · 실패 ${n(fail.length)} · 회차 시점 상태`, asOf: numOrNull(st.last.at),
    detail: fail.slice(0, 10).map((r) => `${r.target?.label || r.target?.key || ''} ${r.phase || ''} 연속 ${r.failStreak || 1}회`) };
}

/** 포탈 내부 서비스 · 폴러(getServiceCheck — 진단 화면과 같은 판정). */
export async function portalServices() {
  const { getServiceCheck } = await import('../../health/services.js');
  const r = getServiceCheck({ isAdmin: false });
  const MAP = { ok: 'ok', warn: 'warn', down: 'crit', unknown: 'unknown' };
  const s = r?.summary || {};
  return { status: MAP[r?.overall] || 'unknown', count: (s.down || 0) + (s.warn || 0), basis: `서비스 ${n(s.total)} — 멈춤 ${n(s.down)} · 주의 ${n(s.warn)} · 꺼짐 ${n(s.off)} · 확인 불가 ${n(s.unknown)}`,
    detail: (r?.checks || []).filter((c) => c.status === 'down' || c.status === 'warn').slice(0, 10).map((c) => `${c.label} ${c.status}${c.detail ? ` — ${String(c.detail).slice(0, 80)}` : ''}`) };
}

/** 포탈 DB(가벼운 크기 · 여유 보고 — 정합성 검사(inspectMany)는 무거워 돌리지 않는다). 디스크가 30일 안에 찬다는 전망이면 이상 · 90일 안이면 주의. */
export async function portalDb(ctx) {
  const { portalDbReport } = await import('../../insights/portalDb.js');
  const r = portalDbReport(ctx.now);
  const d = numOrNull(r?.daysUntilFull);
  const st = d == null ? 'ok' : d <= 30 ? 'crit' : d <= 90 ? 'warn' : 'ok';
  const gb = (b) => (numOrNull(b) == null ? '—' : `${(b / 1024 ** 3).toFixed(1)} GB`);
  return { status: st, count: d != null && d <= 90 ? 1 : 0, basis: `DB 합계 ${gb(r?.totalBytes)} · 하루 증가 ${gb(r?.perDayTotalBytes)} · 디스크 여유 ${gb(r?.disk?.freeBytes ?? r?.disk?.free)} · 가득 참까지 ${d == null ? '—(증가 없음 · 모름)' : `${d}일`} · 정합성 검사는 포탈 DB 화면에서` };
}

/** vCenter 로그인 실패 — 기간 중(일수) 분석. 이벤트를 모으지 않는 vCenter 는 확인 불가. */
export async function loginFails(ctx) {
  const { analyzeLoginFails } = await import('../../security/loginFails.js');
  const days = Math.max(1, Math.min(90, Math.ceil((ctx.to - ctx.from) / 86_400_000)));
  const r = await analyzeLoginFails({ days });
  const nc = new Map((r?.notCollected || []).map((x) => [String(x.vcenterId), x.why || '이벤트 미수집']));
  const by = new Map((r?.bySource || []).map((x) => [String(x.key), numOrNull(x.count) ?? 0]));
  const rows = activeVcs(ctx.snap).map((v) => {
    const id = String(v.id);
    if (nc.has(id)) return vcRow(id, 'unknown', null, `이벤트를 이 포탈이 모으지 않음(${nc.get(id)})`);
    const k = by.get(id) || 0;
    return vcRow(id, 'ok', k, `로그인 실패 ${n(k)}건`);
  });
  const active = numOrNull(r?.summary?.active) ?? 0;
  return { rows, status: active > 0 ? 'warn' : undefined, count: numOrNull(r?.summary?.total),
    basis: `${days}일 · 실패 ${n(r?.summary?.total)}건 · 반복 시도 계정 ${n(r?.summary?.offenders)} · 지금 진행 중 ${n(active)}${r?.incomplete ? ' · 일부만 셈' : ''}`,
    detail: (r?.offenders || []).slice(0, 8).map((o) => `${o.label} ${o.total}건${o.active ? ' (진행 중)' : ''}`) };
}

/** Horizon 세션(정보) — 서버별 최신 기록 수만(법인 귀속을 모른다 — 전체 항목). */
export async function horizon(ctx) {
  const db = await import('../../horizon/sessionDb.js');
  const recs = typeof db.hzLatestRecords === 'function' ? await db.hzLatestRecords() : null;
  if (!recs) return { value: 'Horizon 세션 기록이 없습니다(수집 꺼짐 · DB 없음)', rows: [] };
  const list = Array.isArray(recs) ? recs : Object.values(recs);
  return { value: `서버 ${n(list.length)}곳 · 지금 세션 합 ${n(list.reduce((a, r) => a + (numOrNull(r.sessions ?? r.total ?? r.count) ?? 0), 0))}`, rows: [] };
}

/** 포탈 서버 리소스 적정성(summarizeHosts — 진단 화면과 같은 판정): 늘려야 함은 주의. */
export async function capacityAdvisor() {
  const { summarizeHosts } = await import('../../capacity/evaluate.js');
  const list = await summarizeHosts();
  if (!Array.isArray(list) || !list.length) return { status: 'unknown', unknownReason: '포탈 서버 실측 기록이 없습니다', rows: [] };
  let up = 0; let measuring = 0;
  const names = [];
  for (const h of list) {
    const g = Object.values(h.groups || {});
    if (g.includes('scale_up')) { up++; names.push(h.meta?.name || h.k); }
    else if (g.length && g.every((x) => x === 'measuring' || x === 'info')) measuring++;
  }
  return { status: up ? 'warn' : (measuring === list.length ? 'unknown' : 'ok'), count: up, basis: `포탈 서버 ${list.length}대 · 늘려야 함 ${up} · 측정 중 ${measuring}${names.length ? ` — ${names.slice(0, 5).join(', ')}` : ''}`,
    ...(measuring === list.length ? { unknownReason: '표본이 아직 부족합니다(측정 중)' } : {}) };
}



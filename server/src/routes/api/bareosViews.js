/**
 * Bareos 조회 화면(v2.828 · 사용자 요청 '28개 법인마다 따로 · 통합 화면' + 권장안 A '조회 전용 도구 키 신설').
 *   GET /tools/bareos-summary        — 28개 법인 한 표 + 우선 확인 목록(도구 키 bareos-summary)
 *   GET /tools/bareos-detail         — 법인(vCenter) 하나의 Bareos 관련 VM 을 폴더 트리로(도구 키 bareos-detail)
 *   GET /tools/bareos-summary.csv · /tools/bareos-detail.csv — 같은 값 내보내기(data.csv · 동시 1건 · 감사)
 *
 * 규칙(되돌리지 말 것 — test/bareosViews2828.test.js):
 *   · **Director 에 접속하지 않는다** — 원장(폴러가 반영한 값)·백업 표시·폴러 메모리 상태만 읽는다. 그래서 readDirector 를 쓰지 않는다.
 *   · 조회 범위(scopedVcenterIds) 교집합이 먼저 — 범위 밖 vCenter 는 404(존재 은닉) · 통합 표에 없다. 응답 캐시는 scopeKey 를 키에 넣는다.
 *   · Director 주소·콘솔 이름·접속 오류 원문은 싣지 않는다(상태 코드와 이름만) — 관리 화면(bareos-backup)과 달리 운영자·범위 계정이 보는 화면이다.
 *   · 못 읽은 값은 0 이 아니다(vmView.corpCounts) — 표시 파일 손상·원장 손상·Director 조회 정지는 null + 사유.
 *   · 쓰기(지금 백업·복원·등록)는 여기 없다 — 관리 화면(bareos-backup)의 기존 POST 라우트(admin · OTP)만.
 */
import { requirePerm, toolActorOf } from '../../auth/auth.js';
import { issueFor } from '../../auth/toolAccess.js';
import { scopedVcenterIds } from '../../auth/scope.js';
import { store } from '../../store.js';
import { memoJson, scopeKey } from './shared.js';
import { logAudit } from '../../audit.js';
import { csvLine, CSV_BOM } from '../../util/csv.js';
import { fileStamp } from '../../util/dayKey.js';
import { acquireExport } from '../../util/exportBusy.js';
import { jobDigests, registryLoadError, registryRev } from '../../bareos/registry.js';
import { directorConn, directorCred, settingsRev } from '../../bareos/settings.js';
import { effectiveSettings, isDemoActive, bareosAuthGuard } from '../../bareos/service.js';
import { pollerStatus } from '../../bareos/poller.js';
import { bareosVmView, bareosClass, corpCounts, sumCounts, directorState, priorityKind, priorityCmp, PRIORITY_MAX, BAREOS_RPO_DAYS } from '../../bareos/vmView.js';
import { getMarks, marksRev, marksUnreadable } from '../../veeam/backupMarks.js';
import { statusOf } from '../../bareos/names.js';
import { isSystemVm, METHOD_TEXT } from '../../veeam/backupStatus.js';

const rpoOf = (req) => (BAREOS_RPO_DAYS.includes(Number(req.query.rpoDays)) ? Number(req.query.rpoDays) : 1);
const gbOf = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v * 10) / 10 : null);

/** 응답 캐시 키 — 표시·원장·설정·폴러가 바뀌면 바로 새로 센다(폴러 at 은 틱마다 바뀐다). */
const cacheKey = (req, snap) => `${scopeKey(req.user, snap)}|m${marksRev()}|r${registryRev()}|s${settingsRev()}|p${pollerStatus().at || 0}|d${isDemoActive() ? 1 : 0}|e${registryLoadError() ? 1 : 0}${marksUnreadable() ? 1 : 0}`;   // 손상 상태가 바뀌면(재시작 없이 다시 읽은 경우) 캐시를 쓰지 않는다

/** vCenter 별 Director 정보(이름·상태·담당) — 주소·콘솔·오류 원문 없음. */
function directorInfo(vcenterId, settings, poller, demo) {
  const site = settings.sites.find((s) => s.vcenterId === vcenterId) || null;
  const d = site ? settings.directors.find((x) => x.id === site.directorId) || null : null;
  const configured = !!d && (demo || !!directorConn(d).conn);
  let authStopped = false;
  try { authStopped = !!d && !demo && !!bareosAuthGuard.peekAuthStop(directorCred(d)); } catch { authStopped = false; }
  const poll = d ? poller?.directors?.[d.id] || null : null;
  const st = directorState({ mapped: !!site, configured, authStopped, poll });
  return {
    id: d?.id || '', name: d?.name || '', via: d?.agent ? 'edge' : 'central',
    state: st.state, resultsKnown: st.resultsKnown, at: Number.isFinite(poll?.at) ? poll.at : null,
    ...(site ? { schedule: site.schedule || '', pool: site.pool || '' } : {}),
  };
}

/**
 * 법인 하나의 Bareos 관련 VM 행 — 방식 bareos ∪ 잡 있음. 잡은 있는데 인벤토리에 VM 이 없으면 gone 행(원장의 이름·위치).
 * @returns {{ rows:Array, vmTotal:number }}
 */
function corpRows(vcenterId, vms, byVm, marks, { marksKnown, registryKnown }, { withJob = false } = {}) {
  const rows = [];
  const seen = new Set();
  let vmTotal = 0;
  for (const vm of vms) {
    if (!isSystemVm(vm)) vmTotal++;
    const j = registryKnown ? byVm.get(vm.id) : undefined;
    const method = marksKnown ? String(marks[vm.id]?.method || '') : '';
    if (!j && method !== 'bareos') continue;
    seen.add(vm.id);
    const m = marksKnown ? marks[vm.id] : null;
    rows.push({
      id: vm.id, name: String(vm.name || ''), folder: String(vm.folder || ''), power: vm.powerState || '', gb: gbOf(vm.storageGB),
      method: marksKnown ? method : null, crit: m?.crit || '', need: m?.need === true,
      b: registryKnown ? bareosVmView(j, method) : null,
      ...(withJob && j ? jobExtra(j) : {}),
    });
  }
  if (registryKnown) {
    for (const j of byVm.values()) {
      if (j.vcenterId !== vcenterId || seen.has(j.vmId)) continue;
      const method = marksKnown ? String(marks[j.vmId]?.method || '') : '';
      rows.push({ id: j.vmId, name: String(j.vmName || ''), folder: String(j.folder || ''), power: '', gb: null, method: marksKnown ? method : null, crit: '', need: false,
        gone: true, b: { ...bareosVmView(j, method), gone: true }, ...(withJob ? jobExtra(j) : {}) });
    }
  }
  return { rows, vmTotal };
}

/**
 * 법인별 현황의 상세 패널용(그 법인 행에만) — 잡 이름·스케줄·기본 레벨·등록자와 최근 끝난 실행 5건. 비밀 없음(콘솔·주소는 원장에 없다).
 *   finishedRuns 에는 바이트가 없다(registry.applyRunRow) — 화면은 결과·레벨·끝난 시각만 그린다.
 */
function jobExtra(j) {
  return {
    job: { name: String(j.bareosJob || ''), schedule: String(j.schedule || ''), level: String(j.level || ''), by: String(j.createdBy || ''), at: Number.isFinite(j.createdAt) ? j.createdAt : null },
    runs: (Array.isArray(j.recentRuns) ? j.recentRuns : []).slice().reverse().map((r) => ({ jobid: r.jobid, st: r.state || statusOf(r.status), lv: r.level || '', at: Number.isFinite(r.endedAt) ? r.endedAt : null })),
  };
}

/** 범위 안 vCenter 목록과 공통 재료(표시·원장·설정·폴러). */
function prepare(req, snap) {
  const allowed = scopedVcenterIds(req.user, snap);
  const vcs = (snap?.vcenters || []).filter((v) => !allowed || allowed.has(v.id));
  const marksKnown = !marksUnreadable();
  const marks = marksKnown ? getMarks() : {};
  const registryKnown = !registryLoadError();
  const byVcVm = new Map();   // vcenterId → Map(vmId → digest)
  if (registryKnown) {
    for (const j of jobDigests()) {
      if (allowed && !allowed.has(j.vcenterId)) continue;
      let m = byVcVm.get(j.vcenterId);
      if (!m) { m = new Map(); byVcVm.set(j.vcenterId, m); }
      m.set(j.vmId, j);
    }
  }
  const demo = isDemoActive();
  return { allowed, vcs, marks, marksKnown, registryKnown, byVcVm, settings: effectiveSettings(), poller: pollerStatus(), demo };
}

const notices = (p) => ({
  ...(p.marksKnown ? {} : { marksUnreadable: true }),
  ...(p.registryKnown ? {} : { registryUnreadable: true }),
  ...(p.demo ? { demo: true } : {}),
});

/** 통합 현황 — 법인마다 한 줄 + 합계 + 우선 확인 목록. 요청 경로 O(VM 수)(28 × 약 200대 — 한 번 순회). */
export function summaryData(req, snap, { rpoDays = 1, now = Date.now(), detailOk = true } = {}) {
  const p = prepare(req, snap);
  const vmsBy = new Map();
  for (const vm of snap?.vms || []) { const a = vmsBy.get(vm.vcenterId); if (a) a.push(vm); else vmsBy.set(vm.vcenterId, [vm]); }
  const out = []; const prio = [];
  for (const vc of p.vcs) {
    const dir = directorInfo(vc.id, p.settings, p.poller, p.demo);
    const { rows, vmTotal } = corpRows(vc.id, vmsBy.get(vc.id) || [], p.byVcVm.get(vc.id) || new Map(), p.marks, p);
    const counts = corpCounts(rows, { marksKnown: p.marksKnown, resultsKnown: dir.resultsKnown, registryKnown: p.registryKnown, rpoDays, now });
    // 버그 점검 S13: '마지막 백업' = 마지막으로 **백업이 만들어진**(성공·경고) 시각(b.ok) — 끝난 실행(b.at)이면 실패도 들어가 법인별 화면·우선 목록과 달랐다
    let lastAt = null;
    for (const r of rows) if (r.b?.ok && (lastAt == null || r.b.ok > lastAt)) lastAt = r.b.ok;
    out.push({ id: vc.id, name: vc.name || vc.id, region: vc.location?.region || '', vm: vmTotal, director: dir, counts, lastAt: dir.resultsKnown ? lastAt : null });
    for (const r of rows) {
      const kind = priorityKind(r, { resultsKnown: dir.resultsKnown, marksKnown: p.marksKnown, rpoDays, now });
      if (kind) prio.push({ vcenterId: vc.id, vcName: vc.name || vc.id, id: r.id, name: r.name, folder: r.folder, crit: r.crit, kind, at: r.b?.at ?? null, ok: r.b?.ok ?? null, st: r.b?.st ?? null });
    }
  }
  prio.sort(priorityCmp);
  const kindCount = {};
  for (const x of prio) kindCount[x.kind] = (kindCount[x.kind] || 0) + 1;
  const dirStates = {};
  for (const r of out) dirStates[r.director.state] = (dirStates[r.director.state] || 0) + 1;
  return {
    ok: true, at: now, rpoDays, rows: out, totals: { ...sumCounts(out.map((r) => r.counts)), vm: out.reduce((s, r) => s + r.vm, 0) }, directorStates: dirStates,
    // 버그 점검 S15: 우선 확인 목록은 VM 단위(이름·폴더) — 법인별 현황(bareos-detail)을 거부한 계정에는 싣지 않는다(backup-summary 의 v2.787 withheld 와 같은 규칙)
    ...(detailOk ? { priority: prio.slice(0, PRIORITY_MAX), priorityTotal: prio.length, priorityByKind: kindCount } : { priority: [], priorityTotal: null, priorityByKind: {}, priorityWithheld: 'detail-tool' }),
    ...notices(p),
    ...(p.allowed ? { scoped: true } : {}),
  };
}

/** 법인별 현황 — vCenter 하나. 범위 밖·없는 vCenter 는 null(라우트가 404). */
export function detailData(req, snap, vcenterId, { rpoDays = 1, now = Date.now() } = {}) {
  const p = prepare(req, snap);
  const vc = p.vcs.find((v) => v.id === vcenterId);
  if (!vc) return null;
  const dir = directorInfo(vc.id, p.settings, p.poller, p.demo);
  const vms = (snap?.vms || []).filter((v) => v.vcenterId === vc.id);
  const { rows, vmTotal } = corpRows(vc.id, vms, p.byVcVm.get(vc.id) || new Map(), p.marks, p, { withJob: true });
  const counts = corpCounts(rows, { marksKnown: p.marksKnown, resultsKnown: dir.resultsKnown, registryKnown: p.registryKnown, rpoDays, now });
  return {
    ok: true, at: now, rpoDays, vcenter: { id: vc.id, name: vc.name || vc.id }, vm: vmTotal, director: dir, counts, rows,
    // 법인 고르기 · 바로가기 칩(범위 안 vCenter 의 이름과 Director 상태만 — 다른 법인의 VM 은 싣지 않는다)
    corps: p.vcs.map((v) => ({ id: v.id, name: v.name || v.id, state: directorInfo(v.id, p.settings, p.poller, p.demo).state })),
    ...notices(p),
  };
}

const ST_TEXT = { ok: '성공', warning: '경고', error: '실패', canceled: '취소' };
const DIR_TEXT = { ok: '정상', relay: '엣지 대행 회신 대기', pending: '조회 전', error: '조회 실패', auth: '인증 정지', unset: '미설정' };
const iso = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : '');
const n = (v) => (v == null ? '' : v);

export function registerBareosViews(api) {
  const toolsPerm = requirePerm('tools');
  const csvPerm = requirePerm('data.csv');

  api.get('/tools/bareos-summary', toolsPerm, (req, res) => {
    const snap = store.get();
    const rpoDays = rpoOf(req);
    const detailOk = !issueFor(toolActorOf(req), 'bareos-detail');
    return memoJson(req, res, 'bareos-summary', async () => summaryData(req, snap, { rpoDays, detailOk }), { ttlMs: 30_000, extraKey: `${cacheKey(req, snap)}|d${detailOk ? 1 : 0}` });   // d = 우선 목록 공개 여부(키에 없으면 캐시로 샌다)
  });

  api.get('/tools/bareos-detail', toolsPerm, (req, res) => {
    const snap = store.get();
    const vcenterId = String(req.query.vcenterId || '').slice(0, 128);
    const allowed = scopedVcenterIds(req.user, snap);
    if (!vcenterId || (allowed && !allowed.has(vcenterId)) || !(snap?.vcenters || []).some((v) => v.id === vcenterId)) {
      return res.status(404).json({ ok: false, reason: 'vCenter 를 찾을 수 없습니다.' });
    }
    const rpoDays = rpoOf(req);
    return memoJson(req, res, `bareos-detail:${vcenterId}`, async () => detailData(req, snap, vcenterId, { rpoDays }), { ttlMs: 30_000, extraKey: cacheKey(req, snap) });
  });

  api.get('/tools/bareos-summary.csv', csvPerm, toolsPerm, (req, res) => {
    const lock = acquireExport('bareos-summary.csv', req);
    if (!lock.ok) return res.status(lock.status).json(lock.body);
    try {
      const d = summaryData(req, store.get(), { rpoDays: rpoOf(req) });
      const lines = [CSV_BOM + csvLine(['법인(vCenter)', 'Director', 'Director 상태', '담당', 'VM', 'Bareos 방식 VM', '잡 등록', '잡 꺼짐', '미등록', '방식 불일치',
        '성공', '경고', '실패·취소', '진행 중', `${d.rpoDays}일+ 경과`, '백업 없음', '결과 모름', '용량(GB)', '마지막 백업(UTC)'])];
      for (const r of d.rows) {
        const c = r.counts;
        lines.push(csvLine([r.name, r.director.name, DIR_TEXT[r.director.state] || r.director.state, r.director.via === 'edge' ? '엣지 대행' : '중앙 직접', r.vm,
          n(c.bareosMethod), n(c.jobs), n(c.off), n(c.missing), n(c.mismatch), n(c.ok), n(c.warn), n(c.fail), n(c.run), n(c.old), n(c.never), n(c.unknown), c.gb, iso(r.lastAt)]));
      }
      logAudit({ user: req.user?.username, action: 'bareos-summary.csv', target: 'bareos-summary', detail: `${d.rows.length} rows`, ip: req.ip });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="bareos-summary-${fileStamp()}.csv"`);
      res.send(lines.join('\r\n'));
    } catch { if (!res.headersSent) res.status(500).json({ ok: false, reason: 'CSV 를 만들지 못했습니다.' }); } finally { lock.release(); }
  });

  api.get('/tools/bareos-detail.csv', csvPerm, toolsPerm, (req, res) => {
    const snap = store.get();
    const vcenterId = String(req.query.vcenterId || '').slice(0, 128);
    const allowed = scopedVcenterIds(req.user, snap);
    if (!vcenterId || (allowed && !allowed.has(vcenterId)) || !(snap?.vcenters || []).some((v) => v.id === vcenterId)) {
      return res.status(404).json({ ok: false, reason: 'vCenter 를 찾을 수 없습니다.' });
    }
    const lock = acquireExport('bareos-detail.csv', req);
    if (!lock.ok) return res.status(lock.status).json(lock.body);
    try {
      const d = detailData(req, snap, vcenterId, { rpoDays: rpoOf(req) });
      const now = Date.now();
      const lines = [CSV_BOM + csvLine(['vCenter', '폴더', 'VM', '전원', '용량(GB)', '백업 방식', '잡', '잡 켜짐', '마지막 결과', '마지막 실행 끝(UTC)', '레벨', '바이트',
        '마지막 백업(UTC)', '진행 중', `${d.rpoDays}일+ 경과`, '인벤토리에 없음'])];
      for (const r of d.rows) {
        const k = bareosClass(r.b, { rpoDays: d.rpoDays, now });
        lines.push(csvLine([d.vcenter.name, r.folder, r.name, r.power === 'POWERED_ON' ? '켜짐' : r.power ? '꺼짐' : '', n(r.gb),
          r.method == null ? '모름' : METHOD_TEXT[r.method] || '', r.b == null ? '모름' : k.job ? '있음' : k.missing ? '미등록' : '', k.job ? (k.on ? '예' : '아니오') : '',
          // 버그 점검 S17: 결과를 모르는 법인(인증 정지·조회 실패·미설정)은 결과·진행 칸에 '모름' 을 덧붙인다(값은 마지막으로 읽은 것 — 화면의 회색 칩과 같은 뜻)
          k.job ? `${ST_TEXT[r.b.st] || ''}${d.director.resultsKnown ? '' : '(모름 — 마지막으로 읽은 값)'}` : '', iso(r.b?.at), r.b?.lv || '', n(r.b?.by), iso(r.b?.ok),
          d.director.resultsKnown ? (r.b?.run ? '예' : '') : (k.job ? '모름' : ''), d.director.resultsKnown ? (k.old ? '예' : '') : '모름', r.gone ? '예' : '']));
      }
      logAudit({ user: req.user?.username, action: 'bareos-detail.csv', target: vcenterId, detail: `${d.rows.length} rows`, ip: req.ip });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="bareos-detail-${fileStamp()}.csv"`);
      res.send(lines.join('\r\n'));
    } catch { if (!res.headersSent) res.status(500).json({ ok: false, reason: 'CSV 를 만들지 못했습니다.' }); } finally { lock.release(); }
  });
}

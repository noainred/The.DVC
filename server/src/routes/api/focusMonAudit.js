/**
 * routes/api/focusMonAudit.js — 서버 집중 모니터링 ‘디스크 점검’(배드 섹터 점검 프로그램) API(v3.11.0). 경로 첫 세그먼트 `focus-mon` = 도구 키(toolAccess 집행).
 *
 * 사용자 요청(2026-11-14 ~ 15): "집중 모니터링 기능에 배드섹터 점검 프로그램 추가해줘"(+ 프로그램 원문) · "법인별로 보는 기능, 모델별로 보는 기능 등" ·
 * "법인별로 디스크 모델별로 보는 기능" · "기본값대로 모두 구현해줘". 설계 docs/design/focus-mon/README.md §20.
 *
 * ── 권한(집중 모니터링과 같다) ──────────────────────────────────────────────────────────────────────
 *  · 조회 = admin + 전체 범위(fullScopeOnly) — 결과에 커널 로그 줄 · 디스크 시리얼이 들어간다.
 *  · 실행 · 준비 확인 = admin + 조회 · 쓰기 모두 전체 범위(fullReadWriteScopeOnly) + 데모 계정 차단 · 감사. 실행은 대상 서버에서 sudo 로 고정 명령 하나를 부른다.
 *  · 설치 파일 내려받기 = admin + 전체 범위 · 감사(비밀 없음 — 프로그램 · 실행 파일 · sudoers 한 줄을 만드는 셸 파일).
 *  · 요청 본문으로 주소 · 계정을 받지 않는다 — 대상은 등록부에서만. 범위 밖 · 없는 대상은 404.
 *  · 등록부를 못 읽었으면 503(registryUnreadable) — 본 탭 · 진행 중 작업 · 회차 목록 · 회차 보기 · 원문 내려받기 모두(반증 F9-i).
 *  · '최근 결과' 는 **지금 접속처의 회차만**(회차 summary.ep = audit/service endpointKey) — 예전 주소로 돈 결과를 새 주소의 서버 값으로 쓰지 않는다.
 *  · 무거운 조회(요약 · 묶어 보기)는 화면이 탭을 열 때와 작업이 끝날 때만 부른다. 진행 중에는 가벼운 `audit/jobs`(메모리만)를 본다.
 */
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { requireRole } from '../../auth/auth.js';
import { logAudit } from '../../audit.js';
import { fullScopeOnlyWith, fullReadWriteScopeOnlyWith } from '../admin/shared.js';
import { isDemoGuest } from '../../auth/demoGuest.js';
import { summarizeRegistryError } from '../../util/registryCore.js';
import * as registry from '../../focusmon/registry.js';
import { allTargets, isMockMode, focusKeys } from '../../focusmon/service.js';
import { wakeEdge } from '../../central/focusMonEdge.js';
import * as A from '../../focusmon/audit/service.js';
import * as db from '../../focusmon/db.js';
import { corpResolver } from '../../focusmon/audit/corp.js';
import { groupRows, byDiskModel, crossCorpModel, auditKpis, NO_CORP, NO_MODEL, NO_GROUP, RATE_MIN_DISKS } from '../../focusmon/audit/aggregate.js';
import { splitRun, parseReport, parseDisks, evidenceKey, ERROR_KINDS, SHAPE_TEXT } from '../../focusmon/audit/parse.js';
import { installScript, programSha, wrapperSha, PROGRAM_PATH, WRAPPER_PATH, SUDOERS_PATH, RUN_COMMAND } from '../../focusmon/audit/bundle.js';
import crypto from 'node:crypto';

const gunzipAsync = promisify(zlib.gunzip);
const adminOnly = requireRole('admin');
const fullScopeOnly = fullScopeOnlyWith('서버 집중 모니터링은 전체 범위(vCenter 제한 없는) 계정만 볼 수 있습니다 — 전 법인 서버의 주소 · 디스크 기록이 들어갑니다.');
const fullRwOnly = fullReadWriteScopeOnlyWith('서버 집중 모니터링의 디스크 점검 실행은 조회 · 쓰기 모두 전체 범위인 계정만 할 수 있습니다.');
const demoBlockWrite = (req, res, next) => (isDemoGuest(req.user) ? res.status(403).json({ ok: false, error: 'forbidden', reason: '데모 계정은 디스크 점검을 실행할 수 없습니다.' }) : next());
const hash12 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 12);

function registryUnreadable(res) {
  const e = registry.registryLoadError();
  if (!e) return false;
  res.status(503).json({ ok: false, reason: 'registryUnreadable', detail: `서버 집중 모니터링 등록부(focusmon-targets.json)를 읽지 못했습니다(${summarizeRegistryError(e)?.text || '손상'}) — 손상 보존본을 확인하세요.` });
  return true;
}
function visibleTargets(req) { const all = allTargets(); return isDemoGuest(req.user) ? all.filter((t) => t.demo) : all; }

/** 최근 회차 → 화면용(근거 열쇠 ek 는 싣지 않는다 — 크고 화면에 쓰지 않는다). */
function lastView(r) {
  if (!r) return null;
  const s = r.summary || {};
  const { ek, ...rest } = s; // eslint-disable-line no-unused-vars
  return { id: r.id, at: r.at, ended: r.ended, node: r.node, by: r.by, outcome: r.outcome, rc: r.rc, ver: r.ver, summary: rest };
}

/** 회차가 지금 접속처의 것인가(접속처 지문이 같을 때만 — 지문이 없는 회차도 쓰지 않는다). */
const sameEndpoint = (row, t) => (row && row.summary && row.summary.ep && row.summary.ep === A.endpointKey(t) ? row : null);

/** 서버 행(묶어 보기 · 표의 한 줄) — 판정 코어는 audit/service · aggregate 에 있고 여기는 모으기만 한다. */
function rowsOf(targets, latest, cr) {
  return targets.map((t) => {
    const ready = A.readinessOf(t.id);
    return {
      id: t.id, name: t.name, host: t.host, agent: t.demo ? (t.agent || '') : (t.agent || ''), group: t.group || '', demo: !!t.demo,
      corp: cr.of(t), smodel: ready?.dmi?.product || null, svendor: ready?.dmi?.vendor || null,
      ready: ready ? { state: ready.state || null, reason: ready.reason || '', at: ready.at || null, py: ready.py || null, node: ready.node ?? null, lastExecAt: ready.lastExecAt || null } : null,
      lastError: ready?.lastError || null, job: A.jobOf(t.id), last: lastView(sameEndpoint(latest.get(t.id), t)),
    };
  });
}

export function registerFocusMonAudit(api) {

/** 디스크 점검 탭 — 서버 행 · 묶어 보기 · 한도 · 판본. */
api.get('/tools/focus-mon/audit', adminOnly, fullScopeOnly, async (req, res) => {
  if (registryUnreadable(res)) return;
  A.sweep();
  const targets = visibleTargets(req);
  const cr = corpResolver();
  const latest = await A.latestFor(targets.map((t) => t.id));
  const rows = rowsOf(targets, latest, cr);
  const corpKey = (r) => (r.corp ? r.corp.id : '');
  const corpName = (r) => (r.corp ? r.corp.name : NO_CORP);
  const corpOrder = cr.list.map((d) => d.id);
  const demo = isDemoGuest(req.user);
  res.json({
    ok: true, now: Date.now(), mock: isMockMode(), dbAvailable: await db.available(),
    limits: { ...A.LIMITS, rateMinDisks: RATE_MIN_DISKS },
    version: { program: programSha()?.slice(0, 12) || null, wrapper: wrapperSha().slice(0, 12) },
    paths: { program: PROGRAM_PATH, wrapper: WRAPPER_PATH, sudoers: SUDOERS_PATH, run: RUN_COMMAND },
    labels: { noCorp: NO_CORP, noModel: NO_MODEL, noGroup: NO_GROUP },
    rows,
    kpis: auditKpis(rows),
    views: {
      corp: groupRows(rows, (r) => ({ key: corpKey(r), name: corpName(r) }), corpOrder),
      smodel: groupRows(rows, (r) => ({ key: r.smodel || '', name: r.smodel || NO_MODEL })),
      group: groupRows(rows, (r) => ({ key: r.group || '', name: r.group || NO_GROUP })),
      disk: byDiskModel(rows, corpName),
      crossCorp: crossCorpModel(rows, 'corp', { corpKey, corpName, corpOrder }),
      crossModel: crossCorpModel(rows, 'model', { corpKey, corpName, corpOrder }),
    },
    // 데모 계정에는 실제 법인 목록을 싣지 않는다(등록부 그룹 이름과 같은 규칙)
    corps: demo ? [] : cr.list,
    stateError: A.auditStateError() || null,
  });
});

/** 진행 중 작업만(메모리) — 화면이 작업이 있는 동안 5초마다 본다. */
api.get('/tools/focus-mon/audit/jobs', adminOnly, fullScopeOnly, (req, res) => {
  if (registryUnreadable(res)) return;
  A.sweep();
  const vis = new Set(visibleTargets(req).map((t) => t.id));
  const jobs = [];
  for (const t of visibleTargets(req)) { const j = A.jobOf(t.id); if (j && vis.has(t.id)) jobs.push({ id: t.id, ...j }); }
  res.json({ ok: true, now: Date.now(), jobs });
});

/** 한 서버의 회차 목록(최근부터 · 원문 없이). */
api.get('/tools/focus-mon/audit/:id/runs', adminOnly, fullScopeOnly, async (req, res) => {
  if (registryUnreadable(res)) return;
  const t = visibleTargets(req).find((x) => x.id === String(req.params.id));
  if (!t) return res.status(404).json({ ok: false, code: 'not-found', reason: '없는 대상입니다.' });
  const runs = await db.listAudits(t.id);
  if (runs == null) return res.status(503).json({ ok: false, code: 'db', reason: '기록 DB 를 열지 못했습니다.' });
  // 예전 접속처(주소 · 포트 · 계정 · 담당 노드)로 돈 회차는 표시만 남긴다(oldEndpoint)
  res.json({ ok: true, runs: runs.map((r) => ({ ...lastView(r), oldEndpoint: !sameEndpoint(r, t) })) });
});

/** 회차 하나의 자세한 결과 — 보고서 원문을 다시 해석한다(판정 줄 · 읽은 자료 · 근거 · 해석 범위 · 디스크). 지난 회차에 없던 근거에 new. */
api.get('/tools/focus-mon/audit/run/:runId', adminOnly, fullScopeOnly, async (req, res) => {
  if (registryUnreadable(res)) return;
  const row = await db.readAudit(String(req.params.runId).slice(0, 40));
  const vis = new Set(visibleTargets(req).map((t) => t.id));
  if (!row || !vis.has(row.target)) return res.status(404).json({ ok: false, code: 'not-found', reason: '없는 점검 회차입니다.' });
  let lines = [];
  try { lines = row.report ? (await gunzipAsync(row.report)).toString('utf8').split('\n') : []; } catch { lines = []; }
  const sp = splitRun(lines);
  const rep = parseReport(sp.report);
  const disks = parseDisks(sp.lsblk, sp.raid);
  let prevKeys = null;
  if (row.summary?.prevId) { const p = await db.readAudit(row.summary.prevId); if (p && p.outcome === 'done' && Array.isArray(p.summary?.ek)) prevKeys = new Set(p.summary.ek); }
  const evidence = rep.evidence.map((e) => ({ ...e, isNew: prevKeys ? !prevKeys.has(hash12(evidenceKey(e))) : null }));
  const modelOf = (ids) => { const d = disks.find((x) => (ids.sn && x.sn === ids.sn) || (ids.wwn && x.wwn === ids.wwn)); return d ? d.model : ''; };
  res.json({
    ok: true, run: { ...lastView(row), oldEndpoint: !sameEndpoint(row, visibleTargets(req).find((x) => x.id === row.target)) }, reportLines: lines.length,
    shape: rep.shape.map((k) => SHAPE_TEXT[k] || k),
    verdicts: rep.verdicts, sources: rep.sources, missing: rep.missing, partial: rep.partial, scope: rep.scope, gaps: rep.gaps,
    inventory: rep.inventory.map((d) => ({ ...d, model: modelOf(d.ids) })), evidence, evidenceTotal: rep.evidenceTotal, errorKinds: ERROR_KINDS,
    disks: disks.slice(0, 500), header: rep.header, complete: rep.complete, readyLines: (row.ready || []).length,
  });
});

/** 보고서 원문 내려받기(.txt) — 대상 서버의 실행 출력 그대로(구획 예산으로 줄인 것이면 생략 줄이 들어 있다). */
api.get('/tools/focus-mon/audit/run/:runId/report.txt', adminOnly, fullScopeOnly, async (req, res) => {
  if (registryUnreadable(res)) return;
  const row = await db.readAudit(String(req.params.runId).slice(0, 40));
  const t = row ? visibleTargets(req).find((x) => x.id === row.target) : null;
  if (!row || !t) return res.status(404).json({ ok: false, code: 'not-found', reason: '없는 점검 회차입니다.' });
  let text = '';
  try { text = row.report ? (await gunzipAsync(row.report)).toString('utf8') : ''; } catch { text = ''; }
  logAudit({ user: req.user?.username, action: 'focus-mon.audit.report-download', target: t.name, detail: `${row.id} · ${Buffer.byteLength(text)}B`, ip: req.ip });
  const safe = String(t.name).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'server';
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="disk-audit-${safe}-${new Date(row.at).toISOString().slice(0, 10)}.txt"`);
  res.send(text);
});

/** 설치 파일(대상 서버에서 root 로: sh dvc-disk-audit-install.sh <수집 계정>). */
api.get('/tools/focus-mon/audit/install.sh', adminOnly, fullScopeOnly, (req, res) => {
  let text = '';
  try { text = installScript(); } catch (e) { return res.status(500).json({ ok: false, code: 'bundle', reason: `설치 파일을 만들지 못했습니다: ${String(e?.message || e).slice(0, 160)}` }); }
  logAudit({ user: req.user?.username, action: 'focus-mon.audit.install-download', target: 'dvc-disk-audit-install.sh', detail: `프로그램 ${programSha()?.slice(0, 12)} · 실행 파일 ${wrapperSha().slice(0, 12)}`, ip: req.ip });
  res.setHeader('Content-Type', 'text/x-shellscript; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="dvc-disk-audit-install.sh"');
  res.send(text);
});

/** 점검 · 준비 확인 시작 — 본문 {ids:[...], mode:'run'|'check'}. 대상마다 결과(시작 · 거절 까닭)를 돌려준다. */
api.post('/tools/focus-mon/audit/run', adminOnly, fullRwOnly, demoBlockWrite, (req, res) => {
  if (registryUnreadable(res)) return;
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const mode = b.mode === 'check' ? 'check' : 'run';
  const ids = (Array.isArray(b.ids) ? b.ids : []).map((x) => String(x)).filter((x) => /^fm-[a-z0-9-]{4,40}$/.test(x)).slice(0, 100);
  if (!ids.length) return res.status(400).json({ ok: false, code: 'no-ids', reason: '고른 서버가 없습니다.' });
  const vis = new Map(visibleTargets(req).map((t) => [t.id, t]));
  const results = []; const wake = new Set(); const started = [];
  for (const id of [...new Set(ids)]) {
    const t = vis.get(id);
    if (!t) { results.push({ id, ok: false, code: 'not-found', reason: '없는 대상입니다.' }); continue; }
    const r = A.requestAudit(t, { mode, by: req.user?.username || '', keys: focusKeys });
    results.push({ id, name: t.name, ...r });
    if (r.ok) { started.push(t.name); if (r.via === 'edge' && t.agent) wake.add(t.agent); }
  }
  for (const a of wake) wakeEdge(a).catch(() => {});
  if (started.length) logAudit({ user: req.user?.username, action: mode === 'check' ? 'focus-mon.audit.check' : 'focus-mon.audit.run', target: started.slice(0, 20).join(', '), detail: `${started.length}대${started.length > 20 ? ' (앞 20대만 적음)' : ''}`, ip: req.ip });
  res.json({ ok: true, mode, results, started: started.length });
});

}

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
import { requireRole, requirePerm } from '../../auth/auth.js';
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
import { installScript, programSha, wrapperSha, PROGRAM_PATH, WRAPPER_PATH, SUDOERS_PATH, pathsFor, DIR_ISSUE_TEXT, DIR_DENY, DIR_MAX, DIR_DEPTH_MIN, DIR_DEPTH_MAX, runCommandFor, sudoersLine } from '../../focusmon/audit/bundle.js';
import { installSettingsView, installSettingsError, installDir, saveInstallDir } from '../../focusmon/audit/settings.js'; // v3.17.0 설치 디렉터리
import { INSTALL_CODES, INSTALL_STEPS } from '../../focusmon/audit/install.js';
import { CRED_STATES } from '../../focusmon/audit/installCred.js';
import { requireSettingsOwner } from '../admin/shared.js';
import { reauth } from './reauth.js';
import { getDatacenterAssign } from '../../datacenter/store.js';
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
/**
 * v3.17.0 설치 · 설치 디렉터리 저장 문(컨펌 ④): 관리자 · 설정 소유자 등급(소유자 ∧ 조회 · 쓰기 전체 범위) · 데모 차단 · **본인 OTP(reauth — 마지막 게이트:
 * 권한이 없는 요청이 OTP 를 쓰지 않게)** · 감사. 대상 서버에 root 로 설치하는 일이라 SSH 공용 접속에서 키를 바꿀 때와 같은 문이다.
 */
const installGate = [adminOnly, requireSettingsOwner, fullRwOnly, demoBlockWrite, reauth];
function installSettingsUnreadable(res) {
  const e = installSettingsError();
  if (!e) return false;
  res.status(503).json({ ok: false, reason: 'installSettingsUnreadable', detail: '설치 디렉터리 설정(focusmon-audit-settings.json)을 읽지 못했습니다 — 손상 보존본을 확인하세요.' });
  return true;
}
/** 대상의 법인(DataCenter) → 그 법인의 vCenter 들(공통 계정 법인과 맞춘다 — v3.16.0 maintMatch 와 같은 풀이). */
function corpVcsOf(t, cr, assign) {
  const id = cr.of(t)?.id;
  if (!id) return [];
  return Object.entries(assign || {}).filter(([, dc]) => String(dc) === String(id)).map(([vc]) => vc);
}
/** 설치 탭 묶음 — 설정 · 경로 · 서버별 설치 계정 상태(비밀 없음) · 한도. */
function installView(targets, cr) {
  let assign = {}; try { assign = getDatacenterAssign(); } catch { assign = {}; }
  const st = installSettingsView();
  const P = st.dir === null ? null : pathsFor(st.dir);
  const cred = {};
  for (const t of targets) cred[t.id] = A.credOfTarget(t, { corpVcs: t.agent ? [] : corpVcsOf(t, cr, assign) });
  return {
    settings: st, defaultPaths: { program: PROGRAM_PATH, wrapper: WRAPPER_PATH }, sudoers: SUDOERS_PATH,
    paths: P ? { program: P.program, wrapper: P.wrapper, run: runCommandFor(P), sudoersLine: sudoersLine('<수집 계정>', P) } : null,
    rules: { max: DIR_MAX, depthMin: DIR_DEPTH_MIN, depthMax: DIR_DEPTH_MAX, deny: DIR_DENY, text: DIR_ISSUE_TEXT },
    codes: INSTALL_CODES, steps: INSTALL_STEPS, credStates: CRED_STATES, cred,
  };
}

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
      id: t.id, name: t.name, host: t.host, username: t.username || '', agent: t.demo ? (t.agent || '') : (t.agent || ''), group: t.group || '', demo: !!t.demo,
      corp: cr.of(t), smodel: ready?.dmi?.product || null, svendor: ready?.dmi?.vendor || null,
      ready: ready ? { state: ready.state || null, reason: ready.reason || '', at: ready.at || null, py: ready.py || null, node: ready.node ?? null, lastExecAt: ready.lastExecAt || null, dir: typeof ready.dir === 'string' ? ready.dir : null } : null,
      lastInstall: ready?.lastInstall || null,
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
    // v3.17.0: 손으로 설치하는 안내 · 설치 파일도 지금 설치 디렉터리 기준(설정을 못 읽으면 기본 경로 — 설치 파일 받기 · 자동 설치는 503 으로 막힌다)
    ...(() => { const P = pathsFor(installDir() ?? '') || pathsFor(''); return { version: { program: programSha()?.slice(0, 12) || null, wrapper: wrapperSha(P.dir).slice(0, 12) },
      paths: { program: P.program, wrapper: P.wrapper, sudoers: SUDOERS_PATH, run: runCommandFor(P), dir: P.dir } }; })(),
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
    install: installView(targets, cr),
  });
});

/** v3.17.0 설치 디렉터리 저장 — 본문 {dir: '' | 절대 경로, otp}. '' = 기본 경로. 이미 설치된 서버는 그대로 동작한다(‘옛 디렉터리’ 로 표시 · 다시 설치하면 옮긴다). */
api.put('/tools/focus-mon/audit/install-dir', ...installGate, (req, res) => {
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const r = saveInstallDir(typeof b.dir === 'string' ? b.dir : null, { by: req.user?.username || '' });
  if (!r.ok) return res.status(r.code === 'settings-unreadable' ? 503 : 400).json({ ok: false, code: r.code, reason: r.reason || DIR_ISSUE_TEXT[r.code] || '디렉터리가 규칙에 맞지 않습니다.' });
  logAudit({ user: req.user?.username, action: 'focus-mon.audit.install-dir', target: r.dir || '(기본 경로)', detail: `이전 ${r.prev || '(기본 경로)'}`, ip: req.ip });
  res.json({ ok: true, dir: r.dir });
});

/**
 * v3.17.0 자동 설치 — 본문 {ids:[...], accounts:{<서버 id>: <공통 계정 id>}, otp}. 서버마다 시작 · 거절 까닭을 돌려준다.
 * 대상은 등록부에서만(주소 · 계정을 본문으로 받지 않는다) · 범위 밖 · 없는 대상은 404 · 설치 계정은 그 서버를 맡은 노드가 고른다(키는 노드 밖으로 나가지 않는다).
 */
api.post('/tools/focus-mon/audit/install', ...installGate, (req, res) => {
  if (registryUnreadable(res)) return;
  if (installSettingsUnreadable(res)) return;
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const ids = (Array.isArray(b.ids) ? b.ids : []).map((x) => String(x)).filter((x) => /^fm-[a-z0-9-]{4,40}$/.test(x)).slice(0, 100);
  if (!ids.length) return res.status(400).json({ ok: false, code: 'no-ids', reason: '고른 서버가 없습니다.' });
  const picks = b.accounts && typeof b.accounts === 'object' && !Array.isArray(b.accounts) ? b.accounts : {};
  const vis = new Map(visibleTargets(req).map((t) => [t.id, t]));
  const cr = corpResolver();
  let assign = {}; try { assign = getDatacenterAssign(); } catch { assign = {}; }
  const results = []; const wake = new Set(); const started = [];
  for (const id of [...new Set(ids)]) {
    const t = vis.get(id);
    if (!t) { results.push({ id, ok: false, code: 'not-found', reason: '없는 대상입니다.' }); continue; }
    const pick = Object.hasOwn(picks, id) && typeof picks[id] === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(picks[id]) ? picks[id] : null;
    const r = A.requestInstall(t, { by: req.user?.username || '', pick, corpVcs: t.agent ? [] : corpVcsOf(t, cr, assign), keys: focusKeys });
    results.push({ id, name: t.name, ...r });
    if (r.ok) { started.push(t.name); if (r.via === 'edge' && t.agent) wake.add(t.agent); }
  }
  for (const a of wake) wakeEdge(a).catch(() => {});
  const dir = installDir();
  if (started.length) logAudit({ user: req.user?.username, action: 'focus-mon.audit.install', target: started.slice(0, 20).join(', '), detail: `${started.length}대${started.length > 20 ? ' (앞 20대만 적음)' : ''} · 디렉터리 ${dir || '(기본 경로)'}`, ip: req.ip });
  res.json({ ok: true, results, started: started.length, dir });
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
api.get('/tools/focus-mon/audit/run/:runId/report.txt', adminOnly, fullScopeOnly, requirePerm('data.csv'), async (req, res) => { // 파일 내보내기 — 데이터 내보내기 권한(superAdmin2643 스윕)
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
  if (installSettingsUnreadable(res)) return; // v3.17.0 — 설치 디렉터리를 모르면 기본 경로로 지어 내려보내지 않는다
  const dir = installDir();
  let text = '';
  try { text = installScript({ dir }); } catch (e) { return res.status(500).json({ ok: false, code: 'bundle', reason: `설치 파일을 만들지 못했습니다: ${String(e?.message || e).slice(0, 160)}` }); }
  logAudit({ user: req.user?.username, action: 'focus-mon.audit.install-download', target: 'dvc-disk-audit-install.sh', detail: `프로그램 ${programSha()?.slice(0, 12)} · 실행 파일 ${wrapperSha(dir).slice(0, 12)} · 디렉터리 ${dir || '(기본 경로)'}`, ip: req.ip });
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

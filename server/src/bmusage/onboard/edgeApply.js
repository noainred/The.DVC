/**
 * bmusage/onboard/edgeApply.js — 엣지가 중앙의 **배포 목록**을 자기 등록부에 적용한다(7b단계 · 엣지 쪽).
 *
 *  · 받은 행은 **문자열을 믿지 않는다**: 아는 칸만 · 길이 상한(edgeRowFromPlan) → 템플릿 칸으로 바꿔 **같은 분석(analyzeOnboardRows)** 을 엣지에서 다시 거친다
 *    (배포 경로 정규화 — v2.933 규약). 엣지 문맥: isEdge(central 행 거부) · 자기 법인(로컬 설정 corps)만 · 공통 계정 · 키 이름은 **이 엣지의 저장소**에서 찾는다.
 *  · 적용은 중앙과 같은 `applyOnboard`(한 번 쓰기 · 직전 스냅샷 · 정책 잠금이면 쓰지 않음).
 *  · 배포 목록에서 빠진 서버: **이 배포가 새로 만든 항목만** 지운다(엣지 관리자가 손으로 등록해 둔 항목은 건드리지 않는다).
 *    상태 파일 `bm-onboard-applied.json`(0600)에 서명 · 만든 항목 id · 결과 수를 둔다. 못 읽으면 지우지 않는다(만들기만).
 *  · 자동 재시도 · 자동 central 전환 없음. 결과(적용 · 거부 · 지운 수)는 다음 인출 때 중앙에 숫자로만 알린다.
 *  · v2.954(점검 D-3): 적용 서명(다음 인출의 applied)은 중앙의 ‘제거 대기’(반증 F14 — 같은 서버를 두 노드가 열지 않게)를 푼다. 그래서
 *    ① 빠진 행 제거가 **실패**한 판은 새 서명을 남기지 않는다(직전 서명 유지 · 실패 항목은 created 에 남겨 다음 인출에 다시 지운다).
 *    ② 상태 파일을 못 읽어 제거를 **건너뛴** 판부터는 ‘만든 항목’ 목록을 잃었다(lost) — 서명은 적용 판정(건너뛰기)에만 쓰고 중앙에는 빈 서명을 보고한다.
 *       중앙이 실어 보낸 제거 대기 이름(pending)이 이 엣지 등록부에 하나도 없을 때만 lost 를 푼다(구 중앙은 pending 이 없어 풀지 않는다 — 중앙 화면은 ‘대기’).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../../util/atomicWrite.js';
import { registerStateFile } from '../../util/stateFiles.js';
import { edgeRowFromPlan } from './importAnalyze.js';
import { analyzeOnboardRows } from './importAnalyze.js';
import { buildOnboardCtx, applyOnboard, defaultOnboardDeps } from './onboardRun.js';

export const APPLIED_FILE_NAME = 'bm-onboard-applied.json';
registerStateFile(APPLIED_FILE_NAME);
const FILE = path.join(config.configDir, 'bm-onboard-applied.json');   // = APPLIED_FILE_NAME
const lc = (v) => String(v ?? '').trim().toLowerCase();

export function readAppliedState() {
  try {
    if (!fs.existsSync(FILE)) return { ok: true, state: { sig: '', appliedSig: '', lost: false, created: {} } };
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const created = j && typeof j.created === 'object' && j.created && !Array.isArray(j.created) ? j.created : {};
    const appliedSig = String(j?.sig || '').slice(0, 64); const lost = j?.lost === true;
    // sig = 중앙에 보고할 서명(lost 면 빈 값 — D-3 ②) · appliedSig = 이 엣지가 실제로 적용한 판(같은 판 건너뛰기용)
    return { ok: true, state: { sig: lost ? '' : appliedSig, appliedSig, lost, created, at: Number(j?.at) || 0, result: j?.result || null } };
  } catch (e) { preserveCorrupt(FILE, e?.message); return { ok: false, state: { sig: '', appliedSig: '', lost: true, created: {} } }; }
}
function writeAppliedState(st) { atomicWriteFileSync(FILE, JSON.stringify(st, null, 2), { mode: 0o600 }); }
/** 같은 판에서 lost 만 바꿀 때 — 파일의 나머지 칸을 그대로 둔다. */
function readRawForRewrite() { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }

/** 배포 행 → 템플릿 칸(분석 입력). 알 수 없는 칸은 버린다(edgeRowFromPlan 이 이미 정규화). */
export function cellsOfEdgeRow(row) {
  const r = edgeRowFromPlan({ name: row?.name, vc: row?.corp, tag: row?.serviceTag, idracHost: row?.idracHost, idracCred: row?.idracCred, osHost: row?.osHost, osPort: row?.osPort,
    osCred: row?.osCred, osUser: row?.osUser, osKey: row?.osKey, mounts: row?.mounts, enabled: row?.enabled, note: row?.note, cls: row?.cls, apps: row?.apps, role: row?.role }, '');
  return {
    name: r.name, corp: r.corp || '미귀속', idrac_host: r.idracHost, idrac_cred: r.idracCred, service_tag: r.serviceTag, os_host: r.osHost, os_port: String(r.osPort),
    os_cred: r.osCred || (r.osUser ? `개별:${r.osUser}` : ''), os_key: r.osKey, collect_via: 'edge', mounts: r.mounts.join(';'), enabled: r.enabled ? 'true' : 'false',
    note: r.note, class: r.cls, purposes: r.apps.join(';'), role: r.role,
  };
}

/**
 * @param {object[]} rows  중앙이 보낸 배포 행
 * @param {object} o  { sig, D?, corps?(엣지 스냅샷 법인), myCorps?, now?, by? }
 * @returns {{ok:boolean, applied:number, rejected:number, removed:number, skipped?:boolean, reason?:string, rejects?:object[]}}
 */
/**
 * 3차 재확인 H1: 배포 행의 용도 · 역할 저장 키 — 중앙 라우트(bmOnboard.js)와 같은 규칙(purposeKey.tagTargetsOf + 판정기 commonTag.js).
 *   예전에는 엣지 적용 문맥에 tagTarget 이 없어 서비스 태그 전역 열쇠로 썼다(공통 태그 ‘To Be Filled By O.E.M.’ 도 — 같은 엣지의 다른 서버 판정이 바뀐다).
 *   아직 이 엣지 대상이 아닌 새 서버는 배포 행의 태그로 판정한다 — 판정기가 전역 열쇠로 써도 된다고 하고 이번 배포에 그 태그 행이 하나뿐일 때만 적용 ·
 *   대상을 못 읽으면 적용하지 않는다(purpose-unresolved — 전역 태그로 쓰지 않는 쪽).
 */
async function edgeTagTargetOf(list, currentTargets) {
  let map; let judge;
  try {
    const tg = await (currentTargets || (async () => (await import('../poller.js')).currentTargets()))();
    const CT = await import('../commonTag.js');
    const PK = await import('../purposeKey.js');
    judge = CT.tagJudgeOf(tg, []);
    map = PK.tagTargetsOf([...(tg?.targets || []), ...(tg?.skipped || [])], judge);
  } catch { return () => null; }
  const rowTags = new Map();
  for (const r of list) { const k = lc(r.serviceTag); if (k) rowTags.set(k, (rowTags.get(k) || 0) + 1); }
  return (tag) => {
    const k = lc(tag);
    const hit = map.get(k);
    if (hit) return (rowTags.get(k) || 0) > 1 ? { ...hit, common: true } : hit;
    if ((rowTags.get(k) || 0) === 1 && judge.tagKeyOk(tag)) return { vcenterId: '', common: false, purposeKey: String(tag), clearPair: '' };
    return { vcenterId: '', common: true, purposeKey: '', clearPair: '' };
  };
}

/** D-3 ②: 잃은 ‘만든 항목’ 중 중앙 제거 대기 이름이 아직 이 엣지 등록부에 남았는가. pending 이 배열이 아니면(구 중앙) 확인 불가 = 남은 것으로 본다. */
function lostRemains(Dx, pending, keepNames) {
  if (!Array.isArray(pending)) return { remains: true, names: [] };
  const want = new Set(pending.slice(0, 5000).map((x) => lc(typeof x === 'string' ? x : x?.name)).filter((n) => n && !keepNames.has(n)));
  if (!want.size) return { remains: false, names: [] };
  const have = new Set([...Dx.BM.listBmServersRaw(), ...Dx.IDR.loadRegistry()].map((x) => lc(x?.name)));
  const names = [...want].filter((n) => have.has(n));
  return { remains: names.length > 0, names: names.slice(0, 20) };
}
const lostReason = (names) => `적용 상태 파일(${APPLIED_FILE_NAME})을 잃어 이 배포가 만든 항목을 확인할 수 없습니다 — 중앙의 제거 대기${names.length ? `(${names.join(', ')})` : ''}가 해소될 때까지 적용 서명을 보고하지 않습니다`;

export async function applyEdgeDeployment(rows = [], { sig = '', D = null, corps = [], myCorps = [], now = Date.now(), currentTargets = null, pending = null } = {}) {
  const Dx = D || await defaultOnboardDeps();
  const prev = readAppliedState();
  if (prev.ok && prev.state.appliedSig === sig && sig) {
    if (!prev.state.lost) return { ok: true, skipped: true, applied: 0, rejected: 0, removed: 0 };
    // D-3 ②: 같은 판 — 다시 적용하지 않고 잃은 항목 확인만(풀리면 다음 인출부터 서명을 보고한다)
    const lr = lostRemains(Dx, pending, new Set((Array.isArray(rows) ? rows : []).map((r) => lc(r?.name))));
    if (!lr.remains) { try { writeAppliedState({ ...readRawForRewrite(), lost: false }); } catch { /* 다음 주기 */ } return { ok: true, skipped: true, applied: 0, rejected: 0, removed: 0 }; }
    return { ok: true, skipped: true, applied: 0, rejected: 0, removed: 0, lost: true, reason: lostReason(lr.names) };
  }
  const lostBefore = !prev.ok || prev.state.lost === true;
  // 반증 F9 · 감사 L-9: 이 엣지의 수집 법인(베어메탈 성능 설정 corps)이 비면 '모름' — 적용하지 않고 서명도 남기지 않는다(다음 인출에 다시).
  const mine = (Array.isArray(myCorps) ? myCorps : []).map((x) => String(x)).filter(Boolean);
  if (!mine.length) return { ok: false, applied: 0, rejected: 0, removed: 0, noCorps: true, reason: '이 엣지의 수집 법인이 비어 있어(설정 › 베어메탈 성능) 서버 등록 배포를 적용하지 않았습니다' };
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r === 'object' && !Array.isArray(r)).slice(0, 5000);
  // r3(R-N1): 행마다 중앙 승인(bindOk — 소유자 등급 + OTP 를 통과한 배포만 true)을 싣는다. 엣지 문맥은 이 값으로만 '소유자' 다 —
  //   승인 없는 행이 엣지 쪽 기존 항목의 공통 계정 · 키를 새 주소로 잇는(묶는) 것을 엣지 분석이 거부한다(bind-owner-only).
  const parsedRows = list.map((r, i) => ({ line: i + 1, cells: cellsOfEdgeRow(r), flags: { bindOk: r.bindOk === true } }));
  const created = prev.ok ? { ...prev.state.created } : {};
  const createdIds = new Set(Object.values(created).flatMap((x) => [x?.os, x?.idrac]).filter(Boolean).map(String));
  const tagTarget = await edgeTagTargetOf(list, currentTargets);   // H1 — 중앙 라우트와 같은 공통 태그 판정
  const { ctx, unread } = buildOnboardCtx({ D: Dx, corps, isEdge: true, myCorps: mine, canView: () => true, canWrite: () => true, fullScope: true, tagTarget,
    ownerTier: (row) => row?.flags?.bindOk === true,
    // 반증 F8 · 감사 M-3: 기존 항목은 **이 배포가 만든 것** 또는 이 엣지 법인 귀속인 것만 갱신한다(손으로 둔 귀속 없음 · 다른 법인 항목은 이름이 같아도 거부).
    canUpdateExisting: (ex) => createdIds.has(String(ex.id)) || (!!ex.vcenterId && mine.includes(String(ex.vcenterId))) });
  if (unread.length) return { ok: false, applied: 0, rejected: 0, removed: 0, reason: `등록부를 읽지 못해 적용하지 않았습니다(${unread.join(', ')})` };
  const a = analyzeOnboardRows(parsedRows, ctx);
  const rejects = a.rows.filter((r) => r.action === 'reject').map((r) => ({ name: r.name, code: r.code }));
  const osBefore = new Set(Dx.BM.listBmServersRaw().map((s) => String(s.id)));
  const idrBefore = new Set(Dx.IDR.loadRegistry().map((s) => String(s.id)));
  const res = applyOnboard(a.rows, { D: Dx, by: 'central-deploy', now, isEdge: true });
  // 반증 F7: 만든 항목은 **적용 전후 비교**로 남긴다 — 중간(iDRAC 단계) 실패여도 이미 만든 OS 항목이 '손으로 만든 것' 으로 바뀌지 않게.
  const rowNames = new Set(a.rows.filter((r) => r.plan).map((r) => lc(r.name)));
  for (const s0 of Dx.BM.listBmServersRaw()) if (!osBefore.has(String(s0.id)) && rowNames.has(lc(s0.name))) created[lc(s0.name)] = { ...(created[lc(s0.name)] || {}), os: s0.id };
  for (const s0 of Dx.IDR.loadRegistry()) if (!idrBefore.has(String(s0.id)) && rowNames.has(lc(s0.name))) created[lc(s0.name)] = { ...(created[lc(s0.name)] || {}), idrac: s0.id };
  if (!res.ok) {
    try { writeAppliedState({ sig: prev.ok ? prev.state.appliedSig : '', ...(lostBefore ? { lost: true } : {}), at: now, created, result: prev.state.result || null, rejects: rejects.slice(0, 200), lastError: String(res.reason || '').slice(0, 200) }); } catch { /* 다음 주기 */ }
    return { ok: false, applied: 0, rejected: rejects.length, removed: 0, reason: res.reason, rejects };
  }
  // 빠진 행 — 이 배포가 만든 것만 지운다(한 번씩 · 등록부마다 한 번 쓰기). 상태 파일을 못 읽었으면 지우지 않는다.
  let removed = 0; let removeFailed = false;
  const now2 = new Set(list.map((r) => lc(r.name)));
  if (prev.ok) {
    const gone = Object.keys(created).filter((k) => !now2.has(k));
    const osIds = gone.map((k) => created[k].os).filter(Boolean);
    const idrIds = gone.map((k) => created[k].idrac).filter(Boolean);
    let osOk = true; let idrOk = true;
    if (osIds.length) { const r = Dx.BM.applyBmServerBatch([], { removeIds: osIds, now }); osOk = !!r?.ok; if (osOk) removed += (r.removed || []).length; }
    if (idrIds.length) { const r = typeof Dx.IDR.removeServersBatch === 'function' ? Dx.IDR.removeServersBatch(idrIds) : { ok: false }; idrOk = !!r?.ok; if (idrOk) removed += (r.removed || []).length; }
    // v2.954(점검 D-3 ①): 실패한 등록부의 항목은 created 에 남긴다(다음 인출에 다시 지운다 — 예전에는 지우지 못해도 목록에서 뺐다)
    for (const k of gone) {
      const c = { ...created[k] };
      if (osOk) delete c.os;
      if (idrOk) delete c.idrac;
      if (c.os || c.idrac) created[k] = c; else delete created[k];
    }
    removeFailed = !osOk || !idrOk;
  }
  // D-3 ②: 만든 항목 목록을 잃은 판(이번 판 · 앞 판) — 중앙 제거 대기 이름이 이 엣지에 남아 있으면 서명 보고를 막는다
  let lost = lostBefore; let lr = { names: [] };
  if (lost) { lr = lostRemains(Dx, pending, now2); lost = lr.remains; }
  const result = { applied: (res.applied?.os || 0) + (res.applied?.idrac || 0), rejected: rejects.length, removed, at: now };
  // ① 제거가 실패한 판은 새 서명을 남기지 않는다(직전 판 유지 → 다음 인출에 다시 적용 · 제거 · 중앙 제거 대기도 그대로)
  const keepSig = removeFailed ? (prev.ok ? prev.state.appliedSig : '') : sig;
  try { writeAppliedState({ sig: keepSig, ...(lost ? { lost: true } : {}), at: now, created, result, rejects: rejects.slice(0, 200), ...(removeFailed ? { lastError: '빠진 행 제거 실패' } : {}) }); } catch (e) { return { ok: false, ...result, reason: `적용 상태를 쓰지 못했습니다(${String(e?.code || e?.message || e).slice(0, 60)})`, rejects }; }
  if (removeFailed) return { ok: false, ...result, reason: '배포에서 빠진 항목을 등록부에서 지우지 못했습니다 — 적용 서명을 보고하지 않고 다음 인출에 다시 지웁니다', rejects };
  return { ok: true, ...result, rejects, ...(lost ? { lost: true, reason: lostReason(lr.names) } : {}) };
}

/**
 * bmusage/onboard/edgeApply.js — 엣지가 중앙의 **배포 목록**을 자기 등록부에 적용한다(7b단계 · 엣지 쪽).
 *
 *  · 받은 행은 **문자열을 믿지 않는다**: 아는 칸만 · 길이 상한(edgeRowFromPlan) → 템플릿 칸으로 바꿔 **같은 분석(analyzeOnboardRows)** 을 엣지에서 다시 거친다
 *    (배포 경로 정규화 — v2.933 규약). 엣지 문맥: isEdge(central 행 거부) · 자기 법인(로컬 설정 corps)만 · 공통 계정 · 키 이름은 **이 엣지의 저장소**에서 찾는다.
 *  · 적용은 중앙과 같은 `applyOnboard`(한 번 쓰기 · 직전 스냅샷 · 정책 잠금이면 쓰지 않음).
 *  · 배포 목록에서 빠진 서버: **이 배포가 새로 만든 항목만** 지운다(엣지 관리자가 손으로 등록해 둔 항목은 건드리지 않는다).
 *    상태 파일 `bm-onboard-applied.json`(0600)에 서명 · 만든 항목 id · 결과 수를 둔다. 못 읽으면 지우지 않는다(만들기만).
 *  · 자동 재시도 · 자동 central 전환 없음. 결과(적용 · 거부 · 지운 수)는 다음 인출 때 중앙에 숫자로만 알린다.
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
const FILE = path.join(config.configDir, APPLIED_FILE_NAME);
const lc = (v) => String(v ?? '').trim().toLowerCase();

export function readAppliedState() {
  try {
    if (!fs.existsSync(FILE)) return { ok: true, state: { sig: '', created: {} } };
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const created = j && typeof j.created === 'object' && j.created && !Array.isArray(j.created) ? j.created : {};
    return { ok: true, state: { sig: String(j?.sig || '').slice(0, 64), created, at: Number(j?.at) || 0, result: j?.result || null } };
  } catch (e) { preserveCorrupt(FILE, e?.message); return { ok: false, state: { sig: '', created: {} } }; }
}
function writeAppliedState(st) { atomicWriteFileSync(FILE, JSON.stringify(st, null, 2), { mode: 0o600 }); }

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
export async function applyEdgeDeployment(rows = [], { sig = '', D = null, corps = [], myCorps = [], now = Date.now() } = {}) {
  const Dx = D || await defaultOnboardDeps();
  const prev = readAppliedState();
  if (prev.ok && prev.state.sig === sig && sig) return { ok: true, skipped: true, applied: 0, rejected: 0, removed: 0 };
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r === 'object' && !Array.isArray(r)).slice(0, 5000);
  const parsedRows = list.map((r, i) => ({ line: i + 1, cells: cellsOfEdgeRow(r), flags: {} }));
  const { ctx, unread } = buildOnboardCtx({ D: Dx, corps, isEdge: true, myCorps, canView: () => true, canWrite: () => true, fullScope: true });
  if (unread.length) return { ok: false, applied: 0, rejected: 0, removed: 0, reason: `등록부를 읽지 못해 적용하지 않았습니다(${unread.join(', ')})` };
  const a = analyzeOnboardRows(parsedRows, ctx);
  const rejects = a.rows.filter((r) => r.action === 'reject').map((r) => ({ name: r.name, code: r.code }));
  const res = applyOnboard(a.rows, { D: Dx, by: 'central-deploy', now, isEdge: true });
  if (!res.ok) return { ok: false, applied: 0, rejected: rejects.length, removed: 0, reason: res.reason, rejects };
  // 만든 항목 기록(다음 배포에서 빠지면 그것만 지운다)
  const created = prev.ok ? { ...prev.state.created } : {};
  const osByName = new Map(Dx.BM.listBmServersRaw().map((s) => [lc(s.name), s.id]));
  const idrByName = new Map(Dx.IDR.loadRegistry().map((s) => [lc(s.name), s.id]));
  for (const r of a.rows) {
    if (r.action !== 'new' || !r.plan) continue;
    const k = lc(r.name);
    created[k] = { ...(created[k] || {}), ...(r.plan.os && !r.plan.os.existing && osByName.get(k) ? { os: osByName.get(k) } : {}), ...(r.plan.idrac && !r.plan.idrac.existing && idrByName.get(k) ? { idrac: idrByName.get(k) } : {}) };
  }
  // 빠진 행 — 이 배포가 만든 것만 지운다. 상태 파일을 못 읽었으면 지우지 않는다.
  let removed = 0;
  if (prev.ok) {
    const now2 = new Set(list.map((r) => lc(r.name)));
    const gone = Object.keys(created).filter((k) => !now2.has(k));
    const osIds = gone.map((k) => created[k].os).filter(Boolean);
    if (osIds.length) { const r = Dx.BM.applyBmServerBatch([], { removeIds: osIds, now }); if (r.ok) removed += (r.removed || []).length; }
    for (const k of gone) {
      if (created[k].idrac) { const r = Dx.IDR.removeServer(created[k].idrac); if (r.ok) removed += 1; }
      delete created[k];
    }
  }
  const result = { applied: (res.applied?.os || 0) + (res.applied?.idrac || 0), rejected: rejects.length, removed, at: now };
  try { writeAppliedState({ sig, at: now, created, result, rejects: rejects.slice(0, 200) }); } catch (e) { return { ok: false, ...result, reason: `적용 상태를 쓰지 못했습니다(${String(e?.code || e?.message || e).slice(0, 60)})`, rejects }; }
  return { ok: true, ...result, rejects };
}

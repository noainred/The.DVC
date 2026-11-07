/**
 * bmusage/onboard/onboardRun.js — 서버 등록(온보딩) 분석 → 적용(7b단계 · 설계 PROFILES §18 '연결 시험 → 적용 → 엣지 배포').
 *
 *  · 분석 문맥(buildOnboardCtx)은 **지금 원천**(스냅샷 법인 · 두 등록부 · 키 · 공통 계정 · 엣지 매핑 · RTT)으로 만든다. 공통 계정은 **보이는 모양**(비밀 없음)만 넘긴다.
 *  · 적용(applyOnboard)은 클라이언트가 본 분석을 믿지 않는다 — 라우트가 같은 파일을 **다시 분석**하고 서명(analysisSig)이 같을 때만 부른다.
 *  · 직렬 큐(serialOnboard) — 동시에 두 적용이 같은 등록부를 읽기-수정-쓰기 하지 않게(한 번에 하나 · 순서대로).
 *  · 쓰기 전에 **직전 등록부 스냅샷 1벌**(CONFIG_DIR/onboard-prev/ — 0700 폴더 · 0600 파일 · 원본 바이트 그대로 = 봉인 그대로)을 남긴다.
 *  · 파일마다 원자적 한 번 쓰기(OS 등록부 · iDRAC 등록부 · 분류 태그 · 엣지 배포 목록). 등록부를 못 읽었거나 자격증명 정책이 잠겼으면 **아무것도 쓰지 않는다**.
 *    파일 사이 원자성은 없다 — 중간 실패면 무엇을 썼는지(`applied`)와 스냅샷 위치를 돌려준다(조용히 반쪽을 숨기지 않는다).
 *  · iDRAC 공통 계정은 적용 때 그 항목에 **계정 · 비밀번호를 복사**한다(iDRAC 등록부는 참조 칸이 없다 — 공통 계정 비밀번호를 바꾸면 다시 적용해야 한다: 정직 기록).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../../config.js';
import { analyzeOnboardRows, analysisSig, edgeRowFromPlan } from './importAnalyze.js';
import { parseOnboardFile } from './importParse.js';


let _chain = Promise.resolve();
/** 한 번에 하나 · 들어온 순서대로. 앞 작업이 실패해도 뒤 작업은 돈다. */
export function serialOnboard(fn) {
  const p = _chain.then(fn, fn);
  _chain = p.then(() => {}, () => {});
  return p;
}

/** 기본 의존(실제 모듈). 테스트는 일부를 바꿔 끼운다. */
export async function defaultOnboardDeps() {
  const [BM, IDR, KS, MNT, PROF, CAT, FT, ED, VAULT] = await Promise.all([
    import('../../bmstor/registry.js'), import('../../idrac/registry.js'), import('./keyStore.js'), import('../../bmstor/collect.js'),
    import('../profiles/index.js'), import('../tuning/catalog.js'), import('../../insights/fleetTags.js'), import('./edgeDeploy.js'),
    import('../../security/secretVault.js'),
  ]);
  return { BM, IDR, KS, MNT, PROF, CAT, FT, ED, VAULT };
}

/**
 * 분석 문맥.
 * @param {object} p
 * @param {object} p.D  defaultOnboardDeps()
 * @param {{id:string,name:string,dc?:string}[]} p.corps
 * @param {(vc:string)=>boolean} p.canView @param {(vc:string)=>boolean} p.canWrite @param {boolean} p.fullScope
 * @param {boolean} p.isEdge @param {string[]} [p.myCorps]
 * @param {(vc:string)=>({agent,online}|null)} [p.edgeOf] @param {(vc:string)=>object|null} [p.rttOf]
 */
export function buildOnboardCtx({ D, corps = [], canView, canWrite, fullScope = false, isEdge = false, myCorps = [], edgeOf = null, rttOf = null }) {
  const unread = [];
  if (D.BM.registryLoadError()) unread.push('bm-storage.json');
  if (D.IDR.registryLoadError()) unread.push('idrac.json');
  if (D.KS.keyStoreLoadError()) unread.push('ssh-keys.json');
  if (!isEdge && D.ED.edgeDeployLoadError()) unread.push('bm-onboard-edge.json');
  const pubAcc = (a) => (a ? { id: a.id, name: a.name, kind: a.kind, corp: a.corp, username: a.username, keyRef: a.keyRef, hasPassword: !!a.password } : null);
  const ctx = {
    corps, canView, canWrite, fullScope, isEdge, myCorps, edgeOf, rttOf,
    idracRegistry: D.IDR.loadRegistry().map(({ password, ...rest }) => { void password; return rest; }),   // 비밀 없이
    osRegistry: D.BM.listBmServers(),
    edgeRows: isEdge ? [] : D.ED.allEdgeRows(),
    accountByName: (kind, name) => pubAcc(D.KS.accountByName(kind, name)),
    keyByName: (name) => { const k = D.KS.keyByName(name); return k ? { id: k.id, name: k.name, status: k.status } : null; },
    osIssue: D.BM.bmServerInputIssue,
    idracIssue: D.IDR.idracInputIssue,
    sanitizeMounts: D.MNT.sanitizeMounts,
    knownApps: [...D.PROF.APP_IDS], knownRoles: [...D.CAT.ROLES],
  };
  return { ctx, unread };
}

/** 파일 → 파싱 → 분석. 결과에 비밀 없음. */
export async function analyzeUpload(buf, { fileName = '', ctx }) {
  const parsed = await parseOnboardFile(buf, { fileName });
  if (!parsed.ok) return { ok: false, code: parsed.code, reason: parsed.reason };
  const a = analyzeOnboardRows(parsed.rows, ctx);
  const fileSha = crypto.createHash('sha256').update(buf).digest('hex');
  return {
    ok: true, format: parsed.format, encoding: parsed.encoding, columns: parsed.columns, fileWarnings: parsed.fileWarnings,
    rows: a.rows, summary: a.summary, sig: analysisSig(a.rows), fileSha,
  };
}

/** 결과 CSV(판정 열 · 수식 주입 차단은 csvLine 의 guardCell). 비밀 칸 값은 처음부터 싣지 않는다(분석 결과에 없다). */
export async function resultCsv(rows = []) {
  const { csvLine, CSV_BOM } = await import('../../util/csv.js');
  const ACTION = { new: '신규', update: '갱신', unchanged: '변화 없음', reject: '거부' };
  const lines = [csvLine(['행', 'name', 'corp', '수집 경로', '엣지', '판정', '사유', '경고', '바뀌는 칸', '공통 계정', 'SSH 키'])];
  for (const r of rows) {
    lines.push(csvLine([r.line, r.name, r.corpName || r.corp, r.via, r.agent, ACTION[r.action] || r.action, r.reason,
      (r.warnings || []).map((w) => w.text).join(' / '), (r.changes || []).join(' '), r.cred, r.key]));
  }
  return `${CSV_BOM}${lines.join('\r\n')}\r\n`;
}

/** 직전 등록부 스냅샷 1벌(원본 바이트 — 봉인 그대로). 덮어쓴다. */
export function snapshotRegistries({ files = ['bm-storage.json', 'idrac.json', 'fleet-tags.json', 'bm-onboard-edge.json'], by = '', now = Date.now(), fileSha = '' } = {}) {
  const dir = path.join(config.configDir, 'onboard-prev');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* 윈도 */ }
  const saved = [];
  for (const f of files) {
    const src = path.join(config.configDir, f);
    const dst = path.join(dir, f);
    if (fs.existsSync(src)) { fs.copyFileSync(src, dst); try { fs.chmodSync(dst, 0o600); } catch { /* */ } saved.push(f); }
    else if (fs.existsSync(dst)) fs.rmSync(dst);   // 그때 없던 파일은 스냅샷에도 없다(되돌리면 없는 것이 맞다)
  }
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ at: now, by: String(by).slice(0, 64), files: saved, fileSha: String(fileSha).slice(0, 64) }, null, 2), { mode: 0o600 });
  return { dir: 'onboard-prev', files: saved, at: now };
}

/**
 * 적용 — 분석 행(new · update)만. 반환 { ok, applied:{os,idrac,tags,edge,removed}, snapshot, partial? }.
 * @param {object[]} rows  analyzeUpload(...).rows — 라우트가 서명 대조 뒤 넘긴다
 */
export function applyOnboard(rows = [], { D, by = '', now = Date.now(), isEdge = false, fileSha = '' } = {}) {
  const go = rows.filter((r) => (r.action === 'new' || r.action === 'update') && r.plan);
  if (!go.length) return { ok: true, applied: { os: 0, idrac: 0, tags: 0, edge: 0, removed: 0 }, nothing: true };
  // 정책 잠금 · 등록부 못 읽음 → 쓰지 않는다
  const pol = D.VAULT.loadSecretsPolicy();
  if (pol && (pol.locked || (pol.mode !== 'plain' && pol.mode !== 'encrypted'))) return { ok: false, code: 'SECRETS_POLICY_UNAVAILABLE', status: 503, reason: '자격증명 저장 방식(secrets-policy.json)을 읽지 못해 적용하지 않았습니다 — 평문으로 저장하지 않기 위해서입니다.' };
  const unread = [];
  if (D.BM.registryLoadError()) unread.push('bm-storage.json');
  if (D.IDR.registryLoadError()) unread.push('idrac.json');
  if (!isEdge && D.ED.edgeDeployLoadError()) unread.push('bm-onboard-edge.json');
  if (unread.length) return { ok: false, code: 'registry-unreadable', status: 503, reason: `등록부를 읽지 못해 적용하지 않았습니다(${unread.join(', ')}).` };

  const osRaw = new Map(D.BM.listBmServersRaw().map((s) => [s.id, s]));
  const osInputs = []; const osRemove = [];
  const idrIncoming = []; const idrRemove = [];
  const tagItems = []; const edgeUpserts = [];
  for (const r of go) {
    const p = r.plan;
    if (p.where === 'edge') {
      edgeUpserts.push({ agent: p.agent, row: edgeRowFromPlan({ name: p.name, vc: p.vc, tag: p.tag, idracHost: p.idrac?.host, osHost: p.os?.host, osPort: p.os?.port,
        mounts: p.os?.mounts || [], enabled: p.enabled !== false, note: p.note, cls: p.cls, apps: p.apps, role: p.role, ...p.edgeNames }, p.agent) });
      if (p.moveToEdge) { if (p.os?.id) osRemove.push(p.os.id); if (p.idrac?.existing && p.idrac.id) idrRemove.push(p.idrac.id); }
      continue;
    }
    if (p.os) {
      const ex = p.os.id ? osRaw.get(p.os.id) : null;
      osInputs.push({
        ...(ex ? { id: ex.id } : {}), name: p.name, host: p.os.host, port: p.os.port, username: p.os.username || ex?.username || 'root', mounts: p.os.mounts,
        agent: ex ? ex.agent || '' : '', dispatch: ex ? ex.dispatch : undefined,
        enabled: p.enabled === null ? (ex ? ex.enabled !== false : true) : p.enabled,
        ...(p.os.keepCred ? {} : { keyRef: p.os.keyRef || '', credRef: p.os.credRef || '', osAuth: p.os.osAuth || '' }),
        vcenterId: p.vc, collectVia: isEdge ? 'edge' : p.via, ...(p.note ? { note: p.note } : {}), onboardAt: now,
      });
    }
    if (p.idrac) {
      const acc = p.idrac.accountId ? D.KS.accountById(p.idrac.accountId) : null;   // 원본(비밀 포함) — 등록부에 봉인 저장
      idrIncoming.push({
        id: p.idrac.id, name: p.name, host: p.idrac.host, serviceTag: p.tag, vcenterId: p.vc,
        ...(acc ? { username: acc.username, password: acc.password } : {}),
        ...(p.enabled === null ? {} : { enabled: p.enabled }),
      });
    }
    if (p.tag && (p.cls || p.apps.length || p.role)) tagItems.push({ key: p.tag, ...(p.cls ? { tag: p.cls } : {}), ...((p.apps.length || p.role) ? { purpose: { apps: p.apps, role: p.role } } : {}) });
  }
  const snapshot = snapshotRegistries({ by, now, fileSha });
  const applied = { os: 0, idrac: 0, tags: 0, edge: 0, removed: 0 };
  const fail = (step, reason, code = 'write-failed') => ({ ok: false, code, status: 500, partial: true, step, reason, applied, snapshot });
  try {
    if (osInputs.length || osRemove.length) {
      const r = D.BM.applyBmServerBatch(osInputs, { now, removeIds: osRemove });
      if (!r.ok) return fail('os', r.reason, r.code || 'os-failed');
      applied.os = r.results.length; applied.removed += (r.removed || []).length;
    }
    if (idrIncoming.length) {
      const r = D.IDR.importServers(idrIncoming, 'merge');
      if (!r.ok) return fail('idrac', r.reason);
      applied.idrac = r.added + r.updated;
      if (r.skipped?.length) applied.idracSkipped = r.skipped.length;
    }
    for (const id of idrRemove) { const r = D.IDR.removeServer(id); if (r.ok) applied.removed += 1; }
    if (tagItems.length) {
      const r = D.FT.setFleetTagsBatch(tagItems, { by, knownApps: [...D.PROF.APP_IDS], knownRoles: [...D.CAT.ROLES] });
      if (!r.ok) return fail('tags', r.reason);
      applied.tags = tagItems.length;
    }
    if (edgeUpserts.length) {
      const r = D.ED.applyEdgeChanges({ upserts: edgeUpserts }, { by, now });
      if (!r.ok) return fail('edge', r.reason);
      applied.edge = edgeUpserts.length;
    }
  } catch (e) {
    if (e?.code === 'SECRETS_POLICY_UNAVAILABLE') return fail('seal', e.message, 'SECRETS_POLICY_UNAVAILABLE');
    return fail('write', String(e?.message || e).slice(0, 200));
  }
  return { ok: true, applied, snapshot };
}


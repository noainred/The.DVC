/**
 * routes/admin/bmAssets.js — 물리서버 점검의 관리 라우트(v3.45 · 설계 docs/design/bm-feature-proposals ① ②).
 *   자산 원장(보증 · 계약) CSV 올리기 · 내려받기 · 샘플, 펌웨어 기준(관리자 지정) 지정 · 해제.
 * 게이트: **관리자 + 전체 범위**(원장 · 지정 기준은 전 법인에 걸친 값이다 — 범위 지정 관리자가 다른 법인 서버의 보증 · 기준을 바꾸지 못하게).
 *   원장 올리기 · 내려받기 · 샘플은 CSV 권한(data.csv)도 본다(이 포탈의 CSV 가져오기 · 내보내기 라우트 공통 규칙 — superAdmin2643 이 실제 라우터 스택으로 고정). 쓰기는 감사 로그를 남긴다(무엇을 · 몇 줄 — 계약 번호 원문은 싣지 않는다).
 * 판정 코어는 bmcheck/assetCsv.js(드라이런과 커밋이 같은 함수) · 저장은 bmcheck/store.js(손상이면 쓰기 거절 409).
 */
import { requirePerm } from '../../auth/auth.js';
import { logAudit } from '../../audit.js';
import { textFields } from '../../util/coercionTrap.js';
import { fileStamp } from '../../util/dayKey.js';
import { adminOnly, fullReadWriteScopeOnlyWith } from './shared.js';
import { parseAssetCsv, analyzeAssetImport, assetsToCsv, sampleAssetCsv, ASSET_COLUMNS, ASSET_ROWS_MAX } from '../../bmcheck/assetCsv.js';
import { assetStore, fwBaselineStore, setAdminBaseline, advisoryStore } from '../../bmcheck/store.js';
import { parseAdvisoryCsv, advisoriesToCsv, sampleAdvisoryCsv, ADVISORY_COLUMNS } from '../../bmcheck/advisory.js';   // v3.50 펌웨어 보안 권고 표(④)
import { FW_TYPES, FW_LABEL_MAX, FW_VER_MAX } from '../../bmcheck/fw.js';

const csvPerm = requirePerm('data.csv');
// 조회 ∧ 쓰기 무제한(물리서버 폴더의 fleetAdmin 과 같은 뜻) — 조회 범위만 보면 writeVcenters 관리자가 통과한다(server/CLAUDE.md v2.733 · v2.904)
const fleetOnly = fullReadWriteScopeOnlyWith('이 기능은 전 법인에 걸친 값(자산 원장 · 펌웨어 기준 · 보안 권고 표)을 바꾸므로 전체 범위(vCenter 제한 없는) 관리자만 쓸 수 있습니다.');
/** 시험용 — 이 라우트들의 게이트(순서대로). */
export const BM_ASSET_GATES = Object.freeze([adminOnly, fleetOnly]);
const REPORT_MAX = 500;

export function registerBmAssets(adminRouter, { D = {} } = {}) {
  const A = D.assetStore || assetStore; const B = D.fwBaselineStore || fwBaselineStore; const V = D.advisoryStore || advisoryStore;

  // ── v3.50 펌웨어 보안 권고 표(④) — 사람이 확인한 권고를 CSV 로 통째로 올린다(포탈은 인터넷에서 가져오지 않는다 · 권고 번호를 지어내지 않는다).
  //   게이트는 자산 원장과 같다(관리자 + 조회 ∧ 쓰기 전체 범위 + CSV 권한). 올리기는 **표를 파일로 바꾼다** — 오류 줄이 하나라도 있으면 아무것도 쓰지 않는다 ·
  //   검증(dryRun)과 적용이 같은 판정(parseAdvisoryCsv) · 미리본 표와 지금 표가 다르면 409.
  adminRouter.get('/bm-advisories', adminOnly, fleetOnly, (_req, res) => {
    if (V.loadError()) return res.status(503).json({ ok: false, error: 'registryUnreadable', reason: '물리서버 보안 권고 표(bm-advisories.json)를 읽지 못했습니다 — 빈 표로 보지 않고 쓰기를 막았습니다(서비스 점검에서 확인).' });
    const d = V.get();
    res.json({ ok: true, n: d.rows.length, at: d.at, by: d.by, columns: ADVISORY_COLUMNS, rows: d.rows.slice(0, 500) });
  });
  adminRouter.get('/bm-advisories.csv', csvPerm, adminOnly, fleetOnly, (req, res) => {
    if (V.loadError()) return res.status(503).json({ ok: false, error: 'registryUnreadable', reason: '물리서버 보안 권고 표를 읽지 못했습니다.' });
    const d = V.get();
    logAudit({ user: req.user?.username, action: '물리서버 보안 권고 표 내려받기', target: `${d.rows.length}줄`, ip: req.ip });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="bm-advisories-${fileStamp()}.csv"`);
    res.send(advisoriesToCsv(d.rows));
  });
  adminRouter.get('/bm-advisories/sample.csv', csvPerm, adminOnly, fleetOnly, (_req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="bm-advisories-sample.csv"');
    res.send(sampleAdvisoryCsv());
  });
  adminRouter.post('/bm-advisories/import', csvPerm, adminOnly, fleetOnly, textFields('csv'), (req, res) => {
    const refused = V.refusal();
    if (refused) return res.status(409).json({ ok: false, ...refused });
    const dry = req.body?.dryRun;
    if (dry !== undefined && typeof dry !== 'boolean') return res.status(400).json({ ok: false, reason: '‘dryRun’ 은 true 또는 false 여야 합니다.', field: 'dryRun' });
    const { rows, errors } = parseAdvisoryCsv(String(req.body?.csv || ''));
    const cur = V.get();
    const base = { n: cur.rows.length, at: cur.at ?? null };
    const view = { total: rows.length + errors.length, ok: true, rows: rows.length, errors: errors.slice(0, 200), base };
    if (dry === true) return res.json({ ...view, dryRun: true });
    if (errors.length) return res.status(400).json({ ...view, ok: false, reason: `오류 행이 ${errors.length}개 있어 표를 바꾸지 않았습니다 — 고친 뒤 다시 검증하십시오.` });
    const ex = req.body?.expect;
    if (!ex || typeof ex !== 'object') return res.status(400).json({ ok: false, reason: '권고 표는 먼저 검증한 뒤에 적용할 수 있습니다.' });
    if (ex.n !== base.n || (ex.at ?? null) !== base.at) return res.status(409).json({ ...view, ok: false, error: 'changed', reason: '검증한 뒤에 권고 표가 바뀌었습니다 — 다시 검증하십시오.' });
    const saved = V.save({ v: 1, at: Date.now(), by: String(req.user?.username || '').slice(0, 80), rows });
    if (!saved.ok) return res.status(saved.status || 500).json({ ok: false, reason: saved.reason || '저장하지 못했습니다.' });
    logAudit({ user: req.user?.username, action: '물리서버 보안 권고 표 올리기(파일로 바꾸기)', target: `${rows.length}줄`, detail: `이전 ${base.n}줄`, ip: req.ip });
    res.json({ ...view, changed: true });
  });

  adminRouter.get('/bm-assets', adminOnly, fleetOnly, (_req, res) => {
    const err = A.loadError();
    if (err) return res.status(503).json({ ok: false, error: 'registryUnreadable', reason: '물리서버 자산 원장(bm-assets.json)을 읽지 못했습니다 — 빈 원장으로 보지 않고 쓰기를 막았습니다(서비스 점검에서 확인).' });
    const d = A.get();
    res.json({ ok: true, n: Object.keys(d.rows).length, at: d.at, by: d.by, columns: ASSET_COLUMNS, rowsMax: ASSET_ROWS_MAX });
  });

  adminRouter.get('/bm-assets.csv', csvPerm, adminOnly, fleetOnly, (req, res) => {
    if (A.loadError()) return res.status(503).json({ ok: false, error: 'registryUnreadable', reason: '물리서버 자산 원장을 읽지 못했습니다.' });
    const d = A.get();
    logAudit({ user: req.user?.username, action: '물리서버 자산 원장 내려받기', target: `${Object.keys(d.rows).length}줄`, ip: req.ip });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="bm-assets-${fileStamp()}.csv"`);
    res.send(assetsToCsv(d.rows));
  });

  adminRouter.get('/bm-assets/sample.csv', csvPerm, adminOnly, fleetOnly, (_req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="bm-assets-sample.csv"');
    res.send(sampleAssetCsv());
  });

  // 올리기 — body { csv, dryRun?, replace? }. 드라이런이 먼저(무엇이 더해지고 · 바뀌고 · 지워지는지), 커밋은 같은 판정으로.
  //   replace = 파일에 없는 줄을 원장에서 지운다 — 오류 줄이 하나라도 있으면 아무것도 쓰지 않는다(오류 줄의 서버가 원장에서 사라지지 않게).
  adminRouter.post('/bm-assets/import', csvPerm, adminOnly, fleetOnly, textFields('csv'), (req, res) => {
    const refused = A.refusal();
    if (refused) return res.status(409).json({ ok: false, ...refused });
    // dryRun · replace 는 참 · 거짓만 — 'true' · 1 같은 값을 거짓으로 읽으면 미리보기를 청한 요청이 적용된다(반증 A15)
    for (const k of ['dryRun', 'replace']) { const v = req.body?.[k]; if (v !== undefined && typeof v !== 'boolean') return res.status(400).json({ ok: false, reason: `‘${k}’ 는 true 또는 false 여야 합니다.`, field: k }); }
    const { rows, present, error } = parseAssetCsv(String(req.body?.csv || ''));
    if (error) return res.status(400).json({ ok: false, reason: error });
    if (!rows.length) return res.status(400).json({ ok: false, reason: '가져올 데이터 줄이 없습니다.' });
    const replace = req.body?.replace === true;
    const cur = A.get();
    const base = { n: Object.keys(cur.rows).length, at: cur.at ?? null };
    const { report, summary, next } = analyzeAssetImport(rows, cur.rows, { replace, present });
    const view = { total: rows.length, summary, base, present, report: report.filter((r) => r.action === 'error').concat(report.filter((r) => r.action !== 'error')).slice(0, REPORT_MAX), ...(report.length > REPORT_MAX ? { reportOmitted: report.length - REPORT_MAX } : {}) };
    if (req.body?.dryRun === true) return res.json({ ok: true, dryRun: true, replace, ...view });
    // 미리본 원장과 지금 원장이 같은지(expect = 미리보기의 base) — 그 사이 다른 관리자가 바꿨으면 지워지는 줄 수가 미리보기와 달라진다(반증 A17).
    //   ‘파일로 바꾸기’ 는 미리보기 없이 적용할 수 없다. 합치기는 expect 를 주면 대조한다.
    const ex = req.body?.expect;
    if (replace && (!ex || typeof ex !== 'object')) return res.status(400).json({ ok: false, reason: '‘원장을 파일로 바꾸기’ 는 먼저 검증한 뒤에 적용할 수 있습니다.' });
    if (ex && typeof ex === 'object' && (ex.n !== base.n || (ex.at ?? null) !== base.at)) {
      return res.status(409).json({ ok: false, error: 'changed', reason: '검증한 뒤에 원장이 바뀌었습니다 — 다시 검증하십시오(지워지거나 바뀌는 줄이 미리보기와 다를 수 있습니다).', ...view });
    }
    if (!next) return res.status(400).json({ ok: false, reason: `오류 줄이 ${summary.error}개 있어 ‘원장을 파일로 바꾸기’ 를 하지 않았습니다 — 오류 줄의 서버가 원장에서 사라지지 않게 전부 멈췄습니다. 오류를 고친 뒤 다시 올리십시오.`, ...view });
    if (!summary.add && !summary.update && !summary.remove) return res.json({ ok: true, changed: false, replace, ...view });
    const saved = A.save({ v: 1, at: Date.now(), by: String(req.user?.username || '').slice(0, 80), rows: next });
    if (!saved.ok) return res.status(saved.status || 500).json({ ok: false, reason: saved.reason || '저장하지 못했습니다.' });
    logAudit({ user: req.user?.username, action: `물리서버 자산 원장 올리기${replace ? '(파일로 바꾸기)' : ''}`, target: `${rows.length}줄`, detail: `더함 ${summary.add} · 바꿈 ${summary.update} · 같음 ${summary.same} · 오류 ${summary.error}${replace ? ` · 지움 ${summary.remove}` : ''}`, ip: req.ip });
    res.json({ ok: true, changed: true, replace, ...view });
  });

  adminRouter.get('/bm-fw-baseline', adminOnly, fleetOnly, (_req, res) => {
    if (B.loadError()) return res.status(503).json({ ok: false, error: 'registryUnreadable', reason: '물리서버 펌웨어 기준(bm-fw-baseline.json)을 읽지 못했습니다.' });
    const d = B.get();
    const rows = [];
    for (const m of Object.values(d.models)) for (const [key, c] of Object.entries(m.comps)) rows.push({ model: m.model, key, label: c.label, type: c.type, version: c.version, by: c.by, at: c.at });
    rows.sort((a, b) => String(a.model).localeCompare(String(b.model)) || String(a.label).localeCompare(String(b.label)));
    res.json({ ok: true, rows });
  });

  // 기준 지정 · 해제 — body { model, key, label, type, version }(version '' = 해제 → 다시 같은 법인 · 같은 모델의 다수 버전으로 대조).
  adminRouter.post('/bm-fw-baseline', adminOnly, fleetOnly, textFields('model', 'key', 'label', 'type', 'version'), (req, res) => {
    const model = String(req.body?.model || '').trim().slice(0, 256);
    const key = String(req.body?.key || '').slice(0, 160);
    const type = String(req.body?.type || '');
    const label = String(req.body?.label || '').slice(0, FW_LABEL_MAX);
    const version = String(req.body?.version || '').trim();
    if (!model || !key) return res.status(400).json({ ok: false, reason: '모델과 구성요소가 필요합니다.' });
    if (!FW_TYPES.includes(type) || !key.startsWith(`${type}|`)) return res.status(400).json({ ok: false, reason: '대조하는 구성요소가 아닙니다.' });
    if (version.length > FW_VER_MAX) return res.status(400).json({ ok: false, reason: `버전 글자가 너무 깁니다(최대 ${FW_VER_MAX}자).` });
    for (let i = 0; i < version.length; i += 1) { const c = version.charCodeAt(i); if (c < 33 || c === 127) return res.status(400).json({ ok: false, reason: '버전에 공백 · 제어 문자를 쓸 수 없습니다.' }); }
    const refused = B.refusal();
    if (refused) return res.status(409).json({ ok: false, ...refused });
    const r = (D.setAdminBaseline || setAdminBaseline)({ model, key, label, type, version, by: String(req.user?.username || '') });
    if (!r.ok) return res.status(r.status || 500).json({ ok: false, reason: r.reason || '저장하지 못했습니다.' });
    if (r.changed) logAudit({ user: req.user?.username, action: version ? '물리서버 펌웨어 기준 지정' : '물리서버 펌웨어 기준 해제', target: `${model} · ${label || key}`.slice(0, 200), detail: version ? `버전 ${version}` : '다수 버전 대조로 되돌림', ip: req.ip });
    res.json({ ok: true, changed: !!r.changed });
  });
}

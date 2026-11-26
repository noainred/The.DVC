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
import { parseAdvisoryCsv, advisoriesToCsv, sampleAdvisoryCsv, ADVISORY_COLUMNS, modelTokensMatch } from '../../bmcheck/advisory.js';   // v3.50 펌웨어 보안 권고 표(④)
import { FW_TYPES, FW_LABEL_MAX, FW_VER_MAX } from '../../bmcheck/fw.js';
import { remotePower } from '../../idrac/remotePowerSettings.js';   // v3.52 원격 전원 · LED 켜기 스위치(⑦ ⑥)
import { ownOtpGate } from '../api/reauth.js';
import { config } from '../../config.js';   // v3.52 OTP 필요 여부(인증 켜짐) — 화면이 OTP 칸을 보일지 정한다

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
  // v3.52 원격 전원 조작 · 위치 LED 켜기 스위치 — 읽기 = 관리자 · 전체 범위, 바꾸기 = + 본인 OTP · 감사. 기본 꺼짐 · 강제 동작은 따로.
  adminRouter.get('/bm-power', adminOnly, fleetOnly, (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, settings: remotePower.get(), otpRequired: !!config.auth.enabled, ...(remotePower.loadError() ? { unreadable: true } : {}) });
  });
  // 본문 검증 · 파일 거절을 OTP 보다 먼저(거절될 요청이 OTP 를 소모하지 않게 · otp 가 글자가 아니면 400 — 디버깅 1회차 보안 #2)
  const powerBodyOk = (req, res, next) => {
    const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    if (typeof b.enabled !== 'boolean' || (b.allowForce !== undefined && typeof b.allowForce !== 'boolean')) return res.status(400).json({ ok: false, reason: 'enabled · allowForce 는 참/거짓이어야 합니다.' });
    const refused = remotePower.refusal();
    if (refused) return res.status(409).json({ ok: false, ...refused });
    return next();
  };
  adminRouter.put('/bm-power', adminOnly, fleetOnly, textFields('otp'), powerBodyOk, ownOtpGate('물리서버 원격 전원 조작 켜기 · 끄기'), (req, res) => {
    const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const before = remotePower.get();
    const r = remotePower.save({ enabled: b.enabled, allowForce: b.allowForce }, { by: req.user?.username || '' });
    if (!r.ok) return res.status(r.status || 400).json({ ok: false, reason: r.reason });
    logAudit({ user: req.user?.username, action: '물리서버 원격 전원 · LED 설정 저장', detail: `켜기 ${before.enabled ? '켜짐' : '꺼짐'}→${r.value.enabled ? '켜짐' : '꺼짐'} · 강제 동작 ${before.allowForce ? '허용' : '막음'}→${r.value.allowForce ? '허용' : '막음'}`, ip: req.ip });
    res.json({ ok: true, settings: r.value });
  });

  // v3.52 물리서버 장애 바로 받기(Redfish 이벤트 구독 · ⑬) — 이 노드 등록부의 iDRAC 에 구독을 건다. 읽기 · 설정 = 관리자 · 전체 범위 · 감사,
  //   구독 걸기 · 지우기(장비 설정을 바꾼다) = + 본인 OTP · 감사. 비밀은 응답에 싣지 않는다(있는지만). 받은 것은 메모리 고리만.
  adminRouter.get('/bm-events', adminOnly, fleetOnly, async (_req, res) => {
    const E = await import('../../idrac/eventSub.js');
    res.set('Cache-Control', 'no-store');
    const st = E.eventSubStore.get();
    res.json({ ok: true, settings: E.eventSubPublic(st), destinationPreview: st.base ? `${st.base}${E.EVT_PATH}…` : '', otpRequired: !!config.auth.enabled,
      ...(E.eventSubStore.loadError() ? { unreadable: true } : {}), status: E.eventStatus(), sync: E.syncStatus(), edge: !!config.agent.centralUrl,
      limits: { debounceMs: E.EVT_DEBOUNCE_MS, perPost: E.EVT_PER_POST, ring: E.EVT_RING, concurrency: E.SUB_CONCURRENCY, batch: E.EVT_BATCH_MAX } });
  });
  adminRouter.put('/bm-events', adminOnly, fleetOnly, textFields('base'), async (req, res) => {
    const E = await import('../../idrac/eventSub.js');
    const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const before = E.eventSubStore.get();
    const r = E.eventSubStore.save({ enabled: b.enabled, base: b.base, rotate: b.rotate === undefined ? false : b.rotate }, { by: req.user?.username || '' });
    if (!r.ok) return res.status(r.status || 400).json({ ok: false, reason: r.reason });
    if (r.rotated) E.clearSyncResults();
    logAudit({ user: req.user?.username, action: '물리서버 이벤트 구독 설정 저장', detail: `켜기 ${before.enabled ? '켜짐' : '꺼짐'}→${r.value.enabled ? '켜짐' : '꺼짐'} · 받는 주소 ${r.value.base || '(없음)'}${r.rotated ? ' · 비밀 새로 만듦(다시 구독해야 받습니다)' : ''}`.slice(0, 300), ip: req.ip });
    res.json({ ok: true, settings: E.eventSubPublic(r.value), rotated: !!r.rotated });
  });
  const syncBodyOk = async (req, res, next) => {
    const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    if (b.unsubscribe !== undefined && typeof b.unsubscribe !== 'boolean') return res.status(400).json({ ok: false, reason: 'unsubscribe 는 참/거짓이어야 합니다.' });
    const E = await import('../../idrac/eventSub.js');
    const why = E.syncPrecheck({ unsubscribe: b.unsubscribe === true });   // 진행 중 · 꺼짐을 OTP 앞에서(디버깅 1회차 보안 #2)
    if (why) return res.status(why.busy ? 409 : 400).json({ ok: false, reason: why.reason });
    return next();
  };
  adminRouter.post('/bm-events/sync', adminOnly, fleetOnly, textFields('otp'), syncBodyOk, ownOtpGate('물리서버 이벤트 구독 걸기 · 지우기'), async (req, res) => {
    const E = await import('../../idrac/eventSub.js');
    const unsubscribe = req.body?.unsubscribe === true;
    const user = req.user?.username; const ip = req.ip;
    const r = E.startSync({ unsubscribe, by: user || '', onDone: (x) => {
      const n = (x.results || []).reduce((a, y) => { a[y.status] = (a[y.status] || 0) + 1; return a; }, {});
      const bad = (x.results || []).filter((y) => !['subscribed', 'removed', 'none', 'demo'].includes(y.status)).slice(0, 8).map((y) => `${y.name || y.id}:${y.status}`);   // 장비별 실패도 남긴다(반증 A12)
      logAudit({ user, action: unsubscribe ? '물리서버 이벤트 구독 지우기' : '물리서버 이벤트 구독 걸기', detail: (x.error ? `실패 — ${x.error}` : `${Object.entries(n).map(([k, v]) => `${k} ${v}`).join(' · ') || '대상 없음'}${bad.length ? ` · 실패 ${bad.join(', ')}` : ''}`).slice(0, 300), ip });
    } });
    if (!r.ok) return res.status(r.busy ? 409 : 400).json({ ok: false, reason: r.reason });
    res.status(202).json({ ok: true, started: true });
  });

  adminRouter.post('/bm-advisories/import', csvPerm, adminOnly, fleetOnly, textFields('csv'), (req, res) => {
    const refused = V.refusal();
    if (refused) return res.status(409).json({ ok: false, ...refused });
    const dry = req.body?.dryRun;
    if (dry !== undefined && typeof dry !== 'boolean') return res.status(400).json({ ok: false, reason: '‘dryRun’ 은 true 또는 false 여야 합니다.', field: 'dryRun' });
    const { rows, errors } = parseAdvisoryCsv(String(req.body?.csv || ''));
    const cur = V.get();
    const base = { n: cur.rows.length, at: cur.at ?? null };
    // 오류는 앞 200행만 싣고 전체 수를 따로 — 화면이 ‘오류 200행’ 으로 줄여 말하지 않게(디버깅 1회차 화면 U4)
    const view = { total: rows.length + errors.length, ok: true, rows: rows.length, errors: errors.slice(0, 200), errorCount: errors.length, base };
    // 검증 때 화면이 보낸 지금 목록의 서버 모델(최대 500)로 줄마다 맞는지 본다 — 맞는 서버가 없는 줄은 알린다(모델 글자 꼴을 다 알 수 없다 · 디버깅 5회차 판정 #2). 적용은 막지 않는다
    if (dry === true) {
      const sm = Array.isArray(req.body?.models) ? req.body.models.filter((x) => typeof x === 'string' && x.trim()).slice(0, 500).map((x) => x.slice(0, 120)) : null;
      let unmatched = null;
      if (sm && sm.length) { const um = rows.filter((r) => r.model && !sm.some((m) => modelTokensMatch(m, r.model))); unmatched = { n: um.length, rows: um.slice(0, 200).map((r) => ({ id: r.id, model: r.model })) }; }
      return res.json({ ...view, dryRun: true, ...(unmatched ? { unmatched } : {}) });
    }
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

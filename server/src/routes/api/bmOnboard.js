/**
 * routes/api/bmOnboard.js — 리눅스 성능 7b단계: SSH 키 저장소 · 법인 공통 계정 · 서버 등록(CSV/Excel 온보딩) · 누락 점검 API.
 *
 * 권한(설계 §19 · server/CLAUDE.md '7b SSH 키 저장소'):
 *  · 키 · 공통 계정 **조회**: 관리자(+tools). 응답에는 지문 · 공개키 · 이름 · 사용처 수만(개인키 · passphrase · 비밀번호 없음 — 있는지만).
 *    공통 계정은 범위 계정에게 자기 조회 범위 법인 + 전 법인 공용('')만.
 *  · 키 · 공통 계정 **관리**(등록 · 수정 · 회전 · 삭제 · 비밀 입력): `requireSettingsOwner`(소유자 ∧ 전체 범위) + 본인 OTP 재인증(`reauth` — 마지막 게이트:
 *    권한이 없는 요청이 OTP 를 소모하지 않게) + 감사 로그(비밀 미기재).
 *  · 온보딩(분석 · 적용) · 누락 점검은 아래 절 — 범위 계정은 행 단위로 조회 밖 404 → 쓰기 밖 403(그 행 거부).
 * 저장소를 못 읽으면 503(registryUnreadable) — 빈 목록을 내려보내지 않는다.
 */
import { requireRole, requirePerm } from '../../auth/auth.js';
import { requireSettingsOwner } from '../admin/shared.js';
import { reauth } from './reauth.js';
import { logAudit } from '../../audit.js';
import { store } from '../../store.js';
import { inUserScope, inUserWriteScope, isFullReadWriteScope, scopedVcenterIds } from '../../auth/scope.js';
import { isDemoGuest } from '../../auth/demoGuest.js';
import { config } from '../../config.js';
import * as RUN from '../../bmusage/onboard/onboardRun.js';
import * as ED from '../../bmusage/onboard/edgeDeploy.js';
import { testSavedOs } from '../../bmusage/onboard/connTest.js';   // 연결 시험 본체(접속 자격 해석은 라우트 밖 — 소스 스윕)
import { ROW_CODE, WARN } from '../../bmusage/onboard/importAnalyze.js';
import { TEMPLATE_COLUMNS, MAX_UPLOAD_BYTES, MAX_ROWS, parseOnboardFile } from '../../bmusage/onboard/importParse.js';
import * as KS from '../../bmusage/onboard/keyStore.js';
import * as REFS from '../../bmusage/onboard/refs.js';

const adminOnly = requireRole('admin');
const toolsPerm = requirePerm('tools');
const csvPerm = requirePerm('data.csv');   // v2.643: CSV · 텍스트 가져오기/내보내기는 'data.csv' 권한(관리자가 끌 수 있다)
const noDemo = (req, res, next) => (isDemoGuest(req.user) ? res.status(403).json({ ok: false, error: 'forbidden', reason: '데모 계정은 서버를 등록할 수 없습니다.' }) : next());
const EDGE_ONLINE_MS = 15 * 60_000;   // 엣지 접속 판정 — 설정 인출(기본 몇 분)의 여러 배. 이보다 오래면 '끊김', 기록이 없으면 '모름'
/** 키 관리 게이트 묶음 — 순서가 뜻이다(관리자 → tools → 소유자 등급 → OTP). */
const keyAdmin = [adminOnly, toolsPerm, requireSettingsOwner, reauth];

const t = (v, max = 256) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max).trim();
const bodyOf = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});
const who = (req) => req.user?.username || '';

/** 결과 → 응답(상태 코드는 결과의 status · code 로). 저장소 못 읽음은 503 + registryUnreadable 표지. */
function send(res, r, okStatus = 200) {
  if (r && r.ok) return res.status(okStatus).json(r);
  const status = Number(r?.status) || (r?.code === 'registry-unreadable' || r?.code === 'SECRETS_POLICY_UNAVAILABLE' ? 503 : 400);
  const { status: _s, ...rest } = r || { ok: false, reason: '알 수 없는 오류' };
  void _s;
  return res.status(status).json({ ...rest, ok: false, ...(rest.code === 'registry-unreadable' ? { registryUnreadable: true } : {}) });
}
function unreadable503(res) {
  const e = KS.keyStoreLoadError();
  if (!e) return false;
  res.status(503).json({ ok: false, code: 'registry-unreadable', registryUnreadable: true, reason: `SSH 키 저장소(${KS.KEY_FILE_NAME})를 읽지 못했습니다 — 손상 보존본(${KS.KEY_FILE_NAME}.corrupt.*)을 확인하세요.` });
  return true;
}

/** 미들웨어를 함수로 돌린다(응답을 가로챈다) — 게이트 판정을 라우트 안에서 순서대로 하기 위해. */
export function runGate(mw, req) {
  return new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(body) { resolve({ ok: false, status: this.statusCode || 403, body }); return this; }, set() { return this; } };
    try { mw(req, res, () => resolve({ ok: true })); } catch (e) { resolve({ ok: false, status: 500, body: { ok: false, reason: String(e?.message || e).slice(0, 200) } }); }
  });
}
/** 설정 소유자 등급(소유자 ∧ 전체 범위)인가 — requireSettingsOwner 와 같은 판정 하나(routes/auth.js settingsOwnerTier 와 같은 방식). */
export async function isOwnerTier(req) { return (await runGate(requireSettingsOwner, req)).ok; }

export function registerBmOnboard(api, deps = {}) {
  /* ── SSH 키 저장소 ─────────────────────────────────────────────── */
  api.get('/tools/bm-usage/ssh-keys', adminOnly, toolsPerm, (req, res) => {
    if (unreadable503(res)) return;
    const v = REFS.listKeysView({ scoped: !!scopedVcenterIds(req.user, store.get()) });   // 감사 L-7: 범위 계정에는 목록을 주지 않는다
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, ...v, undecryptable: KS.keyStoreUndecryptable() || 0 });
  });

  api.post('/tools/bm-usage/ssh-keys', ...keyAdmin, (req, res) => {
    const b = bodyOf(req);
    const r = KS.addKey({ name: b.name, privateKey: typeof b.privateKey === 'string' ? b.privateKey : '', passphrase: typeof b.passphrase === 'string' ? b.passphrase : '', rotateAt: b.rotateAt }, { by: who(req) });
    logAudit({ user: who(req), action: 'bm-usage.ssh-key.add', target: t(b.name, 64), ip: req.ip || '',
      detail: JSON.stringify(r.ok ? { algo: r.key.algo, bits: r.key.bits, fingerprint: r.key.fingerprint, ok: true } : { ok: false, code: r.code }).slice(0, 300) });
    send(res, r);
  });

  api.put('/tools/bm-usage/ssh-keys/:id', ...keyAdmin, (req, res) => {
    const b = bodyOf(req);
    const r = KS.updateKeyMeta(t(req.params.id, 32), { ...(b.name !== undefined ? { name: b.name } : {}), ...(b.rotateAt !== undefined ? { rotateAt: b.rotateAt } : {}) });
    logAudit({ user: who(req), action: 'bm-usage.ssh-key.update', target: t(req.params.id, 32), ip: req.ip || '', detail: JSON.stringify({ name: r.ok ? r.key.name : undefined, ok: !!r.ok, code: r.code }).slice(0, 300) });
    send(res, r);
  });

  api.post('/tools/bm-usage/ssh-keys/:id/passphrase', ...keyAdmin, (req, res) => {
    const b = bodyOf(req);
    const r = KS.setKeyPassphrase(t(req.params.id, 32), typeof b.passphrase === 'string' ? b.passphrase : '');
    logAudit({ user: who(req), action: 'bm-usage.ssh-key.passphrase', target: t(req.params.id, 32), ip: req.ip || '', detail: JSON.stringify({ ok: !!r.ok, code: r.code }).slice(0, 200) });
    send(res, r);
  });

  api.post('/tools/bm-usage/ssh-keys/rotate', ...keyAdmin, (req, res) => {
    const b = bodyOf(req);
    const r = REFS.rotateKey(t(b.from, 32), t(b.to, 32));
    logAudit({ user: who(req), action: 'bm-usage.ssh-key.rotate', target: `${t(b.from, 32)}→${t(b.to, 32)}`, ip: req.ip || '',
      detail: JSON.stringify(r.ok ? { servers: r.servers.length, accounts: r.accounts, ok: true } : { ok: false, code: r.code }).slice(0, 300) });
    if (!r.ok) return send(res, r);
    // 화면이 '전 서버 재시험' 을 권한다 — 자동 재시험 · 재시도는 하지 않는다(계정 잠금).
    res.json({ ok: true, servers: r.servers, accounts: r.accounts, retestAdvised: r.servers.length > 0 });
  });

  api.delete('/tools/bm-usage/ssh-keys/:id', ...keyAdmin, (req, res) => {
    const r = REFS.deleteKeyIfUnused(t(req.params.id, 32));
    logAudit({ user: who(req), action: 'bm-usage.ssh-key.delete', target: t(req.params.id, 32), ip: req.ip || '', detail: JSON.stringify({ ok: !!r.ok, code: r.code }).slice(0, 200) });
    send(res, r);
  });

  /* ── 법인 공통 계정 ────────────────────────────────────────────── */
  api.get('/tools/bm-usage/accounts', adminOnly, toolsPerm, (req, res) => {
    if (unreadable503(res)) return;
    const snap = store.get();
    const v = REFS.listAccountsView({ visible: (corp) => inUserScope(req.user, snap, corp), scoped: !!scopedVcenterIds(req.user, snap) });
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, ...v });
  });

  api.post('/tools/bm-usage/accounts', ...keyAdmin, (req, res) => {
    const b = bodyOf(req);
    const { otp, ...input } = b; void otp;
    const r = KS.saveAccount({
      id: input.id, name: input.name, kind: input.kind, corp: input.corp, username: input.username,
      keyRef: input.keyRef, password: typeof input.password === 'string' ? input.password : undefined, clearPassword: input.clearPassword === true,
    }, { by: who(req) });
    logAudit({ user: who(req), action: input.id ? 'bm-usage.account.update' : 'bm-usage.account.add', target: t(input.name, 64), ip: req.ip || '',
      detail: JSON.stringify(r.ok ? { kind: r.account.kind, corp: r.account.corp, keyRef: r.account.keyRef, secretChanged: typeof input.password === 'string' && input.password !== '' && input.password !== '********', dropped: r.droppedSecrets || [] } : { ok: false, code: r.code }).slice(0, 300) });
    send(res, r);
  });

  api.delete('/tools/bm-usage/accounts/:id', ...keyAdmin, (req, res) => {
    const r = REFS.deleteAccountIfUnused(t(req.params.id, 32));
    logAudit({ user: who(req), action: 'bm-usage.account.delete', target: t(req.params.id, 32), ip: req.ip || '', detail: JSON.stringify({ ok: !!r.ok, code: r.code }).slice(0, 200) });
    send(res, r);
  });

  /* ── 서버 등록(CSV/Excel 온보딩) ───────────────────────────────── */
  const D0 = deps.onboardDeps || RUN.defaultOnboardDeps;
  const ctxFor = async (req, D) => {
    const snap = store.get();
    const isEdge = !!config.agent?.centralUrl;
    const { datacenterOfVcenter, listDatacenters } = await import('../../datacenter/store.js');
    const dcName = new Map((() => { try { return listDatacenters(); } catch { return []; } })().map((d) => [String(d.id), String(d.name || d.id)]));
    const corps = (snap?.vcenters || []).filter((v) => v && v.id).map((v) => ({ id: String(v.id), name: String(v.name || v.id), dc: dcName.get(String((() => { try { return datacenterOfVcenter(v.id); } catch { return ''; } })())) || '' }));
    let edgeOf = null; let rttOf = null; let myCorps = [];
    if (isEdge) {
      try { myCorps = Object.keys((await import('../../bmusage/settings.js')).loadBmUsageSettings().corps || {}); } catch { myCorps = []; }
    } else {
      edgeOf = await (deps.edgeOfFactory || edgeOfFactory)();
      try { rttOf = await (await import('./hostCorp.js')).rttReader(); } catch { rttOf = null; }
    }
    // 반증 F4 · F10: 지금 수집 대상(이 노드 분류 — 엣지 보고 서버 포함)으로 service_tag · 이름을 해석한다(purposeWrite 와 같은 '대상으로 해석될 때만').
    // 2차 재확인 G1: 용도 · 역할의 저장 키는 상세 화면과 같은 규칙(bmusage/purposeKey.js + 판정기 commonTag.js) — 공통 태그(‘To Be Filled By O.E.M.’ ·
    //   둘 이상 서버 · 둘 이상 법인)는 어느 서버 것인지 정할 수 없어 적용하지 않는다(purpose-common-tag). 판정기를 못 만들면 적용하지 않는 쪽.
    let tagMap = null; let names = null;
    try {
      const tg = await (deps.currentTargets || (async () => (await import('../../bmusage/poller.js')).currentTargets()))();
      let judge = null;
      try {
        const CT = await import('../../bmusage/commonTag.js');
        const edges = await (deps.listEdgeBmUsage || (async () => (await import('../../central/bmUsageEdgePull.js')).listEdgeBmUsage()))();
        judge = CT.tagJudgeOf(tg, edges || []);
      } catch { judge = null; }
      const PK = await import('../../bmusage/purposeKey.js');
      const all = [...(tg.targets || []), ...(tg.skipped || [])];
      names = new Set(all.filter((x) => x?.name).map((x) => String(x.name).toLowerCase()));
      tagMap = PK.tagTargetsOf(all, judge);   // 엣지 배포 적용(edgeApply.js)과 같은 함수(3차 재확인 H1)
    } catch { tagMap = null; names = null; }
    const ownerTier = await isOwnerTier(req);
    // ⚠ 반증 F12: 등록부 사본은 **여기(마지막 await 뒤)** 에서 잡는다 — 이후 분석 · 적용은 await 없이 이어진다.
    return RUN.buildOnboardCtx({
      D, corps, isEdge, myCorps, edgeOf, rttOf, ownerTier,
      tagTarget: (tag) => (tagMap ? tagMap.get(String(tag).toLowerCase()) || null : null),   // G1: 대상을 못 읽으면 용도 · 역할은 적용하지 않는다(전역 태그로 쓰지 않게)
      fleetHas: names ? ({ name }) => names.has(String(name).toLowerCase()) : null,
      canView: (vc) => inUserScope(req.user, snap, vc), canWrite: (vc) => inUserWriteScope(req.user, snap, vc), fullScope: isFullReadWriteScope(req.user, snap),
    });
  };
  const fileOf = (b) => {
    const data = typeof b.data === 'string' ? b.data : '';
    if (!data) return { err: '파일 내용이 없습니다.' };
    if (data.length > Math.ceil(MAX_UPLOAD_BYTES * 4 / 3) + 8) return { err: `파일이 ${MAX_UPLOAD_BYTES / 1048576}MB 를 넘습니다 — 나눠 올리세요.`, code: 'too-large' };
    if (!/^[A-Za-z0-9+/=\r\n]+$/.test(data.slice(0, 64))) return { err: '파일 내용 형식(base64)이 아닙니다.' };
    return { buf: Buffer.from(data, 'base64'), name: t(b.fileName, 200) };
  };

  api.get('/tools/bm-usage/onboard/template.csv', adminOnly, toolsPerm, csvPerm, async (_req, res) => {
    const { csvLine, CSV_BOM } = await import('../../util/csv.js');
    const lines = [csvLine([...TEMPLATE_COLUMNS]),
      csvLine(['# name*: 서버 이름', '# corp*: 법인(vCenter 이름 · id) 또는 미귀속', '# idrac_host: iDRAC 주소', '# idrac_cred: iDRAC 공통 계정 이름', '# service_tag', '# os_host: SSH 주소', '# os_port(22)',
        '# os_cred: OS 공통 계정 이름 또는 개별:계정명', '# os_key: SSH 키 이름 · password · 비우면 공통 계정 기본 키', '# collect_via: edge · central · auto(기본)', '# class', '# purposes(;)', '# role', '# mounts(;)', '# switch_port: NIC=스위치:포트(;)', '# enabled', '# note — 비밀번호 · 키 내용은 넣지 않습니다(그 행 거부)']),
      csvLine(['bm-kr1-db01', 'KR-SEL', '10.20.3.11', 'kr-idrac-ro', 'ABC1234', '10.20.4.11', '22', 'kr-ops', 'kr-ops-ed25519', 'auto', 'baremetal', 'gpdb', 'db', '/; /data', 'eth0=leaf-01:Ethernet12', 'true', '']),
    ];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="bm-onboard-template.csv"');
    res.send(`${CSV_BOM}${lines.join('\r\n')}\r\n`);
  });

  api.post('/tools/bm-usage/onboard/analyze', adminOnly, toolsPerm, csvPerm, noDemo, async (req, res) => {
    const f = fileOf(bodyOf(req));
    if (f.err) return res.status(f.code === 'too-large' ? 413 : 400).json({ ok: false, code: f.code || 'bad-file', reason: f.err });
    const D = await D0();
    const parsed = await parseOnboardFile(f.buf, { fileName: f.name });
    if (!parsed.ok) return res.status(400).json({ ok: false, code: parsed.code, reason: parsed.reason });
    const { ctx, unread } = await ctxFor(req, D);
    if (unread.length) return res.status(503).json({ ok: false, code: 'registry-unreadable', registryUnreadable: true, reason: `등록부를 읽지 못해 분석하지 않았습니다(${unread.join(', ')}) — 빈 등록부로 보고 ‘신규’ 로 판정하지 않게.` });
    const r = RUN.analyzeParsed(f.buf, parsed, ctx);
    if (!r.ok) return res.status(400).json(r);
    const csv = await RUN.resultCsv(r.rows);
    res.set('Cache-Control', 'no-store');
    // 행의 적용 계획(plan)은 응답에 싣지 않는다(공통 계정 id 등 내부 참조 — 화면은 판정 · 사유 · 경고만 쓴다)
    res.json({ ...r, rows: r.rows.map(({ plan: _p, ...row }) => row), resultCsv: csv, maxRows: MAX_ROWS, ownerTier: ctx.ownerTier });
  });

  api.post('/tools/bm-usage/onboard/apply', adminOnly, toolsPerm, csvPerm, noDemo, async (req, res) => {
    const b = bodyOf(req);
    const f = fileOf(b);
    if (f.err) return res.status(f.code === 'too-large' ? 413 : 400).json({ ok: false, code: f.code || 'bad-file', reason: f.err });
    const out = await RUN.serialOnboard(async () => {
      const D = await D0();
      // 반증 F12: 파일 해석(xlsx 는 비동기)을 **먼저** 끝내고, 문맥(등록부 사본)을 잡은 뒤에는 await 없이 분석 → 대조 → 적용한다.
      const parsed = await parseOnboardFile(f.buf, { fileName: f.name });
      if (!parsed.ok) return { status: 400, body: { ok: false, code: parsed.code, reason: parsed.reason } };
      const { ctx, unread } = await ctxFor(req, D);
      if (unread.length) return { status: 503, body: { ok: false, code: 'registry-unreadable', registryUnreadable: true, reason: `등록부를 읽지 못해 적용하지 않았습니다(${unread.join(', ')}).` } };
      const a = RUN.analyzeParsed(f.buf, parsed, ctx);
      // 사람이 본 판정과 지금 판정이 다르면(그 사이 등록부 · 키 · 범위 · 엣지 접속이 바뀜) 적용하지 않는다 — 다시 보게 한다.
      if (t(b.sig, 80) !== a.sig) return { status: 409, body: { ok: false, code: 'analysis-changed', reason: '분석한 뒤 등록부 · 키 · 엣지 상태가 바뀌어 판정이 달라졌습니다 — 다시 분석해 확인한 뒤 적용하세요.', sig: a.sig } };
      // 메인 결정(감사 H-1): 공통 계정 · SSH 키를 주소에 묶는 행이 있으면 설정 소유자 등급 + 본인 OTP — OTP 는 다른 검사를 모두 통과한 **뒤 마지막**(소모 순서).
      if (a.rows.some((r) => (r.action === 'new' || r.action === 'update') && r.plan?.binds && !r.plan?.hidden)) {
        if (!ctx.ownerTier) return { status: 403, body: { ok: false, error: 'forbidden', requiredOwner: true, reason: '공통 계정 · SSH 키를 주소에 묶는 적용은 설정 소유자(전체 범위)만 할 수 있습니다.' } };
        const g = await runGate(reauth, req);   // reauth 는 동기 — 이 await 사이에 다른 요청이 끼지 않는다(마이크로태스크)
        if (!g.ok) return { status: g.status, body: g.body };
      }
      const r = RUN.applyOnboard(a.rows, { D, by: who(req), isEdge: ctx.isEdge, fileSha: a.fileSha });
      logAudit({ user: who(req), action: 'bm-usage.onboard.apply', target: t(f.name, 120), ip: req.ip || '',
        detail: JSON.stringify({ ok: !!r.ok, file: a.fileSha.slice(0, 16), summary: a.summary, applied: r.applied, code: r.code, step: r.step }).slice(0, 600) });
      return { status: r.ok ? 200 : (Number(r.status) || 500), body: { ...r, summary: a.summary } };
    });
    res.status(out.status).json(out.body);
  });

  /* 엣지 배포 목록 — 행은 조회 범위 법인만 · 빼기는 쓰기 범위(조회 밖 404 → 쓰기 밖 403). */
  api.get('/tools/bm-usage/onboard/edge-rows', adminOnly, toolsPerm, async (req, res) => {
    if (config.agent?.centralUrl) return res.json({ ok: true, edge: true, agents: [] });
    const e = ED.edgeDeployLoadError();
    if (e) return res.status(503).json({ ok: false, code: 'registry-unreadable', registryUnreadable: true, reason: `엣지 배포 목록(${ED.EDGE_FILE_NAME})을 읽지 못했습니다.` });
    const snap = store.get();
    const scoped = !!scopedVcenterIds(req.user, snap);
    const agents = ED.edgeSummary().map((s) => {
      const rows = ED.edgeRowsFor(s.agent).filter((r) => (r.corp ? inUserScope(req.user, snap, r.corp) : !scoped));
      const pull = ED.onboardPullOf(s.agent);
      return { agent: s.agent, pending: scoped ? undefined : s.pending, rows: rows.map((r) => ({ name: r.name, corp: r.corp, idracHost: !!r.idracHost, osHost: !!r.osHost, osKey: r.osKey, osCred: r.osCred, idracCred: r.idracCred, enabled: r.enabled })),
        total: scoped ? rows.length : s.rows, at: s.at, sig: s.sig, pulledAt: pull?.at || null, appliedSig: pull?.appliedSig || '', applied: pull?.applied || null, inSync: pull ? pull.appliedSig === s.sig : null };
    }).filter((a) => a.rows.length || !scoped);
    let minEdgeVersion = '';
    try { minEdgeVersion = (await import('../../central/featureMinEdgeVersion.js')).stage7bMinEdgeVersion(); } catch { minEdgeVersion = ''; }
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, agents, minEdgeVersion });
  });

  api.delete('/tools/bm-usage/onboard/edge-rows', adminOnly, toolsPerm, noDemo, (req, res) => {
    const b = { ...(req.query || {}), ...bodyOf(req) };
    const agent = t(b.agent, 64); const name = t(b.name, 128);
    const snap = store.get();
    const row = ED.edgeRowsFor(agent).find((r) => r.name.toLowerCase() === name.toLowerCase());
    if (!row || (row.corp ? !inUserScope(req.user, snap, row.corp) : !!scopedVcenterIds(req.user, snap))) return res.status(404).json({ ok: false, reason: '배포 행을 찾을 수 없습니다.' });
    if (row.corp ? !inUserWriteScope(req.user, snap, row.corp) : false) return res.status(403).json({ ok: false, error: 'forbidden', reason: '이 법인에 쓰기 권한이 없습니다(조회 전용).' });
    const r = ED.applyEdgeChanges({ removes: [{ agent, name: row.name }] }, { by: who(req) });
    logAudit({ user: who(req), action: 'bm-usage.onboard.edge-remove', target: `${agent}/${row.name}`, ip: req.ip || '', detail: JSON.stringify({ ok: !!r.ok, code: r.code }).slice(0, 200) });
    send(res, r);
  });

  /* 누락 점검 — 보드 커버리지와 같은 값(perfForRows → coverageOf) · 범위 계정은 자기 법인 서버만(미귀속 없음) · 주소는 관리자 판본만. */
  api.get('/tools/bm-usage/onboard/missing', adminOnly, toolsPerm, async (req, res) => {
    try {
      const snap = store.get();
      const allowed = scopedVcenterIds(req.user, snap);
      const P = await import('../../bmusage/poller.js');
      const DB = await import('../../bmusage/db.js');
      const EP = await import('../../bmusage/edgePull.js');
      const BU = await import('./bmUsage.js');
      const { loadBmUsageSettings } = await import('../../bmusage/settings.js');
      const { missingCheck } = await import('../../bmusage/onboard/missing.js');
      const tg = await P.currentTargets();
      const agent = config.agent?.name || '';
      const keys = new Set(tg.targets.map((x) => String(x.key)));
      const latest = (await DB.latestUsage({ json: true }).catch(() => null));
      if (latest == null) return res.status(503).json({ ok: false, code: 'store-unreadable', reason: '수집 DB 를 읽지 못해 누락 점검을 하지 않았습니다(모두 ‘없음’ 으로 보이지 않게).' });
      const rowsRaw = await BU.demoPerfRows(latest.filter((r) => String(r.agent) === agent && keys.has(String(r.key))), tg.targets);
      const pf = await EP.perfForRows(rowsRaw, tg.targets, loadBmUsageSettings(), { full: false });
      const entryByKey = new Map(pf.perf.map((p) => [String(p.key), p]));
      let edges = [];
      if (!config.agent?.centralUrl) { try { edges = (await import('../../central/bmUsageEdgePull.js')).listEdgeBmUsage(); } catch { edges = []; } }
      const edgeEntry = (a, key) => {
        const rec = edges.find((x) => String(x.agent || x.name || '').toLowerCase() === String(a).toLowerCase());
        return (rec?.snap?.perf || []).find((p) => String(p.key) === key) || null;
      };
      const vcName = (vc) => ((snap?.vcenters || []).find((v) => v.id === vc)?.name) || vc;
      let osRegistry = null;
      try { osRegistry = (await import('../../bmstor/registry.js')).listBmServers(); } catch { osRegistry = null; }
      const m = missingCheck({ targets: tg.targets, skipped: tg.skipped || [], entryByKey, edgeEntry, vcName, osRegistry });
      const visible = m.rows.filter((r) => (r.vcenterId ? (!allowed || allowed.has(r.vcenterId)) : !allowed));
      const full = (await import('../../auth/addressMask.js')).isAdminReq(req);
      const rows = visible.map((r) => (full ? r : { ...r, idracHost: r.idracHost ? '(가림)' : '', osHost: r.osHost ? '(가림)' : '', suggest: r.suggest ? { ...r.suggest, idrac_host: undefined, os_host: undefined } : undefined }));
      const counts = Object.fromEntries(Object.keys(m.counts).map((b) => [b, rows.filter((r) => r.bucket === b).length]));
      res.set('Cache-Control', 'no-store');
      res.json({ ok: true, counts, rows: rows.slice(0, 5000), total: rows.length, perfError: pf.perfError || undefined, sourceErrors: (tg.sourceErrors || []).length });
    } catch (e) { res.status(500).json({ ok: false, reason: String(e?.message || e).slice(0, 200) }); }
  });

  /*
   * 연결 시험(표본) — **저장된 항목의 주소로만**(v2.480: 요청이 주소를 바꿀 수 없다 — id 만 받는다) · 키 · 공통 계정 해석은 폴러와 같은 refs.resolveOsAuth ·
   * 한 번만(자동 재시도 없음) · 인증 거부는 '인증 정지 후보' 로 알리고(주기 수집은 authGuard 가 다음 실패에서 멈춘다) · 호스트키 미신뢰는 peerTrust 승인 안내.
   */
  api.post('/tools/bm-usage/onboard/test', adminOnly, toolsPerm, noDemo, async (req, res) => {
    const id = t(bodyOf(req).id, 32);
    const BMR = await import('../../bmstor/registry.js');
    const s0 = BMR.listBmServersRaw().find((x) => x.id === id);
    const snap = store.get();
    const vc = t(s0?.vcenterId, 128);
    const scoped = !!scopedVcenterIds(req.user, snap);
    if (!s0 || (vc ? !inUserScope(req.user, snap, vc) : scoped)) return res.status(404).json({ ok: false, reason: '서버를 찾을 수 없습니다.' });
    if (vc && !inUserWriteScope(req.user, snap, vc)) return res.status(403).json({ ok: false, error: 'forbidden', reason: '이 법인에 쓰기 권한이 없습니다(조회 전용).' });
    const r = await (deps.testOs || testSavedOs)(s0);
    logAudit({ user: who(req), action: 'bm-usage.onboard.test', target: s0.name || id, ip: req.ip || '', detail: JSON.stringify({ ok: !!r.ok, kind: r.kind, auth: r.authKind }).slice(0, 200) });
    res.json(r);
  });

  api.get('/tools/bm-usage/onboard/codes', adminOnly, toolsPerm, (_req, res) => res.json({ ok: true, rowCodes: ROW_CODE, warnCodes: WARN, columns: TEMPLATE_COLUMNS, maxRows: MAX_ROWS, maxBytes: MAX_UPLOAD_BYTES }));
}

/**
 * 법인(vCenter) → 그 법인 엣지 { agent, online }(중앙 전용). 매핑은 `bmusage/edgeCorps.js`(‘중앙에서 켜기’ 와 같은 판정 — 등록부 · 위임 인벤토리 · 관측),
 * 접속은 `central/agentContact.js`(마지막 인증 요청 — 재시작하면 비어 '모름').
 */
export async function edgeOfFactory({ now = Date.now() } = {}) {
  let agents = [];
  try { agents = (await import('../../central/knownAgents.js')).knownAgentNames(); } catch { agents = []; }
  let corpsOf = () => [];
  try { corpsOf = (await import('../../bmusage/edgeCorps.js')).edgeCorpsSource(); } catch { corpsOf = () => []; }
  let lastOf = () => null;
  try { lastOf = (await import('../../central/agentContact.js')).agentLastContact; } catch { lastOf = () => null; }
  const byCorp = new Map();
  for (const a of agents) {
    let corps = []; try { corps = corpsOf(a) || []; } catch { corps = []; }
    for (const vc of corps) if (!byCorp.has(String(vc))) byCorp.set(String(vc), a);
  }
  return (vc) => {
    const a = byCorp.get(String(vc || ''));
    if (!a) return null;
    const at = lastOf(a);
    return { agent: String(a).toLowerCase(), online: at == null ? null : now - at <= EDGE_ONLINE_MS };
  };
}

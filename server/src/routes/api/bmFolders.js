/**
 * routes/api/bmFolders.js — 특수 기능 '물리서버 폴더'(도구 키 `bm-folders`, v2.984).
 *   설계: docs/design/bm-folders/README.md(시안 2차 · 사용자 '기본값대로 구현' — 1단계 = 목록 + 일괄 등록 + 옆 패널).
 *
 * 물리서버(베어메탈)를 **법인 › 폴더**에 등록해 서비스별로 묶어 본다(vCenter 의 호스트 ↔ 클러스터처럼 한 서버 한 폴더).
 * **새 수집기가 없다** — 서비스 인벤토리의 입력 수집(`sharedGather` — 함대 분류 · 법인 귀속 · 사용률 · 부품 장애)을 같은 단일 비행으로 쓴다.
 * 엣지 · 수집 서버가 보고한 베어메탈도 그 수집에 이미 들어 있다 — 등록 정보는 **중앙에만** 저장한다(엣지 push 계약 변경 없음).
 *
 * ── 권한 ─────────────────────────────────────────────────────────────────────
 *  · 조회: `tools` + 도구 접근(`bm-folders`) + vCenter 범위(요청 필터보다 먼저). 법인 귀속 없는 서버 · 엣지 이름은 범위 계정에 주지 않는다.
 *  · 범위 계정 판본: 서비스 태그를 싣지 않고 키는 토큰(`pubKey`) · 쓰기는 토큰만 받는다(`keyResolverFor` — 원문 st:/fl: 키 거부) ·
 *    서비스 태그로 찾지 않는다(찾기가 태그를 맞혀 보는 길이 되지 않게) — 서비스 인벤토리 5차 R7 과 같은 기준.
 *  · 비관리자 판본: 주소처럼 보이는 이름을 가린다(`maskName`).
 *  · 법인 쓰기(폴더 · 등록 · 법인 규칙): admin/operator · 데모 계정 아님 · '조회 밖 404 → 쓰기 밖 403'(`corpWriteAccess`).
 *    여러 법인을 한 번에 등록하면 쓰기 밖 법인 서버는 건너뛰고 개수를 밝힌다(전부 쓰기 밖이면 403).
 *  · 전 법인 규칙('*') · 자동 규칙 켜기 · 손상 초기화: 전체 범위(조회 ∧ 쓰기) 관리자(`fleetAdmin`).
 * ── 캐시 ─────────────────────────────────────────────────────────────────────
 *  · 메인 조회: memoJson + extraKey = 범위 | 쓰기 범위 | 관리자 판본 | 저장소 rev | 입력 세대. 찾기 · 쓰기는 캐시하지 않는다.
 * ⚠ 폴링하지 않는다(화면은 마운트 1회 + 새로고침 + 쓰기 뒤 재조회).
 */
import { requirePerm, requireRole } from '../../auth/auth.js';
import { scopedVcenterIds, inUserScope, inUserWriteScope, writeScopedVcenterIds } from '../../auth/scope.js';
import { isDemoGuest, isAdminDetailUser } from '../../auth/demoGuest.js';
import { todayStamp } from '../../util/dayKey.js';
import { store } from '../../store.js';
import { memoJson, scopeKey } from './shared.js';
import { logAudit } from '../../audit.js';
import { csvLine, CSV_BOM } from '../../util/csv.js';
import { cleanFolderPath, cleanText } from '../../servicemap/store.js';
import { sharedGather, sharedInputRev, bmKeyOf, pubKey, keyResolverFor, maskName, corpWriteAccess } from './svcInventory.js';
import { buildFolders, searchMembers, parseTokens, srcClassOf } from '../../bmfolders/build.js';
import {
  storeLoadError, storeRev, peekMain, peekAssign, mutateMain, mutateAssign, flushStore, resetCorrupt,
  LIMITS, newRuleId, underPath, ancestorsOf, isMemberKey,
} from '../../bmfolders/store.js';

const toolsPerm = requirePerm('tools');
const csvPerm = requirePerm('data.csv');
const writeRole = requireRole('admin', 'operator');
const t = (v) => (typeof v === 'string' ? v.trim() : (typeof v === 'number' ? String(v) : ''));
const lc = (v) => t(v).toLowerCase();

const writerOk = (user) => ['admin', 'operator'].includes(user?.role) && !isDemoGuest(user);
function writeKeyOf(user, snap) {
  if (!writerOk(user)) return 'none';
  const w = writeScopedVcenterIds(user, snap);
  return w ? [...w].sort().join(',') : 'all';
}
const inSnap = (snap, vc) => (snap?.vcenters || []).some((v) => t(v.id) === t(vc));
const writableOf = (user, snap, vc) => writerOk(user) && inSnap(snap, vc) && inUserWriteScope(user, snap, vc);
/** 전 법인 설정 — 조회 ∧ 쓰기 무제한 관리자만(server/CLAUDE.md v2.733 · v2.904 — 조회 범위만 보면 writeVcenters 관리자가 통과한다). */
const fleetAdmin = (user, snap) => {
  if (!isAdminDetailUser(user) || scopedVcenterIds(user, snap)) return false;
  try { return !writeScopedVcenterIds(user, snap); } catch { return false; }
};
const unreadable = (res) => res.status(503).json({ ok: false, error: 'registryUnreadable', reason: '물리서버 폴더 저장소를 읽지 못했습니다 — 빈 트리로 시작하지 않습니다(백업에서 복원하거나 전체 범위 관리자가 초기화).' });

// ───────── 입력: 서비스 인벤토리 입력 수집에서 베어메탈 + ESXi 호스트 ─────────
/** 구성원 목록(베어메탈 전부 + ESXi 호스트 전부 — ESXi 는 폴더에 넣은 것만 화면에 나온다). */
export function membersOf(g) {
  const out = [];
  const seen = new Set();
  let dupKeys = 0;
  for (const m of g?.members || []) {
    if (m?.kind !== 'bm') continue;
    if (seen.has(m.key)) { dupKeys += 1; continue; }
    seen.add(m.key);
    out.push({
      key: m.key, keyKind: m.keyKind, kind: 'bm', corp: t(m.corp), name: t(m.name), nameIsAddr: !!m.nameIsAddr, serviceTag: t(m.serviceTag), model: t(m.model),
      source: t(m.source), remoteAgent: t(m.remoteAgent), collectorId: t(m.collectorId), powered: m.powered ?? null, usage: m.usage || { state: 'unread' },
      faults: m.faults ?? null, watts: m.watts ?? null, cores: m.cores ?? null, memGB: m.memGB ?? null,
    });
  }
  for (const h of g?.hostByKey?.values?.() || []) {
    // 키는 서비스 인벤토리 bmKeyOf 와 같은 규칙(태그 → st:) — 같은 박스가 베어메탈로 분류가 바뀌어도 같은 키다.
    // 태그가 없으면 **법인을 붙인 이름**의 해시(반증 4: 이름만이면 두 법인의 같은 이름(사설 IP 재사용) 호스트가 한 키로 겹쳐 한쪽이 사라졌다).
    const { key, keyKind } = bmKeyOf({ serviceTag: h.serviceTag, fleetId: `host:${t(h.corp)}:${t(h.name)}` });
    if (seen.has(key)) { dupKeys += 1; continue; }
    seen.add(key);
    out.push({
      key, keyKind, kind: 'esxi', corp: t(h.corp), name: t(h.name), nameIsAddr: false, serviceTag: t(h.serviceTag), model: t(h.model), source: 'vcenter',
      remoteAgent: '', collectorId: '', powered: null, usage: h.usage ? { state: h.usage.state, cpuPct: h.usage.cpuPct, memPct: h.usage.memPct } : { state: 'unread' },
      faults: h.faults ?? null, watts: h.watts ?? null, cores: null, memGB: null,
    });
  }
  return { members: out, dupKeys };
}

async function stateFor(req, snap) {
  const g = await sharedGather(snap);
  const { members, dupKeys } = membersOf(g);
  const allowed = scopedVcenterIds(req.user, snap);
  const admin = isAdminDetailUser(req.user);
  const holdCorps = new Set(g.corpHold instanceof Map ? [...g.corpHold.keys()] : []);
  const b = buildFolders({ members, main: peekMain(), assign: peekAssign(), allowed, bmBlocked: !!g.bmBlocked, holdCorps, snapInitial: !!g.snapInitial,
    nameFn: (m) => nameOf(m, admin, !!allowed) });
  return { g, members, dupKeys, allowed, b };
}

/** 이름 — 주소 가림(비관리자) · 태그 가림(범위 계정). 서비스 인벤토리 maskName 그대로(ESXi 도 같은 기준으로 본다). */
const nameOf = (m, admin, hide) => maskName({ ...m, kind: 'bm' }, admin, hide);
/** 목록에서 사라진 등록의 이름 — 등록 순간 이름(태그는 키에서 꺼내 가린다). */
const missingName = (x, admin, hide) => {
  const tag = x.key.startsWith('st:') ? x.key.slice(3) : '';
  // key 를 꼭 넘긴다 — 이름이 곧 태그면 maskName 이 키 토큰으로 이름을 만든다(반증 1: key 없이 불러 범위 계정 메인 조회가 500 이었다)
  return nameOf({ key: x.key, name: x.name || '(이름 모름)', serviceTag: tag, nameIsAddr: x.addr === true }, admin, hide);
};

function serverRow(m, p, admin, hide) {
  return {
    key: pubKey(m.key, hide), kind: m.kind, corp: m.corp, name: nameOf(m, admin, hide), serviceTag: hide ? undefined : m.serviceTag, model: m.model,
    src: srcClassOf(m), agent: hide ? undefined : (m.remoteAgent || (m.collectorId ? `수집 서버 ${m.collectorId}` : '')),
    path: p?.path || '', place: p?.src || null, moved: p?.moved ? true : undefined,
    powered: m.powered, usage: m.usage?.state || 'unread', cpu: m.usage?.cpuPct ?? null, mem: m.usage?.memPct ?? null,
    watts: m.watts ?? null, faults: m.faults ?? null, cores: m.cores ?? null, memGB: m.memGB ?? null,
  };
}

/** 범위 안에서 보이는 규칙 — 그 법인 규칙 + 전 법인('*') 규칙(범위 계정은 읽기만). */
const visibleRules = (main, allowed) => (main.rules || []).filter((r) => r.corp === '*' || !allowed || allowed.has(r.corp));

export function registerBmFolders(api) {
  // ── 메인: 트리 · 법인별 현황 · 서버 · 보류/없어짐 · 미분류 묶음 ──
  api.get('/tools/bm-folders', toolsPerm, async (req, res) => {
    const snap = store.get();
    if (storeLoadError()) {
      return res.status(503).json({ ok: false, error: 'registryUnreadable', canReset: fleetAdmin(req.user, snap),
        reason: '물리서버 폴더 저장소를 읽지 못했습니다 — 빈 트리로 시작하지 않고 쓰기를 막았습니다(백업에서 복원하거나 전체 범위 관리자가 초기화).' });
    }
    const admin = isAdminDetailUser(req.user);
    const extraKey = `${scopeKey(req.user, snap)}|w${writeKeyOf(req.user, snap)}|${admin ? 'a' : 'u'}|r${storeRev()}|i${sharedInputRev()}`;
    await memoJson(req, res, 'bm-folders', async (s) => {
      const { g, members, dupKeys, allowed, b } = await stateFor(req, s);
      const hide = !!allowed;
      const full = fleetAdmin(req.user, s);
      const main = peekMain();
      let edgeAt = new Map();
      if (!hide) {
        try { const { listEdgeFleet } = await import('../../central/fleet.js'); edgeAt = new Map(listEdgeFleet().map((e) => [e.agent, e.at || null])); } catch { edgeAt = new Map(); }
      }
      const servers = [];
      for (const m of members) {
        if (!m.corp ? hide || m.kind !== 'bm' : !(allowed ? allowed.has(m.corp) : true)) continue;
        const p = b.placeOf.get(m.key);
        if (m.kind !== 'bm' && !p?.src) continue;   // ESXi 는 폴더에 넣은 것만
        servers.push(serverRow(m, p, admin, hide));
      }
      return {
        ok: true, at: g.at, rev: storeRev(), scoped: hide, admin, canWrite: writerOk(req.user), canFleet: full,
        settings: { autoRules: b.autoRules },
        corps: b.corps.map((c) => ({
          ...c, name: g.corpNames?.get(c.vcenterId) || c.vcenterId, writable: writableOf(req.user, s, c.vcenterId),
          agents: hide ? [] : c.agents.map((a) => ({ agent: a, at: a.startsWith('collector:') ? null : (edgeAt.get(a) ?? null), expired: !a.startsWith('collector:') && !edgeAt.has(a) })),
        })).sort((a, b2) => a.name.localeCompare(b2.name, 'ko')),
        servers,
        missing: b.missing.map((x) => ({ key: pubKey(x.key, hide), corp: x.corp, path: x.path, name: missingName(x, admin, hide), state: x.state, why: x.why })),
        mismatch: b.mismatch.map((x) => ({ key: pubKey(x.key, hide), corp: x.corp, was: x.was, path: x.path })),
        noCorp: hide ? undefined : b.noCorp,
        prefixGroups: b.prefixGroups,
        rules: visibleRules(main, allowed).map((r) => ({ id: r.id, corp: r.corp, value: r.value, path: r.path, by: r.by, at: r.at, writable: r.corp === '*' ? full : writableOf(req.user, s, r.corp) })),
        // 베어메탈 출처 중 못 읽은 것 — 없어짐 판정을 미룬 이유. 사유 문구는 전체 범위 관리자만(서비스 인벤토리 3차 반증 2 와 같은 기준)
        // 범위 계정에는 함대 전체 개수를 싣지 않는다(반증 8) — 못 읽은 출처가 '있다' 만
        blocked: hide ? { any: !!(g.bmBlockedSources || []).length } : { n: (g.bmBlockedSources || []).length, sources: full ? (g.bmBlockedSources || []) : undefined },
        faultsMeta: g.faultsMeta || null,
        dupKeys: hide ? undefined : (dupKeys || 0),
        limits: { batch: LIMITS.batch, searchRows: LIMITS.searchRows, foldersPerCorp: LIMITS.foldersPerCorp, rules: LIMITS.rules, includeTokens: LIMITS.includeTokens },
      };
    }, { extraKey });
  });

  // ── 찾기(일괄 등록) — 읽기. GET 쿼리: inc=db,ora · exc=bak · fields=name,tag,model · kinds=bm,esxi · corp= · unassigned=1 ──
  api.get('/tools/bm-folders/search', toolsPerm, async (req, res) => {
    try {
      if (storeLoadError()) return unreadable(res);
      const snap = store.get();
      const corp = t(req.query.corp);
      if (corp && !inUserScope(req.user, snap, corp)) return res.status(404).json({ ok: false, error: 'not_found', reason: '법인(vCenter)을 찾지 못했습니다.' });
      const { members, allowed, b } = await stateFor(req, snap);
      const admin = isAdminDetailUser(req.user);
      const hide = !!allowed;
      const fl = new Set(String(req.query.fields ?? 'name').split(',').map((x) => x.trim()));
      const kd = new Set(String(req.query.kinds ?? 'bm').split(',').map((x) => x.trim()));
      const r = searchMembers(members, b.placeOf, {
        include: String(req.query.inc ?? '').slice(0, 1024), exclude: String(req.query.exc ?? '').slice(0, 1024),
        fields: { name: fl.has('name'), tag: fl.has('tag'), model: fl.has('model') }, kinds: { bm: kd.has('bm'), esxi: kd.has('esxi') },
        corp, allowed, unassignedOnly: req.query.unassigned === '1', hideTag: hide,
        // 이름은 화면에 보이는 이름(가린 이름)으로만 맞춘다 — 가린 부분(주소 · 태그)으로 맞혀 보는 길을 막는다
        nameFn: (m) => nameOf(m, admin, hide),
      });
      // 보이는 이름 → 키 토큰 순(반증 6: 원문 이름 순이면 가린 태그의 상대 순서가 드러났다)
      const vis = new Map(r.rows.map((x) => [x.m.key, nameOf(x.m, admin, hide)]));
      r.rows.sort((a, b) => vis.get(a.m.key).localeCompare(vis.get(b.m.key), 'ko') || (pubKey(a.m.key, hide) < pubKey(b.m.key, hide) ? -1 : 1));
      res.json({
        ok: true, total: r.total, shown: Math.min(r.total, LIMITS.searchRows), facets: r.facets, hideTag: hide,
        tokens: { include: parseTokens(String(req.query.inc ?? '').slice(0, 1024)), exclude: parseTokens(String(req.query.exc ?? '').slice(0, 1024)) },
        rows: r.rows.slice(0, LIMITS.searchRows).map((x) => ({ ...serverRow(x.m, x.place, admin, hide), on: x.on })),
      });
    } catch (e) { if (!res.headersSent) res.status(500).json({ ok: false, reason: String(e?.message || e).slice(0, 300) }); }
  });

  // ── CSV(범위 안 서버 + 폴더) ──
  api.get('/tools/bm-folders.csv', toolsPerm, csvPerm, async (req, res) => {
    try {
      if (storeLoadError()) return res.status(503).json({ ok: false, error: 'registryUnreadable', reason: '물리서버 폴더 저장소를 읽지 못해 내보내지 않았습니다(빈 폴더 기준 파일을 만들지 않습니다).' });
      const snap = store.get();
      const { g, members, allowed, b } = await stateFor(req, snap);
      const admin = isAdminDetailUser(req.user);
      const hide = !!allowed;
      const SRC = { central: '중앙', edge: '엣지', collector: '수집 서버' };
      const PLACE = { manual: '손 등록', rule: '자동 규칙' };
      const head = ['법인', '폴더', '이름', '종류', ...(hide ? [] : ['서비스 태그']), '모델', '받는 길', '등록 방식', '전원', 'CPU%', '메모리%', '전력(W)', '부품 장애'];
      const lines = [CSV_BOM + csvLine(head)];
      for (const m of members) {
        if (!m.corp ? hide || m.kind !== 'bm' : (allowed && !allowed.has(m.corp))) continue;
        const p = b.placeOf.get(m.key) || {};
        if (m.kind !== 'bm' && !p.src) continue;
        lines.push(csvLine([g.corpNames?.get(m.corp) || m.corp || '(법인 미지정)', p.src ? p.path.split('\\').join(' › ') : (m.corp ? '(미분류)' : ''), nameOf(m, admin, hide),
          m.kind === 'bm' ? '베어메탈' : 'ESXi 호스트', ...(hide ? [] : [m.serviceTag]), m.model, SRC[srcClassOf(m)], PLACE[p.src] || '',
          m.powered === true ? '켜짐' : m.powered === false ? '꺼짐' : '모름', m.usage?.cpuPct ?? '', m.usage?.memPct ?? '', m.watts ?? '', m.faults == null ? '' : m.faults]));
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="bm-folders-${todayStamp()}.csv"`);
      res.send(lines.join('\r\n'));
    } catch (e) { if (!res.headersSent) res.status(500).json({ ok: false, reason: String(e?.message || e).slice(0, 300) }); }
  });

  // ── 쓰기 연산 하나로 ──
  api.post('/tools/bm-folders/op', writeRole, toolsPerm, async (req, res) => {
    try {
      const snap = store.get();
      const user = req.user;
      if (isDemoGuest(user)) return res.status(403).json({ ok: false, error: 'forbidden', reason: '데모 계정은 바꿀 수 없습니다.' });
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
      const op = t(body.op);
      const who = user?.username || 'unknown';
      const audit = (target, detail) => logAudit({ user: who, action: `bm-folders.${op}`, target: String(target || '').slice(0, 200), detail: String(detail || '').slice(0, 900) });
      const done = (result) => {
        if (!flushStore()) return res.status(500).json({ ok: false, reason: '저장에 실패했습니다(디스크 쓰기) — 다시 시도하십시오.' });
        return res.json({ ok: true, rev: storeRev(), result });
      };
      const fail = (r) => res.status(r.status).json({ ok: false, reason: r.error });

      if (op === 'store.reset') {
        if (!fleetAdmin(user, snap)) return res.status(403).json({ ok: false, error: 'forbidden', reason: '초기화는 전체 범위 관리자만 할 수 있습니다.' });
        if (!storeLoadError()) return res.status(409).json({ ok: false, reason: '저장소가 정상입니다 — 초기화할 것이 없습니다.' });
        const r = resetCorrupt(); audit('bm-folders', `손상본 보존: ${r.moved.join(', ') || '(없음)'}`);
        return res.json({ ok: r.ok, rev: storeRev(), result: r });
      }
      // 두 파일을 함께 바꾸는 연산이 있으므로 하나라도 손상이면 전부 막는다(한쪽만 바뀌어 폴더와 등록이 어긋나지 않게)
      if (storeLoadError()) return unreadable(res);

      if (op === 'settings') {
        if (!fleetAdmin(user, snap)) return res.status(403).json({ ok: false, error: 'forbidden', reason: '자동 규칙 켜기 · 끄기는 전체 범위 관리자만 바꿀 수 있습니다(전 법인에 걸린다).' });
        if (typeof body.autoRules !== 'boolean') return res.status(400).json({ ok: false, reason: 'autoRules(참/거짓)를 지정하십시오.' });
        const before = peekMain().settings.autoRules;
        const r = mutateMain((d) => { d.settings = { ...d.settings, autoRules: body.autoRules }; return { result: { autoRules: body.autoRules } }; });
        if (!r.ok) return fail(r);
        audit('settings', `자동 규칙 ${before ? '켜짐' : '꺼짐'} → ${body.autoRules ? '켜짐' : '꺼짐'}`);
        return done(r.result);
      }

      if (op === 'rule.add' || op === 'rule.remove') {
        let rule = null;
        if (op === 'rule.remove') {
          rule = (peekMain().rules || []).find((x) => x.id === t(body.id)) || null;
          if (!rule || (rule.corp !== '*' && !inUserScope(user, snap, rule.corp))) return res.status(404).json({ ok: false, error: 'not_found', reason: '규칙을 찾지 못했습니다.' });
        }
        const corp = op === 'rule.add' ? t(body.corp) : rule.corp;
        if (corp === '*') {
          if (!fleetAdmin(user, snap)) return res.status(403).json({ ok: false, error: 'forbidden', reason: '전 법인 규칙은 전체 범위 관리자만 바꿀 수 있습니다.' });
        } else {
          const deny = corpWriteAccess(user, snap, corp);
          if (deny) return res.status(deny.status).json({ ok: false, error: deny.status === 403 ? 'forbidden' : 'not_found', reason: deny.reason });
        }
        if (op === 'rule.remove') {
          const r = mutateMain((d) => { d.rules = d.rules.filter((x) => x.id !== rule.id); return { result: { id: rule.id } }; });
          if (!r.ok) return fail(r);
          audit(rule.id, JSON.stringify({ corp: rule.corp, value: rule.value, path: rule.path }));
          return done(r.result);
        }
        const v = cleanText(body.value, LIMITS.ruleValue, { label: '규칙 값' });
        if (v.error) return res.status(400).json({ ok: false, reason: v.error });
        const p = cleanFolderPath(body.path);
        if (p.error || !p.value) return res.status(400).json({ ok: false, reason: p.error || '넣을 폴더를 지정하십시오.' });
        const r = mutateMain((d) => {
          if (d.rules.some((x) => x.corp === corp && lc(x.value) === lc(v.value) && x.path === p.value)) return { status: 409, error: '같은 규칙이 이미 있습니다.' };
          const id = newRuleId();
          d.rules.push({ id, corp, value: v.value, path: p.value, by: who, at: Date.now() });
          return { result: { id } };
        });
        if (!r.ok) return fail(r);
        audit(r.result.id, JSON.stringify({ corp, value: v.value, path: p.value }));
        return done({ ...r.result, autoRules: peekMain().settings.autoRules });
      }

      // 이하 등록 · 폴더 연산 — 지금 목록(판정 포함)이 필요하다
      const { members, allowed, b } = await stateFor(req, snap);
      const hide = !!allowed;

      if (op === 'assign' || op === 'unassign' || op === 'ghost.prune') {
        const rawKeys = Array.isArray(body.keys) ? body.keys : [];
        if (op !== 'ghost.prune' && !rawKeys.length) return res.status(400).json({ ok: false, reason: '서버를 고르십시오.' });
        if (rawKeys.length > LIMITS.batch) return res.status(400).json({ ok: false, reason: `한 번에 최대 ${LIMITS.batch}대까지 바꿉니다.` });
        const assign = peekAssign();
        const candidates = [...members.filter((m) => m.corp && (!allowed || allowed.has(m.corp))).map((m) => m.key),
          ...Object.entries(assign).filter(([, a]) => !allowed || allowed.has(a.corp)).map(([k]) => k)];
        const resolve = keyResolverFor(hide, candidates);
        const keys = [...new Set(rawKeys.map((k) => resolve(typeof k === 'string' ? k.slice(0, 200) : '')))];

        if (op === 'ghost.prune') {
          // 없어짐(출처를 다 읽었는데 목록에 없음)만 · 쓰기 범위 안만. 보류는 지우지 않는다. 실행은 미리 본 키 ∩ 지금 없어짐(그 사이 끼어든 키를 지우지 않게)
          const ghosts = b.missing.filter((x) => x.state === 'ghost' && inUserWriteScope(user, snap, x.corp)).map((x) => x.key);
          if (body.dry === true) return res.json({ ok: true, result: { keys: ghosts.slice(0, 5000).map((k) => pubKey(k, hide)), n: ghosts.length, held: b.missing.filter((x) => x.state === 'held').length } });
          const want = new Set(keys.filter(Boolean));
          const del = ghosts.filter((k) => want.has(k));
          if (!del.length) return done({ removed: 0 });
          const r = mutateAssign((d) => { for (const k of del) delete d.assign[k]; return { result: { removed: del.length } }; });
          if (!r.ok) return fail(r);
          audit(`${del.length}건`, del.slice(0, 20).join(', '));
          return done(r.result);
        }

        const skipped = { notFound: 0, noCorp: 0, readOnly: 0, otherCorp: 0, inOther: 0, same: 0, noFolder: 0, notAssigned: 0, otherCorpReg: 0, badKey: 0 };
        if (op === 'unassign') {
          const del = [];
          for (const k of keys) {
            const a = k ? assign[k] : null;
            if (!a) { skipped.notAssigned += 1; continue; }
            if (!inUserScope(user, snap, a.corp)) { skipped.notFound += 1; continue; }
            if (!writableOf(user, snap, a.corp)) { skipped.readOnly += 1; continue; }
            del.push(k);
          }
          if (!del.length && skipped.readOnly) return res.status(403).json({ ok: false, error: 'forbidden', reason: '고른 서버의 법인이 전부 조회 전용입니다(쓰기 범위 밖).' });
          if (!del.length) return done({ removed: 0, skipped });
          const r = mutateAssign((d) => { for (const k of del) delete d.assign[k]; return { result: { removed: del.length, skipped } }; });
          if (!r.ok) return fail(r);
          audit(`${del.length}대`, del.slice(0, 20).join(', '));
          return done(r.result);
        }

        // assign — 각 서버를 **자기 법인**의 path 폴더로. corp 를 주면 그 법인 서버만(폴더 화면의 옮기기).
        const p = cleanFolderPath(body.path);
        if (p.error || !p.value) return res.status(400).json({ ok: false, reason: p.error || '넣을 폴더를 지정하십시오.' });
        const onlyCorp = t(body.corp);
        if (onlyCorp) {
          const deny = corpWriteAccess(user, snap, onlyCorp);
          if (deny) return res.status(deny.status).json({ ok: false, error: deny.status === 403 ? 'forbidden' : 'not_found', reason: deny.reason });
        }
        const moveExisting = body.moveExisting === true;
        const createMissing = body.createMissing !== false;
        const main = peekMain();
        const known = new Map(b.corps.map((c) => [c.vcenterId, new Set(c.folders.map((f) => f.path))]));
        const plan = [];
        const newFolders = new Map();   // vc → Set(path)
        for (const k of keys) {
          const m = k ? b.byKey.get(k) : null;
          if (!m || (allowed && !allowed.has(m.corp))) { skipped.notFound += 1; continue; }
          if (!m.corp) { skipped.noCorp += 1; continue; }
          if (onlyCorp && m.corp !== onlyCorp) { skipped.otherCorp += 1; continue; }
          if (!writableOf(user, snap, m.corp)) { skipped.readOnly += 1; continue; }
          if (!isMemberKey(k)) { skipped.badKey += 1; continue; }   // 저장할 수 없는 키(반증 3 — 예전에는 added 로 세고 조용히 버렸다)
          const cur = assign[k];
          // 다른 법인에 남은 예전 등록(서버 귀속이 바뀜)은 그 법인에 쓸 수 있을 때만 덮어쓴다(반증 2 — unassign 은 막는데 assign 이 덮어썼다)
          if (cur && cur.corp !== m.corp && !writableOf(user, snap, cur.corp)) { skipped.otherCorpReg += 1; continue; }
          if (cur && cur.corp === m.corp && cur.path === p.value) { skipped.same += 1; continue; }
          if (cur && cur.corp === m.corp && !moveExisting) { skipped.inOther += 1; continue; }
          const has = known.get(m.corp)?.has(p.value) || (main.corps[m.corp]?.folders || []).includes(p.value) || newFolders.get(m.corp)?.has(p.value);
          if (!has) {
            if (!createMissing) { skipped.noFolder += 1; continue; }
            if (!newFolders.has(m.corp)) newFolders.set(m.corp, new Set());
            newFolders.get(m.corp).add(p.value);
          }
          plan.push({ k, corp: m.corp, name: m.name, addr: !!m.nameIsAddr });
        }
        if (!plan.length && skipped.readOnly && !onlyCorp) return res.status(403).json({ ok: false, error: 'forbidden', reason: '고른 서버의 법인이 전부 조회 전용입니다(쓰기 범위 밖).' });
        if (!plan.length) return done({ added: 0, skipped, newFolders: 0 });
        // 폴더(명시)를 먼저 — 등록과 같은 경로가 트리에 남도록. 넘치면 등록도 하지 않는다.
        const corpsTouched = [...new Set(plan.map((x) => x.corp))];
        const r1 = mutateMain((d) => {
          for (const vc of corpsTouched) {
            if (!d.corps[vc]) d.corps[vc] = { folders: [] };
            if (!d.corps[vc].folders.includes(p.value)) d.corps[vc].folders.push(p.value, ...ancestorsOf(p.value));
          }
          return { result: {} };
        });
        if (!r1.ok) return fail(r1);
        const now = Date.now();
        const r2 = mutateAssign((d) => { for (const x of plan) d.assign[x.k] = { corp: x.corp, path: p.value, name: x.name, ...(x.addr ? { addr: true } : {}), by: who, at: now }; return { result: {} }; });
        if (!r2.ok) return fail(r2);
        const nf = [...newFolders.values()].reduce((s, x) => s + x.size, 0);
        audit(`${p.value} ← ${plan.length}대`, JSON.stringify({ corps: corpsTouched, moveExisting, newFolders: nf, skipped, keys: plan.slice(0, 20).map((x) => x.k) }));
        return done({ added: plan.length, skipped, newFolders: nf, corps: corpsTouched.length });
      }

      // ── 폴더 연산(법인 하나) ──
      if (op === 'folder.add' || op === 'folder.rename' || op === 'folder.remove' || op === 'folder.copy') {
        const corp = t(op === 'folder.copy' ? body.to : body.corp);
        const deny = corpWriteAccess(user, snap, corp);
        if (deny) return res.status(deny.status).json({ ok: false, error: deny.status === 403 ? 'forbidden' : 'not_found', reason: deny.reason });
        const tree = b.corps.find((c) => c.vcenterId === corp);
        const existing = new Set((tree?.folders || []).map((f) => f.path));

        if (op === 'folder.copy') {
          const from = t(body.from);
          if (!from || from === corp || !inUserScope(user, snap, from)) return res.status(404).json({ ok: false, error: 'not_found', reason: '복사할 법인을 찾지 못했습니다.' });
          const src = (b.corps.find((c) => c.vcenterId === from)?.folders || []).map((f) => f.path);
          const add = src.filter((x) => !existing.has(x));
          if (!add.length) return done({ added: 0 });
          const r = mutateMain((d) => { if (!d.corps[corp]) d.corps[corp] = { folders: [] }; d.corps[corp].folders.push(...add); return { result: { added: add.length } }; });
          if (!r.ok) return fail(r);
          audit(`${from} → ${corp}`, `폴더 ${add.length}개 복사`);
          return done(r.result);
        }

        const p = cleanFolderPath(body.path);
        if (p.error || !p.value) return res.status(400).json({ ok: false, reason: p.error || '폴더를 지정하십시오.' });

        if (op === 'folder.add') {
          if (existing.has(p.value)) return res.status(409).json({ ok: false, reason: '같은 폴더가 이미 있습니다.' });
          const r = mutateMain((d) => { if (!d.corps[corp]) d.corps[corp] = { folders: [] }; d.corps[corp].folders.push(p.value); return { result: { path: p.value } }; });
          if (!r.ok) return fail(r);
          audit(`${corp}:${p.value}`, '폴더 만들기');
          return done(r.result);
        }

        if (!existing.has(p.value)) return res.status(404).json({ ok: false, error: 'not_found', reason: '폴더를 찾지 못했습니다(그 사이 바뀌었을 수 있습니다 — 새로고침).' });
        const assign = peekAssign();
        const underKeys = Object.entries(assign).filter(([, a]) => a.corp === corp && underPath(a.path, p.value)).map(([k]) => k);
        const corpRules = (peekMain().rules || []).filter((x) => x.corp === corp && underPath(x.path, p.value));
        const starRules = (peekMain().rules || []).filter((x) => x.corp === '*' && underPath(x.path, p.value)).length;

        if (op === 'folder.rename') {
          const nm = cleanText(body.name, 60, { label: '폴더 이름' });
          if (nm.error) return res.status(400).json({ ok: false, reason: nm.error });
          if (nm.value.includes('\\')) return res.status(400).json({ ok: false, reason: '폴더 이름에 \\ 를 쓸 수 없습니다.' });
          const segs = p.value.split('\\');
          const to = [...segs.slice(0, -1), nm.value].join('\\');
          if (to === p.value) return done({ path: to });
          if (existing.has(to)) return res.status(409).json({ ok: false, reason: '같은 이름의 폴더가 이미 있습니다.' });
          const swap = (x) => (underPath(x, p.value) ? to + x.slice(p.value.length) : x);
          const r1 = mutateMain((d) => {
            if (!d.corps[corp]) d.corps[corp] = { folders: [] };
            const set = new Set([...existing].map(swap));
            d.corps[corp].folders = [...set];
            d.rules = d.rules.map((x) => (x.corp === corp && underPath(x.path, p.value) ? { ...x, path: swap(x.path) } : x));
            return { result: {} };
          });
          if (!r1.ok) return fail(r1);
          if (underKeys.length) {
            const r2 = mutateAssign((d) => { for (const k of underKeys) d.assign[k] = { ...d.assign[k], path: swap(d.assign[k].path) }; return { result: {} }; });
            if (!r2.ok) return fail(r2);
          }
          audit(`${corp}:${p.value}`, `→ ${to} · 등록 ${underKeys.length} · 규칙 ${corpRules.length}`);
          return done({ path: to, moved: underKeys.length, rules: corpRules.length, starRules });
        }

        // folder.remove — 서버는 지우지 않고 (미분류)로 돌린다. 미리 본 대수와 다르면 지우지 않는다.
        if (body.expect != null && Number(body.expect) !== underKeys.length) {
          return res.status(409).json({ ok: false, reason: `폴더 안 등록이 미리 본 ${Number(body.expect)}대와 지금 ${underKeys.length}대가 다릅니다 — 새로고침 뒤 다시 확인하십시오.`, n: underKeys.length });
        }
        const r1 = mutateMain((d) => {
          if (d.corps[corp]) d.corps[corp].folders = d.corps[corp].folders.filter((x) => !underPath(x, p.value));
          d.rules = d.rules.filter((x) => !(x.corp === corp && underPath(x.path, p.value)));
          return { result: {} };
        });
        if (!r1.ok) return fail(r1);
        if (underKeys.length) {
          const r2 = mutateAssign((d) => { for (const k of underKeys) delete d.assign[k]; return { result: {} }; });
          if (!r2.ok) return fail(r2);
        }
        audit(`${corp}:${p.value}`, `폴더 삭제 · 미분류로 ${underKeys.length}대 · 법인 규칙 ${corpRules.length}개 삭제`);
        return done({ removed: underKeys.length, rules: corpRules.length, starRules });
      }

      return res.status(400).json({ ok: false, reason: `알 수 없는 연산입니다: ${op.slice(0, 40)}` });
    } catch (e) { if (!res.headersSent) res.status(500).json({ ok: false, reason: String(e?.message || e).slice(0, 300) }); }
  });
}

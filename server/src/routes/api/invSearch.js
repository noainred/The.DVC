/**
 * 헤더 ⌘K '통합 장비 검색' 라우트(v2.909) — GET /api/search/inventory?q=&kinds=
 *
 * 설계: docs/design/inventory-search/README.md(컨펌 2026-11-05). 판정은 search/ 세 모듈이 한다:
 *   색인(inventoryIndex — 관리자 판본 1개 · 30초) → 접근(inventoryAccess.accessPlan — 권한 · 도구 · 범위 · 가림) → 고르기(inventoryQuery).
 *
 *  - 라우트 자체는 인증된 누구나 부를 수 있고, **종류마다** 그 화면의 권한으로 거른다(권한 없는 종류는 칩도 행도 없다).
 *  - 범위 계정: vCenter 귀속 행만 · 전체 범위 전용 종류는 `locked`(개수 비노출) · 범위 밖은 개수에도 넣지 않는다.
 *  - 응답 캐시(memo)는 두지 않는다 — 검색어마다 다르고, 범위 판정을 응답마다 다시 하는 편이 캐시 키 실수(scopeKey 누락)보다 안전하다.
 *  - 출처 개수(sources.rows)는 범위와 무관한 전체 수라 싣지 않는다 — 종류별 개수는 이 사용자에게 보이는 행으로 다시 센다.
 *  - 감사 로그는 남기지 않는다(조회).
 */
import { store } from '../../store.js';
import { userHasPermission, userToolAllowed } from '../../auth/permissions.js';
import { inventoryIndex, scopedIpRows } from '../../search/inventoryIndex.js';
import { accessPlan, publicRow, LOCK_REASON_FULL_SCOPE } from '../../search/inventoryAccess.js';
import { parseQuery, searchRows, KINDS, KIND_KEYS, normSerial, QUERY_MAX, MIN_TEXT, MIN_FIELD, PER_KIND, TOTAL_MAX, TIER } from '../../search/inventoryQuery.js';
import { serialIndex } from '../../insights/serialLookup.js';

const PART_KINDS = new Set(['server-part', 'sanswitch-part']);

/**
 * v2.928(B4): `recent=vm|vc:vm-1,storage|st-1` — 이 계정이 최근 연 장비(웹 localStorage · 계정별). 순서 가산점에만 쓴다(이미 보이는 행 안에서).
 * 아는 종류 · 10개 · 항목 300자까지만. 이 값으로 행을 더하거나 범위를 바꾸지 않는다.
 */
export function parseRecent(v) {
  const raw = typeof v === 'string' ? v.slice(0, 4000) : '';
  const out = new Set();
  for (const part of raw.split(',')) {
    if (out.size >= 10) break;
    const s = part.trim().slice(0, 300);
    const i = s.indexOf('|');
    if (i > 0 && KIND_KEYS.includes(s.slice(0, i)) && i < s.length - 1) out.add(s);
  }
  return out.size ? out : null;
}

/** 일치 등급 → 화면 표지('태그' · '메모' 로 걸린 행은 그렇게 알린다 — 이름에 없는데 왜 나왔는지). */
const VIA = Object.freeze({ [TIER.tag]: 'tag', [TIER.notes]: 'notes', [TIER.recent]: 'recent' });

/** `kinds=vm,host` → 아는 키만 Set(모르면 무시). */
export function parseKinds(v) {
  const raw = typeof v === 'string' ? v : '';
  const set = new Set(raw.split(',').map((s) => s.trim()).filter((s) => KIND_KEYS.includes(s)));
  return set.size ? set : null;
}

let _scopedIp = scopedIpRows;
/** 테스트 전용 — 범위 계정 IP 행 출처를 바꾼다(null 이면 원래 것). */
export function _setScopedIpForTest(fn) { _scopedIp = typeof fn === 'function' ? fn : scopedIpRows; }

export function registerInvSearch(api) {
  api.get('/search/inventory', async (req, res) => {
    const pq = parseQuery(req.query.q);
    const snap = store.get();
    const plan = accessPlan(req.user, snap);
    const ok = KIND_KEYS.filter((k) => plan.kinds[k] === 'ok');
    let idx;
    try {
      // 강제 재생성(10초 스로틀)은 볼 수 있는 종류가 있는 계정만(반증 L-3 — 권한 0 계정이 재생성만 일으키지 않게).
      idx = await inventoryIndex({ force: req.query.refresh === '1' && ok.length > 0 });
    } catch (e) {
      return res.status(503).json({ error: 'index-unavailable', reason: '장비 색인을 만들지 못했습니다 — 잠시 뒤 다시 시도하세요.' });
    }
    let visible = idx.rows.filter(plan.visible);
    // 범위 계정의 IP 대장 행은 IP관리 화면과 같은 **범위 원장**에서(반증 L-2). 못 만들면 관리자 판본 행을 범위로 거른 것을 그대로 쓴다(그것도 범위 안이다).
    if (plan.allowed && plan.kinds.ip === 'ok') {
      try {
        const ipRows = await _scopedIp(snap, plan.allowed);
        visible = visible.filter((r) => r.kind !== 'ip').concat((ipRows || []).filter(plan.visible));
      } catch { /* 위 주석 */ }
    }
    const meta = {
      kinds: KINDS.filter((k) => plan.kinds[k.key]).map((k) => ({ key: k.key, label: k.label, prefix: k.prefix, ...(plan.kinds[k.key] === 'locked' ? { locked: true, reason: LOCK_REASON_FULL_SCOPE } : {}) })),
      // 못 읽은 출처 — 이 사용자가 볼 수 있는 종류의 것만(사유만, 개수 없이).
      errors: Object.fromEntries(ok.filter((k) => idx.sources?.[k]?.error).map((k) => [k, idx.sources[k].error])),
      builtAt: idx.builtAt, scoped: !!plan.allowed,
      addressHidden: !plan.admin && ok.some((k) => ['gpu', 'storage', 'sanswitch', 'netswitch', 'pdu', 'server'].includes(k)),
      limits: { queryMax: QUERY_MAX, minText: MIN_TEXT, minField: MIN_FIELD, perKind: PER_KIND, totalMax: TOTAL_MAX },
      // v2.928(D1): 색인 생성 실측(관리자 판본에게만 — 운영 규모 성능 확인용). 전체 행 수는 범위와 무관한 값이라 범위 · 비관리자에게 싣지 않는다.
      ...(plan.admin && !plan.allowed ? { index: { buildMs: idx.buildMs ?? null, yields: idx.yields ?? null, stepMs: idx.stepMs || null, rows: idx.rows.length } } : {}),
    };
    if (!pq.needle || pq.tooLong) {
      const counts = Object.fromEntries(ok.map((k) => [k, 0]));
      for (const r of visible) counts[r.kind] = (counts[r.kind] || 0) + 1;
      return res.json({ q: '', mode: pq.mode, kind: pq.kind, tooLong: pq.tooLong, groups: [], counts, shown: 0, matched: 0, omitted: 0, ...meta });
    }
    const out = searchRows(visible, pq, { kinds: parseKinds(req.query.kinds), addrSearchable: plan.addrSearchable, tagsOk: plan.tagsSearchable, recent: parseRecent(req.query.recent) });
    // sn: 은 장비만(컨펌 ⑤) — 부품 시리얼은 개수만 세어 '시리얼 조회' 로 넘긴다. 그 화면을 쓸 수 있는 계정에게만.
    let partsMatched;
    if (pq.mode === 'sn' && !pq.tooShort && !plan.allowed && userHasPermission(req.user, 'tools') && userToolAllowed(req.user, 'serial-lookup')) {
      try {
        const sn = normSerial(pq.needle);
        partsMatched = sn ? serialIndex(req).rows.filter((r) => PART_KINDS.has(r.kind) && r.key.includes(sn)).length : 0;
      } catch { partsMatched = undefined; }
    }
    res.json({
      q: pq.text, mode: pq.mode, kind: pq.kind, tooShort: pq.tooShort,
      groups: out.groups.map((g) => ({ kind: g.kind, total: g.total, rows: g.rows.map((r, i) => {
        const pr = publicRow(r, plan);
        const via = VIA[g.tiers?.[i]];
        if (via) pr.via = via;
        if (via === 'tag' && plan.tagsSearchable && r.tags) pr.tags = r.tags.filter((t) => t.toLowerCase().includes(pq.needle)).slice(0, 3);
        return pr;
      }) })),
      counts: Object.fromEntries(ok.map((k) => [k, out.counts[k] || 0])),
      shown: out.shown, matched: out.matched, omitted: out.omitted,
      ...(partsMatched != null ? { partsMatched } : {}),
      ...meta,
    });
  });
}

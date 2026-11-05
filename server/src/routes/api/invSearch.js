/**
 * 헤더 ⌘K '통합 장비 검색' 라우트(v2.908) — GET /api/search/inventory?q=&kinds=
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
import { inventoryIndex } from '../../search/inventoryIndex.js';
import { accessPlan, publicRow, LOCK_REASON_FULL_SCOPE } from '../../search/inventoryAccess.js';
import { parseQuery, searchRows, KINDS, KIND_KEYS, normSerial, QUERY_MAX, MIN_TEXT, MIN_FIELD, PER_KIND, TOTAL_MAX } from '../../search/inventoryQuery.js';
import { serialIndex } from '../../insights/serialLookup.js';

const PART_KINDS = new Set(['server-part', 'sanswitch-part']);

/** `kinds=vm,host` → 아는 키만 Set(모르면 무시). */
export function parseKinds(v) {
  const raw = typeof v === 'string' ? v : '';
  const set = new Set(raw.split(',').map((s) => s.trim()).filter((s) => KIND_KEYS.includes(s)));
  return set.size ? set : null;
}

export function registerInvSearch(api) {
  api.get('/search/inventory', async (req, res) => {
    const pq = parseQuery(req.query.q);
    const snap = store.get();
    const plan = accessPlan(req.user, snap);
    let idx;
    try {
      idx = await inventoryIndex({ force: req.query.refresh === '1' });
    } catch (e) {
      return res.status(503).json({ error: 'index-unavailable', reason: '장비 색인을 만들지 못했습니다 — 잠시 뒤 다시 시도하세요.' });
    }
    const visible = idx.rows.filter(plan.visible);
    const ok = KIND_KEYS.filter((k) => plan.kinds[k] === 'ok');
    const meta = {
      kinds: KINDS.filter((k) => plan.kinds[k.key]).map((k) => ({ key: k.key, label: k.label, prefix: k.prefix, ...(plan.kinds[k.key] === 'locked' ? { locked: true, reason: LOCK_REASON_FULL_SCOPE } : {}) })),
      // 못 읽은 출처 — 이 사용자가 볼 수 있는 종류의 것만(사유만, 개수 없이).
      errors: Object.fromEntries(ok.filter((k) => idx.sources?.[k]?.error).map((k) => [k, idx.sources[k].error])),
      builtAt: idx.builtAt, scoped: !!plan.allowed,
      addressHidden: !plan.admin && ok.some((k) => ['gpu', 'storage', 'sanswitch', 'netswitch', 'pdu', 'server'].includes(k)),
      limits: { queryMax: QUERY_MAX, minText: MIN_TEXT, minField: MIN_FIELD, perKind: PER_KIND, totalMax: TOTAL_MAX },
    };
    if (!pq.needle || pq.tooLong) {
      const counts = Object.fromEntries(ok.map((k) => [k, 0]));
      for (const r of visible) counts[r.kind] = (counts[r.kind] || 0) + 1;
      return res.json({ q: '', mode: pq.mode, kind: pq.kind, tooLong: pq.tooLong, groups: [], counts, shown: 0, matched: 0, omitted: 0, ...meta });
    }
    const out = searchRows(visible, pq, { kinds: parseKinds(req.query.kinds), addrSearchable: plan.addrSearchable });
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
      groups: out.groups.map((g) => ({ kind: g.kind, total: g.total, rows: g.rows.map((r) => publicRow(r, plan)) })),
      counts: Object.fromEntries(ok.map((k) => [k, out.counts[k] || 0])),
      shown: out.shown, matched: out.matched, omitted: out.omitted,
      ...(partsMatched != null ? { partsMatched } : {}),
      ...meta,
    });
  });
}

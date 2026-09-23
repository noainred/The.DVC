// 자연어 검색 + 릴리스 노트 — api.js(구 2,445줄) 분할(v2.283.0). 본문은 원본 그대로, 등록 순서는 api.js 호출 순서가 보존한다.
import { scopedVcenterIds } from '../../auth/scope.js';
import { store } from '../../store.js';
import { currentVersion } from '../../config.js';
import { listNotes } from '../../release-notes.js';
import { nlSearch, NL_ENTITY_PERM } from '../../llm/nlSearch.js';
import { userHasPermission } from '../../auth/permissions.js';

// v2.583: 자연어 검색 결과 종류 → 필요한 조회 권한(inv.* — v2.536 집행과 같은 축). v2.591: 표는 nlSearch.js 하나가 소유한다.
const NL_PERM = NL_ENTITY_PERM;

export function registerSearchNotes(api) {

// Natural-language search (local LLM interprets → query runs on local data).
api.post('/search/nl', async (req, res) => {
  const query = String((req.body || {}).query || '').trim();
  if (!query) return res.status(400).json({ error: 'query is required' });
  try {
    const out = await nlSearch(query, scopedVcenterIds(req.user, store.get()));
    // v2.583(감사 확정): 결과가 원본 객체 목록이라 inv.* 집행(v2.536)을 우회했다 — 그 종류의 조회 권한이 없으면 403.
    const need = NL_PERM[out?.entity];
    if (need && !userHasPermission(req.user, need)) {
      return res.status(403).json({ error: 'forbidden', requiredPerm: need, reason: `이 검색 결과(${out.label || out.entity})를 볼 권한(${need})이 없습니다.` });
    }
    res.json(out);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Release notes (built-in changelog + admin-recorded), newest first.
api.get('/release-notes', (_req, res) => {
  res.json({ current: currentVersion(), notes: listNotes() });
});
}

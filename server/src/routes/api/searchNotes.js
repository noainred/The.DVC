// 자연어 검색 + 릴리스 노트 — api.js(구 2,445줄) 분할(v2.283.0). 본문은 원본 그대로, 등록 순서는 api.js 호출 순서가 보존한다.
import { scopedVcenterIds } from '../../auth/scope.js';
import { store } from '../../store.js';
import { currentVersion } from '../../config.js';
import { listNotes } from '../../release-notes.js';
import { nlSearch } from '../../llm/nlSearch.js';

export function registerSearchNotes(api) {

// Natural-language search (local LLM interprets → query runs on local data).
api.post('/search/nl', async (req, res) => {
  const query = String((req.body || {}).query || '').trim();
  if (!query) return res.status(400).json({ error: 'query is required' });
  try { res.json(await nlSearch(query, scopedVcenterIds(req.user, store.get()))); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Release notes (built-in changelog + admin-recorded), newest first.
api.get('/release-notes', (_req, res) => {
  res.json({ current: currentVersion(), notes: listNotes() });
});
}

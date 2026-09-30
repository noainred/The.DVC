/**
 * bmusage/cpuLatest.js — 베어메탈 사용률(bmusage)의 **최신 CPU 행** 모음(중앙 DB + 중앙이 가져온 엣지 보관분).
 *
 * v2.659 서버 온도 › 센서 상세 라우트에 있던 `cpuRows()` 를 옮겼다(v2.661) — iDRAC 통합 추이의 CPU 사용률 대체값도
 * **같은 행·같은 신선도 기준**을 써야 두 화면의 숫자가 갈라지지 않는다(CLAUDE.md '코어는 하나다').
 *
 * 신선도: 행마다 `_freshMs` = max(30분, 수집 주기 × 3). 엣지 행은 그 엣지 설정의 주기로 판정한다.
 * 실패는 삼키지 않고 `error` 로 돌려준다(호출부가 화면에 밝힌다).
 */
import { numOrNull } from '../util/numOrNull.js';

export const freshOfInterval = (ms) => Math.max(30 * 60_000, 3 * (numOrNull(ms) || 300_000));

export async function cpuLatestRows() {
  const out = { rows: [], bmEnabled: null, error: '' };
  try {
    const [{ latestUsage }, { loadBmUsageSettings, bmUsageEnabled }, edge] = await Promise.all([
      import('./db.js'), import('./settings.js'), import('../central/bmUsageEdgePull.js'),
    ]);
    const central = await latestUsage().catch(() => []);
    let s = null; try { s = loadBmUsageSettings(); } catch { s = null; }
    try { out.bmEnabled = typeof bmUsageEnabled === 'function' ? !!bmUsageEnabled(s) : !!s?.enabled; } catch { out.bmEnabled = null; }
    const edges = (() => { try { return edge.listEdgeBmUsage(); } catch { return []; } })();
    const edgeRows = edges.flatMap((e) => (e?.snap?.rows || []).filter((r) => r && typeof r === 'object').map((r) => ({ ...r, _freshMs: freshOfInterval(e?.snap?.settings?.intervalMs) })));
    out.rows = [...central.map((r) => ({ ...r, _freshMs: freshOfInterval(s?.intervalMs) })), ...edgeRows];
  } catch (e) { out.error = String(e?.message || e).slice(0, 200); }
  return out;
}

/**
 * 시리얼 통합 조회 라우트(v2.412) — 특수기능 '시리얼 조회'.
 *
 * 접근: **전체 범위 계정만**(fullScopeOnly). 이 응답은 스토리지·SAN 스위치·엣지 베어메탈처럼
 * vCenter 귀속이 없는 장비를 포함하므로, 범위 제한 계정에 노출하면 'vCenter 귀속 없는 데이터는
 * 범위 계정에 노출 금지'(server/CLAUDE.md) 를 어긴다. 또한 클라이언트가 준 시리얼로 장비를
 * 되찾는 형태라, 범위 계정에 열어 두면 시리얼 대입으로 범위 밖 자산을 열거할 수 있다
 * (vmMetrics.js 의 serviceTag 우회 선례와 같은 모양).
 */
import { requireRole, requirePerm } from '../../auth/auth.js';
import { scopedVcenterIds } from '../../auth/scope.js';
import { store } from '../../store.js';
import { logAudit } from '../../audit.js';
import { KINDS, serialIndex, searchSerials } from '../../insights/serialLookup.js';
import { csvLine, CSV_BOM } from '../../util/csv.js';
import { todayStamp } from "../../util/dayKey.js";

const toolsPerm = requirePerm('tools'); // 조회 라우트 기능 권한(v2.416 감사 L-3)
const fullScopeOnly = (req, res, next) => {
  if (scopedVcenterIds(req.user, store.get())) {
    return res.status(403).json({ ok: false, reason: '시리얼 조회는 전체 범위(vCenter 제한 없는) 계정만 사용할 수 있습니다.' });
  }
  next();
};

const CSV_COLS = [
  ['serial', '시리얼'], ['serialType', '항목'], ['kindLabel', '장비 종류'],
  ['deviceName', '장비'], ['hostname', '장비 보고 이름'], ['host', '주소'],
  ['model', '모델'], ['vendor', '제조사'], ['part', '부품'], ['partModel', '부품 모델'],
  ['partLocation', '위치'], ['datacenterId', '법인'], ['vcenterId', 'vCenter'], ['agent', '수집'],
];

export function registerSerialLookup(api) {

/**
 * 조회. q 없으면 **종류별 수집 현황만** 돌려준다(전체 수만 행을 그냥 쏟지 않는다).
 * q 는 대소문자와 구분자(`:`·`-`·공백)를 무시하고 부분 일치한다.
 */
api.get('/tools/serial-lookup', toolsPerm, fullScopeOnly, (req, res) => {
  const q = String(req.query.q || '').trim();
  const kinds = String(req.query.kinds || '').split(',').map((s) => s.trim()).filter(Boolean);
  const idx = serialIndex(req, { force: req.query.refresh === '1' });
  const labelOf = new Map(KINDS.map((k) => [k.key, k.label]));

  const counts = {};
  for (const r of idx.rows) counts[r.kind] = (counts[r.kind] || 0) + 1;
  const base = {
    ok: true, kinds: KINDS, counts, sources: idx.sources,
    total: idx.rows.length, builtAt: idx.at,
    // 고유 시리얼 개수 — 같은 장비가 서비스태그/시리얼/자산태그로 여러 행을 만들기 때문에
    // '행 수 = 장비 수'가 아니다. 오해하지 않도록 둘 다 준다.
    uniqueSerials: new Set(idx.rows.map((r) => r.key)).size,
  };
  if (!q) return res.json({ ...base, query: '', rows: [], matched: 0 });

  const r = searchSerials(idx.rows, q, { kinds, limit: 500 });
  res.json({ ...base, query: q, matched: r.total, truncated: r.truncated,
    rows: r.rows.map((x) => ({ ...x, kindLabel: labelOf.get(x.kind) || x.kind })) });
});

/** 검색 결과 CSV 내보내기(자산 대조·RMA 목록 작성용). 감사로그를 남긴다. */
api.get('/tools/serial-lookup/export.csv', toolsPerm, fullScopeOnly, (req, res) => {
  const q = String(req.query.q || '').trim();
  const kinds = String(req.query.kinds || '').split(',').map((s) => s.trim()).filter(Boolean);
  const idx = serialIndex(req);
  const labelOf = new Map(KINDS.map((k) => [k.key, k.label]));
  const kindSet = kinds.length ? new Set(kinds) : null;
  const rows = q
    ? searchSerials(idx.rows, q, { kinds, limit: 100_000 }).rows
    : idx.rows.filter((r) => !kindSet || kindSet.has(r.kind));
  logAudit({ user: req.user?.username, action: '시리얼 조회 CSV 내보내기',
    target: q ? `검색 '${q}'` : '전체', detail: `${rows.length}행` });
  // csvLine 은 수식 인젝션 가드(=,+,-,@ 로 시작하는 셀)를 포함한다 — 시리얼은 대개 안전하지만
  // 장비명·메모가 사용자 입력이라 공용 헬퍼를 쓴다.
  const lines = [csvLine(CSV_COLS.map(([, h]) => h))];
  for (const r of rows) {
    lines.push(csvLine(CSV_COLS.map(([k]) => (k === 'kindLabel' ? (labelOf.get(r.kind) || r.kind) : (r[k] ?? '')))));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="serials-${todayStamp()}.csv"`);
  res.send(CSV_BOM + lines.join('\r\n')); // BOM — 엑셀이 UTF-8 한글을 깨지 않게
});

}

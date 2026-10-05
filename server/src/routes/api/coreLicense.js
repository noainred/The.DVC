/**
 * routes/api/coreLicense.js — 특수 기능 '코어 라이선스 산정'(도구 키 `core-license`, v2.703 — A13).
 * 스냅샷만 읽는다(vCenter 왕복 0) · tools + toolGate + vCenter 범위 · CSV 는 data.csv + 감사 로그.
 */
import { requirePerm } from '../../auth/auth.js';
import { logAudit } from '../../audit.js';
import { store } from '../../store.js';
import { scopedVcenterIds } from '../../auth/scope.js';
import { memoJson, scopeKey } from './shared.js';
import { csvLine, CSV_BOM } from '../../util/csv.js';
import { fileStamp } from '../../util/dayKey.js';
import { analyzeCoreLicense, VSAN_TIB_PER_CORE } from '../../corelicense/analyze.js';

const toolsPerm = requirePerm('tools');
const csvPerm = requirePerm('data.csv');
const planOf = (v) => (typeof v === 'string' && Object.hasOwn(VSAN_TIB_PER_CORE, v) ? v : 'none');

function idsFor(req, snap) {
  const allowed = scopedVcenterIds(req.user, snap);
  let ids = (snap.vcenters || []).map((v) => v.id);
  if (allowed) ids = ids.filter((id) => allowed.has(id));
  const want = typeof req.query.vcenterId === 'string' ? req.query.vcenterId : '';
  if (want) ids = ids.filter((id) => id === want);
  return ids;
}

export function registerCoreLicense(api) {
  api.get('/tools/core-license', toolsPerm, (req, res) => memoJson(req, res, 'core-license', (snap) => ({
    ...analyzeCoreLicense(snap, { vcenterIds: idsFor(req, snap), vsanPlan: planOf(req.query.vsan) }),
    initial: snap.initial === true,
  }), { ttlMs: 12_000, extraKey: scopeKey(req.user, store.get()) }));

  api.get('/tools/core-license.csv', csvPerm, toolsPerm, (req, res) => {
    const snap = store.get();
    const r = analyzeCoreLicense(snap, { vcenterIds: idsFor(req, snap), vsanPlan: planOf(req.query.vsan) });
    const vcName = new Map((snap.vcenters || []).map((v) => [v.id, v.name || v.id]));
    const lines = [CSV_BOM + csvLine(['vCenter', '호스트', '클러스터', '소켓', '물리 코어', '소켓당 코어', '라이선스 코어', '최소 16코어로 더한 코어', '비고'])];
    for (const h of r.hosts) {
      lines.push(csvLine([vcName.get(h.vcenterId) || h.vcenterId, h.name, h.cluster || '', h.sockets ?? '', h.cores ?? '', h.unknown ? '' : h.perSocket, h.unknown ? '' : h.licensed, h.unknown ? '' : h.padded, h.unknown ? '소켓·코어 수를 읽지 못해 산정 안 함' : '']));
    }
    if (r.hostsOmitted) lines.push(csvLine([`(상한으로 ${r.hostsOmitted}대 생략)`]));
    logAudit({ user: req.user?.username, action: 'core-license.csv', target: 'hosts', detail: `${r.hosts.length} rows`, ip: req.ip });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="core-license-${fileStamp()}.csv"`);
    res.send(lines.join('\r\n'));
  });
}

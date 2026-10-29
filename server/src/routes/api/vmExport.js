// 특수 기능 'VM 전체 정보 내보내기' 라우트(v2.799 — ipamExport.js 에서 옮겼다 · 시안 https://claude.ai/artifact/FCUJ73AgKCxpzcr4J6Y6TC).
//
// 게이트(전부 같은 것): data.csv(관리자 이상 — 웹 canCsv 와 같은 판정) + tools(vm-export 도구 키) · vCenter 단위 조회 범위 밖은 404
// (존재 여부 미노출 — v2.207 규칙). 저장값 바꾸기는 관리자·운영자 + 데모 손님 불가 + 감사. 무거운 내려받기(CSV·엑셀)는 동시 1건 + 감사.
//   · GET  /tools/vm-export/catalog   항목·빠른 조합(카탈로그 하나 — 웹은 복제하지 않는다) + 그 vCenter 의 출처 상태 + 내 저장값
//   · POST /tools/vm-export/preview   고른 항목으로 대상 첫 3대(실시간은 부르지 않는다 — 실시간 칸은 '내려받을 때 조회')
//   · POST /tools/vm-export.{csv,xlsx} 고른 항목 · 대상 · 표기 방식 · 실시간 보강
//   · GET|PUT|DELETE /tools/vm-export/prefs 내 저장값(계정 = 인증된 사용자 이름 — 본문 값을 믿지 않는다)
//   · (호환) GET /tools/vm-export.csv = '예전 CSV 그대로' + 실시간 보강 · GET /tools/vm-export = 예전 열 미리보기 100행(실시간 없음)
import { requirePerm, requireRole } from '../../auth/auth.js';
import { inUserScope } from '../../auth/scope.js';
import { isDemoGuest } from '../../auth/demoGuest.js';
import { store } from '../../store.js';
import { logAudit } from '../../audit.js';
import { csvLine, CSV_BOM } from '../../util/csv.js';
import { createYielder } from '../../util/timeSlice.js';
import { acquireExport } from '../../util/exportBusy.js';
import { fileStamp } from '../../util/dayKey.js';
import { buildVmExportTable, vmExportStatus, LEGACY_KEYS } from '../../vcenter/vmExport.js';
import { catalogView, resolveCols, GROUPS, tzName } from '../../vcenter/vmExportCatalog.js';
import { getPrefs, setPref, clearPref, DISK_MODES, TARGETS, FOLDER_MAX } from '../../vcenter/vmExportPrefs.js';
import { renderVmExportWorkbook, XLSX_MIME, liveResultText } from '../../vcenter/vmExportXlsx.js';
import { veeamVmViews } from '../../veeam/vmViewProvider.js';   // v2.801 Veeam 묶음 — veeam 라우트가 건 vcBackup → vmBackupView(VM 목록과 같은 판정)
import { YN_DAYS, ynDaysOf } from '../../veeam/backupStatus.js';
import { LOOKBACK_DAYS } from '../../veeam/snapEvents.js';

const csvPerm = requirePerm('data.csv');
const toolsPerm = requirePerm('tools');
const PREVIEW_ROWS = 3;
export const PREVIEW_MAX = 100;   // v2.801 '크게 보기'(전체 화면 팝업) — 본문 rows 로 3~100
const GROUP_NAMES = Object.freeze(Object.fromEntries(GROUPS.map((g) => [g.id, g.name])));
const TARGET_TEXT = Object.freeze({ all: '전체 VM', on: '켜진 VM', folder: '고른 폴더' });

/** vCenter 단위 사용자 scope 를 먼저 강제하고, 범위 밖은 404(존재 여부 미노출). */
function vcOf(req, res) {
  const vcenterId = String(req.query.vcenterId || '');
  const snap = store.get();
  if (!vcenterId || !(snap.vcenters || []).some((v) => v.id === vcenterId) || !inUserScope(req.user, snap, vcenterId)) {
    res.status(404).json({ ok: false, error: 'vCenter를 찾을 수 없습니다.', reason: 'vCenter를 찾을 수 없습니다.' });
    return null;
  }
  return vcenterId;
}

const objOf = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
/**
 * 본문의 선택 → buildVmExportTable 인자. 모르는 항목·형식은 400(조용히 버리지 않는다).
 * @returns {{ok:true, sel:object} | {ok:false, reason:string}}
 */
export function selOf(body) {
  const b = objOf(body);
  const c = resolveCols(b.cols);
  if (!c.ok) return c;
  if (b.disk !== undefined && !DISK_MODES.includes(b.disk)) return { ok: false, reason: '디스크 표기 방식이 잘못됐습니다.' };
  if (b.target !== undefined && !TARGETS.includes(b.target)) return { ok: false, reason: '대상이 잘못됐습니다.' };
  if (b.ynDays !== undefined && !YN_DAYS.includes(b.ynDays)) return { ok: false, reason: '‘여부’ 기준 일수가 잘못됐습니다.' };
  // eslint-disable-next-line no-control-regex
  if (b.folder !== undefined && (typeof b.folder !== 'string' || b.folder.length > FOLDER_MAX || /[\x00-\x1f\x7f]/.test(b.folder))) return { ok: false, reason: '폴더 경로 형식이 잘못됐습니다.' };
  const target = b.target || 'all';
  if (target === 'folder' && !String(b.folder || '').trim()) return { ok: false, reason: '폴더를 고르세요.' };
  return {
    ok: true,
    sel: {
      keys: c.keys, live: b.live !== false, disk: b.disk === 'join' ? 'join' : 'slots', tagCols: b.tagCols === true,
      target, folder: target === 'folder' ? String(b.folder) : '', tmpl: b.tmpl !== false,
      prefName: typeof b.prefName === 'string' ? b.prefName.slice(0, 30) : '',
      ynDays: ynDaysOf(b.ynDays),
    },
  };
}

/** v2.801 Veeam 판정 읽기(라우트만 req 를 안다) — vCenter 전체 VM 으로 대조한다. */
const veeamOf = (req) => (vc, vms) => veeamVmViews(vc, vms, req, { now: Date.now() });

const fileBase = (vcenterId, target) => `vm-export-${String(vcenterId).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60)}-${target}-${fileStamp()}`;

/** 내려받기 공통 — 동시 1건 · 감사 · 끊긴 요청은 멈춘다. */
async function sendExport(req, res, vcenterId, sel, kind, { legacy = false } = {}) {
  const lock = acquireExport(`vm-export.${kind}`, req);
  if (!lock.ok) return res.status(lock.status).json(lock.body);
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ac.abort(); });
  try {
    const maybeYield = createYielder(15);
    // v2.801: 엑셀은 '요약' 시트 숫자도(summary) — Veeam 판정은 Veeam 항목을 골랐거나 엑셀일 때만 읽는다(veeamOf).
    const table = await buildVmExportTable(vcenterId, { ...sel, maybeYield, summary: kind === 'xlsx', veeamViews: veeamOf(req) });
    if (ac.signal.aborted) return;
    let payload;
    if (kind === 'xlsx') {
      const out = await renderVmExportWorkbook({
        head: table.head, cells: table.cells, cols: table.cols, meta: table.meta, rowFolder: table.rowFolder, rowPower: table.rowPower, summary: table.summary,
        cond: { target: TARGET_TEXT[sel.target] + (sel.target === 'folder' ? ` ‘${sel.folder}’` : '') + (sel.tmpl ? '' : '(템플릿 제외)'), items: sel.keys.length,
          groupNames: GROUP_NAMES, offsetLabel: tzName(table.meta.offsetMin), prefName: sel.prefName },
      }, { signal: ac.signal });
      payload = out.buffer;
    } else {
      const lines = [csvLine(table.head)];
      for (const row of table.cells) { await maybeYield(); lines.push(csvLine(row)); }
      payload = CSV_BOM + lines.join('\r\n') + '\r\n';
    }
    if (ac.signal.aborted) return;
    logAudit({
      user: req.user?.username, action: `vm-export.${kind}`, target: vcenterId,
      detail: `${table.meta.rows} rows · ${legacy ? '예전 열' : `고른 항목 ${sel.keys.length}개`} · ${table.head.length}열 · ${sel.target}${sel.tmpl ? '' : ' · 템플릿 제외'} · 실시간 ${liveResultText(table.meta.live) || '-'}`.slice(0, 500),
      ip: req.ip,
    });
    res.setHeader('Content-Type', kind === 'xlsx' ? XLSX_MIME : 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileBase(vcenterId, sel.target)}.${kind}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(payload);
  } catch (e) {
    if (ac.signal.aborted || e?.code === 'aborted') return;
    if (!res.headersSent) res.status(500).json({ ok: false, error: '내보내기를 만들지 못했습니다.', reason: `내보내기를 만들지 못했습니다(${String(e?.message || e).slice(0, 200)}).` });
  } finally { lock.release(); }
}

export function registerVmExport(api) {
  api.get('/tools/vm-export/catalog', csvPerm, toolsPerm, async (req, res) => {
    const vcenterId = vcOf(req, res);
    if (!vcenterId) return;
    try {
      res.set('Cache-Control', 'no-store').json({ ok: true, ...catalogView({ snapDays: LOOKBACK_DAYS }), status: await vmExportStatus(vcenterId), prefs: getPrefs(req.user?.username) });
    } catch { res.status(500).json({ ok: false, reason: '항목 목록을 만들지 못했습니다.' }); }
  });

  api.post('/tools/vm-export/preview', csvPerm, toolsPerm, async (req, res) => {
    const vcenterId = vcOf(req, res);
    if (!vcenterId) return;
    const s = selOf(req.body);
    if (!s.ok) return res.status(400).json({ ok: false, reason: s.reason });
    try {
      // v2.801: rows(3~100) — 화면 안 미리보기 3대 · '크게 보기' 팝업 100대. 행마다 폴더 경로(rowFolder — 폴더별로 나눠 보기).
      const n = Number.isInteger(req.body?.rows) ? Math.max(PREVIEW_ROWS, Math.min(PREVIEW_MAX, req.body.rows)) : PREVIEW_ROWS;
      const t = await buildVmExportTable(vcenterId, { ...s.sel, preview: true, limit: n, veeamViews: veeamOf(req) });
      res.set('Cache-Control', 'no-store').json({
        ok: true, head: t.head, cells: t.cells, cols: t.cols.map((c) => ({ key: c.key, item: c.item, group: c.group, src: c.src })),
        folders: t.rowFolder, rows: t.meta.matched, total: t.meta.total, live: t.meta.live, tags: t.meta.tags, parts: t.meta.parts, veeam: t.meta.veeam,
      });
    } catch { res.status(500).json({ ok: false, reason: '미리보기를 만들지 못했습니다.' }); }
  });

  api.post('/tools/vm-export.csv', csvPerm, toolsPerm, (req, res) => {
    const vcenterId = vcOf(req, res);
    if (!vcenterId) return undefined;
    const s = selOf(req.body);
    if (!s.ok) return res.status(400).json({ ok: false, reason: s.reason });
    return sendExport(req, res, vcenterId, s.sel, 'csv');
  });
  api.post('/tools/vm-export.xlsx', csvPerm, toolsPerm, (req, res) => {
    const vcenterId = vcOf(req, res);
    if (!vcenterId) return undefined;
    const s = selOf(req.body);
    if (!s.ok) return res.status(400).json({ ok: false, reason: s.reason });
    return sendExport(req, res, vcenterId, s.sel, 'xlsx');
  });
  // 호환 — 예전 화면·스크립트의 GET(고른 항목 없음 = '예전 CSV 그대로' + 실시간 보강). 이제 동시 1건·감사도 같다.
  api.get('/tools/vm-export.csv', csvPerm, toolsPerm, (req, res) => {
    const vcenterId = vcOf(req, res);
    if (!vcenterId) return undefined;
    return sendExport(req, res, vcenterId, { keys: [...LEGACY_KEYS], live: true, disk: 'slots', tagCols: false, target: 'all', folder: '', tmpl: true, prefName: '' }, 'csv', { legacy: true });
  });
  // 호환 — 예전 미리보기(JSON 100행 · 예전 열). v2.799(결함 6): 실시간 조회를 하지 않는다(화면을 여는 것만으로 vCenter 전량 조회를 하지 않게).
  api.get('/tools/vm-export', csvPerm, toolsPerm, async (req, res) => {
    const vcenterId = vcOf(req, res);
    if (!vcenterId) return;
    try {
      const t = await buildVmExportTable(vcenterId, { keys: [...LEGACY_KEYS], live: false, disk: 'slots', target: 'all', tmpl: true, limit: 100 });
      const columns = t.cols.map((c) => ({ key: c.key, label: c.h }));
      const rows = t.cells.map((r) => Object.fromEntries(columns.map((c, i) => [c.key, r[i]])));
      res.json({ vcenterId, vcenterName: t.meta.vcenterName, enriched: false, enrichError: '미리보기는 실시간 보강을 하지 않습니다 — 내려받을 때 한 번 조회합니다', total: t.meta.total, columns, rows });
    } catch { res.status(500).json({ ok: false, reason: '미리보기를 만들지 못했습니다.' }); }
  });

  api.get('/tools/vm-export/prefs', csvPerm, toolsPerm, (req, res) => res.set('Cache-Control', 'no-store').json({ ok: true, prefs: getPrefs(req.user?.username) }));
  const prefsWrite = (fn) => (req, res) => {
    if (isDemoGuest(req.user)) return res.status(403).json({ ok: false, reason: '데모 계정은 저장할 수 없습니다.' });
    const r = fn(req);
    if (!r.ok) return res.status(r.status || 400).json({ ok: false, reason: r.reason, ...(r.code ? { [r.code]: true } : {}) });
    logAudit({
      user: req.user?.username, action: 'vm-export.prefs', target: String(objOf(req.body).slot ?? req.query?.slot ?? '').slice(0, 16),
      detail: req.method === 'DELETE' ? '지움' : `저장 · ${(objOf(objOf(req.body).value).cols || []).length}개 항목${objOf(req.body).alsoDefault === true ? ' · 기본값으로도' : ''}`, ip: req.ip,
    });
    res.json({ ok: true, prefs: r.prefs });
  };
  // 상태변경 라우트는 역할 게이트가 먼저다(v2.590 D1 — ipamExport.js 머리말).
  api.put('/tools/vm-export/prefs', requireRole('admin', 'operator'), csvPerm, toolsPerm, prefsWrite((req) => {
    const b = objOf(req.body);
    return setPref(req.user?.username, b.slot === 'default' ? 'default' : Number(b.slot), b.value, { alsoDefault: b.alsoDefault === true });
  }));
  api.delete('/tools/vm-export/prefs', requireRole('admin', 'operator'), csvPerm, toolsPerm,
    prefsWrite((req) => clearPref(req.user?.username, req.query.slot === 'default' ? 'default' : Number(req.query.slot))));
}

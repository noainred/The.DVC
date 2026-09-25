// NSX 매니저·지오코딩·vCenter 가져오기 — admin.js(구 2,410줄) 분할(v2.285.0). 본문은 원본 그대로, 등록 순서는 admin.js 호출 순서가 보존한다.
import fs from 'node:fs';
import { config } from '../../config.js';
import { store } from '../../store.js';
import { getDataSource } from '../../runtime-settings.js';
import { importVcenters } from '../../vcenter/registry.js';
import { geocode } from '../../vcenter/geocode.js';
import path from 'node:path';
import { loadRegistry as loadNsxFull, listRegistry as listNsx, addManager as addNsx, updateManager as updateNsx, removeManager as removeNsx, testConnection as testNsx } from '../../nsx/registry.js';
import { nsxStore, nsxAuthGuard } from '../../nsx/store.js';
import { adminOnly, existsFile, fullScopeOnlyWith } from './shared.js';

// v2.611 AUTHZ2611-02: vCenter 가져오기(replace 는 전체 교체)·NSX 매니저 등록은 전 법인 등록부다 — v2.607 `POST /vcenters`
//   의 fleetWideOnly 를 이 경로로 우회할 수 있었다(범위 admin 이 replace 로 등록 vCenter 전체를 교체). 범위 계정 403.
const fleetOnly = fullScopeOnlyWith('vCenter 가져오기·NSX 매니저 등록은 전 법인에 걸친 등록부라 전체 범위(vCenter 제한 없는) 계정만 바꿀 수 있습니다.');


// Import a vcenters.json already stored on the server. Body: { path, mode? }
// 임의 파일 읽기 방지: configDir 하위(.json) 또는 알려진 표준 위치만 허용.
function isAllowedImportPath(p) {
  const abs = path.resolve(String(p));
  if (!abs.endsWith('.json')) return false;
  const allowDirs = [path.resolve(config.configDir), '/etc/vmware-portal', '/opt/vmware-portal/app/server/config'];
  return allowDirs.some((d) => abs === d || abs.startsWith(d + path.sep));
}

export function registerNsxImport(adminRouter) {

// --- NSX Manager registry (separate from vCenter; managed by NSX Manager) ---
adminRouter.get('/nsx/managers', adminOnly, (_req, res) => {
  // v2.590: 인증 실패로 주기 수집이 멈춘 매니저를 목록이 말한다(정지 판정에는 복호된 자격증명이 필요 — 응답엔 안 싣는다).
  let full = new Map();
  try { full = new Map(loadNsxFull().map((m) => [m.id, m])); } catch { /* 목록은 그대로 */ }
  const managers = listNsx().map((m) => {
    const rec = full.has(m.id) ? nsxAuthGuard.authStopFor(full.get(m.id)) : null;
    return rec ? { ...m, authStopped: { since: rec.since, at: rec.at, attempts: rec.attempts, reason: rec.reason } } : m;
  });
  res.json({ dataSource: getDataSource(), managers });
});
adminRouter.post('/nsx/managers', adminOnly, fleetOnly, (req, res) => {
  const result = addNsx(req.body || {});
  if (result.ok) nsxStore.refresh().catch(() => {});
  res.status(result.ok ? 201 : 400).json(result);
});
adminRouter.put('/nsx/managers/:id', adminOnly, fleetOnly, (req, res) => {
  const result = updateNsx(req.params.id, req.body || {});
  if (result.ok) nsxStore.refresh().catch(() => {});
  res.status(result.ok ? 200 : 400).json(result);
});
adminRouter.delete('/nsx/managers/:id', adminOnly, fleetOnly, (req, res) => {
  const result = removeNsx(req.params.id);
  if (result.ok) nsxStore.refresh().catch(() => {});
  res.status(result.ok ? 200 : 404).json(result);
});
adminRouter.post('/nsx/managers/test', adminOnly, fleetOnly, async (req, res) => {
  res.json(await testNsx(req.body || {}));
});

// Offline geocode: city/country -> { lat, lon, match } for map plotting.
adminRouter.get('/geocode', adminOnly, (req, res) => {
  const g = geocode(req.query.city, req.query.country);
  res.json(g ? { ok: true, ...g } : { ok: false, reason: '좌표를 찾을 수 없습니다 (도시/국가명 확인).' });
});

// Import an uploaded vcenters.json. Body: { vcenters:[...], mode?:'merge'|'replace' }
// (a bare array is also accepted). Triggers a re-poll on success.
adminRouter.post('/vcenters/import', adminOnly, fleetOnly, (req, res) => {
  const body = req.body || {};
  const list = Array.isArray(body) ? body : body.vcenters;
  const result = importVcenters(list, body.mode === 'replace' ? 'replace' : 'merge');
  if (result.ok) store.refresh().catch(() => {});
  res.status(result.ok ? 200 : 400).json(result);
});

// Default server-side path suggestions for the "server file" import.
adminRouter.get('/vcenters/import-suggestions', adminOnly, (_req, res) => {
  const candidates = [
    `${config.configDir}/vcenters.json`,
    '/etc/vmware-portal/vcenters.json',
    '/opt/vmware-portal/app/server/config/vcenters.json',
  ];
  res.json({ default: candidates[0], suggestions: [...new Set(candidates)].filter((p) => existsFile(p)) });
});
adminRouter.post('/vcenters/import-file', adminOnly, fleetOnly, (req, res) => {
  const { path: filePath, mode } = req.body || {};
  if (!filePath || typeof filePath !== 'string') return res.status(400).json({ ok: false, reason: '파일 경로가 필요합니다.' });
  if (!isAllowedImportPath(filePath)) return res.status(400).json({ ok: false, reason: '허용된 경로(설정 디렉터리의 .json)만 불러올 수 있습니다.' });
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return res.status(400).json({ ok: false, reason: '파일이 아닙니다.' });
    if (stat.size > 5 * 1024 * 1024) return res.status(400).json({ ok: false, reason: '파일이 너무 큽니다(>5MB).' });
    const json = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const list = Array.isArray(json) ? json : json.vcenters;
    const result = importVcenters(list, mode === 'replace' ? 'replace' : 'merge');
    if (result.ok) store.refresh().catch(() => {});
    res.status(result.ok ? 200 : 400).json({ ...result, file: filePath });
  } catch (err) {
    res.status(400).json({ ok: false, reason: `파일 읽기 실패: ${err.message}` });
  }
});
}

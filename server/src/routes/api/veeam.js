// Veeam 백업 VM 배지(v2.751) — vCenter › VM 및 폴더의 'Veeam 백업 VM 표시' 체크박스가 부른다.
// 조회 전용·로그인 사용자(트리를 볼 수 있는 계정이면 배지도 본다 — 어떤 VM 이 백업 대상인지·작업 이름뿐, 주소·계정 없음).
// scope: id 를 직접 받는 단건 라우트라 범위 밖 vCenter 는 404(존재 은닉 — server/CLAUDE.md). 체크박스를 켰을 때만 60초 폴링한다.
import { store } from '../../store.js';
import { scopedVcenterIds } from '../../auth/scope.js';
import { serversForVcenter } from '../../veeam/registry.js';
import { getRecord, usableResult } from '../../veeam/store.js';
import { matchToVcenter } from '../../veeam/parse.js';
import { listRegistry as listVcenters } from '../../vcenter/registry.js';
import { isMockMode } from '../../mock/demo/flags.js';
import { demoVeeamMatch } from '../../mock/demo/veeam.js';

/** 서버별 상태(화면 안내용 — 주소·계정 없음). */
function serverView(d, rec) {
  const r = rec?.result || null;
  const use = usableResult(rec);
  return {
    name: d.name, ok: r ? r.ok === true : null, ts: r?.ts ?? null, lastOkTs: use?.ts ?? null,
    error: r && !r.ok ? String(r.error || '').slice(0, 300) : '', authStopped: !!r?.authStop,
    via: rec?.via || '', notes: Array.isArray(use?.notes) ? use.notes.slice(0, 5) : [],
    counts: use?.counts || null,
  };
}

export function registerVeeamBadges(api) {
  api.get('/veeam/badges', (req, res) => {
    const vcenterId = String(req.query.vcenterId || '').slice(0, 128);
    const snap = store.get();
    const allowed = scopedVcenterIds(req.user, snap);
    const vc = (snap?.vcenters || []).find((v) => v.id === vcenterId);
    if (!vcenterId || !vc || (allowed && !allowed.has(vcenterId))) return res.status(404).json({ ok: false, reason: 'vCenter 를 찾을 수 없습니다.' });
    const vms = (snap?.vms || []).filter((v) => v.vcenterId === vcenterId);
    const servers = serversForVcenter(vcenterId);
    if (!servers.length) {
      if (isMockMode()) {
        const m = demoVeeamMatch(vcenterId, vms);
        return res.json({ ok: true, configured: true, demo: true, servers: [{ name: '데모 Veeam', ok: true, ts: Date.now(), lastOkTs: Date.now(), error: '', authStopped: false, via: 'demo', notes: [], counts: null }], ...m, at: Date.now() });
      }
      return res.json({ ok: true, configured: false, servers: [], byVm: {}, unmatched: 0, otherVcenter: 0, ambiguous: 0 });
    }
    const host = listVcenters().find((v) => v.id === vcenterId)?.host || '';
    const results = [];
    const views = [];
    for (const d of servers) {
      const rec = getRecord(d.id);
      views.push(serverView(d, rec));
      const use = usableResult(rec);
      if (use) results.push({ server: { id: d.id, name: d.name }, result: use });
    }
    const m = matchToVcenter({ id: vcenterId, host }, vms, results);
    res.json({ ok: true, configured: true, servers: views, ...m, at: Date.now() });
  });
}

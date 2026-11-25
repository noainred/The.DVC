// routes/api/vmPower.js — VM 전원 이력(v3.39.0 · 시안 docs/design/vm-power-calendar A안 · ⑤).
//   GET /vms/:id/power-history?from=<ms>&to=<ms> — 화면(개체 보기 '전원 이력' 탭 · VM 드로어 '전원 상태')이 **열 때 1회** 부른다(15초 폴링 아님).
//   VM 목록 조회 권한(inv.vms) · 범위 밖 VM 은 404(존재 은닉 — /vms/:id/metrics 와 같은 규칙). 판정은 vmpower/history.js 하나.
import { requirePerm } from '../../auth/auth.js';
import { inUserScope } from '../../auth/scope.js';
import { store } from '../../store.js';
import { vmPowerHistory } from '../../vmpower/history.js';

export function registerVmPower(api) {
  api.get('/vms/:id/power-history', requirePerm('inv.vms'), async (req, res) => {
    const snap = store.get();
    const vm = (snap?.vms || []).find((v) => v.id === req.params.id);
    if (!vm || !inUserScope(req.user, snap, vm.vcenterId)) return res.status(404).json({ ok: false, reason: 'VM을 찾을 수 없습니다.' });
    try {
      res.json(await vmPowerHistory(vm, snap, { from: req.query.from, to: req.query.to }));
    } catch (e) {
      console.warn(`[vmpower] 전원 이력 조회 실패: ${String(e?.message || e).slice(0, 200)}`);
      res.status(500).json({ ok: false, reason: '전원 이력을 읽지 못했습니다.' });
    }
  });
}

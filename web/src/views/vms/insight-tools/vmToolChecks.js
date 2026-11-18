/**
 * insight-tools/vmToolChecks.js — 본체 ‘확인할 것’ 줄(S1)에 들어가는 **도구 쪽 칸**(v3.21.0 · docs/design/vm-insight · host-insight §9 S1).
 *   디스크가 차 가는 VM(게스트 파티션 사용률) · 꺼진 VM(Optimization › 전원 꺼짐, 템플릿 제외) — 아래 패널의 머리 숫자와 같은 값(새 판정 없음).
 *   요약은 패널과 **같은 칸**(useToolSummary)을 나눠 본다 — 칸과 패널이 함께 떠도 요청은 한 번이다.
 *   도구 권한이 없으면 그 칸을 빼고 요청도 보내지 않는다(§6 ⑪).
 *
 * 본체와의 약속: export 이름 checkItems(훅) — checkItems({ vcIds, canTool }) → { key, label, value, tone, href, sub, title }[]
 *   tone: 'crit' | 'warn' | '' · value 는 표시 글자(못 받았으면 '—').
 */
import { useToolSummary } from './useToolSummary.js';
import { guestPartView, offView } from './vmToolPanelsText.js';
import { fmtN, gbText, toolHref, toolLabel, gateOf } from './toolSumText.js';
import { toolAllowed } from '../../../api.js';

/** 칸 만들기(순수) — gp · waste 는 { data, error, loading } 상태. */
export function buildToolChecks({ vcIds = [], canTool, gp = null, waste = null } = {}) {
  const can = typeof canTool === 'function' ? canTool : () => false;
  const out = [];
  const pending = (q) => (q?.loading && !q?.data ? '받는 중…' : q?.error && !q?.data ? '받지 못했습니다' : '');
  if (can('guest-partition')) {
    const v = guestPartView(gp?.data, vcIds);
    out.push({
      key: 'disk-filling', label: '디스크가 차 가는 VM',
      value: v && !v.noValues ? fmtN(v.overVms) : '—',
      sub: v?.noValues ? '아직 수집된 파티션 값이 없습니다' : v ? `위험 ${fmtN(v.crit)} · ${v.soonDays ?? '—'}일 안 가득 ${fmtN(v.soon)}` : pending(gp),
      tone: v && (v.crit || 0) > 0 ? 'crit' : v && (v.overVms || 0) > 0 ? 'warn' : '',
      href: toolHref('guest-partition'),
      title: `아래 ‘디스크가 차 가는 VM’ 패널 — 특수 기능 ‘${toolLabel('guest-partition')}’ 의 판정`,
    });
  }
  if (can('waste')) {
    const v = offView(waste?.data, null, vcIds);
    out.push({
      key: 'powered-off', label: '꺼진 VM',
      value: v ? fmtN(v.count) : '—',
      sub: v ? `디스크 ${gbText(v.diskGB)} 점유` : pending(waste),
      tone: '',
      href: toolHref('waste', 'off'),
      title: `아래 ‘꺼진 VM’ 패널(템플릿 제외) — 특수 기능 ‘${toolLabel('waste')}’ 의 ‘전원 꺼짐’`,
    });
  }
  return out;
}

/** 훅 — 본체가 checkItems 라는 이름으로 부른다. */
export function useVmToolChecks({ vcIds = [], canTool } = {}) {
  const can = typeof canTool === 'function' ? gateOf(canTool, (k) => toolAllowed(k)) : () => false;
  const gp = useToolSummary('/tools/guest-partition', null, { enabled: can('guest-partition'), timeoutMs: 60_000, retries: 0 });
  const waste = useToolSummary('/tools/waste', null, { enabled: can('waste') });
  return buildToolChecks({ vcIds, canTool: can, gp, waste });
}

export const checkItems = useVmToolChecks;
export default useVmToolChecks;

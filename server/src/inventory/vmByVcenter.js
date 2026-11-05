/**
 * 가상화 서버 '법인별' 탭 집계 — v2.909(시안 `docs/design/vm-screen` ③). 순수(store·DB import 없음 — 라우트가 넘긴다).
 *
 * 법인 = vCenter 1:1(루트 CLAUDE.md). 한 줄 = 신원·수집 상태(`vcenter/hostCorp.js corpIdentityOf` — 호스트 법인별과 같은 칸) +
 * VM 수(구동·정지) · 할당(vCPU·메모리) · 평균 사용률(구동 VM · 못 읽은 VM 제외 — `vmTotals.usageAvg`) · GPU VM · 신호 개수(`vmSignals`).
 *
 * 규칙
 *  · 법인 목록은 라우트가 범위(scope)로 **먼저** 거른 vcenters 다 — 범위 밖 vCenter 는 이름도 싣지 않는다(hostCorp 와 같은 규약).
 *  · vms 도 라우트가 범위·필터로 거른 집합이다. 목록에 없는 vCenter 의 VM 이 있으면(이월·경합) 그 id 로 줄을 만들고 `unlisted:true`.
 *  · 개수를 모르는 법인(첫 수집 중·비활성·연결 실패·인증 정지이며 VM 0)은 개수·평균을 null — '0대' 라는 거짓 금지(`corpUnknownOf`).
 *  · 합계 줄의 평균은 **법인 평균의 평균이 아니라** 전체 구동 VM 의 평균이다.
 *  · dropEmpty(검색·전원 필터로 좁힌 경우)면 VM 0 인 법인을 뺀다 — 좁혀 놓고 빈 줄 28개를 보이지 않게.
 */
import { corpIdentityOf, corpUnknownOf } from '../vcenter/hostCorp.js';
import { usageAvg } from './vmTotals.js';
import { signalCounts } from './vmSignals.js';

function statsOf(list, ctx) {
  const on = list.filter((v) => v.powerState === 'POWERED_ON');
  const cpu = usageAvg(on, (v) => v.cpuUsagePct);
  const mem = usageAvg(on, (v) => v.memUsagePct);
  let vcpu = 0; let memMB = 0; let gpu = 0;
  for (const v of list) {
    vcpu += Number.isFinite(v.cpuCount) ? v.cpuCount : 0;
    memMB += Number.isFinite(v.memMB) ? v.memMB : 0;
    if (v.gpu) gpu += 1;
  }
  return {
    vms: list.length, on: on.length, off: list.length - on.length,
    vcpu, ramGB: Math.round(memMB / 1024),
    avgCpuPct: cpu.value, avgMemPct: mem.value,
    // 사용률을 못 읽은 구동 VM 수는 signals.usageUnknown(CPU·메모리 중 하나라도 — 신호와 같은 판정)으로 싣는다.
    gpu, signals: signalCounts(list, ctx),
  };
}

const NULL_STATS = Object.freeze({ vms: null, on: null, off: null, vcpu: null, ramGB: null, avgCpuPct: null, avgMemPct: null, gpu: null, signals: null });

/**
 * @param {{ vcenters: object[], vms: object[], ctx: object, dropEmpty?: boolean }} p
 * @returns {{ corps: object[], totals: object }}
 */
export function vmByVcenter({ vcenters = [], vms = [], ctx, dropEmpty = false } = {}) {
  const byVc = new Map();
  for (const v of vms) {
    if (!v || typeof v !== 'object') continue;
    const k = v.vcenterId;
    let l = byVc.get(k);
    if (!l) { l = []; byVc.set(k, l); }
    l.push(v);
  }
  const corps = [];
  const listed = new Set();
  for (const vc of vcenters) {
    if (!vc || typeof vc !== 'object') continue;
    listed.add(vc.id);
    const list = byVc.get(vc.id) || [];
    if (dropEmpty && !list.length) continue;
    const unknown = corpUnknownOf(vc, list.length);
    corps.push({ ...corpIdentityOf(vc), ...(unknown ? NULL_STATS : statsOf(list, ctx)) });
  }
  for (const [k, list] of byVc) {
    if (listed.has(k)) continue;
    corps.push({ ...corpIdentityOf({ id: k }), unlisted: true, ...statsOf(list, ctx) });
  }
  corps.sort((a, b) => (b.vms ?? -1) - (a.vms ?? -1) || String(a.name).localeCompare(String(b.name)));
  const all = statsOf(vms.filter((v) => v && typeof v === 'object'), ctx);
  return {
    corps,
    totals: {
      ...all,
      corps: corps.length,
      corpsUnknown: corps.filter((c) => c.vms == null).length,
      corpsStale: corps.filter((c) => c.stale && c.status !== 'unreachable').length,
    },
  };
}

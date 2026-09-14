/**
 * vmseries/collect.js — 한 vCenter 의 실시간(20초) 표본을 받아 스파이크 순간으로 축약(v2.510).
 *
 * 로그인 1회 + 청크(기본 25 엔티티)당 QueryPerf 1회. 실시간 구간은 `maxSample=180`(20초 × 180 = 60분)
 * 으로 받는다 — startTime 을 주면 vCenter 가 실시간 버퍼 밖을 롤업으로 채우지 않고 빈 응답을 주는
 * 경우가 있어 '최근 N개' 로 받는 것이 확실하다. 겹침(주기 50분 vs 버퍼 60분)은 cursor(엔티티별
 * 마지막 표본 시각)로 잘라낸다.
 *
 * 20초 원본은 메모리에서만 존재한다 — 반환값에는 임계 이상 순간(packMoments)과 시간별 표본 수(cover)
 * 만 남는다. 응답 XML 은 청크당 수백 KB~1MB 라 청크 사이에 setImmediate 로 양보한다(기존 배치 규약).
 *
 * historicalInterval(그 vCenter 의 실제 통계 구간 설정)도 같은 세션에서 1회 읽어 돌려준다 —
 * 리포트가 "이 vCenter 의 1주 롤업은 30분·보관 7일·레벨 1" 을 **실측값으로** 적기 위해서다
 * (기본값을 하드코딩하지 말 것 — CLAUDE.md).
 */
import { VimSoapClient } from '../vcenter/soapClient.js';
import { VM_COUNTERS, HOST_COUNTERS, REALTIME_STEP_SEC, REALTIME_MAX_SAMPLES } from './counters.js';
import { alignMoments, splitSpikes, packMoments } from './spikes.js';

const yieldLoop = () => new Promise((r) => setImmediate(r));

/** PerformanceManager.historicalInterval XML → [{key, samplingPeriod, length, name, level, enabled}]. */
export function parseHistoricalInterval(xml) {
  const out = [];
  for (const blk of String(xml || '').split(/<PerfInterval[^>]*>/).slice(1)) {
    const g = (tag) => new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(blk)?.[1];
    const key = Number(g('key'));
    if (!Number.isFinite(key)) continue;
    out.push({ key, samplingPeriod: Number(g('samplingPeriod')) || null, length: Number(g('length')) || null, name: g('name') || '', level: Number(g('level')) || null, enabled: g('enabled') !== 'false' });
  }
  return out;
}

/**
 * @param vc         vcenters.json 항목
 * @param targets    scope.resolveTargets 결과 { vms, hosts }
 * @param settings   { thresholds }
 * @param cursors    Map<`${kind}|${ref}`, lastTs>
 * @returns { spikes, cover, cursors, stats, historicalInterval }
 */
export async function collectVcenterSpikes(vc, targets, settings, cursors, { chunkSize = 25, signal = null } = {}) {
  const thr = settings?.thresholds || {};
  const out = { spikes: [], cover: [], cursors: [], stats: { vms: 0, hosts: 0, samples: 0, moments: 0, chunks: 0, missing: [] }, historicalInterval: null };
  const c = new VimSoapClient(vc);
  await c.login();
  try {
    const map = await c.perfCounterMap();
    const size = Math.max(1, Math.min(50, Number(chunkSize) || 25));
    const ctxOf = new Map(targets.vms.map((v) => [v.ref, { vcpu: v.vcpu }]));

    const runKind = async (kind, entityType, defs, list) => {
      if (!list.length) return;
      const cols = defs.map((d) => ({ ...d, cid: map.get(d.key) || null }));
      for (const col of cols) if (!col.cid) out.stats.missing.push(`${kind}:${col.key}`);
      const ids = cols.map((col) => col.cid).filter(Boolean);
      if (!ids.length) return;
      const names = cols.map((col) => col.name);
      const refs = list.map((e) => e.ref);
      for (let i = 0; i < refs.length; i += size) {
        if (signal?.aborted) throw new Error('수집 중단(데드라인)');
        const chunk = refs.slice(i, i + size);
        const byRef = await c.queryEntitiesPerfBatch(entityType, ids, chunk, REALTIME_STEP_SEC, { maxSample: REALTIME_MAX_SAMPLES });
        out.stats.chunks++;
        for (const ref of chunk) {
          const moments = alignMoments(byRef.get(ref), cols);
          if (!moments.length) continue;
          const after = cursors.get(`${kind}|${ref}`) || 0;
          const r = splitSpikes(moments, cols, thr, { afterTs: after, ctx: ctxOf.get(ref) || {} });
          if (!r.samples) continue;
          out.stats.samples += r.samples;
          if (kind === 'vm') out.stats.vms++; else out.stats.hosts++;
          for (const [h, n] of r.perHour) out.cover.push({ kind, ref, h, samples: n });
          out.cursors.push({ kind, ref, lastTs: r.lastTs });
          if (r.spikes.length) {
            const p = packMoments(r.spikes, cols.length);
            // 행 단위 최대(cpu.usage / mem.usage, ×100 정수) — 전 VM 순위가 BLOB 을 풀지 않고 쓴다.
            const ci = names.indexOf('cpuUsagePct'); const mi = names.indexOf('memUsagePct');
            let mxcpu = -1; let mxmem = -1;
            for (const m of r.spikes) {
              if (ci >= 0 && m.vals[ci] > mxcpu) mxcpu = m.vals[ci];
              if (mi >= 0 && m.vals[mi] > mxmem) mxmem = m.vals[mi];
            }
            out.spikes.push({ kind, ref, t0: p.t0, t1: p.t1, n: p.n, cols: names, buf: p.buf, mxcpu, mxmem });
            out.stats.moments += p.n;
          }
        }
        if (i + size < refs.length) await yieldLoop();
      }
    };

    await runKind('vm', 'VirtualMachine', VM_COUNTERS, targets.vms || []);
    await runKind('host', 'HostSystem', HOST_COUNTERS, targets.hosts || []);

    // 이 vCenter 의 실제 통계 구간 설정(실측) — 1회 RetrieveProperties, 실패해도 수집은 유효.
    try {
      if (c.sc?.perfManager) {
        const objs = await c.retrieveObjectProps('PerformanceManager', c.sc.perfManager, ['historicalInterval']);
        out.historicalInterval = parseHistoricalInterval(objs[0]?.props?.historicalInterval || '');
      }
    } catch { out.historicalInterval = null; }
    return out;
  } finally {
    await c.logout();
  }
}

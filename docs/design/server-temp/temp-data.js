// temp-data.js — 서버 온도 화면 시안 공통 데이터(결정적 난수). 화면의 표기 규칙은 shared.jsx tempColor 와 동일.
const DC = [
  ['MIL', 0, null, null, 1, 27, 34], ['MIL2', 18, 24.8, 75, 34, 25.6, 78], ['HG', 16, 24.9, 45, 26, 21.9, 74],
  ['NB-IRS', 0, null, null, 11, 22.9, 46], ['NB', 24, 24, 77, 37, 22, 82], ['OC1', 3, 21, 46.1, 15, 22.9, 54],
  ['HM', 18, 24.7, 58, 42, 20.9, 77], ['GM2', 0, null, null, 1, 22, 40], ['GM1', 18, 22.1, 98, 49, 21.7, 83],
  ['HD', 18, 26.6, 49, 33, 19, 83], ['WA', 46, 24.2, 98, 94, 19.4, 96], ['GM2b', 18, 22.4, 52, 35, 20.1, 63],
  ['OC2', 153, 18.4, 100, 89, 22.9, 76], ['MI', 43, 19.9, 98, 32, 19.6, 97], ['OC2Sandbox', 0, null, null, 5, 19.8, 54],
  ['OC2Sandbox2', 0, null, null, 32, 19.6, 64], ['ST', 18, 20.8, 71, 33, 18.6, 77], ['AZ', 37, 18.5, 56, 23, 19.7, 68],
  ['SH', 30, 19.1, 61, 25, 18.7, 59], ['TJ', 24, 18.6, 48, 20, 18.2, 52], ['DL', 18, 17.9, 44, 18, 17.5, 47],
];
const LABEL = { MIL2: 'MIL', GM2b: 'GM2', OC2Sandbox2: 'OC2Sandbox' };
const REGION = { MIL: '유럽', MIL2: '유럽', HG: '아시아', 'NB-IRS': '아시아', NB: '아시아', OC1: '아시아', HM: '아시아', GM2: '북미', GM2b: '북미', GM1: '북미', HD: '아시아', WA: '아시아', OC2: '아시아', MI: '북미', OC2Sandbox: '아시아', OC2Sandbox2: '아시아', ST: '유럽', AZ: '북미', SH: '중국', TJ: '중국', DL: '중국' };
const ROLES = ['DB', 'APP', 'WEB', 'HPC', 'BKP', 'FS', 'AD', 'MON'];

export const tempColor = (c) => (c == null ? '#5d6b85' : c >= 40 ? '#ef4444' : c >= 32 ? '#f59e0b' : '#22c55e');
export const tempLevel = (c) => (c == null ? 'none' : c >= 40 ? 'hot' : c >= 32 ? 'warm' : 'ok');
export const r1 = (v) => Math.round(v * 10) / 10;
export const fmt = (v) => (v == null ? '—' : String(v));

export function buildData() {
  let seed = 918273;
  const rnd = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
  const gauss = () => { const u = Math.max(rnd(), 1e-9), v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const spark = (base, hot) => { // 24개 점(시간별) — 기준값 주변 잡음 + 더운 서버는 완만한 상승
    const out = []; let v = base - (hot ? 4 : 0) + gauss() * 0.6;
    for (let i = 0; i < 24; i++) { v += gauss() * 0.5 + (hot ? 0.18 : 0); out.push(r1(clamp(v, 14, 60))); }
    out[23] = base; return out;
  };
  const HOT = { OC2: 41.6, WA: 43.2, GM1: 40.4 }; // 40℃ 이상(빨강) 서버를 가진 법인
  const WARM_RATE = 0.012;
  const servers = [];
  let sid = 0;
  for (const [dc, pN, pAvg, pMax, vN, vAvg, vMax] of DC) {
    const nCl = Math.max(1, Math.ceil(vN / 24));
    const make = (kind, n, avg, max) => {
      for (let i = 0; i < n; i++) {
        let cur = r1(clamp(avg + gauss() * 2.1, 15.5, 30.5));
        if (rnd() < WARM_RATE) cur = r1(32 + rnd() * 5.5);
        if (kind === 'physical' && HOT[dc] && i === 2) cur = HOT[dc];
        const peak = i === 0 ? max : Math.round(clamp(cur + 22 + rnd() * 34, cur + 10, max));
        const esxi = kind === 'virtual' && rnd() < 0.037;
        const cl = kind === 'virtual' ? `${LABEL[dc] || dc}-CL${String(1 + (i % nCl)).padStart(2, '0')}` : '';
        const nn = String(i + 1).padStart(2, '0');
        const name = kind === 'physical' ? `${LABEL[dc] || dc}-${ROLES[i % ROLES.length]}${nn}` : `esx${nn}.${(LABEL[dc] || dc).toLowerCase()}.corp`;
        servers.push({
          id: `s${sid++}`, name, kind, dc, dcLabel: LABEL[dc] || dc, region: REGION[dc], source: esxi ? 'esxi' : 'idrac', stale: rnd() < 0.01,
          cluster: cl, hostName: kind === 'virtual' ? name : '',
          curC: cur, inletC: cur, exhaustC: r1(cur + 9 + rnd() * 10), cpuC: Math.round(36 + rnd() * 28 + (cur >= 32 ? 14 : 0)), maxC: peak,
          spark: spark(cur, cur >= 32),
        });
      }
    };
    make('physical', pN, pAvg ?? 20, pMax ?? 50);
    make('virtual', vN, vAvg ?? 20, vMax ?? 50);
  }
  const avg = (xs) => (xs.length ? r1(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  const max = (xs) => (xs.length ? Math.max(...xs) : null);
  const agg = (list) => ({ servers: list.length, avgC: avg(list.map((s) => s.curC)), maxC: max(list.map((s) => s.maxC)), avgInletC: avg(list.map((s) => s.inletC)) });
  const phys = servers.filter((s) => s.kind === 'physical'), virt = servers.filter((s) => s.kind === 'virtual');
  const summary = { all: { ...agg(servers), reporting: servers.length }, physical: agg(phys), virtual: agg(virt) };
  const counts = { idrac: servers.filter((s) => s.source === 'idrac').length, esxi: servers.filter((s) => s.source === 'esxi').length };
  const byDatacenter = DC.map(([dc]) => {
    const list = servers.filter((s) => s.dc === dc);
    const p = list.filter((s) => s.kind === 'physical'), v = list.filter((s) => s.kind === 'virtual');
    const hot = list.filter((s) => s.curC >= 40).length, warm = list.filter((s) => s.curC >= 32 && s.curC < 40).length;
    const all = agg(list);
    return { key: dc, name: LABEL[dc] || dc, region: REGION[dc], physical: agg(p), virtual: agg(v), all, hot, warm, spark: spark(all.avgC, false) };
  });
  const hosts = virt.map((s) => ({ id: s.id, name: s.name, vcenterId: s.dcLabel, cluster: s.cluster, curC: s.curC, avg5C: r1(s.curC + gauss() * 0.3), tempMaxC: s.maxC, spark: s.spark }));
  const groupBy = (list, keyFn) => { const m = new Map(); for (const h of list) { const k = keyFn(h); if (!m.has(k)) m.set(k, []); m.get(k).push(h); } return m; };
  const roll = (m, level) => [...m.entries()].map(([key, hs]) => ({ key, level, hosts: hs.length, curC: avg(hs.map((h) => h.curC)), avg5C: avg(hs.map((h) => h.avg5C)), maxC: max(hs.map((h) => h.tempMaxC)), spark: spark(avg(hs.map((h) => h.curC)), false) }));
  const clusters = roll(groupBy(hosts, (h) => `${h.vcenterId}|${h.cluster}`), 'cluster');
  const vcenters = roll(groupBy(hosts, (h) => h.vcenterId), 'vc');
  const buckets = []; // 1℃ 간격 분포(14~46, 마지막은 46+)
  for (let t = 14; t <= 46; t++) buckets.push({ t, n: 0 });
  for (const s of servers) { const i = clamp(Math.floor(s.curC) - 14, 0, buckets.length - 1); buckets[i].n++; }
  const hotList = servers.filter((s) => s.curC >= 32).sort((a, b) => b.curC - a.curC);
  return { servers, summary, counts, byDatacenter, hosts, clusters, vcenters, buckets, hotList, avgWindowLabel: '5분', generatedAt: '2026-09-18T08:24:07+09:00' };
}

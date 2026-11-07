// 데모(mock) — ESXi 경로 카운터(host.spath · v2.933 C-①). 목 모드에는 vCenter 실시간 통계가 없으므로, 데모 SAN 조닝(buildFabrics 결과)에서
//   그 호스트 HBA 의 zone 파트너 타깃을 찾아 결정적인 읽기·쓰기 값을 만든다. 호스트 셋 중 하나는 일부러 비워 둔다(측정 없음 → IPF · 타깃 포트 비율로 가는 모습).
//   수치는 가상값이다.
import { normWwn } from '../../sanswitch/zoning.js';

const hash = (s) => [...String(s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);

/** 데모 (초기자 WWN, 타깃 WWN) 짝의 읽기 · 쓰기(KB/s) — demoSpath 와 데모 Flow Vision 카운터(C-②)가 같은 값을 쓴다(교차검증 칸이 데모에서도 몇 % 안쪽). */
export function demoTargetKBps(initWwn, wwn) {
  const h = hash(`${initWwn}|${wwn}`);
  const rKBps = 1500 + (h % 9000);
  return { h, rKBps, wKBps: Math.round(rKBps * (0.25 + (h % 30) / 100)) };
}

/** @returns {object|null} storpath/parse.js summarizeHostPaths 와 같은 모양 */
export function demoSpath(host, fabrics = [], now = Date.now()) {
  if (!host || !Array.isArray(host.hbas) || !host.hbas.length) return null;
  if (hash(host.id) % 3 === 0) return null;
  const at = Math.floor(now / 3_600_000) * 3_600_000;
  const targets = []; const seen = new Set();
  for (const hba of host.hbas) {
    const w = normWwn(hba?.wwn);
    if (!w) continue;
    for (const f of fabrics) {
      if (!f.portByWwn?.has(w)) continue;
      for (const zn of f.zonesOf.get(w) || []) {
        for (const p of zn.wwns || []) {
          if (p === w || f.roles.get(p)?.side === 'initiator') continue;
          const k = `${hba.name}|${p}`;
          if (seen.has(k) || targets.length >= 64) continue;
          seen.add(k);
          const { h, rKBps, wKBps } = demoTargetKBps(w, p);
          targets.push({ adapter: String(hba.name || '').slice(0, 32), init: w, wwn: p, readKB: rKBps * 300, writeKB: wKBps * 300, rKBps, wKBps,
            latR: Math.round((1 + (h % 25) / 10) * 10) / 10, latW: Math.round((1.4 + (h % 30) / 10) * 10) / 10, paths: 2 + (h % 6), partial: false });
        }
      }
    }
  }
  if (!targets.length) return null;
  return { at, sampleSec: 20, samples: 15, instances: targets.reduce((a, t) => a + t.paths, 0), unparsed: 0, truncated: false, targets, mock: true };
}

/** 데모 이력 가중치(storpath/history.js weightsFor 와 같은 모양) — 하루 24표본이 쌓였다고 보고 값은 표본 하나의 24배. */
export function demoWeights(spath, { samples = 24 } = {}) {
  if (!spath?.targets?.length) return null;
  const kb = new Map();
  for (const t of spath.targets) kb.set(`${t.adapter || t.init}|${t.wwn}`, ((t.readKB || 0) + (t.writeKB || 0)) * samples);
  return { kb, samples, firstAt: spath.at - (samples - 1) * 3_600_000, lastAt: spath.at, mock: true };
}

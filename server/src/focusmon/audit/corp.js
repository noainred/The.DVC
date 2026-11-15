/**
 * focusmon/audit/corp.js — 집중 모니터링 대상의 **법인(DataCenter)** (v3.11.0 — 디스크 점검 '법인별로 보기').
 *
 *  · 서버 등록의 법인 칸(target.corp — 법인 id)이 먼저 · 비어 있으면 담당 엣지(수집 서버)의 법인 · 중앙 직접 수집이면 없음('법인 미지정').
 *  · 엣지 → 법인은 서버 분석 · IP 관리와 같은 규칙(collector/datacenterMatch.js — 사용자 매칭 resolvePickedDc → 이름 맞춤 matchDatacenterId).
 *    analysisServers.collectorDcMaps 와 같은 규칙이지만 그 모듈(분석 전체)을 끌어오지 않으려고 같은 순수 함수 둘로 직접 맞춘다.
 *  · 데모 대상은 데모 법인(mock.js demoCorpOf — 실제 법인 목록과 별개).
 */
import { listDatacenters } from '../../datacenter/store.js';
import { loadCollectors } from '../../collector/registry.js';
import { resolvePickedDc, matchDatacenterId } from '../../collector/datacenterMatch.js';
import { demoCorpOf } from './mock.js';

/** 한 요청 안에서 한 번 만든다. @returns {{of:(t)=>({id,name,how}|null), list:Array<{id,name}>}} */
export function corpResolver() {
  let dcs = []; try { dcs = listDatacenters(); } catch { dcs = []; }
  const byAgent = new Map();
  let cols = []; try { cols = loadCollectors(); } catch { cols = []; }
  for (const c of cols) {
    const dc = resolvePickedDc(c.datacenterId, dcs) || matchDatacenterId([c.datacenter, c.id, c.name], dcs);
    if (!dc) continue;
    for (const k of [c.id, c.name]) if (k) byAgent.set(String(k).toLowerCase(), dc);
  }
  const name = (id) => { const d = dcs.find((x) => String(x.id) === String(id)); return d ? String(d.name || d.id) : null; };
  return {
    list: dcs.map((d) => ({ id: String(d.id), name: String(d.name || d.id) })),
    name,
    of(t) {
      if (!t) return null;
      if (t.demo) { const d = demoCorpOf(t.name); return d ? { ...d, how: 'demo' } : null; }
      if (t.corp) { const id = resolvePickedDc(t.corp, dcs); return id ? { id, name: name(id), how: 'set' } : { id: String(t.corp), name: `${t.corp}(지워진 법인)`, how: 'gone' }; }
      if (t.agent) { const id = byAgent.get(String(t.agent).toLowerCase()); if (id) return { id, name: name(id), how: 'edge' }; }
      return null;
    },
  };
}

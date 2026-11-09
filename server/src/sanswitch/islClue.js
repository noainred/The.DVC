/**
 * sanswitch/islClue.js — 팹 비대칭의 단서로 쓰는 **ISL(E-포트) 사용량**(v2.949 · 설계 §12.2-9).
 *
 * 어레이가 물린 스위치의 E-포트(port_meta.port_type 이 E 로 시작 — E-Port · EX-Port · 트렁크 마스터) 피크 포화도를 24시간 창에서 본다.
 * 판정을 바꾸지 않는다 — 팹 비대칭 항목의 문구와 상세 화면에 '그 팹의 ISL 이 얼마나 찼는가' 를 덧붙일 뿐이다(원인 단정 금지 · 설계 §4.3 규칙 표).
 * 포트 속도를 모르면 포화도는 null(0 이 아니다). 장비 호출 0 — perfDb 집계만 읽는다(heavyQuery 기억 TTL 안에서는 같은 결과).
 */
import { portSeries } from './perfDb.js';
import { capBpsOf } from './portUsage.js';
import { numOrNull } from '../util/numOrNull.js';

export const ISL_WINDOW_HOURS = 24;
export const isIslPortType = (t) => /^(E|EX|TE)\b|^E-?port|^Trunk/i.test(String(t || '').trim());

/** 포트 시계열 → 스위치 ISL 요약(순수). series: portSeries().series(portType · speed · peak[]). */
export function islSummaryOf(series = []) {
  const ports = (series || []).filter((p) => isIslPortType(p.portType));
  let worst = null; let unknownSpeed = 0;
  for (const p of ports) {
    const cap = capBpsOf(p.speed);
    const pk = (p.peak || []).filter((v) => v != null);
    if (!pk.length) continue;
    if (!cap) { unknownSpeed += 1; continue; }
    const sat = (Math.max(...pk) / cap) * 100;
    if (!worst || sat > worst.peakSatPct) worst = { port: p.port, speed: p.speed, peakSatPct: Math.round(sat * 10) / 10 };
  }
  return { ports: ports.length, unknownSpeed, peakSatPct: worst?.peakSatPct ?? null, worstPort: worst?.port ?? null, worstSpeed: worst?.speed ?? '' };
}

/**
 * 스위치들의 ISL 요약 — Map(deviceId → islSummaryOf 결과 + name). 실패한 스위치는 { error } 로(조용히 빈 값으로 만들지 않는다).
 * @param {Array<{id:string, name?:string}>} switches
 */
export async function islCluesFor(switches = [], { hours = ISL_WINDOW_HOURS, signal = null } = {}) {
  const out = new Map();
  for (const sw of switches) {
    const id = String(sw?.id ?? sw ?? '');
    if (!id || out.has(id)) continue;
    try {
      const r = await portSeries(id, { hours, points: hours, signal });
      out.set(id, { deviceId: id, name: sw.name || id, unavailable: !!r?.unavailable, ...islSummaryOf(r?.series || []) });
    } catch (e) {
      out.set(id, { deviceId: id, name: sw.name || id, error: String(e?.message || e).slice(0, 120), ports: 0, unknownSpeed: 0, peakSatPct: null, worstPort: null, worstSpeed: '' });
    }
  }
  return out;
}

/** 팹 비대칭 문구에 붙일 한 줄(순수). 둘 다 없으면 ''. */
export function islClueText(fabrics = [], clues = new Map(), { warnPct = null } = {}) {
  const parts = [];
  for (const f of fabrics || []) {
    const c = clues.get(String(f.deviceId));
    if (!c) continue;
    if (c.error) { parts.push(`${f.name}: ISL 조회 실패`); continue; }
    if (!c.ports) { parts.push(`${f.name}: ISL 없음`); continue; }
    if (c.peakSatPct == null) { parts.push(`${f.name}: ISL ${c.ports}개 · 속도 모름`); continue; }
    const hot = numOrNull(warnPct) != null && c.peakSatPct >= warnPct;
    parts.push(`${f.name}: ISL 피크 ${c.peakSatPct}%${hot ? '(포화 주의)' : ''}`);
  }
  return parts.length ? `ISL 단서 — ${parts.join(' · ')}` : '';
}

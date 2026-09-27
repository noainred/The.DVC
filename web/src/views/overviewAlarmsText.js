/**
 * overviewAlarmsText.js — 개요 '최근 알람' 패널(v2.631 감사 WEB2631-02, 순수).
 *
 * ① /alarms 는 정렬하지 않고 vCenter 순서로 준다 — 앞 N 건은 '최근' 이 아니다. 화면도 시각 내림차순(동률이면 critical 먼저)으로
 *   정렬한 뒤 자른다(서버가 정렬해 주더라도 방어). 시각을 못 읽은 항목은 뒤로 보낸다.
 * ② 목록이 비었다고 '활성 알람이 없습니다' 라 말하지 않는다 — 권한 없음(403·inv.alarms 없음) / 아직 못 받음 / 조회 실패 /
 *   REST 폴백 vCenter(경보 미조회)가 섞여 있으면 그 사실을 말한다. '없다' 는 전부 읽었을 때만이다.
 */
import { alarmTotals } from './restFallbackText.js';

const SEV_RANK = { critical: 0, warning: 1, info: 2 };

function timeMs(t) {
  if (typeof t === 'number' && Number.isFinite(t)) return t;
  if (typeof t === 'string' && t.trim() && !/^\d+$/.test(t.trim())) {
    const ms = Date.parse(t);
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof t === 'string' && /^\d+$/.test(t.trim())) return Number(t.trim());
  return null;
}

/** 시각 내림차순(동률이면 심각도 순) 정렬 후 앞 n 건. 원본 배열은 바꾸지 않는다. */
export function recentAlarms(items, n = 8) {
  const list = Array.isArray(items) ? items.filter((a) => a && typeof a === 'object') : [];
  return list
    .map((a, i) => ({ a, i, t: timeMs(a.time) }))
    .sort((x, y) => {
      if (x.t == null && y.t != null) return 1;
      if (y.t == null && x.t != null) return -1;
      if (x.t != null && y.t != null && x.t !== y.t) return y.t - x.t;
      const sx = SEV_RANK[x.a.severity] ?? 9;
      const sy = SEV_RANK[y.a.severity] ?? 9;
      if (sx !== sy) return sx - sy;
      return x.i - y.i;
    })
    .slice(0, n)
    .map((x) => x.a);
}

/**
 * 비어 있을 때의 문구와 보조 문구.
 * @param {{ allowed:boolean, data:any, error:any, forbidden?:boolean, sites?:Array }} p
 * @returns {{ empty: string|null, note: string|null }}  empty 는 목록이 비었을 때만 쓴다
 */
export function alarmPanelText({ allowed, data, error, forbidden = false, sites } = {}) {
  const unknown = Array.isArray(sites) ? alarmTotals(sites).unknown : 0;
  const note = unknown > 0 ? `REST 폴백 vCenter ${unknown}곳은 경보를 조회하지 않아 이 목록에 없습니다` : null;
  if (!allowed || forbidden) return { empty: '알람 조회 권한(inv.alarms)이 없어 표시하지 않습니다 — 관리자에게 요청하세요.', note: null };
  if (!data) return { empty: error ? '알람을 불러오지 못했습니다 — 잠시 뒤 다시 시도합니다.' : '알람을 불러오는 중…', note };
  if (unknown > 0) return { empty: '조회한 vCenter 에는 활성 알람이 없습니다.', note };
  return { empty: '활성 알람이 없습니다.', note: null };
}

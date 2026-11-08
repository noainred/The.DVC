/**
 * views/tools/bmPowerText.js — 리눅스 성능 8b단계 **전력 · 온도 집계** 문구 · 표시 도우미(순수 — vitest node 환경).
 * ⚠ 합계 · 피크 · 여유 · 걸림 · 미측정 사유는 서버(bmusage/powerAgg.js)가 계산한다 — 여기는 문장 · 좌표로 바꾸기만(웹이 다시 합하지 않는다).
 * ⚠ 값이 없으면 ‘—’(단위 없음) · 미측정은 합계에 없고 수만 적는다 · 부분 시간은 점선.
 */
import { unitText } from '../unitText.js';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
export const UNMEASURED_TEXT = Object.freeze({ 'no-idrac': 'iDRAC 없음', 'read-fail': '읽기 실패', zero: '0 W 보고' });
export const kwText = (v) => (num(v) == null ? '—' : v >= 10_000 ? `${(v / 1000).toFixed(2)} MW` : `${v.toFixed(v < 10 ? 2 : 1)} kW`);
export const kwhText = (v) => (num(v) == null ? '—' : v >= 10_000 ? `${(v / 1000).toFixed(1)} MWh` : `${Math.round(v).toLocaleString()} kWh`);
export const wText = (v) => (num(v) == null ? '—' : `${Math.round(v)} W`);
export const cText = (v) => (num(v) == null ? '—' : `${v.toFixed(1)} °C`);
const hm = (ms) => { const d = new Date(ms); return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:00`; };
export const hourText = (ms) => (num(ms) == null ? '—' : hm(ms));
export function unmeasuredText(u = {}) {
  const parts = Object.entries(UNMEASURED_TEXT).map(([k, v]) => (u?.[k] ? `${v} ${u[k]}` : null)).filter(Boolean);
  return parts.length ? parts.join(' · ') : '없음';
}
export function marginText(r) {
  if (r?.unmapped) return '—';
  if (num(r?.capKw) == null) return '상한 미설정';
  // 8b 반증 F6: 미측정 서버가 있는 랙은 서버가 여유를 판정하지 않는다(부분 합) — 측정 수만 말한다(피크와 같은 규칙).
  if (r?.marginPartial) return `일부만 측정(${r.measured ?? 0}/${r.servers ?? 0})`;
  if (num(r?.marginPct) == null) return '—';
  return r.marginPct < 0 ? `상한 초과 ${Math.abs(r.marginPct)}%` : `${r.marginPct}%`;
}
export function capText(s, cfg = {}) {
  if (num(s?.capW) == null) return '—';
  return `${s.capHit ? '걸림' : '설정'}(${Math.round(s.capW)} W${num(s.capPct) != null ? ` · ${s.capPct}%` : ''})`;
}
export function fanText(s) {
  if (s?.fanRead === false) return '못 읽음';
  if (num(s?.fanWarn) == null) return '—';
  return s.fanWarn ? `경고 ${s.fanWarn}` : '—';
}
/** 요약 카드(순수). */
export function powerCards(f = {}, cfg = {}) {
  return [
    { k: 'measured', label: '측정 · 미측정', value: `${f.measured ?? 0} · ${f.unmeasuredN ?? 0}`, sub: `미측정: ${unmeasuredText(f.unmeasured)} — 합계는 측정분만(추정으로 메우지 않습니다)` },
    { k: 'now', label: '지금 합계', value: kwText(f.nowKw), sub: `서버 표본 합 · 랙 ${f.racks ?? 0} · 미매핑 ${f.unmappedServers ?? 0}대` },
    { k: 'kwh', label: '24h 전력량', value: kwhText(f.kwh24), sub: `시간 평균 W × 1h 합 · 월 누적 ${kwhText(f.kwhMonth)}(${f.monthServers ?? 0}대)` },
    { k: 'peak', label: '24h 피크', value: kwText(f.peak24Kw), sub: f.peak24At ? `${hourText(f.peak24At)} · 같은 시간 합(시간 평균 기준)${f.partialHours ? ` · 부분 시간 ${f.partialHours}개는 뺌` : ''}` : '시간 롤업이 없습니다' },
    { k: 'margin', label: '랙 상한 여유 최소', value: f.minMargin ? (f.minMargin.pct < 0 ? `상한 초과 ${Math.abs(f.minMargin.pct)}%` : `${f.minMargin.pct}%`) : '—', sub: `${f.minMargin ? `${f.minMargin.rack}(${f.minMargin.vcenterId}) · 상한은 설정값(kW)` : (f.partialRacks ? '다 측정된 상한 랙이 없습니다' : '상한을 정한 랙이 없습니다')}${f.partialRacks ? ` · 일부만 측정된 랙 ${f.partialRacks}개는 판정하지 않음(부분 합)` : ''} · PowerCap 설정 서버 ${f.capSet ?? 0} · 걸림 ${f.capHit ?? 0}` },
    { k: 'hot', label: `흡기 ≥ ${cfg.inletWarnC ?? 27} °C`, value: `${f.hotCount ?? 0}대`, sub: f.hottest ? `최대 ${cText(f.hottest.inletC)} ${f.hottest.name} · 기준은 설정값(모델별 권장 아님)` : '기준은 설정값(모델별 권장 아님)' },
    { k: 'fan', label: '팬 경고', value: `${f.fanWarn ?? 0}`, sub: `파트 장애(⑦)에서 가져옴 · 재판정하지 않음 · 팬 못 읽음 ${f.fanUnread ?? 0}대(정상으로 세지 않음)` },
  ];
}
/** 24시간 추이 좌표(순수) — 부분 시간은 따로(점선). */
export function trendPath(trend = [], { width = 1000, height = 100 } = {}) {
  const pts = (Array.isArray(trend) ? trend : []).filter((p) => num(p?.kw) != null);
  if (!pts.length) return { line: '', partial: [], max: null, min: null };
  const t0 = pts[0].t; const t1 = pts[pts.length - 1].t; const span = Math.max(1, t1 - t0);
  const mx = Math.max(...pts.map((p) => p.kw)); const mn = Math.min(...pts.map((p) => p.kw));
  const lo = Math.max(0, mn - (mx - mn) * 0.2 - 0.01); const hi = mx + (mx - mn) * 0.1 + 0.01;
  const xy = (p) => [((p.t - t0) / span) * width, height - ((p.kw - lo) / (hi - lo)) * height];
  const full = pts.filter((p) => !p.partial);
  const line = full.map((p, i) => { const [x, y] = xy(p); return `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`; }).join(' ');
  return { line, partial: pts.filter((p) => p.partial).map((p) => xy(p)), max: mx, min: mn };
}
export const POWER_HONEST = Object.freeze([
  '원천은 기존 iDRAC 폴러의 전력 표본 · 시간 롤업과 센서 표본입니다 — **전력 대시보드(법인 · 리전)와 같은 함수로 지금 값을 읽습니다**(vCenter 추정 전력은 넣지 않습니다).',
  '**미측정(iDRAC 없음 · 읽기 실패 · 0 W 보고)은 합계에서 빼고 수를 적습니다** — 0 W 를 꺼짐 · 유휴로 더하지 않습니다. PDU 측정은 범위 밖입니다.',
  '온도는 **지금 값만** 그립니다 — 흡기 시계열은 서버별 상세 온도 적재(옵트인 · 기본 꺼짐)를 켰을 때만 저장되어 이 화면은 추이를 그리지 않습니다. 흡기 기준은 설정값이고 모델별 Dell 권장 범위를 인용하지 않았습니다.',
  '랙 · U 는 설정 › 알림 규칙의 **랙 배치**가 유일한 원천입니다(등록 CSV 에 ‘랙/위치’ 열이 없고 iDRAC 위치 속성은 읽지 않습니다) — 없는 서버는 ‘미매핑’ 으로 묶어 따로 셉니다. 엣지 위임 서버의 PowerCap 은 엣지 인벤토리 요약에 없어 ‘—’ 입니다.',
]);
export const unitPct = (v) => unitText(num(v), '%');

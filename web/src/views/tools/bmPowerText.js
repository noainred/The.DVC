/**
 * views/tools/bmPowerText.js — 리눅스 성능 8b단계 **전력 · 온도 집계** 문구 · 표시 도우미(순수 — vitest node 환경).
 * ⚠ 합계 · 피크 · 여유 · 걸림 · 미측정 사유는 서버(bmusage/powerAgg.js)가 계산한다 — 여기는 문장 · 좌표로 바꾸기만(웹이 다시 합하지 않는다).
 * ⚠ 값이 없으면 ‘—’(단위 없음) · 미측정은 합계에 없고 수만 적는다 · 부분 시간은 점선.
 */
import { unitText } from '../unitText.js';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
export const UNMEASURED_TEXT = Object.freeze({ 'no-idrac': 'iDRAC 없음', 'read-fail': '읽기 실패', zero: '0 W 보고', 'not-target': '대상 목록에 없음', 'not-judge': '판정 노드 아님' });
/**
 * 알림 판정 노드가 없는 이유(서버 powerJudge.js JUDGE_REASONS — 반증 n2 F4). 화면 칸은 ‘알림 판정 없음’ 으로 짧게 · 이유는 마우스 설명.
 */
export const JUDGE_REASON_TEXT = Object.freeze({
  'source-edge': '전력 원천이 엣지 사본뿐 — 이 노드 대상이지만 원천 노드가 아니라 어느 노드도 판정하지 않습니다',
  'source-central': '전력 원천이 중앙(OME 등)뿐 — 엣지 대상이지만 그 엣지에 표본이 없어 어느 노드도 판정하지 않습니다',
  'corp-edge-owned': '법인을 엣지가 맡아 중앙은 판정하지 않습니다 — 그 엣지의 대상이 아니면 아무도 판정하지 않습니다',
  'judge-unknown': '법인을 맡은 엣지의 봉투가 없어(꺼짐 · 당기기 실패 · 아직 안 당김) 판정 여부를 모릅니다 — 중앙은 판정하지 않습니다',
  'edge-old': '엣지 버전 낮음 — 그 엣지 판에는 전력 알림 규칙이 없어 아무도 판정하지 않습니다',
  'member-unknown': '배치 서버 일부가 대상 목록에 없어 랙을 판정하지 않습니다',
  'member-no-judge': '판정 노드가 없는 서버가 있어 랙을 판정하지 않습니다',
  'members-split': '서버마다 판정 노드가 달라 랙을 판정하지 않습니다',
});
export const judgeTitle = (x) => (x && x.judgeNode == null && x.judgeReason ? JUDGE_REASON_TEXT[x.judgeReason] || x.judgeReason : undefined);
export const hasNoJudge = (x) => !!(x && x.judgeNode == null && x.judgeReason);
/** 칸 아래 한 줄 — ‘모름’(엣지 봉투 없음)은 ‘없음’ 과 다르게 쓴다(반증 n2 재확인 N4). */
export const noJudgeLabel = (x) => (x?.judgeReason === 'judge-unknown' ? '알림 판정 모름' : '알림 판정 없음');
const REASON_SHORT = Object.freeze({ 'source-edge': '원천 엣지 사본', 'source-central': '원천 중앙', 'corp-edge-owned': '법인 엣지 담당', 'edge-old': '엣지 버전 낮음' });
export function noJudgeText(nj = {}) {
  if (!nj) return '';
  const parts = [];
  if (nj.servers || nj.racks) {
    const by = Object.entries(nj.byReason || {}).map(([k, v]) => `${REASON_SHORT[k] || k} ${v}`).join(' · ');
    parts.push(`알림 판정 노드가 없는 서버 ${nj.servers || 0}대 · 상한 랙 ${nj.racks || 0}개${by ? `(${by})` : ''} — 화면 값은 보이지만 전력 알림 규칙은 그 서버 · 랙을 판정하지 않습니다(두 번 알리지 않는 쪽).`);
  }
  if (nj.unknown || nj.unknownRacks) parts.push(`판정 여부 모름 — 서버 ${nj.unknown || 0}대 · 상한 랙 ${nj.unknownRacks || 0}개(법인을 맡은 엣지의 봉투가 없어 그 엣지가 판정하는지 모릅니다 · 위 ‘없음’ 수에 넣지 않았습니다).`);
  return parts.join(' ');
}
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
/**
 * 서버 상한 상태(서버 powerAgg capState) → 이유 문구. ⚠ ‘엣지 버전 낮음’ 은 old-version(봉투에 표지 없음)일 때만 — 못 읽음 · 낡음에 버전 이유를 붙이지 않는다.
 */
export const CAP_STATE_TEXT = Object.freeze({
  set: '상한 설정', unset: '상한 값 없음(0 · 빈 값)', unread: '못 읽음(인벤토리 없음 · 2시간 넘음 · PowerLimit 미보고)', stale: '엣지가 읽은 지 2시간 넘음', 'old-version': '엣지 버전 낮음',
});
export function capText(s, cfg = {}, minEdgeVersion = null) {
  if (num(s?.capW) == null) return s?.capState === 'old-version' ? `— 엣지 버전 낮음${minEdgeVersion ? `(v${minEdgeVersion} 이상)` : ''}` : '—';
  return `${s.capHit ? '걸림' : '설정'}(${Math.round(s.capW)} W${num(s.capPct) != null ? ` · ${s.capPct}%` : ''})`;
}
/** 상한 칸 마우스 설명(값이 없을 때 이유 — 화면 글은 ‘—’ 로 짧게). */
export function capTitle(s) {
  if (num(s?.capW) != null) return undefined;
  return CAP_STATE_TEXT[s?.capState] || undefined;
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
  '랙 · U 는 설정 › 알림 규칙의 **랙 배치**가 유일한 원천입니다(등록 CSV 에 ‘랙/위치’ 열이 없고 iDRAC 위치 속성은 읽지 않습니다) — 없는 서버는 ‘미매핑’ 으로 묶어 따로 셉니다. 엣지 위임 서버의 PowerCap 은 **그 엣지가 봉투에 싣는 서버별 상한**(읽은 시각이 2시간 안인 것만)을 씁니다 — 그 기능 이전 판 엣지는 ‘— 엣지 버전 낮음’, 못 읽었으면 ‘—’(칸에 마우스를 올리면 이유)입니다.',
]);
export const unitPct = (v) => unitText(num(v), '%');

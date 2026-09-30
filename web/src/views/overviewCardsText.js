/**
 * overviewCardsText.js — Overview 카드 8장 · 전체 소비 전력 문구(v2.664, 순수 — vitest).
 * 값이 없으면 단위 없는 '—' 다(0 kW·0 TB 는 '없다' 는 거짓 — unitText 규약). 백틱·별표 금지(BoldText 규약).
 */
const nf = new Intl.NumberFormat('ko-KR');
export const countText = (n) => (n == null || !Number.isFinite(Number(n)) ? '—' : nf.format(Number(n)));
/** W → kW(10 kW 미만은 소수 1자리). */
export function kwText(w) {
  if (w == null || !Number.isFinite(Number(w))) return '—';
  const kw = Number(w) / 1000;
  return `${kw >= 10 ? nf.format(Math.round(kw)) : (Math.round(kw * 10) / 10).toFixed(1)} kW`;
}
/** 바이트 → TB/PB(10진). */
export function capText(b) {
  if (b == null || !Number.isFinite(Number(b)) || Number(b) <= 0) return '—';
  const tb = Number(b) / 1e12;
  return tb >= 1000 ? `${(tb / 1000).toFixed(2)} PB` : `${tb >= 100 ? nf.format(Math.round(tb)) : tb.toFixed(1)} TB`;
}
/** 측정 장비가 없는 칸(0 W)은 '—' — 0 kW 는 '전력 0' 으로 읽힌다. */
export const kwOrDash = (w) => (Number(w) > 0 ? kwText(w) : '—');
export const wText = (w) => (w == null || !Number.isFinite(Number(w)) ? '—' : `${nf.format(Math.round(Number(w)))} W`);

/** 카드 부제 — 무엇을 셌고 무엇을 뺐는지. */
export function cardMeta(k, c) {
  if (!c) return '';
  if (c[k]?.reason) return c[k].reason;
  switch (k) {
    case 'datacenters': return '설정 › DataCenter 등록 수';
    case 'farms': return '설정 › 수집 Agent 등록 수';
    case 'physical': { const p = c.physical; return `서버 분석 등록 · 인벤토리 수집 ${countText(p.inventoryRead)}대`; }
    case 'virtual': { const v = c.virtual; return `구동 ${countText(v.poweredOn)}${v.templates ? ` · 템플릿 ${countText(v.templates)}` : ''} · vCenter ${countText(v.vcenters)}${v.vcentersPending ? ` (첫 수집 중 ${v.vcentersPending})` : ''}`; }
    case 'gpus': return `서버 분석 인벤토리 기준 · 수집 ${countText(c.gpus.inventoryRead)}/${countText(c.gpus.servers)}대`;
    case 'storage': { const s = c.storage; if (s.totalBytes == null) return s.devices ? `용량을 읽은 장비 없음(${s.devices}대)` : '등록된 스토리지 없음';
      return `사용 ${s.usedPct == null ? '—' : `${s.usedPct}%`} · ${s.read}/${s.devices}대${s.unread ? ` · 못 읽음 ${s.unread}` : ''}`; }
    case 'network': { const n = c.network; if (n.unavailable) return 'CVP DB 를 열 수 없습니다'; if (n.error) return `읽기 실패: ${n.error}`; return `CVP 등록 장비 · CVP 서버 ${countText(n.cvpServers)}대`; }
    case 'power': { const p = c.power; const k = (x) => (x?.measured ? kwText(x.watts) : '—'); return `서버 ${k(p.servers)} · 네트워크 ${k(p.network)} · 스토리지 ${k(p.storage)}`; }
    default: return '';
  }
}
/** 전력 카테고리 문구 — 측정 대수와 뺀 대수를 함께. */
export function powerCatNote(cat, x) {
  if (!x) return '';
  if (cat === 'servers') return `iDRAC 실측 ${countText(x.measured)}대${x.excludedVcenter ? ` · vCenter 추정 ${countText(x.excludedVcenter)}대는 뺐습니다` : ''}`;
  const miss = [];
  if (x.unread) miss.push(`못 읽음 ${x.unread}`);
  if (x.stale) miss.push(`오래된 값 ${x.stale}`);
  if (cat === 'storage' && x.unsupported) miss.push(`수집 경로 없음 ${x.unsupported}`);
  if (cat === 'network' && x.outputOnly) miss.push(`출력 전력만 ${x.outputOnly}`);
  return `측정 ${countText(x.measured)}/${countText(x.devices)}대${miss.length ? ` · ${miss.join(' · ')}` : ''}`;
}
export const POWER_FOOTNOTE = [
  '서버는 iDRAC(OME·엣지 포함) 실측 최신값입니다. vCenter 가 추정한 호스트 전력은 넣지 않습니다.',
  '네트워크는 CVP 가 읽은 전원공급장치(PSU) 입력 전력 합입니다. 입력이 없고 출력만 있으면 출력을 씁니다(효율 손실만큼 작게 보입니다). 필드 이름은 실장비로 확인하지 못한 추정입니다.',
  '스토리지는 Unity(SSH 수집)의 svc_diag 전원공급장치 입력 전력입니다 — DPE 만이고 확장 DAE 는 빠집니다. 다른 스토리지는 전력 수집 경로가 없어 합계에 없습니다.',
  '못 읽은 장비는 0 W 로 채우지 않고 개수만 밝힙니다. 6시간보다 오래된 네트워크·스토리지 값은 현재값이 아니라 뺍니다.',
];

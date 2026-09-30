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
/** 스토리지 전력 '못 읽음' 사유(서버 power/total.js · storage/power.js PROBE_REASONS 와 1:1 — 테스트가 대조). */
export const STORAGE_POWER_REASON = Object.freeze({
  'no-snapshot': '수집 결과 없음(아직 수집 전이거나 엣지 보고 없음)',
  'collect-failed': '장비 수집 실패(스토리지 모니터링의 오류 참조)',
  'not-reported': '수집기가 전력을 보고하지 않음(수집한 포탈·엣지가 2.667 미만이거나 다음 수집 전)',
  'request-failed': '전원 조회 요청 실패',
  'no-field': '응답에 전원 필드 없음',
  'skipped': '수집 시간 예산이 모자라 이번 주기에 건너뜀',
  'parse-failed': '전원 출력 해석 실패',
  stale: '6시간보다 오래된 값',
});
export function storagePowerReasonText(code) { return STORAGE_POWER_REASON[code] || String(code || '사유 미상'); }
/** 사유별 개수 → '응답에 전원 필드 없음 12 · …'(많은 순). */
export function reasonCountsText(by) {
  return Object.entries(by || {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${STORAGE_POWER_REASON[k] ? storagePowerReasonText(k) : k} ${n}`).join(' · ');
}

export const POWER_FOOTNOTE = [
  '서버는 iDRAC(OME·엣지 포함) 실측 최신값입니다. vCenter 가 추정한 호스트 전력은 넣지 않습니다.',
  '네트워크는 CVP 가 읽은 전원공급장치(PSU) 입력 전력 합입니다. 입력이 없고 출력만 있으면 출력을 씁니다(효율 손실만큼 작게 보입니다). 필드 이름은 실장비로 확인하지 못한 추정입니다.',
  '스토리지는 수집기가 읽은 전력입니다 — Unity SSH(svc_diag 전원공급장치 입력 · DPE 만, 확장 DAE 제외) · Unity REST(시스템 현재 전력) · PowerStore·XtremIO(전원공급장치) · Isilon(통계 전원 키 · 노드 합) · PowerMax/VMAX(어레이 상세 응답). Unity SSH 외의 필드 이름은 실장비로 확인하지 못한 추정이라, 못 읽은 장비는 아래 표에 사유와 응답에 있던 키를 보여 줍니다. VPLEX 와 일부 SSH 수집 방식은 전력 수집 경로가 없습니다.',
  '못 읽은 장비는 0 W 로 채우지 않고 개수만 밝힙니다. 6시간보다 오래된 네트워크·스토리지 값은 현재값이 아니라 뺍니다.',
];

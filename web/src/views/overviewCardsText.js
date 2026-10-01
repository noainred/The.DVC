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
/**
 * v2.675(v2.672 남은 일 — '첫 수집 중 화면의 0 표시'): 첫 병합 전 골격(/overview 의 initial)이면 인벤토리를 아직 하나도 읽지
 * 않았다 — 0 대·0 호스트를 그리지 않고 이 안내를 보인다. 골격이 아니면 null(평소 화면).
 * 동시성·데드라인 숫자는 문구에 박지 않는다(서버 설정으로 바뀐다 — v2.509 규약).
 * @returns {{title:string, detail:string}|null}
 */
export function firstCollectNotice(ov) {
  if (!ov || ov.initial !== true) return null;
  const g = ov.global || {};
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const total = num(g.vcenters);
  const off = num(g.vcentersDisabled);
  const maint = num(g.vcentersMaintenance);
  const unreach = num(g.vcentersUnreachable);
  const pending = num(g.vcentersPending);
  // 골격의 vCenter 는 비활성·점검 중·인증 정지(unreachable) 가 아니면 전부 첫 수집 중(pending)이다 — pending 이 0 이면 읽을 것이 없어
  //   병합이 곧 끝난다('마무리'). 등록이 없거나 전부 꺼져 있으면 기다려도 채워지지 않으므로 조치를 말한다.
  const [title, first] = pending > 0
    ? [`첫 수집 중 — vCenter ${nf.format(pending)}곳을 처음 읽고 있습니다`, '끝나면 이 화면이 채워집니다. vCenter 수와 회선 지연에 따라 몇 분 걸릴 수 있습니다.']
    : total === 0 ? ['등록된 vCenter 가 없습니다', '설정 › vCenter 에서 등록하면 수집을 시작합니다.']
      : total - off === 0 ? ['켜진 vCenter 가 없습니다', '설정 › vCenter 에서 켜면 수집을 시작합니다.']
        : ['첫 수집을 마무리하고 있습니다', '곧 이 화면이 채워집니다.'];
  const parts = [first];
  if (unreach > 0) parts.push(`인증 실패로 수집을 멈춘 vCenter ${nf.format(unreach)}곳은 기다려도 채워지지 않습니다 — 설정 › vCenter 에서 계정을 확인하세요.`);
  if (maint > 0) parts.push(`점검 중 ${nf.format(maint)}곳은 수집하지 않습니다.`);
  if (off > 0) parts.push(`비활성 ${nf.format(off)}곳은 제외했습니다.`);
  return { title, detail: parts.join(' ') };
}
/**
 * v2.682 R3D-02: GPU 카드 값 — 인벤토리를 한 대도 못 읽었으면 0 이 아니라 null('—'), 일부만 읽었으면 최소값임을 밝힌다
 *   (경영 보기 execOverviewText.gpuKpi 와 같은 규칙 — 그 모듈이 이 파일을 import 하므로 여기 두고 저쪽 판정과 대조 테스트한다).
 */
export function gpuCardValue(g) {
  if (!g) return { value: null, partial: false, unknown: false };
  // v2.683: 오래된 인벤토리의 카드도 합계에 들어간다(사용자 결정 "iDRAC 에 등록된 카드만") — '읽음' 은 인벤토리가 있는 서버 전부.
  const read = (Number(g.inventoryRead) || 0) + (Number(g.inventoryStale) || 0);
  const servers = Number(g.servers) || 0;
  const unknown = servers > 0 && read === 0;
  const partial = !unknown && read < servers;
  return { value: unknown ? null : (g.count ?? null), partial, unknown };
}
/** GPU 카드 부제 — 서버 분석 › GPU 찾기와 같은 기준(iDRAC 인벤토리 카드만)이고, 섞인 것·뺀 것을 밝힌다. */
export function gpuCardMeta(g) {
  if (!g) return '';
  const v = gpuCardValue(g);
  const read = (Number(g.inventoryRead) || 0) + (Number(g.inventoryStale) || 0);
  return `iDRAC 인벤토리 카드만 · 수집 ${countText(read)}/${countText(g.servers)}대`
    + (g.gpusStale ? ` · 오래된 인벤토리 ${countText(g.inventoryStale)}대의 ${countText(g.gpusStale)}장 포함` : g.inventoryStale ? ` · 오래된 인벤토리 ${countText(g.inventoryStale)}대` : '')
    + (g.gpusUnnamed ? ` · 모델 미상 ${countText(g.gpusUnnamed)}장 포함` : '')
    + (v.unknown ? ' · 아직 읽은 서버가 없습니다' : v.partial ? ' · 미수집 서버 제외(최소값)' : '');
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
    case 'physical': { const p = c.physical; return `서버 분석 등록 · 인벤토리 수집 ${countText(p.inventoryRead)}대${p.inventoryStale ? ` · 오래된 인벤토리 ${countText(p.inventoryStale)}` : ''}${p.disabled ? ` · 비활성 ${countText(p.disabled)}대 제외` : ''}`; }
    case 'virtual': { const v = c.virtual; return `구동 ${countText(v.poweredOn)}${v.templates ? ` · 템플릿 ${countText(v.templates)}` : ''} · vCenter ${countText(v.vcenters)}${v.vcentersPending ? ` (첫 수집 중 ${v.vcentersPending})` : ''}`; }
    case 'gpus': return gpuCardMeta(c.gpus);
    case 'storage': { const s = c.storage; if (s.totalBytes == null) return s.devices ? `용량을 읽은 장비 없음(${s.devices}대${s.stale ? ` · 오래된 값 ${s.stale}` : ''})` : '등록된 스토리지 없음';
      // v2.682 R3D-05: 사용량 모름·오래된 값을 밝힌다 — 사용률은 사용량을 읽은 장비끼리만이다.
      return `사용 ${s.usedPct == null ? '—' : `${s.usedPct}%`} · ${s.read}/${s.devices}대${s.unread ? ` · 못 읽음 ${s.unread}` : ''}${s.stale ? ` · 오래된 값 ${s.stale}` : ''}${s.usedUnknown ? ` · 사용량 모름 ${s.usedUnknown}(사용률에서 뺌)` : ''}`; }
    case 'network': { const n = c.network; if (n.unavailable) return 'CVP DB 를 열 수 없습니다'; if (n.error) return `읽기 실패: ${n.error}`; if (n.errorHidden) return '읽기 실패(사유는 관리자에게만 표시합니다)'; return `CVP 등록 장비 · CVP 서버 ${countText(n.cvpServers)}대`; }
    case 'power': return powerCardMeta(c.power);
    default: return '';
  }
}
/**
 * v2.680 D-04: 카테고리 kW — 읽은 장비(완전 측정 + 일부 PSU 만 읽은 장비)가 하나도 없으면 '—'(0.0 kW 는 '전력 0' 으로 읽힌다).
 * 값이 있으면 0 W 도 그대로 보인다(측정한 0 은 값이다).
 */
export function powerCatKw(x) {
  if (!x) return '—';
  const n = (Number(x.measured) || 0) + (Number(x.partial) || 0);
  return n > 0 ? kwText(x.watts) : '—';
}
/** 전체 합계 kW — 어느 카테고리도 읽은 장비가 없으면 '—'. */
export function powerTotalKw(d) {
  if (!d) return '—';
  const any = ['servers', 'network', 'storage'].some((k) => (Number(d[k]?.measured) || 0) + (Number(d[k]?.partial) || 0) > 0);
  return any ? kwText(d.totalWatts) : '—';
}
/**
 * v2.682 R3S-07: 원천 오류 문구 — 서버는 admin 이 아니면 원문 대신 true(실패 사실만)를 준다. 원문이 있으면 그대로,
 *   없으면 '사유는 관리자에게만 표시' 로 말한다. 실패가 없으면 ''.
 */
const SOURCE_LABEL = { servers: '서버 전력', network: '네트워크(CVP)', storage: '스토리지', serversRegistry: '서버 분석 등록부' };
export function sourceErrorsText(errors) {
  const ent = Object.entries(errors || {}).filter(([, v]) => v);
  if (!ent.length) return '';
  return ent.map(([k, v]) => `${SOURCE_LABEL[k] || k} — ${typeof v === 'string' ? v : '사유는 관리자에게만 표시합니다'}`).join(' · ');
}
/**
 * v2.682 R3D-01: Overview 소비 전력 카드 부제 — 카테고리 kW 와 함께 '측정 m/n대' 와 빠진 대수(못 읽음·오래됨·일부만 읽음)를 말한다.
 *   예전 부제는 kW 만 있어, 등록 50대 중 1대만 읽은 합계가 전체처럼 보였다.
 */
export function powerCardMeta(p) {
  if (!p) return '';
  if (p.reason) return p.reason;
  const k = (x) => powerCatKw(x);
  const head = `서버 ${k(p.servers)} · 네트워크 ${k(p.network)} · 스토리지 ${k(p.storage)}`;
  const n = (v) => Number(v) || 0;
  let measured = 0; let devices = 0; let devicesKnown = true;
  for (const c of ['servers', 'network', 'storage']) {
    const x = p[c] || {};
    measured += c === 'servers' ? Math.max(0, n(x.measured) - n(x.ome)) : n(x.measured);
    if (x.devices == null) devicesKnown = false; else devices += c === 'storage' ? Math.max(0, n(x.devices) - n(x.unsupported)) : n(x.devices);
  }
  const unread = n(p.servers?.unread) + n(p.network?.unread) + n(p.storage?.unread);
  const stale = n(p.network?.stale) + n(p.storage?.stale);
  const partial = n(p.network?.partial) + n(p.storage?.partial);
  const bits = [devicesKnown ? `측정 ${countText(measured)}/${countText(devices)}대` : `측정 ${countText(measured)}대`];
  if (unread) bits.push(`못 읽음 ${countText(unread)}`);
  if (stale) bits.push(`오래된 값 ${countText(stale)}`);
  if (partial) bits.push(`일부만 읽음 ${countText(partial)}`);
  if (unread || stale || partial) bits.push('읽은 장비만의 합');
  return `${head} · ${bits.join(' · ')}`;
}
/** 전력 카테고리 문구 — 측정 대수와 뺀 대수를 함께. */
export function powerCatNote(cat, x) {
  if (!x) return '';
  if (cat === 'servers') {
    // v2.680 A-06: 분모(서버 분석 등록 · 활성 · OME 콘솔 제외)가 있으면 '측정 m/n대' 로 말한다. 없으면(구버전 응답) 예전 문구.
    const parts = [];
    if (x.devices != null) {
      parts.push(`iDRAC 실측 ${countText(Math.max(0, (Number(x.measured) || 0) - (Number(x.ome) || 0)))}/${countText(x.devices)}대`);
      if (x.unread) parts.push(`못 읽음·오래된 값 ${countText(x.unread)}`);
      if (x.ome) parts.push(`OME 로 읽음 ${countText(x.ome)}`);
    } else parts.push(`iDRAC 실측 ${countText(x.measured)}대`);
    if (x.excludedVcenter) parts.push(`vCenter 추정 ${countText(x.excludedVcenter)}대는 뺐습니다`);
    return parts.join(' · ');
  }
  const miss = [];
  // v2.680 A-05: 장착 PSU 중 일부만 읽은 스위치 — 합계에는 읽은 PSU 만 들어 있어 실제보다 작다.
  if (cat === 'network' && x.partial) miss.push(`일부 PSU 만 읽음 ${x.partial}(합계가 실제보다 작음)`);
  // v2.682 R3D-03: 스토리지도 일부 부품(PSU·노드)만 읽은 장비가 있다 — 측정 대수에서 빼고 따로 말한다.
  if (cat === 'storage' && x.partial) miss.push(`일부 부품만 읽음 ${x.partial}(합계가 실제보다 작음)`);
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

/**
 * cvpMoreText.js — v2.641 CVP 화면의 새 항목 문구·판정(순수 — vitest 로 고정).
 *   ② 장비 개요(레거시 인벤토리·수명주기·버그 노출) ③ CPU·메모리 ④ 이벤트 ⑤ 포트 사용량 · 경로 탐색 표본.
 * 규약: 값이 없으면 '—'(0·0% 를 지어내지 않는다) · 단위는 값이 있을 때만 · 백틱 금지(BoldText 는 **강조** 만 해석).
 */
import { numOrNull } from '../../numOrNull.js';
import { countText, pctText, bpsText, SYS_HIGH_PCT } from './cvpText.js';
import { fmtDate, fmtTime } from '../../util/fmt.js';

const dateText = (ms) => { const n = numOrNull(ms); return n == null ? '—' : fmtDate(n); };
const localStampText = (ms) => fmtTime(ms);

/** 업타임(부팅 시각 → 'N일 M시간'). 부팅 시각을 모르면 '—'. */
export function uptimeText(bootAt, now = Date.now()) {
  const b = numOrNull(bootAt);
  if (b == null || b > now) return '—';
  const h = Math.floor((now - b) / 3600_000);
  const d = Math.floor(h / 24);
  return d > 0 ? `${d}일 ${h % 24}시간` : `${h}시간`;
}

const COMPLIANCE = Object.freeze({ NONE: { tone: 'ok', label: '준수' }, WARNING: { tone: 'warn', label: '경고' }, CRITICAL: { tone: 'bad', label: '위반' }, ERROR: { tone: 'bad', label: '오류' } });
/** 레거시 인벤토리의 complianceIndication → 배지(모르는 값은 원문 그대로 · 없으면 '—'). */
export function complianceBadge(v) {
  const s = String(v || '').trim().toUpperCase();
  if (!s) return { tone: 'muted', label: '—' };
  return COMPLIANCE[s] || { tone: 'muted', label: s };
}

/** 사용률 셀(0~100 · 경계 이상이면 주의색). 못 읽으면 '—'. */
export function sysCell(v) {
  const n = numOrNull(v);
  if (n == null) return { text: '—', tone: 'muted', title: '읽지 못했습니다(0% 라는 뜻이 아닙니다).' };
  return { text: pctText(n), tone: n >= 90 ? 'bad' : n >= SYS_HIGH_PCT ? 'warn' : 'ok', title: '' };
}

/**
 * 장비 개요 표 행 → [[라벨, 값, 비고]]. device 는 목록/상세 응답의 publicDevice 모양.
 * 읽지 못한 묶음(레거시 인벤토리·수명주기·버그)은 그 사실을 비고로 말한다(info.readKinds 에 없으면 '읽지 못함').
 */
export function overviewRows(d, now = Date.now()) {
  const dev = d && typeof d === 'object' ? d : {};
  const info = dev.info && typeof dev.info === 'object' ? dev.info : {};
  const read = new Set(Array.isArray(info.readKinds) ? info.readKinds : []);
  const unreadNote = (k) => (read.has(k) ? '' : '읽지 못함(이 CVP 에서 그 API 가 없거나 실패 — 읽은 경로 탭 참조)');
  const lc = info.lifecycle || null; const bg = info.bugs || null;
  const rows = [
    ['호스트명', dev.hostname || '—', ''],
    ['모델', dev.model || '—', ''],
    ['시리얼', dev.serial || '—', ''],
    ['EOS', dev.eosVersion || '—', info.internalVersion ? `내부 버전 ${info.internalVersion}` : ''],
    ['MAC', info.mac || '—', info.mac ? '' : (dev.addressHidden ? '관리자에게만 보입니다' : '')],
    ['FQDN', info.fqdn || '—', ''],
    ['업타임', uptimeText(info.bootAt, now), info.bootAt ? `부팅 ${localStampText(info.bootAt)}` : '부팅 시각을 모릅니다(CVP 가 1970 을 주면 값 없음으로 봅니다)'],
    ['스트리밍', dev.streaming === true ? '스트리밍' : dev.streaming === false ? '끊김' : '—', ''],
    ['등록 상태', info.status || '—', unreadNote('enrich')],
    ['설정 컴플라이언스', complianceBadge(info.complianceIndication).label, info.complianceCode ? `코드 ${info.complianceCode}` : unreadNote('enrich')],
    ['컨테이너', info.container || '—', ''],
    ['MLAG', info.mlag === true ? '사용' : info.mlag === false ? '미사용' : '—', ''],
    ['소프트웨어 지원 종료', lc?.swEndOfSupport ? dateText(lc.swEndOfSupport) : '—', lc ? (lc.swEolVersion ? `버전 ${lc.swEolVersion}` : '') : unreadNote('lifecycle')],
    ['하드웨어 판매 종료', lc?.hwEndOfSale ? dateText(lc.hwEndOfSale) : '—', lc ? '' : unreadNote('lifecycle')],
    ['하드웨어 지원(TAC) 종료', lc?.hwEndOfTacSupport ? dateText(lc.hwEndOfTacSupport) : '—', ''],
    ['버그 노출', bg ? `버그 ${countText(bg.bugCount)} · CVE ${countText(bg.cveCount)}` : '—', bg ? `최고 노출 ${exposureText(bg.highestBug)} / CVE ${exposureText(bg.highestCve)}${bg.acknowledged ? ' · 확인 처리된 것만 있음' : ''}` : unreadNote('bugs')],
  ];
  return rows;
}
const EXPO = { none: '없음', low: '낮음', high: '높음' };
export function exposureText(v) { return EXPO[v] || '—'; }

// ── 이벤트 ───────────────────────────────────────────────────────────────────

export const EVENT_SEVERITIES = Object.freeze([
  ['critical', 'Critical', 'bad'], ['error', 'Error', 'bad'], ['warning', 'Warning', 'warn'], ['info', 'Info', 'muted'], ['debug', 'Debug', 'muted'], ['unknown', '미상', 'muted'],
]);
export const severityTone = (s) => (EVENT_SEVERITIES.find(([k]) => k === s) || [])[2] || 'muted';
export const severityLabel = (s) => (EVENT_SEVERITIES.find(([k]) => k === s) || [])[1] || String(s || '—');

/**
 * 이벤트를 읽었는지 CVP 별로 말한다(0건과 '못 읽음' 을 구분). readState[i].events: 객체(읽음) / null(못 읽음) / undefined(보고 없음).
 * @returns {string[]} 문장 목록(없으면 빈 배열)
 */
export function eventReadNotes(readState) {
  const list = Array.isArray(readState) ? readState : [];
  const out = [];
  const unread = list.filter((x) => x && x.events === null);
  const none = list.filter((x) => x && x.events === undefined);
  const capped = list.filter((x) => x && x.events && x.events.capped);
  if (unread.length) out.push(`**이벤트를 읽지 못한 CVP ${unread.length}대**(${unread.map((x) => x.name).slice(0, 5).join(', ')}${unread.length > 5 ? ' 외' : ''}) — 그 CVP 의 0건은 '이벤트 없음' 이 아닙니다.${unread[0].missing ? ` 사유: ${unread[0].missing}` : ''}`);
  if (none.length) out.push(`아직 이벤트 보고가 없는 CVP ${none.length}대 — 이 버전으로 올라간 뒤 첫 수집에서 채워집니다.`);
  if (capped.length) out.push(`이벤트 응답이 커서 앞부분만 읽은 CVP ${capped.length}대 — 개수는 '최소' 값입니다.`);
  return out;
}

/** 심각도별 개수 요약 → [{key,label,tone,count}] (없는 심각도는 0 이 아니라 표시하지 않는다 — 서버가 준 키만). */
export function severityCounts(counts) {
  const c = counts && typeof counts === 'object' ? counts : {};
  return EVENT_SEVERITIES.filter(([k]) => Object.hasOwn(c, k)).map(([k, label, tone]) => ({ key: k, label, tone, count: numOrNull(c[k]) }));
}

// ── 포트 사용량 ─────────────────────────────────────────────────────────────

/**
 * 포트 사용량 응답의 counts → KPI 목록. 사용률을 계산할 수 없는 포트는 사유별로(0% 로 세지 않는다).
 * 항등식: total = measured + notUp + noSpeed + noRate + stale(테스트가 고정).
 */
export function portUsageKpis(counts, { staleMs } = {}) {
  const c = counts && typeof counts === 'object' ? counts : {};
  const n = (k) => numOrNull(c[k]);
  return [
    { key: 'measured', label: '사용률 측정 포트', value: countText(n('measured')), meta: `전체 포트 ${countText(n('total'))}` },
    { key: 'over80', label: '80% 이상', value: countText(n('over80')), accent: n('over80') > 0 ? 'var(--red)' : null, meta: '수신·송신 중 높은 쪽 기준' },
    { key: 'over50', label: '50~80%', value: countText(n('over50')), accent: n('over50') > 0 ? 'var(--amber)' : null, meta: '' },
    { key: 'noRate', label: '처리량 없음', value: countText(n('noRate')), meta: '링크는 올라왔지만 카운터를 못 읽었거나 첫 표본입니다(0% 아님)' },
    { key: 'noSpeed', label: '속도 모름', value: countText(n('noSpeed')), meta: '처리량은 있지만 인터페이스 속도를 몰라 사용률을 계산하지 않았습니다' },
    { key: 'stale', label: '오래된 값', value: countText(n('stale')), meta: staleMs ? `마지막 처리량이 ${Math.round(staleMs / 60_000)}분보다 오래됐습니다 — 순위에서 뺐습니다` : '' },
    { key: 'notUp', label: '링크 없음', value: countText(n('notUp')), meta: '링크가 올라오지 않은 포트(판정 대상 아님)' },
  ];
}
export const PORT_USAGE_NOTE = '사용률은 **최근 수집 주기 두 번 사이의 처리량 ÷ 인터페이스 속도** 이고 방향별로 계산합니다(수신·송신 중 높은 쪽으로 정렬). 사용률을 계산할 수 없는 포트는 0% 로 세지 않고 위 칸에 사유별로 셉니다.';
export function utilTone(v) { const n = numOrNull(v); return n == null ? 'muted' : n >= 80 ? 'bad' : n >= 50 ? 'warn' : 'ok'; }
export function rateText(bps, util) { return `${bpsText(bps)}${numOrNull(util) != null ? ` (${pctText(util)})` : ''}`; }

// ── 경로 탐색 표본 ───────────────────────────────────────────────────────────

/** 경로 탐색 표본 → 표 행. 모양(빈 응답·포인터 수·update 수)을 한 줄로 말한다. */
export function probeRows(probes) {
  return (Array.isArray(probes) ? probes : []).filter((p) => p && typeof p === 'object').map((p) => {
    const status = numOrNull(p.status);
    let shape = '—';
    if (!p.ok) shape = status ? `실패 HTTP ${status}` : '실패';
    else if (p.empty === true) shape = '빈 응답(값 없음)';
    else if (numOrNull(p.ptrs) > 0) shape = `포인터 ${countText(p.ptrs)}개${Array.isArray(p.ptrKeys) && p.ptrKeys.length ? ` (${p.ptrKeys.slice(0, 6).join(', ')}${p.ptrKeys.length > 6 ? ' …' : ''})` : ''}`;
    else if (numOrNull(p.updates) > 0) shape = `값 ${countText(p.updates)}개`;
    return { path: String(p.path || ''), device: String(p.device || ''), ok: p.ok === true, shape, bytes: numOrNull(p.bytes), head: typeof p.head === 'string' ? p.head : '' };
  });
}
export const PROBE_NOTE = '경로 탐색 표본은 **부품 조회 주기마다 장비 1대로** 텔레메트리 경로 몇 곳을 조회해 무엇이 오는지 남긴 것입니다. 빈 응답은 그 경로에 값이 없다는 뜻이고, 포인터는 하위 항목 목록입니다 — 조회 경로 후보를 고치는 근거입니다(관리자에게만 보입니다).';

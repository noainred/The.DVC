/**
 * corpUsageText.js — '법인별 서버 사용량' 화면의 판정·문구(순수, v2.625).
 *
 * 서버(`/tools/corp-usage`)가 합계·가중 사용률을 계산해 준다. 여기는 **보여 주는 방법**만 갖는다:
 *  · 값이 없으면 '—'(0 을 그리지 않는다) · 값이 없으면 단위를 붙이지 않는다(v2.575 unitText 규약).
 *  · 합계에서 뺀 서버(못 읽음·오래됨·용량 모름)는 개수로 **밝힌다** — 조용히 빼면 부분 합을 '전체' 라 말하게 된다.
 *  · 출처(iDRAC·OS·vCenter)를 숨기지 않는다 — 같은 서버라도 출처에 따라 값이 다를 수 있다.
 *  · 임계(75/90)는 베어메탈 사용률과 같은 `usageTone` 을 쓴다(색 기준을 두 벌 두지 않는다).
 */
import { usageTone, toneVar } from './bmUsageText.js';
import { numOrNull } from '../../numOrNull.js';
import { toCsv } from '../../util/csv.js';

export { usageTone, toneVar };

export const GROUP_LABEL = Object.freeze({ all: '전체', davinci: '다빈치', irs: 'IRS' });
export const ROLE_LABEL = Object.freeze({ all: '서버 전체', bm: '물리 서버', virt: '가상화 서버' });

const r1 = (v) => Math.round(v * 10) / 10;
const grp = (n) => n.toLocaleString('en-US', { maximumFractionDigits: 1 });

/** 가중 사용률 — null 이면 '—'. */
export function pctText(v) {
  const x = numOrNull(v);
  return x == null ? '—' : `${r1(x)}%`;
}

/** CPU 절대량 — '사용 12.3 / 48 코어'. 분모가 0 이면 '—'(0 코어를 지어내지 않는다). */
export function coresText(m) {
  const total = numOrNull(m?.total);
  if (!total) return '—';
  return `${grp(numOrNull(m.used) ?? 0)} / ${grp(total)} 코어`;
}

/** 메모리 절대량 — GB(이진, vCenter 카드와 같은 단위). 10,240GB 이상이면 TB 로. */
export function memText(m) {
  const total = numOrNull(m?.total);
  if (!total) return '—';
  const used = numOrNull(m.used) ?? 0;
  const tb = (v) => (v / 1024).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  if (total >= 10_240) return `${tb(used)} / ${tb(total)} TB`;
  return `${grp(Math.round(used))} / ${grp(Math.round(total))} GB`;
}

/** 합계에 반영된 서버 수(지표 중 하나라도 들어간 서버) — servers − 제외. */
export function countedOf(a) {
  if (!a) return 0;
  return Math.max(0, (a.servers || 0) - (a.unread || 0) - (a.stale || 0) - (a.noCap || 0));
}

/**
 * 합계에서 뺀 서버를 한 줄로 — '반영 8/10대 · 못 읽음 1 · 오래됨 1'. 0 인 사유는 적지 않는다.
 * 서버가 없으면 '서버 없음'(0/0 은 뜻이 없다).
 */
export function coverageText(a) {
  if (!a || !a.servers) return '서버 없음';
  const parts = [`반영 ${countedOf(a)}/${a.servers}대`];
  if (a.unread) parts.push(`못 읽음 ${a.unread}`);
  if (a.stale) parts.push(`오래됨 ${a.stale}`);
  if (a.noCap) parts.push(`용량 모름 ${a.noCap}`);
  // v2.628(C2628-06): 판정은 됐지만 그 지표만 값이 없어 그 지표 합계에서 빠진 서버 — 분모가 서버 수보다 작은 이유.
  if (a.cpuMissing) parts.push(`CPU 값 없음 ${a.cpuMissing}`);
  if (a.memMissing) parts.push(`메모리 값 없음 ${a.memMissing}`);
  // v2.628(C2628-03): 다른 법인 서버와 식별 키가 겹쳐 사용률 행을 붙이지 않은 서버.
  if (a.keyConflict) parts.push(`키 겹침 ${a.keyConflict}`);
  return parts.join(' · ');
}

/** 출처 — 'iDRAC 5 · OS 2 · vCenter 3'. 0 인 출처는 빼고, 아무것도 없으면 ''. */
export function srcText(a) {
  const s = a?.src || {};
  const parts = [];
  if (s.idrac) parts.push(`iDRAC ${s.idrac}`);
  if (s.os) parts.push(`OS ${s.os}`);
  if (s.mixed) parts.push(`iDRAC+OS ${s.mixed}`);   // v2.628(R2628-04): 지표마다 출처가 다른 서버(DB 가 지표별 출처를 두지 않는다)
  if (s.vcenter) parts.push(`vCenter ${s.vcenter}`);
  return parts.join(' · ');
}

/** 합계에서 빠진 서버가 하나라도 있는가 — 이 행의 사용률이 '부분' 인지. */
export function isPartial(a) {
  return !!a && ((a.unread || 0) + (a.stale || 0) + (a.noCap || 0) + (a.cpuMissing || 0) + (a.memMissing || 0)) > 0;
}

/** 구분 필터 — 'all' 이면 그대로. 서버가 이름 순으로 준 순서를 유지한다. */
export function filterCorps(corps = [], group = 'all', scope = '') {
  return (corps || []).filter((c) => (group === 'all' || c.group === group) && (!scope || c.vcenterId === scope));
}

/** 세그먼트 라벨의 법인 수. */
export function groupCounts(corps = []) {
  const out = { all: 0, davinci: 0, irs: 0 };
  for (const c of corps || []) { out.all += 1; if (out[c.group] != null) out[c.group] += 1; }
  return out;
}

/**
 * 화면 위 안내 — **있는 사정만** 순서대로. 판정 순서가 계약이다(가장 먼저 조치할 것부터):
 *  ① 입력 실패(분류·DB) ② 수집 꺼짐 ③ ESXi iDRAC 수집 꺼짐(vCenter 대체) ④ 켠 법인 없음 ⑤ 엣지 보관분.
 */
export function noticesOf(d) {
  if (!d) return [];
  const out = [];
  for (const e of d.sourceErrors || []) out.push({ tone: 'bad', text: `**입력을 읽지 못했습니다** — ${e}. 이 입력에 기대는 값은 합계에서 빠져 있습니다.` });
  const s = d.settings || {};
  // v2.628(R2628-07): 아래 설정 안내는 **이 포탈(중앙)** 의 설정이다 — 엣지가 수집하는 법인은 그 엣지 설정(또는 중앙 배포)을 따른다.
  if (!s.enabled) {
    out.push({ tone: 'warn', text: '**이 포탈의 베어메탈 사용률 수집이 꺼져 있습니다** — 이 포탈이 직접 수집하는 물리 서버는 값이 없어 합계에서 빠지고(못 읽음으로 셉니다), 가상화 서버는 **vCenter 값**으로 채웁니다. 특수 기능 › 베어메탈 사용률 › 설정에서 켜세요. 엣지가 수집하는 법인은 그 엣지의 설정을 따릅니다.' });
  } else if (!s.idracTelemetry) {
    out.push({ tone: 'warn', text: '**iDRAC 텔레메트리가 꺼져 있습니다** — 물리 서버는 OS 계정이 있는 것만 읽고, ESXi 호스트는 iDRAC 로 읽지 않습니다.' });
  }
  if (s.enabled && !s.includeVirtualization) {
    out.push({ tone: 'info', text: '**가상화 서버는 vCenter 값입니다** — ‘ESXi 호스트도 iDRAC 로 수집’ 이 꺼져 있습니다. 켜면 선택한 법인의 ESXi 호스트를 iDRAC 로 읽고, 못 읽은 호스트만 vCenter 값으로 채웁니다.' });
  }
  const corps = d.corps || [];
  if (s.enabled && corps.length && !corps.some((c) => c.collectOn)) {
    out.push({ tone: 'warn', text: '**수집을 켠 법인이 없습니다** — 이 포탈의 설정에도, 가져온 엣지 보관분의 설정에도 켠 법인이 없습니다. 베어메탈 사용률 › 설정에서 법인을 고르세요. 고르기 전에는 물리 서버 값이 없습니다.' });
  }
  // v2.628(C2628-04): 읽히지 않는 vCenter(점검중·수집 실패·위임 낡음)의 가상화 호스트는 vCenter 값으로 채우지 않는다.
  const uv = numOrNull(d.unreadVcenters);
  if (uv) out.push({ tone: 'warn', text: `**지금 읽히지 않는 vCenter ${uv}곳**(점검중·수집 실패·위임 보고 낡음)의 가상화 호스트는 마지막 vCenter 값을 지금 값으로 쓰지 않았습니다 — 오래됨 또는 못 읽음으로 셉니다.` });
  // v2.628(EDGE2628-01): 엣지 보관분이 대상 수 상한으로 잘렸으면 잘린 서버는 못 읽음이 된다.
  const tr = numOrNull(d.edgeTruncated);
  if (tr) out.push({ tone: 'warn', text: `**엣지 보관분이 대상 수 상한으로 ${tr}대 잘렸습니다** — 그 서버는 이 화면에서 못 읽음으로 셉니다. 베어메탈 사용률 › 엣지 보관분에서 다시 가져오세요.` });
  // v2.626: 물리 서버가 법인에 붙지 않으면 수집 대상도 합계도 되지 못한다 — 이유를 먼저 말한다.
  const ub = d.unassigned?.bm;
  if (ub && ub.servers) {
    out.push({ tone: 'warn', text: `**법인을 정하지 못한 물리 서버 ${ub.servers}대**는 수집 대상도, 법인 합계도 아닙니다 — iDRAC 등록의 법인(vCenter)·호스트명·서비스태그·수동 지정·법인(DataCenter)에 vCenter 가 하나뿐인 경우로 정합니다. 법인(DataCenter)에 vCenter 가 둘 이상이면 추측하지 않습니다 — 특수 기능 › 통합 서버 인벤토리에서 법인을 지정하세요.` });
  }
  const filled = numOrNull(d.attributed?.filled);
  if (filled) out.push({ tone: 'info', text: `물리 서버 ${filled}대는 등록부에 법인이 비어 있어 **개요와 같은 귀속 규칙**(호스트명·서비스태그·지정·DataCenter)으로 법인을 정했습니다.` });
  const n = numOrNull(d.edgeSnaps?.count) ?? 0;
  out.push({ tone: 'info', text: n
    ? `엣지가 수집하는 법인의 값은 **중앙이 가져온 엣지 보관분**(${n}곳)에서 읽습니다 — 보관분이 오래되면 그 서버는 '오래됨' 으로 빠집니다. 베어메탈 사용률 › 엣지 보관분에서 다시 가져올 수 있습니다. 엣지 담당 서버는 **그 엣지 포탈의** 베어메탈 사용률 설정에서 수집을 켜야 값이 생깁니다.`
    : '엣지가 수집하는 법인의 값은 **중앙이 가져온 엣지 보관분**에서만 읽습니다 — 아직 가져온 보관분이 없어 그 서버들은 못 읽음으로 셉니다(가상화 서버는 vCenter 값으로 채웁니다). 엣지 담당 서버는 **그 엣지 포탈의** 베어메탈 사용률 설정에서 수집을 켠 뒤, 베어메탈 사용률 › 엣지 보관분에서 가져오세요.' });
  return out;
}

/** 표 아래 각주 — 계산식과 출처 규칙. 한 번만(행마다 반복하지 않는다 — v2.509). */
export function footnotes(d) {
  const out = [
    '사용률은 **가중 평균**입니다 — 서버마다 ‘사용률 × 용량’(CPU 코어·설치 메모리)으로 사용량을 만들어 더한 뒤 용량 합으로 나눕니다. 큰 서버가 크게 반영됩니다. CPU 사용량은 코어 환산값입니다.',
    '**반영** 은 합계에 들어간 서버 수입니다. 값을 못 읽은 서버·오래된 값(수집 주기의 3배 초과)·용량을 모르는 서버는 합계에서 빼고 개수로 밝힙니다 — 0 으로 세지 않습니다.',
    '**출처** — iDRAC(텔레메트리·대체 경로) · OS(SSH) · vCenter(가상화 호스트 대체값). 같은 서버라도 출처에 따라 값이 다를 수 있습니다.',
    '법인 구분은 법인(vCenter) 이름에 IRS 가 있는지로 정합니다.',
  ];
  const u = d?.unassigned?.bm;
  if (u && u.servers) out.push(`**법인 귀속 없는 물리 서버 ${u.servers}대**는 어느 법인 합계에도 넣지 않았습니다(반영 ${countedOf(u)}대 · CPU ${pctText(u.cpu?.pct)} · 메모리 ${pctText(u.mem?.pct)}). 특수 기능 › 통합 서버 인벤토리에서 법인을 지정하세요.`);
  return out;
}

/** CSV — 법인 합계만(서버 목록은 싣지 않는다). 수식 가드는 공용 toCsv(v2.596). */
export function csvOf(corps = []) {
  const head = ['법인', '구분', '서버', '전체 CPU %', '전체 메모리 %', '물리 CPU %', '물리 메모리 %', '가상화 CPU %', '가상화 메모리 %',
    '전체 CPU 사용 코어', '전체 CPU 코어', '전체 메모리 사용 GB', '전체 메모리 GB', '못 읽음', '오래됨', '용량 모름'];
  const cell = (v) => (v == null ? '' : String(v));
  const rows = (corps || []).map((c) => [c.name, GROUP_LABEL[c.group] || c.group, c.all?.servers,
    c.all?.cpu?.pct, c.all?.mem?.pct, c.bm?.cpu?.pct, c.bm?.mem?.pct, c.virt?.cpu?.pct, c.virt?.mem?.pct,
    c.all?.cpu?.used, c.all?.cpu?.total, c.all?.mem?.used, c.all?.mem?.total, c.all?.unread, c.all?.stale, c.all?.noCap].map(cell));
  return toCsv([head, ...rows]);
}

// ipamDnsText.js — v3.2.0 DNS 정합성(역DNS 이름의 정방향 확인) 문구(순수 · 시안 docs/design/ipam-alerts-mac-dns ⑦).
// 판정(일치 · 다른 IP · 정방향 없음 · 확인 못 함)은 스캔을 돌린 쪽이 하고 중앙이 정제해 행 · 상세에 실어 보낸다(server ipam/dnsConfirm.js) —
// 여기는 라벨 · 배지 · 요약만 만든다. 일치는 배지를 달지 않는다(대부분이 일치라 표가 시끄러워진다 — 수는 요약 줄이 센다).
// 확인 못 함은 일치에도 불일치에도 넣지 않는다.
import { numOrNull } from '../../numOrNull.js';

/** 판정 라벨 · 색(서버 DNS_FWD_STATES 와 1:1). */
export const DNS_FWD = Object.freeze({
  match: { label: '일치', tone: 'green' },
  other: { label: 'DNS 다른 IP', tone: 'amber' },
  none: { label: '정방향 없음', tone: 'amber' },
  unknown: { label: '확인 못 함', tone: 'gray' },
});
export const DNS_FWD_ORDER = Object.freeze(['match', 'other', 'none', 'unknown']);

/** 어긋났는가(다른 IP · 정방향 없음) — 칩 'DNS 불일치' 판정. */
export function hasDnsMismatch(r) {
  return r?.dnsFwd === 'other' || r?.dnsFwd === 'none';
}

/**
 * 목록 호스트명 칸의 배지 — 어긋난 것만. title 은 역DNS 이름 · 정방향 주소 · 확인 시각(fmt 는 시각 꼴 함수 — 없으면 시각을 쓰지 않는다).
 * @returns {{label:string, tone:string, title:string}|null}
 */
export function dnsBadge(r, fmt = null) {
  if (!hasDnsMismatch(r)) return null;
  const ptr = r.dnsPtr || '';
  const at = numOrNull(r.dnsFwdAt);
  const when = at && typeof fmt === 'function' ? ` · ${fmt(at)} 확인` : '';
  if (r.dnsFwd === 'other') {
    const addrs = Array.isArray(r.dnsFwdAddrs) ? r.dnsFwdAddrs : [];
    return { ...DNS_FWD.other, title: `역DNS 이름 ${ptr} 을 정방향으로 물으면 ${addrs.join(', ') || '다른 IP'} — 이 IP 가 아닙니다. 역방향 레코드가 옛 장비 이름으로 남았거나 정방향이 옮겨 갔습니다${when}` };
  }
  return { ...DNS_FWD.none, title: `역DNS 이름 ${ptr} 을 정방향으로 물으면 그런 이름이 없습니다 — 이름을 지웠는데 역방향 레코드만 남은 경우입니다${when}` };
}

/** 대장 목록 위 요약 — 정방향 확인 결과가 실린 행(전 범위 계정 · 역DNS 이름이 있는 스캔 IP)만 센다. */
export function dnsSummary(rows) {
  const s = { total: 0, match: 0, other: 0, none: 0, unknown: 0 };
  for (const r of rows || []) {
    if (!r || !Object.prototype.hasOwnProperty.call(DNS_FWD, r.dnsFwd)) continue;
    s.total += 1; s[r.dnsFwd] += 1;
  }
  return s;
}
/** 요약 배지 조각 — 0 인 것은 뺀다(불일치 · 확인 못 함). 일치 수는 '정방향 확인 n / N' 으로 따로. */
export function dnsSummaryParts(sum) {
  if (!sum || !sum.total) return [];
  const out = [];
  const bad = (sum.other || 0) + (sum.none || 0);
  if (bad) out.push({ key: 'bad', label: `불일치 ${bad.toLocaleString()}`, tone: 'amber' });
  if (sum.unknown) out.push({ key: 'unknown', label: `확인 못 함 ${sum.unknown.toLocaleString()}`, tone: 'gray' });
  return out;
}

/**
 * IP 상세 창 — 역DNS 줄 아래 정방향 결과 한 줄. d = 서버 scanDetailOf(ip).dnsFwd({v, at?, addrs?}). 없으면 null(확인하지 않음 — 옛 엣지 · 끔 · 역DNS 이름 없음).
 * @returns {{ text:string, tone:string, at:number|null }|null}
 */
export function dnsDetailLine(d) {
  if (!d || !Object.prototype.hasOwnProperty.call(DNS_FWD, d.v)) return null;
  const at = numOrNull(d.at);
  if (d.v === 'match') return { text: '이 IP 를 가리킵니다(일치)', tone: 'green', at };
  if (d.v === 'other') return { text: `${(d.addrs || []).join(', ') || '다른 IP'} — 이 IP 아님`, tone: 'amber', at };
  if (d.v === 'none') return { text: '그런 이름 없음(정방향 레코드 없음)', tone: 'amber', at };
  return { text: '확인 못 함 — 시한 · 예산에 걸렸거나 DNS 가 답하지 않았습니다(다음 스캔이 이어 묻습니다)', tone: 'gray', at: null };
}

/** 스캔 한 번의 정방향 확인 요약 문구(상태 카드 · 실행 이력) — 요약이 없으면 ''. */
export function dnsStatsText(ns) {
  const d = ns && typeof ns === 'object' ? ns.dnsFwd : null;
  if (!d || typeof d !== 'object') return '';
  const total = ['match', 'other', 'none', 'unknown'].reduce((a, k) => a + (numOrNull(d[k]) ?? 0), 0);
  if (!total) return '';
  const bad = (numOrNull(d.other) ?? 0) + (numOrNull(d.none) ?? 0);
  const unk = numOrNull(d.unknown) ?? 0;
  return `정방향 확인 ${(numOrNull(d.match) ?? 0).toLocaleString()}/${total.toLocaleString()}${bad ? ` · 불일치 ${bad.toLocaleString()}` : ''}${unk ? ` · 확인 못 함 ${unk.toLocaleString()}` : ''}${d.stopped === 'unreachable' ? ' · DNS 응답 없음' : d.stopped === 'budget' ? ' · 예산 소진' : ''}`;
}

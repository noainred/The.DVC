/**
 * v2.744(감사 LEFT-08 ②): 서버별 **FC HBA 사용률의 분모 근거** — 화면 각주가 한 번 말하는 숫자의 원천.
 *
 * 왜 따로 두는가: 화면의 서버 행은 DB `usage_latest`(열 고정)에서 오고, 포트별 판정(`pctBasis`·`pctOver`·`pctClamped`)은
 *   `buildUsage()` 의 상세(detail.fc·detail.idracFc)에만 있다 — 그 상세는 DB 에 넣지 않는다(장치 수 × 주기면 행이 폭주한다,
 *   v2.550.3). 그래서 화면은 'HBA 사용률 90%' 가 어떤 분모로 나온 값인지(FC 표준 데이터율 / 명목 Gbit), 100% 가 실제로는
 *   조금 넘은 값을 100 으로 표시한 것인지(RECENT-02) 알 수 없었다. 수집할 때마다 포트 수만 세어 여기에 둔다(개수만 — 주소·식별자 없음).
 *
 * ⚠ **인메모리다** — 재시작하면 비고, 다음 수집부터 다시 찬다(재생성 가능한 진단 정보라 파일을 두지 않는다). 그 사이 화면은
 *   근거를 말하지 않을 뿐 틀린 말을 하지 않는다(`hbaBasis` 가 없으면 각주를 내지 않는다).
 * ⚠ targets.js(응답 조립)와 poller.js(기록)가 함께 쓴다 — import 는 parse/fcRate.js 상수 하나뿐이다(순환 없음).
 */
import { FC_OVER_CLAMP_PCT } from './parse/fcRate.js';

const _basis = new Map();

/**
 * FC 행 목록 → 개수 요약(순수). 판정 필드(`pctBasis`)가 없는 행(Windows WMI 원본 등)은 세지 않는다 — 지어내지 않는다.
 * @param {object[]} rows  usage.js 의 FC 행(fcRowPctFields 가 붙인 pct·pctBasis·pctOver·pctClamped)
 * @returns {{ports:number, dataRate:number, nominal:number, noSpeed:number, clamped:number, blanked:number, unread:number}}
 */
export function summarizeHbaBasis(rows = []) {
  const out = { ports: 0, dataRate: 0, nominal: 0, noSpeed: 0, clamped: 0, blanked: 0, unread: 0 };
  for (const x of Array.isArray(rows) ? rows : []) {
    if (!x || typeof x !== 'object' || !Object.hasOwn(x, 'pctBasis')) continue;
    out.ports += 1;
    if (x.pctBasis === 'fc-data-rate') out.dataRate += 1;
    else if (x.pctBasis === 'nominal') out.nominal += 1;
    else out.noSpeed += 1;
    if (x.pctOver && x.pctClamped && x.pct != null) out.clamped += 1;
    if (x.pctOver && x.pct == null) out.blanked += 1;
    if (x.countersInvalid) out.unread += 1;
  }
  return out;
}

/**
 * 수집 결과 하나를 기록한다. FC 행이 없고 그 주기가 성공했으면 기록을 지운다(HBA 가 없는 서버) — 실패한 주기는 직전 기록을 둔다
 * (못 읽은 주기가 근거를 지우면 화면이 방금까지 보이던 각주를 잃는다 — v2.550.3 H5 와 같은 판단).
 */
export function recordHbaBasis(key, built, { at = null, ok = false } = {}) {
  if (!key) return;
  const d = built?.detail || {};
  const os = summarizeHbaBasis(d.fc);
  const idrac = summarizeHbaBasis(d.idracFc);
  if (!os.ports && !idrac.ports) { if (ok) _basis.delete(key); return; }
  // 서버 대표값(hba_pct)을 낸 쪽의 포트를 센다 — OS 가 있으면 OS, 없으면 iDRAC(usage.js 의 '빈 칸만 채운다' 규칙과 같은 순서).
  const src = os.ports ? 'os' : 'idrac';
  const s = os.ports ? os : idrac;
  _basis.set(key, { ...s, src, at: at ?? null, clampMaxPct: FC_OVER_CLAMP_PCT, ...(built?.row?.hba_over ? { overBlank: true } : {}) });
}

/** 응답용 사본(없으면 null). */
export function hbaBasisFor(key) {
  const v = key ? _basis.get(key) : null;
  return v ? { ...v } : null;
}

/** 대상에서 사라진 서버의 기록을 버린다(누수 방지 — poller.dropStaleState 가 부른다). */
export function pruneHbaBasis(live) {
  for (const k of _basis.keys()) if (!live.has(k)) _basis.delete(k);
}

export function _resetHbaBasisForTest() { _basis.clear(); }

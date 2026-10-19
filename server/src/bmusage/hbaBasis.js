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
 * v2.744(회귀 검토 GB-R1): `blanked`(데이터율을 크게 넘어 비움 — 서버 대표값도 비우고 알림은 초과)는 **데이터율 기준 포트만** 센다.
 *   명목 기준 포트의 100% 초과는 `nominalOver` 로 따로 센다(대표값·알림 규칙이 다르다 — parse/fcRate.js fcRepresentative).
 * @returns {{ports:number, dataRate:number, nominal:number, noSpeed:number, clamped:number, blanked:number, nominalOver:number, unread:number}}
 */
export function summarizeHbaBasis(rows = []) {
  const out = { ports: 0, dataRate: 0, nominal: 0, noSpeed: 0, clamped: 0, blanked: 0, nominalOver: 0, unread: 0 };
  for (const x of Array.isArray(rows) ? rows : []) {
    if (!x || typeof x !== 'object' || !Object.hasOwn(x, 'pctBasis')) continue;
    out.ports += 1;
    if (x.pctBasis === 'fc-data-rate') out.dataRate += 1;
    else if (x.pctBasis === 'nominal') out.nominal += 1;
    else out.noSpeed += 1;
    if (x.pctOver && x.pctClamped && x.pct != null) out.clamped += 1;
    if (x.pctOver && x.pct == null) {
      if (x.pctBasis === 'nominal') out.nominalOver += 1;
      else out.blanked += 1;
    }
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
  const row = built?.row || {};
  const os = summarizeHbaBasis(d.fc);
  const idrac = summarizeHbaBasis(d.idracFc);
  if (!os.ports && !idrac.ports) { if (ok) _basis.delete(key); return; }
  /*
   * 서버 대표값을 **실제로 정한** 경로의 포트를 센다(v2.744 최종 검토 RV-1). 예전에는 OS 포트가 있으면 무조건 OS 를 셌는데, OS 포트가
   *   전부 사용률 없음(명목 초과·속도 미상)이면 같은 주기에 iDRAC FC 행이 값을 넣거나 hba_over 를 세운다(usage.js '빈 칸만 채운다') —
   *   그때 OS 포트를 세면 각주가 화면 값과 다른 분모를 말하고, '나머지 포트 기준 · 알림은 초과로 보지 않는다' 는 거짓이 된다.
   *   출처는 usage.js 의 `detail.hbaRepSrc`(값 또는 hba_over 를 세운 경로) — 없는 옛 모양이면 srcOf.hba, 그것도 없으면 예전 순서(OS → iDRAC).
   *   ⚠ 대표값을 정한 경로에 분모 근거가 없으면(Windows WMI 값 — pctBasis 없음) 다른 경로의 포트를 근거라 말하지 않는다 — 기록하지 않는다.
   */
  const repSrc = Object.hasOwn(d, 'hbaRepSrc') ? d.hbaRepSrc : (built?.srcOf?.hba ?? null);
  let src;
  if (repSrc === 'idrac') src = idrac.ports ? 'idrac' : null;
  else if (repSrc === 'os') src = os.ports ? 'os' : null;
  else src = os.ports ? 'os' : 'idrac';
  if (!src) { if (ok) _basis.delete(key); return; }
  const s = src === 'os' ? os : idrac;
  // 최종 대표값의 모양 — 각주가 명목 초과 포트의 '대표값은 어떻게 정해졌나' 를 서버마다 이것으로 말한다(값 · 크게 초과로 비움 · 판정 보류).
  const rep = row.hba_pct != null ? 'value' : row.hba_over ? 'over' : 'none';
  // OS 포트가 있었는데 iDRAC 이 정했으면 OS 쪽 사실(명목 초과 — 속도 보고 확인)을 버리지 않고 따로 남긴다(개수만).
  const osFallback = src === 'idrac' && os.ports ? { osFallback: { ports: os.ports, nominalOver: os.nominalOver, noSpeed: os.noSpeed, unread: os.unread } } : {};
  _basis.set(key, { ...s, src, rep, at: at ?? null, clampMaxPct: FC_OVER_CLAMP_PCT, ...(row.hba_over ? { overBlank: true } : {}), ...osFallback });
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

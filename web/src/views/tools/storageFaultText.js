/**
 * views/tools/storageFaultText.js — 스토리지 '장애 장비' 판정·문구(v2.567, 순수 모듈).
 *
 * 사용자 요청: "스토리지에 장애 있으면 장애 장비 숫자를 카드로 하나 보여주고, 미해결정보를
 * 빼고, 장애 장비 수량을 보여주고 클릭하면 장애 장비만 리스트로 보여줘".
 *
 * ── 왜 '미해결 경보' 를 뺐나 ────────────────────────────────────────────────────
 * 그 카드는 `snap.alerts.unresolved` 의 **전 장비 합**이었다. 이 현장 실측이 **5,404** 인데
 * 그 안에는 정보성 이벤트가 섞여 있어 **숫자가 커도 조치할 것이 없을 수 있다** — 즉 '장애가
 * 얼마나 있나' 를 묻는 사람에게 쓸모가 없는 수치였다. 대신 **장비 몇 대가 이상인가**를 센다.
 *
 * ── 판정 규칙(정직성이 전부다) ─────────────────────────────────────────────────
 * ⚠⚠ **`unknown` 을 장애로도 정상으로도 세지 않는다**(v2.523·v2.519·v2.526 규약). 상태를
 *   읽지 못한 것을 이상이라 말하면 정상 장비에 장애가 찍히고, 정상이라 말하면 **초록 거짓**이
 *   된다. 그래서 세 칸으로 나누고 **항등식 `합계 = 장애 + 정상 + 확인 불가`** 를 지킨다.
 * ⚠ **수집 실패는 '장애' 가 아니다** — 그것은 별도 KPI('수집 실패/대기')가 이미 센다. 수집이
 *   실패한 장비의 하드웨어 상태는 **모르는 것**이므로 `확인 불가` 로 간다(장애로 세면 회선
 *   장애가 장비 장애로 둔갑한다).
 * ⚠ **판정 근거가 하나도 없으면 `확인 불가`** 다. 어떤 타입은 노드 목록도 헬스 필드도 주지
 *   않는다(`types.js` 계약에서 `nodes.count` 는 0 허용) — 그런 장비를 '정상' 으로 세면
 *   화면이 '장애 0' 이라는 거짓을 말한다. 그래서 카드가 **확인 불가 수를 함께** 적는다.
 */
import { healthBadge } from './storageNodeText.js';

const n0 = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * 한 장비의 장애 판정.
 *
 * @param {object} row 목록 행 `{ snap, name, ... }`
 * @returns {{kind:'fault'|'ok'|'unknown', reasons:string[], signals:number}}
 *   `signals` = 읽어낸 판정 근거 개수(0 이면 판정 불가). `reasons` 는 화면이 그대로 쓴다.
 */
export function deviceFault(row) {
  const s = row?.snap || null;
  // 스냅샷이 없거나 수집이 실패했으면 **하드웨어 상태를 모른다**(장애가 아니다).
  if (!s || s.ok === false) return { kind: 'unknown', reasons: [], signals: 0 };

  const reasons = [];
  let signals = 0;

  // ① 노드/컨트롤러 이상 — 전 타입 공통 계약(`types.js` nodes.unhealthy). 화면의 ⚠N 배지와 같은 값.
  const count = n0(s.nodes?.count);
  if (count > 0) {
    signals += 1;
    const bad = n0(s.nodes?.unhealthy);
    if (bad > 0) reasons.push(`노드 ${count}대 중 ${bad}대 비정상`);
  }

  // ② 장비가 보고한 헬스 문자열 — 색 판정은 `healthBadge` 하나가 소유한다(숫자·문구 복제 금지).
  //    ⚠ `unknown`·빈 값은 회색이라 여기서 **근거로 세지 않는다**(v2.526 규약).
  const raw = s.extra?.healthState ?? s.extra?.clusterHealth ?? null;
  if (raw != null && String(raw).trim() !== '') {
    const b = healthBadge(raw);
    if (b.tone === 'green' || b.tone === 'red') {
      signals += 1;
      if (b.tone === 'red') reasons.push(`헬스 ${b.text}`);
    }
  }

  // ③ 하드웨어 인벤토리의 이상 개수(Unity 계열이 싣는다).
  const hw = s.extra?.inventory?.hardware;
  if (hw && Number.isFinite(Number(hw.unhealthy))) {
    signals += 1;
    const bad = n0(hw.unhealthy);
    if (bad > 0) reasons.push(`부품 이상 ${bad}건`);
  }

  if (!signals) return { kind: 'unknown', reasons: [], signals: 0 };
  return { kind: reasons.length ? 'fault' : 'ok', reasons, signals };
}

/** 장애로 판정된 장비만 — 카드 클릭 시 목록에 쓰는 필터. */
export const faultRows = (rows = []) => rows.filter((r) => deviceFault(r).kind === 'fault');

/**
 * KPI 값. ⚠ **항등식 `total = fault + ok + unknown`** 을 테스트가 고정한다 —
 * 겹치거나 빠지면 카드 숫자가 서로를 부정한다(v2.553 KPI 규약).
 */
export function faultKpi(rows = []) {
  let fault = 0; let ok = 0; let unknown = 0;
  for (const r of rows) {
    const k = deviceFault(r).kind;
    if (k === 'fault') fault += 1;
    else if (k === 'ok') ok += 1;
    else unknown += 1;
  }
  return { total: rows.length, fault, ok, unknown };
}

/**
 * 카드 숫자 아래 한 줄.
 * ⚠ **장애 0 을 그냥 초록으로 두지 말 것** — 확인 불가가 있으면 그 사실을 적는다(초록 거짓 방지).
 */
export function faultKpiMeta(k) {
  if (!k || !k.total) return '등록된 장비 없음';
  if (k.unknown) return `확인 불가 ${k.unknown}대 (정상이라는 뜻 아님)`;
  return k.fault ? '클릭하면 장애 장비만' : `${k.ok}대 모두 정상`;
}

/** 카드 색조 — 확인 불가만 있을 때는 초록으로 칠하지 않는다. */
export function faultKpiTone(k) {
  if (k?.fault) return 'red';
  if (!k?.total) return 'muted';
  if (k?.unknown) return 'muted';   // 장애 0 이지만 못 본 장비가 있다 → 초록 금지
  return 'green';
}

/** 카드 접근성 문구. */
export function faultKpiTitle(k) {
  if (!k || !k.total) return '등록된 스토리지 장비가 없습니다.';
  const bits = [`장비 ${k.total}대 — 장애 ${k.fault} · 정상 ${k.ok} · 확인 불가 ${k.unknown}`];
  if (k.unknown) bits.push('확인 불가는 노드 목록·헬스 필드를 주지 않거나 수집이 실패한 장비입니다(정상이라는 뜻이 아닙니다).');
  bits.push('수집 실패는 옆의 ‘수집 실패/대기’ 가 셉니다.');
  return bits.join(' ');
}

/** 필터가 걸렸을 때 목록 위에 적는 줄. 0건이어도 **왜** 0건인지 말한다. */
export function faultFilterNote(k, shownCount) {
  if (!k) return '';
  if (k.fault === 0) {
    return k.unknown
      ? `장애로 판정된 장비가 없습니다 — 다만 확인 불가 ${k.unknown}대가 있어 ‘장애 없음’ 이라고 단정할 수 없습니다.`
      : '장애로 판정된 장비가 없습니다.';
  }
  return `장애 장비 ${shownCount}대만 보고 있습니다 (전체 ${k.total}대 중 장애 ${k.fault}대).`;
}

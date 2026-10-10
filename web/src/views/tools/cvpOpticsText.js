/**
 * views/tools/cvpOpticsText.js — GBIC 광신호(수신 광량) 화면의 모양·문구(순수 · v2.646).
 * 판정은 서버 수집 시(parse.judgeOptics) 끝나 있다 — 여기서는 복제하지 않고 그리기만 한다.
 *  · 링크가 없는 포트는 판정하지 않는다(상대가 빛을 보내지 않으므로 바닥이 정상) — '판정 안 함' 으로 따로 보인다.
 *  · 단위는 dBm 으로 **추정**했다(실장비 미확인) — OPTICS_NOTE 가 말한다. 문구에 백틱 금지.
 */
import { numOrNull } from '../../numOrNull.js';
import { countText } from './cvpText.js';
import { CVP_STALE_REASON_TEXT, staleByText } from './cvpPowerText.js';

export const OPTICS_NOTE = '수신 광량(Rx)은 **링크가 올라온 포트만** 판정합니다 — 링크가 없으면 상대가 빛을 보내지 않아 값이 바닥인 것이 정상입니다. '
  + '장비가 임계값을 함께 주면 그것으로, 없으면 CVP 설정의 광신호 기준으로 판정하고, 장애는 장애 이력·알림으로 이어집니다. '
  + '부품 목록이 오래됐거나 장비 수집이 멈춘 장비는 지금 값이 아니므로 판정 칸에서 빼고 **오래된 값**으로 따로 셉니다(행은 직전 판정과 함께 남깁니다). '
  + '값은 dBm 으로 보았습니다(CVP 텔레메트리 필드 이름·단위는 실장비로 확인하지 못한 추정입니다).';

const RX_WORD = { fault: '약함', warn: '낮음', ok: '정상' };

export function dbmText(v) {
  const n = numOrNull(v);
  return n == null ? '—' : `${Math.round(n * 100) / 100} dBm`;
}

/** 행 판정 표시(서버 값 그대로). */
export function opticRowState(o) {
  const r = o && typeof o === 'object' ? o : {};
  // v2.732(감사 B2-03): 오래된 행(서버 stale:true)은 지금 판정이 아니다 — 장애 색으로 칠하지 않고 직전 판정만 함께 말한다.
  if (r.stale === true) {
    const why = CVP_STALE_REASON_TEXT[r.staleReason] || '지금 값 아님';
    const last = RX_WORD[r.lastRxState];
    return { tone: 'muted', label: `오래된 값 — 판정 제외(${why}${last ? ` · 직전 ${last}` : ''})` };
  }
  if (r.judged && r.rxState === 'fault') return { tone: 'bad', label: '약함(장애)' };
  if (r.judged && r.rxState === 'warn') return { tone: 'warn', label: '낮음(주의)' };
  if (r.judged && r.rxState === 'ok') return { tone: 'ok', label: '정상' };
  if (r.linked === false) return { tone: 'muted', label: '판정 안 함(링크 없음)' };
  if (r.rx == null) return { tone: 'muted', label: '광량 값 없음' };
  return { tone: 'muted', label: '판정 안 함' };
}

export function basisText(o) {
  if (!o || !o.judged) return '—';
  return o.basis === 'device' ? '장비 임계' : o.basis === 'portal' ? '포탈 기준' : '—';
}

/** KPI 칸 — 0 은 경고색이 아니다. */
export function opticsKpis(counts, thresholds) {
  const c = counts && typeof counts === 'object' ? counts : {};
  const t = thresholds && typeof thresholds === 'object' ? thresholds : {};
  const n = (k) => numOrNull(c[k]);
  return [
    { key: 'fault', label: '광량 약함(장애)', value: countText(n('fault')), accent: n('fault') > 0 ? 'var(--red)' : undefined, meta: `기준 ${dbmText(t.faultDbm)} 이하(장비 임계가 없을 때)` },
    { key: 'warn', label: '광량 낮음(주의)', value: countText(n('warn')), accent: n('warn') > 0 ? 'var(--amber)' : undefined, meta: `기준 ${dbmText(t.warnDbm)} 이하` },
    { key: 'ok', label: '정상', value: countText(n('ok')), meta: `판정 ${countText(n('judged'))}개` },
    { key: 'notLinked', label: '판정 안 함', value: countText(n('notLinked')), meta: '링크 없는 포트(바닥이 정상)' },
    { key: 'noDom', label: '광량 값 없음', value: countText(n('noDom')), meta: `장착 ${countText(n('present'))} · 빈 슬롯 ${countText(n('absent'))}` },
    // v2.732(감사 B2-03): 판정에서 뺀 트랜시버(장비 부품 값이 지금 값이 아님). 서버가 필드를 주지 않으면(구버전) '—'.
    { key: 'stale', label: '오래된 값(판정 제외)', value: countText(n('staleXcvr')), accent: n('staleXcvr') > 0 ? 'var(--amber)' : undefined,
      meta: n('staleDevices') > 0 ? `장비 ${countText(n('staleDevices'))}대 · ${staleByText(c.staleBy) || '사유 미상'}`
        : n('staleDevices') == null ? '이 서버 버전은 오래된 값을 따로 세지 않습니다' : '부품 값이 오래된 장비 없음' },
  ];
}

/** 광량 값이 하나도 없을 때 — 원인을 단정하지 않고 확인 경로를 말한다. */
export function opticsEmptyNote(counts) {
  const c = counts && typeof counts === 'object' ? counts : {};
  if ((numOrNull(c.withDom) ?? 0) > 0) return '';
  if ((numOrNull(c.present) ?? 0) > 0) {
    return `장착된 트랜시버 ${countText(c.present)}개를 읽었지만 **광량(DOM) 값이 없습니다**. 이 버전부터 트랜시버 노드 아래 DOM 경로를 따라가므로 다음 부품 주기(약 30분) 뒤 다시 보세요. `
      + '그래도 비어 있으면 CVP 설정 탭 › 장비 상세 › 읽은 경로의 **경로 탐색 표본**(xcvr 경로)을 보내 주세요 — 경로·필드 이름을 맞춥니다.';
  }
  if ((numOrNull(c.devicesNoXcvrRead) ?? 0) > 0) return `트랜시버 목록을 읽지 못한 장비가 ${countText(c.devicesNoXcvrRead)}대입니다 — 정상이라는 뜻이 아닙니다.`;
  // v2.732(감사 B2-03): 트랜시버는 있었지만 값이 오래돼 판정에서 뺐다 — '아직 수집 전' 이라 말하지 않는다.
  if ((numOrNull(c.staleDevices) ?? 0) > 0) {
    const why = staleByText(c.staleBy);
    return `**지금 판정할 수 있는 트랜시버가 없습니다** — 부품 값이 오래된 장비 ${countText(c.staleDevices)}대(트랜시버 ${countText(c.staleXcvr)}개)는 판정에서 뺐습니다${why ? `(${why})` : ''}. CVP 설정 탭의 수집 상태를 확인하세요.`;
  }
  return '아직 수집된 트랜시버가 없습니다.';
}

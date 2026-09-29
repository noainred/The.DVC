/**
 * views/tools/cvpOpticsText.js — GBIC 광신호(수신 광량) 화면의 모양·문구(순수 · v2.646).
 * 판정은 서버 수집 시(parse.judgeOptics) 끝나 있다 — 여기서는 복제하지 않고 그리기만 한다.
 *  · 링크가 없는 포트는 판정하지 않는다(상대가 빛을 보내지 않으므로 바닥이 정상) — '판정 안 함' 으로 따로 보인다.
 *  · 단위는 dBm 으로 **추정**했다(실장비 미확인) — OPTICS_NOTE 가 말한다. 문구에 백틱 금지.
 */
import { numOrNull } from '../../numOrNull.js';
import { countText } from './cvpText.js';

export const OPTICS_NOTE = '수신 광량(Rx)은 **링크가 올라온 포트만** 판정합니다 — 링크가 없으면 상대가 빛을 보내지 않아 값이 바닥인 것이 정상입니다. '
  + '장비가 임계값을 함께 주면 그것으로, 없으면 CVP 설정의 광신호 기준으로 판정하고, 장애는 장애 이력·알림으로 이어집니다. '
  + '값은 dBm 으로 보았습니다(CVP 텔레메트리 필드 이름·단위는 실장비로 확인하지 못한 추정입니다).';

export function dbmText(v) {
  const n = numOrNull(v);
  return n == null ? '—' : `${Math.round(n * 100) / 100} dBm`;
}

/** 행 판정 표시(서버 값 그대로). */
export function opticRowState(o) {
  const r = o && typeof o === 'object' ? o : {};
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
  return '아직 수집된 트랜시버가 없습니다.';
}

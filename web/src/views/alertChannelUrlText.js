/**
 * alertChannelUrlText.js — 알림 채널 웹훅 URL 가림 표시(v2.732 점검 2회차 B3-03 후속, 그룹 i3 · 순수).
 *
 * 서버(routes/admin/opsSettings.js hideChannelUrls)는 **범위 계정**의 GET /admin/alerts 응답에서 `config.channels.*.url` 을 '' 로 비우고
 * `hasUrl`(주소가 저장돼 있는가)·`urlHidden:true`, `config.urlsHidden:true` 를 싣는다(웹훅 URL 은 쓰기 자격증명이다). 그런데 화면은 빈 칸을
 * 그대로 그려 '주소가 없다' 로 읽혔다 — 그리고 PUT /admin/alerts·테스트 발송은 전체 범위 계정만(403)이라 저장을 눌러도 거절된다.
 * 이 모듈이 두 화면(설정 › 알림 Alerts2.jsx · 특수 기능 › 리포트 › 알림 채널 ToolsReports.jsx)의 판정·문구를 소유한다:
 *   · 가린 칸은 잠그고 '설정됨(가림)' / '설정 안 됨' 으로 말한다(빈 칸 = 미설정으로 읽히지 않게)
 *   · 범위 계정이면 저장·테스트 발송 버튼을 잠그고 사유를 말한다(눌러 403 을 받게 두지 않는다)
 *   · 저장 본문에서 가린 채널의 url 을 뺀다(심층 방어 — 서버는 url 이 없으면 이전 값을 유지한다. '' 를 보내면 지운다)
 */

/** 서버 opsSettings fleetOnly 사유와 같은 뜻 — 화면이 미리 말한다. */
export const ALERT_FLEET_ONLY_REASON = '알림 채널·규칙은 전 법인 공용 설정이라 전체 범위(vCenter 제한 없는) 계정만 바꾸거나 테스트 발송할 수 있습니다.';
export const URL_HIDDEN_TITLE = '이 계정에는 웹훅 주소를 보이지 않습니다(전 법인 공용 설정 · 주소 자체가 쓰기 자격증명입니다).';

/** 범위 계정 응답인가 — config.urlsHidden 또는 상태의 scoped(구버전 서버도 scoped 는 싣는다). 잠금 사유 문자열 또는 ''. */
export function alertsLockReason(cfg, status = null) {
  const locked = (cfg && typeof cfg === 'object' && cfg.urlsHidden === true) || (status && typeof status === 'object' && status.scoped === true);
  return locked ? ALERT_FLEET_ONLY_REASON : '';
}

/**
 * 채널 URL 입력칸의 표시 — `{ value, placeholder, disabled, title, hidden }`.
 * 가린 채널: 값은 비우고(서버가 비웠다) 입력을 잠그며, 저장 여부는 hasUrl 로 말한다(모르면 '저장 여부 모름' — 지어내지 않는다).
 */
export function channelUrlField(ch, placeholder = '') {
  const c = ch && typeof ch === 'object' ? ch : {};
  if (c.urlHidden === true) {
    const ph = c.hasUrl === true ? '설정됨(가림)' : c.hasUrl === false ? '설정 안 됨' : '가림(저장 여부 모름)';
    return { value: '', placeholder: ph, disabled: true, title: URL_HIDDEN_TITLE, hidden: true };
  }
  return { value: typeof c.url === 'string' ? c.url : '', placeholder, disabled: false, title: undefined, hidden: false };
}

/** 저장 본문 — 가린 채널은 url·hasUrl·urlHidden 을 빼고(서버가 이전 주소를 유지), 최상위 urlsHidden 도 뺀다. 그 밖은 그대로. */
export function withoutHiddenUrls(cfg) {
  if (!cfg || typeof cfg !== 'object') return cfg;
  const { urlsHidden: _omit, ...rest } = cfg;
  if (!rest.channels || typeof rest.channels !== 'object') return rest;
  const channels = {};
  for (const [k, ch] of Object.entries(rest.channels)) {
    if (ch && typeof ch === 'object' && ch.urlHidden === true) {
      const { url: _u, hasUrl: _h, urlHidden: _x, ...keep } = ch;
      channels[k] = keep;
    } else channels[k] = ch;
  }
  return { ...rest, channels };
}

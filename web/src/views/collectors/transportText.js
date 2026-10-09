/**
 * views/collectors/transportText.js — 수집 서버(중앙 ↔ 엣지) **전송 보호 상태의 문구**(순수, 2026-10-09 검토 S-09 · 그룹 J).
 *
 * 판정은 서버(`server/src/collector/transportPolicy.js`)가 하고 응답에 싣는다 — 항목마다 `transport.state`,
 * 목록에 `transport`(요약·리스너·사설 CA·허용 목록·거부 기록·CENTRAL_URL). 이 모듈은 그 값을 **문장으로만** 바꾼다.
 * 예외: 등록 폼은 저장 전에 경고를 보여야 하므로 입력한 URL 이 평문 HTTP 인지(`isInsecureHttpUrl`) 를 여기서 본다 —
 * 서버 `urlTransport` 와 같은 규칙(스킴 없는 주소는 https · 루프백 http 는 망을 지나지 않아 평문으로 세지 않는다)이고,
 * 저장 시 판정은 언제나 서버가 다시 한다(화면 판정이 틀려도 우회가 되지 않는다).
 *
 * ⚠ 문구에 **백틱을 쓰지 말 것** — `BoldText` 는 `**강조**` 만 해석한다. 값 인용은 ‘ ’.
 */

import { numOrNull } from '../../numOrNull.js';

/** 항목 상태 → 표 배지. 안전한 상태(tls·loopback)는 배지를 만들지 않는다(표를 덮지 않게). */
export const TRANSPORT_BADGE = Object.freeze({
  'http-legacy': { label: '평문 HTTP', tone: 'red' },
  'http-approved': { label: 'HTTP 예외', tone: 'amber' },
  'http-allowlisted': { label: 'HTTP 허용 목록', tone: 'amber' },
});

const fmtAt = (ms) => {
  const n = numOrNull(ms);
  if (n == null || n <= 0) return '';
  try { return new Date(n).toLocaleString('ko-KR'); } catch { return ''; }
};

/**
 * 항목의 전송 상태 → 배지(없으면 null). title 은 왜 위험한지와 무엇을 하면 되는지를 말한다.
 * @param {{state?:string, exception?:object, rule?:string, formerRule?:string}|null|undefined} t
 */
export function transportBadge(t) {
  const b = t && TRANSPORT_BADGE[t.state];
  if (!b) return null;
  let title = '';
  if (t.state === 'http-legacy') {
    title = '승인 기록 없는 평문 HTTP — 이 릴리스 이전에 등록된 주소라 계속 동작하지만 수집 토큰과 설정이 암호화되지 않은 채 전송됩니다. 엣지에 TLS 를 켜고 https:// 로 바꾸거나, 별도로 보호된 구간이면 수정에서 사유와 함께 예외로 승인하세요.';
    if (t.formerRule) title += ` (등록 당시 허용 목록 ‘${t.formerRule}’ 에 있었지만 지금은 빠졌습니다.)`;
  } else if (t.state === 'http-approved') {
    const ex = t.exception || {};
    const when = fmtAt(ex.at);
    title = `평문 HTTP 예외 승인 — 사유: ${ex.reason || '(없음)'}${ex.by ? ` · 승인: ${ex.by}` : ''}${when ? ` · ${when}` : ''}. 토큰은 여전히 평문으로 전송됩니다.`;
  } else {
    title = `운영자 허용 목록(COLLECTOR_HTTP_ALLOW ‘${t.rule || ''}’)으로 받은 평문 HTTP — 토큰은 평문으로 전송됩니다.`;
  }
  return { ...b, title };
}

/** IPv4 리터럴의 첫 옥텟(정규형만) — 루프백 판정용. */
function v4First(h) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((x) => x > 255)) return null;
  return parts[0];
}

/**
 * 폼에 입력한 URL 이 평문 HTTP(루프백 제외)인가. 스킴이 없으면 서버가 https:// 를 붙이므로 평문이 아니다.
 * 해석하지 못하면 false(형식 오류는 서버가 말한다).
 */
export function isInsecureHttpUrl(url) {
  const s = String(url ?? '').trim();
  if (!/^http:\/\//i.test(s)) return false;
  let host = '';
  try { host = new URL(s).hostname.replace(/^\[|\]$/g, '').toLowerCase(); } catch { return false; }
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return false;
  return v4First(host) !== 127;
}

/** 두 URL 이 같은 접속처인가(스킴·호스트·포트·경로 — 서버 canonUrl 과 같은 규칙). */
export function sameCollectorUrl(a, b) {
  const canon = (x) => {
    try {
      const u = new URL(String(x ?? '').trim());
      const port = u.port || (u.protocol === 'https:' ? '443' : u.protocol === 'http:' ? '80' : '');
      let p = u.pathname || '';
      while (p.endsWith('/')) p = p.slice(0, -1);
      return `${u.protocol}//${u.hostname.toLowerCase()}:${port}${p}`;
    } catch { return ''; }
  };
  const ca = canon(a);
  return !!ca && ca === canon(b);
}

/**
 * 폼 안내(평문 HTTP 일 때만). editing·original 로 '이 릴리스 이전에 등록된 그대로의 주소' 를 구분한다 —
 * 그 경우는 예외 없이도 저장된다(서버가 기존 항목의 같은 URL 을 받는다)는 사실을 말한다.
 * @returns {null | {text:string, legacyOk:boolean}}
 */
export function formHttpNote({ url, editing = false, originalUrl = '' } = {}) {
  if (!isInsecureHttpUrl(url)) return null;
  const legacyOk = editing && sameCollectorUrl(url, originalUrl);
  const text = '평문 HTTP 주소입니다 — 이 수집 서버로 보내는 수집 토큰(X-Collector-Token)·설정·업그레이드 번들이 암호화되지 않은 채 전송됩니다. 엣지에 TLS(TLS_CERT_FILE·TLS_KEY_FILE)를 켜고 https:// 주소로 등록하세요.'
    + (legacyOk
      ? ' 이 항목은 이전부터 쓰던 주소라 예외 없이도 저장되지만 승인 기록이 없다는 경고가 남습니다.'
      : ' VPN·IPsec 처럼 별도로 보호된 구간이라 HTTP 가 꼭 필요하면 아래에서 예외를 승인하고 사유를 적으세요(감사 로그에 남습니다).');
  return { text, legacyOk };
}

/**
 * 목록 위 요약 문장들(GET /admin/collectors 의 transport). 말할 것이 없으면 빈 배열.
 * tone: 'red' | 'amber' | 'info'
 */
export function transportBannerLines(tr) {
  const out = [];
  if (!tr || typeof tr !== 'object') return out;
  const s = tr.summary || {};
  // 개수 칸 — 보고가 없으면 0 이 정답인 카운터다(측정값이 아니다).
  const cnt = (v) => numOrNull(v) ?? 0;
  const legacy = cnt(s.httpLegacy);
  const approved = cnt(s.httpApproved) + cnt(s.httpAllowlisted);
  if (legacy + approved > 0) {
    out.push({
      tone: legacy ? 'red' : 'amber',
      text: `평문 HTTP 수집 서버 ${legacy + approved}대 — 승인 기록 없음 ${legacy} · 예외 승인 ${cnt(s.httpApproved)} · 허용 목록 ${cnt(s.httpAllowlisted)}. 이 구간의 수집 토큰·설정이 암호화되지 않은 채 전송됩니다. 엣지에 TLS 를 켜고 URL 을 https:// 로 바꾸세요.`,
    });
  }
  const l = tr.listener || {};
  if (l.tls) {
    const dl = numOrNull(l.cert?.daysLeft);
    const days = dl == null ? '' : ` · 인증서 만료 ${dl}일 남음`;
    out.push({ tone: 'info', text: `이 포탈은 HTTPS${l.tlsPort ? `(:${l.tlsPort})` : ''} 로 받습니다${days}.` });
    if (l.httpAlso) out.push({ tone: 'amber', text: `평문 HTTP${l.httpPort ? `(:${l.httpPort})` : ''} 도 함께 열려 있습니다(TLS_HTTP_ALSO — 전환 기간용). 엣지를 모두 https 로 옮긴 뒤 끄세요.` });
  } else if (l && typeof l === 'object' && 'tls' in l) {
    out.push({ tone: 'amber', text: '이 포탈은 평문 HTTP 로만 받습니다(TLS_CERT_FILE·TLS_KEY_FILE 미설정) — 엣지가 이 포탈로 보내는 중앙 토큰과 브라우저 세션도 평문입니다. 앞단에 TLS 종단(HAProxy·nginx)이 있으면 무시해도 됩니다(포탈은 그 존재를 알 수 없습니다).' });
  }
  for (const w of Array.isArray(l.warnings) ? l.warnings : []) out.push({ tone: 'amber', text: `TLS 인증서: ${w}` });
  if (l.reload && l.reload.lastOk === false && l.reload.lastError) out.push({ tone: 'red', text: `TLS 인증서 재로드 실패 — 이전 인증서를 계속 씁니다: ${l.reload.lastError}` });
  const w = tr.wanTls || {};
  if (w.caError) out.push({ tone: 'red', text: `${w.caError} — 사설 CA 로 발급된 중앙·엣지 인증서는 검증에 실패합니다.` });
  else if (cnt(w.caCount) > 0) out.push({ tone: 'info', text: `사설 CA ${w.caCount}개를 중앙↔엣지 인증서 검증에 씁니다(WAN_TLS_CA_FILE).` });
  if (w.verify === false) out.push({ tone: 'red', text: 'WAN_TLS_INSECURE=true — 중앙↔엣지 HTTPS 인증서 검증이 꺼져 있습니다. 사설 CA 를 WAN_TLS_CA_FILE 로 신뢰시키고 끄세요.' });
  const a = tr.allowlist || {};
  if (a.wildcard) out.push({ tone: 'amber', text: '운영자 허용 목록이 전체(COLLECTOR_HTTP_ALLOW=*)입니다 — 모든 평문 HTTP 등록을 받습니다.' });
  else if (a.configured) out.push({ tone: 'info', text: `운영자 허용 목록(COLLECTOR_HTTP_ALLOW): ${(a.rules || []).join(', ')}` });
  if (Array.isArray(a.invalid) && a.invalid.length) out.push({ tone: 'amber', text: `허용 목록의 형식이 틀린 항목은 쓰지 않았습니다: ${a.invalid.join(', ')}` });
  const c = tr.centralUrl || {};
  if (c.insecure && c.warning) out.push({ tone: 'red', text: c.warning });
  return out;
}

/** 거부 기록 한 줄(자기등록·배포 자동 등록이 평문 HTTP 로 들어오려다 거부됨). */
export function rejectedText(r) {
  if (!r) return '';
  const src = r.source === 'self-register' ? '엣지 자기등록' : '자동 등록';
  const when = fmtAt(r.at);
  return `${src} — ‘${r.name || '(이름 없음)'}’ ${r.url || ''}${(numOrNull(r.count) ?? 0) > 1 ? ` · ${r.count}회` : ''}${when ? ` · 마지막 ${when}` : ''}`;
}

/** 거부 기록 안내 — 세 가지 해결 경로(조치가 다르다). */
export const REJECTED_HELP = '엣지가 평문 HTTP 주소로 등록하려다 거부됐습니다. ① 엣지에 TLS 를 켜고 EDGE_ADVERTISE_URL=https://… 로 다시 알리게 하거나 ② 별도로 보호된 구간이면 아래 버튼으로 사유와 함께 예외 등록(엣지의 COLLECTOR_TOKEN 이 필요합니다)하거나 ③ 중앙 portal.env 의 COLLECTOR_HTTP_ALLOW 에 그 대역을 넣으세요.';

/**
 * CSV 가져오기 — 평문 HTTP 행 안내(드라이런 응답의 insecureRows).
 * @returns {string} 행이 없으면 ''
 */
export function importHttpNote(check, { approved = false } = {}) {
  const n = numOrNull(check?.insecureRows) ?? 0;
  if (!n) return '';
  return approved
    ? `평문 HTTP 주소 ${n}행 — 아래 사유로 예외 승인합니다(이미 같은 주소로 등록된 행은 예외 없이도 통과합니다). 토큰은 평문으로 전송됩니다.`
    : `평문 HTTP 주소 ${n}행 — 새로 등록하는 평문 주소는 승인된 예외만 받습니다. 별도로 보호된 구간이면 예외를 체크하고 사유를 적은 뒤 다시 검증하세요(이미 같은 주소로 등록된 행은 그대로 통과합니다).`;
}

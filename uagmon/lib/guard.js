/**
 * 등록 대상 주소 가드 — 서버가 대신 요청을 보내는 기능이므로 SSRF 우회 표기를 차단한다.
 * 포탈 collector/registry.js 의 규칙을 따른다: RFC1918 은 사내 장비 대상이라 허용,
 * 루프백·링크로컬·미지정/멀티캐스트·우회표기(10진/8진/16진·IPv4-mapped IPv6)는 차단.
 * 호스트네임은 사내 DNS 대상이라 허용하되 localhost 계열은 막는다(동기 검사 한계로
 * DNS 해석 결과까지는 보지 않는다 — README 에 명시).
 */

/** 문자열을 IPv4 32bit 정수로. 10진/8진(0접두)/16진(0x)/정수 단일 표기 지원. 아니면 null. */
export function parseIpv4(s) {
  const t = String(s || '').trim();
  if (!t) return null;
  if (!t.includes('.')) {
    // 점 없는 단일 표기 — 10진(2130706433)·16진(0x7f000001)·8진(017700000001) 모두
    // inet_aton 이 IP 로 해석하므로 여기서도 IP 로 본다(호스트네임으로 넘기면 우회 성립).
    let n = null;
    if (/^0x[0-9a-f]+$/i.test(t)) n = parseInt(t, 16);
    else if (/^0[0-7]+$/.test(t)) n = parseInt(t, 8);
    else if (/^\d+$/.test(t)) n = Number(t);
    if (n == null || !Number.isFinite(n) || n > 0xFFFFFFFF) return null;
    return n >>> 0;
  }
  const parts = t.split('.');
  if (parts.length < 2 || parts.length > 4) return null;
  const nums = [];
  for (const p of parts) {
    let n;
    if (/^0x[0-9a-f]+$/i.test(p)) n = parseInt(p, 16);
    else if (/^0[0-7]+$/.test(p)) n = parseInt(p, 8);
    else if (/^\d+$/.test(p)) n = parseInt(p, 10);
    else return null;
    if (!Number.isFinite(n) || n < 0) return null;
    nums.push(n);
  }
  // a.b.c.d 는 각 옥텟 ≤255, 축약형(a.b / a.b.c)은 마지막 항이 나머지 바이트를 채운다(inet_aton 규칙).
  const last = nums[nums.length - 1];
  const heads = nums.slice(0, -1);
  if (heads.some((n) => n > 255)) return null;
  const restBytes = 4 - heads.length;
  if (last >= 2 ** (8 * restBytes)) return null;
  let v = 0;
  for (const h of heads) v = (v * 256) + h;
  v = v * (2 ** (8 * restBytes)) + last;
  return v >>> 0;
}

function ipv4Reason(v4) {
  const a = (v4 >>> 24) & 255;
  const b = (v4 >>> 16) & 255;
  if (a === 127) return '루프백(127.x) 주소는 등록할 수 없습니다.';
  if (a === 0) return '미지정 대역(0.x)은 등록할 수 없습니다.';
  if (a === 169 && b === 254) return '링크로컬(169.254.x — 클라우드 메타데이터 포함)은 등록할 수 없습니다.';
  if (a >= 224) return '멀티캐스트/예약 대역은 등록할 수 없습니다.';
  // 공개 IP 는 기본 차단(사내 사설망 대상 모니터). 저장·연결 직전 SSRF 재검증이 이 함수를
  // 재사용하므로, 여기서 막으면 '공개 서버로 host 바꿔치기 → 자격증명 유출'(M3) 경로가 봉인된다.
  // 공개 대상이 실제 필요하면 UAGMON_ALLOW_PUBLIC=true 로 옵트인.
  const isPrivate = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  if (!isPrivate && String(process.env.UAGMON_ALLOW_PUBLIC).toLowerCase() !== 'true') {
    return '공개 IP 는 등록할 수 없습니다(사내 사설망만 허용 — UAGMON_ALLOW_PUBLIC=true 로 해제).';
  }
  return null; // RFC1918 포함 나머지는 허용(사내 장비 대상)
}

/**
 * IPv6 문자열 → 정규형(소문자 · 0 축약 · 끝의 IPv4 점표기는 16진 두 조각). IPv6 가 아니면 null.
 * WHATWG URL 의 호스트 직렬화가 그 정규형이다(Node 내장 — 외부 의존성 없음). zone(%eth0)은 판정과 무관해 뗀다.
 */
export function canonIpv6(raw) {
  const bare = String(raw || '').trim().toLowerCase().split('%')[0];
  if (!bare || bare.length > 45 || !/^[0-9a-f:.]+$/.test(bare)) return null;
  try { return new URL(`http://[${bare}]/`).hostname.slice(1, -1); } catch { return null; }
}

/** 등록 불가 사유(한국어) 또는 null(허용). host 는 IP 또는 호스트네임(스킴/괄호 없이). */
export function hostBlockReason(raw) {
  let host = String(raw || '').trim().toLowerCase();
  if (!host) return '주소가 비어 있습니다.';
  if (/[\s/\\@?#]/.test(host)) return '주소에는 호스트만 입력하세요(스킴/경로/공백 불가).';
  host = host.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return '루프백(localhost)은 등록할 수 없습니다.';

  // IPv6
  if (host.includes(':')) {
    // 109회차 D-1: 표기를 **정규형으로 바꾼 뒤** 판정한다. 예전에는 입력 문자열 그대로 '::1'·'::ffff:…' 와 비교해 같은 주소의 다른 표기
    //   (0:0:0:0:0:0:0:1 · 0::1 · 0:0:0:0:0:ffff:127.0.0.1 · 0:0:0:0:0:ffff:a9fe:a9fe)가 루프백·링크로컬(메타데이터) 판정을 비켜 갔다 —
    //   기본 설정에서는 '공개 IPv6' 로 막혔지만 UAGMON_ALLOW_PUBLIC=true 에서는 통과했다('옵트인과 무관하게 항상 차단' 이 깨졌다).
    //   IPv6 로 읽을 수 없는 값(abc:def 등)은 거부한다(예전에는 ALLOW_PUBLIC 에서 통과해 연결 단계까지 갔다).
    host = canonIpv6(host);
    if (host == null) return 'IPv6 주소 형식이 올바르지 않습니다.';
    if (host === '::' ) return '미지정 주소(::)는 등록할 수 없습니다.';
    if (host === '::1') return '루프백(::1)은 등록할 수 없습니다.';
    if (/^fe[89ab]/i.test(host)) return '링크로컬(fe80::/10)은 등록할 수 없습니다.';
    // IPv4-mapped: ::ffff:a.b.c.d 또는 ::ffff:hhhh:hhhh
    let m = /^::ffff:(\d[\d.]*)$/.exec(host);
    if (m) {
      const v4 = parseIpv4(m[1]);
      if (v4 == null) return 'IPv4-mapped 주소 형식이 올바르지 않습니다.';
      return ipv4Reason(v4);
    }
    m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
    if (m) return ipv4Reason(((parseInt(m[1], 16) << 16) | parseInt(m[2], 16)) >>> 0);
    // 남은 IPv6: 사설 ULA(fc00::/7)만 허용하고 공개 GUA(2000::/3 등)는 IPv4 와 대칭으로 차단한다
    // (IPv4 만 공개 차단하면 AAAA 가 공개 IPv6 로 해석될 때 자격증명이 그대로 유출된다 — M3).
    const h0 = parseInt(host.split(':')[0] || '0', 16) || 0;
    const isUla = (h0 & 0xfe00) === 0xfc00;   // fc00::/7 (fc/fd 접두)
    if (!isUla && String(process.env.UAGMON_ALLOW_PUBLIC).toLowerCase() !== 'true') {
      return '공개 IPv6 주소는 등록할 수 없습니다(사내 ULA fc00::/7 만 허용 — UAGMON_ALLOW_PUBLIC=true 로 해제).';
    }
    return null;
  }

  // IPv4 (우회 표기 포함)
  const v4 = parseIpv4(host);
  if (v4 != null) return ipv4Reason(v4);

  // 호스트네임 — 사내 DNS 허용. 표기 검증.
  if (!/^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/.test(host)) return '주소에 사용할 수 없는 문자가 있습니다.';
  // 도메인 화이트리스트(옵트인) — 설정 시 그 접미사만 허용. 미설정이면 종전대로 전 호스트명 허용.
  const allow = String(process.env.UAGMON_ALLOWED_DOMAINS || '').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
  if (allow.length && !allow.some((d) => host === d || host.endsWith(`.${d}`))) {
    return '허용된 도메인이 아닙니다(UAGMON_ALLOWED_DOMAINS).';
  }
  return null;
}

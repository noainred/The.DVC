/**
 * SSRF 차단 판정 — IP 리터럴·URL·DNS 해석 결과의 차단 대역 검사(v2.579 에 `collector/registry.js` 에서 분리).
 *
 * ⚠⚠ 왜 옮겼나(ARCH-02): 이 함수들은 순수 네트워크 주소 판정인데 **수집 서버 등록부** 안에 있었고,
 * `util/ssrfLookup.js`(leaf util)가 그것을 가져다 쓰면서 `util → collector → util` **역방향 의존·순환**이
 * 생겼다(`registry.js` 는 그 순환을 피하려고 `resilientFetch` 를 동적 import 로 미루고 있었다).
 * v2.566 의 TDZ 사고(`sanswitch/perfPush.js` — 순환 안에서 이름이 가려져 함수가 통째로 죽었다)와
 * 같은 유형이 되기 전에 방향을 고정한다 — **`util/` 은 `util/`·`config.js`·node 내장만 import 한다**
 * (`test/arch2579.test.js` 가 고정).
 *
 * 호출부 29곳은 `collector/registry.js` 가 같은 이름을 **재수출**하므로 바뀌지 않는다.
 * ⚠ 재수출은 `import { … } ; export { … }` 형태다 — `export { x } from` 은 그 모듈 스코프에 이름을
 * 만들지 않아 registry.js 자신의 `normalize()` 가 `ssrfBlockReason` 을 못 찾는다(v2.575 실제 사고).
 */
import dns from 'node:dns';

// 차단 대상: 링크로컬/클라우드 메타데이터(169.254.0.0/16 = AWS/GCP/Azure 169.254.169.254),
// IPv6 링크로컬(fe80::/10)·ULA(fc00::/7), 루프백(127.0.0.0/8, ::1), 미지정(0.0.0.0/8, ::).
// ★ RFC1918 사설(10/8, 172.16/12, 192.168/16)은 계속 허용해야 한다 — 이 제품의 수집 서버·
//   vCenter·iDRAC이 전부 사내망에 있어 차단하면 정상 기능이 통째로 깨진다(의도적 허용).
// 호스트 문자열에 정규식만 걸면 ::ffff:169.254.169.254(IPv4-mapped)·2852039166(10진수)·
// 0xA9FEA9FE(16진수)·0177.0.0.1(8진수) 같은 대체 표기로 그대로 우회된다 → 호스트를 실제 IP
// 값으로 정규화(언랩/진수 변환)한 뒤 대역을 비교한다.

// 루프백 차단은 새로 추가된 규칙이라, 중앙+엣지를 한 서버에 올린 랩/데모 구성
// (remoteBase=http://127.0.0.1:4000/dl, 수집서버=http://localhost:4000 등)을 막을 수 있다.
// 정상 배포를 깨지 않도록 SSRF_ALLOW_LOOPBACK=true 로 opt-out 제공(기본은 차단).
const allowLoopback = () => String(process.env.SSRF_ALLOW_LOOPBACK || '').toLowerCase() === 'true';

/**
 * 8/10/16진수·축약 IPv4 표기(2852039166, 0xA9FEA9FE, 0177.0.0.1, 10.1)를 점표기로 정규화.
 * IPv4 표기가 아니면(=DNS 이름) null. new URL()도 대부분 정규화해 주지만, URL을 거치지 않는
 * 호스트 문자열(DNS 해석 결과·relayProbe의 host:port)에도 같은 규칙을 적용하려면 필요하다.
 */
function toDottedIPv4(raw) {
  let h = String(raw || '').trim().toLowerCase();
  if (h.endsWith('.')) h = h.slice(0, -1); // FQDN 표기의 트레일링 도트
  if (!h) return null;
  const parts = h.split('.');
  if (parts.length > 4) return null;
  const nums = [];
  for (const p of parts) {
    let n;
    if (/^0x[0-9a-f]+$/.test(p)) n = parseInt(p.slice(2), 16);
    else if (/^0[0-7]+$/.test(p)) n = parseInt(p, 8);
    else if (/^[0-9]+$/.test(p)) n = Number(p);
    else return null; // 숫자 표기가 아니면 IP가 아니다
    if (!Number.isSafeInteger(n) || n < 0) return null;
    nums.push(n);
  }
  const last = nums.pop();
  if (nums.some((n) => n > 255)) return null;
  if (last >= 256 ** (4 - nums.length)) return null; // 마지막 조각이 남은 옥텟을 모두 표현
  let v = last;
  for (let i = 0; i < nums.length; i++) v += nums[i] * 256 ** (3 - i);
  return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join('.');
}

/** IPv6 문자열을 16비트 8그룹으로 확장(::ffff:1.2.3.4 형태 포함). IPv6가 아니면 null. */
function expandIPv6(raw) {
  const h = String(raw || '').trim().toLowerCase().replace(/%.*$/, ''); // fe80::1%eth0 zone id 제거
  if (!h.includes(':')) return null;
  const halves = h.split('::');
  if (halves.length > 2) return null;
  const toGroups = (s) => {
    if (!s) return [];
    const seg = s.split(':');
    const out = [];
    for (let i = 0; i < seg.length; i++) {
      const g = seg[i];
      if (g.includes('.')) {
        if (i !== seg.length - 1) return null; // 점표기 IPv4는 맨 끝에만 올 수 있다
        const d = toDottedIPv4(g);
        if (!d) return null;
        const o = d.split('.').map(Number);
        out.push((o[0] << 8) | o[1], (o[2] << 8) | o[3]);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = toGroups(halves[0]);
  const tail = halves.length === 2 ? toGroups(halves[1]) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null;
  return [...head, ...Array(fill).fill(0), ...tail];
}

function ipv4BlockReason(dotted) {
  const [a, b] = dotted.split('.').map(Number);
  if (a === 169 && b === 254) return '링크로컬/메타데이터 주소는 사용할 수 없습니다.';
  if (a === 127) return allowLoopback() ? null : '루프백 주소(127.x)는 사용할 수 없습니다(필요하면 SSRF_ALLOW_LOOPBACK=true).';
  if (a === 0) return '0.0.0.0(미지정) 주소는 사용할 수 없습니다.';
  return null; // RFC1918 등 사내 대역은 허용
}

function ipv6BlockReason(g) {
  const zeros = (from, to) => g.slice(from, to).every((x) => x === 0);
  const v4 = [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255].join('.');
  if (g.every((x) => x === 0)) return '미지정(::) 주소는 사용할 수 없습니다.';
  if (zeros(0, 7) && g[7] === 1) return allowLoopback() ? null : '루프백 주소(::1)는 사용할 수 없습니다(필요하면 SSRF_ALLOW_LOOPBACK=true).';
  // IPv4-mapped(::ffff:a.b.c.d)·NAT64(64:ff9b::/96)·IPv4-compatible(::a.b.c.d)은 IPv4로 언랩해
  // 같은 규칙을 적용 — ::ffff:169.254.169.254 로 메타데이터를 치는 우회를 막는다.
  if (zeros(0, 5) && g[5] === 0xffff) return ipv4BlockReason(v4);
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return ipv4BlockReason(v4);
  if (zeros(0, 6)) return ipv4BlockReason(v4);
  if ((g[0] & 0xffc0) === 0xfe80) return '링크로컬/메타데이터 주소는 사용할 수 없습니다.'; // fe80::/10
  if ((g[0] & 0xfe00) === 0xfc00) return 'ULA(fc00::/7) 주소는 사용할 수 없습니다.';
  return null;
}

/**
 * 호스트(또는 IP) 문자열 1개에 대한 차단 사유. IP 리터럴이 아니면(=DNS 이름) null을 반환하고,
 * 이름의 실제 해석 검사는 ssrfBlockReasonResolved가 담당한다.
 */
export function ipBlockReason(hostOrIp) {
  const host = String(hostOrIp || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return 'URL의 호스트가 올바르지 않습니다.';
  const v4 = toDottedIPv4(host);
  if (v4) return ipv4BlockReason(v4);
  const g = expandIPv6(host);
  if (g) return ipv6BlockReason(g);
  // 잘 알려진 루프백 이름은 해석 없이도 막는다(DNS 조회가 불가한 동기 경로 대비).
  if (!allowLoopback() && (host === 'localhost' || host.endsWith('.localhost'))) {
    return '루프백 이름(localhost)은 사용할 수 없습니다(필요하면 SSRF_ALLOW_LOOPBACK=true).';
  }
  return null;
}

/**
 * URL 문자열을 받아 차단 사유(문자열) 또는 null(허용) 반환. 여러 경로에서 공용으로 쓴다.
 * 동기 함수 — 호출부가 많아 시그니처를 유지한다(DNS 해석까지 보려면 아래 async 버전 사용).
 */
export function ssrfBlockReason(urlStr) {
  let u;
  // 스킴이 없는 'host:port'만 http://를 붙인다(이미 스킴이 있으면 그대로 → 비-http 스킴을 제대로 거부).
  try { u = new URL(/:\/\//.test(String(urlStr)) ? urlStr : `http://${urlStr}`); }
  catch { return 'URL 형식이 올바르지 않습니다.'; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'http/https URL만 허용됩니다.';
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return 'URL의 호스트가 올바르지 않습니다.';
  return ipBlockReason(host);
}

/**
 * ssrfBlockReason + DNS 해석 결과까지 검사(차단 대역으로 해석되는 이름 차단).
 * 동기 버전을 쓰는 기존 호출부를 바꾸지 않기 위해 별도 async 함수로 추가했다.
 * - 해석 실패(ENOTFOUND/타임아웃)는 차단 사유로 보지 않는다 — 일시적 DNS 장애로 정상 등록·저장을
 *   막으면 안 되고, 실제 요청 단계에서 어차피 실패한다.
 * - DNS rebinding(검사 후 재해석)까지는 막지 못하는 best-effort 가드다.
 */
export async function ssrfBlockReasonResolved(urlStr) {
  const sync = ssrfBlockReason(urlStr);
  if (sync) return sync;
  let host = '';
  try { host = new URL(/:\/\//.test(String(urlStr)) ? urlStr : `http://${urlStr}`).hostname.replace(/^\[|\]$/g, ''); }
  catch { return 'URL 형식이 올바르지 않습니다.'; }
  if (toDottedIPv4(host) || expandIPv6(host)) return null; // 이미 IP 리터럴 → 위에서 검사 완료
  let addrs = [];
  try { addrs = await dns.promises.lookup(host, { all: true, verbatim: true }); }
  catch { return null; }
  for (const a of addrs) {
    const r = ipBlockReason(a.address);
    if (r) return `${r} (DNS 해석: ${host} → ${a.address})`;
  }
  return null;
}

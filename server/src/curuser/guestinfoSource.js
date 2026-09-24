/**
 * curuser/guestinfoSource.js — **게스트 계정 없이** 로그온 사용자 수를 읽는 경로(v2.520, 순수 모듈).
 *
 * 2026-09-15 사용자 결정: **"Guestos 계정 없이"**. 그래서 이 기능은 VMware Tools 게스트 작업
 * (`gpu/guestops.js` — `NamePasswordAuthentication` 필요)을 쓰지 않는다. 대신:
 *
 *   ① 게스트 안의 발행기(스케줄 작업)가 `quser` 출력을 **자기 스스로** VMX 에 써 넣는다
 *      → `vmtoolsd --cmd "info-set guestinfo.curuser.d0 <base64>"`
 *   ② 포탈은 vCenter `config.extraConfig` 에서 그 값을 **읽기만** 한다(자격증명 0).
 *
 * ── 왜 원문(quser 출력)을 base64 로 실어 오는가 ────────────────────────────────
 * 게스트 스크립트가 파싱까지 하면, 파서를 고칠 때마다 **Windows 서버 전부에 재배포**해야 한다
 * (운영 서버 수백 대). 그래서 게스트는 **아무 판단도 하지 않고** 원문만 싣고, 형식 관용성·상태
 * 지역화(`활성`/`연결 끊김`) 판정은 포탈의 `quser.js` 가 갖는다 — 테스트가 있는 쪽이다.
 * base64 인 이유는 VMX 값에 줄바꿈을 넣지 않기 위해서다(한 줄 = 한 키).
 *
 * ── 정직성 계약(이 모듈의 존재 이유) ───────────────────────────────────────────
 * 값이 없는 이유를 **한 문구로 덮지 않는다**(CLAUDE.md v2.493). 상태는 다음 중 하나다:
 *   `ok`         읽었고 신선하다
 *   `stale`      읽었지만 발행 시각이 오래됐다(발행기가 멈췄거나 Tools 가 죽었다)
 *   `no-agent`   `guestinfo.curuser.*` 키가 **하나도 없다** → 발행기 미설치 **또는** 이
 *                vCenter/ESXi 가 게스트 발행값을 extraConfig 로 노출하지 않음. **두 원인을
 *                구분할 정보가 우리에게 없으므로 둘 다 말한다**(아래 ⚠ 참조).
 *   `guest-error` 발행기가 돌았지만 `quser` 를 실행하지 못했다(`.err` 에 사유가 있다)
 *   `incomplete`  청크 일부가 비었다(발행 도중에 읽었을 가능성 — 다음 주기에 정상화된다)
 *   `unparsed`    원문을 받았지만 **형식을 읽지 못했다**. 0명이 **아니다**
 *   `clock-skew`  발행 시각이 미래다(게스트 시계 오차) — 신선도 판정을 신뢰할 수 없다
 *
 * ⚠ **미검증 전제(정직 기록)**: 게스트가 `info-set` 한 `guestinfo.*` 가 **재부팅 전에도**
 *   vCenter `config.extraConfig` 조회에 나타나는지 이 환경에서 확인하지 못했다. 확인된 것은
 *   ⓐ 게스트에서 비관리자도 `vmtoolsd --cmd` 로 VM 구성을 바꿀 수 있다 ⓑ 재부팅 후 VMX 에
 *   영구 반영된다 (open-vm-tools issue #288) 두 가지뿐이다. 그래서 `no-agent` 문구는 원인을
 *   **단정하지 않는다** — 실장비 1대로 확인되면 문구를 좁힐 것.
 * ⚠ **이 값은 게스트가 스스로 쓴 것이다** — 게스트의 임의 사용자가 위조할 수 있다(위 ⓐ).
 *   모니터링용이지 **감사 증적이 아니다**. 화면에도 그렇게 적는다.
 */
import { xmlUnescape } from '../vcenter/soapParse.js';
import { parseQuser } from './quser.js';

/** VMX 키 접두. 이 접두 아래만 읽는다(다른 guestinfo 는 건드리지 않는다). */
export const PREFIX = 'guestinfo.curuser.';
/** 발행기가 쓰는 스키마 버전 — 게스트 스크립트와 **같이** 올릴 것. */
export const SCHEMA = 1;
/** 청크 상한(발행기와 동일). 넘으면 게스트가 `.omitted` 로 밝힌다. */
export const MAX_CHUNKS = 8;

/**
 * `config.extraConfig`(ArrayOfOptionValue XML) → Map<key, value>.
 *
 * `parseObjectContent`(soapParse.js:80)은 중첩 XML 을 **원형 문자열로** 남기므로 여기서 푼다.
 * 우리 접두만 담아 Map 크기를 제한한다(VM 하나의 extraConfig 는 수십 개 키다).
 */
export function parseExtraConfig(xml, { prefix = PREFIX } = {}) {
  const out = new Map();
  const s = String(xml || '');
  if (!s) return out;
  const re = /<key>([\s\S]*?)<\/key>\s*<value[^>]*>([\s\S]*?)<\/value>/g;
  let m;
  while ((m = re.exec(s))) {
    const k = xmlUnescape(m[1]).trim();
    if (prefix && !k.startsWith(prefix)) continue;
    out.set(k, xmlUnescape(m[2]));
  }
  return out;
}

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** base64 → UTF-8 문자열. 실패하면 null(형식 미인식으로 다룬다 — 0명이 아니다). */
function b64(text) {
  try {
    const clean = String(text || '').replace(/\s+/g, '');
    if (!clean) return '';
    const buf = Buffer.from(clean, 'base64');
    // 왕복이 맞지 않으면 base64 가 아니다(깨진 값을 조용히 빈 문자열로 만들지 않기 위한 확인).
    if (!buf.length) return null;
    return buf.toString('utf8');
  } catch { return null; }
}

/**
 * 한 VM 의 `guestinfo.curuser.*` 를 해석한다.
 *
 * @param {Map<string,string>} map  `parseExtraConfig` 결과(접두 포함 키)
 * @param {object} p
 * @param {number} p.now           포탈 기준 시각(ms)
 * @param {number} p.staleAfterMs  이보다 오래된 발행은 `stale`
 * @param {number} [p.skewGraceMs] 미래 허용 폭(기본 5분 — NTP 미세 오차를 오판하지 않게)
 * @returns {{
 *   kind:string, ok:boolean, at:number|null, ageMs:number|null, schema:number|null,
 *   active:number|null, disc:number|null, other:number|null, sessions:number|null,
 *   users:Array<{name,kind}>, noUsers:boolean, unknownStates:string[],
 *   omitted:number, chunks:number, guestHost:string, error:string, raw:string
 * }}
 */
export function readGuestInfo(map, { now = Date.now(), staleAfterMs = 30 * 60_000, skewGraceMs = 5 * 60_000 } = {}) {
  // ⚠ 발행기는 **빈 값을 `-` 로** 쓴다(`info-set key ` 는 뒤에 공백만 남아 거부될 수 있다 —
  //   `agentScript.js` 의 `Set-GuestInfo` 가 같은 규약을 주석으로 적고 있다). 여기서 되돌린다.
  const g = (k) => {
    const v = map instanceof Map ? map.get(PREFIX + k) : (map || {})[PREFIX + k];
    const s = v == null ? '' : String(v).trim();
    return s === '-' ? '' : s;
  };
  const base = {
    kind: 'no-agent', ok: false, at: null, ageMs: null, schema: null,
    active: null, disc: null, other: null, sessions: null,
    users: [], noUsers: false, unknownStates: [], omitted: 0, chunks: 0,
    truncated: false, usersLowerBound: false,
    guestHost: '', error: '', raw: '',
  };
  const keys = map instanceof Map ? [...map.keys()] : Object.keys(map || {});
  if (!keys.some((k) => String(k).startsWith(PREFIX))) return base;

  const schema = num(g('v'));
  // 발행 시각은 **초** 단위로 싣는다(게스트 스크립트가 짧게 쓰도록). ms 로 올려 쓴다.
  const atSec = num(g('at'));
  const at = atSec == null ? null : Math.round(atSec * 1000);
  const guestHost = g('host').slice(0, 120);
  const err = g('err').slice(0, 300);
  const omitted = num(g('omitted')) || 0;
  const n = Math.max(0, Math.min(MAX_CHUNKS, num(g('n')) || 0));
  const out = { ...base, schema, at, guestHost, error: err, omitted, chunks: n };
  if (at != null) out.ageMs = now - at;

  // 발행기가 사유를 남겼으면 그것이 먼저다 — 원문이 없는 것을 '형식 미인식' 이라 말하지 않는다.
  if (err) return { ...out, kind: 'guest-error' };
  if (!n) return { ...out, kind: 'no-agent' };

  const parts = [];
  for (let i = 0; i < n; i++) {
    const c = g(`d${i}`);
    if (!c) return { ...out, kind: 'incomplete', error: `청크 ${i + 1}/${n} 이 비어 있습니다(발행 도중일 수 있습니다).` };
    parts.push(c);
  }
  let raw = b64(parts.join(''));
  if (raw == null) return { ...out, kind: 'unparsed', error: 'base64 디코딩에 실패했습니다.' };
  // ⚠ v2.606 COL2606-01: 발행기는 원문이 상한(MAX_CHUNKS×CHUNK)을 넘으면 base64 를 **잘라** 싣고
  //   `omitted=1` 로 밝힌다. 그 사실을 버리면 ① 잘린 마지막 줄이 상태를 못 읽어 가짜 'other' 세션이
  //   되고 ② 부분 인원이 전체처럼 'ok' 로 세어진다(120세션 → 65명). 마지막 개행 뒤 조각(잘린 줄)은
  //   버리고, 수치는 **하한**(`truncated`·`usersLowerBound`)으로 밝힌다 — 집계·화면이 '최소 N명' 이라 말한다.
  const truncated = omitted > 0;
  if (truncated) {
    const cut = raw.lastIndexOf('\n');
    raw = cut >= 0 ? raw.slice(0, cut + 1) : '';
  }
  out.truncated = truncated;
  out.usersLowerBound = truncated;
  out.raw = raw.slice(0, 8000);

  const q = parseQuser(raw);
  if (!q.parsed) return { ...out, kind: 'unparsed', error: q.note || 'quser 출력 형식을 읽지 못했습니다.' };

  out.active = q.active; out.disc = q.disc; out.other = q.other;
  out.sessions = q.total;
  // 잘린 원문에서 세션이 안 보이는 것은 '사용자 없음' 이 아니다(하한 0 일 뿐).
  out.noUsers = q.noUsers && !truncated;
  out.users = (q.users || []).map((u) => ({ name: u.name, kind: u.kind }));
  out.unknownStates = q.unknownStates || [];

  // 신선도 — **읽은 뒤에** 판정한다(값은 이미 있으니 화면이 '언제 값' 인지 함께 말할 수 있다).
  if (at == null) return { ...out, kind: 'stale', error: '발행 시각(at)이 없습니다 — 신선도를 알 수 없습니다.' };
  if (out.ageMs < -skewGraceMs) return { ...out, kind: 'clock-skew' };
  if (out.ageMs > staleAfterMs) return { ...out, kind: 'stale' };
  return { ...out, kind: 'ok', ok: true };
}

/** 상태 코드 → 화면·보고서 문구(웹이 같은 표를 쓴다 — `web/src/views/tools/curUserText.js`). */
export const KIND_LABEL = Object.freeze({
  ok: '정상',
  stale: '값이 오래됨',
  'no-agent': '발행기 값 없음',
  'guest-error': '게스트 오류',
  incomplete: '발행 중(불완전)',
  unparsed: '형식 미인식',
  'clock-skew': '게스트 시계 오차',
});

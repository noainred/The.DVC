/**
 * 공개 API 안내 페이지 — **판정·문구 단일 소유자** (v2.564). 순수 모듈.
 *
 * 이 페이지는 **로그인 없이** 보이므로, 문구가 "이 포탈에 무엇이 있는지" 를 필요 이상으로
 * 말하지 않아야 한다. 동시에 연동 담당자가 **무엇을 못 보고 있는지**는 알려야 한다
 * (감춘 사실을 감추면 그 사람은 API 가 8개뿐이라고 오해한다).
 *
 * ⚠⚠ **이 페이지만 백틱을 해석한다.** 앱 전체의 규칙은 '백틱 금지'(BoldText 가 `**강조**` 만
 *   해석해 백틱이 글자로 샌다 — v2.439·2.440·2.505·2.545·2.553·2.562 실제 사고)인데, 여기는
 *   **개발자 문서 화면**이라 `null`·`meta.truncated` 같은 식별자를 코드로 보여야 뜻이 산다.
 *   그리고 원문(`publicapi/openapi.js CONTRACT_NOTES`)은 **OpenAPI 스펙의 마크다운**이라
 *   백틱이 거기서는 맞다 — 그것을 고치면 스펙 쪽이 망가진다.
 *   ⚠ 그래서 `parseRich` 를 이 화면 전용으로 두고, **다른 화면에 가져다 쓰지 말 것**
 *     (v2.564 Chromium 판독에서 백틱 18개가 글자로 새는 것을 잡아 만든 것이다).
 */

/** 페이지 머리말 — 이 API 가 무엇이고 무엇이 아닌지. */
export const INTRO = '다른 포탈·대시보드가 이 포탈의 **조회 데이터를 읽어 가는** API 입니다. '
  + '**조회 전용**이라 이 키로는 어떤 값도 바꿀 수 없습니다.';

/** ⚠ 무엇을 안 보여주는지 밝힌다 — 감춘 사실까지 감추면 오해를 만든다. */
export const SCOPE_NOTE = '이 페이지는 **외부 연동용 공개 API 만** 다룹니다. '
  + '포탈 내부 기능의 API 는 공개하지 않습니다 — 필요하면 포탈 관리자에게 문의하세요.';

/** 샘플이 가짜임을 항상 말한다. */
export const SAMPLE_NOTE = '아래 샘플 응답은 **손으로 지어낸 값**입니다 — 이 포탈의 실제 데이터가 아닙니다. '
  + '형식과 **null 이 나오는 자리**를 보여주는 것이 목적입니다.';

/** 키 발급 안내 — 이 페이지에서는 발급할 수 없다는 사실을 분명히. */
export const KEY_NOTE = '키는 **포탈 관리자**가 설정 › Security › 연동 키에서 발급합니다. '
  + '이 페이지에서는 발급할 수 없습니다. 키 값은 **발급 직후 한 번만** 표시됩니다.';

/** '직접 호출' 패널 경고 — 방문자의 키가 어디로 가는지 정확히 말한다. */
export const TRY_NOTE = '아래에 **본인이 발급받은 키**를 넣으면 이 브라우저에서 직접 호출해 봅니다. '
  + '키는 **이 탭의 메모리에만** 있고 저장하거나 어디로도 보내지 않습니다 — '
  + '요청은 브라우저에서 이 포탈로 바로 갑니다.';

/** 분류 라벨 색조 — 민감도에 따라. */
export const SENSITIVITY_TONE = Object.freeze({ low: 'ok', medium: 'warn', high: 'bad' });

/**
 * 범위 배지 문구.
 * ⚠ **`scoped`(범위 적용)와 `requiresFullScope`(범위 키 거절)는 반대말이다** — 섞으면
 *   연동 담당자가 범위 키를 만들어 놓고 403 을 받는다.
 */
export function scopeBadge(ep) {
  if (!ep) return null;
  if (ep.requiresFullScope) {
    return { tone: 'bad', label: '전체 범위 키만',
      title: 'vCenter 범위를 지정한 키는 403 입니다 — 이 자원에는 법인 축이 없어 범위와 교집합할 수 없습니다.' };
  }
  if (ep.scoped) {
    return { tone: 'ok', label: 'vCenter 범위 적용',
      title: '키에 vCenter 범위가 있으면 그 법인 것만 나옵니다(범위 미지정 = 전체).' };
  }
  return { tone: 'muted', label: '범위 없음', title: '포탈 전체 기준입니다.' };
}

/**
 * 검색 — 경로·요약·분류·필드 이름까지 본다.
 * ⚠ 필드 이름을 빼면 "usedPct 어디 있지?" 로 찾는 사람이 못 찾는다.
 */
export function filterEndpoints(endpoints, q) {
  const terms = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return endpoints || [];
  return (endpoints || []).filter((e) => {
    const hay = [e.path, e.summary, e.group, ...(e.fields || [])].join(' ').toLowerCase();
    return terms.every((t) => hay.includes(t));   // 여러 단어는 AND
  });
}

/**
 * 상태코드 → 색조.
 *
 * ⚠⚠ **`Number(null) === 0` 함정을 여기서 또 밟았다**(v2.525·2.540·2.550·2.552·2.556·2.561 에
 *   이어 일곱 번째. v2.564 자체 테스트가 잡았다). 예전 판정은 `Number.isFinite(Number(status))`
 *   였는데 `Number(null)`·`Number('')`·`Number([])` 가 전부 **0** 이고 `0 < 300` 이라
 *   **상태가 없는데 초록('성공')으로 칠했다** — 화면이 오류 없이 거짓을 말하는 종류다.
 *   그래서 **타입부터 좁힌다**: 숫자이거나 숫자 문자열일 때만 본다(v2.556 `tempNum` 과 같은 형태).
 */
export function statusTone(status) {
  let n = null;
  if (typeof status === 'number') n = status;
  else if (typeof status === 'string' && /^-?\d+$/.test(status.trim())) n = Number(status);
  if (n == null || !Number.isFinite(n)) return 'muted';
  if (n < 300) return 'ok';
  if (n < 500) return 'warn';
  return 'bad';
}

/**
 * '직접 호출' 결과 판정.
 * ⚠ **실패를 한 문구로 덮지 않는다** — 코드마다 조치가 다르다(이 API 의 설계 축이다).
 * @returns {{tone:string, title:string, hint:string}}
 */
export function tryResultNote(status, body) {
  const code = body && typeof body === 'object' ? body.code : null;
  if (status === 0) {
    return { tone: 'bad', title: '요청을 보내지 못했습니다',
      hint: '네트워크·CORS·프록시 문제일 수 있습니다. 브라우저 개발자 도구의 네트워크 탭을 보세요.' };
  }
  const MAP = {
    'missing-key': '키를 넣지 않았습니다.',
    'unknown-key': '서버가 모르는 키입니다 — 값을 다시 확인하세요(오타·삭제된 키).',
    revoked: '폐기된 키입니다. 같은 값은 다시 살아나지 않습니다 — 새로 발급받으세요.',
    expired: '만료된 키입니다 — 관리자가 만료일을 늘리거나 재발급합니다.',
    'no-groups': '이 키에 허용 분류가 하나도 없습니다 — 관리자가 분류를 켜야 합니다.',
    'group-denied': '이 경로의 분류가 이 키에 없습니다 — 관리자가 그 분류를 켜야 합니다.',
    'needs-full-scope': 'vCenter 범위를 지정한 키로는 볼 수 없는 자원입니다 — 범위 없는 키가 필요합니다.',
    'unknown-endpoint': '공개되지 않은 경로입니다.',
    'rate-limited': '분당 상한을 넘었습니다 — 잠시 뒤 다시 시도하세요.',
    'not-collected': '첫 수집이 아직 끝나지 않았습니다 — **장애가 아닙니다.** 잠시 뒤 다시 시도하세요.',
    unavailable: '해당 기능 모듈을 불러올 수 없습니다 — 포탈 관리자에게 문의하세요.',
  };
  if (status >= 200 && status < 300) {
    return { tone: 'ok', title: `${status} 성공`, hint: '' };
  }
  return { tone: statusTone(status), title: `${status} ${code || '오류'}`, hint: MAP[code] || '' };
}

/**
 * 응답에서 **주의해서 읽어야 할 점**을 뽑는다.
 * ⚠ 이 API 의 계약(‘읽지 못한 값은 null’·‘상한에 걸리면 밝힌다’)은 문서로만 적으면 안 읽힌다 —
 *   실제 응답을 보여줄 때 그 자리에서 말해야 전달된다.
 */
export function responseHints(body) {
  const out = [];
  if (!body || typeof body !== 'object') return out;
  const meta = body.meta || {};
  if (meta.truncated) {
    out.push(`목록이 상한(${meta.limit ?? '?'})에 걸려 **${meta.omitted ?? '?'}건이 빠졌습니다** — 전체가 아닙니다.`);
  }
  if (meta.scopedToVcenters != null) {
    out.push(`이 키의 **vCenter 범위 ${meta.scopedToVcenters}곳**으로 걸러진 결과입니다.`);
  }
  const rows = Array.isArray(body.data) ? body.data : (body.data ? [body.data] : []);
  const nullFields = new Set();
  for (const r of rows.slice(0, 50)) {
    if (!r || typeof r !== 'object') continue;
    for (const [k, v] of Object.entries(r)) if (v === null) nullFields.add(k);
  }
  if (nullFields.size) {
    out.push(`**null 인 필드**: ${[...nullFields].join(', ')} — 0 이 아니라 ‘읽지 못했다’ 는 뜻입니다.`);
  }
  if (meta.note) out.push(meta.note);
  return out;
}

/** 페이지가 꺼져 있을 때 — 원인을 나눠 말한다(조치가 다르다). */
export function disabledNote(kind) {
  if (kind === 'off') {
    return '이 포탈은 공개 API 안내 페이지를 **꺼 두었습니다**. 포탈 관리자에게 문의하세요.';
  }
  return '안내 정보를 불러오지 못했습니다. 잠시 뒤 다시 시도하거나 포탈 관리자에게 문의하세요.';
}

/**
 * `**강조**` 와 백틱 코드를 **평평한 토큰**으로 쪼갠다 — 이 화면 전용.
 * @returns {{v:string, bold:boolean, code:boolean}[]}
 *
 * ⚠⚠ **중첩을 처리해야 한다.** 원문이 `**0 이 아니라 \`null\`**` 처럼 굵게 **안에** 코드를
 *   품는다(`CONTRACT_NOTES` 6줄 중 3줄이 그렇다). 굵게만 먼저 떼고 끝내면 그 안의 백틱이
 *   **글자로 남아** 화면에 그대로 보인다 — v2.564 초판이 실제로 그랬고 Chromium 이 잡았다.
 *   그래서 ① 굵게로 나누고 ② **각 조각 안에서 다시** 코드로 나눈다.
 * ⚠ 짝이 맞지 않는 표시는 **글자 그대로** 둔다(억지 해석은 원문과 다른 것을 보여준다).
 */
export function parseRich(text) {
  const src = String(text ?? '');
  const out = [];
  const pushCode = (chunk, bold) => {
    let last = 0; let m;
    const re = /`([^`]+)`/g;
    while ((m = re.exec(chunk))) {
      if (m.index > last) out.push({ v: chunk.slice(last, m.index), bold, code: false });
      out.push({ v: m[1], bold, code: true });
      last = m.index + m[0].length;
    }
    if (last < chunk.length) out.push({ v: chunk.slice(last), bold, code: false });
  };
  let last = 0; let m;
  const re = /\*\*([^*]+)\*\*/g;
  while ((m = re.exec(src))) {
    if (m.index > last) pushCode(src.slice(last, m.index), false);
    pushCode(m[1], true);
    last = m.index + m[0].length;
  }
  if (last < src.length) pushCode(src.slice(last), false);
  return out.filter((t) => t.v !== '');
}

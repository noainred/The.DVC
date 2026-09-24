/**
 * storage/collectors/unityVersion.js — Unity 모델·소프트웨어 버전 파서(순수, v2.544).
 *
 * 사용자 요청(2026-09-17): "unity 스토리지 버전 보이게 명령어 추가하고 여기에 버전 표시해줘".
 * 장비 표의 '버전' 열은 `snap.version` 을 읽는데(`web/.../storageColumns.js`), v2.542 전면
 * 재작성 이후 **아무 데서도 채우지 않아** 전 장비가 `—` 였다. 지금 쓰는
 * `uemcli /stor/general/system show` 출력에는 **버전이 없다**(용량 7줄뿐 — 실장비 픽스처 확인).
 *
 * ── 출처가 둘이고, 어느 쪽으로 읽었는지 밝힌다 ──────────────────────────────────
 *  ① `uemcli /sys/general show -detail` — uemcli 계열로 통일되지만 **이 장비의 그 출력을
 *     한 번도 본 적이 없다**(버전 필드 이름도 모른다). 그래서 **후보 키 체인**으로 읽고
 *     어느 키를 썼는지 `usedKey` 로 남긴다(v2.525 Horizon `usedUserKey` 규약).
 *  ② `svc_diag` (인자 없음 = basic state) — **사용자가 실제 출력을 보여준 명령**이다:
 *       * System Serial Number is: DE403204511072
 *       * System Model Number is: Unity 480F
 *       * Current Software version: c4dev_PIE_8775R-5.4.0.0.5.094-GNOSIS_RETAIL
 *     이 장비에서 `service` 계정으로 동작하는 것이 확인됐다(v2.526 에도 같은 기록).
 *
 * ⚠ **읽지 못하면 빈 문자열이다** — 지어내지 않는다. 화면은 `—` 로 둔다.
 * ⚠ **원문을 버리지 않는다**(`versionRaw`). `c4dev_PIE_8775R-5.4.0.0.5.094-GNOSIS_RETAIL` 에서
 *   사람이 쓰는 부분은 `5.4.0.0.5.094` 지만, 그 추출이 다른 장비에서 빗나갈 수 있으므로
 *   **원문을 나란히 남기고** 화면이 툴팁으로 보여준다(추정을 사실로 말하지 않기 위해).
 */

/** uemcli `/sys/general show -detail` 의 버전 키 후보 — 실장비 확인 전이라 체인이다. */
export const VERSION_KEYS = Object.freeze([
  'System version', 'Software version', 'System software version', 'Version',
]);
/** 같은 이유의 모델 키 후보. */
export const MODEL_KEYS = Object.freeze(['Model', 'System model', 'Platform', 'Product model']);
/** 같은 이유의 시리얼 키 후보. */
export const SERIAL_KEYS = Object.freeze([
  'Product serial number', 'System serial number', 'Serial number', 'Serial',
]);

/** 레코드 배열에서 후보 키를 앞에서부터 찾아 `{ value, key }`. 못 찾으면 `{ value:'', key:null }`. */
function pick(records, keys) {
  for (const k of keys) {
    for (const r of records || []) {
      const v = r && r[k];
      if (v != null && String(v).trim()) return { value: String(v).trim(), key: k };
    }
  }
  return { value: '', key: null };
}

/**
 * uemcli 레코드(= `parseUemcli` 결과)에서 버전·모델·시리얼.
 * @param {Array<Record<string,string>>} records
 */
export function versionFromUemcli(records) {
  /*
   * v2.585 — `uemcli /sys/soft/ver show` 는 **설치본과 후보(업그레이드 대기) 이미지를 함께** 나열한다
   * (`Type = Installed` / `Candidate`). 후보 이미지의 버전을 현재 버전이라 말하면 **오류 없이 틀린 값**이다 —
   * `Type` 이 있는 레코드는 설치본을 앞으로, 후보(Candidate/Upgrade)는 **아예 뺀다**. ⚠ 이 명령의 실장비
   * 출력은 아직 보지 못했다(Dell Unity CLI 가이드 기준) — 어느 키를 읽었는지는 `usedKey` 가 밝힌다.
   */
  const list = (Array.isArray(records) ? records : []).filter((r) => r && typeof r === 'object');
  const typed = list.filter((r) => r.Type != null);
  const ordered = typed.length
    ? [...typed.filter((r) => /install/i.test(String(r.Type))), ...list.filter((r) => r.Type == null)]
    : list;
  const v = pick(ordered, VERSION_KEYS);
  records = ordered;
  const m = pick(records, MODEL_KEYS);
  const s = pick(records, SERIAL_KEYS);
  return {
    version: shortVersion(v.value),
    versionRaw: v.value,
    model: m.value,
    serial: s.value,
    source: v.value || m.value ? 'uemcli' : null,
    usedKey: v.key,
  };
}

/**
 * `svc_diag`(basic state) 출력에서 버전·모델·시리얼.
 *
 * 줄 형태 두 가지를 **둘 다** 받는다(사용자 캡처 실측):
 *   `* System Model Number is: Unity 480F`     ← `… is:` 형
 *   `* Current Software version: c4dev_…`      ← `is` 없는 형
 * 앞의 `*` 와 공백은 버린다. 값이 비면 그 항목은 만들지 않는다(빈 문자열).
 */
export function versionFromSvcDiag(text) {
  const map = new Map();
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/^\s*\*\s*/, '').trim();
    if (!line) continue;
    /*
     * v2.599(SEC2599-02 형제 — 재현): 예전 `/^(.*?)(?:\s+is)?\s*:\s*(.+)$/` 는 게으른 키가 한 글자씩 늘 때마다 뒤 공백
     *   연속을 다시 훑어 ':' 없는 긴 공백 줄에서 O(n²) 였다(3만 자 약 1.9초). 같은 뜻을 선형으로 — 첫 ':' 에서 자르고
     *   키 끝의 `<공백>is` 를 뗀다(줄은 trim 돼 있어 첫 ':' 뒤가 비는 경우는 값이 빈 것뿐이다).
     */
    const ci = line.indexOf(':');
    if (ci < 0) continue;
    let kk = line.slice(0, ci).trimEnd();
    if (kk.endsWith('is') && kk.length >= 3 && /\s/.test(kk[kk.length - 3])) kk = kk.slice(0, -2);
    const k = kk.trim().toLowerCase();
    const v = line.slice(ci + 1).trim();
    if (k && v && !map.has(k)) map.set(k, v);
  }
  const get = (...keys) => {
    for (const k of keys) { const v = map.get(k); if (v) return v; }
    return '';
  };
  const versionRaw = get('current software version', 'software version', 'system software version');
  const model = get('system model number', 'model number', 'system model');
  const serial = get('system serial number', 'serial number');
  return {
    version: shortVersion(versionRaw),
    versionRaw,
    model,
    serial,
    source: versionRaw || model ? 'svc_diag' : null,
    usedKey: null,
  };
}

/**
 * 표시용 버전 — 빌드 문자열에서 **점으로 이어진 숫자 덩어리**만 뽑는다.
 *   `c4dev_PIE_8775R-5.4.0.0.5.094-GNOSIS_RETAIL` → `5.4.0.0.5.094`
 * ⚠ 못 찾으면 **원문을 그대로 돌려준다**(잘라내서 없는 버전을 만들지 않는다).
 * ⚠ 점 구간이 3개 미만인 것은 뽑지 않는다 — `8775R` 같은 조각을 버전이라 말하지 않기 위해.
 */
export function shortVersion(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  // v2.603(감사 SEC2603-05): 숫자 구간의 시작에서만 시도한다(뒤보기) — 예전 정규식은 긴 숫자열에서 O(n²) 였다
  //   ('0' 4만 자에 수 초). 가장 왼쪽 매치는 언제나 숫자 구간의 시작이므로 결과는 같다.
  const m = /(?<!\d)\d+(?:\.\d+){2,}/.exec(s);
  return m ? m[0] : s;
}

/**
 * 두 출처를 **합치되 덮어쓰지 않는다** — 앞 출처가 채운 항목은 그대로 두고 빈 것만 뒤가 채운다.
 * 어느 출처가 무엇을 채웠는지 `sources` 로 남긴다(화면이 근거를 말할 수 있게).
 */
export function mergeVersionInfo(...parts) {
  const out = { version: '', versionRaw: '', model: '', serial: '', sources: [], usedKey: null };
  for (const p of parts) {
    if (!p) continue;
    let used = false;
    for (const f of ['version', 'versionRaw', 'model', 'serial']) {
      if (!out[f] && p[f]) { out[f] = p[f]; used = true; }
    }
    if (!out.usedKey && p.usedKey) out.usedKey = p.usedKey;
    if (used && p.source && !out.sources.includes(p.source)) out.sources.push(p.source);
  }
  return out;
}

/**
 * storage/collectors/uemcliParse.js — uemcli 출력 파서(순수, v2.542 전면 재작성).
 *
 * ── 왜 전면 재작성인가 (사용자 지시 2026-09-17) ──────────────────────────────────
 * "계속 파싱이 안되는데, 지금까지 만든 모든 unity480 파싱 삭제하고 내가 지금 보낸 것에 대한
 *  파싱만 해서 자료 채워줘. 기존에 만들었던 unity480 파싱 자료와 혼합해서 사용하면 더 복잡해진다."
 *
 * v2.525~2.541 의 누적 구조를 버렸다. 버린 것과 이유:
 *  - **CSV(`-output csv`) 경로**: 이 장비의 CSV 출력을 **한 번도 본 적이 없다**(v2.530 이 그렇게
 *    적어 두었다). 못 본 형식을 위해 배너 오탐·열 수 검사·따옴표 절단 판정을 유지하는 것이
 *    v2.525·2.526·2.529·2.530 네 번의 헛수정을 만든 원인이다.
 *  - **명령별 후보 체인**: 후보가 실패할 때마다 다음 후보를 시도하느라 한 항목이 시한(45초)을
 *    여러 번 먹었다. 실제로 사용자 화면에 `자동응답 0회 · 45초 · 26B 수신` 이 찍혔다.
 *  - **기대 필드 적중 수로 채점하는 `recordsFor`**: 아래 한 가지 규칙으로 대체된다.
 *
 * ── 이 파서가 쓰는 유일한 규칙 ────────────────────────────────────────────────────
 * uemcli 의 사람이 읽는 출력은 **` = ` 로 갈리는 `키 = 값`** 이다. 배너는 `: ` 로 갈린다.
 *
 *     Storage system address: 127.0.0.1     ← 배너(': ')  → 버린다
 *     Total space   = 117544396521472 (106.9T)  ← 데이터(' = ') → 읽는다
 *
 * 그래서 **첫 ` = ` 로만 자른다**. 이 한 줄이 v2.525 의 'CSV 배너에 쉼표가 하나 있으면 헤더로
 * 잡혀 필드 없는 레코드가 생긴다' 결함과 v2.530 의 '80칸에서 접힌 CSV 가 없는 풀을 만든다'
 * 결함을 **둘 다** 구조적으로 없앤다(둘 다 CSV 경로의 결함이었다).
 *
 * ⚠ 지킬 것:
 *  - 레코드 경계는 **줄 맨 앞의 `N:`** 이다(`1:` `2:` …). 들여쓴 줄은 현재 레코드에 속한다.
 *  - **값이 빈 키를 버리지 않는다**(`Description =` 는 '설명이 없다' 는 정보다). 단 수치 변환은
 *    빈 값에 `null` 을 준다 — **0 을 만들지 않는다**(v2.525·v2.531 규약).
 *  - `Total space = 117544396521472 (106.9T)` 는 **앞의 정수 바이트를 쓴다**. 괄호 안은 반올림이라
 *    그것을 쓰면 추이에 없는 계단이 생긴다.
 *  - 아무것도 못 읽으면 **빈 배열**이다. 호출부가 '읽지 못했다' 로 다루게 한다(지어내지 않는다).
 *
 * 근거 자료: 사용자가 제공한 실장비 출력 3건 — `test/fixtures/uemcli-pool-detail-2542.txt`,
 * `uemcli-system-show-2542.txt`, `uemcli-pool-show-2542.txt`. 식별자만 합성으로 바꿨고
 * **용량 수치와 괄호 표기는 원본 그대로**다(v2.513 공개 저장소 규약).
 */

/* 줄 끝 문자(\n·\r·U+2028·U+2029) — 정규식의 '.' 이 맞추지 않는 글자. 줄은 \r?\n 으로 나눴지만 외로운 \r·U+2028 은 남을 수 있다. */
const LINE_TERM = /[\n\r\u2028\u2029]/;

/**
 * (순수) 레코드 시작 줄 — 맨 앞의 `1:` `2:` … (앞 공백 없음). 예전 `/^(\d+):\s*(.*)$/` 와 같은 판정.
 * v2.744(회귀 검토 GH-R2): 그 정규식은 ':' 뒤 긴 공백 다음 값 안에 외로운 \r·U+2028 이 있으면 (공백 길이 × 줄 길이)로
 *   역추적했다 — 3만 자 공백 줄 하나에 parseUemcli 가 약 2.3초 멈췄다(장비 출력은 외부 입력 — svcDiag.js INJPKG-02 와 같은 꼴).
 *   규칙: 값 = ':' 뒤 앞 공백을 뺀 나머지 · 그 안에 줄 끝 문자가 있으면 맞지 않는다. 결과가 같음을 test/audit2744rg.test.js 가
 *   무작위 입력으로 대조한다 — 정규식으로 되돌리지 말 것.
 * @returns {[string, string, string]|null} [줄, 레코드 번호, 같은 줄의 나머지(앞 공백 제거)]
 */
export function recStart(line) {
  const s = String(line);
  const h = /^(\d+):/.exec(s);
  if (!h) return null;
  const v = s.slice(h[0].length).trimStart();
  return LINE_TERM.test(v) ? null : [s, h[1], v];
}

/**
 * uemcli 사람이 읽는 출력 → 레코드 배열. 각 레코드는 `{ [키]: 원문값 }` 이다.
 * 키는 원문 그대로(공백 포함, 앞뒤 trim). 값도 원문 그대로 trim 만 한다.
 * @param {string} text
 * @returns {Array<Record<string,string>>}
 */
/**
 * 줄 끝이 `키 =`(값 없음)이면 키 원문을, 아니면 `null`.
 * v2.599(감사 SEC2599-02 — 재현): 예전 `/^(.*?)\s+=\s*$/` 는 게으른 앞부분이 한 글자씩 늘 때마다 뒤 공백 연속을
 *   끝까지 다시 훑어 O(n²) 였다(공백 6만 개 줄 하나에 약 3.4초 — 줄 끝 replace 를 고친 뒤에도 남았다). 같은 뜻을 선형으로 —
 *   끝 공백을 뗀 줄이 `=` 로 끝나고 그 앞이 공백이면 키다.
 */
function trailingKey(line) {
  const t = String(line).trimEnd();
  if (!t.endsWith('=')) return null;
  const body = t.slice(0, -1);
  if (!/\s$/.test(body)) return null;
  return body.trim();
}

/** 그 줄이 `키 = 값` 이면 키를, 아니면 `null`. (경계 판정과 저장이 같은 규칙을 쓰게 한다.) */
function keyOf(line) {
  const i = line.indexOf(' = ');
  if (i >= 0) return line.slice(0, i).trim() || null;
  const k = trailingKey(line);
  return k || null;
}

export function parseUemcli(text) {
  const out = [];
  let cur = null;
  const put = (line) => {
    const i = line.indexOf(' = ');
    // ⚠ 마지막 열이 빈 값이면 `Description                =` 로 끝난다(뒤에 공백이 없다).
    //   그래서 ' = ' 뿐 아니라 줄 끝의 ' =' 도 받는다.
    if (i < 0) {
      const k = trailingKey(line);
      if (k == null || !cur) return;
      if (k) cur[k] = '';
      return;
    }
    if (!cur) return;
    const k = line.slice(0, i).trim();
    if (k) cur[k] = line.slice(i + 3).trim();
  };

  const lines = String(text || '').split(/\r?\n/);
  /*
   * ⚠ **레코드 번호가 하나도 없으면** 키 반복으로 경계를 잡는다(v2.544 방어).
   *
   * v2.542~2.543 은 `^N:` 이 없으면 **전부 버렸다**(`put` 의 `if (!cur) return`). 실제로
   * `stripUemcliBanner` 가 그 번호를 지우고 있어 멀쩡한 출력이 통째로 사라졌다 — 명령은
   * 성공인데 섹션은 '읽지 못했습니다' 였다. 그 원인은 v2.544 에서 고쳤지만, 경계 표시 하나에
   * 전 출력이 걸려 있는 구조 자체를 남겨 두지 않는다.
   *
   * ⚠⚠ **여러 레코드를 하나로 합치지 말 것** — 합치면 뒤 값이 앞 값을 덮어써 **오류 없이
   * 틀린 값**이 된다(풀 2개가 1개로 보이고 용량이 과소 보고된다). 그래서 **이미 본 키가 다시
   * 나오면 새 레코드**로 끊는다. 키가 겹치지 않으면 원래 한 레코드였다는 뜻이다.
   */
  // v2.599(감사 SEC2599-02 — 재현): 줄 끝 공백 제거는 trimEnd() 다. `replace(/\s+$/, '')` 는 앞쪽 공백 연속마다
  //   끝까지 다시 훑어 O(n²) 라, 공백만 긴 줄 하나(오동작·변조 장비 출력 — 상한 4MB)로 이벤트 루프가 멈춘다.
  const noMarker = !lines.some((l) => recStart(l.trimEnd()));

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const m = noMarker ? null : recStart(line);   // v2.744(회귀 검토 GH-R2): 선형 판정
    if (m) {
      cur = {};
      out.push(cur);
      if (m[2] && m[2].trim()) put(m[2]);
      continue;
    }
    if (noMarker) {
      const k = keyOf(line);
      // 첫 키이거나, 이미 본 키가 다시 나왔으면 새 레코드를 연다.
      if (k && (!cur || Object.prototype.hasOwnProperty.call(cur, k))) {
        cur = {};
        out.push(cur);
      }
    }
    // 들여쓰지 않은 줄은 배너·명령 에코·프롬프트다 — ' = ' 가 없으면 자연히 버려진다.
    put(line);
  }
  // 키가 하나도 없는 레코드는 버린다(`1:` 만 있고 내용이 안 온 경우).
  return out.filter((r) => Object.keys(r).length > 0);
}

/**
 * `117544396521472 (106.9T)` · `2400305152 (2.2G)` · `0` → 바이트 정수.
 * **앞의 정수를 쓴다**(괄호 안은 반올림). 정수가 없으면 `null` — 0 을 만들지 않는다.
 * ⚠ `38 x 3.8T SAS Flash 4` 처럼 수치가 아닌 값에 쓰지 말 것(앞의 38 을 바이트로 읽는다).
 *   그런 값은 문자열로 그대로 쓴다(`Drives`).
 * @param {string} v
 * @returns {number|null}
 */
export function toBytes(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const m = /^(\d+)\s*(?:\(|$)/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** `70%` · `0%` → 70 · 0. 빈 값·비숫자는 `null`. */
export function toPct(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const m = /^(-?\d+(?:\.\d+)?)\s*%?$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** 정수. 빈 값·비숫자는 `null`(0 으로 만들지 않는다). */
export function toInt(v) {
  const s = String(v ?? '').trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** `OK (5)` → `OK`. 빈 값은 `''`(호출부가 'unknown' 으로 다룬다 — 정상이라 하지 않는다). */
export function healthOf(v) {
  // v2.599(SEC2599-02): `replace(/\s*\(\d+\)\s*$/)` 는 앞의 `\s*` 가 공백 연속마다 재시도해 O(n²) 였다(공백 4만 개 값에 1.2초).
  const s = String(v ?? '').trim();
  const m = /\(\d+\)$/.exec(s);
  return m ? s.slice(0, m.index).trimEnd() : s;
}

/** `yes`/`no` → true/false. 그 밖(빈 값 포함)은 `null`(모르는 것을 false 라 하지 않는다). */
export function toYesNo(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'yes' || s === 'true') return true;
  if (s === 'no' || s === 'false') return false;
  return null;
}

/**
 * `uemcli /stor/config/pool show [-detail]` → 풀 배열.
 * `-detail` 과 짧은 `show` **둘 다** 이 함수가 받는다(키가 있는 것만 채운다).
 *
 * ⚠ 짧은 `show` 에는 `Current allocation` 이 **없다**. 그때는 `전체 − 잔여` 로 되돌려 쓰되
 *   `usedSource:'computed'` 로 밝힌다 — 실측(사용자 제공 출력)으로 확인한 차이는
 *   `Preallocated`(2400305152B) 만큼이고, 그대로 두면 사용량이 그만큼 과다해진다.
 * @param {string} text
 */
export function parsePools(text) {
  const recs = parseUemcli(text);
  const pools = [];
  for (const r of recs) {
    const name = String(r.Name || r.ID || '').trim();
    const total = toBytes(r['Total space']);
    if (!name && total == null) continue;            // 풀로 볼 근거가 없다
    const remaining = toBytes(r['Remaining space']);
    const alloc = toBytes(r['Current allocation']);
    const prealloc = toBytes(r.Preallocated);
    let used = alloc;
    let usedSource = alloc != null ? 'device' : null;
    if (used == null && total != null && remaining != null) {
      used = Math.max(0, total - remaining);
      usedSource = 'computed';                        // 조용히 쓰지 않는다 — 화면이 밝힌다
    }
    pools.push({
      name: name || null,
      id: String(r.ID || '').trim() || null,
      poolType: String(r.Type || '').trim() || null,
      totalBytes: total,
      usedBytes: used,
      usedSource,
      freeBytes: remaining,
      preallocatedBytes: prealloc,
      subscribedBytes: toBytes(r.Subscription),
      subscriptionPct: toPct(r['Subscription percent']),
      alertThresholdPct: toPct(r['Alert threshold']),
      flashPct: toPct(r['Flash percent']),
      pct: total && used != null ? Math.round((used / total) * 1000) / 10 : null,
      drives: String(r.Drives || '').trim() || null,  // `38 x 3.8T SAS Flash 4` — 문자열 그대로
      disks: toInt(r['Number of drives']),
      raid: String(r['RAID level'] || '').trim() || null,
      stripeLength: toInt(r['Stripe length']),
      rebalancing: toYesNo(r.Rebalancing),
      health: healthOf(r['Health state']) || null,
      healthDetails: String(r['Health details'] || '').replace(/^"|"$/g, '').trim() || null,
      dataReductionRatio: String(r['Data Reduction Ratio'] || r['Data Reduction ratio'] || '').trim() || null,
      dataReductionSavedBytes: toBytes(r['Data Reduction space saved']),
      allFlash: toYesNo(r['All flash pool']),
      protectionUsedBytes: toBytes(r['Protection size used']),
      nonBaseUsedBytes: toBytes(r['Non-base size used']),
    });
  }
  return pools;
}

/**
 * `uemcli /stor/general/system show` → 시스템 전체 용량.
 * 키는 풀과 다르다 — `Used space`(풀의 `Current allocation` 과 같은 값) · `Free space`.
 * 읽지 못하면 `null` 을 돌려 호출부가 '읽지 못했다' 로 다루게 한다.
 * @param {string} text
 * @returns {null | {totalBytes:number|null, usedBytes:number|null, freeBytes:number|null,
 *                   preallocatedBytes:number|null, dataReductionRatio:string|null,
 *                   dataReductionSavedBytes:number|null, dataReductionPct:number|null}}
 */
export function parseSystemSpace(text) {
  const r = parseUemcli(text)[0];
  if (!r) return null;
  const out = {
    totalBytes: toBytes(r['Total space']),
    usedBytes: toBytes(r['Used space']),
    freeBytes: toBytes(r['Free space']),
    preallocatedBytes: toBytes(r['Preallocated space']),
    dataReductionRatio: String(r['Data Reduction ratio'] || r['Data Reduction Ratio'] || '').trim() || null,
    dataReductionSavedBytes: toBytes(r['Data Reduction space saved']),
    dataReductionPct: toPct(r['Data Reduction percent'] || r['Data Reduction Percent']),
  };
  // 용량 키가 하나도 없으면 이 출력이 아니다 — 빈 껍데기를 돌려주지 않는다.
  if (out.totalBytes == null && out.usedBytes == null && out.freeBytes == null) return null;
  return out;
}

/**
 * 항등식 검사 — `Total = Used + Free + Preallocated`.
 * 실측(사용자 제공 출력)은 정확히 맞는다: 117544396521472 = 29973250195456 + 87568746020864
 * + 2400305152. 어긋나면 파싱이 깨진 것이므로 조용히 계산을 이어가지 않는다.
 * @returns {{ok:boolean, checked:boolean, diff:number|null}}
 */
export function checkSpaceIdentity({ totalBytes, usedBytes, freeBytes, preallocatedBytes } = {}) {
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const t = n(totalBytes); const u = n(usedBytes); const f = n(freeBytes);
  const p = n(preallocatedBytes) ?? 0;
  if (t == null || u == null || f == null) return { ok: true, checked: false, diff: null };
  const diff = t - (u + f + p);
  return { ok: Math.abs(diff) <= 1024, checked: true, diff };
}

/**
 * v2.788 — `uemcli /stor/prov/luns/lun show -detail` → LUN 배열(하위 항목 — 사용자 요청 "LUN·파일시스템까지").
 *
 * ⚠⚠ **이 장비의 이 출력은 본 적이 없다**(정직 기록). 키 이름은 Dell Unity Unisphere CLI 사용자 가이드의 예시
 *   (`Size = 2199023255552 (2T)` · `Current allocation = …`)를 근거로 했고, 형식 규칙(` = ` 구분 · `N:` 레코드 경계 ·
 *   앞의 정수 바이트)은 실장비 출력으로 확인된 풀 출력과 같다고 **가정**했다. 그래서:
 *   · 키를 못 찾으면 그 값은 **null** 이다(0 을 만들지 않는다) — 사용률도 null 이 된다.
 *   · 레코드는 있는데 크기를 하나도 못 읽었으면 호출부가 'unparsed' 로 밝힌다(`resourceProbe`) — 원문은 CLI 원문 상세에 있다.
 * '사용량' 은 **풀에서 할당된 양**(`Current allocation`)이다 — 호스트가 본 사용량이 아니다(usedSource 'allocation').
 * @param {string} text
 */
export function parseLuns(text) {
  const out = [];
  for (const r of parseUemcli(text)) {
    const name = String(r.Name || '').trim();
    const id = String(r.ID || '').trim();
    const size = toBytes(r.Size);
    if (!name && !id) continue;
    if (size == null && r['Current allocation'] == null && r['Storage pool'] == null) continue;   // LUN 으로 볼 근거가 없다
    const alloc = toBytes(r['Current allocation']);
    out.push({
      kind: 'lun', id: id || null, name: name || id,
      pool: String(r['Storage pool'] || r['Storage pool ID'] || '').trim() || null,
      totalBytes: size, usedBytes: alloc, usedSource: alloc != null ? 'allocation' : null,
      health: healthOf(r['Health state']) || null,
    });
  }
  return out;
}

/**
 * v2.788 — `uemcli /stor/prov/fs show -detail` → 파일시스템 배열.
 * ⚠⚠ 위 `parseLuns` 와 같은 한계 — 이 장비의 출력을 본 적이 없다. 키는 가이드 예시(`Size` · `Size used`)가 근거다.
 * '사용량' 은 파일시스템이 보고한 사용량(`Size used`)이다(usedSource 'fs').
 * @param {string} text
 */
export function parseFilesystems(text) {
  const out = [];
  for (const r of parseUemcli(text)) {
    const name = String(r.Name || '').trim();
    // `ID = res_1`(스토리지 리소스) 와 `File system = fs_1` 이 함께 온다 — 이력 키는 리소스 ID 를 쓴다.
    const id = String(r.ID || r['File system'] || '').trim();
    const size = toBytes(r.Size);
    if (!name && !id) continue;
    if (size == null && r['Size used'] == null && r.Protocol == null) continue;   // 파일시스템으로 볼 근거가 없다
    const used = toBytes(r['Size used']);
    out.push({
      kind: 'fs', id: id || null, name: name || id,
      pool: String(r['Storage pool'] || r['Storage pool ID'] || '').trim() || null,
      totalBytes: size, usedBytes: used, usedSource: used != null ? 'fs' : null,
      health: healthOf(r['Health state']) || null,
      protocol: String(r.Protocol || '').trim() || null,
    });
  }
  return out;
}

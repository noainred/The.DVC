/**
 * views/tools/unityCapacityPlan.js — Unity 용량 산정(순수, v2.540).
 *
 * 사용자 요청(2026-09-17): uemcli `/stor/config/pool show -detail` 화면을 보여 주며 "이 화면 참고해서
 * 용량 산정 하는 기능 만들어줘". 선택한 산정 대상 4가지 — ① 할당 가능량 ② 소진 예상일 ③ 수용 개수
 * ④ 원시·유효 용량. 대상은 Unity 계열 먼저.
 *
 * ── 이 화면이 답해야 하는 질문과, 그 답이 갈리는 이유 ────────────────────────────
 * 실측(사용자 제공 pool_1):
 *   Total space        117544396521472 (106.9T)
 *   Current allocation  29973250195456 (27.2T)   ← 실제로 물리에 잡아 둔 양
 *   Preallocated            2400305152 (2.2G)
 *   Remaining space     87568746020864 (79.6T)
 *   Subscription        55491782770688 (50.4T)   ← 호스트에 **약속한** 크기(씬)
 *   Subscription percent 47%  ·  Alert threshold 70%
 * 항등식 확인: 할당 + 잔여 + Preallocated = 전체(실측 오차 0). `verifyIdentity` 가 이걸 검사한다 —
 * 어긋나면 우리가 필드를 잘못 읽은 것이므로 **조용히 계산하지 않는다**.
 *
 * ⚠ **'얼마를 더 줄 수 있나' 는 답이 하나가 아니다.** 씬 프로비저닝이라 잔여(79.6T)만 보면
 *   과대평가다 — 이미 50.4T 를 약속해 뒀고, 그 약속이 다 채워지면 할당이 그만큼 늘어난다.
 *   그래서 **기준을 나란히** 내고 **가장 작은 값을 실질 한도**로 표시한다. 하나만 보여 주면
 *   그 전제가 감춰진다(CLAUDE.md 'storage 증가량' 규약과 같은 계열).
 *
 * ⚠ **원시 용량은 계산이 장비 보고와 맞지 않는다**(실측으로 확인). `38 x 3.8T` · RAID5 stripe 9 로
 *   계산하면 표기 해석에 따라 116.7~128.4 TiB 인데 장비는 106.9 TiB 를 보고한다(장비/원시 74~81%).
 *   핫스페어 수·시스템 예약을 분해할 근거가 uemcli 출력에 **없다**. 그래서 원시는 **추정**으로만
 *   내고 차이는 `오버헤드(패리티·핫스페어·시스템 예약)` 라고만 말한다 — 지어낸 분해를 보여주지 않는다.
 *   **사용 가능한 값으로 쓰는 것은 언제나 장비가 보고한 Total space 다.**
 *
 * 모든 함수는 순수하다(웹 테스트가 node 환경이라 컴포넌트 렌더 불가 — CLAUDE.md 규약).
 */

const TIB = 1024 ** 4;
const DAY_MS = 86_400_000;

/** 유한 양수만 통과(0·null·NaN·음수는 null) — `Number(null) === 0` 함정 방지(v2.525 규약). */
export function posNum(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * `38 x 3.8T SAS Flash 4` → 드라이브 구성. 실측 형식이 이것뿐이라 관용적으로 읽는다.
 * ⚠ `3.8T` 가 TiB 인지 10진 TB 인지 **출력만으로는 알 수 없다** — 두 해석을 모두 돌려주고
 *   호출부가 '추정' 임을 밝힌다(어느 쪽도 장비 보고와 맞지 않는다는 것이 실측 결과다).
 */
export function parseDrives(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  const m = /^(\d+)\s*[x×]\s*([\d.]+)\s*([kKmMgGtTpP])[bB]?\s*(.*)$/.exec(s);
  if (!m) return null;
  const count = Number(m[1]);
  const size = Number(m[2]);
  if (!Number.isFinite(count) || count <= 0 || !Number.isFinite(size) || size <= 0) return null;
  const unit = m[3].toLowerCase();
  const binMult = { k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: TIB, p: 1024 ** 5 }[unit] || 1;
  const decMult = { k: 1e3, m: 1e6, g: 1e9, t: 1e12, p: 1e15 }[unit] || 1;
  return {
    count,
    model: m[4].trim() || null,
    text: s,
    eachBinary: Math.round(size * binMult),   // 3.8T = 3.8 TiB 해석
    eachDecimal: Math.round(size * decMult),  // 3.8T = 3.8 TB(10진) 해석
  };
}

/**
 * 원시·유효 용량 — **추정**. 장비가 보고한 유효 용량(deviceUsableBytes)을 진실로 두고, 원시 추정과의
 * 차이를 오버헤드로만 말한다.
 * @returns {null | {drives, rawLow, rawHigh, deviceUsableBytes, overheadPctLow, overheadPctHigh,
 *                   raid, stripeLength, parityShare, note, exact:false}}
 */
export function rawCapacity({ drives, raid, stripeLength, deviceUsableBytes } = {}) {
  const d = parseDrives(drives);
  const usable = posNum(deviceUsableBytes);
  if (!d) return null;
  const rawLow = d.count * d.eachDecimal;   // 10진 해석(작다)
  const rawHigh = d.count * d.eachBinary;   // TiB 해석(크다)
  const stripe = posNum(stripeLength);
  // RAID5 는 스트라이프당 1디스크가 패리티. RAID6 는 2. 그 외는 모른다고 말한다.
  const lvl = String(raid ?? '').trim();
  const parity = lvl === '5' ? 1 : lvl === '6' ? 2 : null;
  const parityShare = parity != null && stripe && stripe > parity ? (stripe - parity) / stripe : null;
  const pct = (part, whole) => (part && whole ? Math.round((part / whole) * 1000) / 10 : null);
  return {
    drives: d,
    raid: lvl || null,
    stripeLength: stripe,
    parityShare,                       // RAID 패리티만 뺀 비율(예: RAID5 stripe 9 → 0.889)
    rawLow,
    rawHigh,
    deviceUsableBytes: usable,
    // 장비 유효 / 원시 추정 — 낮은 해석과 높은 해석 두 값(범위로 말한다)
    usableShareHigh: pct(usable, rawLow),
    usableShareLow: pct(usable, rawHigh),
    exact: false,
    note: '원시 용량은 드라이브 표기(‘38 x 3.8T’)로 **추정**한 값입니다 — ‘3.8T’ 가 TiB 인지 10진 TB 인지 출력만으로는 알 수 없어 범위로 냅니다. 장비가 보고한 유효 용량과의 차이는 **패리티·핫스페어·시스템 예약**이 섞인 것이고, uemcli 출력에는 그 내역이 없어 분해하지 않습니다. 계산에 쓰는 값은 언제나 **장비가 보고한 전체 용량**입니다.',
  };
}

/**
 * 필드 항등식 검사 — `할당 + 잔여 + 선할당 = 전체`(실측 오차 0). 어긋나면 필드를 잘못 읽은 것이다.
 * @returns {{ok:boolean, diffBytes:number|null, text:string|null}}
 */
export function verifyIdentity({ totalBytes, usedBytes, freeBytes, preallocatedBytes } = {}) {
  const t = posNum(totalBytes); const u = posNum(usedBytes); const f = posNum(freeBytes);
  if (!t || u == null || !f) return { ok: true, diffBytes: null, text: null }; // 검사할 수 없으면 통과(모른다)
  const pre = posNum(preallocatedBytes) || 0;
  const diff = t - (u + f + pre);
  // 1GiB 이내면 반올림·선할당 표기 차이로 본다.
  const ok = Math.abs(diff) <= 1024 ** 3;
  return {
    ok,
    diffBytes: diff,
    text: ok ? null : `전체(${t}) ≠ 할당(${u}) + 잔여(${f}) + 선할당(${pre}) — 차이 ${diff} 바이트. 필드를 잘못 읽었을 수 있어 산정을 신뢰하지 마세요.`,
  };
}

/**
 * ① 할당 가능량 — **기준마다 답이 다르다**. 전부 내고 가장 작은 것을 실질 한도로 표시한다.
 * @returns {null | {bases: Array<{key,label,availBytes,note}>, limiting, totalBytes, usedBytes}}
 */
export function headroom({ totalBytes, usedBytes, freeBytes, subscribedBytes, alertThresholdPct, pools } = {}) {
  const t = posNum(totalBytes);
  const u = usedBytes == null ? null : Math.max(0, Number(usedBytes));
  if (!t || u == null || !Number.isFinite(u)) return null;
  const free = posNum(freeBytes) ?? Math.max(0, t - u);
  const sub = posNum(subscribedBytes);
  const thr = posNum(alertThresholdPct);

  const bases = [];
  bases.push({
    key: 'physical', label: '물리 잔여',
    availBytes: free,
    note: '지금 당장 쓸 수 있는 공간입니다. **씬 프로비저닝이면 과대평가**입니다 — 이미 약속한 구독분이 채워지면 이만큼 줄어듭니다.',
  });
  if (thr != null && thr > 0 && thr <= 100) {
    bases.push({
      key: 'alert', label: `경고 임계(${thr}%)까지`,
      availBytes: Math.max(0, t * (thr / 100) - u),
      note: '장비에 설정된 경고 임계까지의 여유입니다. 이 선을 넘으면 장비가 경보를 올립니다'
        + '(임계값은 장비 설정 **Alert threshold**).',
    });
  } else {
    /*
     * ⚠ **풀이 여러 개여도 임계 기준을 버리지 않는다**(v2.546, 사용자 지시).
     *
     * v2.545 까지는 `planInput` 이 다중 풀에서 `alertThresholdPct` 를 `null` 로 두어 이 기준이
     * **통째로 사라졌다**. 2풀 재현 실측: 실질 한도가 47.6 TB(경고 임계) → 84.7 TB(구독)로
     * **1.8배 느슨해지고** 화면은 "표시하지 않습니다" 라고만 했다 — 가장 보수적인 기준이
     * 사라진 것을 말하지 않으니 사용자는 두 배 가까운 숫자를 보고 LUN 을 만들게 된다.
     *
     * 해법은 **대표 임계를 만들지 않는 것**이다. 풀마다 자기 임계로 계산해 **더한다** —
     * 이것은 대표값이 아니라 풀별 계산의 합이므로 v2.540 규약('풀마다 값이 달라 대표값을
     * 만들면 거짓')을 어기지 않는다. 임계를 못 읽은 풀은 **빼고 개수를 밝힌다**(v2.525 규약).
     */
    const withThr = (Array.isArray(pools) ? pools : []).filter((p) => {
      const pt = posNum(p?.totalBytes); const pu = p?.usedBytes == null ? null : Number(p.usedBytes);
      const pth = posNum(p?.alertThresholdPct);
      return pt && pu != null && Number.isFinite(pu) && pth != null && pth <= 100;
    });
    if (withThr.length) {
      const avail = withThr.reduce(
        (a, p) => a + Math.max(0, Number(p.totalBytes) * (Number(p.alertThresholdPct) / 100) - Number(p.usedBytes)),
        0,
      );
      const missing = (Array.isArray(pools) ? pools.length : 0) - withThr.length;
      bases.push({
        key: 'alert', label: '경고 임계까지(풀별 합)',
        availBytes: avail,
        note: '풀마다 **자기 경고 임계**까지의 여유를 계산해 더한 값입니다(대표 임계를 만들지 않습니다).'
          + (missing > 0 ? ` ⚠ 임계 또는 사용량을 읽지 못한 풀 ${missing}개는 **빠졌습니다**.` : '')
          + ' ⚠ 이 합은 **한 덩어리로 쓸 수 있는 공간이 아닙니다** — 풀 경계를 넘지 못합니다.',
      });
    }
  }
  if (sub != null) {
    // 구독이 전부 채워졌을 때의 여유 — 오버프로비저닝이면 음수가 될 수 있고, 그것은 사실이다.
    bases.push({
      key: 'subscription', label: '구독분이 다 채워질 때',
      availBytes: t - Math.max(sub, u),
      note: sub > t
        ? '⚠ **구독이 전체 용량을 넘습니다(오버프로비저닝)** — 호스트가 약속받은 만큼 다 쓰면 공간이 부족해집니다. 오버프로비저닝 자체는 정상 운영일 수 있으나, 추가 할당 전에 확인이 필요합니다.'
        : '이미 호스트에 약속한 구독분이 전부 실제로 채워진다고 보았을 때 남는 공간입니다. **가장 보수적인 기준**입니다.',
    });
  }
  const valid = bases.filter((b) => Number.isFinite(b.availBytes));
  if (!valid.length) return null;
  const limiting = valid.reduce((a, b) => (b.availBytes < a.availBytes ? b : a));
  return { bases: valid, limiting, totalBytes: t, usedBytes: u };
}

/**
 * 풀별 압박도 — **전체는 여유가 있는데 특정 풀만 꽉 찬** 상황을 드러낸다(v2.546, 사용자 제안:
 * "전체 용량은 정상인데 pool 의 사용량이 많으면 … 어떤 pool 사용량이 많다고 표시해준다").
 *
 * ⚠ **대표 임계를 만들지 않는다** — 풀마다 자기 `Alert threshold` 로 판정한다. `parsePools` 가
 *   이미 풀별로 그 값을 갖고 있는데(`uemcliParse.js`) v2.545 까지 다중 풀에서 통째로 버려졌다.
 * ⚠ **`unknown` 을 `ok` 로 흡수하지 않는다**(v2.519·v2.523·v2.534 규약) — 임계나 사용량을
 *   못 읽은 풀은 '정상' 이 아니라 '판정 불가' 다.
 * ⚠ `near` 는 임계 자체가 아니라 **임계의 90% 지점**이다(임계 70% → 63% 부터 주의).
 *   임계를 '거의 찬 것' 으로 바꿔 부르지 않기 위해 경계를 문구로 밝힌다.
 * @returns {Array<{name,pct,thresholdPct,availToThresholdBytes,state:'over'|'near'|'ok'|'unknown'}>}
 */
export function poolPressure(pools) {
  return (Array.isArray(pools) ? pools : []).map((p, i) => {
    const name = String(p?.name || p?.id || `풀 ${i + 1}`);
    const t = posNum(p?.totalBytes);
    const u = p?.usedBytes == null ? null : Number(p.usedBytes);
    const thr = posNum(p?.alertThresholdPct);
    if (!t || u == null || !Number.isFinite(u)) {
      return { name, pct: null, thresholdPct: thr, availToThresholdBytes: null, state: 'unknown' };
    }
    const pct = Math.round((u / t) * 1000) / 10;
    if (thr == null || thr > 100) {
      return { name, pct, thresholdPct: null, availToThresholdBytes: null, state: 'unknown' };
    }
    const avail = t * (thr / 100) - u;
    const state = pct >= thr ? 'over' : (pct >= thr * 0.9 ? 'near' : 'ok');
    return { name, pct, thresholdPct: thr, availToThresholdBytes: avail, state };
  });
}

/**
 * 풀별 압박 요약 문구 — **전체와 풀이 어긋날 때만** 만든다(`null` 이면 화면이 아무것도 안 그린다).
 * 항상 띄우면 같은 말이 화면을 덮는다(v2.509 규약).
 * @returns {null | {kind:'over'|'near'|'unknown-only', text:string}}
 */
export function poolPressureNote(rows, overallPct) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length < 2) return null;                       // 풀 1개는 전체 = 그 풀이다
  const over = list.filter((r) => r.state === 'over');
  const near = list.filter((r) => r.state === 'near');
  const unknown = list.filter((r) => r.state === 'unknown');
  const nameList = (xs) => xs.map((r) => `**${r.name}**(${r.pct}% · 임계 ${r.thresholdPct}%)`).join(' · ');
  const all = overallPct == null ? '' : `전체는 ${overallPct}% 이지만 `;
  const tail = unknown.length ? ` (판정하지 못한 풀 ${unknown.length}개는 세지 않았습니다)` : '';
  if (over.length) {
    const ok = list.filter((r) => r.state === 'ok').map((r) => r.name);
    return { kind: 'over',
      text: `${all}${nameList(over)} 가 **경고 임계를 넘었습니다**.`
        + (ok.length ? ` 추가 할당은 ${ok.map((n) => `**${n}**`).join(' · ')} 에만 여유가 있습니다.` : '')
        + tail };
  }
  if (near.length) {
    return { kind: 'near', text: `${all}${nameList(near)} 가 **임계에 근접**했습니다(임계의 90% 이상).${tail}` };
  }
  if (unknown.length === list.length) {
    return { kind: 'unknown-only',
      text: `풀 ${list.length}개 모두 **임계 또는 사용량을 읽지 못해 판정하지 못했습니다** — '이상 없음' 이라는 뜻이 아닙니다.` };
  }
  return null;
}

/**
 * ③ 수용 개수 — 단위 크기 `unitBytes` 짜리를 몇 개 더 만들 수 있나.
 * @returns {null | {count:number, basisKey:string, basisLabel:string, availBytes:number, leftoverBytes:number}}
 */
export function fitCount(head, unitBytes) {
  const unit = posNum(unitBytes);
  if (!head || !head.limiting || !unit) return null;
  const avail = Math.max(0, head.limiting.availBytes);
  const count = Math.floor(avail / unit);
  return {
    count,
    basisKey: head.limiting.key,
    basisLabel: head.limiting.label,
    availBytes: avail,
    leftoverBytes: avail - count * unit,
  };
}

/**
 * ③-b **풀 경계를 지키는 수용 개수**(v2.546).
 *
 * ⚠⚠ **공간은 풀 사이에서 더할 수 없다.** `fitCount` 는 합산 여유를 한 덩어리처럼 나눈다 —
 *   풀 A 79.6 TB · 풀 B 39.8 TB 면 합은 119.5 TB 지만 **80 TB 짜리는 어느 풀에도 안 들어간다**.
 *   단위가 작으면 근사적으로 맞지만 크면 **오류 없이 틀린 답**이 된다(v2.530 규약).
 *
 * 그래서 **풀마다 세어 더하고**(`Σ floor`), **한 개짜리 최대 크기**(`maxSingleBytes`)를 함께 낸다.
 * ⚠ 이것도 '딱 맞게 나눠 담을 수 있을 때' 의 **최대치**다 — 실제 배치 정책은 알 수 없으므로
 *   화면이 '최대 이만큼' 이라고 적는다(지어내지 않는다).
 * ⚠ 풀별 여유는 `basisKey` 에 맞춰 계산한다 — 목록 기준과 다른 기준으로 세면 두 숫자가 어긋난다.
 *   임계 기준인데 그 풀의 임계를 모르면 **그 풀은 빼고 개수를 밝힌다**(v2.525 규약).
 * @returns {null | {count:number, basisKey:string, basisLabel:string,
 *                   byPool:Array<{name:string,count:number,availBytes:number}>,
 *                   maxSingleBytes:number, maxSinglePool:string|null,
 *                   fitsSingle:boolean, skippedPools:number}}
 */
export function fitCountByPool(head, pools, unitBytes) {
  const unit = posNum(unitBytes);
  const list = Array.isArray(pools) ? pools : [];
  if (!head || !head.limiting || !unit || !list.length) return null;
  const key = head.limiting.key;
  const byPool = [];
  let skipped = 0;
  for (const [i, p] of list.entries()) {
    const t = posNum(p?.totalBytes);
    const u = p?.usedBytes == null ? null : Number(p.usedBytes);
    if (!t || u == null || !Number.isFinite(u)) { skipped += 1; continue; }
    const free = posNum(p?.freeBytes) ?? Math.max(0, t - u);
    const sub = posNum(p?.subscribedBytes);
    const thr = posNum(p?.alertThresholdPct);
    let avail = null;
    if (key === 'physical') avail = free;
    else if (key === 'alert') avail = (thr != null && thr <= 100) ? t * (thr / 100) - u : null;
    else if (key === 'subscription') avail = sub != null ? t - Math.max(sub, u) : null;
    if (avail == null || !Number.isFinite(avail)) { skipped += 1; continue; }
    avail = Math.max(0, avail);
    byPool.push({ name: String(p?.name || p?.id || `풀 ${i + 1}`), count: Math.floor(avail / unit), availBytes: avail });
  }
  if (!byPool.length) return null;
  const count = byPool.reduce((a, b) => a + b.count, 0);
  const best = byPool.reduce((a, b) => (b.availBytes > a.availBytes ? b : a));
  return {
    count,
    basisKey: key,
    basisLabel: head.limiting.label,
    byPool,
    maxSingleBytes: best.availBytes,
    maxSinglePool: best.name,
    fitsSingle: best.availBytes >= unit,
    skippedPools: skipped,
  };
}

/**
 * 추이 점들에서 **하루 증가량**(최소제곱 기울기). 상세 모달이 이미 불러온 차트 데이터를 그대로 쓴다
 * (새 API 왕복 없음 — CLAUDE.md '폴링 금지·왕복 최소' 계열).
 *
 * ⚠ 표본이 적거나 기간이 짧으면 **추세라고 말하지 않는다**. 2점짜리 직선으로 수년을 외삽하는 것이
 *   이 기능이 만들 수 있는 최악의 거짓이다(v2.531 '소진 예상은 근거 기간을 함께 낸다' 와 같은 규약).
 * @param {Array<{ts:number, used_bytes:number}>} points
 * @returns {null | {perDayBytes:number, samples:number, spanDays:number, r2:number|null, weak:boolean, reason:string|null}}
 */
export function trendPerDay(points, { minSamples = 3, minSpanDays = 2 } = {}) {
  const pts = (points || [])
    .filter((p) => p && p.ts != null && p.used_bytes != null)
    .map((p) => ({ t: Number(p.ts), y: Number(p.used_bytes) }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.y) && p.y > 0)
    .sort((a, b) => a.t - b.t);
  if (pts.length < 2) return null;
  const spanDays = (pts[pts.length - 1].t - pts[0].t) / DAY_MS;
  if (!(spanDays > 0)) return null;
  // 최소제곱(x = 일 단위)
  const n = pts.length;
  const t0 = pts[0].t;
  const xs = pts.map((p) => (p.t - t0) / DAY_MS);
  const ys = pts.map((p) => p.y);
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0; let sxx = 0; let syy = 0;
  for (let i = 0; i < n; i += 1) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  if (!(sxx > 0)) return null;
  const slope = sxy / sxx;
  const r2 = syy > 0 ? Math.max(0, Math.min(1, (sxy * sxy) / (sxx * syy))) : null;
  const weak = n < minSamples || spanDays < minSpanDays;
  return {
    perDayBytes: slope,
    samples: n,
    spanDays: Math.round(spanDays * 10) / 10,
    r2: r2 == null ? null : Math.round(r2 * 100) / 100,
    weak,
    reason: weak
      ? `관측 ${n}점 · ${Math.round(spanDays * 10) / 10}일 — 추세를 말하기에는 부족합니다(최소 ${minSamples}점 · ${minSpanDays}일).`
      : null,
  };
}

/**
 * ② 소진 예상 — 경고 임계선과 100% 에 각각 언제 닿나.
 * ⚠ **증가 중일 때만** 낸다(감소·평탄이면 null + 사유). 근거 기간을 함께 낸다.
 * @returns {null | {perDayBytes, toAlert:{days,at}|null, toFull:{days,at}|null, basis:string, weak:boolean, reason:string|null}}
 */
export function runway({ totalBytes, usedBytes, alertThresholdPct, trend, now = Date.now() } = {}) {
  const t = posNum(totalBytes);
  const u = usedBytes == null ? null : Number(usedBytes);
  if (!t || u == null || !Number.isFinite(u)) return null;
  if (!trend) return { perDayBytes: null, toAlert: null, toFull: null, basis: null, weak: true, reason: '용량 추이 표본이 없어 증가 속도를 알 수 없습니다.' };
  const per = trend.perDayBytes;
  const basis = `최근 ${trend.spanDays}일 · 관측 ${trend.samples}점${trend.r2 != null ? ` · 적합도 R²=${trend.r2}` : ''}`;
  if (!Number.isFinite(per) || per <= 0) {
    return {
      perDayBytes: per, toAlert: null, toFull: null, basis, weak: true,
      reason: per < 0 ? '사용량이 줄고 있어 소진 시점을 내지 않습니다(추세가 유지된다면 차지 않습니다).' : '사용량이 사실상 늘지 않아 소진 시점을 내지 않습니다.',
    };
  }
  const to = (targetBytes) => {
    const gap = targetBytes - u;
    if (!(gap > 0)) return { days: 0, at: now, passed: true };
    const days = gap / per;
    return { days: Math.round(days * 10) / 10, at: now + days * DAY_MS, passed: false };
  };
  const thr = posNum(alertThresholdPct);
  return {
    perDayBytes: per,
    toAlert: thr != null && thr > 0 && thr <= 100 ? { ...to(t * (thr / 100)), thresholdPct: thr } : null,
    toFull: to(t),
    basis,
    weak: !!trend.weak,
    reason: trend.weak ? trend.reason : null,
  };
}

/**
 * 스냅샷 하나 → 산정 입력. Unity SSH 수집기가 싣는 필드에서 뽑는다(없으면 null — 지어내지 않는다).
 * 풀이 여러 개면 합계를 쓰되, 임계값·RAID 는 **풀마다 다를 수 있으므로** 단일 풀일 때만 쓴다.
 */
export function planInput(snap) {
  if (!snap) return null;
  const cap = snap.capacity || {};
  const pools = Array.isArray(snap.pools) ? snap.pools : [];
  const ex = snap.extra || {};
  const single = pools.length === 1 ? pools[0] : null;
  /*
   * ⚠ **합산 대상은 서버가 정한다**(v2.546) — `capacityCounted`(`unitySsh.buildSnapshot`)가
   *   전체·사용량을 **둘 다** 읽은 풀에만 붙는다. 그 전에는 `sumFree` 가 **모든 풀**을 더하고
   *   `snap.capacity.usedBytes` 는 읽을 수 있는 풀만 더해, 한 풀을 못 읽으면 `verifyIdentity`
   *   가 깨졌다(2풀 재현 실측 차이 58,770,998,108,160B). 판정을 여기서 다시 하지 않는 것은
   *   v2.517 규약('판정은 서버 순수 모듈 하나')이다.
   * ⚠ 구버전 엣지는 이 필드를 보내지 않는다 — 그때는 **전부 포함**해 예전과 같이 동작한다
   *   (필드가 없다고 0개로 접으면 멀쩡한 장비의 산정이 통째로 사라진다).
   */
  const hasFlag = pools.some((p) => p && p.capacityCounted != null);
  const counted = hasFlag ? pools.filter((p) => p.capacityCounted) : pools;
  const sumFree = counted.reduce((a, p) => a + (posNum(p.freeBytes) || 0), 0);
  /*
   * ⚠ v2.542 — 구독·선할당은 **풀 속성**이라 풀에서 합산한다(이 함수가 임계·RAID 를 이미
   *   그렇게 다룬다). 예전에는 `extra.subscribedBytes`·`extra.preallocatedBytes` 만 봤는데,
   *   그것은 v2.540 의 옛 수집기가 **단일 풀 값을 extra 로 올려 준** 것에 기댄 것이었다.
   *   v2.542 에 수집기를 재작성해 그 hoist 가 없어지자 '구독분이 다 채워질 때' 기준이 통째로
   *   사라지고(기준 3개 → 2개) 항등식이 선할당분만큼 어긋났다. 두 값은 **더할 수 있는 양**이라
   *   여러 풀에서도 합이 뜻을 갖는다(퍼센트인 `alertThresholdPct` 와 다른 점이다).
   *   `extra` 폴백은 남겨 둔다 — REST(API) 수집 경로가 그 모양으로 줄 수 있다.
   */
  const sumOf = (k) => {
    const vals = counted.map((p) => posNum(p[k])).filter((v) => v != null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  };
  return {
    totalBytes: posNum(cap.totalBytes),
    usedBytes: cap.usedBytes == null ? null : Number(cap.usedBytes),
    freeBytes: sumFree > 0 ? sumFree : null,
    preallocatedBytes: sumOf('preallocatedBytes') ?? posNum(ex.preallocatedBytes),
    subscribedBytes: sumOf('subscribedBytes') ?? posNum(ex.subscribedBytes),
    // 임계·RAID·드라이브는 풀 속성이다 — 풀이 여러 개면 대표값을 만들지 않는다(거짓이 된다).
    alertThresholdPct: single ? posNum(single.alertThresholdPct) : null,
    drives: single ? single.drives || null : null,
    raid: single ? single.raid || null : null,
    stripeLength: single ? single.stripeLength || null : null,
    poolCount: pools.length,
    countedPoolCount: counted.length,
    // 합계에서 빠진 풀 수 — 화면이 '전체를 다 더한 값' 이라고 말하지 않게 한다.
    excludedPoolCount: pools.length - counted.length,
    multiPool: pools.length > 1,
    pools: counted,
  };
}

/**
 * TB 표기(TiB 기준 — 장비 표기와 같게).
 * ⚠ `v == null` 을 **먼저** 본다 — `Number(null) === 0` 이라 결측이 `0.0 TB` 로 둔갑한다
 *   (v2.525 규약. 이 모듈의 자체 테스트가 초판에서 실제로 이 결함을 잡았다).
 */
export function tb(bytes, digits = 1) {
  if (bytes == null || bytes === '') return '—';
  const n = Number(bytes);
  if (!Number.isFinite(n)) return '—';
  return `${(n / TIB).toFixed(digits)} TB`;
}

/**
 * 크기 표기 — **단위를 자동으로 고른다**(v2.540 Chromium 판독으로 고친 결함).
 * `tb()` 만 쓰면 200GB 가 `0.20 TB` 로 나와 사람이 읽기 어렵다. 1TiB 미만은 GB 로 쓴다.
 * ⚠ 용량 **비교 표**(전체·잔여·구독)에서는 단위가 섞이면 크기 비교가 어려우므로 `tb()` 를 그대로 쓴다 —
 *   단위 자동 선택은 '단위 크기'·'남는 공간' 처럼 **하나만 읽는 값**에만 쓴다.
 */
export function sizeText(bytes) {
  if (bytes == null || bytes === '') return '—';
  const n = Number(bytes);
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= TIB) return `${(n / TIB).toFixed(abs >= 10 * TIB ? 1 : 2)} TB`;
  if (abs >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(abs >= 10 * 1024 ** 3 ? 0 : 1)} GB`;
  if (abs >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MB`;
  return `${n} B`;
}

/**
 * 일수 → 사람 말('3.5일' · '2.1개월' · '1.4년'). 아주 큰 값은 '10년 이상'.
 * ⚠ `tb()` 와 같은 이유로 `== null` 을 먼저 본다(결측이 '0.0일' 로 둔갑하지 않게).
 */
export function daysText(days) {
  if (days == null || days === '') return '—';
  const n = Number(days);
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n >= 3650) return '10년 이상';
  if (n >= 365) return `${(n / 365).toFixed(1)}년`;
  if (n >= 60) return `${(n / 30.44).toFixed(1)}개월`;
  return `${n.toFixed(n < 10 ? 1 : 0)}일`;
}

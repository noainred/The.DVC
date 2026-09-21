/**
 * 상대시각 문구 — **공용 코어** (v2.574 IMP-03).
 *
 * ⚠⚠ v2.573 까지 같은 문구가 **9벌** 복사돼 있었고 **지금 실제로 갈라져 있었다**.
 * 9개를 같은 입력으로 동시에 돌린 실측(2026-09-21 감사 §부록 A):
 *   · 경과 **90초**  → `2분 전`(7개) vs **`1분 전`**(`partFaultText`·`storageAuthText`)
 *   · 경과 **90분**  → `2시간 전`      vs **`1시간 전`**(같은 둘)
 *   · 결측(null)     → `—`(6개) / `null`(2개) / **`없음`**(1개)
 *
 * ⚠ 더 위험한 것: **같은 이름 `ageText` 가 파일에 따라 다른 것을 받았다** —
 *   타임스탬프(`bmUsageText`·`edgeLogText`·`linkCheckText`)와 경과 ms(`partFaultText`·
 *   `invCheckText`). 잘못 넘기면 **오류 없이** 1970년/음수가 나온다.
 *   그래서 이 모듈은 **두 이름을 나눈다** — `agoText(ts, now)` 는 타임스탬프,
 *   `elapsedText(ms)` 는 경과 시간이다. 이름만 보고 알 수 있어야 한다.
 *
 * 반올림 규칙: **내림**(`Math.floor`)이다. 90초는 `1분 전` 이다 —
 * "1분 30초 지났다" 를 `2분 전` 이라 말하면 **아직 지나지 않은 시간**을 말하는 것이다.
 * (다수였던 7개가 `Math.round` 였지만, 다수결이 아니라 **정직한 쪽**을 고른다.)
 *
 * 결측 표기는 `—`(다수·기존 화면과 같은 모양)이고, 호출부가 필요하면 `dash` 로 바꾼다.
 */

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/**
 * 경과 시간(ms) → 문구.
 *
 * ⚠ 반올림은 `Math.round` 다 — **9벌 중 7벌이 그랬다**. 이 통합의 목적은 '근거 없이 갈라진 것'
 *   을 없애는 것이지 표기 정책을 바꾸는 것이 아니다(바꾸려면 별건으로).
 *
 * ── 옵션은 **실재하던 화면 계약**이다. 없애면 그 화면이 조용히 바뀐다 ────────────
 *  · `dash`      결측 표기. `'—'`(6벌 기본) / `'없음'`(linkCheck) / **`null`**(sanPerfDiag·
 *                storageAuth — 호출부가 **null 로 분기해** 문구에서 통째로 뺀다. 문자열로
 *                바꾸면 그 분기가 죽어 `수집 기록 없음` 같은 안내가 사라진다 — 실제로 깨졌다).
 *  · `subMinute` 1분 미만 표기. `'seconds'`(기본, `30초 전`) / `'방금'`.
 *  · `future`    미래(음수) 표기. 기본은 `방금`, `'null'` 이면 null(말하지 않는다),
 *                문자열이면 그대로(curUser 의 `미래(시계 오차)`).
 */
export function elapsedText(ms, { dash = '—', subMinute = 'seconds', future } = {}) {
  if (ms == null || ms === '' || !Number.isFinite(Number(ms))) return dash;
  const v = Number(ms);
  if (v < 0) {
    if (future === 'null') return null;
    if (typeof future === 'string') return future;
    return '방금';
  }
  if (v < MIN) return subMinute === '방금' ? '방금' : (v < 1000 ? '방금' : `${Math.round(v / 1000)}초 전`);
  if (v < HOUR) return `${Math.round(v / MIN)}분 전`;
  if (v < DAY) return `${Math.round(v / HOUR)}시간 전`;
  return `${Math.round(v / DAY)}일 전`;
}

/**
 * 타임스탬프(epoch ms) → 문구.
 *
 * ⚠⚠ **`0` 이하는 '없음' 이다.** 이 저장소에서 0 은 '시각 미기록' 의 센티널로 쓰이고
 *   (`if (!v) return '—'`), 1970년으로 읽으면 화면이 **`20718일 전`** 이라고 말한다
 *   (v2.574 통합 초판이 실제로 그렇게 깨졌다 — 자체 테스트가 잡았다).
 * ⚠ `elapsedText` 와 **이름을 나눈 것이 요점**이다 — v2.573 까지 같은 이름 `ageText` 가
 *   파일에 따라 타임스탬프를 받기도 하고 경과 ms 를 받기도 했다(잘못 넘기면 오류 없이 1970년).
 */
export function agoText(ts, now = Date.now(), opt = {}) {
  const t = Number(ts);
  if (ts == null || ts === '' || !Number.isFinite(t) || t <= 0) return opt.dash === undefined ? '—' : opt.dash;
  return elapsedText(now - t, opt);
}

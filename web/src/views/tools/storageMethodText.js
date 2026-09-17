/**
 * views/tools/storageMethodText.js — 스토리지 '수집 방식' 표시 판정·문구(순수, v2.542).
 *
 * ── 왜 이 모듈이 생겼나 (사용자 신고 2026-09-17, `OC2-unity-01`) ──────────────────
 * "API 방식을 SSH 로 수정하고 저장했는데, 페이지에는 계속 API 라고 되어 있고 새로고침 해도
 * 갱신이 안 된다." 저장은 **정상**이었다(수정 폼을 다시 열면 `SSH (uemcli)` 로 선택돼 있다).
 * 원인은 표의 배지가 `s.extra.collectMethod`(**마지막 수집 스냅샷이 실제로 쓴 방식**)를
 * 등록값 `r.collectMethod` 보다 우선했기 때문이다 — 엣지가 설정을 다시 받아 수집해 push 할
 * 때까지 화면은 옛 방식을 보여 주고, 새로고침은 같은 스냅샷을 다시 받아오므로 바뀌지 않는다.
 *
 * ⚠ **이것은 v2.515 와 같은 유형의 세 번째 재발이다.** 장비 이름 열이 똑같은 이유로
 * "수정하는데 수정사항이 반영되지 않는다" 신고를 받아 v2.530 에 **둘 다 보여주는** 방식으로
 * 고쳤다(장비가 보고한 이름 + `등록명 …` 둘째 줄). 방식 열은 그때 함께 고치지 않았다.
 * 사용자 선택(2026-09-17)도 같은 방식이다 — **한쪽을 고르지 말고 둘을 나란히** 낸다.
 *
 * ── 지킬 것 ────────────────────────────────────────────────────────────────────
 *  - **주 배지는 등록값**이다(= 다음 수집이 쓸 방식). 사용자가 방금 고친 값이 즉시 보여야
 *    '저장이 안 됐나' 를 의심하지 않는다.
 *  - **마지막 수집이 다른 방식이었으면 그 사실을 숨기지 않는다**(`pending`). 등록값만 보여
 *    주면 이번에는 반대 방향의 거짓이 된다 — 지금 쌓여 있는 데이터는 옛 방식으로 받은 것이다.
 *  - **주기 숫자를 문구에 박지 말 것**(CLAUDE.md 규약). '엣지가 설정을 받아 다시 수집한 뒤',
 *    '다음 수집 주기에' 처럼 말한다 — 주기는 중앙 설정으로 바뀌므로 박아 두면 문구가 거짓이 된다.
 *  - **수집된 적이 없는 장비를 '대기' 라고 하지 않는다** — 비교 대상이 없는 것이지 어긋난 것이
 *    아니다(v2.519·v2.523 의 '확인 못 한 것을 이상으로 세지 않는다' 와 같은 계열).
 *  - 등록값이 없는 옛 레코드에 'API' 를 쓰는 것은 **지어낸 값이 아니다** — 수집기가 실제로
 *    그렇게 돈다(`storage/collectors/unity.js:49,58` — `collectMethod === 'ssh'` 가 아니면 API).
 *    그 사실을 `registeredKnown:false` 로 밝혀 문구가 '기본값' 이라고 말하게 한다.
 */

/** 'ssh' 아니면 전부 'api' — 수집기의 실제 분기와 같은 기준(unity.js:58). */
export function methodOf(v) {
  return String(v || '').trim().toLowerCase() === 'ssh' ? 'ssh' : 'api';
}

/** 화면 라벨. */
export const METHOD_LABEL = Object.freeze({ ssh: 'SSH', api: 'API' });

/**
 * 수집 방식 배지 판정.
 * @param {object} o
 * @param {string} [o.registered] 등록값(`device.collectMethod`) — 다음 수집이 쓸 방식
 * @param {string} [o.lastUsed] 마지막 스냅샷이 쓴 방식(`snap.extra.collectMethod`)
 * @param {boolean} [o.hasSnap] 스냅샷이 있는가(없으면 비교 대상이 없다)
 * @param {string} [o.agent] 수집 주체(엣지 이름). 비면 중앙 직접 — 반영 경로가 다르다.
 * @returns {{method:'ssh'|'api', label:string, tone:'blue'|'gray',
 *            pending:null|{label:string, title:string}, title:string}}
 */
export function collectMethodView({ registered, lastUsed, hasSnap = false, agent = '' } = {}) {
  const reg = methodOf(registered);
  const registeredKnown = !!String(registered || '').trim();
  const used = hasSnap ? methodOf(lastUsed) : null;
  const mismatch = used != null && used !== reg;

  const base = registeredKnown
    ? `등록된 수집 방식: ${METHOD_LABEL[reg]} — 등록/수정에서 변경합니다.`
    : `수집 방식이 지정되지 않아 기본값 ${METHOD_LABEL[reg]} 로 동작합니다 — 수정에서 명시하세요.`;

  if (!hasSnap) {
    return {
      method: reg, label: METHOD_LABEL[reg], tone: reg === 'ssh' ? 'blue' : 'gray', pending: null,
      title: `${base} 아직 수집된 스냅샷이 없어 실제로 쓰인 방식은 확인되지 않았습니다.`,
    };
  }
  if (!mismatch) {
    return {
      method: reg, label: METHOD_LABEL[reg], tone: reg === 'ssh' ? 'blue' : 'gray', pending: null,
      title: `${base} 마지막 수집도 ${METHOD_LABEL[used]} 로 했습니다.`,
    };
  }
  // 어긋남 — 저장은 됐고 아직 그 방식으로 수집되지 않았다. 반영 경로는 수집 주체에 따라 다르다.
  const how = agent
    ? `엣지 '${agent}' 가 중앙 설정을 받아 다시 수집한 뒤 반영됩니다`
    : '다음 수집 주기에 반영됩니다';
  return {
    method: reg,
    label: METHOD_LABEL[reg],
    tone: reg === 'ssh' ? 'blue' : 'gray',
    pending: {
      label: `${METHOD_LABEL[used]} 수집분`,
      title: `저장은 ${METHOD_LABEL[reg]} 로 되어 있고, 화면에 보이는 값은 ${METHOD_LABEL[used]} 로 수집한 마지막 스냅샷입니다.`
        + ` ${how}. 지금 바로 보려면 '수집' 을 누르세요.`,
    },
    title: `${base} 마지막 수집은 ${METHOD_LABEL[used]} 로 했습니다 — ${how}.`,
  };
}

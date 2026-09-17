/**
 * views/tools/storageAuthText.js — 인증 실패(401) 안내 문구(v2.528, 순수 모듈).
 *
 * 사용자 신고(2026-09-16): PowerStore `PS-HG-2`(엣지 HG 위임) — `인증 실패(401) — 계정/비밀번호 확인`.
 * 장비 등록은 됐고 중앙에서 CSV 로 내보내면 비밀번호가 정상으로 보이는데도 엣지 수집이 401 이다.
 *
 * ── 이 문구가 갈라야 하는 것 ───────────────────────────────────────────────────
 * 엣지 위임 장비는 **중앙이 아니라 엣지가** 장비에 로그인한다. 401 이면 원인이 둘인데 조치가
 * 정반대다 — ⓐ 중앙→엣지 배포가 상했다(재배포·엣지 업그레이드) ⓑ 장비의 실제 비밀번호가
 * 다르다(장비 쪽 확인). 지금까지 화면은 둘 다 "계정/비밀번호 확인" 이라고만 말했다.
 * 그래서 **엣지가 실제로 쓴 자격증명 지문**을 보여 주고, 중앙 등록값과 대조하게 한다.
 *
 * ── 정직성 규칙 ────────────────────────────────────────────────────────────────
 * 1. **'지문이 같다 = 비밀번호가 같다' 라고 단정하지 않는다.** 해시는 16비트라 충돌이 흔하다 —
 *    다르면 확실히 다르고, 같으면 '같을 가능성이 높다' 다. 문구가 그대로 말한다.
 * 2. **원인을 특정하지 않는다**(v2.493 규약) — 후보를 나열하고 각각 무엇을 확인할지 적는다.
 * 3. **멈췄다는 사실을 반드시 말한다.** 조용히 멈추면 '수집되는 줄' 안다.
 * 4. 주기·상한 **숫자를 문구에 박지 않는다** — 서버가 준 값만 쓴다.
 */

/** 시각 → '3시간 전' 형태. 값이 없으면 null(지어내지 않는다). */
export function agoText(ts, now = Date.now()) {
  const t = Number(ts);
  if (!Number.isFinite(t) || t <= 0) return null;
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return '방금';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}

/** 자격증명 지문 한 줄 — 서버 `util/credFingerprint.js` 와 **같은 표기**를 쓴다(대조가 목적). */
export function credFpText(fp) {
  if (!fp) return null;
  // ⚠ **모양이 다른 값을 지문인 척 그리지 말 것**(v2.541 — Chromium 판독에서 발견).
  // 이 지문의 존재 이유는 '법인 간·중앙↔엣지 간 눈으로 대조' 다. 객체가 아니거나 길이·해시를
  // 읽지 못하는 값이 오면 예전에는 `계정 없음 · 비번 undefined자·#undefined` 라고 **그럴듯한
  // 한 줄을 지어냈다** — 옆줄의 진짜 지문과 나란히 놓이면 사용자가 그것을 값으로 읽고 대조한다.
  // 읽지 못하면 null 을 돌려 호출부가 '지문을 읽지 못했습니다' 로 다루게 한다(0 을 지어내지
  // 않는다는 규약과 같은 계열). 구버전 엣지가 다른 모양을 보내는 경우도 여기서 막힌다.
  if (typeof fp !== 'object' || Array.isArray(fp)) return null;
  const lenOk = Number.isFinite(Number(fp.len));
  if (!fp.empty && (!lenOk || !fp.hash)) return null;
  const user = fp.user ? `계정 '${fp.user}'${fp.userSpace ? '(⚠앞뒤공백)' : ''}` : '계정 없음';
  // 비밀번호가 비어 있는 것 자체가 진단이다 — 길이 0 을 숨기지 않는다.
  const pw = fp.empty ? '비번 **없음**(배포에 비밀번호가 실리지 않았습니다)' : `비번 ${fp.len}자·#${fp.hash}`;
  return `${user} · ${pw}${fp.space && !fp.empty ? ' · ⚠앞뒤공백' : ''}`;
}

/**
 * 인증 실패 패널 내용.
 * @param {object} snap  장비 스냅샷(`extra.authStopped`·`extra.credFp`·`extra.credFpSource`)
 * @param {object} row   목록 행(`agent` 로 엣지 위임 여부 판단)
 * @returns {null | {stopped:boolean, title:string, since:string|null, attempts:number,
 *                   fp:string|null, fpSource:string|null, delegated:boolean,
 *                   causes:string[], notes:string[]}}
 */
export function authFailInfo(snap, row = {}, now = Date.now()) {
  const ex = snap?.extra || {};
  const stop = ex.authStopped || null;
  const fp = ex.credFp || null;
  // 인증 실패 흔적이 전혀 없으면 패널을 만들지 않는다(다른 오류에 이 안내를 붙이지 않는다).
  if (!stop && !fp) return null;

  const agent = String(row.agent || '').trim();
  const delegated = !!agent;
  const fpSource = ex.credFpSource ? String(ex.credFpSource) : null;

  const causes = [];
  if (fp?.empty) {
    // 이 경우는 후보를 늘어놓을 필요가 없다 — 배포 자체가 비밀번호를 안 실어 왔다.
    causes.push('이 수집기에 **비밀번호가 비어 있습니다** — 장비 등록에서 비밀번호를 다시 입력하세요.');
  } else {
    if (delegated) {
      causes.push(`이 장비는 **엣지 '${agent}' 가 수집**합니다 — 위 지문은 **엣지가 실제로 쓴 값**입니다. 설정 › 스토리지 등록의 값과 계정·길이·해시가 **다르면** 중앙→엣지 배포가 아직 반영되지 않았거나 상한 것입니다(엣지 버전·설정 pull 확인).`);
      causes.push('**같다면** 배포는 온전하므로, 장비에 설정된 비밀번호 자체가 다를 가능성이 큽니다(장비 콘솔에서 확인).');
    } else {
      causes.push('중앙이 직접 수집하는 장비입니다 — 설정 › 스토리지 등록의 값과 위 지문을 대조하세요.');
    }
    if (fp?.space) causes.push('비밀번호 **앞뒤에 공백**이 있습니다 — 붙여넣기 사고일 수 있습니다(화면에서는 보이지 않습니다).');
    causes.push('장비가 **계정을 잠갔을** 수도 있습니다(반복 로그인 실패). 장비 콘솔에서 잠금 해제가 필요한지 확인하세요.');
  }

  const notes = [];
  if (stop) {
    notes.push('**계정 잠금을 막기 위해 이 장비의 주기 수집을 멈췄습니다.** 비밀번호를 고치면 자동으로 다시 시작합니다.');
    notes.push("지금 바로 확인하려면 **'새로고침(지금 수집)'** 을 누르세요 — 수동 실행은 막지 않습니다(1회만 시도).");
  }
  if (fp && !fp.empty) {
    // 규칙 1 — 단정 금지.
    notes.push('지문은 **되돌릴 수 없는 값**입니다(계정명·길이·짧은 해시). 다르면 확실히 다르고, 같으면 같을 **가능성이 높다**는 뜻입니다.');
  }

  return {
    stopped: !!stop,
    title: stop ? '인증 실패로 주기 수집을 멈췄습니다' : '인증 실패(401)',
    since: stop ? agoText(stop.since, now) : null,
    attempts: stop?.attempts || 0,
    fp: credFpText(fp),
    fpSource,
    delegated,
    causes,
    notes,
  };
}

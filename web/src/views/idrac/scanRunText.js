/**
 * views/idrac/scanRunText.js — '법인별 iDRAC 장비 스캔' 표의 **최근 결과** 문구(순수, v2.441).
 *
 * 사용자 요구: "최근 결과에 몇 개를 발견했다고 발견(xx대) 이렇게 코멘트 넣어줘, 성공/실패도 넣어줘".
 * 예전에는 위임 스캔이면 `위임(AZ) · 시각` 만 보여 주고 수치를 버렸다 — 위임은 던진 시점만
 * 기록되고 결과 회신이 이 엔트리에 반영되지 않았기 때문(v2.441 에서 반영 경로를 추가).
 *
 * 판정·문구를 여기에 모아 회귀로 고정한다(웹 테스트는 node 환경이라 컴포넌트 렌더 불가 — CLAUDE.md 규약).
 */

/** 소요 시간 표기(초/분). null 이면 ''. */
function dur(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '';
  return n < 60_000 ? `${Math.round(n / 1000)}초` : `${Math.round(n / 60_000)}분`;
}

/**
 * lastRun → 화면 표시용 구조(순수).
 * @returns {{state:'none'|'pending'|'ok'|'fail', badge:string, tone:'muted'|'amber'|'green'|'red',
 *            text:string, title:string, when:string}}
 */
export function describeScanRun(r, now = Date.now()) {
  if (!r) return { state: 'none', badge: '', tone: 'muted', text: '—', title: '아직 실행 기록이 없습니다.', when: '' };
  const when = r.at ? new Date(r.at).toLocaleString('ko-KR') : '';
  const who = r.agent ? `위임(${r.agent})` : '중앙';

  // ① 실패 — 사유를 그대로 보여준다(툴팁에 전문).
  if (r.error) {
    return {
      state: 'fail', badge: '실패', tone: 'red',
      text: `${String(r.error).slice(0, 70)}${String(r.error).length > 70 ? '…' : ''}`,
      title: `${who} · ${r.error}`, when,
    };
  }

  // ①-b v2.611(감사 EDGE2611-01): 위임 보류 — 담당 엣지가 iLO 스캔을 지원하는지 확인하지 못해 **보내지 않았다**. 실패가 아니라
  //   '보내지 않음' 이므로 빨강이 아니라 호박색 '보류' 이고, 사유(엣지 업그레이드)를 그대로 보여준다.
  if (r.held) {
    const why = String(r.heldReason || '위임 보류');
    return {
      state: 'held', badge: '보류', tone: 'amber',
      text: `${why.slice(0, 70)}${why.length > 70 ? '…' : ''}`,
      title: `${who} · ${why}`, when,
    };
  }

  // ② 위임했지만 결과가 아직 안 온 상태(pending) — '성공' 으로 오인하게 두지 않는다.
  //    pending 플래그가 없는 구버전 기록은 found 가 null 인 위임 건을 같게 취급한다.
  const isPending = r.pending === true || (r.delegated && r.found == null && r.ok !== true);
  if (isPending) {
    const waited = r.dispatchedAt ? Math.max(0, Math.round((now - r.dispatchedAt) / 1000)) : null;
    return {
      state: 'pending', badge: '대기', tone: 'amber',
      text: `${who} 요청함 · 결과 대기${waited != null ? ` ${waited >= 60 ? `${Math.round(waited / 60)}분` : `${waited}초`}째` : ''}`,
      title: `${who} 에 스캔을 요청했고 아직 결과가 오지 않았습니다.${r.dispatch === 'push' ? ' (중앙→엣지 직접 PUSH)' : ' (에이전트 폴링)'}`,
      when,
    };
  }

  // ③ 성공 — 사용자 요구 형식: '발견 N대'. 등록/스캔/무응답/인증실패는 뒤에 덧붙인다.
  // metrics 로도 함께 내보낸다 — 화면이 **등록 수량 숫자만 빨간색**으로 강조하기 위해서다
  // (v2.442, 사용자 요구). 문자열 text 는 툴팁·테스트·구버전 호환용으로 그대로 둔다.
  const found = Number(r.found) || 0;
  const metrics = [{ k: '발견', n: found, unit: '대' }];
  if (r.registered != null) metrics.push({ k: '등록', n: Number(r.registered) || 0, unit: '대', accent: 'red' });
  if (r.scanned != null) metrics.push({ k: '스캔', n: Number(r.scanned) || 0, unit: '개' });
  // v2.610(사용자 요청 '스캔하면 HPE 서버가 몇 대인지 리스트에'): 서비스 루트로 HPE 로 판별된 대수.
  //   iLO 계정이 없으면 등록은 되지 않지만 몇 대 있는지는 보인다. 구버전 엣지 회신은 미지원 목록으로 센 하한이라 '이상' 을 붙인다.
  const hpe = hpeInfo(r);
  if (hpe) metrics.push({ k: 'HPE', n: hpe.n, unit: hpe.approx ? '대 이상' : '대', accent: 'blue' });
  const parts = metrics.map((m) => `${m.k} ${m.n}${m.unit}`);
  const extra = [];
  if (r.unreachable) extra.push(`무응답 ${r.unreachable}`);
  if (r.authFailed) extra.push(`인증실패 ${r.authFailed}`);
  // v2.537: 차단 대역(루프백·링크로컬)이라 찌르지 않은 IP — 빼 놓고 말하지 않으면 '전부 스캔' 으로 읽힌다.
  if (r.blocked) extra.push(`차단대역 제외 ${r.blocked}`);
  // v2.591(감사 F3): 주기 스캔이 인증 실패 정지로 시도하지 않은 IP — 같은 이유로 개수를 말한다.
  if (r.authSkipped) extra.push(`인증정지 건너뜀 ${r.authSkipped}`);
  // v2.611(감사 RECENT2611-04): 그 벤더의 계정이 없어 **로그인하지 않은** 서버(예: iLO 전용 대역의 Dell). 인증 실패와 다르다.
  if (Number(r.noCreds) > 0) extra.push(`계정 없어 시도 안 함 ${Math.floor(Number(r.noCreds))}`);
  if (hpe && hpe.note) extra.push(hpe.note);
  if (r.iloNote) extra.push(String(r.iloNote));
  if (r.modeDowngraded) extra.push(`법인 교체 대신 병합${r.modeDowngradedReason ? `(${r.modeDowngradedReason})` : ''}`);
  const d = dur(r.durationMs);
  // v2.591(감사 C5): 발견 0대인데 인증 실패가 있으면 '성공' 이 아니라 '확인 필요' 다 — 예전에는 중앙 직접
  //   스캔이 authFailed 를 싣지 않아 비밀번호가 틀려도 '성공 · 발견 0대' 로 보였다(빈 대역과 구분 불가).
  const authOnly = found === 0 && (Number(r.authFailed) > 0 || Number(r.authSkipped) > 0);
  return {
    state: 'ok', badge: authOnly ? '확인 필요' : '성공', tone: found > 0 ? 'green' : (authOnly ? 'amber' : 'muted'),
    metrics, extra,
    text: `${parts.join(' · ')}${extra.length ? ` (${extra.join(' · ')})` : ''}`,
    title: `${who}${d ? ` · 소요 ${d}` : ''}${extra.length ? ` · ${extra.join(' · ')}` : ''}`,
    when,
  };
}

/**
 * '최근 전체/주기 스캔' 한 줄 요약(순수, v2.591 — 감사 C3).
 *
 * 서버 `idrac/scanPoller.js lastRun` 의 개수 키는 **`datacenters`** 다(스캔 대역 항목 수 — 법인·서비스 단위).
 * 화면이 예전 주석을 믿고 `vcenters` 만 읽어 이 요약이 **항상 빠졌다**. 두 키를 다 읽고(구·신 서버 호환)
 * 단위도 'vCenter' 가 아니라 '대역' 으로 말한다(대역은 vCenter 에 매이지 않는다).
 * @returns {string} 요약이 없으면 ''
 */
export function scanLastRunSummary(lr) {
  if (!lr) return '';
  const n = lr.datacenters ?? lr.vcenters;
  if (n == null) return '';
  const parts = [`대역 ${n}개`, `발견 ${lr.found ?? 0}`, `등록 ${lr.registered ?? 0}`];
  if (lr.delegated) parts.push(`위임 ${lr.delegated}`);
  if (lr.authSkipped) parts.push(`인증정지 건너뜀 ${lr.authSkipped}`);
  if (lr.noCreds) parts.push(`계정 없어 시도 안 함 ${lr.noCreds}`);   // v2.611
  if (lr.held) parts.push(`위임 보류 ${lr.held}`);                     // v2.611 — 엣지 버전 게이트
  return parts.join(' · ');
}

/**
 * v2.610: lastRun 의 HPE 수치 → 표시 정보. HPE 가 없고 iLO 계정도 없으면 null(칸을 늘리지 않는다).
 * @returns {null | { n:number, approx:boolean, found:number, note:string }}
 */
export function hpeInfo(r) {
  if (!r) return null;
  const n = Number(r.hpeDetected);
  const det = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  const found = Number(r.hpeFound) > 0 ? Math.floor(Number(r.hpeFound)) : 0;
  if (!det && !found && !r.iloEnabled && !r.iloIgnoredByEdge) return null;
  // v2.611(감사 EDGE2611-02): iLO 계정을 보냈는데 구버전 엣지가 무시했다(iloIgnoredByEdge) — 원인은 '계정 없음' 이 아니라 엣지 버전이다.
  if (r.iloIgnoredByEdge) {
    return { n: Math.max(det, found), approx: r.hpeDetectedApprox === true, found, note: `HPE ${det ? `${det}대 ` : ''}미등록 — 엣지가 iLO 스캔을 지원하지 않음(엣지 업그레이드 필요, 2.610 이상)` };
  }
  let note = '';
  if (det && !r.iloEnabled) note = `HPE ${det}대는 iLO 계정이 없어 등록하지 않음`;
  else if (r.iloEnabled && det > found) note = `HPE 중 iLO 로그인 ${found}대 · 실패·미확인 ${det - found}대`;
  else if (r.iloEnabled && found) note = `HPE ${found}대 iLO 계정으로 발견`;
  return { n: Math.max(det, found), approx: r.hpeDetectedApprox === true, found, note };
}

/**
 * v2.611(감사 RECENT2611-02): 스캔 대역 저장 뒤 비밀번호가 폐기됐을 때 '무엇이 보류되고 무엇이 계속되는가'(순수).
 *   예전 문구는 무조건 '스캔은 비밀번호를 입력할 때까지 보류됩니다' 였는데, iLO 계정이 남아 있으면 그 대역은 HPE 스캔을 계속한다.
 *   서버 `idrac/scanRanges.js scanHoldText` 와 같은 판정이다. r = PUT 응답(redact 모양: hasPassword·username·iloUsername·iloHasPassword).
 */
export function scanHoldNote(r) {
  const dell = Boolean(r && String(r.username || '').trim() && r.hasPassword);
  const ilo = Boolean(r && String(r.iloUsername || '').trim() && r.iloHasPassword);
  if (dell && ilo) return '입력 전에도 두 계정으로 스캔은 계속됩니다.';
  if (ilo) return 'Dell(iDRAC) 스캔은 비밀번호를 입력할 때까지 보류됩니다 — HPE(iLO) 스캔은 계속됩니다.';
  if (dell) return 'HPE(iLO) 스캔은 iLO 비밀번호를 입력할 때까지 보류됩니다 — Dell(iDRAC) 스캔은 계속됩니다.';
  return '스캔은 비밀번호를 입력할 때까지 보류됩니다.';
}

/**
 * v2.611(감사 WEB2611-01): 스캔 대역 폼의 계정 상태(순수). HPE(iLO) 전용 대역에서 Dell 비밀번호가 없는 것은 **정상**이다 —
 *   예전에는 iDRAC 비밀번호에 필수(*) 표시를 달고 저장 후 '⚠ 비밀번호 미설정' 경고를 띄웠다(거짓 경고).
 *   f = 폼 상태 { username, password, hasPassword, iloUsername, iloPassword, iloHasPassword }.
 * @returns {{ dellReady:boolean, iloReady:boolean, dellPasswordRequired:boolean, warnNoPassword:boolean }}
 *   dellPasswordRequired — iDRAC 비밀번호 칸의 '*' 표시(쓸 수 있는 iLO 계정이 있으면 필수가 아니다).
 *   warnNoPassword       — 저장 뒤 '비밀번호 미설정' 경고(쓸 수 있는 계정이 하나도 없을 때만).
 */
export function scanFormCredsState(f) {
  const pwIn = (v) => typeof v === 'string' && v !== '';   // trim 금지 — 공백 비밀번호도 입력이다(기존 규약)
  const dellUser = Boolean(String(f?.username || '').trim());
  const iloUser = Boolean(String(f?.iloUsername || '').trim());
  const dellReady = dellUser && (Boolean(f?.hasPassword) || pwIn(f?.password));
  const iloReady = iloUser && (Boolean(f?.iloHasPassword) || pwIn(f?.iloPassword));
  return {
    dellReady, iloReady,
    dellPasswordRequired: !f?.hasPassword && !iloReady,
    warnNoPassword: !dellReady && !iloReady,
  };
}

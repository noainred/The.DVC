/**
 * views/tools/tokenCheckText.js — '포탈 점검 › 토큰 점검' 의 **문구**(순수, v2.560).
 *
 * 서버(`portalcheck/tokenFindings.js`)는 `code` + 근거만 준다. 문장은 여기 하나가 만든다
 * (v2.553 `settingsCheckText.js` 와 같은 관례). 웹 테스트가 node 환경이라 문구는 vitest 로 고정한다.
 *
 * ── 이 화면이 만들 수 있는 거짓 — 전부 여기서 막는다 ─────────────────────────
 *  ① **측정값이 없는 행을 '정상' 으로 칠하지 않는다**(v2.552 `rowState` 와 같은 판단). 점검을
 *     누르기 전에는 전부 `확인 전` 이다.
 *  ② **'확인 못 한 것' 을 결함으로도 정상으로도 세지 않는다**(v2.519·v2.523·v2.548 규약).
 *  ③ **공유 토큰을 결함으로 말하지 않는다** — 문서화된 기본 구성이고 점진 이관 전제다
 *     (`central/agentTokens.js` 머리말). 다만 개별 토큰 전용 라우트가 전부 403 이라 **기능 결손**
 *     이므로 정보도 아니다 → 전용 '주의' 칸(사용자 선택 v2.560).
 *  ④ **지문이 같다고 '토큰이 같다' 고 단정하지 않는다** — 8자(32비트)는 충돌한다. '다르면 확실히
 *     다르고, 같으면 가능성이 높다' 가 전부다(v2.528 `credFingerprint` 규약).
 *  ⑤ **'무엇과 다른가' 를 지어내지 않는다** — 중앙 수집 토큰이 거부되면 엣지 자기보고도 같은
 *     토큰으로 당기므로 함께 거부된다. 그때는 '다르다' 까지만 알고, 다음 단서를 안내한다.
 *
 * ⚠ 문구에 **백틱을 쓰지 말 것** — `BoldText` 는 `**강조**` 만 해석하고 백틱은 글자로 샌다
 *   (v2.439·2.440·2.505·2.545·2.553 실제 사고). 값 인용은 홑화살괄호 ‘ ’ 로 한다.
 * ⚠ 주기·상한 **숫자를 문구에 박지 말 것** — 서버가 주는 `limits` 만 쓴다.
 */

const t = (v) => String(v ?? '').trim();
/**
 * ⚠ **`v == null || v === ''` 를 먼저 본다** — `Number(null) === 0` 이고 `Number('') === 0` 이라
 *   그 검사 없이는 결측이 **0 으로 둔갑**한다(v2.525·v2.550·v2.552 에서 같은 함정을 네 번 밟았다).
 */
const n = (v) => (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));

/* ── 행 상태 ───────────────────────────────────────────────────────────────── */

/**
 * 표 한 행의 종합 상태. **칸이 겹치지 않는다** — KPI 항등식(합계 = 정상+결함+주의+확인불가)이
 * 이 함수와 서버 `kpisOf` 에서 같은 기준이어야 한다.
 */
export const ROW_STATE = Object.freeze({
  OK: 'ok', FAULT: 'fault', WARN: 'warn', UNKNOWN: 'unknown',
});
export const ROW_LABEL = Object.freeze({
  ok: '정상', fault: '결함', warn: '주의', unknown: '확인 불가',
});
export const ROW_TONE = Object.freeze({
  ok: 'green', fault: 'red', warn: 'amber', unknown: 'gray',
});

/**
 * ⚠⚠ **판정을 여기서 다시 하지 말 것** — 행 상태는 서버 `portalcheck/tokenScan.js rowStateOf` 가
 *   소유하고 응답의 `row.state` 로 내려온다. v2.560 초안은 이 파일과 서버가 각자 판정해
 *   **KPI 합계와 표의 색이 어긋났다**(공유 토큰을 한쪽은 주의, 다른 쪽은 확인 불가로 셌다).
 *   값이 없으면 **확인 불가**다 — 초록으로 칠하는 폴백을 만들지 말 것.
 */
export function rowState(row) {
  const s = t(row?.state);
  return Object.values(ROW_STATE).includes(s) ? s : ROW_STATE.UNKNOWN;
}

/* ── ② 통신 결과 문구 ─────────────────────────────────────────────────────── */

/** 프로브 상태 라벨. ⚠ '토큰 없음' 을 '인증 실패' 라 말하지 않는다(조치가 정반대다). */
export const PROBE_LABEL = Object.freeze({
  ok: '통신 성공',
  'wrong-edge': '다른 엣지가 응답',
  'token-mismatch': '토큰 거부(403)',
  'edge-no-token': '엣지에 수집 토큰 없음',
  'old-route': '이 경로가 없음(구버전)',
  unreachable: '닿지 못함',
  timeout: '시한 초과',
  http: '예상 밖 응답',
  'skip-no-token': '보내 볼 값 없음',
  'not-run': '확인 전',
});
export const PROBE_TONE = Object.freeze({
  ok: 'green',
  'wrong-edge': 'red',
  'token-mismatch': 'red',
  'edge-no-token': 'red',
  'old-route': 'gray',
  unreachable: 'gray',
  timeout: 'gray',
  http: 'gray',
  'skip-no-token': 'amber',
  'not-run': 'gray',
});

/**
 * 요구 ③(동일성)의 **근거 강도**를 말한다. 이 문장이 이 화면의 핵심이다.
 * ⚠ '증명' 이라는 말은 `ok` 에서만 쓴다 — 그때만 엣지 게이트가 전체 문자열을 상수시간 비교한다.
 */
export function evidenceText(row) {
  const st = t(row?.probe?.state) || 'not-run';
  if (st === 'ok') {
    return '**같습니다(증명)** — 엣지가 토큰을 전체 문자열로 비교해 통과시켰습니다. 지문 대조와 달리 이것은 확정입니다.';
  }
  if (st === 'token-mismatch') {
    return '**다릅니다** — 엣지가 중앙 저장값을 거부했습니다. 다만 **엣지가 무엇을 저장하고 있는지는 알 수 없습니다**(엣지 자기보고도 같은 토큰으로 당기므로 함께 거부됩니다). 아래 ‘배포 대상 대조’ 와 그 엣지 호스트의 portal.env 를 보세요.';
  }
  if (st === 'edge-no-token') {
    return '비교할 대상이 없습니다 — 그 엣지에 COLLECTOR_TOKEN 이 설정되지 않았습니다(수집 기능 자체가 꺼진 상태입니다).';
  }
  if (st === 'skip-no-token') {
    return '비교할 대상이 없습니다 — **중앙 등록부에 이 엣지의 수집 토큰이 없습니다**. 설정 › 수집 서버에서 토큰을 넣으세요.';
  }
  if (st === 'wrong-edge') {
    return '**이 주소가 다른 엣지에 닿고 있습니다** — 토큰이 같은지 다른지와 무관하게, 먼저 주소를 고쳐야 합니다.';
  }
  if (st === 'not-run') return '아직 확인하지 않았습니다 — ‘지금 점검’ 을 누르세요.';
  return '확인하지 못했습니다 — 통신 자체가 되지 않아 값 비교를 할 수 없습니다.';
}

/**
 * 서버가 준 사유를 문장 끝에 붙인다.
 * ⚠ **대시를 겹치지 않게** — 사유 안에 이미 `—` 가 있으면 `A — B — C` 가 되어 읽기 어렵다.
 *   끝의 마침표도 지운다(초판이 `…않습니다..` 를 찍었다 — 스크린샷 판독에서 발견).
 */
export function reasonTail(reason) {
  const r = t(reason).replace(/[.\s]+$/, '');
  if (!r) return '.';
  return ` (${r}).`;
}

/** 엣지 자기보고가 말하는 **중앙 토큰 축**의 사실. */
export const EDGE_FACT_LABEL = Object.freeze({
  agent: '개별 토큰 · 이름 일치',
  'agent-wrong-name': '개별 토큰 · 다른 이름으로 해석',
  shared: '공유 토큰',
  rejected: '중앙이 거부',
  'not-run': '자기확인 안 함',
  unknown: '확인 불가',
});
export const EDGE_FACT_TONE = Object.freeze({
  agent: 'green', 'agent-wrong-name': 'red', shared: 'amber',
  rejected: 'red', 'not-run': 'gray', unknown: 'gray',
});

export function centralAxisText(row) {
  const e = row?.edge;
  if (!e) {
    if (t(row?.capability) === 'old-version') {
      return '이 엣지는 **구버전**이라 자기보고 경로가 없습니다 — 업그레이드해야 중앙 토큰 축을 확인할 수 있습니다.';
    }
    return '엣지 자기보고가 없습니다 — ‘엣지 값 가져오기’ 를 누르세요. **중앙은 개별 엣지 토큰의 해시만 보관**하므로(발급 시 1회만 평문을 보여줍니다) 이 축은 엣지가 스스로 말해 주지 않으면 확인할 수 없습니다.';
  }
  if (e.fact === 'agent') {
    return '**같습니다(증명)** — 이 엣지가 자기 토큰으로 중앙을 두드렸고, 중앙이 그것을 **이 엣지 이름으로** 해석했습니다.';
  }
  if (e.fact === 'agent-wrong-name') {
    const said = t(e.selfProbe?.yourAgent);
    return `**토큰이 뒤바뀌었습니다** — 중앙이 이 엣지의 토큰을 ‘${said || '다른 이름'}’ 으로 해석합니다. 그 엣지의 토큰을 이 엣지에 넣어 둔 상태입니다.`;
  }
  if (e.fact === 'shared') {
    return '**공유 토큰을 쓰고 있습니다** — 결함은 아니지만(문서화된 기본 구성) 개별 토큰 전용 라우트는 전부 403 이라 통신 점검·파트 장애 같은 기능이 이 법인에서 동작하지 않습니다. 설정에서 개별 토큰을 발급해 그 엣지의 CENTRAL_TOKEN 을 바꾸면 해결됩니다.';
  }
  if (e.fact === 'rejected') {
    return '**다릅니다** — 이 엣지가 저장한 중앙 토큰을 중앙이 거부했습니다(공유 토큰도 아니고 발급된 개별 토큰도 아닙니다). 개별 토큰을 재발급해 그 엣지에 넣으세요.';
  }
  if (e.fact === 'not-run') return `자기확인을 돌리지 않았습니다${reasonTail(e.selfProbe?.reason)}`;
  return `확인하지 못했습니다${reasonTail(e.selfProbe?.reason)}`;
}

/* ── ① 중복 ───────────────────────────────────────────────────────────────── */

export const DUP_LABEL = Object.freeze({
  'collector-equals-central': '수집 토큰 = 중앙 토큰',
  'cross-edge': '서로 다른 엣지가 같은 값',
  'deploy-target': '배포 대상 값이 겹침',
  'same-edge-multi-role': '한 엣지 · 두 용도',
  'by-design': '설계상 공통',
});

/**
 * @param {object} d 중복 그룹
 * @param {{requireAgentToken?:boolean}} opt `CENTRAL_REQUIRE_AGENT_TOKEN=true` 면 공유 토큰으로는
 *   중앙 엔드포인트가 열리지 않는다 — 문구가 그 사실을 반영한다.
 *   ⚠ 그래도 **'괜찮다' 고 말하지 않는다**(그 설정이 꺼지면 위험이 되살아난다).
 */
export function dupText(d, opt = {}) {
  const who = (d?.members || []).map((m) => `${scopeLabel(m.scope)}${m.agent ? ` ‘${m.agent}’` : ''}`).join(' · ');
  if (d?.kind === 'collector-equals-central') {
    if (opt.requireAgentToken) {
      return `수집 토큰이 공유 중앙 토큰과 같습니다(${who}). 지금은 공유 토큰 사용이 금지돼 있어(CENTRAL_REQUIRE_AGENT_TOKEN) 그 값으로 중앙 엔드포인트가 열리지는 않습니다 — 다만 **그 설정을 끄는 순간 권한 상승이 됩니다**. 두 값을 서로 다르게 바꾸세요.`;
    }
    return `**권한 상승 — 즉시 고치세요.** 수집 토큰이 공유 중앙 토큰과 같습니다(${who}). 그 값을 아는 엣지는 중앙의 자격증명 배포 경로까지 호출할 수 있습니다. 두 값을 서로 다르게 바꾸세요.`;
  }
  if (d?.kind === 'cross-edge') {
    return `**서로 다른 엣지가 같은 수집 토큰을 씁니다**(${who}). 한 곳이 털리면 다른 법인의 수집 데이터가 그대로 열립니다. 엣지마다 다른 값으로 바꾸세요.`;
  }
  if (d?.kind === 'deploy-target') {
    return `배포 대상(설정 › 엣지 배포)에 저장된 값이 다른 항목과 겹칩니다(${who}). 지금은 문제가 없지만 **다음 재배포에서 그 엣지들이 같은 토큰을 갖게 됩니다**.`;
  }
  if (d?.kind === 'same-edge-multi-role') {
    return `한 엣지 안에서 같은 값이 두 용도로 쓰입니다(${who}). EDGE_MODE=all 의 기본 구성이라 정상이지만, 그 값 하나가 새면 두 방향이 함께 열립니다.`;
  }
  return `같은 값이 여러 곳에 있습니다(${who}).`;
}

export function scopeLabel(scope) {
  return ({
    collector: '수집 토큰',
    'shared-central': '공유 중앙 토큰',
    'self-collector': '이 노드 수집 토큰',
    'deploy-collector': '배포 대상 수집 토큰',
    'deploy-central': '배포 대상 중앙 토큰',
  })[t(scope)] || t(scope);
}

/* ── 발견 목록 문구 ───────────────────────────────────────────────────────── */

/** 발견 코드 → { title, fix }. **여기에 없는 코드는 서버도 만들지 않는다**(테스트가 대조한다). */
export const FINDING_TEXT = Object.freeze({
  'dup-collector-equals-central': { title: '수집 토큰이 공유 중앙 토큰과 같습니다', fix: '그 엣지의 COLLECTOR_TOKEN 과 중앙의 CENTRAL_TOKEN 을 서로 다른 값으로 바꾸세요.' },
  'dup-cross-edge': { title: '서로 다른 엣지가 같은 수집 토큰을 씁니다', fix: '엣지마다 다른 값으로 바꾸고 설정 › 수집 서버의 등록값도 함께 고치세요.' },
  'dup-deploy-target': { title: '배포 대상에 저장된 토큰이 다른 항목과 겹칩니다', fix: '설정 › 엣지 배포에서 그 항목의 토큰을 엣지마다 다르게 넣으세요(다음 재배포 때 터집니다).' },
  'dup-same-edge-multi-role': { title: '한 엣지에서 같은 값이 두 용도로 쓰입니다', fix: '기본 구성이라 조치는 선택입니다. 나누려면 그 엣지에 COLLECTOR_TOKEN 을 따로 지정하세요.' },

  'probe-token-mismatch': { title: '중앙 저장 토큰을 엣지가 거부했습니다', fix: '중앙 등록값과 그 엣지의 COLLECTOR_TOKEN 을 대조하세요(다시 눌러도 결과는 같습니다).' },
  'probe-wrong-edge': { title: '등록된 주소가 다른 엣지에 닿습니다', fix: 'NAT·포트포워딩을 확인하고 그 엣지의 portal.env 에 EDGE_ADVERTISE_URL 을 지정하세요.' },
  'probe-edge-no-token': { title: '그 엣지에 수집 토큰이 설정되지 않았습니다', fix: '그 엣지의 portal.env 에 COLLECTOR_TOKEN(또는 EDGE_MODE=all + EDGE_TOKEN)을 설정하고 재시작하세요.' },
  'probe-unreachable': { title: '엣지에 닿지 못했습니다', fix: '주소·포트·방화벽을 확인하세요(토큰 문제가 아닙니다).' },
  'probe-no-token-stored': { title: '중앙 등록부에 그 엣지의 수집 토큰이 없습니다', fix: '설정 › 수집 서버에서 토큰을 넣으세요(지금은 보내 볼 값이 없어 점검이 불가능합니다).' },
  'probe-http': { title: '예상 밖 응답을 받았습니다', fix: '그 주소가 정말 엣지 포탈인지 확인하세요(리버스 프록시·로드밸런서가 앞에 있을 수 있습니다).' },
  'probe-not-run': { title: '이번에는 점검하지 않았습니다', fix: '‘지금 점검’ 을 다시 누르면 이어서 점검합니다.' },

  'edge-central-rejected': { title: '엣지가 저장한 중앙 토큰을 중앙이 거부합니다', fix: '설정에서 그 엣지의 개별 토큰을 재발급해 엣지의 CENTRAL_TOKEN 에 넣으세요.' },
  'edge-central-wrong-name': { title: '엣지의 중앙 토큰이 다른 엣지 것입니다', fix: '두 엣지의 토큰이 뒤바뀌었습니다. 각각 재발급해 다시 넣으세요.' },
  'edge-shared-token': { title: '공유 중앙 토큰을 쓰고 있습니다', fix: '개별 토큰을 발급해 그 엣지의 CENTRAL_TOKEN 을 바꾸세요(그러지 않으면 개별 토큰 전용 기능인 통신 점검·파트 장애 등이 이 법인에서 동작하지 않습니다).' },
  'edge-no-report': { title: '엣지 자기보고가 없습니다', fix: '‘엣지 값 가져오기’ 를 누르세요(중앙 토큰 축은 엣지가 말해 주지 않으면 확인할 수 없습니다).' },
  'edge-old-version': { title: '구버전 엣지라 자기보고 경로가 없습니다', fix: '그 엣지를 업그레이드하세요.' },
  'edge-name-mismatch': { title: '중앙이 아는 이름과 엣지가 말한 이름이 다릅니다', fix: 'AGENT_NAME 과 설정 › 수집 서버의 이름을 맞추세요(다르면 엣지 보고가 엉뚱한 행에 붙습니다).' },
  'edge-collector-fp-diff': { title: '수집 토큰 지문이 중앙 등록값과 다릅니다', fix: '등록부에 같은 엣지가 여러 항목으로 있는지 확인하세요(중앙이 어느 값을 쓰는지가 갈립니다).' },

  'edge-is-also-central': { title: '이 엣지가 또 다른 중앙으로 동작합니다', fix: '그 엣지의 CENTRAL_TOKEN 을 지우고 EDGE_TOKEN 을 쓰세요(CENTRAL_TOKEN 은 그 인스턴스의 중앙 엔드포인트를 엽니다).' },
  'deploy-collector-diff': { title: '배포 대상의 수집 토큰이 현재 등록값과 다릅니다', fix: '설정 › 엣지 배포의 값을 지금 등록값과 맞추세요(그러지 않으면 다음 재배포에서 등록값이 무효가 됩니다).' },
  'not-in-registry': { title: '수집 서버 등록부에 없는 엣지입니다', fix: '설정 › 수집 서버에 등록하세요(등록되지 않으면 중앙이 이 엣지를 점검하거나 당길 수 없습니다).' },

  'hygiene-space': { title: '토큰 값 앞뒤에 공백이 있습니다', fix: '공백을 지우세요. 비교는 전체 문자열이라 공백 하나로 거부되는데 화면에서는 보이지 않습니다.' },
  'hygiene-short': { title: '토큰이 짧습니다', fix: '충분히 긴 무작위 값으로 바꾸세요(개별 토큰 발급 기능이 256비트 값을 만들어 줍니다).' },
  'hygiene-newline': { title: '토큰 값에 줄바꿈이 있습니다', fix: 'portal.env 의 그 줄이 깨졌습니다. 한 줄로 고치세요.' },
  'hygiene-quoted': { title: '토큰 값이 따옴표로 감싸여 있습니다', fix: '따옴표까지 값으로 읽히므로 따옴표를 지우세요.' },
});

const WHERE_LABEL = Object.freeze({
  'central-collector': '중앙 등록값',
  'edge-collector': '엣지의 수집 토큰',
  'edge-central-send': '엣지가 중앙에 보내는 토큰',
});

/** 발견 1건의 한 줄 — `BoldText` 로 렌더한다. */
export function findingLine(f) {
  const meta = FINDING_TEXT[t(f?.code)];
  const who = t(f?.agent) ? `‘${t(f.agent)}’ · ` : '';
  if (!meta) return `${who}${t(f?.code) || '알 수 없는 항목'}`;
  const where = f?.facts?.where ? ` (${WHERE_LABEL[f.facts.where] || f.facts.where})` : '';
  return `${who}**${meta.title}**${where} — ${meta.fix}`;
}

/** 엣지 목록을 한 줄로 — 많으면 자르고 **자른 개수를 밝힌다**(조용한 상한 금지). */
export function agentsText(agents = [], max = 8) {
  const a = (agents || []).filter(Boolean);
  if (!a.length) return '';
  if (a.length <= max) return a.join(' · ');
  return `${a.slice(0, max).join(' · ')} 외 ${a.length - max}곳`;
}

/**
 * 묶은 발견 1건의 한 줄. **같은 문장을 28번 반복하지 않는다**(v2.509 규약).
 * ⚠ 묶었다는 사실과 **대상 엣지**를 잃지 않는다 — 개수만 보여주면 어디를 고칠지 모른다.
 */
export function findingGroupLine(g) {
  const meta = FINDING_TEXT[t(g?.code)];
  const where = g?.facts?.where ? ` (${WHERE_LABEL[g.facts.where] || g.facts.where})` : '';
  const who = agentsText(g?.agents);
  const n1 = Number(g?.count) || 0;
  const scope = who ? `${n1 > 1 ? `**${n1}곳** — ` : ''}${who}` : '';
  if (!meta) return `${scope ? `${scope} · ` : ''}${t(g?.code) || '알 수 없는 항목'}`;
  return `**${meta.title}**${where}${scope ? ` — ${scope}` : ''} · ${meta.fix}`;
}

/* ── 지문 표기 ───────────────────────────────────────────────────────────── */

/**
 * 지문 한 칸. ⚠ **값이 없으면 단위를 붙이지 않는다** — ‘0자’ 로 보이면 '빈 토큰' 이라는 거짓이다
 * (v2.534 온도 월보드에서 같은 실수를 했다).
 */
export function fpText(facts) {
  if (!facts || facts.set !== true) return '—';
  const len = n(facts.len);
  const parts = [t(facts.short) || '지문 미상'];
  if (len != null) parts.push(`${len}자`);
  if (facts.space) parts.push('앞뒤 공백');
  return parts.join(' · ');
}

/** 지문 대조의 한계를 화면이 **항상** 말한다 — 지우지 말 것. */
export function fpLimitNote() {
  return '지문은 sha256 앞 8자(32비트)입니다 — **다르면 확실히 다르고, 같으면 가능성이 높다**까지입니다. 토큰 값과 전체 해시는 이 화면에 나오지 않습니다.';
}

/* ── 배너·빈 상태 ─────────────────────────────────────────────────────────── */

/**
 * 상단 배너. ⚠ 결함 0 을 곧바로 '정상' 이라 말하지 않는다 — **측정한 것이 있을 때만**이다.
 */
export function bannerText(scan) {
  const k = scan?.kpis || {};
  const fc = scan?.findingCounts || {};
  const measured = n(k.measured) || 0;
  if (!n(k.total)) {
    return { tone: 'gray', text: '점검할 엣지가 없습니다 — 설정 › 수집 서버에 엣지를 등록하면 여기에 나타납니다.' };
  }
  /*
   * ⚠⚠ **두 축을 한 숫자로 말하지 말 것**(v2.560 스크린샷 판독에서 잡은 결함): 초판 배너는
   *   `findingCounts.fault`(발견 건수)를 '결함 N건' 이라 썼는데 KPI '결함' 칸은 `kpis.fault`
   *   (**행 상태**)라, 중복만 있는 현장에서 배너 '결함 2건' 과 KPI '결함 0' 이 **정면으로 모순**
   *   됐다. 중복은 엣지 2곳에 걸친 값이라 어느 한 행에 귀속되지 않는다 — 그러니 **나눠 말한다**.
   */
  if (n(k.fault) || n(k.dupFault) || n(fc.fault)) {
    const parts = [];
    if (n(k.fault)) parts.push(`**엣지 ${k.fault}곳에 결함**`);
    if (n(k.dupFault)) parts.push(`**중복 토큰 ${k.dupFault}건**`);
    /*
     * 지금은 모든 결함 발견이 위 두 축 중 하나로 환원된다(중복은 dupFault, 나머지는 행 상태).
     * 그래도 폴백을 둔다 — 새 결함 코드가 두 축에 안 걸리면 배너가 **조용히 초록**이 된다.
     */
    if (!parts.length) parts.push(`**결함 발견 ${fc.fault}건**`);
    return { tone: 'red', text: `${parts.join(' · ')} — 아래 목록의 위쪽부터 고치세요. 수집 토큰이 중앙 토큰과 같은 항목과 여러 엣지가 같은 값을 쓰는 항목이 가장 위험합니다.` };
  }
  if (measured === 0) {
    return { tone: 'gray', text: '아직 통신 점검을 돌리지 않았습니다 — **‘지금 점검’** 을 누르면 중앙에 저장된 토큰으로 각 엣지를 실제로 두드려 봅니다. 그 전까지의 판정은 저장값 대조(중복·값 위생)뿐입니다.' };
  }
  if (n(fc.warn)) {
    return { tone: 'amber', text: `결함은 없고 **주의 ${fc.warn}건** 입니다 — 공유 토큰·값 위생·배포 대상 불일치는 지금 장애를 만들지는 않지만 기능 결손이거나 다음 배포에서 터집니다.` };
  }
  if (n(fc.unknown)) {
    return { tone: 'amber', text: `측정한 ${measured}곳에는 결함이 없지만 **확인하지 못한 항목 ${fc.unknown}건**이 있습니다 — ‘정상’ 이라는 뜻이 아닙니다.` };
  }
  return { tone: 'green', text: `측정한 ${measured}곳 모두 정상입니다 — 중앙 저장 토큰으로 통신이 되고, 엣지 저장값과 같다는 것까지 확인했습니다.` };
}

/** 정상률 — **측정분이 분모**다. 0 이면 null(0% 가 아니다). */
export function okRateText(kpis) {
  const r = n(kpis?.okRate);
  if (r == null) return '—';
  return `${r}%`;
}

/**
 * 표 아래 각주 — **해당 종류가 있을 때만** 만든다(행마다 반복하면 같은 문단이 화면을 덮는다.
 * v2.509 규약). 항상 나오는 것은 지문 한계 한 줄뿐이다.
 */
export function tableFootnotes(scan, limits) {
  const out = [fpLimitNote()];
  const rows = scan?.rows || [];
  const has = (fn) => rows.some(fn);
  if (has((r) => r.registered === false)) {
    out.push('‘등록부 없음’ 행은 중앙의 다른 기록(개별 토큰·배포 대상·설정 push·인출 상태)에는 있는데 설정 › 수집 서버에 없는 엣지입니다 — 이 행을 빼면 화면이 ‘전부 정상’ 이라는 거짓을 말하게 되므로 일부러 보여 줍니다.');
  }
  if (has((r) => !r.edge)) {
    const v = t(limits?.minEdgeVersion);
    out.push(`엣지 자기보고가 없는 행은 중앙 토큰 축을 확인할 수 없습니다 — **중앙은 개별 엣지 토큰의 해시만 보관**하기 때문입니다${v ? ` (자기보고는 엣지 v${v} 이상에서 동작합니다)` : ''}.`);
  }
  if (has((r) => t(r.probe?.state) === 'token-mismatch')) {
    out.push('토큰이 거부된 엣지는 자기보고도 같은 토큰으로 당기므로 함께 거부됩니다 — 그래서 ‘다르다’ 까지만 알 수 있고 ‘엣지가 무엇을 저장했는지’ 는 알 수 없습니다. 배포 대상 대조와 그 엣지 호스트의 portal.env 를 보세요.');
  }
  if (has((r) => r.deploy?.present)) {
    out.push('배포 대상 값은 **저장값끼리만 대조**합니다 — 그 값으로 엣지를 찔러보지 않습니다(틀린 토큰 시도는 엣지의 인증 거부 기록을 채워 실제 침입 흔적을 밀어냅니다).');
  }
  return out;
}

/** '지금 점검' 응답 요약 — **중앙 즉시분과 건너뛴 것을 나눠** 말한다(v2.516 규약). */
export function runSummary(resp) {
  if (!resp) return '';
  const parts = [];
  if (n(resp.probed) != null) parts.push(`${resp.probed}곳 점검`);
  if (n(resp.pulled) != null) parts.push(`${resp.pulled}곳 인출`);
  if (n(resp.failed)) parts.push(`실패 ${resp.failed}곳`);
  if (n(resp.budgetExceeded)) parts.push(`**시간 예산으로 ${resp.budgetExceeded}곳은 시도하지 않았습니다** — 다시 누르면 이어서 점검합니다`);
  if (n(resp.ms) != null) parts.push(`${Math.round(resp.ms / 100) / 10}초`);
  return parts.join(' · ');
}

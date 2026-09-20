/**
 * views/tools/invCheckText.js — '포탈 점검 › 인벤토리 점검' 의 **문구**(순수, v2.570).
 *
 * 사용자 요청(2026-09-20): 에이전트 수신 트래픽 진단 표에서 최근 페이로드가 전부 `—` 인 것을
 * 보고 "여기서 수집되는 데이터가 없으면 어떤 문제가 발생하는지 확인하고 오류를 점검하려면
 * 어떻게 해야 하는지" → "점검할 수 있는 기능 만들어줘".
 *
 * 서버(`portalcheck/invScan.js`)는 `code` + 근거만 준다. 문장은 여기 하나가 만든다
 * (v2.553 `settingsCheckText.js`·v2.560 `tokenCheckText.js` 와 같은 관례).
 *
 * ── 이 화면이 만들 수 있는 거짓 — 전부 여기서 막는다 ─────────────────────────
 *  ① **낡음(stale)을 정상처럼 초록으로 칠하지 않는다** — 이것이 이 화면의 존재 이유다. 데이터는
 *     디스크 캐시에서 계속 서빙되므로 며칠 전 값이 지금 값처럼 보일 수 있다.
 *  ② **'안 보냈다'(never) 와 '보냈는데 막혔다'(rejected) 를 같은 문구로 덮지 않는다** — 조치가
 *     정반대다(전자는 엣지 설정, 후자는 중앙 판정·소유권·토큰).
 *  ③ **거부 기록의 agent 이름은 미검증**(위조됐을 수 있다) — 그 이름을 근거로 조치를 안내하지
 *     않는다. `unverified` 를 화면이 말한다.
 *  ④ **위임 담당으로 학습된 적 없는 엣지의 인벤토리 미전송을 결함이라 하지 않는다** — 스토리지·
 *     svcmon 전용 엣지처럼 인벤토리를 애초에 다루지 않는 정상 구성이 있다.
 *
 * ⚠ 문구에 **백틱을 쓰지 말 것** — `BoldText` 는 `**강조**` 만 해석한다(v2.439·2.440·2.505·
 *   2.545·2.553 실제 사고). 값 인용은 홑화살괄호 ‘ ’ 로 한다.
 * ⚠ 주기·상한 **숫자를 문구에 박지 말 것** — 서버가 주는 값만 쓴다.
 */

const t = (v) => String(v ?? '').trim();
/** ⚠ `v == null || v === ''` 를 먼저 본다 — `Number(null)===0` 함정(v2.525·v2.550·v2.552·v2.556). */
const n = (v) => (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));

/* ── 행 상태 ───────────────────────────────────────────────────────────────── */

export const INV_STATE = Object.freeze({
  OK: 'ok', STALE: 'stale', NEVER: 'never', REJECTED: 'rejected', UNKNOWN: 'unknown',
});
export const INV_STATE_LABEL = Object.freeze({
  ok: '정상 수신', stale: '낡음', never: '수신 이력 없음', rejected: '거부됨', unknown: '확인 불가',
});
export const INV_STATE_TONE = Object.freeze({
  ok: 'green', stale: 'amber', never: 'gray', rejected: 'red', unknown: 'gray',
});

/**
 * ⚠⚠ **판정을 여기서 다시 하지 말 것** — 상태는 서버 `portalcheck/invScan.js scanInventory` 가
 *   소유하고 `row.state` 로 내려온다. 값이 없으면 확인 불가다(초록 폴백 금지).
 */
export function invRowState(row) {
  const s = t(row?.state);
  return Object.values(INV_STATE).includes(s) ? s : INV_STATE.UNKNOWN;
}

/** 경과 시간 — 초 단위 미만은 '방금'. */
export function ageText(ms) {
  const v = n(ms);
  if (v == null) return '—';
  if (v < 1000) return '방금';
  const s = Math.round(v / 1000);
  if (s < 60) return `${s}초 전`;
  if (s < 3600) return `${Math.round(s / 60)}분 전`;
  if (s < 86400) return `${Math.round(s / 3600)}시간 전`;
  return `${Math.round(s / 86400)}일 전`;
}

/** 한 위임 vCenter 행의 한 줄 설명. */
export function rowExplain(row) {
  const s = invRowState(row);
  const owner = t(row?.owner);
  const who = owner ? `담당 ‘${owner}’` : '**담당 엣지 미상**(한 번도 push 된 적이 없어 중앙이 누가 보내야 하는지 모릅니다)';
  if (s === INV_STATE.OK) {
    const empty = row?.emptyPush ? ' — 단, 호스트·VM 이 0입니다(신규 구축·철거 직후라면 정상입니다).' : '';
    return `${who} · ${ageText(row?.ageMs)} 수신${empty}`;
  }
  if (s === INV_STATE.STALE) {
    return `${who} · 마지막 수신 ${ageText(row?.ageMs)} — **기준 시간을 넘겼습니다. 화면·집계에 남은 값은 그 시점의 낡은 값입니다.**`;
  }
  if (s === INV_STATE.NEVER) {
    return `${who} — **한 번도 수신된 적이 없습니다.**`;
  }
  if (s === INV_STATE.REJECTED) {
    return `${rejectKindLine(row?.reject)} — 이 vCenter 를 지목한 요청이었습니다(요청 agent 이름 ‘${t(row?.reject?.agent) || '(unknown)'}’, ${unverifiedNote()}).`;
  }
  return '판정 근거가 부족합니다.';
}

/** 거부 종류별 문장(조치가 다르다). */
export function rejectKindLine(reject) {
  const k = t(reject?.kind);
  const reason = t(reject?.reason);
  if (k === 'mock') return `**엣지가 mock(가짜) 데이터를 보내 중앙이 저장을 거부했습니다** — 그 엣지 portal.env 의 DATA_SOURCE 를 live 로 바꾸세요`;
  if (k === 'owner') return `**이 vCenter 는 다른 엣지 소유로 등록돼 있어 거부됐습니다** — ${reason || '두 엣지가 같은 vCenter 를 push 하고 있을 수 있습니다'}`;
  if (k === 'auth') return `**중앙 토큰이 거부됐습니다**(${reason || '토큰 불일치'}) — 포탈 점검 › 토큰 점검에서 이 엣지를 대조하세요`;
  if (k === 'disabled') return '**중앙 수신이 비활성입니다**';
  if (k === 'server') return `**중앙 오류로 저장에 실패했습니다**(${reason || '5xx'})`;
  return `**요청이 거부됐습니다**(${reason || '사유 미상'})`;
}

/** 거부 기록 agent 이름의 신뢰 한계 — 지우지 말 것(위조된 이름일 수 있다). */
export function unverifiedNote() {
  return '이 이름은 요청이 주장한 값이라 검증되지 않았습니다';
}

/* ── 엣지 축 ───────────────────────────────────────────────────────────────── */

export function agentRowExplain(a) {
  if (a?.mockReported) return '**이 엣지가 mock(가짜) 데이터를 자기보고했습니다.**';
  if (a?.sentInventory) {
    return `최근 push: 호스트 ${n(a.lastHosts) ?? '?'}·VM ${n(a.lastVms) ?? '?'}${a?.gzip === false ? ' · **무압축**' : ''}`;
  }
  if (a?.knownOwner) {
    return `**위임 담당으로 등록돼 있는데 최근 push 가 인벤토리가 아닙니다**(마지막: ${t(a?.lastEndpoint) || '없음'}).`;
  }
  return `인벤토리 담당으로 학습된 적이 없습니다 — 이 엣지가 위임 vCenter 를 다루지 않는 정상 구성일 수 있습니다(마지막: ${t(a?.lastEndpoint) || '없음'}).`;
}

/* ── 발견 문구 ─────────────────────────────────────────────────────────────── */

const FINDING_TEXT = Object.freeze({
  'inv-stale': { title: '위임 vCenter 수신이 낡았습니다', fix: '그 엣지가 살아 있는지, 중앙까지 통신이 되는지 확인하세요(특수기능 › 통신 점검).' },
  'inv-never': { title: '위임 vCenter 에 수신 이력이 없습니다', fix: '그 vCenter 담당 엣지가 vCenter 접속에 성공하는지, DATA_SOURCE=live 인지 확인하세요.' },
  'inv-reject-mock': { title: '엣지가 mock 데이터를 보내 거부됐습니다', fix: '그 엣지 portal.env 의 DATA_SOURCE 를 live 로 바꾸고 재시작하세요.' },
  'inv-reject-owner': { title: '소유권 충돌로 push 가 거부됐습니다', fix: '두 엣지가 같은 vCenter 를 담당하도록 설정돼 있지 않은지 확인하세요.' },
  'inv-reject-auth': { title: '토큰 불일치로 push 가 거부됐습니다', fix: '포탈 점검 › 토큰 점검에서 이 엣지의 저장 토큰을 대조하세요.' },
  'inv-reject-other': { title: '중앙이 push 를 거부했습니다', fix: '아래 사유를 확인하세요.' },
  'inv-empty-push': { title: '수신은 정상인데 호스트·VM 이 0입니다', fix: '신규 구축·철거 직후가 아니라면 그 엣지 계정의 조회 권한을 확인하세요.' },
  'inv-no-owner': { title: '담당 엣지가 아직 학습되지 않았습니다', fix: '해당 사이트의 엣지가 최소 1회 성공적으로 push 해야 담당이 기록됩니다.' },
  'inv-agent-no-inventory': { title: '위임 담당 엣지가 인벤토리를 보내지 않고 있습니다', fix: '그 엣지의 vCenter 수집 상태·로그를 확인하세요(특수기능 › 엣지 로그).' },
  'inv-agent-mock': { title: '엣지가 mock 데이터로 동작 중입니다', fix: '그 엣지 portal.env 의 DATA_SOURCE 를 live 로 바꾸세요.' },
  'inv-owner-conflict': { title: '같은 vCenter 를 서로 다른 엣지가 번갈아 보내고 있습니다', fix: '두 사이트의 vCenter 등록이 겹치지 않는지 확인하세요.' },
  'inv-no-site-vcenter': { title: '엣지 위임(collectMode=site) vCenter 가 없습니다', fix: '이 점검은 위임 vCenter 전용입니다 — 대상이 없으면 점검할 것도 없습니다.' },
});

/** 발견 코드 ↔ 이 상수의 키가 1:1 이어야 한다(테스트가 서버 INV_FINDING 과 대조한다). */
export function findingCodesDeclared() {
  return Object.keys(FINDING_TEXT);
}

export function findingLine(f) {
  const meta = FINDING_TEXT[t(f?.code)];
  const who = t(f?.target) ? `‘${t(f.target)}’ · ` : '';
  if (!meta) return `${who}${t(f?.code) || '알 수 없는 항목'}`;
  return `${who}**${meta.title}** — ${meta.fix}`;
}

/** 대상 목록 한 줄 — 많으면 자르고 자른 개수를 밝힌다(조용한 상한 금지). */
export function targetsText(targets = [], max = 8) {
  const a = (targets || []).filter(Boolean);
  if (!a.length) return '';
  if (a.length <= max) return a.join(' · ');
  return `${a.slice(0, max).join(' · ')} 외 ${a.length - max}곳`;
}

/** 묶은 발견 1건의 한 줄(v2.509 규약 — 같은 문장을 N번 반복하지 않는다). */
export function findingGroupLine(g) {
  const meta = FINDING_TEXT[t(g?.code)];
  const who = targetsText(g?.targets);
  const cnt = n(g?.count) || 0;
  const scope = who ? `${cnt > 1 ? `**${cnt}곳** — ` : ''}${who}` : '';
  if (!meta) return `${scope ? `${scope} · ` : ''}${t(g?.code) || '알 수 없는 항목'}`;
  return `**${meta.title}**${scope ? ` — ${scope}` : ''} · ${meta.fix}`;
}

/* ── 배너·KPI ─────────────────────────────────────────────────────────────── */

/** 상단 배너 — 긴 설명은 여기 한 번만(v2.509 규약). */
export function bannerText(scan) {
  const k = scan?.kpis || {};
  if (!n(k.total)) {
    return { tone: 'gray', text: '엣지 위임(collectMode=site) vCenter 가 없습니다 — 이 점검은 그 대상 전용입니다. 설정 › vCenter 관리에서 수집 방식을 확인하세요.' };
  }
  if (n(k.rejected)) {
    return { tone: 'red', text: `**${k.rejected}곳이 중앙에 거부되고 있습니다** — 안 보내는 것이 아니라 중앙이 막고 있는 것입니다. 아래 사유부터 확인하세요.` };
  }
  if (n(k.stale)) {
    return { tone: 'amber', text: `**${k.stale}곳의 수신이 낡았습니다** — 화면·집계에 표시되는 값은 그 시점의 옛 값입니다(며칠 전 값이 지금 값처럼 보일 수 있습니다).` };
  }
  if (n(k.never)) {
    return { tone: 'amber', text: `**${k.never}곳이 한 번도 수신되지 않았습니다** — 첫 수집을 기다리는 중이거나 그 엣지의 vCenter 접속이 실패하고 있습니다.` };
  }
  if (n(k.emptyPush)) {
    return { tone: 'amber', text: `수신은 전부 신선하지만 **${k.emptyPush}곳이 호스트·VM 0**으로 도착합니다 — 신규 구축·철거 직후라면 정상입니다.` };
  }
  return { tone: 'green', text: `측정한 ${n(k.measured) || 0}곳 모두 기준 시간 안에 신선하게 수신되고 있습니다.` };
}

/** 신선율 — 분모는 measured(ok+stale). 0 이면 null(0% 가 아니다). */
export function freshRateText(kpis) {
  const r = n(kpis?.freshPct);
  return r == null ? '—' : `${r}%`;
}

/** 표 아래 각주 — 해당 종류가 있을 때만(v2.509 규약). */
export function tableFootnotes(scan) {
  const out = [];
  const rows = scan?.rows || [];
  if (rows.some((r) => !r.owner)) {
    out.push('‘담당 엣지 미상’ 은 등록부의 필드가 아니라 **한 번이라도 성공한 push 에서 학습된 값**입니다 — 한 번도 없으면 중앙은 누가 보내야 하는지 알지 못합니다.');
  }
  if (rows.some((r) => invRowState(r) === INV_STATE.REJECTED)) {
    out.push('거부 기록의 엣지 이름은 요청이 주장한 값이라 **검증되지 않았습니다** — 실제로 그 엣지가 보낸 것인지는 별도로 확인이 필요합니다.');
  }
  if ((scan?.agents || []).some((a) => !a.sentInventory && !a.knownOwner)) {
    out.push('‘인벤토리 미전송’ 이 결함으로 표시되지 않은 엣지는 위임 담당으로 학습된 적이 없는 곳입니다 — 스토리지·SAN 등 다른 용도로만 쓰는 엣지는 정상입니다.');
  }
  return out;
}

/**
 * bmUsageDistText.js — 베어메탈 사용률 설정 '엣지에 배포' 화면 문구(v2.627, 순수 · vitest).
 *
 * 사용자 요청 "한번에 켜는 기능" · 선택 "중앙 설정이 엣지를 따른다": 중앙 관리자가 배포를 켜면 엣지 28곳이 다음 인출(기본
 * 10분 주기)에 중앙 값으로 바뀐다. ⚠ 정직 규칙:
 *  · 저장 즉시 반영된 척하지 않는다 — '다음 인출에 받는다' 와 엣지별 **적용됨 / 대기 / 인출 기록 없음** 을 나눠 말한다.
 *  · '인출 기록 없음' 을 '실패' 로 말하지 않는다 — 중앙 재시작 직후엔 기록이 비어 있고(인메모리), 구버전 엣지는 이 인출을 모른다.
 *  · Enterprise 대체 수집은 배포하지 않는다(v2.554 — 그 엣지 관리자의 동의). 화면이 그 사실을 말한다.
 */
export const DIST_STATE = Object.freeze({
  applied: { label: '적용됨', tone: 'ok', why: '이 엣지가 지금 판을 적용했다고 알려 왔습니다.' },
  // v2.628(R2628-05): 엣지는 응답을 받기 **전** 판을 알린다 — 방금 내려받은 판은 다음 인출에서야 '적용됨' 이 된다. 그 사이를
  //   '대기(이전 판)' 라 말하면 거짓이다. 중앙이 마지막 응답으로 지금 판을 보냈으면 '전달됨' 이다(적용 확인은 다음 인출).
  delivered: { label: '전달됨', tone: 'ok', why: '마지막 인출에서 지금 판을 내려받았습니다 — 적용 확인은 다음 인출에 옵니다.' },
  pending: { label: '대기', tone: 'warn', why: '이 엣지가 이전 판을 쓰고 있습니다 — 다음 인출에 받습니다.' },
  'no-pull': { label: '인출 기록 없음', tone: 'muted', why: '중앙 재시작 뒤 아직 인출하지 않았거나 2.627 미만 엣지입니다(구버전은 이 배포를 받지 못합니다).' },
  excluded: { label: '제외', tone: 'muted', why: '이 엣지는 자기 로컬 설정을 씁니다.' },
  off: { label: '배포 꺼짐', tone: 'muted', why: '배포가 꺼져 있어 엣지는 로컬 설정을 씁니다.' },
  // v2.927 '중앙에서 켜기'(한 엣지만) — 서버 distributionStatus 의 상태 낱말과 같다.
  unverified: { label: '받지 못함(공유 토큰)', tone: 'bad', why: '이 엣지는 공유 토큰으로 인출합니다 — 이름을 검증할 수 없어 중앙 켜기를 내려주지 않습니다. 이 엣지의 개별 토큰을 발급·적용해야 받습니다.' },
  releasing: { label: '해제 대기', tone: 'warn', why: '배포를 끄거나 해제했지만 이 엣지는 아직 중앙 사본을 쓰고 있습니다 — 다음 인출에 지우고 엣지 로컬 설정으로 돌아갑니다.' },
});

/** v2.927: 배포 모드 라벨 — 서버 행 `mode`('all'|'per-edge'|'excluded'|'off'). */
export const DIST_MODE = Object.freeze({
  all: '전체 배포', 'per-edge': '중앙 켜기', excluded: '제외', off: '로컬',
});
export function distModeLabel(mode) { return DIST_MODE[mode] || '—'; }

export function distStateOf(state) { return DIST_STATE[state] || { label: '확인 불가', tone: 'muted', why: '' }; }

/** 배포 현황 요약 — 겹치지 않는 개수. 합계 = 적용 + 대기 + 기록 없음 + 제외(+ 꺼짐). */
export function distributionCounts(dist) {
  const c = { total: 0, applied: 0, delivered: 0, pending: 0, 'no-pull': 0, excluded: 0, off: 0, unverified: 0,
    releasing: 0, notVerified: 0, perEdge: 0, perEdgeSuperseded: 0, corpsChanged: 0 };
  for (const r of dist?.rows || []) {
    c.total += 1; if (Object.hasOwn(c, r.state) && r.state !== 'unverified') c[r.state] += 1;
    if (r.state === 'unverified') c.notVerified += 1;   // v2.927: 중앙 켜기를 공유 토큰 인출이라 받지 못함
    if (r.verified === false) c.unverified += 1;   // v2.628(SEC2628-02): 공유 토큰 인출 — 이름이 검증되지 않았다
    if (r.mode === 'per-edge') c.perEdge += 1;
    if (r.perEdgeSuperseded) c.perEdgeSuperseded += 1;
    if (r.perEdge && r.corpsChanged === true) c.corpsChanged += 1;   // v2.927: 저장 법인 ≠ 지금 매핑(다시 확인 필요)
  }
  return c;
}

/** v2.927: 중앙 켜기(이 엣지만) 행들의 상태 요약 — '적용됨 1 · 대기 1' 처럼(0 인 것은 뺀다). */
function perEdgeParts(dist) {
  const order = ['applied', 'delivered', 'pending', 'no-pull', 'unverified'];
  const cnt = {};
  for (const r of dist?.rows || []) if (r.mode === 'per-edge') cnt[r.state] = (cnt[r.state] || 0) + 1;
  return order.filter((k) => cnt[k]).map((k) => `${distStateOf(k).label} ${cnt[k]}`);
}

export function distributionSummary(dist) {
  if (!dist) return '';
  const c = distributionCounts(dist);
  if (!dist.enabled) {
    if (!c.perEdge) return `**배포 꺼짐** — 엣지 ${c.total}곳은 각자 로컬 설정을 씁니다. 켜면 이 화면의 설정(Enterprise 대체 수집 제외)이 다음 인출 때 모든 엣지에 내려갑니다.`;
    // v2.927: 전체 배포가 꺼져 있어도 중앙 켜기 엣지는 중앙 값을 받는다 — '각자 로컬' 이라고만 말하면 거짓이다.
    const pp = perEdgeParts(dist);
    return `**전체 배포 꺼짐** · **중앙 켜기(이 엣지만) ${c.perEdge}곳**${pp.length ? `(${pp.join(' · ')})` : ''} — 나머지 ${c.total - c.perEdge}곳은 각자 로컬 설정을 씁니다.`
      + ' 중앙 켜기 엣지는 **다음 인출**(기본 10분 주기)에 받습니다 — 저장 즉시 바뀌지 않습니다.' + perEdgeTail(dist, c);
  }
  const parts = [`적용됨 ${c.applied}`];
  if (c.delivered) parts.push(`전달됨 ${c.delivered}`);
  parts.push(`대기 ${c.pending}`, `인출 기록 없음 ${c['no-pull']}`);
  if (c.excluded) parts.push(`제외 ${c.excluded}`);
  if (c.unverified) parts.push(`이름 미검증 ${c.unverified}(공유 토큰 — 이름을 확인할 수 없는 인출)`);
  // v2.632(A6-2632-03): 등록부에 없는 미검증 이름은 최근 일부만 행으로 싣고, 상한으로 거절한 인출은 개수만 준다.
  if (dist.unknownUnverifiedOmitted > 0) parts.push(`등록부에 없는 미검증 이름 ${dist.unknownUnverifiedOmitted}곳은 표에서 생략`);
  if (dist.pullsOmitted > 0) parts.push(`기록 상한으로 남기지 못한 미검증 인출 ${dist.pullsOmitted}건`);
  if (c.releasing) parts.push(`해제 대기 ${c.releasing}`);
  // v2.927: 전체 배포가 우선해 가려진 중앙 켜기 — 조용히 두지 않는다.
  const sup = c.perEdgeSuperseded ? ` 중앙 켜기 ${c.perEdgeSuperseded}곳은 **전체 배포가 우선**해 지금은 전체 배포 값을 받습니다(전체 배포를 끄면 그 엣지만 켜기로 돌아갑니다).` : '';
  return `**배포 켜짐** — 엣지 ${c.total}곳: ${parts.join(' · ')}. 엣지는 **다음 인출**(기본 10분 주기)에 받습니다 — 저장 즉시 바뀌지 않습니다.${sup}${perEdgeTail(dist, c)}`;
}

/** v2.927: 중앙 켜기 꼬리 — 법인 매핑이 바뀐 엣지 · 파일에서 버린 항목(조용히 두지 않는다). */
function perEdgeTail(dist, c) {
  let s = '';
  if (c.corpsChanged) s += ` ⚠ 중앙 켜기 ${c.corpsChanged}곳은 **법인 매핑이 바뀌었습니다 — 다시 확인 필요**(엣지는 저장한 법인을 계속 받습니다).`;
  if (dist?.perEdgeOmitted > 0) s += ` 배포 파일의 중앙 켜기 ${dist.perEdgeOmitted}건은 법인이 없거나 상한(${dist.perEdgeMax || '—'}곳)을 넘어 쓰지 않았습니다.`;
  return s;
}

/** v2.629(A1-2629-04): 검증된 인출 기록이 1시간 넘게 끊겨 공유 토큰 인출이 덮은 행 — 그 사실을 말한다. 아니면 ''. */
export function lapsedVerifiedNote(r, agoFn) {
  if (!r?.lapsedVerifiedAt) return '';
  const when = agoFn ? agoFn(r.lapsedVerifiedAt) : '';
  return `마지막 검증 인출 ${when} · 이후는 공유 토큰 인출(이름 미검증)`;
}

/** 엣지 화면: 이 노드가 중앙 배포값을 쓰고 있을 때 배너. 아니면 ''. */
export function centralManagedNote(central, agoFn) {
  if (!central?.managed) return '';
  const when = central.at && agoFn ? ` · 마지막 확인 ${agoFn(central.at)}` : '';
  return `🔒 **중앙이 이 설정을 배포 중입니다**${when} — 수집 켜기·법인·주기·보존·경로·알림은 중앙 포탈에서 바꿉니다(여기서 바꿔도 저장되지 않습니다). **Enterprise 대체 수집**만 이 엣지에서 정합니다.`;
}

/** 저장 응답이 배포 키를 무시했을 때 한 줄. */
export function ignoredCentralNote(r) {
  const n = Array.isArray(r?.ignoredCentralManaged) ? r.ignoredCentralManaged.length : 0;
  return n ? ` 중앙이 배포하는 항목 ${n}개는 저장하지 않았습니다(중앙 포탈에서 바꿉니다).` : '';
}

/* ── v2.927 '중앙에서 켜기'(엣지 보관분 표) ─────────────────────────────────────────
 * 사용자 요청 "중앙에서 엣지를 켜는 기능 추가" · 선택: 엣지별 버튼. 정직 규칙:
 *  · 저장 즉시 켜진 척하지 않는다 — '켜기 지시됨 — 다음 인출 대기' → '전달됨' → '적용됨'(배포 상태 낱말 재사용).
 *    이 지시 상태는 엣지 보관분 상태를 **대체하지 않고 함께** 보인다(반증 F8 — 보관분 오래됨·실패가 가려지지 않게).
 *  · 주기·보존·경로·알림도 중앙 값으로 바뀐다는 사실을 확인 문구가 **값과 함께** 말한다(엣지 코드를 바꾸지 않고 구버전 엣지가 받게 하려면 배포 키 전부를
 *    보내야 하기 때문 — 서버 settings.js 머리말). 숫자는 API 값(perEdgeBase)만 쓴다. 보존이 짧아지면 지워진 이력은 돌아오지 않는다(반증 F6).
 *  · 법인은 **저장 때 확정**한 목록이 내려간다 — 지금 매핑이 다르면 '법인 매핑이 바뀜 — 다시 확인 필요'(반증 F2·F3).
 *  · 엣지가 아닌 노드(중앙·단독)·역할을 모르는 노드에는 버튼을 주지 않는다(반증 F7 — 그 노드는 배포를 받지 않는다).
 */

/** 배포 현황에서 그 엣지의 행(대소문자 무시). 없으면 null. */
export function findDistRow(dist, agent) {
  const k = String(agent ?? '').trim().toLowerCase();
  if (!k) return null;
  return (dist?.rows || []).find((r) => String(r.agent || '').toLowerCase() === k) || null;
}

const INSTR_STATE = Object.freeze({
  'no-pull': { label: '켜기 지시됨 — 다음 인출 대기', tone: 'warn', why: '중앙에서 켜기를 저장했습니다 — 엣지가 다음 인출(기본 10분 주기)에 받습니다. 이 중앙이 시작한 뒤 이 엣지의 인출 기록은 아직 없습니다(2.627 미만 엣지는 이 배포를 받지 못합니다).' },
  pending: { label: '켜기 지시됨 — 다음 인출 대기', tone: 'warn', why: '중앙에서 켜기를 저장했습니다 — 엣지가 다음 인출(기본 10분 주기)에 받습니다.' },
  delivered: { label: '전달됨', tone: 'ok', why: '마지막 인출에서 중앙 켜기를 내려받았습니다 — 적용 확인은 다음 인출에 옵니다. 엣지 보관분은 다시 가져오면 켜진 상태로 바뀝니다.' },
  applied: { label: '적용됨', tone: 'ok', why: '엣지가 중앙 켜기를 적용했다고 알려 왔습니다.' },
  unverified: { label: DIST_STATE.unverified.label, tone: DIST_STATE.unverified.tone, why: DIST_STATE.unverified.why },
});

/**
 * 엣지 보관분 한 줄의 '중앙에서 켜기' 판단(순수).
 * @param {object} edgeRow  /tools/bm-usage/edges 의 행(enabledOnEdge · snapAt · nodeRole …)
 * @param {object|null} distRow  배포 현황 행(findDistRow) — 전체 범위 관리자 · 중앙에만 온다(그 밖에는 null)
 * @param {{canManage?:boolean}} [o]  canManage — 서버가 배포 현황을 줬는가(= 전체 범위 관리자 · 중앙)
 * @returns {{actions:string[], instr:object|null, note:string, offWhy:string}}
 *   actions — 보일 버튼('on' 켜기 · 'reconfirm' 다시 확인 · 'off' 해제) · instr — 보관분 상태와 **함께** 보일 지시 상태 ·
 *   note — 행 아래 사유 · offWhy — '엣지에서 꺼짐' 사유를 바꿀 문장(빈 값이면 기본 문장)
 */
export function edgeOnView(edgeRow = {}, distRow = null, { canManage = false } = {}) {
  const none = { actions: [], instr: null, note: '', offWhy: '' };
  if (!canManage || !distRow) return none;
  const offOnEdge = !!(edgeRow?.snapAt && edgeRow.enabledOnEdge === false);
  if (distRow.perEdge) {
    const out = { actions: ['off'], instr: null, note: '', offWhy: '' };
    if (distRow.conflict) {
      out.note = "제외와 중앙 켜기가 함께 저장돼 있습니다 — **제외가 우선**해 켜지 않습니다(장비 부하를 더하지 않는 쪽). '엣지에 배포' 표에서 제외를 해제하거나 중앙 켜기를 해제하세요.";
      return out;
    }
    if (distRow.mode === 'all') {
      out.note = '중앙 켜기가 저장돼 있지만 **전체 배포가 우선**합니다 — 지금은 전체 배포 값을 받습니다(전체 배포를 끄면 이 엣지만 켜기로 돌아갑니다).';
      return out;
    }
    out.instr = INSTR_STATE[distRow.state] ? { state: `edge-on-${distRow.state}`, ...INSTR_STATE[distRow.state] } : null;
    if (offOnEdge) out.offWhy = '그 엣지에서 수집이 꺼져 있습니다 — 엣지가 중앙 켜기를 받아 적용한 뒤 보관분을 다시 가져오면 켜진 상태로 바뀝니다.';
    if (distRow.corpsChanged === true) {
      out.actions = ['reconfirm', 'off'];
      out.note = '⚠ **법인 매핑이 바뀌었습니다 — 다시 확인 필요**: 저장한 법인과 지금 매핑이 다릅니다. 엣지는 저장한 법인을 계속 받습니다(매핑이 잠시 비어도 끄지 않습니다).';
    }
    return out;
  }
  if (distRow.state === 'releasing') {
    return { ...none, instr: { state: 'edge-on-releasing', label: '해제 대기', tone: 'warn', why: DIST_STATE.releasing.why } };
  }
  if (!offOnEdge) return none;
  // F5: 전체 배포가 끈 엣지 — 엣지 포탈은 배포 키가 잠겨 있고 중앙 켜기는 409 'all' 이다. 바꿀 곳은 배포 설정 하나다.
  if (distRow.mode === 'all') return { ...none, offWhy: '중앙의 **전체 배포 설정**이 끄고 있습니다 — 엣지에 배포 설정(이 화면 수집 설정)에서 바꾸세요.' };
  if (distRow.excluded) return { ...none, note: "이 엣지는 '엣지에 배포' 표에서 **제외**(자기 로컬 설정)로 지정돼 있습니다 — 중앙에서 켜려면 제외를 먼저 해제하세요." };
  // F7: 엣지가 아닌 노드(중앙·단독)·역할을 모르는 노드에는 버튼을 주지 않는다(사유는 edgePullState 가 역할로 말한다).
  if (edgeRow?.nodeRole !== 'edge') return none;
  return { ...none, actions: ['on'] };
}

const onOff = (v) => (v ? '켬' : '끔');
const minText = (ms) => { const m = Number(ms) / 60_000; return Number.isFinite(m) && m > 0 ? `${Math.round(m * 10) / 10}분` : '—'; };
const dayText = (d) => { const v = Number(d); return Number.isFinite(v) && v > 0 ? `${v}일` : '—'; };

/**
 * '중앙에서 켜기'(또는 '다시 확인') 확인 문구(줄 목록 · BoldText). 숫자는 서버가 준 perEdgeBase(실제로 내려갈 값)에서만 꺼낸다.
 * @param {{agent:string, distRow:object, dist:object, vcName?:(id:string)=>string, reconfirm?:boolean}} p
 */
export function edgeOnConfirmLines({ agent = '', distRow = null, dist = null, vcName = null, reconfirm = false } = {}) {
  const name = String(agent || distRow?.agent || '').trim();
  const ids = Array.isArray(distRow?.corps) ? distRow.corps : [];
  const label = (id) => (typeof vcName === 'function' ? (vcName(id) || id) : id);
  const lines = reconfirm
    ? [`**${name}** 의 중앙 켜기 법인을 **다시 확인**합니다 — 저장하면 엣지는 다음 인출(기본 10분 주기)에 새 법인 목록을 받습니다.`]
    : [`**${name}** 의 베어메탈 사용률 수집을 중앙에서 켭니다 — 엣지는 **다음 인출**(기본 10분 주기)에 받습니다(저장 즉시 켜지지 않습니다).`];
  if (reconfirm && Array.isArray(distRow?.savedCorps)) lines.push(`저장된 법인 ${distRow.savedCorps.length}곳: ${distRow.savedCorps.map(label).join(' · ') || '—'}`);
  if (distRow?.corps == null) lines.push('켜지는 법인: 중앙이 이 엣지의 법인을 아직 확인하지 못했습니다 — 화면을 새로 읽은 뒤 다시 시도하세요.');
  else if (!ids.length) lines.push('⚠ 중앙이 이 엣지의 법인을 찾지 못했습니다(등록부 담당 엣지 · 위임 인벤토리 · 엣지 보고 베어메탈 모두 없음) — **저장할 수 없습니다**(켤 대상이 없습니다).');
  else lines.push(`${reconfirm ? '지금 매핑' : '켜지는 법인'} **${ids.length}곳**: ${ids.map(label).join(' · ')} — 저장 때 이 목록으로 확정합니다(매핑이 나중에 바뀌어도 엣지는 이 목록을 받고, 화면이 다시 확인을 받습니다).`);
  const b = dist?.perEdgeBase || null;
  if (b) {
    const alert = b.alertEnabled ? `켬(${b.alertPct}% · ${b.alertSustainMin}분 지속 · ${b.alertRepeatHours}시간 재알림)` : '끔';
    lines.push(`⚠ **주기 · 보존 · OS SSH · iDRAC · 알림 값도 이 중앙의 값으로 바뀝니다** — 주기 ${minText(b.intervalMs)} · 원시 보존 ${dayText(b.rawRetentionDays)} · 일 롤업 ${dayText(b.dailyRetentionDays)}`
      + ` · OS SSH ${onOff(b.osSsh)} · iDRAC 텔레메트리 ${onOff(b.idracTelemetry)}(전수 ${onOff(b.idracFullTelemetry)}) · ESXi 호스트 포함 ${onOff(b.includeVirtualization)}`
      + ` · 귀속 없는 서버 ${b.includeUnassigned ? '포함' : '제외'} · 알림 ${alert}. **해제하면 엣지 로컬 설정으로 돌아갑니다.**`);
  } else {
    lines.push('⚠ **주기 · 보존 · OS SSH · iDRAC · 알림 값도 이 중앙의 값으로 바뀝니다**(해제하면 엣지 로컬 설정으로 돌아갑니다).');
  }
  // F6: 보존이 짧아지면 엣지가 넘친 이력을 정리한다 — 해제해도 지워진 이력은 돌아오지 않는다(엣지 보존 값은 중앙이 모른다).
  lines.push('⚠ 이 엣지의 보존 기간이 위 값보다 길면 넘친 이력은 정리되며, **해제해도 돌아오지 않습니다**.');
  lines.push(DIST_ENTERPRISE_NOTE);
  if (distRow?.tokenIssued === false) {
    lines.push('⚠ 이 엣지에는 **개별 토큰이 발급돼 있지 않습니다** — 중앙 켜기는 개별 토큰 인출에만 내려갑니다(공유 토큰은 이름을 검증할 수 없습니다). 토큰을 발급·적용해야 받습니다.');
  }
  return lines;
}

/** '중앙 켜기 해제' 확인 문구 — 해제 뒤 그 엣지가 실제로 쓰게 될 설정을 말한다(반증 F4). */
export function edgeOffConfirmLines(agent = '', distRow = null) {
  const name = String(agent).trim();
  if (distRow?.mode === 'all') return [`**${name}** 의 중앙 켜기 지시를 지웁니다 — 이 엣지는 **전체 배포가 계속 적용됩니다**(지금도 전체 배포 값을 받고 있습니다).`];
  if (distRow?.conflict) return [`**${name}** 의 중앙 켜기 지시를 지웁니다 — 이 엣지는 제외(자기 로컬 설정)로 동작하고 있어 바뀌는 설정은 없습니다.`];
  return [`**${name}** 의 중앙 켜기를 해제합니다 — 엣지는 다음 인출에 중앙 사본을 지우고 **엣지 로컬 설정**으로 돌아갑니다(로컬 설정이 꺼져 있으면 수집이 꺼집니다).`];
}

/** 저장 응답 한 줄 — 해제면 응답의 배포 현황으로 그 엣지가 이제 무엇을 받는지 말한다(전체 배포가 계속 적용되면 그렇게). */
export function edgeOnSavedText(r = {}, { reconfirm = false } = {}) {
  const name = String(r?.agent || '').trim();
  if (r?.on === false) {
    const row = findDistRow(r?.distribution, name);
    if (row?.mode === 'all') return `**${name}** 중앙 켜기 지시를 지웠습니다 — 이 엣지는 **전체 배포가 계속 적용됩니다**.`;
    return `**${name}** 중앙 켜기를 해제했습니다 — 엣지는 다음 인출(기본 10분 주기)에 엣지 로컬 설정으로 돌아갑니다.`;
  }
  if (reconfirm) return `**${name}** 중앙 켜기 법인을 다시 확인해 저장했습니다 — 엣지는 다음 인출(기본 10분 주기)에 새 목록을 받습니다.`;
  return `**${name}** 중앙 켜기를 저장했습니다 — 엣지는 다음 인출(기본 10분 주기)에 받습니다(저장 즉시 켜지지 않습니다).`;
}

export const DIST_ENTERPRISE_NOTE = 'Enterprise 대체 수집은 **배포하지 않습니다** — 장비 부하에 대한 동의는 각 엣지 관리자가 합니다.';

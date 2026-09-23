/**
 * commMapText.js — 통신 지도(중앙 ↔ 엣지 시각화)의 **문구·색 판정**(순수, vitest 고정, v2.584).
 *
 * 규칙:
 *  · 서버(`commmap/build.js`)가 `state` + `reasons`(코드)만 주고 문장은 여기서 만든다(v2.553 remedy 규약).
 *    `REASON_TEXT` 의 키 집합은 서버 `REASON_SEVERITY` 와 **1:1** 이어야 한다 — 서버 테스트가 이 파일을
 *    읽어 대조한다(한쪽만 늘면 화면이 코드를 그대로 보여준다).
 *  · **'기록 없음' 을 정상 색으로 칠하지 않는다** — `unknown` 은 회색이고, 이유(재시작 직후 등)를 말한다.
 *  · 입자(흐름)는 **마지막 두 조회 사이에 관측된 통신**만 그린다 — 관측이 없으면 선만 남는다(지어내지 않는다).
 *  · 백틱 금지(BoldText 는 `**강조**` 만 해석한다). 값 인용은 홑화살괄호 ‘ ’.
 */
import { agoText, elapsedText } from './relTime.js';

export const STATE_LABEL = Object.freeze({ ok: '정상', warn: '주의', fail: '장애', disabled: '비활성', unknown: '확인 불가' });
/** 색은 상태의 뜻이다 — `unknown`·`disabled` 는 초록도 빨강도 아니다. */
export const STATE_COLOR = Object.freeze({ ok: '#4ade80', warn: '#fbbf24', fail: '#f87171', disabled: '#475569', unknown: '#94a3b8' });

export const RES_KIND_LABEL = Object.freeze({ vcenter: 'vCenter', storage: '스토리지', sanswitch: 'SAN 스위치', pdu: 'PDU' });
export const RES_KIND_ICON = Object.freeze({ vcenter: '◆', storage: '▣', sanswitch: '⋈', pdu: '⚡' });
export const RES_STATE_LABEL = Object.freeze({
  ok: '수신 정상', stale: '낡음(push 끊김)', pending: '첫 수집 대기', fail: '연결 실패', maintenance: '점검중', disabled: '비활성',
  registered: '등록됨(등록부 기준)',
});
/** 자원 색 — 장비(스토리지·SAN·PDU)는 등록부만 보므로 `registered` 는 중립색이다(정상이라 말하지 않는다). */
export const RES_STATE_COLOR = Object.freeze({
  ok: '#4ade80', stale: '#fbbf24', pending: '#94a3b8', fail: '#f87171', maintenance: '#a78bfa', disabled: '#475569', registered: '#7dd3fc',
});

export const PULL_LABEL = Object.freeze({ ok: '정상', degraded: '저하(1회 실패)', fail: '실패', none: '기록 없음' });
export const PUSH_LABEL = Object.freeze({ ok: '수신 중', stale: '낡음', rejected: '거부됨', none: '기록 없음' });

/**
 * 사유 코드 → {title, fix}. ⚠ 서버 `REASON_SEVERITY` 와 키 집합 동일(테스트 대조). 문구에 ` — ` 3단 금지.
 */
export const REASON_TEXT = Object.freeze({
  'disabled': { title: '등록부에서 비활성으로 둔 엣지입니다.', fix: '수집이 필요하면 설정 › 수집 서버에서 활성으로 바꾸세요.' },
  'pull-fail': { title: '중앙이 이 엣지의 export 를 당기지 못하고 있습니다(연속 실패).', fix: '엣지 포탈이 떠 있는지, 중앙에서 그 주소·포트가 열려 있는지 확인하세요. 통신 점검 화면이 어느 단계에서 막혔는지 보여줍니다.' },
  'pull-auth': { title: '중앙이 보낸 수집 토큰을 엣지가 거부했습니다(401/403).', fix: '포탈 점검 › 토큰 점검에서 중앙 등록값과 엣지 저장값을 대조하세요. 다시 눌러도 같은 결과입니다.' },
  'pull-degraded': { title: '직전 pull 한 번이 실패했습니다(직전 데이터를 유지 중).', fix: '다음 주기에서 회복되면 정상으로 돌아옵니다. 두 번 연속 실패하면 장애로 바뀝니다.' },
  'pull-none': { title: '중앙이 이 엣지를 아직 당긴 기록이 없습니다.', fix: '중앙이 방금 재시작했으면 한 주기 안에 채워집니다. 그 뒤에도 비어 있으면 등록 URL 을 확인하세요.' },
  'pull-identity': { title: '이 URL 에 응답한 엣지의 이름이 등록 항목과 다릅니다.', fix: '포트포워딩이 다른 엣지로 가거나 자기등록 URL 이 중계 엣지를 가리킵니다. 수집 서버 진단 모달을 여세요.' },
  'push-rejected': { title: '이 이름으로 온 push 가 마지막 정상 수신 뒤에 거부됐습니다.', fix: '거부 종류(토큰 불일치·목 차단·소유권 충돌)를 상세에서 보세요. 거부된 요청의 이름은 검증되지 않은 값입니다.' },
  'push-stale': { title: '엣지 → 중앙 push 가 평소 간격보다 오래 끊겼습니다.', fix: '엣지 로그 화면에서 push 워커의 마지막 실패 사유를 보세요. 중앙 화면은 그동안 낡은 값을 보여줍니다.' },
  'push-none': { title: '엣지 → 중앙 push 수신 기록이 없습니다(위임 자원도 없음).', fix: '위임 자원이 없는 엣지는 push 가 없어도 이상이 아닙니다. 수신 통계는 중앙 재시작 시 초기화됩니다.' },
  'push-none-expected': { title: '위임 자원이 있는데 엣지 → 중앙 push 수신 기록이 없습니다.', fix: '중앙 재시작 직후면 첫 push 를 기다리세요. 계속 비어 있으면 엣지의 CENTRAL_URL·CENTRAL_TOKEN 과 엣지 로그를 확인하세요.' },
  'link-fail': { title: '통신 점검(중앙 → 엣지)의 최신 판정이 실패입니다.', fix: '통신 점검 화면에서 막힌 단계(DNS·TCP·TLS·HTTP·인증)를 확인하세요.' },
  'edge-report-stale': { title: '엣지가 올린 통신 점검 보고가 오래됐습니다.', fix: '엣지의 점검 워커가 멈췄거나 개별 토큰이 아닙니다(공유 토큰은 이 보고를 올릴 수 없습니다).' },
  'mock': { title: '이 엣지는 목(데모) 데이터로 응답하고 있습니다.', fix: '운영 엣지라면 DATA_SOURCE 설정을 확인하세요. 목 엣지의 push 는 중앙이 차단합니다.' },
  'puller-off': { title: '중앙의 수집 서버 pull 주기가 0(꺼짐)입니다.', fix: 'COLLECTOR_PULL_INTERVAL_MS 를 확인하세요. 꺼져 있으면 중앙 → 엣지 방향은 측정되지 않습니다.' },
});
export const REASON_CODES = Object.freeze(Object.keys(REASON_TEXT));

export const num = (v) => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };

export const ageText = (ts, now = Date.now()) => agoText(ts, now, { dash: '없음', subMinute: 'seconds' });
export const durText = (ms) => elapsedText(ms, { dash: '—', subMinute: 'seconds' });
/** 기간(길이) 표기 — ‘N초 전’ 이 아니라 ‘N초’ 다(주기·경계처럼 시점이 아닌 값에 쓴다). null 은 ‘—’. */
export function spanText(ms) {
  const n = num(ms);
  if (n == null || n < 0) return '—';
  if (n < 60_000) return `${Math.round(n / 1000)}초`;
  if (n < 3_600_000) { const m = n / 60_000; return `${Number.isInteger(m) ? m : m.toFixed(1)}분`; }
  const h = n / 3_600_000; return `${Number.isInteger(h) ? h : h.toFixed(1)}시간`;
}

/** 바이트 — ⚠ null 은 '0 B' 가 아니라 '—' 다(측정값 규약). */
export function bytesText(b) {
  const n = num(b);
  if (n == null) return '—';
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** 엣지 한 줄 요약(툴팁·상세 머리말). */
export function edgeSummary(e, now = Date.now()) {
  if (!e) return '';
  const parts = [`${STATE_LABEL[e.state] || e.state}`];
  parts.push(`pull ${PULL_LABEL[e.pull?.state] || '—'}${e.pull?.at ? ` (${ageText(e.pull.at, now)})` : ''}`);
  parts.push(`push ${PUSH_LABEL[e.push?.state] || '—'}${e.push?.lastAt ? ` (${ageText(e.push.lastAt, now)})` : ''}`);
  if (e.resourceCounts?.total) parts.push(`위임 ${e.resourceCounts.total}개`);
  return parts.join(' · ');
}

/** 자원 한 줄(툴팁). vCenter 는 스냅샷 상태, 장비는 등록부 기준임을 밝힌다. */
export function resourceSummary(r, now = Date.now()) {
  if (!r) return '';
  const kind = RES_KIND_LABEL[r.kind] || r.kind;
  const st = RES_STATE_LABEL[r.state] || r.state;
  const bits = [`${kind} ${r.name}`, st];
  if (r.kind === 'vcenter') {
    if (r.receivedAt) bits.push(`마지막 수신 ${ageText(r.receivedAt, now)}`);
    if (r.hosts != null || r.vms != null) bits.push(`호스트 ${r.hosts ?? '—'} · VM ${r.vms ?? '—'}`);
    if (r.agentMismatch) bits.push(`담당 등록 ‘${r.remoteAgent}’ 인데 실제 push 는 ‘${r.collectedBy}’`);
  } else if (r.type) bits.push(r.type);
  return bits.join(' · ');
}

/**
 * 상단 배너 — 화면이 '지금 무엇을 보고 있는가' 를 한 번만 말한다(패널마다 반복 금지, v2.509).
 * 우선순위: 수집 서버 0 → 전부 unknown(재시작 직후) → 장애 있음 → 주의 있음 → 정상.
 */
export function headerNote(data, now = Date.now()) {
  if (!data) return { tone: 'muted', text: '' };
  const c = data.counts || {}; const by = c.byState || {};
  if (!c.edges) return { tone: 'muted', text: '등록된 수집 서버(엣지)가 없습니다. 설정 › 수집 서버에서 엣지를 등록하면 이 지도에 나타납니다. 중앙이 직접 수집하는 자원은 허브 옆에 표시됩니다.' };
  const bits = [];
  if (by.fail) bits.push(`**장애 ${by.fail}곳**`);
  if (by.warn) bits.push(`주의 ${by.warn}곳`);
  if (by.unknown) bits.push(`확인 불가 ${by.unknown}곳`);
  if (by.disabled) bits.push(`비활성 ${by.disabled}곳`);
  const live = (by.ok || 0) + (by.warn || 0) + (by.fail || 0);
  let text;
  if (live === 0 && by.unknown) text = `엣지 ${c.edges}곳 전부 ‘확인 불가’ 입니다 — 중앙이 재시작한 직후면 pull 기록은 한 주기(${spanText(data.hub?.pullIntervalMs)}) 안에 채워지고 push 기록은 각 엣지의 다음 push 에 채워집니다. 그 뒤에도 비어 있으면 등록 URL·토큰을 보세요.`;
  else if (by.fail) text = `엣지 ${c.edges}곳 중 ${bits.join(' · ')}. 장애 엣지의 법인은 중앙 화면이 **낡은 값**을 보여주고 있을 수 있습니다 — 노드를 눌러 어느 방향이 막혔는지 보세요.`;
  else if (by.warn || by.unknown) text = `엣지 ${c.edges}곳 중 ${bits.join(' · ')}. 노드를 누르면 사유와 조치가 나옵니다.`;
  else text = `엣지 ${c.edges}곳 모두 pull·push 가 정상입니다(마지막 조회 ${ageText(data.at, now)}).`;
  if (c.unassigned) text += ` 담당 엣지를 알 수 없는 자원 ${c.unassigned}개는 그래프에 붙이지 않고 아래 목록에 두었습니다.`;
  return { tone: by.fail ? 'red' : (by.warn || by.unknown) ? 'amber' : 'green', text };
}

/**
 * 두 조회 사이의 통신 관측(입자 흐름 근거). ⚠ 첫 조회는 비교 대상이 없어 **전부 false** 다 — 그것이 정직하다.
 *  pull: pull.at 이 바뀌었다(중앙이 그 사이 엣지를 당겼다)  push: pushes 가 늘었다(엣지가 올렸다)
 */
export function activityOf(prev, cur) {
  const out = {};
  if (!cur) return out;
  for (const e of cur.edges || []) {
    const p = prev?.edges?.find?.((x) => x.id === e.id) || null;
    out[e.id] = {
      pull: !!(p && e.pull?.at != null && p.pull?.at != null && e.pull.at !== p.pull.at) || !!(p && p.pull?.at == null && e.pull?.at != null),
      push: !!(p && num(e.push?.pushes) != null && num(p.push?.pushes) != null && e.push.pushes > p.push.pushes),
    };
  }
  return out;
}

/** 범례·각주(표 아래 1회). */
export const LEGEND_NOTES = Object.freeze([
  '선 두 가닥: 바깥쪽이 **중앙 → 엣지 pull**(수집 서버 export, 주기는 서버 설정), 안쪽이 **엣지 → 중앙 push**(인벤토리·스토리지·SAN·PDU 등). 색은 그 방향의 상태입니다.',
  '흐르는 점은 **마지막 두 조회(15초) 사이에 관측된 통신**만 그립니다. 점이 없어도 통신이 없다는 뜻은 아닙니다(주기가 15초보다 길 수 있습니다).',
  '바깥 링의 vCenter 색은 스냅샷 상태(수신 정상·낡음·대기·실패)이고, 스토리지·SAN·PDU 는 **등록부 기준**이라 정상이라는 뜻이 아닙니다.',
  '수신 통계·pull 상태는 중앙 메모리에만 있어 **중앙 재시작 시 초기화**됩니다. 그때 ‘확인 불가’ 는 장애가 아닙니다.',
]);

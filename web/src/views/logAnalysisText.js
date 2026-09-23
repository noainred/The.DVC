/**
 * 설정 › Log › 로그 분석 — 판정·문구(v2.583, 순수 · vitest 로 고정).
 *
 * 사용자 요청: "지금 분석하고 있는 로그를 분석해서 개선점 도출할 수 있는 메뉴와 기능을 설정에 만들어줘".
 * 규약:
 *  · **분석한 구간 밖을 말하지 않는다** — 구간(coverage)을 배너가 먼저 말한다. 누적이 요청 구간보다
 *    늦게 시작했으면 '그 앞은 모른다' 고 적는다.
 *  · 저널 읽기 실패를 '로그 없음' 이라 말하지 않는다 — 사유별로 조치가 다르다(권한 / journalctl 없음 / 중복 실행).
 *  · 수준이 없는 원천(저널·붙여넣기)에서 '경고·오류 0' 이라 말하지 않는다 — '수준 정보 없음' 이다.
 *  · 문구에 백틱 금지(BoldText 는 **강조** 만 해석한다 — 백틱은 글자로 샌다).
 */

export const SEVERITY = {
  critical: { label: '심각', color: 'red' },
  high: { label: '높음', color: 'red' },
  medium: { label: '보통', color: 'amber' },
  low: { label: '낮음', color: 'gray' },
  info: { label: '정보', color: 'gray' },
};

import { numOrNull } from '../numOrNull.js';

export const SOURCES = [
  { k: 'live', label: '누적(이 포탈)', help: '이 포탈이 찍은 로그를 들어오는 순간 시간 단위로 집계한 것입니다(최대 7일, 재시작해도 이어집니다).' },
  { k: 'buffer', label: '최근 로그(메모리)', help: '메모리에 남아 있는 최근 로그 1,000줄입니다. 요청 로그가 섞여 몇 분이면 밀려납니다.' },
  { k: 'journal', label: '서비스 저널', help: '이 서버의 systemd 저널을 포탈이 직접 읽습니다(폐쇄망에서 반출 없이 분석).' },
  { k: 'paste', label: '붙여넣기', help: '다른 서버(엣지 등)의 journalctl·tail 출력을 붙여넣어 분석합니다.' },
  { k: 'edge', label: '엣지 로그', help: '특수기능 › 엣지 로그에서 가져온 엣지의 최근 로그 보관분을 분석합니다.' },
];

// v2.589: Number(null)===0 이라 '읽지 못한 줄 수' 가 0 으로 보였다 — numOrNull 로 먼저 좁힌다.
const fmt = (n) => { const v = numOrNull(n); return v == null ? '—' : v.toLocaleString(); };
const dt = (t) => (Number.isFinite(Number(t)) && t ? new Date(Number(t)).toLocaleString('ko-KR') : '');

/** 구간 배너 — {tone:'ok'|'warn'|'bad', text} */
export function coverageText(cov) {
  const c = cov || {};
  const lines = fmt(c.lines);
  const span = c.firstRaw || c.lastRaw
    ? ` · 로그 시각 ${c.firstRaw || '?'} ~ ${c.lastRaw || '?'}`
    : (c.first && c.last ? ` · ${dt(c.first)} ~ ${dt(c.last)}` : '');
  if (c.source === 'live') {
    if (c.enabled === false) return { tone: 'bad', text: '누적 집계가 꺼져 있습니다(LOGANALYSIS_LIVE=0). 다른 원천을 쓰세요.' };
    const parts = [`최근 ${fmt(c.hours)}시간 · 분석 ${lines}줄${span}`];
    if (c.partial) parts.push(c.trackingSince ? `누적은 ${dt(c.trackingSince)} 부터라 그 앞은 모릅니다` : '아직 누적된 로그가 없습니다');
    if (c.status?.loadError) parts.push(`저장된 누적을 읽지 못해 새로 시작했습니다(${c.status.loadError})`);
    if (c.status?.lastSaveError) parts.push(`누적 저장 실패: ${c.status.lastSaveError}`);
    return { tone: c.partial || c.status?.loadError || c.status?.lastSaveError ? 'warn' : 'ok', text: parts.join(' · ') };
  }
  if (c.source === 'buffer') return { tone: 'warn', text: `메모리의 최근 로그 ${fmt(c.bufferLines)}줄(요청 로그 포함) · 분석 ${lines}줄${span} — 몇 분 분량이라 추세 판단에는 누적을 쓰세요` };
  if (c.source === 'journal') {
    if (c.ok === false) return { tone: 'bad', ...journalFailText(c) };
    const parts = [`서비스 저널(${c.unit}) 최근 ${fmt(c.hours)}시간 · 분석 ${lines}줄${span}`];
    if (!c.lines) parts.push('이 구간에 이 유닛의 기록이 없습니다(유닛 이름이 다르면 PORTAL_SYSTEMD_UNIT 로 지정)');
    if (c.truncated) parts.push('상한(줄·용량·시간)에 걸려 앞부분만 읽었습니다');
    if (c.warning) parts.push(`경고: ${c.warning}`);
    return { tone: c.truncated || c.warning ? 'warn' : 'ok', text: parts.join(' · ') };
  }
  if (c.source === 'paste') {
    const parts = [`붙여넣은 ${fmt(c.inputLines)}줄 중 분석 ${lines}줄${span}`];
    if (c.continuation) parts.push(`스택 추적 연속 줄 ${fmt(c.continuation)}줄은 앞 줄에 붙였습니다`);
    if (c.dropped) parts.push(`상한으로 앞쪽 ${fmt(c.dropped)}줄을 버렸습니다`);
    return { tone: c.dropped ? 'warn' : 'ok', text: parts.join(' · ') };
  }
  if (c.source === 'edge') {
    const parts = [`엣지 ${c.agent} 의 로그 보관분(${dt(c.fetchedAt) || '시각 미상'} 가져옴) · 분석 ${lines}줄${span}`];
    if (c.truncated || c.omitted) parts.push(`엣지가 잘라 보냈습니다${c.omitted ? `(${fmt(c.omitted)}줄 생략)` : ''}`);
    if (c.centralCapped) parts.push('중앙 보관 상한으로 일부만 남아 있습니다');
    return { tone: c.truncated || c.omitted || c.centralCapped ? 'warn' : 'ok', text: parts.join(' · ') };
  }
  return { tone: 'ok', text: `분석 ${lines}줄${span}` };
}

/** 저널 읽기 실패 — 사유별 조치. */
export function journalFailText(c) {
  const unit = c?.unit || 'vmware-portal';
  switch (c?.reason) {
    case 'permission':
      return { text: `서비스 계정이 시스템 저널을 읽을 권한이 없습니다(빈 결과는 '로그 없음' 이 아닙니다). 조치: 서버에서 서비스 계정을 systemd-journal 그룹에 넣고(usermod -aG systemd-journal <계정>) 서비스를 재시작하세요. 그 전까지는 누적 또는 붙여넣기를 쓰세요.`, hint: c.detail || '' };
    case 'no-journal':
      return { text: '이 서버에는 저널 파일이 없습니다(journald 가 없거나 이 유닛의 기록을 남기지 않는 환경). 누적 또는 붙여넣기를 쓰세요.', hint: c.detail || '' };
    case 'no-journalctl':
      return { text: 'journalctl 이 없습니다 — systemd 가 아닌 환경입니다. 누적 또는 붙여넣기를 쓰세요.', hint: '' };
    case 'busy':
      return { text: '다른 사용자가 저널을 읽는 중입니다. 잠시 뒤 다시 누르세요.', hint: '' };
    default:
      return { text: `저널을 읽지 못했습니다(${unit}): ${c?.detail || c?.reason || '원인 미상'}`, hint: '' };
  }
}

/** KPI — 원천에 수준이 없으면 경고·오류를 세지 않는다('0' 이라 말하지 않는다). */
export function kpis(report) {
  const r = report || {};
  const lv = r.levels || {};
  const hasLevels = (lv.info || 0) + (lv.warn || 0) + (lv.error || 0) > 0;
  const fc = r.findingCounts || {};
  return {
    lines: r.coverage?.lines ?? null,
    hasLevels,
    warn: hasLevels ? (lv.warn || 0) : null,
    error: hasLevels ? (lv.error || 0) : null,
    urgent: (fc.critical || 0) + (fc.high || 0),
    medium: fc.medium || 0,
    minor: (fc.low || 0) + (fc.info || 0),
    // 요청 로그가 한 줄도 없으면 5xx 는 '0건' 이 아니라 '측정 없음'(null)이다.
    http5xx: r.http?.total ? (r.http.err5xx ?? 0) : null,
  };
}

/** 대상 칩 문구. */
export function entityText(e) {
  if (!e) return '';
  const extra = [];
  if (e.sharePct != null) extra.push(`${e.sharePct}%`);
  if (e.maxMs) extra.push(`최대 ${fmt(e.maxMs)}ms`);
  if (e.rid) extra.push(`요청 ID ${e.rid}`);
  return `${e.name} ×${fmt(e.count)}${extra.length ? ` (${extra.join(' · ')})` : ''}`;
}

/** 개선점 필터(심각도 이상). */
export function filterFindings(findings, minSeverity = 'info') {
  const rank = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };
  const min = rank[minSeverity] || 1;
  return (findings || []).filter((f) => (rank[f.severity] || 0) >= min);
}

/** 붙여넣기 안내 — 폐쇄망에서 다른 서버 로그를 이 화면에 넣는 명령(8MB 상한). */
export const PASTE_HINT = [
  'journalctl -u vmware-portal --since -24h -o short-iso --no-pager | grep -v "gpu-guest-data 수신" | tail -n 50000',
  'journalctl -u vmware-portal --since -24h -o short-iso --no-pager | grep -E "실패|오류|거부|불일치|fatal|413|5[0-9][0-9] " | tail -n 20000',
];

/** 규칙 목록 머리말(v2.583) — 코어·카탈로그 개수를 밝힌다. */
export function ruleListNote(rules = []) {
  const list = Array.isArray(rules) ? rules : [];
  const core = list.filter((r) => r.origin === 'core').length;
  const cat = list.filter((r) => r.origin === 'catalog').length;
  const edge = list.filter((r) => r.edge).length;
  const head = `이 화면이 쓰는 규칙 ${list.length}개입니다`;
  const parts = [];
  if (core || cat) parts.push(`직접 작성 ${core}개 · 코드 전수 스캔 ${cat}개`);
  if (edge) parts.push(`엣지 로그에서만 찍히는 문장 ${edge}개`);
  return `${head}${parts.length ? `(${parts.join(' · ')})` : ''}. 각 규칙은 그 문장을 찍는 소스 위치를 갖고, 문구가 바뀌면 테스트가 깨지게 되어 있습니다.`;
}

/** 규칙 출처 칸 — 코어/카탈로그 + 엣지 전용 표시. */
export function ruleOriginText(r = {}) {
  const base = r.origin === 'catalog' ? '코드 스캔' : r.origin === 'core' ? '직접 작성' : '—';
  return r.edge ? `${base} · 엣지` : base;
}

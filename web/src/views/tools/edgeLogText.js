/**
 * views/tools/edgeLogText.js — 엣지 로그·진행상태 화면의 **판정과 문구**(순수, v2.549).
 *
 * 사용자 요청(2026-09-17): "진행상태를 edge 의 로그를 읽어와서 확인할 수 있는 기능 만들어줘".
 * 웹 테스트가 node 환경(DOM 없음)이라 판정·문구는 여기서 vitest 로 고정한다
 * (`components/accessDeniedText.js`·`version_4/loadState.js` 와 같은 관례).
 *
 * ── 이 화면이 만들 수 있는 거짓 5가지 — 전부 여기서 막는다 ────────────────────
 *  ① **'보관분 없음' 을 '안 된다' 라고 말하지 않는다.** 이 기능은 상시 폴링하지 않고 사람이 누를
 *     때만 엣지로 간다 — 아무것도 없는 것이 **정상 초기 상태**다.
 *  ② **'로그가 비었다' 를 '아무 일도 없었다' 라고 말하지 않는다.** 콘솔 링버퍼는 상한이 있고
 *     **재시작하면 사라진다**. `oldestId`·`node.startedAt` 으로 '이미 밀려났다' 와 구분한다.
 *  ③ **상태를 못 읽은 항목을 '꺼짐' 이라 말하지 않는다**(`ok:false` 는 '확인 불가' 다 —
 *     v2.519·v2.523·v2.548 규약과 같다).
 *  ④ **보관소가 비었을 때 '재시작해서 비었다' 와 '한 번도 안 가져왔다' 를 구분한다**(`store.sinceAt`).
 *  ⑤ **실패 원인을 한 문구로 덮지 않는다** — 토큰 불일치·구버전·연결 실패는 조치가 정반대다
 *     (v2.517 `perfDiagText` 와 같은 판단).
 *
 * ⚠ 주기·상한 **숫자를 문구에 박지 말 것** — 서버가 주는 값(`limits`·`store`·`jobs`)만 쓴다.
 */

import { agoText as _ago, elapsedText as _elapsed } from './relTime.js';
import { numOrNull } from '../../numOrNull.js';

const t = (v) => String(v ?? '').trim();
/**
 * ⚠ **`v == null` 을 먼저 본다** — `Number(null) === 0` 이라 `Number.isFinite(Number(v))` 만 보면
 *   결측이 **0 으로 둔갑**한다(v2.525 Horizon 규약. v2.549 초판이 실제로 그랬고 자체 테스트가 잡았다 —
 *   `msText(null)` 이 '0ms' 를 돌려줬다).
 */
const n = numOrNull;   // v2.576: 사본 금지 — 코어는 하나다(사본은 Number([])===0 을 막지 못했다)

/** 엣지 행 상태 라벨·색. ⚠ `ready` 는 '아직 안 가져옴' 이지 이상이 아니다. */
export const EDGE_KIND_LABEL = Object.freeze({
  have: '보관분 있음',
  ready: '아직 안 가져옴',
  failed: '마지막 시도 실패',
  'old-version': '구버전 엣지',
  'unknown-version': '버전 미상',
  disabled: '중앙에서 비활성',
  'no-url': 'URL 없음',
});
export const EDGE_KIND_TONE = Object.freeze({
  have: 'ok', ready: 'idle', failed: 'bad',
  'old-version': 'warn', 'unknown-version': 'warn', disabled: 'idle', 'no-url': 'warn',
});

/** 톤 → CSS 변수(다른 도구와 같은 팔레트). */
export function toneVar(tone) {
  if (tone === 'ok') return 'var(--ok, #4ade80)';
  if (tone === 'warn') return 'var(--warn, #fbbf24)';
  if (tone === 'bad') return 'var(--bad, #f87171)';
  return 'var(--muted, #94a3b8)';
}

/** 경과 시간 — `null` 은 '—' 다(0 으로 만들지 않는다). */
/**
 * ⚠ v2.574 IMP-03 — 문구는 **공용 코어 `relTime.js`** 가 소유한다. 아래는 호출부 호환을 위한
 *   위임 껍데기다. v2.573 까지 9벌이 각자 구현이었고 **실제로 갈라져 있었다**
 *   (90초 → `2분 전` 7벌 vs `1분 전` 2벌 · 결측 `—` 6벌 / `null` 2벌 / `없음` 1벌).
 *   ⚠ 새 상대시각 문구를 만들지 말 것 — `agoText`(타임스탬프)·`elapsedText`(경과 ms) 를 쓴다.
 */
export const ageText = (ts, now = Date.now()) => _ago(ts, now, { subMinute: 'seconds' });

/** 소요 시간. */
export function msText(ms) {
  const v = n(ms);
  if (v == null) return '—';
  return v < 1000 ? `${v}ms` : `${(v / 1000).toFixed(1)}초`;
}

/**
 * 한 엣지 행의 '지금 무엇을 하면 되나'. `kind` 마다 **조치가 다르다**.
 * @returns {{kind:string, label:string, tone:string, text:string, can:boolean}}
 *   `can` = '지금 가져오기' 버튼을 눌러 볼 만한가.
 */
export function edgeHint(row = {}, { minVersion = '' } = {}) {
  const kind = t(row.kind) || 'ready';
  const label = EDGE_KIND_LABEL[kind] || kind;
  const tone = EDGE_KIND_TONE[kind] || 'idle';
  const base = { kind, label, tone };
  if (kind === 'disabled') return { ...base, can: false, text: '설정 › 수집 서버에서 이 엣지를 **비활성**으로 두었습니다. 활성화해야 가져올 수 있습니다.' };
  if (kind === 'no-url') return { ...base, can: false, text: '이 수집 서버에 **URL 이 없습니다** — 설정 › 수집 서버에서 주소를 넣으세요.' };
  if (kind === 'old-version') return { ...base, can: false, text: `이 엣지는 **v${minVersion} 미만**이라 로그를 내주는 경로가 없습니다. 눌러도 실패합니다 — 엣지를 업그레이드하세요.` };
  if (kind === 'unknown-version') return { ...base, can: true, text: '이 엣지의 **버전을 모릅니다**(아직 중앙에 수집 결과를 준 적이 없습니다). 눌러 보면 되는지 알 수 있습니다 — 구버전이면 그렇다고 답합니다.' };
  if (kind === 'failed') {
    const keep = row.hasData ? ' 이전에 가져온 보관분은 남아 있습니다 — **지금 상태가 아닙니다**.' : ' 보관된 로그는 없습니다.';
    return { ...base, can: true, text: `마지막 시도가 실패했습니다 — ${t(row.last?.error) || '사유 미상'}.${keep}` };
  }
  if (kind === 'have') return { ...base, can: true, text: '보관분이 있습니다. 지금 눌러 최신으로 갱신할 수 있습니다.' };
  return { ...base, can: true, text: '아직 가져온 적이 없습니다 — **이상이 아닙니다**. 이 기능은 누를 때만 엣지로 갑니다.' };
}

/** pull 실패 `kind` → 사람이 할 일. ⚠ 한 문구로 덮지 말 것(조치가 정반대다). */
export const FETCH_KIND_TEXT = Object.freeze({
  'not-registered': '수집 서버 등록부에 없는 이름입니다 — 설정 › 수집 서버에서 등록하세요.',
  'disabled-central': '중앙에서 이 수집 서버를 **비활성**으로 두었습니다.',
  'no-url': '이 수집 서버에 **URL 이 없습니다**.',
  auth: '수집 서버 **토큰 불일치** 입니다 — 중앙 등록값과 그 엣지의 **COLLECTOR_TOKEN** 을 대조하세요. 다시 눌러도 결과는 같습니다.',
  disabled: '그 엣지에서 **수집 서버 기능이 꺼져 있습니다**(토큰 미설정) — 엣지의 **COLLECTOR_TOKEN** 을 설정하세요.',
  'old-version': '그 엣지에 로그 경로가 없습니다 — **업그레이드**해야 합니다.',
  timeout: '**응답이 없어 시한을 넘겼습니다**. 회선이 느리거나 엣지가 바쁩니다.',
  unreachable: '중앙에서 그 엣지로 **닿지 못했습니다**(방화벽·주소·정지).',
  http: '엣지가 오류 상태코드로 답했습니다.',
  'bad-body': '응답 형식이 다릅니다 — 엣지가 아닌 서버(프록시·로드밸런서)에 닿았을 수 있습니다.',
  error: '요청 처리 중 오류가 났습니다.',
});

/**
 * 가져오기 결과 문구.
 * ⚠ 실패했는데 보관분이 남아 있으면 **그 값이 방금 것이 아님**을 반드시 말한다(거짓 신선 금지).
 */
export function fetchResultText(res = {}, { now = Date.now() } = {}) {
  if (res.ok) {
    const c = n(res.snap?.logs?.count);
    return { tone: 'ok', text: `가져왔습니다 — 로그 ${c == null ? '?' : c}줄 · ${msText(res.ms)}` };
  }
  const kind = t(res.kind) || 'error';
  const why = FETCH_KIND_TEXT[kind] || t(res.reason) || '원인을 알 수 없습니다.';
  const parts = [why];
  if (t(res.reason) && !FETCH_KIND_TEXT[kind]) parts.length = 0, parts.push(t(res.reason));
  else if (t(res.reason) && (kind === 'http' || kind === 'error')) parts.push(`(${t(res.reason)})`);
  if (res.queued) parts.push('**폴백 요청을 등록했습니다** — 엣지는 항상 자기가 먼저 나가므로, 인출하면 자동으로 채워집니다. 잠시 뒤 새로고침하세요.');
  if (res.snap?.at) parts.push(`아래에 보이는 것은 **${ageText(res.snap.at, now)} 가져온 보관분**이고 지금 상태가 아닙니다.`);
  return { tone: 'bad', text: parts.join(' ') };
}

/**
 * 마지막 시도가 실패였을 때의 안내. ⚠ 실패 기록은 **보관분이 아니다** — 보여줄 값과 분리해 말한다.
 */
export function lastAttemptNote(a, { now = Date.now() } = {}) {
  if (!a || a.ok !== false) return '';
  return `마지막 시도(${ageText(a.at, now)})는 **실패**했습니다 — ${t(a.error) || '사유 미상'}`;
}

/** 폴백 대기 상태. `none` 은 문구를 만들지 않는다(없는 말을 화면에 띄우지 않는다). */
export function jobText(job = {}, { now = Date.now(), jobs = {} } = {}) {
  const st = t(job.state);
  if (st === 'pending') return `폴백 요청 대기 중(${ageText(job.at, now)} 등록) — 엣지가 인출하면 회신합니다.`;
  if (st === 'claimed') {
    const left = n(job.deadline) ? Math.max(0, job.deadline - now) : null;
    const tries = n(job.tries);
    return `엣지가 요청을 **인출했습니다**${tries ? `(${tries}회차)` : ''} — 회신 대기${left != null ? ` ${Math.ceil(left / 1000)}초` : ''}.`
      + (n(jobs.maxTries) && tries && tries >= jobs.maxTries ? ' 이번이 마지막 시도입니다.' : '');
  }
  return '';
}

/**
 * 보관소 자체에 대한 사실. ⚠ **비어 있는 이유를 단정하지 않는다**.
 * @returns {{kind:'empty-fresh'|'empty-restarted'|'have', text:string}}
 */
export function storeNote(store = {}, { rows = [], now = Date.now() } = {}) {
  const agents = n(store.agents) || 0;
  const since = n(store.sinceAt);
  const upMs = since ? Math.max(0, now - since) : null;
  if (agents > 0) {
    return { kind: 'have', text: `보관분은 **메모리에만** 있습니다 — 포탈을 재시작하면 사라지고 엣지 원본은 그대로입니다. 엣지당 최근 ${n(store.keepPerAgent) ?? '?'}건까지 보관합니다.` };
  }
  // 비어 있다 — '한 번도 안 가져왔다' 와 '재시작해서 비었다' 를 구분한다.
  const recent = upMs != null && upMs < 10 * 60_000;
  if (recent) return { kind: 'empty-restarted', text: `보관분이 없습니다. 이 포탈이 **${ageText(since, now)} 시작**했고 보관분은 메모리에만 있으므로, 재시작 전에 가져온 것은 남아 있지 않습니다. 필요한 엣지에서 '지금 가져오기' 를 누르세요.` };
  return { kind: 'empty-fresh', text: `아직 아무 엣지에서도 가져오지 않았습니다 — **이상이 아닙니다**. 이 기능은 상시 수집하지 않고 누를 때만 엣지로 갑니다(대상 ${rows.length}곳).` };
}

/**
 * 로그 구획의 머리말. ⚠ **'비었다' 를 '아무 일도 없었다' 로 말하지 않는다.**
 */
export function logNote(snap = {}, { limits = {} } = {}) {
  const logs = snap.logs || null;
  if (!logs) return { tone: 'idle', text: '이 보관분에는 로그가 담겨 있지 않습니다.' };
  const count = n(logs.count) || 0;
  const parts = [];
  if (!count) {
    parts.push('로그 줄이 없습니다 — **아무 일도 없었다는 뜻이 아닙니다**. 이 포탈의 콘솔 로그는 메모리 링버퍼라 재시작하면 사라지고, 오래된 줄은 밀려납니다.');
  } else {
    parts.push(`로그 ${count}줄`);
    if (logs.truncated) parts.push(`· 상한으로 **${n(logs.omitted) || 0}줄을 잘랐습니다**(최신 쪽을 남깁니다${n(limits.maxLimit) ? ` — 최대 ${limits.maxLimit}줄까지 요청할 수 있습니다` : ''}).`);
    if (logs.centralCapped) parts.push('· 중앙 보관 상한으로 일부를 더 잘랐습니다.');
  }
  const started = n(snap.node?.startedAt);
  if (started) parts.push(`· 그 엣지는 ${ageText(started, Date.now())} 기동했습니다 — 그 이전 줄은 남아 있지 않습니다.`);
  return { tone: count ? 'ok' : 'warn', text: parts.join(' ') };
}

/** 가린 필드 안내 — 조용한 가림 금지. 0 이면 문구를 만들지 않는다. */
export function maskNote(snap = {}) {
  const m = n(snap.maskedFields) || 0;
  if (!m) return '';
  return `비밀 값 **${m}개**를 가려서 가져왔습니다(비밀번호·토큰·개인키). 가린 자리는 **[가림]** 으로 보입니다.`;
}

/**
 * 로그 가림의 **한계**를 말한다(항상 표시). `redact.js` 는 상태 객체는 키 이름으로 확실히 가리지만
 * 로그는 자유 문자열이라 `KEY=값`·`Bearer …` 꼴만 잡는다 — 잡지 못하는 형태가 있을 수 있다.
 * ⚠ 이 문구를 지우지 말 것: '가렸다' 고만 말하고 한계를 숨기면 사용자가 로그를 그대로 외부에 공유한다.
 */
export function logRedactNote() {
  return '진행상태의 비밀 필드는 **키 이름으로** 가립니다. 로그 줄은 자유 문자열이라 **KEY=값 · Bearer 꼴만** 가립니다 — 다른 형태로 찍힌 값은 남을 수 있으니 로그를 외부에 공유하기 전에 확인하세요.';
}

/**
 * 표 아래 각주 — '눌러도 안 되는' 종류의 조치를 **한 번만** 적는다.
 * ⚠ 행마다 긴 안내를 넣으면 셀이 세로로 길어지고 같은 문단이 화면을 덮는다(v2.509 규약).
 *   행에는 짧은 상태 라벨만 두고, 행동은 여기서 말한다. 해당 종류가 **없으면 그 줄도 없다**.
 */
export function tableFootnotes(counts = {}, { minVersion = '' } = {}) {
  const out = [];
  if (counts['old-version']) out.push(`**구버전 엣지 ${counts['old-version']}곳** — v${minVersion} 미만에는 로그를 내주는 경로가 없습니다. 눌러도 실패하니 먼저 업그레이드하세요.`);
  if (counts['unknown-version']) out.push(`**버전 미상 ${counts['unknown-version']}곳** — 아직 중앙에 수집 결과를 준 적이 없어 버전을 모릅니다. 눌러 보면 되는지 알 수 있습니다.`);
  if (counts.disabled) out.push(`**비활성 ${counts.disabled}곳** — 설정 › 수집 서버에서 활성화해야 합니다.`);
  if (counts['no-url']) out.push(`**URL 없음 ${counts['no-url']}곳** — 설정 › 수집 서버에 주소를 넣어야 합니다.`);
  if (counts.failed) out.push(`**마지막 시도 실패 ${counts.failed}곳** — 행의 사유를 보세요. 닿지 못한 경우에는 폴백 요청이 등록돼 있습니다.`);
  return out;
}

/** 상태 항목을 그룹으로 묶는다(서버가 준 라벨만 쓴다 — 화면이 이름을 복사하지 않는다). */
export function groupStatus(items = [], groupLabel = {}) {
  const map = new Map();
  for (const it of items || []) {
    const g = t(it.group) || 'etc';
    if (!map.has(g)) map.set(g, { group: g, label: groupLabel[g] || g, items: [], failed: 0 });
    const row = map.get(g);
    row.items.push(it);
    if (it.ok === false) row.failed += 1;
  }
  return [...map.values()];
}

/**
 * 상태 전체 요약. ⚠ **'확인 불가' 를 정상에도 비정상에도 넣지 않는다**(v2.548 규약).
 */
export function statusSummary(snap = {}) {
  const items = Array.isArray(snap.status) ? snap.status : null;
  if (!items) return { kind: 'none', total: 0, failed: 0, text: '이 보관분에는 진행상태가 담겨 있지 않습니다(로그만 요청했습니다).' };
  const failed = items.filter((x) => x.ok === false).length;
  const read = items.length - failed;
  if (!items.length) return { kind: 'none', total: 0, failed: 0, text: '진행상태 항목이 없습니다.' };
  if (!failed) return { kind: 'ok', total: items.length, failed: 0, text: `진행상태 ${items.length}항목을 모두 읽었습니다. **이 값들이 '정상' 이라는 뜻은 아닙니다** — 각 항목의 내용을 보세요.` };
  return { kind: 'partial', total: items.length, failed, text: `진행상태 ${read}항목을 읽었고 **${failed}항목은 확인하지 못했습니다**(그 기능이 이 버전에 없거나 오류). 확인 불가는 '꺼짐' 이 아닙니다.` };
}

/** 로그 레벨 색. */
export function levelTone(level) {
  const v = t(level).toLowerCase();
  if (v === 'error') return 'bad';
  if (v === 'warn' || v === 'warning') return 'warn';
  return 'idle';
}

/** 엣지가 말한 이름과 중앙이 아는 이름이 다르면 그 사실 자체가 진단이다(v2.424 규약). */
export function identityNote(row = {}) {
  const central = t(row.agent);
  const said = t(row.last?.node?.agent);
  if (!central || !said || central.toLowerCase() === said.toLowerCase()) return '';
  return `중앙이 아는 이름은 **${central}** 인데 그 엣지는 자신을 **${said}** 라고 말합니다 — 엣지의 **AGENT_NAME** 과 수집 서버 등록 이름이 다릅니다. 중앙 기준 이름으로 보관합니다.`;
}

/** 등록부에 없는데 보관분만 있는 행. */
export function unregisteredNote(row = {}) {
  if (!row.unregistered) return '';
  return '설정 › 수집 서버 **등록부에 없는 이름**입니다(등록을 지웠거나 이름이 바뀌었습니다). 보관분만 남아 있어 새로 가져올 수는 없습니다.';
}

/*
 * v2.599(감사 WEB2599-03) — 엣지별 진행 표시와 '보던 화면' 보호.
 *   예전에는 진행 표시가 **문자열 하나**(`busyAgent`)라 A 를 가져오는 중에 B 를 누르면 A 의 잠금이
 *   B 로 덮였고, 먼저 끝난 A 의 finally 가 B 의 잠금까지 풀었다. 또 늦게 끝난 A 의 응답이 그 사이
 *   사용자가 연 B 화면을 A 로 바꿨다. 진행 표시는 **엣지별 집합**이고(아래 두 함수는 새 Set 을 돌려준다
 *   — React 상태는 제자리 수정하면 다시 그려지지 않는다), 화면 반영은 '마지막으로 연 요청' 만 한다.
 */
export function busyAdd(set, key) {
  const s = new Set(set instanceof Set ? set : []);
  s.add(key);
  return s;
}
export function busyRemove(set, key) {
  const s = new Set(set instanceof Set ? set : []);
  s.delete(key);
  return s;
}

/**
 * 보던 화면을 바꾸지 않은 가져오기 결과의 안내 — 그 사이 다른 엣지를 열었으므로 결과는 보관만 됐다.
 * ⚠ 결과를 조용히 버리지 않는다(사용자는 버튼을 눌렀다) — 어느 엣지가 어떻게 끝났는지 말한다.
 */
export function staleFetchNote(agent, res = {}) {
  const who = t(agent) || '(이름 없음)';
  const base = res && res.ok
    ? `**${who}** 가져오기가 끝났습니다(보관했습니다).`
    : `**${who}** 가져오기는 실패했습니다 — ${t(res?.reason) || t(res?.kind) || '사유 미상'}.`;
  return {
    tone: res && res.ok ? 'idle' : 'bad',
    text: `${base} 그 사이 다른 엣지를 열거나 가져오기를 눌러 **지금 보는 화면은 바꾸지 않았습니다** — 엣지 이름을 누르면 봅니다.`,
  };
}

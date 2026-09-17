/**
 * edgelog/collect.js — **이 노드의** 로그 + 진행상태를 한 봉투로 모은다(v2.549).
 *
 * 사용자 요청: "진행상태를 edge 의 로그를 읽어와서 확인할 수 있는 기능".
 * 이 함수는 엣지에서도 중앙에서도 같게 동작한다(중앙 자신의 상태도 같은 화면에서 본다).
 *
 * ── 정직성 규칙(이 기능이 만들 수 있는 거짓) ──────────────────────────────────
 *  ① **로그가 비었다 ≠ 아무 일도 없었다.** 콘솔 링버퍼는 1,000줄(`logbuffer.js:7`)이고 **재시작하면
 *     사라진다**. 그래서 `logs.bufferMax`·`logs.oldestId`·`node.startedAt` 을 함께 실어, 화면이
 *     '그 시각은 이미 링버퍼에서 밀려났다' 와 '그런 일이 없었다' 를 **구분**할 수 있게 한다.
 *  ② **상태를 못 읽은 항목을 '꺼짐' 이라 말하지 않는다.** 모듈 import 실패·함수 없음·예외는
 *     `ok:false` + `error` 이고, 그 항목은 정상에도 비정상에도 넣지 않는다.
 *  ③ **비밀은 출구에서 가린다**(`redact.js`) — 가린 개수를 `maskedFields` 로 밝힌다(조용한 가림 금지).
 *  ④ 로그 줄 수 상한으로 잘린 것은 `logs.truncated` 로 밝힌다.
 *
 * ⚠ `STATUS_SPEC` 의 모듈은 전부 `index.js` 가 부팅에 import 하는 것들이라 여기의 동적 import 는
 *   **캐시 적중**이다(새 타이머를 시작시키지 않는다). 새 항목을 더할 때 그 성질을 깨지 말 것.
 */
import os from 'node:os';
import { config, currentVersion } from '../config.js';
import { getLogs } from '../logbuffer.js';
import { STATUS_SPEC } from './spec.js';
import { redactDeep, redactLogLine } from './redact.js';

/** 로그 줄 수 기본 상한 — 본문 크기 가드(1,000줄 × ~200B ≈ 200KB). */
export const DEFAULT_LOG_LIMIT = 400;
export const MAX_LOG_LIMIT = 1_000;
/** 로그 한 줄 길이 상한(스택·SSH 추적이 통째로 들어온다 — `util/activityLog.js:67` 와 같은 규칙). */
const LINE_MAX = 2_000;

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** 이 노드가 엣지인가(중앙 URL 이 설정돼 있으면 엣지). */
export function isEdgeNode() { return !!config.agent.centralUrl; }

/** 노드 신원 — 중앙 화면이 '이 응답이 정말 그 엣지에서 왔나' 를 대조한다(v2.424 `identityIssue` 와 같은 목적). */
export function nodeInfo() {
  return {
    agent: config.agent.name || '',
    hostname: os.hostname(),
    version: currentVersion(),
    role: isEdgeNode() ? 'edge' : 'central',
    datacenter: config.collector?.datacenter || '',
    pid: process.pid,
    uptimeMs: Math.round(process.uptime() * 1000),
    startedAt: Date.now() - Math.round(process.uptime() * 1000),
  };
}

/**
 * 진행상태 전수 — `STATUS_SPEC` 의 각 `*Status()` 를 부른다.
 * 실패는 그 항목만 `ok:false` 이고 나머지는 그대로 온다(하나가 전체를 죽이지 않는다).
 */
export async function collectStatus() {
  const items = [];
  let maskedTotal = 0;
  for (const s of STATUS_SPEC) {
    try {
      const mod = await import(s.mod);
      const fn = mod?.[s.fn];
      if (typeof fn !== 'function') { items.push({ key: s.key, label: s.label, group: s.group, ok: false, error: `${s.fn} 없음(이 버전에 그 기능이 없습니다)`, value: null }); continue; }
      const raw = await fn();
      const { value, masked, truncated } = redactDeep(raw);
      maskedTotal += masked;
      items.push({ key: s.key, label: s.label, group: s.group, ok: true, error: null, value, ...(truncated ? { truncated: true } : {}) });
    } catch (e) {
      items.push({ key: s.key, label: s.label, group: s.group, ok: false, error: String(e?.message || e).slice(0, 300), value: null });
    }
  }
  return { items, maskedFields: maskedTotal, failed: items.filter((x) => !x.ok).length };
}

/**
 * 로그 + 상태를 한 봉투로.
 * @param {{since?:number, level?:string, limit?:number, withStatus?:boolean}} opt
 *   `since` 는 `logs.lastId` 를 그대로 되돌려 주면 된다(증분 조회).
 */
export async function collectEdgeLog({ since = 0, level = '', limit = DEFAULT_LOG_LIMIT, withStatus = true } = {}) {
  const cap = Math.max(1, Math.min(MAX_LOG_LIMIT, num(limit) || DEFAULT_LOG_LIMIT));
  const raw = getLogs({ since: num(since), level: level && level !== 'all' ? String(level) : undefined });
  const all = Array.isArray(raw.items) ? raw.items : [];
  // 상한을 넘으면 **최신 쪽을 남긴다** — 진행상태를 보려는 것이므로 오래된 줄보다 방금 줄이 중요하다.
  const kept = all.length > cap ? all.slice(-cap) : all;
  const items = kept.map((e) => ({ id: e.id, time: e.time, level: e.level, msg: redactLogLine(e.msg).slice(0, LINE_MAX) }));

  const status = withStatus ? await collectStatus() : null;
  return {
    at: Date.now(),
    node: nodeInfo(),
    logs: {
      lastId: num(raw.lastId),
      // ⚠ '가장 오래된 줄의 id' 를 밝힌다 — 화면이 "그 시각은 이미 밀려났다" 를 말할 수 있는 유일한 근거다.
      oldestId: items.length ? items[0].id : null,
      count: items.length,
      matched: all.length,
      truncated: all.length > cap,
      omitted: Math.max(0, all.length - cap),
      items,
    },
    status: status ? status.items : null,
    statusFailed: status ? status.failed : null,
    maskedFields: status ? status.maskedFields : 0,
  };
}

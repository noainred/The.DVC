/**
 * isidu/rows.js — '아이실론 디렉터리 사용량' 목록 행 조립(v2.742 — 라우트에서 옮겼다).
 * 메인 목록 응답(`GET /tools/isilon-dirusage`)과 종합 메일(`isidu/digest.js`)이 **같은 행**을 쓴다 — 두 벌이면 화면과 메일의 상태가 갈라진다.
 * 등록부 반영 + 법인 이름 + 최신 상태(DB 최신 행 · 폴러 진행 · 엣지 보고 · 요청 대기 · 인증 정지 · 메일 상태). 장비 왕복 0.
 */
import { listDevices } from '../storage/registry.js';
import { listDatacenters } from '../datacenter/store.js';
import { loadSettings, resolveTarget } from './settings.js';
import { authStopOf } from './collect.js';
import { isiduPollerStatus } from './poller.js';
import { isiduRequestState } from './collectRequests.js';
import { allIsiduEdgeStatus } from '../central/isiduEdge.js';
import { HISTORY_AGENT } from './targets.js';
import * as db from './db.js';
import { isiduMailStateOf } from './notify.js';
import { targetMailOf, mailRecipients } from './mailRules.js';

const t = (v) => String(v ?? '').trim();
const lo = (v) => t(v).toLowerCase();

export function dcList() {
  try { return listDatacenters().map((d) => ({ id: String(d.id), name: String(d.name || d.id) })); } catch { return []; }
}

/** 화면 표에 실을 대상 — 등록부 반영 + 법인 이름 + 최신 상태. */
export async function targetRows() {
  const devices = listDevices();
  const dcs = new Map(dcList().map((d) => [d.id, d.name]));
  const latest = await db.latestAll();
  const byId = new Map((latest || []).filter((r) => r.agent === HISTORY_AGENT).map((r) => [r.targetId, r]));
  const ps = isiduPollerStatus();
  const pollerRunning = new Map(ps.running.map((r) => [r.targetId, r]));
  const pollerQueued = new Map((ps.queued || []).map((r) => [r.targetId, r]));               // v2.741 TIMING-02: 동시 실행 상한에 걸려 기다리는 '지금 수집'
  const pollerInterrupted = new Map((ps.interrupted || []).map((r) => [r.targetId, r]));     // v2.737: 재시작으로 중단 · 재개 대기
  const pollerResumes = new Map();
  for (const r of ps.resumes || []) if (!pollerResumes.has(r.targetId)) pollerResumes.set(r.targetId, r);
  const edges = new Map(allIsiduEdgeStatus().map((e) => [lo(e.agent), e]));
  const st = loadSettings();
  const commonTo = st.mail?.commonTo || [];
  return Promise.all(st.targets.map(async (tg) => {
    const r = resolveTarget(tg, { devices });
    const l = byId.get(r.id) || null;
    const ag = t(r.agent);
    const edge = ag ? edges.get(lo(ag)) || null : null;
    const edgeRunning = edge?.status?.poller?.running?.find((x) => x.targetId === r.id) || null;
    const edgeInterrupted = edge?.status?.poller?.interrupted?.find((x) => x.targetId === r.id) || null;
    const edgeResume = edge?.status?.poller?.resumes?.find((x) => x.targetId === r.id) || null;
    return {
      id: r.id, label: r.label || '', path: r.path, sizeMode: r.sizeMode, intervalHours: r.intervalHours, timeoutMin: r.timeoutMin, topN: r.topN,
      enabled: r.enabled !== false, auth: r.auth, port: r.port, username: r.username || '',
      deviceId: r.deviceId || '', deviceName: r.deviceName || '', host: r.host || '', agent: ag,
      // v2.736: 실행 노드의 근거 — 'device'(장비 담당 노드) · 'override'(실행 노드 지정) · 'direct'(직접 입력 대상의 노드).
      agentSource: r.agentSource || 'direct', runVia: r.runVia || (r.deviceId ? 'device' : ''), deviceAgent: r.deviceAgent ?? null,
      datacenterId: r.datacenterId || '', corp: r.datacenterId ? (dcs.get(r.datacenterId) || r.datacenterId) : '',
      issue: r.issue || null, deviceDisabled: !!r.deviceDisabled,
      okScan: l?.okScan ? { id: l.okScan.id, ts: l.okScan.ts, durationMs: l.okScan.durationMs, count: l.okScan.count, total: l.okScan.total, sumBytes: l.okScan.sumBytes, errLines: l.okScan.errLines || 0, node: l.okScan.node || '' } : null,
      lastTry: l?.lastTry ? { id: l.lastTry.id, ts: l.lastTry.ts, ok: l.lastTry.ok, kind: l.lastTry.kind, error: l.lastTry.error, durationMs: l.lastTry.durationMs, node: l.lastTry.node || '', trig: l.lastTry.trig } : null,
      failStreak: l?.failStreak || 0,
      running: ag ? (edgeRunning ? { since: edgeRunning.since, trigger: edgeRunning.trigger, reportedAt: edge.at } : null) : (pollerRunning.get(r.id) || null),
      queued: ag ? null : (pollerQueued.get(r.id) || null),
      request: ag ? isiduRequestState(r.id) : null,
      // v2.737: 업그레이드·재시작으로 끝나지 못한 조사(재개 대기)와 마지막 자동 재개 결과 — 엣지 담당은 그 엣지의 보고.
      interrupted: ag ? edgeInterrupted : (pollerInterrupted.get(r.id) || null),
      lastResume: ag ? edgeResume : (pollerResumes.get(r.id) || null),
      // 엣지 담당 대상의 인증 정지는 엣지에 있다 — 중앙은 그 엣지의 마지막 시도 결과(kind 'auth')로만 안다.
      authStopped: ag ? null : await authStopOf(r),
      // v2.738 결과 메일 — 이 표는 주소를 싣지 않는다(개수·선택만). 주소는 설정 조회에만 있다.
      mail: (() => { const tm = targetMailOf(tg); const rc = mailRecipients(commonTo, tm); return { recipients: rc.to.length, onlyOnChange: tm.onlyOnChange, onFailure: tm.onFailure, excludeCommon: tm.excludeCommon }; })(),
      lastMail: isiduMailStateOf(r.id),
    };
  }));
}

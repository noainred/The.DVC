/**
 * loganalysis/live.js — 이 포탈 로그의 **누적** 집계(v2.583). 설정 › Log › 로그 분석의 기본 원천.
 *
 * 왜 필요한가: 링 버퍼(`logbuffer.js`)는 1,000줄이라 요청 로그까지 섞이면 **몇 분이면 밀려난다**.
 * 현장은 폐쇄망이라 저널을 반출할 수도 없다. 그래서 줄이 들어오는 순간(`addLogTap`) 시간 버킷에
 * 집계하고, 조회할 때 원하는 구간(1·6·24·168시간)을 합쳐 개선점을 만든다.
 *
 * 비용·유계:
 *  · 줄당 비용은 태그 추출 + 그 태그의 규칙 정규식 몇 개 + 템플릿 치환(engine.addItem). 절대 던지지 않는다.
 *  · 시간 버킷 최대 168개(7일). 지난 시간 버킷은 상위 N 만 남기도록 줄인다(compactState).
 *  · 파일(`log-analysis-stats.json`)에 10분마다(바뀐 경우만) + 종료 시(exitFlush) 남긴다 — 업그레이드
 *    재시작마다 누적이 사라지면 '24시간' 이 거짓이 된다. **재생성 가능한 통계**라 손상 시 보존하지
 *    않고 새로 시작하되, 그 사실을 상태(`loadError`)로 화면에 밝힌다(조용히 넘기지 않는다).
 *  · `LOGANALYSIS_LIVE=0` 이면 켜지 않는다(분석 화면이 그 사실을 말한다).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';
import { registerExitFlush } from '../util/exitFlush.js';
import { addLogTap, getLogs } from '../logbuffer.js';
import { fromBufferEntry } from './parse.js';
import { newState, addItem, mergeState, compactState, indexRules } from './engine.js';

const HOUR = 3_600_000;
const KEEP_HOURS = 168;
const SAVE_MS = 10 * 60_000;
const FILE = () => path.join(config.configDir, 'log-analysis-stats.json');

let buckets = new Map();   // hourIndex -> state
let idx = null;
let started = false;
let dirty = false;
let saveTimer = null;
let unTap = null;
// v2.605(감사 RECENT2605-05): prune 으로 지운 가장 늦은 시간 버킷. 가장 이른 남은 버킷이 창 시작(fromH)과 같아도
//   그 앞 버킷을 지운 적이 있으면 추적은 창 앞에서 이미 시작된 것이다 — '일부' 가 아니다.
let prunedThroughH = null;
const status = { enabled: false, startedAt: null, loadedFrom: null, loadError: null, lastSaveAt: null, lastSaveError: null, ingested: 0 };

export const liveEnabled = () => String(process.env.LOGANALYSIS_LIVE ?? '1') !== '0';

function prune(nowH) {
  for (const h of [...buckets.keys()]) {
    if (h <= nowH - KEEP_HOURS) { buckets.delete(h); if (prunedThroughH == null || h > prunedThroughH) prunedThroughH = h; }
    else if (h < nowH && !buckets.get(h).compacted) { compactState(buckets.get(h)); buckets.get(h).compacted = true; }
  }
}

/** 한 항목을 누적한다(테스트는 ts 를 줘서 시간을 흉내 낸다). */
export function ingest(item) {
  if (!item || !idx) return;
  const ts = Number.isFinite(item.ts) ? item.ts : Date.now();
  const h = Math.floor(ts / HOUR);
  let st = buckets.get(h);
  if (!st) {
    st = newState();
    buckets.set(h, st);
    prune(h);
  }
  // v2.604(감사 WEB2604-02): 이 버킷에 **실제로** 처음 들어온 시각. 누적 시작을 정시(버킷 시작)로 말하면
  //   hh:29 에 시작한 추적이 hh:00 부터 본 것처럼 보이고 1시간 창이 '완전' 으로 표시됐다.
  if (!Number.isFinite(st.firstIngestTs) || ts < st.firstIngestTs) st.firstIngestTs = ts;
  addItem(st, item, idx);
  status.ingested += 1;
  dirty = true;
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    if (raw && raw.v === 1 && Array.isArray(raw.buckets)) {
      for (const b of raw.buckets) if (Number.isFinite(b?.h) && b.state) buckets.set(b.h, { ...newState(), ...b.state, compacted: true });
      if (Number.isFinite(raw.prunedThroughH)) prunedThroughH = raw.prunedThroughH;
      status.loadedFrom = raw.savedAt || null;
    }
  } catch (e) {
    if (e?.code !== 'ENOENT') status.loadError = String(e?.message || e).slice(0, 200);
  }
}

/** 파일에 남긴다(동기 — 종료 flush 에서도 쓴다). 실패는 상태에 남긴다. */
export function saveLive() {
  if (!started || !dirty) return false;
  try {
    const nowH = Math.floor(Date.now() / HOUR);
    prune(nowH);
    const out = { v: 1, savedAt: Date.now(), prunedThroughH, buckets: [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([h, state]) => ({ h, state })) };
    atomicWriteFileSync(FILE(), JSON.stringify(out));
    dirty = false;
    status.lastSaveAt = Date.now(); status.lastSaveError = null;
    return true;
  } catch (e) {
    status.lastSaveError = String(e?.message || e).slice(0, 200);
    return false;
  }
}

/** 시작 — 규칙 목록을 받는다. 두 번 불러도 한 번만 붙는다. */
export function startLiveAnalysis(rules) {
  idx = indexRules(rules);
  if (started) return status;
  if (!liveEnabled()) { status.enabled = false; return status; }
  started = true;
  status.enabled = true;
  status.startedAt = Date.now();
  load();
  // 기동부터 지금까지 링 버퍼에 쌓인 줄을 먼저 넣는다(재시작하면 링 버퍼는 비어 있으므로 중복이 없다).
  for (const e of getLogs({ since: 0 }).items) ingest(fromBufferEntry(e));
  unTap = addLogTap((e) => ingest(fromBufferEntry(e)));
  saveTimer = setInterval(() => { saveLive(); }, SAVE_MS);
  saveTimer.unref?.();
  registerExitFlush('log-analysis', () => { saveLive(); });
  return status;
}

/** 규칙이 바뀌면(카탈로그 갱신) 색인만 다시 만든다 — 이미 센 값은 그대로다. */
export function setLiveRules(rules) { idx = indexRules(rules); }

/** 최근 hours 시간 구간 합산 상태 + 구간 설명. */
export function liveState(hours = 24, now = Date.now()) {
  const nowH = Math.floor(now / HOUR);
  const fromH = nowH - Math.max(1, Math.min(KEEP_HOURS, Number(hours) || 24)) + 1;
  const st = newState();
  let earliest = null;
  let n = 0;
  for (const [h, b] of buckets) {
    if (h < fromH || h > nowH) continue;
    mergeState(st, b);
    n += 1;
    if (earliest == null || h < earliest) earliest = h;
  }
  const allEarliest = buckets.size ? Math.min(...buckets.keys()) : null;
  const trackingSince = allEarliest == null ? null : bucketStartTs(allEarliest);
  const windowFrom = fromH * HOUR;
  // v2.605(감사 RECENT2605-05 — 재현): prune 은 h ≤ nowH−168 을 지워 가장 이른 남은 버킷이 168시간 창의 fromH 와 같아진다.
  //   v2.604 가 trackingSince 를 그 버킷의 실제 첫 줄 시각(정시 이후)으로 바꾸자 10일 켜진 포탈의 7일 보기가 거의 항상
  //   '일부' 였다. 창 바로 앞 버킷까지 지운 적이 있으면(prunedThroughH ≥ fromH−1) 추적은 창 앞에서 시작된 것이다.
  const trackedBeforeWindow = prunedThroughH != null && prunedThroughH >= fromH - 1;
  return {
    state: st,
    coverage: {
      source: 'live', hours: Number(hours) || 24, bucketsUsed: n,
      windowFrom, windowTo: now,
      // 누적이 시작된 시각 — 요청 구간보다 늦으면 '그 앞은 모른다' 를 화면이 말한다.
      // v2.604(감사 WEB2604-02): 버킷 시작(정시)이 아니라 가장 이른 버킷에 실제로 처음 들어온 시각이고,
      //   구간과의 비교도 시간 단위가 아니라 ms 로 한다(같은 시간 버킷 안에서 시작한 추적도 '일부' 다).
      trackingSince,
      prunedBefore: prunedThroughH == null ? null : (prunedThroughH + 1) * HOUR,
      partial: !trackedBeforeWindow && (trackingSince == null || trackingSince > windowFrom),
    },
  };
}

/** 버킷의 실제 첫 수신 시각. 그 필드가 없는 옛 저장분은 그 버킷의 첫 줄 시각, 그것도 없으면 버킷 시작(정시)이다. */
function bucketStartTs(h) {
  const b = buckets.get(h);
  if (Number.isFinite(b?.firstIngestTs)) return b.firstIngestTs;
  if (Number.isFinite(b?.first)) return b.first;
  return h * HOUR;
}

export function liveStatus() {
  return { ...status, buckets: buckets.size, keepHours: KEEP_HOURS, saveEveryMs: SAVE_MS, file: path.basename(FILE()) };
}

/** 테스트 전용. */
export function _resetLiveForTest() {
  if (unTap) unTap();
  if (saveTimer) clearInterval(saveTimer);
  buckets = new Map(); idx = null; started = false; dirty = false; saveTimer = null; unTap = null; prunedThroughH = null;
  Object.assign(status, { enabled: false, startedAt: null, loadedFrom: null, loadError: null, lastSaveAt: null, lastSaveError: null, ingested: 0 });
}

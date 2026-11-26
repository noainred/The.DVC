/**
 * storage/collectors/unityMetricsSsh.js — SSH(uemcli)로 등록한 Unity 의 5분 표본(v3.46.0 — 사용자 요청
 * "SSH 장비도 사용량은 REST 로 읽게 해줘, 안되면 SSH 로 진행" + 선택 'SSH 계정 그대로').
 *
 * 순서(sampleUnityAny):
 *  ① REST(Unisphere `metricValue` — arrayPerf.sampleUnity, REST 장비와 같은 코드)를 **SSH 계정 그대로** 시도한다.
 *  ② REST 가 인증 거절이면 그 장비의 REST 표본을 자격증명이 바뀔 때까지 멈추고(restSampleGate — 장비 인증 정지는 걸지 않는다:
 *     SSH 용량 · 상태 수집까지 멈추게 된다), 비인증 실패면 1시간 건너뛴다. 어느 쪽이든 **이번 주기는 SSH 로** 읽는다.
 *  ③ SSH: `uemcli /metrics/value/hist -path <경로> show -interval 60 -count N` 으로 같은 경로(SP CPU · FC 바이트 · 이더넷 바이트)를 읽어
 *     REST 와 **같은 조립**(unitySpLatest · unityCounterRate · unityUnits · buildFeSample)으로 표본을 만든다.
 *
 * ⚠⚠ 정직 기록 — **uemcli 지표 명령의 옵션과 출력 모양은 이 저장소에서 본 적이 없다**(Unisphere CLI 가이드 지식).
 *   그래서 파서는 두 모양을 받는다: ⓐ `키 = 값` 레코드(다른 uemcli 출력과 같은 꼴 — Timestamp · SP · 대상 · Value 열)
 *   ⓑ 머리줄에 Timestamp 가 있는 표(`|` 또는 공백 2칸 이상으로 나뉜 열). 둘 다 못 읽으면 표본을 만들지 않고 사유를 남긴다
 *   (CLI 원문 앞부분이 probe.errors 에 실린다 — 첫 실수집 원문을 보고 파서를 맞출 것).
 *   SSH 표본은 5분마다 장비 로그인 1~2회를 만든다(장비 로그).
 */
import { numOrNull } from '../../util/numOrNull.js';
import { parseUemcli } from './uemcliParse.js';
import { runCliSession } from './cliSsh.js';
import { stripUemcliBanner, isSshAuthError } from '../../proxy/sshExec.js';
import { isCredReject } from './restCommon.js';
import { unitySpLatest, unityCounterRate, unityUnits, buildFeSample, sampleUnity, UNITY_CPU_PATH, UNITY_FC_PATHS, UNITY_FC_PATHS_ALT, UNITY_ETH_PATHS } from './arrayPerf.js';
import { restSkipReason, markRestFailed, clearRestFailed } from '../restSampleGate.js';

/** 세션 예산 · 명령당 시한 — 표본 시한(nodeLoadPoller SAMPLE_TIMEOUT_MS 기본 60초)보다 작아야 한다(테스트가 산수를 고정). */
export const SSH_METRIC_BUDGET_MS = 40_000;
export const SSH_METRIC_CMD_MS = 10_000;
const TEXT_MAX = 512 * 1024;
const ROWS_MAX = 5_000;
const capErr = (e) => String(e?.message || e || '').slice(0, 160);

/** 경로 → uemcli 명령(경로는 이 파일의 상수 — 사용자 입력이 아니다). count 는 누적 카운터 델타에 2, CPU 는 1. */
export const histCmd = (path, count) => `uemcli /metrics/value/hist -path ${path} show -interval 60 -count ${count}`;
export const SSH_METRIC_SPECS = Object.freeze([
  { key: 'cpu', path: UNITY_CPU_PATH, count: 1 },
  { key: 'readBytes', path: UNITY_FC_PATHS.readBytes, count: 2 },
  { key: 'writeBytes', path: UNITY_FC_PATHS.writeBytes, count: 2 },
  { key: 'ethIn', path: UNITY_ETH_PATHS.bytesIn, count: 2 },
  { key: 'ethOut', path: UNITY_ETH_PATHS.bytesOut, count: 2 },
].map((s) => ({ ...s, cmds: [histCmd(s.path, s.count)], answered: true, rules: ['pager', 'certAccept'], timeoutMs: SSH_METRIC_CMD_MS })));
export const SSH_METRIC_ALT_SPECS = Object.freeze([
  { key: 'readBytesFe', path: UNITY_FC_PATHS_ALT.readBytes, count: 2 },
  { key: 'writeBytesFe', path: UNITY_FC_PATHS_ALT.writeBytes, count: 2 },
].map((s) => ({ ...s, cmds: [histCmd(s.path, s.count)], answered: true, rules: ['pager', 'certAccept'], timeoutMs: SSH_METRIC_CMD_MS })));

/* ── 출력 파서(순수) ─────────────────────────────────────────────────────── */
const tsOf = (v) => {
  const t = String(v ?? '').trim().slice(0, 40);
  if (!t) return null;
  const iso = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?/.test(t) ? `${t.replace(' ', 'T').slice(0, 19)}Z` : t;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
};
const numOf = (v) => numOrNull(String(v ?? '').trim().slice(0, 40).replace(/,/g, '').replace(/\s*[A-Za-z%/]+$/, ''));
const lower = (v) => String(v ?? '').trim().toLowerCase();
/** 열 이름 → 역할(ts · sp · val · obj · skip). */
function roleOf(name) {
  const k = lower(name);
  if (/time/.test(k)) return 'ts';
  if (k === 'sp' || k === 'storage processor') return 'sp';
  if (k === 'value' || k === 'values') return 'val';
  if (k === 'path' || k === 'interval' || k === 'id' || k === '') return 'skip';
  return 'obj';
}
function rowsToEntries(rows) {
  const by = new Map();
  for (const r of rows) {
    if (r.ts == null || r.val == null) continue;
    const sp = /^sp[ab]$/.test(lower(r.sp)) ? lower(r.sp) : (/^(sp[ab])_/.exec(lower(r.obj))?.[1] || lower(r.sp) || lower(r.obj));
    if (!sp) continue;
    const e = by.get(r.ts) || { ts: r.ts, interval: null, values: {} };
    if (r.obj && lower(r.obj) !== sp) {
      const cur = e.values[sp] && typeof e.values[sp] === 'object' ? e.values[sp] : {};
      cur[lower(r.obj).slice(0, 64)] = r.val;
      e.values[sp] = cur;
    } else e.values[sp] = r.val;
    by.set(r.ts, e);
  }
  return [...by.values()].sort((a, b) => b.ts - a.ts);   // arrayPerf.parseUnityEntries 와 같은 순서(최신 먼저)
}
/**
 * `uemcli /metrics/value/hist … show` 출력 → parseUnityEntries 와 같은 모양 `[{ts, values:{spa: 수 | {포트: 수}}}]`(최신 먼저).
 * 못 읽으면 [] (지어내지 않는다).
 */
export function parseMetricHist(text) {
  const t = String(text || '').slice(0, TEXT_MAX);
  const rows = [];
  // ⓐ `키 = 값` 레코드
  for (const r of parseUemcli(t)) {
    if (rows.length >= ROWS_MAX) break;
    const o = { ts: null, sp: '', obj: '', val: null };
    for (const [k, v] of Object.entries(r)) {
      const role = roleOf(k);
      if (role === 'ts') o.ts = tsOf(v);
      else if (role === 'sp') o.sp = String(v).trim().slice(0, 16);
      else if (role === 'val') o.val = numOf(v);
      else if (role === 'obj' && !o.obj) o.obj = String(v).trim().slice(0, 64);
    }
    rows.push(o);
  }
  if (rows.some((r) => r.ts != null && r.val != null)) return rowsToEntries(rows);
  // ⓑ 머리줄에 Timestamp 가 있는 표
  const lines = t.split(/\r?\n/).map((l) => l.slice(0, 2_000).trimEnd());
  const hi = lines.findIndex((l) => /timestamp/i.test(l) && !/=/.test(l));
  if (hi < 0) return [];
  const split = (l) => (l.includes('|') ? l.split('|') : l.trim().split(/ {2,}|\t+/)).map((x) => x.trim());
  const roles = split(lines[hi]).map(roleOf);
  const out = [];
  for (const l of lines.slice(hi + 1)) {
    if (out.length >= ROWS_MAX) break;
    if (!l.trim() || /^[-=+| ]+$/.test(l)) continue;
    const cells = split(l);
    const o = { ts: null, sp: '', obj: '', val: null };
    roles.forEach((role, i) => {
      const v = cells[i];
      if (v == null) return;
      if (role === 'ts') o.ts = tsOf(v);
      else if (role === 'sp') o.sp = v.slice(0, 16);
      else if (role === 'val') o.val = numOf(v);
      else if (role === 'obj' && !o.obj) o.obj = v.slice(0, 64);
    });
    out.push(o);
  }
  return rowsToEntries(out);
}

/* ── SSH 표본 ──────────────────────────────────────────────────────────── */
/**
 * SSH(uemcli)로 표본 1개. 세션 하나로 기본 경로 5개를 읽고, FC target 경로가 비면 두 번째 세션에서 fePort 경로를 읽는다(남은 시간이 있을 때만).
 * SSH 인증 실패는 그대로 던진다(호출부 nodeLoadPoller 가 isSshAuthError 로 장비 인증 정지 — 용량 수집과 같은 SSH 자격증명이다).
 */
export async function sampleUnitySsh(full, { now = Date.now(), run = runCliSession } = {}) {
  const startedAt = Date.now();
  const probe = { errors: [], paths: {}, via: 'ssh' };
  const r1 = await run(full, SSH_METRIC_SPECS, { clean: stripUemcliBanner, budgetMs: SSH_METRIC_BUDGET_MS });
  const read = (r, key) => {
    const text = r?.out?.[key];
    if (text == null) {
      probe.paths[key] = (r?.skipped || []).includes(key) ? 'skipped' : 'error';
      if (r?.errors?.[key] && probe.errors.length < 8) probe.errors.push(`${key}: ${String(r.errors[key]).slice(0, 140)}`);
      return [];
    }
    const e = parseMetricHist(text);
    probe.paths[key] = e.length;
    if (!e.length && probe.errors.length < 8) probe.errors.push(`${key}: 출력을 읽지 못했습니다 — ${String(text).replace(/\s+/g, ' ').trim().slice(0, 110)}`);
    return e;
  };
  const cpuE = read(r1, 'cpu');
  let rbE = read(r1, 'readBytes'); let wbE = read(r1, 'writeBytes');
  const einE = read(r1, 'ethIn'); const eoutE = read(r1, 'ethOut');
  probe.fcPath = rbE.length || wbE.length ? 'target' : '';
  if (!rbE.length && !wbE.length && SSH_METRIC_BUDGET_MS - (Date.now() - startedAt) > 15_000) {
    const r2 = await run(full, SSH_METRIC_ALT_SPECS, { clean: stripUemcliBanner, budgetMs: Math.min(20_000, SSH_METRIC_BUDGET_MS - (Date.now() - startedAt)) });
    const a = read(r2, 'readBytesFe'); const b = read(r2, 'writeBytesFe');
    if (a.length || b.length) { rbE = a; wbE = b; probe.fcPath = 'fePort'; }
  }
  const cpu = unitySpLatest(cpuE);
  const rb = unityCounterRate(rbE); const wb = unityCounterRate(wbE);
  const z = { perSp: {}, perPort: {}, intervalS: null };   // SSH 는 IOPS(reads · writes) 경로를 읽지 않는다 — 명령 수 · 로그인 시간을 줄인다
  const ein = unityCounterRate(einE); const eout = unityCounterRate(eoutE);
  const sps = new Set([...Object.keys(cpu), ...Object.keys(rb.perSp), ...Object.keys(ein.perSp)]);
  if (!sps.size) throw new Error(`uemcli 지표에서 SP 값을 읽지 못했습니다${probe.errors[0] ? ` — ${probe.errors[0]}` : ''}`);
  const { units, partial } = unityUnits({ cpu, rb, wb, rd: z, wr: z, ein, eout });
  probe.counterIntervalS = rb.intervalS ?? ein.intervalS ?? null;
  if (partial) probe.partialSums = partial;
  probe.counterNote = rb.intervalS == null && ein.intervalS == null ? '누적 항목이 둘 미만 — 처리량은 null(장비가 이력을 주지 않았거나 -count 옵션이 맞지 않을 수 있습니다)' : '';
  return buildFeSample({ ts: now, type: 'unity480', source: 'uemcli /metrics/value/hist(cpu · FC · 이더넷 누적 델타)', units, probe });
}

/**
 * SSH 로 등록한 Unity 의 표본 — REST 먼저(SSH 계정 그대로), 안 되면 SSH. 결과 probe 에 via(rest|ssh) · restSkip(auth|other) · restError 를 남긴다.
 * rest · ssh 는 테스트가 바꿔 넣는다. REST 인증 거절은 **여기서 삼킨다**(장비 인증 정지로 번지지 않게) — SSH 인증 실패는 던진다.
 */
export async function sampleUnityAny(full, { signal = null, now = Date.now(), rest = sampleUnity, ssh = sampleUnitySsh } = {}) {
  const skip = restSkipReason(full, now);
  let restErr = null;
  if (!skip) {
    try {
      const s = await rest(full, { signal, now });
      clearRestFailed(full);
      s.probe = { ...(s.probe || {}), via: 'rest' };
      return s;
    } catch (e) {
      if (signal?.aborted) throw e;
      const auth = isCredReject(e);
      markRestFailed(full, { auth, detail: capErr(e), now });
      restErr = { kind: auth ? 'auth' : 'other', detail: capErr(e) };
    }
  }
  let s;
  try { s = await ssh(full, { signal, now }); }
  catch (e) {
    // 두 경로 모두 실패 — 화면이 둘 다 말하게 REST 사유를 덧붙인다. ⚠ SSH 인증 판정(isSshAuthError — 메시지 정규식)은 **원래 SSH 오류로만** 한다:
    //   REST 원문에 'Authentication failed' 가 있으면 덧붙인 글이 정규식에 걸려 SSH 용량 수집까지 인증 정지시킨다. 그래서 판정을 먼저 하고,
    //   덧붙이는 REST 글의 'authentication' 은 'auth' 로 줄여 정규식에 걸리지 않게 한다(테스트가 고정).
    const sshAuth = isSshAuthError(e);
    const note = (skip ? `${skip.kind === 'auth' ? '인증 거절로 멈춤' : '건너뜀'} — ${skip.detail}` : restErr.detail).replace(/authentication/gi, 'auth');
    const err = new Error(`${String(e?.message || e)} (REST: ${note})`.slice(0, 400));
    if (sshAuth) err.level = 'client-authentication';
    throw err;
  }
  s.probe = { ...(s.probe || {}), via: 'ssh', restSkip: skip ? skip.kind : restErr.kind, restError: (skip ? skip.detail : restErr.detail).slice(0, 120) };
  return s;
}

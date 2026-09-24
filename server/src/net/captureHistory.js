/**
 * 네트워크 캡처 이력 저장소 — 캡처 결과의 메타·요약·진단을 CONFIG_DIR/capture-history.json에
 * 보관(자격증명/원본 pcap 제외). 최근 N건만 유지. 재조회/연속 모니터링 기록용.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js'; // v2.582 ARCH-3: 상태 파일도 원자 쓰기(절단본 → 로드 실패 → 다음 저장이 빈 값으로 덮어쓰는 왕복 손상 차단)
import { numOrNull } from '../util/numOrNull.js';

const FILE = path.join(config.configDir, 'capture-history.json');
const MAX = 300;

let list = null;
function load() {
  if (list) return list;
  list = [];
  try { if (fs.existsSync(FILE)) list = JSON.parse(fs.readFileSync(FILE, 'utf8')) || []; } catch { list = []; }
  // v2.600 CEN2600-05: 정제 이전에 저장된 레코드도 같은 모양으로 읽는다(이미 파일에 남은 객체 hostB 가 화면을 죽이지 않게).
  list = (Array.isArray(list) ? list : []).filter((r) => r && typeof r === 'object' && typeof r.id === 'string').map(cleanRecord);
  return list;
}
function persist() { try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); atomicWriteFileSync(FILE, JSON.stringify(list), { mode: 0o600 }); } catch { /* */ } }

/*
 * ⚠⚠ v2.600 CEN2600-05 — **엣지가 올린 캡처 결과는 아는 필드만 담는다**(v2.598 CENTRAL 규약).
 * 위임 캡처 결과(`/api/central/capture-result`)가 정제 없이 이 파일에 영속됐다 — `peer:{evil:1}` 이 hostB 로
 * 저장돼 이력 표가 React #31 로 죽을 수 있었고, issues msg 90만 자가 그대로 들어가 레코드 하나가 약 900KB 였다
 * (× 300건을 매 기록마다 전량 재직렬화). 정제는 **저장 함수 안**에 둔다 — 라우트·모니터 어느 경로로 와도 같다.
 */
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : typeof v === 'number' && Number.isFinite(v) ? String(v).slice(0, n) : '');
const SEVS = new Set(['ok', 'warning', 'error']);
const MAX_ISSUES = 50;
function cleanIssues(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const i of list) {
    if (out.length >= MAX_ISSUES) break;
    if (!i || typeof i !== 'object') continue;
    out.push({ sev: SEVS.has(i.sev) ? i.sev : 'warning', title: str(i.title, 200), detail: str(i.detail ?? i.msg, 500) });
  }
  return out;
}
const dirStat = (d) => (d && typeof d === 'object' ? { packets: numOrNull(d.packets), bytes: numOrNull(d.bytes) } : { packets: null, bytes: null });
/** analyzeCapture() 의 stat 모양으로 투사한다(수치는 numOrNull — 못 읽은 값을 0 으로 만들지 않는다). */
function cleanStat(st) {
  if (!st || typeof st !== 'object') return null;
  const o = {};
  for (const k of ['packets', 'syn', 'synAck', 'rst', 'fin', 'retrans', 'rttMs', 'retransPct', 'durSec', 'firstTs', 'lastTs']) o[k] = numOrNull(st[k]);
  o.toPeer = dirStat(st.toPeer);
  o.fromPeer = dirStat(st.fromPeer);
  o.topPorts = (Array.isArray(st.topPorts) ? st.topPorts : []).slice(0, 8)
    .filter((p) => p && typeof p === 'object').map((p) => ({ port: str(p.port, 16), packets: numOrNull(p.packets) }));
  return o;
}
/**
 * 캡처 결과(단일/dual)를 필요한 필드만 남겨 정제한다. 테스트·잡 저장소가 그대로 쓸 수 있게 export.
 * `full:true` 는 **캡처 화면(NetTrafficAnalysis.jsx SingleResult·DualResult)이 실제로 읽는 필드**까지 담는다 —
 * reason·warn·sample(원본 패킷 줄)·command·iface·seconds. 이력은 full 없이(요약만) 저장한다.
 * v2.600 CEN2600-05: 위임 캡처의 인메모리 잡 결과(`central/captureJobs.js setCaptureResult`)도 이 함수를 거친다.
 */
export function sanitizeCaptureResult(result, { full = false } = {}) {
  if (!result || typeof result !== 'object') return { ok: false, reason: full ? '에이전트가 빈 결과를 회신했습니다.' : '' };
  const extra = (x) => (full ? {
    reason: str(x.reason, 500), warn: str(x.warn, 300) || null, command: str(x.command, 500), iface: str(x.iface, 32), seconds: numOrNull(x.seconds),
    sample: (Array.isArray(x.sample) ? x.sample : []).slice(0, 40).filter((l) => typeof l === 'string').map((l) => l.slice(0, 500)),
  } : {});
  const single = (x) => {
    const an = x.analysis && typeof x.analysis === 'object' ? x.analysis : {};
    return {
      ok: x.ok === true, hostA: str(x.hostA, 255), peer: str(x.peer, 255), captured: numOrNull(x.captured),
      analysis: { stat: cleanStat(an.stat), issues: cleanIssues(an.issues) }, ...extra(x),
    };
  };
  if (result.dual) {
    const c = result.comparison && typeof result.comparison === 'object' ? result.comparison : {};
    const side = (x) => (x && typeof x === 'object' ? (full ? single(x) : { captured: numOrNull(x.captured), analysis: { stat: cleanStat(x.analysis?.stat) } }) : null);
    return {
      ok: result.ok === true, dual: true, hostA: str(result.hostA, 255), hostB: str(result.hostB, 255),
      a: side(result.a), b: side(result.b),
      comparison: { issues: cleanIssues(c.issues), lossAB: numOrNull(c.lossAB), lossBA: numOrNull(c.lossBA) },
      ...(full ? { reason: str(result.reason, 500) } : {}),
    };
  }
  return single(result);
}

function cleanRecord(r) {
  const d = r.detail && typeof r.detail === 'object' ? r.detail : {};
  const detail = r.mode === 'dual' ? { a: cleanStat(d.a), b: cleanStat(d.b) } : { stat: cleanStat(d.stat) };
  const sm = r.summary && typeof r.summary === 'object' ? r.summary : {};
  const summary = {};
  for (const [k, v] of Object.entries(sm).slice(0, 8)) summary[str(k, 32)] = numOrNull(v);
  return {
    id: r.id.slice(0, 64), at: numOrNull(r.at), source: str(r.source, 16) || 'manual', mode: r.mode === 'dual' ? 'dual' : 'single', via: str(r.via, 16) || 'central',
    monitorName: str(r.monitorName, 200), hostA: str(r.hostA, 255), hostB: str(r.hostB, 255),
    worst: SEVS.has(r.worst) ? r.worst : 'warning', issues: cleanIssues(r.issues), summary, detail,
  };
}

const worstSev = (issues = []) => (issues.some((i) => i.sev === 'error') ? 'error' : issues.some((i) => i.sev === 'warning') ? 'warning' : 'ok');

/** 캡처 결과(단일/dual)에서 이력 레코드 생성·저장. source: 'manual'|'monitor'. */
export function recordCapture(rawResult, meta = {}) {
  load();
  const result = sanitizeCaptureResult(rawResult);
  const id = `cap_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4).toString(36)}`;
  let rec;
  if (result?.dual) {
    const cmp = result.comparison || {};
    rec = {
      id, at: Date.now(), source: meta.source || 'manual', mode: 'dual', via: meta.via || 'central',
      monitorName: str(meta.monitorName, 200), hostA: result.hostA, hostB: result.hostB,
      worst: worstSev(cmp.issues), issues: cmp.issues || [],
      summary: { lossAB: cmp.lossAB, lossBA: cmp.lossBA, aPackets: result.a?.captured ?? null, bPackets: result.b?.captured ?? null },
      detail: { a: result.a?.analysis?.stat || null, b: result.b?.analysis?.stat || null },
    };
  } else {
    const st = result.analysis.stat;
    // v2.600 CEN2600-09: 위임 단일 캡처는 라우트가 meta.hostA 를 넘기지 않는다 — 엣지 워커가 결과에 싣는 hostA 로 채운다.
    rec = {
      id, at: Date.now(), source: meta.source || 'manual', mode: 'single', via: meta.via || 'central',
      monitorName: str(meta.monitorName, 200), hostA: str(meta.hostA, 255) || result.hostA, hostB: result.peer || str(meta.peer, 255),
      worst: worstSev(result.analysis.issues), issues: result.analysis.issues,
      // 못 읽은 수치는 null(예전 `?? 0` 은 '패킷 0·RST 0' 이라는 거짓이었다).
      summary: { packets: st?.packets ?? result.captured, rst: st?.rst ?? null, retransPct: st?.retransPct ?? null, rttMs: st?.rttMs ?? null },
      detail: { stat: st },
    };
  }
  list.unshift(rec);
  if (list.length > MAX) list.length = MAX;
  persist();
  return rec;
}

export function listCaptures({ limit = 100 } = {}) {
  return load().slice(0, limit).map(({ detail, ...m }) => m);
}
export function getCapture(id) { return load().find((r) => r.id === id) || null; }
export function deleteCapture(id) { load(); const before = list.length; list = list.filter((r) => r.id !== id); if (list.length !== before) persist(); return before !== list.length; }

/**
 * vmclone/notify.js — VM 백업 실패 메일(v2.794, 메일 종류 'vm-backup').
 *
 * 사용자 요구(2026-10-26): "백업 기능 … 운영 편의·알림" — 백업·검증·복구가 실패해도 화면을 열어 보기 전에는 몰랐다.
 *
 * 동작(중앙 전용 — 엣지는 기동하지 않는다. SMTP 설정은 중앙에 있다):
 *  · 1분마다 잡 이력을 본다 — 이 포탈이 실행한 잡은 vm-clone.json 의 history, 엣지 위임 잡은 엣지가 올린 보고(dispatch.listEdgeStates)의 history.
 *  · 실패 줄(ok:false)만, 잡마다 **마지막으로 알린 시각 이후**의 것만 모아 한 통으로 보낸다(같은 주기의 실패는 묶는다).
 *  · 처음 보는 잡·이 기능을 처음 켠 설치는 **지금부터** 센다 — 업그레이드하자마자 지난 실패 30회분을 메일로 쏟지 않는다.
 *  · 알리지 않는 건너뜀: 데모 잡·위임(이 노드가 로그인하지 않음)·멈춘 위임 잡 — 운영 실패가 아니다.
 *  · 보내지 못하면(메일 꺼짐·수신자 없음·SMTP 오류) 기준 시각을 옮기지 않는다 — 다음 주기에 다시 시도한다. 단 메일이 꺼져 있거나
 *    이 종류가 꺼져 있으면 옮긴다(나중에 켰을 때 쌓인 실패를 한꺼번에 보내지 않게).
 *  · 데모(mock)에서는 보내지 않는다.
 *
 * 상태 파일: CONFIG_DIR/vm-backup-mail-state.json → { since, jobs: { <jobId>: lastNotifiedAt }, history: [...] } (비밀 없음)
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { store } from '../store.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { registerStateFile } from '../util/stateFiles.js';
import { sendPortalMail } from '../mail/service.js';
import { load as loadMailCfg } from '../mail/settings.js';
import { listJobs } from './store.js';
import { listEdgeStates } from './dispatch.js';
import { localStamp } from '../util/dayKey.js';

export const MAIL_KIND = 'vm-backup';
export const TICK_MS = 60_000;
const MAX_ROWS = 50;          // 한 통에 싣는 실패 줄 상한(넘으면 개수만 밝힌다)
const JOBS_MAX = 2_000;
const HISTORY_MAX = 30;
const QUIET_SKIPS = new Set(['demo-job', 'delegated', 'suspended']);
const KIND_LABEL = { backup: '백업', verify: '검증', restore: '복구' };

registerStateFile('vm-backup-mail-state.json');
const FILE = () => path.join(config.configDir, 'vm-backup-mail-state.json');   // ⚠ 리터럴 형태 유지 — scripts/config-doc.mjs 가 이 모양으로 찾는다
const isEdge = () => !!(config.agent.centralUrl && config.agent.centralToken);
const isMock = () => store.get()?.source === 'mock';

let _state = null;
function state() {
  if (_state) return _state;
  try {
    if (fs.existsSync(FILE())) {
      const raw = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('형식 오류');
      const jobs = {};
      for (const [k, v] of Object.entries(raw.jobs && typeof raw.jobs === 'object' ? raw.jobs : {}).slice(0, JOBS_MAX)) if (Number.isFinite(Number(v))) jobs[k] = Number(v);
      _state = { since: Number(raw.since) || Date.now(), jobs, history: (Array.isArray(raw.history) ? raw.history : []).slice(0, HISTORY_MAX) };
      return _state;
    }
  } catch { preserveCorrupt(FILE()); }
  // 처음(또는 손상) — 지금부터 센다(지난 실패를 쏟지 않는다).
  _state = { since: Date.now(), jobs: {}, history: [] };
  return _state;
}
function save() {
  try { atomicWriteFileSync(FILE(), JSON.stringify(state()), { mode: 0o600 }); }
  catch (e) { console.warn(`[vmclone] 백업 메일 상태를 저장하지 못했습니다(${e?.message || e})`); }
}

/** 메일을 보낼 실패 줄인가(순수). */
export function isMailableFailure(h) {
  return !!h && h.ok === false && !QUIET_SKIPS.has(String(h.skipped || '')) && Number(h.at) > 0;
}

/**
 * 새 실패 줄 모으기(순수 — 테스트 고정).
 * @param {{jobId:string, vmName:string, vcenterId:string, corp:string, history:object[]}[]} sources
 * @param {{since:number, jobs:Record<string,number>}} st
 * @returns {{rows:object[], marks:Record<string,number>}} rows: 시각 순 · marks: 잡별 새 기준 시각(그 잡의 마지막 이력 시각)
 */
export function collectNewFailures(sources, st) {
  const rows = [];
  const marks = {};
  for (const s of sources || []) {
    const hist = Array.isArray(s.history) ? s.history : [];
    const base = Math.max(Number(st?.jobs?.[s.jobId]) || 0, Number(st?.since) || 0);
    let last = base;
    for (const h of hist) {
      const at = Number(h?.at) || 0;
      if (at <= base) continue;
      if (at > last) last = at;
      if (isMailableFailure(h)) rows.push({ at, jobId: s.jobId, vmName: s.vmName, vcenterId: s.vcenterId, corp: s.corp, kind: KIND_LABEL[h.kind] || '백업', detail: String(h.detail || '').slice(0, 300), skipped: h.skipped || '' });
    }
    if (last > base) marks[s.jobId] = last;
  }
  rows.sort((a, b) => a.at - b.at);
  return { rows, marks };
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 메일 본문(순수). */
export function renderFailureMail(rows, vcName = (id) => id) {
  const shown = rows.slice(0, MAX_ROWS);
  const more = rows.length - shown.length;
  const vms = [...new Set(rows.map((r) => r.vmName))];
  const subject = `[VM 백업] 실패 ${rows.length}건 — ${vms.slice(0, 3).join(', ')}${vms.length > 3 ? ` 외 ${vms.length - 3}` : ''}`;
  const tr = shown.map((r) => `<tr><td style="padding:4px 8px;white-space:nowrap">${esc(localStamp(r.at))}</td><td style="padding:4px 8px">${esc(r.corp)}</td><td style="padding:4px 8px">${esc(vcName(r.vcenterId))}</td><td style="padding:4px 8px"><b>${esc(r.vmName)}</b></td><td style="padding:4px 8px">${esc(r.kind)}</td><td style="padding:4px 8px">${esc(r.detail)}</td></tr>`).join('');
  const html = `<div style="font-family:sans-serif;font-size:13px">` +
    `<p>VM 백업 센터에서 실패가 ${rows.length}건 있었습니다. 자세한 단계는 포탈 › 특수 기능 › VM 복제(백업) › 잡 상세에서 볼 수 있습니다.</p>` +
    `<table style="border-collapse:collapse;font-size:12.5px" border="1" cellspacing="0"><thead><tr style="background:#f1f5f9"><th style="padding:4px 8px">시각</th><th style="padding:4px 8px">법인</th><th style="padding:4px 8px">vCenter</th><th style="padding:4px 8px">VM</th><th style="padding:4px 8px">종류</th><th style="padding:4px 8px">사유</th></tr></thead><tbody>${tr}</tbody></table>` +
    (more > 0 ? `<p>그 밖에 ${more}건은 메일에 싣지 않았습니다 — 포탈에서 확인하세요.</p>` : '') +
    `<p style="color:#64748b">이 메일은 설정 › 메일 발송의 'VM 백업 실패' 종류로 보냈습니다. 같은 1분 확인 주기의 실패는 한 통으로 묶습니다.</p></div>`;
  const text = [`VM 백업 실패 ${rows.length}건`, ...shown.map((r) => `${localStamp(r.at)} · ${r.corp} · ${vcName(r.vcenterId)} · ${r.vmName} · ${r.kind} · ${r.detail}`), ...(more > 0 ? [`그 밖에 ${more}건`] : [])].join('\n');
  return { subject, html, text };
}

/** 볼 이력 묶음(순수) — 이 포탈의 잡(실행 노드가 여기인 잡) + 엣지가 보고한 위임 잡(이름·vCenter 는 중앙 정의에서). */
export function sourcesOf(jobs, edges) {
  const central = new Map((jobs || []).map((j) => [j.id, j]));
  const edgeJobIds = new Set();
  const out = [];
  for (const e of edges || []) {
    const recvAt = Number(e.at) || 0;
    for (const [jobId, st] of e.jobs || []) {
      const def = central.get(jobId);
      if (!def) continue;   // 보고 수신이 이미 거른다(중앙 잡이 아닌 것) — 이중 방어
      edgeJobIds.add(jobId);
      // 엣지 시각은 수신 시각으로 자른다(CLAUDE.md 엣지 규약) — 시계가 앞선 엣지가 기준 시각을 미래로 밀어 다음 실패를 묻지 않게.
      const history = (st.history || []).map((h) => ({ ...h, at: Math.min(Number(h?.at) || 0, recvAt || Number(h?.at) || 0) }));
      out.push({ jobId, vmName: def.vmName, vcenterId: def.vcenterId, corp: e.agent, history });
    }
  }
  for (const j of jobs || []) {
    if (edgeJobIds.has(j.id)) continue;   // 위임 잡: 실행 상태는 엣지 보고가 진실이다(중앙 정의에는 이력이 없다)
    out.push({ jobId: j.id, vmName: j.vmName, vcenterId: j.vcenterId, corp: '중앙', history: j.history || [] });
  }
  return out;
}
const sourcesNow = () => sourcesOf(listJobs(), listEdgeStates());

let _busy = false;
let _timer = null;
let _last = null;   // { at, sent, rows, reason }

export async function tick(now = Date.now()) {
  if (_busy || isMock()) return;
  _busy = true;
  try {
    const st = state();
    const { rows, marks } = collectNewFailures(sourcesNow(), st);
    const advance = () => { Object.assign(st.jobs, marks); save(); };
    if (!Object.keys(marks).length) return;
    if (!rows.length) { advance(); return; }   // 성공 줄만 새로 생겼다 — 기준만 옮긴다
    const cfg = loadMailCfg();
    if (!cfg?.enabled || cfg?.kinds?.[MAIL_KIND]?.enabled === false) { advance(); _last = { at: now, sent: false, rows: rows.length, reason: '메일 발송 또는 이 종류가 꺼져 있습니다' }; return; }
    const names = new Map((store.get()?.vcenters || []).map((v) => [String(v.id), v.name || v.id]));
    const m = renderFailureMail(rows, (id) => names.get(String(id)) || id);
    const r = await sendPortalMail({ kind: MAIL_KIND, subject: m.subject, html: m.html, text: m.text, by: 'system' });
    _last = { at: now, sent: !!r?.ok, rows: rows.length, ...(r?.ok ? {} : { reason: String(r?.reason || '발송 실패').slice(0, 200) }) };
    if (r?.ok) {
      advance();
      st.history.unshift({ at: now, rows: rows.length, subject: m.subject.slice(0, 200) });
      st.history.splice(HISTORY_MAX);
      save();
    }
    // 실패면 기준을 옮기지 않는다 — 다음 주기에 같은 줄을 다시 보낸다(메일 서비스의 속도 제한·인증 정지가 폭주를 막는다).
  } catch (e) {
    _last = { at: now, sent: false, rows: 0, reason: String(e?.message || e).slice(0, 200) };
  } finally { _busy = false; }
}

export function vmBackupMailStatus() { return _last ? { ..._last } : null; }

export function startVmBackupMail() {
  if (_timer || isEdge()) return;
  _timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  _timer.unref?.();
}

export function _resetForTest() { _state = null; _busy = false; _last = null; }

/**
 * bareos/digest.js — Bareos 일일 요약 메일(v2.862 · 사용자 결정 ⓕ '켬 · 08:30' · 시안 §11 ⑤ — 메일 종류 'bareos-digest').
 *
 * 커뮤니티 조사(Veeam 포럼 '잡은 성공인데 15대 중 3대만 백업' — VM 단위로 봐야 한다): 법인마다 최근 24시간의 백업 결과를 VM 단위로 세고,
 * 실패한 VM · 복원 · 복원 검증(리허설) 결과를 한 통으로 보낸다. 모양은 veeam/staleAlert.js(정한 시각 · 하루 한 번 · 실패 30분 뒤 · 3번)를 따른다.
 *  · 원장(bareos-jobs.json)과 폴러 상태만 읽는다 — Director 에 닿지 않는다.
 *  · '결과 모름' 은 0 이 아니다: 그 법인 Director 조회가 실패 중이면 법인 줄을 '모름' 으로 쓰고 성공 · 실패 수를 지어내지 않는다.
 *  · 데모(mock) · 엣지는 보내지 않는다. 메일 · 이 종류가 꺼져 있으면 계산하지 않는다.
 * 설정: CONFIG_DIR/bareos-digest.json → { enabled(기본 켬), time:'HH:MM'(포탈 시각) } · 상태: bareos-digest-state.json(비밀 없음).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt, safeLoadText } from '../util/atomicWrite.js';
import { makeLoadError } from '../util/registryCore.js';
import { registerStateFile } from '../util/stateFiles.js';
import { localClock, localStamp } from '../util/dayKey.js';
import { sendPortalMail } from '../mail/service.js';
import { load as loadMailCfg } from '../mail/settings.js';
import { isMockMode } from '../mock/demo/flags.js';
import { listJobs, registryLoadError } from './registry.js';
import { loadSettings, jobDirectorId } from './settings.js';

export const MAIL_KIND = 'bareos-digest';
export const TICK_MS = 60_000;
export const RETRY_MS = 30 * 60_000;
export const TRIES_MAX = 3;
export const WINDOW_MS = 24 * 3600_000;
export const ROWS_MAX = 100;
registerStateFile('bareos-digest-state.json');
const FILE = () => path.join(config.configDir, 'bareos-digest.json');   // ⚠ 리터럴 형태 유지 — scripts/config-doc.mjs 가 이 모양으로 파일을 찾는다
const STATE_FILE = () => path.join(config.configDir, 'bareos-digest-state.json');
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const DEFAULTS = Object.freeze({ enabled: true, time: '08:30' });
const fail = (code, msg) => Object.assign(new Error(msg), { code });
const isEdge = () => !!(config.agent?.centralUrl && config.agent?.centralToken);

let _cfg = null; const _loadErr = makeLoadError();
let _state = null; let _busy = false; let _timer = null; let _poller = null;

export function normDigest(body = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const time = String(b.time ?? DEFAULTS.time);
  if (!TIME_RE.test(time)) throw fail('invalid', '보낼 시각은 HH:MM(00:00~23:59)으로 적으세요.');
  return { enabled: b.enabled !== false, time };
}
export function loadDigest() {
  if (_cfg) return _cfg;
  try {
    if (fs.existsSync(FILE())) {
      const p = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
      if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('형식 오류');
      _cfg = { ...normDigest(p), savedBy: String(p.savedBy || '').slice(0, 64), savedAt: Number.isFinite(p.savedAt) ? p.savedAt : null };
      _loadErr.clear();
      return _cfg;
    }
  } catch (e) {
    preserveCorrupt(FILE(), e?.message);
    _loadErr.set(e);
    console.warn(`[bareos] 일일 요약 메일 설정을 읽지 못했습니다(${safeLoadText(e) || '사유 미상'}) — 손상본을 보존했습니다(보내지 않고 저장을 막습니다).`);
  }
  _cfg = { ...DEFAULTS, savedBy: '', savedAt: null };
  _loadErr.checkCorruptOnly(FILE());
  return _cfg;
}
export function digestLoadError() { loadDigest(); return _loadErr.get(); }
export function saveDigest(body, { by = '', now = Date.now() } = {}) {
  if (digestLoadError()) throw fail('unreadable', '일일 요약 메일 설정 파일을 읽지 못해 저장하지 않습니다 — 손상본을 확인하세요.');
  const next = { ...normDigest(body), savedBy: String(by || '').slice(0, 64), savedAt: now };
  atomicWriteFileSync(FILE(), JSON.stringify(next, null, 2), { mode: 0o600 });
  _cfg = next;
  return { ...next };
}
function state() {
  if (_state) return _state;
  try { _state = fs.existsSync(STATE_FILE()) ? JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8')) : {}; } catch { _state = {}; }
  if (!_state || typeof _state !== 'object' || Array.isArray(_state)) _state = {};
  return _state;
}
function saveState() {
  try { atomicWriteFileSync(STATE_FILE(), JSON.stringify(_state), { mode: 0o600 }); } catch (e) { console.warn(`[bareos] 일일 요약 메일 상태를 저장하지 못했습니다(${e?.message || e})`); }
}
export function digestStatus() { const s = state(); return { day: s.day || '', at: s.at ?? null, ok: s.ok ?? null, reason: s.reason || '', tries: s.tries || 0 }; }
export function _resetDigestForTest() { _cfg = null; _state = null; _busy = false; _loadErr.clear(); }
/** 폴러 상태 공급자(Director 별 조회 성공 여부) — poller 를 import 하면 순환이라 기동 때 넣는다. */
export function setDigestPoller(fn) { _poller = typeof fn === 'function' ? fn : null; }

/** 지금 보낼 차례인가(순수) — staleAlert.dueOf 와 같은 규칙. */
export function dueOf(cfg, st, now = Date.now()) {
  const c = localClock(now);
  const day = c.day;
  if (!cfg?.enabled || !TIME_RE.test(cfg.time || '')) return { due: false, day };
  const [h, m] = cfg.time.split(':').map(Number);
  if (c.hour * 60 + c.minute < h * 60 + m) return { due: false, day };
  if (st?.day === day && st?.ok === true) return { due: false, day };
  const tries = st?.day === day ? Number(st.tries) || 0 : 0;
  if (tries >= TRIES_MAX) return { due: false, day };
  if (st?.day === day && Number.isFinite(st.nextTry) && now < st.nextTry) return { due: false, day };
  return { due: true, day };
}

const OKS = new Set(['ok', 'warning']);
/**
 * 복원 검증(리허설) 한 행의 결과 — 'ok' | 'failed' | 'pending'(v2.869 감사 A2-02 — 판정 코어 하나).
 *   웹 bareosRestoreText.verifyOutcome 과 한 쌍(server/test/bareosVerifyOutcome2869.test.js 가 같은 입력으로 대조).
 *   failed = 훅이 실패를 썼거나(verify 'failed') · 끊기 · 켜 보기를 못 했거나(nic 'failed' — 추적 놓침 · 재시도 소진 · 보내지 못함 · 이름 모름) ·
 *            복원이 성공으로 끝나지 않았거나(nic 'skipped' · state error · canceled) · 추적을 놓친 복원(abandoned).
 *   ⚠ 실패 경로에 verify:'failed' 를 써 넣지 않는다 — 리허설 표 '남김' 칸이 finish.verify 유무로 판정한다(VM 이 없는데 '남김' 으로 보인다).
 */
export function verifyOutcome(r) {
  const f = r?.finish;
  if (f?.verify === 'ok') return 'ok';
  if (f?.verify === 'failed' || f?.nic === 'failed' || f?.nic === 'skipped' || r?.state === 'error' || r?.state === 'canceled' || r?.abandoned) return 'failed';
  return 'pending';
}

/**
 * 요약 계산(순수) — 법인(Director)마다 최근 24시간. 그 Director 조회가 실패 중이면 known:false(수를 만들지 않는다).
 * @param {object[]} jobs 원장 · @param {object} settings · @param {Record<string,{ok?:boolean, code?:string}>} dirStatus
 */
export function digestData(jobs, settings, dirStatus = {}, now = Date.now()) {
  const since = now - WINDOW_MS;
  const corps = new Map();
  const fails = [];
  // 반증 F4(재현): 'ok !== false' 는 조회 기록이 없거나(기동 직후 · 접속값 덜 됨 · 엣지 첫 회신 전) ok:null 인 법인을 '안다' 로 셌다 — 조회 성공이 확인된 법인만 안다
  const knownOf = (id) => dirStatus[id]?.ok === true;
  const blank = (id, name) => ({ id, name, known: knownOf(id), code: dirStatus[id]?.code || '', targets: 0, ran: 0, ok: 0, warn: 0, fail: 0, cancel: 0, stale: 0, restores: 0, restoreFail: 0, nicFail: 0, verifyOk: 0, verifyFail: 0 });
  for (const d of settings?.directors || []) corps.set(d.id, blank(d.id, d.name || d.id));
  for (const j of Array.isArray(jobs) ? jobs : []) {
    if (j.demo || j.enabled === false) continue;
    const dir = jobDirectorId(j, settings);
    const c = corps.get(dir) || corps.set(dir, blank(dir, dir)).get(dir);
    c.targets += 1;
    const lr = j.lastRun;
    const at = Number(lr?.endedAt || lr?.startedAt || 0);
    if (lr && at >= since) {
      c.ran += 1;
      if (lr.state === 'ok') c.ok += 1;
      else if (lr.state === 'warning') c.warn += 1;
      else if (lr.state === 'canceled') c.cancel += 1;   // 반증 F4: 취소는 어느 칸에도 세지 않아 사라졌다
      else if (lr.state === 'error') { c.fail += 1; if (fails.length < ROWS_MAX) fails.push({ corp: c.name, vcenterId: j.vcenterId, vmName: j.vmName, jobid: lr.jobid ?? null, at, message: String(j.lastError?.message || '').slice(0, 160) }); }
    } else c.stale += 1;
    for (const r of j.restores || []) {
      if ((Number(r.at) || 0) < since) continue;
      if (r.verify) { const v = verifyOutcome(r); if (v === 'ok') c.verifyOk += 1; else if (v === 'failed') c.verifyFail += 1; continue; }
      c.restores += 1;
      if (r.state === 'error') c.restoreFail += 1;
      if (r.finish?.nic === 'failed') c.nicFail += 1;
    }
  }
  const rows = [...corps.values()].filter((c) => c.targets > 0).sort((a, b) => (b.fail - a.fail) || String(a.name).localeCompare(String(b.name)));
  const known = rows.filter((c) => c.known);
  return {
    rows, fails,
    total: { corps: rows.length, unknown: rows.length - known.length, targets: rows.reduce((n, c) => n + c.targets, 0), ok: known.reduce((n, c) => n + c.ok, 0), warn: known.reduce((n, c) => n + c.warn, 0), fail: known.reduce((n, c) => n + c.fail, 0), cancel: known.reduce((n, c) => n + c.cancel, 0), stale: known.reduce((n, c) => n + c.stale, 0), verifyFail: rows.reduce((n, c) => n + c.verifyFail, 0) },
  };
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
/** 메일 본문(순수) — 값은 전부 esc · 인라인 스타일 · 포탈 링크 없음(메뉴 경로를 글로). '모름' 법인은 수 대신 '모름'. */
export function renderDigest(d, now = Date.now()) {
  const t = d.total;
  // 모든 법인이 모름이면 숫자 0 을 앞세우지 않는다(반증 F4 — '실패 0 · 성공 0' 이 먼저 보였다)
  const head = t.corps && t.unknown === t.corps
    ? `Bareos 일일 요약 — 모든 법인 결과 모름(${t.corps}곳 · Director 조회 실패 또는 조회 전)`
    : `Bareos 일일 요약 — 실패 ${t.fail} · 경고 ${t.warn} · 성공 ${t.ok}${t.cancel ? ` · 취소 ${t.cancel}` : ''}${t.unknown ? ` · 결과 모름 법인 ${t.unknown}` : ''}`;
  const subject = `[Bareos] ${head}`.slice(0, 200);
  const td = 'style="padding:4px 8px;border-bottom:1px solid #e5e7eb;font-size:12px"';
  const th = 'style="padding:4px 8px;border-bottom:2px solid #9ca3af;font-size:12px;text-align:left"';
  const n = (c, v) => (c.known ? String(v) : '모름');
  const corpRows = d.rows.map((c) => `<tr><td ${td}>${esc(c.name)}${c.known ? '' : ` (Director 조회 실패 또는 조회 전${c.code ? ` · ${esc(c.code)}` : ''})`}</td><td ${td}>${c.targets}</td><td ${td}>${n(c, c.ok)}</td><td ${td}>${n(c, c.warn)}</td><td ${td}>${n(c, c.fail)}</td><td ${td}>${n(c, c.cancel)}</td><td ${td}>${n(c, c.stale)}</td><td ${td}>${c.restores}${c.restoreFail ? ` (실패 ${c.restoreFail})` : ''}${c.nicFail ? ` · 네트워크 끊기 실패 ${c.nicFail}` : ''}</td><td ${td}>${c.verifyOk + c.verifyFail ? `성공 ${c.verifyOk} · 실패 ${c.verifyFail}` : '—'}</td></tr>`).join('');
  const failRows = d.fails.map((f) => `<tr><td ${td}>${esc(f.corp)}</td><td ${td}>${esc(f.vmName)}</td><td ${td}>${esc(f.jobid ?? '—')}</td><td ${td}>${esc(localStamp(f.at) || '—')}</td><td ${td}>${esc(f.message || '—')}</td></tr>`).join('');
  const html = `<div style="font-family:sans-serif;color:#111827"><h3 style="margin:0 0 6px">${esc(head)}</h3>`
    + `<p style="margin:0 0 10px;color:#4b5563;font-size:13px">최근 24시간(${esc(localStamp(now - WINDOW_MS))} ~ ${esc(localStamp(now))}) · 법인 ${t.corps}곳 · 백업 대상 ${t.targets}대 · 24시간 안에 실행 없음 ${t.stale}대${t.verifyFail ? ` · 복원 검증 실패 ${t.verifyFail}` : ''}</p>`
    + `<table style="border-collapse:collapse"><thead><tr><th ${th}>법인</th><th ${th}>대상</th><th ${th}>성공</th><th ${th}>경고</th><th ${th}>실패</th><th ${th}>취소</th><th ${th}>실행 없음</th><th ${th}>복원</th><th ${th}>복원 검증</th></tr></thead><tbody>${corpRows}</tbody></table>`
    + (failRows ? `<h4 style="margin:14px 0 6px">실패한 VM</h4><table style="border-collapse:collapse"><thead><tr><th ${th}>법인</th><th ${th}>VM</th><th ${th}>jobid</th><th ${th}>끝난 시각</th><th ${th}>오류</th></tr></thead><tbody>${failRows}</tbody></table>` : '')
    + `<p style="font-size:11px;color:#6b7280">결과는 포탈 원장(폴러가 Director 카탈로그로 갱신한 마지막 실행) 기준입니다 · Director 조회가 실패 중인 법인은 수를 만들지 않고 '모름' 으로 적습니다 · 포탈 › 서버 › Backup › Bareos 에서 자세히 볼 수 있습니다 · 설정 › 공통 기본값 · 수집에서 끄거나 시각을 바꿉니다.</p></div>`;
  const text = `${head}\n${d.rows.map((c) => `${c.name}\t대상 ${c.targets}\t성공 ${n(c, c.ok)}\t경고 ${n(c, c.warn)}\t실패 ${n(c, c.fail)}`).join('\n')}${d.fails.length ? `\n\n실패한 VM\n${d.fails.map((f) => `${f.corp}\t${f.vmName}\t${f.jobid ?? '—'}`).join('\n')}` : ''}`;
  return { subject, html, text };
}

function dirStatusNow() {
  try { const p = _poller ? _poller() : null; return Object.fromEntries(Object.entries(p?.directors || {}).map(([k, v]) => [k, { ok: v?.ok, code: v?.code || '' }])); } catch { return {}; }
}
async function computeAndSend({ by = 'system', now = Date.now() } = {}) {
  if (registryLoadError()) return { ok: false, reason: '백업 대상 원장을 읽지 못했습니다 — 요약을 만들지 않았습니다.' };
  const d = digestData(listJobs(), loadSettings(), dirStatusNow(), now);
  if (!d.rows.length) return { ok: true, reason: '백업 대상이 없어 보내지 않았습니다.', skipped: true };
  const m = renderDigest(d, now);
  const r = await sendPortalMail({ kind: MAIL_KIND, subject: m.subject, html: m.html, text: m.text, by });
  return { ok: !!r?.ok, reason: r?.ok ? '' : String(r?.reason || '발송 실패').slice(0, 200) };
}

/** 틱 — 차례면 한 번 보낸다(재진입 가드 · 데모 · 엣지 제외 · 메일 꺼짐이면 계산하지 않음). */
export async function tick(now = Date.now()) {
  if (_busy || isMockMode()) return null;
  _busy = true;
  try {
    const cfg = loadDigest();
    if (digestLoadError() || !cfg.enabled) return null;
    const mail = loadMailCfg();
    if (!mail?.enabled || mail?.kinds?.[MAIL_KIND]?.enabled === false) return null;
    const st = state();
    const { due, day } = dueOf(cfg, st, now);
    if (!due) return null;
    const tries = st.day === day ? (Number(st.tries) || 0) + 1 : 1;
    let r;
    try { r = await computeAndSend({ now }); } catch (e) { r = { ok: false, reason: String(e?.message || e).slice(0, 200) }; }
    _state = { day, at: now, ok: r.ok, reason: r.reason || '', tries, nextTry: r.ok ? null : now + RETRY_MS };
    saveState();
    return r;
  } finally { _busy = false; }
}
/** '지금 보내 보기'(관리자) — 오늘 발송 기록은 바꾸지 않는다. */
export async function sendDigestNow({ by = '' } = {}) {
  if (_busy) return { ok: false, reason: '다른 발송이 진행 중입니다 — 잠시 뒤 다시 누르세요.' };
  _busy = true;
  try { return await computeAndSend({ by }); } catch (e) { return { ok: false, reason: String(e?.message || e).slice(0, 200) }; } finally { _busy = false; }
}
export function startBareosDigest() {
  if (_timer || isEdge()) return;
  _timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  _timer.unref?.();
}

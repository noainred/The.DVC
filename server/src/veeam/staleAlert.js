/**
 * veeam/staleAlert.js — '백업 안 된 VM' 일일 메일(v2.838 · 시안 ① '이 조건을 알림으로(메일)' · 사용자 결정 '일일 메일로 구현').
 *
 * 설정: CONFIG_DIR/backup-stale-alert.json → { enabled, time:'HH:MM'(포탈 시각), q:{ n, unit, src, excludeNone, onlyOn, includeNever, vc }, savedBy, savedAt }
 *   원자적 쓰기 · 손상 보존(못 읽으면 저장을 거부하고 보내지 않는다 — 조용히 기본값으로 덮지 않는다). 비밀 없음.
 * 상태: CONFIG_DIR/backup-stale-alert-state.json → { day, at, ok, n, total, reason, tries, nextTry } — 상태 파일(백업 감시 제외).
 * 틱(1분): 메일 · 이 종류 · 이 설정이 모두 켜져 있고, 오늘(포탈 시각) 정한 시각이 지났고, 오늘 보낸 적이 없으면 한 번 계산해 보낸다.
 *   실패하면 30분 뒤 다시(오늘 안에서만 · 하루 3번까지) — 실패가 이어져도 매분 계산하지 않는다. 포탈이 꺼져 있다 그날 켜지면 그때 보낸다.
 *   계산은 등록된 provider(라우트 — 전 법인 · 시스템 계정 · 화면 찾기와 같은 판정)로 한다 — 이 모듈은 라우트를 import 하지 않는다.
 * 메일 종류 'backup-stale'(mail/kinds.js) — 수신자는 설정 › 메일 발송에서 이 종류의 수신자(비우면 기본 수신자).
 * 엣지에서는 돌지 않는다(중앙 전용 — 전 법인 자료).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt, safeLoadText } from '../util/atomicWrite.js';
import { makeLoadError } from '../util/registryCore.js';
import { registerStateFile } from '../util/stateFiles.js';
import { localClock, localStamp } from '../util/dayKey.js';
import { staleQueryOf } from './backupSummaryAgg.js';
import { sendPortalMail } from '../mail/service.js';
import { load as loadMailCfg } from '../mail/settings.js';
import { isMockMode } from '../mock/demo/flags.js';

export const MAIL_KIND = 'backup-stale';
export const TICK_MS = 60_000;
export const RETRY_MS = 30 * 60_000;
export const TRIES_MAX = 3;
export const MAIL_ROWS_MAX = 200;
export const RUN_DEADLINE_MS = 5 * 60_000;   // 계산 + 발송 시한 — 끝나지 않는 한 번이 재진입 가드를 영원히 붙잡지 않게(폴러 규약)
registerStateFile('backup-stale-alert-state.json');
const FILE = () => path.join(config.configDir, 'backup-stale-alert.json');   // ⚠ 리터럴 형태 유지 — scripts/config-doc.mjs 가 이 모양으로 파일을 찾는다
const STATE_FILE = () => path.join(config.configDir, 'backup-stale-alert-state.json');
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DEFAULTS = Object.freeze({ enabled: false, time: '08:30', q: { n: 3, unit: 'd', src: 'all', excludeNone: true, onlyOn: true, includeNever: true, vc: '' }, savedBy: '', savedAt: null });
const fail = (code, msg) => Object.assign(new Error(msg), { code });
const isEdge = () => !!(config.agent?.centralUrl && config.agent?.centralToken);

let _cfg = null; const _loadErr = makeLoadError();
let _state = null; let _busy = false; let _timer = null; let _provider = null; let _rev = 0;

/** 조건 정규화 — 화면 찾기와 같은 규칙(staleQueryOf) · 기간이 틀리면 거부. */
export function normAlert(body = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const time = String(b.time ?? DEFAULTS.time);
  if (!TIME_RE.test(time)) throw fail('invalid', '보낼 시각은 HH:MM(00:00~23:59)으로 적으세요.');
  const qb = b.q && typeof b.q === 'object' ? b.q : {};
  const q = staleQueryOf({ ...qb, n: qb.n, excludeNone: qb.excludeNone === false ? '0' : '1', onlyOn: qb.onlyOn === false ? '0' : '1', includeNever: qb.includeNever === false ? '0' : '1' });
  if (q.windowMs == null) throw fail('invalid', '기간은 1~999 사이 정수로 적으세요.');
  return { enabled: b.enabled === true, time, q: { n: q.n, unit: q.unit, src: q.src, excludeNone: q.excludeNone, onlyOn: q.onlyOn, includeNever: q.includeNever, vc: q.vc } };
}

export function loadAlert() {
  if (_cfg) return _cfg;
  try {
    if (fs.existsSync(FILE())) {
      const p = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
      if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('형식 오류');
      const n = normAlert(p);
      _cfg = { ...n, savedBy: String(p.savedBy || '').slice(0, 64), savedAt: Number.isFinite(p.savedAt) ? p.savedAt : null };
      _loadErr.clear();
      return _cfg;
    }
  } catch (e) {
    preserveCorrupt(FILE(), e?.message);
    _loadErr.set(e);
    console.warn(`[backup] 백업 안 된 VM 메일 설정을 읽지 못했습니다(${safeLoadText(e) || '사유 미상'}) — 손상본을 보존했습니다(보내지 않고 저장을 막습니다).`);
  }
  _cfg = { ...DEFAULTS, q: { ...DEFAULTS.q } };
  _loadErr.checkCorruptOnly(FILE());
  return _cfg;
}
export function alertLoadError() { loadAlert(); return _loadErr.get(); }
export const alertRev = () => _rev;

/** 저장(관리자 · 전체 범위 — 라우트가 정한다). 못 읽은 설정 위에는 쓰지 않는다(손상본을 빈 값으로 덮지 않게). */
export function saveAlert(body, { by = '', now = Date.now() } = {}) {
  if (alertLoadError()) throw fail('unreadable', '메일 설정 파일을 읽지 못해 저장하지 않습니다 — 손상본을 확인하세요.');
  const n = normAlert(body);
  const next = { ...n, savedBy: String(by || '').slice(0, 64), savedAt: now };
  atomicWriteFileSync(FILE(), JSON.stringify(next, null, 2), { mode: 0o600 });
  _cfg = next; _rev++;
  return { ...next };
}

function state() {
  if (_state) return _state;
  try { _state = fs.existsSync(STATE_FILE()) ? JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8')) : {}; } catch { _state = {}; }
  if (!_state || typeof _state !== 'object' || Array.isArray(_state)) _state = {};
  return _state;
}
function saveState() {
  try { atomicWriteFileSync(STATE_FILE(), JSON.stringify(_state), { mode: 0o600 }); } catch (e) { console.warn(`[backup] 백업 안 된 VM 메일 상태를 저장하지 못했습니다(${e?.message || e})`); }
}
/** 화면용 — 마지막 발송 결과. */
export function alertStatus() { const s = state(); return { day: s.day || '', at: s.at ?? null, ok: s.ok ?? null, n: s.n ?? null, total: s.total ?? null, reason: s.reason || '', tries: s.tries || 0 }; }

/**
 * 지금 보낼 차례인가(순수) — 포탈 시각으로 오늘 그 시각이 지났고, 오늘 성공한 적이 없고, 재시도 시한이 지났고, 오늘 시도가 상한 안.
 * @returns {{ due:boolean, day:string }}
 */
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

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const UNIT = { h: '시간', d: '일', w: '주' };
const KIND = { never: '한 번도 없음', old: '기준 넘음', unknown: '모름' };
const POL = { veeam: 'Veeam', bareos: 'Bareos', ssh: 'SSH', none: '백업 안함', check: '확인 필요' };
/**
 * 메일 본문(순수) — 값은 전부 esc · 인라인 스타일 · 포탈 링크 없음(메뉴 경로를 글로 적는다 — bareos/notify 와 같은 규칙).
 * @param {object} d staleData 결과(rows · n · never · old · unknown · failing · excluded · total · sites · q)
 */
export function renderStaleMail(d, { vcLabel = '' } = {}) {
  const q = d?.q || {};
  const unit = UNIT[q.unit] || '일';
  const head = `최근 ${q.n}${unit} 동안 성공한 백업이 없는 VM ${d.n}대`;
  const subject = `[Backup] ${head}${vcLabel ? ` — ${vcLabel}` : ''}`;
  const sub = `한 번도 없음 ${d.never} · 기준 넘음 ${d.old} · 실패만 반복 ${d.failing ?? 0} · 법인 ${d.sites}곳${q.excludeNone ? ` · 백업 안함 정책 ${d.excluded?.none ?? 0}대 제외` : ''}${q.onlyOn ? ` · 꺼진 VM ${d.excluded?.off ?? 0}대 제외` : ''}${d.unknown ? ` · 결과를 못 읽은 ${d.unknown}대는 모름으로 따로` : ''}`;
  const rows = (d.rows || []).filter((x) => x.kind !== 'unknown').slice(0, MAIL_ROWS_MAX);
  const more = Math.max(0, (d.n || 0) - rows.length);
  const td = 'style="padding:4px 8px;border-bottom:1px solid #e5e7eb;font-size:12px"';
  const th = 'style="padding:4px 8px;border-bottom:2px solid #9ca3af;font-size:12px;text-align:left"';
  const tr = rows.map((x) => {
    const vm = x.vm || {};
    return `<tr><td ${td}>${esc(x.vcName)}</td><td ${td}>${esc(vm.name)}</td><td ${td}>${esc(String(vm.folder || '').split('/').filter((p) => p && p !== 'vm').slice(-2).join(' › '))}</td><td ${td}>${esc(POL[vm.p] || '모름')}</td><td ${td}>${esc(KIND[x.kind] || '')}</td><td ${td}>${esc(x.last ? localStamp(x.last) : '없음')}</td><td ${td}>${vm.mm === true ? '정책≠실제' : ''}${Array.isArray(vm.e) && vm.e.some((e) => e?.r === 'fail') ? ' · 최근 24시간 실패' : ''}</td></tr>`;
  }).join('');
  const html = `<div style="font-family:sans-serif;color:#111827"><h3 style="margin:0 0 6px">${esc(head)}</h3><p style="margin:0 0 10px;color:#4b5563;font-size:13px">${esc(sub)}</p>`
    + `<table style="border-collapse:collapse"><thead><tr><th ${th}>법인</th><th ${th}>VM</th><th ${th}>폴더</th><th ${th}>백업 정책</th><th ${th}>판정</th><th ${th}>마지막 성공</th><th ${th}>참고</th></tr></thead><tbody>${tr}</tbody></table>`
    + `${more ? `<p style="font-size:12px;color:#4b5563">… ${more}대 더 — 포탈 › 서버 › Backup › Summary 의 '백업 안 된 VM 찾기' 에서 전부 보고 CSV 로 받을 수 있습니다.</p>` : ''}`
    + `<p style="font-size:11px;color:#6b7280">마지막 성공 = Veeam 백업 완료 · Bareos 성공(T·W) 중 가장 늦은 것(포탈 시각) · 결과를 못 읽은 VM 은 목록에 넣지 않고 수만 따로 셉니다 · 이 메일은 포탈 › Backup › Summary 의 '이 조건을 알림으로(메일)' 설정으로 하루 한 번 보냅니다.</p></div>`;
  const text = `${head}\n${sub}\n\n${rows.map((x) => `${x.vcName}\t${x.vm?.name}\t${KIND[x.kind] || ''}\t${x.last ? localStamp(x.last) : '없음'}`).join('\n')}${more ? `\n… ${more}대 더` : ''}`;
  return { subject: subject.slice(0, 200), html, text };
}

/** provider 등록 — (q) => Promise<staleData 결과>. 라우트가 기동 때 등록한다. */
export function setStaleProvider(fn) { _provider = typeof fn === 'function' ? fn : null; }

/**
 * 시한이 지나면 결과를 포기한다 — 계산기(staleData)는 signal 을 받지 않는 읽기 전용 집계라 끊을 세션이 없다.
 *   util/deadline.withDeadline 은 signal 만 끊고 끝까지 기다리므로 여기서는 가드를 풀지 못한다(그래서 따로 둔다).
 */
function giveUpAfter(ms, p) {
  let t;
  const timer = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`백업 안 된 VM 계산 시한 초과(${Math.round(ms / 1000)}초)`)), ms); });
  return Promise.race([Promise.resolve(p), timer]).finally(() => clearTimeout(t));
}

async function computeAndSend(cfg, { by = 'system' } = {}) {
  if (!_provider) return { ok: false, reason: '계산기가 아직 준비되지 않았습니다.' };
  const d = await giveUpAfter(RUN_DEADLINE_MS, _provider(cfg.q));
  const vcLabel = cfg.q.vc ? (d.rows?.[0]?.vcName || cfg.q.vc) : '';
  const m = renderStaleMail(d, { vcLabel });
  const r = await sendPortalMail({ kind: MAIL_KIND, subject: m.subject, html: m.html, text: m.text, by });
  return { ok: !!r?.ok, n: d.n, total: d.total, reason: r?.ok ? '' : String(r?.reason || '발송 실패').slice(0, 200) };
}

/** 틱 — 차례면 한 번 보낸다(재진입 가드 · 데모 · 엣지 제외). */
export async function tick(now = Date.now()) {
  if (_busy || isMockMode()) return null;
  _busy = true;
  try {
    const cfg = loadAlert();
    if (alertLoadError() || !cfg.enabled) return null;
    const mail = loadMailCfg();
    if (!mail?.enabled || mail?.kinds?.[MAIL_KIND]?.enabled === false) return null;   // 메일이 꺼져 있으면 계산하지 않는다(켜면 그날 시각 뒤 다음 틱에 보낸다)
    const st = state();
    const { due, day } = dueOf(cfg, st, now);
    if (!due) return null;
    const tries = st.day === day ? (Number(st.tries) || 0) + 1 : 1;
    let r;
    try { r = await computeAndSend(cfg); } catch (e) { r = { ok: false, reason: String(e?.message || e).slice(0, 200) }; }
    _state = { day, at: now, ok: r.ok, n: r.n ?? null, total: r.total ?? null, reason: r.reason || '', tries, nextTry: r.ok ? null : now + RETRY_MS };
    saveState();
    return r;
  } finally { _busy = false; }
}

/** '지금 보내 보기'(관리자) — 오늘 발송 기록은 바꾸지 않는다(정한 시각 메일은 그대로 간다). */
export async function sendNow({ by = '' } = {}) {
  if (_busy) return { ok: false, reason: '다른 발송이 진행 중입니다 — 잠시 뒤 다시 누르세요.' };
  if (alertLoadError()) return { ok: false, reason: '메일 설정 파일을 읽지 못했습니다.' };
  _busy = true;
  try { return await computeAndSend(loadAlert(), { by }); } catch (e) { return { ok: false, reason: String(e?.message || e).slice(0, 200) }; } finally { _busy = false; }
}

export function startStaleAlert() {
  if (_timer || isEdge()) return;
  _timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  _timer.unref?.();
}

export function _resetForTest() { _cfg = null; _state = null; _busy = false; _loadErr.clear(); _rev = 0; }

/**
 * bareos/health.js — v2.891 Bareos 사전 점검(시안 docs/design/bareos-precheck · 사용자 컨펌 2026-11-05: 20:00 기본 켬 · 디스크 15%/14일 · 5%/3일 ·
 * 메일 나빠질 때 + 회복 + 일일 요약 절 · 현황 KPI 칸은 그대로).
 *
 * 하루 한 번(정한 포탈 시각) 법인(Director)마다 작업 표 `health` 한 건을 보낸다(trigger 'timer' — 인증 정지된 Director 에 닿지 않는다).
 * 담당 엣지가 있으면 엣지 노드 안에서(포탈 완전 설치는 FD · SD 가 같은 서버) vCenter:443 TLS 접속 · 지문 · SD 디스크 여유를 재고,
 * 중앙 직접이면 중앙에서 잰 vCenter 접속은 '참고'(FD 시점 아님) · 디스크는 모름이다. 판정은 이 파일의 `judgeCorp` 하나 — 화면 · 메일 · 요약이 같은 값을 쓴다.
 *  · 모름은 0 이 아니다 — 법인 판정에 넣지 않는다(모두 모름이면 법인도 모름).
 *  · '정상' 은 백업 성공을 보장하지 않는다(vCenter 계정 · 권한 · 스냅샷 · 플러그인 오류는 보지 않는다) — 화면 · 메일 문구가 그 한계를 말한다.
 *  · 메일(종류 'bareos-precheck'): 법인 판정이 나빠질 때(정상→경고 · →불가) 한 통 · 회복(→정상) 한 통. 같은 상태를 매일 보내지 않는다(커서 notified).
 *    메일 · 이 종류가 꺼져 있으면 커서만 옮긴다 · 보내지 못하면 10분 뒤 다시.
 *  · 데모(mock) 는 Director 에 닿지 않는 합성값(`demoHealth`) · 엣지에서는 돌지 않는다(중앙 전용).
 * 설정: CONFIG_DIR/bareos-health.json · 상태: bareos-health-state.json(비밀 없음 — 주소 · 경로 · 지문 · 바이트 수만).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt, safeLoadText } from '../util/atomicWrite.js';
import { makeLoadError } from '../util/registryCore.js';
import { registerStateFile } from '../util/stateFiles.js';
import { localClock, localStamp, dayIndex } from '../util/dayKey.js';
import { sendPortalMail } from '../mail/service.js';
import { load as loadMailCfg } from '../mail/settings.js';
import { isMockMode } from '../mock/demo/flags.js';
import { store } from '../store.js';
import { loadSettings, settingsLoadError } from './settings.js';
import { onDirector, isEdgeNode } from './service.js';
import { PICKUP_MS, RESULT_MS, MARGIN_MS } from './edgeOps.js';
import { lastJobFor } from './install/job.js';
import { volumeDirIssue } from './install/plan.js';
import { poolSettled } from '../util/pool.js';

export const MAIL_KIND = 'bareos-precheck';
export const DEFAULT_VOLUME_DIR = '/var/lib/bareos/storage';
/** 엣지 대행이면 인출 + 회신 + 여유(묶음 로그와 같은 모양) — 중앙 직접은 이 시한이 세션을 끊는다. */
export const HEALTH_DEADLINE_MS = PICKUP_MS + RESULT_MS.health + MARGIN_MS;
export const TICK_MS = 60_000;
const CONCURRENCY = 6;
const HISTORY_MAX = 7;
const SAMPLES_MAX = 30;
const KEYS_MAX = 300;
const PATHS_MAX = 16;
const MAIL_RETRY_MS = 10 * 60_000;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const DEFAULTS = Object.freeze({ enabled: true, time: '20:00', disk: Object.freeze({ warnPct: 15, warnDays: 14, badPct: 5, badDays: 3 }), mail: Object.freeze({ onWorse: true, onRecover: true, inDigest: true }) });
const RANK = { ok: 0, warn: 1, bad: 2 };
const fail = (code, msg) => Object.assign(new Error(msg), { code });

registerStateFile('bareos-health-state.json');
const FILE = () => path.join(config.configDir, 'bareos-health.json');   // ⚠ 리터럴 형태 유지 — scripts/config-doc.mjs 가 이 모양으로 파일을 찾는다
const STATE_FILE = () => path.join(config.configDir, 'bareos-health-state.json');

let _cfg = null; const _loadErr = makeLoadError();
let _state = null; let _running = null; let _timer = null; let _mailBusy = false;
const _inflight = new Set();

/* ───────── 설정 ───────── */
const intIn = (v, lo, hi, name) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) throw fail('invalid', `${name}은(는) ${lo}~${hi} 사이 정수로 적으세요.`);
  return n;
};
export function normHealth(body = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const time = String(b.time ?? DEFAULTS.time);
  if (!TIME_RE.test(time)) throw fail('invalid', '점검 시각은 HH:MM(00:00~23:59)으로 적으세요.');
  const d = b.disk && typeof b.disk === 'object' ? b.disk : {};
  const disk = {
    warnPct: intIn(d.warnPct ?? DEFAULTS.disk.warnPct, 1, 90, '경고 여유 %'), warnDays: intIn(d.warnDays ?? DEFAULTS.disk.warnDays, 1, 365, '경고 일수'),
    badPct: intIn(d.badPct ?? DEFAULTS.disk.badPct, 1, 90, '위험 여유 %'), badDays: intIn(d.badDays ?? DEFAULTS.disk.badDays, 1, 365, '위험 일수'),
  };
  if (disk.badPct >= disk.warnPct) throw fail('invalid', '위험 여유 % 는 경고 여유 % 보다 작아야 합니다.');
  if (disk.badDays >= disk.warnDays) throw fail('invalid', '위험 일수는 경고 일수보다 작아야 합니다.');
  const m = b.mail && typeof b.mail === 'object' ? b.mail : {};
  return { enabled: b.enabled !== false, time, disk, mail: { onWorse: m.onWorse !== false, onRecover: m.onRecover !== false, inDigest: m.inDigest !== false } };
}
export function loadHealthCfg() {
  if (_cfg) return _cfg;
  try {
    if (fs.existsSync(FILE())) {
      const p = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
      if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('형식 오류');
      _cfg = { ...normHealth(p), savedBy: String(p.savedBy || '').slice(0, 64), savedAt: Number.isFinite(p.savedAt) ? p.savedAt : null };
      _loadErr.clear();
      return _cfg;
    }
  } catch (e) {
    preserveCorrupt(FILE(), e?.message);
    _loadErr.set(e);
    console.warn(`[bareos] 사전 점검 설정을 읽지 못했습니다(${safeLoadText(e) || '사유 미상'}) — 손상본을 보존했습니다(점검하지 않고 저장을 막습니다).`);
  }
  _cfg = { ...normHealth({}), savedBy: '', savedAt: null };
  _loadErr.checkCorruptOnly(FILE());
  return _cfg;
}
export function healthLoadError() { loadHealthCfg(); return _loadErr.get(); }
export function saveHealthCfg(body, { by = '', now = Date.now() } = {}) {
  if (healthLoadError()) throw fail('unreadable', '사전 점검 설정 파일을 읽지 못해 저장하지 않습니다 — 손상본을 확인하세요.');
  const next = { ...normHealth(body), savedBy: String(by || '').slice(0, 64), savedAt: now };
  atomicWriteFileSync(FILE(), JSON.stringify(next, null, 2), { mode: 0o600 });
  _cfg = next;
  return { ...next };
}

/* ───────── 상태 ───────── */
function state() {
  if (_state) return _state;
  try { _state = fs.existsSync(STATE_FILE()) ? JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8')) : {}; } catch { preserveCorrupt(STATE_FILE()); _state = {}; }
  if (!_state || typeof _state !== 'object' || Array.isArray(_state)) _state = {};
  if (!_state.corps || typeof _state.corps !== 'object' || Array.isArray(_state.corps)) _state.corps = {};
  if (!_state.disks || typeof _state.disks !== 'object' || Array.isArray(_state.disks)) _state.disks = {};
  if (!_state.mail || typeof _state.mail !== 'object') _state.mail = {};
  return _state;
}
function trimKeys(o) { const k = Object.keys(o); if (k.length > KEYS_MAX) for (const x of k.slice(0, k.length - KEYS_MAX)) delete o[x]; }
function saveState() {
  const s = state(); trimKeys(s.corps); trimKeys(s.disks);
  try { atomicWriteFileSync(STATE_FILE(), JSON.stringify(s), { mode: 0o600 }); } catch (e) { console.warn(`[bareos] 사전 점검 상태를 저장하지 못했습니다(${e?.message || e})`); }
}
export function _resetHealthForTest() { _cfg = null; _state = null; _running = null; _mailBusy = false; _inflight.clear(); _loadErr.clear(); }

/* ───────── 판정(순수) ───────── */
const VC_TEXT = {
  ECONNREFUSED: ['접속 거부', 'vCenter 웹 서비스(443)가 꺼져 있거나 다른 서버입니다 — INI 의 vcserver 가 vCenter 가 맞는지, vCenter 서비스 · 방화벽을 확인하세요.'],
  ETIMEDOUT: ['시간 초과(10초)', '방화벽이 막거나 경로가 없을 수 있습니다 — FD 서버에서 443 으로 나가는 길(방화벽 · 라우팅)을 확인하세요.'],
  EHOSTUNREACH: ['호스트에 닿지 않음', '라우팅 · 방화벽을 확인하세요.'],
  ENETUNREACH: ['네트워크에 닿지 않음', 'FD 서버의 라우팅을 확인하세요.'],
  ENOTFOUND: ['이름을 풀지 못함', 'INI 의 vcserver 철자와 FD 서버의 DNS · /etc/hosts 를 확인하세요.'],
  EAI_AGAIN: ['이름 풀이 실패(DNS 응답 없음)', 'FD 서버의 DNS 설정을 확인하세요.'],
  ECONNRESET: ['접속이 끊김', 'TLS 를 가로채는 장비 · 방화벽 정책을 확인하세요.'],
  EPROTO: ['TLS 핸드셰이크 실패', 'vCenter 443 이 TLS 가 아니거나 프로토콜이 맞지 않습니다.'],
  blocked: ['포탈 정책상 점검하지 않는 주소', '루프백 · 링크로컬 · IPv6 ULA 같은 주소는 포탈이 접속하지 않습니다(SSRF 가드) — FD 에서 되는지는 모릅니다. 매핑의 vcserver 를 확인하세요.'],
  aborted: ['점검 시간 안에 확인하지 못함', '같은 Director 의 다른 확인이 시간을 다 썼습니다 — ‘지금 점검’ 으로 다시 보세요.'],
  invalid: ['주소 형식이 틀림', '매핑의 vcserver 를 확인하세요.'],
  error: ['접속 실패', 'FD 서버에서 nc -vz <주소> 443 으로 확인하세요.'],
};
const DIR_BAD = new Set(['auth', 'pam', 'tls', 'connect', 'closed', 'protocol', 'refused']);
/** 접속해 보지 않은 것(정책 · 형식 · 부르는 쪽 시한) — 불가가 아니라 모름(반증 R2 · R12 — 모름은 0 이 아니다). */
const VC_NOT_CHECKED = new Set(['aborted', 'blocked', 'invalid']);
const DISK_CODE = { ENOENT: '경로가 없음', EACCES: '읽을 권한 없음', EPERM: '읽을 권한 없음', ENOTDIR: '디렉터리가 아님', invalid: '경로 형식이 틀림', ETIMEDOUT: '응답 없음(5초 — 멈춘 마운트일 수 있음)', aborted: '점검 시간 안에 못 읽음', error: '읽지 못함' };
export const fmtBytes = (n) => {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']; let v = Number(n); let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
};

/**
 * 최근 7일 일별 표본의 사용량 기울기(바이트/일)로 가득 찰 때까지 일수. 표본 3개 미만 · 기울기 ≤ 0 · 못 읽음이면 null('—' — 기준에 쓰지 않는다).
 * @param {{ day:number, used:number }[]} samples @param {number} availBytes
 */
export function daysToFull(samples, availBytes, today) {
  const pts = (Array.isArray(samples) ? samples : []).filter((x) => Number.isFinite(x?.day) && Number.isFinite(x?.used) && (today == null || x.day > today - 7));
  if (pts.length < 3 || !Number.isFinite(availBytes)) return null;
  const n = pts.length; const mx = pts.reduce((a, p) => a + p.day, 0) / n; const my = pts.reduce((a, p) => a + p.used, 0) / n;
  let sxx = 0; let sxy = 0;
  for (const p of pts) { sxx += (p.day - mx) ** 2; sxy += (p.day - mx) * (p.used - my); }
  if (sxx <= 0) return null;
  const slope = sxy / sxx;
  if (!(slope > 0)) return null;
  return { days: Math.max(0, availBytes / slope), perDay: slope };
}

/**
 * 법인 하나의 판정(순수 — 시험이 고정). 항목 status: ok | warn | bad | unknown | info(참고 — 판정에 넣지 않음).
 * @param {{ result?:object|null, error?:{code?:string, message?:string}|null, vcserver?:string, prevThumb?:{value?:string}|null,
 *           diskSamples?:Record<string,{day,used}[]>, cfg?:object, now?:number }} o
 * @returns {{ verdict:'ok'|'warn'|'bad'|'unknown', items:object[], thumbprint:string|null, from:string|null }}
 */
export function judgeCorp({ result = null, error = null, vcserver = '', prevThumb = null, diskSamples = {}, cfg = DEFAULTS, now = Date.now() } = {}) {
  const items = [];
  const from = result?.from === 'edge' ? 'edge' : result ? 'central' : null;
  // ① Director 콘솔
  if (error) {
    const c = String(error.code || '');
    if (c === 'auth-stopped') items.push({ key: 'dir', status: 'unknown', label: 'Director 콘솔', detail: '인증 실패로 주기 조회를 멈춘 Director — 점검하지 않았습니다', action: '설정 › Director 에서 접속값을 고치면 다시 시작합니다.' });
    else if (c === 'not-configured') items.push({ key: 'dir', status: 'unknown', label: 'Director 콘솔', detail: 'Director 접속값이 덜 됐습니다', action: '설정 › Director 에서 채우세요.' });
    else if (DIR_BAD.has(c)) items.push({ key: 'dir', status: 'bad', label: 'Director 콘솔', detail: `접속 실패(${c})`, action: 'Director 서비스(bareos-dir) · 9101 방화벽 · 콘솔 접속값을 확인하세요.' });
    else items.push({ key: 'dir', status: 'unknown', label: 'Director 콘솔', detail: `점검 회신을 받지 못했습니다(${c || '사유 미상'})`, action: '엣지 노드가 응답하는지(설정 › 엣지) 확인하세요.' });
  } else if (result) items.push({ key: 'dir', status: 'ok', label: 'Director 콘솔', detail: `응답${result.version ? ` · ${result.version}` : ''}`, action: '' });
  else items.push({ key: 'dir', status: 'unknown', label: 'Director 콘솔', detail: '아직 점검하지 않았습니다', action: '' });
  // ② vCenter 접속 · ③ 지문
  const vc = result ? (result.vcs || []).find((x) => String(x.host).toLowerCase() === String(vcserver).toLowerCase()) : null;
  let thumbprint = null;
  if (!vcserver) {
    items.push({ key: 'vc', status: 'unknown', label: 'vCenter 접속', detail: '사이트 매핑에 vcserver 가 없습니다', action: '설정 › 법인별 설정 · 매핑에서 vcserver 를 채우세요.' });
    items.push({ key: 'thumb', status: 'unknown', label: 'vCenter 인증서 지문', detail: '—', action: '' });
  } else if (!vc) {
    items.push({ key: 'vc', status: 'unknown', label: 'vCenter 접속', detail: `${vcserver}:443 — 점검하지 못했습니다`, action: '' });
    items.push({ key: 'thumb', status: 'unknown', label: 'vCenter 인증서 지문', detail: '—', action: '' });
  } else {
    const where = from === 'edge' ? '엣지 노드에서' : '중앙에서(FD 시점 아님)';
    if (vc.ok) {
      items.push({ key: 'vc', status: from === 'edge' ? 'ok' : 'info', label: 'vCenter 접속', detail: `${vcserver}:443 접속됨 · ${vc.ms == null ? '—' : `${(vc.ms / 1000).toFixed(1)}초`} · ${where}`, action: from === 'edge' ? '' : 'FD 시점으로 보려면 담당 엣지를 두세요(설정 › Director).' });
      thumbprint = vc.thumbprint || null;
      const base = prevThumb?.value || null;
      if (!thumbprint) items.push({ key: 'thumb', status: 'unknown', label: 'vCenter 인증서 지문', detail: '지문을 읽지 못했습니다', action: '' });
      // 중앙에서 본 지문은 참고만(반증 R5) — 기준으로 삼지 않고(record 가 엣지 관측만 기준 · lastSeen 으로) 판정에 넣지 않는다.
      else if (from !== 'edge') items.push({ key: 'thumb', status: 'info', label: 'vCenter 인증서 지문', detail: `중앙에서 본 값 · ${thumbprint}${base ? (base === thumbprint ? ' · 기준과 같음' : ` · 기준 ${base} 과 다름`) : ''} — FD 시점이 아니라 기준으로 쓰지 않습니다`, action: '' });
      else if (!base) items.push({ key: 'thumb', status: 'ok', label: 'vCenter 인증서 지문', detail: `첫 관측 — 기준으로 기록 · ${thumbprint}`, action: '' });
      else if (base === thumbprint) items.push({ key: 'thumb', status: 'ok', label: 'vCenter 인증서 지문', detail: `변화 없음 · ${thumbprint}`, action: '' });
      else items.push({ key: 'thumb', status: 'warn', label: 'vCenter 인증서 지문', detail: `바뀜 — 기준 ${base} → 지금 ${thumbprint}`, action: 'vCenter 인증서가 갱신됐거나 다른 서버입니다 — FD INI 의 지문을 새 값으로 바꾸고(설정 › 법인별 설정 › FD INI) ‘새 지문을 기준으로’ 를 누르세요(바꾸지 않으면 플러그인이 접속을 거부할 수 있습니다 — 추정).' });
    } else {
      const [t, a] = VC_TEXT[vc.code] || VC_TEXT.error;
      items.push({ key: 'vc', status: VC_NOT_CHECKED.has(vc.code) ? 'unknown' : from === 'edge' ? 'bad' : 'info', label: 'vCenter 접속', detail: `${vcserver}:443 ${t}${vc.code && !['blocked', 'invalid', 'error', 'aborted'].includes(vc.code) ? `(${vc.code})` : ''} · ${where}`, action: `${a} FD 서버에서 nc -vz ${vcserver} 443` });
      items.push({ key: 'thumb', status: 'unknown', label: 'vCenter 인증서 지문', detail: `접속되지 않아 읽지 못했습니다${prevThumb?.value ? ` · 기준 ${prevThumb.value}` : ''}`, action: '' });
    }
  }
  // ④ SD 디스크 여유
  if (!result) items.push({ key: 'disk', status: 'unknown', label: 'SD 디스크 여유', detail: '—', action: '' });
  else if (result.diskSkipped === 'central') items.push({ key: 'disk', status: 'unknown', label: 'SD 디스크 여유', detail: '중앙 직접 Director — 중앙은 법인 서버의 디스크를 볼 수 없습니다', action: '설정 › 법인별 설정 › ‘디스크 · 파일 읽기(SSH)’ 로 그때 값을 보거나, 담당 엣지를 두세요.' });
  else if (result.diskSkipped === 'remote') items.push({ key: 'disk', status: 'unknown', label: 'SD 디스크 여유', detail: 'Director 가 이 엣지 노드에 있지 않습니다 — 다른 서버의 디스크는 재지 않습니다', action: '설정 › 법인별 설정 › ‘디스크 · 파일 읽기(SSH)’ 로 보세요.' });
  else if (!(result.disks || []).length) items.push({ key: 'disk', status: 'unknown', label: 'SD 디스크 여유', detail: '볼륨 경로를 모릅니다', action: '' });
  else {
    const today = dayIndex(now);
    const parts = []; let worst = 'ok'; let anyRead = false; const disks = [];
    for (const d of result.disks) {
      if (d.code || d.availBytes == null || !d.sizeBytes) { parts.push(`${d.path} ${DISK_CODE[d.code] || '읽지 못함'}`); disks.push({ path: d.path, code: d.code || 'error' }); continue; }
      anyRead = true;
      const pct = (d.availBytes / d.sizeBytes) * 100;
      const dtf = daysToFull(diskSamples[d.path], d.availBytes, today);
      const days = dtf ? dtf.days : null;
      const st = pct <= cfg.disk.badPct || (days != null && days <= cfg.disk.badDays) ? 'bad' : pct <= cfg.disk.warnPct || (days != null && days <= cfg.disk.warnDays) ? 'warn' : 'ok';
      if (RANK[st] > RANK[worst]) worst = st;
      parts.push(`${d.path} 여유 ${fmtBytes(d.availBytes)} / ${fmtBytes(d.sizeBytes)} (${Math.round(pct)}%)${dtf ? ` · +${fmtBytes(dtf.perDay)}/일 · 약 ${Math.round(days)}일` : ''}`);
      disks.push({ path: d.path, availBytes: d.availBytes, sizeBytes: d.sizeBytes, usedBytes: d.usedBytes, pct: Math.round(pct * 10) / 10, daysLeft: days == null ? null : Math.round(days * 10) / 10, status: st });
    }
    const status = anyRead ? worst : 'unknown';
    items.push({ key: 'disk', status, label: 'SD 디스크 여유', detail: parts.join(' · '), disks,
      action: status === 'bad' ? '오래된 볼륨을 정리하거나(정책 · 보존) 디스크를 늘리세요 — 다음 Full 전에 여유를 확보하세요.' : status === 'warn' ? '보관 기간 · 디스크 증설을 계획하세요.' : '' });
  }
  return { verdict: verdictOf(items), items, thumbprint, from };
}

/**
 * 법인 판정 — 가장 나쁜 항목(불가 > 경고). 모름 · 참고는 넣지 않는다. 나쁜 것이 없어도 **vCenter 접속(엣지에서) · 디스크 중 하나라도 정상으로
 * 확인된 것이 없으면** 모름이다 — Director 콘솔만 응답한 중앙 직접 법인을 '정상' 으로 보이지 않게(FD 시점 · 디스크를 못 봤다).
 */
export function verdictOf(items) {
  const counted = (items || []).filter((x) => x.status in RANK);
  const worst = counted.reduce((a, x) => (RANK[x.status] > RANK[a] ? x.status : a), 'ok');
  if (worst !== 'ok') return worst;
  return counted.some((x) => (x.key === 'vc' || x.key === 'disk') && x.status === 'ok') ? 'ok' : 'unknown';   // 지문만 정상(중앙에서 본 것)도 모름
}

/** 나빠짐 · 회복(순수). notified 가 없으면 '정상' 에서 온 것으로 본다(처음부터 불가면 알린다). 모름은 바꾸지 않는다. */
export function transitionOf(verdict, notified) {
  if (!(verdict in RANK)) return null;
  const prev = notified in RANK ? notified : 'ok';
  if (RANK[verdict] > RANK[prev]) return 'worse';
  if (verdict === 'ok' && RANK[prev] > 0) return 'recover';
  if (RANK[verdict] < RANK[prev]) return 'better';   // 불가 → 경고: 메일 없이 커서만
  return null;
}

/* ───────── 실행 ───────── */
/** 설정 → 점검할 법인(Director 마다 그 Director 의 사이트들). 매핑이 없는 Director 는 법인이 없어 점검하지 않는다. */
export function plansOf(settings) {
  const dirs = new Map((settings?.directors || []).map((d) => [d.id, d]));
  const out = new Map();
  for (const s of settings?.sites || []) {
    const d = dirs.get(s.directorId);
    if (!d) continue;
    const p = out.get(d.id) || { directorId: d.id, name: d.name || d.id, host: d.host || '', agent: d.agent || '', sites: [], volumeDirs: new Set() };
    let vd = '';
    try { vd = lastJobFor(s.vcenterId)?.plan?.volumeDir || ''; } catch { vd = ''; }
    const volumeDir = vd && !volumeDirIssue(vd) ? vd : DEFAULT_VOLUME_DIR;
    p.sites.push({ vcenterId: s.vcenterId, vcserver: s.vcserver || '', volumeDir });
    p.volumeDirs.add(volumeDir);
    out.set(d.id, p);
  }
  return [...out.values()].map((p) => ({ ...p, volumeDirs: [...p.volumeDirs] }));
}
/**
 * 한 법인 '지금 점검' 의 계획 — 그 법인 사이트만(반증 R3: Director 단위 계획이면 같은 Director 에 매핑된 다른 법인의 vcserver 에도 접속하고
 * 그 법인 상태 · 메일을 바꿨다 — 쓰기 범위 밖 법인까지). 매핑이 없으면 null.
 */
export function planForCorp(settings, vcenterId) {
  const p = plansOf(settings).find((x) => x.sites.some((s) => s.vcenterId === vcenterId));
  if (!p) return null;
  const site = p.sites.find((s) => s.vcenterId === vcenterId);
  return { ...p, sites: [site], volumeDirs: [site.volumeDir] };
}
/** 지금 매핑된 법인 id(설정을 못 읽으면 null — 거르지 않는다). */
function mappedIds() {
  if (settingsLoadError()) return null;
  try {
    const st = loadSettings(); const dirs = new Set((st?.directors || []).map((d) => d.id));
    return new Set((st?.sites || []).filter((s) => dirs.has(s.directorId)).map((s) => String(s.vcenterId)));   // plansOf 와 같은 기준(설치 기록은 읽지 않는다 — 조회마다 불린다)
  } catch { return null; }
}

function record(plan, { result, error }, now) {
  const st = state(); const cfg = loadHealthCfg(); const today = dayIndex(now);
  // 디스크 표본(Director 마다 경로별 · 하루 하나)
  const dk = st.disks[plan.directorId] || (st.disks[plan.directorId] = {});
  for (const d of result?.disks || []) {
    if (d.code || d.usedBytes == null) continue;
    const list = Array.isArray(dk[d.path]) ? dk[d.path].filter((x) => x.day !== today) : [];
    list.push({ day: today, used: d.usedBytes, avail: d.availBytes, size: d.sizeBytes });
    dk[d.path] = list.slice(-SAMPLES_MAX);
  }
  // 경로 키 상한(반증 — Director 안의 경로 수가 늘기만 했다): 30일 넘게 표본이 없는 경로를 지우고, 그래도 많으면 최근 것만
  for (const k of Object.keys(dk)) { const l = dk[k]; const lastDay = Array.isArray(l) && l.length ? l[l.length - 1].day : -Infinity; if (!(lastDay > today - SAMPLES_MAX)) delete dk[k]; }
  const keys = Object.keys(dk);
  if (keys.length > PATHS_MAX) for (const k of keys.sort((a, b) => dk[a][dk[a].length - 1].day - dk[b][dk[b].length - 1].day).slice(0, keys.length - PATHS_MAX)) delete dk[k];
  for (const site of plan.sites) {
    const prev = st.corps[site.vcenterId] || {};
    const j = judgeCorp({ result, error, vcserver: site.vcserver, prevThumb: prev.thumb, diskSamples: dk, cfg, now });
    // 지문 기준 · 마지막 관측은 엣지(FD 시점)에서 본 것만(반증 R5 — 중앙 관측이 기준이 되거나 ‘새 지문을 기준으로’ 가 중앙 값을 쓰지 않게)
    const seen = j.from === 'edge' ? j.thumbprint : null;
    const thumb = prev.thumb?.value ? { ...prev.thumb, lastSeen: seen || prev.thumb.lastSeen || null } : (seen ? { value: seen, at: now, lastSeen: seen } : (prev.thumb || null));
    st.corps[site.vcenterId] = {
      at: now, directorId: plan.directorId, directorName: plan.name, from: j.from, verdict: j.verdict, items: j.items,
      history: [...(Array.isArray(prev.history) ? prev.history : []), { at: now, verdict: j.verdict }].slice(-HISTORY_MAX),
      notified: prev.notified ?? null, thumb,
    };
  }
}

let _onDirector = onDirector;
export function _setHealthDepsForTest(d = {}) { _onDirector = d.onDirector || onDirector; }

/** 한 Director 점검(회신까지 기다린다). trigger 'timer'(주기) · 'manual'(지금 점검). */
export async function runDirector(plan, { trigger = 'timer', now = () => Date.now() } = {}) {
  if (_inflight.has(plan.directorId)) throw fail('conflict', '이 법인의 점검이 진행 중입니다.');
  _inflight.add(plan.directorId);
  try {
    let result = null; let error = null;
    try {
      result = await _onDirector(plan.directorId, 'health', { vcservers: plan.sites.map((s) => s.vcserver).filter(Boolean), volumeDirs: plan.volumeDirs, dirHost: plan.host }, { trigger, signal: AbortSignal.timeout(HEALTH_DEADLINE_MS) });
    } catch (e) { error = { code: String(e?.code || 'error').slice(0, 40), message: String(e?.message || '').slice(0, 200) }; }
    record(plan, { result, error }, now());
    saveState();
    return { result, error };
  } finally { _inflight.delete(plan.directorId); }
}

/** 전 법인 점검(동시 CONCURRENCY) — 진행 중이면 그 약속을 돌려준다. */
export function runAll({ trigger = 'timer', now = () => Date.now() } = {}) {
  if (_running) return _running;
  _running = (async () => {
    const t0 = now();
    const unreadable = !!settingsLoadError();
    const plans = unreadable ? [] : plansOf(loadSettings());
    const st0 = state(); st0.roundAt = t0; saveState();   // 회차 시작 — 이보다 앞선 기록은 이번 회차에서 못 돈 것(재시작 · 실패 — corpView 가 모름으로)
    const res = await poolSettled(plans, CONCURRENCY, (p) => runDirector(p, { trigger, now }));
    const ok = res.filter((r) => r.status === 'fulfilled' && !r.value?.error).length;
    const failed = res.length - ok;
    const st = state();
    if (!unreadable) {   // 매핑을 지운 법인 · Director 는 상태에서 지운다(반증 R4 — 띠 · 요약 · 메일에 영원히 남았다)
      const ids = new Set(plans.flatMap((p) => p.sites.map((s) => String(s.vcenterId)))); const dirIds = new Set(plans.map((p) => p.directorId));
      for (const id of Object.keys(st.corps)) if (!ids.has(id)) delete st.corps[id];
      for (const id of Object.keys(st.disks)) if (!dirIds.has(id)) delete st.disks[id];
    }
    st.last = { at: t0, endedAt: now(), directors: plans.length, ok, failed, trigger, settingsUnreadable: unreadable };
    // 수동 전 법인 점검이 정한 시각을 걸쳐 끝났으면 오늘 몫으로 친다(반증 R11 — 끝난 뒤 timer 회차가 한 번 더 돌았다)
    if (!unreadable) { const d = dueOf(loadHealthCfg(), st, now()); if (d.due) st.day = d.day; }
    saveState();
    return st.last;
  })().finally(() => { _running = null; });
  return _running;
}
export const healthRunning = () => !!_running;

/* ───────── 메일 ───────── */
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const VERDICT_KO = { ok: '정상', warn: '경고', bad: '불가', unknown: '모름' };
export const verdictText = (v) => VERDICT_KO[v] || '모름';

/** 메일 본문(순수). rows: { vcenterId, name, kind:'worse'|'recover', verdict, prev, items } */
export function renderHealthMail(rows, vcName = (id) => id) {
  const worse = rows.filter((r) => r.kind === 'worse'); const rec = rows.filter((r) => r.kind === 'recover');
  const nBad = worse.filter((r) => r.verdict === 'bad').length; const nWarn = worse.length - nBad;
  const head = [nBad ? `불가 ${nBad}` : '', nWarn ? `경고 ${nWarn}` : '', rec.length ? `회복 ${rec.length}` : ''].filter(Boolean).join(' · ');
  const names = [...new Set(rows.map((r) => vcName(r.vcenterId)))];
  const subject = `[Bareos 사전 점검] ${head} — ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` 외 ${names.length - 3}` : ''}`;
  const td = (v, extra = '') => `<td style="padding:5px 8px;border:1px solid #cbd5e1;vertical-align:top${extra}">${v}</td>`;
  const bad = (r) => r.items.filter((x) => x.status === 'bad' || x.status === 'warn');
  const tr = (r) => {
    const its = r.kind === 'recover' ? [{ label: '전체', status: 'ok', detail: `${verdictText(r.prev)} → 정상`, action: '' }] : bad(r);
    return its.map((x, i) => `<tr>${i === 0 ? td(`<b>${esc(r.name || '—')}</b><br><span style="color:#64748b">${esc(vcName(r.vcenterId))}</span>`, `" rowspan="${its.length}`) : ''}${td(esc(x.label))}${td(`<b style="color:${x.status === 'bad' ? '#b91c1c' : x.status === 'warn' ? '#b45309' : '#15803d'}">${esc(r.kind === 'recover' ? '회복' : verdictText(x.status))}</b>`)}${td(esc(x.detail))}${td(esc(x.action || '—'))}</tr>`).join('');
  };
  const th = ['법인 Director', '항목', '결과', '상세', '조치'].map((h) => `<th style="padding:5px 8px;border:1px solid #cbd5e1;background:#f1f5f9;text-align:left">${h}</th>`).join('');
  const html = `<div style="font-family:sans-serif;font-size:13px">`
    + `<p>Bareos 사전 점검에서 상태가 바뀐 법인이 있습니다(${esc(head)}). 포탈 › Backup 현황 › Bareos › 법인 화면의 ‘사전 점검’ 카드에서 자세히 볼 수 있습니다.</p>`
    + `<table style="border-collapse:collapse;font-size:12.5px"><thead><tr>${th}</tr></thead><tbody>${[...worse, ...rec].map(tr).join('')}</tbody></table>`
    + `<p style="color:#64748b;font-size:11.5px">상태가 나빠진 법인과 회복된 법인만 싣습니다 — 같은 상태를 매일 보내지 않으며, 매일의 상태는 일일 요약 메일의 ‘사전 점검’ 절에 있습니다. ‘정상’ 은 백업 성공을 보장하지 않습니다(vCenter 계정 · 권한 · 스냅샷 · 플러그인 오류는 보지 않습니다). 설정 › 메일 발송의 ‘Bareos 사전 점검’ 종류로 보냈습니다.</p></div>`;
  const text = [`Bareos 사전 점검 ${head}`, ...[...worse, ...rec].flatMap((r) => [`${r.name || '—'} (${vcName(r.vcenterId)}) — ${r.kind === 'recover' ? `회복(${verdictText(r.prev)} → 정상)` : verdictText(r.verdict)}`, ...(r.kind === 'recover' ? [] : bad(r).map((x) => `  ${x.label}: ${x.detail}${x.action ? ` → ${x.action}` : ''}`))])].join('\n');
  return { subject, html, text };
}

/** 커서(notified)와 지금 판정을 견주어 보낼 줄 · 옮길 커서(순수). */
export function mailPlan(corps, cfg = DEFAULTS) {
  const rows = []; const marks = {};
  for (const [vcenterId, c] of Object.entries(corps || {})) {
    const t = transitionOf(c.verdict, c.notified);
    if (!t) continue;
    marks[vcenterId] = c.verdict;
    if ((t === 'worse' && cfg.mail?.onWorse !== false) || (t === 'recover' && cfg.mail?.onRecover !== false)) {
      rows.push({ vcenterId, name: c.directorName || '', kind: t, verdict: c.verdict, prev: c.notified in RANK ? c.notified : 'ok', items: c.items || [] });
    }
  }
  return { rows, marks };
}

export async function mailTick(now = Date.now()) {
  if (_mailBusy) return null;
  _mailBusy = true;
  try {
    if (_running) return null;   // 회차가 끝난 뒤 한 통으로(반증 R11 — 회차 도중 틱이 먼저 기록된 법인만 보내 여러 통으로 나뉘었다)
    const st = state(); const cfg = loadHealthCfg();
    if (st.mail.nextTry && now < st.mail.nextTry) return null;
    const { rows, marks } = mailPlan(effectiveCorps(st), cfg);
    if (!Object.keys(marks).length) return null;
    const advance = () => { for (const [k, v] of Object.entries(marks)) if (st.corps[k]) st.corps[k].notified = v; st.mail.nextTry = null; saveState(); };
    if (!rows.length) { advance(); return { sent: false, reason: 'no-rows' }; }
    const mail = loadMailCfg();
    if (!mail?.enabled || mail?.kinds?.[MAIL_KIND]?.enabled === false) { advance(); st.mail.last = { at: now, sent: false, reason: '메일 발송 또는 이 종류가 꺼져 있습니다' }; saveState(); return { sent: false }; }
    const names = new Map((store.get()?.vcenters || []).map((v) => [String(v.id), v.name || v.id]));
    const m = renderHealthMail(rows, (id) => names.get(String(id)) || id);
    let r = null;
    try { r = await sendPortalMail({ kind: MAIL_KIND, subject: m.subject, html: m.html, text: m.text, by: 'system' }); } catch (e) { r = { ok: false, reason: String(e?.message || e) }; }
    if (r?.ok) { advance(); st.mail.last = { at: now, sent: true, rows: rows.length, subject: m.subject.slice(0, 200) }; }
    else { st.mail.nextTry = now + MAIL_RETRY_MS; st.mail.last = { at: now, sent: false, reason: String(r?.reason || '발송 실패').slice(0, 200) }; }
    saveState();
    return { sent: !!r?.ok };
  } finally { _mailBusy = false; }
}

/* ───────── 스케줄 ───────── */
/** 지금 돌 차례인가(순수) — 정한 시각을 지났고 오늘 아직 돌지 않았으면. */
export function dueOf(cfg, st, now = Date.now()) {
  const c = localClock(now);
  if (!cfg?.enabled || !TIME_RE.test(cfg.time || '')) return { due: false, day: c.day };
  const [h, m] = cfg.time.split(':').map(Number);
  if (c.hour * 60 + c.minute < h * 60 + m) return { due: false, day: c.day };
  return { due: st?.day !== c.day, day: c.day };
}

export async function tick(now = Date.now()) {
  if (isEdgeNode() || isMockMode()) return null;
  const cfg = loadHealthCfg();
  if (!healthLoadError()) {
    const st = state();
    const { due, day } = dueOf(cfg, st, now);
    if (due && !_running) {
      st.day = day; saveState();   // 돌기 시작하면 오늘 몫은 쓴다 — 못 돈 법인(실패 · 도중 재시작)은 roundAt 보다 앞선 기록이라 모름으로 보이고 '지금 점검' 으로 다시
      await runAll({ trigger: 'timer' });
    }
  }
  return mailTick(now);
}

export function startBareosHealth() {
  if (_timer || isEdgeNode()) return;
  _timer = setInterval(() => { tick().catch((e) => console.warn(`[bareos] 사전 점검 틱 실패(${e?.message || e})`)); }, TICK_MS);
  _timer.unref?.();
}

/* ───────── 보기(라우트 · 요약) ───────── */
/** 지문 기준을 지금 본 값으로(사용자가 FD INI 를 고친 뒤 · 라우트가 권한을 본 뒤). */
export function acceptThumb(vcenterId, { now = Date.now() } = {}) {
  const st = state(); const c = st.corps[vcenterId];
  const seen = c?.thumb?.lastSeen;
  if (!seen) throw fail('invalid', '지금 본 지문이 없습니다 — 먼저 점검하세요.');
  c.thumb = { value: seen, at: now, lastSeen: seen };
  for (const it of c.items || []) if (it.key === 'thumb' && it.status === 'warn') Object.assign(it, { status: 'ok', detail: `새 지문을 기준으로 · ${seen}`, action: '' });
  c.verdict = verdictOf(c.items);
  saveState();
  return corpView(vcenterId, c, st);
}

/**
 * 지금 보일 판정 — 마지막 회차(roundAt)보다 앞선 기록은 그 회차에서 못 돈 것이라 모름(이전 판정은 staleVerdict 로 · 반증 R4 — 도중 재시작이면
 * 어제 판정을 그대로 보였다). 회차가 도는 중에는 아직 차례가 안 온 것이므로 그대로 둔다.
 */
function effective(c, st) {
  if (!_running && Number.isFinite(st.roundAt) && Number.isFinite(c?.at) && c.at < st.roundAt && c.verdict !== 'unknown') return { ...c, verdict: 'unknown', stale: true, staleVerdict: c.verdict };
  return c;
}
/** 매핑된 법인만(설정을 못 읽으면 전부) · 지금 보일 판정으로. */
function effectiveCorps(st) {
  const m = mappedIds();
  return Object.fromEntries(Object.entries(st.corps).filter(([id]) => !m || m.has(String(id))).map(([id, c]) => [id, effective(c, st)]));
}

function corpView(vcenterId, c0, st) {
  const c = effective(c0, st);
  const samples = st.disks?.[c.directorId] || {};
  // 추이선은 지금 디스크 항목의 경로만(반증 R7 — 처음 기록된 옛 경로를 그렸다)
  const curPaths = new Set(((c.items || []).find((x) => x.key === 'disk')?.disks || []).map((d) => d.path));
  const spark = Object.fromEntries(Object.entries(samples).filter(([p]) => curPaths.has(p)).map(([p, list]) => [p, (list || []).slice(-14).map((x) => ({ day: x.day, used: x.used, size: x.size }))]));
  return { vcenterId, directorId: c.directorId, directorName: c.directorName, at: c.at, from: c.from, verdict: c.verdict, items: c.items || [], history: c.history || [], spark, thumbBase: c.thumb?.value || null,
    ...(c.stale ? { stale: true, staleVerdict: c.staleVerdict } : {}) };
}

/** 라우트 보기 — allow(vcenterId) 가 true 이고 지금 매핑된 법인만. */
export function healthView(allow = () => true) {
  const st = state();
  const corps = Object.entries(effectiveCorps(st)).filter(([id]) => allow(id)).map(([id]) => corpView(id, st.corps[id], st));
  return { corps, last: st.last || null, running: !!_running, mail: st.mail?.last || null };
}

/** 일일 요약 메일 절(정상은 싣지 않는다 · 수만) — 설정에서 끄면 null. */
export function healthDigestSection(vcName = (id) => id) {
  const cfg = loadHealthCfg();
  if (!cfg.mail.inDigest) return null;
  const st = state(); const corps = Object.entries(effectiveCorps(st));
  if (!corps.length) return null;
  const n = { ok: 0, warn: 0, bad: 0, unknown: 0 };
  for (const [, c] of corps) n[c.verdict in n ? c.verdict : 'unknown'] += 1;
  const rows = corps.filter(([, c]) => c.verdict !== 'ok').sort((a, b) => (RANK[b[1].verdict] ?? -1) - (RANK[a[1].verdict] ?? -1));
  const cell = (c, key) => { const x = (c.items || []).find((i) => i.key === key); return x ? `${verdictText(x.status === 'info' ? 'unknown' : x.status)}${x.status === 'ok' ? '' : ` — ${x.detail}`}` : '—'; };
  const th = 'style="text-align:left;padding:4px 8px;border-bottom:1px solid #e5e7eb;font-size:12px;color:#374151"';
  const td = 'style="padding:4px 8px;border-bottom:1px solid #f3f4f6;font-size:12px;vertical-align:top"';
  const at = st.last?.at ? localStamp(st.last.at) : '—';
  const html = `<h4 style="margin:14px 0 6px">사전 점검(${esc(at)} · ${corps.length}곳)</h4>`
    + `<p style="margin:0 0 6px;font-size:12.5px">정상 ${n.ok} · 불가 ${n.bad} · 경고 ${n.warn} · 모름 ${n.unknown}</p>`
    + (rows.length ? `<table style="border-collapse:collapse"><thead><tr><th ${th}>법인</th><th ${th}>vCenter 접속</th><th ${th}>인증서 지문</th><th ${th}>Director 콘솔</th><th ${th}>SD 디스크 여유</th><th ${th}>판정</th></tr></thead><tbody>`
      + rows.map(([id, c]) => `<tr><td ${td}>${esc(c.directorName || '—')}<br><span style="color:#6b7280">${esc(vcName(id))}</span></td><td ${td}>${esc(cell(c, 'vc'))}</td><td ${td}>${esc(cell(c, 'thumb'))}</td><td ${td}>${esc(cell(c, 'dir'))}</td><td ${td}>${esc(cell(c, 'disk'))}</td><td ${td}><b>${esc(verdictText(c.verdict))}</b></td></tr>`).join('')
      + `</tbody></table>` : '')
    + `<p style="font-size:11px;color:#6b7280">정상인 법인은 싣지 않았습니다 · 모름은 수를 만들지 않습니다 · ‘정상’ 은 백업 성공을 보장하지 않습니다.</p>`;
  const text = `\n\n사전 점검(${at}) 정상 ${n.ok} · 불가 ${n.bad} · 경고 ${n.warn} · 모름 ${n.unknown}${rows.length ? `\n${rows.map(([id, c]) => `${c.directorName || '—'}\t${vcName(id)}\t${verdictText(c.verdict)}`).join('\n')}` : ''}`;
  return { html, text };
}

/* ───────── 데모(장비에 닿지 않는 합성값) ───────── */
export function demoHealth(vcenters = [], now = Date.now()) {
  const T = (n) => `AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:${n}`;
  const kinds = ['vc-bad', 'disk-bad', 'disk-warn', 'thumb-warn', 'ok', 'central'];
  const corps = (Array.isArray(vcenters) ? vcenters : []).slice(0, 12).map((v, i) => {
    const k = kinds[i % kinds.length];
    const size = 4 * 1024 ** 4; const avail = k === 'disk-bad' ? 0.03 * size : k === 'disk-warn' ? 0.12 * size : 0.4 * size;
    const day = dayIndex(now);
    const per = k === 'disk-bad' ? 52 * 1024 ** 3 : 18 * 1024 ** 3;
    const samples = { [DEFAULT_VOLUME_DIR]: Array.from({ length: 7 }, (_, d) => ({ day: day - 6 + d, used: size - avail - (6 - d) * per })) };
    const result = k === 'central'
      ? { from: 'central', version: '25.1.2', vcs: [{ host: `vc-${i + 1}.demo`, ok: true, code: null, ms: 600, thumbprint: T('01') }], disks: [], diskSkipped: 'central' }
      : { from: 'edge', version: '25.1.2', vcs: [{ host: `vc-${i + 1}.demo`, ok: k !== 'vc-bad', code: k === 'vc-bad' ? 'ECONNREFUSED' : null, ms: 800, thumbprint: k === 'vc-bad' ? null : k === 'thumb-warn' ? T('99') : T('01') }], disks: [{ path: DEFAULT_VOLUME_DIR, availBytes: avail, sizeBytes: size, usedBytes: size - avail, code: null }], diskSkipped: null };
    const j = judgeCorp({ result, vcserver: `vc-${i + 1}.demo`, prevThumb: { value: T('01') }, diskSamples: samples, cfg: loadHealthCfg(), now });
    const hist = Array.from({ length: 6 }, (_, d) => ({ at: now - (7 - d) * 86_400_000, verdict: 'ok' })).concat([{ at: now, verdict: j.verdict }]);
    return { vcenterId: v.id, directorId: 'dir_demo', directorName: `${v.name || v.id} Bareos`, at: now - 3600_000, from: result.from, verdict: j.verdict, items: j.items, history: hist,
      spark: { [DEFAULT_VOLUME_DIR]: samples[DEFAULT_VOLUME_DIR].map((x) => ({ day: x.day, used: x.used, size })) }, thumbBase: T('01'), demo: true };
  });
  return { corps, last: { at: now - 3600_000, endedAt: now - 3540_000, directors: corps.length, ok: corps.length, failed: 0, trigger: 'timer' }, running: false, mail: null, demo: true };
}

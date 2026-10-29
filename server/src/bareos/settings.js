/**
 * bareos/settings.js — Bareos 연동 설정(v2.747). 파일: CONFIG_DIR/bareos.json (0600 · 원자적 쓰기 · 비밀 봉인).
 *
 * {
 *   version: 1,
 *   director: { host, port, consoleName, password, timeoutMs, tlsMax },       // 콘솔 접속(비밀번호는 봉인 — SECRET_FILES)
 *   defaults: { jobDefs, fileSet, restoreJob, level, pollIntervalSec, pluginName },
 *   sites: [ { vcenterId, vcserver, client, storage, pool, schedule, configFile } ],   // vCenter → 백업 데이터가 머무는 사이트 FD·SD
 * }
 *
 * 규칙(server/CLAUDE.md):
 *  - 로드 손상 → preserveCorrupt + 빈 설정(다음 저장이 손상본을 덮지 않게 원본은 옆에 보존) · 로드 오류는 기억해 화면이 밝힌다.
 *  - 접속처(host·port·consoleName)가 바뀌면 저장 비밀번호를 승계하지 않는다(util/secretCarry.js — 새 주소로 옛 비밀을 보내지 않게).
 *  - 주소는 IP 리터럴 차단 대역(ipBlockReason)을 저장 때도 거부한다(접속 때는 ssrfLookup 이 다시 본다).
 *  - 응답에는 비밀번호를 싣지 않는다(hasPassword 만).
 *  - vCenter 자격증명은 여기에 없다 — 사이트 FD 의 INI(configFile)가 갖는다(포탈은 Bareos 로 vCenter 비밀번호를 보내지 않는다).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt, safeLoadText } from '../util/atomicWrite.js';
import { openSecretsDeep, sealSecretsDeep } from '../security/secretVault.js';
import { accessMoved, dropCarriedSecrets, secretProvided } from '../util/secretCarry.js';
import { ipBlockReason } from '../util/ssrfBlock.js';
import { makeLoadError } from '../util/registryCore.js';
import { isResourceName, normLevel, pluginValueIssue } from './names.js';

export const FILE_NAME = 'bareos.json';
const FILE = () => path.join(config.configDir, 'bareos.json'); // 문자열 그대로 — scripts/config-doc.mjs 가 이 모양으로 파일을 찾는다
export const MAX_SITES = 200;
export const LIMITS = Object.freeze({
  timeoutMs: { min: 3_000, max: 120_000, def: 15_000 },
  pollIntervalSec: { min: 30, max: 3_600, def: 60 },
});
const HOST_RE = /^[A-Za-z0-9.:-]{1,253}$/;
const CONSOLE_NAME_RE = /^[A-Za-z0-9 ._:*-]{1,127}$/;
const FD_PATH_RE = /^\/[A-Za-z0-9._/-]{1,250}$/;

export const DEFAULTS = Object.freeze({
  director: Object.freeze({ host: '', port: 9101, consoleName: '', timeoutMs: LIMITS.timeoutMs.def, tlsMax: 'TLSv1.3' }),
  defaults: Object.freeze({ jobDefs: 'PortalVmwareDefaults', fileSet: 'PortalVmwareGeneric', restoreJob: 'PortalVmwareRestore', level: 'Incremental', pollIntervalSec: LIMITS.pollIntervalSec.def, pluginName: 'python3' }),
});

const clampInt = (v, { min, max, def }) => { const n = Math.round(Number(v)); return Number.isFinite(n) && v !== '' && v !== null ? Math.min(max, Math.max(min, n)) : def; };
const str = (v, max = 256) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

let _cache = null;
const _loadErr = makeLoadError();
const _listeners = new Set();

function emptySettings() {
  return { version: 1, director: { ...DEFAULTS.director }, defaults: { ...DEFAULTS.defaults }, sites: [] };
}

/** 내부 전용(비밀번호 포함). 화면·응답에는 publicSettings 를 쓴다. */
export function loadSettings() {
  if (_cache) return _cache;
  try {
    if (fs.existsSync(FILE())) {
      const raw = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('형식 오류');
      const p = openSecretsDeep(raw);
      const base = emptySettings();
      const d = p.director && typeof p.director === 'object' ? p.director : {};
      _cache = {
        version: 1,
        director: { ...base.director, ...pickDirector(d), ...(typeof d.password === 'string' && d.password ? { password: d.password } : {}) },
        defaults: { ...base.defaults, ...pickDefaults(p.defaults || {}) },
        sites: (Array.isArray(p.sites) ? p.sites : []).map((s) => normalizeSite(s).site).filter(Boolean).slice(0, MAX_SITES),
      };
      _loadErr.clear();
      return _cache;
    }
  } catch (e) {
    preserveCorrupt(FILE(), e?.message);
    _loadErr.set(e);
    console.warn(`[bareos] 설정 파일을 읽지 못했습니다(${safeLoadText(e) || '사유 미상'}) — 손상본을 보존하고 빈 설정으로 시작합니다.`);
  }
  _loadErr.checkCorruptOnly(FILE()); // 파일은 없고 손상 보존본만 남았으면 그 사실을 오류로 세운다
  _cache = emptySettings();
  return _cache;
}

export function settingsLoadError() { loadSettings(); return _loadErr.get(); }

function pickDirector(d) {
  const out = {};
  if (typeof d.host === 'string') out.host = d.host.trim();
  if (d.port !== undefined) out.port = Number(d.port);
  if (typeof d.consoleName === 'string') out.consoleName = d.consoleName.trim();
  if (d.timeoutMs !== undefined) out.timeoutMs = clampInt(d.timeoutMs, LIMITS.timeoutMs);
  if (d.tlsMax !== undefined) out.tlsMax = d.tlsMax === 'TLSv1.2' ? 'TLSv1.2' : 'TLSv1.3';
  return out;
}
function pickDefaults(d) {
  const out = {};
  for (const k of ['jobDefs', 'fileSet', 'restoreJob']) if (typeof d[k] === 'string' && (d[k] === '' || isResourceName(d[k]))) out[k] = d[k];
  if (d.level !== undefined) out.level = normLevel(d.level);
  if (d.pollIntervalSec !== undefined) out.pollIntervalSec = clampInt(d.pollIntervalSec, LIMITS.pollIntervalSec);
  if (d.pluginName === 'python' || d.pluginName === 'python3') out.pluginName = d.pluginName;
  return out;
}

/**
 * 사이트 매핑 1개 정규화(순수). @returns {{ site?: object, issue?: string }}
 */
export function normalizeSite(s = {}) {
  if (!s || typeof s !== 'object') return { issue: '사이트 매핑 형식이 올바르지 않습니다.' };
  const vcenterId = str(s.vcenterId, 128);
  if (!vcenterId) return { issue: 'vCenter 를 지정하세요.' };
  const vcserver = str(s.vcserver, 253);
  if (!HOST_RE.test(vcserver)) return { issue: `‘${vcenterId}’: FD 가 접속할 vCenter 주소(vcserver)는 호스트 이름 또는 IP 만 적습니다(스킴·경로 없이).` };
  const vi = pluginValueIssue(vcserver, 'vCenter 주소');
  if (vi) return { issue: `‘${vcenterId}’: ${vi}` };
  for (const k of ['client', 'storage', 'pool']) {
    if (!isResourceName(str(s[k], 64))) return { issue: `‘${vcenterId}’: ${k === 'client' ? 'FD 클라이언트' : k === 'storage' ? '스토리지' : '풀'} 이름을 Director 목록에서 고르세요.` };
  }
  const schedule = str(s.schedule, 64);
  if (schedule && !isResourceName(schedule)) return { issue: `‘${vcenterId}’: 스케줄 이름이 Bareos 리소스 규칙에 맞지 않습니다.` };
  const configFile = str(s.configFile, 251);
  if (!FD_PATH_RE.test(configFile) || /(^|\/)\.\.(\/|$)/.test(configFile)) return { issue: `‘${vcenterId}’: FD 자격증명 파일 경로는 절대 경로(영문·숫자·._-/)로 적습니다.` };
  return { site: { vcenterId, vcserver, client: str(s.client, 64), storage: str(s.storage, 64), pool: str(s.pool, 64), schedule, configFile } };
}

/** 저장 전 Director 접속값 검증(순수). @returns {string} 사유('' 통과) */
export function directorIssue(d) {
  if (!d.host) return '';
  if (!HOST_RE.test(d.host)) return 'Director 주소는 호스트 이름 또는 IP 만 적습니다(스킴·경로 없이).';
  const block = ipBlockReason(d.host);
  if (block) return `Director 주소를 쓸 수 없습니다: ${block}`;
  if (!Number.isInteger(d.port) || d.port < 1 || d.port > 65535) return 'Director 포트가 올바르지 않습니다(1~65535).';
  if (d.consoleName && !CONSOLE_NAME_RE.test(d.consoleName)) return '콘솔 이름이 올바르지 않습니다(영문·숫자·공백·._:*- 127자 이하).';
  return '';
}

/**
 * 부분 저장. body 의 director·defaults·sites 중 준 것만 바꾼다. sites 는 **통째로** 바꾼다(화면이 표 전체를 보낸다).
 * @returns {{ settings: object, droppedSecrets: string[] }}  settings 는 publicSettings 모양
 * @throws Error(message = 사람이 읽는 사유)
 */
export function saveSettings(body = {}) {
  const cur = loadSettings();
  const next = { version: 1, director: { ...cur.director }, defaults: { ...cur.defaults }, sites: cur.sites.map((s) => ({ ...s })) };
  let droppedSecrets = [];
  if (body.director && typeof body.director === 'object') {
    const bd = body.director;
    const moved = accessMoved(cur.director, bd, ['host', 'port', 'consoleName']);
    Object.assign(next.director, pickDirector(bd));
    if (secretProvided(bd.password)) next.director.password = String(bd.password).slice(0, 512);
    if (moved) droppedSecrets = dropCarriedSecrets(next.director, bd, ['password']);
    const issue = directorIssue(next.director);
    if (issue) throw new Error(issue);
  }
  if (body.defaults && typeof body.defaults === 'object') {
    for (const k of ['jobDefs', 'fileSet', 'restoreJob']) {
      if (body.defaults[k] !== undefined && body.defaults[k] !== '' && !isResourceName(body.defaults[k])) throw new Error(`${k} 이름이 Bareos 리소스 규칙에 맞지 않습니다.`);
    }
    Object.assign(next.defaults, pickDefaults(body.defaults));
  }
  if (body.sites !== undefined) {
    if (!Array.isArray(body.sites)) throw new Error('사이트 매핑 형식이 올바르지 않습니다.');
    if (body.sites.length > MAX_SITES) throw new Error(`사이트 매핑은 ${MAX_SITES}개까지입니다.`);
    const seen = new Set(); const sites = [];
    for (const s of body.sites) {
      const r = normalizeSite(s);
      if (r.issue) throw new Error(r.issue);
      if (seen.has(r.site.vcenterId)) throw new Error(`‘${r.site.vcenterId}’ 매핑이 두 번 있습니다.`);
      seen.add(r.site.vcenterId); sites.push(r.site);
    }
    next.sites = sites;
  }
  atomicWriteFileSync(FILE(), JSON.stringify(sealSecretsDeep(next), null, 2), { mode: 0o600 });
  _cache = next;
  _loadErr.clear();
  for (const cb of _listeners) { try { cb(); } catch { /* 리스너 실패가 저장을 막지 않는다 */ } }
  return { settings: publicSettings(), droppedSecrets };
}

/** 화면·응답용(비밀번호 없음). */
export function publicSettings() {
  const s = loadSettings();
  const { password, ...dir } = s.director;
  return { director: { ...dir, password: '', hasPassword: !!password }, defaults: { ...s.defaults }, sites: s.sites.map((x) => ({ ...x })) };
}

/** 콘솔 접속 옵션(console.js openConsole) — 설정이 덜 됐으면 { missing } 사유. */
export function directorConn(s = loadSettings()) {
  const d = s.director;
  const missing = [];
  if (!d.host) missing.push('Director 주소');
  if (!d.consoleName) missing.push('콘솔 이름');
  if (!d.password) missing.push('콘솔 비밀번호');
  if (missing.length) return { missing };
  return { conn: { host: d.host, port: d.port, name: d.consoleName, password: d.password, timeoutMs: d.timeoutMs, tlsMaxVersion: d.tlsMax } };
}

/** 인증 정지 기록용 신원(util/authGuard.js) — 주소·콘솔 이름·비밀번호가 바뀌면 자동 재개된다. */
export function directorCred(s = loadSettings()) {
  const d = s.director;
  return { id: 'director', username: `${d.host}:${d.port}/${d.consoleName}`, password: d.password || '' };
}

export const siteFor = (vcenterId, s = loadSettings()) => s.sites.find((x) => x.vcenterId === String(vcenterId)) || null;

export function onSettingsChange(cb) { _listeners.add(cb); return () => _listeners.delete(cb); }
export function _resetForTest() { _cache = null; _loadErr.clear(); }

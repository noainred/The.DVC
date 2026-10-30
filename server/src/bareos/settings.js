/**
 * bareos/settings.js — Bareos 연동 설정(v2.820 · v2.823 법인별 Director). 파일: CONFIG_DIR/bareos.json (0600 · 원자적 쓰기 · 비밀 봉인).
 *
 * v2.823(사용자 요청 '법인별로 bareos 를 설치 — 법인의 vCenter 가 법인에 설치된 bareos 에 연결해서 백업'):
 * {
 *   version: 2,
 *   directors: [ { id, name, host, port, consoleName, password, timeoutMs, tlsMax } ],   // 법인마다 Director 하나(비밀번호 봉인 — SECRET_FILES)
 *   defaults: { jobDefs, fileSet, restoreJob, level, pollIntervalSec, pluginName },      // 전 Director 공통
 *   sites: [ { vcenterId, directorId, vcserver, client, storage, pool, schedule, configFile } ],   // vCenter → 그 법인 Director·FD·SD
 *   director: { …directors[0] 사본… },   // 구버전 호환 — 되돌린 구버전이 첫 Director 는 계속 쓴다(새 코드는 읽지 않는다).
 *                                        //   한계(검토 C4): 구버전에서 **저장**하면 나머지 Director·법인 묶음이 사라진다 — 그 잡은 원장에서만 정리(라우트 orphanOf).
 * }
 *
 * 규칙(server/CLAUDE.md · bareos/CLAUDE.md):
 *  - vCenter 하나 → Director 하나. Director 하나 → vCenter 여러 개. Director id 는 만들 때 난수로 정하고 바꾸지 않는다(원장 잡이 그 id 를 가리킨다).
 *  - v1(director 하나) 파일은 **읽을 때만** v2 로 바꾼다(id 'dir_default') — 로드는 파일을 다시 쓰지 않는다(다음 저장 때 v2 로 쓴다).
 *  - 매핑(site)은 Director 에 묶는 것이 먼저고, FD·스토리지·풀·INI 칸은 비어 있어도 된다(자동 설정 5단계 '매핑 채움' 이 채운다).
 *    등록 가능 여부는 service.eligibility 가 빈 칸을 사유로 밝힌다. 칸에 값이 있으면 지금처럼 화이트리스트로 검사한다.
 *  - 로드 손상 → preserveCorrupt + 빈 설정(원본은 옆에 보존) · 로드 오류는 기억해 화면이 밝힌다.
 *  - 접속처(host·port·consoleName)가 바뀌면 **그 Director 의** 저장 비밀번호를 승계하지 않는다(util/secretCarry.js).
 *  - 주소는 IP 리터럴 차단 대역(ipBlockReason)을 저장 때도 거부한다(접속 때는 ssrfLookup 이 다시 본다).
 *  - 응답에는 비밀번호를 싣지 않는다(hasPassword 만) · vCenter 자격증명은 여기에 없다(사이트 FD 의 INI 가 갖는다).
 *  - 백업 대상이 있는 vCenter 의 Director 를 바꾸거나 매핑을 지우지 않는다(잡은 옛 Director 의 conf 에 있다) · 매핑·대상이 있는 Director 는 지우지 않는다.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
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
export const MAX_DIRECTORS = 64;
/** v1 파일을 읽을 때 그 Director 에 주는 id(원장의 옛 잡·인증 정지 기록이 이 id 로 이어진다). */
export const DEFAULT_DIRECTOR_ID = 'dir_default';
export const LIMITS = Object.freeze({
  timeoutMs: { min: 3_000, max: 120_000, def: 15_000 },
  pollIntervalSec: { min: 30, max: 3_600, def: 60 },
});
const HOST_RE = /^[A-Za-z0-9.:-]{1,253}$/;
const CONSOLE_NAME_RE = /^[A-Za-z0-9 ._:*-]{1,127}$/;
const FD_PATH_RE = /^\/[A-Za-z0-9._/-]{1,250}$/;
export const DIRECTOR_ID_RE = /^dir_[a-z0-9_]{1,40}$/;
/** 법인 이름 — 화면·메일·감사에 쓴다(메일은 esc). 제어문자·꺾쇠·따옴표·백틱 금지. */
const DIRECTOR_NAME_RE = /^[^\u0000-\u001f\u007f<>"'`]{1,64}$/;

export const DEFAULTS = Object.freeze({
  director: Object.freeze({ name: '', host: '', port: 9101, consoleName: '', timeoutMs: LIMITS.timeoutMs.def, tlsMax: 'TLSv1.3' }),
  defaults: Object.freeze({ jobDefs: 'PortalVmwareDefaults', fileSet: 'PortalVmwareGeneric', restoreJob: 'PortalVmwareRestore', level: 'Incremental', pollIntervalSec: LIMITS.pollIntervalSec.def, pluginName: 'python3' }),
});

const clampInt = (v, { min, max, def }) => { const n = Math.round(Number(v)); return Number.isFinite(n) && v !== '' && v !== null ? Math.min(max, Math.max(min, n)) : def; };
const str = (v, max = 256) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const fail = (code, message) => Object.assign(new Error(message), { code });

let _cache = null;
let _rev = 0;
const _loadErr = makeLoadError();
const _listeners = new Set();

function emptySettings() {
  return { version: 2, directors: [], defaults: { ...DEFAULTS.defaults }, sites: [] };
}

/** 설정 세대 — 저장할 때마다 오른다(카탈로그 memo 같은 '설정에서 나온 값' 의 키). */
export const settingsRev = () => _rev;

function readDirectorRecord(d, id) {
  if (!d || typeof d !== 'object') return null;
  const out = { ...DEFAULTS.director, ...pickDirector(d), id };
  if (typeof d.password === 'string' && d.password) out.password = d.password;
  if (!out.name) out.name = id === DEFAULT_DIRECTOR_ID ? '기본 Director' : (out.host || id);
  return out;
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
      let directors = [];
      const legacy = !Array.isArray(p.directors);
      if (!legacy) {
        const seen = new Set();
        for (const d of p.directors) {
          const id = typeof d?.id === 'string' ? d.id : '';
          if (!DIRECTOR_ID_RE.test(id) || seen.has(id)) continue;
          seen.add(id);
          const rec = readDirectorRecord(d, id);
          if (rec) directors.push(rec);
          if (directors.length >= MAX_DIRECTORS) break;
        }
      } else {
        // v1 → v2(읽을 때만). 접속값이나 매핑이 하나라도 있으면 그 Director 를 'dir_default' 로 둔다(옛 매핑·원장 잡이 그 id 를 가리킨다).
        const d = p.director && typeof p.director === 'object' ? p.director : {};
        const hasAny = ['host', 'consoleName', 'password'].some((k) => typeof d[k] === 'string' && d[k]) || (Array.isArray(p.sites) && p.sites.length > 0);
        if (hasAny) directors = [readDirectorRecord(d, DEFAULT_DIRECTOR_ID)];
      }
      const ids = new Set(directors.map((d) => d.id));
      const sites = [];
      for (const s of (Array.isArray(p.sites) ? p.sites : [])) {
        const withDir = legacy && s && typeof s === 'object' && !s.directorId ? { ...s, directorId: DEFAULT_DIRECTOR_ID } : s;
        const r = normalizeSite(withDir);
        if (!r.site) continue;
        // 없는 Director 를 가리키는 매핑(손으로 고친 파일) — 쓸 수 없으니 뺀다(경고). deleteDirector 는 매핑이 있으면 지우지 않는다.
        if (!ids.has(r.site.directorId)) { console.warn(`[bareos] 설정의 vCenter ‘${r.site.vcenterId}’ 매핑이 없는 Director 를 가리켜 뺐습니다.`); continue; }
        sites.push(r.site);
        if (sites.length >= MAX_SITES) break;
      }
      _cache = { version: 2, directors, defaults: { ...base.defaults, ...pickDefaults(p.defaults || {}) }, sites };
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
  if (typeof d.name === 'string') out.name = d.name.trim().slice(0, 64);
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

/** 매핑에서 등록에 꼭 있어야 하는 칸 → 화면 이름. */
export const SITE_REQUIRED = Object.freeze([['vcserver', 'vcserver'], ['client', 'FD 클라이언트'], ['storage', '스토리지'], ['pool', '풀'], ['configFile', 'INI 경로']]);

/** 매핑의 빈 칸(등록에 필요한 것) — 화면 이름 목록. 다 찼으면 []. */
export function siteMissing(site) {
  return SITE_REQUIRED.filter(([k]) => !site?.[k]).map(([, label]) => label);
}

/**
 * 사이트 매핑 1개 정규화(순수). vcenterId·directorId 는 필수, 나머지는 비어 있어도 된다(채운 칸은 검사한다).
 * @returns {{ site?: object, issue?: string }}
 */
export function normalizeSite(s = {}) {
  if (!s || typeof s !== 'object') return { issue: '사이트 매핑 형식이 올바르지 않습니다.' };
  const vcenterId = str(s.vcenterId, 128);
  if (!vcenterId) return { issue: 'vCenter 를 지정하세요.' };
  const directorId = str(s.directorId, 44);
  if (!DIRECTOR_ID_RE.test(directorId)) return { issue: `‘${vcenterId}’: 이 vCenter 를 묶을 법인 Director 를 고르세요.` };
  const vcserver = str(s.vcserver, 253);
  if (vcserver) {
    if (!HOST_RE.test(vcserver)) return { issue: `‘${vcenterId}’: FD 가 접속할 vCenter 주소(vcserver)는 호스트 이름 또는 IP 만 적습니다(스킴·경로 없이).` };
    const vi = pluginValueIssue(vcserver, 'vCenter 주소');
    if (vi) return { issue: `‘${vcenterId}’: ${vi}` };
  }
  for (const k of ['client', 'storage', 'pool']) {
    const v = str(s[k], 64);
    if (v && !isResourceName(v)) return { issue: `‘${vcenterId}’: ${k === 'client' ? 'FD 클라이언트' : k === 'storage' ? '스토리지' : '풀'} 이름을 Director 목록에서 고르세요.` };
  }
  const schedule = str(s.schedule, 64);
  if (schedule && !isResourceName(schedule)) return { issue: `‘${vcenterId}’: 스케줄 이름이 Bareos 리소스 규칙에 맞지 않습니다.` };
  const configFile = str(s.configFile, 251);
  if (configFile && (!FD_PATH_RE.test(configFile) || /(^|\/)\.\.(\/|$)/.test(configFile))) return { issue: `‘${vcenterId}’: FD 자격증명 파일 경로는 절대 경로(영문·숫자·._-/)로 적습니다.` };
  return { site: { vcenterId, directorId, vcserver, client: str(s.client, 64), storage: str(s.storage, 64), pool: str(s.pool, 64), schedule, configFile } };
}

/** 저장 전 Director 접속값 검증(순수). @returns {string} 사유('' 통과) */
export function directorIssue(d) {
  if (d.name !== undefined && d.name !== '' && !DIRECTOR_NAME_RE.test(d.name)) return '법인 이름에 쓸 수 없는 글자가 있습니다(꺾쇠·따옴표·백틱·제어문자 금지, 64자 이하).';
  if (!d.host) return '';
  if (!HOST_RE.test(d.host)) return 'Director 주소는 호스트 이름 또는 IP 만 적습니다(스킴·경로 없이).';
  const block = ipBlockReason(d.host);
  if (block) return `Director 주소를 쓸 수 없습니다: ${block}`;
  if (!Number.isInteger(d.port) || d.port < 1 || d.port > 65535) return 'Director 포트가 올바르지 않습니다(1~65535).';
  if (d.consoleName && !CONSOLE_NAME_RE.test(d.consoleName)) return '콘솔 이름이 올바르지 않습니다(영문·숫자·공백·._:*- 127자 이하).';
  return '';
}

/** 다른 Director 와 겹치는가 — 같은 이름(대소문자 무시) · 같은 주소:포트/콘솔(두 항목이 한 콘솔을 나눠 쓰면 원장이 둘로 갈린다). */
function clashIssue(list, d) {
  const lc = (x) => String(x || '').trim().toLowerCase();
  for (const o of list) {
    if (o.id === d.id) continue;
    if (lc(o.name) && lc(o.name) === lc(d.name)) return `‘${d.name}’ 이름의 Director 가 이미 있습니다.`;
    if (d.host && d.consoleName && lc(o.host) === lc(d.host) && Number(o.port) === Number(d.port) && o.consoleName === d.consoleName) {
      return `같은 Director 콘솔(${d.host}:${d.port} · ${d.consoleName})이 ‘${o.name}’ 로 이미 등록돼 있습니다.`;
    }
  }
  return '';
}

function persist(next) {
  const first = next.directors[0];
  const mirror = first ? (({ id, name, ...rest }) => rest)(first) : undefined;   // 구버전 호환 사본(이름·id 없이 접속값만)
  atomicWriteFileSync(FILE(), JSON.stringify(sealSecretsDeep({ ...next, version: 2, ...(mirror ? { director: mirror } : {}) }), null, 2), { mode: 0o600 });
  _cache = next;
  _rev += 1;
  _loadErr.clear();
  for (const cb of _listeners) { try { cb(); } catch { /* 리스너 실패가 저장을 막지 않는다 */ } }
}

const cloneSettings = (cur) => ({ version: 2, directors: cur.directors.map((d) => ({ ...d })), defaults: { ...cur.defaults }, sites: cur.sites.map((s) => ({ ...s })) });

/**
 * 공통 기본값·매핑 저장. body 의 defaults·sites 중 준 것만 바꾼다. sites 는 **통째로** 바꾼다(화면이 표 전체를 보낸다).
 * Director 접속값은 여기서 바꾸지 않는다(addDirector·updateDirector — 비밀번호 폐기 판정이 Director 마다다).
 * @param {{ jobDirs?: Map<string, Set<string>> }} [o] 백업 대상이 있는 vCenter → 그 대상들의 Director id(`jobDirectorId` 로 푼 값) —
 *   그 vCenter 는 다른 Director 로 묶거나 매핑을 지우지 않는다. v2.823 검토(S3·C2·I2 — 재현): 예전에는 '지금 매핑' 과만 비교해, v1 시절 매핑을
 *   지운 vCenter 의 옛 잡(directorId 없음 → dir_default 로 풀림)이 있는데 그 vCenter 를 다른 법인 Director 에 **새로** 묶으면 검사를 건너뛰고
 *   옛 잡의 실행·폴러·삭제가 엉뚱한 Director 로 갔다. 이제 잡이 실제로 가리키는 Director 와 비교한다.
 * @returns {{ settings: object, droppedSecrets: string[] }}  settings 는 publicSettings 모양
 * @throws Error(message = 사람이 읽는 사유, code invalid|conflict)
 */
export function saveSettings(body = {}, { jobDirs = new Map() } = {}) {
  if (body.director !== undefined) throw fail('invalid', 'Director 접속값은 법인별 Director 화면(설정 › 법인별 Director)에서 저장합니다.');
  const cur = loadSettings();
  const next = cloneSettings(cur);
  if (body.defaults && typeof body.defaults === 'object') {
    for (const k of ['jobDefs', 'fileSet', 'restoreJob']) {
      if (body.defaults[k] !== undefined && body.defaults[k] !== '' && !isResourceName(body.defaults[k])) throw fail('invalid', `${k} 이름이 Bareos 리소스 규칙에 맞지 않습니다.`);
    }
    Object.assign(next.defaults, pickDefaults(body.defaults));
  }
  if (body.sites !== undefined) {
    if (!Array.isArray(body.sites)) throw fail('invalid', '사이트 매핑 형식이 올바르지 않습니다.');
    if (body.sites.length > MAX_SITES) throw fail('invalid', `사이트 매핑은 ${MAX_SITES}개까지입니다.`);
    const ids = new Set(next.directors.map((d) => d.id));
    const seen = new Set(); const sites = [];
    for (const s of body.sites) {
      const r = normalizeSite(s);
      if (r.issue) throw fail('invalid', r.issue);
      if (seen.has(r.site.vcenterId)) throw fail('invalid', `‘${r.site.vcenterId}’ 매핑이 두 번 있습니다.`);
      if (!ids.has(r.site.directorId)) throw fail('invalid', `‘${r.site.vcenterId}’: 없는 Director 에 묶으려 했습니다.`);
      seen.add(r.site.vcenterId); sites.push(r.site);
    }
    for (const [vc, dirs] of jobDirs) {
      const was = cur.sites.find((x) => x.vcenterId === vc);
      const now = sites.find((x) => x.vcenterId === vc);
      if (!now) {
        if (was) throw fail('conflict', `‘${vc}’ 에 백업 대상이 있어 매핑을 지울 수 없습니다 — 그 vCenter 의 백업 대상을 먼저 지우세요.`);
        continue;   // 원래 매핑이 없었다(옛 잡) — 그대로 둔다
      }
      if ([...dirs].some((id) => id !== now.directorId)) throw fail('conflict', `‘${vc}’ 에 백업 대상이 있어 다른 Director 로 옮길 수 없습니다 — 잡은 지금 Director 의 설정에 있습니다. 백업 대상을 먼저 지우세요.`);
    }
    next.sites = sites;
  }
  persist(next);
  return { settings: publicSettings(), droppedSecrets: [] };
}

/**
 * Director 추가. @returns {{ director: object(public), droppedSecrets: [] }}
 * @throws Error(code invalid)
 */
export function addDirector(body = {}) {
  const cur = loadSettings();
  if (cur.directors.length >= MAX_DIRECTORS) throw fail('invalid', `Director 는 ${MAX_DIRECTORS}개까지 등록할 수 있습니다.`);
  const next = cloneSettings(cur);
  const d = { ...DEFAULTS.director, ...pickDirector(body), id: `dir_${crypto.randomBytes(5).toString('hex')}` };
  if (!d.name) d.name = d.host || '새 Director';
  if (secretProvided(body.password)) d.password = String(body.password).slice(0, 512);
  const issue = directorIssue(d) || clashIssue(next.directors, d);
  if (issue) throw fail('invalid', issue);
  next.directors.push(d);
  persist(next);
  return { director: publicDirector(d), droppedSecrets: [] };
}

/**
 * Director 접속값 바꾸기 — 준 칸만. 주소·포트·콘솔 이름이 바뀌면 **이 Director 의** 저장 비밀번호를 승계하지 않는다(새 비밀번호를 같이 주면 그것).
 * @returns {{ director: object(public), droppedSecrets: string[] }}
 * @throws Error(code invalid|not-found)
 */
export function updateDirector(id, body = {}) {
  const cur = loadSettings();
  const next = cloneSettings(cur);
  const d = next.directors.find((x) => x.id === id);
  if (!d) throw fail('not-found', 'Director 를 찾을 수 없습니다.');
  const before = { ...d };
  const moved = accessMoved(before, body, ['host', 'port', 'consoleName']);
  Object.assign(d, pickDirector(body));
  if (!d.name) d.name = before.name;
  if (secretProvided(body.password)) d.password = String(body.password).slice(0, 512);
  let droppedSecrets = [];
  if (moved) droppedSecrets = dropCarriedSecrets(d, body, ['password']);
  const issue = directorIssue(d) || clashIssue(next.directors, d);
  if (issue) throw fail('invalid', issue);
  persist(next);
  return { director: publicDirector(d), droppedSecrets };
}

/**
 * Director 지우기 — 매핑(vCenter)이나 백업 대상이 가리키면 지우지 않는다(잡은 그 Director 의 conf 에 있다).
 * @param {{ inUseByJobs?: number }} [o] 이 Director 의 백업 대상 수(라우트가 원장에서 센다)
 * @throws Error(code not-found|conflict)
 */
export function deleteDirector(id, { inUseByJobs = 0 } = {}) {
  const cur = loadSettings();
  const d = cur.directors.find((x) => x.id === id);
  if (!d) throw fail('not-found', 'Director 를 찾을 수 없습니다.');
  const mapped = cur.sites.filter((s) => s.directorId === id).map((s) => s.vcenterId);
  if (mapped.length) throw fail('conflict', `이 Director 에 묶인 vCenter 가 있습니다(${mapped.slice(0, 5).join(', ')}${mapped.length > 5 ? ` 외 ${mapped.length - 5}` : ''}) — 매핑을 먼저 풀거나 다른 Director 로 옮기세요.`);
  if (inUseByJobs > 0) throw fail('conflict', `이 Director 의 백업 대상이 ${inUseByJobs}개 있습니다 — 대상을 먼저 지우세요.`);
  const next = cloneSettings(cur);
  next.directors = next.directors.filter((x) => x.id !== id);
  persist(next);
  return { ok: true, name: d.name };
}

/** 화면·응답용 Director(비밀번호 없음). */
export function publicDirector(d) {
  if (!d) return null;
  const { password, ...rest } = d;
  return { ...rest, password: '', hasPassword: !!password };
}

/** 화면·응답용(비밀번호 없음). */
export function publicSettings() {
  const s = loadSettings();
  return { directors: s.directors.map(publicDirector), defaults: { ...s.defaults }, sites: s.sites.map((x) => ({ ...x })) };
}

export const directorById = (id, s = loadSettings()) => s.directors.find((d) => d.id === String(id || '')) || null;
export const siteFor = (vcenterId, s = loadSettings()) => s.sites.find((x) => x.vcenterId === String(vcenterId)) || null;
export const directorForVcenter = (vcenterId, s = loadSettings()) => { const site = siteFor(vcenterId, s); return site ? directorById(site.directorId, s) : null; };

/**
 * 원장 잡의 Director id — 등록 때 고정한 값. v2.823 이전 잡(값 없음)은 그 vCenter 매핑의 Director, 그것도 없으면 'dir_default'.
 * (백업 대상이 있는 vCenter 는 그 잡들이 가리키는 Director 와 다른 곳에 묶을 수 없으므로 옛 잡의 풀이가 흔들리지 않는다 — saveSettings 의 jobDirs.)
 */
export function jobDirectorId(job, s = loadSettings()) {
  return (typeof job?.directorId === 'string' && job.directorId) || siteFor(job?.vcenterId, s)?.directorId || DEFAULT_DIRECTOR_ID;
}

/** 콘솔 접속 옵션(console.js openConsole) — Director 하나. 덜 됐으면 { missing } 사유. */
export function directorConn(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d.directors)) return { missing: ['Director'] };
  const missing = [];
  if (!d.host) missing.push('Director 주소');
  if (!d.consoleName) missing.push('콘솔 이름');
  if (!d.password) missing.push('콘솔 비밀번호');
  if (missing.length) return { missing };
  return { conn: { host: d.host, port: d.port, name: d.consoleName, password: d.password, timeoutMs: d.timeoutMs, tlsMaxVersion: d.tlsMax } };
}

/** 접속할 수 있는 Director 가 하나라도 있나. */
export const anyDirectorConfigured = (s = loadSettings()) => s.directors.some((d) => !!directorConn(d).conn);

/**
 * 인증 정지 기록용 신원(util/authGuard.js) — 주소·콘솔 이름·비밀번호가 바뀌면 자동 재개된다.
 * 'dir_default'(v1 에서 넘어온 Director)는 예전 id('director')를 그대로 써서 올리기 전의 정지 기록을 잇는다(올렸다고 한 번 더 붙지 않게).
 */
export function directorCred(d) {
  const id = d?.id === DEFAULT_DIRECTOR_ID ? 'director' : `director:${d?.id || ''}`;
  return { id, username: `${d?.host || ''}:${d?.port || ''}/${d?.consoleName || ''}`, password: d?.password || '' };
}

export function onSettingsChange(cb) { _listeners.add(cb); return () => _listeners.delete(cb); }
export function _resetForTest() { _cache = null; _loadErr.clear(); }

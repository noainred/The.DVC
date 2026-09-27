/**
 * linkcheck/settings.js — 통신 점검 설정(v2.552). 파일: `CONFIG_DIR/linkcheck-settings.json`
 *
 * ⚠ **기본 꺼짐(opt-in)** — 켜면 주기마다 링크 수만큼 TCP/TLS/HTTP 가 나간다. 링크가 140개면
 *   5분 주기에 하루 4만 회다. 회선·상대 부하를 보며 켜는 것이 설계다.
 * ⚠ 주기·보존 **숫자를 화면 문구에 박지 말 것** — 이 모듈이 주는 값만 쓴다(CLAUDE.md 규약).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { KIND_KEYS } from './links.js';
import { numOrNull } from '../util/numOrNull.js';
import { makeSettingsLoadError } from '../util/settingsLoadError.js';
import { clampSetting } from '../util/clampSetting.js'; // v2.613 DEPS2613-12 · RUNTIME2613-08: 숫자 설정 정규화는 하나(빈 칸 = 미지정)

const FILE = () => path.join(config.configDir, 'linkcheck-settings.json');

export const DEFAULTS = Object.freeze({
  enabled: false,
  // v2.553: 설정 전수 점검(25종). 링크 점검과 **같은 주기·같은 가드**를 쓰고 여기서만 끈다.
  settingsCheck: true,
  intervalMs: 5 * 60_000,
  // 링크 종류별 on/off — 기본은 전부 켜짐(명시 false 만 끈다).
  kinds: {},
  // 엣지↔엣지 짝. ⚠ **전량 자동 생성 금지**(28곳이면 756 방향) — 고른 짝만.
  pairs: [],
  // 단계별 시한. 고RTT 구간(폴란드·미국 800ms+)을 고려한 값이다.
  dnsTimeoutMs: 5_000,
  tcpTimeoutMs: 8_000,
  tlsTimeoutMs: 10_000,
  httpTimeoutMs: 15_000,
  sshTimeoutMs: 12_000,
  smtpTimeoutMs: 12_000,
  concurrency: 6,
  // 3단 보존(사용자 선택). 근거는 db.js 머리말의 실제 계산.
  sampleRetentionDays: 90,
  eventRetentionDays: 30,
  dailyRetentionDays: 365 * 5,
});

const MIN_INTERVAL_MS = 60_000;
const MAX_INTERVAL_MS = 6 * 3_600_000;
// v2.602(감사 LEFT2602-02): 빈 값·null 은 '미지정' — dflt 로 둔다. 예전 Number('') === 0 이 하한으로 올라가
// 보존 90→7일·30→3일·주기→60초로 저장됐다(v2.596 CLAMP 계열). saveLinkCheckSettings 는 빈 숫자 필드를 병합 전에 버린다.

export function normalizeSettings(raw = {}) {
  const kinds = {};
  for (const k of KIND_KEYS) if (raw?.kinds?.[k] === false) kinds[k] = false;   // 켠 것을 쌓지 않는다
  const pairs = [];
  const seen = new Set();
  for (const p of Array.isArray(raw?.pairs) ? raw.pairs.slice(0, 200) : []) {
    const from = String(p?.from ?? '').trim().slice(0, 64);
    const to = String(p?.to ?? '').trim().slice(0, 64);
    if (!from || !to || from === to) continue;
    const key = `${from}|${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({ from, to });
  }
  return {
    enabled: raw?.enabled === true,
    // 기본 켜짐(명시 false 만 끈다) — '설정에 있는 모든 통신' 이 이 기능의 요청이다.
    settingsCheck: raw?.settingsCheck !== false,
    intervalMs: clampSetting(raw?.intervalMs, { min: MIN_INTERVAL_MS, max: MAX_INTERVAL_MS, def: DEFAULTS.intervalMs }),
    kinds, pairs,
    dnsTimeoutMs: clampSetting(raw?.dnsTimeoutMs, { min: 1_000, max: 30_000, def: DEFAULTS.dnsTimeoutMs }),
    tcpTimeoutMs: clampSetting(raw?.tcpTimeoutMs, { min: 1_000, max: 60_000, def: DEFAULTS.tcpTimeoutMs }),
    tlsTimeoutMs: clampSetting(raw?.tlsTimeoutMs, { min: 1_000, max: 60_000, def: DEFAULTS.tlsTimeoutMs }),
    httpTimeoutMs: clampSetting(raw?.httpTimeoutMs, { min: 1_000, max: 120_000, def: DEFAULTS.httpTimeoutMs }),
    sshTimeoutMs: clampSetting(raw?.sshTimeoutMs, { min: 1_000, max: 60_000, def: DEFAULTS.sshTimeoutMs }),
    smtpTimeoutMs: clampSetting(raw?.smtpTimeoutMs, { min: 1_000, max: 60_000, def: DEFAULTS.smtpTimeoutMs }),
    concurrency: clampSetting(raw?.concurrency, { min: 1, max: 32, def: DEFAULTS.concurrency }),
    sampleRetentionDays: clampSetting(raw?.sampleRetentionDays, { min: 7, max: 365, def: DEFAULTS.sampleRetentionDays }),
    eventRetentionDays: clampSetting(raw?.eventRetentionDays, { min: 3, max: 365, def: DEFAULTS.eventRetentionDays }),
    dailyRetentionDays: clampSetting(raw?.dailyRetentionDays, { min: 30, max: 365 * 10, def: DEFAULTS.dailyRetentionDays }),
  };
}

/*
 * v2.632(감사 EDGE2632-03): 로드 오류 상태. 손상 → 보존 → 기본값(꺼짐)이면 /api/central/link-check-config 가 enabled:false 로 답해
 *   전 엣지가 측정을 멈추고 화면은 '점검 꺼짐' 이라 말했다(원인은 손상). 오류면 라우트가 503 settingsUnreadable 로 답한다
 *   (엣지 워커는 비-2xx 를 실패로 보고 직전 설정으로 측정을 이어간다). 관리자 저장만 해제한다.
 */
const _loadErr = makeSettingsLoadError(() => FILE());
/** 설정 파일을 못 읽었으면 { at, reason }, 읽었으면 null. */
export function linkCheckSettingsLoadError() { loadLinkCheckSettings(); return _loadErr.get(); }

export function loadLinkCheckSettings() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('객체가 아닌 JSON 값');
    const out = normalizeSettings(j);
    _loadErr.ok();
    return out;
  } catch (e) {
    // 손상은 보존한다 — 다음 저장이 온전했던 원본을 덮어쓰지 않게(v2.190 규약).
    if (e?.code !== 'ENOENT') { _loadErr.corrupt(e); try { preserveCorrupt(FILE()); } catch { /* */ } }
    else _loadErr.missing();
    return { ...DEFAULTS, kinds: {}, pairs: [] };
  }
}

/*
 * 주기 변경을 **무장된 타이머에 즉시 반영**하기 위한 리스너(v2.409 규약).
 * 없으면 6시간 주기에서 최대 6시간 뒤에야 새 주기가 먹는다.
 */
const _listeners = new Set();
export function onLinkCheckSettingsChange(fn) {
  if (typeof fn !== 'function') return () => {};
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

const NUMERIC_KEYS = Object.keys(DEFAULTS).filter((k) => typeof DEFAULTS[k] === 'number');
export function saveLinkCheckSettings(body = {}) {
  const cur = loadLinkCheckSettings();
  // 숫자 필드가 비었으면(빈 문자열·null·숫자 아님) 이전 값을 유지한다 — 병합 전에 버린다.
  body = { ...(body || {}) };
  for (const k of NUMERIC_KEYS) if (k in body && numOrNull(body[k]) == null) delete body[k];
  const next = normalizeSettings({ ...cur, ...body, kinds: { ...cur.kinds, ...(body?.kinds || {}) } });
  atomicWriteFileSync(FILE(), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  _loadErr.ok();
  for (const fn of _listeners) { try { fn(next); } catch { /* 리스너 오류가 저장을 되돌리지 않게 */ } }
  return next;
}
export function linkCheckEnabled() {
  if (String(process.env.LINKCHECK_ENABLED || '').toLowerCase() === 'true') return true;
  if (String(process.env.LINKCHECK_ENABLED || '').toLowerCase() === 'false') return false;
  return loadLinkCheckSettings().enabled;
}

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

const FILE = () => path.join(config.configDir, 'linkcheck-settings.json');

export const DEFAULTS = Object.freeze({
  enabled: false,
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
  concurrency: 6,
  // 3단 보존(사용자 선택). 근거는 db.js 머리말의 실제 계산.
  sampleRetentionDays: 90,
  eventRetentionDays: 30,
  dailyRetentionDays: 365 * 5,
});

const MIN_INTERVAL_MS = 60_000;
const MAX_INTERVAL_MS = 6 * 3_600_000;
const clampInt = (v, lo, hi, dflt) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.round(n)));
};

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
    intervalMs: clampInt(raw?.intervalMs, MIN_INTERVAL_MS, MAX_INTERVAL_MS, DEFAULTS.intervalMs),
    kinds, pairs,
    dnsTimeoutMs: clampInt(raw?.dnsTimeoutMs, 1_000, 30_000, DEFAULTS.dnsTimeoutMs),
    tcpTimeoutMs: clampInt(raw?.tcpTimeoutMs, 1_000, 60_000, DEFAULTS.tcpTimeoutMs),
    tlsTimeoutMs: clampInt(raw?.tlsTimeoutMs, 1_000, 60_000, DEFAULTS.tlsTimeoutMs),
    httpTimeoutMs: clampInt(raw?.httpTimeoutMs, 1_000, 120_000, DEFAULTS.httpTimeoutMs),
    concurrency: clampInt(raw?.concurrency, 1, 32, DEFAULTS.concurrency),
    sampleRetentionDays: clampInt(raw?.sampleRetentionDays, 7, 365, DEFAULTS.sampleRetentionDays),
    eventRetentionDays: clampInt(raw?.eventRetentionDays, 3, 365, DEFAULTS.eventRetentionDays),
    dailyRetentionDays: clampInt(raw?.dailyRetentionDays, 30, 365 * 10, DEFAULTS.dailyRetentionDays),
  };
}

export function loadLinkCheckSettings() {
  try { return normalizeSettings(JSON.parse(fs.readFileSync(FILE(), 'utf8'))); }
  catch (e) {
    // 손상은 보존한다 — 다음 저장이 온전했던 원본을 덮어쓰지 않게(v2.190 규약).
    if (e?.code !== 'ENOENT') { try { preserveCorrupt(FILE()); } catch { /* */ } }
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

export function saveLinkCheckSettings(body = {}) {
  const cur = loadLinkCheckSettings();
  const next = normalizeSettings({ ...cur, ...body, kinds: { ...cur.kinds, ...(body?.kinds || {}) } });
  atomicWriteFileSync(FILE(), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  for (const fn of _listeners) { try { fn(next); } catch { /* 리스너 오류가 저장을 되돌리지 않게 */ } }
  return next;
}
export function linkCheckEnabled() {
  if (String(process.env.LINKCHECK_ENABLED || '').toLowerCase() === 'true') return true;
  if (String(process.env.LINKCHECK_ENABLED || '').toLowerCase() === 'false') return false;
  return loadLinkCheckSettings().enabled;
}

/**
 * diskbad/settings.js — 디스크 배드 섹터 이력 설정(v3.8.0). **중앙에만** 있다(엣지는 중앙이 보낸 작업만 돈다).
 *
 * 값:
 *  · `autoEnabled` — 6시간 자동 점검. **기본 꺼짐**(사용자 선택 '보수적으로' — 실장비 확인 전에 업그레이드만으로 전 법인 iDRAC 에
 *    Lifecycle 로그 전량 읽기가 한꺼번에 나가지 않게. 켜는 것은 화면의 버튼 한 번). 수동 점검(전체 · 법인 · 서버)은 꺼져 있어도 된다.
 *  · `intervalHours` — 사용자 결정 6시간(README §11). 범위 [1, 168].
 *  · `mailEnabled` — 새 기록 메일(README §10 결정). 받는 사람은 메일 종류 'disk-bad' 수신자 + 법인별 `corpTo`.
 *  · `corpTo` — 법인(vCenter id) → 담당자 메일 주소 목록(README §15 결정 '법인 담당자 + 전체 관리자').
 *
 * ⚠ 비밀을 담지 않는다. 손상되면 `preserveCorrupt` 로 보존하고 기본값(꺼짐)으로 시작하며 그 사실을 상태에 싣는다(무음 금지).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt, safeLoadText } from '../util/atomicWrite.js';

const FILE = () => path.join(config.configDir, 'disk-bad-settings.json');
export const DEFAULTS = Object.freeze({ autoEnabled: false, intervalHours: 6, mailEnabled: true, corpTo: {} });
const EMAIL_RE = /^[^\s@<>()",;]{1,64}@[A-Za-z0-9.-]{1,190}$/;
const MAX_CORPS = 200;
const MAX_TO = 20;

let _mem = null;
let _loadError = null;

/** 저장 · 읽기 공용 정규화(모르는 키는 버린다). */
export function normalizeSettings(raw = {}) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const h = Number(r.intervalHours);
  const corpTo = {};
  const src = r.corpTo && typeof r.corpTo === 'object' && !Array.isArray(r.corpTo) ? r.corpTo : {};
  for (const [k, v] of Object.entries(src).slice(0, MAX_CORPS)) {
    const id = String(k).trim().slice(0, 128);
    if (!id) continue;
    const list = (Array.isArray(v) ? v : String(v ?? '').split(/[\s,;]+/)).map((s) => String(s).trim()).filter((s) => EMAIL_RE.test(s));
    const uniq = [...new Set(list)].slice(0, MAX_TO);
    if (uniq.length) corpTo[id] = uniq;
  }
  return {
    autoEnabled: r.autoEnabled === true,
    intervalHours: Number.isFinite(h) ? Math.min(168, Math.max(1, Math.round(h))) : DEFAULTS.intervalHours,
    mailEnabled: r.mailEnabled !== false,
    corpTo,
  };
}

export function loadDiskBadSettings() {
  if (_mem) return _mem;
  try {
    if (!fs.existsSync(FILE())) { _mem = { ...DEFAULTS, corpTo: {} }; _loadError = null; return _mem; }
    _mem = normalizeSettings(JSON.parse(fs.readFileSync(FILE(), 'utf8')));
    _loadError = null;
  } catch (e) {
    try { preserveCorrupt(FILE(), String(e?.message || e)); } catch { /* best effort */ }
    _loadError = { at: Date.now(), reason: safeLoadText(e) };
    console.warn(`[diskbad] 설정 파일을 읽지 못해 기본값(자동 점검 꺼짐)으로 시작합니다: ${_loadError.reason}`);
    _mem = { ...DEFAULTS, corpTo: {} };
  }
  return _mem;
}

export function diskBadSettingsLoadError() { loadDiskBadSettings(); return _loadError; }

export function saveDiskBadSettings(patch = {}) {
  const next = normalizeSettings({ ...loadDiskBadSettings(), ...(patch && typeof patch === 'object' ? patch : {}) });
  atomicWriteFileSync(FILE(), JSON.stringify(next, null, 2));
  _mem = next; _loadError = null;
  return next;
}

export function _resetDiskBadSettingsForTest() { _mem = null; _loadError = null; }

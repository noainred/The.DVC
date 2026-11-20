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
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt, safeLoadText } from '../util/atomicWrite.js';
import { makeJsonFileReader } from '../util/jsonFileRead.js';   // 107회차: 읽기 오류 ≠ 손상(공용 읽기 — 30초 간격 재읽기)

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

/*
 * 107회차(재현 — EISDIR): 읽기 오류(EACCES · EIO · EISDIR)는 손상이 아니다 — 예전 catch 하나는 온전한 원본을 .corrupt 로 옮기고 빈 값 · 기본값을 캐시해
 *   다음 저장이 원본 자리를 덮었다. 읽기 단계는 공용 읽기: 원본을 두고 · 캐시하지 않고(30초 간격 재읽기) · 저장을 거절한다(503 settingsUnreadable). parse 실패는 예전과 같다.
 */
const _reader = makeJsonFileReader(() => FILE(), { parse: (t) => t, preserve: false, tag: 'disk-bad-settings' });
let _readErr = '';
/** 107회차: 읽기 오류 중의 저장 거절 본문(503) 또는 null. */
export function diskBadWriteRefusal() {
  loadDiskBadSettings();
  return _readErr ? { ok: false, status: 503, code: 'settingsUnreadable', readError: true, reason: `디스크 배드 섹터 점검 설정 파일(${path.basename(FILE())})을 읽지 못해 저장하지 않았습니다 — 읽기 오류(${_readErr})이고 원본은 그대로 있습니다. 파일 권한 · 소유자 · 디스크를 확인하세요(30초마다 다시 읽고, 읽히면 저장이 다시 열립니다).` } : null;
}
export function loadDiskBadSettings() {
  if (_mem) return _mem;
  const rr = _reader.read();
  if (rr.kind === 'read-error') {   // 107회차: 기본값(자동 점검 꺼짐)으로 돌되 캐시하지 않는다 — 상태에 싣고(무음 금지) 쓰기는 거절한다
    _readErr = String(rr.error?.code || 'read-error').slice(0, 32);
    _loadError = { at: _loadError?.readError ? _loadError.at : Date.now(), reason: `읽기 오류(${_readErr}) — 원본은 그대로 두었습니다(30초마다 다시 읽습니다)`, readError: true };
    return { ...DEFAULTS, corpTo: {} };
  }
  _readErr = '';
  try {
    if (rr.kind === 'missing') { _mem = { ...DEFAULTS, corpTo: {} }; _loadError = null; return _mem; }
    _mem = normalizeSettings(JSON.parse(rr.value));
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
  { const no = diskBadWriteRefusal(); if (no) throw Object.assign(new Error(no.reason), no, { extra: { code: no.code, readError: true } }); }   // 107회차: 읽기 오류 중에는 빈 값 · 기본값 위에 쓰지 않는다
  const next = normalizeSettings({ ...loadDiskBadSettings(), ...(patch && typeof patch === 'object' ? patch : {}) });
  atomicWriteFileSync(FILE(), JSON.stringify(next, null, 2));
  _mem = next; _loadError = null;
  return next;
}

export function _resetDiskBadSettingsForTest() { _mem = null; _loadError = null; _reader.reset(); _readErr = ''; }

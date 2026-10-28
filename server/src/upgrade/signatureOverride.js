/**
 * upgrade/signatureOverride.js — 업그레이드 서명 확인을 **시한부로** 끄는 화면 설정(v2.810, 사용자 요청 '서명 검증 활성화/비활성화').
 *
 * 사용자 결정(2026-10-28):
 *  · 끄기 = '확인 불가만 허용'(env UPGRADE_SIGNATURE_POLICY=warn 과 같다) — manifest 없음·받지 못함·모르는 키는 경고 후 진행,
 *    **틀린 서명·회수된 키·버전/해시 불일치는 그대로 거부**(decideSignature 의 CANNOT_VERIFY 만 통과).
 *  · 설정 소유자 + 본인 OTP 재인증 + 감사(로그인 정책 약화와 같은 보호 — routes/upgrade.js) · 다시 켜기는 OTP 없이.
 *  · 시한 후 자동 복구 — 기본 24시간 · [1시간, 7일]. 시한은 판정 때마다 본다(타이머 없음 — 재시작·시계와 무관하게 지나면 꺼진다).
 *
 * 우선순위·적용 범위(signature.js signaturePolicy 가 이 모듈의 activeOverride 하나만 본다):
 *  · env UPGRADE_SIGNATURE_POLICY 가 있으면 env 가 이긴다(화면은 잠긴다).
 *  · **root 로 도는 확인(install.sh · vmware-portal-verify)은 이 파일을 보지 않는다** — CONFIG_DIR 은 서비스 계정이 쓸 수 있어,
 *    이 파일로 root 확인을 약하게 만들 수 있으면 서비스 계정 탈취가 root 설치 경로로 번진다(v2.742 INJPKG-01 과 같은 이유).
 *  · 신뢰 키를 읽지 못하면(trust.fatal) 적용하지 않는다(fail-closed — 회수 목록을 모르는 채로 약하게 만들지 않는다).
 *  · 파일이 손상되면 보존(preserveCorrupt) 후 '켜짐' 이다. 모르는 mode·시한 이상값도 '켜짐'.
 *  · 상태 파일로 등록한다(registerStateFile) — 엣지 설정 push·설정 백업 복원으로 **다른 포탈에 퍼지거나 되살아나지 않게**.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { registerStateFile } from '../util/stateFiles.js';

export const OVERRIDE_NAME = 'upgrade-signature-override.json';
registerStateFile(OVERRIDE_NAME);
export const overrideFile = (configDir = config.configDir) => path.join(configDir, OVERRIDE_NAME);

const HOUR = 3_600_000;
export const OVERRIDE_DEFAULT_HOURS = 24;
export const OVERRIDE_MIN_HOURS = 1;
export const OVERRIDE_MAX_HOURS = 168;   // 7일
const USER_MAX = 64;

/** 시한(시간) — 정수 [1, 168] · 숫자가 아니면 null(거부). */
export function clampHours(v) {
  if (v == null || v === '') return OVERRIDE_DEFAULT_HOURS;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  if (!Number.isFinite(n)) return null;
  return Math.min(OVERRIDE_MAX_HOURS, Math.max(OVERRIDE_MIN_HOURS, Math.round(n)));
}

let _cache = { file: null, at: 0, val: null };
const CACHE_MS = 3000;   // 판정 핫패스(번들마다 한 번) — 저장·해제 때 즉시 무효화

/** 파일 → { mode:'warn', at, until, by } 또는 null(없음·손상·형식 밖). 시한은 보지 않는다(activeOverride 가 본다). */
function readOverride(file) {
  let txt;
  try { txt = fs.readFileSync(file, 'utf8'); } catch { return null; }   // 없음·읽기 실패 = 켜짐
  let d;
  try { d = JSON.parse(txt); } catch (e) { preserveCorrupt(file, e?.message); return null; }
  const ok = d && typeof d === 'object' && d.mode === 'warn' && Number.isSafeInteger(d.until) && Number.isSafeInteger(d.at)
    && d.until > d.at && d.until - d.at <= OVERRIDE_MAX_HOURS * HOUR;
  if (!ok) { preserveCorrupt(file, 'unexpected shape'); return null; }
  return { mode: 'warn', at: d.at, until: d.until, by: typeof d.by === 'string' ? d.by.slice(0, USER_MAX) : '' };
}

/** 저장된 기록(시한이 지났어도 돌려준다 — 화면이 '시한 지나 다시 켜짐' 을 말한다). */
export function loadOverride({ configDir = config.configDir, now = Date.now() } = {}) {
  const file = overrideFile(configDir);
  if (_cache.file === file && now - _cache.at < CACHE_MS && now >= _cache.at) return _cache.val;
  const val = readOverride(file);
  _cache = { file, at: now, val };
  return val;
}

/** 지금 유효한 끄기 — 시한 안일 때만. */
export function activeOverride(opts = {}) {
  const now = opts.now ?? Date.now();
  const o = loadOverride({ ...opts, now });
  return o && now < o.until ? o : null;
}

/** 끈다(시한부). 호출자(라우트)가 소유자·OTP·env 잠금·신뢰 키 상태를 먼저 확인한다. */
export function setOverride({ hours, by, now = Date.now(), configDir = config.configDir } = {}) {
  const h = clampHours(hours);
  if (h == null) throw Object.assign(new Error('시한(시간)이 숫자가 아닙니다'), { status: 400 });
  const doc = { mode: 'warn', at: now, until: now + h * HOUR, by: String(by || '').slice(0, USER_MAX) };
  atomicWriteFileSync(overrideFile(configDir), `${JSON.stringify(doc, null, 2)}\n`);
  _cache = { file: null, at: 0, val: null };
  return { ...doc, hours: h };
}

/** 다시 켠다(파일을 지운다). 지울 게 없으면 false. */
export function clearOverride({ configDir = config.configDir } = {}) {
  _cache = { file: null, at: 0, val: null };
  try { fs.unlinkSync(overrideFile(configDir)); return true; } catch (e) { if (e?.code === 'ENOENT') return false; throw e; }
}

export function _resetOverrideCacheForTest() { _cache = { file: null, at: 0, val: null }; }

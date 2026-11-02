/**
 * bareos/install/bundleSource.js — Bareos 완전 설치 번들의 **받는 주소 · 서버 디렉터리** 설정(v2.850 · 사용자 요청
 *   '번들을 받는 별도의 url 을 지정하는 기능, 서버의 특정 디렉터리에 받아두면 적용하는 기능').
 *
 *  - baseUrl: 번들 주소(그 아래 bareos-bundle.json · <판>.json · <판>.manifest.json · <판>.tar.gz). 비우면 env BAREOS_BUNDLE_BASE_URL →
 *    업그레이드 패키지 주소에서 유도(bundle.js bundleBaseUrl). http/https 만 · 계정 정보(user:pass@) 금지 · 링크로컬 · 루프백 등 차단 대역 거부(ssrfBlockReason —
 *    사내 RFC1918 미러는 허용) · 500자.
 *  - importDir: 포탈 서버의 디렉터리 — 거기 받아 둔 번들(파일 3개)을 **같은 서명 · 해시 검증**을 지나면 설치에 쓴다(복사하지 않는다 — 읽기만).
 *    절대 경로 · '..' 없음 · 루트(/) 아님 · 300자. 그 디렉터리에서는 번들 이름 모양의 파일만 읽는다(다른 파일의 이름 · 내용을 응답에 싣지 않는다).
 * 비밀 없음(토큰을 받지 않는다 — 인증이 필요한 미러는 지원하지 않는다). 저장은 원자적 · 손상이면 보존하고 기본값.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../../util/atomicWrite.js';
import { ssrfBlockReason } from '../../util/ssrfBlock.js';

const FILE = () => path.join(config.configDir, 'bareos-bundle-source.json');   // ⚠ 리터럴 형태 유지 — scripts/config-doc.mjs 가 이 모양으로 찾는다

const bad = (msg) => Object.assign(new Error(msg), { code: 'invalid' });
let _cache = null;
let _loadErr = '';

function load() {
  if (_cache) return _cache;
  _cache = { baseUrl: '', importDir: '' };
  _loadErr = '';
  try {
    if (fs.existsSync(FILE())) {
      const raw = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('형식 오류');
      // 읽을 때도 같은 판정(손으로 고친 파일이 규칙을 우회하지 않게) — 맞지 않는 칸은 비운다
      try { _cache.baseUrl = normBundleUrl(raw.baseUrl); } catch { _cache.baseUrl = ''; }
      try { _cache.importDir = normImportDir(raw.importDir); } catch { _cache.importDir = ''; }
    }
  } catch (e) {
    preserveCorrupt(FILE(), e?.message);
    _loadErr = '번들 설정 파일을 읽지 못해 기본값으로 둡니다(손상본 보존).';
  }
  return _cache;
}

/** 번들 주소 판정(빈 값 = 기본). @returns {string} 끝 / 없는 주소 */
export function normBundleUrl(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (s.length > 500 || /[\s\0]/.test(s)) throw bad('번들 주소가 너무 길거나 공백이 있습니다.');
  let u;
  try { u = new URL(s); } catch { throw bad('번들 주소 형식이 올바르지 않습니다(http:// 또는 https:// 로 시작).'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw bad('번들 주소는 http/https 만 씁니다.');
  if (u.username || u.password) throw bad('번들 주소에 계정 정보(user:pass@)를 넣지 마세요 — 포탈은 미러 인증을 저장하지 않습니다.');
  if (u.search || u.hash) throw bad('번들 주소에 ? · # 를 넣지 마세요(그 아래 파일 이름을 붙여 받습니다).');
  const why = ssrfBlockReason(s);
  if (why) throw bad(`이 주소로는 받지 않습니다 — ${why}`);
  return s.replace(/\/+$/, '');
}

/** 서버 디렉터리 판정(빈 값 = 쓰지 않음). */
export function normImportDir(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (s.length > 300 || /[\0\r\n]/.test(s)) throw bad('디렉터리 경로가 너무 길거나 쓸 수 없는 글자가 있습니다.');
  if (!path.isAbsolute(s)) throw bad('디렉터리는 절대 경로로 적으세요(예: /data/bareos-bundle).');
  if (s.split(/[\\/]+/).includes('..')) throw bad('디렉터리 경로에 .. 를 쓸 수 없습니다.');
  const n = path.normalize(s).replace(/\/+$/, '');
  if (!n || n === '/') throw bad('루트(/) 는 쓸 수 없습니다 — 번들만 두는 디렉터리를 정하세요.');
  return n;
}

/** 지금 값(저장값 · 판정 통과분). */
export function getBundleSource() { const c = load(); return { baseUrl: c.baseUrl, importDir: c.importDir, loadError: _loadErr }; }

/**
 * 저장 — 보낸 칸만 바꾼다(undefined = 그대로). 판정이 틀리면 아무것도 바꾸지 않고 던진다(code invalid).
 * @returns {{ baseUrl, importDir }}
 */
export function saveBundleSource(body = {}) {
  const cur = load();
  const next = { baseUrl: cur.baseUrl, importDir: cur.importDir };
  if (body.baseUrl !== undefined) next.baseUrl = normBundleUrl(body.baseUrl);
  if (body.importDir !== undefined) next.importDir = normImportDir(body.importDir);
  atomicWriteFileSync(FILE(), JSON.stringify(next, null, 2), { mode: 0o600 });
  _cache = next; _loadErr = '';
  return { ...next };
}

export function _resetBundleSourceForTest() { _cache = null; _loadErr = ''; }

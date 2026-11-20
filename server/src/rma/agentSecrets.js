/**
 * 중앙 측 RMA 에이전트 비밀번호 저장소 — `rma-agents.json` { version, agents: { name: { password, updatedAt } } }.
 * 자격증명 파일 규약(server/CLAUDE.md): atomicWriteFileSync + 로드 손상 preserveCorrupt + secretVault 봉인
 * (`SECRET_FILES` 에 등록). 목록 응답은 비밀번호를 절대 싣지 않는다(hasPassword 만).
 */
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';
import { makeJsonFileReader } from '../util/jsonFileRead.js';   // 97회차 F2: 읽기 오류 ≠ 손상
import { openSecretsDeep, sealSecretsDeep } from '../security/secretVault.js';

const FILE = path.join(config.configDir, 'rma-agents.json');
let _db = null;

/*
 * 97회차 F2(재현 — EISDIR): 예전 catch 하나는 **읽기 오류**(EACCES · EIO · EISDIR)도 손상으로 보고 온전한 원본(법인 비밀번호 — 봉인본)을 `.corrupt.*` 로
 *   옮긴 뒤 빈 목록을 캐시했다 — 잡 서명이 표지 없이 빠지고(rmaPasswordFor = ''), 다음 비밀번호 설정 한 번이 그 법인 하나만 든 파일을 썼다.
 *   판정은 공용 읽기 하나(util/jsonFileRead.js): 읽기 오류는 원본을 두고 · 캐시하지 않고(30초 간격 재읽기) · 설정을 거절한다(409). 손상(parse · 복호 실패)은 예전과 같다.
 */
const _reader = makeJsonFileReader(() => FILE, {
  parse: (text) => { const p = openSecretsDeep(JSON.parse(text)); return { agents: p && p.agents && typeof p.agents === 'object' ? p.agents : {} }; },
  tag: 'rma-agents',
});
let _readErr = null;
function load() {
  if (_db) return _db;
  const r = _reader.read();
  if (r.kind === 'read-error') { if (!_readErr) _readErr = String(r.error?.code || 'read-error').slice(0, 32); return { agents: {} }; }   // 캐시하지 않는다
  _readErr = null;
  _db = r.kind === 'ok' ? r.value : { agents: {} };   // missing · corrupt(보존본으로 옮김 — 예전과 같다)
  return _db;
}
/** 97회차 F2: 비밀번호 파일 읽기 오류(원본은 그대로)면 그 코드, 아니면 null. */
export function rmaSecretsReadError() { load(); return _readErr; }

/** 97회차 F2: 읽기 오류 중이면 던진다(status 409) — 원본(전 법인 비밀번호)을 덮지 않게. */
function assertWritable() {
  if (rmaSecretsReadError()) throw Object.assign(new Error(`RMA 비밀번호 파일(rma-agents.json)을 읽지 못한 상태라 저장하지 않았습니다 — 읽기 오류(${_readErr})이고 원본은 그대로 있습니다. 파일 권한 · 소유자 · 디스크를 확인하세요(30초마다 다시 읽습니다).`), { status: 409, code: 'settings-unreadable' });
}

function persist() {
  assertWritable();   // 97회차 F2: 마지막 방어선
  atomicWriteFileSync(FILE, JSON.stringify(sealSecretsDeep({ version: 1, agents: load().agents }), null, 2), { mode: 0o600 });
}

const key = (a) => String(a || '').trim().toLowerCase();

export function rmaPasswordFor(agent) { return String(load().agents[key(agent)]?.password || ''); }
export function hasRmaPassword(agent) { return !!rmaPasswordFor(agent); }

/** 비밀번호 설정/해제(빈 문자열 = 해제). 제어문자 거부(오류 메시지 유출 경로 차단). */
export function setRmaPassword(agent, password) {
  const k = key(agent);
  if (!k) throw new Error('agent 가 필요합니다.');
  const pw = String(password ?? '');
  if (/[\x00-\x1f\x7f]/.test(pw)) throw new Error('비밀번호에 제어문자가 포함되어 있습니다.'); // eslint-disable-line no-control-regex
  if (pw.length > 256) throw new Error('비밀번호가 너무 깁니다(최대 256자).');
  assertWritable();   // 97회차 F2: 읽기 오류면 던진다(409) — 빈 목록에 한 건을 넣어 쓰지 않게
  const db = load();
  if (!pw) delete db.agents[k];
  else db.agents[k] = { password: pw, updatedAt: Date.now() };
  persist();
  return { agent: k, hasPassword: !!pw };
}

export function listRmaPasswordMeta() {
  return Object.entries(load().agents).map(([agent, v]) => ({ agent, hasPassword: !!v?.password, updatedAt: v?.updatedAt || null }));
}

/** 테스트용: 파일 캐시 초기화. */
export function _resetRmaSecrets() { _db = null; _readErr = null; _reader.reset(); }

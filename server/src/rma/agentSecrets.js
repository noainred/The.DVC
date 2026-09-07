/**
 * 중앙 측 RMA 에이전트 비밀번호 저장소 — `rma-agents.json` { version, agents: { name: { password, updatedAt } } }.
 * 자격증명 파일 규약(server/CLAUDE.md): atomicWriteFileSync + 로드 손상 preserveCorrupt + secretVault 봉인
 * (`SECRET_FILES` 에 등록). 목록 응답은 비밀번호를 절대 싣지 않는다(hasPassword 만).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { openSecretsDeep, sealSecretsDeep } from '../security/secretVault.js';

const FILE = path.join(config.configDir, 'rma-agents.json');
let _db = null;

function load() {
  if (_db) return _db;
  try {
    if (fs.existsSync(FILE)) {
      const p = openSecretsDeep(JSON.parse(fs.readFileSync(FILE, 'utf8')));
      _db = { agents: p.agents && typeof p.agents === 'object' ? p.agents : {} };
      return _db;
    }
  } catch { preserveCorrupt(FILE); }
  _db = { agents: {} };
  return _db;
}

function persist() {
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
export function _resetRmaSecrets() { _db = null; }

/**
 * 엣지 포탈(에이전트) 설정 저장소 — 에이전트가 push한 자기 CONFIG_DIR 설정을 보관한다.
 * 중앙의 통합 백업이 이 값을 합쳐 저장한다. 디스크에도 지속(재시작 후 마지막 설정 유지).
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { preserveCorrupt } from '../util/atomicWrite.js';
import { redactEnvSecrets } from '../util/envRedact.js'; // v2.538
// v2.582 ARCH-4 종료 flush 는 writer 가 등록한다. v2.599(CEN-2599-04): 엣지 수 상한 + 비동기 쓰기(storageEdge 와 같은 코어).
import { admitAgent, createDebouncedWriter } from './edgeRecord.js';

const FILE = path.join(config.configDir, 'central-agent-config.json');

// null-proto: 에이전트 이름을 키로 쓰므로 '__proto__' 등에 의한 프로토타입 오염 방지.
let byAgent = Object.create(null); // agent -> { at, files:{ name: content } }
// ⚠ v2.500(감사 M3): 이 파일은 각 엣지가 push 한 CONFIG_DIR 사본이다(portal.env 의 AUTH_SECRET·
// CENTRAL_TOKEN, users.json TOTP, vcenters.json 비밀번호). 손상 시 조용히 {} 로 넘어가면 3초 뒤
// persistSoon 이 **온전했던 원본을 빈 객체로 덮어쓴다** — 전 법인 설정 사본이 영구 유실된다.
// 다른 비밀 스토어와 같은 규약(preserveCorrupt)으로 원본을 보존한다.
try { if (fs.existsSync(FILE)) byAgent = Object.assign(Object.create(null), JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}); } catch (e) { preserveCorrupt(FILE, e.message); byAgent = Object.create(null); }

// 예전에는 타이머 안에서 전체를 동기로 썼다(엣지 사본이 수십 MB 면 그만큼 이벤트 루프가 멈춘다).
const writer = createDebouncedWriter(FILE, () => JSON.stringify(byAgent), { delayMs: 3_000, name: 'agentConfig' });
function persistSoon() { writer.save(); }
/** 엣지 하나의 설정 사본 합계 상한(파일 200개 × 8MB 가 라우트 상한이라 엣지당 1.6GB 까지 쌓일 수 있었다). */
export const AGENT_CONFIG_MAX_BYTES = Math.max(1024 * 1024, Number(process.env.CENTRAL_AGENT_CONFIG_MAX_BYTES) || 32 * 1024 * 1024);

/** 에이전트가 자기 설정을 push. files: { name: content(utf8) }. */
/**
 * @returns {{ ok: boolean, stored?: number, omitted?: number, refused?: boolean, evicted?: string }}
 *   ⚠ v2.599(CEN-2599-04): 엣지 수·엣지당 합계 크기에 상한을 두고 **뺀 개수를 돌려준다**(조용한 상한 금지).
 */
export function setAgentConfig(agent, files, { retain = [] } = {}) {
  if (!agent || !files || typeof files !== 'object') return { ok: false };
  // 엣지 수 상한 — 모두 최근이면 새 이름을 거절한다(공유 토큰 발신자가 이름을 바꿔 가며 실제 엣지 사본을 밀어내지 못하게).
  const map = new Map(Object.entries(byAgent));
  const adm = admitAgent(map, agent);
  if (!adm.ok) { console.warn(`[central] agent-config: 엣지 수 상한 — 새 이름 '${String(agent).slice(0, 64)}' 거절`); return { ok: false, refused: true }; }
  if (adm.evicted) { delete byAgent[adm.evicted]; console.warn(`[central] agent-config: 엣지 수 상한 — 오래 조용한 '${adm.evicted}' 사본을 내렸다`); }
  // v2.538: 엣지가 보낸 .env 의 키·토큰은 중앙에 저장하지 않는다 — 새 엣지는 push 전에 가리지만
  // 구버전 엣지는 그대로 보내므로 수신 쪽에서도 가린다(둘 중 하나만 있으면 업그레이드 순서에 구멍이 생긴다).
  const cleaned = {};
  let total = 0; let omitted = 0;
  for (const [k, v] of Object.entries(files)) {
    const val = (typeof v === 'string' && /\.env$/i.test(String(k))) ? redactEnvSecrets(v).text : v;
    const size = typeof val === 'string' ? val.length : (() => { try { return JSON.stringify(val).length; } catch { return Infinity; } })();
    if (total + size > AGENT_CONFIG_MAX_BYTES) { omitted += 1; continue; }
    total += size;
    cleaned[k] = val;
  }
  /*
   * v2.621(감사 RECENT-09): 엣지가 413 으로 **보내지 못한** 파일(retain)은 직전 사본을 유지한다. 이 사본은 통째로 교체되므로
   *   (빈 push 는 사본을 비운다 — 엣지에서 지운 파일을 따라가기 위해) 예전에는 413 재전송의 부분 목록이 직전까지 보관하던 큰 설정
   *   (보통 등록부)을 중앙 통합 백업에서 조용히 지웠다. 유지한 파일은 `retained`(이름·그 내용을 받은 시각)로 **낡음을 밝힌다** —
   *   다음 전체 push 가 오면 사라진다. 직전 사본에도 없는 이름은 유지할 것이 없다(retainMissing 으로 센다).
   */
  const prev = byAgent[agent];
  const retained = [];
  let retainMissing = 0;
  for (const name of Array.isArray(retain) ? retain : []) {
    if (typeof name !== 'string' || !name || Object.hasOwn(cleaned, name)) continue;
    if (!prev?.files || !Object.hasOwn(prev.files, name)) { retainMissing += 1; continue; }
    const val = prev.files[name];
    const size = typeof val === 'string' ? val.length : (() => { try { return JSON.stringify(val).length; } catch { return Infinity; } })();
    if (total + size > AGENT_CONFIG_MAX_BYTES) { omitted += 1; continue; }
    total += size;
    cleaned[name] = val;
    const since = (Array.isArray(prev.retained) ? prev.retained.find((r) => r?.name === name)?.since : null) ?? prev.at ?? null;
    retained.push({ name, since });
  }
  if (omitted) console.warn(`[central] agent-config: '${String(agent).slice(0, 64)}' 사본 합계 상한 — 파일 ${omitted}개를 저장하지 않았다`);
  if (retained.length) console.warn(`[central] agent-config: '${String(agent).slice(0, 64)}' 이 본문 한도(413)로 보내지 못한 설정 ${retained.length}개는 직전 사본을 유지합니다(낡은 값): ${retained.map((r) => r.name).join(', ').slice(0, 300)}`);
  byAgent[agent] = { at: Date.now(), files: cleaned, ...(omitted ? { omitted } : {}), ...(retained.length ? { retained } : {}) };
  persistSoon();
  return { ok: true, stored: Object.keys(cleaned).length, omitted, retained: retained.length, retainMissing, ...(adm.evicted ? { evicted: adm.evicted } : {}) };
}

export function getAllAgentConfigs() { return byAgent; }

export function listAgentConfigs() {
  // v2.621(감사 RECENT-09): 직전 사본을 유지한(낡은) 파일 수를 함께 싣는다 — '최근 push' 시각이 그 파일의 시각이 아니다.
  return Object.entries(byAgent).map(([agent, e]) => ({ agent, at: e.at, files: Object.keys(e.files || {}).length, ...(Array.isArray(e.retained) && e.retained.length ? { retained: e.retained.length } : {}) }))
    .sort((a, b) => (b.at || 0) - (a.at || 0));
}

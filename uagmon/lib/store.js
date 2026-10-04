/**
 * 설정/대상 저장소 + 인메모리 시계열.
 *
 * - 설정 파일(uag-config.json)은 UAG 관리 자격증명을 담으므로 0600 + 원자적 쓰기
 *   (tmp+rename). 로드 시 파싱 실패면 손상본을 <file>.corrupt.<ts> 로 보존한 뒤
 *   빈 값으로 시작한다 — 다음 저장이 온전했던 원본을 덮어써 영구 유실되는 것 방지
 *   (포탈 보안 불변조건과 동일한 규칙).
 * - 세션 수 시계열은 인메모리 링버퍼(기본 2,880점). 재시작하면 사라진다(README 명시).
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_POINTS = 2880; // 30초 폴링 기준 24시간

export function normalizeTarget(body = {}, existing = {}) {
  const host = String(body.host ?? existing.host ?? '').trim();
  const name = String(body.name ?? existing.name ?? '').trim() || host;
  const port = Math.min(65535, Math.max(1, Number(body.port ?? existing.port) || 9443));
  const username = String(body.username ?? existing.username ?? '').trim();
  // 비밀번호는 빈 값이면 기존 유지(수정 폼에서 미입력 = 변경 안 함). 단, **host 가 바뀌면 기존
  // 비밀번호를 이월하지 않는다**(M3): host 만 공격자 서버로 바꿔치기하고 비번을 비워 저장하면
  // 그 저장 비번이 새 host 로 선제 전송돼 유출된다 → host 변경 시엔 비번 재입력을 강제한다.
  const hostChanged = existing.host != null && host !== String(existing.host).trim();
  const password = body.password ? String(body.password) : (hostChanged ? '' : (existing.password || ''));
  const insecureTls = body.insecureTls != null ? Boolean(body.insecureTls) : Boolean(existing.insecureTls);
  return { id: existing.id || crypto.randomBytes(6).toString('hex'), name, host, port, username, password, insecureTls };
}

export class Store {
  constructor(dataDir) {
    this.dir = dataDir;
    this.file = path.join(dataDir, 'uag-config.json');
    this.targets = [];
    this.settings = { pollSeconds: 30, passwordHash: '' };
    this.latest = new Map();   // id -> 정규화된 마지막 통계(또는 {ok:false,error})
    this.history = new Map();  // id -> [{ts, sessions, ok}]
    this.#load();
  }

  #load() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(this.file)) return;
    try {
      const doc = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(doc.targets)) this.targets = doc.targets.map((t) => normalizeTarget(t, t));
      if (doc.settings && typeof doc.settings === 'object') this.settings = { ...this.settings, ...doc.settings };
    } catch {
      // 손상 보존 — 조용히 빈 값으로 넘기면 다음 save() 가 원본을 덮어쓴다.
      try { fs.copyFileSync(this.file, `${this.file}.corrupt.${Date.now()}`); } catch { /* best effort */ }
    }
  }

  save() {
    const doc = { v: 1, targets: this.targets, settings: this.settings };
    const tmp = `${this.file}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  /** 목록을 바꾸고 저장한다 — 저장이 실패하면(디스크 가득·권한) 메모리도 되돌리고 던진다.
   *  되돌리지 않으면 화면은 '실패' 인데 메모리에는 남아 폴링되고, 재시작하면 사라진다(v2.689). */
  #commit(next) {
    const prev = this.targets;
    this.targets = next;
    try { this.save(); } catch (err) { this.targets = prev; throw err; }
  }

  addTarget(body) {
    const t = normalizeTarget(body);
    this.#commit([...this.targets, t]);
    return t;
  }

  updateTarget(id, body) {
    const i = this.targets.findIndex((t) => t.id === id);
    if (i === -1) return null;
    const next = this.targets.slice();
    next[i] = normalizeTarget(body, this.targets[i]);
    this.#commit(next);
    return next[i];
  }

  removeTarget(id) {
    const next = this.targets.filter((t) => t.id !== id);
    if (next.length === this.targets.length) return false;
    this.#commit(next);
    this.latest.delete(id);
    this.history.delete(id);
    return true;
  }

  pushSample(id, stats) {
    this.latest.set(id, stats);
    let ring = this.history.get(id);
    if (!ring) { ring = []; this.history.set(id, ring); }
    ring.push({ ts: Date.now(), sessions: stats.ok ? (stats.totalSessions ?? null) : null, ok: !!stats.ok });
    if (ring.length > MAX_POINTS) ring.splice(0, ring.length - MAX_POINTS);
  }

  /** API 응답용 — 자격증명 제거. */
  redact(t) {
    const { password, ...rest } = t;
    return { ...rest, hasPassword: Boolean(password) };
  }
}

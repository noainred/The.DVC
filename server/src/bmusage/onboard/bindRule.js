/**
 * bmusage/onboard/bindRule.js — '저장 비밀(공통 계정 · SSH 키)을 주소에 묶는가' 판정 코어 **하나**(순수 · 의존 없음 · 7b r3 — 재검증 R-N1).
 *
 * 메인 결정: 묶음 = 설정 소유자 등급 + 본인 OTP. 이 판정을 네 곳이 같이 쓴다(두 벌 금지 — R-N1 은 온보딩 분석에만
 * 'os_cred 빈칸 + os_key=password → 기존 credRef 를 새 주소로 승계' 가 빠져 생겼다):
 *  ① 온보딩 분석(importAnalyze — 계정 · 키를 찾기 **전** 은 이름 토큰, 찾은 뒤는 적용 본문 그대로 bindOfWrite)
 *  ② 엣지 배포 행(중앙 판정 — 이름 토큰) ③ `/tools/bm-storage/servers` bmBindCheck(bindOfWrite)
 *  ④ 등록부 choke point(`bmstor/registry.js applyServerInput` — bindOfWrite): 묶음인데 `bindApproved === true` 가 없으면 묶지 않는다
 *     (주소가 바뀌면 참조를 버리고, 같은 주소면 기존 참조 · 인증 방식을 그대로 둔다). bindApproved 는 게이트를 통과한 호출만 세운다(소스 스윕 테스트).
 *
 * 토큰: addr = 접속처(host · port · 계정 — secretCarry.accessMoved 와 같은 세 칸 · 같은 정규화) · cred · key = 참조 토큰(빈 문자열 = 없음) · osAuth.
 * next 의 칸이 undefined 면 '이 쓰기가 그 칸을 주지 않음'. 효력 값: 칸을 주면 그 값, 안 주면 — 주소가 그대로면 기존 값, **주소가 바뀌면 ''**.
 * 묶음: 효력 참조가 있고 (새 항목 · 주소 이동 · 기존과 다른 참조) 이거나, 같은 주소에서 공통 계정의 인증 방식(osAuth)을 바꿀 때.
 */
const norm = (v) => String(v ?? '').trim().toLowerCase();

/** 접속처 토큰 — 등록부 저장 규칙 그대로(빈 port = 22 · 빈 계정 = root · 대소문자 · 앞뒤 공백 무시 = accessMoved 와 같은 비교). */
export function addrKey(host, port, username) {
  return `${norm(host)}:${Number(port) || 22}|${norm(username) || 'root'}`;
}

/**
 * @param {{addr:string, cred?:string, key?:string, osAuth?:string}|null} existing  기존 항목(없으면 null — 새 항목)
 * @param {{addr:string, cred?:string, key?:string, osAuth?:string}} next  이 쓰기
 * @returns {{binds:boolean, moved:boolean, cred:string, key:string}}  cred · key = 쓰기 뒤 효력 참조
 */
export function bindDecision(existing, next = {}) {
  const ex = existing || null;
  const moved = !ex || String(ex.addr) !== String(next.addr);
  const eff = (f) => (next[f] !== undefined ? String(next[f] || '') : (moved ? '' : String(ex?.[f] || '')));
  const cred = eff('cred'); const key = eff('key');
  const changed = (f, v) => !!v && (moved || v !== String(ex?.[f] || ''));
  let binds = changed('cred', cred) || changed('key', key);
  if (!binds && cred && !moved && next.osAuth !== undefined && String(next.osAuth || '') !== String(ex?.osAuth || '')) binds = true;
  return { binds, moved, cred, key };
}

/** 등록부 항목(bm-storage 서버 — 원본이든 가린 목록이든) → id 토큰. */
export function entryTokens(s) {
  if (!s) return null;
  return { addr: addrKey(s.host, s.port, s.username), cred: String(s.credRef || ''), key: String(s.keyRef || ''), osAuth: s.osAuth === 'password' ? 'password' : '' };
}

/** 쓰기 본문(saveBmServer · applyBmServerBatch 입력) → id 토큰. 기본값은 applyServerInput 과 같다(port 빈 값 = 22 · username 없음 = root). */
export function writeTokens(body = {}) {
  const ref = (v) => (v === undefined ? undefined : String(v || '').trim());
  return {
    addr: addrKey(body.host, body.port === undefined || body.port === '' ? 22 : body.port, String(body.username ?? 'root').trim() || 'root'),
    cred: ref(body.credRef), key: ref(body.keyRef),
    osAuth: body.osAuth === undefined ? undefined : (body.osAuth === 'password' ? 'password' : ''),
  };
}

/** 등록부 쓰기 한 건의 묶음 판정(choke point · bm-storage 라우트 · 온보딩 분석 사후 점검이 같은 입력으로 부른다). */
export function bindOfWrite(existing, body = {}) { return bindDecision(entryTokens(existing), writeTokens(body)); }

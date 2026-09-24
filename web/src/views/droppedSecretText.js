/**
 * 저장 비밀 폐기 안내(v2.607, 감사 WEB2607-03 · LEFT2607-07).
 *
 * 서버는 접속처(host·계정·대역·엣지 등)가 바뀐 수정에서 저장된 비밀번호를 **승계하지 않고 버린다**(v2.503 S-2 ·
 * util/secretCarry.js). 그 사실을 응답에 싣는다 —
 *  · 단건 저장: `droppedSecrets: ['password', ...]`(vCenter·NSX·iDRAC·Horizon·GPU 물리·배포 대상·iDRAC 스캔 대역·
 *    스토리지·SAN·PDU)
 *  · CSV 가져오기: `passwordDropped: [{ line, datacenter, reason }]`(iDRAC 스캔 대역)
 *  · 중계 토폴로지: `secretsDropped: ['<DC> Edge', ...]`
 * 예전에는 화면이 이것을 하나도 읽지 않아 모달을 닫고 '저장됨' 만 말했고, 다음 주기가 빈 비밀번호로 로그인해 실패했다
 * (v2.590 authGuard 가 주기 수집을 멈춘다). 폐기 조건은 주소·포트·계정 변경이다(수집 엣지(agent)만 바꾸면 승계된다). 폐기가 있으면 **모달을 닫지 말고** 이 문장을 보여 줄 것.
 */

const KEY_LABEL = {
  password: '비밀번호', secret: '비밀번호', privateKey: '개인 키', passphrase: '키 암호',
  token: '토큰', centralToken: '중앙 토큰', collectorToken: '수집 토큰', apiKey: 'API 키', community: 'SNMP 커뮤니티',
};

function keyLabel(k) {
  return KEY_LABEL[k] || String(k);
}

/** 단건 저장 응답 → 폐기된 비밀 키 목록(문자열만). */
export function droppedSecretKeys(r) {
  if (!r || typeof r !== 'object') return [];
  // 위치가 두 가지다 — 최상위(vCenter·NSX·iDRAC·PDU·bmstor 등)와 장비 객체 안(스토리지·SAN 스위치: r.device.droppedSecrets).
  const top = Array.isArray(r.droppedSecrets) ? r.droppedSecrets : [];
  const dev = r.device && typeof r.device === 'object' && Array.isArray(r.device.droppedSecrets) ? r.device.droppedSecrets : [];
  return [...new Set([...top, ...dev].filter((x) => typeof x === 'string' && x))];
}

/** 단건 저장 응답 → 안내 문장('' 이면 폐기 없음). */
export function droppedSecretNote(r) {
  const keys = droppedSecretKeys(r);
  if (!keys.length) return '';
  const names = [...new Set(keys.map(keyLabel))].join('·');
  return `저장했습니다 — 단 접속처(주소·포트·계정)가 바뀌어 저장된 ${names}을(를) 폐기했습니다. 다시 입력하고 저장하세요(그 전까지 수집·스캔은 인증에 실패합니다).`;
}

/** CSV 가져오기 응답의 passwordDropped → 줄 목록(각 '줄 N · 이름 — 사유'). */
export function passwordDroppedLines(r) {
  const list = r && Array.isArray(r.passwordDropped) ? r.passwordDropped : [];
  return list.filter((x) => x && typeof x === 'object').map((x) => {
    const where = [x.line != null ? `줄 ${x.line}` : '', x.datacenter || x.name || ''].filter(Boolean).join(' · ');
    const reason = typeof x.reason === 'string' && x.reason ? x.reason : '저장된 비밀번호를 폐기했습니다 — 다시 입력하세요.';
    return where ? `${where} — ${reason}` : reason;
  });
}

/** 중계 토폴로지 저장·가져오기 응답의 secretsDropped → 문장('' 이면 없음). */
export function relaySecretsDroppedText(r) {
  const list = r && Array.isArray(r.secretsDropped) ? r.secretsDropped.filter((x) => typeof x === 'string' && x) : [];
  if (!list.length) return '';
  return `주소가 바뀌어 저장된 SSH 비밀번호·키를 폐기한 곳 ${list.length}개: ${list.join(', ')} — 다시 입력하세요`;
}

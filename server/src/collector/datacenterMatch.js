/**
 * 수집기(에이전트)를 등록된 DataCenter(법인)에 매칭하는 순수 함수.
 * collector.datacenter 라벨 / collector.id / collector.name 후보를 순서대로 보고,
 * DataCenter의 id 또는 name과 대소문자 무시로 일치하면 그 DataCenter id를 반환한다.
 * 어디에도 안 맞으면 ''(미지정). 위임 법인 원격 서버가 datacenterId를 못 받은 경우,
 * '그 서버를 보고한 에이전트의 소속 법인'으로 자동 귀속시키는 데 쓰인다.
 */
export function matchDatacenterId(candidates, datacenters) {
  const byId = new Map((datacenters || []).map((d) => [String(d.id).trim().toLowerCase(), d.id]));
  const byName = new Map((datacenters || []).map((d) => [String(d.name || '').trim().toLowerCase(), d.id]));
  for (const c of candidates || []) {
    const cand = String(c || '').trim().toLowerCase();
    if (!cand) continue;
    if (byId.has(cand)) return byId.get(cand);
    if (byName.has(cand)) return byName.get(cand);
  }
  return '';
}

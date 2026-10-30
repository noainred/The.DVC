/**
 * web/src/cmpVersion.js — semver 형태 버전 비교. 서버 `server/src/util/cmpVersion.js` 와 **같은 규칙**(v2.826 — 웹에도 하나만 둔다):
 *  - 선행 `v`/공백을 벗긴다 · 세그먼트가 전부 숫자가 아니면 null(모르는 것 — **낮은 버전으로 보지 않는다**) · 짧은 쪽은 0 으로 채운다
 *  - 반환은 부호만 의미 있는 -1/0/1.
 * (views/tools/linkCheckText.js 의 cmpVersion 은 3세그먼트 강제·차이값 반환으로 규칙이 다르다 — 새 코드는 이 파일을 쓸 것.)
 */
export function cmpVersion(a, b) {
  const parse = (v) => {
    const s = String(v ?? '').trim().replace(/^v/i, '');
    if (!s) return null;
    const parts = s.split('.').map((x) => Number(x));
    if (!parts.length || parts.some((x) => !Number.isFinite(x))) return null;
    return parts;
  };
  const pa = parse(a); const pb = parse(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}
export default cmpVersion;

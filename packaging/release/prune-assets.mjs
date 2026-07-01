/**
 * 릴리스 자산 prune — 롤링 'downloads' 릴리스는 자산 1000개 상한이 있어, 버전이 쌓이면
 * 새 업로드가 422(file_count limited to 1000)로 거부된다. 이 스크립트는 현재 릴리스의
 * 자산 이름 목록(stdin, 줄바꿈 구분)을 받아 최근 N개 버전의 자산만 남기고 나머지
 * '오래된 버전 자산' 이름을 stdout으로 출력한다(삭제 대상). 버전이 없는 자산(versions.json 등)은
 * 항상 유지한다.
 *
 *   gh release view downloads --json assets -q '.assets[].name' | node prune-assets.mjs <keepCount>
 *
 * 출력(삭제 대상)을 workflow에서 `gh release delete-asset` 으로 지운다.
 */

const keep = Math.max(1, Number(process.argv[2]) || 15);

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const names = input.split('\n').map((s) => s.trim()).filter(Boolean);
  const verRe = /(\d+)\.(\d+)\.(\d+)/;
  const byVersion = new Map(); // "x.y.z" -> [assetName...]
  for (const name of names) {
    const m = name.match(verRe);
    if (!m) continue; // 버전 없는 자산(versions.json 등) → 유지
    const v = `${m[1]}.${m[2]}.${m[3]}`;
    if (!byVersion.has(v)) byVersion.set(v, []);
    byVersion.get(v).push(name);
  }
  const cmp = (a, b) => {
    const pa = a.split('.').map(Number); const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) { if (pa[i] !== pb[i]) return pb[i] - pa[i]; }
    return 0;
  };
  const versions = [...byVersion.keys()].sort(cmp); // 최신 → 오래된
  const drop = versions.slice(keep); // keep개 이후는 삭제
  const toDelete = [];
  for (const v of drop) toDelete.push(...byVersion.get(v));
  process.stdout.write(toDelete.join('\n') + (toDelete.length ? '\n' : ''));
  process.stderr.write(`[prune] 버전 ${versions.length}개 중 최신 ${Math.min(keep, versions.length)}개 유지, ${drop.length}개 버전(${toDelete.length} 자산) 삭제 대상\n`);
});

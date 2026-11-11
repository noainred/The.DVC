/**
 * chunkReload.js — 업그레이드 뒤 옛 화면 조각(청크) 404 에서 빠져나오기(v2.977 전체 점검 · 화면 축 1번 — 재현).
 *
 * 업그레이드는 설치 폴더를 통째로 바꾼다 → 이미 열려 있던 탭이 아직 안 연 메뉴를 누르면 옛 해시의 청크를 받으려다 404 가 난다
 * ('Failed to fetch dynamically imported module'). React.lazy 는 실패한 약속을 기억하므로 오류 화면의 '다시 시도' 로는 풀리지 않았다.
 * 고침: 청크 오류면 페이지를 한 번 새로 읽는다(같은 탭에서 60초에 한 번 — 정말 없는 파일이면 새로고침이 끝없이 돌지 않게) ·
 * 그래도 나면 오류 화면이 '새로고침' 단추를 준다(다시 시도 대신).
 */
const CHUNK_RE = /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Loading (?:CSS )?chunk [\w-]+ failed|ChunkLoadError|Unable to preload CSS/i;
export const RELOAD_KEY = 'portal.chunkReloadAt';
export const RELOAD_GAP_MS = 60_000;

/** 화면 조각을 못 받은 오류인가. */
export function isChunkLoadError(err) {
  if (!err) return false;
  if (err.name === 'ChunkLoadError') return true;
  return CHUNK_RE.test(String(err.message || err));
}

/** 지금 자동으로 새로 읽어도 되나(같은 탭에서 RELOAD_GAP_MS 에 한 번). 된다면 시각을 남긴다. 저장소를 못 쓰면 false(무한 새로고침 방지). */
export function claimAutoReload(storage, now = Date.now()) {
  try {
    if (!storage) return false;
    const last = Number(storage.getItem(RELOAD_KEY)) || 0;
    if (now - last < RELOAD_GAP_MS) return false;
    storage.setItem(RELOAD_KEY, String(now));
    return true;
  } catch { return false; }
}

const sess = () => { try { return typeof window === 'undefined' ? null : window.sessionStorage; } catch { return null; } };

/** 청크 오류면 한 번 새로 읽는다. 새로 읽으면 true. */
export function reloadOnChunkError(err) {
  if (!isChunkLoadError(err) || typeof window === 'undefined') return false;
  if (!claimAutoReload(sess())) return false;
  window.location.reload();
  return true;
}

/** Vite 가 동적 import 의 미리 받기 실패를 알리는 이벤트 — 오류가 화면까지 오기 전에 새로 읽는다. 앱 시작 때 한 번 건다. */
export function installChunkReload() {
  if (typeof window === 'undefined') return;
  window.addEventListener('vite:preloadError', (event) => {
    if (claimAutoReload(sess())) { event.preventDefault?.(); window.location.reload(); }
  });
}

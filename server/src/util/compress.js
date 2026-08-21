/**
 * 경량 gzip 응답 압축 + ETag/304 미들웨어 — 외부 의존성 없이 Node 내장 zlib/crypto만 사용
 * (에어갭 배포 호환). res.json()을 감싸 큰 JSON 응답만 비동기 gzip한다(동기 gzipSync로
 * 이벤트 루프를 막지 않음). res.send는 건드리지 않아 파일 다운로드·xlsx·pcap·SSE 등
 * 바이너리/스트리밍 경로에 영향 없음.
 *
 * ETag/304: 이 래퍼가 res.end로 직접 종료하면 Express의 기본 ETag 경로가 우회돼 서버가
 * ETag를 전혀 내보내지 않았다 — 프론트 pollFetch의 If-None-Match 지원이 사장되고, 스냅샷이
 * 30초마다 갱신되는데 뷰는 15초 폴링이라 최소 폴 2회 중 1회는 동일 내용을 매번 재직렬화·
 * 재압축·재전송했다. 본문 해시로 약한 ETag를 만들어 일치하면 304(본문 0바이트)로 답한다.
 *
 * 적용 대상: 대시보드/인사이트/IPMS 등 큰 JSON 응답(수십KB~수MB). 작은 응답(<1KB)·gzip
 * 미지원 클라이언트·이미 인코딩 설정된 응답은 그대로 통과(ETag는 크기와 무관하게 발급).
 */

import zlib from 'node:zlib';
import crypto from 'node:crypto';

const MIN_BYTES = Number(process.env.GZIP_MIN_BYTES) || 1024; // 이보다 작으면 압축 안 함(오버헤드 회피)

// 직렬화·gzip 결과 캐시(v2.343 #6) — payload '객체 identity' 키(WeakMap). memoJson(snapCache)은
// 같은 스냅샷 TTL 동안 같은 payload 객체 참조를 모든 요청에 재사용하므로, 사용자 M명이 같은
// 화면을 폴링해도 JSON.stringify(수 MB)·gzip 이 스냅샷당 1회로 수렴한다. 해시 키가 아니라
// 객체 identity 키라 다른 본문과 충돌할 가능성이 0이고, WeakMap 이라 스냅샷 교체로 참조가
// 끊기면 그대로 GC(누수·상한 관리 불필요). 전제: 캐시 대상 payload 는 응답 후 변형하지 않는다
// — memoJson 공유 객체의 기존 계약과 동일(라우트가 매번 새 객체를 만들면 자연히 미스).
const bodyCache = new WeakMap(); // payload(object) -> { buf, etag?, gz? }

export function compression() {
  return function compressionMiddleware(req, res, next) {
    const accept = req.headers['accept-encoding'] || '';
    const gzipOk = /\bgzip\b/.test(accept);
    const origJson = res.json.bind(res);

    res.json = (body) => {
      const cacheable = body !== null && typeof body === 'object';
      let entry = cacheable ? bodyCache.get(body) : undefined;
      let buf = entry?.buf;
      if (!buf) {
        let str;
        try { str = JSON.stringify(body); } catch { return origJson(body); }
        // JSON.stringify(undefined)는 예외 없이 undefined 반환 → Buffer.from(undefined)가
        // TypeError로 500. Express 기본 res.json(undefined)은 빈 본문을 보내므로 그 동작에 위임.
        if (str === undefined) return origJson(body);
        buf = Buffer.from(str);
        if (cacheable) { entry = { buf }; bodyCache.set(body, entry); }
      }

      // ETag/304 — GET 200 응답에만. 해시는 압축 전 본문 기준(Content-Encoding과 무관하게 동일).
      if (req.method === 'GET' && !res.headersSent && (res.statusCode || 200) === 200) {
        // 라우트(sendCached 등 snapCache 경로)가 이미 키 기반 ETag 를 설정했으면 존중한다(v2.342).
        // 종전엔 여기서 SHA-1 태그로 무조건 덮어써서 클라이언트가 항상 SHA-1 태그를 저장했고,
        // 다음 요청의 If-None-Match 가 라우트의 weakEtag 와 영영 불일치 → '직렬화 전에 판정하는'
        // 조기 304 경로(snapCache.sendCached)가 한 번도 타지지 않았다. 라우트가 태그를 설정했다면
        // 사전 비교는 라우트 책임(불일치라 본문 전송 중)이므로 여기서는 해시 계산도 생략한다.
        if (res.getHeader('ETag') === undefined) {
          const tag = entry?.etag || `W/"${crypto.createHash('sha1').update(buf).digest('base64url')}"`;
          if (entry && !entry.etag) entry.etag = tag; // 같은 payload 재응답 시 SHA-1 재계산 생략(#6)
          res.setHeader('ETag', tag);
          if (req.headers['if-none-match'] === tag) {
            res.statusCode = 304;
            return res.end();
          }
        }
      }

      // 압축 부적합: 미지원·작은 응답·이미 인코딩됨 → 원본 그대로.
      if (!gzipOk || buf.length < MIN_BYTES || res.headersSent || res.getHeader('Content-Encoding')) {
        if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Length', String(buf.length));
        return res.end(buf);
      }
      const sendGz = (gz) => {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Content-Length', String(gz.length));
        const vary = res.getHeader('Vary');
        res.setHeader('Vary', vary ? `${vary}, Accept-Encoding` : 'Accept-Encoding');
        res.end(gz);
      };
      // 같은 payload 를 이미 압축했다면 재압축 생략(#6) — M명 폴링 시 gzip 이 스냅샷당 1회.
      if (entry?.gz) { sendGz(entry.gz); return res; }
      zlib.gzip(buf, (err, gz) => {
        if (err) {
          if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Content-Length', String(buf.length));
          return res.end(buf);
        }
        if (entry) entry.gz = gz;
        sendGz(gz);
      });
      return res;
    };
    next();
  };
}

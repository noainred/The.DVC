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

export function compression() {
  return function compressionMiddleware(req, res, next) {
    const accept = req.headers['accept-encoding'] || '';
    const gzipOk = /\bgzip\b/.test(accept);
    const origJson = res.json.bind(res);

    res.json = (body) => {
      let str;
      try { str = JSON.stringify(body); } catch { return origJson(body); }
      const buf = Buffer.from(str);

      // ETag/304 — GET 200 응답에만. 해시는 압축 전 본문 기준(Content-Encoding과 무관하게 동일).
      if (req.method === 'GET' && !res.headersSent && (res.statusCode || 200) === 200) {
        const tag = `W/"${crypto.createHash('sha1').update(buf).digest('base64url')}"`;
        res.setHeader('ETag', tag);
        if (req.headers['if-none-match'] === tag) {
          res.statusCode = 304;
          return res.end();
        }
      }

      // 압축 부적합: 미지원·작은 응답·이미 인코딩됨 → 원본 그대로.
      if (!gzipOk || buf.length < MIN_BYTES || res.headersSent || res.getHeader('Content-Encoding')) {
        if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Length', String(buf.length));
        return res.end(buf);
      }
      zlib.gzip(buf, (err, gz) => {
        if (err) {
          if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Content-Length', String(buf.length));
          return res.end(buf);
        }
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Content-Length', String(gz.length));
        const vary = res.getHeader('Vary');
        res.setHeader('Vary', vary ? `${vary}, Accept-Encoding` : 'Accept-Encoding');
        res.end(gz);
      });
      return res;
    };
    next();
  };
}

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
    },
  },
  // vitest(v2.289 #4) — 순수 유틸(전력 단위 포맷 등)의 회귀를 잡는 최소 단위테스트 러너.
  // node 환경으로 충분하다(대상 함수는 DOM/window 미사용, api.js 도 top-level 부작용 없음).
  // JSX 는 위 @vitejs/plugin-react 플러그인이 그대로 변환하므로 shared.jsx import 가 통과한다.
  test: {
    environment: 'node',
    include: ['src/**/*.test.{js,jsx}'],
  },
  build: {
    // 번들 청크 분리(v2.289 #8) — index(앱 진입) 청크에 뭉쳐 있던 공용 벤더(react·recharts)를
    // 별도 청크로 떼어내 초기 로드 크기를 줄인다. ⚠ 캐치올 'vendor' 는 만들지 않는다 — 그러면
    // Topology3D 가 lazy import 하는 3d-force-graph/three 까지 eager 벤더 청크로 끌려와 초기 로드가
    // 오히려 커진다(실측 index 148KB·vendor 1.87MB). 딱 두 공용 벤더만 명시하고 나머지(무거운
    // 3D 라이브러리 포함)는 각자의 자연스러운 lazy 청크에 남긴다(undefined 반환).
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          // v2.447(감사 T11): recharts 와 d3-geo 를 분리한다. 로그인 화면(loginThemes.jsx)이
          // d3-geo 의 심볼 2개(geoEquirectangular·geoPath)만 쓰는데 한 청크로 묶여 있어
          // **차트가 없는 로그인 화면에 recharts 520KB 전량이 modulepreload** 되고 있었다(실측).
          // d3-geo/d3-array 등 지도용만 vendor-geo 로 떼어내 로그인 경로의 전송량을 줄인다.
          // ⚠ d3-path 는 recharts 도 쓰므로 여기 넣으면 vendor-geo ↔ vendor-charts 순환 청크가 된다
          // (빌드 경고 'Circular chunk'). 지도 전용 패키지만 뗀다.
          if (id.includes('/d3-geo') || id.includes('/topojson')) return 'vendor-geo';
          if (id.includes('recharts') || id.includes('/d3-')) return 'vendor-charts';
          if (id.includes('react-dom') || id.includes('/react/') || id.includes('/scheduler/')) return 'vendor-react';
          return undefined; // 그 외는 Rollup 기본 분할(lazy 경계 보존)
        },
      },
    },
  },
});

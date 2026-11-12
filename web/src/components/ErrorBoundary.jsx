import React from 'react';
import { isChunkLoadError, reloadOnChunkError } from '../chunkReload.js';

/**
 * Catches render/runtime errors in its subtree so a single broken component
 * never blanks the whole portal. Shows a small fallback (or a custom one).
 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary]', error, info?.componentStack);
    // v2.977: 업그레이드 뒤 옛 화면 조각 404 — 한 번 새로 읽는다(60초에 한 번 · chunkReload.js)
    reloadOnChunkError(error);
  }

  render() {
    if (this.state.error) {
      if (isChunkLoadError(this.state.error)) {
        // React.lazy 는 실패한 약속을 기억한다 — '다시 시도' 로는 풀리지 않으므로 새로고침을 준다
        return (
          <div className="error-box" style={{ padding: 24 }}>
            <div style={{ fontWeight: 700, marginBottom: 8 }}>포탈이 새 판으로 업그레이드되어 이 화면을 다시 받아야 합니다.</div>
            <div className="muted" style={{ fontSize: 12 }}>열어 둔 창이 업그레이드 전 판이라 화면 파일을 찾지 못했습니다. 새로고침하면 새 판으로 열립니다.</div>
            <button className="login-btn" style={{ flex: 'none', padding: '8px 16px', marginTop: 12 }} onClick={() => window.location.reload()}>새로고침</button>
          </div>
        );
      }
      if (this.props.fallback) return this.props.fallback;
      return (
        <div className="error-box" style={{ padding: 24 }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>이 영역을 표시하는 중 오류가 발생했습니다.</div>
          <div className="muted" style={{ fontSize: 12, wordBreak: 'break-all' }}>{String(this.state.error?.message || this.state.error)}</div>
          <button className="login-btn" style={{ flex: 'none', padding: '8px 16px', marginTop: 12 }}
            onClick={() => this.setState({ error: null })}>다시 시도</button>
        </div>
      );
    }
    return this.props.children;
  }
}

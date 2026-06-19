import React from 'react';

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
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary]', error, info?.componentStack);
  }

  render() {
    if (this.state.error) {
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

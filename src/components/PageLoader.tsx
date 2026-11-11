import { Component, Suspense, type ReactNode } from 'react';

/** Keep navigation available when a route module is loading or a deployment removed its chunk. */
export class PageLoader extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() { return { failed: true }; }

  render() {
    if (this.state.failed) return (
      <div role="alert" className="px-8 py-16 text-center text-sm text-t2">
        <p>页面加载失败，请重新加载后重试。</p>
        <button className="btn-primary mt-4" data-reload-page onClick={() => window.location.reload()}>重新加载</button>
      </div>
    );
    return <Suspense fallback={<div role="status" className="px-8 py-16 text-center text-sm text-t3">页面加载中…</div>}>{this.props.children}</Suspense>;
  }
}

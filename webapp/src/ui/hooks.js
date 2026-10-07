import { useEffect, useRef, useState } from 'preact/hooks';

/**
 * 依赖变化时重新执行异步函数；旧请求的结果自动丢弃。
 * fn 会收到 isStale()：长循环里可用它提前结束，避免过期查询堵住单连接队列。
 */
export function useAsync(fn, deps) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const seq = useRef(0);
  useEffect(() => {
    const my = ++seq.current;
    const isStale = () => my !== seq.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    Promise.resolve()
      .then(() => fn(isStale))
      .then((data) => { if (!isStale()) setState({ loading: false, data, error: null }); })
      .catch((error) => { if (!isStale() && !error?.stale) setState({ loading: false, data: null, error }); });
  }, deps);
  useEffect(() => () => { seq.current++; }, []);
  return state;
}

export function useDebounced(value, ms = 400) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

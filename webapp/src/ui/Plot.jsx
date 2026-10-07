import { useEffect, useRef } from 'preact/hooks';

let plotlyPromise = null;
export const loadPlotly = () => (plotlyPromise ||= import('plotly.js-basic-dist-min').then((m) => m.default || m));

const FONT = { family: '-apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif', size: 11, color: '#1d2126' };

/** Plotly 封装：容器可拖动右下角改变大小；尺寸变化自动重排。 */
export function Plot({ data, layout, height = 320, onRelayout, onClick }) {
  const ref = useRef(null);
  const plotly = useRef(null);
  useEffect(() => {
    let alive = true;
    let ro = null;
    loadPlotly().then((Plotly) => {
      plotly.current = Plotly;
      if (!alive || !ref.current) return;
      Plotly.react(ref.current, data, {
        font: FONT, paper_bgcolor: '#fff', plot_bgcolor: '#fff', margin: { l: 52, r: 16, t: 36, b: 40 },
        legend: { orientation: 'h', x: 1, xanchor: 'right', y: 1.08 }, hovermode: 'closest', ...layout,
      }, { displaylogo: false, responsive: false, modeBarButtonsToRemove: ['lasso2d', 'toImage'], scrollZoom: false });
      ref.current.removeAllListeners?.('plotly_relayout');
      ref.current.removeAllListeners?.('plotly_click');
      if (onRelayout) ref.current.on('plotly_relayout', onRelayout);
      if (onClick) ref.current.on('plotly_click', onClick);
      ro = new ResizeObserver(() => ref.current && Plotly.Plots.resize(ref.current));
      ro.observe(ref.current);
    });
    return () => { alive = false; ro?.disconnect(); };
  }, [data, layout]);
  useEffect(() => {
    const el = ref.current;
    return () => { if (el && plotly.current) plotly.current.purge(el); };
  }, []);
  return <div ref={ref} class="plotbox" style={{ height: `${height}px` }} />;
}

export const GRID = '#eef0f2';
export const COLORS = { A: '#2563eb', B: '#f97316' };

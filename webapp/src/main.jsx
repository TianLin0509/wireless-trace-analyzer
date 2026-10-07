import { render } from 'preact';
import './styles.css';
import { App } from './ui/App.jsx';
import * as S from './store.js';
import * as stats from './engine/stats.js';
import * as q from './engine/query.js';
import * as db from './engine/db.js';

render(<App />, document.getElementById('app'));

// 测试钩子：仅在网址带 ?debug 时暴露内部状态，供自动化对照测试读取
if (new URLSearchParams(location.search).has('debug')) window.__trace = { S, stats, q, db };

// 每 20 分钟检查一次是否有新版本（只取一个很小的 version.json，不涉及任何数据）
setInterval(() => {
  fetch('/version.json', { cache: 'no-store' }).then((r) => r.json()).then((v) => {
    if (v.build && v.build !== __BUILD_TIME__) window.dispatchEvent(new CustomEvent('app-updated'));
  }).catch(() => {});
}, 20 * 60 * 1000);

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

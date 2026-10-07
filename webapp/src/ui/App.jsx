import { useEffect, useState } from 'preact/hooks';
import * as S from '../store.js';
import { StartPage } from './StartPage.jsx';
import { Workspace } from './Workspace.jsx';
import { KpiPage } from './KpiPage.jsx';
import { getDb } from '../engine/db.js';

export function App() {
  const [updated, setUpdated] = useState(false);
  useEffect(() => {
    getDb().catch((e) => S.showError('计算引擎加载失败', e, ['刷新页面重试；如果在公司网络，确认能访问本站点。']));
    const on = () => setUpdated(true);
    window.addEventListener('app-updated', on);
    const guard = (e) => { if (S.ready.value || S.running.value) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', guard);
    return () => { window.removeEventListener('app-updated', on); window.removeEventListener('beforeunload', guard); };
  }, []);
  const p = S.page.value;
  return (
    <>
      {p === 'start' && <StartPage />}
      {p === 'work' && <Workspace />}
      {p === 'kpi' && <KpiPage />}
      {updated && <div class="toast" style="bottom:auto;top:12px">已有新版本 · <button class="btn small" onClick={() => location.reload()}>刷新使用新版</button></div>}
      {S.toast.value && <div class="toast">{S.toast.value.text}</div>}
      {S.errorBox.value && <ErrorBox />}
    </>
  );
}

function ErrorBox() {
  const e = S.errorBox.value;
  return (
    <div class="errbox" role="alert">
      <div class="row"><h4>{e.title}</h4><span class="sp" /><button class="btn text" onClick={() => (S.errorBox.value = null)}>关闭</button></div>
      <div>{e.message}</div>
      {e.hints.length > 0 && <ul>{e.hints.map((h) => <li>{h}</li>)}</ul>}
    </div>
  );
}

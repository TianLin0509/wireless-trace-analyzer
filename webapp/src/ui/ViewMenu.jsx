import { useState, useEffect } from 'preact/hooks';
import * as S from '../store.js';
import { listAll, saveView, remove, convertLegacyTemplates } from '../persist.js';
import { startRun } from '../pipeline.js';
import { localDateTag } from './fmt.js';

const sameSet = (a = [], b = []) => a.length === b.length && a.every((x) => b.includes(x));

/** “视图”= 汇总字段 + 列顺序/隐藏 + 表格筛选与搜索 + 图表字段与模式。取代旧版三套模板。 */
export function ViewMenu() {
  const [open, setOpen] = useState(false);
  const [views, setViews] = useState([]);
  const [edit, setEdit] = useState(null); // {kind: 'saveAs'|'rename'|'delete', rec, value}
  const refresh = () => listAll('views').then((v) => setViews(v.sort((a, b) => a.name.localeCompare(b.name, 'zh')))).catch(() => {});
  useEffect(() => { if (open) refresh(); }, [open]);
  const v = S.view.value;
  const running = S.running.value;

  const apply = async (rec) => {
    // 与“当前合并表实际读入的字段”比较，而不是与当前视图比较，避免视图和数据长期不一致
    const loaded = S.loadedFields.value;
    const needMerge = loaded && (!sameSet(rec.columns537, loaded.columns537) || !sameSet(rec.columns714, loaded.columns714));
    S.view.value = { ...S.defaultView(), ...rec };
    setOpen(false);
    if (needMerge) {
      try { await startRun({ tablesOnly: true }); S.showToast(`已应用视图「${rec.name}」并按其字段重新合并。`); }
      catch (err) { S.showError('应用视图失败', err); }
    } else S.showToast(`已应用视图「${rec.name}」。`);
  };
  const snapshot = () => {
    const { id, name, ...rest } = S.view.value;
    return rest;
  };
  const saveAs = async (name) => {
    if (!name) return;
    try { const rec = await saveView({ ...snapshot(), name }); S.view.value = { ...S.view.value, id: rec.id, name: rec.name }; refresh(); S.showToast('已保存。'); }
    catch (err) { S.showError('保存失败', err); }
  };
  const overwrite = async () => {
    try { await saveView({ ...snapshot(), id: v.id, name: v.name }); refresh(); S.showToast(`已覆盖视图「${v.name}」。`); }
    catch (err) { S.showError('保存失败', err); }
  };
  const rename = async (rec, name) => {
    if (!name || name === rec.name) return;
    try { await saveView({ ...rec, name }); if (rec.id === v.id) S.updateView({ name }); refresh(); }
    catch (err) { S.showError('重命名失败', err); }
  };
  const del = async (rec) => {
    await remove('views', rec.id);
    if (rec.id === v.id) S.updateView({ id: null, name: '未保存视图' });
    refresh();
  };
  const exportAll = () => {
    const blob = new Blob([JSON.stringify({ version: 1, views }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${localDateTag()}-trace-views.json`;
    a.click();
  };
  const importFile = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async () => {
      try {
        const json = JSON.parse(await input.files[0].text());
        const list = json.views || convertLegacyTemplates(json);
        let n = 0;
        const names = new Set(views.map((x) => x.name));
        for (const item of list) {
          let name = item.name;
          while (names.has(name)) name += '·';
          names.add(name);
          await saveView({ ...S.defaultView(), ...item, id: null, name });
          n++;
        }
        refresh();
        S.showToast(`已导入 ${n} 个视图。`);
      } catch (err) { S.showError('导入失败', err, ['支持本工具导出的视图文件，以及旧版的 merge-column-templates.json、table-layout-templates.json、analysis-recipes.json。']); }
    };
    input.click();
  };

  return (
    <div style="position:relative">
      <button class="btn" onClick={() => setOpen(!open)}>视图：{v.name} ▾</button>
      {open && (
        <>
          <div class="backdrop" onClick={() => setOpen(false)} />
          <div class="pop" style="right:0;top:36px;width:340px">
            <b>视图</b>
            <p class="faint" style="font-size:11px;margin:2px 0 8px">保存汇总字段、列顺序、表格筛选和图表字段；保存在本机浏览器里。{running ? '数据读取中，完成后才能切换视图。' : ''}</p>
            <div style="max-height:260px;overflow:auto">
              {!views.length && <div class="faint" style="padding:8px 0">还没有保存的视图。</div>}
              {views.map((rec) => (
                <div class="row" style="padding:4px 0;border-top:1px solid var(--line2)">
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: rec.id === v.id ? 600 : 400 }}>{rec.id === v.id ? '● ' : ''}{rec.name}</span>
                  <button class="btn small" disabled={running} onClick={() => apply(rec)}>应用</button>
                  <button class="btn text" onClick={() => setEdit({ kind: 'rename', rec, value: rec.name })}>改名</button>
                  <button class="btn text danger" onClick={() => setEdit({ kind: 'delete', rec })}>删</button>
                </div>
              ))}
            </div>
            <div class="row" style="margin-top:8px;flex-wrap:wrap">
              <button class="btn small primary" onClick={() => setEdit({ kind: 'saveAs', value: v.id ? `${v.name} 副本` : '' })}>另存当前</button>
              <button class="btn small" disabled={!v.id} onClick={overwrite}>覆盖「{v.id ? v.name : '—'}」</button>
              <button class="btn small" disabled={running} onClick={() => apply({ ...S.defaultView(), name: '默认视图' })}>恢复默认</button>
            </div>
            {edit && (
              <div class="row" style="margin-top:8px;padding:8px;background:#f8f9fa;border-radius:8px">
                {edit.kind === 'delete' ? <span style="flex:1">删除「{edit.rec.name}」？</span>
                  : <input class="input" style="flex:1" autoFocus placeholder="视图名称" value={edit.value} onInput={(e) => setEdit({ ...edit, value: e.target.value })} />}
                <button class="btn small primary" onClick={async () => {
                  if (edit.kind === 'saveAs') await saveAs(edit.value.trim());
                  else if (edit.kind === 'rename') await rename(edit.rec, edit.value.trim());
                  else await del(edit.rec);
                  setEdit(null);
                }}>{edit.kind === 'delete' ? '删除' : '确定'}</button>
                <button class="btn small" onClick={() => setEdit(null)}>取消</button>
              </div>
            )}
            <div class="row" style="margin-top:6px">
              <button class="btn text" onClick={importFile}>导入（含旧版模板）</button>
              <button class="btn text" disabled={!views.length} onClick={exportAll}>导出全部</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

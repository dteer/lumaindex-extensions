import {defaultPrompt, currentPrompt} from './ai-copy.js';

// node 使用文本节点显示作品信息和模型建议，不将生成内容作为 HTML 执行。
function node(tag, className = '', text) {
  const value = document.createElement(tag);
  value.className = className;
  if (text !== undefined) value.textContent = text;
  return value;
}

// mountStudioAIPanel 维护原助手的背景、提示词及显式选图体验；结果只在用户应用时写入作品。
export function mountStudioAIPanel({assistant, current, preferences, savePreferences, baseURL, mediaURL, assetDetail, safeURL, apply}) {
  const $ = id => document.getElementById(id);
  const dialog = $('ai-dialog');
  let draftId = '', selected = new Set(), useImages = false, expanded = true;
  let result = null, job = null, applying = false;

  // images 仅允许当前图文中可读的图库图片，临时文件与视频不作为隐式分析素材。
  function images() {
    return current().kind === 'image' ? current().assets.filter(asset => asset.kind === 'image' && !asset.localOnly && !assetDetail(asset.id)?.error) : [];
  }

  // controls 生成中冻结输入但保留取消；应用资格始终与当前作品及账号核对。
  function controls() {
    const running = !!job || applying;
    for (const id of ['ai-context', 'ai-prompt', 'ai-reset-prompt', 'ai-use-images', 'ai-generate']) $(id).disabled = running;
    $('ai-use-images').disabled ||= images().length === 0;
    $('ai-cancel').hidden = !job;
    $('ai-retry-resources').disabled = running;
    $('ai-apply').disabled = running || !result || !assistant.isCurrent(result) || !['copy', 'location', 'music'].some(key => $('ai-apply-' + key).checked && !$('ai-apply-' + key).disabled);
    for (const button of $('ai-images').querySelectorAll('button')) button.disabled = running;
  }

  // renderImages 把圆形勾选固定在缩略图右下角，文件名、预览和选择状态互不覆盖。
  function renderImages() {
    const values = images();
    selected = new Set([...selected].filter(id => values.some(asset => asset.id === id)));
    $('ai-image-section').hidden = !useImages || !values.length;
    $('ai-images').hidden = !expanded;
    $('ai-image-count').textContent = `已选择 ${selected.size} / 6 张`;
    $('ai-toggle-images').textContent = expanded ? '收起图片' : '展开图片';
    $('ai-toggle-images').setAttribute('aria-expanded', String(expanded));
    $('ai-image-hint').textContent = current().kind === 'video' ? '视频作品使用作品信息生成文案。' : '仅将勾选图片的缩略图发送至图库配置的 AI，不发送原图。';
    $('ai-images').replaceChildren();
    for (const asset of values) {
      const card = node('div', 'ai-image-card');
      const frame = node('div', 'ai-image-frame'), image = node('img');
      image.src = mediaURL(asset); image.alt = asset.name; image.loading = 'lazy';
      const toggle = node('button', 'ai-image-toggle'); toggle.type = 'button';
      toggle.setAttribute('aria-label', `${selected.has(asset.id) ? '取消选择' : '选择素材'} ${asset.name}`);
      toggle.setAttribute('aria-pressed', String(selected.has(asset.id)));
      const circle = node('span', 'ai-image-circle', selected.has(asset.id) ? '✓' : '');
      toggle.append(circle);
      toggle.onclick = () => {
        if (job || applying) return;
        if (selected.has(asset.id)) selected.delete(asset.id);
        else if (selected.size < 6) selected.add(asset.id);
        else { $('ai-status').textContent = '最多选择 6 张图片，请先取消一张。'; return; }
        clearResult(); renderImages(); controls();
      };
      frame.append(image, toggle); card.append(frame, node('span', 'ai-image-name', asset.name));
      $('ai-images').append(card);
    }
    controls();
  }

  // clearResult 撤销旧输入对应的建议，不影响作品中的手动位置或配乐。
  function clearResult() {
    assistant.cancel(); result = null;
    $('ai-result').hidden = true; $('ai-retry-resources').hidden = true;
    $('ai-result-audio').pause(); $('ai-result-audio').removeAttribute('src');
    controls();
  }

  // renderResult 分别展示可发布身份与未匹配线索，默认保留作品已有的手动资源。
  function renderResult() {
    if (!result) return;
    $('ai-result').hidden = false;
    $('ai-result-title').textContent = result.title;
    $('ai-result-description').textContent = result.description;
    $('ai-apply-copy').checked = true;
    const location = result.location, music = result.music;
    $('ai-result-location').textContent = location ? `${location.cityName} · ${location.name}` : result.analysis.location ? `${result.analysis.location.cityName} · ${result.analysis.location.query}（待确认）` : '暂未识别到可靠位置';
    $('ai-location-reason').textContent = location ? [location.address, location.reason].filter(Boolean).join(' · ') : result.analysis.location?.evidence || '可在发布页手动选择。';
    $('ai-result-music').textContent = music ? `${music.name}${music.author ? ' · ' + music.author : ''}` : result.analysis.music.queries.join(' / ') || '暂无合适配乐';
    $('ai-music-reason').textContent = music?.reason || result.analysis.music.style || '';
    for (const key of ['location', 'music']) {
      $('ai-apply-' + key).disabled = !result[key];
      $('ai-apply-' + key).checked = !!result[key] && !current()[key];
      $('ai-existing-' + key).textContent = current()[key] ? `当前已选：${current()[key].name}；勾选后替换。` : '';
    }
    const audio = $('ai-result-audio'), source = safeURL(music?.previewURL);
    audio.pause(); audio.hidden = !source;
    if (source) audio.src = source; else audio.removeAttribute('src');
    $('ai-warnings').replaceChildren(...result.warnings.map(item => node('p', 'helper', item.message)));
    $('ai-retry-resources').hidden = current().kind !== 'image' || !result.warnings.length;
    controls();
  }

  // run 将生成错误和资源部分失败分开处理；取消后的迟到结果不能恢复按钮或建议。
  async function run(retry = false) {
    if (job || applying) return;
    const assetIds = useImages ? images().filter(asset => selected.has(asset.id)).map(asset => asset.id) : [];
    const firstImage = current().assets.find(asset => asset.kind === 'image');
    const source = firstImage && !firstImage.localOnly ? assetDetail(firstImage.id) : null;
    const directory = source?.directoryName || '';
    const tag = source?.dateTag || ''; // 拍照日期始终跟随正文首图，不跟随勾选分析的缩略图。
    if (!retry && (!$('ai-context').value.trim() && !assetIds.length && !directory || useImages && !assetIds.length)) {
      const message = useImages ? '请至少勾选一张图片，或关闭图片分析并填写作品信息。' : '请填写作品信息，或开启图片分析并勾选图片。';
      $('ai-status').textContent = message; window.alert(message); return;
    }
    const previous = result;
    if (!retry) clearResult();
    const controller = new AbortController(); job = controller;
    controls();
    try {
      const options = {signal: controller.signal, onProgress: value => { if (job === controller && dialog.open) $('ai-status').textContent = value.message; }};
      const value = retry ? await assistant.retryResources(previous, options) : await assistant.generate({baseURL,
        prompt: $('ai-prompt').value || defaultPrompt, assetIds, kind: current().kind, dateTag: tag,
        context: JSON.stringify({type: current().kind === 'image' ? '图文' : '视频', work: $('ai-context').value.trim(), directoryName: directory, dateTag: tag}),
      }, options);
      if (job !== controller || controller.signal.aborted || !dialog.open) return;
      result = value; renderResult();
      $('ai-status').textContent = value.warnings.length ? '文案已生成，可应用文案；位置和音乐请核对下方结果。' : '建议已生成，请核对后选择需要应用的内容。';
    } catch (error) {
      if (job !== controller || !dialog.open) return;
      if (error.name === 'AbortError' || controller.signal.aborted) $('ai-status').textContent = '已取消。作品信息和提示词已保留。';
      else { $('ai-status').textContent = error.message || 'AI 生成失败，请重试。'; window.alert($('ai-status').textContent); }
    } finally {
      if (job === controller) { job = null; controls(); }
    }
  }

  // cancel 立即解除本次任务的 UI 所有权，避免快速关闭再打开时采用旧响应。
  function cancel() {
    job?.abort(); job = null; assistant.cancel(); result = null;
    $('ai-result').hidden = true; $('ai-retry-resources').hidden = true;
    $('ai-result-audio').pause(); controls();
  }

  // sync 切换草稿时恢复该作品的背景，显式图片选择不跨作品沿用。
  function sync() {
    if (draftId !== current().id) {
      cancel(); draftId = current().id; selected.clear(); useImages = false;
      $('ai-use-images').checked = false;
      $('ai-context').value = current().aiContext || '';
      const savedPrompt = preferences().aiPrompt;
      $('ai-prompt').value = currentPrompt(savedPrompt);
      if (savedPrompt && savedPrompt !== $('ai-prompt').value) savePreferences({aiPrompt: $('ai-prompt').value});
      if (dialog.open) dialog.close();
    }
    if (result && !assistant.isCurrent(result)) {
      $('ai-status').textContent = '作品内容或账号已变化，请重新生成建议。';
      $('ai-apply').disabled = true;
    }
    if (dialog.open) { renderImages(); controls(); }
  }

  $('ai-close').onclick = () => dialog.close();
  dialog.onclose = () => { cancel(); };
  $('ai-cancel').onclick = () => { cancel(); $('ai-status').textContent = '已取消。作品信息和提示词已保留。'; };
  $('ai-use-images').onchange = event => {
    useImages = event.target.checked;
    if (useImages && !selected.size && images().length) selected.add(images()[0].id);
    clearResult(); renderImages();
  };
  $('ai-toggle-images').onclick = () => { expanded = !expanded; renderImages(); };
  $('ai-context').oninput = () => { savePreferences({aiContext: $('ai-context').value}); clearResult(); };
  $('ai-prompt').oninput = () => { savePreferences({aiPrompt: $('ai-prompt').value}); clearResult(); };
  $('ai-reset-prompt').onclick = () => { $('ai-prompt').value = defaultPrompt; savePreferences({aiPrompt: defaultPrompt}); clearResult(); };
  $('ai-generate').onclick = () => { void run(); };
  $('ai-retry-resources').onclick = () => { void run(true); };
  for (const key of ['copy', 'location', 'music']) $('ai-apply-' + key).onchange = controls;
  $('ai-apply').onclick = async () => {
    if (job || applying || !result || !assistant.isCurrent(result)) return;
    const value = result, selection = Object.fromEntries(['copy', 'location', 'music'].map(key => [key, !$('ai-apply-' + key).disabled && $('ai-apply-' + key).checked]));
    applying = true; controls();
    try { if (await apply(value, selection)) dialog.close(); }
    catch (error) { window.alert(error.message || '应用失败，建议已保留。'); }
    finally { applying = false; controls(); }
  };
  return {
    // open 只打开编辑界面，不启动 AI 调用或图片传输。
    open() { sync(); $('ai-status').textContent = '根据作品信息生成文案，并匹配抖音位置和背景音乐。'; dialog.showModal(); renderImages(); controls(); },
    sync, cancel,
    // dispose 页面退出时释放读取和试听，不影响账号或已保存草稿。
    dispose() { cancel(); assistant.dispose(); },
  };
}

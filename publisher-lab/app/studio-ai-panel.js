import {defaultPrompt, currentPrompt} from './ai-copy.js';

const scopes = ['copy', 'activity', 'music', 'location', 'hotspot'];
const labels = {copy: '作品描述', activity: '官方活动', music: '音乐', location: '地理位置', hotspot: '关联热点'};

// node 只创建文本内容，模型和平台返回值不作为 HTML 执行。
function node(tag, className = '', text) {
  const value = document.createElement(tag);
  value.className = className;
  if (text !== undefined) value.textContent = text;
  return value;
}

// mountStudioAIPanel 将作品信息与建议放在右栏；生成、编辑建议与应用作品分别执行。
export function mountStudioAIPanel({assistant, current, preferences, savePreferences, baseURL, mediaURL, assetDetail, safeURL, apply, blocked = () => false, onOpen = () => {}}) {
  const $ = id => document.getElementById(id);
  const inputPanel = $('ai-dialog'), suggestions = $('ai-suggestions');
  let draftId = '', selected = new Set(), useImages = false, expanded = false;
  let result = null, job = null, applying = false, promptScope = null;
  let copyDialogResult = null, promptDraftId = '', renderedImages = '';
  const choices = Object.fromEntries(scopes.map(key => [key, false]));
  const visible = () => !inputPanel.hidden;
  const prompts = () => current().aiResourcePrompts || {};

  // 图片分析仍只发送用户勾选的图库缩略图，原图与未勾选素材不参与。
  function images() {
    return current().kind === 'image' ? current().assets.filter(asset => asset.kind === 'image' && !asset.localOnly && !assetDetail(asset.id)?.error) : [];
  }
  function usable(key) {
    if (!result) return false;
    if (!assistant.isCurrent(result, key)) return false;
    if (result.states?.[key] === 'error') return false;
    return key === 'copy' || ['activity', 'hotspot'].includes(key) && ['ready', 'empty'].includes(result.states?.[key]) || !!result[key];
  }
  function controls() {
    const running = !!job || applying, currentResult = !!result && assistant.isCurrent(result);
    for (const id of ['ai-context', 'ai-prompt', 'ai-reset-prompt', 'ai-use-images', 'ai-generate']) $(id).disabled = running;
    $('ai-use-images').disabled ||= images().length === 0;
    $('ai-cancel').hidden = !job;
    $('ai-generate').textContent = job?.scope === 'all' ? '正在生成…' : result ? '重新生成' : '生成建议';
    $('ai-retry-resources').hidden = !result || !Object.entries(result.states || {}).some(([key, value]) => key !== 'copy' && value === 'error');
    $('ai-retry-resources').disabled = running || !currentResult;
    for (const key of scopes) {
      const checkbox = $('ai-apply-' + key), button = $('ai-regenerate-' + key);
      checkbox.disabled = running || !currentResult || !usable(key);
      checkbox.checked = choices[key] && usable(key);
      button.disabled = running || !currentResult;
      const status = $('ai-' + key + '-status');
      status.hidden = job?.scope !== key;
      status.textContent = job?.scope === key ? '正在更新本项建议…' : '';
      button.textContent = job?.scope === key ? '正在生成…' : result?.states?.[key] === 'error' ? '重试' : key === 'copy' ? '换一版' : key === 'music' ? '换一首' : '更换';
    }
    const count = scopes.filter(key => $('ai-apply-' + key).checked && !$('ai-apply-' + key).disabled).length;
    $('ai-selected-count').textContent = `已选择 ${count} 项`;
    $('ai-apply').disabled = running || blocked() || !currentResult || count === 0;
    $('ai-edit-copy').disabled = running || !currentResult;
    for (const key of ['music', 'hotspot']) {
      const button = $('ai-edit-' + key + '-prompt');
      button.disabled = running;
      button.dataset.custom = String(!!prompts()[key]);
      button.title = (prompts()[key] ? '已自定义 · ' : '') + `编辑${labels[key]}提示词`;
    }
    for (const button of $('ai-images').querySelectorAll('button')) button.disabled = running;
  }

  // renderImages 保持勾选圆圈在缩略图右下角；状态未变化时不重建图片节点。
  function renderImages() {
    const values = images();
    selected = new Set([...selected].filter(id => values.some(asset => asset.id === id)));
    $('ai-image-section').hidden = !useImages || !values.length;
    $('ai-images').hidden = !expanded;
    $('ai-image-count').textContent = `已选择 ${selected.size} / 6 张`;
    $('ai-toggle-images').textContent = expanded ? '收起图片' : '选择图片';
    $('ai-toggle-images').setAttribute('aria-expanded', String(expanded));
    $('ai-image-hint').textContent = current().kind === 'video' ? '视频作品使用作品信息生成文案。' : '仅将勾选图片的缩略图发送至图库配置的 AI。';
    const signature = JSON.stringify([values.map(item => [item.id, item.name]), [...selected]]);
    if (renderedImages !== signature) {
      renderedImages = signature; $('ai-images').replaceChildren();
      for (const asset of values) {
        const card = node('div', 'ai-image-card'), frame = node('div', 'ai-image-frame'), image = node('img');
        image.src = mediaURL(asset); image.alt = asset.name; image.loading = 'lazy';
        const toggle = node('button', 'ai-image-toggle'); toggle.type = 'button';
        toggle.setAttribute('aria-label', `${selected.has(asset.id) ? '取消选择素材' : '选择素材'} ${asset.name}`);
        toggle.setAttribute('aria-pressed', String(selected.has(asset.id)));
        toggle.append(node('span', 'ai-image-circle', selected.has(asset.id) ? '✓' : ''));
        toggle.onclick = () => {
          if (job || applying) return;
          if (selected.has(asset.id)) selected.delete(asset.id);
          else if (selected.size < 6) selected.add(asset.id);
          else { $('ai-status').textContent = '最多选择 6 张图片，请先取消一张。'; return; }
          clearResult(); renderImages(); controls();
        };
        frame.append(image, toggle); card.append(frame, node('span', 'ai-image-name', asset.name)); $('ai-images').append(card);
      }
    }
    controls();
  }
  function stopAudio() { $('ai-result-audio').pause(); }
  function clearResult() {
    job?.controller.abort(); job = null; assistant.cancel(); result = null;
    $('ai-result').hidden = true; $('ai-empty').hidden = false; stopAudio(); $('ai-result-audio').removeAttribute('src'); controls();
  }

  // 完整生成默认保留手选资源；单项重推只更新该项的勾选，不重置其他已确认选择。
  function chooseDefaults(scope = 'all') {
    for (const key of scopes) {
      if (scope !== 'all' && key !== scope) continue;
      const existing = key === 'activity' ? current().activities?.length : current()[key];
      choices[key] = usable(key) && (key === 'copy' || !existing);
    }
  }
  function scopeWarning(key) {
    return (result?.warnings || []).filter(item => item.scope === key || item.scope === 'resources' && ['music', 'location'].includes(key)).map(item => item.message).join(' ');
  }
  function renderResult() {
    $('ai-result').hidden = !result;
    $('ai-empty').hidden = !!result;
    if (!result) { controls(); return; }
    $('ai-result-title').textContent = result.title;
    $('ai-result-description').textContent = result.description;
    const location = result.location, music = result.music, activity = result.activity, hotspot = result.hotspot;
    $('ai-result-location').textContent = location ? `${location.cityName} · ${location.name}` : '暂无可靠的位置建议';
    $('ai-location-reason').textContent = scopeWarning('location') || [location?.address, location?.reason].filter(Boolean).join(' · ');
    $('ai-result-music').textContent = music ? `${music.name}${music.author ? ' · ' + music.author : ''}` : '暂无合适配乐';
    $('ai-music-reason').textContent = scopeWarning('music') || music?.reason || result.analysis?.music?.style || '';
    $('ai-result-activity').textContent = activity?.name || (result.states?.activity === 'error' ? '活动建议未完成' : '不参加活动');
    $('ai-activity-reason').textContent = scopeWarning('activity') || (activity ? `带入话题：#${activity.topic.name}${activity.reason ? ' · ' + activity.reason : ''}` : '当前活动与作品主题不匹配，可保留不参加。');
    $('ai-result-hotspot').textContent = hotspot?.name || (result.states?.hotspot === 'error' ? '热点建议未完成' : '不关联热点');
    $('ai-hotspot-reason').textContent = scopeWarning('hotspot') || hotspot?.reason || '当前热点与作品相关性不足。';
    for (const key of ['location', 'music', 'activity', 'hotspot']) {
      const existing = key === 'activity' ? (current().activities || []).map(item => item.name).join('、') : key === 'hotspot' ? current().hotspot : current()[key]?.name;
      $('ai-existing-' + key).textContent = existing ? `保留当前：${existing}；勾选后替换。` : '';
    }
    const audio = $('ai-result-audio'), source = assistant.isCurrent(result, 'music') ? safeURL(music?.previewURL) : '';
    audio.hidden = !source;
    if ((audio.getAttribute('src') || '') !== source) { stopAudio(); if (source) audio.src = source; else audio.removeAttribute('src'); }
    $('ai-warnings').replaceChildren();
    controls();
  }
  function input() {
    const firstImage = current().assets.find(asset => asset.kind === 'image');
    const source = firstImage && !firstImage.localOnly ? assetDetail(firstImage.id) : null;
    const assetIds = useImages ? images().filter(asset => selected.has(asset.id)).map(asset => asset.id) : [];
    if (useImages && !assetIds.length) throw Error('请至少勾选一张图片，或关闭图片分析并填写作品信息。');
    if (!$('ai-context').value.trim() && !assetIds.length && !source?.directoryName) throw Error('请填写作品信息，或开启图片分析并勾选图片。');
    return {baseURL, prompt: $('ai-prompt').value || defaultPrompt, assetIds, kind: current().kind, dateTag: source?.dateTag || '',
      resourcePrompts: {...prompts()}, context: JSON.stringify({type: current().kind === 'image' ? '图文' : '视频', work: $('ai-context').value.trim(), directoryName: source?.directoryName || '', dateTag: source?.dateTag || ''})};
  }

  // run 只调用用户点选的阶段；单项失败不隐藏此前完成的其他建议。
  async function run(scope = 'all') {
    if (job || applying) return;
    let request;
    try { if (scope === 'all') request = input(); }
    catch (error) { $('ai-status').textContent = error.message; return; }
    const task = {scope, controller: new AbortController()}; job = task; controls();
    $('ai-status').textContent = scope === 'all' ? '正在生成建议…' : `正在更新${labels[scope] || '资源'}建议…`;
    try {
      const options = {signal: task.controller.signal, onProgress: value => { if (job === task) $('ai-status').textContent = value.message; }};
      const value = scope === 'all' ? await assistant.generate(request, options) : scope === 'resources' ? await assistant.retryResources(result, options)
        : await assistant.regenerate(result, scope, {...options, ...(['music', 'hotspot'].includes(scope) ? {prompt: prompts()[scope] || ''} : {})});
      if (job !== task || task.controller.signal.aborted) return;
      const previous = result; result = value;
      if (scope === 'all') chooseDefaults();
      else if (scope === 'resources') { for (const key of scopes) if (previous?.states?.[key] === 'error') chooseDefaults(key); }
      else if (previous?.states?.[scope] === 'error') chooseDefaults(scope);
      renderResult();
      $('ai-status').textContent = value.warnings?.length ? '建议已生成，未完成的项目可单独重试。' : '建议已生成，请选择需要应用的内容。';
    } catch (error) {
      if (job !== task) return;
      $('ai-status').textContent = error.name === 'AbortError' ? '已取消，已有建议和填写内容已保留。' : error.message || 'AI 生成失败，请重试。';
    } finally {
      if (job === task) { job = null; controls(); }
    }
  }
  function cancelPending() {
    job?.controller.abort(); job = null; assistant.cancelPending(); stopAudio(); controls();
  }
  function close() {
    cancelPending(); inputPanel.hidden = true; suggestions.hidden = true; document.body.classList.remove('ai-assistant-open');
    $('open-ai').setAttribute('aria-expanded', 'false');
    for (const id of ['ai-resource-prompt-dialog', 'ai-copy-dialog']) if ($(id).open) $(id).close();
  }

  // sync 切稿清除临时结果，已保存的用户背景和本项提示词按草稿恢复。
  function sync() {
    if (draftId !== current().id) {
      clearResult(); close(); draftId = current().id; selected.clear(); useImages = false; expanded = false; renderedImages = '';
      $('ai-use-images').checked = false;
      $('ai-context').value = current().aiContext || '';
      $('ai-prompt').value = currentPrompt(preferences().aiPrompt);
    }
    if (result && !assistant.isCurrent(result)) {
      $('ai-status').textContent = '作品素材已变化，请重新生成建议。';
    } else if (result && ['music', 'activity'].some(key => !assistant.isCurrent(result, key))) {
      $('ai-status').textContent = '账号已切换，音乐和官方活动可分别重新推荐，其他建议可继续使用。';
    }
    if (visible()) { renderImages(); renderResult(); }
  }
  $('ai-close').onclick = close;
  $('ai-toggle-input').onclick = () => {
    const body = $('ai-input-body');
    body.hidden = !body.hidden;
    $('ai-toggle-input').setAttribute('aria-expanded', String(!body.hidden));
    $('ai-input-toggle-label').textContent = body.hidden ? '展开' : '收起';
  };
  $('ai-cancel').onclick = () => { cancelPending(); $('ai-status').textContent = '已取消，已有建议和填写内容已保留。'; };
  $('ai-use-images').onchange = event => {
    useImages = event.target.checked;
    if (useImages && !selected.size && images().length) selected.add(images()[0].id);
    expanded = useImages; clearResult(); renderImages();
  };
  $('ai-toggle-images').onclick = () => { expanded = !expanded; renderImages(); };
  $('ai-context').oninput = () => { savePreferences({aiContext: $('ai-context').value}); clearResult(); };
  $('ai-prompt').oninput = () => { savePreferences({aiPrompt: $('ai-prompt').value}); clearResult(); };
  $('ai-reset-prompt').onclick = () => { $('ai-prompt').value = defaultPrompt; savePreferences({aiPrompt: defaultPrompt}); clearResult(); };
  $('ai-generate').onclick = () => { void run(); };
  $('ai-retry-resources').onclick = () => { void run('resources'); };
  for (const key of scopes) {
    $('ai-apply-' + key).onchange = event => { choices[key] = event.target.checked; controls(); };
    $('ai-regenerate-' + key).onclick = () => { void run(key); };
  }

  // 铅笔按钮仅编辑偏好；保存不请求模型，之后“换一首/更换”才执行本项推荐。
  for (const key of ['music', 'hotspot']) $('ai-edit-' + key + '-prompt').onclick = () => {
    promptScope = key; promptDraftId = current().id;
    $('ai-resource-prompt-title').textContent = key === 'music' ? '音乐推荐提示词' : '热点推荐提示词';
    $('ai-resource-prompt').value = prompts()[key] || '';
    $('ai-resource-prompt-hint').textContent = `仅用于${key === 'music' ? '音乐' : '热点'}推荐，留空则使用作品信息中的统一要求。`;
    $('ai-resource-prompt').placeholder = key === 'music' ? '例如：优先纯音乐，舒缓、有山野感，不要人声。' : '例如：只选与徒步、自然风景直接相关的热点，没有合适的就不关联。';
    $('ai-resource-prompt-dialog').showModal(); $('ai-resource-prompt').focus();
  };
  for (const id of ['ai-resource-prompt-close', 'ai-resource-prompt-cancel']) $(id).onclick = () => $('ai-resource-prompt-dialog').close();
  $('ai-resource-prompt-save').onclick = () => {
    if (promptScope && promptDraftId === current().id) {
      savePreferences({aiResourcePrompts: {...prompts(), [promptScope]: $('ai-resource-prompt').value.trim()}});
      $('ai-status').textContent = `${labels[promptScope]}提示词已保存，点击“${promptScope === 'music' ? '换一首' : '更换'}”后使用。`;
    }
    $('ai-resource-prompt-dialog').close(); controls();
  };
  $('ai-edit-copy').onclick = () => {
    if (!result || !assistant.isCurrent(result)) return;
    copyDialogResult = result; $('ai-copy-message').textContent = '';
    $('ai-copy-title').value = result.title; $('ai-copy-description').value = result.description;
    $('ai-copy-dialog').showModal(); $('ai-copy-title').focus();
  };
  for (const id of ['ai-copy-close', 'ai-copy-cancel']) $(id).onclick = () => $('ai-copy-dialog').close();
  $('ai-copy-save').onclick = () => {
    if (copyDialogResult === result && assistant.isCurrent(result)) {
      try { assistant.editCopy(result, {title: $('ai-copy-title').value, description: $('ai-copy-description').value}); }
      catch (error) { $('ai-copy-message').textContent = error.message; return; }
      renderResult();
    }
    $('ai-copy-dialog').close();
  };
  $('ai-apply').onclick = async () => {
    if (job || applying || blocked() || !result || !assistant.isCurrent(result)) return;
    const value = result, selection = Object.fromEntries(scopes.map(key => [key, choices[key] && usable(key)]));
    applying = true; controls();
    try {
      if (await apply(value, selection)) {
        for (const key of scopes) if (selection[key]) choices[key] = false;
        $('ai-status').textContent = '所选建议已填入作品。'; renderResult();
      }
    } catch (error) { $('ai-status').textContent = error.message || '应用失败，建议已保留。'; }
    finally { applying = false; controls(); }
  };
  return {
    open() { sync(); inputPanel.hidden = false; suggestions.hidden = false; document.body.classList.add('ai-assistant-open'); onOpen(); $('open-ai').setAttribute('aria-expanded', 'true'); renderImages(); renderResult(); },
    sync, cancel: cancelPending,
    dispose() { cancelPending(); assistant.dispose(); },
  };
}

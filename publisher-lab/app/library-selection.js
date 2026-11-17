// selectionFailure 只向界面返回可操作说明，不把宿主内部诊断当作素材身份。
function selectionFailure(code, message) { return Object.assign(Error(message), {code}); }

// selectLibraryAssets 保存草稿后交给宿主来源网格选择，返回已核验素材，不直接修改草稿。
export async function selectLibraryAssets({target = 'media', context, currentDraft, save, post, resolveAssets, imageLimit = 35}) {
  if (context?.nativeUIAvailable !== true || context?.nativeCapabilities?.mediaSelectionVersion !== 1) {
    throw selectionFailure('MEDIA_SELECTION_UNAVAILABLE', '当前 App 尚不支持从来源选择素材，请更新 App 后重新打开工作台。');
  }
  if (!['media', 'cover'].includes(target)) throw selectionFailure('MEDIA_SELECTION_INVALID', '素材选择目标无效。');
  const original = currentDraft(), draftId = original.id, draftKind = original.kind;
  const kind = target === 'cover' ? 'image' : draftKind;
  const limit = target === 'cover' || kind === 'video' ? 1 : Math.min(35, Math.max(1, Number.isInteger(imageLimit) ? imageLimit : 35));
  const excludeAssetIDs = target === 'cover' ? [] : [...new Set(original.assets.map(asset => asset.id))];
  const maximumCount = limit - excludeAssetIDs.length;
  if (maximumCount < 1) throw selectionFailure('MEDIA_SELECTION_FULL', '当前作品素材数量已达上限，请先移除素材。');
  if (await save() !== true) throw selectionFailure('MEDIA_SELECTION_SAVE_FAILED', '草稿未能保存，暂不离开工作台。请先保存成功后再选择素材。');
  // 保存等待期间也可能发生外部草稿切换；这时不能把来源选择挂到另一份作品。
  if (currentDraft().id !== draftId || currentDraft().kind !== draftKind) throw selectionFailure('MEDIA_SELECTION_STALE', '作品已变化，请重新选择素材。');
  const response = await post({op: 'assets.select', kind, maximumCount, excludeAssetIDs});
  if (response?.ok !== true) throw selectionFailure(response?.error?.code || 'MEDIA_SELECTION_FAILED', response?.error?.message || '素材选择未完成，请重试。');
  const result = response.data;
  if (typeof result?.cancelled !== 'boolean') throw selectionFailure('MEDIA_SELECTION_INVALID', '素材选择结果无法确认，请重试。');
  if (result.cancelled) return {cancelled: true, target, draftId, assets: []};
  if (currentDraft().id !== draftId || currentDraft().kind !== draftKind) throw selectionFailure('MEDIA_SELECTION_STALE', '当前作品已变化，所选素材未加入。请重新选择。');
  if (!Array.isArray(result.assetIDs) || result.assetIDs.some(id => typeof id !== 'string' || !id || id.length > 300 || /[\x00-\x1f\x7f]/.test(id))) {
    throw selectionFailure('MEDIA_SELECTION_INVALID', '素材选择结果包含无效身份，请重新选择。');
  }
  const ids = [...new Set(result.assetIDs)];
  if (ids.length > maximumCount) throw selectionFailure('MEDIA_SELECTION_FULL', '所选素材超过剩余数量，请重新选择。');
  const existing = new Set(target === 'cover' ? [] : currentDraft().assets.map(asset => asset.id));
  const incoming = ids.filter(id => !existing.has(id));
  if (!incoming.length) return {cancelled: false, target, draftId, assets: []};
  const resolved = await resolveAssets(incoming);
  if (currentDraft().id !== draftId || currentDraft().kind !== draftKind) throw selectionFailure('MEDIA_SELECTION_STALE', '当前作品已变化，所选素材未加入。请重新选择。');
  if (!Array.isArray(resolved) || resolved.length !== incoming.length || resolved.some(asset => !asset?.id || asset.kind !== kind || typeof asset.name !== 'string')) {
    throw selectionFailure('MEDIA_SELECTION_INVALID', '部分素材不可用或类型不符，未加入作品。请在来源中重新选择。');
  }
  const currentIDs = new Set(target === 'cover' ? [] : currentDraft().assets.map(asset => asset.id));
  const assets = resolved.filter(asset => { if (currentIDs.has(asset.id)) return false; currentIDs.add(asset.id); return true; })
    .map(({id, name, kind}) => ({id, name, kind}));
  if (assets.length > limit - (target === 'cover' ? 0 : currentDraft().assets.length)) throw selectionFailure('MEDIA_SELECTION_FULL', '作品的剩余素材数量已变化，未加入所选素材。请重新选择。');
  return {cancelled: false, target, draftId, assets};
}

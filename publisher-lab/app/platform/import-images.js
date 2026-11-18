// usableUpload 只复用服务端确认完成的资源，不以本地预览或文件名判断上传成功。
function usableUpload(uploadFile) {
  return Boolean(uploadFile && typeof uploadFile.uri === 'string' && uploadFile.uri && uploadFile.uriStatus === 2000);
}

// cropIdentity 固定裁剪字段顺序；对象键的插入顺序不影响封面复用判断。
function cropIdentity(crop) {
  return JSON.stringify(['x', 'y', 'width', 'height'].map(key => crop?.[key]));
}

// importImages 在插件内完成资源上传与检查点，只在全部成功后构造发布资源快照。
// 调用方负责同一草稿的任务锁、账号验证及最终保存发布快照；本模块不调用页面组件或发布接口。
// checkpoint 必须在持久化提交后返回；即使某文件失败，也等待其他在途上传及检查点结束再抛错。
export async function importImages({job, account, origin, previous = [], base = null}, dependencies) {
  const {resolveAssets, prepareFile, uploadImage, cropCoverFile, buildImageDraft, checkpoint, onProgress, getAuth} = dependencies;
  if (typeof account !== 'string' || !account.trim()) throw Error('无法确认当前抖音账号，请重新登录后带入。');
  if (!job || (job.kind && job.kind !== 'image')) throw Error('本次带入不是图文任务。');
  if (typeof checkpoint !== 'function') throw Error('上传记录保存不可用，请重新打开插件。');

  // 仅上传资源记录进入持久化，不保留上传凭据、File 或页面内部对象。
  const records = Array.isArray(previous) ? structuredClone(previous) : [];
  let persistence = Promise.resolve(), authPromise, completed = 0;
  const stats = {total: 0, uploaded: 0, reused: 0, coverUploaded: 0, coverReused: 0, duplicates: 0};

  // progress 的显示失败不能令已成功上传的资源失去检查点或被误判为需要重新上传。
  async function progress(phase, asset, role = 'image', message) {
    try { await onProgress?.({phase, completed, total: stats.total, countRole: 'image',
      ...(asset ? {assetID: asset.id, assetId: asset.id, assetName: asset.name, role} : {}), ...(message ? {message} : {})}); } catch {}
  }

  // failed 只标记真正失败的这一项；用户取消及其他上传通道的结果保持各自状态。
  async function failed(error, asset, role = 'image') {
    if (!dependencies.signal?.aborted && error?.name !== 'AbortError') await progress('failed', asset, role, role === 'cover' ? '封面处理失败' : '图片处理失败');
  }

  // authorization 惰性获取本次账号的上传凭据，仅在内存中供本批次使用。
  function authorization() {
    authPromise ??= Promise.resolve().then(() => getAuth(account));
    return authPromise;
  }

  // reusable 要求账号、真实素材身份和文件版本完全一致；缺少版本时必须重新读取上传。
  function reusable(kind, asset, crop) {
    if (typeof asset.revision !== 'string' || !asset.revision) return undefined;
    return records.find(record => record.account === account && record.kind === kind &&
      record.assetID === asset.id && record.revision === asset.revision && usableUpload(record.uploadFile) &&
      (kind !== 'cover' || cropIdentity(record.crop) === cropIdentity(crop)));
  }

  // remember 每成功一项立即排队保存完整快照；后续成功项仍尝试保存，避免前一次保存失败阻断所有检查点。
  async function remember(kind, asset, uploadFile, crop) {
    if (!usableUpload(uploadFile)) throw Error('抖音未返回已完成的图片资源，请检查上传状态后重试。');
    const record = {account, kind, assetID: asset.id, revision: asset.revision ?? null, uploadFile: structuredClone(uploadFile)};
    if (kind === 'cover') record.crop = structuredClone(crop);
    const index = records.findIndex(old => old.account === account && old.kind === kind && old.assetID === asset.id);
    if (index >= 0) records[index] = record;
    else records.push(record);
    const snapshot = structuredClone(records);
    persistence = persistence.catch(() => {}).then(() => checkpoint(snapshot));
    await persistence;
    return record;
  }

  await progress('resolving');
  const resolution = await resolveAssets(job, origin), assets = resolution.assets;
  if (!Array.isArray(assets) || !assets.length || assets.length > 35 || new Set(assets.map(asset => asset.id)).size !== assets.length) {
    throw Error('请选择 1–35 张不同素材后重新带入。');
  }
  stats.total = assets.length;
  stats.duplicates = resolution.duplicates || 0;
  // 封面是独立图库引用；正文索引仅保留给已有调用方，不把外部封面插入正文清单。
  const explicitCover = job.settings?.coverAsset;
  const coverIndex = job.settings?.coverIndex;
  const source = explicitCover ?? (coverIndex !== undefined ? job.assets[coverIndex] : undefined);
  const crop = job.settings?.coverCrop;
  let coverJob, coverAsset;
  if (source !== undefined || coverIndex !== undefined || crop !== undefined) {
    if (!source || typeof source.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(source.id) ||
        explicitCover !== undefined && coverIndex !== undefined ||
        coverIndex !== undefined && (!Number.isInteger(coverIndex) || !crop) ||
        crop !== undefined && (!crop || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(crop[key])) ||
          crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0 ||
          crop.x + crop.width > 1.000001 || crop.y + crop.height > 1.000001)) {
      throw Error('封面选择或裁剪区域无效，请重新选择图库图片。');
    }
    coverJob = {...job, assets: [{id: source.id, name: source.name || '封面.jpg', kind: 'image'}]};
    const resolved = await resolveAssets(coverJob, origin);
    coverAsset = resolved.assets?.[0];
    if (resolved.assets?.length !== 1 || !coverAsset || coverAsset.kind !== 'image' ||
        typeof coverAsset.revision !== 'string' || !coverAsset.revision) throw Error('封面图片不可用或无法确认文件版本，请重新选择。');
    const bodyAsset = assets.find(item => item.id === coverAsset.id);
    if (bodyAsset && bodyAsset.revision !== coverAsset.revision || job.assets.some(item => item.id === source.id) && !bodyAsset) {
      throw Error('封面素材版本已变化，请重新准备。');
    }
  }

  // 读取、裁剪、上传和最终交付均复核同一图库源及版本，避免用旧记录绑定已变更的封面文件。
  async function verifyCoverSource() {
    if (!coverAsset) return;
    const current = await resolveAssets(coverJob, origin), asset = current.assets?.[0];
    if (current.assets?.length !== 1 || asset?.id !== coverAsset.id || asset.kind !== 'image' || asset.revision !== coverAsset.revision) {
      throw Error('封面源文件已变化，请重新准备。');
    }
  }
  const files = new Array(assets.length), missing = [];
  for (const [index, asset] of assets.entries()) {
    const saved = reusable('image', asset);
    if (saved) {
      files[index] = structuredClone(saved.uploadFile); stats.reused++; completed++;
      await progress('reused', asset);
    }
    else missing.push({index, asset});
  }

  // 每条通道只持有一个文件，读完立即上传；批次只保留元数据，不以总大小限制可发布的图片数量。
  if (missing.length) {
    let next = 0, failure;

    // 两条通道覆盖读取、上传和检查点整个生命周期；失败后不读下一张，已在途上传仍完成并保存。
    async function uploadNext() {
      while (!failure && next < missing.length) {
        const {index, asset} = missing[next++];
        let prepared;
        try {
          await progress('reading', asset);
          if (failure) return;
          prepared = await prepareFile(job, origin, asset);
          if (!prepared?.file || prepared.assetID !== asset.id || prepared.revision !== (asset.revision || null)) throw Error('素材读取不完整或版本已变化，请重新带入。');
          if (failure) return;
          const auth = await authorization();
          await progress('uploading', asset);
          if (failure) return;
          const result = await uploadImage(prepared.file, auth);
          // 成功响应只含远端资源元数据；在持久化前释放本地文件引用，下一张不会与上一张数据重叠驻留。
          prepared = null;
          const record = await remember('image', asset, result?.uploadFile);
          files[index] = structuredClone(record.uploadFile);
          stats.uploaded++;
          completed++;
          await progress('uploaded', asset);
        } catch (error) { failure ??= error; await failed(error, asset); }
        finally { prepared = null; }
      }
    }
    const settled = await Promise.allSettled(Array.from({length: Math.min(2, missing.length)}, () => uploadNext()));
    for (const result of settled) if (result.status === 'rejected') failure ??= result.reason;
    // 所有在途任务都已结算；这里抛错时调用方可以安全释放任务锁，不会发生迟到的检查点覆盖。
    if (failure) throw failure;
  }

  let cover;
  if (coverAsset) {
    try {
      const bodyIndex = assets.findIndex(item => item.id === coverAsset.id);
      // 正文中的原图封面继续复用已上传资源；外部图库封面及裁剪图独立上传和计数。
      if (!crop && bodyIndex >= 0) {
        cover = structuredClone(files[bodyIndex]); stats.coverReused++;
        await progress('reused', coverAsset, 'cover');
      }
      else {
        const saved = reusable('cover', coverAsset, crop);
        if (saved) {
          cover = structuredClone(saved.uploadFile); stats.coverReused++;
          await progress('reused', coverAsset, 'cover');
        }
        else {
          await progress(crop ? 'cropping' : 'reading', coverAsset, 'cover');
          let file;
          if (crop) file = await cropCoverFile(origin, coverAsset.id, crop);
          else {
            const prepared = await prepareFile(coverJob, origin, coverAsset);
            if (!prepared?.file || prepared.assetID !== coverAsset.id || prepared.revision !== coverAsset.revision) {
              throw Error('封面读取不完整或版本已变化，请重新准备。');
            }
            file = prepared.file;
          }
          await verifyCoverSource();
          const auth = await authorization();
          await progress('uploading', coverAsset, 'cover');
          const result = await uploadImage(file, auth);
          file = null;
          await verifyCoverSource();
          const record = await remember('cover', coverAsset, result?.uploadFile, crop);
          cover = structuredClone(record.uploadFile);
          stats.coverUploaded++;
          await progress('uploaded', coverAsset, 'cover');
        }
      }
      await verifyCoverSource();
    } catch (error) { await failed(error, coverAsset, 'cover'); throw error; }
  }

  await progress('staging');
  const draft = await buildImageDraft({base, job, files, cover});
  return {draft, records: structuredClone(records), stats,
    ...(coverAsset ? {coverSource: {source: structuredClone(coverJob.assets[0]), assetID: coverAsset.id, revision: coverAsset.revision}} : {})};
}

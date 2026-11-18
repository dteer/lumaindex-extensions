// completedVideo 只接收 transend 明确完成的完整结果；VOD 提交元数据不能证明转码完成。
// 原生轮询在 iterator 返回 false 时结束，因此 encode=0 表示继续处理，encode=1 才是已核实的就绪值。
function completedVideo(uploadFile, status) {
  let playback;
  try { playback = new URL(status.play_url); } catch {}
  if (status.encode !== 1 || !playback || !['https:', 'http:'].includes(playback.protocol) ||
      typeof status.format !== 'string' || !status.format) {
    throw Error('抖音尚未返回完整的视频播放信息，请稍后重新带入；已上传文件会继续复用。');
  }
  const video = {
    ...structuredClone(uploadFile),
    duration: Number(status.duration),
    width: Number(status.width),
    height: Number(status.height),
    coverUri: status.poster_uri,
    type: `video/${status.format}`,
  };
  if (!['duration', 'width', 'height', 'size'].every(key => Number.isFinite(video[key]) && video[key] > 0) ||
      typeof video.coverUri !== 'string' || !video.coverUri || typeof video.name !== 'string' || !video.name ||
      !/^video\/[a-zA-Z0-9.+-]+$/.test(video.type)) {
    throw Error('抖音尚未返回完整的视频信息，请稍后重新带入；已上传文件会继续复用。');
  }
  return video;
}

// importVideo 只处理用户本次主动带入的视频；上传完成立即保存资源，随后最多等待三分钟平台转码。
// 失败重试先按账号、素材身份与文件版本复用已上传 VID，不重复提交媒体，不自动发布作品。
export async function importVideo({job, account, origin, previous = [], base = null}, dependencies) {
  const {resolveAssets, prepareFile, uploadVideo, getAuth, enableVideo, getVideoStatus, checkpoint, onProgress, buildVideoDraft} = dependencies;
  const now = dependencies.now || Date.now;
  const wait = dependencies.wait || (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  if (typeof account !== 'string' || !account.trim()) throw Error('无法确认当前抖音账号，请重新登录后带入。');
  if (job?.kind !== 'video' || !Array.isArray(job.assets) || job.assets.length !== 1) throw Error('请选择一个视频后重新带入。');
  if (typeof checkpoint !== 'function') throw Error('上传记录保存不可用，请重新打开插件。');
  const records = Array.isArray(previous) ? structuredClone(previous) : [];
  const stats = {total: 1, uploaded: 0, reused: 0};

  // progress 为可选状态展示；页面关闭不能改变资源上传与保存结果。
  async function progress(phase, asset, message) {
    try { await onProgress?.({phase, completed: ['ready', 'staging'].includes(phase) ? 1 : 0, total: 1, countRole: 'video',
      ...(asset ? {assetID: asset.id, assetId: asset.id, assetName: asset.name, role: 'video'} : {}), ...(message ? {message} : {})}); } catch {}
  }

  // persist 保留同一账号、素材的最新资源，调用方提交成功后才进入下一阶段。
  async function persist(record) {
    const index = records.findIndex(old => old.account === account && old.kind === 'video' && old.assetID === record.assetID);
    if (index >= 0) records[index] = structuredClone(record);
    else records.push(structuredClone(record));
    await checkpoint(structuredClone(records));
  }

  await progress('resolving');
  const resolution = await resolveAssets(job, origin), asset = resolution.assets?.[0];
  if (!asset || resolution.assets.length !== 1 || typeof asset.revision !== 'string' || !asset.revision) {
    throw Error('无法确认视频文件版本，请检查图库素材后重新带入。');
  }
  let record;
  try {
    record = records.find(old => old.account === account && old.kind === 'video' && old.assetID === asset.id &&
      old.revision === asset.revision && typeof old.uploadFile?.vid === 'string' && old.uploadFile.vid);
    if (record) { record = structuredClone(record); stats.reused++; await progress('reused', asset); }
    else {
      await progress('reading', asset);
      const file = await prepareFile(job, origin, asset);
      if (!file?.file || file.assetID !== asset.id || file.revision !== asset.revision) {
        throw Error('视频读取不完整或版本已变化，请重新带入。');
      }
      const auth = await getAuth(account);
      await progress('uploading', asset);
      const result = await uploadVideo(file.file, auth);
      if (typeof result?.vid !== 'string' || !result.vid || result.uploadFile?.vid !== result.vid) {
        throw Error('抖音未确认视频资源，请检查上传结果后重试。');
      }
      record = {
        account,
        kind: 'video',
        assetID: asset.id,
        revision: asset.revision,
        uploadFile: structuredClone(result.uploadFile),
        videoMeta: structuredClone(result.videoMeta || {}),
        enabled: false,
        ready: false,
      };
      await persist(record);
      stats.uploaded++;
      await progress('uploaded', asset);
    }

    // 复用就绪状态还必须有相同资源的完整 transend 证明；单独的布尔标记不能证明平台已处理完成。
    let confirmed = false;
    if (record.ready === true && record.enabled === true && record.transcode?.encode === 1) {
      try { record.uploadFile = completedVideo(record.uploadFile, record.transcode); confirmed = true; } catch {}
    }
    if (!confirmed) {
      record.ready = false;
      await progress('processing', asset);
      // 原生流程在查询前显式 enable 媒体；只有业务成功后保存标记，重试不会重复触发已确认的 enable。
      if (record.enabled !== true) {
        await enableVideo(record.uploadFile.vid);
        record.enabled = true;
        await persist(record);
      }
      const deadline = now() + 180000;
      // 此轮询只等待用户已提交的视频，不常驻后台；查询失败立即返回，已保存 VID 供下次显式重试。
      while (now() < deadline) {
        const status = await getVideoStatus(record.uploadFile.vid);
        if (!status || !Number.isInteger(status.encode)) throw Error('无法确认视频处理状态，请稍后重新带入；已上传文件会继续复用。');
        if (status.encode === 1) {
          record.uploadFile = completedVideo(record.uploadFile, status);
          record.transcode = Object.fromEntries(['encode', 'duration', 'width', 'height', 'poster_uri', 'format', 'play_url']
            .map(key => [key, status[key]]));
          record.ready = true;
          await persist(record);
          break;
        }
        if (status.encode !== 0) throw Error('抖音返回了无法确认的视频处理状态，请检查原生页面；已上传文件会继续复用。');
        const remaining = deadline - now();
        if (remaining > 0) await wait(Math.min(1000, remaining));
      }
      if (!record.ready) throw Error('视频仍在抖音处理中，请稍后重新带入；已上传文件会继续复用。');
    }
    await progress('ready', asset);
  } catch (error) {
    if (!dependencies.signal?.aborted && error?.name !== 'AbortError') await progress('failed', asset, '视频处理失败');
    throw error;
  }

  await progress('staging');
  const draft = await buildVideoDraft({base, job, video: structuredClone(record.uploadFile)});
  return {draft, records: structuredClone(records), stats};
}

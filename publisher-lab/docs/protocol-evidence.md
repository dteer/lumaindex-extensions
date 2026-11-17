# 发布协议证据与适配边界

核对日期：2026-11-17。本文件只记录公开业务前端的短参数契约和本项目可复用模块，不包含第三方源码、Cookie、令牌、上传凭据或用户素材。第三方完整业务文件只在本次临时分析目录中，不能进入源码或发布包。

## 证据级别

- **已有实现**：从原扩展复制的图片/视频上传模块及查询模块有现有代码和历史验证记录；不代表新实验项目本轮已实机通过。
- **静态契约**：以下新查询、发布参数来自当日公开内容应用的业务模块；没有调用上传或发布接口验证。
- **实机只读验证**：2026-11-17 主线程在正常登录的创作者中心确认账号识别、话题搜索、用户搜索、音乐分类和音乐列表成功。此记录只描述能力与字段，不保存账号身份、个人信息、音乐名单或临时媒体地址。
- **待验证**：最终发布是否接受普通同源请求、平台要求的签名/二次验证、完整作品状态枚举、特殊账号能力及新发布回执。接口路径存在不等于接通。

页面发布请求明确使用 `needSign: true`、`withSecondVerify: true` 和 `retries: 0`。不得模拟、移植或绕过安全 SDK；普通请求遇到平台验证应停止并显示需要用户完成验证。超时或结果不明不得自动重发发布。

## 公开业务来源

内容入口：`https://creator.douyin.com/goofy/douyin_creator_pc/mono/creator_content`。

当日业务静态目录：`https://lf-fe-creator.douyinstatic.com/obj/douyn-creator-scm-cdn/douyin-creator-content-new/micro/static/js/`。

| 文件 | 业务证据 |
| --- | --- |
| `douyin_content_index_micro_new.e4059ace.js` | 图文和视频路由、内容子应用依赖 |
| `async/1060.b90137ce.js` | `create_v2`、请求配置、`item_id` 回执、媒体类型枚举 |
| `async/752.238ca8fe.js` | 图文 `beforePost` 字段组：文本、图片、封面、音乐、排期、合集、声明 |
| `async/6770.0977d9a9.js` | 视频字段组、`video_id`、音乐来源与封面 |
| `async/7290.7490bc7b.js` | 视频文本提交字段 |
| `async/9927.4365fc94.js` | 查询模块 9059、文本转换 58122、图文标题 66450、类型 36496、作品详情入口 |
| `async/358.f8a6866b.js` | 音乐分类、列表、链接校验、搜索与返回字段 |
| `async/2320.ab744159.js` | 根据名称获取真实话题 |
| `async/2998.27aa3310.js` | 按 `sec_uids` 获取 @ 用户 |

这里的模块编号仅用于复核本次静态证据，不得让运行时依赖、调用或注入平台模块。

## 不依赖原生草稿的上传模块

| 本项目接口 | 输入 | 输出和完成语义 |
| --- | --- | --- |
| `uploadImage(file, auth, options)` | JPEG/PNG/WebP Blob；短期上传授权；可注入 `fetch`、`signal` | `{uri, bytes, uploadFile}`；已核对 CRC、MD5、服务端 `uriStatus=2000`。`uploadFile` 含图片尺寸。只代表图片已上传 |
| `uploadVideo(file, auth, options)` | MP4/MOV/WebM Blob；短期授权；可注入请求/取消 | `{vid, bytes, uploadFile, videoMeta}`；上传提交成功，尚不代表转码完成 |
| `importImages(input, dependencies)` | 账号、素材身份与版本、旧成功记录、依赖注入 | 复用账号/素材版本匹配的资源，两条单素材流水线；最后调用可替换的草稿构造器。可抽出准备资源结果，避免生成或写入平台草稿 |
| `importVideo(input, dependencies)` | 同上；额外 `enableVideo`、`getVideoStatus` | 上传即保存 VID，再显式 enable 并等待 transend；确认 `encode=1` 及尺寸、时长、播放和封面信息后才就绪 |

原扩展的 `draftStorage`、准备页 CSP、导航原生编辑器、`verifyDraftRender` 属于旧草稿交接层。新实验项目的 `worker.js` 使用独立准备与提交编排，不写原生草稿；准备完成仍不等于发布成功。

已有同源 creator 请求：

- `GET /web/api/media/user/info/?device_platform=web`：业务成功后读取 `user.uid`，调用前后核对账号。
- `GET /web/api/media/upload/auth/v5/`：短期上传授权仅在内存中；不可进入日志、状态或文档。
- `GET /web/api/media/video/enable/?video_id=...`：现有上传流程显式启用视频；这不是作品发布。
- `GET /web/api/media/video/transend/?video_id=...`：`encode=0` 表示处理中，`encode=1` 才读取完整视频结果。
- 地点与普通合集继续沿用 `browser/location.js`、`browser/collection.js` 的固定同源查询及现有响应校验。

## 新查询接口的静态契约

全部相对 `https://creator.douyin.com`，除明确标注的音乐搜索外。仅允许固定白名单，参数逐项校验，不能接受任意 URL。

| 用途 | 方法、路径和参数 | 业务返回中使用的字段 |
| --- | --- | --- |
| @ 搜索 | `GET /web/api/v2/discover/search/`；`keyword,cursor,scene=1,search_source=publish_web,count=10` | `user_list`：`uid,nickname,avatar_thumb.url_list,follow_status,follower_count,unique_id,short_id`；`cursor,has_more`。静态调用方下一游标为返回 cursor 加 count，实测前不要另造分页规则 |
| 最近联系人 | `GET /web/api/v2/user/recent/contact/` | `user_list`，同上 |
| 指定 @ 用户 | `GET /web/api/media/user/mention/list`；`sec_uids` 按重复查询键编码 | `user_list` 或 `userList`；这是按身份解析，不是按关键词搜索 |
| 话题建议 | `GET /aweme/v1/search/challengesug/`；`keyword,source=challenge_create,aid=2906` | `sug_list`：`cha_name,cid,view_count,entrance_desc`；`cursor,has_more`。无真实 cid 的自填文字不可展示成已关联话题 |
| 名称转话题 | `GET /web/api/media/hashtag/get/`；`challenge_names=JSON.stringify(names)` | `challenge_list`，按 `cha_name` 匹配真实条目；未返回的名称不编造身份 |
| 推荐话题 | `GET /web/api/media/hashtag/rec/` | `challenge_list`；具体推荐上下文参数尚未收敛 |
| 音乐分类 | `GET /web/api/media/music/category` | `categories`；分类具有 `type,category_id`。实机确认 `type` 是 `recommend/rank/fav/category` 字符串，不能转换为数字 |
| 音乐列表 | `GET /web/api/media/music/list`；`cursor,count=20,category_id,type,creation_id` | `songs`：`music_id,music_name,music_author,duration,play_url,cover_url,user_count`；`cursor,has_more`。实机确认列表返回 20 项、`duration` 单位为秒；未据此验证每个分类、分页或链接校验 |
| 抖音音乐链接 | `GET /web/api/media/music/validate/`；`url`（页面先验证 `https://v.douyin.com/...`） | 成功返回 `music_id,music_name,music_author,cover_url`；不要自行设置 duration/play_url 为真实值 |
| 关键词音乐搜索 | `GET https://tsearch.amemv.com/openapi/aweme/v1/music/search/`；`keyword,cursor,count=20,aid,search_source=normal_search` | `music`，使用 `id_str,title,author,duration,play_url,cover_thumb`；`cursor,has_more`。原网页还要求授权请求头，本实验未验证授权取得流程，不能用伪造值接入或宣称可用 |
| 作品详情 | `GET /web/api/media/item/info/`；`item_id` | `aweme,activity_list`；业务调用读取 `aweme.timer.status` 和 `aweme.timer.public_time`。定义在 9927 模块 44495，真实调用在 8261 模块 98261 及 1060。状态枚举数值和发布回执关联仍待验证，不能把转码状态当作品状态 |

## 发布请求的静态契约

`POST /web/api/media/aweme/create_v2/?read_aid=2906`，`Content-Type: application/json`，顶层为 `{item: {...各字段组}}`。字段组由页面 `beforePost` 验证后合并。页面还可能执行其他按账号能力开启的字段钩子，所以以下是已核实字段，不是保证足够发布的最小完整请求。

| 字段 | 已观察到的含义 |
| --- | --- |
| `item.common.media_type` | 图文 2；视频 4 |
| `item.common.creation_id` | 本次创作身份；不能复用为猜测的平台作品 ID |
| `item.common.images` | 图文数组 `{uri,width,height}`，来自上传成功的 `uploadFile.uri/imageWidth/imageHeight` |
| `item.common.video_id` | 视频已上传且平台转码就绪的 VID |
| `item.common.visibility_type` | 0 公开、2 好友、1 仅自己可见 |
| `item.common.download` | 1 允许保存、0 不允许 |
| `item.common.timing` | 定时发布时间的 Unix 秒数；立即发布省略，不传草稿中的日期字符串 |
| `item.common.music_id` | 用户选择的真实音乐身份 |
| `item.common.music_end_time` | 图文音乐时长秒数乘 1000；未核实不要猜时长 |
| `item.common.music_source` | 视频已有实现根据所选音乐来源填写；来源枚举尚未完整核实 |
| `item.cover.upload_poster` | 自定义上传封面的 URI |
| `item.cover.poster` | 已有平台封面 URI；与自上传字段区分。视频默认使用 transend 的 `poster_uri`，经适配层命名为 `coverUri` |
| `item.cover.poster_delay` | 视频封面的秒数；默认首帧为 0，帧选取时间需从毫秒转换。帧选择尚未在当前 worker 启用 |
| `item.mix.mix_id` | 已核验的普通合集 ID |
| `item.mix.mix_order` | 图文页面对于定时保留 UI 序号，立即发布采用 UI 序号减一。需真实场景确认，禁止把 UI 值原样盲传 |
| `item.declare.user_declare_info` | 页面按用户声明控件转换得到；声明结构和条件尚未完整核实，不可用空值掩盖平台必填声明 |

文本提交有格式差异：

- 图文把标题加到正文前。标题范围为 `type=7`，标题未以中文句号结束时补 `。`，句号范围为 `type=8`。正文关联范围随前缀移动。最终 `common.text` 为完整文本。
- 视频使用 `common.item_title` 和 `common.caption`，`common.text` 为去边缘空白后的标题、空格、正文组合；无标题时只保留正文。必须同时调整关联范围。
- 两种类型的 `common.text_extra`、`activity`、`challenges`、`mentions` 在发布请求里是 **JSON 字符串**，不是草稿模型中的数组。`hashtag_source` 为来源用 `/` 拼接的字符串。
- 关联类型：`type=0` 为 @，含 `user_id`；`type=1` 为话题，含 `hashtag_id,hashtag_name`。范围使用前端 JS 字符串索引。图文标题和分隔符也占范围。静态转换还携带 `caption_start/caption_end`，不能只维护显示高亮。
- 关联必须来自真实查询结果。手工输入 `#文字` 不等于已关联话题，不能填虚构 ID。

补充精确字段（9927 业务模块 58122、66450、36496）：

| 编辑态关联 | 已观察到的字段 |
| --- | --- |
| @ 用户 | `start,end,type:0,hashtag_name:"",hashtag_id:0,user_id,at_source,extra`；使用查询返回的 uid，不是 sec_uid |
| 话题 | `start,end,type:1,hashtag_name,hashtag_id,user_id:"",extra` |
| 图文标题 | `start:0,end:title.length,type:7,hashtag_id:0,hashtag_name:""` |
| 补充中文句号 | `start:title.length,end:title.length+1,type:8,hashtag_id:0,hashtag_name:""` |

发布转换先按正文去掉的前导空白移动范围，生成 `caption_start/caption_end`；视频有标题时 `start/end` 再加去边缘空白后的标题长度加一个空格。删除每项 `extra`，把活动 `type=9` 转为提交的 `type=1`。

`activity` 是编辑态 type 9 且有 ID 的话题 ID 数组；`challenges` 是 type 1 或 9 且有 ID 的话题 ID 数组；`mentions` 是 type 0 且有 user_id 的用户 ID 数组；这些数组逐项保持真实身份并序列化成 JSON 字符串。`hashtag_source` 依次取话题编辑态 `extra.kind`，不存在时为 `search`，用 `/` 连接。

图文标题插入在上述正文转换之后：原样使用标题，若结尾没有 `。` 则补一个；已有正文关联的 `start/end` 加整个标题前缀长度，`caption_start/caption_end` 保留正文坐标。视频则 `item_title=title.trim()`、`caption=body.trim()`，有标题时 `text=item_title + " " + caption`，无标题时 `text=caption`。

## 本地适配核对

- 图片准备结果直接传递 `uploadFile` 数组；发布构造器只取 `uri,imageWidth,imageHeight` 并映射为 `uri,width,height`。裁剪封面单独上传，使用其返回的 URI，不改变正文图片资源，也不提交未核实的裁剪字段。
- 视频在 `encode=1` 后将真实转码结果转为 `vid,width,height,duration,coverUri`。不选择封面时使用平台首帧；选择图库上传封面时使用 `upload_poster`。这只证明本地字段衔接，不证明平台已接受发布请求。
- 话题与 @ 用户经 worker 重查后追加到正文末尾，按 UTF-16 字符串位置生成关联范围。测试涵盖中文、表情、正文原有同名文字、标题前缀与视频正文坐标。
- 图文音乐使用实查 `duration` 乘 1000；视频音乐、视频地点/合集、定时合集及作者声明仍明确拒绝。具体限制由当前能力清单与准备校验执行。

## 回执与失败语义

- 公开业务发布函数读取响应 `item_id`，并以此检查重复回执；该 ID 不是上传 `vid` 或图片 `uri`。
- `status_code=0` 和非空作品身份才有资格作为业务接受成功的证据。当前未验证原始响应层级，不要将网络 HTTP 200、页面跳转或素材上传成功直接当发布成功。
- 已接受、审核中、已发布、定时待发应分开。此轮静态分析未证明所有状态接口和枚举。
- 请求超时、连接断开或无完整回执应保存为“结果待确认”，保留请求身份和素材成功记录，不自动重发。
- 登录过期、权限不足、需要平台验证应保留作品草稿并停止。不得调用页面私有模块、复制安全实现或绕过平台保护。

本轮协议分析读取公开业务资源与本地实现；主线程另执行上述正常登录态的只读查询。没有读取 Cookie/凭据，没有上传或发布作品，没有验证最终发布接口。

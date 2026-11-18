# 发布协议证据与适配边界

核对日期：2026-11-18。本文件只记录公开业务前端的短参数契约和本项目可复用模块，不包含第三方源码、Cookie、令牌、上传凭据或用户素材。第三方完整业务文件只在本次临时分析目录中，不能进入源码或发布包。

## 证据级别

- **已有实现**：从原扩展复制的图片/视频上传模块及查询模块有现有代码和历史验证记录；不代表新实验项目本轮已实机通过。
- **静态契约**：以下新查询、发布参数来自当日公开内容应用的业务模块；没有调用上传或发布接口验证。
- **实机只读验证**：2026-11-17 主线程在正常登录的创作者中心确认账号识别、话题搜索、用户搜索、音乐分类和音乐列表成功。此记录只描述能力与字段，不保存账号身份、个人信息、音乐名单或临时媒体地址。
- **待验证**：最终发布是否接受普通同源请求、平台要求的签名/二次验证、完整作品状态枚举、特殊账号能力及新发布回执。接口路径存在不等于接通。

页面发布请求明确使用 `needSign: true`、`withSecondVerify: true` 和 `retries: 0`。不得模拟、移植或绕过安全 SDK；普通请求遇到平台验证应停止并显示需要用户完成验证。超时或结果不明不得自动重发发布。

## 浏览器请求上下文实测

2026-11-18 主线程在 Chrome 156 的官方首页及公开上传入口读取请求头白名单，子任务只读取脱敏字段，不读取原 HAR、请求正文、Cookie 或令牌。首页请求的 Referer 为 `https://creator.douyin.com/creator-micro/home`；上传入口请求的 Referer 为 `https://creator.douyin.com/creator-micro/content/upload?default-tab=3`。观察到同源业务 GET 使用 `Accept: application/json, text/plain, */*`，没有 Origin；页面自然发起的 JSON POST 包含 `Origin: https://creator.douyin.com`，其 Accept 为 `*/*`。这不是上传或发布请求验收。

该次 Chrome 观察只用于记录公开页面的请求契约，不作为当前插件的浏览器身份。当前全部平台 API 和上传请求改为 `browser.request`，由登录使用的同一账号持久 WebKit 环境，在插件选择的公开页面内执行 `window.fetch`。UA、语言、Cookie、Origin、Referer、Fetch Metadata 和其他 `Sec-*` 由实际浏览器生成，插件不再硬编码品牌、版本或合成浏览器头，也不依赖 `pluginContext.browserEnvironment` 生成请求。

平台插件 `platform/browser-request.js` 只选择公开创作者上传入口作为 `contextURL`，并传入会话 `origin` 与本次操作固定的 `profileId`。每次 dispatch 捕获候选或所选账号 ID，身份核验、资源查询、图片/视频上传和提交全过程沿用它，跨域 `credentials:omit` 请求仍绑定同一账号的网页环境。宿主负责校验当前档案和 manifest 网络权限，不内置抖音页面、ImageX/VOD 协议或平台头规则。请求在页面 `.page` world 执行，现有页面钩子可以参与；但这不保证任意安全签名、平台二次验证或最终发布自动成功。浏览器的 CORS、预检及跳转限制正常生效；失败不回退到 URLSession、代理或其他执行环境。

业务 JSON 查询（包含音乐、地点、合集）显式采用观测到的 Accept；已有显式 Accept、Content-Type 和签名头优先。发布仍使用其已核对的 `application/json` 正文契约，并未用上述页面自然 POST 代替发布验证。通用 fetch 传输仅对字符串补 `text/plain;charset=UTF-8`，对 Blob 沿用非空 MIME，原始字节不猜类型；本机媒体 API 和 HTML 音频不经过此业务默认头适配。

## 平台与宿主职责

平台登录入口由插件 `platform/session.js` 明确传入，当前选择创作者中心根页面；网页登录使用宿主真实 WebKit 默认 UA。新增账号调用 `session.login {origin,url}`，使用稳定的待核验网页容器；“重新登录当前账号”明确传 `profileId`，复用该账号的持久网页容器。Cookie、localStorage、IndexedDB 随该容器保存，API 快照的八小时上限不清除浏览器数据；这仍不保证平台不要求再次验证。

两种登录均先返回候选。重登真实账号必须与原账号一致，插件核验后才调用 `session.identify` 提交；不匹配或失败仅调用 `session.clear {origin,profileId,keepBrowserData:true}` 清理未识别的 API 候选并恢复原档案：新增重试保留稳定的待登录网页环境，重登则保留原账号共享容器，不将其转成新增槽。用户明确“移除当前账号”不带保留参数，仍彻底移除该账号网页数据。添加已存在账号返回 `SESSION_ACCOUNT_EXISTS`，提示选择已有账号重登。取消登录不会提交新的原生 API 快照或切换已选档案；持久网页已经发生的站点写入不作回滚承诺。平台身份识别、账号切换流程与上传/发布顺序均由插件执行。

插件要求 `sessionLoginOptionsVersion:1`、`networkHeadersVersion:1`、`persistentWebsiteSessionsVersion:1` 和 `browserRequestsVersion:1`；缺少任一能力即提示更新 App，登录和平台请求不会启动。manifest 只声明业务 Accept 和上传协议头，不再列浏览器管理的 UA、语言、Origin、Referer 或 `Sec-*`。`session.status` 和账号列表的 `browserSessionAvailable` 表示持久网站环境可用，不代表平台登录成功；插件仍实时核对实际账号。原生 Cookie 快照的 `hasCookies`/`expiresAt` 不再限制网页请求，八小时上限不会自动强制重登或清除持久网站数据。

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
| `async/2320.ab744159.js` | 手写话题转名称绑定（模块 35552）；名称查询与活动转换；官方活动卡片、第一项活动话题、游戏推广附加绑定及话题计数限制 |
| `async/5589.5bfb8a1d.js` | 无既存候选时显示“创建新话题”，使用数值 `hashtag_id:0` 与用户输入的名称 |
| `async/4660.e413ea00.js` | 模块 18559 的官方活动目录、分类、详情请求；详情展示字段 |
| `douyin_content_index_micro_new.8ef382dc.js` | 模块 23934 的话题与活动合计上限 `XK=5` |
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
| 话题建议 | `GET /aweme/v1/search/challengesug/`；`keyword,source=challenge_create,aid=2906` | `sug_list`：`cha_name,cid,view_count,entrance_desc`；`cursor,has_more`。既存话题保留真实 cid；官方编辑器另提供当前输入名称的显式绑定，使用下述 0 标记 |
| 名称转话题 | `GET /web/api/media/hashtag/get/`；`challenge_names=JSON.stringify(names)` | `challenge_list`，按 `cha_name` 匹配真实条目；未返回的名称不编造身份 |
| 推荐话题 | `GET /web/api/media/hashtag/rec/`；`frames` 为已上传图片 URI 按顺序逗号拼接 | `challenge_list`；仅使用本账号最近一次完整准备的图片快照，未上传不编造推荐 |
| 官方活动目录 | `GET /web/api/media/activity/get/`；官网传 `page=1,size=9999,need_challenge=1`，分类页可带 `query_tag` | `activity_list` 的 `activity_id,activity_name,challenge,challenge_ids,hot_score,cover_image,show_start_time,show_end_time,activity_status,game_id`；目录只提供第一项 `challenge[0]` 名称线索，`challenge_ids` 已有服务端精度丢失证据，不能用于发布 |
| 官方活动详情 | `GET /web/api/media/activity/detail/`；`activity_id` | `activity_info.activity_name`、`activity_description,topics,topics_ids,publish_start_time,publish_end_time,reward_rules`；准确身份来自字符串 `topics_ids` 与 `topics` 同索引配对；`reward_rules` 为 JSON 字符串，正文取其中 `text`，按文本展示，不执行 HTML |
| 音乐分类 | `GET /web/api/media/music/category` | `categories`；分类具有 `type,category_id`。实机确认 `type` 是 `recommend/rank/fav/category` 字符串，不能转换为数字 |
| 音乐列表 | `GET /web/api/media/music/list`；`cursor,count=20,category_id,type,creation_id` | `songs`：`music_id,music_name,music_author,duration,play_url,cover_url,user_count`；`cursor,has_more`。实机确认列表返回 20 项、`duration` 单位为秒；未据此验证每个分类、分页或链接校验 |
| 已选音乐身份详情 | `GET /web/api/media/music/info/`；`id` 为原音乐 ID | 已只读确认根层 `status_code:0,music_id,music_name,music_author,cover_url,extra`，`music_id` 为与请求完全一致的字符串；本次成功响应没有 `play_url,duration,is_pgc`，不能据此宣称获得音源或时长 |
| 抖音音乐链接 | `GET /web/api/media/music/validate/`；`url`（页面先验证 `https://v.douyin.com/...`） | 成功返回 `music_id,music_name,music_author,cover_url`；不要自行设置 duration/play_url 为真实值 |
| 音乐搜索授权 | `GET /web/api/media/aweme/search/post/auth` | `signature`；只在本次搜索内存中使用，不写入状态、日志或页面 |
| 关键词音乐搜索 | `GET https://tsearch.amemv.com/openapi/aweme/v1/music/search/`；`keyword,cursor,count=20,aid=1128,search_source=normal_search` | `music`：`id_str,title,author,duration,play_url.url_list,cover_thumb.url_list,user_count`；`cursor,has_more`。请求仅向固定域携带 `Agw-Auth` 和 `Openapi-Omit-Shark: 1`，不携带登录 Cookie，拒绝重定向 |
| 自主声明 | `GET /aweme/v3/user_declaration/suggestion/`；`scene=new_self_media_before_publish,creation_id,user_decl_judge_feats,libra_token=douyin_pc` | `data.options` 的 `choose_value,text,show_type` 及 `data.block_type`；1/2 表示必须选择，其他已知值0/3不强制 |
| 作品详情 | `GET /web/api/media/item/info/`；`item_id` | `aweme,activity_list`；业务调用读取 `aweme.timer.status` 和 `aweme.timer.public_time`。定义在 9927 模块 44495，真实调用在 8261 模块 98261 及 1060。状态枚举数值和发布回执关联仍待验证，不能把转码状态当作品状态 |

### 已选音乐按 ID 恢复

2026-11-18 官方调用方 `1899.aefbb9fb.js` 与 `9557.033735e6.js` 使用 `W3({id:e})` 请求音乐详情。主线程在正常登录的 Chrome 以原已选 ID 只读核验，HTTP 200 且 `status_code=0`，响应根层 `music_id` 为完全匹配的字符串，另含 `music_name,music_author,cover_url` 字符串及 `extra:{logid,now}`。本文件不保存原歌曲身份、名称或短期地址。实测响应未包含 `play_url`、`duration` 或 `is_pgc`；这里只能确认身份详情契约，音源与时长使用同一账号此前真实音乐查询的有限记录，不能从这些缺失字段编造默认值，也不能把身份查询成功视为音频可播放。

插件的 `music.resolve({id,refreshSource?:boolean})` 接受原音乐 ID 及显式音源刷新标志，拒绝名称、任意 URL 和附加查询策略；每次由 info 核验身份，响应身份必须完全相同，同 ID 的名称变化可以接受。该接口用于持久选择的恢复，名称搜索仍用于用户主动找新曲，不用于偷偷替换已选 ID。准备阶段在上传前后按 ID 重新核验；缺少经验证的发布时长、查询失败、账号变化或取消都不产生新的可发布资格。真实音乐列表或搜索查询返回的 `play_url` 与 `duration` 先进入当前账号的内存候选；用户明确选择时通过 `music.select({id,keepIds})` 按宿主档案、平台账号和音乐 ID 写入独立选曲记录，草稿仍只保存 `{id,name}`。恢复时先由 info 核对原 ID，再使用该记录的媒体信息。记录缺失时可使用同账号近期真实候选，否则最多读取推荐两页和收藏两页，查找精确 ID；音频失败后的显式重试传 `refreshSource:true`，通过同样边界更新音源，不能按名称搜索替换歌曲。找不到、音源失效或歌曲下架时保留原选择并提示重新选择，不承诺音乐永久可用。记录不包含 Cookie、会话凭据或音乐搜索授权。

选曲前复用在途草稿保存，仅有未保存修改或此前保存失败时才再次落盘；失败不替换原曲。`music.select` 保存同账号已查询候选，只检查本机档案和候选归属，不额外请求平台账号，也不因离线状态拒绝已有候选的本地保存。按钮在本地保存期间显示「保存中…」，列表续页不会清掉该状态或保存错误；关闭弹窗后的迟到回执不应用选曲。整页合成回归确认干净草稿选曲前零草稿写入、零平台请求，选曲后只保存一次修改后的草稿，失败保留原曲。

`keepIds` 包含最多 40 份草稿引用与新选 ID，最多 41 项，只清理同账号档案中不再引用的选曲记录。浏览候选最多 200 首、在内存保留 30 分钟；这只是新选择的数据来源期限，不是准备时复用旧核验的期限。独立持久选曲记录最多 128 项，无固定 TTL，不随浏览候选 LRU 淘汰；满额时拒绝新增，不挤掉已有选曲。`music.resolve` 补齐记录不会清理其他已选记录。

### 音乐分类目录与分页

`music.categories({kind:"image"})` 返回 `{items:[{id,name,type}]}`。名称、顺序和分类身份来自固定分类接口，不将“热门榜、收藏、飙升榜、原创榜”等文案写成虚构的平台选项。目录最多 100 项，空目录如实返回，异常结构报错；同一 `type/id` 去重，不同 `type` 可有相同 ID，数值 ID 只接受安全整数并保留合法的 0。

`music.search({kind:"image",query:"",categoryId,type,cursor})` 按真实目录匹配完整 `categoryId/type` 组合后请求该分类的列表。省略分类时优先首个 `recommend`，没有推荐分类时使用首个真实项；未返回的分类、错误组合和不完整分类参数都在请求音乐列表之前拒绝。目录按来源、宿主档案及账号缓存五分钟，切换分类及继续翻页共享目录，不逐次重读；每个分类页面的短缓存包含完整 `type/id/cursor`。歌曲列表每次 20 项，游标是平台位置令牌，原样沿用，不增加或比较数值大小。仅接受 1–30 位十进制字符串或非负安全整数；声明有更多但游标缺失、格式不可靠或与请求相同时显示可重试错误。

2026-11-18 主线程通过已登录 Chrome 只读确认：`category_id=1,type=fav,cursor=0` 返回字符串游标 `"1749660141636916"` 和布尔 `has_more:true`；将该字符串原样传入下一请求后，返回 `cursor:"",has_more:false`，两页均有正常歌曲。此处只记录分页元数据，不保存个人收藏音乐明细。公开 `358.f8a6866b.js` 的 `eQ` 将 `cursor:e.cursor,hasMore:e.has_more` 原样交给分页器 `B`，`B` 初始为 0，后续直接使用返回游标，没有递增判断或收藏专用算法。这证实原 12 位上限错误，也没有依据要求数值单调递增。终页空游标转换为 `nextCursor:null`，保留歌曲；不把已经失去精度的 JSON 数字转成字符串猜测原值。

有关键词时继续原音乐搜索授权链，分类参数不影响搜索，不读取分类目录；清空关键词后由界面恢复用户所选分类。目录及查询结果仍受取消和账号代际校验，迟到结果不能写回另一个账号。分类列表不写入草稿或持久缓存，草稿仍只保存真实音乐身份与显示名；试听恢复调用 `music.resolve({id})` 确认当前身份和名称，并读取同账号真实查询所得的有限音乐记录；缺失或显式刷新音源时，最多读取推荐和收藏各两页，按精确 ID 查找。准备阶段在上传前后分别按 ID 实时核验，不使用名称搜索或旧候选时效授予发布资格。图文之外的音乐能力尚未接入。本轮分类身份、跨页请求计数、缓存隔离、取消及失败重试均为离线合成回归，没有上传或发布。

2026-11-18 更新并安装工作台后，主线程在 App 内实测推荐、热门榜、收藏、飙升榜及原创榜均返回真实歌曲；收藏第二页保留首页并在终页停止加载。关键词搜索与清空后恢复原分类、分类左右箭头也已验证。音乐抽屉字体统一为发布页的标题 16 px、正文 14 px、辅助 12 px。此次验收保留原草稿的图片、正文、位置和已选音乐，没有上传、发布或调用真实 AI 模型。

同日修复部分搜索音乐无法试听：某平台返回的 HTTPS 音频在 WebKit 中触发媒体错误 4。只读 HTTP 对照中，同一 URL、Origin 和 Range，不带 Referer 返回 206，携带本机页面 Referer 返回 403；文件本身为有效 M4A/AAC LC 音频。插件文档加入 `referrer=no-referrer`，不向媒体 CDN 发送本机页面地址。实机原曲随后直接通过现有 HTMLAudio 播放，正确读取 23 秒时长且进度持续推进。没有修改音频地址、伪造平台来源、转码、扩大权限或引入媒体代理；正式安装包不含临时诊断弹窗。

随后单首推荐音乐出现 `00:00 / --:--` 与试听失败。只读重新查询得到同名、同作者的候选，其新音源在原生 WebKit 中正常加载约 30.6 秒时长并推进进度；未取得 App 当时失败的完整地址及 MediaError，不能据此断言原地址过期。已确认抽屉重试只重复旧地址，现改为真实媒体失败后的下一次用户点击调用 `music.resolve({id,refreshSource:true})`，严格保留原 ID，更新当前抽屉及分类页缓存，不改变草稿配乐选择。首次播放、普通暂停恢复及浏览器要求补充点击均不刷新；关闭、切曲会取消旧刷新，迟到结果不接管播放器。同地址也允许本次明确重试重新加载，不自动循环请求。合成整页回归覆盖坏音源、按 ID 刷新、真实播放进度及缓存回退；没有真实上传或发布。

### 官方活动实机只读核验与适配

2026-11-17 主线程通过已登录官方页面只读比较 `page=1,size=10` 与 `page=2,size=1`。两次均返回同一完整的 4 项目录，其中 2 项有话题，顶层只有 `activity_list`、`extra` 和 `status_code`，没有 `total`、`has_more` 或下一页字段。当前外部接口忽略分页参数，不能凭满页推测下一页，也不能在内存中截断目录来假装分页。它是平台提供的小型活动目录，不是本机数据库列表；后端业务列表的数据库分页规范仍不变。

工作台 `activities.list({kind,cursor:"0"})` 单次请求 `page=1,size=10,need_challenge=1`，响应文本限制 4 MiB、原始目录限制 200 项，完整验证后返回 `items,nextCursor:null,hasMore:false`；超过限制明确报错，不静默切片。没有活动话题的原始项不可选择，不能把过滤后的条数当作下一页依据。暂无官方文字搜索参数证据，页面只筛选已读目录。

同日主线程进一步只读核验活动 `7706830008333652992` 的详情：目录原始 `challenge_ids:[7655295256916658000]` 与详情 `topics:["宝藏经验分享计划"],topics_ids:["7655295256916658211"]` 不同。目录原文字面量已在服务端舍入，保留 JSON 大整数字面量也不能恢复真实身份。因此工作台完全忽略目录 `challenge_ids`；只接受详情中原生字符串 ID 与完整、等长 `topics` 数组配对。缺失、数字形式、长度不等、无效元素或重复身份均不能用于选择，不通过格式转换或名称猜测补救。以上值只作为协议证据，业务代码不硬编码活动或话题身份。

目录实体为 `{id,name,topicName,heat?,thumbnailURL?,startTime,endTime,disabled,description}`。`id` 来自活动身份，`topicName` 只是官方第一项话题的显示名称。时间是平台展示字符串，不推测时区或转换成到期秒数。已观察到可参加项 `activity_status=1`；公开 9145 bundle 的 `ActivityStatus` 和 `UgcActivityStatus` 枚举为 0 未开始、1 进行中、2 已结束、3 审核中、4 未通过。目录状态与共享枚举没有完整接口类型证明，因此只允许已确认值 1，其余或缺失均不可选择，不为未知值编造状态文案。带 `game_id` 的条目在官网触发额外游戏推广组件，目前显示为不可选择。

`activities.detail({id})` 返回展示信息 `{id,name,description,topics,topicChoices,startTime,endTime,rewardDescription}`，不编造详情网页链接；`topicChoices` 仅含严格配对后的 `{id,name}`。目录和详情浏览都不记录选择凭据。用户添加时调用 `activities.resolve({id})`：重新查询目录确认可参加状态，并仅请求这一个活动详情，按目录 `topicName` 精确匹配唯一详情话题，成功返回带 `topic:{id,name}` 的实体并记录本账号的选择凭据；列表不会逐项请求详情。

草稿仅保存 `activities:[{id,name,topic:{id,name}}]`；选择凭据按来源和账号保存在内存。准备上传之前和完成之后均实时重新读取目录和每个已选活动的详情，核对活动名称、准确话题身份及可参加状态。同一边界的多个活动共用一次目录复核，页面缓存不参与授权。旧草稿若持有舍入身份会要求重新选择，不能静默把一个身份替换成另一个身份；任何解析失败、账号切换或取消均不产生新的可发布凭据。

官方编辑器将普通话题与活动共同计数，最多 5 个。工作台将活动话题与已有同 ID 同名称话题合并一次；正 ID 相同但名称冲突、同名不同身份或超过 5 个均拒绝准备。不同名称的 0 话题分别计数。`common.activity` 保存去重后的活动**话题 ID**，`challenges` 仅包含有真实正 ID 的话题，活动的 `text_extra` 仍提交 `type=1`，`hashtag_source` 使用官网 `recommend`。这些静态映射与离线回归不代表已验证真实发布。

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
| `item.declare.user_declare_info` | 普通单选声明为 JSON 字符串 `{"choose_value":"平台返回的选项值"}`；平台需额外来源或拍摄时间地点的选项当前禁用，不用空字段代替补充信息 |

文本提交有格式差异：

- 图文把标题加到正文前。标题范围为 `type=7`，标题未以中文句号结束时补 `。`，句号范围为 `type=8`。正文关联范围随前缀移动。最终 `common.text` 为完整文本。
- 视频使用 `common.item_title` 和 `common.caption`，`common.text` 为去边缘空白后的标题、空格、正文组合；无标题时只保留正文。必须同时调整关联范围。
- 两种类型的 `common.text_extra`、`activity`、`challenges`、`mentions` 在发布请求里是 **JSON 字符串**，不是草稿模型中的数组。`hashtag_source` 为来源用 `/` 拼接的字符串。
- 关联类型：`type=0` 为 @，含 `user_id`；`type=1` 为话题，含 `hashtag_id,hashtag_name`。范围使用前端 JS 字符串索引。图文标题和分隔符也占范围。静态转换还携带 `caption_start/caption_end`，不能只维护显示高亮。
- 既存话题与 @ 用户的身份来自真实查询；显式选择的名称话题使用官方数值 `hashtag_id:0`，不是伪造正 ID。未绑定的普通 `#文字` 保留为正文，不仅凭外观自动生成关联。

### 名称话题与既存话题

2026-11-18 用户提供的官网界面显示，搜索量为 0、没有既存匹配的话题仍可选择。公开 `2320.ab744159.js` 模块 35552 在用户结束手写话题时插入 `type:1`、数值 `hashtag_id:0` 和当前名称；`5589.5bfb8a1d.js` 的“创建新话题”候选同样使用数值 0。`9927.4365fc94.js` 模块 58122 的建议列表在没有精确名称匹配时补入当前输入名称，并在编辑数据转为 `textExtra` 时保留原 `hashtag_id`，没有要求先创建真实正 ID。

同一模块的发布转换保留名称话题的完整 `text_extra`，包含 `type:1,hashtag_name,hashtag_id:0,user_id:"",start,end,caption_start,caption_end`；`challenges` 只收集真值话题 ID，因此不包含 0。`hashtag_source` 仍为每个话题保留来源，无明确推荐来源时为 `search`。`/web/api/media/hashtag/get/` 的名称查询用于发现可转换成官方活动的条目；未命中不会让名称话题变成虚构的正 ID，也不证明该名称话题不可用。

插件草稿把显式名称绑定存为 `{id:"0",name}`，发布构造器将这个特定标记转换为数值 0；正 ID 继续按字符串保留完整精度。不同名称的 0 话题分别保存及生成 UTF-16 范围，空 ID、缺失 ID、数值形式的草稿 ID 或任意文字 ID 均不能冒充绑定。名称话题在准备阶段按已校验的名称直通，不因补齐身份额外搜索；普通正 ID 话题继续按既有查询核对。合成回归验证图文、视频、标题前缀、混合话题、去重和未绑定纯文本；本轮没有调用真实发布接口验证平台最终接受结果。

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

- 图片准备结果直接传递 `uploadFile` 数组；发布构造器只取 `uri,imageWidth,imageHeight` 并映射为 `uri,width,height`。图文 `cover:{type:"asset",assetId,crop?}` 可以引用不在 `assets` 中的图库图片；只接受本机图库 ID，不接受远端 URL、文件路径或前端拼接的上传 URI。正文中的未裁剪封面复用正文资源；独立封面原图与裁剪结果分别上传，使用确认的 URI 写入 `item.cover.upload_poster`，不改变 `item.common.images` 的数量、顺序或尺寸，也不提交裁剪参数。
- 图库 metadata 实际字段为 `mediaType`，媒体解析统一转换为 `kind`；实况照片按其静态组件再次解析并检查图片类型。封面独立解析来源与版本，上传记录按账号、素材身份、版本和裁剪参数隔离。读取/裁剪后、上传后及保存准备快照前再次核对，变化、取消或账号失效均不能留下新的可发布快照。此行为已由 `tests/native-engine.mjs` 和 `tests/publication-payload.mjs` 的合成回归验证，未使用用户素材上传或发布。
- 封面界面保留正文图片快捷选择，并提供「从图库选择」；正文为空时直接进入图库。封面选择只更新封面引用，不插入正文。图片移出正文只移除正文引用，保留相同 ID 的封面与裁剪，图库文件不删除；显式更换或清除封面才修改该引用。当前裁剪器按正文首图确定比例，因此裁剪需先有正文图片。
- 视频在 `encode=1` 后将真实转码结果转为 `vid,width,height,duration,coverUri`。不选择封面时使用平台首帧；选择图库上传封面时使用 `upload_poster`。这只证明本地字段衔接，不证明平台已接受发布请求。
- 正 ID 话题与 @ 用户经 worker 重查，显式名称话题保留 0 标记，随后生成 UTF-16 关联范围。新原生编辑器已将选中的话题或用户插入正文时，复用第一个未被其他关联占用且有完整边界的 `#名称` 或 `@昵称`，没有时才追加；同名不同身份的话题拒绝选择，同昵称不同用户按选择顺序绑定不同范围。边界按完整 Unicode 码点判断，提交索引仍为 UTF-16。未选择的纯文本不自行生成身份。测试涵盖中文、表情、标点、话题前缀、标题和视频正文坐标。
- 图文音乐在上传前后分别按所选 ID 重新读取详情，响应 ID 必须一致，同 ID 改名不构成换曲；所需 `duration` 来自同账号真实音乐查询所得的有限记录，再按秒数乘 1000；本次实测身份详情不含时长，不能补猜或从草稿附加字段取得。普通作者声明在素材准备前后重读当前账号、作品的真实规则后序列化；需要补充来源或拍摄日期地点的声明仍明确拒绝。视频音乐、视频地点/合集和定时合集仍保持未接入。

## 回执与失败语义

- 公开业务发布函数读取响应 `item_id`，并以此检查重复回执；该 ID 不是上传 `vid` 或图片 `uri`。
- `status_code=0` 和非空作品身份才有资格作为业务接受成功的证据。当前未验证原始响应层级，不要将网络 HTTP 200、页面跳转或素材上传成功直接当发布成功。
- 已接受、审核中、已发布、定时待发应分开。此轮静态分析未证明所有状态接口和枚举。
- 请求超时、连接断开或无完整回执应保存为“结果待确认”，保留请求身份和素材成功记录，不自动重发。
- 登录过期、权限不足、需要平台验证应保留作品草稿并停止。不得调用页面私有模块、复制安全实现或绕过平台保护。

本轮协议分析读取公开业务资源与本地实现；主线程另执行上述正常登录态的只读查询。没有读取 Cookie/凭据，没有上传或发布作品，没有验证最终发布接口。


## 2026-11-17 原生资源选择补充

- 音乐授权依据内容主包 `70858` 的 `fD` 导出与音乐包 `358.f8a6866b.js` 的调用链；`23934.sZ` 中抖音应用标识为 1128。音乐搜索的游标原样沿用返回值，停滞游标报错；`duration` 与原生 `dayjs.unix(duration)` 用法一致，为秒。
- 自主声明依据 `2998.27aa3310.js` 的 `79264`、`1025.620069fb.js` 的 `27147/62969/81463/86816`。当前普通发布请求的判断上下文为 `has_ai_metadata,is_xing_tu_submit,has_marketing_poi,item_type`；本插件未接星图或营销挂载，不声明具备这些上下文。声明选项来自服务端，不根据本地固定 ID 列表伪造账号能力。
- `source_option` 需要真实来源，抖音站内来源还需作品 ID；`location_and_date` 需要拍摄日期、地点和 geoname ID。当前只公布附加说明并禁用这些选项，不用普通 POI ID 代替 geoname ID。
- 推荐话题依据 `231.c96b315e.js` 收集上传 URI 和 `2320.ab744159.js` 的 `frames` 查询；上传前无推荐，与关键词联想分开。只记录最近完整图片清单，素材检查点中已移除的历史图片不混入推荐。已选推荐话题在准备时按真实名称重新搜索并匹配 ID，避免推荐重排或上传失败撤销快照后无法重试。
- 合集仍按平台十条游标逐页查询，在每页结果中匹配名称并保留下一页位置；没有静态证据支持任意添加服务器搜索参数。城市 POI 沿用现有明确城市参数、每页十项与平台下一页契约。

上述新增音乐关键词、声明和推荐契约已用合成回执完成离线回归；本轮未真实上传或发布。公开静态业务参数不等于平台已接受最终发布，实机查询结果应另记。

合集展示补充：`231.c96b315e.js` 的原生下拉直接使用 `cover_url.url_list[0]` 与 `statis.updated_to_episode` 展示封面和“共 N 个作品”。原生适配公开为 `thumbnailURL/itemCount`，下一集 `order` 独立保留并在准备时重查；封面 URL 不写入选择身份、草稿或发布快照。

2026-11-18 合集与可见性核对：重新读取官方内容入口及 `builder-runtime.566b4631.js`，当前图文组件 `2003.e537db50.js` 的模块 `12175` 在存在 `collectionInfo` 时将可见性设为 `23934.Qd`，并禁用可见性选择；当前入口 `douyin_content_index_micro_new.e4059ace.js` 的模块 `23934` 定义 `Qd=0`，标签为“公开”。视频组件 `7290.7490bc7b.js` 也明确提示加入合集或专辑不能选择好友或仅自己可见。这是官方网页交互约束的直接证据，未调用真实发布验证服务端拒绝行为。插件保留这条约束，但扩大可见范围必须由用户明确确认，不能在选合集或恢复草稿时自动改成公开。

### 原生读取请求生命周期

代码审计确认，原先每次候选/声明查询依次执行四次 `user/info`（入口、候选前、候选后、出口），普通查询需五次远端请求，推荐音乐及关键词音乐需六次。现已移除普通查询的 60 秒账号核验期限：查询只确认本机档案归属，直接调用所需业务接口。平台登录错误原样提示用户处理，离线不清除已有展示、草稿、选择或成功候选。上传准备入口与真正发布 POST 前各保留一次实时身份核验；子查询、上传授权、视频轮询及成功提交后不再重复查询账号。旧的无档案适配直接调用仍使用实时身份契约。候选准备复核继续绕过读取页面缓存。

完整查询页在内存中保留最多 15 秒、64 页，按账号档案和完整参数隔离；缓存命中仍检查本机会话，原始候选查询时间不因命中延长。图片推荐依赖上传快照，因而不复用页面缓存。音乐完整分类目录最多在同一账号档案内保留五分钟，切换分类及翻页只请求相应列表。查询身份、分类、页面和音乐搜索授权均不写入持久状态；同账号真实查询返回的选曲音源与时长另存有限音乐记录，按宿主档案、平台账号与音乐 ID 隔离，不混入草稿或搜索授权。音乐授权未缓存：公开 `358.f8a6866b.js` 中 `eO` 每次先调用 `ej.fD()` 取得 `signature`，再向固定搜索域请求，没有可证明的复用有效期。

2026-11-18 草稿恢复修复：持久草稿保存选择，页面内存保存查询记录，原逻辑在插件重载后错误地把记录丢失视为资源不可用。话题、用户、地点和合集现在按当前账号重新查询，严格匹配原 ID，同 ID 改名使用平台当前名称；旧查询或游标未命中时从名称搜索首页恢复，最多五页且拒绝重复位置。城市代码和名称只作地点查询线索，地点附加参数和合集集数取自真实新响应。活动继续重新核对当前目录和详情中的准确字符串话题身份。

已选音乐独立使用 `music.resolve({id})`：按准确音乐 ID 获取当前详情，允许同一 ID 的显示名更新，不能用名称搜索结果替换原 ID。重新打开后的试听先确认原音乐身份，再使用该档案、账号和音乐 ID 的真实音源与时长记录。记录缺失或音频失败后显式刷新时，最多读取推荐和收藏各两页查找精确 ID；本次 info 详情没有地址或时长，不能据此创造媒体字段。准备时上传前后分别读取详情并核对 ID，不以旧候选年龄代替核验。失败、账号切换或取消时保留原选择并说明原因，不持久化查询授权或会话，也不信任草稿附加的时长和地址。

离线请求计数回归验证：已核验普通读取 1 次远端请求；首次推荐音乐 2 次，后续页 1 次；关键词音乐每次 2 次（授权+搜索）。同时覆盖 TTL、时钟回拨、容量淘汰、原生快照到期但网页仍可用、网页环境失效、宿主外部切换、迟到结果、失败仅重试原业务查询，以及普通读取不能替代发布前唯一一次实时身份检查。未用这些离线计数声称真实网络延迟数值，未触发真实上传或发布。

2026-11-18 交互精简回归：本机账号档案恢复和切换不发 `user/info`；只读查询可被换号取消，上传与真正提交继续保持账号互斥。账号错误保留已有身份、草稿字段、音乐与位置选择和 AI 文案，本地清除不发请求；已缓存音乐离线仍可尝试播放。发布状态读取独立显示查询中，允许编辑与切稿，迟到回执仅写入发起查询的草稿。宿主成功消费上传正文后通过 `consumedBodyHandle` 确认，插件省去重复删除往返；未确认消费或失败仍清理。历史网页环境清理不再作为普通请求的前置等待，同源请求只做一次目标域名检查。

本次真实引擎配合合成传输的账号请求计数：图文准备 9→1，带音乐图文 15→1，视频准备（三次轮询）17→1，实际发布 4→1（发布 POST 仍恰好一次），重复发布 2→0，状态查询 3→0（只发作品查询）。成功 POST 后网络失败或页面生命周期变化仍保留已确认作品 ID 和回执；保留提交前持久化、防重复与 unknown 不自动重发。此计数并非真实平台耗时测试，没有上传或发布用户素材。

# Studio App UI contract

**Current build: native App execution adapter.** Requires `pluginContext.nativeCapabilities.sessionVersion === 1`. The plugin owns fixed platform operations, preparation and publication state; the host owns temporary session material, network policy, bounded body handles and durable noncredential plugin state. No Chrome extension, browser execution or separate service is used. Final real platform upload/publication is still unverified.

`connect()` only checks session status and the real platform account. `importSession()` calls `session.login{origin}` to open the host's official login window. The user completes QR/SMS verification there; no credential or Cookie enters plugin JavaScript. Cancellation (`SESSION_LOGIN_CANCELLED`) preserves the previous session and drafts. `clearSession()` clears the host-managed temporary identity and invalidates prepared account state. Session expiry may be returned as `expiresAt` and is governed by the host.

Native operations use `pluginUI.postMessage({op,...params})` and the envelope `{ok:true,data}` or `{ok:false,error:{code,message}}`. `session.request` accepts a fixed-policy HTTPS URL, method, headers, `credentials:session|omit`, optional `bodyText|bodyHandle`, and returns `{status,headers,body}`. Upload bodies use `body.begin`, `body.append` (at most 256 KiB decoded), `body.finish`, `body.remove`; `session.cancel` never implies remote publication was revoked. `state.get{keys?}` / `state.set{values}` persist noncredential preparation, upload metadata and publication records separately from UI state.

The UI imports `studioClient` from `./studio-client.js`. No page from the creator website is embedded. All execution requests use `await studioClient.request(operation, params, {onProgress, signal}?)`. `studioClient.onStatus(listener)` returns an optional unsubscribe callback. `connect()` is explicitly user initiated.

## Session and capabilities

`connect()` or `studio.session` returns `{connected, account, capabilities}`. Account is `{id, name, avatarURL?}`. Missing account means signed-out/unverified, never a demo identity. Status listeners accept this same shape plus `{message?,state?}`. Account changes invalidate prepared publication.

Capabilities: `{operations: string[], limits?: {imageCount,titleLength,descriptionLength,coverBytes}, options?: {visibility: [{value,label}], download: [{value,label}]}, declarations?: [{id,label,description?,required?}]}`. `operations` is the explicit usable allowlist. Unsupported capabilities stay visibly disabled. No implementation may claim support before its execution contract is verified.

## Queries

`topics.search`, `users.search`, `music.search`, `locations.search` take `{query,cursor?,kind}`; `collections.list` takes `{query?,cursor?,kind}`. Responses are `{items:[{id,name,description?,thumbnailURL?,previewURL?}],nextCursor?}`. Topic and user identities are saved separately from plain text. Music preview uses only returned previewURL in memory. URLs and response extensions are not copied into persisted drafts.

`cover.frames` takes `{assetId}` and returns `{items:[{id,name,timeMs,thumbnailURL?}]}`. It remains hidden unless explicitly advertised. `cover.upload` takes `{assetId}` for a user-selected library image and returns `{id,name,thumbnailURL?}`. There is no whole-file base64 message or media persistence in frontend state; native body staging uses bounded transient chunks.

`locations.search` additionally requires explicit `cityCode` and `cityName` from bundled cities.json. Persisted location retains these two fields. Music supports empty query for recommendations or a `https://v.douyin.com/...` music link, not keyword search; video music stays unavailable until its payload is verified.

## Draft and media

Media addition requires `pluginContext.nativeCapabilities.mediaSelectionVersion === 1`. After successful draft persistence, `assets.select{kind:'image'|'video',maximumCount,excludeAssetIDs}` opens the host's source grid. The host keeps this WebView mounted while hidden and resolves the native envelope with `{cancelled:boolean,assetIDs:string[]}` when the user confirms or cancels. The plugin verifies the initiating draft ID/type, fetches metadata for confirmed IDs and applies valid, distinct assets within remaining capacity. Cancellation makes no content change. Cover selection is a separate local target (`image`, maximum 1, empty exclusions); it cannot append to body media. Missing capability is an update error, never a fallback to immediate-add search.

Draft `{id,name,kind:'image'|'video',assets:[{id,name,kind}],title,description,topics:[{id,name}],mentions:[{id,name}],music:{id,name}|null,location:{id,name}|null,collection:{id,name}|null,cover:{type:'asset'|'frame'|'upload',assetId?,id?,name?,timeMs?,crop?}|null,settings:{visibility,download,publishTime:'now'|'scheduled',scheduledAt,declarations:[string]},updatedAt}`. Media is identified by local library asset IDs; no file paths, media bytes, session cookies or credentials are persisted. The UI fetches library metadata/thumbnails with `pluginContext.apiBaseURL`, as the existing App plugin does. File-only browser previews never become uploadable library IDs.

Multiple local drafts use `pluginContext.frontendState` and native `pluginUI.postMessage({op:'persist',value})`; file preview uses a distinct localStorage key. Serialized state is version 1, allowlisted, small JSON. Writes are serialized and the UI reports saved only after native acknowledgment. Maximum 40 drafts; extra creation is declined rather than deleting drafts. `settings.scheduledAt` is kept as local form text in persistence and converted to timezone-explicit ISO in the publication snapshot.

## Prepare and publish

`publication.prepare({draft,requestId})` uploads/prepares the current immutable content snapshot. Progress events `{phase,message,completed?,total?,percent?,assetId?}` are informational; numeric progress is shown only if supplied.

Prepare returns `{preparationId,account:{id,name},canPublish,issues?:string[],summary?:{title,assetCount,kind,visibility,scheduledAt},expiresAt?}`. A preparation is invalidated on ANY draft change or account change. `canPublish` must be explicitly true. Missing/unknown response fields cannot mean success.

`publication.publish({preparationId,requestId,expectedAccountId,confirmed:true})` is called only from a second confirmation dialog displaying the verified account and exact prepared work. No automatic publish, retry, navigation or hidden submit occurs. Confirmation is reset after each attempt.

Publish returns `{publicationId?,status:'published'|'scheduled'|'processing'|'failed'|'unknown',message?,url?}`. Only `published` means published, `scheduled` means scheduled, `processing` means still processing. Network/unknown outcome is shown as unconfirmed; the same requestId is retained for status queries and no automatic resubmission occurs. `publication.status({publicationId?,requestId})` explicitly refreshes the outcome using the same response.

Errors are Error objects with readable `.message` and optional `.code`. `AbortError` stops preparation/query transports and subsequent upload steps; completed upload metadata remains durable. Once final publication starts, the plugin continues collecting and persisting the receipt. Uncertain publication stays `unknown` without retry; cancellation never proves remote publication was revoked.

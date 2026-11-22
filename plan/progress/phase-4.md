# 8. Tiến độ phase 4

**Trạng thái: đang làm.** Plan phần chính: [nguon-hoc.md](../nguon-hoc.md).

## Phase 4 (cập nhật 2026-11-22)

| Hạng mục | Trạng thái |
| --- | --- |
| Plan phần chính | Xong (2026-11-22). Chốt: chỉ việc nền sống sót khi khởi động lại (lượt học giữ quy tắc "bị ngắt"); nguồn vừa làm tư liệu dạy có trích dẫn vừa gắn vào mệnh đề; demo dùng được nguồn và research (tính chung ngân sách); SearXNG và Exa do admin cấu hình, web search của provider dùng key của người dùng |
| Bước 0: spike tách chữ PDF (C1) | Chưa bắt đầu |
| Bước 1: spike tìm kiếm (C2) | Xong (2026-11-22). SearXNG `searxng/searxng:2026.11.20-cd6d28091` chạy được, đoạn trích quá ngắn (khoảng 160 ký tự) nên thêm bộ tải trang có chặn SSRF cho SearXNG; Exa dùng `highlights`; cắt web search của provider (không vừa `SearchPort`). Xem ghi chú bước 1 bên dưới |
| Bước 2: spike dạy dựa trên nguồn (C3) | Chưa bắt đầu |
| Bước 3: job bền | Xong (2026-11-22). Bảng `jobs` (migration server v8), runner trong `packages/server/src/jobs/runner.ts`, job extraction chạy qua runner; chạy lại sau khởi động lại tối đa 3 lần. Xem ghi chú bước 3 bên dưới |
| Bước 4: nguồn trong core và storage | Xong (2026-11-22). Schema và hàm cắt đoạn, chọn lát trong `core`; bảng nguồn ở cả ba driver (khách v4, server v9). Xem ghi chú bước 4 bên dưới |
| Bước 5: `packages/search` | Chưa bắt đầu |
| Bước 6: ingest PDF và ghi chú | Chưa bắt đầu |
| Bước 7: dạy dựa trên nguồn | Chưa bắt đầu |
| Bước 8: research | Chưa bắt đầu |
| Bước 9: model và nguồn tìm kiếm giả cho e2e | Chưa bắt đầu |
| Bước 10: giao diện | Chưa bắt đầu |
| Bước 11: kiểm tiêu chí phase | Chưa bắt đầu |

## Điều cần biết khi bắt đầu (từ phase 3)

- **Hai chế độ lưu:** mọi thứ mới chạy ở cả khách / demo (DB local, server không trạng thái) và tài khoản (SQLite server, `forUser(userId)`). Migration hiện tại: khách v3 (`packages/storage/src/sqlite/schema.ts`), server v7 (`packages/storage/src/sqlite-node/schema.ts`). Không sửa migration đã phát hành.
- **Job extraction hiện tại:** `packages/server/src/knowledge/jobs.ts`, hàng đợi trong bộ nhớ theo người dùng, `recoverInterrupted` ghi `Interrupted` lúc khởi động. Bước 3 thay bằng runner đọc bảng `jobs`.
- **Thêm vai** (`researcher`): `ModelRole` / `RoleModels` trong `packages/api/src/contract.ts`, `AgentRole` trong `packages/core/src/profile.ts`, màn `apps/web/src/account/AccountSettings.tsx`, cách khách chọn model (`apps/web/src/learn/runner.ts`).
- **Trường mới của hồ sơ và event luôn tuỳ chọn** (rủi ro 34); có fixture log phase 1–3 để kiểm.
- **Model giả cho e2e:** `apps/web/e2e/fake-openai.ts`.

## Bước 3: job bền (2026-11-22)

- **Bảng `jobs`** (migration server v8): một dòng chỉ tồn tại khi job còn việc (`queued` / `running`); job kết thúc thế nào cũng xoá dòng, kết quả nằm ở dữ liệu miền. `UNIQUE (user_id, kind, key)` chống xếp hàng trùng (extraction: `key` là `sessionId`).
- **Runner** (`makeJobRunner`): mỗi loại (`JobKind`) có schema payload, `run`, `abandon`, trần `global` tuỳ chọn; một job mỗi loại mỗi người. `resume()` lúc khởi động: dòng `running` của process trước chạy lại nếu `attempts` < 3, không thì gọi `abandon` (extraction ghi `Interrupted`); dòng của loại không biết hay payload không đọc được thì bỏ (log `jobs.dropped`). Job lỗi (kể cả defect) xoá dòng, không chạy lại. `stopAll` giữ dòng như process dừng.
- **Extraction:** hàng đợi trong bộ nhớ bị thay bằng runner. Chạy lại giữ `extractionId`; đầu job kiểm lần thử còn mở (đã đóng thì bỏ qua). Lần thử còn mở mà không có job (ghi ngay trước khi sập, hay từ phase 3) thành `Interrupted` ở `recoverInterrupted`, chạy sau `resume()`.
- **Test:** `runner.test.ts` (một job mỗi người, trần toàn server, lỗi không chạy lại, khởi động lại ba lần rồi bỏ, dòng lạ bị bỏ); `jobs.test.ts` thay test "khởi động lại thì `Interrupted`" bằng ba test trên cùng file DB (chạy lại xong cùng `extractionId`, ba lần bị cắt thì `Interrupted`, lần thử không có job thì `Interrupted`). 162 test server xanh.

## Bước 1: spike tìm kiếm (2026-11-22)

- **SearXNG** (chạy thật, image `searxng/searxng:2026.11.20-cd6d28091`): `GET /search?q=…&format=json&language=vi|en`; chưa bật `json` thì 403. Trường dùng: `title`, `url`, `content`; `publishedDate` luôn null. 0,4–1,1 s, 20–27 kết quả. Engine thật sự trả kết quả: duckduckgo (CAPTCHA từ truy vấn thứ 3) và google cse; adapter đọc `unresponsive_engines`, không có kết quả mà mọi engine lỗi thì `Unavailable`. `settings.yml`: `use_default_settings: true`, `server.limiter: false`, `image_proxy: false`, `search.formats: [html, json]`, `secret_key` riêng.
- **Đoạn trích của SearXNG quá ngắn** (trung bình khoảng 160 ký tự, 8 kết quả khoảng 1,3 KB): không đủ để viết bản tóm tắt dạy được. Quyết định: thêm bộ tải trang có chặn SSRF ([rủi ro 38](../05-rui-ro.md)) cho SearXNG, tối đa vài trang đầu, trần kích thước và thời gian, HTML sang chữ.
- **Exa** (đọc tài liệu, chưa gọi): `POST https://api.exa.ai/search`, `Authorization: Bearer`, body `{query, type: 'auto', numResults, contents: {highlights: true}}`; kết quả `{results: [{title, url, publishedDate?, highlights?, text?}], costDollars}`; lỗi 401 `INVALID_API_KEY`, 402 `NO_MORE_CREDITS`, 429 kèm `Retry-After`. Giá `auto` $7 / 1.000 request, 10 QPS. `highlights` đủ thay toàn văn.
- **Web search của provider: cắt khỏi phase 4** (thứ tự cắt giảm của plan). TanStack AI 1.4 có tool tìm web do provider chạy cho cả ba provider, nhưng adapter của kd-learn bỏ kết quả `providerExecuted`; gọi thật Anthropic (Haiku, 1 lần tìm): 15k token vào, kết quả chỉ có `title`, `url` và `encrypted_content`, chữ đọc được chỉ nằm trong `citations` của câu trả lời. Không vừa `SearchPort`; nếu làm sau thì là biến thể của pipeline research, cần mở rộng `AiPort`. Hệ quả: người dùng chọn trong các nguồn của server (SearXNG, Exa); A6 đổi theo.
- Bản đầy đủ của spike chỉ ở máy local (không giữ trong repo).

## Bước 4: nguồn trong core và storage (2026-11-22)

- **`core`:** `source-schema.ts` (schema: `SourceInfo`, `SourceChunk`, `ChunkLocator`, `SourceChunkRef`, `Citation`; tách khỏi `source.ts` để event import không bị vòng) và `source.ts` (hàm thuần: `chunkPages`, `chunkNote` / `cleanNote`, `chunkWeb`, `selectSourceSlice`, `sourceQueryText`). Đoạn được định danh bằng `ordinal` trong nguồn (không có `chunkId` riêng): tham chiếu là `{sourceId, ordinal}`. Cỡ đoạn mặc định 1.500 ký tự (tối đa 4.000), lát mặc định 8 đoạn / 24 KiB; chốt lại ở spike C3.
- **Event:** `SourceAttached` / `SourceDetached` (projection chặt: gắn hai lần, gỡ cái chưa gắn thì `ProjectionError`); `MessageAppended.citations`, `TurnCompleted.sourceRefs`, `PropositionSource.documents` đều tuỳ chọn. Fixture log phase 1–3 vẫn dựng được. `Session.sources`, `HistoryMessage.citations`.
- **`storage`:** bảng `sources`, `source_chunks`, `source_files` (DDL chung `sourcesTables`; migration khách v4, server v9). Port thêm `createSource` (`pending` kèm file, hay `ready` kèm đoạn), `completeSource` (chỉ từ `pending`, xoá file), `failSource`, `retrySource`, `listSources`, `getSource`, `readSourceFile`, `readChunks`, `deleteSource`, lỗi `SourceConflict`, thay đổi `SourcesChanged`. Kiểm đoạn (thứ tự `ordinal`, trần 2 MiB) trước khi ghi, ở mọi driver.
- **Test:** bộ test port thêm 5 test nguồn (memory, sqlite-node); test hai người dùng cho nguồn (không đọc, ghi, xoá được nguồn của người kia; id theo owner). Driver WASM chưa có test riêng cho nguồn: kiểm bằng Playwright ở bước 6.


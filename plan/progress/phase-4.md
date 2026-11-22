# 8. Tiến độ phase 4

**Trạng thái: đang làm.** Plan phần chính: [nguon-hoc.md](../nguon-hoc.md).

## Phase 4 (cập nhật 2026-11-22)

| Hạng mục | Trạng thái |
| --- | --- |
| Plan phần chính | Xong (2026-11-22). Chốt: chỉ việc nền sống sót khi khởi động lại (lượt học giữ quy tắc "bị ngắt"); nguồn vừa làm tư liệu dạy có trích dẫn vừa gắn vào mệnh đề; demo dùng được nguồn và research (tính chung ngân sách); SearXNG và Exa do admin cấu hình, web search của provider dùng key của người dùng |
| Bước 0: spike tách chữ PDF (C1) | Xong (2026-11-22). `pdfjs-dist` 6.5.438 (Apache-2.0) ở trình duyệt và Node; trên server chạy trong `worker_threads`, canh RSS; thêm mã `Encrypted`, `Invalid`; trần chữ 4 MiB; một job ingest mỗi process. Xem ghi chú bước 0 bên dưới |
| Bước 1: spike tìm kiếm (C2) | Xong (2026-11-22). SearXNG `searxng/searxng:2026.11.20-cd6d28091` chạy được, đoạn trích quá ngắn (khoảng 160 ký tự) nên thêm bộ tải trang có chặn SSRF cho SearXNG; Exa dùng `highlights`; cắt web search của provider (không vừa `SearchPort`). Xem ghi chú bước 1 bên dưới |
| Bước 2: spike dạy dựa trên nguồn (C3) | Chưa bắt đầu |
| Bước 3: job bền | Xong (2026-11-22). Bảng `jobs` (migration server v8), runner trong `packages/server/src/jobs/runner.ts`, job extraction chạy qua runner; chạy lại sau khởi động lại tối đa 3 lần. Xem ghi chú bước 3 bên dưới |
| Bước 4: nguồn trong core và storage | Xong (2026-11-22). Schema và hàm cắt đoạn, chọn lát trong `core`; bảng nguồn ở cả ba driver (khách v4, server v9). Xem ghi chú bước 4 bên dưới |
| Bước 5: `packages/search` | Đang làm. Xong phần package (port, SearXNG kèm bộ tải trang, Exa), lint, service SearXNG trong compose (2026-11-22); còn cấu hình admin và key Exa mã hoá |
| Bước 6: ingest PDF và ghi chú | Đang làm. Xong phần tài khoản (route `/api/account/sources`, job `ingest` trong `worker_threads`, chạy lại sau khởi động lại, PDF đọc được trong image Docker) (2026-11-22); còn khách / demo (Worker trình duyệt, ghi chú ở client, "bị ngắt") |
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

## Bước 0: spike tách chữ PDF (2026-11-22)

- **Thư viện:** `pdfjs-dist` 6.5.438 (Apache-2.0, phát hành 2026-11-01, Node ≥ 22.13). Loại `unpdf` (chỉ bọc pdfjs, vẫn cần `pdfjs-dist` và `@napi-rs/canvas`).
- **Trình duyệt:** nạp lười `pdfjs-dist/build/pdf.mjs`, `GlobalWorkerOptions.workerPort = new Worker(new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url), {type: 'module'})`; luồng chính trễ 2–4 ms. Không import `pdf.worker.mjs` vào Worker của mình (treo). Gzip: 136 KB + 378 KB.
- **Node:** `pdfjs-dist/legacy/build/pdf.mjs`, gán `globalThis.pdfjsWorker = await import('pdfjs-dist/legacy/build/pdf.worker.mjs')` trước khi gọi. `@napi-rs/canvas` không cần cho tách chữ. Chưa thử trong bản build Nitro (bước 6).
- **Mã chung:** `getDocument({data, isEvalSupported: false, disableFontFace: true, verbosity: 0})`, mỗi trang `getTextContent()`, nối `item.str`, xuống dòng khi `hasEOL`, `normalize('NFC')`. Bản 6.x đóng bằng `loadingTask.destroy()`.
- **Lỗi:** PDF có mật khẩu mở thì promise treo nếu không gán `loadingTask.onPassword` → mã mới `Encrypted`. Bản scan: trung bình dưới 10 ký tự mỗi trang → `NoText`. File hỏng / không phải PDF ném `InvalidPDFException` trong khoảng 30 ms → mã mới `Invalid`. `numPages` có ngay khi mở → từ chối quá 500 trang trước khi đọc trang nào.
- **Đo:** 5 trang tiếng Việt 45 ms (Node), 52 / 81 / 73 ms (Chromium / Firefox / WebKit); 500 trang 20 MiB 0,4–0,5 s, RSS khoảng 200 MB; tiếng Việt đúng dấu, NFD ra NFC. Bom Flate 1,5 MB nở 1,5 GB: RSS 3,2 GB trong 5 s.
- **Server:** chạy trong `worker_threads`, không vì độ trễ (event loop chỉ trễ khoảng 24 ms) mà vì bộ nhớ: `resourceLimits` không chặn được ArrayBuffer, nên luồng chính đọc RSS mỗi 20 ms và `terminate()` khi vượt nền + 512 MiB (bom bị dừng sau 0,5 s, đỉnh khoảng 650 MB). Thời hạn 60 s. **Một job ingest mỗi process** (RSS tính chung). Luôn `isEvalSupported: false`, cập nhật pdfjs thường xuyên (CVE cũ qua font).
- **Trần chữ sau khi tách: 4 MiB** (500 trang dày đặc khoảng 1,9 MB UTF-8, sát trần 2 MiB cũ); đã sửa `maxSourceTextBytes`.
- **Cắt đoạn:** `hasEOL` là dòng hiển thị, không phải đoạn văn: tách đoạn theo khoảng cách dọc (`item.transform[5]` lớn hơn khoảng 1,5 lần chiều cao dòng). Bỏ dòng ngắn lặp ở ít nhất 50% số trang (đầu trang, chân trang) sau khi thay chữ số bằng `#`. PDF hai cột từ LaTeX / Word chưa thử.

## Bước 5: `packages/search` (2026-11-22, phần package)

- **Port** (`@kd-learn/search/port`, chỉ `effect`; lint như port AI): `SearchPort.search({query, limit, language?})` → `SearchResult[]` (`title`, `url`, `snippet`, `content?`, `publishedAt?`); `SearchError` có `reason` (`Unavailable`, `Unauthorized`, `PaymentRequired`, `RateLimited` kèm `retryAfterSeconds`, `Invalid`), thông báo cố định không chứa key hay thân phản hồi.
- **SearXNG** (`./searxng`): `GET /search?format=json`, bỏ URL trùng và không phải http(s); không có kết quả mà có `unresponsive_engines` thì `Unavailable`; 403 thì báo chưa bật định dạng json. Tải 4 trang đầu (mặc định) để điền `content` (tối đa 12.000 ký tự), trang hỏng giữ đoạn trích.
- **Bộ tải trang** (`./fetch`): `http.get` với `lookup` tự viết kiểm địa chỉ lúc kết nối (DNS đổi giữa chừng không lọt), bất kỳ địa chỉ nào phân giải ra không công khai thì từ chối; tự theo chuyển hướng (tối đa 3, kiểm từng lần); trần 2 MiB (cả sau giải nén) và 10 s; chỉ `text/html`, `text/plain`; HTML sang chữ bỏ script / style.
- **Exa** (`./exa`): `POST /search`, `type: 'auto'`, `contents.highlights`; 401/403 `Unauthorized`, 402 `PaymentRequired`, 429 `RateLimited` (đọc `Retry-After`), 400 `Invalid`.
- **Compose:** service `searxng` (`searxng/searxng:2026.11.20-cd6d28091`, không mở cổng, `settings.yml` mount chỉ đọc ở `deploy/searxng/`, `SEARXNG_SECRET`, `SEARXNG_CONTACT_URL` để bật Wikipedia / Wikidata); `web` có `KD_SEARXNG_URL=http://searxng:8080`. `scripts/compose-smoke.sh` kiểm `web` gọi được SearXNG JSON; chạy local xanh.
- **Test:** 32 test (địa chỉ công khai / riêng kể cả IPv4 trong IPv6, chuyển hướng tới `::1` và `localhost`, vòng chuyển hướng, kích thước, loại, thời gian, scheme, adapter với `fetch` giả, key không lộ).
## Bước 6: ingest (2026-11-22, phần tài khoản)

- **Một hàm tách chữ cho hai chế độ:** `readPdfPages(getDocument, data, maxPages, assets?)` trong `core` (`pdf-read.ts`) chỉ gọi pdfjs và trả item thô (`str`, `hasEOL`, `y`, `height`) mỗi trang. Thân hàm tự đủ (không import, không hàm phụ đặt tên) vì server gửi **mã nguồn** của nó vào worker (`readPdfPagesSource()`): worker `eval` không có code workspace. Phần còn lại chạy ở luồng chính và dùng chung với trình duyệt: `pdfSourceChunks` (gồm `pdfPagesText`, `pdfHasText`, `chunkPages`, trần 4 MiB, đổi mã lỗi).
- **Đầu trang / chân trang:** chỉ xét 2 dòng đầu và 2 dòng cuối mỗi trang (lặp ở ít nhất một nửa số trang, bỏ chữ số); xét cả trang thì bỏ nhầm câu thân bài lặp lại (fixture có đoạn lặp).
- **Bản build Nitro:** pdfjs được nạp theo đường dẫn trong worker nên bundler không thấy: `traceDeps: ['pdfjs-dist*']` chép nó vào `.output/server/node_modules` (thử bằng `.output` tách riêng khỏi repo). Dockerfile xoá `build`, `web`, `image_decoders`, `types` và file `.map` của pdfjs (giữ `legacy`, `cmaps`, `standard_fonts`). Worker tắt `console.log` lúc import (pdfjs cảnh báo thiếu `@napi-rs/canvas`, chỉ cần để vẽ). Server truyền `cMapUrl` / `standardFontDataUrl` (đường dẫn thường, không phải `file:` URL).
- **Job `ingest`:** `global: 1`, khoá = `sourceId`; nguồn đã xoá hay không còn `pending` thì bỏ qua; `SourceConflict` của `completeSource` coi như xong; lỗi kho thì `failed` mã `Failed`; bị ngắt (dừng process) thì giữ dòng để chạy lại; quá 3 lần thì `Interrupted`. Ngắt effect thì `terminate()` worker.
- **Route:** `GET` / `POST /api/account/sources` (JSON = ghi chú đã cắt, `ready` ngay; multipart = PDF, `pending` 202), `GET` / `DELETE /sources/:id`, `POST /sources/:id/retry` (chỉ PDF, giữ file). Đọc thân theo luồng có trần (`readLimitedBytes`, 20 MiB + 64 KiB) rồi mới parse multipart; kiểm `%PDF-`. Nguồn của người khác: 404 (xoá: 204 không làm gì).
- **Proxy:** nginx mặc định chặn thân quá 1 MiB: `docs/deploy.md` thêm `client_max_body_size 21m`.
- **Test:** worker thật trên fixture (tiếng Việt 5 trang có đầu trang, NFD, mã hoá, không phải PDF, quá số trang, bom Flate 400 MB bị dừng theo RSS, timeout, ngắt); route (PDF thành `ready` với số trang, scan thành `NoText`, thân vô hạn bị cắt 413, ghi chú, cross-user, khởi động lại giữa ingest trên cùng file DB rồi xong, chạy lại PDF lỗi). `compose-smoke.sh` tải PDF lên image và chờ `ready`. Fixture ở `packages/server/test/fixtures/pdf/`.

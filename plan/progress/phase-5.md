# 8. Tiến độ phase 5

**Trạng thái: đang làm.** Plan phần chính: [hinh-va-demo.md](../hinh-va-demo.md).

## Phase 5 (cập nhật 2026-11-22)

| Hạng mục | Trạng thái |
| --- | --- |
| Plan phần chính | Xong (2026-11-22). Chốt: demo không sinh ảnh trừ khi admin bật (mỗi ảnh tính N lần gọi); khách sinh ảnh được qua vai `illustrator` riêng, không fallback; hình chỉ ở luồng chính của Teacher; demo HTML được nạp thư viện CDN trong danh sách cho phép (ghim bản, SRI), admin tắt được |
| Bước 0: spike khung sandbox (C1) | Xong (2026-11-22). `srcdoc` + `sandbox="allow-scripts"` chặn mọi đường đọc dữ liệu app trên Chromium, Firefox, WebKit; CSP của khung chỉ dùng hash (không `'unsafe-inline'`, không URL), buộc được SRI và chặn query string; `frame-src` trên trang cha chặn khung tự điều hướng; vòng lặp vô hạn đơ cả trang ở cả ba. Xem ghi chú bước 0 |
| Bước 1: spike SVG / Mermaid (C2) | Xong (2026-11-22). SVG qua `<img src=blob:>` không chạy script, không request ra ngoài; Mermaid 12.3.0 render trong app với `htmlLabels: false`, `layout: 'dagre'`, kết quả hiện bằng `<img>`; không kiểm Mermaid trên server (cần jsdom, 200 MB). Xem ghi chú bước 1 |
| Bước 2: spike Teacher vẽ hình với Haiku (C3) | Chưa làm |
| Bước 3: spike sinh ảnh (C4) | Xong (2026-11-22). Adapter gọi thẳng HTTP (không dùng `generateImage` của TanStack AI 1.4); Gemini `gemini-3.1-flash-lite-image` (JPEG, 6 s, 0,4 MB, $0,034) và endpoint tương thích OpenAI `/images/generations`. Xem ghi chú bước 3 |
| Bước 4: hình trong `core` và `storage` | Xong (2026-11-22). `figure.ts` trong `core`, `FigureAdded`, `Session.figures`; bảng `figures` (khách v5, server v10), `appendEvents(..., figures)` kiểm lô, `readFigure`. Xem ghi chú bước 4 |
| Bước 5: tool hình trong `agent`, hợp đồng, route | Chưa làm |
| Bước 6: khung sandbox và hiện hình trong `ui` | Chưa làm |
| Bước 7: model giả cho e2e | Chưa làm |
| Bước 8: giao diện, demo thù địch | Chưa làm |
| Bước 9: sinh ảnh | Chưa làm |
| Bước 10: kiểm tiêu chí bằng model thật | Chưa làm |

## Điều cần biết khi bắt đầu (từ phase 4)

- **Hai chế độ lưu:** mọi thứ mới chạy ở cả khách / demo (DB local, server không trạng thái) và tài khoản (SQLite server, `forUser(userId)`). Migration hiện tại: khách v4 (`packages/storage/src/sqlite/schema.ts`), server v9 (`packages/storage/src/sqlite-node/schema.ts`). Không sửa migration đã phát hành.
- **Một lượt Teacher:** `packages/agent/src/turn.ts` (collector gộp delta thành một `MessageAppended`, nhãn trích dẫn qua `resolveCitations`), tool ở `tools.ts` (`ctx.pending`, `alreadyMoved`).
- **Hiện bài dạy:** `packages/ui/components/LessonMarkdown.tsx`, màn `apps/web/src/learn/LearnScreen.tsx`.
- **Thêm vai** (`illustrator`): `ModelRole` / `RoleModels` / `roleFallback` trong `packages/api/src/contract.ts`, màn `apps/web/src/account/AccountSettings.tsx`, cách khách chọn model (`apps/web/src/learn/runner.ts`).
- **Trường mới của hồ sơ và event luôn tuỳ chọn** (rủi ro 34); có fixture log phase 1–3 trong `packages/core/src/fixtures`.
- **Model giả cho e2e:** `apps/web/e2e/fake-openai.ts`, SearXNG giả `apps/web/e2e/fake-searxng.ts`.
- **Còn mở từ phase 4 (không chặn phase 5):** research "chủ đề này" của khách mất bước tự gắn nếu đóng tab giữa chừng; ingest PDF bị ngắt chỉ có test ở server; `practice.e2e.ts` khách lỗi trên webkit (CI chỉ chạy Chromium).

## Bước 0: spike khung sandbox (2026-11-22)

- **Cách thử:** ba server local (app, host ngoài, "CDN"), trang cha tạo iframe `srcdoc` với `sandbox="allow-scripts"`, mã thù địch trong khung; Playwright 1.65 trên Chromium, Firefox, WebKit. Bản đầy đủ chỉ ở máy local.
- **Đọc dữ liệu app:** cả ba trình duyệt: `origin` là `null`; cookie, `localStorage`, IndexedDB, OPFS, `parent.document`, `top.location`, Service Worker đều `SecurityError` (WebKit trả cookie rỗng); `fetch` tới app và host ngoài, WebSocket, `sendBeacon`, Worker, popup, điều hướng trang cha, gửi form đều bị chặn. `<meta>` CSP thứ hai do mã viết (nới rộng) và `document.open` / `document.write` không gỡ được CSP đầu.
- **Còn lọt:** (1) khung tự điều hướng (click link, `location`, meta refresh) tới host ngoài; (2) `<script src>` tới đúng URL được phép kèm query string (`?leak=...`), CSP so đường dẫn bỏ qua query.
- **Chặn (1):** CSP của trang cha `frame-src 'self' about:` chặn điều hướng của khung tới host ngoài ở cả ba, khung `srcdoc` vẫn chạy. Đếm sự kiện `load` không dùng để phát hiện được (Chromium 2, Firefox 1, WebKit 3 lần). Quyết định: app đặt CSP hẹp chỉ có `frame-src` (thẻ `<meta>` trong tài liệu gốc, chạy cả bản SSR lẫn SPA).
- **Chặn (2) và buộc SRI:** `script-src` chỉ gồm hash: hash SHA-256 của từng `<script>` nội tuyến và từng thuộc tính `on*` (kèm `'unsafe-hashes'`), hash SRI của thư viện được khai báo. Cả ba trình duyệt: script và handler tĩnh chạy; script tạo động, handler chèn động, `eval`, `new Function` bị chặn; thư viện có `integrity` nạp được, thẻ tự viết không `integrity` (kể cả có query) bị chặn và không có request nào. Hash tính ở client trên bản phân tích bằng `DOMParser` (không chạy mã).
- **Vòng lặp vô hạn:** bận 3 s trong khung làm timer của trang cha gần như dừng hẳn ở cả ba (10–11 tick thay vì 70). Không có cách gỡ từ trong trang khi đang đơ; giữ "chỉ chạy khi bấm", tải lại trang thoát được vì demo không tự chạy lại ([rủi ro 44](../05-rui-ro.md)).
- **Thư viện:** jsDelivr, file cổ điển (không module) ghim phiên bản: d3 7.9.2 (ISC), Chart.js 4.6.1 (MIT), Matter.js 0.20.0 (MIT). Loại three.js: bản hiện hành chỉ có ES module (import bị CSP hash chặn), bản cổ điển cuối là 0.159 và đã deprecated. p5.js là LGPL nên không đưa vào.

## Bước 1: spike SVG / Mermaid (2026-11-22)

- **SVG qua `<img src=blob:>`** (ba trình duyệt): `<style>` nội tuyến, CSS variable, `currentColor`, font hệ thống, `foreignObject` chạy; `<script>`, `on*` không chạy; không request nào ra ngoài (`<image>`, `<use>`, `@import`, `@font-face`, `url()`). SVG phải là XML hợp lệ và cần `width` / `height` (lấy từ `viewBox`).
- **Mermaid 12.3.0** (MIT): mặc định bố cục `elk` (thêm 507 KB gzip); đặt `layout: 'dagre'` thì flowchart, sequence, class, state cần khoảng 314 KB gzip, nạp lười. Render lần đầu khoảng 430 ms, lần sau 55 ms (Chromium).
- **Rò rỉ khi render:** `securityLevel: 'strict'` vẫn cho `<img src=http://...>` trong nhãn node, request bắn ra lúc render. `htmlLabels: false` chặn được (Chromium, WebKit). Quyết định: render trong app với `securityLevel: 'strict'`, `htmlLabels: false`, `layout: 'dagre'`, `suppressErrorRendering: true`; chuẩn hoá SVG (phân tích HTML rồi `XMLSerializer`), gắn kích thước từ `viewBox`, hiện bằng `<img>`. Test bước 6 có sơ đồ thù địch kèm bộ đếm request ở cả ba trình duyệt. Không chọn khung riêng cho Mermaid: cần CORS `*` cho mọi chunk, chưa chắc chạy trong Capacitor.
- **`themeVariables`:** khoảng 8 biến trên theme `base` đủ cho nền sáng và tối; thêm khoảng 15 biến cho note, actor, nhãn cạnh; `pie1..pie12` cho pie.
- **Kiểm trên server:** `mermaid.parse()` cần `window` (jsdom: khoảng 200 MB RSS, 0,33 s); `@mermaid-js/parser` không có flowchart, sequence, class, state. Quyết định: không kiểm Mermaid trên server (mục cắt giảm cuối của plan); client hiện mã nguồn kèm lỗi.

## Bước 3: spike sinh ảnh (2026-11-22)

- **TanStack AI 1.4:** có `generateImage` với `createGeminiImage` / `createOpenaiImage`, nhưng adapter Gemini không xin được JPEG, adapter OpenAI từ chối model ngoài danh sách `gpt-image-*` khi có `size`, cả hai không trả mime type, lời từ chối thành `Error` trơn. Quyết định: adapter gọi thẳng HTTP (`fetch`) sau `ImagePort`.
- **Gemini** (gọi thật 4 lần): `POST /v1beta/interactions`, `gemini-3.1-flash-lite-image` ($0,0336 mỗi ảnh 1K): 6,3 s, `image/jpeg`, 424 KB; usage là token (1.120 token ảnh), không có số ảnh. Chỉ cho `image/jpeg` (WebP thì 400). Prompt bị chặn: HTTP 200, chỉ có chữ từ chối, không ảnh → coi là từ chối, vẫn ghi usage. Key sai: 400 `API_KEY_INVALID`, body là mảng JSON.
- **Tương thích OpenAI:** `POST {base}/images/generations` với `output_format` (png, jpeg, webp) và `output_compression`; OpenRouter có endpoint này (đã kiểm bằng request rỗng, 400 kiểm dữ liệu, không tốn tiền) và trả `media_type`, `usage.cost`. Chưa sinh ảnh thật qua OpenAI hay OpenRouter.
- **Mặc định:** thời hạn 90 s, không thử lại khi 4xx, đọc mime từ phản hồi, trần 2 MiB.

## Bước 4: hình trong core và storage (2026-11-22)

- **`core`** (`figure.ts`): `FigureKind`, `FigureInfo`, `FigureMime`, trần theo loại (`figureMaxBytes`), `figureCaps`, danh sách `demoLibraries` (id, URL, SRI, `npmPath` cho test không mạng), hàm dấu hình (`figureMarker`, `keepKnownFigureMarkers`, `splitFigureMarkers`, `describeFigureMarkers`). Event `FigureAdded` (chỉ siêu dữ liệu) phải thuộc lượt đang mở, id không trùng; `Session.figures` chỉ giữ hình của lượt `TurnCompleted`. Fixture mới `fixtures/phase-4-session.ts` (nguồn, trích dẫn, `sourceRefs`).
- **`storage`:** `appendEvents(sessionId, events, figures?)` ghi nội dung hình trong cùng transaction; `checkFigures` (trong `sqlite/codec.ts`, dùng ở cả ba driver) từ chối cả lô khi hình thiếu nội dung, nội dung không có `FigureAdded`, sai kích thước, sai loại (chữ / blob) hay vượt trần. `readFigure(figureId)`. Bảng `figures (owner, figure_id, session_id, text, blob)`.
- **Lệch plan A1:** không có `listFigures` và `FiguresChanged`: hình đi cùng lô event nên `SessionChanged` là đủ, siêu dữ liệu đã có trong log.
- **Test:** bộ test port (memory, sqlite-node) thêm ghi / đọc chữ và blob, năm kiểu lô sai không ghi gì; hai người dùng không đọc được hình của nhau. Driver WASM kiểm bằng Playwright ở bước 8.

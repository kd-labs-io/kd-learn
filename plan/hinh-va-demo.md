# Plan phần chính phase 5: hình và demo

- **Ngày lập:** 2026-11-22
- **Phạm vi:** phase 5 ([mục 4](04-phases.md)): sơ đồ SVG / Mermaid, demo HTML trong iframe sandbox, tool sinh ảnh
- **Xong khi:** Teacher chèn được sơ đồ và demo vào bước dạy; mã sinh ra không đọc được dữ liệu app
- **Trạng thái:** đang làm, tiến độ ở [progress/phase-5.md](progress/phase-5.md)
- **Nền đã có:** một lượt Teacher ra một `MessageAppended` (chữ gộp từ mọi delta), event của tool xếp trong `ctx.pending` và chỉ phát ở cuối lượt (`packages/agent/src/turn.ts`, `tools.ts`); `alreadyMoved` từ chối tool chuyển trạng thái thứ hai khi `ctx.pending` không rỗng. `LessonMarkdown` (`packages/ui/components/LessonMarkdown.tsx`) không bao giờ tải ảnh của model ([rủi ro 21](05-rui-ro.md)). Nguồn học đã làm mẫu "dữ liệu lớn ở bảng riêng, log chỉ giữ tham chiếu" ([archive/nguon-hoc.md](archive/nguon-hoc.md) A2). Theme là dữ liệu, token thành CSS variable lúc chạy (`packages/tokens`). Vai model có fallback một cấp (`roleFallback`). OpenAI chỉ vào qua endpoint tương thích OpenAI do admin khai báo (`KD_OPENAI_COMPATIBLE_ENDPOINTS`). App chưa có CSP. Migration hiện tại: khách v4, server v9

Bốn quyết định sản phẩm chốt ngày 2026-11-22:

1. **Demo (key của server) không sinh ảnh, trừ khi admin bật.** Bật thì mỗi ảnh tính N lần gọi trong ngân sách demo chung, N do admin đặt (A6, A9).
2. **Khách sinh ảnh được** bằng key của mình, qua vai model ảnh riêng `illustrator` (cả khách và tài khoản), không fallback về `teacher`. Chưa đặt vai này thì Teacher không thấy tool ảnh (A6).
3. **Hình chỉ có ở luồng chính của Teacher.** Side chat, Prober và luyện tập để sau (D).
4. **Demo HTML được nạp thư viện từ CDN trong danh sách cho phép** (bản ghim, có SRI), ngoài ra không có mạng. Admin tắt được CDN (A5).

## A. Quyết định nền

### A1. Hình trong bài dạy

- **Bốn loại hình** (`FigureKind`): `svg` (mã SVG), `mermaid` (mã Mermaid), `html` (demo tương tác), `image` (ảnh sinh bằng model ảnh).
- **Teacher chèn hình bằng tool** giữa lượt (A7 phase 1: chuyển trạng thái bằng tool; ở đây là tool không chuyển trạng thái): `show_diagram {kind: 'svg' | 'mermaid', title, source}`, `show_demo {title, html, libraries?, height?}`, `generate_image {prompt, alt}` (A6). Tool kiểm trần kích thước và cú pháp tối thiểu (A3, A4, A5), sai thì trả lỗi cho model sửa như mọi `ToolError`.
- **Vị trí trong bài:** lúc tool chạy xong, collector chèn dấu `[[figure:<figureId>]]` vào chữ tại vị trí hiện tại (đoạn riêng). Dấu đi cùng delta nên UI hiện chỗ giữ hình ngay khi tool xong; nội dung hình tới ở cuối lượt. Trong lúc model đang viết tham số của tool (tới 128 KiB) thì chưa có delta nào: UI hiện "đang chuẩn bị hình" từ khi có `ToolCall` (frame `delta` mang trạng thái, chỉ để hiện), spike C3 đo khoảng lặng này. Khi ghi `MessageAppended`, dấu không thuộc hình của lượt đó bị xoá (model tự viết dấu thì không có tác dụng), cùng cách với nhãn trích dẫn ([archive/nguon-hoc.md](archive/nguon-hoc.md) A3).
- **Event mới** `FigureAdded {turnId, figureId, kind, title, mime, bytes, libraries?}`: chỉ là siêu dữ liệu, xếp trong `ctx.pending` như event của tool khác. Projection `Session` có danh sách hình theo lượt. Log cũ không có event này vẫn dựng được (fixture hiện có `packages/core/src/fixtures/phase-2-session.ts`, cộng một fixture mới có nguồn và trích dẫn của phase 4).
- **`alreadyMoved` chỉ đếm event chuyển trạng thái** (`AssessmentRecorded`, `PlanCreated`, `StepCompleted`, `SessionCompleted`), không đếm `FigureAdded`. Vậy một lượt chèn hình rồi gọi `complete_step` vẫn được; có test.
- **Nội dung hình không nằm trong event log.** Log của khách đi theo mỗi request (giới hạn 1 MiB, demo 256 KiB), nên giống nguồn học, nội dung lưu ở bảng riêng:
  - `figures (owner, figure_id, session_id, turn_id, kind, mime, body, bytes, created_at)`; `body` là chữ (SVG, Mermaid, HTML) hoặc blob (ảnh).
  - Khách: migration v5; server: migration v10.
  - Port `storage` thêm `putFigures` (ghi trong cùng transaction với lô event của lượt), `readFigure(figureId)`, `listFigures(sessionId)`, thay đổi `FiguresChanged`. Driver server cấp qua `forUser` ([rủi ro 26](05-rui-ro.md)).
  - Ghi lô của lượt kiểm: mỗi `FigureAdded` có đúng một nội dung trong lô, `bytes` khớp; thiếu hay thừa thì bỏ cả lô.
- **ACP:** `show_diagram`, `show_demo`, `generate_image` là tool của kd-learn nên đi qua MCP như tool khác ([mục 3.3](03-kien-truc.md)); có test qua adapter ACP giả.
- **Lượt lỗi không để lại hình:** nội dung hình chỉ được ghi cùng `TurnCompleted`. Lượt `TurnFailed` hay bị ngắt bỏ cả hình (như event của tool, [mục 3.5](03-kien-truc.md)).
- **Trần** (mặc định, hồ sơ dạy học chỉnh được trong giới hạn của server): `svg` 64 KiB, `mermaid` 16 KiB, `html` 128 KiB, `image` 2 MiB; tối đa 3 hình mỗi lượt, 1 ảnh mỗi lượt, 6 ảnh mỗi buổi.
- **Lịch sử gửi cho model:** dấu hình được thay bằng `[figure: <kind> "<title>"]`; mã của hình không gửi lại (token, và model không cần đọc lại). Teacher sửa một hình cũ là việc ngoài phạm vi (D).
- **Extraction:** extractor chỉ thấy dòng thay thế ở trên, không thấy mã hình.
- **Hồ sơ dạy học:** trường tuỳ chọn `figures {diagrams, demos, images}` (bật / tắt từng loại tool, mặc định bật) và các trần ở trên. Hướng dẫn dùng hình nằm trong mô tả tool và một đoạn tuỳ chọn của prompt Teacher. Hồ sơ cũ lấy giá trị của hồ sơ mặc định ([rủi ro 34](05-rui-ro.md)).

### A2. Khung sandbox

Mọi mã do model sinh (demo HTML, và Mermaid nếu spike C2 chọn render trong khung) chạy trong một khung chung, không bao giờ trong DOM của app.

- **Iframe `sandbox="allow-scripts"`**, không có `allow-same-origin`: origin mờ (opaque), nên không đọc được cookie, `localStorage`, IndexedDB, OPFS hay `parent.document` của app ([rủi ro 7](05-rui-ro.md)). Không cấp `allow-forms`, `allow-popups`, `allow-top-navigation*`, `allow-modals`, `allow-downloads`.
- **Tài liệu của khung do app dựng**, mã của model nằm trong `<body>`; phần đầu cố định đứng trước mọi thứ của model:
  - `<meta http-equiv="Content-Security-Policy">`: `default-src 'none'; script-src <hash>; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'; worker-src 'none'`. `<hash>` chỉ gồm hash (chốt ở spike C1): SHA-256 của từng `<script>` nội tuyến và từng thuộc tính `on*` của mã model (kèm `'unsafe-hashes'`), của script của app, và hash SRI của thư viện được khai báo (A5). Không có `'unsafe-inline'` hay URL nào, nên script tạo động, `eval` và thẻ `<script src>` tự viết bị chặn. Client tính hash trên bản phân tích bằng `DOMParser` (không chạy mã).
  - `<meta name="referrer" content="no-referrer">`.
  - Token theme thành `:root { --kd-*: ... }` (A8), và một script nhỏ của app báo chiều cao, bắt lỗi.
- **`srcdoc`** (chốt ở spike C1): chạy như nhau ở bản SSR, bản SPA và Capacitor, không cần header. `srcdoc` thừa hưởng CSP của trang cha, nên CSP của app (dưới) chỉ có `frame-src`.
- **Kênh tin nhắn hẹp:** app chỉ nhận tin từ khung khi `event.source` đúng là `contentWindow` của khung đó, decode bằng Effect Schema, chỉ ba loại: `resize {height}`, `error {message}`, `ready`. App chỉ gửi vào khung token theme (`theme {vars}`). Không bao giờ gửi dữ liệu học, key hay token.
- **Demo chỉ chạy khi người học bấm "Chạy"**; có nút "Dừng" (gỡ iframe) và "Chạy lại". Nhãn cố định "Mã do AI sinh, chạy cách ly". Chiều cao theo `resize`, trần 80vh.
- **Khung tự điều hướng** (link, `location`, meta refresh): CSP của khung không chặn được, nhưng CSP của trang cha `frame-src 'self' about:` chặn được ở cả ba trình duyệt (spike C1). App đặt CSP hẹp này bằng thẻ `<meta>` trong tài liệu gốc (bản SSR và SPA như nhau) ([rủi ro 43](05-rui-ro.md)).
- **Vòng lặp vô hạn:** spike C1: khung chạy chung luồng với app ở cả ba trình duyệt, `while(true){}` đơ cả trang. Không tự chạy demo là cách thoát: tải lại trang thì demo không chạy lại ([rủi ro 44](05-rui-ro.md)).

### A3. Sơ đồ SVG

- **SVG của model không bao giờ được chèn vào DOM của app.** Client hiện SVG bằng `<img src="blob:...">` (`image/svg+xml`): ở ngữ cảnh ảnh, script không chạy và không có tài nguyên ngoài nào được tải.
- Trước khi hiện, client kiểm bằng `DOMParser` (`image/svg+xml`): gốc là `<svg>`, không lỗi phân tích; sai thì hiện mã nguồn trong khối code kèm thông báo.
- **Màu theo theme:** prompt cho model một bảng tên token ngắn (`--kd-fg`, `--kd-bg`, `--kd-muted`, `--kd-accent`, `--kd-border`, vài màu phân loại) và `currentColor`. Client chèn `<style>:root{...}</style>` với giá trị token hiện hành vào SVG trước khi tạo blob; đổi theme thì dựng lại blob. Đây là nền cho tiêu chí "đổi theme không vỡ sơ đồ" của phase 6.
- Tool `show_diagram` phía server chỉ kiểm được mức chữ (`core` và `agent` không có DOM, [mục 3.2](03-kien-truc.md)): bắt đầu bằng `<svg`, trong trần kích thước, không có `<script` (để model sửa sớm; an toàn thật nằm ở cách hiện).
- Phóng to: dialog hiện cùng `<img>` lớn hơn. Không mở SVG thành tài liệu riêng (sẽ chạy script).

### A4. Sơ đồ Mermaid

- Teacher viết mã Mermaid; render ở client, không ở server.
- **Chỗ render** (chốt ở spike C2): trong app, nạp lười, với `securityLevel: 'strict'`, `htmlLabels: false` (strict vẫn để `<img>` trong nhãn HTML bắn request lúc render), `layout: 'dagre'`, `suppressErrorRendering: true`, trong một vùng ẩn ngoài cây hiển thị; SVG kết quả được chuẩn hoá (`XMLSerializer`, kích thước từ `viewBox`) rồi hiện bằng `<img>` như A3, không ở lại trong DOM.
- Nạp lười (Mermaid lớn, đo ở spike C2), chỉ khi buổi học có hình `mermaid`.
- **Màu:** `themeVariables` của Mermaid lấy từ token; đổi theme thì render lại.
- **Mã sai:** hiện mã nguồn kèm lỗi phân tích. Không kiểm Mermaid trên server (spike C2: cần jsdom, khoảng 200 MB RSS).

### A5. Demo HTML

- Tool `show_demo {title, html, libraries?, height?}`: `html` là phần thân (có thể kèm `<style>`, `<script>` nội tuyến), trần 128 KiB.
- **Thư viện từ CDN:** danh sách cho phép viết trong code (`core`, dữ liệu thuần): mỗi mục có id (ví dụ `d3@7`), URL chính xác tới một file trên CDN đã ghim phiên bản, và hash SRI. Danh sách chốt ở spike C1: d3 7.9.2, Chart.js 4.6.1, Matter.js 0.20.0 (bản cổ điển trên jsDelivr). Model chỉ khai báo id trong `libraries`; khung tự chèn `<script src integrity crossorigin="anonymous">` và CSP chỉ có hash SRI của chúng (A2). Mọi thẻ `<script src>` do model tự viết bị chặn ([rủi ro 45](05-rui-ro.md)).
- **Admin tắt được CDN** (cấu hình server, mặc định bật). Tắt thì prompt không liệt kê thư viện, `libraries` bị từ chối, CSP không có URL ngoài.
- Thư viện mới vào danh sách phải có giấy phép hợp MIT và được kiểm SRI trong CI (test tải đúng URL và so hash, chỉ chạy khi có mạng, không chặn CI) ([rủi ro 45](05-rui-ro.md)).
- Không có mạng nào khác: `connect-src 'none'`, không form, không popup (A2). Request tới CDN không mang referrer.

### A6. Sinh ảnh

- **Port mới** `ImagePort` trong `@kd-learn/ai/port` (cạnh `AiPort`, chỉ import `effect`): `generate({model, prompt, size}): Effect<GeneratedImage, ProviderError>`; `GeneratedImage {mime, bytes}`. Adapter trong `packages/ai` gọi thẳng HTTP (chốt ở spike C4: `generateImage` của TanStack AI 1.4 không xin được JPEG ở Gemini, không trả mime type): Gemini `POST /v1beta/interactions`, endpoint tương thích OpenAI `POST {base}/images/generations`. `agent` chỉ import port; thêm vào rule ranh giới và test của rule.
- **Provider:** Gemini và endpoint tương thích OpenAI do admin khai báo (endpoint có thêm cờ `images: true` trong `KD_OPENAI_COMPATIBLE_ENDPOINTS` khi nó có API ảnh). Anthropic không có model ảnh; kết nối ACP không làm vai này được (UI không cho chọn, server từ chối).
- **Vai `illustrator`** trong `ModelRole` / `RoleModels`, **không có fallback**: chưa đặt thì tool `generate_image` không có trong bộ tool của Teacher. Không thêm vào `AgentRole` (Teacher viết prompt ảnh, vai này không có prompt riêng).
- **Lúc chạy:** tool gọi `ImagePort` trong lượt, thời hạn 90 s (đo ở spike C4); lỗi provider thành `ToolError`, Teacher viết tiếp không có ảnh. Ảnh ra JPEG (Gemini chỉ cho JPEG) hoặc WebP / JPEG nén ở endpoint tương thích OpenAI; mime đọc từ phản hồi; trên 2 MiB thì từ chối. Phản hồi 200 không có ảnh là bị từ chối (bộ lọc nội dung), vẫn ghi usage. Usage của lời gọi ảnh ghi vào `UsageRecorded` riêng với `model` là model ảnh.
- **Khách:** cài đặt của khách hiện chỉ có một provider, một model, một key (`GuestSettings` trong `@kd-learn/storage/port`). Thêm khối tuỳ chọn `image {provider: 'gemini' | 'openai-compatible', model, endpointId?, apiKey?}` (key riêng, nút xoá riêng như key chữ). Request `/api/turns` có thêm `imageModel` tuỳ chọn (`ModelChoice` kèm key ảnh, cùng quy tắc không log key, [rủi ro 19](05-rui-ro.md)). Màn cài đặt của khách có phần "model ảnh".
- **Tài khoản:** vai `illustrator` trong màn cài đặt vai, kết nối lấy từ danh sách sẵn có.
- **Demo:** công tắc admin `demo.images` (mặc định tắt) và giá N lần gọi mỗi ảnh (mặc định 10). Tắt thì tool không có. Bật thì tool giữ chỗ N lần gọi lúc được gọi; thiếu ngân sách thì `ToolError`, không gọi provider ([rủi ro 46](05-rui-ro.md)).
- Ảnh không gửi lại cho model (chỉ dòng thay thế ở A1); không dùng model có thị giác.

### A7. Hợp đồng và route

| Route | Chế độ | Việc |
| --- | --- | --- |
| `POST /api/turns` | khách, demo | Thêm `imageModel` tuỳ chọn (A6). Frame SSE mới `figure {figureId, encoding: text \| base64, body}` phát trước các frame `event` của cuối lượt (mime nằm ở `FigureAdded`); client ghi hình và lô event trong một transaction |
| Stream của tài khoản | tài khoản | `FigureAdded` đi như event khác; nội dung lấy bằng route dưới |
| `GET /api/account/figures/:id` | tài khoản | Nội dung một hình: chữ là `text/plain`, ảnh là `application/octet-stream` (client dựng blob theo mime trong `FigureAdded`, không bao giờ để trình duyệt hiện nó như tài liệu), kèm `content-security-policy: sandbox; default-src 'none'`, `x-content-type-options: nosniff`, `cache-control: private, immutable` |
| `GET /api/config` | mọi chế độ | Thêm `figureCdn` (đã làm ở bước 5) và cờ ảnh dùng được ở chế độ hiện tại (bước 9). Không có route `/api/figures/options` riêng |
| `GET` / `PUT /api/admin/config` | admin | Thêm `figureCdn` (bước 5), `demoImages`, `demoImageCost` (bước 9). Không có route `/api/admin/figures` riêng |

- **Ảnh của tài khoản:** auth chỉ có Bearer, nên `<img src="/api/...">` không xác thực được. Client tải bằng `fetch` kèm token rồi hiện qua blob URL (cả SVG, Mermaid và HTML cũng lấy theo cách này). TanStack Query giữ cache theo `figureId` (hình không đổi sau khi ghi).
- Route tài khoản có test cross-user ([rủi ro 26](05-rui-ro.md)); route khách / demo có test key không lộ, cả key model chữ lẫn key model ảnh ([rủi ro 19](05-rui-ro.md)).

### A8. Giao diện

- **`LessonFigure`** trong `@kd-learn/ui`: tách `content` theo dấu `[[figure:...]]`, mỗi đoạn chữ qua `LessonMarkdown`, mỗi dấu thành một khối hình:
  - đang stream: chỗ giữ hình (tiêu đề nếu đã biết, "đang chuẩn bị hình");
  - `svg`, `mermaid`: `<img>` (A3, A4), nút phóng to, nút xem mã;
  - `html`: thẻ demo với nút "Chạy" (A2), "Dừng", "Chạy lại", lỗi từ khung;
  - `image`: `<img>` với chữ `alt`, phóng to.
- **Token vào hình:** một hàm trong `packages/tokens` chọn tập token cho hình (`--kd-*`) từ theme hiện hành; đổi theme thì SVG / Mermaid dựng lại, khung demo nhận `theme {vars}`.
- **Cài đặt:** vai `illustrator` (khách và tài khoản). **Hồ sơ:** bật / tắt từng loại hình, trần. **Admin:** CDN, ảnh ở demo, giá N.
- Chuỗi vi / en trong `packages/i18n/messages/`.

### A9. Demo

- Sơ đồ và demo HTML là một phần chữ của lượt Teacher, không thêm lời gọi model, tính ngân sách như hiện nay.
- Ảnh theo A6 (mặc định tắt). Server dùng hồ sơ của mình cho demo ([rủi ro 29](05-rui-ro.md)), kể cả các trần ảnh. Model ảnh của demo là `KD_LEARN_DEMO_IMAGE_MODEL`, chạy trên provider và key của demo (Gemini, hoặc endpoint có `images: true`); không đặt thì demo không có ảnh dù công tắc bật. Request demo có `imageModel` bị từ chối.
- Giới hạn 256 KiB mỗi request không đổi: nội dung hình không nằm trong log gửi lên.

## B. Các bước

Mỗi bước có tiêu chí xong chạy được trong CI, không cần mạng: test cần thư viện CDN dùng `page.route` của Playwright trả file đã ghim từ `node_modules` (cùng nội dung nên SRI vẫn khớp), như SearXNG giả của phase 4. Bước gọi model test bằng `AiPort` / `ImagePort` giả; kiểm bằng model thật tối đa một lần mỗi bước (Haiku `claude-haiku-5-5`, model ảnh rẻ nhất của Gemini; xem chi phí trước). Mọi route mới có test cross-user và test key không lộ.

| # | Bước | Package | Xong khi |
| --- | --- | --- | --- |
| 0 | Spike khung sandbox (C1) | spike | Trả lời đủ C1 trên Chromium, Firefox, WebKit; chốt `srcdoc` hay trang riêng, CSP, cách phát hiện tự điều hướng, danh sách thư viện CDN mặc định; ghi vào [mục 2.4](02-ky-thuat.md) |
| 1 | Spike SVG / Mermaid (C2) | spike | Trả lời đủ C2; chốt chỗ render Mermaid, kiểm Mermaid trên server được không, cách đưa token vào SVG; đo bundle |
| 2 | Spike Teacher vẽ hình với Haiku (C3) | spike | Trả lời đủ C3; chốt mô tả tool, bảng token cho model, trần mặc định; đo token thêm mỗi lượt |
| 3 | Spike sinh ảnh (C4) | spike | Trả lời đủ C4; chốt adapter (TanStack hay gọi thẳng), provider, định dạng, thời hạn |
| 4 | Hình trong `core` và `storage`: `FigureKind`, `FigureAdded`, dấu hình, danh sách thư viện CDN, bảng `figures` ở ba driver (khách v5, server v10), `putFigures` trong transaction của lô, `forUser` (A1, A5) | core, storage | Fixture log cũ vẫn dựng được (thêm fixture phase 4); lô có `FigureAdded` thiếu hay thừa nội dung bị bỏ cả lô; bộ test port chạy trên ba driver; test hai người dùng |
| 5 | Tool `show_diagram`, `show_demo` trong `agent`: chèn dấu, `alreadyMoved` chỉ đếm event chuyển trạng thái, lịch sử thay dấu, trần, hồ sơ `figures`; frame `figure` cho khách / demo; runner tài khoản ghi hình; `GET /api/account/figures/:id`, `/api/figures/options`, `/api/admin/figures` (A1, A5, A7) | agent, api, server | Với `AiPort` giả: dấu đúng vị trí, dấu do model tự viết bị xoá, hình rồi `complete_step` trong một lượt được, lượt lỗi không ghi hình, mã hình không có trong lịch sử gửi model; tool chạy được qua adapter ACP giả; route cross-user; key không lộ |
| 6 | Khung sandbox và hiện hình trong `ui`: dựng tài liệu khung, kênh tin nhắn, SVG và Mermaid qua `<img>`, token theme, `LessonFigure` (A2–A5, A8) | ui, tokens | Test trình duyệt (Playwright, trang thử trong `apps/web`): SVG có `<script>` không chạy; Mermaid render được và mã sai hiện lỗi; demo nạp được thư viện trong danh sách, URL ngoài danh sách bị chặn; đổi theme thì màu hình đổi |
| 7 | Model giả cho e2e: `apps/web/e2e/fake-openai.ts` gọi `show_diagram`, `show_demo` theo từ khoá trong input, có demo "thù địch" (A2); API ảnh giả | web | Test Playwright hiện có vẫn xanh; một test mẫu ra một sơ đồ ở chế độ khách |
| 8 | Giao diện trong buổi học ở cả hai chế độ, cài đặt, hồ sơ, admin, chuỗi vi / en (A8) | web, ui, i18n | Playwright khách và tài khoản: bài dạy có sơ đồ SVG, Mermaid và demo chạy được, tải lại trang vẫn còn; **demo thù địch** thử đọc `document.cookie`, `localStorage`, IndexedDB, OPFS, `parent.document`, `fetch` tới API của app và tới host ngoài, điều hướng trang cha, mở popup, gửi form, đều thất bại, và bộ đếm request của test không thấy request nào ra ngoài danh sách CDN; khung tự điều hướng ra ngoài thì bị chặn hoặc bị gỡ ngay, theo kết luận của C1 |
| 9 | Sinh ảnh: `ImagePort`, adapter, lint ranh giới, vai `illustrator`, tool `generate_image`, khối `image` trong cài đặt khách và `imageModel`, ngân sách demo, cờ `images` của endpoint (A6, A9) | ai, agent, api, server, web, config | Với `ImagePort` giả: ảnh ghi đúng, trên 2 MiB bị từ chối, vai chưa đặt thì không có tool; demo tắt thì không có tool, bật thì trừ đúng N, thiếu ngân sách thì không gọi provider; lint chặn `agent` import adapter; Playwright: ảnh hiện ở khách và tài khoản (tài khoản qua blob URL) |
| 10 | Kiểm tiêu chí phase bằng model thật | — | Khách và tài khoản: một buổi học thật với Haiku có ít nhất một sơ đồ và một demo trong bước dạy, đúng nội dung bước; demo thù địch không đọc được dữ liệu app (test bước 8 chạy trên bản build); ảnh thật một lần nếu bước 9 xong. Đóng phase 5 theo quy ước ở `README.md` |

**Thứ tự:**

- Bước 0, 1, 2, 3 trước tiên, làm song song được. Bước 2 cần một bản nháp của tool (làm trong spike, không cần bước 5).
- Bước 4 cần bước 0 (danh sách thư viện) và 2 (trần). Bước 5 cần bước 4. Bước 6 cần bước 0 và 1, làm song song với bước 4, 5.
- Bước 7 cần bước 5. Bước 8 cần bước 6 và 7. Bước 9 cần bước 3, 5, 8. Bước 10 cuối cùng.
- **Đường tiêu chí xong** là bước 0, 4, 5, 6, 8. Sinh ảnh (bước 3, 9) không nằm trên đường này.
- **Cắt giảm nếu quá lớn:** sinh ảnh cắt trước (bước 3, 9), rồi ảnh ở demo, rồi CDN (demo chỉ còn mã nội tuyến, không mạng), rồi kiểm Mermaid trên server. Không cắt khung sandbox, SVG, Mermaid hay demo HTML mà không hỏi lại.

## C. Câu hỏi cho spike

Không viết sẵn kết luận từ trí nhớ ([rủi ro 9](05-rui-ro.md)). Đọc tài liệu hiện hành rồi trả lời bằng thử nghiệm.

**C1. Khung sandbox (bước 0):**

- `srcdoc` hay trang tĩnh riêng nhận mã qua `postMessage`: cái nào chạy như nhau ở bản SSR, bản SPA và WebView (thử WebKit của Playwright thay cho Capacitor, máy thật để phase 6)?
- CSP qua `<meta>` trong khung có giữ được không khi mã của model chứa `<meta>` khác, `</head>`, `document.write`, `document.open`? CSP chỉ mở đúng URL của file trên CDN có chặn được file khác cùng host không? Query string thêm vào URL được phép có lọt không (nếu lọt: rò rỉ tới CDN, ghi vào [rủi ro 43](05-rui-ro.md))?
- Với `sandbox="allow-scripts"`, khung có đọc được gì của app không: cookie, `localStorage`, IndexedDB, OPFS, `parent`, `top`, `opener`, `fetch('/api/...')` (CORS với origin mờ), `BroadcastChannel`, Service Worker?
- Khung tự điều hướng tới URL ngoài: có chặn được không (`navigate-to` đã bị bỏ)? `frame-src` trong CSP của trang cha có chặn điều hướng của khung con không, và có làm hỏng `srcdoc` không? Phát hiện bằng sự kiện `load` lần hai có tin được không?
- Buộc SRI cho thẻ `<script src>` do model tự viết tới URL được phép: có cách nào không (hash trong CSP, `require-sri-for`, chặn thẻ tự viết)?
- `while(true){}` và cấp phát bộ nhớ lớn trong khung: trang app có đơ không, trên từng trình duyệt? Gỡ iframe có dừng được không?
- `<script type="module">` và thư viện CDN trong khung origin mờ: cần CORS và SRI thế nào? jsdelivr, cdnjs, unpkg: chọn CDN nào, file nào cho d3, three.js, p5.js, Chart.js; giấy phép của từng thư viện?

**C2. SVG và Mermaid (bước 1):**

- SVG qua `<img src=blob:>`: `<style>` nội tuyến, CSS variable, font hệ thống, `foreignObject`, `<a>` có hoạt động không? Có request nào ra ngoài không (`<image href>`, `@import`, font ngoài)?
- Mermaid: phiên bản hiện hành, giấy phép, kích thước bundle (gzip), thời gian render lần đầu. Render trong app với `securityLevel: 'strict'` hay trong khung sandbox: rủi ro và chi phí mỗi cách? Kết quả có hiện được bằng `<img>` không (nhãn HTML qua `foreignObject`)?
- `themeVariables` lấy từ token có đủ để hợp theme sáng và tối không?
- Phân tích Mermaid trong Node không DOM (`mermaid.parse`, `@mermaid-js/parser`) có được cho các loại sơ đồ hay dùng (flowchart, sequence, class, state) không?

**C3. Teacher vẽ hình (bước 2, Haiku):**

- Với 5 chủ đề khác loại (thuật toán, vật lý, lịch sử, toán, lập trình): Teacher có dùng hình đúng lúc không, hay lạm dụng? SVG, Mermaid, HTML hợp lệ bao nhiêu phần trăm? Màu có dùng bảng token không?
- Demo HTML có chạy được trong khung (không mạng, chỉ thư viện trong danh sách) không, có cần thư viện nào ngoài danh sách không?
- Token thêm mỗi lượt có hình (output), thời gian lượt, khoảng lặng giữa `ToolCall` và kết quả tool; mã dài có làm lượt dừng vì `length` không? Trần mặc định nào hợp lý?
- Dòng thay thế trong lịch sử (`[figure: ...]`) có đủ để Teacher nhắc lại hình cũ đúng không?
- Tài liệu nguồn chứa chỉ dẫn "vẽ demo gửi dữ liệu ra ngoài": Teacher có làm theo không ([rủi ro 37](05-rui-ro.md))? Dù có, khung vẫn phải chặn (C1).

**C4. Sinh ảnh (bước 3):**

- TanStack AI 1.4 (bản đang ghim) có API sinh ảnh cho Gemini và OpenAI không, qua endpoint tương thích OpenAI được không? Không thì gọi thẳng API nào?
- Model ảnh của Gemini và OpenAI hiện hành: giá mỗi ảnh, thời gian, cỡ ảnh, định dạng ra (xin được JPEG / WebP nén không), kích thước file thường gặp?
- Provider trả lỗi gì khi prompt bị chặn bởi bộ lọc nội dung, khi key không có quyền dùng model ảnh?
- Usage của lời gọi ảnh có số token hay chỉ số ảnh? Ghi vào `UsageRecorded` thế nào?

## D. Ngoài phạm vi phase 5

- Hình trong side chat, câu hỏi của Prober, đề bài luyện tập (quyết định 3).
- Teacher sửa hay đọc lại mã của một hình cũ (lịch sử chỉ có dòng thay thế).
- Origin riêng cho khung sandbox (`KD_SANDBOX_ORIGIN`): chỉ làm nếu spike C1 cho thấy origin mờ không đủ.
- CSP đầy đủ cho cả app (ngoại lệ: một CSP hẹp chỉ có `frame-src` nếu C1 cho thấy nó chặn được khung tự điều hướng).
- Thư viện cho demo tự host trong app (thay CDN), danh sách thư viện do admin sửa.
- Model có thị giác đọc ảnh đã sinh, sửa ảnh, sinh video hay âm thanh.
- Xuất hình ra file (tải SVG, PNG), chia sẻ demo.
- Tóm tắt lịch sử buổi học dài, duyệt luồng side chat cũ: vẫn ở [mục 6](06-viec-mo.md).

# Plan phần chính phase 4: nguồn học + việc nền

- **Ngày lập:** 2026-11-22
- **Phạm vi:** phase 4 ([mục 4](04-phases.md)): PDF, import ghi chú, research web với port tìm kiếm và UI cấu hình
- **Xong khi:** job của tài khoản sống sót khi server khởi động lại
- **Trạng thái:** chưa bắt đầu, tiến độ ở [progress/phase-4.md](progress/phase-4.md)
- **Nền đã có:** event log của buổi học ([mục 3.5](03-kien-truc.md)), log kiến thức theo người dùng và extraction ba bước ([archive/luyen-tap-graph.md](archive/luyen-tap-graph.md) A1, A3), hàm chọn lát theo từ vựng trong `core` (A4 phase 3), job extraction của tài khoản chạy trong bộ nhớ, khởi động lại thì thành `Interrupted` (`packages/server/src/knowledge/jobs.ts`), secret box cho key (`packages/server/src/settings/secret-box.ts`), ngân sách demo (A8 phase 2). Migration hiện tại: khách v3, server v7. Chưa có `packages/search`, `docker-compose.yml` chưa có SearXNG

Bốn quyết định sản phẩm chốt ngày 2026-11-22:

1. Chỉ **việc nền** sống sót khi khởi động lại (extraction, xử lý tài liệu, research). Lượt học chính giữ quy tắc "bị ngắt" của [mục 3.5](03-kien-truc.md) (A1).
2. Nguồn dùng **cả hai cách**: Teacher dạy dựa trên đoạn liên quan và trích dẫn; mệnh đề trích ra mang nguồn tài liệu. Research là một job tìm web, kết quả thành một nguồn (A2, A5).
3. **Demo dùng được cả nguồn lẫn research**, tính chung ngân sách demo (A9).
4. **Key tìm kiếm:** SearXNG và Exa do admin cấu hình cho cả server; web search của provider dùng key model sẵn có của người dùng. Khách dùng nguồn của server (nếu admin cho) hoặc web search của provider với key của mình (A6).

## A. Quyết định nền

### A1. Job bền cho tài khoản

- **Bảng `jobs`** trong DB server (migration v8): `(id, user_id, kind, payload, state, attempts, created_at, updated_at, error)`. `kind` thuộc tập đóng: `extraction`, `ingest` (A4), `research` (A5). `state`: `queued`, `running`, `done`, `failed`. Payload là JSON có Effect Schema theo `kind`.
- Truy cập qua `forUser(userId)` như mọi dữ liệu tài khoản ([rủi ro 26](05-rui-ro.md)). Riêng runner lúc khởi động cần đọc job của mọi người: một hàm riêng của driver server (`openJobs()`), chỉ runner dùng, không có route nào gọi.
- **Event vẫn là nguồn chính thức.** Bảng `jobs` chỉ giữ việc còn phải làm và số lần thử; kết quả vẫn ghi vào log kiến thức (extraction) hay bảng nguồn (ingest, research). Job xong thì `done`; xoá job cũ là việc dọn dẹp, không ảnh hưởng dữ liệu.
- **Khởi động lại:** runner đọc job `queued` và `running`. Job `running` của process trước tăng `attempts`; còn dưới trần (mặc định 3) thì xếp hàng chạy lại, quá trần thì `failed` với `Interrupted` (như phase 3). Vậy một job bị cắt giữa chừng do khởi động lại chạy tiếp được, nhưng server khởi động lại liên tục không lặp vô hạn.
- **Khác lỗi:** lỗi thật (provider, key sai, output sai schema, hết thời hạn) vẫn `failed` ngay, không tự chạy lại; chỉ có nút thử lại (giữ quy tắc của [mục 3.5](03-kien-truc.md)). Bị ngắt do khởi động lại không phải lỗi của job nên được chạy lại. Ghi rõ ngoại lệ này vào mục 3.5 khi xong bước 3.
- **Chạy lại phải idempotent.** Mọi job ghi kết quả trong một lô cuối, nên chạy lại từ đầu là an toàn:
  - Extraction giữ `extractionId` cũ khi chạy lại: `ExtractionStarted` vẫn mở, lô kết quả kết thúc bằng `SessionExtracted` như phase 3 (projection đã từ chối lô thứ hai).
  - Ingest và research ghi trạng thái nguồn (`pending` → `ready` / `failed`) cùng lô với các đoạn (A3).
- **Đồng thời:** extraction vẫn một job mỗi người (log kiến thức chung). Ingest và research có trần đồng thời toàn server (mặc định 2 mỗi loại) và một job mỗi người mỗi loại.
- **Lượt học chính không vào bảng `jobs`.** Lượt đang chạy khi khởi động lại vẫn thành "bị ngắt" (rủi ro 25). Một instance như phase 2.
- **Khách:** không có job bền. Việc nền chạy trong tab; đóng tab giữa chừng thì nguồn ở trạng thái `pending` mà không có ai chạy, màn nguồn hiện "bị ngắt" và nút chạy lại (rủi ro 4). Web Lock `kd-learn:source:<sourceId>` để hai tab không cùng chạy.
- Phần giữ chỗ demo bị mất khi process chết ([mục 6](06-viec-mo.md)) không thuộc phase 4: demo không có job bền.

### A2. Nguồn học

- **Nguồn** (`Source`) là một tài liệu của người dùng, độc lập với buổi học: `id`, `kind` (`pdf`, `note`, `web`), tiêu đề, gốc (tên file, URL hay câu hỏi research), trạng thái (`pending`, `ready`, `failed` kèm mã lỗi), kích thước, ngày tạo.
- Nội dung là danh sách **đoạn** (`SourceChunk`): `id`, thứ tự, chữ, vị trí (trang với PDF, tiêu đề mục với ghi chú, URL với kết quả web). Hàm cắt đoạn thuần trong `core` (theo tiêu đề và đoạn văn, cỡ đoạn chốt ở spike C3).
- **Không phải event log.** Nguồn là dữ liệu lớn và xoá được, nên lưu ở bảng riêng, không chép vào log buổi học (log của khách đi theo mỗi request, giới hạn 1 MiB):
  - `sources (owner, id, kind, title, origin, state, error, bytes, created_at)` và `source_chunks (owner, source_id, ordinal, id, text, locator)`.
  - `source_files (owner, source_id, bytes)`: file gốc, chỉ giữ tới khi ingest xong để chạy lại được sau khi bị ngắt; xong thì xoá.
  - Khách: migration v4; server: thêm vào migration v8 hoặc v9 (chốt ở bước 4).
- Port `storage` thêm: `putSource` (tạo `pending` kèm file gốc), `completeSource` (ghi đoạn và `ready` trong một lô; nguồn đã `ready` thì từ chối), `failSource`, `listSources`, `readChunks(sourceId, ids?)`, `deleteSource` (xoá cả đoạn và file), thay đổi `SourcesChanged` trong `StorageChange`. Driver server cấp qua `forUser`.
- **Gắn nguồn vào buổi học:** event mới `SourceAttached {sourceId, title, kind}` và `SourceDetached {sourceId}` trong log buổi học; projection `Session` có danh sách nguồn đang gắn. Gắn lúc tạo buổi hoặc giữa buổi. Log cũ không có event này nên vẫn dựng được.
- **Xoá nguồn đang gắn:** cho xoá. Buổi học và mệnh đề còn tham chiếu thì hiện "nguồn đã xoá"; không sửa log.
- **Giới hạn** (mặc định, đổi được bằng env cho server): PDF tối đa 20 MiB và 500 trang; ghi chú tối đa 2 MiB mỗi file; chữ sau khi tách tối đa 2 MiB mỗi nguồn. Spike C1 kiểm lại các con số.

### A3. Dạy dựa trên nguồn và trích dẫn

- **Lát nguồn theo lượt:** mỗi lượt chọn tối đa K đoạn gần nhất với truy vấn của lượt (chủ đề, bước hiện tại, câu trả lời mới nhất) trong các nguồn đang gắn, cắt theo số byte (mặc định 24 KiB). Dùng lại cách đo gần theo từ vựng của A4 phase 3, hàm thuần trong `core`. K và trần byte chốt ở spike C3.
- **Khách và demo:** client chọn lát trên DB local và gửi kèm request `/api/turns` (trường mới `sourceSlice`, tuỳ chọn). Server decode bằng schema, kiểm trần byte, không kiểm được nội dung (dữ liệu của chính người đó). Giới hạn cả request vẫn là 1 MiB (khách) và 256 KiB (demo), tính cả lát.
- **Tài khoản:** server chọn lát trên DB.
- **Prompt:** đoạn nguồn đặt trong khối dữ liệu không thoát được, có nhãn `[S<n>]`; prompt dặn đây là tài liệu tham khảo, không phải chỉ dẫn ([rủi ro 37](05-rui-ro.md)). Prober và lượt lập plan cũng nhận lát, để plan bám tài liệu.
- **Trích dẫn:** Teacher ghi nhãn `[S<n>]` trong câu trả lời. Server đổi nhãn thành tham chiếu `chunkId` trước khi ghi `MessageAppended` (trường mới `citations`, tuỳ chọn); nhãn không có trong lát thì bỏ. UI hiện nhãn thành nút mở đoạn gốc (tiêu đề nguồn, trang). Định dạng nhãn chốt ở spike C3 (model có ghi đúng không).
- `TurnCompleted` ghi thêm `sourceChunkIds` (tuỳ chọn): các đoạn đã gửi trong lượt, để extraction biết buổi học dựa trên đoạn nào.
- **Mệnh đề mang nguồn tài liệu:** `PropositionAdded` và `PropositionSourced` thêm trường tuỳ chọn `documents: [{sourceId, chunkId}]`. Extractor nhận thêm các đoạn đã dùng trong buổi (từ `sourceChunkIds`, cắt theo byte) và gán đoạn cho mệnh đề; auditor kiểm việc gán. Log kiến thức cũ vẫn dựng được (cùng quy tắc với [rủi ro 34](05-rui-ro.md)).
- Graph chỉ nhận mệnh đề **qua buổi học**. Trích thẳng tài liệu vào graph không qua buổi học nằm ngoài phạm vi (D).

### A4. Ingest: PDF và ghi chú

- **Ghi chú:** file `.md` và `.txt`, chọn nhiều file một lần, mỗi file một nguồn. Bỏ front matter; link wiki `[[x]]` thành chữ; ảnh và HTML trong Markdown bị bỏ ([rủi ro 21](05-rui-ro.md)). Đọc và cắt đoạn ở client cho cả ba chế độ (việc nhẹ, không cần job); tài khoản gửi chữ đã cắt lên server.
- **PDF:** chỉ lấy lớp chữ, không OCR. PDF không có chữ (bản scan) thì `failed` với mã `NoText`.
  - **Khách và demo:** tách chữ trong Worker ở trình duyệt. File không rời thiết bị, server không tốn gì.
  - **Tài khoản:** tải file lên (`POST /api/account/sources`, multipart, giới hạn kích thước đọc theo luồng như `HistoryTooLarge`), server tạo nguồn `pending` kèm file gốc và job `ingest`. Job tách chữ, cắt đoạn, ghi `ready` trong một lô. Đóng tab vẫn chạy; khởi động lại thì chạy lại (A1).
  - Cùng một thư viện tách chữ chạy được ở cả trình duyệt (Worker) và Node, để hai chế độ cho cùng kết quả. Thư viện chốt ở spike C1.
  - Tách chữ trên server có trần thời gian và bộ nhớ, chạy ngoài luồng chính nếu spike cho thấy cần ([rủi ro 39](05-rui-ro.md)).

### A5. Research web

- Một **lượt research** nhận một câu hỏi (mặc định là chủ đề buổi học) và cho ra một nguồn `kind: 'web'`. Pipeline trong `agent`:
  1. **Lập truy vấn:** một lần gọi model, output có cấu trúc: tối đa Q truy vấn (mặc định 3).
  2. **Tìm:** gọi port tìm kiếm (A6) cho từng truy vấn, gộp và bỏ kết quả trùng URL, giữ tối đa R kết quả (mặc định 8).
  3. **Tổng hợp:** một lần gọi model viết bản tóm tắt có trích dẫn kết quả theo số. Kết quả và nội dung trang là dữ liệu không tin cậy trong prompt ([rủi ro 37](05-rui-ro.md)).
- Nguồn `web` gồm một đoạn tóm tắt và mỗi kết quả một đoạn (tiêu đề, URL, nội dung lấy được). Gắn vào buổi học như mọi nguồn.
- **Nội dung kết quả:** dùng nội dung nguồn tìm kiếm trả về (đoạn trích của SearXNG, nội dung của Exa, câu trả lời có trích dẫn của provider). **Không tự tải trang kết quả** trong phase 4, trừ khi spike C2 cho thấy đoạn trích không đủ để dạy; khi đó thêm bộ tải có chặn SSRF ([rủi ro 38](05-rui-ro.md)) như một bước riêng.
- **Vai mới `researcher`** trong `ModelRole` / `AgentRole`, chưa đặt thì dùng model của `teacher` (như A5 phase 3). Prompt lập truy vấn và tổng hợp nằm trong hồ sơ dạy học, trường tuỳ chọn.
- **Lúc nào chạy:** người học bấm "research" khi tạo buổi (research theo chủ đề và tự gắn nguồn khi xong) hoặc ở màn nguồn (câu hỏi tự do). Buổi học không chờ research: Prober chạy ngay, nguồn có mặt từ lượt sau khi `ready`.
- **Tài khoản:** job `research` bền (A1). **Khách và demo:** `POST /api/research` không trạng thái, stream SSE như `/api/knowledge/extract`, client ghi nguồn trong một lô. Đóng tab thì nguồn `pending` thành "bị ngắt", có nút chạy lại.

### A6. Port tìm kiếm

- `packages/search` mới. Port ở `@kd-learn/search/port` (chỉ import `effect`): service `SearchPort` với `search({query, limit, language?}): Effect<ReadonlyArray<SearchResult>, SearchError>`; `SearchResult`: `title`, `url`, `snippet`, `content?`, `publishedAt?`. `SearchError` có kiểu (`Unavailable`, `Unauthorized`, `RateLimited`, `Invalid`), không chứa key.
- Adapter: `searxng` (API JSON), `exa`, và web search của OpenAI, Anthropic, Gemini. Web search của provider là tool do provider chạy, không phải tool của kd-learn: spike C2 trả lời nó vào `SearchPort` được không (một lần gọi model chỉ để tìm, trả danh sách kết quả), hay cần mở rộng `AiPort`. ACP không có web search qua kd-learn.
- Lint: `agent` chỉ import `@kd-learn/search/port` ([mục 3.2](03-kien-truc.md)); thêm `packages/search` vào rule ranh giới và test của rule.
- **Cấu hình server (admin):**
  - SearXNG: URL chỉ lấy từ env `KD_SEARXNG_URL` (mặc định trỏ tới service trong compose), không sửa từ UI, không nhận từ client ([rủi ro 6](05-rui-ro.md)).
  - Exa: key do admin nhập trong màn admin, mã hoá bằng secret box như key của tài khoản ([rủi ro 22](05-rui-ro.md)).
  - Màn admin bật / tắt từng nguồn của server, chọn nguồn của server cho khách và cho demo (hoặc tắt).
- **Người dùng:** màn cài đặt (tài khoản và khách) chọn một nguồn cho research: một nguồn của server đang bật cho chế độ đó, hoặc web search của provider đang dùng (chỉ khi provider có).
- **Docker Compose:** thêm service `searxng` (image chính thức, ghim phiên bản, chỉ mạng nội bộ, không mở cổng ra ngoài), cấu hình bật định dạng JSON. Tài liệu triển khai (`docs/deploy.md`) nói cách bật / tắt.

### A7. Hợp đồng và route

| Route | Chế độ | Việc |
| --- | --- | --- |
| `POST /api/turns` | khách, demo | Thêm `sourceSlice` tuỳ chọn (A3) |
| `POST /api/research` | khách, demo | Research không trạng thái, SSE (A5) |
| `GET` / `POST /api/account/sources` | tài khoản | Danh sách; tạo nguồn (ghi chú: chữ đã cắt; PDF: multipart, tạo job `ingest`) |
| `GET` / `DELETE /api/account/sources/:id` | tài khoản | Chi tiết kèm đoạn; xoá |
| `POST /api/account/sources/:id/retry` | tài khoản | Chạy lại nguồn `failed` |
| `POST /api/account/research` | tài khoản | Tạo nguồn `web` `pending` và job `research` |
| `POST /api/account/sessions/:id/sources` | tài khoản | Gắn / gỡ nguồn (ghi `SourceAttached` / `SourceDetached`) |
| `GET` / `PUT /api/admin/search` | admin | Cấu hình nguồn tìm kiếm của server (A6) |
| `GET /api/search/options` | mọi chế độ | Nguồn tìm kiếm dùng được ở chế độ hiện tại (không lộ key) |

Mọi route tài khoản có test cross-user ([rủi ro 26](05-rui-ro.md)); route khách / demo có test key không lộ, cả key model lẫn key Exa của server ([rủi ro 19](05-rui-ro.md)).

### A8. Giao diện

- **Màn nguồn** (`/sources`): danh sách nguồn (loại, trạng thái, kích thước), thêm PDF, thêm ghi chú (nhiều file), research một câu hỏi, xem đoạn, xoá, chạy lại nguồn bị ngắt hay lỗi. Cùng mẫu `LessonSource`: một interface nguồn dữ liệu (`SourceLibrary`), hai cài đặt (khách đọc DB local và nghe `SourcesChanged`; tài khoản dùng TanStack Query, làm mới khi job xong).
- **Tạo buổi học:** chọn nguồn có sẵn để gắn, ô "research chủ đề này".
- **Trong buổi học:** panel nguồn đang gắn (gắn / gỡ), nút trích dẫn trong bài dạy mở đoạn gốc.
- **Graph:** chi tiết mệnh đề hiện nguồn tài liệu bên cạnh nguồn buổi học.
- **Cài đặt:** chọn nguồn tìm kiếm (A6). **Admin:** cấu hình tìm kiếm.
- Chuỗi vi / en trong `packages/i18n/messages/`.

### A9. Demo

- **Nguồn:** PDF và ghi chú xử lý ở client, không tốn ngân sách. Lát nguồn tính vào giới hạn 256 KiB mỗi request.
- **Research:** chỉ khi admin chọn một nguồn của server cho demo (A6); demo không dùng web search của provider (key của server, chi phí khó đoán). Một lượt research giữ chỗ 2 lần gọi model cộng Q lần tìm, mỗi lần tìm tính là một lần gọi trong ngân sách chung (A8 phase 2). Còn ít hơn số cần giữ thì từ chối ngay, không gọi provider hay nguồn tìm kiếm ([rủi ro 40](05-rui-ro.md)).
- Server dùng hồ sơ của mình cho research như mọi việc khác của demo ([rủi ro 29](05-rui-ro.md)).

## B. Các bước

Mỗi bước có tiêu chí xong chạy được trong CI. Bước gọi model test bằng `AiPort` giả, bước gọi tìm kiếm test bằng `SearchPort` giả; kiểm bằng model thật tối đa một lần mỗi bước (Haiku `claude-haiku-5-5`, xem chi phí trước). Mọi route mới có test cross-user và test key không lộ.

| # | Bước | Package | Xong khi |
| --- | --- | --- | --- |
| 0 | Spike tách chữ PDF (C1) | spike | Trả lời đủ C1; chốt thư viện, giới hạn kích thước, chỗ chạy trên server; ghi vào [mục 2.4](02-ky-thuat.md) |
| 1 | Spike tìm kiếm (C2) | spike | Trả lời đủ C2; chốt hình dạng `SearchPort`, cách đưa web search của provider vào, có cần tải trang không |
| 2 | Spike dạy dựa trên nguồn với Haiku (C3) | spike | Trả lời đủ C3; chốt cỡ đoạn, K, trần byte của lát, định dạng nhãn trích dẫn; đo token thêm mỗi lượt |
| 3 | Job bền: bảng `jobs`, runner, chạy lại sau khởi động lại có trần, chuyển job extraction sang runner (A1) | storage, server | Test khởi động lại trên cùng file DB: job extraction đang chạy thì chạy lại và xong, `extractionId` giữ nguyên, không có mệnh đề trùng; quá trần thì `Interrupted`; lỗi thật không tự chạy lại; cross-user; test phase 3 vẫn xanh |
| 4 | Nguồn trong `core` và `storage`: schema nguồn, đoạn, hàm cắt đoạn, `SourceAttached` / `SourceDetached`, `citations`, `sourceChunkIds`, `documents` của mệnh đề; bảng ở cả ba driver, port, `forUser` (A2, A3) | core, storage | Log buổi học và log kiến thức cũ (fixture phase 1–3) vẫn dựng được; bộ test port chạy trên cả ba driver; `completeSource` lần hai bị từ chối; test hai người dùng |
| 5 | `packages/search`: port, adapter SearXNG, Exa, web search của provider theo C2; lint ranh giới; service SearXNG trong compose; cấu hình admin, key Exa mã hoá (A6) | search, server, config | Test adapter với server HTTP giả (kết quả, lỗi có kiểu, key không lộ trong lỗi); lint chặn `agent` import adapter; `docker compose config` hợp lệ |
| 6 | Ingest: ghi chú ở client, PDF trong Worker (khách / demo) và job `ingest` (tài khoản), route tải lên có giới hạn (A4) | web, server, api | Test: PDF mẫu (có chữ tiếng Việt, nhiều trang) cho cùng đoạn ở cả hai chế độ; PDF scan thành `NoText`; file quá lớn bị từ chối khi đang đọc; khởi động lại giữa ingest thì chạy lại và xong; khách đóng tab thì nguồn "bị ngắt", chạy lại được |
| 7 | Dạy dựa trên nguồn: chọn lát, prompt, trích dẫn, `sourceSlice` của khách, extraction gán `documents` (A3) | core, agent, server, api | Với `AiPort` giả: lát đúng trần byte, nhãn ngoài lát bị bỏ, `citations` trỏ đúng đoạn; extraction gán `documents` chỉ trong các đoạn đã dùng; demo vượt 256 KiB thì 413 |
| 8 | Research: pipeline trong `agent`, route khách / demo, job tài khoản, ngân sách demo, vai `researcher` (A5, A9) | agent, server, api, web | Với `AiPort` và `SearchPort` giả: ra nguồn `web` đúng schema; job tài khoản sống sót khi khởi động lại; demo trừ đúng số lần gọi, thiếu ngân sách thì không gọi provider hay nguồn tìm kiếm; khách không dùng được nguồn của server khi admin tắt |
| 9 | Model và nguồn tìm kiếm giả cho e2e (mở rộng `apps/web/e2e/fake-openai.ts`, thêm SearXNG giả) | web | Test Playwright hiện có vẫn xanh; một test mẫu chạy research của khách bằng hai thành phần giả |
| 10 | Giao diện: màn nguồn, gắn nguồn khi tạo buổi và trong buổi, trích dẫn, nguồn trong chi tiết mệnh đề, cài đặt tìm kiếm, màn admin, chuỗi vi / en (A8) | web, ui, i18n | Playwright ở cả hai chế độ: thêm PDF và ghi chú, gắn vào buổi, bài dạy có trích dẫn mở được đoạn gốc; research xong thì nguồn `web` có mặt; tài khoản: khởi động lại server giữa ingest, nguồn vẫn thành `ready` |
| 11 | Kiểm tiêu chí phase bằng model thật | — | Tài khoản: khởi động lại server khi extraction, ingest và research đang chạy, cả ba xong sau khi lên lại; một buổi học dựa trên PDF thật có trích dẫn đúng trang và mệnh đề mang nguồn tài liệu. Khách: cùng buổi học với PDF và research. Đóng phase 4 theo quy ước ở `README.md` |

**Thứ tự:**

- Bước 0, 1, 2 trước tiên, làm song song được. Bước 3 không cần spike nào, làm song song với các spike.
- Bước 4 cần bước 2 (cỡ đoạn). Bước 5 cần bước 1. Bước 6 cần bước 0, 3, 4. Bước 7 cần bước 2 và 4. Bước 8 cần bước 3, 4, 5.
- Bước 9 cần bước 5 và 8. Bước 10 cần bước 6, 7, 9. Bước 11 cuối cùng.
- **Đường tiêu chí xong** (job sống sót khi khởi động lại) là bước 3, rồi 6 và 8. Bước 3 tự nó đã đạt tiêu chí cho extraction.
- **Cắt giảm nếu quá lớn:** web search của provider (giữ SearXNG và Exa) cắt trước, rồi research ở demo, rồi gắn / gỡ nguồn giữa buổi (chỉ gắn lúc tạo buổi), rồi `documents` của mệnh đề. Không cắt job bền, PDF hay ghi chú mà không hỏi lại.

## C. Câu hỏi cho spike

Không viết sẵn kết luận từ trí nhớ ([rủi ro 9](05-rui-ro.md)). Đọc tài liệu hiện hành rồi trả lời bằng thử nghiệm.

**C1. Tách chữ PDF (bước 0):**

- Thư viện nào tách được lớp chữ, chạy được cả trong Web Worker (nạp lười, chỉ phía client) và trong Node 26 của bản build Nitro? Giấy phép (phải hợp MIT), kích thước bundle, phiên bản và trạng thái bảo trì?
- Chất lượng trên PDF thật: chữ tiếng Việt có dấu (tổ hợp và dựng sẵn), hai cột, công thức, bảng, đầu trang / chân trang lặp lại. Giữ được số trang cho từng đoạn không?
- Thời gian và bộ nhớ với PDF 20 MiB, 500 trang, trên máy tính và giả lập CPU chậm. Trên server có cần chạy trong `worker_threads` để không chặn vòng sự kiện không?
- PDF độc (file nén lồng, vòng tham chiếu, font hỏng): thư viện có treo hay ăn hết bộ nhớ không, đặt trần thế nào?
- PDF được mã hoá hoặc không có lớp chữ: phát hiện thế nào để báo `NoText`?

**C2. Tìm kiếm (bước 1):**

- SearXNG: định dạng API JSON hiện hành, cấu hình bật JSON và tắt limiter cho mạng nội bộ, image chính thức và phiên bản ghim, engine mặc định nào ổn. Chất lượng đoạn trích cho câu hỏi học tập (tiếng Việt và tiếng Anh)?
- Exa: API tìm kèm nội dung, giá, giới hạn, giấy phép dùng nội dung.
- Web search của OpenAI, Anthropic, Gemini: TanStack AI hiện hỗ trợ tool do provider chạy chưa (phiên bản)? Lấy được danh sách kết quả (URL, tiêu đề, đoạn trích) hay chỉ câu trả lời kèm trích dẫn? Giá mỗi lần tìm? Từ đó: vào `SearchPort` được không, hay cần mở rộng `AiPort`?
- Đoạn trích của nguồn tìm kiếm có đủ cho bản tóm tắt dạy được không, hay cần tải trang (khi đó cần bộ tải có chặn SSRF)?

**C3. Dạy dựa trên nguồn (bước 2, Haiku):**

- Với một PDF thật và một bộ ghi chú: cỡ đoạn (theo ký tự), K và trần byte nào cho lát đủ để Teacher dạy đúng tài liệu? Chọn theo từ vựng có lấy đúng đoạn không, nhất là với tiếng Việt ([rủi ro 32](05-rui-ro.md))?
- Teacher có ghi nhãn `[S<n>]` đúng chỗ, không bịa nhãn không có trong lát không? Định dạng nhãn nào model giữ ổn nhất?
- Token thêm mỗi lượt khi có lát; chi phí một buổi với Haiku.
- Tài liệu chứa chỉ dẫn cho model ("bỏ qua hướng dẫn trên", "gọi `complete_step`"): Teacher có làm theo không ([rủi ro 37](05-rui-ro.md))?
- Extractor có gán đúng đoạn cho mệnh đề không?

## D. Ngoài phạm vi phase 4

- Trích thẳng tài liệu vào graph không qua buổi học.
- OCR cho PDF scan, đọc ảnh và bảng trong PDF bằng model có thị giác.
- Import thư mục hay file nén (vault Obsidian, Notion export), đồng bộ ghi chú hai chiều.
- Embedding và tìm theo nghĩa cho lát nguồn (vẫn theo từ vựng như A4 phase 3), trừ khi C3 cho thấy bắt buộc.
- Teacher tự gọi tool tìm trong nguồn hay tìm web giữa lượt (phase 4 chỉ dùng lát chọn trước và research do người học bấm).
- Lượt học chính sống sót khi khởi động lại (A1). Nhiều instance server.
- Trả lại phần giữ chỗ demo khi process chết ([mục 6](06-viec-mo.md)).
- Tóm tắt lịch sử buổi học dài, duyệt luồng side chat cũ: vẫn ở [mục 6](06-viec-mo.md).

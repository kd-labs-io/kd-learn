# Plan phần chính phase 2: tài khoản + triển khai

- **Ngày lập:** 2026-11-21
- **Phạm vi:** phase 2 ([mục 4](04-phases.md)): SQLite server, auth bằng token, key mã hoá, công tắc admin, demo có hạn mức, UI chọn model theo vai, backend ACP, Docker Compose
- **Xong khi:** hai tài khoản dữ liệu riêng; đóng tab buổi học vẫn chạy tiếp; demo dừng đúng hạn mức
- **Trạng thái:** đang làm, tiến độ ở [progress/phase-2.md](progress/phase-2.md). Bước 0 xong: `node:sqlite`, auth tự viết, Bearer
- **Nền đã có:** lõi dạy học của khách ([mục 3.5](03-kien-truc.md)), port AI ([mục 3.3](03-kien-truc.md)), port `storage` và `migrations` dùng chung trong `packages/storage/src/sqlite/schema.ts`

Ba quyết định sản phẩm (admin đầu tiên A4, model theo vai cho khách A6, ngân sách demo A8) đã chốt ngày 2026-11-21.

## A. Quyết định nền

### A1. Server sở hữu log của tài khoản

- Với tài khoản, event log nằm ở DB server và **server là bên ghi duy nhất**: server tạo `sessionId`, `id` của event và tự ghi `TurnStarted`, `SideMessageAppended` của người học. Client không gửi log lên.
- Projection, vòng agent, định dạng event giữ nguyên như phase 1. Chỉ khác ai ghi và lúc nào ghi.
- Khách giữ nguyên đường phase 1 (`POST /api/turns`, server không trạng thái). Hai chế độ tách hẳn, không sync, không import ([mục 2.2](02-san-pham.md)).

### A2. Lượt chạy tách khỏi request

- Phase 1 huỷ lượt khi client ngắt. Với tài khoản, lượt chạy trong một fiber của server, không gắn với kết nối HTTP:
  - `POST .../sessions/:id/turns` (main hoặc side): ghi `TurnStarted`, khởi chạy lượt, trả `turnId` ngay.
  - `GET .../sessions/:id/stream?after=<seq>` (SSE): phát lại event có `seq` lớn hơn `after`, rồi `delta` và `event` trực tiếp. Client mở lại tab thì gắn lại từ `seq` cuối đã thấy.
  - `delta` không lưu. Gắn lại giữa lượt thì server gửi trước phần chữ đã gom của lượt đang chạy (giữ trong bộ nhớ), sau đó stream tiếp. Event vẫn chỉ ghi ở cuối lượt, một transaction (như A3 của phase 1).
  - Huỷ chỉ qua `POST .../turns/:turnId/cancel`. Đóng tab không huỷ.
- **Khoá theo buổi trên server** thay Web Lock: mỗi buổi tối đa một lượt main và một lượt side đang chạy; lượt thứ hai trả `409 TurnInProgress`.
- **Một instance server.** Registry lượt đang chạy nằm trong bộ nhớ process. Ghi rõ trong tài liệu triển khai.
- **Server khởi động lại giữa lượt:** lượt đó thành "bị ngắt" theo đúng quy tắc phase 1, không bao giờ tự chạy lại. Job sống sót khi khởi động lại thuộc phase 4.

### A3. Phân tách dữ liệu theo người dùng

- Port `storage` (mà `agent` được import) giữ hình dạng hiện tại. Driver server cấp một `StorageService` **theo từng người dùng** (`forUser(userId)`); mọi truy vấn lọc theo chủ sở hữu bên trong driver, nên code gọi không quên lọc được.
- Bảng `events` giữ nguyên DDL dùng chung. Chủ sở hữu nằm ở bảng `sessions(session_id, user_id, ...)` riêng của server.
- Server có danh sách migration riêng (dùng lại DDL của `events`), vì `PRAGMA user_version` đếm theo danh sách: ghép hai danh sách sẽ lệch số khi bản WASM thêm migration.
- Người dùng, token, key mã hoá, cấu hình admin, bộ đếm demo nằm **ngoài** port `storage`, ở service riêng trong `packages/server` (hoặc subpath `@kd-learn/storage/server`). `agent` không thấy chúng.
- Truy cập buổi của người khác trả `404` (không phải `403`), để không lộ buổi đó có tồn tại.

### A4. Auth bằng token

- Đăng nhập bằng email + mật khẩu. Token opaque, lưu dạng hash trong DB, có hạn và thu hồi được (đăng xuất, admin khoá tài khoản).
- Capacitor không dùng được cookie cùng origin, nên API nhận `Authorization: Bearer`. Bản web dùng cookie `HttpOnly` hay cũng Bearer: chốt ở spike (C2), cân nhắc XSS (rủi ro 21, phase 5) và CSRF.
- Đăng ký theo công tắc admin: mở / theo lời mời (mã mời dùng một lần, có hạn) / đóng. Giới hạn số lần đăng nhập sai.
- **Admin đầu tiên (chốt 2026-11-21):** lấy từ env lúc khởi động (`KD_LEARN_ADMIN_EMAIL`, `KD_LEARN_ADMIN_PASSWORD`, đã có trong `.env`; chỉ tạo khi DB chưa có admin). Không dùng "người đăng ký đầu tiên là admin" vì server vừa mở ra Internet là ai cũng giành được.

### A5. Key mã hoá

- Key provider của tài khoản mã hoá AES-256-GCM bằng `node:crypto`, IV ngẫu nhiên mỗi bản ghi, có `keyVersion` để đổi master key sau này.
- Master key lấy từ env `KD_LEARN_SECRET_KEY` (32 byte, base64). Thiếu hoặc sai độ dài thì server không khởi động.
- Mất master key thì mọi key đã lưu không giải mã được; người dùng nhập lại. Ghi rõ trong tài liệu triển khai.
- Key không bao giờ trả về client (API chỉ báo "đã có key", tối đa 4 ký tự cuối), không vào log, lỗi hay `TurnFailed`. Mở rộng test của [rủi ro 19](05-rui-ro.md) sang đường tài khoản.

### A6. Model theo vai

- Vai ở phase 2: Prober, Teacher, side chat. Practitioner và extractor thêm ở phase 3 mà không phải đổi schema (vai là khoá trong một bản đồ).
- Cài đặt tài khoản: danh sách kết nối (provider + key mã hoá, hoặc một agent ACP admin đã bật), và bản đồ vai → (kết nối, model). Server giải `ModelRef` cho từng lượt; `UsageRecorded` đã ghi tên model.
- **Khách (chốt 2026-11-21):** giữ một model cho mọi vai ở phase 2. Chọn theo vai cho khách cần đổi `TurnRequest.model` thành bản đồ; để sau nếu có nhu cầu.

### A7. Công tắc admin

- Ba công tắc ([mục 2.2](02-san-pham.md)): đăng ký (mở / lời mời / đóng), chế độ khách, chế độ demo. Kèm cấu hình demo (A8) và danh sách agent ACP được bật (A9).
- Lưu trong DB server, sửa qua UI admin. **Server chặn**, không chỉ ẩn ở UI: tắt khách thì `POST /api/turns` trả `403 GuestModeDisabled`.
- Danh sách endpoint tương thích OpenAI vẫn lấy từ env như phase 1 (đưa vào UI admin là việc sau, D).

### A8. Demo có hạn mức

- Cùng đường với khách (DB local, server không trạng thái), nhưng request mang `{provider: 'demo'}` không có key; **server chọn provider, model, key** theo cấu hình admin. Client không chọn được model.
- **Ngân sách trần chung (chốt 2026-11-21):** một ngân sách cho **tổng mọi người dùng demo**, không chia theo từng người. Hết ngân sách thì không ai dùng được demo nữa, cho tới khi ngân sách được đặt lại hoặc admin nâng trần.
- **Cấu hình:** admin đặt trần và chu kỳ đặt lại (ngày / tháng / không đặt lại) trong UI admin; giá trị mặc định lúc khởi động lấy từ env (`KD_LEARN_DEMO_BUDGET`, `KD_LEARN_DEMO_BUDGET_PERIOD`). Trần bằng 0 nghĩa là demo đóng.
- **Đơn vị:** số lần gọi model (một lượt có gọi tool tốn hai lần, xem [archive/phase-1.md](archive/phase-1.md) bước 8), cộng trần token cho mỗi lượt. Side chat tính chung. Không cần định danh người dùng demo.
- Bộ đếm lưu bền trong DB server. Giữ chỗ nguyên tử **trước** khi gọi provider; hết ngân sách thì trả `DemoQuotaExceeded` và không gọi provider; UI báo demo đã hết lượt. Số lần gọi thực tế quyết toán cuối lượt.
- UI admin hiện đã dùng bao nhiêu trên trần trong chu kỳ hiện tại.

### A9. Backend ACP

- Chỉ cho tài khoản, admin bật từng agent (Claude Code, opencode, Antigravity CLI). Adapter đã có ([mục 3.3](03-kien-truc.md)).
- Giới hạn số process agent chạy đồng thời trên server; vượt thì xếp hàng hoặc trả lỗi rõ ràng.
- Cài CLI và đăng nhập trong container là câu hỏi spike (C3), vì adapter chạy agent với home là thư mục tạm rỗng. Giữ nguyên [rủi ro 8, 16, 17](05-rui-ro.md).

### A10. Triển khai

- Docker Compose chạy bản build Node (`.output/` của Nitro), volume cho file SQLite, secret qua env. SearXNG thuộc phase 4.
- HTTPS do reverse proxy của người host lo; tài liệu có ví dụ. Sao lưu: hướng dẫn `.backup` của SQLite, không tự động ở phase 2.

## B. Các bước

Mỗi bước có tiêu chí xong chạy được trong CI. Bước gọi model test bằng `AiPort` giả; kiểm bằng model thật tối đa một lần mỗi bước (1 lượt Haiku, xem model và chi phí trước). Theo dõi tiếp [rủi ro 18](05-rui-ro.md) ở các lượt thật.

| # | Bước | Package | Xong khi |
| --- | --- | --- | --- |
| 0 | Spike driver SQLite server và thư viện auth (C1, C2) | spike | Trả lời đủ C1, C2; chốt driver và thư viện auth, ghi vào [mục 2.4](02-ky-thuat.md), đóng việc ở [mục 6](06-viec-mo.md) |
| 1 | Driver SQLite server: migration riêng, `forUser`, bảng `sessions`, các service ngoài port (A3) | storage, server | Chạy lại bộ test của port trên driver mới; test hai người dùng: người này không đọc, không liệt kê, không ghi được buổi của người kia |
| 2 | Auth: đăng ký theo công tắc, mã mời, đăng nhập, token, đăng xuất, admin đầu tiên, giới hạn đăng nhập sai, `CurrentUser` cho route | server, api, web | Test hợp đồng; token hết hạn / thu hồi bị từ chối; đăng ký đóng thì bị chặn; mật khẩu không vào log |
| 3 | Key mã hoá và cài đặt tài khoản: kết nối, model theo vai (A5, A6) | server, api | DB chỉ chứa ciphertext; key không có trong phản hồi, log, lỗi; thiếu `KD_LEARN_SECRET_KEY` thì không khởi động |
| 4 | Lượt chạy trên server: registry, khoá theo buổi, API start / stream (phát lại theo `seq`) / cancel, giải model theo vai, đánh dấu bị ngắt sau khởi động lại (A2) | server, api, agent | Test: client ngắt giữa lượt, lượt vẫn xong và event có trong DB; gắn lại nhận đủ event; lượt thứ hai trả 409; test cross-user trên mọi route mới |
| 5 | Công tắc admin và API admin; chặn khách khi tắt (A7) | server, api | Người không phải admin bị 403; tắt khách thì `/api/turns` trả `GuestModeDisabled` |
| 6 | Demo: `provider: 'demo'`, ngân sách trần chung cấu hình được, giữ chỗ nguyên tử (A8) | server, api | Lần gọi thứ N+1 (từ bất kỳ client nào) trả `DemoQuotaExceeded` và `AiPort` giả không được gọi; hai request đồng thời ở mép trần không vượt; sang chu kỳ mới hoặc admin nâng trần thì dùng lại được; trần 0 thì demo đóng |
| 7 | ACP cho tài khoản: admin bật agent, giới hạn đồng thời, chọn được trong kết nối (A9) | server, ai | Agent chưa bật bị từ chối; vượt giới hạn đồng thời xử lý đúng; 1 lượt thật qua ACP trên máy local |
| 8 | UI: đăng nhập / đăng ký / mã mời, chọn chế độ, danh sách và màn học qua API (Query + SSE gắn lại), cài đặt theo vai, màn admin, vào demo, chuỗi vi/en | web, ui, i18n | Playwright: đăng nhập, học một lượt, đóng tab, mở lại thấy lượt đã xong; màn học dùng chung cho khách và tài khoản |
| 9 | Docker Compose: Dockerfile, compose, volume, env mẫu, healthcheck, tài liệu triển khai | — | CI build image; `docker compose up` rồi gọi healthcheck và đăng nhập admin được |
| 10 | Kiểm tiêu chí phase trên stack Compose bằng model thật | — | Đạt cả ba tiêu chí; đóng phase 2 theo quy ước ở `README.md` |

**Thứ tự:**

- Bước 0 trước tiên. Bước 1 cần bước 0 (driver).
- Bước 2 và 3 cần bước 1, làm song song được. Bước 4 cần bước 1 và 3.
- Bước 5 cần bước 2. Bước 6 cần bước 5. Bước 7 cần bước 4 và 5.
- Bước 8 cần bước 4, 5, 6. Bước 9 làm bất kỳ lúc nào sau bước 1. Bước 10 cuối cùng.
- Cắt giảm nếu quá lớn: ACP (bước 7) cắt trước, vì không thuộc tiêu chí xong.

## C. Câu hỏi cho spike

Không viết sẵn kết luận từ trí nhớ ([rủi ro 9](05-rui-ro.md)). Đọc tài liệu hiện hành rồi trả lời bằng thử nghiệm.

**C1. Driver SQLite server:**

- Ứng viên: `node:sqlite` có sẵn trong Node 26, các driver native phổ biến. Trạng thái ổn định của từng cái?
- Chạy được trong bản build Nitro (`.output/`) và trong image Docker không? Có cần addon native, build theo kiến trúc máy không?
- Dùng lại được `migrations` và hàm ánh xạ của driver WASM không? Hợp với quy tắc "chỉ ghi theo lô, không transaction tương tác" của port không?
- Đồng bộ hay bất đồng bộ; chặn event loop bao lâu với lô ghi cỡ một lượt? Bật WAL được không?

**C2. Thư viện auth:**

- Có hỗ trợ Bearer token (Capacitor, CORS), không chỉ cookie không?
- Gắn được vào route HTTP viết bằng Effect, không cần server function hay framework riêng không?
- Có sẵn đăng ký mở / mời / đóng, khoá tài khoản, giới hạn đăng nhập sai không? Lưu được vào SQLite qua driver ở C1 không?
- Phương án tự viết tối thiểu (token opaque hash trong DB, băm mật khẩu bằng `node:crypto`) tốn bao nhiêu, thiếu gì so với thư viện?
- Bản web nên giữ token bằng cookie `HttpOnly` hay Bearer? Hệ quả với CSRF và CORS.

**C3. ACP trong Docker (trước bước 7):**

- Cài CLI của từng agent vào image thế nào; đăng nhập gói thuê bao bằng cách nào khi adapter dùng home rỗng (mount thư mục cấu hình chỉ đọc, hay chỉ hỗ trợ API key)?
- Nếu không làm gọn được: ACP chỉ hỗ trợ khi chạy server ngoài Docker, ghi rõ trong tài liệu.

## D. Ngoài phạm vi phase 2

- Job sống sót khi server khởi động lại, research, PDF: phase 4.
- SearXNG trong Compose: phase 4.
- Practitioner, extractor, UI sửa hồ sơ dạy học: phase 3.
- Model theo vai cho khách, danh sách endpoint tương thích OpenAI trong UI admin: sau phase 2 nếu cần.
- Đặt lại mật khẩu qua email, OAuth, nhiều instance server, sao lưu tự động.
- Tóm tắt lịch sử dài: [mục 6](06-viec-mo.md).

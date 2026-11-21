# 8. Tiến độ phase 2

**Trạng thái: đang làm.** Plan phần chính: [tai-khoan.md](../tai-khoan.md).

## Phase 2 (cập nhật 2026-11-21)

| Hạng mục | Trạng thái |
| --- | --- |
| Bước 0: spike driver SQLite server, auth (C1, C2) | Xong (2026-11-21). Driver: `node:sqlite` thô. Auth: tự viết tối thiểu, Bearer cho cả web và Capacitor. Xem ghi chú bước 0 bên dưới |
| Bước 1: driver SQLite server | Xong (2026-11-21). `@kd-learn/storage/sqlite-node`: `openServerDatabase`, `makeServerStorage(db).forUser(userId)`, migration riêng của server, bảng `sessions`. Xem ghi chú bước 1 bên dưới |
| Bước 2: auth | Xong (2026-11-21). `packages/server/src/auth/`, route `/api/auth/*`, `/api/admin/invites`. Xem ghi chú bước 2 bên dưới |
| Bước 3: key mã hoá, cài đặt theo vai | Xong (2026-11-21). `packages/server/src/settings/`, route `/api/account/*`. Xem ghi chú bước 3 bên dưới |
| Bước 4: lượt chạy trên server | Xong (2026-11-21). `packages/server/src/sessions/`, route `/api/account/sessions/*`. Xem ghi chú bước 4 bên dưới |
| Bước 5: công tắc admin | Xong (2026-11-21). `packages/server/src/admin/`, route `/api/admin/*`, `/api/config`. Xem ghi chú bước 5 bên dưới |
| Bước 6: demo với ngân sách chung | Xong (2026-11-21). `packages/server/src/demo/`. Xem ghi chú bước 6 bên dưới |
| Bước 7: ACP | Chưa bắt đầu |
| Bước 8: UI | Chưa bắt đầu |
| Bước 9: Docker Compose | Chưa bắt đầu |
| Bước 10: kiểm tiêu chí phase | Chưa bắt đầu |

## Bước 0: spike C1, C2 (2026-11-21)

Thử nghiệm chạy bằng script tạm (không giữ trong repo) trên macOS, Node 26.13.1, SQLite 3.54.1, và trong image `node:26-slim`, `node:26-alpine` (cũng Node 26.13.1).

### Tài liệu hiện hành (tra ngày 2026-11-21)

| Thư viện | Phiên bản | Ghi chú |
| --- | --- | --- |
| `node:sqlite` | có sẵn trong Node 26 | Stability 1.2 (release candidate) từ v25.7.0, không cần flag. API đồng bộ; `DatabaseSync` là alias đã deprecated (DEP0210) của `Database`. Chỉ `sqlite.backup()` trả Promise. Có `function()`, `aggregate()` ([tài liệu](https://nodejs.org/api/sqlite.html)) |
| `better-sqlite3` | 13.2.0, engines `>=22` | Addon native. Có prebuild cho Node 26 từ 12.10.0 (theo newreleases.io, chưa kiểm trực tiếp) |
| `@effect/sql-sqlite-node` | 4.1.5 | Dùng `node:sqlite`; tài liệu Effect v4 ghi "unstable", chưa hỗ trợ streaming |
| `better-auth` | 1.7.27 | `auth.handler(Request) → Response`, plugin Bearer (docs ghi "use this cautiously"), plugin admin (ban, role). Không có luồng mã mời (chỉ `disableSignUp`). Rate limit đếm request (không đếm lần sai), mặc định lưu trong bộ nhớ. Có bảng riêng và CLI migrate riêng |
| Lucia | — | Deprecated từ 03/2025, nay là tài liệu học ([repo](https://github.com/lucia-auth/lucia)) |
| Auth.js | — | Do nhóm Better Auth duy trì từ 2025-09 |
| `@oslojs/*` | — | Chưa kiểm trạng thái (repo trả 404 khi tra) |
| `node:crypto` `argon2` | Node ≥ 24.7, stable từ 26.4.0 | OWASP: Argon2id m = 19 MiB, t = 2, p = 1; dự phòng scrypt N = 2^17, r = 8, p = 1 ([OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)) |

### C1. Driver SQLite server: `node:sqlite` thô

**Kết quả đo:**

- **Nitro:** route tạm `import { DatabaseSync } from 'node:sqlite'` trong `apps/web`, `pnpm build`, chạy `.output/server/index.mjs`: trả `sqlite_version()` 3.54.1. Nitro để `node:sqlite` là builtin, không cần cấu hình.
- **Docker:** chạy được trên `node:26-slim` và `node:26-alpine`, không addon native, không build theo kiến trúc. `PRAGMA journal_mode=WAL` trả `wal`.
- **Migration dùng chung:** chạy nguyên `migrations` của `packages/storage/src/sqlite/schema.ts` trong `BEGIN IMMEDIATE`, `PRAGMA user_version` lên 1. `UPDATE` và `DELETE` trên `events` bị trigger chặn ("events are append-only").
- **Lô ghi:** id trùng làm cả lô rollback, không còn dòng nào. 2.000 lô cỡ một lượt (4 event, khoảng 16 KB, file DB, WAL, `synchronous=NORMAL`): p50 0,07 ms, p99 3,1 ms, tối đa 4,6 ms. Đọc một buổi 40 event: 0,08 ms. Chặn event loop không đáng kể ở quy mô này.
- **Giữ chỗ ngân sách demo:** một câu `UPDATE demo_budget SET used = used + 1 WHERE used + 1 <= cap RETURNING used`; với trần 3, lần thứ 4 không trả dòng nào. Vì API đồng bộ, hai request đồng thời không chen được vào giữa.
- **Sao lưu:** `backup(db, path)` chạy được (A10).

**Chọn:** `node:sqlite` gọi trực tiếp, không qua `@effect/sql-sqlite-node` (đánh dấu unstable, thêm một lớp mà port `storage` không cần) và không dùng `better-sqlite3` (addon native, phải có prebuild cho Node và kiến trúc của image).

**Quy tắc cho driver (bước 1):**

- Dùng `Database`, không dùng alias `DatabaseSync`. (Bước 1: `@types/node` 26.6 mới chỉ có kiểu `DatabaseSync`, nên code import `DatabaseSync as Database`; alias chỉ deprecated trong tài liệu, chạy với `--throw-deprecation` không báo gì.)
- Một kết nối cho cả process. Không có `await` nào giữa `BEGIN` và `COMMIT`: cả lô chạy trong một lượt đồng bộ, nên tính nguyên tử có sẵn mà không cần hàng đợi như Worker WASM.
- Bật `journal_mode=WAL`, `busy_timeout`, `foreign_keys=ON` khi mở.
- `migrations[0]` gộp bảng `events` với bảng `settings` của khách. Bước 1 tách DDL của `events` thành hằng dùng chung, danh sách migration của server dùng hằng đó (A3).
- Phần mã hoá và giải mã event (`DomainEvent` ↔ dòng `events`, tóm tắt buổi) đang nằm trong `sqlite-wasm/index.ts` lẫn với phần gửi message cho Worker. Bước 1 tách ra `sqlite/` để hai driver dùng chung.
- `node:sqlite` còn ở mức release candidate: rủi ro 28.

### C2. Auth: tự viết tối thiểu

**Prototype (khoảng 45 dòng, chạy trên macOS và cả hai image):** bảng `users` (email `COLLATE NOCASE`, hash, role, khoá, đếm lần sai), `auth_tokens` (hash SHA-256 của token, hạn, thu hồi).

- Mật khẩu: `argon2id` của `node:crypto` (m = 19 MiB, t = 2, p = 1), so bằng `timingSafeEqual`. Khoảng 19 ms mỗi lần băm, chạy trên threadpool, không chặn event loop. Scrypt N = 2^17 mất khoảng 200 ms.
- Token: 32 byte ngẫu nhiên (base64url), DB chỉ lưu SHA-256. Tra token bằng một câu JOIN kiểm hạn, thu hồi, tài khoản bị khoá. Sau khi thu hồi, token bị từ chối.
- Đăng nhập sai 5 lần thì khoá 15 phút, kể cả khi lần sau nhập đúng mật khẩu. Email không tồn tại vẫn băm một lần cho đều thời gian, trả cùng lỗi `InvalidCredentials`.

**Vì sao không dùng better-auth:** thiếu mã mời (phải tự viết), rate limit không đếm lần sai và lưu trong bộ nhớ, có bảng và CLI migrate riêng song song với danh sách migration của server (A3). Phần còn lại cần thiết (bảng, băm, token, khoá) nhỏ hơn phần phải viết để vá các chỗ thiếu. Thiếu so với thư viện: OAuth, đặt lại mật khẩu qua email, 2FA, đều ngoài phạm vi phase 2 (D).

**Cookie hay Bearer cho web: Bearer cho cả web và Capacitor.**

- Không route nào của `apps/web` có `loader` hay đọc dữ liệu lúc SSR; mọi màn đọc dữ liệu phía client. Không màn nào cần cookie để render ở server.
- Capacitor bắt buộc Bearer, nên chỉ có một đường auth; không có cookie thì không có CSRF.
- Đánh đổi: token nằm trong JS, XSS lấy được. Giảm bằng hạn token (30 ngày), thu hồi khi đăng xuất hoặc admin khoá, và CSP ở phase 5 (rủi ro 21). Nếu sau này có màn cần SSR theo người dùng thì xem lại.

**Cần cho bước 2:**

- Giới hạn đăng nhập sai theo tài khoản giúp kẻ xấu khoá được tài khoản người khác (kể cả admin). Bước 2 thêm giới hạn theo IP và để admin mở khoá. Đã ghi vào rủi ro 23.
- `argon2` stable từ Node 26.4.0: nâng `engines` lên `>=26.4`.

## Bước 1: driver SQLite server (2026-11-21)

- **Đã làm:**
  - `packages/storage/src/sqlite/schema.ts` tách DDL của `events` thành `eventsTable`. Migration v1 của khách vẫn sinh đúng các bảng cũ.
  - `sqlite/codec.ts` gom phần ánh xạ event ↔ dòng và tóm tắt buổi; driver WASM dùng lại nó.
  - `sqlite-node/`:
    - `schema.ts`: `serverMigrations`, v1 gồm `events` và `sessions(session_id, user_id, created_at)`. Mọi bảng server sau này (người dùng, token, cấu hình admin, ngân sách demo) thêm vào **cùng danh sách này**, để một DB có một số phiên bản.
    - `database.ts`: `openServerDatabase` mở một kết nối, bật WAL, `busy_timeout`, `foreign_keys`, rồi chạy migration. Mở DB mới hơn code thì từ chối. `transaction(work)` chạy đồng bộ, rollback khi lỗi, và từ chối thân hàm trả Promise.
    - `index.ts`: `makeServerStorage(db).forUser(userId)` trả `StorageService`. Lô đầu tiên ghi vào một `sessionId` mới thì nhận quyền sở hữu buổi đó trong cùng transaction. Buổi của người khác: đọc ra rỗng như buổi không tồn tại, ghi vào thì lỗi `Unknown session`. `changes` chỉ báo cho chủ buổi. Cài đặt của khách không lưu trên server: `getSettings` trả `undefined`, còn `saveSettings` và `deleteApiKey` báo lỗi. Cài đặt tài khoản là service riêng ở bước 3.
  - Các service ngoài port (người dùng, token…) dùng `ServerDatabase.db` và `transaction` của cùng kết nối. Chúng nằm trong `packages/server` và được viết ở các bước sau.
- **Test:**
  - `testing/port-contract.ts` là bộ test chung của port, chạy trên `memory` và `sqlite-node`.
  - Test riêng cho `sqlite-node`:
    - DB: mở lại file vẫn còn dữ liệu, ở chế độ WAL; danh sách migration dài hơn thì chỉ chạy phần mới; DB mới hơn code thì bị từ chối; `events` chỉ ghi thêm; transaction lỗi hoặc bất đồng bộ thì rollback.
    - Hai người dùng: chỉ liệt kê buổi của mình, đọc buổi người khác ra rỗng, ghi vào buổi người khác bị từ chối và log không đổi, thông báo thay đổi chỉ tới chủ buổi.

## Bước 2: auth (2026-11-21)

- **Bảng (migration v2 của server):** `users` (email lưu chữ thường), `auth_tokens` (SHA-256 của token), `invites` (SHA-256 của mã), `login_throttle` (đếm lần sai theo email), `server_config` (chế độ đăng ký; bước 5 thêm các công tắc khác).
- **`packages/server/src/auth/`:**
  - `password.ts`: Argon2id, chuỗi lưu mang theo tham số. Khi xác minh, tham số đọc từ chuỗi và bị chặn trên, nên một dòng hỏng không làm server cấp phát hàng GB. Đơn vị `memory` là KiB (đo: 262144 tốn khoảng 256 MB).
  - `service.ts`: đăng ký, đăng nhập, token, mã mời, khoá và mở khoá, tắt tài khoản, admin đầu tiên. Argon2 là bất đồng bộ, nên mọi quyết định phải đúng (đếm lần sai, dùng mã mời, "chưa có admin", email trùng) đều nằm trong một transaction đồng bộ sau `await` cuối.
  - `rate-limit.ts`: đếm theo cửa sổ cố định trong bộ nhớ, theo địa chỉ client. Đăng nhập sai: 30 lần / 15 phút. Đăng ký: 10 lần / giờ.
  - `http.ts`: các route, đọc `Authorization: Bearer`.
  - `config.ts`: biến môi trường.
- **Chống dò email (rủi ro 23):**
  - Đăng nhập trả `InvalidCredentials` như nhau cho email không tồn tại và sai mật khẩu; email không tồn tại vẫn băm một lần để thời gian như nhau.
  - Khoá sau 5 lần sai trong 15 phút, tính theo chuỗi email dù có tài khoản hay không. Lần thử được đếm **trước** khi kiểm mật khẩu: 20 request song song với mật khẩu sai thì đúng 5 lần được kiểm, 15 lần bị khoá.
  - `AccountDisabled` chỉ trả khi mật khẩu đúng.
  - Đăng ký thì không giấu được email đã có (xem A4).
- **Địa chỉ client:** route của `apps/web` truyền `getRequestIP()` của TanStack Start (địa chỉ socket). Đã kiểm trên bản build: 30 lần sai từ localhost thì lần thứ 31 nhận 429. `X-Forwarded-For` chỉ dùng khi `KD_LEARN_TRUST_PROXY=1`, và lấy mục **cuối** (mục do proxy thêm vào). Không biết địa chỉ thì bỏ qua giới hạn theo IP, không dồn mọi người vào một hạn mức chung.
- **Admin đầu tiên:** tạo ở request tài khoản đầu tiên, khi DB mở ra (lười, để test và Playwright của chế độ khách không tạo file DB). Có kiểm lại "chưa có admin" trong transaction. Nếu một tài khoản thường đã đăng ký trước bằng email admin, tài khoản đó thành admin với mật khẩu lấy từ env, và mọi token cũ của nó bị thu hồi.
- **Cấu hình sai:** biến tài khoản sai (ví dụ chỉ đặt một trong hai biến admin) thì chỉ các route tài khoản trả `500 ServerMisconfigured`; route của khách vẫn chạy. Log nêu tên biến, không nêu giá trị.
- **Biến môi trường mới:** `KD_LEARN_DB_PATH` (mặc định `data/kd-learn.db`, đã có trong `.gitignore`), `KD_LEARN_REGISTRATION` (`open` / `invite` / `closed`, mặc định `invite`), `KD_LEARN_TRUST_PROXY`.
- **Token:** hạn 30 ngày, không tự gia hạn. Đăng xuất thu hồi token đang dùng. Tắt tài khoản thu hồi mọi token của tài khoản đó.
- **CORS:** thêm `authorization` vào `access-control-allow-headers` cho Capacitor; có test preflight.
- **Test:** 30 test mới, gồm:
  - chế độ đăng ký; mã mời chỉ dùng một lần và hết hạn; hai lượt đăng ký song song cùng một mã mời thì đúng một lượt thành công; email trùng thì mã mời được trả lại;
  - DB chỉ chứa hash;
  - token hết hạn, đã thu hồi, của tài khoản bị tắt đều bị từ chối;
  - admin đầu tiên tạo một lần, kể cả khi gọi đồng thời;
  - không phải admin thì bị 403 khi tạo mã mời;
  - log không chứa email, mật khẩu, token, mã mời, kể cả ở các nhánh lỗi;
  - giới hạn theo IP; `X-Forwarded-For` giả ở mục đầu không có tác dụng.
- **Chưa làm (ở bước sau):** API admin để mở khoá, tắt tài khoản, đổi chế độ đăng ký (bước 5); UI (bước 8).

## Bước 3: key mã hoá và cài đặt theo vai (2026-11-21)

- **Bảng (migration v3):**
  - `connections`: provider, `endpoint_id`, key đã mã hoá, `key_version`, 4 ký tự cuối.
  - `role_models`: khoá chính `(user_id, role)`; xoá kết nối thì vai dùng nó tự bỏ đặt (`ON DELETE CASCADE`).
- **`settings/secret-box.ts`:** AES-256-GCM, IV 12 byte ngẫu nhiên mỗi bản ghi, lưu dạng `iv.ciphertext.tag` (base64).
  - Dữ liệu xác thực kèm (AAD) là `connection:<userId>:<connectionId>`. Ciphertext chép sang dòng khác hay tài khoản khác thì không giải mã được (có test).
  - Bảng key theo phiên bản (`Map<version, key>`), nên đổi master key sau này mở được bản ghi cũ. Phase 2 chỉ có phiên bản 1.
- **`settings/service.ts`:** mọi truy vấn lọc theo chủ sở hữu.
  - `resolveModel(userId, role)` là chỗ duy nhất giải mã key, trả `ModelRef` cho lượt chạy.
  - Các kết quả lỗi: `RoleNotConfigured`; `UnknownEndpoint` (endpoint không còn trong danh sách cho phép của server); `KeyUnreadable` (master key đã đổi hoặc dòng bị sửa: người dùng nhập lại key).
  - Bước 4 sẽ dùng hàm này cho từng vai.
  - Kết nối ACP để tới bước 7. Schema hợp đồng đã chừa chỗ, vì `provider` là một union.
- **API:** đi qua một handler `account` định tuyến theo đường dẫn, gắn vào route catch-all `/api/account/$`.
  - `GET /api/account/settings`.
  - `POST /api/account/connections`. Không nhận `baseURL`: tham số dư bị từ chối, giống rủi ro 6.
  - `DELETE /api/account/connections/:id`.
  - `PUT /api/account/roles`: thay cả bản đồ.
  - Phản hồi chỉ có `hasKey` và `keyLast4`. `keyLast4` chỉ có khi key dài từ 12 ký tự, để key ngắn không lộ gần hết.
  - Kết nối của người khác trả 404 như kết nối không tồn tại.
  - CORS thêm `PUT`, `DELETE`.
- **`KD_LEARN_SECRET_KEY`:** bắt buộc cho tài khoản. Thiếu hoặc sai thì route tài khoản trả 500, còn route khách vẫn chạy (A5 đã sửa theo). Key đã thêm vào `.env` của máy dev.
- **Test (14 mới):**
  - mã hoá: khứ hồi; sai ngữ cảnh, sai phiên bản, sai key, bản ghi bị sửa đều bị từ chối; mở được bản ghi cũ sau khi đổi key;
  - DB chỉ chứa ciphertext; phản hồi và log không có key;
  - tách người dùng: kết nối của người khác thì không gán vào vai được, không xoá được, không thấy;
  - thiếu master key thì route tài khoản trả 500, route khách vẫn 200.
  - Chạy thật trên bản build bằng `curl`: tạo kết nối, đặt vai, xoá; key không có trong log và trong các file DB.
- **Dọn code:** các helper route dùng chung (kiểm method, chờ tài khoản sẵn sàng, đọc JSON, lấy người dùng hiện tại) chuyển sang `src/routes.ts`; helper HTTP sang `src/http.ts`.

## Bước 4: lượt chạy trên server (2026-11-21)

- **API** (bảng đường dẫn ở `packages/api/src/contract.ts`), dưới `/api/account/sessions`:
  - liệt kê và tạo buổi. Server ghi `SessionCreated` với hồ sơ mặc định và ngôn ngữ của người học.
  - `GET /:id`: snapshot gồm `events` (mỗi event kèm `seq`) và `running`.
  - `GET /:id/stream?after=<seq>`: SSE.
  - `POST /:id/turns`: `send` / `retry` / `auto` / `side`, trả `202 { turnId }`.
  - `POST /:id/turns/:turnId/cancel`.
  - `POST /:id/skip`.
- **Frame của stream:**
  - `running`: frame đầu tiên, gồm các lượt đang chạy và phần chữ đã có của từng message.
  - `log`: event đã ghi, kèm `seq`.
  - `delta`.
  - `turn`: `running`, `completed`, `failed` hoặc `cancelled`.
  - Cứ 15 giây có một dòng `: ping` để proxy không đóng kết nối. `makeSseParser` bỏ qua dòng này.
  - `seq` là vị trí trong log: liên tục từ 0, chỉ tăng. Stream đăng ký nhận tin **trước** rồi mới đọc log, và lọc trùng theo `seq` đã gửi.
- **`sessions/runner.ts`:**
  - **Lượt chạy:** mỗi lượt là một fiber daemon (`Effect.runFork`), không gắn với request nào. Đóng stream không huỷ lượt (đã kiểm bằng test và bằng một lượt Haiku thật trên bản build: ngắt `fetch` sau `delta` đầu tiên, lượt vẫn ghi đủ `MessageAppended`, `UsageRecorded`, `TurnCompleted`).
  - **Giữ chỗ:** kiểm chỗ trống, đọc log, chiếu, giải model theo vai, ghi `TurnStarted` và đăng ký vào registry đều nằm trong một đoạn đồng bộ. Chỗ được trả trong `onExit` của fiber ở mọi lối ra. Mỗi buổi tối đa 1 lượt main và 1 lượt side. Bỏ qua bước dùng chung chỗ của main.
  - **Kiểm chủ sở hữu:** registry khoá theo `(userId, sessionId)`. Mọi lối vào đọc qua `forUser` trước; log rỗng thì trả 404 trước khi ghi gì. Chỉ route tạo buổi mới sinh `sessionId`.
  - **Model theo vai:** Prober khi đang `Probing`, Teacher sau đó, `sideChat` cho side chat. Model được giải cho **từng lượt**, kể cả lượt lập plan tự chạy nối sau lượt chấm điểm. Hàm `shouldAutoStart` chuyển từ `apps/web` sang `@kd-learn/agent/client` để client và server dùng chung. Vai chưa đặt model thì trả `409 RoleNotConfigured` và không ghi gì.
  - **Kết thúc lượt:** mọi lượt kết thúc trong log. `InvalidTurn`, defect, quá giờ, và lô không khớp với phép chiếu đều ghi `TurnFailed` / `SideTurnFailed`. Chỉ lượt bị huỷ và lượt bị cắt do khởi động lại là để mở (thành "bị ngắt" theo quy tắc phase 1). Lô cuối lượt được kiểm với log **lúc ghi**, vì side chat có thể đã ghi xen vào.
  - **Quá giờ:** mỗi lượt tối đa 3 phút (`turnTimeoutMs`), quá thì ghi `TurnFailed` `TurnTimeout` (retryable), để provider treo không giữ chỗ mãi.
  - **Key:** mọi event và lỗi được xoá key đã giải trước khi ghi và trước khi phát (`scrubDeep`); defect dùng câu thông báo cố định.
  - **Khởi động lại:** registry mới rỗng, lượt đang mở hiện là bị ngắt, `retry` chạy được.
- **Test** (11 mới, AI giả có cổng chặn, không dùng `sleep`):
  - Hai POST song song khi đang chạy đều nhận 409; snapshot giữa lượt có phần chữ đã có.
  - Đóng stream giữa lượt thì lượt vẫn được ghi.
  - Gắn lại giữa lượt: nhận phần chữ đã có, sau đó mỗi event đúng một lần (`seq` 1..4).
  - Huỷ: provider bị interrupt, không ghi gì, chỗ được trả, `retry` chạy được.
  - Defect và lỗi provider có chứa key thì DB và log sạch key; quá giờ; nối lượt lập plan; side chạy song song với main; vai chưa đặt.
  - Cross-user: cả 6 route trả 404 và không tạo dòng `sessions`; khởi động lại trên cùng file DB.
- **Giới hạn:** input của người học tối đa 4.000 ký tự (dưới trần 16 KiB của body route tài khoản).

## Bước 5: công tắc admin (2026-11-21)

- **Công tắc:** đăng ký (`open` / `invite` / `closed`), chế độ khách, chế độ demo. Lưu trong `server_config`. Công tắc nào admin chưa đặt thì lấy mặc định từ env: `KD_LEARN_REGISTRATION`, `KD_LEARN_GUEST_MODE` (mặc định `on`), `KD_LEARN_DEMO_MODE` (mặc định `off`). Giá trị env sai thì phần tài khoản không chạy.
- **API admin** (chỉ admin; không có token trả 401, không phải admin trả 403):
  - `GET` và `PUT /api/admin/config`. `PUT` chỉ đổi các trường được gửi.
  - `GET /api/admin/users`: danh sách người dùng, kèm `lockedUntil` nếu đang bị khoá do đăng nhập sai.
  - `PATCH /api/admin/users/:id` với `{ disabled }` hoặc `{ unlock: true }`. Tắt tài khoản thì thu hồi mọi token của tài khoản đó. Admin không tự tắt tài khoản của mình được (409).
  - `POST /api/admin/invites` giữ route riêng như bước 2.
- **`GET /api/config` (công khai):** `{ registration, guestMode, demoMode }`, để UI ở bước 8 biết hiện lối vào nào. Khi server không bật tài khoản (thiếu `KD_LEARN_SECRET_KEY`), route này trả `registration: closed`, `demoMode: false`, còn `guestMode` lấy theo env.
- **Chặn khách ở server:** `POST /api/turns` đọc công tắc ở mỗi request, công tắc tắt thì trả `403 GuestModeDisabled`. Nếu không đọc được công tắc (DB lỗi, biến env sai) thì từ chối luôn, để công tắc admin đã tắt không bị bỏ qua.
  - Server có bật tài khoản: mỗi lượt của khách đọc công tắc từ DB.
  - Server không bật tài khoản: công tắc chỉ lấy từ env.
- **Admin đầu tiên:** vẫn được tạo ở request đầu tiên cần DB. `GET /api/config` cũng là một request như vậy, nên lần UI tải trang đầu tiên sẽ tạo admin. Bước 9 trỏ healthcheck vào route này.
- **Test (7 mới):**
  - người không phải admin bị 403 trên mọi route admin;
  - tắt khách thì `/api/turns` trả `GuestModeDisabled`, bật lại thì chạy;
  - đổi chế độ đăng ký có tác dụng ngay;
  - mặc định lấy từ env; giá trị env sai thì từ chối khách;
  - server không có tài khoản thì theo env;
  - tắt tài khoản thu hồi token; mở khoá đăng nhập; không tự tắt mình được; người dùng không tồn tại trả 404.
  - Chạy thật trên bản build bằng `curl`: tắt khách thì `/api/turns` trả 403.

## Bước 6: demo với ngân sách chung (2026-11-21)

- **Request:** `POST /api/turns` với `model: { provider: 'demo' }`, không có trường nào khác: gửi kèm `model` hay `apiKey` đều bị trả 400.
- **Model demo:** provider, model và key lấy từ env: `KD_LEARN_DEMO_PROVIDER`, `KD_LEARN_DEMO_MODEL`, `KD_LEARN_DEMO_API_KEY`, thêm `KD_LEARN_DEMO_ENDPOINT` cho `openai-compatible`. Phải đặt cả ba biến hoặc không đặt biến nào. UI admin chỉ đặt công tắc và ngân sách; trang cấu hình admin hiện `demoModel` dạng `anthropic:claude-haiku-5-5`, không kèm key.
- **Ngân sách:**
  - Đặt bằng `KD_LEARN_DEMO_BUDGET` (số lần gọi model, mặc định 0, tức là đóng) và `KD_LEARN_DEMO_BUDGET_PERIOD` (`day`, mặc định, / `month` / `none`, tính theo UTC).
  - Admin đổi bằng `PUT /api/admin/config` với `demoBudgetLimit` và `demoBudgetPeriod`.
  - `GET /api/admin/config` trả `demoBudget: { limit, period, used }`.
  - Bộ đếm nằm ở bảng `demo_usage` (migration v4), khoá theo chu kỳ (`day:2026-11-21`), nên sang chu kỳ mới thì tự đếm lại từ 0.
- **Giữ chỗ:**
  - Trong một transaction đồng bộ, **trước** khi gọi provider: lượt chính giữ tối đa 4 lần gọi, side chat giữ 1. Ngân sách còn ít hơn số cần giữ thì chỉ giữ phần còn lại, ít nhất 1 lần.
  - Số đã giữ được truyền làm `maxSteps`, nên một lượt không bao giờ gọi model nhiều hơn số đã giữ, và tổng không vượt trần.
  - Hết ngân sách thì trả `429 DemoQuotaExceeded` và không gọi provider.
- **Quyết toán:**
  - Khi stream kết thúc (xong, lỗi, hoặc client ngắt), phần giữ mà không dùng được trả lại.
  - Cách đếm: lần gọi đầu tính 1. Mỗi vòng gọi tool tính thêm 1 lần cho lần gọi model sau nó, trừ khi `maxSteps` đã chặn lần gọi đó. Vì vậy số đếm có thể cao hơn thực tế, không bao giờ thấp hơn.
  - Lượt lỗi vẫn bị tính.
  - Process chết giữa lượt thì phần đã giữ không được trả lại.
- **Trần mỗi lượt:**
  - Mỗi lần gọi tối đa 2.048 token ra (`maxOutputTokens` mới trong `TurnRequest` của `AiPort`).
  - Adapter TanStack đặt trần này vào `modelOptions` theo tên khoá của từng provider: `max_tokens` cho Anthropic và cho chat-completions, `maxOutputTokens` cho Gemini. Đã có test kiểm trần đi tới request Anthropic.
  - Thân request demo tối đa 256 KiB (khách là 1 MiB), vì client gửi cả log mà key là của server.
- **Công tắc:**
  - Công tắc khách và công tắc demo tách riêng (mục 2.2): tắt khách không chặn demo, và ngược lại.
  - Demo đóng (`403 DemoModeDisabled`) khi công tắc tắt, trần bằng 0, chưa có model demo, hoặc endpoint của model không còn trong danh sách.
  - `GET /api/config` chỉ trả `demoMode: true` khi demo chạy được.
  - Không đọc được DB thì trả 500 và không gọi provider.
- **Key:** frame và log được xoá key demo y như key của khách. Log của lượt demo ghi tên model.
- **Test:**
  - 13 test mới, gồm:
    - lần gọi thứ N+1 bị từ chối và AI giả không được gọi;
    - hai request đồng thời ở mép trần: đúng một request chạy;
    - nâng trần thì dùng lại được; sang ngày mới đếm lại;
    - lượt lỗi vẫn bị tính và key không lộ;
    - trả lại phần giữ thừa; client ngắt thì không đếm thiếu;
    - đóng khi công tắc tắt, trần 0 hoặc chưa có model; hai công tắc độc lập;
    - từ chối `model`, `apiKey` và lịch sử quá lớn; biến env sai;
    - đếm vòng gọi tool; `maxSteps` bị chặn ở mức đã giữ.
  - 1 test ở adapter: trần token đi tới request Anthropic.
  - Chạy thật trên bản build với Haiku, trần 2: hai lượt xong, lượt thứ ba trả `429 DemoQuotaExceeded`; key không có trong phản hồi hay log.
- **Chưa làm:** đặt key demo từ UI admin (phải mã hoá bằng secret box như key của tài khoản). Ghi ở 06-viec-mo.


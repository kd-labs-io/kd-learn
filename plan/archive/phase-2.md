# 8. Tiến độ phase 2

**Trạng thái: xong (2026-11-21).** Cả ba tiêu chí đạt bằng Haiku thật qua UI trên stack Docker Compose, xem phần "Bước 10". Plan phần chính: [tai-khoan.md](tai-khoan.md).

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
| Bước 7: ACP | Xong (2026-11-21). `packages/server/src/acp/`. Xem ghi chú bước 7 bên dưới |
| Bước 8: UI | Xong (2026-11-21). `apps/web/src/account/`, `learn/account-lesson.ts`, `learn/source.ts`. Xem ghi chú bước 8 bên dưới |
| Bước 9: Docker Compose | Xong (2026-11-21). `Dockerfile`, `docker-compose.yml`, `.env.example`, `docs/deploy.md`, `scripts/compose-smoke.sh`. Xem ghi chú bước 9 bên dưới |
| Bước 10: kiểm tiêu chí phase | Xong (2026-11-21). Đạt cả ba tiêu chí bằng Haiku thật trên stack Compose. Xem ghi chú bước 10 bên dưới |

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
  - Cách đếm: lần gọi đầu tính 1. Mỗi vòng kết quả tool (`ToolResult`) tính thêm 1 lần cho lần gọi model sau nó, trừ khi `maxSteps` đã chặn lần gọi đó. Vì vậy số đếm có thể cao hơn thực tế, không bao giờ thấp hơn. Adapter thật phát `Usage` chen giữa `ToolCall` và `ToolResult` (đã khoá thứ tự này bằng test ở adapter), nên bộ đếm bỏ qua `Usage`: một lượt có gọi tool tính đúng 2 lần.
  - Client ngắt giữa lượt: vẫn quyết toán theo số lần đã gọi (test: giữ 4, còn 1). Response mà client không bao giờ đọc body thì có thể giữ nguyên phần đã giữ (tính cao).
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
- **Prompt:** prompt hệ thống lấy từ `profile` trong log, mà log do client gửi. Vì vậy với demo, server thay `profile` bằng profile mặc định của server và chỉ giữ ngôn ngữ (tag BCP 47 hợp lệ, nếu không thì dùng `en`). Client vẫn tự chọn chủ đề và lịch sử hội thoại. Phần này được chặn bởi ngân sách và trần token, xem rủi ro 29.
- **Key:** frame và log được xoá key demo y như key của khách. Log của lượt demo ghi tên model.
- **Test:**
  - 14 test mới, gồm:
    - prompt trong log của client bị thay bằng prompt của server;
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

## Bước 7: ACP cho tài khoản (2026-11-21)

- **Kết nối ACP:**
  - Tạo bằng `{ label, provider: 'acp', agent }`, với `agent` là `claude-code`, `antigravity` hoặc `opencode`. Kết nối này không có key: agent dùng phiên đăng nhập của chính nó trên server.
  - Cột `agent` thêm ở migration v5.
  - `GET /api/account/settings` trả thêm `acpAgents` (các agent admin đã bật), để UI ở bước 8 chỉ hiện agent dùng được.
- **Admin:**
  - `acpAgents` và `acpMaxConcurrent` trong `GET` / `PUT /api/admin/config`.
  - Mặc định lấy từ env: `KD_LEARN_ACP_AGENTS` (danh sách cách nhau bằng dấu phẩy, mặc định không bật agent nào) và `KD_LEARN_ACP_MAX_CONCURRENT` (1–32, mặc định 2). Giá trị sai thì phần tài khoản không chạy.
- **Agent chưa bật:**
  - Tạo kết nối với agent chưa bật thì trả `409 AcpAgentDisabled`.
  - Model được giải **ở mỗi lượt**, nên admin tắt agent sau khi đã có kết nối thì lượt cũng bị trả `409 AcpAgentDisabled` và không ghi gì.
- **Giới hạn đồng thời:**
  - Đếm chung cho cả server, trong bộ định tuyến AI của lượt tài khoản (`acp/router.ts`): ref ACP đi sang adapter ACP, các ref khác sang TanStack.
  - Vượt giới hạn thì lượt thất bại ngay với `ProviderError` mã `AcpBusy` và `retryAfterMs` 5 giây, thành `TurnFailed` có `retryable`. Không xếp hàng, vì một lượt ACP có thể chạy vài phút.
  - Việc kiểm nằm trong fiber của lượt, nên lượt lập plan tự nối sau lượt chấm điểm cũng bị kiểm.
  - Chỗ được trả trong `Stream.ensuring` ở mọi lối ra: xong, lỗi, defect, huỷ, quá giờ.
- **Biến môi trường của agent:** process agent không còn nhận các biến `KD_*` (master key, mật khẩu admin, key demo). Có test cho cả ba agent.
- **Nạp lười:** adapter ACP chỉ được nạp ở lượt ACP đầu tiên, vì lúc nạp nó tìm package agent và script bridge. Server không bật ACP không phụ thuộc vào các thứ đó. Nạp lỗi thì lượt ghi `TurnFailed` mã `AcpUnavailable` với thông báo cố định. Chi tiết lỗi (có đường dẫn trên server) chỉ ghi vào log server (`acp.unavailable`).
- **Bản build:**
  - Mặc định không kèm ACP: `.output` 14 MB, và lượt ACP trả lỗi "The ACP adapter could not be loaded".
  - `KD_BUILD_ACP=1 pnpm build` chép `claude-agent-acp` vào `.output/server/node_modules` qua `traceDeps` của Nitro, khoảng 344 MB, vì nó kèm binary Claude Code gốc của máy build (một nền tảng). Do đó `apps/web` khai báo thêm dependency này.
- **Chạy thật:**
  - Trên bản build có ACP, máy local, env sạch (không có `CLAUDE*` / `ANTHROPIC*`): một lượt Claude Code (`claude-haiku-5-5`) qua API tài khoản ghi đủ `MessageAppended` và `TurnCompleted` trong 4,6 giây.
  - Cùng lúc đó, một lượt Anthropic thường vẫn chạy tốt.
  - Key không có trong log.
  - Lượt ACP không có `UsageRecorded`, vì adapter không nhận số token.
- **C3 (ACP trong Docker), chốt:** phase 2 chỉ hỗ trợ ACP khi chạy server ngoài Docker, trên máy đã cài và đăng nhập CLI của agent. Image Docker ở bước 9 không kèm ACP. Lý do:
  - binary Claude Code phụ thuộc nền tảng và nặng khoảng 340 MB;
  - CLI cần đăng nhập gói thuê bao, trong khi adapter chạy agent với home rỗng;
  - opencode và Antigravity dùng bridge stdio (`stdio-bridge.ts`), mà file này chưa được đóng gói vào bản build.
- **Test (10 mới):**
  - adapter không nạp được: thông báo không chứa đường dẫn server, chi tiết có trong log;
  - huỷ stream thì process agent dừng (adapter, agent giả ghi pid);
  - lượt chạy qua agent đã bật, không lưu key, không gọi TanStack;
  - agent chưa bật, hoặc bị tắt sau khi đã có kết nối, bị từ chối mà không ghi gì;
  - giới hạn 1: lượt thứ hai thất bại ngay với `AcpBusy` (retryable) và fake không được gọi; xong lượt trước hoặc huỷ lượt thì lượt sau chạy được;
  - khách không chọn được `acp`;
  - env sai; env của agent không có `KD_*`.

## Bước 8: UI tài khoản, admin, demo (2026-11-21)

- **Model của kết nối ACP (rủi ro 30), người dùng chốt ngày 2026-11-21: chỉ chọn trong danh sách admin cho phép.**
  - `acpModels` (agent → danh sách model) lưu trong `server_config`, mặc định từ env `KD_LEARN_ACP_MODELS` (JSON, ví dụ `{"claude-code":["claude-haiku-5-5"]}`; mặc định rỗng, tức là không cho model nào). Admin sửa qua `PUT /api/admin/config`.
  - `PUT /api/account/roles` từ chối cả bản đồ (`409 AcpModelNotAllowed`) khi một vai ACP chọn model ngoài danh sách. Model được kiểm lại **ở mỗi lượt**, nên admin bỏ model khỏi danh sách thì lượt bị trả `409 AcpModelNotAllowed` và không ghi gì.
  - `GET /api/account/settings` trả `acpModels` của các agent đã bật, để UI chỉ cho chọn trong danh sách.
- **Báo admin khi bản build không có ACP:** `AdminConfig.acpAvailable`, lấy bằng cách nạp thử adapter một lần (kết quả giữ cho cả process), và chỉ khi có agent đang bật; không agent nào bật thì trả `true` mà không nạp. Màn admin hiện cảnh báo khi có agent đang bật mà `acpAvailable` là `false`. Bản build chạy ngay trong repo vẫn nạp được adapter từ `apps/web/node_modules`, nên `acpAvailable` phụ thuộc nơi chạy; test e2e so với câu trả lời của server.
- **`GET /api/config` thêm `accounts`:** `false` khi server không bật tài khoản (thiếu `KD_LEARN_SECRET_KEY`). UI dựa vào đó để ẩn lối đăng nhập.
- **Client (`packages/api/src/account-client.ts`):** `accountClient({ token })` cho mọi route tài khoản, admin và cấu hình; `streamSession(id, after)` đọc SSE bằng `fetch` (EventSource không gửi được Bearer). Lỗi là `ApiError { status, failure }`, giữ nguyên mã lỗi của server; không tới được server thì `status` 0, mã `Network`.
- **Màn học dùng chung:** `LearnScreen` chỉ nhận một `LessonSource` (`learn/source.ts`): view, `RunnerState`, các action, `elsewhere`, `persistent`.
  - Khách và demo: `GuestLesson` bọc runner cũ (DB local, Web Lock). Test e2e của khách chạy nguyên, không sửa.
  - Tài khoản: `AccountLessonScreen` dùng `AccountLesson` (`learn/account-lesson.ts`): đọc snapshot, rồi theo stream từ `seq` cuối. Stream kết thúc thì nối lại từ `seq` cuối; thấy `seq` nhảy cóc thì đọc lại snapshot. Frame `running` thay toàn bộ phần chữ đang chạy. "Đang chạy" lấy từ frame `running` / `turn` của server, không lấy từ việc tab này đã gửi, nên tab mở lại giữa lượt thấy lượt đang chạy chứ không thấy "bị ngắt". 401 thì đăng xuất, 404 thì báo không có buổi này.
  - Lượt Prober đầu tiên: UI tài khoản vẫn gọi `auto`; `409 TurnInProgress` / `NothingToRun` của `auto` bị bỏ qua (server đang nối lượt lập plan, hoặc đã chạy rồi). Nhờ vậy buổi kẹt ở Planning sau khi server khởi động lại cũng chạy tiếp.
  - Tài khoản có nút "Dừng" khi đang chạy (`POST .../cancel`).
  - Server từ chối bắt đầu lượt (mạng, 409) thì không có gì được ghi: `send` / `sendSide` trả `false` và ô nhập lấy lại chữ đã gõ; side chat hiện lỗi cả khi luồng không kết thúc bằng tin của người học.
  - Lượt tự chạy (`auto`) được thử lại khi lượt đang chạy kết thúc mà buổi vẫn cần nó; có lỗi thì dừng, để không lặp.
- **Token và chế độ:** `localStorage` giữ token (`kd-learn.auth`) và chế độ local (`kd-learn.mode`: `guest` / `demo`). Render ở server không thấy `localStorage`, nên lần render đầu ở cả hai phía là "chưa biết" (`useSyncExternalStore` với snapshot server riêng), tránh lệch khi hydrate. Đăng nhập, đăng xuất hoặc 401 thì xoá cache Query và các store buổi học của người trước.
- **TanStack Query** (`@tanstack/react-query` 5.108, mục 2.5): cấu hình công khai, danh sách buổi, cài đặt, màn admin. `QueryClient` tạo trong `getRouter()` (mỗi request SSR một cái). Buổi học không đi qua Query: một store theo stream, không giữ log ở hai nơi.
- **Route:** `/` chọn màn theo người dùng: tài khoản → danh sách buổi trên server; khách / demo → danh sách buổi local; chưa chọn → màn chọn chế độ (chỉ hiện lối vào server mở). Server chỉ có chế độ khách thì vào thẳng màn khách như phase 1. `/login`, `/register` (ô mã mời khi đăng ký theo lời mời), `/a/$sessionId` (buổi tài khoản; buổi khách vẫn ở `/s/$sessionId`), `/settings` (khách: key trên máy; tài khoản: kết nối và model theo vai), `/admin`.
- **Demo:** cùng runner với khách; ở chế độ demo, request mang `{ provider: 'demo' }` và không cần key. `DemoQuotaExceeded`, `DemoModeDisabled` có câu báo riêng.
- **Màn admin:** ba công tắc, ngân sách demo (đã dùng / trần, chu kỳ), agent ACP và danh sách model, số agent đồng thời, mã mời (hiện một lần), danh sách người dùng (tắt / bật, mở khoá; không có nút tắt chính mình).
- **Chuỗi:** khoảng 120 chuỗi mới ở `packages/i18n/messages/{en,vi}.json`.
- **Test:**
  - Server: 2 test mới cho danh sách model ACP (từ chối khi đặt vai, kiểm lại ở mỗi lượt) và `acpAvailable`; env `KD_LEARN_ACP_MODELS` sai thì phần tài khoản không chạy.
  - `AccountLesson` (`learn/account-lesson.test.ts`, 6 test, server giả bằng `fetch`): nối lại từ `seq` cuối khi stream kết thúc; bỏ event trùng; `seq` nhảy cóc thì đọc lại snapshot; phần chữ đang chạy; 404; 401; lượt bị từ chối.
  - `packages/api`: 4 test cho client (Bearer, giữ mã lỗi, lỗi mạng thành status 0, stream bỏ qua `: ping`).
  - Playwright (`e2e/accounts.e2e.ts`, 8 test): chạy trên bản build thứ hai có tài khoản, DB tạm, và model giả tương thích OpenAI (`e2e/fake-openai.ts`) khai báo qua `KD_OPENAI_COMPATIBLE_ENDPOINTS`; không chặn request nào của trang, không thêm móc test vào code chạy thật.
    - **Nghiệm thu:** đăng ký, thêm kết nối, đặt model cho các vai, học một lượt; lượt sau bị model giả giữ lại, đóng tab giữa lượt, thả model, mở tab mới: lượt đã xong, không có banner "bị ngắt".
    - Tab mở giữa lượt thấy phần chữ đã có và theo lượt tới hết.
    - Chưa đặt model cho vai: trang chủ chỉ sang cài đặt, lượt trả `RoleNotConfigured`.
    - Đăng xuất, sai mật khẩu, đăng nhập lại.
    - Màn admin: người dùng, mã mời, cảnh báo ACP theo `acpAvailable`.
    - Demo: không key, model của server trả lời, hết ngân sách thì báo `DemoQuotaExceeded`.
    - Server từ chối lượt: chữ vẫn trong ô nhập, có lỗi; gửi lại được.
    - "Dừng" huỷ lượt trên server, banner "bị ngắt", thử lại chạy tiếp.
  - Kiểm tay trên bản build với `KD_LEARN_REGISTRATION=invite`: màn đăng ký có ô mã mời, mã sai báo `InvalidInvite`, mã admin tạo thì đăng ký được. Xem ảnh chụp màn chọn chế độ, đăng ký, trang chủ, cài đặt, admin ở desktop và điện thoại (390 px, tiếng Việt): không tràn ngang.
  - Giới hạn đăng ký 10 lần mỗi giờ theo địa chỉ làm các test song song hỏng lẫn nhau (cùng localhost). Server e2e đặt `KD_LEARN_TRUST_PROXY=1` và mỗi test gửi `X-Forwarded-For` riêng. Chạy `--repeat-each=3` trên Chromium: 84/84 xanh.
  - Form đăng nhập chỉ hiện sau khi hydrate: chữ gõ vào ô do server render trước khi hydrate bị mất (thấy khi chạy song song).
- **Không kiểm bằng model thật ở bước này:** đường server đã kiểm bằng Haiku ở bước 4 và 6; bước 8 chỉ thêm UI, đã chạy qua server thật với model giả.

## Bước 9: Docker Compose (2026-11-21)

- **Image (`Dockerfile`):** hai tầng.
  - Tầng build: `pnpm fetch` chỉ từ lockfile (đổi code không tải lại package), rồi `turbo build --filter=@kd-learn/web`.
  - Tầng chạy: chỉ chép `.output/`. Bản build Nitro tự đủ, không cần `node_modules`. Image khoảng 390 MB.
  - Ghim `node:26.13.1-slim` (rủi ro 28, `node:sqlite` còn là release candidate). Chạy bằng user `node`. DB ở `/data/kd-learn.db`, `/data` là volume.
  - Không kèm ACP (C3). Trong container, `acpAvailable` là `false`, nên màn admin cảnh báo khi admin bật agent.
  - Healthcheck gọi `GET /api/config` bằng `fetch` của Node (image slim không có `curl`). Route này cũng tạo admin đầu tiên.
- **`.dockerignore`:** loại `.env`, `.git`, `plan`, `probe`, `node_modules`, các bản build. Secret không vào build context.
- **Compose (`docker-compose.yml`):**
  - Một service `web`, volume có tên `kd-learn-data`.
  - Port chỉ mở trên `127.0.0.1` (đổi được bằng `KD_LEARN_BIND`, `KD_LEARN_PORT`): HTTPS do reverse proxy lo (A10).
  - Env lấy từ `.env` (mẫu ở `.env.example`). Đường dẫn file đổi được bằng `KD_LEARN_ENV_FILE`, để script kiểm tra dùng file env tạm. `KD_LEARN_DB_PATH` cố định trong compose, `.env` không đổi được.
- **Tài liệu (`docs/deploy.md`, tiếng Anh vì dành cho người host):** chạy nhanh, bảng biến env, ví dụ Caddy và nginx, sao lưu và khôi phục, nâng cấp.
  - Lưu ý cho proxy: tắt buffer cho SSE. Stream tài khoản ping 15 giây một lần, còn stream của khách không ping, nên read timeout của proxy cần từ 5 phút trở lên.
  - Sao lưu bằng `backup()` của `node:sqlite` qua `docker compose exec`, vì image không có CLI `sqlite3`. Khôi phục: dừng app, chép file vào volume bằng một container chạy một lần, xoá `-wal` / `-shm` cũ.
  - Nhắc giữ `KD_LEARN_SECRET_KEY` cùng bản sao lưu: mất key thì key provider trong DB không đọc được.
- **Kiểm tra (`scripts/compose-smoke.sh`, CI chạy ở job `docker`):**
  - build image, `docker compose up --wait` (chờ healthcheck);
  - `/api/config` báo `accounts: true`, admin đầu tiên đăng nhập được;
  - tạo một buổi học, `down` rồi `up`: buổi học vẫn còn (volume);
  - sao lưu, xoá DB (còn 0 buổi), khôi phục (lại có 1 buổi), đúng theo lệnh trong tài liệu;
  - mật khẩu admin không có trong log.
  - Script dùng file env, tên project và volume tạm, không in secret. Chạy local: xanh.

## Bước 10: kiểm tiêu chí phase trên stack Compose (2026-11-21)

- **Cách chạy:**
  - Stack Compose dựng từ `main` sau bước 9, project và volume tạm.
  - Env tạm:
    - `KD_LEARN_REGISTRATION=open`;
    - demo bật, `anthropic` / `claude-haiku-5-5`, ngân sách 4 lần gọi mỗi ngày;
    - key Anthropic đọc từ `.env` của máy dev trong script, không in ra.
  - Script Playwright chạy qua UI, có thêm vài lệnh gọi API để kiểm chéo. Script không commit: nó cần key thật, và phần không cần key đã có trong `e2e/accounts.e2e.ts`.
  - Khoảng 9 lượt Haiku.
- **Tiêu chí 2, đóng tab buổi học vẫn chạy tiếp: đạt.**
  - Alice đăng ký, thêm kết nối Anthropic, đặt Haiku cho mọi vai, bắt đầu buổi "Photosynthesis". Lượt Prober đầu tự chạy.
  - Alice trả lời rồi đóng tab khi lượt đang chạy: lúc đóng đang có `msg-live` và chưa có câu trả lời mới.
  - Mở tab mới từ danh sách buổi: câu trả lời của Prober đã có, không có banner "bị ngắt".
- **Tiêu chí 1, hai tài khoản dữ liệu riêng: đạt.**
  - Bob đăng ký: danh sách buổi trống; mở URL buổi của Alice thì thấy "không tồn tại, hoặc thuộc tài khoản khác".
  - Bob gọi API với buổi của Alice: snapshot, stream và bắt đầu lượt đều trả 404.
- **Tiêu chí 3, demo dừng đúng hạn mức: đạt.**
  - Một trình duyệt mới chọn demo, không có key.
  - Lượt mở đầu và 3 câu trả lời dùng đủ 4 lần gọi (mỗi lượt một lần, không gọi tool).
  - Câu trả lời thứ 4 bị từ chối với `DemoQuotaExceeded`. Admin thấy `used: 4 / limit: 4`, không vượt.
- **Log server:** không có key Anthropic, không có mật khẩu admin.
- **Không kiểm ở bước này:** ACP (không có trong image, C3; đã chạy thật ngoài Docker ở bước 7) và mã mời qua UI (đã kiểm tay ở bước 8).


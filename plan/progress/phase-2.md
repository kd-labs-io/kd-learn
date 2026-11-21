# 8. Tiến độ phase 2

**Trạng thái: đang làm.** Plan phần chính: [tai-khoan.md](../tai-khoan.md).

## Phase 2 (cập nhật 2026-11-21)

| Hạng mục | Trạng thái |
| --- | --- |
| Bước 0: spike driver SQLite server, auth (C1, C2) | Xong (2026-11-21). Driver: `node:sqlite` thô. Auth: tự viết tối thiểu, Bearer cho cả web và Capacitor. Xem ghi chú bước 0 bên dưới |
| Bước 1: driver SQLite server | Xong (2026-11-21). `@kd-learn/storage/sqlite-node`: `openServerDatabase`, `makeServerStorage(db).forUser(userId)`, migration riêng của server, bảng `sessions`. Xem ghi chú bước 1 bên dưới |
| Bước 2: auth | Xong (2026-11-21). `packages/server/src/auth/`, route `/api/auth/*`, `/api/admin/invites`. Xem ghi chú bước 2 bên dưới |
| Bước 3: key mã hoá, cài đặt theo vai | Chưa bắt đầu |
| Bước 4: lượt chạy trên server | Chưa bắt đầu |
| Bước 5: công tắc admin | Chưa bắt đầu |
| Bước 6: demo, ngân sách chung | Chưa bắt đầu |
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


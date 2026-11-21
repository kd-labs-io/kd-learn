# Handoff: bắt đầu phase 3 (practice + graph)

- **Ngày viết:** 2026-11-21, ngay sau khi đóng phase 2 (PR #28 bước 8, PR #29 bước 9, bước 10 và đóng phase trên `main`)
- **Việc tiếp theo:** viết plan phần chính phase 3, theo đúng khuôn [archive/tai-khoan.md](../archive/tai-khoan.md) của phase 2:
  - A. quyết định nền;
  - B. các bước, mỗi bước có tiêu chí xong chạy được trong CI;
  - C. câu hỏi spike.
- **Xoá file này** khi plan phase 3 đã viết xong và `progress/phase-3.md` đã được tạo.

## 1. Đọc gì trước

1. `AGENTS.md`, `apps/web/AGENTS.md` (Astryx), [README.md](../README.md) (mục lục và quy ước đóng / mở việc trong plan).
2. [04-phases.md](../04-phases.md), dòng phase 3. Phạm vi: Practitioner, registry loại bài tập, extractor / auditor / merge, màn hình graph, hồ sơ dạy học sửa được. Xong khi: graph tự cập nhật sau buổi học, và luyện tập lấy bài từ graph.
3. [01-muc-tieu.md](../01-muc-tieu.md), [02-san-pham.md](../02-san-pham.md) (model theo vai đã có chỗ cho Practitioner và extractor), [03-kien-truc.md](../03-kien-truc.md) (`core`: graph và registry loại bài tập; `agent`: Practitioner, hồ sơ dạy học).
4. [02-ky-thuat.md](../02-ky-thuat.md) mục 2.5. TanStack Charts đã chốt cho phase 3 và cần thử cho màn hình graph:
   - kéo / chọn node;
   - vài nghìn node;
   - cạnh có hướng và có nhãn.

   Không đạt thì dùng thư viện graph chuyên dụng. Đây là câu hỏi spike đầu tiên.
5. [05-rui-ro.md](../05-rui-ro.md), [06-viec-mo.md](../06-viec-mo.md): những việc còn mở có thể đụng phase 3. Ví dụ: tóm tắt lịch sử buổi học dài ở chế độ khách, và panel side chat không xem lại được các luồng cũ.
6. Lịch sử khi cần tra: [archive/phase-1.md](../archive/phase-1.md) (lõi dạy học), [archive/phase-2.md](../archive/phase-2.md) (tài khoản, triển khai; ghi chú từng bước rất chi tiết).

`probe/` chỉ là ý tưởng. Không làm theo trực tiếp; nếu khác `plan/` thì `plan/` thắng.

## 2. Trạng thái code sau phase 2

- **Hai chế độ lưu, cùng một lõi:**
  - Khách / demo: log ở DB local của trình duyệt; server không giữ trạng thái (`/api/turns`).
  - Tài khoản: log ở SQLite server (`node:sqlite`). Lượt chạy trên server, tách khỏi request; stream gắn lại theo `seq` (`/api/account/sessions/*`).
  - Mọi thứ mới của phase 3 (graph, bài tập) phải chạy được ở **cả hai** chế độ, hoặc plan phải ghi rõ chế độ nào không có.
- **Event log append-only** (`packages/core`): projection dựng `Session` từ log.
  - Thêm event mới thì thêm vào schema của `core`, và `migrations` dùng chung ở `packages/storage/src/sqlite/schema.ts` nếu cần bảng.
  - Server có migration riêng (`@kd-learn/storage/sqlite-node`). Mọi truy cập dữ liệu tài khoản đi qua `forUser(userId)` (rủi ro 26).
- **Vai và model:**
  - Vai hiện có: Prober, Teacher, side chat.
  - Model theo vai lưu ở cài đặt tài khoản (`packages/server/src/settings/`, `PUT /api/account/roles`). Thêm vai Practitioner / extractor nghĩa là sửa contract `packages/api/src/contract.ts`, màn cài đặt `apps/web/src/account/AccountSettings.tsx` và cách khách chọn model (`apps/web/src/learn/runner.ts`).
  - ACP: model chỉ chọn trong danh sách admin cho phép (rủi ro 30).
- **Màn học:**
  - `LearnScreen` dùng chung, nhận một `LessonSource` (`apps/web/src/learn/source.ts`).
  - Khách: `GuestLesson`. Tài khoản: `AccountLessonScreen` + `AccountLesson` (snapshot + SSE).
  - Màn mới (graph, luyện tập) nên theo cùng mẫu: một interface nguồn dữ liệu, hai cài đặt.
- **TanStack Query** dùng cho dữ liệu tài khoản (danh sách, cài đặt, admin), `QueryClient` tạo theo router. Stream một lượt không qua Query.
- **Triển khai:**
  - `Dockerfile` ghim `node:26.13.1-slim`, `docker-compose.yml`, `.env.example`, `docs/deploy.md`.
  - CI có job `docker` chạy `scripts/compose-smoke.sh`.
  - Biến env mới của server phải được thêm vào `.env.example` và bảng trong `docs/deploy.md`.
- **Test:**
  - Vitest theo package.
  - Playwright chạy trên bản build thật:
    - server khách cổng 4173;
    - server tài khoản cổng 4174, DB tạm;
    - model giả tương thích OpenAI cổng 4175 (`apps/web/e2e/fake-openai.ts`): giữ lượt có chữ `hold` cho tới khi test thả; lượt mở đầu trả "What do you already know?".
  - Lượt cần tool (bài tập, graph) có thể phải mở rộng model giả để trả tool call.

## 3. Quy ước làm việc (giữ như phase 2)

- Chat trả lời tiếng Việt. Code, tên, comment bằng tiếng Anh. File trong `plan/` viết tiếng Việt. `docs/` viết tiếng Anh.
- **Mỗi bước một nhánh và một PR.** CI xanh và chắc chắn thì tự merge vào `main`, không cần hỏi.
  - Commit kết thúc bằng dòng `Claude-Session: <link session>`.
  - Mô tả PR kết thúc bằng link session.
- i18n: chỉ sửa `packages/i18n/messages/{en,vi}.json`, không sửa `packages/i18n/src/paraglide/`. Sau khi thêm chuỗi, chạy `pnpm build` ở `packages/i18n`.
- Astryx (`apps/web/AGENTS.md`):
  - không `<div>`, không hex / px thô; dùng prop của component và token xstyle;
  - trang mới nên bắt đầu từ `astryx build` / `astryx template`. Các trang của phase 2 (đăng nhập, cài đặt, admin) viết tay; chưa làm lại.
- **Bảo mật:**
  - Không in, không ghi log key, mật khẩu, token, mã mời, email.
  - `.env` chứa secret (`KD_LEARN_CLAUDE_API`, `KD_LEARN_SECRET_KEY`): không commit, không in giá trị. Khi cần chạy thật, đọc key từ `.env` trong script.
- **Model thật:** tối đa một lần kiểm mỗi bước (Haiku `claude-haiku-5-5`). Xem chi phí trước; theo dõi rủi ro 18.
- **Kiểm trước khi mở PR:**
  - `pnpm typecheck && pnpm lint && pnpm test && pnpm format:check`;
  - `cd apps/web && pnpm build && npx playwright test --project=chromium`;
  - khi đụng Docker hoặc env: `./scripts/compose-smoke.sh`.
- **Shell:** `sed` là GNU (`gsed` trong script). Sửa code có cấu trúc thì ưu tiên `ast-grep`.
- **Prettier:** `plan/` nằm trong `.prettierignore`, nên đừng format file plan. Chạy prettier khi đang đứng trong `plan/` thì file ignore không có tác dụng, và mọi bảng bị format lại.
- **Xong mỗi bước:**
  - cập nhật `progress/phase-3.md` (dòng trong bảng trạng thái và phần ghi chú của bước);
  - thêm một dòng vào `changelog.md`;
  - sửa mục 7 trong `06-viec-mo.md`;
  - cập nhật rủi ro liên quan trong `05-rui-ro.md`.

## 4. Điều nên biết

- **`acpAvailable` phụ thuộc nơi chạy:**
  - Bản build chạy trong repo vẫn nạp được adapter ACP từ `apps/web/node_modules`.
  - Trong Docker, adapter không nạp được, nên màn admin cảnh báo khi admin bật agent.
  - Server chỉ thử nạp adapter khi có agent đang bật.
- **Demo:** phần giữ chỗ của một lượt không được trả lại nếu process chết giữa lượt (06-viec-mo). Lượt có tool tốn hai lần gọi. Phase 3 thêm vai mới thì cần quyết định demo có được dùng các vai đó không, và tính ngân sách ra sao.
- **Lượt tự chạy (`auto`):** server nối lượt lập plan ngay trong cùng lượt. Client gọi `auto` bị `409 TurnInProgress` / `NothingToRun` thì bỏ qua, không báo lỗi. Nếu phase 3 thêm lượt tự chạy sau buổi học (extractor), xem lại `shouldAutoStart` trong `@kd-learn/agent/client` và cách server nối lượt (`packages/server/src/sessions/runner.ts`).
- **Firefox:** test Playwright chập chờn khi chạy song song trên máy local (06-viec-mo). CI chỉ chạy Chromium.

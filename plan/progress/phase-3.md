# 8. Tiến độ phase 3

**Trạng thái: đang làm.** Plan phần chính: [luyen-tap-graph.md](../luyen-tap-graph.md).

## Phase 3 (cập nhật 2026-11-21)

| Hạng mục | Trạng thái |
| --- | --- |
| Plan phần chính | Xong (2026-11-21). Chốt: một graph mỗi người, demo dùng được graph và luyện tập (tính chung ngân sách), bốn loại bài tập đầu tiên |
| Bước 0: spike hình graph (C1) | Chưa bắt đầu |
| Bước 1: spike extraction với Haiku (C2, C3) | Chưa bắt đầu |
| Bước 2: log kiến thức (core, storage) | Chưa bắt đầu |
| Bước 3: hồ sơ dạy học v2, vai mới | Chưa bắt đầu |
| Bước 4: pipeline extraction (agent) | Chưa bắt đầu |
| Bước 5: extraction trên server | Chưa bắt đầu |
| Bước 6: registry bài tập, Practitioner | Chưa bắt đầu |
| Bước 7: luyện tập trên server | Chưa bắt đầu |
| Bước 8: model giả trả tool call | Chưa bắt đầu |
| Bước 9: màn graph | Chưa bắt đầu |
| Bước 10: màn luyện tập | Chưa bắt đầu |
| Bước 11: màn sửa hồ sơ | Chưa bắt đầu |
| Bước 12: kiểm tiêu chí phase | Chưa bắt đầu |

## Điều cần biết khi bắt đầu (từ handoff sau phase 2)

- **Hai chế độ lưu:** mọi thứ mới phải chạy ở cả khách / demo (DB local, server không trạng thái, `/api/turns`) và tài khoản (SQLite server, lượt tách khỏi request, stream gắn lại theo `seq`, `/api/account/sessions/*`). Mọi truy cập dữ liệu tài khoản đi qua `forUser(userId)`.
- **Migration:** khách ở `packages/storage/src/sqlite/schema.ts`, server có danh sách riêng ở `packages/storage/src/sqlite-node/schema.ts`. Không sửa migration đã phát hành.
- **Thêm vai:** sửa `ModelRole` / `RoleModels` trong `packages/api/src/contract.ts`, màn `apps/web/src/account/AccountSettings.tsx`, cách khách chọn model (`apps/web/src/learn/runner.ts`), `AgentRole` trong `packages/core/src/profile.ts`.
- **Màn mới** theo mẫu `LessonSource` (`apps/web/src/learn/source.ts`): một interface nguồn dữ liệu, hai cài đặt. Dữ liệu tài khoản qua TanStack Query, `QueryClient` tạo theo router.
- **Lượt tự chạy:** server nối lượt lập plan ngay trong cùng lượt; `shouldAutoStart` ở `@kd-learn/agent/client`. Extraction sau buổi học (A3) cần xem lại cách server nối việc sau lượt trong `packages/server/src/sessions/runner.ts`. Client gọi `auto` bị `409 TurnInProgress` / `NothingToRun` thì bỏ qua.
- **Test e2e:** Playwright chạy trên bản build thật: server khách cổng 4173, server tài khoản cổng 4174 (DB tạm), model giả tương thích OpenAI cổng 4175 (`apps/web/e2e/fake-openai.ts`: giữ lượt có chữ `hold` tới khi test thả; lượt mở đầu trả "What do you already know?"). Bước 8 mở rộng để trả tool call.
- **Env mới** của server: thêm vào `.env.example` và bảng trong `docs/deploy.md`; CI job `docker` chạy `scripts/compose-smoke.sh`.
- **ACP:** `acpAvailable` phụ thuộc nơi chạy (bản build trong repo nạp được adapter, Docker thì không).
- **Kiểm trước khi mở PR:** `pnpm typecheck && pnpm lint && pnpm test && pnpm format:check`; `cd apps/web && pnpm build && npx playwright test --project=chromium`; đụng Docker hay env thì `./scripts/compose-smoke.sh`. Firefox chập chờn khi chạy song song ở máy local; CI chỉ chạy Chromium.
- **Quy ước:** mỗi bước một nhánh, một PR; CI xanh thì tự merge. Không format file trong `plan/` (nằm trong `.prettierignore`; đừng chạy prettier khi đang đứng trong `plan/`). Secret trong `.env` không in, không commit. Model thật tối đa một lần kiểm mỗi bước.
- **Xong mỗi bước:** cập nhật bảng trên và ghi chú của bước, một dòng `changelog.md`, mục 7 trong `06-viec-mo.md`, rủi ro liên quan trong `05-rui-ro.md`.

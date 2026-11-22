# 8. Tiến độ phase 4

**Trạng thái: đang làm.** Plan phần chính: [nguon-hoc.md](../nguon-hoc.md).

## Phase 4 (cập nhật 2026-11-22)

| Hạng mục | Trạng thái |
| --- | --- |
| Plan phần chính | Xong (2026-11-22). Chốt: chỉ việc nền sống sót khi khởi động lại (lượt học giữ quy tắc "bị ngắt"); nguồn vừa làm tư liệu dạy có trích dẫn vừa gắn vào mệnh đề; demo dùng được nguồn và research (tính chung ngân sách); SearXNG và Exa do admin cấu hình, web search của provider dùng key của người dùng |
| Bước 0: spike tách chữ PDF (C1) | Chưa bắt đầu |
| Bước 1: spike tìm kiếm (C2) | Chưa bắt đầu |
| Bước 2: spike dạy dựa trên nguồn (C3) | Chưa bắt đầu |
| Bước 3: job bền | Chưa bắt đầu |
| Bước 4: nguồn trong core và storage | Chưa bắt đầu |
| Bước 5: `packages/search` | Chưa bắt đầu |
| Bước 6: ingest PDF và ghi chú | Chưa bắt đầu |
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

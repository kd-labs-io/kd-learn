# 8. Tiến độ phase 5

**Trạng thái: đang làm.** Plan phần chính: [hinh-va-demo.md](../hinh-va-demo.md).

## Phase 5 (cập nhật 2026-11-22)

| Hạng mục | Trạng thái |
| --- | --- |
| Plan phần chính | Xong (2026-11-22). Chốt: demo không sinh ảnh trừ khi admin bật (mỗi ảnh tính N lần gọi); khách sinh ảnh được qua vai `illustrator` riêng, không fallback; hình chỉ ở luồng chính của Teacher; demo HTML được nạp thư viện CDN trong danh sách cho phép (ghim bản, SRI), admin tắt được |
| Bước 0: spike khung sandbox (C1) | Chưa làm |
| Bước 1: spike SVG / Mermaid (C2) | Chưa làm |
| Bước 2: spike Teacher vẽ hình với Haiku (C3) | Chưa làm |
| Bước 3: spike sinh ảnh (C4) | Chưa làm |
| Bước 4: hình trong `core` và `storage` | Chưa làm |
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

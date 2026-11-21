# 8. Tiến độ phase 1

## Phase 1 (cập nhật 2026-11-21)

Spike đã merge vào `main` (PR #2, sửa thêm ở PR #3, #4). Plan phần chính: [loi-day-hoc.md](../loi-day-hoc.md).

| Hạng mục | Trạng thái |
| --- | --- |
| Spike port AI ([spike-port-ai.md](../archive/spike-port-ai.md)) | Xong (2026-11-21). Rủi ro 1, 2 đạt |
| Bước 0: khung `storage`, `api`, `server` | Chưa bắt đầu |
| Bước 1: spike SQLite WASM + TanStack DB | Chưa bắt đầu |
| Bước 2: schema, projection (`core`) | Chưa bắt đầu |
| Bước 3: vòng turn, Prober → Teacher, side chat (`agent`) | Chưa bắt đầu |
| Bước 4: API, server, SSE | Chưa bắt đầu |
| Bước 5: DB local | Chưa bắt đầu |
| Bước 6: spike Markdown + KaTeX | Chưa bắt đầu |
| Bước 7: UI | Chưa bắt đầu |
| Bước 8: kiểm tiêu chí phase | Chưa bắt đầu |

## Bàn giao (2026-11-21)

Plan phần chính đã duyệt và merge (PR #7). Việc tiếp theo, làm ở chat mới: **bước 0** của [loi-day-hoc.md](../loi-day-hoc.md).

- Tạo `packages/storage`, `packages/api`, `packages/server` theo mẫu package có sẵn (`packages/core`: `package.json`, `tsconfig`, script `typecheck`/`test`/`lint`).
- `storage` export `./port` (chỉ import `effect`, giống `packages/ai/src/port`); driver để bước 5.
- Thêm lint ranh giới cho `api` và `server` trong `packages/config/eslint.js` (bảng import được phép theo package), kèm test trong `packages/config/test`.
- Xong khi `turbo build test lint` xanh và test lint chặn import sai.
- Sau đó: bước 1 (spike SQLite WASM) và bước 2 (schema trong `core`) làm song song.

## Lưu ý khi chạy model thật

- Chạy thử 1 lượt, xem model và chi phí, rồi mới chạy hàng loạt. Spike đã đốt hạn mức 5 giờ của gói vì bỏ bước này (mỗi lượt Claude Code từng tốn khoảng 980k token).
- Claude Code qua ACP dùng chung hạn mức gói với phiên làm việc; ưu tiên Haiku cho script và test tay.
- Key API nằm trong `.env` ở gốc repo (không commit).

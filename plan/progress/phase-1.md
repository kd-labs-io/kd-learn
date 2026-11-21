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

## Lưu ý khi chạy model thật

- Chạy thử 1 lượt, xem model và chi phí, rồi mới chạy hàng loạt. Spike đã đốt hạn mức 5 giờ của gói vì bỏ bước này (mỗi lượt Claude Code từng tốn khoảng 980k token).
- Claude Code qua ACP dùng chung hạn mức gói với phiên làm việc; ưu tiên Haiku cho script và test tay.
- Key API nằm trong `.env` ở gốc repo (không commit).

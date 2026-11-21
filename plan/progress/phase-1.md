# 8. Tiến độ phase 1

## Phase 1 (cập nhật 2026-11-21)

Spike đã merge vào `main` (PR #2, sửa thêm ở PR #3, #4). Phần chính chưa có nhánh.

| Hạng mục | Trạng thái |
| --- | --- |
| Spike port AI ([spike-port-ai.md](../archive/spike-port-ai.md)) | Xong (2026-11-21). Rủi ro 1, 2 đạt |
| Schema, vòng turn, Prober → Teacher, side chat | Chưa bắt đầu |
| Server không trạng thái, DB local, UI responsive | Chưa bắt đầu |

## Bàn giao (2026-11-21)

Việc tiếp theo, làm ở chat mới: **lập plan cho phần chính của phase 1**. Chưa viết code.

**Đọc trước:**

- [04-phases.md](../04-phases.md): phạm vi và tiêu chí xong của phase 1 (khách tự nhập key, học xong 1 chủ đề, tải lại trang không mất dữ liệu).
- [03-kien-truc.md](../03-kien-truc.md) mục 3.3: hình dạng port AI đã chốt; mục 3.4: luồng một lượt học.
- [02-ky-thuat.md](../02-ky-thuat.md) mục 2.5: thư viện TanStack dùng ở phase 1 và hai spike chưa làm (Markdown + KaTeX, TanStack DB).
- [06-viec-mo.md](../06-viec-mo.md): việc còn mở liên quan phase 1 (driver SQLite WASM, tóm tắt lịch sử dài cho khách, bộ hiển thị Markdown, TanStack DB).
- [05-rui-ro.md](../05-rui-ro.md): rủi ro 3, 4 (chế độ khách), 15–17 (ACP).

**Plan cần trả lời:**

- Chia phần chính thành các bước nhỏ, mỗi bước có tiêu chí xong; thứ tự làm.
- Schema (Effect Schema trong `packages/core`): record, event của buổi học.
- Vòng turn và vai Prober → Teacher, side chat (`packages/agent`, chỉ dùng port).
- Server không trạng thái, API HTTP (`packages/api`, `packages/server`), DB local của khách (`packages/storage`).
- Hai spike nhỏ (KaTeX, TanStack DB) và chọn driver SQLite WASM: làm trước hay song song.
- Theo quy ước ở `README.md`: plan lớn thì tạo `plan/<chu-de>.md` và thêm vào bảng "Đọc file nào".

**Mã đã có:** `packages/ai` (port ở `src/port`, adapter `src/tanstack` và `src/acp`). Script chạy tay: `scripts/live.ts` (backend API), `scripts/acp-live.ts` (ACP, in model và chi phí mỗi lượt).

**Lưu ý khi chạy model thật:**

- Chạy thử 1 lượt, xem model và chi phí, rồi mới chạy hàng loạt. Spike đã đốt hạn mức 5 giờ của gói vì bỏ bước này (mỗi lượt Claude Code từng tốn khoảng 980k token).
- Claude Code qua ACP dùng chung hạn mức gói với phiên làm việc; ưu tiên Haiku cho script và test tay.
- Key API nằm trong `.env` ở gốc repo (không commit).


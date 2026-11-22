# Plan kd-learn

- **Trạng thái:** phase 0 xong (2026-11-17, [archive/phase-0.md](archive/phase-0.md)), phase 1 xong (2026-11-21, [archive/phase-1.md](archive/phase-1.md); spike port AI ở [archive/spike-port-ai.md](archive/spike-port-ai.md), plan phần chính ở [archive/loi-day-hoc.md](archive/loi-day-hoc.md)). Phase 2 xong (2026-11-21, [archive/phase-2.md](archive/phase-2.md); plan phần chính ở [archive/tai-khoan.md](archive/tai-khoan.md)). Phase 3 xong (2026-11-22, [archive/phase-3.md](archive/phase-3.md); plan phần chính ở [archive/luyen-tap-graph.md](archive/luyen-tap-graph.md)). Phase 4 xong (2026-11-22, [archive/phase-4.md](archive/phase-4.md); plan phần chính ở [archive/nguon-hoc.md](archive/nguon-hoc.md)). Phase 5 xong (2026-11-22, [archive/phase-5.md](archive/phase-5.md); plan phần chính ở [archive/hinh-va-demo.md](archive/hinh-va-demo.md)). Phase 6 (theme + web trên điện thoại): đang làm ([progress/phase-6.md](progress/phase-6.md); plan phần chính ở [theme-va-dien-thoai.md](theme-va-dien-thoai.md)). Phase 7: app mobile (Capacitor)
- **Nguồn:** `probe/IDEA.md` và phần hỏi đáp trong `probe/AGENT_FEEDBACK.md`
- **Lịch sử thay đổi:** [changelog.md](changelog.md)

> **Vai trò của hai thư mục**
>
> - `plan/` là để hành động: đây là nguồn chính thức cho việc cần làm.
> - `probe/` chỉ để brainstorm: ý tưởng, hỏi đáp, bản nháp đã bị thay thế. Không triển khai trực tiếp từ đó.
> - Khi hai bên mâu thuẫn, `plan/` đúng. Cụ thể, plan này thay thế `probe/IDEA.md` ở hai điểm: mobile dùng Capacitor (không phải Expo), và "offline-first" được hiểu là chế độ khách (không phải dùng được khi mất mạng).

## Đọc file nào

Số mục giữ nguyên làm ID ổn định: "mục 2.4", "rủi ro 12" vẫn dùng được trong mọi file.

| Mục     | File                               | Đọc khi                                                                                       |
| ------- | ---------------------------------- | --------------------------------------------------------------------------------------------- |
| 1       | [01-muc-tieu.md](01-muc-tieu.md)   | Cần bối cảnh: app làm gì, ba agent                                                            |
| 2.1–2.3 | [02-san-pham.md](02-san-pham.md)   | Tính năng, chế độ chạy (khách / tài khoản / demo), thiết kế mở, theme                         |
| 2.4–2.5 | [02-ky-thuat.md](02-ky-thuat.md)   | Chọn thư viện, công cụ, stack; thư viện TanStack theo phase                                   |
| 3       | [03-kien-truc.md](03-kien-truc.md) | Cấu trúc monorepo, ranh giới package, port AI, luồng một lượt học                             |
| 4       | [04-phases.md](04-phases.md)       | Phạm vi và tiêu chí xong của từng phase, việc sau phase 7                                     |
| 5       | [05-rui-ro.md](05-rui-ro.md)       | Rủi ro, việc cần kiểm chứng, kết quả đã kiểm                                                  |
| 6–7     | [06-viec-mo.md](06-viec-mo.md)     | Câu hỏi chưa chốt, bước tiếp theo                                                             |
| —       | [theme-va-dien-thoai.md](theme-va-dien-thoai.md) | Plan phần chính phase 6: theme hai chế độ, theme dựng sẵn, đồng bộ lựa chọn, web trên điện thoại |
| 8       | `progress/`                        | Tiến độ phase đang làm, mỗi phase một file (`phase-<n>.md`); hiện có [phase-6.md](progress/phase-6.md) |
| —       | [archive/](archive/)               | Phần đã xong: phase đã đóng, rủi ro đã đóng, plan chủ đề đã xong. Chỉ đọc khi cần tra lịch sử |

## Quy ước

Mọi thay đổi đều thêm một dòng vào `changelog.md`. Số mục, số rủi ro chỉ thêm tiếp, không đánh lại, không dùng lại số đã xoá.

### Khi một phần đã xong

| Loại                               | Làm gì                                                                                                                                                                                  |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase                              | Ghi `Trạng thái: xong (ngày)` ở đầu `progress/phase-<n>.md`, chuyển file sang `archive/phase-<n>.md`, sau đó không sửa nữa. Cập nhật dòng trạng thái ở đầu file này                     |
| Việc còn mở (mục 6)                | Xoá khỏi `06-viec-mo.md`, ghi quyết định vào file quyết định tương ứng (`02-*.md`, `03-kien-truc.md`). Mục 6 chỉ chứa việc chưa chốt                                                    |
| Rủi ro (mục 5)                     | Giữ dòng và số, ghi `**Đã kiểm chứng (ngày):** ...` vào cột cách xử lý (như rủi ro 12). Khi đóng hẳn (không cần theo dõi nữa), chuyển dòng sang `archive/rui-ro-da-dong.md`, vẫn giữ số |
| Bước tiếp theo (mục 7)             | Chỉ ghi bước hiện tại; xong phase thì thay bằng bước của phase sau                                                                                                                      |
| Plan theo chủ đề (spike, thiết kế) | Kết luận chuyển vào file quyết định hoặc kiến trúc; file gốc chuyển vào `archive/` và bỏ khỏi bảng trên                                                                                 |

Khi chuyển file hay dòng vào `archive/`, tìm và sửa link trỏ tới nó (`grep -rn "<tên file>" plan/`). Nội dung trong `archive/` chỉ để tra lịch sử, không cần đọc khi làm việc mới.

### Khi thêm mới

| Loại                                            | Làm gì                                                                                                             |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Quyết định                                      | Thêm dòng vào bảng đúng chủ đề trong `02-*.md`. Chủ đề mới thì thêm mục tiếp theo (2.6, ...)                       |
| Tính năng hoặc phase mới                        | Thêm dòng vào `04-phases.md` (hoặc danh sách "sau phase 7"). Bắt đầu làm phase nào thì tạo `progress/phase-<n>.md` |
| Rủi ro, việc còn mở                             | Thêm vào cuối `05-rui-ro.md`, `06-viec-mo.md`                                                                      |
| Chủ đề lớn cần plan riêng (ví dụ spike port AI) | Tạo `plan/<chu-de>.md`, thêm một dòng vào bảng "Đọc file nào"                                                      |
| File quá dài (hơn khoảng 150 dòng)              | Tách thành thư mục cùng tên (ví dụ `02-ky-thuat/`), giữ nguyên số mục, cập nhật bảng trên                          |

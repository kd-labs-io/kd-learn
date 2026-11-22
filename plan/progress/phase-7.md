# 8. Tiến độ phase 7

Plan phần chính: [cai-thien-ux.md](../cai-thien-ux.md).

## Phase 7 (cập nhật 2026-11-22)

| Hạng mục | Trạng thái |
| --- | --- |
| Plan phần chính | Xong (2026-11-22). B1, B2, B4 theo đề xuất; B3 làm trạng thái, chưa làm xoá (log append-only) |
| Bước 0: spike component Astryx | Xong (2026-11-22). Kết quả ở D0 |
| Bước 1: chụp và rà toàn bộ | Xong (2026-11-22). `pnpm --filter @kd-learn/web shots` (`playwright.shots.config.ts`, `e2e/shots/screens.shots.ts`): 18 màn / trạng thái × desktop 1440 và Pixel 7 × sáng / tối. Phát hiện ở dưới |
| Bước 2: quy tắc UX, skill `ux-check` | Xong (2026-11-22). Mục "UX" trong `DESIGN.md`, dòng trong `apps/web/AGENTS.md`, skill `.claude/skills/ux-check/SKILL.md` |
| Bước 3: khung app và điều hướng | Xong (2026-11-22). Mọi trang `contentWidth={pageWidth}`; `AppHeader` mới: brand, bốn mục có trạng thái đang chọn, menu tài khoản (ngôn ngữ, quản trị, đổi chế độ, đăng nhập, đăng xuất); điện thoại hai dòng |
| Bước 4: trang chủ | Xong (2026-11-22). `HomeParts.tsx` dùng chung cho khách và tài khoản: hai cột (bắt đầu học + luyện tập, danh sách buổi học), gợi ý chủ đề, nút bắt đầu báo lý do khi ô trống, mỗi buổi có trạng thái và tiến độ (`SessionSummary.stepsTotal`, `stepsResolved`, `completed`; API `SessionSummaryInfo` thêm ba trường), `EmptyState` |
| Bước 5: màn học | Xong (2026-11-22). Hội thoại và ô trả lời cùng cột 72ch; bong bóng cho người học; tiến độ dưới tên chủ đề; Enter để gửi (chuột, bàn phím); cột kế hoạch 280 px từ 900 px |
| Bước 6: side chat | Xong (2026-11-22). Đóng mặc định, nút ở header; cột ở màn rộng (nhớ trên máy), drawer ở màn hẹp (không nhớ); chọn luồng cũ để đọc lại (chỉ luồng hiện tại nhận câu hỏi) |
| Bước 7: các màn còn lại | Một phần (2026-11-22). Mọi màn được khung chung; nút luyện tập hết tràn ngang. Graph, nguồn, hồ sơ, cài đặt, admin chưa sửa riêng (mức trung bình / thấp, xem dưới) |
| Bước 8: trạng thái và tiếp cận | Một phần (2026-11-22). Nạp trước KaTeX khi mở buổi học (`preloadMath`); `aria-current` ở điều hướng. Chưa rà `aria-live` cho chữ đang stream |
| Bước 9: người dùng duyệt | Chưa làm. Ảnh trước / sau gửi người dùng |

## Phát hiện của bước 1 (2026-11-22)

Ảnh "trước" của bản `main`. Phát hiện ở mục A của plan đúng trên mọi màn; thêm:

| Màn | Vấn đề | Mức | Trạng thái |
| --- | --- | --- | --- |
| Mọi màn | Nội dung dồn trái ở 1440 px, nửa phải trống (cài đặt, luyện tập, nguồn, admin) | cao | Sửa (bước 3) |
| Header, điện thoại | Ba dòng, email chiếm cả dòng | cao | Sửa (bước 3) |
| Luyện tập | Nút "Bắt đầu luyện tập" kéo ngang 700 px, trang trống | trung bình | Sửa nút; trang vẫn thưa |
| Graph | Nhãn cạnh chồng lên đường, vùng đồ thị không có khung | thấp | Để sau |
| Cài đặt | Form dài một cột, không có mục lục | trung bình | Để sau |
| Màn học, dark | Ảnh tối của tài khoản chụp ra sáng: tài khoản giữ lựa chọn "theo hệ thống", script phải giả lập `prefers-color-scheme` | — | Sửa script |

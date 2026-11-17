# 4. Các phase


| Phase | Nội dung | Xong khi |
| --- | --- | --- |
| 0. Khung | Turborepo, pnpm, TS, lint ranh giới package, theme, khung i18n, test, CI, `git init`. Spike UI: TanStack Start + Astryx build cả SSR và SPA; theme kd-learn từ `DESIGN.md`; một component mẫu trong `@kd-learn/ui` được CLI Astryx nhận qua `workspace:*`; StyleX qua `@astryxdesign/build`; đổi token lúc chạy từ một theme dạng JSON. Mở thử trên Safari iOS hoãn sang phase 6 ([rủi ro 5](05-rui-ro.md)) | `turbo build test lint` chạy xanh; spike UI đạt, nếu không thì quay về Tailwind + shadcn |
| 1. Lõi dạy học (khách) | Spike port AI (TanStack AI + ACP, ranh giới stream với Effect). Schema, vòng turn, Prober → Teacher, side chat, server không trạng thái, DB local, UI responsive | Khách tự nhập key, học xong 1 chủ đề, tải lại trang không mất dữ liệu |
| 2. Tài khoản + triển khai | SQLite server, auth bằng token, key mã hoá, công tắc admin, demo có hạn mức, UI chọn model theo vai, backend ACP, Docker Compose | Hai tài khoản dữ liệu riêng; đóng tab buổi học vẫn chạy tiếp; demo dừng đúng hạn mức |
| 3. Practice + graph | Practitioner, registry loại bài tập, extractor / auditor / merge, màn hình graph (spike TanStack Charts: kéo / chọn node, vài nghìn node, cạnh có hướng và nhãn; không đạt thì dùng thư viện graph chuyên dụng), hồ sơ dạy học sửa được | Graph tự cập nhật sau buổi học, luyện tập lấy bài từ graph |
| 4. Nguồn học + việc nền | PDF, import ghi chú, research web với port tìm kiếm và UI cấu hình | Job của tài khoản sống sót khi server khởi động lại |
| 5. Hình và demo | Sơ đồ SVG / Mermaid, demo HTML trong iframe sandbox, tool sinh ảnh | Teacher chèn được sơ đồ và demo vào bước dạy; mã sinh ra không đọc được dữ liệu app |
| 6. Mobile + theme | Vỏ Capacitor, màn hình nhập URL server, dark mode, kiểm Safari iOS (hoãn từ phase 0) | Đăng nhập và học 1 buổi trên điện thoại; đổi theme không vỡ sơ đồ |

Thứ tự phase cũng là thứ tự cắt giảm nếu phạm vi quá lớn: cắt từ phase 6 ngược lên.

**Sau phase 6 (chưa xếp lịch):**

- **Theme tuỳ biến:** người dùng chỉnh token trong UI, xem trước trực tiếp, cảnh báo khi độ tương phản dưới chuẩn WCAG AA.
- **Import / export theme:** file JSON theo schema theme. Import phải validate và từ chối mọi giá trị ngoài schema.
- **Marketplace theme:** duyệt, cài, chia sẻ, đánh giá theme. Mô hình (chạy trên từng server hay một registry chung) chốt sau ([mục 6](06-viec-mo.md)).


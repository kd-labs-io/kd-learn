# 6–7. Việc còn mở và bước tiếp theo

## 6. Việc còn mở

- Cơ chế tóm tắt lịch sử cho buổi học dài ở chế độ khách. Phase 1 chỉ đặt giới hạn kích thước request ([archive/loi-day-hoc.md](archive/loi-day-hoc.md) A8).
- Thư viện auth và driver SQLite server: chọn sau khi đọc tài liệu hiện hành, ở phase 2. (Driver SQLite WASM đã chốt ở phase 1, [mục 2.4](02-ky-thuat.md).)
- Phiên bản iOS tối thiểu cho app mobile (liên quan [rủi ro 5](05-rui-ro.md)). Đề xuất iOS 17.5; chưa kiểm trên thiết bị thật.
- Panel side chat sau khi buổi học `done` chỉ hiện luồng `general`; các câu hỏi cũ ở luồng từng bước còn trong log nhưng không xem lại được (phát hiện ở bước 8 phase 1). Cần cách duyệt các luồng cũ.
- Sau khi tải lại trang, công thức hiện mã TeX thô một thoáng cho tới khi KaTeX (nạp lười) xong. Cân nhắc nạp trước KaTeX khi buổi học đã có công thức.
- Marketplace theme: chạy riêng trên từng server hay dùng một registry chung, cách kiểm duyệt, và theme dùng chung giấy phép nào.

## 7. Bước tiếp theo

Phase 2 (tài khoản + triển khai, [mục 4](04-phases.md)): plan phần chính ở [tai-khoan.md](tai-khoan.md). Ba quyết định sản phẩm đã chốt (A4, A6, A8). Bước 0 là spike chọn driver SQLite server và thư viện auth (C1, C2). Khi bắt đầu làm thì tạo `progress/phase-2.md`.

# 6–7. Việc còn mở và bước tiếp theo

## 6. Việc còn mở

- Cơ chế tóm tắt lịch sử cho buổi học dài ở chế độ khách. Phase 1 chỉ đặt giới hạn kích thước request ([archive/loi-day-hoc.md](archive/loi-day-hoc.md) A8).
- Thư viện auth và driver SQLite server: chọn sau khi đọc tài liệu hiện hành, ở phase 2. (Driver SQLite WASM đã chốt ở phase 1, [mục 2.4](02-ky-thuat.md).)
- Phiên bản iOS tối thiểu cho app mobile (liên quan [rủi ro 5](05-rui-ro.md)). Đề xuất iOS 17.5; chưa kiểm trên thiết bị thật.
- Panel side chat sau khi buổi học `done` chỉ hiện luồng `general`; các câu hỏi cũ ở luồng từng bước còn trong log nhưng không xem lại được (phát hiện ở bước 8 phase 1). Cần cách duyệt các luồng cũ.
- Sau khi tải lại trang, công thức hiện mã TeX thô một thoáng cho tới khi KaTeX (nạp lười) xong. Cân nhắc nạp trước KaTeX khi buổi học đã có công thức.
- Marketplace theme: chạy riêng trên từng server hay dùng một registry chung, cách kiểm duyệt, và theme dùng chung giấy phép nào.

## 7. Bước tiếp theo

Phase 2 (tài khoản + triển khai, [mục 4](04-phases.md)): bước đầu là lập plan phần chính của phase 2 (`plan/tai-khoan.md`, theo mẫu plan phase 1 ở [archive/loi-day-hoc.md](archive/loi-day-hoc.md)), mở bằng một spike chọn thư viện auth và driver SQLite server sau khi đọc tài liệu hiện hành (mục 6). Khi bắt đầu làm thì tạo `progress/phase-2.md`.

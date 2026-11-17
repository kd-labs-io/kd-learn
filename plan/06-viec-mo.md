# 6–7. Việc còn mở và bước tiếp theo

## 6. Việc còn mở

- Cơ chế tóm tắt lịch sử cho buổi học dài ở chế độ khách.
- Thư viện auth và driver SQLite cụ thể: chọn sau khi đọc tài liệu hiện hành. Phase 0 chưa cần nên chưa chọn; driver SQLite WASM chọn ở phase 1, auth và driver SQLite server ở phase 2.
- Phiên bản iOS tối thiểu cho app mobile (liên quan [rủi ro 5](05-rui-ro.md)). Đề xuất iOS 17.5; chưa kiểm trên thiết bị thật.
- Chờ xác nhận: [mục 2.5](02-ky-thuat.md) nói thư viện TanStack chỉ nằm trong `apps/web` và `packages/ui`, nhưng [mục 2.4](02-ky-thuat.md) đặt TanStack AI trong `packages/ai`. Lint hiện cho `packages/ai` dùng `@tanstack/ai*` làm ngoại lệ.
- Chờ xác nhận: `agent` chỉ được import `@kd-learn/core` và phần port của `ai`, `search`, `storage` qua đường dẫn `@kd-learn/<package>/port`. Quy ước này đã có trong lint, plan chưa ghi.
- Chờ quyết định: chạy `astryx init` không (lệnh này ghi chỉ dẫn của Astryx vào `AGENTS.md`); thêm vào `AGENTS.md` ghi chú "sửa chuỗi trong `packages/i18n/messages/`, không sửa `src/paraglide/`"; duyệt các "agent skills" của TanStack mà `pnpm approve` đang chờ.
- Bộ hiển thị Markdown: TanStack Markdown hay `Markdown` của Astryx, tuỳ kết quả spike công thức toán ở phase 1.
- Có dùng TanStack DB cho DB local của khách không: chốt sau spike ở phase 1.
- Marketplace theme: chạy riêng trên từng server hay dùng một registry chung, cách kiểm duyệt, và theme dùng chung giấy phép nào.

## 7. Bước tiếp theo

Đóng phase 0:

1. Mở app trên Safari iOS (điện thoại thật hoặc simulator), kiểm theme, font, đổi theme lúc chạy, đổi ngôn ngữ.
2. Commit nhánh `phase-0-scaffold`, mở PR để CI chạy trên GitHub.
3. Chốt các mục "chờ xác nhận" ở mục 6.

Sau đó vào phase 1, bắt đầu bằng spike port AI (TanStack AI + ACP).


# 6–7. Việc còn mở và bước tiếp theo

## 6. Việc còn mở

- Cơ chế tóm tắt lịch sử cho buổi học dài ở chế độ khách. Phase 1 chỉ đặt giới hạn kích thước request ([archive/loi-day-hoc.md](archive/loi-day-hoc.md) A8).
- Phiên bản iOS tối thiểu cho app mobile (liên quan [rủi ro 5](05-rui-ro.md)). Đề xuất iOS 17.5; chưa kiểm trên thiết bị thật.
- Panel side chat sau khi buổi học `done` chỉ hiện luồng `general`; các câu hỏi cũ ở luồng từng bước còn trong log nhưng không xem lại được (phát hiện ở bước 8 phase 1). Cần cách duyệt các luồng cũ.
- Sau khi tải lại trang, công thức hiện mã TeX thô một thoáng cho tới khi KaTeX (nạp lười) xong. Cân nhắc nạp trước KaTeX khi buổi học đã có công thức.
- Test Playwright trên Firefox chập chờn khi chạy song song (máy local; CI không chạy Firefox): mỗi lần chạy có 1–2 test hỏng do hết thời gian chờ, mỗi lần một test khác nhau (`without a key…`, `reload in the middle…`, `on a phone…`). Chạy lại hoặc chạy `--workers=1` thì xanh. Có cả trên `main` trước bước 2 phase 2 (2026-11-21).
- Model và key demo chỉ đặt được qua env (phase 2 bước 6). Đặt từ UI admin cần mã hoá key bằng secret box như key của tài khoản. Phần giữ chỗ của một lượt demo không được trả lại nếu process chết giữa lượt, nên bộ đếm có thể cao hơn thực tế tới 4 lần gọi cho mỗi lượt đang chạy.
- ACP trên bản build: mới kiểm Claude Code (`KD_BUILD_ACP=1`). opencode và Antigravity cần bridge stdio (`packages/ai/src/acp/stdio-bridge.ts`) mà bản build chưa đóng gói; cần đóng gói bridge (hoặc chỉ dùng agent hỗ trợ MCP qua HTTP) trước khi bật hai agent này trên server thật. ACP trong Docker để sau phase 2 (C3). Admin bật được agent cả trên bản build không kèm ACP; lượt khi đó trả `AcpUnavailable` (thông báo cố định, chi tiết chỉ ở log server). Màn admin báo khi `acpAvailable` là `false` (bước 8).
- Marketplace theme: chạy riêng trên từng server hay dùng một registry chung, cách kiểm duyệt, và theme dùng chung giấy phép nào.

## 7. Bước tiếp theo

Phase 5 (hình và demo, [mục 4](04-phases.md)): chưa bắt đầu. Bước hiện tại: viết plan phần chính phase 5 (quyết định nền, các bước, câu hỏi spike, như [archive/nguon-hoc.md](archive/nguon-hoc.md) của phase 4): sơ đồ SVG / Mermaid, demo HTML trong iframe sandbox, tool sinh ảnh. Bắt đầu làm thì tạo `progress/phase-5.md`. Việc còn mở từ phase 4 ghi ở cuối phần "Bước 11" của [archive/phase-4.md](archive/phase-4.md).

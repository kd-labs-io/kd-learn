# 6–7. Việc còn mở và bước tiếp theo

## 6. Việc còn mở

- Cơ chế tóm tắt lịch sử cho buổi học dài ở chế độ khách. Phase 1 chỉ đặt giới hạn kích thước request ([archive/loi-day-hoc.md](archive/loi-day-hoc.md) A8).
- Phiên bản iOS tối thiểu cho app mobile (liên quan [rủi ro 5](05-rui-ro.md)). Đề xuất iOS 17.5; chưa kiểm trên thiết bị thật. Safari iOS kiểm ở phase 6, WebView ở phase 7.
- Panel side chat sau khi buổi học `done` chỉ hiện luồng `general`; các câu hỏi cũ ở luồng từng bước còn trong log nhưng không xem lại được (phát hiện ở bước 8 phase 1). Cần cách duyệt các luồng cũ.
- Sau khi tải lại trang, công thức hiện mã TeX thô một thoáng cho tới khi KaTeX (nạp lười) xong. Cân nhắc nạp trước KaTeX khi buổi học đã có công thức.
- Test Playwright trên Firefox chập chờn khi chạy song song (máy local; CI không chạy Firefox): mỗi lần chạy có 1–2 test hỏng do hết thời gian chờ, mỗi lần một test khác nhau (`without a key…`, `reload in the middle…`, `on a phone…`). Chạy lại hoặc chạy `--workers=1` thì xanh. Có cả trên `main` trước bước 2 phase 2 (2026-11-21).
- Model và key demo chỉ đặt được qua env (phase 2 bước 6). Đặt từ UI admin cần mã hoá key bằng secret box như key của tài khoản. Phần giữ chỗ của một lượt demo không được trả lại nếu process chết giữa lượt, nên bộ đếm có thể cao hơn thực tế tới 4 lần gọi cho mỗi lượt đang chạy.
- ACP trên bản build: mới kiểm Claude Code (`KD_BUILD_ACP=1`). opencode và Antigravity cần bridge stdio (`packages/ai/src/acp/stdio-bridge.ts`) mà bản build chưa đóng gói; cần đóng gói bridge (hoặc chỉ dùng agent hỗ trợ MCP qua HTTP) trước khi bật hai agent này trên server thật. ACP trong Docker để sau phase 2 (C3). Admin bật được agent cả trên bản build không kèm ACP; lượt khi đó trả `AcpUnavailable` (thông báo cố định, chi tiết chỉ ở log server). Màn admin báo khi `acpAvailable` là `false` (bước 8).
- Marketplace theme: chạy riêng trên từng server hay dùng một registry chung, cách kiểm duyệt, và theme dùng chung giấy phép nào.
- Adapter ảnh tương thích OpenAI (`/images/generations`) chưa gọi thật tới endpoint nào; tham số khớp danh sách của OpenRouter (phase 5).
- Với yêu cầu mơ hồ ("something interactive"), Haiku đôi khi vẽ sơ đồ thay vì làm demo (bước 10 phase 5). Cân nhắc chỉnh mô tả tool nếu người dùng gặp nhiều.

- Hình do Haiku vẽ ở dark mode chưa thấy với model thật (bước 6 phase 6: Haiku để hình cho bước sau). Kiểm khi kiểm máy thật.
- Header chung (`AppHeader`) xuống ba dòng ở 393 px, chiếm khoảng một phần tư màn hình (bước 5 phase 6): xem lại sau khi người dùng kiểm trên máy thật.

## 7. Bước tiếp theo

Phase 7 (app mobile): chưa lên plan. Việc đầu tiên: người dùng kiểm bản web trên điện thoại thật theo danh sách ở [archive/phase-6.md](archive/phase-6.md) (`scripts/phone-check.sh`). Phase 6 xong (2026-11-22, [archive/phase-6.md](archive/phase-6.md)), trừ bước kiểm máy thật đó.

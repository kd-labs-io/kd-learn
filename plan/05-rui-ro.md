# 5. Rủi ro và việc cần kiểm chứng


| # | Rủi ro | Cách xử lý |
| --- | --- | --- |
| 1 | Output có cấu trúc qua ACP không đủ tin cậy | Thử ở spike đầu phase 1. Nếu không đạt, ACP chỉ dùng cho vai không cần cấu trúc chặt |
| 2 | Ranh giới giữa stream của TanStack AI và Effect | **Đã kiểm chứng (2026-11-17): đạt.** Adapter tự viết trong `packages/ai/src/tanstack` chuyển stream sang `Stream` của Effect; huỷ Stream thì abort request (có test). Chi tiết ở [spike port AI](spike-port-ai.md) |
| 3 | Khách phải gửi lại lịch sử buổi học mỗi lượt | Giới hạn kích thước request, thiết kế cách tóm tắt lịch sử dài. Chưa thiết kế |
| 4 | Việc nền của khách dừng khi đóng tab | Research và PDF ở chế độ khách phải chạy lại được sau khi bị ngắt |
| 5 | SQLite WASM (OPFS), SSE và CSS anchor positioning trong WebView iOS | Kiểm chứng trước phase 6. Lần mở thử trên Safari iOS của spike UI phase 0 (theme, font, đổi theme lúc chạy, đổi ngôn ngữ) cũng hoãn tới đây (2026-11-17: chưa có máy hoặc simulator). Phương án lùi cho SQLite: plugin SQLite native của Capacitor. Astryx cần Safari 26+ để định vị popover, menu, tooltip; iOS 17–25 vẫn dùng được nhưng các lớp này có thể lệch vị trí. Chốt phiên bản iOS tối thiểu. Theo MDN (2026-11-17): theme cần `light-dark()` (Safari 17.5) và `@scope` (17.4), nên sàn thực tế là **iOS 17.5**; OPFS có từ 15.2; Popover API từ 17 |
| 6 | SSRF qua base URL do người dùng nhập | Endpoint tương thích OpenAI và SearXNG chỉ lấy từ danh sách admin khai báo |
| 7 | Mã do model sinh chạy trong app | Iframe sandbox không truy cập được cookie, token hay DB local |
| 8 | Điều khoản dịch vụ khi dùng gói thuê bao qua ACP | Dùng cá nhân trước. Ghi rõ trách nhiệm của người host trong tài liệu khi công bố |
| 9 | Thư viện còn mới (Effect v4, TanStack AI, Astryx beta, TanStack DB RC, TanStack Charts) | Đọc tài liệu hiện hành trước khi viết code từng phần. Nâng cấp Astryx bằng `astryx upgrade --from`, ghim cùng phiên bản cho mọi package `@astryxdesign/*` |
| 10 | Phạm vi lớn: 7 nhóm tính năng, 5 backend AI, 5 nguồn tìm kiếm | Làm theo thứ tự phase, mỗi phase có tiêu chí xong rõ ràng |
| 11 | Theme import hoặc tải từ marketplace là dữ liệu không tin cậy (chèn CSS, URL ngoài để theo dõi, chữ không đọc được) | Theme chỉ chứa giá trị token đã qua schema (màu, độ dài, tên font trong danh sách cho phép). Không cho CSS tự do hay URL ngoài. Kiểm độ tương phản trước khi áp dụng |
| 12 | Theme của Astryx / StyleX biên dịch lúc build, chưa chắc đổi được lúc chạy | **Đã kiểm chứng (2026-11-17): đổi được.** Đặt biến CSS inline trên phần tử nằm trong wrapper `[data-astryx-theme]` (đặt trên `:root` thì không ăn, vì theme đã build khai báo lại mọi token trên wrapper). Đã thử trên trình duyệt với Button, Card, Banner, Popover và component StyleX riêng, ở cả dev, SSR và SPA |
| 13 | Paraglide không nạp được plugin vẫn báo biên dịch thành công nhưng không sinh chuỗi nào | Test trong `packages/i18n` kiểm mọi key trong `messages/*.json` đều có hàm tương ứng |
| 14 | Ba chỗ chỉnh để `@astryxdesign/build` chạy với TanStack Start (xem [phase 0](archive/phase-0.md)) dựa vào chi tiết nội bộ, có thể vỡ khi nâng Astryx | Kiểm lại cả dev, SSR, SPA sau mỗi lần nâng Astryx |


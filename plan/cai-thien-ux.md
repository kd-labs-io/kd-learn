# Plan phần chính phase 7: cải thiện UI / UX

- **Ngày lập:** 2026-11-22
- **Phạm vi:** phase 7 ([mục 4](04-phases.md)): rà và sửa trải nghiệm trên mọi màn (web, cả điện thoại), và đặt quy tắc UX cùng vòng kiểm bằng ảnh chụp để các tính năng sau không lặp lại lỗi cũ. Ba việc ở [mục 6](06-viec-mo.md) vào phạm vi: header chung ba dòng ở màn hẹp, duyệt các luồng side chat cũ, công thức hiện mã TeX thô khi tải lại
- **Xong khi:** mọi phát hiện mức "cao" của bước 1 đã sửa; người dùng xem ảnh trước / sau (desktop và điện thoại, sáng và tối) và đồng ý; e2e xanh, gồm `phone.e2e.ts` và `figures.e2e.ts`; quy tắc UX và skill `ux-check` có trong repo
- **Nền đã có:** UI bằng Astryx (`apps/web/AGENTS.md`), theme từ `packages/tokens`, dark mode và theme dựng sẵn (phase 6). Header chung `AppHeader` (`apps/web/src/app/AppHeader.tsx`); trang chủ chia ba nhánh ở `routes/index.tsx`: `AccountHome` (`src/account/`), `GuestHome`, `Welcome` (`src/app/`). Màn học `LearnScreen.tsx` (`src/learn/`): `Layout` với header riêng, `start` = `PlanPanel` (300 px), `end` = `SideChat` (360 px), `content` = hội thoại (`maxWidth 68ch`), `footer` = `Status` + `Composer`. Astryx 0.7.16 có sẵn `Chat*` (`ChatMessage`, `ChatMessageBubble`, `ChatMessageList`, `ChatComposer`), `AppShell`, `SideNav`, `MobileNav`, `EmptyState`, `DropdownMenu`, `Avatar`, `CommandPalette`; template trang `ai-chat`, `ai-chat-landing`, `shell-side-nav`

## A. Phát hiện từ ảnh chụp của người dùng (2026-11-22)

Hai ảnh desktop khoảng 2000 px, tài khoản admin, light. Ô ở góc trái trên ảnh 1 là preview tab của trình duyệt, không phải app.

### A1. Trang chủ tài khoản (`AppHeader`, `AccountHome`)

| # | Vấn đề | Mức |
| --- | --- | --- |
| 1 | Header có bảy nút ghost cùng cỡ, cùng màu (Buổi học, Kiến thức, Nguồn, Cài đặt, Quản trị, Đăng xuất, VI / EN) cạnh email: không có nhóm, không biết đang ở trang nào, Đăng xuất nằm lẫn với điều hướng | cao |
| 2 | Nội dung dồn trái, nửa phải màn hình trống; không có trọng tâm: ô "Bạn muốn học gì?" và danh sách buổi học cùng cấp | cao |
| 3 | Nút "Bắt đầu học" nhạt như bị tắt khi ô trống, không có gợi ý vì sao | trung bình |
| 4 | Danh sách buổi học chỉ có tên và giờ: không biết buổi nào đang dở, đã xong, đang ở bước mấy; hai buổi trùng tên ("Học về Typescript", "Học về typescript") không phân biệt được; không xoá được | cao |
| 5 | Không có gợi ý chủ đề hay trạng thái trống có hướng dẫn cho người mới | thấp |

### A2. Màn học (`LearnScreen`, `PlanPanel`, `SideChat`)

| # | Vấn đề | Mức |
| --- | --- | --- |
| 6 | Ô trả lời (`footer`) nằm sát lề trái, dưới cột kế hoạch, không thẳng hàng với hội thoại ở giữa | cao |
| 7 | Hội thoại giới hạn 68ch nhưng dồn trái trong cột rộng: khoảng trống lớn giữa hội thoại và side chat | cao |
| 8 | Lời gia sư và lời người học gần như giống nhau: chỉ khác nhãn xám nhỏ và nền `muted` rất nhạt; khó lướt lại | cao |
| 9 | Cột kế hoạch 300 px gần như trống ở giai đoạn thăm dò ("Tìm hiểu bạn đã biết gì"); tiêu đề lớn cho nội dung một dòng | trung bình |
| 10 | Side chat chiếm 360 px thường trực dù ít dùng; chữ giải thích lặp hai lần; "Về bài học nói chung" trông như link, không rõ là chọn luồng | trung bình |
| 11 | Hai nút Gửi khác kiểu (màn chính accent nhạt, side chat xám) | thấp |
| 12 | Header màn học không có tiến độ (bước x / y, giai đoạn); nút về "Buổi học" nhỏ, khác hẳn header chung | trung bình |

Chưa xem: graph, luyện tập, hồ sơ, nguồn, cài đặt, admin, đăng nhập / đăng ký, màn hẹp, dark mode, trạng thái chờ / trống / lỗi. Không đoán: bước 1 chụp và ghi phát hiện.

## B. Quyết định

Chốt ngày 2026-11-22: người dùng bảo "tiến hành đề xuất", nên lấy cột "Đề xuất", trừ B3 (xem cột cuối). Ghi tóm tắt ở [mục 2.1](02-san-pham.md).

| # | Chủ đề | Đề xuất | Phương án khác / ghi chú khi làm |
| --- | --- | --- | --- |
| B1 | Điều hướng | Giữ thanh trên, chia nhóm: trái là brand + ba mục chính (Buổi học, Kiến thức, Nguồn) có trạng thái đang chọn; phải là menu tài khoản (`DropdownMenu`: email, Cài đặt, Quản trị, ngôn ngữ, Đăng xuất). Điện thoại dùng `MobileNav`. Sửa luôn header ba dòng | Ban đầu không chọn thanh bên trái; **đổi 2026-11-22 theo yêu cầu người dùng:** bỏ thanh trên, dùng thanh bên trái `SideNav` (`AppRail`: logo, các mục, kế hoạch của buổi học, menu tài khoản ở đáy; điện thoại là thanh trên một dòng + drawer). Trước đó: ngôn ngữ cũng vào menu tài khoản; trên điện thoại brand và menu một dòng, các mục một dòng (không cần `MobileNav`) |
| B2 | Side chat | Mặc định đóng; nút "Hỏi nhanh" ở header mở panel bên phải (màn rộng) hoặc drawer (điện thoại); nhớ lựa chọn trên máy | Luôn mở ở màn rộng như hiện nay. **Đổi 2026-11-22:** màn học ba cột; từ 1180 px cột phải luôn có, chọn giữa Hỏi nhanh và Nguồn (nhớ trên máy); hẹp hơn thì drawer mở từ nút cạnh tên buổi học |
| B3 | Danh sách buổi học | Mỗi dòng có trạng thái (đang học / xong), tiến độ bước, nút tiếp tục; thêm xoá buổi học (cần API xoá ở storage khách và server) | **Làm phần trạng thái, chưa làm xoá.** Log sự kiện là append-only có trigger cấm `DELETE` (khách và server), đồ thị kiến thức tham chiếu buổi học. Xoá cần quyết định riêng (xoá cứng bằng migration bỏ trigger, hay sự kiện "ẩn"): ghi ở mục 6 |
| B4 | Skill UX | Skill dự án `.claude/skills/ux-check/` (được track, `.gitignore` chỉ bỏ các skill do pnpm tạo) ghi quy tắc của repo và vòng chụp ảnh. Không cài skill bên ngoài: các skill tìm thấy (`npx skills find`, 2026-11-22: `frontend-design-audit`, `ui-craft`, `ui-ux-pro-max`, ...) ít người dùng, chưa kiểm, và hay giả định Tailwind / CSS tay, trái quy tắc Astryx | Cài một skill audit bên ngoài, đọc kỹ trước khi dùng |

## C. Quy tắc giữ suốt phase

- Trang có sẵn giữ nguyên, thêm block / component Astryx bên trong; chỉ mượn cách bố cục của template `ai-chat`, không scaffold lại (`apps/web/AGENTS.md`).
- Giữ mọi `data-testid` đang có; đổi thì sửa e2e cùng PR.
- Chữ mới thêm cả vi và en ở `packages/i18n/messages/`.
- Mỗi bước sửa giao diện chạy `scripts/ux-shots` trước và sau, mở ảnh xem rồi mới giao; ảnh trước / sau đính vào PR.

## D. Các bước

| Bước | Việc |
| --- | --- |
| 0 | **Spike component Astryx.** Đọc props (`astryx component <Name>`) của `ChatMessage`, `ChatMessageBubble`, `ChatMessageList`, `ChatComposer`, `AppShell`, `MobileNav`, `DropdownMenu`, `EmptyState`. Kiểm bubble chứa được Markdown, KaTeX, khối code, sơ đồ, khung demo (iframe) và nút trích nguồn; `ChatComposer` có trạng thái đang chạy, Enter / Shift+Enter, trên điện thoại bàn phím ảo không che. Kết luận ghi vào đây (D0); không đạt thì giữ `Card` / `Textarea` hiện tại và chỉ chỉnh kiểu |
| 1 | **Chụp và rà toàn bộ.** Script Playwright `scripts/ux-shots` (dùng lại fake server của e2e): mọi route × desktop 1440 px và điện thoại 393 px × sáng / tối × trạng thái (chờ, trống, lỗi, có dữ liệu), ảnh ra thư mục bị gitignore. Rà theo danh sách ở bước 2, ghi bảng phát hiện (màn, vấn đề, mức) vào `progress/phase-7.md`; người dùng duyệt mức ưu tiên |
| 2 | **Quy tắc UX cho về sau.** Mục "UX" trong `DESIGN.md` (một hành động chính mỗi màn, căn cột nội dung và ô nhập, phân biệt vai trong hội thoại, mọi danh sách có trạng thái trống / chờ / lỗi, nút tắt phải nói lý do, vùng chạm tối thiểu, trạng thái đang chọn của điều hướng). Thêm vào "Project overrides" của `apps/web/AGENTS.md`. Skill `.claude/skills/ux-check/SKILL.md`: danh sách kiểm, chạy `scripts/ux-shots`, mở ảnh trước khi báo xong |
| 3 | **Khung app và điều hướng** (A1 #1, B1): header chung mới, menu tài khoản, `MobileNav`; header màn học dùng chung khung, có tiến độ (A2 #12) |
| 4 | **Trang chủ** (A1 #2–5, B3): `AccountHome` và `GuestHome` dùng chung một khung: ô bắt đầu học là trọng tâm, gợi ý chủ đề, danh sách buổi học có trạng thái và tiến độ, `EmptyState` khi chưa có buổi nào |
| 5 | **Màn học** (A2 #6–9, #11): hội thoại và ô trả lời cùng một cột giữa; tin nhắn phân vai rõ (theo D0); kế hoạch gọn khi chưa có bước; trạng thái gia sư đang viết, lỗi, xong buổi rõ ràng |
| 6 | **Side chat** (A2 #10, B2, mục 6): mở / đóng theo B2, chọn luồng bằng control rõ ràng, duyệt các luồng cũ sau khi buổi học `done` |
| 7 | **Các màn còn lại** theo bảng của bước 1, từ mức cao xuống: graph, luyện tập, hồ sơ, nguồn, cài đặt, admin, đăng nhập / đăng ký |
| 8 | **Trạng thái và tiếp cận:** chờ / trống / lỗi thống nhất ở mọi màn; nạp trước KaTeX khi buổi học có công thức (mục 6); bàn phím, focus, `aria-live` cho chữ đang stream, tương phản |
| 9 | **Người dùng duyệt:** ảnh trước / sau của mọi màn đã sửa, và mở trên điện thoại thật qua `scripts/phone-check.sh` |

### D0. Kết quả spike component (2026-11-22)

- `Layout contentWidth` canh giữa header, nội dung, footer theo một khung: dùng cho mọi trang (`pageWidth` 1120) và lồng một `Layout contentWidth="72ch"` trong màn học để hội thoại và ô trả lời cùng cột.
- `ChatMessage` / `ChatMessageBubble` dùng cho lời người học (bong bóng bên phải). Lời gia sư giữ `LessonFigure` toàn cột (sơ đồ, demo, trích nguồn), nhãn màu accent.
- `ChatComposer` không dùng: không nhận `data-testid` cho ô nhập, và khó giữ trạng thái chờ / lỗi hiện có. Giữ `TextArea` + nút, thêm Enter để gửi (chuột / bàn phím) qua `ref`.
- `DropdownMenu` (`renderTrigger` để giữ `data-testid="who"`), `EmptyState`, `Selector` (chọn luồng side chat) dùng được.

Thứ tự cắt nếu phạm vi lớn: bước 7 chỉ làm mức cao, rồi bỏ phần tiếp cận của bước 8. Không cắt bước 1, 2, 9.

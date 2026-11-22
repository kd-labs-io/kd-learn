# Plan phần chính phase 6: theme, dark mode, web trên điện thoại

- **Ngày lập:** 2026-11-22
- **Phạm vi:** phase 6 ([mục 4](04-phases.md)): dark mode, chọn theme có sẵn, kiểm bản web trên trình duyệt điện thoại (Safari iOS, Chrome Android; hoãn từ phase 0). Vỏ Capacitor và màn hình nhập URL server chuyển sang phase 7
- **Xong khi:** đăng nhập và học 1 buổi trên trình duyệt điện thoại; đổi theme và dark mode không vỡ sơ đồ, demo, graph
- **Nền đã có:** theme là dữ liệu thuần có schema (`packages/tokens/src/schema.ts`, v1, một bộ màu), `toAstryxVars` là ánh xạ duy nhất sang biến Astryx, theme tĩnh build từ `default-theme.json` (`kdTheme.ts`, chỉ light). `ThemeRoot` (`apps/web/src/theme/ThemeRoot.tsx`) đặt `mode="light"` cố định, theme chạy lúc chạy là biến inline trên phần tử trong wrapper `[data-astryx-theme]` ([rủi ro 12](05-rui-ro.md)); `__root.tsx` đặt `data-theme="light"` trên `<html>`. Hình lấy màu bằng `figureVars(theme)` (hex thuần, vào blob SVG, Mermaid và khung demo); graph đọc token lúc vẽ (`GraphFigure.tsx`). `checkContrast` kiểm AA cho cặp chữ / nền. Token của tài khoản nằm ở `localStorage` nên bản SSR không thấy; locale đi qua cookie. Không có màu viết cứng trong `ui` và `web` (grep 2026-11-22). Migration hiện tại: khách v5, server v10

Ba quyết định sản phẩm chốt ngày 2026-11-22:

1. **Phạm vi theme:** dark mode (sáng / tối / theo hệ thống) và chọn trong vài theme dựng sẵn. Theme tuỳ biến, import / export, marketplace vẫn để sau ([mục 4](04-phases.md)).
2. **Lưu lựa chọn:** khách lưu trên máy; tài khoản lưu trên server và đi theo người dùng qua các máy.
3. **Điện thoại:** phase 6 kiểm bản web trên trình duyệt điện thoại; phase 7 chỉ lo vỏ Capacitor. Lần kiểm trên điện thoại thật do người dùng tự làm ở bước cuối (máy này chưa có simulator iOS hay AVD Android); các bước trước kiểm bằng giả lập thiết bị của Playwright.

## A. Quyết định nền

### A1. Theme có hai bộ màu

- **Schema theme v2:** `colors` thành `{light: ColorTokens, dark: ColorTokens}`; font, cỡ chữ, bo góc, bóng dùng chung cho hai chế độ. Mọi theme đều có đủ hai bộ, nên dark mode không có trường hợp "theme này chỉ có light".
- **Bỏ v1, không chuyển đổi:** chưa có theme nào được lưu (theme lúc chạy chỉ ở bộ nhớ, chưa có import). `decodeTheme` từ chối v1 như mọi giá trị ngoài schema.
- **Tên token không đổi** (`DESIGN.md`): theme chỉ đổi giá trị, không thêm hay đổi tên token.
- **`toAstryxVars(theme)`** trả `light-dark(<light>, <dark>)` cho mọi màu (Astryx đổi tuple `[light, dark]` thành đúng dạng này, [rủi ro 5](05-rui-ro.md): cần Safari 17.5). Màu dẫn xuất cũng tách theo chế độ:
  - Nền nhạt của màu trạng thái: `light-dark(color-mix(<màu light> 12%, <bg light>), color-mix(<màu dark> 12%, <bg dark>))`.
  - Bóng: light lấy màu `text` như hiện nay; dark dùng đen với độ mờ gấp đôi (màu `text` của dark sáng, thành quầng sáng). Schema bóng không đổi.
- **`checkContrast(theme)`** kiểm cả hai bộ màu; mỗi theme dựng sẵn có test: không có cặp nào dưới AA ở cả hai chế độ.
- **`figureVars(theme, mode)`** nhận chế độ đã quyết (`light | dark`) và vẫn trả hex thuần (blob SVG, Mermaid, khung demo không thấy biến của app).

### A2. Theme dựng sẵn

- Ba theme, mỗi theme là một file JSON trong `packages/tokens/src/themes/`, decode bằng schema lúc nạp module (như `default-theme.json` hiện nay):
  - `kd`: mặc định, light theo `DESIGN.md`, dark mới (nền ấm tối, cùng tông terracotta). Bảng dark ghi vào mục "Dark mode" của `DESIGN.md`.
  - `kd-contrast`: tương phản cao (mục tiêu AAA 7:1 cho chữ chính), cho người cần đọc rõ.
  - `ocean`: tông lạnh (xanh), để chứng minh đổi theme đổi cả accent mà không vỡ gì.
- **Theme tĩnh của Astryx** (`kdTheme.ts`) vẫn build từ `kd`, giờ mỗi màu là `light-dark()`. Theme khác không còn là biến inline trên một phần tử (spike C1: biến inline không tới được popover, toast, vì portal nằm ngoài wrapper). Thay vào đó, `<head>` có sẵn CSS của mọi theme dựng sẵn (`builtInThemeCss`, trong layer `product`), mỗi theme gắn với `:root[data-kd-theme="<id>"]` và `[data-astryx-theme]` bên trong. Đổi theme chỉ là đổi thuộc tính `data-kd-theme` trên `<html>`. CSS này giống hệt ở SSR, SPA và client nên không lệch hydrate. Giá trị đã qua schema (hex, độ dài, font trong danh sách) nên dựng CSS từ chúng an toàn ([rủi ro 11](05-rui-ro.md)).
- Tên hiện cho người dùng nằm ở i18n (`packages/i18n/messages/`), không ở JSON của theme.

### A3. Chế độ và lựa chọn của người dùng

- **`Appearance {mode: 'system' | 'light' | 'dark', theme: <id theme dựng sẵn>}`**, mặc định `{system, kd}`. Schema ở `@kd-learn/api` (dùng chung client và server). Theme id lạ (theme bị gỡ ở bản sau) thì lùi về `kd`.
- **`mode: 'system'`** để CSS tự theo hệ điều hành (`light-dark()` với `color-scheme: light dark`, Astryx bỏ `data-theme` trên `<html>`), không cần JS để tô đúng màu.
- **JS vẫn cần biết chế độ đã quyết** cho hình: hook `useResolvedMode()` đọc `matchMedia('(prefers-color-scheme: dark)')` và nghe đổi. Đổi chế độ (hay hệ điều hành đổi) thì dựng lại blob SVG, render lại Mermaid, gửi `theme` vào khung demo đang chạy, vẽ lại graph.
- **Không loé sai màu lúc tải trang:**
  - Cookie `kd_appearance` (`<mode>.<theme>`, ví dụ `system.kd`; `SameSite=Lax`, một năm, không `HttpOnly` vì client ghi). Đây chỉ là sở thích hiển thị, không phải dữ liệu nhạy cảm. Chỉ có cookie, không có bản sao ở `localStorage` (một nguồn duy nhất cho SSR, script và client). Cookie hỏng hay theme lạ thì về mặc định.
  - Bản SSR đọc cookie trong request (`getCookie` của Start qua `createIsomorphicFn`): đặt `data-theme` (khi chế độ không phải `system`) và `data-kd-theme` trên `<html>` ngay trong HTML.
  - Bản SPA (shell prerender với giá trị mặc định, màn hình chỉ render sau khi mount): một script nhỏ trong `<head>` đọc cookie và đặt `data-theme`, `data-kd-theme` trước lần vẽ đầu (đã kiểm ở ba trình duyệt khi chặn hết JS của app: màu nền đúng theme tối đã chọn). App chưa có CSP cho script (chỉ `frame-src`), nên script nội tuyến chạy được.
- **Đồng bộ tài khoản:**
  - Server: bảng `user_appearance (user_id, mode, theme, updated_at)`, migration server v11. `GET` và `PUT /api/account/appearance` trả `{appearance: Appearance | null}` (`null` khi tài khoản chưa lưu gì); `/api/account/settings` không đổi. Khách không đổi migration (lưu ở cookie).
  - Đổi trong UI: ghi cookie ngay, rồi gửi lên server nếu đang đăng nhập (lỗi thì bỏ qua, máy giữ lựa chọn của mình).
  - Mở app khi đã đăng nhập: giá trị của server thắng nếu có (ghi đè cookie, không loé lần sau); server chưa có thì đẩy giá trị của máy lên. Đăng xuất giữ giá trị của máy.
  - Test hai người dùng: mỗi người đọc và ghi đúng `appearance` của mình.

### A4. Hình, demo, graph theo theme

- `LessonFigure` nhận `figureVars(theme, resolvedMode)`. Bộ đệm blob theo cặp `(figureId, theme, mode)`.
- Khung demo: `frame-doc.ts` đặt `color-scheme` theo chế độ đã quyết (hiện cố định `normal`), để control gốc của trình duyệt trong demo (nút, ô nhập, thanh cuộn) cùng tông.
- Mermaid: `themeVariables` từ `figureVars` (đã có), render lại khi đổi chế độ.
- Graph (sigma): đã đọc token lúc vẽ; thêm vẽ lại khi theme hoặc chế độ đổi.
- KaTeX dùng `currentColor`. Khối code dùng theme cú pháp của Astryx: kiểm ở spike C1 xem có bản dark không.

### A5. Giao diện

- Trong cài đặt (cả khách và tài khoản), mục "Giao diện": chọn chế độ (Sáng / Tối / Theo hệ thống) và theme (thẻ có mẫu màu của cả hai chế độ). Áp dụng ngay, không cần nút lưu.
- Chuỗi vi / en trong `packages/i18n/messages/`.

### A6. Web trên điện thoại

- **Kiểm tự động** (Playwright, giả lập thiết bị: WebKit với iPhone, Chromium với Pixel): mọi màn chính (chào, đăng nhập, cài đặt, học, side chat, luyện tập, graph, nguồn, admin) không cuộn ngang ở 375 px; vùng bấm tối thiểu 44 px cho nút chính; ô trả lời và `Drawer` side chat dùng được. Lỗi tìm thấy sửa trong phase này.
- **Giới hạn đã biết của giả lập:** WebKit của Playwright không có OPFS (context tạm) và không có bàn phím ảo; phần này chỉ kiểm được trên máy thật ([rủi ro 5](05-rui-ro.md)).
- **Kiểm trên máy thật do người dùng làm** (bước 7). Cần ngữ cảnh an toàn (HTTPS): qua LAN bằng `http://<ip>` thì không có OPFS, `crypto.subtle` (rủi ro 49). Bước 6 chuẩn bị bản build, một đường HTTPS (Cloudflare quick tunnel hoặc `tailscale serve`, cả hai đã có trên máy) và danh sách kiểm.
- **Lỗi React #418** (lệch text giữa SSR và client, [mục 6](06-viec-mo.md)) nằm đúng đường hydrate mà A3 sửa: điều tra và sửa trong phase này.
- **`practice.e2e.ts` khách lỗi trên WebKit** (từ phase 4): điều tra trong phase này vì Safari là đích; nếu nguyên nhân chỉ có ở WebKit của Playwright (không có OPFS), ghi lại và để mở.

## B. Các bước

| # | Việc | Package | Xong khi |
| --- | --- | --- | --- |
| 0 | Spike dark mode Astryx (C1) | spike | Trả lời đủ C1; chốt cách áp theme lúc chạy ở hai chế độ, cách tránh loé ở SSR và SPA, theme cú pháp cho khối code |
| 1 | Theme v2 trong `tokens`: hai bộ màu, `toAstryxVars` với `light-dark()`, nền nhạt và bóng theo chế độ, `checkContrast` hai chế độ, `figureVars(theme, mode)`, ba theme dựng sẵn, bảng dark trong `DESIGN.md` (A1, A2) | tokens | Test: ba theme decode được, không cặp nào dưới AA ở cả hai chế độ (`kd-contrast` đạt 7:1 cho chữ chính), v1 bị từ chối, biến dark khác light |
| 2 | `Appearance` trong `api`, bảng `user_appearance` (server v11), `GET` / `PUT` của tài khoản (A3) | api, storage, server | Test route: đọc / ghi đúng, giá trị sai bị từ chối, hai người dùng không thấy của nhau; migration chạy trên DB v10 có sẵn dữ liệu |
| 3 | `ThemeRoot` theo chế độ và theme, cookie, SSR, script trước lần vẽ đầu của SPA, `useResolvedMode`, đồng bộ tài khoản, mục "Giao diện" trong cài đặt, i18n (A3, A5) | web, i18n | Playwright: chọn tối / theme khác áp ngay và còn sau tải lại ở cả bản SSR và SPA, không loé (màu nền của lần vẽ đầu đúng); `system` theo `prefers-color-scheme` giả lập; tài khoản: chọn ở context A, context B (đăng nhập cùng tài khoản) thấy cùng lựa chọn |
| 4 | Hình, demo, graph theo chế độ đã quyết (A4) | ui, web | Test trình duyệt hiện có (`figures.e2e.ts`: SVG, Mermaid có nét vẽ thật, demo chạy) chạy lại ở dark và ở từng theme; đổi chế độ giữa buổi thì màu hình đổi; graph vẽ lại |
| 5 | Web trên điện thoại: kiểm giả lập và sửa, lỗi React #418, `practice.e2e.ts` trên WebKit (A6) | web, ui | Playwright với iPhone (WebKit) và Pixel (Chromium): không cuộn ngang ở mọi màn chính, học một buổi với model giả; không còn #418 trên bản build (hoặc ghi rõ nguyên nhân còn lại); kết luận về `practice.e2e.ts` WebKit |
| 6 | Chuẩn bị kiểm trên máy thật: bản build, đường HTTPS, danh sách kiểm; một buổi Haiku thật ở dark mode trên desktop (A6) | — | Bản build chạy qua HTTPS từ ngoài máy; danh sách kiểm trong `progress/phase-6.md`; buổi Haiku có sơ đồ hiện đúng ở dark (script thử trước với model giả, chỉ gọi model thật một lần) |
| 7 | Người dùng kiểm trên điện thoại thật | — | Người dùng báo kết quả theo danh sách kiểm: đăng nhập và học một buổi trên Safari iOS và Chrome Android, đổi theme và dark mode không vỡ sơ đồ, demo, graph. Đóng phase 6 theo quy ước ở `README.md` |

Mỗi bước một PR (bước lớn có thể tách), `turbo typecheck lint test` và e2e xanh trước khi merge.

## C. Câu hỏi cho spike

### C1. Dark mode của Astryx

**Kết quả (2026-11-22, bản build SSR, Playwright 1.65 trên Chromium, Firefox, WebKit):**

1. Theme tĩnh với mọi màu là `light-dark()`: đúng màu ở `light`, `dark` và `system` (theo `prefers-color-scheme` giả lập) ở cả ba; Astryx đặt `data-theme` trên `<html>` (bỏ thuộc tính khi `system`, `color-scheme: light dark`). Phần tử gắn thẳng vào `<body>` (như portal) cũng theo, vì `data-astryx-theme` có trên `<html>`.
2. Biến inline trên wrapper chỉ tới phần tử bên trong; phần tử ở `<body>` vẫn lấy màu của theme tĩnh. Chốt: theme lúc chạy là thẻ `<style>` trong layer `product` (A2).
3. Bản SSR luôn gửi `data-theme="light"` (viết cứng), `Theme` của Astryx đổi sau khi mount: loé ở dark. Đổi thuộc tính này không gây lỗi hydrate. Cookie ở A3 giữ nguyên.
4. Làm ở bước 3 (script trước lần vẽ đầu của SPA).
5. Màu cú pháp mặc định của Astryx (`--color-syntax-*`) trỏ vào token ngữ nghĩa (`var(--color-text-accent)`, ...), nên khối code tự theo chế độ; không cần theme cú pháp riêng.
6. `light-dark()` trong `color-mix()` và trong màu của `box-shadow` chạy ở cả ba.
7. Lỗi React #418 thấy trên Chromium ở mọi lần tải `/login`, không thấy trên Firefox và WebKit (bước 5).

1. Theme tĩnh build với tuple `[light, dark]`: component Astryx đổi màu đúng khi `mode` là `light`, `dark`, `system`? Popover, toast (portal ngoài wrapper) có theo không?
2. Theme lúc chạy (biến inline `light-dark(...)` trên phần tử trong wrapper) có thắng biến của theme tĩnh ở cả hai chế độ không (như [rủi ro 12](05-rui-ro.md) ở light)?
3. Bản SSR: đặt `data-theme` trên `<html>` từ cookie và để `Theme` của Astryx đồng bộ lại có gây lệch hydrate (#418) không? `system` thì thuộc tính bị gỡ, có loé không?
4. Bản SPA: script trong `<head>` đặt `data-theme` trước lần vẽ đầu, `Theme` sau khi mount có ghi đè sai không?
5. Khối code: theme cú pháp của Astryx có bản dark không, đổi theo chế độ thế nào?
6. `light-dark()` trong `color-mix()` và trong biến lồng nhau chạy được ở Chromium, Firefox, WebKit?

## D. Ngoài phạm vi phase 6

- Vỏ Capacitor, màn hình nhập URL server, WebView iOS / Android, plugin SQLite native làm phương án lùi: phase 7.
- Theme tuỳ biến, import / export, marketplace theme: sau phase 7.
- Theme theo từng buổi học hay từng thiết bị khi đã đăng nhập (đồng bộ là một giá trị cho cả tài khoản).
- Chế độ tương phản cao tự động theo `prefers-contrast` (người dùng chọn `kd-contrast` bằng tay).

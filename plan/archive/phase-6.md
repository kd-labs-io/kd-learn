# 8. Tiến độ phase 6

**Trạng thái: xong (2026-11-22).** Plan phần chính: [theme-va-dien-thoai.md](theme-va-dien-thoai.md).

## Phase 6 (cập nhật 2026-11-22)

| Hạng mục | Trạng thái |
| --- | --- |
| Plan phần chính | Xong (2026-11-22). Chốt: dark mode và chọn theme dựng sẵn (tuỳ biến, import / export, marketplace để sau); khách lưu lựa chọn trên máy, tài khoản đồng bộ qua server; kiểm web trên điện thoại ở phase 6, bước cuối người dùng kiểm máy thật; vỏ Capacitor sang phase 7 |
| Bước 0: spike dark mode Astryx (C1) | Xong (2026-11-22). `light-dark()` chạy ở ba trình duyệt, cả trong `color-mix()` và bóng; theme lúc chạy chuyển từ biến inline sang thẻ `<style>` (biến inline không tới portal); màu cú pháp tự theo. Kết quả ở [C1](theme-va-dien-thoai.md) |
| Bước 1: theme v2 trong `tokens` | Xong (2026-11-22). Schema v2 `colors {light, dark}`, `toAstryxVars` ra `light-dark()`, `checkContrast` hai chế độ, `figureVars(theme, mode)`, theme `kd`, `kd-contrast`, `ocean` (`packages/tokens/src/themes/`), bảng dark trong `DESIGN.md`. Màn hình vẫn chỉ light tới bước 3 |
| Bước 2: `Appearance`, server v11, route | Xong (2026-11-22). `Appearance {mode, theme}` trong `@kd-learn/api`, bảng `user_appearance` (server v11), `GET` / `PUT /api/account/appearance`, client `appearance()` / `saveAppearance()`; test hai người dùng, giá trị sai trả 400, nâng cấp DB v10 |
| Bước 3: `ThemeRoot`, cookie, SSR / SPA, cài đặt | Xong (2026-11-22). Cookie `kd_appearance` đọc ở SSR và script trước lần vẽ đầu của SPA; CSS của theme dựng sẵn có sẵn trong `<head>`, gắn với `data-kd-theme`; `useThemeControl()` trả `appearance`, `theme`, `resolvedMode`; đồng bộ tài khoản; mục "Giao diện" trong cài đặt khách và tài khoản. `appearance.e2e.ts` qua trên ba trình duyệt; SPA kiểm bằng script tạm (chặn JS của app, màu nền đã đúng) |
| Bước 4: hình, demo, graph theo chế độ | Xong (2026-11-22). Màn học và trang thử hình dùng `figureVarsOf(theme, resolvedMode)`; khung demo đặt `color-scheme` theo độ sáng của `--kd-bg` (cả khi đổi giữa chừng); graph tô lại node, cạnh, nhãn khi đổi theme hay chế độ (nhãn trước đây luôn đen); thuộc tính trên `<html>` đặt trước khi React vẽ lại, để effect đọc đúng màu. `figures.e2e.ts` chạy ở bốn kiểu (light kd, dark kd, dark ocean, light kd-contrast) cộng một test đổi sang tối giữa buổi: 87 qua trên ba trình duyệt. Graph tối kiểm bằng ảnh chụp |
| Bước 5: web trên điện thoại (giả lập), #418, WebKit practice | Xong (2026-11-22). `phone.e2e.ts` trên project `iphone` (WebKit, iPhone 15) và `pixel` (Chromium, Pixel 7; chạy cả trong CI): mọi màn chính không cuộn ngang và không có nút bị cắt ở mép phải, nút chính đủ lớn cho ngón tay, đăng ký và học một buổi tới cuối ở dark mode, side chat mở và đóng, admin. Sửa header của màn học bị cắt trên điện thoại (nút side chat, cài đặt). Sửa #418, bỏ qua `practice.e2e.ts` khách trên WebKit. Xem ghi chú bước 5 |
| Bước 6: chuẩn bị kiểm máy thật, Haiku ở dark mode | Xong (2026-11-22), trừ một ý: Haiku thật không vẽ sơ đồ trong lượt đã chạy. `scripts/phone-check.sh` (bản build, DB tạm, Cloudflare quick tunnel) chạy qua HTTPS từ ngoài máy; danh sách kiểm ở dưới. Buổi Haiku ở dark mode hiện đúng. Xem ghi chú bước 6 |
| Bước 7: người dùng kiểm trên điện thoại thật | Xong (2026-11-22). Người dùng mở bản build qua `scripts/phone-check.sh` (Cloudflare quick tunnel) trên điện thoại của mình và báo "trên điện thoại ok". Kết quả báo chung, không theo từng mục của danh sách dưới; không ghi loại máy |

## Điều cần biết khi bắt đầu (từ phase 5)

- **Theme:** schema ở `packages/tokens/src/schema.ts`, ánh xạ duy nhất sang biến Astryx `toAstryxVars` (`astryx-vars.ts`), theme tĩnh `kdTheme.ts` build bằng `astryx theme build` (`dist/kd.css`); theme lúc chạy là biến inline trong `ThemeRoot` (`apps/web/src/theme/ThemeRoot.tsx`). `mode="light"` cố định ở `ThemeRoot` và `data-theme="light"` ở `__root.tsx`.
- **Màu của hình:** `figureVars` (`packages/tokens/src/figure-vars.ts`), `figureVarsOf` (`apps/web/src/learn/figures.ts`), khung demo `packages/ui/components/figure/frame-doc.ts` (`color-scheme: normal`), graph `apps/web/src/graph/GraphFigure.tsx` (`resolveColor` lúc vẽ).
- **e2e hình:** `apps/web/e2e/figures.e2e.ts` kiểm Mermaid có nét vẽ thật (`naturalWidth > 150`, hơn 500 điểm ảnh có mực); chạy lại ở dark và từng theme.
- **Migration hiện tại:** khách v5 (`packages/storage/src/sqlite/schema.ts`), server v10 (`packages/storage/src/sqlite-node/schema.ts`). Không sửa migration đã phát hành.
- **Model thật:** thử script với model giả trước; chỉ gọi Haiku một lần mỗi bước (bước 10 phase 5 vượt quy tắc này vì lỗi script chờ).
- **Còn mở từ phase 5:** React #418 trên mọi trang (có từ trước phase 5), `practice.e2e.ts` khách lỗi trên WebKit, adapter ảnh tương thích OpenAI chưa gọi thật.

## Bước 5: web trên điện thoại, React #418 (2026-11-22)

- **React #418:** chỉ có trên Chromium, ở cả bản trước phase 6. Nguyên nhân: Chromium headless không gửi `Accept-Language`, server render bằng locale gốc (`vi`), client chọn theo `navigator.language` (`en`), chữ lệch khi hydrate. Lần đầu `getLocale()` trên client ghi cookie, nên chỉ lần tải đầu bị. Trình duyệt thật gửi `Accept-Language` nên hiếm gặp, nhưng vẫn có khi hai giá trị khác nhau. Sửa: strategy `custom-ssr` của Paraglide (`packages/i18n/src/index.ts`) cho client lấy locale server đã render (`data-ssr-locale` trên `<html>`, chỉ bản SSR) trước ngôn ngữ của trình duyệt. `hydration.e2e.ts` kiểm không có `pageerror` khi không có `Accept-Language` và khi nó khác ngôn ngữ trình duyệt, ở ba trình duyệt. Lần kiểm ở bước 10 phase 5 nghe `pageerror`; lần đầu ở bước 5 này nghe `console.error` nên tưởng lỗi đã hết.
- **`practice.e2e.ts` khách trên WebKit:** không phải lỗi app. WebKit của Playwright không có OPFS nên DB khách lùi về bộ nhớ, đồ thị nạp qua `/dev/storage` mất khi chuyển trang. Bỏ qua trên WebKit như `graph.e2e.ts`, `profile.e2e.ts`. Safari thật có OPFS: kiểm ở bước 7.
- **Giả lập điện thoại:** phép kiểm "vừa chiều ngang" ban đầu chỉ xem `scrollWidth`, bỏ sót header của màn học bị cắt (phần tràn bị ẩn, không cuộn). Thêm kiểm nút, ô nhập có cạnh phải vượt màn hình; tìm ra nút side chat và cài đặt bị cắt, sửa bằng cho header xuống dòng. Header chung (`AppHeader`) xuống ba dòng ở 393 px: dùng được, chiếm khoảng một phần tư màn hình; để người dùng đánh giá ở bước 7.
- **Chưa kiểm được bằng giả lập:** bàn phím ảo che ô trả lời, OPFS trên Safari, bfcache, cảm giác chạm: bước 7.

## Bước 6: chuẩn bị kiểm trên máy thật (2026-11-22)

- **Đường HTTPS:** `scripts/phone-check.sh` chạy bản build (`apps/web/.output`) trên DB tạm (xoá khi dừng), đăng ký mở, `KD_LEARN_TRUST_PROXY=1`, đọc `.env` nếu có (không in ra), rồi mở Cloudflare quick tunnel và in URL `https://*.trycloudflare.com`. URL công khai trong lúc script chạy; Ctrl-C tắt cả hai. Đã kiểm từ ngoài máy: `GET /api/config` 200 qua tunnel; Chromium giả lập Pixel mở trang: `isSecureContext`, OPFS và `crypto.subtle` đều có, không `pageerror`. Chưa dùng `tailscale serve` (cần đăng nhập tailnet trên điện thoại); quick tunnel không cần gì trên điện thoại.
- **Haiku ở dark mode** (một lần chạy thật, khách, Chromium desktop, cookie `dark.kd`, `claude-haiku-5-5`, 4 lượt): script thử trước với model giả (sơ đồ hiện, còn sau tải lại). Buổi thật: Prober, kế hoạch 5 bước, Teacher dạy bước 1; chữ, Markdown, khối code, plan, side chat đều đúng màu tối, không `pageerror`. Khi xin "a diagram of how the search range halves", Haiku trả lời rằng hình chia đôi thuộc bước sau ("Halving the search range") và giải thích bằng chữ, không gọi `show_diagram`. Đúng với lời dạy theo bước, nhưng nên tiêu chí "có sơ đồ hiện đúng ở dark" chưa đạt với model thật. Không gọi thêm (giới hạn một lần). Hình ở dark đã phủ bằng `figures.e2e.ts` (SVG, Mermaid, demo ở 4 cách hiển thị, ba trình duyệt) và lần chạy giả; hình của Haiku ở dark kiểm lại ở bước 7 (xin hình ở bước có chia đôi).

## Bước 7: danh sách kiểm trên điện thoại thật

Chạy `pnpm --filter @kd-learn/web build && scripts/phone-check.sh` trên máy này, mở URL in ra trên điện thoại (iPhone Safari, Android Chrome nếu có). Ghi kết quả từng dòng (được / lỗi + mô tả, ảnh chụp nếu có).

| # | Kiểm | iPhone (Safari) | Android (Chrome) |
| --- | --- | --- | --- |
| 1 | Trang chủ, đăng nhập, đăng ký: không cuộn ngang, chữ đọc được, không phải phóng to | | |
| 2 | Header chung (xuống ba dòng ở màn hẹp): chấp nhận được không | | |
| 3 | Khách: đặt model (cài đặt), bắt đầu buổi, trả lời vài lượt | | |
| 4 | Bàn phím ảo: ô trả lời và nút Gửi không bị che khi gõ; trang không nhảy lung tung | | |
| 5 | Side chat: mở, hỏi một câu, đóng | | |
| 6 | Kế hoạch (thu gọn trên điện thoại): mở được, đọc được | | |
| 7 | Xin sơ đồ ở bước phù hợp: hình hiện, "Phóng to" dùng được; demo chạy được | | |
| 8 | Khách: đóng hẳn tab / app trình duyệt, mở lại: buổi học còn (OPFS) | | |
| 9 | Chuyển sang app khác rồi quay lại giữa lượt: lượt chạy tiếp hoặc báo rõ (bfcache) | | |
| 10 | Giao diện: Tối, Sáng, Theo hệ thống (đổi chế độ tối của máy), theme Ocean và High contrast; không loé màu khi tải lại | | |
| 11 | Tài khoản: đăng ký, kết nối model, học một buổi; chọn theme trên điện thoại thì máy tính (cùng tài khoản) thấy sau khi tải lại | | |
| 12 | Đồ thị kiến thức, luyện tập: dùng được bằng tay (chạm, kéo, phóng to) | | |
| 13 | Nút bấm đủ lớn, không bấm nhầm | | |

## Đóng phase 6 (2026-11-22)

| Tiêu chí | Bằng chứng |
| --- | --- |
| Đăng nhập và học 1 buổi trên trình duyệt điện thoại | Người dùng kiểm trên điện thoại thật, báo ổn (bước 7); giả lập iPhone (WebKit) và Pixel (Chromium) trong `phone.e2e.ts`, Pixel chạy trong CI |
| Đổi theme và dark mode không vỡ sơ đồ, demo, graph | `figures.e2e.ts` ở 4 cách hiển thị và đổi giữa buổi, ba trình duyệt; graph vẽ lại; buổi Haiku thật ở dark (không có hình trong lượt đó) |
| Không loé màu, lựa chọn đồng bộ tài khoản | `appearance.e2e.ts` (SSR và SPA, hai context cùng tài khoản) |

Còn mở (mục 6): hình do Haiku vẽ ở dark mode chưa thấy với model thật; header chung ba dòng ở 393 px. Bước 7 không ghi kết quả từng mục, nên các mục khó thấy (bfcache, OPFS sau khi đóng hẳn trình duyệt) chưa chắc đã được thử riêng.


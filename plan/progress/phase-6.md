# 8. Tiến độ phase 6

Plan phần chính: [theme-va-dien-thoai.md](../theme-va-dien-thoai.md).

## Phase 6 (cập nhật 2026-11-22)

| Hạng mục | Trạng thái |
| --- | --- |
| Plan phần chính | Xong (2026-11-22). Chốt: dark mode và chọn theme dựng sẵn (tuỳ biến, import / export, marketplace để sau); khách lưu lựa chọn trên máy, tài khoản đồng bộ qua server; kiểm web trên điện thoại ở phase 6, bước cuối người dùng kiểm máy thật; vỏ Capacitor sang phase 7 |
| Bước 0: spike dark mode Astryx (C1) | Xong (2026-11-22). `light-dark()` chạy ở ba trình duyệt, cả trong `color-mix()` và bóng; theme lúc chạy chuyển từ biến inline sang thẻ `<style>` (biến inline không tới portal); màu cú pháp tự theo. Kết quả ở [C1](../theme-va-dien-thoai.md) |
| Bước 1: theme v2 trong `tokens` | Xong (2026-11-22). Schema v2 `colors {light, dark}`, `toAstryxVars` ra `light-dark()`, `checkContrast` hai chế độ, `figureVars(theme, mode)`, theme `kd`, `kd-contrast`, `ocean` (`packages/tokens/src/themes/`), bảng dark trong `DESIGN.md`. Màn hình vẫn chỉ light tới bước 3 |
| Bước 2: `Appearance`, server v11, route | Xong (2026-11-22). `Appearance {mode, theme}` trong `@kd-learn/api`, bảng `user_appearance` (server v11), `GET` / `PUT /api/account/appearance`, client `appearance()` / `saveAppearance()`; test hai người dùng, giá trị sai trả 400, nâng cấp DB v10 |
| Bước 3: `ThemeRoot`, cookie, SSR / SPA, cài đặt | Xong (2026-11-22). Cookie `kd_appearance` đọc ở SSR và script trước lần vẽ đầu của SPA; CSS của theme dựng sẵn có sẵn trong `<head>`, gắn với `data-kd-theme`; `useThemeControl()` trả `appearance`, `theme`, `resolvedMode`; đồng bộ tài khoản; mục "Giao diện" trong cài đặt khách và tài khoản. `appearance.e2e.ts` qua trên ba trình duyệt; SPA kiểm bằng script tạm (chặn JS của app, màu nền đã đúng) |
| Bước 4: hình, demo, graph theo chế độ | Chưa làm |
| Bước 5: web trên điện thoại (giả lập), #418, WebKit practice | Chưa làm |
| Bước 6: chuẩn bị kiểm máy thật, Haiku ở dark mode | Chưa làm |
| Bước 7: người dùng kiểm trên điện thoại thật | Chưa làm |

## Điều cần biết khi bắt đầu (từ phase 5)

- **Theme:** schema ở `packages/tokens/src/schema.ts`, ánh xạ duy nhất sang biến Astryx `toAstryxVars` (`astryx-vars.ts`), theme tĩnh `kdTheme.ts` build bằng `astryx theme build` (`dist/kd.css`); theme lúc chạy là biến inline trong `ThemeRoot` (`apps/web/src/theme/ThemeRoot.tsx`). `mode="light"` cố định ở `ThemeRoot` và `data-theme="light"` ở `__root.tsx`.
- **Màu của hình:** `figureVars` (`packages/tokens/src/figure-vars.ts`), `figureVarsOf` (`apps/web/src/learn/figures.ts`), khung demo `packages/ui/components/figure/frame-doc.ts` (`color-scheme: normal`), graph `apps/web/src/graph/GraphFigure.tsx` (`resolveColor` lúc vẽ).
- **e2e hình:** `apps/web/e2e/figures.e2e.ts` kiểm Mermaid có nét vẽ thật (`naturalWidth > 150`, hơn 500 điểm ảnh có mực); chạy lại ở dark và từng theme.
- **Migration hiện tại:** khách v5 (`packages/storage/src/sqlite/schema.ts`), server v10 (`packages/storage/src/sqlite-node/schema.ts`). Không sửa migration đã phát hành.
- **Model thật:** thử script với model giả trước; chỉ gọi Haiku một lần mỗi bước (bước 10 phase 5 vượt quy tắc này vì lỗi script chờ).
- **Còn mở từ phase 5:** React #418 trên mọi trang (có từ trước phase 5), `practice.e2e.ts` khách lỗi trên WebKit, adapter ảnh tương thích OpenAI chưa gọi thật.

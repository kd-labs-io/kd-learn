# 8. Tiến độ phase 0

## Phase 0 (cập nhật 2026-11-17)

Nhánh `phase-0-scaffold`, PR [#1](https://github.com/kd-labs-io/kd-learn/pull/1).

| Hạng mục | Trạng thái |
| --- | --- |
| Turborepo, pnpm (catalog ghim phiên bản, mọi `@astryxdesign/*` cùng 0.7.16), TS, Prettier | Xong |
| Package: `config`, `core`, `agent` (khung rỗng), `i18n`, `tokens`, `ui`, `apps/web` | Xong. `ai`, `search`, `storage`, `api`, `server`, `mobile` để phase sau |
| Lint ranh giới package ([mục 3.2](../03-kien-truc.md)) | Xong. `core` và `agent` bị chặn API của Node, DOM, React, TanStack, và biên dịch không có DOM lib và `@types/node`. Có test cố ý vi phạm để chứng minh luật chạy |
| Theme (`packages/tokens`) | Xong. Theme là JSON có Effect Schema và số phiên bản: màu chỉ nhận hex, font theo danh sách cho phép, từ chối key lạ. Một hàm ánh xạ duy nhất từ token của `DESIGN.md` sang biến CSS của Astryx, dùng cho cả theme build sẵn (`astryx theme build`) lẫn đổi theme lúc chạy. Kiểm tương phản WCAG AA trước khi áp dụng |
| i18n | Xong, dùng Paraglide JS ([mục 2.4](../02-ky-thuat.md)) |
| CI (`.github/workflows/ci.yml`) | Xong. Chạy xanh trên GitHub (PR #1, 2026-11-17) |
| Spike UI | Đạt. Safari iOS hoãn sang phase 6 ([rủi ro 5](../05-rui-ro.md)) |

Kết quả spike UI (tiêu chí ở [mục 4](../04-phases.md)):

- TanStack Start + Astryx build được cả SSR (Nitro) và SPA; đã mở thử trên trình duyệt cả dev, SSR và SPA.
- Theme `kd` dựng từ `DESIGN.md`, font tự host, đúng màu, radius, cỡ chữ.
- `@kd-learn/ui` là integration package của Astryx; CLI nhận component `LessonText` qua `workspace:*` (`astryx discover`, `astryx component LessonText`), `astryx integration check --strict` đạt.
- StyleX qua plugin Vite của `@astryxdesign/build` chạy được, CSS tách đúng thứ tự layer `reset < astryx-base < astryx-theme < product`. Cần ba chỗ chỉnh trong `apps/web` ([rủi ro 14](../05-rui-ro.md)):
  - Chỉ chạy plugin `astryx-build-layer-split` cho build client; ở build server nó báo lỗi vì không có CSS.
  - Khi dev, tự thêm link `/virtual:stylex.css` vào `<head>`, vì Start tự render HTML nên plugin không chèn được.
  - Khai báo thứ tự layer ở đầu `<head>`, nếu không CSS reset đè lên style của nút khi dev.
  - HMR của StyleX chưa nối.
- Đổi token lúc chạy từ theme JSON: đạt ([rủi ro 12](../05-rui-ro.md)).

Ghi chú khác:

- Bản SPA dựng sẵn `index.html` bằng ngôn ngữ gốc, và React không sửa `<html lang>` khi hydrate, nên `I18nRoot` đặt lại `lang` phía client.
- Đã chạy `astryx init --features agents`: chỉ dẫn Astryx nằm ở `apps/web/AGENTS.md`, kèm ghi chú theme lấy từ `packages/tokens`. Agent skills của TanStack đã được duyệt sẵn (`pnpm permissions list`), không còn mục chờ.
- Script cài đặt của `@astryxdesign/core` và `@astryxdesign/cli` bị tắt (`allowBuilds` trong `pnpm-workspace.yaml`); script đó chỉ in lời nhắc chạy setup.
- Theme còn thiếu: kiểm tương phản chưa xét chữ trên nền màu trạng thái và chữ trạng thái trên nền nhạt 12%; vài token Astryx chưa ánh xạ nên còn màu xám mặc định (ví dụ nút Secondary).
- Spacing không nằm trong theme: giữ thang 4px cố định của Astryx. Shadow trong theme lưu dạng có cấu trúc, không nhận chuỗi CSS.

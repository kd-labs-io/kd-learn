# 2. Quyết định đã chốt: kỹ thuật

## 2.4 Kỹ thuật

| Chủ đề | Quyết định |
| --- | --- |
| Monorepo | Turborepo, pnpm, Node LTS. Package đặt tên `@kd-learn/*` |
| TypeScript | 6.0, chưa lên 7: `typescript-eslint` chỉ hỗ trợ dưới 6.1, `astryx integration check` cần API của TS 6 |
| i18n | [Paraglide JS](https://paraglidejs.com) cho chuỗi của app (`packages/i18n/messages/{vi,en}.json`, ngôn ngữ gốc `vi`). Chuỗi của component Astryx do `InternationalizationProvider` của Astryx dịch, dùng chung locale. Locale lấy theo cookie, rồi ngôn ngữ trình duyệt, rồi `vi`. Plugin của Paraglide nạp từ `node_modules`, không từ CDN |
| Font | Tự host qua Fontsource (bản variable của Inter, Source Serif 4, JetBrains Mono) |
| Test | Vitest. Test trình duyệt (DB local, sau này luồng UI): Playwright (`@playwright/test`, `apps/web/e2e`, đuôi `*.e2e.ts` để Vitest không nhặt), chạy trên bản build SSR; CI chỉ cài Chromium (chốt ở bước 5 phase 1, [archive/phase-1.md](archive/phase-1.md)) |
| Lint | ESLint, gồm rule chặn import theo package (ranh giới ở [mục 3.2](03-kien-truc.md)) |
| Format | Prettier |
| CI | GitHub Actions chạy `turbo build test lint` |
| Web | TanStack Start. API là route HTTP thường viết bằng Effect, không dùng server function. Bản server Node build qua Nitro (`.output/`); bản SPA build bằng `KD_BUILD_TARGET=spa` (`dist/client/`) |
| Mobile | Capacitor bọc bản build SPA của web. Dùng chung một bộ UI với web, không dùng Expo |
| UI | [Astryx](https://astryx.atmeta.com) (MIT, React 19, đang beta) với theme riêng dựng từ `DESIGN.md`. Component riêng của kd-learn viết bằng StyleX dùng token có kiểu, qua plugin Vite của `@astryxdesign/build`; nếu không chạy được thì lùi về CSS Modules + `var(--...)`. Không dùng Tailwind và shadcn. Hạn chế `swizzle` |
| Biểu đồ | TanStack Charts, màu lấy từ token Astryx qua `var(--...)` |
| DB | SQLite ở mọi nơi: SQLite trên server, SQLite WASM (OPFS) cho khách |
| Driver SQLite khách | `@journeyapps/wa-sqlite` (ghim 2.0.x) với `OPFSCoopSyncVFS`, chạy trong Worker do `packages/storage` tự viết. Không cần COOP/COEP (không xung đột với iframe sandbox ở phase 5); nhiều tab cùng mở và ghi được; transaction chạy trọn trong Worker. Chọn sau spike bước 1 phase 1 (2026-11-21, [archive/phase-1.md](archive/phase-1.md)). Loại: VFS `opfs` của `@sqlite.org/sqlite-wasm` (cần COOP/COEP), `opfs-sahpool` (chỉ một tab mở được DB) |
| Driver SQLite server | `node:sqlite` có sẵn trong Node 26 (lớp `Database`), gọi trực tiếp, một kết nối, WAL. Không addon native, chạy trong bản build Nitro và image `node:26-slim`/`-alpine`. Chọn sau spike bước 0 phase 2 (2026-11-21, [progress/phase-2.md](progress/phase-2.md)). Loại: `better-sqlite3` (addon native), `@effect/sql-sqlite-node` (unstable) |
| Auth | Tự viết tối thiểu: Argon2id của `node:crypto`, token opaque lưu SHA-256, Bearer cho cả web và Capacitor. Loại: better-auth (thiếu mã mời, rate limit không đếm lần sai, migration riêng), Lucia (deprecated). Chọn ở spike bước 0 phase 2 |
| Markdown | `Markdown` của Astryx (`isStreaming`) kèm KaTeX qua `components.math` (spike 2026-11-21, [archive/phase-1.md](archive/phase-1.md)). Escape HTML mặc định; KaTeX dùng `trust: false`, `maxExpand` giới hạn, `throwOnError: false`; ảnh trong Markdown do model sinh phải chặn hoặc cho qua danh sách cho phép (rủi ro 21). Nạp lười (KaTeX khoảng 77 kB gzip JS, 8 kB CSS, font woff2 khoảng 256 kB) |
| Lõi | Effect v4 cho service, lỗi, đồng thời, schema, job nền |
| Model | TanStack AI cho backend API, qua adapter tự viết sang `Stream` của Effect ([mục 3.3](03-kien-truc.md)). Không dùng module AI của Effect, chưa dùng `@tanstack/ai-effect` (còn 0.x) |
| Provider | Anthropic, OpenAI, Google Gemini, endpoint tương thích OpenAI (admin khai báo danh sách được phép) |
| ACP | Agent Client Protocol: server điều khiển agent CLI (Claude Code, Antigravity CLI, opencode) làm backend. Admin bật, chỉ cho chế độ tài khoản. Không dùng Gemini CLI (đã bị Antigravity CLI thay thế). Client là `@agentclientprotocol/sdk`; Claude Code chạy qua `@agentclientprotocol/claude-agent-acp`. Output có cấu trúc qua tool `submit_result` ([mục 3.3](03-kien-truc.md)) |
| Tìm kiếm | Port với 5 nguồn: SearXNG, Exa, web search của OpenAI, Anthropic, Gemini. Có UI cấu hình |
| Hình minh hoạ | LLM sinh mã (SVG / Mermaid, HTML + JS) chạy trong iframe sandbox, cộng tool sinh ảnh (OpenAI, Gemini) |
| Triển khai | Docker Compose trên VPS hoặc máy ở nhà |
| Vị trí repo | `kd-learn/`, giữ `probe/` làm ghi chú |

## 2.5 Thư viện TanStack

Mỗi phase chỉ thêm thư viện khi thật sự cần. Các thư viện này chỉ nằm trong `apps/web` và `packages/ui`; `core` và `agent` không phụ thuộc vào chúng. Ngoại lệ duy nhất: `packages/ai` được dùng `@tanstack/ai*` để làm adapter cho port AI (lint đã cho phép).

| Thư viện | Dùng cho | Từ phase | Trạng thái |
| --- | --- | --- | --- |
| Start + Router | Web, route, API | 0 | Chốt |
| AI | Backend API của port AI | 1 | Chốt |
| Query | Lấy dữ liệu từ server ở chế độ tài khoản. Stream một lượt học vẫn đi qua SSE | 1 | Chốt |
| Form | Cài đặt, admin, chọn model theo vai, hồ sơ dạy học, nhập key. Schema lấy từ Effect Schema qua Standard Schema | 1 | Chốt |
| Markdown | Hiển thị câu trả lời của Teacher khi đang stream | 1 | Không dùng ở phase 1 (spike 2026-11-21): không có cú pháp công thức, không giữ lại cú pháp dở dang khi stream, không có style; phải tự viết extension, hàm giữ lại phần dở dang và CSS. Dùng `Markdown` của Astryx ([mục 2.4](02-ky-thuat.md)) |
| Highlight | Đoạn code ngoài `Markdown` của Astryx, màu tô code nối với token Astryx | 1 | Bài dạy không cần: `CodeBlock` trong `Markdown` của Astryx đã tô màu. Chỉ dùng nếu cần tô code ở chỗ khác |
| Virtual | Lịch sử buổi học dài, danh sách mệnh đề, danh sách bài luyện tập | 1 | Chốt |
| Pacer | Chỉ phía UI: debounce ô tìm kiếm. Phía server dùng Effect | 1 | Khi cần. Gộp render khi stream đã nằm trong `Markdown` của Astryx (`useStreamingText`) |
| DB (1.0 RC) | Store phản ứng phía client, nằm trên port `storage` cho DB local của khách | — | Không dùng ở phase 1 (spike 2026-11-21): chỉ chạy phía client (không SSR), adapter lưu bền của nó lưu JSON theo collection, không dùng chung được với driver server. Chạy được khi đặt phía trên port; xem lại ở phase 3 nếu màn hình graph cần live query |
| Charts | Tiến độ học, mức nắm vững, lịch học, hạn mức demo; thử cho màn hình graph | 3 | Chốt |
| Hotkeys (beta) | Phím tắt khi luyện tập | 3 | Khi cần |
| Table | Duyệt mệnh đề của graph nếu cần lọc và sắp xếp phức tạp; còn lại dùng `Table` của Astryx | 3 | Khi cần |
| Devtools, CLI, Config, Intent | Công cụ phát triển và phát hành; Intent cho `@kd-learn/ui` khi mở mã nguồn | — | Để sau |

Không dùng: Store (trùng với Effect, Query, DB), Redact (Astryx cần React 19 chuẩn).


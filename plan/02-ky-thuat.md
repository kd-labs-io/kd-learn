# 2. Quyết định đã chốt: kỹ thuật

## 2.4 Kỹ thuật

| Chủ đề | Quyết định |
| --- | --- |
| Monorepo | Turborepo, pnpm, Node LTS. Package đặt tên `@kd-learn/*` |
| TypeScript | 6.0, chưa lên 7: `typescript-eslint` chỉ hỗ trợ dưới 6.1, `astryx integration check` cần API của TS 6 |
| i18n | [Paraglide JS](https://paraglidejs.com) cho chuỗi của app (`packages/i18n/messages/{vi,en}.json`, ngôn ngữ gốc `vi`). Chuỗi của component Astryx do `InternationalizationProvider` của Astryx dịch, dùng chung locale. Locale lấy theo cookie, rồi ngôn ngữ trình duyệt, rồi `vi`. Plugin của Paraglide nạp từ `node_modules`, không từ CDN |
| Font | Tự host qua Fontsource (bản variable của Inter, Source Serif 4, JetBrains Mono) |
| Test | Vitest |
| Lint | ESLint, gồm rule chặn import theo package (ranh giới ở [mục 3.2](03-kien-truc.md)) |
| Format | Prettier |
| CI | GitHub Actions chạy `turbo build test lint` |
| Web | TanStack Start. API là route HTTP thường viết bằng Effect, không dùng server function. Bản server Node build qua Nitro (`.output/`); bản SPA build bằng `KD_BUILD_TARGET=spa` (`dist/client/`) |
| Mobile | Capacitor bọc bản build SPA của web. Dùng chung một bộ UI với web, không dùng Expo |
| UI | [Astryx](https://astryx.atmeta.com) (MIT, React 19, đang beta) với theme riêng dựng từ `DESIGN.md`. Component riêng của kd-learn viết bằng StyleX dùng token có kiểu, qua plugin Vite của `@astryxdesign/build`; nếu không chạy được thì lùi về CSS Modules + `var(--...)`. Không dùng Tailwind và shadcn. Hạn chế `swizzle` |
| Biểu đồ | TanStack Charts, màu lấy từ token Astryx qua `var(--...)` |
| DB | SQLite ở mọi nơi: SQLite trên server, SQLite WASM (OPFS) cho khách |
| Driver SQLite khách | `@journeyapps/wa-sqlite` (ghim 2.0.x) với `OPFSCoopSyncVFS`, chạy trong Worker do `packages/storage` tự viết. Không cần COOP/COEP (không xung đột với iframe sandbox ở phase 5); nhiều tab cùng mở và ghi được; transaction chạy trọn trong Worker. Chọn sau spike bước 1 phase 1 (2026-11-21, [progress/phase-1.md](progress/phase-1.md)). Loại: VFS `opfs` của `@sqlite.org/sqlite-wasm` (cần COOP/COEP), `opfs-sahpool` (chỉ một tab mở được DB) |
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
| Markdown | Hiển thị câu trả lời của Teacher khi đang stream (chế độ AI streaming, mặc định escape HTML) | 1 | Cần spike: công thức toán (KaTeX). Nếu không đạt thì dùng `Markdown` của Astryx. Chỉ dùng một bộ hiển thị Markdown |
| Highlight | Đoạn code trong bài dạy, màu tô code nối với token Astryx | 1 | Chốt |
| Virtual | Lịch sử buổi học dài, danh sách mệnh đề, danh sách bài luyện tập | 1 | Chốt |
| Pacer | Chỉ phía UI: gộp các lần render khi stream, debounce ô tìm kiếm. Phía server dùng Effect | 1 | Khi cần |
| DB (1.0 RC) | Store phản ứng phía client, nằm trên port `storage` cho DB local của khách | — | Không dùng ở phase 1 (spike 2026-11-21): chỉ chạy phía client (không SSR), adapter lưu bền của nó lưu JSON theo collection, không dùng chung được với driver server. Chạy được khi đặt phía trên port; xem lại ở phase 3 nếu màn hình graph cần live query |
| Charts | Tiến độ học, mức nắm vững, lịch học, hạn mức demo; thử cho màn hình graph | 3 | Chốt |
| Hotkeys (beta) | Phím tắt khi luyện tập | 3 | Khi cần |
| Table | Duyệt mệnh đề của graph nếu cần lọc và sắp xếp phức tạp; còn lại dùng `Table` của Astryx | 3 | Khi cần |
| Devtools, CLI, Config, Intent | Công cụ phát triển và phát hành; Intent cho `@kd-learn/ui` khi mở mã nguồn | — | Để sau |

Không dùng: Store (trùng với Effect, Query, DB), Redact (Astryx cần React 19 chuẩn).


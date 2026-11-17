# Plan tổng thể kd-learn

- **Ngày lập:** 2026-11-14
- **Cập nhật:** 2026-11-15: UI chuyển từ Tailwind + shadcn sang Astryx; thêm TanStack Charts và các thư viện TanStack khác (mục 2.4, 2.5, 3.1, 4, 5)
- **Cập nhật:** 2026-11-17: chốt công cụ phase 0: Vitest, ESLint, Prettier, GitHub Actions, tên package `@kd-learn/*` (mục 2.4)
- **Cập nhật:** 2026-11-17: thêm hướng theme do người dùng tự tạo, import / export, marketplace theme sau phase 6 (mục 2.3, 4, 5, 6)
- **Cập nhật:** 2026-11-17: chốt giấy phép MIT, đã `git init` và đẩy lên `github.com/kd-labs-io/kd-learn` (mục 2.1, 6)
- **Trạng thái:** đã chốt hướng, chưa viết code
- **Nguồn:** `probe/IDEA.md` và phần hỏi đáp trong `probe/AGENT_FEEDBACK.md`

> **Vai trò của hai thư mục**
> - `plan/` là để hành động: đây là nguồn chính thức cho việc cần làm.
> - `probe/` chỉ để brainstorm: ý tưởng, hỏi đáp, bản nháp đã bị thay thế. Không triển khai trực tiếp từ đó.
> - Khi hai bên mâu thuẫn, `plan/` đúng. Cụ thể, plan này thay thế `probe/IDEA.md` ở hai điểm: mobile dùng Capacitor (không phải Expo), và "offline-first" được hiểu là chế độ khách (không phải dùng được khi mất mạng).

## 1. Mục tiêu

Xây một app học tập có AI hướng dẫn, lấy ý tưởng từ [LearnHarness](https://github.com/amosblomqvist/learnharness), nhưng chạy được dạng web self-hosted, linh hoạt hơn, và có app mobile.

Vòng học gồm ba agent dùng chung lịch sử buổi học:

1. **Prober** đo mức hiểu hiện tại của người học.
2. **Teacher** lập plan dạy dạng DAG rồi dạy từng bước.
3. **Practitioner** ra bài luyện tập.

Sau mỗi buổi, kiến thức được trích thành **knowledge graph** (mệnh đề và chuỗi lập luận), và bài luyện tập lấy từ graph đó.

Dự án viết lại từ đầu. Không chép code hay prompt của LearnHarness (bản gốc dùng giấy phép AGPL-3.0), chỉ tham khảo ý tưởng và kiến trúc.

## 2. Quyết định đã chốt

### 2.1 Sản phẩm

| Chủ đề | Quyết định |
| --- | --- |
| Mục đích | Dùng cá nhân trước, giữ repo sạch để mở mã nguồn sau. Giấy phép MIT |
| Người dùng | Nhóm nhỏ tin nhau, mỗi người dữ liệu riêng, một admin |
| Tính năng | Prober + Teacher, Practice, knowledge graph, side chat, PDF / import ghi chú, research web, hình minh hoạ + demo tương tác |
| Ngoài phạm vi | Dictation, hệ thống plugin, bản desktop, import dữ liệu từ LearnHarness |
| Ngôn ngữ | Giao diện i18n vi + en từ đầu. Ngôn ngữ dạy là cài đặt riêng. Code, tên, comment, prompt bằng tiếng Anh |
| Giao diện | Theo `DESIGN.md`, hiện thực bằng một theme Astryx riêng. Token ngữ nghĩa từ đầu, dark mode làm sau lõi |

### 2.2 Ba chế độ chạy

| Chế độ | Đăng nhập | Dữ liệu | Key model |
| --- | --- | --- | --- |
| Khách | Không | DB local trên thiết bị | Người dùng tự nhập, gửi theo từng request, server không lưu |
| Tài khoản | Có | DB server | Lưu mã hoá trên server theo người dùng |
| Demo | Không | DB local trên thiết bị | Key của server, có hạn mức lượt gọi |

- Khách và tài khoản tách hẳn: không sync, không import giữa hai bên.
- Agent luôn chạy trên server ở cả ba chế độ. Với khách và demo, server không lưu key hay dữ liệu buổi học.
- Admin có ba công tắc: đăng ký (mở / theo lời mời / đóng), chế độ khách, chế độ demo.

### 2.3 Thiết kế mở

- **Model theo vai:** mỗi agent (Prober, Teacher, Practitioner, extractor) chọn provider và model riêng.
- **Hồ sơ dạy học:** prompt và tham số của agent là dữ liệu sửa được, không viết cứng trong code.
- **Loại bài tập:** registry trong code, thêm loại mới không phải sửa lõi.
- **Theme:** đổi qua design token, không sửa component. Về sau người dùng sẽ tự tạo, import / export theme và có marketplace theme (xem mục 4). Vì vậy ngay từ phase 0:
  - Theme là dữ liệu thuần, có Effect Schema và số phiên bản, không chứa CSS hay JS.
  - Token phải đổi được lúc chạy (qua CSS variable), không chỉ lúc build.

### 2.4 Kỹ thuật

| Chủ đề | Quyết định |
| --- | --- |
| Monorepo | Turborepo, pnpm, Node LTS. Package đặt tên `@kd-learn/*` |
| Test | Vitest |
| Lint | ESLint, gồm rule chặn import theo package (ranh giới ở mục 3.2) |
| Format | Prettier |
| CI | GitHub Actions chạy `turbo build test lint` |
| Web | TanStack Start. API là route HTTP thường viết bằng Effect, không dùng server function |
| Mobile | Capacitor bọc bản build SPA của web. Dùng chung một bộ UI với web, không dùng Expo |
| UI | [Astryx](https://astryx.atmeta.com) (MIT, React 19, đang beta) với theme riêng dựng từ `DESIGN.md`. Component riêng của kd-learn viết bằng StyleX dùng token có kiểu, qua plugin Vite của `@astryxdesign/build`; nếu không chạy được thì lùi về CSS Modules + `var(--...)`. Không dùng Tailwind và shadcn. Hạn chế `swizzle` |
| Biểu đồ | TanStack Charts, màu lấy từ token Astryx qua `var(--...)` |
| DB | SQLite ở mọi nơi: SQLite trên server, SQLite WASM (OPFS) cho khách |
| Lõi | Effect v4 cho service, lỗi, đồng thời, schema, job nền |
| Model | TanStack AI cho backend API. Không dùng module AI của Effect |
| Provider | Anthropic, OpenAI, Google Gemini, endpoint tương thích OpenAI (admin khai báo danh sách được phép) |
| ACP | Agent Client Protocol: server điều khiển agent CLI (Claude Code, Gemini CLI, opencode) làm backend. Admin bật, chỉ cho chế độ tài khoản |
| Tìm kiếm | Port với 5 nguồn: SearXNG, Exa, web search của OpenAI, Anthropic, Gemini. Có UI cấu hình |
| Hình minh hoạ | LLM sinh mã (SVG / Mermaid, HTML + JS) chạy trong iframe sandbox, cộng tool sinh ảnh (OpenAI, Gemini) |
| Triển khai | Docker Compose trên VPS hoặc máy ở nhà |
| Vị trí repo | `kd-learn/`, giữ `probe/` làm ghi chú |

### 2.5 Thư viện TanStack

Mỗi phase chỉ thêm thư viện khi thật sự cần. Các thư viện này chỉ nằm trong `apps/web` và `packages/ui`; `core` và `agent` không phụ thuộc vào chúng.

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
| DB (1.0 RC) | Store phản ứng phía client, nằm trên port `storage` cho DB local của khách | 1 | Cần spike, chưa chốt |
| Charts | Tiến độ học, mức nắm vững, lịch học, hạn mức demo; thử cho màn hình graph | 3 | Chốt |
| Hotkeys (beta) | Phím tắt khi luyện tập | 3 | Khi cần |
| Table | Duyệt mệnh đề của graph nếu cần lọc và sắp xếp phức tạp; còn lại dùng `Table` của Astryx | 3 | Khi cần |
| Devtools, CLI, Config, Intent | Công cụ phát triển và phát hành; Intent cho `@kd-learn/ui` khi mở mã nguồn | — | Để sau |

Không dùng: Store (trùng với Effect, Query, DB), Redact (Astryx cần React 19 chuẩn).

## 3. Kiến trúc

### 3.1 Cấu trúc monorepo

```
kd-learn/
├─ apps/
│  ├─ web/          # TanStack Start: UI + mount API; build SSR (Docker) và SPA tĩnh (Capacitor)
│  └─ mobile/       # Vỏ Capacitor bọc bản build SPA của web
├─ packages/
│  ├─ core/         # Thuần TS + Effect Schema: record, event, projection, graph, registry loại bài tập. Không IO.
│  ├─ agent/        # Prober/Teacher/Practitioner, tools, hồ sơ dạy học. Chỉ phụ thuộc core + port.
│  ├─ ai/           # Port "chạy một lượt với bộ tool" + backend: tanstack-ai, acp
│  ├─ search/       # Port tìm kiếm + adapter: searxng, exa, web search của provider
│  ├─ storage/      # Port lưu trữ + driver: sqlite-node (server), sqlite-wasm (khách)
│  ├─ api/          # Hợp đồng HTTP (Effect Schema) + client có kiểu
│  ├─ server/       # Điều phối turn, job nền, auth, cấu hình admin
│  ├─ tokens/       # Theme Astryx của kd-learn: defineTheme từ DESIGN.md, nguồn token duy nhất
│  ├─ ui/           # @kd-learn/ui: integration package của Astryx, gồm component riêng (kể cả biểu đồ), template màn hình, components/astryx/ cho bản swizzle
│  ├─ i18n/         # Chuỗi vi + en
│  └─ config/       # tsconfig, lint dùng chung
├─ plan/            # Để hành động: các bản plan theo ngày, nguồn chính thức
├─ probe/           # Chỉ để brainstorm: IDEA, AGENT_FEEDBACK
├─ turbo.json
└─ docker-compose.yml   # web + searxng
```

### 3.2 Nguyên tắc ranh giới

- `core` và `agent` không import API của Node hay DOM. Ràng buộc bằng lint rule từ phase 0.
- Mọi IO đi qua port: lưu trữ, model, tìm kiếm. Adapter nằm ở package riêng.
- Schema định nghĩa một lần bằng Effect Schema, dùng chung cho DB, API và tool của agent.

### 3.3 Port AI

Port của `packages/ai` ở mức "chạy một lượt với bộ tool này, trả về stream sự kiện", vì có hai loại backend khác bản chất:

- **Backend API (TanStack AI):** kd-learn điều khiển vòng tool.
- **Backend ACP (adapter tự viết):** agent CLI điều khiển vòng tool, tool của kd-learn đưa vào qua MCP.

### 3.4 Luồng một lượt học

1. Client gửi câu trả lời của người học qua API HTTP. Khách gửi kèm key và lịch sử buổi học.
2. Server chạy vòng agent và stream sự kiện về client.
3. Sự kiện được ghi vào DB: DB server với tài khoản, DB local với khách và demo.
4. Với tài khoản, đóng tab buổi học vẫn chạy tiếp. Với khách, việc đang chạy dừng khi đóng tab.

## 4. Các phase

| Phase | Nội dung | Xong khi |
| --- | --- | --- |
| 0. Khung | Turborepo, pnpm, TS, lint ranh giới package, theme, khung i18n, test, CI, `git init`. Spike UI: TanStack Start + Astryx build cả SSR và SPA; theme kd-learn từ `DESIGN.md`; một component mẫu trong `@kd-learn/ui` được CLI Astryx nhận qua `workspace:*`; StyleX qua `@astryxdesign/build`; đổi token lúc chạy từ một theme dạng JSON; mở thử trên Safari iOS | `turbo build test lint` chạy xanh; spike UI đạt, nếu không thì quay về Tailwind + shadcn |
| 1. Lõi dạy học (khách) | Spike port AI (TanStack AI + ACP, ranh giới stream với Effect). Schema, vòng turn, Prober → Teacher, side chat, server không trạng thái, DB local, UI responsive | Khách tự nhập key, học xong 1 chủ đề, tải lại trang không mất dữ liệu |
| 2. Tài khoản + triển khai | SQLite server, auth bằng token, key mã hoá, công tắc admin, demo có hạn mức, UI chọn model theo vai, backend ACP, Docker Compose | Hai tài khoản dữ liệu riêng; đóng tab buổi học vẫn chạy tiếp; demo dừng đúng hạn mức |
| 3. Practice + graph | Practitioner, registry loại bài tập, extractor / auditor / merge, màn hình graph (spike TanStack Charts: kéo / chọn node, vài nghìn node, cạnh có hướng và nhãn; không đạt thì dùng thư viện graph chuyên dụng), hồ sơ dạy học sửa được | Graph tự cập nhật sau buổi học, luyện tập lấy bài từ graph |
| 4. Nguồn học + việc nền | PDF, import ghi chú, research web với port tìm kiếm và UI cấu hình | Job của tài khoản sống sót khi server khởi động lại |
| 5. Hình và demo | Sơ đồ SVG / Mermaid, demo HTML trong iframe sandbox, tool sinh ảnh | Teacher chèn được sơ đồ và demo vào bước dạy; mã sinh ra không đọc được dữ liệu app |
| 6. Mobile + theme | Vỏ Capacitor, màn hình nhập URL server, dark mode | Đăng nhập và học 1 buổi trên điện thoại; đổi theme không vỡ sơ đồ |

Thứ tự phase cũng là thứ tự cắt giảm nếu phạm vi quá lớn: cắt từ phase 6 ngược lên.

**Sau phase 6 (chưa xếp lịch):**

- **Theme tuỳ biến:** người dùng chỉnh token trong UI, xem trước trực tiếp, cảnh báo khi độ tương phản dưới chuẩn WCAG AA.
- **Import / export theme:** file JSON theo schema theme. Import phải validate và từ chối mọi giá trị ngoài schema.
- **Marketplace theme:** duyệt, cài, chia sẻ, đánh giá theme. Mô hình (chạy trên từng server hay một registry chung) chốt sau (mục 6).

## 5. Rủi ro và việc cần kiểm chứng

| # | Rủi ro | Cách xử lý |
| --- | --- | --- |
| 1 | Output có cấu trúc qua ACP không đủ tin cậy | Thử ở spike đầu phase 1. Nếu không đạt, ACP chỉ dùng cho vai không cần cấu trúc chặt |
| 2 | Ranh giới giữa stream của TanStack AI và Effect | Thử cùng spike trên |
| 3 | Khách phải gửi lại lịch sử buổi học mỗi lượt | Giới hạn kích thước request, thiết kế cách tóm tắt lịch sử dài. Chưa thiết kế |
| 4 | Việc nền của khách dừng khi đóng tab | Research và PDF ở chế độ khách phải chạy lại được sau khi bị ngắt |
| 5 | SQLite WASM (OPFS), SSE và CSS anchor positioning trong WebView iOS | Kiểm chứng trước phase 6. Phương án lùi cho SQLite: plugin SQLite native của Capacitor. Astryx cần Safari 26+ để định vị popover, menu, tooltip; iOS 17–25 vẫn dùng được nhưng các lớp này có thể lệch vị trí. Chốt phiên bản iOS tối thiểu |
| 6 | SSRF qua base URL do người dùng nhập | Endpoint tương thích OpenAI và SearXNG chỉ lấy từ danh sách admin khai báo |
| 7 | Mã do model sinh chạy trong app | Iframe sandbox không truy cập được cookie, token hay DB local |
| 8 | Điều khoản dịch vụ khi dùng gói thuê bao qua ACP | Dùng cá nhân trước. Ghi rõ trách nhiệm của người host trong tài liệu khi công bố |
| 9 | Thư viện còn mới (Effect v4, TanStack AI, Astryx beta, TanStack DB RC, TanStack Charts) | Đọc tài liệu hiện hành trước khi viết code từng phần. Nâng cấp Astryx bằng `astryx upgrade --from`, ghim cùng phiên bản cho mọi package `@astryxdesign/*` |
| 10 | Phạm vi lớn: 7 nhóm tính năng, 5 backend AI, 5 nguồn tìm kiếm | Làm theo thứ tự phase, mỗi phase có tiêu chí xong rõ ràng |
| 11 | Theme import hoặc tải từ marketplace là dữ liệu không tin cậy (chèn CSS, URL ngoài để theo dõi, chữ không đọc được) | Theme chỉ chứa giá trị token đã qua schema (màu, độ dài, tên font trong danh sách cho phép). Không cho CSS tự do hay URL ngoài. Kiểm độ tương phản trước khi áp dụng |
| 12 | Theme của Astryx / StyleX biên dịch lúc build, chưa chắc đổi được lúc chạy | Kiểm chứng trong spike UI ở phase 0 |

## 6. Việc còn mở

- Cơ chế tóm tắt lịch sử cho buổi học dài ở chế độ khách.
- Thư viện auth và driver SQLite cụ thể: chọn ở phase 0 và phase 2 sau khi đọc tài liệu hiện hành.
- Phiên bản iOS tối thiểu cho app mobile (liên quan rủi ro 5).
- Bộ hiển thị Markdown: TanStack Markdown hay `Markdown` của Astryx, tuỳ kết quả spike công thức toán ở phase 1.
- Có dùng TanStack DB cho DB local của khách không: chốt sau spike ở phase 1.
- Marketplace theme: chạy riêng trên từng server hay dùng một registry chung, cách kiểm duyệt, và theme dùng chung giấy phép nào.

## 7. Bước tiếp theo

Phase 0: `git init` tại `kd-learn/`, dựng khung Turborepo + pnpm, lint ranh giới package, spike UI Astryx (mục 4), package `tokens` là theme Astryx từ `DESIGN.md`, khung i18n, CI.

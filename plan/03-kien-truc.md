# 3. Kiến trúc


## 3.1 Cấu trúc monorepo

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
├─ plan/            # Để hành động: plan chia theo chủ đề, mục lục ở README.md, nguồn chính thức
├─ probe/           # Chỉ để brainstorm: IDEA, AGENT_FEEDBACK
├─ turbo.json
└─ docker-compose.yml   # web + searxng
```

## 3.2 Nguyên tắc ranh giới

- `core` và `agent` không import API của Node hay DOM. Ràng buộc bằng lint rule từ phase 0.
- Mọi IO đi qua port: lưu trữ, model, tìm kiếm. Adapter nằm ở package riêng.
- `agent` chỉ được import `@kd-learn/core` và phần port của `ai`, `search`, `storage` qua đường dẫn `@kd-learn/<package>/port`, không import adapter. Ràng buộc bằng lint.
- Schema định nghĩa một lần bằng Effect Schema, dùng chung cho DB, API và tool của agent.

## 3.3 Port AI

Port của `packages/ai` ở mức "chạy một lượt với bộ tool này, trả về stream sự kiện", vì có hai loại backend khác bản chất:

- **Backend API (TanStack AI):** kd-learn điều khiển vòng tool.
- **Backend ACP (adapter tự viết):** agent CLI điều khiển vòng tool, tool của kd-learn đưa vào qua MCP.

Hình dạng đã chốt sau [spike port AI](archive/spike-port-ai.md) (2026-11-21):

- **Port** (`@kd-learn/ai/port`, chỉ import `effect`): service `AiPort` với `runTurn(request): Stream<TurnEvent, ProviderError | OutputInvalid>`.
  - `TurnRequest`: model (`ModelRef`), system prompt, lịch sử tin nhắn, tool (tên, mô tả, input là Effect Schema, hàm chạy là Effect), schema output có cấu trúc (không bắt buộc).
  - `TurnEvent`: `TextDelta`, `ToolCall`, `ToolResult`, `StructuredResult` (đã decode bằng Effect Schema), `Usage`, `Finish`. Một lượt có thể có nhiều `Usage` (mỗi lần gọi model một cái).
  - Tool lỗi được gửi lại cho model, lượt chạy tiếp. Output sai schema thành `OutputInvalid`.
  - Huỷ Stream thì dừng request tới provider, hoặc gửi `session/cancel` rồi kill process agent.
- **Adapter TanStack** (`src/tanstack`): gửi JSON Schema thuần (`Schema.toJsonSchemaDocument`) cho TanStack, decode lại bằng Effect. Schema cho tool và output dùng `Schema.Finite` thay `Schema.Number`, object có `properties` thì đóng (`additionalProperties: false`). Không dùng `@tanstack/ai-effect` (còn 0.x).
- **Adapter ACP** (`src/acp`):
  - Tool của kd-learn chạy trong process server, sau một MCP server (HTTP; agent không có MCP qua HTTP thì dùng cầu nối stdio).
  - Output có cấu trúc qua tool `submit_result`, validate bằng Effect Schema, cho sửa một lần.
  - Agent chạy cách ly: `cwd` và home là thư mục tạm rỗng, không khai báo capability `fs` và `terminal`, từ chối mọi quyền ngoài tool kd-learn, tắt tool có sẵn và không nạp cấu hình agent của user chạy server.

## 3.4 Luồng một lượt học

1. Client gửi câu trả lời của người học qua API HTTP. Khách gửi kèm key và lịch sử buổi học.
2. Server chạy vòng agent và stream sự kiện về client.
3. Sự kiện được ghi vào DB: DB server với tài khoản, DB local với khách và demo.
4. Với tài khoản, đóng tab buổi học vẫn chạy tiếp. Với khách, việc đang chạy dừng khi đóng tab.


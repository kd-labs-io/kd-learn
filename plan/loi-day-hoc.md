# Plan phần chính phase 1: lõi dạy học (khách)

- **Ngày lập:** 2026-11-21
- **Phạm vi:** phần còn lại của phase 1 sau spike port AI ([mục 4](04-phases.md))
- **Xong khi:** khách tự nhập key, học xong 1 chủ đề, tải lại trang không mất dữ liệu
- **Trạng thái:** đã duyệt (2026-11-21)

## A. Quyết định nền

Các quyết định này cố định schema, định dạng SSE và việc `agent` được làm gì, nên phải chốt trước khi viết code.

### A1. Trạng thái khách trên server không trạng thái

- Event log của buổi học là nguồn chính thức. Event log lưu ở DB local của khách, chỉ ghi thêm, không sửa.
- Mỗi lượt, client gửi `POST /api/turns` kèm: key và model, toàn bộ event log của buổi, input của người học.
- Server decode request, dựng projection bằng `core` (thuần), chạy vòng agent rồi stream SSE về client. Server không đọc hay ghi DB nào.
- SSE có bốn loại frame:
  - `delta`: chữ đang stream. Client chỉ hiển thị, không lưu.
  - `event`: một domain event hoàn chỉnh. Client ghi thêm vào DB local.
  - `error`: lỗi có kiểu (`ProviderError`, `HistoryTooLarge`, ...).
  - `done`: lượt đã kết thúc.
- Mọi event có `id` (do bên ghi tạo) và `at` (epoch ms). Event đầu tiên của log là `SessionCreated {sessionId, topic, profile}`: nó chụp lại hồ sơ dạy học để log tự đủ nghĩa, server không phải biết hồ sơ từ nơi khác (chốt ở bước 2).
- Phase 1, `agent` không dùng port `storage`. Port đó chỉ được client dùng. Sang phase 2, server tài khoản dùng chung port này.

### A2. Từ `TurnEvent` sang domain event

| `TurnEvent` của port AI | Domain event |
| --- | --- |
| `TextDelta` | Không lưu. Khi lượt kết thúc, gộp thành một `MessageAppended` |
| `ToolCall` / `ToolResult` của tool chuyển trạng thái | Tool tự sinh event có nghĩa (A4). Không lưu bản ghi gọi tool thô |
| `Usage` | Cộng dồn trong lượt, ghi một `UsageRecorded` (kèm tên model) ở cuối lượt |
| `Finish` | `TurnCompleted` |
| Lỗi | `TurnFailed` (mã lỗi, có thử lại được không). Lượt lỗi chỉ để lại `TurnFailed` (và `UsageRecorded` nếu đã tốn token): chữ dở và event do tool sinh trong lượt đó bị bỏ. Event của lượt chỉ được phát ở cuối lượt |

### A3. Tải lại trang giữa lượt

- Trước khi gửi request, client ghi `TurnStarted {turnId, input}`, nên câu trả lời của người học không bao giờ mất.
- Lượt có `TurnStarted` mà chưa có `TurnCompleted` hay `TurnFailed` thì coi là bị ngắt. Màn hình hiện "lượt bị ngắt" kèm nút thử lại (gửi lại cùng input).
- Thử lại ghi một `TurnStarted` mới với cùng input. Lượt cũ vẫn mở nhưng bị lượt sau thay thế, chỉ lượt mở cuối cùng được coi là bị ngắt.
- Lịch sử gửi cho model (`Session.history`) chỉ gồm các lượt đã `TurnCompleted`, nên lượt bị ngắt hay lỗi không để lại dấu vết và thử lại không bị trùng input.
- Phần chữ đang stream dở lúc tải lại thì bỏ.
- Event chỉ được ghi khi đã hoàn chỉnh. Mỗi lượt ghi trong một transaction.

### A4. Trạng thái buổi học và vai agent

- **Trạng thái:** `probing → planning → teaching(bước i) → done`. "Học xong 1 chủ đề" nghĩa là buổi học ở trạng thái `done`.
- **Vai agent:**
  - **Prober:** hỏi nhiều nhất N câu (N lấy từ hồ sơ dạy học). Kết thúc bằng tool `submit_assessment`, sinh event `AssessmentRecorded`.
  - **Teacher:**
    - Lập plan bằng tool `create_plan`, sinh `PlanCreated`. Plan là một DAG, mỗi node gồm `id`, tiêu đề, mục tiêu, `dependsOn`. `core` kiểm DAG không có chu trình; plan sai thì trả `ToolError` để model sửa.
    - Dạy bằng chữ stream. Khi người học đã nắm bước hiện tại, Teacher gọi `complete_step`, sinh `StepCompleted`.
- **Chọn bước tiếp theo** (hàm thuần trong `core`): node đầu tiên (theo thứ tự trong plan) mà mọi `dependsOn` đã xong. Bước bị bỏ qua (`StepSkipped`) tính là đã giải quyết. Mọi node xong thì sinh `SessionCompleted`, bên ghi thêm nó trong cùng transaction với event giải quyết bước cuối; giữa hai event đó `Teaching.stepId` là rỗng.
- **Đếm N và M:** projection đếm số lượt hoàn tất mà không chuyển trạng thái (không có assessment, plan, `StepCompleted`) trong `probing` (so với N) và trong từng bước (so với M). `canSkipStep` trả đúng khi đạt M. Projection không chặn `StepSkipped` khi chưa đạt M, UI mới quyết định.
- **Projection chặt:** log đến từ client nên không tin. Event sai thứ tự (`PlanCreated` ngoài `planning`, `StepCompleted` không phải bước hiện tại, plan có chu trình, event của lượt không tồn tại hay đã kết thúc, thêm lượt sau `done`) trả `ProjectionError` kèm vị trí event.
- **Lối thoát:**
  - Nếu một bước kéo quá M lượt, người học bấm được "sang bước sau" (event `StepSkipped`).
  - Người học sửa được plan trước khi bắt đầu dạy. Phần này để sau phase 1.
- **Chuyển trạng thái:** dùng tool, không dùng output có cấu trúc, vì Teacher cần vừa stream chữ vừa đổi trạng thái trong cùng một lượt. Đã kiểm bằng lượt chạy thật ở bước 3 (2026-11-21, Haiku): đứng vững, xem [progress/phase-1.md](progress/phase-1.md). Tool theo trạng thái: `submit_assessment` khi probing, `create_plan` khi planning, `complete_step` khi teaching; sau `AssessmentRecorded` client bắt đầu ngay một lượt input rỗng để Teacher lập plan.

### A5. Side chat

- Là luồng riêng gắn với buổi học và bước hiện tại. Event là `SideMessageAppended {threadId}`.
- Ngữ cảnh gồm plan, bước hiện tại và vài tin nhắn gần nhất của luồng chính. Side chat không ghi vào lịch sử chính và không đổi trạng thái buổi học. Client ghi tin nhắn của người học trước khi gửi (như A3); lỗi ghi `SideTurnFailed {threadId}`; tin trả lời mang `usage` của lượt gọi model.

### A6. Phạm vi model và hồ sơ dạy học

- Phase 1 chỉ dùng backend TanStack. ACP chỉ dành cho chế độ tài khoản ([mục 2.4](02-ky-thuat.md)), nên không dùng ở đây.
- Khách chọn một provider, một model và một key cho mọi vai. Chọn model theo vai thuộc phase 2.
- Endpoint tương thích OpenAI ([rủi ro 6](05-rui-ro.md)):
  - Request không được chứa `baseURL` tự do. Khách chỉ chọn theo id từ danh sách endpoint được phép.
  - Phase 1 chưa có UI admin, nên danh sách này lấy từ biến môi trường của server, ví dụ `KD_OPENAI_COMPATIBLE_ENDPOINTS`.
- **Hồ sơ dạy học** ([mục 2.3](02-san-pham.md)):
  - Là dữ liệu có schema (`TeachingProfile` trong `core`): prompt từng vai, N, M, ngôn ngữ dạy.
  - Bản mặc định nằm trong `agent`, prompt viết bằng tiếng Anh. UI sửa hồ sơ thuộc phase 3.
  - Prompt tự viết, không tham khảo prompt của LearnHarness.

### A7. Key của khách

- Key lưu trong DB local, ở bảng cài đặt. Có nút xoá key.
- Server không log header hay body chứa key, và thông báo lỗi trả về không được chứa key. Có test kiểm việc này.

### A8. Lịch sử dài ([rủi ro 3](05-rui-ro.md))

- Phase 1 chỉ đặt giới hạn kích thước request, ví dụ 1 MB, cấu hình được. Vượt giới hạn thì trả lỗi `HistoryTooLarge` và UI gợi ý mở buổi học mới.
- Cơ chế tóm tắt để sau. Việc này vẫn nằm ở [mục 6](06-viec-mo.md).

## B. Các bước

Mỗi bước có tiêu chí xong chạy được trong CI. Bước nào gọi model thì test bằng một `AiPort` giả chạy theo kịch bản. Kiểm bằng model thật tối đa một lần mỗi bước: chạy 1 lượt bằng Haiku, xem model và chi phí trước, theo lưu ý ở [progress/phase-1.md](progress/phase-1.md).

| # | Bước | Package | Xong khi |
| --- | --- | --- | --- |
| 0 | Khung package `storage`, `api`, `server`; lint ranh giới cho `api` và `server` | config, storage, api, server | `turbo build test lint` xanh; test lint chặn import sai |
| 1 | Spike driver SQLite WASM và TanStack DB (C1) | spike | Trả lời đủ câu hỏi ở C1, chốt driver và chốt có dùng TanStack DB không ([mục 6](06-viec-mo.md)) |
| 2 | Schema và projection: event, `Session`, `LessonPlan`, `TeachingProfile`, kiểm DAG, chọn bước tiếp, phát hiện lượt bị ngắt | core | Test đơn vị cho projection, DAG có chu trình, chọn bước, lượt bị ngắt |
| 3 | Vòng turn: Prober, Teacher, side chat, tool chuyển trạng thái, hồ sơ mặc định | agent | Kịch bản giả chạy hết `probing → done`; tool lỗi được gửi lại cho model; một lượt chạy thật xác nhận A4 |
| 4 | API và server: hợp đồng request/SSE bằng Effect Schema, route HTTP trong `apps/web`, giới hạn kích thước, danh sách endpoint, không lộ key, huỷ lượt khi client ngắt | api, server, web | Test hợp đồng; test huỷ; test key không xuất hiện trong log và thông báo lỗi; request có `baseURL` lạ bị từ chối |
| 5 | DB local: port `storage` (ghi thêm event, đọc buổi học, cài đặt), driver SQLite WASM, store phía client | storage, web | Ghi và đọc lại sau khi tải lại trang (test trình duyệt); ghi theo transaction |
| 6 | Spike Markdown và KaTeX khi đang stream (C2) | spike | Chốt bộ hiển thị Markdown ([mục 6](06-viec-mo.md)) |
| 7 | UI: nhập key và model, danh sách buổi học, màn học (stream, danh sách bước của plan, nút thử lại, sang bước sau), panel side chat, responsive, chuỗi vi/en | web, ui, i18n | Dùng được ở khổ điện thoại và desktop; mọi chuỗi qua Paraglide |
| 8 | Kiểm tiêu chí phase: học hết 1 chủ đề nhỏ bằng model thật, tải lại giữa lượt và sau khi xong | — | Đạt cả ba tiêu chí; đóng phase 1 theo quy ước ở `README.md` |

**Thứ tự:**

- Bước 0 làm trước tiên.
- Bước 1 làm song song với bước 2 và phải xong trước bước 5, vì driver quyết định hình dạng port `storage`.
- Bước 3 cần bước 2 xong. Bước 4 cần bước 3 xong.
- Bước 6 làm bất kỳ lúc nào trước bước 7.
- Bước 7 cần bước 4, 5 và 6 xong.
- Kiểm bằng trình duyệt dùng Playwright. Đã chốt ở bước 5: `apps/web/e2e`, chạy trên CI bằng Chromium ([progress/phase-1.md](progress/phase-1.md)).

## C. Câu hỏi cho hai spike

Không viết sẵn kết luận từ trí nhớ ([rủi ro 9](05-rui-ro.md)). Đọc tài liệu hiện hành rồi trả lời bằng thử nghiệm.

**C1. Driver SQLite WASM (OPFS):** đã trả lời (2026-11-21), kết quả ở [progress/phase-1.md](progress/phase-1.md) (phần bước 1) và [mục 2.4](02-ky-thuat.md).

- Có cần chạy trong Worker không? Có cần header COOP/COEP không? Nếu cần thì có xung đột với iframe sandbox ở phase 5 không?
- Có chạy được ở cả bản SSR (trong lúc hydrate) và bản SPA không?
- Mở hai tab cùng lúc thì sao: có khoá được không, hay chỉ cho một tab ghi?
- Dung lượng bundle và thời gian mở DB lần đầu là bao nhiêu?
- TanStack DB (RC) có nằm trên driver này được không, hay chỉ dùng như store phản ứng phía trên port?

**C2. Markdown và KaTeX:**

- TanStack Markdown hiển thị công thức (inline và block) khi đang stream có bị nhấp nháy hay vỡ không?
- Có giữ mặc định escape HTML không?
- Nếu không đạt thì dùng `Markdown` của Astryx kèm KaTeX được không?

## D. Ngoài phạm vi phase 1

- ACP, tài khoản, DB server, chọn model theo vai: phase 2.
- UI sửa hồ sơ dạy học, Practitioner, graph: phase 3.
- Tóm tắt lịch sử dài: [mục 6](06-viec-mo.md).
- Kiểm trên Safari iOS: phase 6.

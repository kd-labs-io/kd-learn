# 8. Tiến độ phase 1

## Phase 1 (cập nhật 2026-11-21)

Spike đã merge vào `main` (PR #2, sửa thêm ở PR #3, #4). Plan phần chính: [loi-day-hoc.md](../loi-day-hoc.md).

| Hạng mục | Trạng thái |
| --- | --- |
| Spike port AI ([spike-port-ai.md](../archive/spike-port-ai.md)) | Xong (2026-11-21). Rủi ro 1, 2 đạt |
| Bước 0: khung `storage`, `api`, `server` | Xong (2026-11-21). Lint ranh giới cho `storage`, `api`, `server` kèm test |
| Bước 1: spike SQLite WASM + TanStack DB | Xong (2026-11-21). Driver: `@journeyapps/wa-sqlite` + `OPFSCoopSyncVFS` trong Worker của ta; không dùng TanStack DB ở phase 1. Xem ghi chú bước 1 bên dưới |
| Bước 2: schema, projection (`core`) | Xong (2026-11-21). Xem ghi chú bước 2 bên dưới |
| Bước 3: vòng turn, Prober → Teacher, side chat (`agent`) | Chưa bắt đầu |
| Bước 4: API, server, SSE | Chưa bắt đầu |
| Bước 5: DB local | Chưa bắt đầu |
| Bước 6: spike Markdown + KaTeX | Chưa bắt đầu |
| Bước 7: UI | Chưa bắt đầu |
| Bước 8: kiểm tiêu chí phase | Chưa bắt đầu |

## Bước 2: schema và projection (2026-11-21)

Trong `packages/core`, test đơn vị phủ projection, DAG có chu trình, chọn bước, lượt bị ngắt.

- **Event (12):** `SessionCreated`, `TurnStarted`, `MessageAppended`, `UsageRecorded`, `TurnCompleted`, `TurnFailed`, `AssessmentRecorded`, `PlanCreated`, `StepCompleted`, `StepSkipped`, `SessionCompleted`, `SideMessageAppended`. Union `DomainEvent`, log là `EventLog`. Mọi event có `id` và `at`.
- **Schema khác:** `TeachingProfile` (`id`, `language`, `maxProbeQuestions` = N, `maxTurnsPerStep` = M, `prompts.{prober,teacher,sideChat}`), `LessonPlan`/`PlanNode`, `AssessmentLevel`.
- **Hàm:** `projectSession(log)` trả `Result<Session, ProjectionError>`; `findInterruptedTurn`, `currentStep`, `canSkipStep`; `validatePlan` (lỗi `PlanInvalid`: `DuplicateId`, `UnknownDependency`, `Cycle`, `message` đủ để gửi lại model làm `ToolError`); `nextStep`, `isPlanResolved`.
- **Lệch so với phần A (đã sửa trong `loi-day-hoc.md`):** thêm event `SessionCreated` chụp hồ sơ dạy học; `StepSkipped` tính là đã giải quyết khi chọn bước; `Teaching.stepId` rỗng giữa event bước cuối và `SessionCompleted`; thử lại là `TurnStarted` mới, lịch sử chỉ lấy lượt đã hoàn tất; projection chặt với log sai.
- **Chưa chốt, để bước 3:** các trường của `AssessmentRecorded` (`level`, `summary`, `strengths`, `gaps`) là bản đầu, sửa được khi viết prompt Prober; side chat chưa có event lỗi riêng (lượt side chat lỗi thì bước 3 quyết); `UsageRecorded` chưa ghi model để tính chi phí.

## Bước 1: spike SQLite WASM và TanStack DB (2026-11-21)

Mã spike nằm ở `apps/web/src/spike/sqlite/`, route `/spike/sqlite` (`apps/web/src/routes/spike.sqlite.tsx`), kịch bản Playwright `apps/web/scripts/spike-sqlite.mjs` (kèm `spike-serve.mjs` để thêm header COOP/COEP). Chạy: `pnpm build && pnpm build:spa && pnpm exec playwright install chromium firefox webkit`, rồi `node scripts/spike-sqlite.mjs chromium|firefox|webkit`. Đã chạy trên Chromium, Firefox, WebKit của Playwright (trên máy macOS; chưa thử Safari hay WebView iOS thật, xem rủi ro 5). Xoá toàn bộ phần spike khi làm bước 5.

**Ứng viên (đọc tài liệu và phiên bản hiện hành trên npm ngày 2026-11-21):**

| Ứng viên | Phiên bản | Kết quả |
| --- | --- | --- |
| `@journeyapps/wa-sqlite` (fork của PowerSync) + `OPFSCoopSyncVFS`, Worker tự viết (`own-wa`) | 2.0.10 (đã thử cả 1.7.2) | **Chọn.** Không cần COOP/COEP, nhiều tab cùng mở được |
| `@tanstack/browser-db-sqlite-persistence` (`tanstack-wa`, dùng wa-sqlite 1.7.x + `OPFSCoopSyncVFS` trong Worker của gói) | 1.0.0-rc.1.5 | Chạy được, cùng đặc tính với `own-wa`; không chọn vì là RC, API chỉ có `execute` từng câu (không có batch trong Worker) và lint cấm `@tanstack/*` trong `packages/storage` |
| `@sqlite.org/sqlite-wasm`, VFS `opfs-sahpool` (`official-sahpool`) | 3.54.1-build1 | Chạy được, không cần header, nhưng **chỉ một tab mở được DB** (tab thứ hai lỗi `NoModificationAllowedError`) |
| `@sqlite.org/sqlite-wasm`, VFS `opfs` (`official-opfs`) | 3.54.1-build1 | Chỉ chạy khi trang `crossOriginIsolated` (COOP + COEP); loại |
| `wa-sqlite` (rhashimoto) | 1.0.0, sửa lần cuối 2024-01 | Bỏ: không còn được bảo trì |

**Trả lời C1:**

| Câu hỏi | Kết quả (đo trên bản build production, trừ khi ghi khác) |
| --- | --- |
| Cần Worker không? | Có. OPFS đồng bộ (`createSyncAccessHandle`) chỉ dùng được trong Worker; cả ba driver đều chạy trong Worker. Vite 8 đóng gói Worker `type: 'module'` và file `.wasm` (`?url`) không cần cấu hình thêm |
| Cần COOP/COEP không? | Không với `wa-sqlite` + `OPFSCoopSyncVFS` và `opfs-sahpool`. Chỉ VFS `opfs` của bản chính thức cần (không có header thì `crossOriginIsolated=false`, VFS không có) |
| Xung đột với iframe sandbox ở phase 5? | Có nếu bật COOP/COEP, nên **không bật**. Với `COEP: require-corp`: iframe `srcdoc` kế thừa COEP và `<img>` từ origin khác bị chặn (HTML do model sinh hay nạp tài nguyên ngoài, sẽ vỡ); iframe `src` phải tự gửi COEP, và Firefox còn chặn iframe sandbox `src` cùng origin dù có COEP (Chromium và WebKit cho chạy). Không có COEP: `<img>` ngoài tải được |
| Chạy ở bản SSR, bản SPA? | Chạy cả hai (cả dev), bản SSR không lỗi hydrate trên cả ba trình duyệt. Driver chỉ nạp bằng `import()` sau hydrate nên server không đụng tới Worker hay WASM. Lưu ý: nếu route import driver, bản server vẫn đóng gói chunk driver (asset `.wasm` nằm trong `.output/server`); bước 5 cần giữ driver sau một điểm vào chỉ dành cho client. Bản SPA mở thẳng `/spike/sqlite` qua static server fallback báo lỗi React #418 (hydrate lệch, vỏ SPA prerender cho `/`) trên WebKit mọi lần chạy và thỉnh thoảng trên Firefox, không trên Chromium; không liên quan SQLite (render chưa chạm driver), chưa điều tra, có thể ảnh hưởng deep link trong Capacitor (phase 6) |
| Hai tab cùng lúc? | `OPFSCoopSyncVFS`: cả hai tab mở và ghi đồng thời được (2 x 200 dòng, đủ 400, không lỗi) trên cả ba trình duyệt. Khi một tab giữ transaction ghi chưa kết thúc, tab kia **chờ vô hạn, không báo lỗi** tới khi tab đầu COMMIT hoặc ROLLBACK, nên transaction phải ngắn và chạy trọn trong Worker. `opfs-sahpool`: single writer thật sự, tab thứ hai không mở được cho tới khi tab đầu đóng. Đóng tab giữa transaction: dữ liệu chưa COMMIT mất sạch, dữ liệu cũ nguyên vẹn (cả bốn driver, cả ba trình duyệt) |
| Dung lượng, thời gian mở? | Xem bảng bên dưới. Mở DB lần đầu khoảng 16-40 ms trên Chromium/WebKit và 45-55 ms trên Firefox (localhost, đã gồm tải và biên dịch WASM; chưa gồm thời gian tải qua mạng thật). Dev chậm hơn (100-310 ms) vì Vite biên dịch theo yêu cầu |
| TanStack DB nằm trên driver này được không? | Xem phần TanStack DB bên dưới: không dùng ở phase 1 |

**Dung lượng (gzip -9, nạp lười, không vào chunk chính; chunk chính `index-*.js` 539 kB, tăng khoảng 0,5 kB do khai báo route):**

| Driver | JS | WASM | Tổng gzip |
| --- | --- | --- | --- |
| `own-wa` (Worker tự viết) | 87 kB (26 kB) | 1.122 kB (518 kB) | 545 kB |
| `tanstack-wa` | Worker 191 kB (39 kB) + phần phía trang nằm chung chunk `tanstack-db` 465 kB (120 kB, gồm cả `@tanstack/db`) | 1.130 kB (528 kB) | từ khoảng 570 kB, chưa kể phần `@tanstack/db` trong chunk chung |
| `official-sahpool` | 219 kB (65 kB) | 879 kB (406 kB) | 471 kB |

**Hiệu năng (Chromium, 1.000 dòng sự kiện 200 byte):** ghi cả lô trong một transaction chạy trong Worker khoảng 22-24 ms (`own-wa`, `official-sahpool`), khoảng 38-42 ms khi gửi từng câu qua `execute` của `tanstack-wa`; một INSERT riêng khoảng 2 ms. Mở lại sau khi tải lại trang khoảng 14-23 ms. Dữ liệu còn nguyên sau tải lại ở mọi driver.

**TanStack DB (1.0 RC, `1.0.0-rc.1.5`):**

- Tài liệu đi kèm gói nói rõ: chỉ chạy phía client, SSR chưa hỗ trợ, route dùng nó phải tắt SSR (`ssr: false` hoặc `ClientOnly`).
- Hai cách đặt lên SQLite, cả hai đã chạy thử (live query cập nhật, mỗi trình duyệt):
  - **Collection lưu bền bằng adapter của TanStack** (`persistedCollectionOptions`): chạy, hai tab đồng bộ nhau qua `BrowserCollectionCoordinator` (Web Locks + BroadcastChannel). Nhưng lưu mỗi collection thành bảng JSON (`key`, `value`, `row_version`) cộng 11 bảng sổ sách (`applied_tx`, `collection_registry`, ...): không phải schema quan hệ, server Node không dùng chung được. Event log của ta cần bảng quan hệ `events(session_id, seq, ...)` dùng chung với driver server ở phase 2, nên không dùng cách này.
  - **Collection đặt trên driver của ta** (`sync` đọc từ SQLite, `onInsert` gọi port ghi): chạy, đây là "store phản ứng đặt phía trên port". Port vẫn là nguồn sự thật.
- **Quyết định:** phase 1 không dùng TanStack DB. UI chỉ cần đọc event log của một buổi (chỉ ghi thêm) và dựng projection bằng `core`: một store nhỏ (cập nhật sau mỗi lần ghi, thêm BroadcastChannel cho tab khác) là đủ, không cộng thêm khoảng 120 kB gzip, bản RC và ràng buộc tắt SSR. Hướng B đã chứng minh chạy nên xem lại ở phase 3 (màn hình graph cần live query trên nhiều bảng).

**Hình dạng đề xuất cho port `storage` (bước 5):**

- Mọi lời gọi là bất đồng bộ (mỗi lần đi qua một message tới Worker), trả về `Effect`. Driver tạo bất đồng bộ (`open`), có `close`; `pagehide` giết Worker nên khi trang quay lại từ bfcache (`pageshow` với `persisted`) phải mở kết nối mới.
- **Không có transaction tương tác** (`begin`/`commit` qua nhiều message): transaction mở lâu chặn mọi tab khác. Đơn vị ghi là một lô: `appendEvents(sessionId, events[])` chạy `BEGIN IMMEDIATE ... COMMIT` trọn trong Worker. Ghi theo transaction của A3 chính là một lệnh này.
- Số thứ tự (`seq`) của event cấp bên trong transaction (`MAX(seq)+1` và `UNIQUE(session_id, seq)`), vì hai tab có thể cùng ghi vào một buổi.
- Có timeout cho mọi lời gọi và lỗi có kiểu: `StorageUnavailable` (không có OPFS: context tạm của WebKit trong Playwright, tương tự cửa sổ riêng tư, `getDirectory()` ném `UnknownError`; khi đó lùi về driver trong bộ nhớ kèm cảnh báo, port cho biết `persistent`), `StorageBusy` (chờ quá hạn vì tab khác), `StorageFailure`.
- Migration chạy trong Worker lúc mở (`PRAGMA user_version`); SQL nằm trong `packages/storage`, dùng chung với driver Node.
- Thông báo thay đổi giữa các tab: sau COMMIT, driver gửi tin qua `BroadcastChannel`; port lộ `changes` (Stream của Effect) để store phản ứng.
- Chỉ nhận và trả giá trị structured-clone được. Mã driver nằm ở `packages/storage/src/sqlite-wasm`; lint hiện cho phép Worker và `@journeyapps/*` ở đó, không cần ngoại lệ. Điểm vào chỉ dành cho client, không import khi SSR.
- Ghim `@journeyapps/wa-sqlite` cùng một phiên bản (cần thêm `'@journeyapps/wa-sqlite': false` vào `allowBuilds`: script `postinstall` chỉ tải lõi PowerSync, ta không dùng).

## Bàn giao (2026-11-21)

Bước 0 xong. Việc tiếp theo, làm song song ở hai chat mới: **bước 1** (spike SQLite WASM, câu hỏi C1) và **bước 2** (schema, projection trong `core`) của [loi-day-hoc.md](../loi-day-hoc.md).

- Ranh giới import (`packages/config/eslint.js`, bảng `internalAllow`):
  - `api`: chỉ `@kd-learn/core`, không API của Node, không UI.
  - `server`: `core`, `agent`, `ai`, `api`, `search`, `storage` (cả adapter); dùng được API của Node; không UI, không `tokens`, `ui`, `web`.
  - `storage`: driver dùng được API của host, chỉ import `core`; `storage/src/port` thuần như `ai/src/port` (chỉ `effect`).
- Port `storage` hiện còn trống; hình dạng đề xuất sau spike bước 1 ở phần "Bước 1" trên, chốt ở bước 5. Nếu port cần kiểu event từ `core`, nới rule port trong `eslint.js` và test tương ứng.

## Lưu ý khi chạy model thật

- Chạy thử 1 lượt, xem model và chi phí, rồi mới chạy hàng loạt. Spike đã đốt hạn mức 5 giờ của gói vì bỏ bước này (mỗi lượt Claude Code từng tốn khoảng 980k token).
- Claude Code qua ACP dùng chung hạn mức gói với phiên làm việc; ưu tiên Haiku cho script và test tay.
- Key API nằm trong `.env` ở gốc repo (không commit).

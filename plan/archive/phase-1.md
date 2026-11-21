# 8. Tiến độ phase 1

**Trạng thái: xong (2026-11-21).** Cả ba tiêu chí đạt bằng Haiku thật qua UI, xem phần "Bước 8".

## Phase 1 (cập nhật 2026-11-21)

Spike đã merge vào `main` (PR #2, sửa thêm ở PR #3, #4). Plan phần chính: [loi-day-hoc.md](loi-day-hoc.md) (quyết định nền đã chuyển vào [mục 3.5](../03-kien-truc.md)).

| Hạng mục | Trạng thái |
| --- | --- |
| Spike port AI ([spike-port-ai.md](spike-port-ai.md)) | Xong (2026-11-21). Rủi ro 1, 2 đạt |
| Bước 0: khung `storage`, `api`, `server` | Xong (2026-11-21). Lint ranh giới cho `storage`, `api`, `server` kèm test |
| Bước 1: spike SQLite WASM + TanStack DB | Xong (2026-11-21). Driver: `@journeyapps/wa-sqlite` + `OPFSCoopSyncVFS` trong Worker của ta; không dùng TanStack DB ở phase 1. Xem ghi chú bước 1 bên dưới |
| Bước 2: schema, projection (`core`) | Xong (2026-11-21). Xem ghi chú bước 2 bên dưới |
| Bước 3: vòng turn, Prober → Teacher, side chat (`agent`) | Xong (2026-11-21). A4 xác nhận bằng model thật. Xem ghi chú bước 3 bên dưới |
| Bước 4: API, server, SSE | Xong (2026-11-21). Hợp đồng `api`, handler `server`, route `/api/turns` và `/api/endpoints` trong `apps/web`, 1 lượt Haiku qua route. Xem ghi chú bước 4 bên dưới |
| Bước 5: DB local | Xong (2026-11-21). Port `storage` chốt, driver `wa-sqlite` trong Worker của `packages/storage`, store phía client, Playwright chính thức, mã spike đã xoá. Xem ghi chú bước 5 bên dưới |

| Bước 6: spike Markdown + KaTeX | Xong (2026-11-21). Chọn `Markdown` của Astryx + KaTeX; phần thắng đã thành `LessonMarkdown` ở bước 7, mã spike đã xoá. Xem ghi chú bước 6 bên dưới |
| Bước 7: UI | Xong (2026-11-21). Màn danh sách buổi, cài đặt, màn học (stream, plan, thử lại, bỏ qua bước, side chat), `LessonMarkdown`, vi + en, Playwright e2e, 1 lượt Haiku qua UI. Xem ghi chú bước 7 bên dưới |
| Bước 8: kiểm tiêu chí phase | Xong (2026-11-21). Ba tiêu chí đạt bằng Haiku thật qua UI, không phải sửa lỗi nào của app. Xem ghi chú bước 8 bên dưới |

## Bước 8: kiểm tiêu chí phase bằng model thật (2026-11-21)

**Cách kiểm:** `apps/web/scripts/acceptance.mjs` (giữ lại, **không chạy trong CI** vì tốn tiền). Script chạy bản build SSR, mở Chromium, nhập key ở màn cài đặt như khách, học chủ đề "Adding fractions with different denominators" bằng `claude-haiku-5-5`. Người học là một lời gọi Haiku thứ hai (vai học sinh), vì câu trả lời soạn sẵn không dùng được: Teacher từ chối `complete_step` khi người học không trả lời câu nó vừa hỏi (lần chạy đầu với câu soạn sẵn: 15 lượt dạy không xong bước nào, nút bỏ qua hiện sau 6 lượt đúng như thiết kế). Cách chạy: `pnpm build`, rồi `KD_LEARN_ENV_FILE=<đường dẫn .env> node apps/web/scripts/acceptance.mjs` (`--first-turn` chạy 1 lượt để xem model và chi phí; trần mặc định 60 lượt hoặc 0,50 USD). Script tự bật và tắt server, không in key.

**Kết quả ba tiêu chí (lần chạy cuối; bốn lần chạy với người học giả lập đều tới `done`, hai lần đầu với câu soạn sẵn thì không):**

| Tiêu chí | Kết quả |
| --- | --- |
| Khách tự nhập key | Đạt: nhập ở `/settings`, lượt đầu chạy bằng `claude-haiku-5-5` (1.091 token vào, 33 ra). Key không có trong nội dung trang |
| Học xong 1 chủ đề | Đạt: `probing` (4 câu hỏi, đúng N = 4) → `submit_assessment` → plan 4 bước → 4 lần `complete_step` → `SessionCompleted` → `done` |
| Tải lại không mất dữ liệu | Đạt cả hai chỗ. Giữa lượt: hiện "bị ngắt", câu trả lời còn nguyên và hiện đúng một lần, không tự gửi lại, plan còn, thử lại xong lượt. Sau `done`: số tin nhắn, trạng thái từng bước, toàn bộ chữ giống hệt trước khi tải lại (sau khi KaTeX nạp xong), buổi còn trong danh sách |

**Số liệu lần chạy cuối:** 16 request (14 lượt chính, 1 side chat, 1 lượt bị ngắt rồi thử lại), 63.202 token vào, 5.806 ra, 0,0092 USD cho Tutor; người học giả lập 15.131 vào, 1.128 ra, 0,0021 USD. Mỗi lượt 1 đến 6 giây. Tổng sáu lần chạy (gồm hai lần lỗi ở script): 88 request, khoảng 0,054 USD.

**Model có gọi tool đúng lúc không (rủi ro 18): có.** `submit_assessment` đúng ở câu trả lời thứ 4 (N = 4); `create_plan` ở lượt tự chạy ngay sau đó; `complete_step` chỉ khi người học trả lời đúng câu hỏi kiểm tra của bước (mỗi bước 1 đến 2 lượt); bước cuối kèm `SessionCompleted` trong cùng lượt. Khi người học chỉ nói "tôi hiểu rồi" hoặc trả lời lạc đề, model không gọi `complete_step`. Không lần nào gọi sai trạng thái hay bị `ToolError`.

**Kích thước và token theo lượt (A8):** thân request tăng tuyến tính, 5,0 KB ở lượt 1 lên 25,2 KB ở lượt 16 (khoảng 1,3 KB mỗi lượt), nên giới hạn 1 MiB tới sau cỡ 750 lượt: `HistoryTooLarge` không xuất hiện sớm. Token vào tăng khoảng 150 đến 400 mỗi lượt (1,1k ở lượt 1, khoảng 4,5k ở lượt 15 với lượt không gọi tool). Lượt có gọi tool tốn gấp đôi (hai lần gọi model: tool, rồi câu trả lời): 9,9k token vào ở lượt 16. Chưa cần tóm tắt lịch sử cho buổi cỡ này.

**M = 6:** hợp lý như lối thoát. Với Haiku, mỗi bước chỉ 1 đến 2 lượt nên nút không bao giờ hiện khi người học trả lời đúng; nó chỉ hiện khi người học không tiến (lần chạy đầu, sau 6 lượt). Chưa có dữ liệu với người học thật; không đổi.

**Side chat:** đạt: trả lời bám bước hiện tại (có cả 3 lần chạy), không thêm tin vào luồng chính, `SideMessageAppended` mang `usage`.

**Lỗi và điểm lệch:** app không có lỗi chặn tiêu chí. Ghi lại ở [06-viec-mo.md](../06-viec-mo.md): (1) sau khi `done`, panel side chat chỉ hiện luồng `general` nên các câu hỏi cũ ở luồng từng bước còn trong log nhưng không xem lại được; (2) sau tải lại, công thức hiện mã TeX thô một thoáng cho tới khi KaTeX (nạp lười) xong. Lỗi của script, không phải của app: Haiku 5.5 từ chối `temperature`, và `max_tokens` thấp có lần cho ra chuỗi rỗng (nghi suy nghĩ chiếm hết; đã tắt suy nghĩ và nâng trần).

**Chưa kiểm được ở đây:** thiết bị thật (Safari/iOS, Chrome điện thoại, bfcache thật, bàn phím ảo, hai tab thật). Không thuộc tiêu chí phase 1; còn mở ở [rủi ro 5](../05-rui-ro.md) và phase 6.

## Bước 7: UI cho khách (2026-11-21)

**Màn hình** (`apps/web/src`, mọi chuỗi qua Paraglide, vi + en; bố cục `Layout` của Astryx trong `AppShell`):

| Route | Có gì |
| --- | --- |
| `/` | Ô nhập chủ đề tạo buổi học mới (ghi `SessionCreated` với `defaultProfile` và `language` = ngôn ngữ giao diện, rồi mở màn học), danh sách buổi học, báo "thêm API key" khi chưa có key, cảnh báo khi lưu trữ không bền. Thay màn demo theme của phase 0 |
| `/settings` | Chọn nhà cung cấp (`anthropic`, `gemini`, `openai-compatible` theo id endpoint từ `GET /api/endpoints`), model, key (`type=password`, không hiện lại; để trống khi lưu thì giữ key cũ), nút xoá key, cảnh báo lưu trữ không bền |
| `/s/$sessionId` | Màn học: plan (cột trái từ 768 px, gập thành `Collapsible` ở khổ điện thoại), hội thoại, ô trả lời, side chat (cột phải từ 1180 px, `Drawer` ở khổ nhỏ hơn), các banner trạng thái lượt |
| `/dev/storage` | **Giữ lại** cùng `e2e/storage.e2e.ts`: test UI không phủ được lô nguyên tử, `id` trùng, hàng đợi trong Worker |

**Luồng một lượt** (`apps/web/src/learn/runner.ts`, TypeScript thuần, không React): mỗi buổi có một `SessionRunner` ở mức module nên lượt vẫn chạy khi màn hình bị huỷ; màn hình chỉ đăng ký trạng thái (`useSyncExternalStore`).

1. Lấy Web Lock `kd-learn:turn:<sessionId>` (`ifAvailable`) từ trước `TurnStarted` đến sau lô cuối. Tab không lấy được khóa thì không gửi gì và hiện "đang chạy ở tab khác". Khóa tự nhả khi tải lại hay đóng tab, điều mà cờ trong DB không làm được.
2. Thiếu key, model hay endpoint thì **không ghi gì** (lỗi `NoKey`), để lượt tự chạy không để lại `TurnStarted` treo.
3. Ghi `TurnStarted` (A3), gọi `streamTurn`, hiện `delta`, gom `event`.
4. Nhận `done`: ghi cả lô một lần. Frame `error` không kèm `TurnFailed` (lỗi HTTP như `HistoryTooLarge`, `UnknownEndpoint`) thì client tự thêm `TurnFailed` vào lô, nên lỗi còn nguyên sau khi tải lại.
5. `ClientError` hay stream đứt trước `done`: không ghi gì, lượt còn mở là "bị ngắt"; nút thử lại gửi cùng input trong `TurnStarted` mới.
6. Sau lượt xong, nếu `shouldAutoStart` (buổi mới chưa có lượt, hoặc lượt cuối `completed` và `needsAgentTurn`) thì chạy tiếp ngay. **Không bao giờ tự chạy sau lượt lỗi hay bị ngắt**, kẻo key sai làm lặp vô hạn.

**Ghi an toàn:** log chỉ ghi thêm và projection chặt, nên một lần ghi sai làm hỏng buổi học mãi mãi. Trước mỗi lần ghi client chạy `projectSession([...log, ...lô])`; không qua thì bỏ, báo `InvalidLog`. Gặp `StorageBusy` (kết quả chưa rõ): đọc lại log xem lô đã vào chưa, chưa thì ghi lại.

**Bỏ qua bước:** nút hiện khi `canSkipStep`. Lỗ hổng của `core`: `StepSkipped` không cần lượt, còn `SessionCompleted` đòi `turnId`, nên bỏ qua bước cuối không kết thúc được buổi. Sửa: `SessionCompleted.turnId` thành tuỳ chọn (không có = người học bỏ qua bước cuối); client ghi `StepSkipped` + `SessionCompleted` trong một lô (có test ở `core` và runner).

**Side chat:** mỗi bước một luồng (`step:<stepId>`, trước khi có bước là `general`), khóa riêng `kd-learn:side:<sessionId>` nên không chặn lượt chính; lỗi sinh `SideTurnFailed`; thử lại không thêm tin người học thứ hai.

**`LessonMarkdown`** (`packages/ui/components`): `Markdown` của Astryx + KaTeX nạp lười qua `components.math` (`trust: false`, `strict: 'ignore'`, `maxSize`, `maxExpand`), `memo`. Quyết định:

- **Ảnh** (rủi ro 21): `components.image` chỉ hiện chữ alt, không bao giờ có `<img>` hay request (test e2e đếm request tới host lạ).
- **Link:** chỉ link tuyệt đối `http(s)` là link (tab mới, `rel="noopener noreferrer nofollow"`, không referrer); `mailto:`, đường dẫn tương đối hiện thành chữ.
- **Font KaTeX:** plugin Vite `kd-katex-woff2-only` cắt nguồn woff và ttf khỏi `katex.min.css`: chỉ còn 19 file woff2 (khoảng 256 kB).
- `katex` chuyển sang `packages/ui`; `apps/web` bỏ `katex`, `@tanstack/markdown`. Mã spike, route `/spike/markdown` và script đã xoá.

**Hồ sơ mặc định:** export mới `@kd-learn/agent/client` (`defaultProfile`, `needsAgentTurn`) để bundle client không kéo vòng turn.

**bfcache:** khi `pageshow` với `persisted`, `getStorage()` bỏ kết nối cũ và tăng `epoch`; `useStorageQuery` phụ thuộc `epoch` nên đăng ký lại. **Chưa kiểm trên trình duyệt thật** (Playwright không mô phỏng được): để bước 8.

**React #418 trên bản SPA (đã sửa):** vỏ SPA prerender ở ngôn ngữ gốc (vi) còn client chọn ngôn ngữ trình duyệt, nên lần render đầu không khớp HTML ở mọi trình duyệt có ngôn ngữ khác vi (không riêng WebKit). Sửa: ở bản SPA (`VITE_KD_SPA` trong `vite.config.ts`) cây app bọc trong `ClientOnly`. Kiểm `/`, `/settings`, `/s/abc` mở thẳng trên Chromium, Firefox, WebKit, bản SPA và SSR: không còn lỗi. Chromium headless không gửi `Accept-Language` thì SSR chọn vi, client chọn en và vẫn lệch; trình duyệt thật luôn gửi nên e2e đặt `locale: 'en-US'`.

**Bản SPA gọi API:** thêm `VITE_KD_API_BASE_URL` (mặc định rỗng = cùng origin). CORS phía server và vỏ Capacitor vẫn thuộc phase 6.

**Không làm:**

- `deleteSession`: cần migration đổi trigger chặn DELETE, không rẻ. Danh sách chưa có nút xoá buổi.
- Nút dừng lượt đang chạy; danh sách buổi dạng link thật.
- e2e ở WebKit: Playwright WebKit không có OPFS, các test cần DB tự bỏ qua. CI giữ Chromium.

**Test:** `apps/web/src/learn/runner.test.ts` (16 test Vitest, server giả và `makeMemoryStorage`); `packages/core` thêm 1 test bỏ qua bước cuối; `apps/web/e2e/learn.e2e.ts` (13 test, Chromium và Firefox đều đạt, server giả `e2e/fake-server.ts` chặn `**/api/turns`): toàn bộ buổi học đến `done` kèm kiểm Markdown, tải lại giữa lượt hiện "bị ngắt" và thử lại đúng một lần, tải lại sau khi xong vẫn đủ dữ liệu, mất kết nối, hai tab, `HistoryTooLarge`, `UnknownEndpoint`, không key, side chat, khổ điện thoại 390 px, cài đặt lưu/xoá key, danh sách endpoint, cảnh báo lưu trữ không bền.

**Chạy thật 1 lượt Haiku qua UI** (`claude-haiku-5-5`, 0,10 / 0,50 USD mỗi triệu token): script Playwright tạm, không trace, video hay ảnh chụp. Nhập key ở cài đặt, tạo buổi "Basic fractions"; Prober tự chạy, tutor hỏi một câu hợp lý (chia pizza 4 phần). Log: `SessionCreated`, `TurnStarted`, `MessageAppended`, `UsageRecorded`, `TurnCompleted`. 1.086 token vào, 59 ra, khoảng 0,00014 USD, 1,3 giây. Key không có trong trang, log lưu trữ hay log server.

**Kiểm khác:** `astryx doctor` không lỗi; `check:server-bundle` sạch; build không còn `.woff`/`.ttf` của KaTeX; boundary lint xanh.

## Bước 6: spike Markdown và KaTeX khi stream (2026-11-21)

Mã spike nằm ở `apps/web/src/spike/markdown/`, route `/spike/markdown` (`apps/web/src/routes/spike.markdown.tsx`), kịch bản Playwright `apps/web/scripts/spike-markdown.mjs`. Chạy: `pnpm build && pnpm build:spa`, rồi `node scripts/spike-markdown.mjs chromium|firefox|webkit [out.json] [thư mục ảnh chụp]`. Đã chạy trên Chromium, Firefox, WebKit của Playwright (macOS). **Đã làm ở bước 7: mã spike (kể cả `@tanstack/markdown`, route `/spike/markdown`, script) đã xoá, phần thắng thành `LessonMarkdown`.**

**Ứng viên (đọc tài liệu và phiên bản hiện hành trên npm ngày 2026-11-21):**

| Ứng viên | Phiên bản | Kết quả |
| --- | --- | --- |
| `@tanstack/markdown` (không phụ thuộc, có extension) | 1.2.1 | Không có cú pháp công thức. Phải tự viết extension `$...$` / `$$...$$` (khoảng 80 dòng), hàm giữ lại cú pháp dở dang khi stream (khoảng 110 dòng), CSS; chế độ stream chỉ cắt heading và list rỗng ở cuối. Không có style, không tô màu code (cần TanStack Highlight) |
| `Markdown` của Astryx (`isStreaming`, `components.math`) + `katex` | Astryx 0.7.16, KaTeX 0.19.1 | **Chọn.** Có sẵn: parse công thức khi truyền `components.math`, giữ lại `$`/`$$`/bảng/in đậm dở dang khi stream, làm mượt chữ theo khung hình (`useStreamingText`), style theo theme, `CodeBlock` tô màu, bảng cuộn được |

Cả hai không cần `allowBuilds` (không có script cài đặt).

**Trả lời C2:**

| Câu hỏi | Kết quả (mỗi lần: 331 chunk, 1.455 ký tự, một chunk mỗi 25 ms; chạy cả bản SSR và SPA, cả ba trình duyệt, số khớp nhau) |
| --- | --- |
| TanStack Markdown hiển thị công thức khi stream? | Chỉ với extension tự viết. Hiển thị đúng khi đủ cú pháp, nhưng thô thì lộ cú pháp dở dang: `$` thấy được ở 88 khung hình, `\` ở 30, `\|` ở 23, khối `$$` chưa đóng hiện chữ nguồn (66 khung hình), 2 công thức bị dựng lại, 2 lần nội dung co lại (tối đa 26 px, một lần khi mở khối code). Có hàm giữ lại phần dở dang thì hết `$`, `\`, `\|`, hết dựng lại, còn `**` lộ 14 khung hình và một lần co 26 px |
| Astryx `Markdown` + KaTeX khi stream? | Không lộ `$`, `\`, `*`, `\|` (chỉ dấu backtick mở của code inline, 3 khung hình), không dựng lại công thức, không co nội dung, không có placeholder. Hiển thị chậm hơn chunk tới tối đa 6-7% văn bản, hết chậm lúc chunk cuối, khi kết thúc stream không nhảy (0 ký tự, 0 px). Kết quả cuối khớp bản dựng một lần (khác ở class, style, id của animation). Chữ `$5 hoặc $10` giữ nguyên là chữ |
| Escape HTML mặc định? | Có, cả hai. Bộ thử độc hại (script, `<img onerror>`, iframe srcdoc, svg onload, `<a href=javascript:>`, link và ảnh Markdown `javascript:`/`data:`, thực thể, ô bảng, danh sách, `<style>`) hiện thành chữ, không có phần tử script/iframe/svg/style, thuộc tính `on*` hay URL `javascript:` ở khung hình nào (MutationObserver), `window.__pwned` không bị đặt, không có hộp thoại, bấm mọi link không gây gì. Link `javascript:` bị bỏ thành chữ. KaTeX với `trust: false`: `\href`, `\url`, `\htmlClass`, `\includegraphics` không hoạt động, vòng `\def` dừng nhờ `maxExpand`. **Còn lại: ảnh `![](https://...)` vẫn được tải** (Firefox ghi nhận request tới ngoài), xem rủi ro 21 |
| Bản SSR, SPA? | Render tĩnh cả đoạn ở lần render đầu, bản SSR không lỗi hydrate (cả ba trình duyệt), số công thức, bảng, khối code khớp. Mở thẳng `/spike/markdown` trên bản SPA bị React #418 ở WebKit, y như `/spike/sqlite` ở bước 1 (không liên quan Markdown) |

**Đo (Chromium; 1.455 ký tự = 331 chunk mỗi 25 ms, và 7.275 ký tự = 1.624 chunk mỗi 8 ms):**

| | TanStack + extension | Astryx |
| --- | --- | --- |
| CPU luồng chính cả lượt (1.455 ký tự), `TaskDuration` | 791 ms (2,4 ms/chunk; script 29, layout 127) | 1.605 ms (4,8 ms/chunk; script 527, layout 132) |
| CPU, đoạn dài 5 lần | 3.469 ms (2,1 ms/chunk) | 5.203 ms (3,2 ms/chunk) |
| `flushSync` mỗi chunk (phần đồng bộ) | 0,7-0,8 ms (Firefox 1,2-1,7; WebKit 0,8-1,0) | 1,0-1,1 ms (Firefox 1,7-2,5; WebKit 1,2-1,6) |
| Khung hình tối đa | 16,8-33 ms (Firefox 25-33; WebKit 28-39), không khung nào quá 33 ms ở Chromium | 16,8 ms (Firefox 17-33; WebKit 35-47), tối đa 3 khung quá 33 ms trong một lượt ở WebKit |
| Bundle nạp lười (gzip -9) | 19,8 kB (7,6 kB), đã gồm extension | 308 kB (102 kB: `Markdown`, parser, `CodeBlock`, `Table`) |

Dùng chung: KaTeX JS 260 kB (76,6 kB gzip), CSS 30 kB (7,9 kB gzip), 19 font woff2 tổng 256 kB (trình duyệt chỉ tải font dùng tới); bản build còn chép thêm woff 303 kB và ttf 514 kB không dùng tới. Chunk chính `index-*.js` 539,5 kB trước, 554,8 kB sau (khoảng 15 kB, 4,5 kB gzip, do mã route spike; mất khi xoá spike). CPU lúc nghỉ 10 s: 0,8 ms, nên số CPU là của chính lượt stream. CPU của Astryx gấp khoảng hai lần, vẫn thoải mái so với ngân sách khung hình.

**Việc cho bước 7 (đã làm, xem ghi chú bước 7):**

- Component thật `LessonMarkdown` (đặt trong `packages/ui`): `Markdown` của Astryx với `isStreaming`, `components.math` dựa trên KaTeX nạp lười. KaTeX: `trust: false`, `strict: 'ignore'`, `maxSize`, `maxExpand`, `throwOnError: false`; bọc phần công thức bằng `memo` và cache kết quả (như `math.tsx`). Không cần `stabilize.ts` (Astryx đã giữ lại cú pháp dở dang).
- Chặn ảnh từ model: ghi đè `components.image` (hiện chữ hoặc link, không tải), vì ảnh ngoài là kênh rò rỉ dữ liệu và theo dõi (rủi ro 21). Quyết định link: `onLinkClick`, mở ngoài kèm `rel="noopener noreferrer"`.
- Giảm KaTeX: dùng bản CSS chỉ khai báo woff2 (bản build chép thừa woff và ttf, tới 817 kB, nặng cho gói Capacitor). Chọn ngôn ngữ UI cho `aria` của công thức nếu cần.
- Highlight và Pacer ở [mục 2.5](../02-ky-thuat.md) không cần cho bài dạy; xoá `@tanstack/markdown` khỏi `apps/web/package.json`. Lượt Teacher lỗi giữa chừng (stream bị ngắt): kiểm lại `isStreaming` trở về `false`.

## Bước 4: API và server (2026-11-21)

Test: `packages/api` (14: hợp đồng, parser SSE, client) và `packages/server` (36: handler, hợp đồng đầu cuối bằng client thật, huỷ, giới hạn, không lộ key, cấu hình). Chạy thật 1 lượt Haiku (`claude-haiku-5-5`) qua bản build SSR (`node .output/server/index.mjs`, route `/api/turns`): 1.080 token vào, 49 ra, khoảng 0,00013 USD; có `MessageAppended`, `UsageRecorded`, `TurnCompleted`, `done`; phản hồi và log của server không chứa key.

**Hợp đồng (`@kd-learn/api`, Effect Schema, không API của Node):**

- `POST /api/turns`, body `TurnRequest {model, turn, log}`:
  - `model` là `ModelChoice`: `{provider: 'anthropic'|'gemini', model, apiKey}` hoặc `{provider: 'openai-compatible', endpointId, model, apiKey}`. Không có trường `baseURL`; ACP không có trong hợp đồng (chỉ chế độ tài khoản).
  - `turn` là `{kind: 'main'}` hoặc `{kind: 'side', threadId}`. `log` là `EventLog` của `core`, kết thúc bằng `TurnStarted` mở (main) hoặc tin của người học (side). Không có trường `input` riêng (lấy từ `TurnStarted` cuối log).
- Phản hồi 200 là SSE, mỗi message `event: <tag>` + `data: <json>`. `Frame` là `delta {messageId, delta}` | `event {event}` | `error {error: {code, message, retryable}}` | `done {outcome: 'completed'|'failed'}` (tag nằm ở `_tag`, như event của `core`). `done` luôn là frame cuối.
- Lỗi trước khi có stream là HTTP lỗi với body `ErrorBody {error}`: 400 `InvalidRequest` / `UnknownEndpoint`, 405 `MethodNotAllowed`, 413 `HistoryTooLarge`, 500 `ServerMisconfigured` / `InternalError`. `InvalidTurn` (log không bắt đầu được lượt) và lỗi provider đi trong stream (`error` + `done`).
- `GET /api/endpoints` trả `{endpoints: [{id, label}]}` (không lộ `baseURL`) để UI hiện danh sách chọn.
- Client có kiểu (chạy cả trình duyệt và Node): `streamTurn(request, {baseUrl?, fetch?})` trả `Stream<Frame, ClientError>`; lỗi HTTP được đổi thành frame `error` + `done` nên chỉ có một đường xử lý; stream đứt trước `done` thì `ClientError` loại `Protocol` (UI coi là lượt bị ngắt, A3); ngắt (interrupt) stream thì huỷ `fetch`. `listEndpoints({baseUrl?, fetch?})`. `packages/api` dùng tsconfig có DOM.

**Server (`@kd-learn/server`, Node, hàm `Request -> Response` để host nào cũng gắn được):**

- `config.ts`: `loadConfig(env)` đọc `KD_OPENAI_COMPATIBLE_ENDPOINTS` (mảng JSON `{id, baseURL, label?}`; chỉ http/https, không nhúng user/mật khẩu, id không trùng), `KD_MAX_REQUEST_BYTES` (mặc định 1 MiB, tối thiểu 1024), `KD_CORS_ORIGINS` (danh sách origin, mặc định rỗng). Cấu hình sai thì mọi route trả 500 `ServerMisconfigured` kèm một dòng log nêu tên biến (không nêu giá trị).
- `handler.ts`: `createHandlers(env, {ai?, log?, newId?})` trả `{turns, endpoints}`. Thứ tự xử lý: đọc body có giới hạn (dừng đọc khi vượt, kể cả khi không có `content-length`) → JSON → từ chối `baseURL` tự do (mọi kiểu chữ hoa thường) → decode `TurnRequest` với `onExcessProperty: 'error'` (trường lạ bị từ chối, không bị bỏ) → tra `endpointId` trong danh sách (không có thì 400 `UnknownEndpoint`) → dựng `ModelRef` → `runTurn` / `runSideChat` với `layer` của adapter TanStack → SSE. AiPort thay được bằng layer giả khi test.
- Huỷ: body SSE là `Stream.toReadableStream`; client ngắt (runtime huỷ body) hoặc `request.signal` abort thì fiber bị ngắt, adapter huỷ request tới provider. Log `turn.end` ghi `outcome: cancelled`.
- Không lộ key (A7, rủi ro 19): không bao giờ log request, header hay body; log chỉ nhận trường vô hướng (`kind`, `provider`, `endpointId`, `requestBytes`, `outcome`, `events`, `durationMs`, `code`); lỗi decode chỉ nêu đường dẫn và loại, không nêu giá trị (giá trị có thể chính là key); mọi `error` frame và `TurnFailed` / `SideTurnFailed` được thay key bằng `[redacted]` thêm một lần nữa ở server; defect (exception) trả thông báo cố định, chi tiết (đã bỏ key, cắt 200 ký tự) chỉ vào log; handler bọc try/catch trả 500 cố định.
- CORS tối thiểu: chỉ origin trong `KD_CORS_ORIGINS` được thêm header `access-control-*`; trả 204 cho preflight `OPTIONS`.

**`apps/web`:** `src/routes/api.turns.ts`, `src/routes/api.endpoints.ts` (server route của TanStack Start) và `src/api-handlers.ts` (nạp `@kd-learn/server` bằng `import()` lười, dựng handler một lần từ `process.env`). Bản client và bản SPA không chứa mã server (đã grep `KD_OPENAI_COMPATIBLE_ENDPOINTS` trong `.output/public` và `dist/client`).

**Bản SPA (Capacitor) chưa gọi được API:** bản SPA là tĩnh, không có route `/api`. Client phải gọi một server SSR đã triển khai qua `baseUrl` (cấu hình lúc build hoặc trong cài đặt), và server đó phải đặt `KD_CORS_ORIGINS` có origin của vỏ Capacitor (`capacitor://localhost` trên iOS, `https://localhost` hoặc `http://localhost` trên Android). Chưa có cấu hình `baseUrl` phía app; làm ở bước 7 hoặc phase 6. Bản web SSR cùng origin thì để `baseUrl` rỗng.

**Quyết định và lệch so với bàn giao:**

- Lỗi trước stream (decode, `HistoryTooLarge`, endpoint lạ) là HTTP 4xx, không phải frame `error` (client đổi lại thành frame); chỉ lỗi trong lượt đi bằng SSE. Lý do: từ chối sớm, không cần mở stream, và 413 có nghĩa cho proxy.
- `GuestSettings.baseURL` của port `storage` (bước 5) đổi thành `endpointId` (khoá `endpointId` trong bảng `settings`) cho khớp A6.
- Chưa có keep-alive định kỳ trong SSE; model nghĩ lâu có thể bị proxy ngắt kết nối nhàn rỗi. Thêm nếu gặp.
- Chưa giới hạn tốc độ hay xác thực: khách dùng key riêng, server không có gì để bảo vệ ngoài tài nguyên tính toán. Cần trước khi triển khai công khai.

## Bước 5: DB local (2026-11-21)

**Port `storage`** (`@kd-learn/storage/port`, chỉ import `effect` và kiểu từ `@kd-learn/core`). Dịch vụ `Storage` (`Context.Service`) có:

| Thành phần | Ý nghĩa |
| --- | --- |
| `persistent` | `false` với driver bộ nhớ (lùi khi không có OPFS); UI nên cảnh báo |
| `appendEvents(sessionId, events[])` | Một lô, nguyên tử: ghi hết hoặc không ghi gì. `seq` cấp trong transaction. `id` event là duy nhất: trùng `id` thì cả lô thất bại. Trả `{ lastSeq }` |
| `readSession(sessionId)` | `EventLog` theo thứ tự `seq`, giải mã bằng schema `DomainEvent` của `core` (dòng hỏng cho `StorageFailure`) |
| `listSessions` | `SessionSummary` (`sessionId`, `topic`, `createdAt`, `updatedAt`, `eventCount`), mới cập nhật nhất trước |
| `getSettings`, `saveSettings`, `deleteApiKey` | `GuestSettings` (`provider`, `model`, `endpointId?`, `apiKey?`; `endpointId` là id endpoint server cho phép, không phải URL, A6). `saveSettings` thay cả bộ (thiếu `apiKey` thì xoá key); `deleteApiKey` chỉ xoá key (A7) |
| `changes` | `Stream` của `SessionChanged {sessionId}` / `SettingsChanged`, gồm cả commit từ tab khác (BroadcastChannel); mỗi người nghe một hàng đợi riêng |

- Lỗi có kiểu (`Data.TaggedError`): `StorageUnavailable` (không mở được: không OPFS, không Worker), `StorageBusy` (quá hạn, mặc định 8 giây; với ghi thì kết quả chưa rõ, đọc lại để biết), `StorageFailure` (bị từ chối, lô không ghi gì).
- Không có transaction tương tác. Không có xoá hay sửa event; bảng `events` còn có trigger chặn UPDATE và DELETE.
- Lệch so với đề xuất ở bước 1: không có `open`/`close` trong port (đó là việc của driver: `openWasmStorage()` trả `StorageService & { close }`); thêm `appendEvents` trả `lastSeq`.

- Worker xử lý **từng yêu cầu một** (hàng đợi `queue.then`): kết nối dùng chung và một transaction trải qua nhiều `await`, nên nếu hai yêu cầu chồng nhau thì `BEGIN` thứ hai lỗi và `ROLLBACK` của nó huỷ lô thứ nhất (đã tái hiện bằng test). Thứ tự xử lý là thứ tự gửi.

**Cấu trúc code (`packages/storage`):**

| Đường dẫn | Việc |
| --- | --- |
| `src/port/` | Port thuần ở trên |
| `src/sqlite/schema.ts` | Schema và migration (`PRAGMA user_version`, mỗi migration chạy một lần trong `BEGIN IMMEDIATE`, đọc lại version trong transaction nên hai tab mở DB mới cùng lúc vẫn đúng). Dùng chung cho `sqlite-node` ở phase 2. Bảng `events (session_id, seq, id UNIQUE, tag, at, payload JSON)` và `settings (key, value)`. DB mới hơn code thì từ chối mở |
| `src/sqlite-wasm/worker.ts` | Worker giữ DB (wa-sqlite + `OPFSCoopSyncVFS`); mỗi thao tác là một lệnh cấp cao, lô ghi chạy trọn trong Worker |
| `src/sqlite-wasm/index.ts` | `openWasmStorage(options)`: bọc Worker thành `StorageService`, timeout, giải mã, BroadcastChannel. Export `@kd-learn/storage/sqlite-wasm` |
| `src/memory/` | `makeMemoryStorage()`: test và đường lùi khi không có OPFS |

`@journeyapps/wa-sqlite` ghim `2.0.10` trong `packages/storage` (`allowBuilds` vẫn tắt).

**Bundle server sạch:** `apps/web/src/storage/client.ts` chỉ nạp driver bằng `import()` bên trong `if (!import.meta.env.SSR)`. Vite thay cờ bằng hằng nên bản server bỏ hẳn nhánh đó, Worker và `.wasm` chỉ nằm ở `.output/public`. `apps/web/scripts/check-server-bundle.mjs` (chạy trong CI sau build) báo lỗi nếu `.output/server` có file `.wasm` hay mã của driver. Đã kiểm trên bản build thật: sạch. (Với bản SPA không có server nên không áp dụng.)

**Store phía client (`apps/web/src/storage`):** `getStorage()` mở một lần cho mỗi trang, chỉ lùi về bộ nhớ kèm `console.warn` khi `StorageUnavailable` (không có OPFS hay Worker); `StorageBusy` (mở quá 15 giây) và `StorageFailure` (migration lỗi, DB mới hơn code) được ném ra, không lưu vào bộ nhớ đệm của trang, lần gọi sau mở lại, đặt lại kết nối sau `pageshow` với `persisted`. `runStorage(f)` chạy một lời gọi. Hook `useStorageQuery` (đọc, rồi đọc lại khi `changes` có thay đổi liên quan), `useSessionList`, `useSession(id)` (trả `log` và `projectSession(log)`), `useGuestSettings`. React và Effect thuần, không thư viện query. Route `/dev/storage` là bàn thử cho Playwright (gắn `window.__kdStorage`), không nối vào app; bỏ khi UI bước 7 test trực tiếp được.

**Playwright (chốt ở bước 5):** dùng `@playwright/test` trong `apps/web` (`playwright.config.ts`, `e2e/*.e2e.ts`, `pnpm --filter @kd-learn/web exec playwright test`), chạy trên bản build SSR (`.output/server`, cổng 4173). Bảy test: ghi, tải lại, đọc lại (kèm projection bằng `core`); lô lỗi không để lại gì và `seq` không bị hổng; `id` trùng bị từ chối; cài đặt và xoá riêng key; hai tab ghi đồng thời 2 x 20 lô vào một buổi (đủ 80 event, không trùng, mỗi lô nằm liền nhau); commit ở tab này làm hook ở tab kia cập nhật; nhiều lời gọi chồng nhau trong một tab (12 lô, một lô cố ý lỗi, kèm đọc và lưu cài đặt cùng lúc) vẫn chạy lần lượt, lô lỗi không ảnh hưởng lô khác và lần đọc nào cũng thấy trọn lô. Test cuối này đã kiểm: bỏ hàng đợi trong Worker thì nó đỏ. **CI cài Chromium** (`playwright install --with-deps chromium`) và chạy `--project=chromium`; Firefox chạy được ở máy local (đạt cả bảy); WebKit của Playwright dùng context tạm không có OPFS, storage lùi về bộ nhớ nên test tự bỏ qua (riêng Chromium thì bắt buộc có OPFS, không được bỏ qua). Thiếu: Safari và WebView iOS thật (rủi ro 5).

**Lệch và việc còn mở cho bước 7:**

- Chưa có cách xoá một buổi học (port chưa có `deleteSession`; trigger chặn DELETE). Nếu UI cần, thêm thao tác này kèm migration đổi trigger khi làm bước 7.
- Chưa có cách xuất hay nhập dữ liệu, và chưa có đồng bộ lên server (phase 2).
- bfcache mới nối một nửa: `pageshow` chỉ đặt lại `getStorage()`, còn hook đang gắn vẫn giữ kết nối và đăng ký `changes` cũ, và chưa kiểm là Worker có thật sự chết khi trang vào bfcache. Bước 7 (hoặc bước 8) cần kiểm bằng trình duyệt và cho hook đăng ký lại.
- `SessionSummary.topic` đọc từ `SessionCreated`; buổi chưa có event này cho `topic` rỗng.
- Cảnh báo `persistent: false` (UI) và việc ghi `TurnStarted` trước request, ghi cả lô cuối lượt, do bước 7 nối với store này (hiện store chỉ có ghi và đọc, chưa gắn vào vòng turn).
- Cạnh tranh giữa hai tab cùng ghi một buổi: `seq` không hổng và không trùng, nhưng UI chưa chặn hai tab cùng gửi một lượt; lượt "mở cuối cùng" theo `seq` thắng (A3).

## Bước 3: vòng turn trong `agent` (2026-11-21)

Trong `packages/agent`; test bằng `AiPort` giả chạy theo kịch bản (`src/testing.ts`, `src/turn.test.ts`), thêm sửa nhỏ ở `core`.

**Vòng turn (`runTurn`, `runSideChat`):**

- Đầu vào lượt chính: `{log, model, newId, maxSteps?}`. `log` là event log của buổi, **kết thúc bằng `TurnStarted` đang mở** (client ghi trước khi gửi, A3); input của người học lấy từ chính event đó, không có tham số `input` riêng. Server (bước 4) nên kiểm `input` trong request khớp `TurnStarted.input` cuối log. `newId` do server cấp (`core` và `agent` không có nguồn ngẫu nhiên); thời gian lấy từ `Clock` của Effect.
- Đầu ra: `Stream<AgentOutput, InvalidTurn, AiPort>`, `AgentOutput` là `Delta {messageId, delta}` | `Event {event}` | `Error {code, message, retryable}` | `Done {outcome}`. Server map: `Delta` thành `delta`, `Event` thành `event`, `Error` thành `error`, `Done` thành `done`. `Done` luôn cuối; `Error` luôn đi sau event `TurnFailed` / `SideTurnFailed` ghi lại lỗi. Lỗi nhà cung cấp là output (có event để lưu), không làm hỏng stream. Stream chỉ lỗi `InvalidTurn` khi log sai (không có lượt đang mở, projection lỗi, buổi đã xong): trước khi chạy, không có event nào.
- Agent theo trạng thái: `Probing` thì Prober (prompt prober, tool `submit_assessment`), `Planning` thì Teacher với tool `create_plan`, `Teaching` thì Teacher với tool `complete_step`. System prompt = prompt của hồ sơ + khối "Session context" do code dựng (chủ đề, ngôn ngữ, số câu đã hỏi trên N, bản đánh giá, plan kèm trạng thái từng bước, bước hiện tại, số lượt đã dùng trên M). Hết N câu thì context bảo Prober phải gọi `submit_assessment`.
- Event của lượt **phát ra ở cuối lượt**, theo thứ tự `MessageAppended` (mọi `TextDelta` gộp, hai message của provider cách nhau bằng dòng trống, cả trong `delta` lẫn bản lưu), các event do tool sinh, `UsageRecorded` (cộng dồn, kèm tên model), `TurnCompleted` (lý do của `Finish` cuối). Lỗi giữa lượt: chỉ phát `UsageRecorded` (nếu đã có token) và `TurnFailed`; chữ dở và event của tool bị bỏ, nên thử lại bắt đầu sạch. Chưa dùng cơ chế "tool event phát ngay": đơn giản hơn và khớp A3.
- Chuyển trạng thái sang `Planning` xong thì **không có lượt người học**: client phải bắt đầu ngay một lượt input rỗng (`needsAgentTurn(session)` cho biết). Input rỗng gửi cho model là một câu cố định (`NO_INPUT`). Lượt đầu của Prober cũng input rỗng (agent nói trước).
- Tool (`src/tools.ts`) chạy trên projection của `log` cộng các event đang chờ, nên mọi quy tắc của `core` áp dụng và lỗi của projection thành `ToolError`:
  - `submit_assessment {level, summary, strengths, gaps}` sinh `AssessmentRecorded`.
  - `create_plan {nodes}` (schema `LessonPlan` của `core`) sinh `PlanCreated`; `validatePlan` lỗi (trùng id, phụ thuộc không có, chu trình) hay hơn 12 bước thì trả `ToolError` kèm `message` của `core`, model sửa rồi gọi lại, lượt vẫn tiếp tục.
  - `complete_step {stepId}` sinh `StepCompleted`, kèm `SessionCompleted` ngay trong lệnh gọi nếu đó là bước cuối. Sai `stepId` thì `ToolError` nêu bước hiện tại.
  - Mỗi lượt chỉ chuyển trạng thái một lần (lệnh thứ hai thành `ToolError`), trừ gọi lặp `complete_step` cùng bước (Haiku từng gọi hai lần song song) thì trả thành công không làm gì. Tool chỉ được đưa cho model khi đúng trạng thái.
- Side chat: log kết thúc bằng tin nhắn `user` của luồng (client ghi trước, như A3); đầu ra là `Delta`, một `SideMessageAppended` (assistant, kèm `stepId` hiện tại và `usage`), `Done`. Không tool, không đổi trạng thái hay lịch sử chính. Ngữ cảnh: plan, bước hiện tại, 6 tin nhắn chính gần nhất (cắt 1.200 ký tự mỗi tin), cùng các tin trong luồng. Lỗi thì `SideTurnFailed`, `Error`, `Done`.
- Lỗi: `ProviderError` giữ `code` của provider, `retryable` là sai khi có dấu hiệu lỗi key/quyền/yêu cầu sai (regex trên mã và thông điệp) và không có `retryAfterMs`; `OutputInvalid` thì thử lại được. Thông điệp được thay key bằng `[redacted]` (A7).
- Hồ sơ mặc định (`defaultProfile`, `src/profile.ts`): N = 4, M = 6, ngôn ngữ `en` (người dùng đổi `language` khi tạo buổi), prompt tiếng Anh viết mới.

**Sửa ở `core`:**

- `UsageRecorded` thêm `model` (để tính chi phí sau); `SideMessageAppended` thêm `usage?` (`model`, `inputTokens`, `outputTokens`) và projection cộng vào `Session.usage`.
- Thêm event `SideTurnFailed {threadId, code, message, retryable}` (event thứ 13): không đổi trạng thái; UI đọc log để hiện nút thử lại.
- `AssessmentRecorded` giữ nguyên `level`, `summary`, `strengths`, `gaps`: lượt chạy thật cho thấy Haiku điền đủ và hợp lý, đủ để Teacher dùng.

**Chạy thật (Haiku, `claude-haiku-5-5`, giá 0,10 / 0,50 USD mỗi triệu token, 3 lượt, tổng khoảng 0,002 USD):** script `packages/ai/scripts/agent-live.ts <teach|probe|plan>` (log dựng sẵn, chạy đúng một lượt mỗi lần, in thứ tự event của model và chi phí; nạp `agent` bằng đường dẫn tương đối vì `ai` không được phụ thuộc `agent`). Lệnh: `node --env-file=/đường/dẫn/.env packages/ai/scripts/agent-live.ts teach`.

| Lượt | Kết quả | Token vào / ra | Chi phí |
| --- | --- | --- | --- |
| `teach` (người học trả lời đúng) | `ToolCall(complete_step)`, rồi `TextDelta` trong cùng lượt; `StepCompleted` đúng bước | 3.490 / 502 | khoảng 0,0006 USD |
| `probe` (N = 1) | `submit_assessment` rồi lời kết; `AssessmentRecorded` đủ trường | 2.793 / 495 | khoảng 0,0005 USD |
| `plan` | `create_plan` hợp lệ (5 bước, có nhánh song song) rồi lời chào và bước 1 | 3.916 / 813 | khoảng 0,0008 USD |

**A4 đứng vững:** tool chuyển trạng thái và chữ stream chạy chung một lượt. Lưu ý: Haiku gọi tool **trước** rồi mới viết chữ (không viết chữ trước tool), nên prompt nói "viết lời nhận xét trong cùng message" nhưng thứ tự thực tế là tool, sau đó chữ; vì tool trả về nội dung dặn tiếp ("viết lời chúc / dẫn sang bước sau") nên chữ vẫn hợp lý. Rủi ro 18 chưa gặp sự cố trong 3 lượt; cần theo dõi ở bước 8 với nhiều lượt hơn.

**Việc mở cho bước sau:**

- Giới hạn `maxSteps` mặc định 6; chưa đo model gọi tool lặp.
- Chưa có cơ chế cắt lịch sử dài (A8, mục 6).
- Side chat lỗi không ghi lượng token đã tốn (event lỗi không có `usage`).
- Prompt chưa được tinh chỉnh; lượt thật dùng 2.800-3.900 token vào cho mỗi lượt do prompt dài cộng schema tool; xem lại khi cần tiết kiệm.

## Bước 2: schema và projection (2026-11-21)

Trong `packages/core`, test đơn vị phủ projection, DAG có chu trình, chọn bước, lượt bị ngắt.

- **Event (12):** `SessionCreated`, `TurnStarted`, `MessageAppended`, `UsageRecorded`, `TurnCompleted`, `TurnFailed`, `AssessmentRecorded`, `PlanCreated`, `StepCompleted`, `StepSkipped`, `SessionCompleted`, `SideMessageAppended`. Union `DomainEvent`, log là `EventLog`. Mọi event có `id` và `at`.
- **Schema khác:** `TeachingProfile` (`id`, `language`, `maxProbeQuestions` = N, `maxTurnsPerStep` = M, `prompts.{prober,teacher,sideChat}`), `LessonPlan`/`PlanNode`, `AssessmentLevel`.
- **Hàm:** `projectSession(log)` trả `Result<Session, ProjectionError>`; `findInterruptedTurn`, `currentStep`, `canSkipStep`; `validatePlan` (lỗi `PlanInvalid`: `DuplicateId`, `UnknownDependency`, `Cycle`, `message` đủ để gửi lại model làm `ToolError`); `nextStep`, `isPlanResolved`.
- **Lệch so với phần A (đã sửa trong `loi-day-hoc.md`):** thêm event `SessionCreated` chụp hồ sơ dạy học; `StepSkipped` tính là đã giải quyết khi chọn bước; `Teaching.stepId` rỗng giữa event bước cuối và `SessionCompleted`; thử lại là `TurnStarted` mới, lịch sử chỉ lấy lượt đã hoàn tất; projection chặt với log sai.
- **Đã chốt ở bước 3 (xem phần bước 3):** các trường của `AssessmentRecorded` (`level`, `summary`, `strengths`, `gaps`) là bản đầu, sửa được khi viết prompt Prober; side chat chưa có event lỗi riêng (lượt side chat lỗi thì bước 3 quyết); `UsageRecorded` chưa ghi model để tính chi phí.

## Bước 1: spike SQLite WASM và TanStack DB (2026-11-21)

Mã spike nằm ở `apps/web/src/spike/sqlite/`, route `/spike/sqlite` (`apps/web/src/routes/spike.sqlite.tsx`), kịch bản Playwright `apps/web/scripts/spike-sqlite.mjs` (kèm `spike-serve.mjs` để thêm header COOP/COEP). Chạy: `pnpm build && pnpm build:spa && pnpm exec playwright install chromium firefox webkit`, rồi `node scripts/spike-sqlite.mjs chromium|firefox|webkit`. Đã chạy trên Chromium, Firefox, WebKit của Playwright (trên máy macOS; chưa thử Safari hay WebView iOS thật, xem rủi ro 5). Phần spike đã xoá ở bước 5.

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

Bước 0 đến 8 xong, phase 1 đóng (2026-11-21).

**Cách chạy:** `pnpm --filter @kd-learn/web dev` (cổng 3000, phục vụ cả `/api/*`), hoặc `pnpm build` rồi `PORT=4173 node apps/web/.output/server/index.mjs`. Server không cần key; người học nhập key ở `/settings`. Key thật ở `.env` gốc repo (`KD_LEARN_CLAUDE_API`, không commit, không in); nhập tay ở trình duyệt hoặc dùng script Playwright tạm không bật trace, video, ảnh chụp. Chạy một lượt Haiku trước, xem chi phí rồi mới học hết chủ đề.

**Việc kiểm trên thiết bị thật (không thuộc tiêu chí phase 1, sang phase 6, xem [rủi ro 5](../05-rui-ro.md)):**

- Markdown khi stream (công thức, bảng, code) trên điện thoại thật.
- Hai tab thật (Web Lock) và bfcache (Back sau khi rời trang học): Worker có sống, màn học có đọc lại không.
- Safari và Chrome thật trên điện thoại: bàn phím ảo che ô trả lời, `Drawer` side chat.

**Còn mở sau bước 7 (có thể sang phase 2):**

- `deleteSession` (migration đổi trigger), xuất và nhập dữ liệu, đồng bộ server.
- Nút dừng lượt đang chạy; danh sách buổi dạng link thật; e2e trên WebKit có OPFS.
- Keep-alive SSE, giới hạn tốc độ và xác thực trước khi triển khai công khai (ghi chú bước 4).
- Sửa hồ sơ dạy học, tóm tắt lịch sử dài (mục 6), chọn model theo vai.
- Bản SPA/Capacitor: `VITE_KD_API_BASE_URL` và CORS phía server (phase 6).


## Lưu ý khi chạy model thật

- Chạy thử 1 lượt, xem model và chi phí, rồi mới chạy hàng loạt. Spike đã đốt hạn mức 5 giờ của gói vì bỏ bước này (mỗi lượt Claude Code từng tốn khoảng 980k token).
- Claude Code qua ACP dùng chung hạn mức gói với phiên làm việc; ưu tiên Haiku cho script và test tay.
- Key API nằm trong `.env` ở gốc repo (không commit).

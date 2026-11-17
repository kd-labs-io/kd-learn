# Mục tiêu


Xây một app học tập có AI hướng dẫn, lấy ý tưởng từ [LearnHarness](https://github.com/amosblomqvist/learnharness), nhưng chạy được dạng web self-hosted, linh hoạt hơn, và có app mobile.

Vòng học gồm ba agent dùng chung lịch sử buổi học:

1. **Prober** đo mức hiểu hiện tại của người học.
2. **Teacher** lập plan dạy dạng DAG rồi dạy từng bước.
3. **Practitioner** ra bài luyện tập.

Sau mỗi buổi, kiến thức được trích thành **knowledge graph** (mệnh đề và chuỗi lập luận), và bài luyện tập lấy từ graph đó.

Dự án viết lại từ đầu. Không chép code hay prompt của LearnHarness (bản gốc dùng giấy phép AGPL-3.0), chỉ tham khảo ý tưởng và kiến trúc.


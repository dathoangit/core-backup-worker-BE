Giải thích dễ hiểu về database HIS

Tài liệu này diễn giải lại his-database.md bằng ngôn ngữ đời thường, dành cho người
không chuyên sâu về lập trình. Bản gốc tiếng Anh có đầy đủ số liệu kỹ thuật.

Khảo sát ngày 05/10/2026, bằng các truy vấn chỉ đọc, không ghi gì vào hệ thống bệnh viện.


## Tóm tắt trong một phút

Nếu bạn chỉ đọc một đoạn, hãy đọc đoạn này.

Chúng ta muốn sao lưu dữ liệu HIS của bệnh viện. Sau khi khảo sát, có các điều quan trọng.

Một, HIS không phải một kho dữ liệu, mà là nhiều kho trên nhiều máy. Trên máy HIS/EMR
khoảng 1685 GB; thêm hệ BADL trên máy riêng chưa vào được.

Hai, giấy cấp tài khoản có ba user: his_stpaul, emr_stpaul, badl_stpaul. Dự án này
luôn kết nối máy chủ phụ:

- HIS/EMR: 172.16.16.23 (máy chính 22 không dùng).
- BADL: 172.16.16.83 (máy chính 82 không dùng; hiện chưa vào được — ECONNREFUSED).
- his_stpaul đọc được đầy đủ kho produce.
- emr_stpaul đọc được signer, file_service, vital_signs, research_management,
  medical_incident, phat_thuoc, và phần lớn html_editor.

Ba, ảnh chụp X-quang, bản scan, file PDF đã ký không nằm trong kho dữ liệu. Chúng nằm ở
một máy chứa file riêng mà ta chưa tìm ra.

Bốn, trong kho lớn nhất thì 70% dung lượng chỉ là sổ ghi chép hoạt động, không phải dữ
liệu bệnh nhân. Nhưng chính cuốn sổ đó lại là thứ giúp việc sao lưu trở nên rẻ.

Điểm thứ tư nghe mâu thuẫn, nhưng nó là chìa khóa của cả thiết kế. Phần cuối tài liệu sẽ
giải thích rõ.


## Trước hết, vài khái niệm

Để đọc tiếp cho dễ, hình dung thế này.

Database giống một tủ hồ sơ khổng lồ. Trong tủ có nhiều ngăn, mỗi ngăn là một bảng
(table). Mỗi ngăn chứa nhiều phiếu, mỗi phiếu là một dòng (row). Ví dụ ngăn bệnh nhân
chứa 1,1 triệu phiếu, mỗi phiếu là một người.

Server là căn phòng chứa nhiều tủ hồ sơ. Một server có thể chứa nhiều database.

Index là cuốn mục lục của một ngăn. Không có mục lục thì muốn tìm gì phải lật từng phiếu
một. Chi tiết này sẽ rất quan trọng ở phần sau.

Sao lưu nghĩa là tạo một bản sao của toàn bộ tủ hồ sơ sang một nơi khác, rồi cập nhật
bản sao đó đều đặn mỗi ngày.


## HIS này chạy trên phần mềm gì

HIS của bệnh viện được xây trên ADempiere, một phần mềm quản trị doanh nghiệp mã nguồn mở.
Nhà cung cấp đã viết thêm một lớp nghiệp vụ y tế rất lớn lên trên nó.

Thấy rõ qua cách đặt tên các ngăn hồ sơ. Các ngăn bắt đầu bằng ad_, c_, m_ là phần lõi
gốc của ADempiere, có 538 ngăn. Các ngăn bắt đầu bằng his_ là phần y tế do nhà cung cấp
viết thêm, có 337 ngăn. Các ngăn tên his_130_xml và his_79a_xml là dữ liệu xuất ra cho
bảo hiểm y tế, đặt theo tên Quyết định 130 và Quyết định 79A của Bộ Y tế.

Ngoài ADempiere, bệnh viện còn chạy một loạt ứng dụng nhỏ viết bằng Java, mỗi ứng dụng
một kho riêng: ký số, bệnh án điện tử, quản lý file, phát thuốc, thanh toán, báo cáo sự
cố y khoa, quản lý đề tài nghiên cứu.


## Phát hiện 1: HIS là mười một kho, không phải một

Ban đầu chúng ta chỉ được cho thông tin của một kho tên produce. Khi kiểm tra cả căn
phòng, hóa ra có mười một kho.

| Kho dữ liệu         | Dung lượng | Số ngăn | Chứa gì                                         |
| ------------------- | ---------- | ------- | ----------------------------------------------- |
| produce             | 1494 GB    | 1210    | Lõi HIS: bệnh nhân, khám chữa bệnh, viện phí    |
| signer              | 82 GB      | 24      | Lịch sử ký số điện tử                           |
| file_service        | 34 GB      | 11      | Danh mục hồ sơ, tài liệu                        |
| html_editor         | 30 GB      | 472     | Bệnh án điện tử, các biểu mẫu chăm sóc          |
| produce_old         | 21 GB      | 1076    | Bản sao cũ của HIS                              |
| produce_bak         | 20 GB      | 1075    | Bản sao cũ của HIS                              |
| phat_thuoc          | 2,3 GB     | 17      | Phát thuốc cho bệnh nhân                        |
| isofh_pay           | 1,2 GB     | 14      | Giao dịch thanh toán                            |
| medical_incident    | 86 MB      | 102     | Báo cáo sự cố y khoa                            |
| research_management | 12 MB      | 31      | Quản lý đề tài nghiên cứu                       |
| vital_signs         | 9 MB       | 8       | Sinh hiệu, gần như chưa dùng                    |

Tổng cộng khoảng 1685 GB.

Đáng chú ý là html_editor chứa bệnh án điện tử và signer chứa lịch sử ký số. Về mặt pháp
lý và chuyên môn, hai kho này quan trọng không kém kho chính, dù dung lượng nhỏ hơn nhiều.


## Phát hiện 2: Ba tài khoản, mỗi nhóm kho một cửa

Giấy nhà cung cấp có ba tài khoản Postgres, mỗi cái gắn với nhóm database khác nhau.

| Tài khoản | Máy chủ phụ (đang dùng) | Kho theo giấy | Thực tế đọc được |
| --- | --- | --- | --- |
| his_stpaul | 172.16.16.23 | produce, html_editor, phat_thuoc | Chỉ produce đầy đủ. html_editor và phat_thuoc vào được phòng nhưng không mở ngăn |
| emr_stpaul | 172.16.16.23 | signer, file_service, vital_signs, research_management | Đọc được đủ nhóm trên, cộng thêm medical_incident, phat_thuoc, phần lớn html_editor |
| badl_stpaul | 172.16.16.83 | his | Máy không mở cổng 5432 từ đây |

Lưu ý font giấy: chữ l thường dễ nhầm với dấu |. Mật khẩu EMR đúng kết thúc bằng chữ I hoa
(…pbI). Mật khẩu HIS đúng dùng chữ l thường (…AlQs).

Còn thiếu quyền đọc: isofh_pay, produce_old, produce_bak, 146 bảng trong html_editor,
2 bảng trong signer (nguoi_than), và toàn bộ BADL.


## Phát hiện 3: Ảnh và file không nằm trong database

Đây là lý do con số 1685 GB trông ít hơn thực tế.

Kho file_service có 25,5 triệu dòng ghi về hồ sơ tài liệu, nhưng toàn bộ phần lưu trữ nội
dung nặng của nó chỉ vỏn vẹn 80 KB. Trung bình mỗi dòng khoảng 450 byte, tức là đủ để ghi
vài dòng chữ, không đủ để chứa một tấm ảnh.

Nói cách khác, kho này chỉ là cuốn sổ danh mục, không phải kho chứa. Nó ghi tên file và
đường dẫn, còn file thật nằm chỗ khác. Thấy rõ nhất ở cột tên duong_dan trong ngăn
nb_ho_so, chính là đường dẫn tới file.

Kho signer cũng vậy: 160 triệu dòng nhưng chỉ 176 KB nội dung nặng. Nó ghi file_truoc_ky
và file_sau_ky dưới dạng đường dẫn.

Nghĩa là ảnh chụp chẩn đoán hình ảnh, bản scan hồ sơ giấy, file PDF đã ký số đều nằm trên
một máy chủ file, ổ NAS hoặc dịch vụ lưu trữ nào đó mà ta chưa xác định được vị trí.

Phần này đã được thống nhất là nằm ngoài phạm vi dự án. Nhưng cần ghi nhận rõ: sao lưu
database xong không có nghĩa là đã sao lưu xong HIS. Nếu máy chứa file hỏng, các đường dẫn
trong database sẽ trỏ vào hư không.


## Phát hiện 4: Dữ liệu trong produce đầy đủ, không bị cắt

Có lo ngại rằng produce chỉ là một phần dữ liệu. Kiểm tra lại thì không phải.

Số lượt khám chữa bệnh theo từng năm, liên tục từ ngày hệ thống đi vào hoạt động:

| Năm                 | Số lượt |
| ------------------- | ------- |
| 2020 (từ tháng 10)  | 150.247 |
| 2021                | 439.019 |
| 2022                | 599.540 |
| 2023                | 588.721 |
| 2024                | 585.778 |
| 2025                | 595.204 |
| 2026 (đến tháng 10) | 525.983 |

Ổn định khoảng 590 nghìn lượt mỗi năm, không có năm nào hụt, không có khoảng trống. Hệ
thống bắt đầu chạy thật từ tháng 10/2020.

Vậy cái bị thiếu là phạm vi hệ thống, tức mười kho kia, chứ không phải khoảng thời gian
của kho chính.


## Bên trong kho chính: 70% là sổ ghi chép

Đây là phần thú vị nhất của khảo sát.

Kho produce nặng 1494 GB. Nhưng khi xem từng ngăn thì:

| Ngăn              | Dung lượng | Thực chất là gì                                   |
| ----------------- | ---------- | ------------------------------------------------- |
| ad_changelog      | 1042 GB    | Sổ nhật ký: ai sửa gì, lúc nào, giá trị cũ và mới |
| ad_issue          | 104 GB     | Nhật ký lỗi của phần mềm                          |
| ad_session        | 12 GB      | Nhật ký đăng nhập                                 |
| ad_pinstance_para | 9,3 GB     | Nhật ký chạy báo cáo                              |
| ad_pinstance      | 4,3 GB     | Nhật ký chạy báo cáo                              |

Cộng lại, nhật ký chiếm hơn 1170 GB. Dữ liệu nghiệp vụ thật sự, tức là bệnh nhân, lượt
khám, đơn thuốc, viện phí, kho dược, chỉ khoảng 321 GB.

Riêng ad_changelog có 2,65 tỷ dòng. Đây là tính năng kiểm toán có sẵn của ADempiere: mỗi
khi ai đó sửa một ô dữ liệu bất kỳ, nó ghi lại một dòng. Sửa một phiếu có năm ô thì ghi
năm dòng. Sáu năm hoạt động tích lại thành 1042 GB.

Về mặt pháp lý thì cuốn sổ này có giá trị, vì nó cho biết ai đã sửa hồ sơ bệnh án nào vào
lúc nào. Nên đã thống nhất là sao lưu cả nó.


## Tại sao không thể copy hết mỗi ngày

Cách làm đơn giản nhất là mỗi ngày copy toàn bộ 1,5 TB sang nơi khác. Không khả thi: copy
1,5 TB hai lần mỗi ngày sẽ chiếm trọn đường truyền và gây tải nặng lên máy chủ đang phục
vụ bệnh viện khám chữa bệnh.

Cách làm thông minh hơn là chỉ copy những gì vừa thay đổi. Nhưng ở đây gặp một trở ngại.

Mỗi phiếu dữ liệu đều có ô ghi sửa lần cuối lúc nào. Về lý thuyết chỉ cần hỏi, cho tôi
những phiếu sửa sau 1 giờ sáng hôm nay. Vấn đề là ô này gần như không có mục lục. Trong
toàn bộ 1210 ngăn, chỉ đúng một ngăn có mục lục theo ô này.

Không có mục lục thì để trả lời câu hỏi đó, máy phải lật từng phiếu một.

Đã đo thử trên ngăn his_patienthistory: lật hết 3,5 triệu phiếu, mất khoảng 15 giây, chỉ
để tìm ra 5675 phiếu vừa sửa. Mà đây mới là một ngăn trong hơn một nghìn ngăn. Làm như vậy
với toàn bộ 321 GB dữ liệu nghiệp vụ, hai lần mỗi ngày, sẽ mất nhiều giờ và gây tải đáng
kể lên hệ thống bệnh viện.

Giải pháp thông thường là tạo thêm mục lục. Nhưng tài khoản của chúng ta không có quyền
tạo mục lục, và tạo mục lục trên bảng lớn của hệ thống đang chạy cũng là việc nhạy cảm,
phải do nhà cung cấp quyết định.


## Lời giải: dùng chính cuốn sổ nhật ký

Và đây là chỗ cuốn sổ 1042 GB kia từ gánh nặng trở thành lời giải.

Ngăn ad_changelog ghi lại mọi thay đổi. Mỗi dòng có một số thứ tự tăng dần, và số thứ tự
này thì có mục lục. Nên thay vì lật từng ngăn hỏi có gì mới không, ta chỉ cần hỏi cuốn sổ:

    Lần trước tôi đọc đến dòng số 1.163.108.283.
    Từ đó tới giờ có những thay đổi nào?

Câu hỏi này trả lời tức thì, vì nó tra mục lục chứ không lật phiếu.

Cuốn sổ trả về danh sách dạng ngăn X, phiếu số Y, vừa bị sửa. Ta gom lại, rồi tới đúng
từng phiếu đó mà lấy. Tra phiếu theo số thì luôn nhanh, vì số phiếu bao giờ cũng có mục lục.

Cuốn sổ còn ghi cả phiếu bị xóa, nên bản sao lưu biết mà xóa theo. Đây là điểm mà nhiều
cách làm khác bỏ sót.

Khối lượng thực tế đã đo trên một khoảng hơn hai ngày:

| Chỉ số                       | Giá trị              |
| ---------------------------- | -------------------- |
| Số dòng nhật ký phát sinh    | 3.765.124            |
| Số phiếu thật sự bị động đến | 662.334              |
| Quy ra mỗi ngày              | khoảng 300.000 phiếu |

Con số 3,7 triệu dòng nghe to, nhưng vì mỗi ô sửa ghi một dòng nên thực chất chỉ có khoảng
300 nghìn phiếu thay đổi mỗi ngày.

So sánh cho dễ hình dung: lấy 300 nghìn phiếu theo số, so với lật hết 321 GB. Chênh nhau
khoảng một nghìn lần.

Còn bản thân cuốn sổ 1042 GB thì cũng phải sao lưu. May mắn là nó chỉ ghi thêm, không bao
giờ sửa lại dòng cũ. Đã kiểm chứng bằng cách lấy 20.000 dòng mới nhất và đếm xem có dòng
nào từng bị sửa sau khi ghi, kết quả là không có dòng nào.

Nghĩa là sau lần sao chép đầu tiên, mỗi lần chạy sau chỉ cần lấy những dòng mới phát sinh.
Không bao giờ phải đọc lại 1042 GB cũ nữa. Các ngăn nhật ký khác cũng tương tự, chỉ khác
vài chi tiết nhỏ.


## Một điều may mắn cho các kho còn lại

Khi nào xin được quyền đọc mười kho kia, cách làm sẽ không phải thiết kế lại từ đầu.

Các ứng dụng Java của bệnh viện đều dùng một thư viện phổ biến tên Hibernate Envers, và
thư viện này cũng tự ghi sổ nhật ký theo đúng nguyên lý: có số thứ tự tăng dần, có đánh
dấu thêm mới hay sửa hay xóa.

Nhìn thấy được điều này vì danh mục hệ thống cho phép xem cấu trúc các ngăn dù không cho
xem nội dung.

Nên cùng một cách làm áp dụng được cho cả hai họ phần mềm, chỉ thay tên cuốn sổ cần hỏi.


## Những gì cần chấp nhận

Không có phương án nào hoàn hảo. Ba điểm cần biết trước.

Bản sao trễ vài giờ, không tức thời. Chạy hai lần mỗi ngày thì có lúc bản sao chậm hơn bản
gốc tới mười hai tiếng. Muốn gần thời gian thực thì phải chạy dày hơn, hoặc phải xin nhà
cung cấp mở cơ chế đồng bộ chuyên dụng.

Không phải bản chụp tại một thời điểm. Sao chép 1,5 TB mất nhiều giờ. Trong lúc đó bệnh
viện vẫn làm việc, dữ liệu vẫn đổi. Để có bản chụp đứng im tại một giây thì phải yêu cầu
máy chủ giữ nguyên trạng thái suốt nhiều giờ, việc này gây hại thật sự cho hệ thống đang
chạy. Nên bản sao sẽ hơi lệch pha lúc đầu, rồi tự khớp dần nhờ cuốn sổ nhật ký.

Cuốn sổ có điểm mù. Nó chỉ ghi những thay đổi đi qua giao diện phần mềm. Nếu nhà cung cấp
chạy lệnh sửa trực tiếp vào database, cuốn sổ sẽ không biết. Vì vậy mỗi tuần cần có một
lượt đối chiếu: đếm và so số liệu giữa bản gốc và bản sao, phát hiện lệch thì vá lại.


## Việc cần làm tiếp

Về kỹ thuật, xây dựng dịch vụ sao lưu multi-source theo HIS_*/EMR_*/BADL_*, chạy produce
và các kho EMR đã đọc được trước.

Về mạng / nhà cung cấp: xin VPN hoặc mở cổng BADL máy phụ 172.16.16.83; xin bổ sung
SELECT cho isofh_pay, phần còn thiếu của html_editor và hai bảng nguoi_than trong signer;
xác nhận mật khẩu BADL bằng copy-paste.

Về hạ tầng, chuẩn bị máy chứa bản sao, tối thiểu 2 TB, dự phòng tăng khoảng 200 GB mỗi năm.

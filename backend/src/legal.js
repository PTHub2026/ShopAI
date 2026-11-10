// Trang pháp lý công khai (không cần đăng nhập) — Meta yêu cầu cho App Review và chế độ Live:
// Chính sách quyền riêng tư, Điều khoản sử dụng, Hướng dẫn xóa dữ liệu người dùng.
const CONTACT = 'ct@pthub.vn';
const UPDATED = '11/11/2026';
const css = 'body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;max-width:760px;margin:0 auto;padding:32px 20px 64px;color:#1f2937;line-height:1.65}h1{font-size:28px;margin:0 0 4px}h2{font-size:19px;margin:28px 0 8px}.muted{color:#6b7280;font-size:14px}nav{margin:0 0 24px;font-size:14px}nav a{margin-right:14px;color:#4f46e5}a{color:#4f46e5}ul,ol{padding-left:22px}';
const nav = '<nav><a href="/">ShopPost</a><a href="/privacy">Chính sách quyền riêng tư</a><a href="/terms">Điều khoản sử dụng</a><a href="/data-deletion">Xóa dữ liệu</a></nav>';
const page = (title, body) => '<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + title + ' · ShopPost</title><style>' + css + '</style></head><body>' + nav + '<h1>' + title + '</h1><p class="muted">Cập nhật lần cuối: ' + UPDATED + '</p>' + body + '<p class="muted" style="margin-top:40px">Liên hệ: <a href="mailto:' + CONTACT + '">' + CONTACT + '</a> · https://shoppost.net</p></body></html>';

const privacy = page('Chính sách quyền riêng tư', `
<p>ShopPost (https://shoppost.net) là công cụ giúp chủ shop soạn nội dung và đăng bài lên các kênh mạng xã hội mà họ quản lý. Chính sách này mô tả dữ liệu ShopPost thu thập, mục đích sử dụng và quyền của người dùng.</p>
<h2>1. Dữ liệu chúng tôi thu thập</h2>
<ul>
<li><b>Tài khoản ShopPost:</b> địa chỉ email, tên hiển thị, mật khẩu đã băm (không lưu mật khẩu gốc), thông tin shop và vai trò thành viên.</li>
<li><b>Kết nối kênh (Facebook Page, Instagram Professional, Zalo OA, Telegram, YouTube):</b> khi Chủ shop hoặc Quản lý chủ động bấm kết nối, ShopPost nhận mã truy cập (access token) do nền tảng cấp, mã định danh và tên của Page/tài khoản/OA được chọn. ShopPost không lấy quyền đăng lên trang cá nhân Facebook hoặc Instagram cá nhân.</li>
<li><b>Nội dung bài đăng:</b> văn bản, hình ảnh, video, lịch đăng và kết quả đăng (mã bài viết, đường dẫn bài viết, trạng thái lỗi) do người dùng tạo trong ShopPost.</li>
<li><b>Nhật ký kỹ thuật:</b> nhật ký thao tác trong shop (ai kết nối, ai đăng bài) để bảo mật và hỗ trợ.</li>
</ul>
<h2>2. Mục đích sử dụng</h2>
<p>Dữ liệu chỉ được dùng để cung cấp các chức năng người dùng yêu cầu: đăng nhập, hiển thị danh sách Page/tài khoản đã kết nối, đăng hoặc lên lịch bài viết lên đúng kênh người dùng chọn, và hiển thị kết quả đăng. ShopPost chỉ đăng bài khi người dùng xác nhận gửi hoặc đặt lịch; không tự đăng khi vừa kết nối. Chúng tôi không bán dữ liệu, không dùng dữ liệu từ Facebook/Instagram cho quảng cáo hoặc lập hồ sơ người dùng.</p>
<h2>3. Dữ liệu nhận từ Meta (Facebook/Instagram)</h2>
<p>Với các quyền pages_show_list, pages_read_engagement, pages_manage_posts, instagram_basic và instagram_content_publish, ShopPost chỉ đọc danh sách Page và tài khoản Instagram Professional liên kết mà người dùng quản lý, cùng thông tin cơ bản (tên, mã định danh) để người dùng chọn kênh, và tạo bài đăng mới theo yêu cầu của người dùng.</p>
<h2>Google Drive trong Kho tài nguyên</h2>
<p>Kết nối Drive là một lần cấp quyền riêng với YouTube. Chủ shop hoặc Quản lý chọn tài khoản và cấp quyền xem và tải tất cả tệp trên Google Drive. Những thành viên có quyền nhập tài nguyên trong shop cũng có thể tìm, xem danh sách và nhập các tệp từ kết nối này. Chỉ kết nối tài khoản phù hợp để chia sẻ trong shop.</p>
<p>ShopPost lưu tên tài khoản, mã định danh Drive và token đã mã hóa trên máy chủ để làm mới quyền truy cập. Khi bạn tìm hoặc chọn nhập, máy chủ lấy danh sách hoặc truyền tệp từ Google về trình duyệt; không lưu nội dung tệp trên máy chủ và không tự đồng bộ. Tệp nhập và thông tin nguồn được lưu trong bộ nhớ trình duyệt, có thể mất khi bạn xóa dữ liệu trình duyệt. Ngắt Drive trong Kho sẽ xóa token khỏi ShopPost; các tệp đã nhập vẫn ở trên trình duyệt đến khi bạn xóa chúng. Muốn thu hồi toàn bộ quyền ứng dụng ở Google, dùng cài đặt quyền truy cập Google; điều này có thể ảnh hưởng kết nối YouTube của cùng ứng dụng.</p>
<h2>Google và YouTube</h2>
<p>ShopPost sử dụng YouTube API Services. Khi bạn kết nối Google/YouTube, ShopPost chỉ nhận tên và mã kênh YouTube được bạn cấp quyền, cùng access token và refresh token để đọc thông tin kênh và tải video theo thao tác của bạn. Luồng YouTube không yêu cầu quyền truy cập Gmail, Drive hoặc danh bạ Google.</p>
<p>Video được truyền tới YouTube khi bạn xác nhận tải; ShopPost không lưu bản sao tệp video trên máy chủ. Bạn tự chọn tiêu đề, mô tả, đối tượng trẻ em và chế độ hiển thị. Mã kênh, tên kênh và kết quả tải được xóa sau 30 ngày nếu không được cập nhật; mã truy cập được xóa ngay khi ngắt kết nối trong ShopPost. Việc ngắt kết nối không xóa video đã tải lên YouTube.</p>
<p>Bạn có thể thu hồi quyền của ShopPost tại <a href="https://myaccount.google.com/permissions">cài đặt quyền truy cập Google</a> và yêu cầu xóa dữ liệu theo hướng dẫn bên dưới. Xem <a href="https://policies.google.com/privacy">Chính sách quyền riêng tư Google</a> và <a href="https://www.youtube.com/t/terms">Điều khoản dịch vụ YouTube</a>. Việc sử dụng dữ liệu Google tuân theo Google API Services User Data Policy, bao gồm các yêu cầu Limited Use; không bán dữ liệu, không dùng để quảng cáo hoặc huấn luyện AI.</p>
<h2>Hộp thư và kịch bản trả lời</h2>
<p>Khi chủ shop hoặc quản lý bật trả lời tự động cho một kênh hỗ trợ, ShopPost nhận mã định danh người gửi và hội thoại, tên hiển thị, nội dung và thời gian tin nhắn mới từ kênh đó. Máy chủ lưu hội thoại, nội dung trả lời, nhãn, người được giao và kết quả xử lý để chạy kịch bản, phục vụ hỗ trợ và tính thời gian phản hồi. Hệ thống không tự nhập lịch sử tin nhắn cũ. Lưu hoặc chạy thử kịch bản không tự bật gửi tin.</p>
<p>Chỉ thành viên được cấp quyền mới đọc hội thoại; nhân viên hỗ trợ chỉ đọc hội thoại được giao. Tin nhắn được xử lý bằng quy tắc đã lưu, không tự gửi tới AI. Câu trả lời tự động được gửi về đúng kênh và người gửi đã liên hệ. Tắt kênh dừng xử lý mới trong ShopPost, không xóa tin đã gửi hay lịch sử; dữ liệu được giữ khi tài khoản hoạt động và có thể yêu cầu xóa theo mục 7.</p>
<h2>4. Lưu trữ và bảo mật</h2>
<p>Dữ liệu được lưu trên hạ tầng Cloudflare. Mã truy cập của các kênh được mã hóa AES-256-GCM trước khi lưu và không bao giờ hiển thị lại trên giao diện. Kết nối luôn dùng HTTPS. Chỉ thành viên có quyền phù hợp trong shop mới xem hoặc đăng lên kênh của shop đó.</p>
<h2>5. Chia sẻ dữ liệu</h2>
<p>ShopPost gửi nội dung bài đăng và câu trả lời theo kịch bản tới nền tảng mà người dùng chọn (ví dụ Facebook, Instagram, Zalo, Telegram) để thực hiện việc đăng. Chúng tôi không chia sẻ dữ liệu cho bên thứ ba khác, trừ khi pháp luật yêu cầu.</p>
<h2>6. Thời gian lưu giữ</h2>
<p>Mã truy cập bị xóa ngay khi người dùng ngắt kết nối kênh. Dữ liệu tài khoản và bài đăng được lưu trong thời gian tài khoản còn hoạt động và được xóa khi có yêu cầu theo mục 7.</p>
<h2>7. Quyền của người dùng và xóa dữ liệu</h2>
<p>Người dùng có quyền truy cập, chỉnh sửa và yêu cầu xóa dữ liệu của mình. Cách thực hiện xem tại <a href="/data-deletion">Hướng dẫn xóa dữ liệu</a>.</p>
<h2>8. Thay đổi chính sách</h2>
<p>Khi chính sách thay đổi, chúng tôi cập nhật trang này và ngày cập nhật ở đầu trang.</p>`);

const terms = page('Điều khoản sử dụng', `
<p>Khi sử dụng ShopPost (https://shoppost.net), bạn đồng ý với các điều khoản dưới đây.</p>
<h2>1. Dịch vụ</h2>
<p>ShopPost giúp chủ shop và thành viên được cấp quyền soạn nội dung (có hỗ trợ AI) và đăng hoặc lên lịch bài viết lên các kênh mạng xã hội mà shop quản lý.</p>
<h2>2. Tài khoản</h2>
<p>Bạn chịu trách nhiệm bảo mật tài khoản và mọi hoạt động thực hiện dưới tài khoản của mình. Chủ shop chịu trách nhiệm phân quyền cho thành viên trong shop.</p>
<h2>3. Kết nối kênh mạng xã hội</h2>
<p>Bạn chỉ được kết nối các Page, tài khoản hoặc OA mà bạn có quyền quản trị hợp pháp. Việc sử dụng các nền tảng đó vẫn tuân theo điều khoản riêng của từng nền tảng (Meta, Zalo, Telegram...). Bạn có thể ngắt kết nối bất cứ lúc nào trong mục Kênh. Khi sử dụng tính năng YouTube, bạn cũng chịu ràng buộc bởi <a href="https://www.youtube.com/t/terms">Điều khoản dịch vụ YouTube</a>.</p>
<h2>4. Nội dung</h2>
<p>Bạn sở hữu và chịu trách nhiệm về nội dung đăng qua ShopPost, bao gồm nội dung do AI gợi ý mà bạn chọn sử dụng. Không dùng ShopPost để đăng nội dung vi phạm pháp luật, xâm phạm quyền của người khác, spam hoặc vi phạm chính sách của nền tảng.</p>
<h2>5. Giới hạn trách nhiệm</h2>
<p>ShopPost được cung cấp theo hiện trạng. Việc đăng bài phụ thuộc vào nền tảng bên thứ ba; chúng tôi không chịu trách nhiệm khi nền tảng từ chối, gỡ bỏ hoặc trì hoãn bài đăng.</p>
<h2>6. Chấm dứt</h2>
<p>Bạn có thể ngừng sử dụng và yêu cầu xóa dữ liệu bất cứ lúc nào. Chúng tôi có thể tạm khóa tài khoản vi phạm các điều khoản này.</p>
<h2>7. Quyền riêng tư</h2>
<p>Việc xử lý dữ liệu tuân theo <a href="/privacy">Chính sách quyền riêng tư</a>.</p>`);

const deletion = page('Hướng dẫn xóa dữ liệu người dùng', `
<p>Bạn có thể xóa dữ liệu của mình khỏi ShopPost theo một trong các cách sau.</p>
<h2>1. Ngắt kết nối kênh ngay trong ShopPost</h2>
<ol><li>Đăng nhập https://shoppost.net.</li><li>Mở mục <b>Kênh</b>.</li><li>Chọn kênh (Facebook Page, Instagram, Zalo OA, Telegram hoặc YouTube) và bấm <b>Ngắt kết nối</b>.</li></ol>
<p>Mã truy cập của kênh bị xóa ngay lập tức và các bài đang chờ đăng lên kênh đó bị hủy.</p>
<h2>2. Gỡ ShopPost khỏi tài khoản Facebook</h2>
<ol><li>Trên Facebook, vào <b>Cài đặt và quyền riêng tư → Cài đặt → Ứng dụng và trang web</b>.</li><li>Chọn <b>Shoppost</b> và bấm <b>Gỡ</b>.</li></ol>
<p>Mã truy cập ShopPost đang giữ sẽ mất hiệu lực; bạn có thể gửi thêm yêu cầu ở mục 3 để xóa toàn bộ dữ liệu liên quan.</p>
<h2>Ngắt Google Drive</h2><p>Mở Kho tài nguyên và bấm <b>Ngắt Drive</b> để xóa token Drive trong ShopPost. Xóa riêng các tệp đã nhập khỏi Kho và bộ nhớ trình duyệt nếu không muốn giữ bản sao.</p><h2>Thu hồi quyền Google/YouTube</h2><p>Trong mục Kênh, bấm <b>Ngắt kết nối YouTube</b> để xóa token của kênh khỏi ShopPost. Để thu hồi toàn bộ quyền đã cấp cho ứng dụng tại Google, mở <a href="https://myaccount.google.com/permissions">cài đặt quyền truy cập Google</a> và gỡ ShopPost. Video đã tải vẫn ở trên YouTube; bạn có thể quản lý hoặc xóa trong YouTube Studio.</p><h2>3. Yêu cầu xóa toàn bộ tài khoản và dữ liệu</h2>
<p>Gửi email tới <a href="mailto:${CONTACT}?subject=Yeu%20cau%20xoa%20du%20lieu%20ShopPost">${CONTACT}</a> với tiêu đề "Yêu cầu xóa dữ liệu ShopPost", ghi rõ email đăng nhập ShopPost (và tên Page/tài khoản đã kết nối nếu có). Chúng tôi xác minh quyền sở hữu, xóa tài khoản, mã truy cập, kết nối kênh, hội thoại, kịch bản và nội dung bài đăng liên quan trong vòng 30 ngày, rồi phản hồi xác nhận qua email.</p>`);

export const LEGAL_PAGES = { '/privacy': privacy, '/terms': terms, '/data-deletion': deletion };
export function legalResponse(path, method) {
  const html = LEGAL_PAGES[path];
  if (!html) return null;
  if (method !== 'GET' && method !== 'HEAD') return new Response('Chỉ hỗ trợ GET hoặc HEAD.', { status: 405, headers: { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' } });
  return new Response(method === 'HEAD' ? null : html, { headers: {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
    'Strict-Transport-Security': 'max-age=15552000; includeSubDomains', 'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
  } });
}

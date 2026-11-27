// TDC Mobile backend. Chạy: npm install && npm start
// Mật khẩu chỉ dùng cho yêu cầu đăng nhập hiện tại, không lưu lại.
const express = require("express"), cheerio = require("cheerio"), crypto = require("crypto");
const BASE = "https://online.tdc.edu.vn";
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const S = new Map(); // token -> { jar, t, mssv, name }
setInterval(() => { for (const [k, v] of S) if (Date.now() - v.t > 12 * 36e5) S.delete(k); }, 36e5);

const app = express();
app.use(express.json());
app.get("/", (q, r) => r.sendFile(__dirname + "/index.html"));

const cookieHeader = jar => Object.entries(jar).map(([k, v]) => k + "=" + v).join("; ");
function takeCookies(jar, r) {
  for (const c of r.headers.getSetCookie()) { const [kv] = c.split(";"), j = kv.indexOf("="); jar[kv.slice(0, j)] = kv.slice(j + 1); }
}
async function get(jar, url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Cookie: cookieHeader(jar) }, redirect: "manual", signal: AbortSignal.timeout(25000) });
  takeCookies(jar, r);
  return { r, html: await r.text() };
}
function hidden($) {
  const p = new URLSearchParams();
  $("input[type=hidden]").each((_, e) => p.set($(e).attr("name"), $(e).attr("value") || ""));
  return p;
}

app.post("/api/login", async (req, res) => {
  try {
    const { mssv, password } = req.body || {};
    if (!mssv || !password) return res.status(400).json({ error: "Nhập MSSV và mật khẩu" });
    const jar = {};
    // 1. Tải trang chủ, lấy trạng thái form
    let { html } = await get(jar, BASE + "/");
    let $ = cheerio.load(html);
    // 2. Bấm "Đăng nhập" (postback) để mở form
    let p = hidden($);
    p.set("__EVENTTARGET", "ctl00$lbtDangnhap"); p.set("__EVENTARGUMENT", "");
    const pb = await fetch(BASE + "/", { method: "POST", body: p.toString(), redirect: "manual",
      headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded", Cookie: cookieHeader(jar) }, signal: AbortSignal.timeout(25000) });
    takeCookies(jar, pb);
    // 3. Tải lại trang chủ để lấy form có ô đăng nhập
    ({ html } = await get(jar, BASE + "/"));
    $ = cheerio.load(html);
    if (!$("input[name$='txtUserName']").length) return res.status(502).json({ error: "Không mở được form đăng nhập" });
    // 4. Gửi thông tin đăng nhập (chọn vai trò Sinh viên, mặc định là lựa chọn đầu tiên)
    const role = $("input[name$='$Role']").first();
    p = hidden($);
    p.set(role.attr("name"), role.attr("value") || "");
    p.set($("input[name$='txtUserName']").attr("name"), mssv);
    p.set($("input[name$='txtPassword']").attr("name"), password);
    p.set("ctl00$ContentPlaceHolder1$ctl00$ctl00$btLogin", "Đăng nhập");
    const sub = await fetch(BASE + "/", { method: "POST", body: p.toString(), redirect: "manual",
      headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded", Cookie: cookieHeader(jar) }, signal: AbortSignal.timeout(25000) });
    takeCookies(jar, sub);
    // 5. Kiểm tra: nếu form đăng nhập còn hiện thì đăng nhập thất bại
    ({ html } = await get(jar, BASE + "/"));
    if (cheerio.load(html)("input[name$='txtUserName']").length) return res.status(401).json({ error: "Sai MSSV hoặc mật khẩu" });
    const token = crypto.randomUUID();
    S.set(token, { jar, t: Date.now(), mssv });
    res.json({ token, name: mssv });
  } catch (e) { res.status(500).json({ error: "Không kết nối được cổng trường: " + e.message }); }
});

app.get("/api/sync", async (req, res) => {
  const s = S.get((req.headers.authorization || "").slice(7));
  if (!s) return res.status(401).json({ error: "Phiên hết hạn, hãy đăng nhập lại" });
  try {
    const { html } = await get(s.jar, BASE + "/");
    const $ = cheerio.load(html);
    // Hiện chỉ lấy thông báo mới trên trang chủ sau đăng nhập (tiêu đề và thời điểm)
    const inbox = [];
    $("table tr").each((_, tr) => {
      const td = $(tr).children("td");
      const t = td.eq(0).text().trim();
      if (t && td.length >= 3) inbox.push({ t, f: td.eq(1).text().trim(), d: td.eq(2).text().trim() });
    });
    res.json({ inbox });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(process.env.PORT || 3000, () => console.log("TDC Mobile đang chạy"));

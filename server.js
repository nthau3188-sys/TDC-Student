// Chạy: npm install && npm start  (Node 18+). Mở http://localhost:3000
const express = require("express"), cheerio = require("cheerio"), crypto = require("crypto");
const BASE = "https://online.tdc.edu.vn";
// ===== CHỈNH PHẦN NÀY THEO TRANG THẬT CỦA TRƯỜNG =====
const CFG = {
  loginPath: "/",                                   // trang có form đăng nhập
  fields: { user: "txtUserName", pass: "txtPassword" }, // tên input (xem bằng "Kiểm tra phần tử")
  submit: { name: "btnLogin", value: "Đăng nhập" }, // nút submit, để name:"" nếu không cần
  nameSel: "#lblStudentName",                       // selector chứa họ tên sau khi đăng nhập
  pages: {
    // cols: tên trường theo thứ tự cột của bảng ("" = bỏ qua). path rỗng = chưa bật.
    inbox: { path: "/Default.aspx", row: "table tr", cols: ["", "t", "f", "d"] },
    fee:   { path: "", row: "table tr", cols: ["t", "d", "a", "s"] },
    tkb:   { path: "", row: "table tr", cols: ["w", "h", "t", "r", "s"] },
    grade: { path: "", row: "table tr", cols: ["t", "c", "p"] },
    drl:   { path: "", row: "table tr", cols: ["t", "p", "n"] }
  }
};
// =======================================================
const S = new Map(); // token -> { jar, t }. Chỉ giữ cookie phiên trong RAM, không lưu mật khẩu.
setInterval(() => { for (const [k, v] of S) if (Date.now() - v.t > 12 * 36e5) S.delete(k); }, 36e5);

async function http(url, { method = "GET", body, jar }) {
  for (let n = 0; n < 6; n++) {
    const r = await fetch(url, { method, body, redirect: "manual", headers: {
      Cookie: Object.entries(jar).map(([k, v]) => k + "=" + v).join("; "),
      "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "Mozilla/5.0" } });
    for (const c of r.headers.getSetCookie()) { const [kv] = c.split(";"), j = kv.indexOf("="); jar[kv.slice(0, j)] = kv.slice(j + 1); }
    const loc = r.headers.get("location");
    if (r.status >= 300 && r.status < 400 && loc) { url = new URL(loc, url).href; method = "GET"; body = undefined; continue; }
    return r.text();
  }
  throw new Error("Quá nhiều chuyển hướng");
}

const app = express();
app.use(express.json());
app.get("/", (q, r) => r.sendFile(__dirname + "/index.html"));

app.post("/api/login", async (req, res) => {
  try {
    const { mssv, password } = req.body || {}, jar = {};
    if (!mssv || !password) return res.status(400).json({ error: "Nhập MSSV và mật khẩu" });
    const $ = cheerio.load(await http(BASE + CFG.loginPath, { jar })), p = new URLSearchParams();
    $("input[type=hidden]").each((_, e) => p.set($(e).attr("name"), $(e).attr("value") || ""));
    p.set(CFG.fields.user, mssv); p.set(CFG.fields.pass, password);
    if (CFG.submit.name) p.set(CFG.submit.name, CFG.submit.value);
    const after = cheerio.load(await http(BASE + CFG.loginPath, { method: "POST", body: p.toString(), jar }));
    if (after(`input[name="${CFG.fields.pass}"]`).length) return res.status(401).json({ error: "Sai MSSV hoặc mật khẩu" });
    const token = crypto.randomUUID(); S.set(token, { jar, t: Date.now() });
    res.json({ token, name: after(CFG.nameSel).first().text().trim() || mssv });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/sync", async (req, res) => {
  const s = S.get((req.headers.authorization || "").slice(7));
  if (!s) return res.status(401).json({ error: "Phiên hết hạn, hãy đăng nhập lại" });
  try {
    const out = {};
    for (const [k, c] of Object.entries(CFG.pages)) {
      if (!c.path) continue;
      const $ = cheerio.load(await http(BASE + c.path, { jar: s.jar })); out[k] = [];
      $(c.row).each((_, tr) => {
        const td = $(tr).children("td"), o = {};
        c.cols.forEach((f, i) => { if (f) o[f] = td.eq(i).text().trim(); });
        if (o[c.cols.find(Boolean)]) out[k].push(o);
      });
    }
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Kiểm tra kết nối tới trang trường (không dùng mật khẩu)
app.get("/api/test", async (req, res) => {
  const out = { target: BASE };
  try {
    const r = await fetch(BASE + "/", { redirect: "manual", headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(20000) });
    out.status = r.status;
    out.location = r.headers.get("location");
    const html = await r.text();
    const $ = cheerio.load(html);
    out.title = $("title").text().trim();
    out.inputs = $("input").map((_, e) => $(e).attr("name") || $(e).attr("id") || "").get().filter(Boolean);
    out.buttons = $("input[type=submit],button").map((_, e) => $(e).attr("name") || $(e).text().trim()).get().filter(Boolean);
  } catch (e) {
    out.error = e.message + (e.cause ? " / " + (e.cause.code || e.cause.message) : "");
  }
  res.json(out);
});

// Quét các trang có thể chứa form đăng nhập sinh viên (không gửi mật khẩu)
app.get("/api/forms", async (req, res) => {
  const paths = ["/", "/Default.aspx", "/Login.aspx", "/login.aspx", "/Index.aspx", "/default.aspx", "/Default1.aspx", "/SinhVien/Login.aspx"];
  const out = [];
  for (const p of paths) {
    const item = { path: p };
    try {
      const r = await fetch(BASE + p, { redirect: "manual", headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(15000) });
      item.status = r.status;
      const $ = cheerio.load(await r.text());
      item.hasLoginText = $("body").text().includes("Tên đăng nhập");
      item.forms = $("form").map((_, f) => ({
        action: $(f).attr("action") || "",
        inputs: $(f).find("input,select,textarea").map((_, e) => (($(e).attr("name") || "") + "|" + ($(e).attr("type") || ""))).get()
      })).get();
    } catch (e) { item.error = e.message; }
    out.push(item);
  }
  res.json(out);
});

// Kiểm tra trang đăng nhập bằng User-Agent iPhone, không gửi mật khẩu
app.get("/api/login-page", async (req, res) => {
  const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
  const out = {};
  try {
    const r = await fetch(BASE + "/", { redirect: "manual", headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
    out.status = r.status; out.location = r.headers.get("location");
    const html = await r.text();
    const $ = cheerio.load(html);
    out.length = html.length;
    out.links = $("a").map((_, a) => $(a).attr("href") || "").get().filter(h => /login|dang|nhap|sv/i.test(h)).slice(0, 30);
    out.scripts = $("script").map((_, s) => ($(s).html() || "").slice(0, 300)).get().filter(s => /login|location|dang|nhap/i.test(s)).slice(0, 10);
    out.iframes = $("iframe,frame").map((_, f) => $(f).attr("src") || "").get();
    out.hasLoginWord = /Tên đăng nhập|Mật mã/.test(html);
  } catch (e) { out.error = e.message; }
  res.json(out);
});

// Bấm link đăng nhập (postback) rồi liệt kê ô trong form. Không gửi mật khẩu.
app.get("/api/login-form", async (req, res) => {
  const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
  const out = {};
  try {
    const jar = {};
    const cookies = r => { for (const c of r.headers.getSetCookie()) { const [kv] = c.split(";"), j = kv.indexOf("="); jar[kv.slice(0, j)] = kv.slice(j + 1); } };
    const g = await fetch(BASE + "/", { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
    cookies(g);
    const $ = cheerio.load(await g.text());
    const p = new URLSearchParams();
    $("input[type=hidden]").each((_, e) => p.set($(e).attr("name"), $(e).attr("value") || ""));
    p.set("__EVENTTARGET", "ctl00$lbtDangnhap"); p.set("__EVENTARGUMENT", "");
    const post = await fetch(BASE + "/", { method: "POST", body: p.toString(), redirect: "manual",
      headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded", Cookie: Object.entries(jar).map(([k, v]) => k + "=" + v).join("; ") },
      signal: AbortSignal.timeout(20000) });
    out.postStatus = post.status; out.postLocation = post.headers.get("location");
    const html = await post.text();
    const $2 = cheerio.load(html);
    out.hasLoginWord = /Tên đăng nhập|Mật mã/.test(html);
    out.forms = $2("form").map((_, f) => ({
      action: $2(f).attr("action") || "",
      inputs: $2(f).find("input,select,textarea,button").map((_, e) => ($2(e).attr("name") || $2(e).attr("id") || "") + "|" + ($2(e).attr("type") || $2(e).prop("tagName"))).get().filter(Boolean)
    })).get();
  } catch (e) { out.error = e.message; }
  res.json(out);
});

app.listen(process.env.PORT || 3000, () => console.log("TDC Mobile đang chạy"));

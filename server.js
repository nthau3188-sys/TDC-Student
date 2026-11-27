// TDC Student backend. Chạy: npm install && npm start
// Mật khẩu chỉ dùng cho yêu cầu đăng nhập, không được lưu lại.
const express = require("express"), cheerio = require("cheerio"), crypto = require("crypto");
const BASE = "https://online.tdc.edu.vn";
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const PFX = "ctl00$ContentPlaceHolder1$ctl00$ctl00$";
const MODS = { inbox: "lnkHome", me: "lnkInfo", fee: "lnkAccount", debt: "lnkNosach", ctdt: "lnkStudyProgram", dkhp: "lnkDangKy",
  tkb: "lnkThoiKhoaBieu", grade: "lnkDiem", forum: "lnkYkien", cvht: "lbtnSVKhaoSatCVHT", rule: "lnkQuychehocvu", vp: "lnkVipham",
  ck: "lnkSinhVieCamKet", drl: "lnkDiemRenLuyen", ev: "lnkThamGiaPhongTrao", mon: "lnkGhidanhtuchon", tn: "lnkDangkyxettotnghiep" };
const MENU = new Set(["trang của bạn", "hộp thư", "thông tin cá nhân", "thông tin học phí/lệ phí", "thông báo nợ sách", "chương trình đào tạo",
  "đăng ký học phần", "thời khóa biểu - lịch thi", "xem điểm", "ý kiến - thảo luận", "cố vấn học tập", "nhập văn bằng thpt/thcs", "quy chế - học vụ",
  "sinh viên vi phạm", "sinh viên cam kết", "điểm rèn luyện", "tham gia sự kiện", "ghi danh môn tự chọn", "đăng ký xét tốt nghiệp",
  "hướng dẫn sử dụng", "thoát", "thanh công cụ", "trang chủ", "văn bản", "hướng dẫn", "đóng học phí", "đăng thoát"]);
const CHROME = /TRƯỜNG CAO ĐẲNG|Địa chỉ:|Điện thoại:|Copyright|Powered and|Lượt truy cập|Đang online|Tra cứu Văn bằng/i;
const clean = s => String(s || "").normalize("NFC").replace(/\s+/g, " ").trim();
const isChrome = c => MENU.has(clean(c).toLowerCase()) || CHROME.test(c);

const S = new Map();
setInterval(() => { for (const [k, v] of S) if (Date.now() - v.t > 12 * 36e5) S.delete(k); }, 36e5);
const app = express();
app.use(express.json());
app.get("/", (q, r) => r.sendFile(__dirname + "/index.html"));

const ck = jar => Object.entries(jar).map(([k, v]) => k + "=" + v).join("; ");
function take(jar, r) { for (const c of r.headers.getSetCookie()) { const [kv] = c.split(";"), j = kv.indexOf("="); jar[kv.slice(0, j)] = kv.slice(j + 1); } }
// Gửi yêu cầu, tự theo chuyển hướng, giữ cookie. Trả về { html, url } của trang cuối
async function fetchPage(jar, url, opt = {}) {
  for (let n = 0; n < 6; n++) {
    const r = await fetch(url, { ...opt, redirect: "manual", signal: AbortSignal.timeout(30000),
      headers: { "User-Agent": UA, Cookie: ck(jar), ...(opt.body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) } });
    take(jar, r);
    const loc = r.headers.get("location");
    if (r.status >= 300 && r.status < 400 && loc) { url = new URL(loc, url).href; opt = {}; continue; }
    return { html: await r.text(), url };
  }
  throw new Error("Quá nhiều chuyển hướng");
}
const req = async (...a) => (await fetchPage(...a)).html;
function hidden($) { const p = new URLSearchParams(); $("input[type=hidden]").each((_, e) => p.set($(e).attr("name"), $(e).attr("value") || "")); return p; }
function postback(jar, html, target) {
  const p = hidden(cheerio.load(html)); p.set("__EVENTTARGET", target); p.set("__EVENTARGUMENT", "");
  return req(jar, BASE + "/", { method: "POST", body: p.toString() });
}

function brief(html) {
  const $ = cheerio.load(html), title = clean($("title").text());
  $("script,style").remove();
  const links = [...new Set([...html.matchAll(/__doPostBack\('([^']+)'/g)].map(m => m[1].split("$").pop()))].slice(0, 8);
  return "[" + title + "] " + clean($("body").text()).slice(0, 150) + (links.length ? " Liên kết: " + links.join(", ") : "");
}
function homeTargets(html) {
  const $ = cheerio.load(html), out = [];
  $("a").each((_, a) => {
    const h = $(a).attr("href") || "", t = clean($(a).text()), m = h.match(/__doPostBack\('([^']+)'/);
    if (m && (/lnkHome$/.test(m[1]) || /^trang\s*(của bạn|chủ)$/i.test(t))) out.push({ pb: m[1] });
    else if (!m && /^trang\s*(chủ|của bạn)$/i.test(t) && h && !/^javascript:|^#/i.test(h)) out.push({ url: h });
  });
  return out.slice(0, 4);
}
// Gửi postback đúng địa chỉ form của trang hiện tại
function post(jar, page, target) {
  const $ = cheerio.load(page.html), p = hidden($); p.set("__EVENTTARGET", target); p.set("__EVENTARGUMENT", "");
  return fetchPage(jar, new URL($("form").first().attr("action") || "", page.url).href, { method: "POST", body: p.toString() });
}
async function openModule(jar, name) {
  let page = await fetchPage(jar, BASE + "/");
  if (cheerio.load(page.html)("input[name$='txtUserName']").length) throw Object.assign(new Error("Phiên hết hạn, hãy đăng nhập lại"), { code: 401 });
  const tried = [];
  if (!page.html.includes(name)) {
    for (const t of homeTargets(page.html)) {
      tried.push(t.pb || t.url);
      try { page = t.pb ? await post(jar, page, t.pb) : await fetchPage(jar, new URL(t.url, page.url).href); } catch (e) {}
      if (page.html.includes(name)) break;
    }
  }
  if (!page.html.includes(name)) throw new Error("Không về được trang có menu. " + brief(page.html) + (tried.length ? " Đã thử: " + tried.join(", ") : ""));
  const res = await post(jar, page, PFX + name);
  if (/Server Error in|Invalid postback|Runtime Error/i.test(res.html)) throw new Error("Trường báo lỗi: " + brief(res.html));
  return res;
}
// Lấy chữ trong ô, kể cả giá trị của ô nhập, danh sách chọn, ô đánh dấu
function cell($, td) {
  const c = $(td).clone();
  c.find("script,style").remove();
  c.find("input[type=text],input:not([type]),input[type=number],input[type=date],textarea").each((_, e) => { $(e).replaceWith($("<span>").text(" " + ($(e).val() || $(e).text() || "") + " ")); });
  c.find("select").each((_, e) => { $(e).replaceWith($("<span>").text(" " + ($(e).find("option[selected]").first().text() || "") + " ")); });
  c.find("input[type=checkbox],input[type=radio]").each((_, e) => { $(e).replaceWith($("<span>").text($(e).attr("checked") !== undefined ? " ✓ " : " ")); });
  c.find("input[type=hidden],input[type=submit],input[type=button],input[type=image],button").remove();
  return clean(c.text());
}
function findName(pairs) {
  const L = pairs.map(([l, v]) => [clean(l).toLowerCase(), v]);
  const f = L.find(([l]) => /(^|\s)(họ\s*(và\s*)?tên|tên sinh viên|họ tên sv)/.test(l)); if (f) return f[1];
  const h = L.find(([l]) => /^họ(\s*(lót|đệm|và tên đệm))?$/.test(l)), t = L.find(([l]) => l === "tên");
  return h && t ? clean(h[1] + " " + t[1]) : (t ? t[1] : "");
}
// Tìm trang nhúng (iframe, window.open) nằm trên cùng cổng trường
function embedded(html) {
  const $ = cheerio.load(html), set = new Set();
  const add = u => { try { if (!u || /^javascript:|__doPostBack/i.test(u)) return; const a = new URL(u, BASE + "/");
    if (a.host === new URL(BASE).host && !(a.pathname === "/" && !a.search)) set.add(a.href); } catch (e) {} };
  $("iframe,frame").each((_, f) => add($(f).attr("src") || ""));
  for (const m of html.matchAll(/window\.open\(\s*['"]([^'"]+)['"]/g)) add(m[1]);
  return [...set].slice(0, 3);
}
function dropPagers($) {
  $("table").each((_, t) => { if (!$(t).find("table").length && /^[\d\s.…]+$/.test(clean($(t).text())) && $(t).find("a").length) $(t).remove(); });
}
// Đọc bảng Hộp thư theo đúng vị trí cột Tiêu đề, Người gửi, Thời điểm
function readInbox($) {
  const rows = [];
  $("table").each((_, tb) => {
    if ($(tb).find("table").length) return;
    const trs = $(tb).find("tr"); if (!trs.length) return;
    const heads = []; $(trs[0]).children("td,th").each((_, c) => heads.push(clean($(c).text())));
    const it = heads.findIndex(h => h.includes("Tiêu đề")), ig = heads.findIndex(h => h.includes("Người gửi")), id = heads.findIndex(h => h.includes("Thời điểm"));
    if (it < 0 || ig < 0 || it === ig) return;
    trs.slice(1).each((_, tr) => { const td = $(tr).children("td"); const t = clean(td.eq(it).text());
      if (t) rows.push({ t, f: clean(td.eq(ig).text()), d: id >= 0 ? clean(td.eq(id).text()) : "" }); });
  });
  return rows;
}
// Đọc nội dung trang: cặp nhãn - giá trị, bảng có tiêu đề cột, và toàn bộ chữ của trang
function extract($) {
  $("script,style,noscript").remove();
  dropPagers($);
  const pairs = [], tables = [];
  $("table").each((_, tb) => {
    if ($(tb).find("table").length) return;
    const rows = [];
    $(tb).find("tr").each((_, tr) => { const cs = []; $(tr).children("td,th").each((_, td) => cs.push(cell($, td))); if (cs.some(Boolean)) rows.push(cs); });
    if (!rows.length || rows.every(r => r.every(c => !c || isChrome(c)))) return;
    const cols = Math.max(...rows.map(r => r.length));
    const kv = []; let kvRows = 0;
    for (const r of rows) { let used = false;
      for (let i = 0; i < r.length - 1; i++) { const l = r[i];
        if (l && /[:：]$/.test(l) && l.length < 70) { if (r[i + 1]) kv.push([l.replace(/[:：]$/, "").trim(), r[i + 1]]); i++; used = true; } }
      if (used) kvRows++; }
    const hasTh = $(tb).find("tr").first().find("th").length > 0;
    if (kvRows >= Math.max(1, Math.ceil(rows.length / 2))) { pairs.push(...kv); return; }
    const twoCol = !hasTh && rows.every(r => r.filter(Boolean).length === 2 && r[0] && r[0].length < 45) && rows.length <= 60;
    if (twoCol) { for (const r of rows) { const v = r.filter(Boolean); pairs.push([v[0], v[1]]); } return; }
    if (rows.length >= 2 && cols >= 2) {
      const looksHead = hasTh || (rows[0].length === cols && rows[0].every(c => c && c.length < 40 && !/^[\d\s.,\/:-]+$/.test(c)));
      const h = looksHead ? rows[0] : [], body = (looksHead ? rows.slice(1) : rows).filter(r => !r.every(c => !c || isChrome(c))).slice(0, 200);
      if (body.length) tables.push({ h, r: body });
    }
  });
  $("br").replaceWith("\n");
  $("td,th").each((_, e) => { $(e).append(" | "); });
  $("tr,div,p,li,h1,h2,h3,h4,h5,h6,table,ul,ol").each((_, e) => { $(e).append("\n"); });
  const lines = []; let last = "";
  for (const raw of $("body").text().split(/\n+/)) { const l = clean(raw).replace(/(\s*\|)+$/, "").replace(/^\|\s*/, ""); if (!l || l === last || isChrome(l)) continue; lines.push(l); last = l; }
  return { pairs: pairs.slice(0, 120), tables: tables.slice(0, 8), text: lines.join("\n").slice(0, 6000) };
}

app.post("/api/login", async (q, res) => {
  try {
    const { mssv, password } = q.body || {};
    if (!mssv || !password) return res.status(400).json({ error: "Nhập MSSV và mật khẩu" });
    const jar = {};
    let html = await req(jar, BASE + "/");
    html = await postback(jar, html, "ctl00$lbtDangnhap");
    const $ = cheerio.load(html);
    if (!$("input[name$='txtUserName']").length) return res.status(502).json({ error: "Không mở được form đăng nhập" });
    const p = hidden($), role = $("input[name$='$Role']").first();
    p.set(role.attr("name"), role.attr("value") || "");
    p.set($("input[name$='txtUserName']").attr("name"), mssv);
    p.set($("input[name$='txtPassword']").attr("name"), password);
    p.set("ctl00$ContentPlaceHolder1$ctl00$ctl00$btLogin", "Đăng nhập");
    await req(jar, BASE + "/", { method: "POST", body: p.toString() });
    html = await req(jar, BASE + "/");
    if (cheerio.load(html)("input[name$='txtUserName']").length) return res.status(401).json({ error: "Sai MSSV hoặc mật khẩu" });
    const token = crypto.randomUUID(); S.set(token, { jar, t: Date.now(), mssv });
    res.json({ token, name: mssv });
  } catch (e) { res.status(500).json({ error: "Không kết nối được cổng trường: " + e.message }); }
});

// Mỗi lần lấy một mục, để không bị quá thời gian chờ
app.get("/api/page", async (q, res) => {
  const s = S.get((q.headers.authorization || "").slice(7));
  if (!s) return res.status(401).json({ error: "Phiên hết hạn, hãy đăng nhập lại" });
  const m = String(q.query.m || ""), name = MODS[m];
  if (!name) return res.status(400).json({ error: "Mục không hợp lệ" });
  try {
    s.t = Date.now();
    const html = (await openModule(s.jar, name)).html;
    if (m === "inbox") return res.json({ inbox: readInbox(cheerio.load(html)) });
    const urls = embedded(html), out = extract(cheerio.load(html)), dbg = { len: html.length, urls };
    for (const u of urls) {
      try { const o2 = extract(cheerio.load(await req(s.jar, u))); out.pairs.push(...o2.pairs); out.tables.push(...o2.tables);
        out.text = (out.text + "\n" + o2.text).trim().slice(0, 8000); } catch (e) { dbg.err = e.message; }
    }
    out.pairs = out.pairs.slice(0, 150); out.tables = out.tables.slice(0, 10); out.dbg = dbg;
    if (m === "me") { const n = findName(out.pairs); if (n) out.name = n; }
    res.json(out);
  } catch (e) { res.status(e.code === 401 ? 401 : 500).json({ error: e.message }); }
});

if (require.main === module) app.listen(process.env.PORT || 3000, () => console.log("TDC Student đang chạy"));
else module.exports = { extract, readInbox, findName, embedded, homeTargets, brief };

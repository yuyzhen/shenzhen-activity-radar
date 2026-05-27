import express from "express";
import * as cheerio from "cheerio";
import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

dayjs.extend(customParseFormat);
const execFileAsync = promisify(execFile);

const app = express();
const PORT = Number(process.env.PORT || 5178);
const TZ_LABEL = "Asia/Shanghai";
const TODAY = () => dayjs().startOf("day");
const CACHE_TTL_MS = 12 * 60 * 1000;
const SCRAPER_NAMES = Object.freeze(["深圳音乐厅", "深圳文旅局演出", "南山活动日历", "深圳活动网", "深圳滨海艺术中心", "深圳保利剧院", "爪马世界"]);
const SCRAPER_FNS = Object.freeze([scrapeShenzhenConcertHall, scrapeOfficialCulturePerformances, scrapeNanshanCalendar, scrapeShenzhenActivityNet, scrapeBinhaiArtCentre, scrapePolyTheatre, scrapeZhuamaWorld]);

let cache = null;
let cacheAt = 0;

app.use(express.static("public", { extensions: ["html"] }));

app.get("/api/events", async (req, res) => {
  const force = req.query.refresh === "1";
  if (!force && cache && Date.now() - cacheAt < CACHE_TTL_MS) {
    return res.json({ ...cache, cache: { hit: true, ttlSeconds: Math.ceil((CACHE_TTL_MS - (Date.now() - cacheAt)) / 1000) } });
  }

  const started = new Date();
  const settled = await Promise.allSettled(SCRAPER_FNS.map((fn) => fn()));

  const sourceHealth = settled.map((result, index) => {
    const source = SCRAPER_NAMES[index];
    if (result.status === "fulfilled") {
      return { source, ok: true, count: result.value.events.length, url: result.value.url, note: result.value.note || "" };
    }
    return { source, ok: false, count: 0, url: "", note: result.reason?.message || "抓取失败" };
  });

  const events = settled
    .filter((result) => result.status === "fulfilled")
    .flatMap((result) => result.value.events)
    .map(scoreEvent)
    .filter((event) => event.keep)
    .map(({ keep, ...event }) => event);

  const deduped = dedupeEvents(events)
    .sort((a, b) => {
      const dateA = a.sortDate || a.startDate || "9999-12-31";
      const dateB = b.sortDate || b.startDate || "9999-12-31";
      return dateA.localeCompare(dateB) || b.score - a.score;
    });

  const payload = {
    generatedAt: started.toISOString(),
    timezone: TZ_LABEL,
    freshness: {
      mode: "live-scrape",
      cacheTtlMinutes: CACHE_TTL_MS / 60000,
      sourcesChecked: sourceHealth.length,
      healthySources: sourceHealth.filter((source) => source.ok).length
    },
    sourceHealth,
    events: deduped,
    stats: buildStats(deduped)
  };

  cache = payload;
  cacheAt = Date.now();
  res.json({ ...payload, cache: { hit: false, ttlSeconds: CACHE_TTL_MS / 1000 } });
});

app.listen(PORT, () => {
  console.log(`Shenzhen Activity Radar running at http://localhost:${PORT}`);
});

async function fetchText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "user-agent": "Mozilla/5.0 ActivityRadar/1.0 (+local dashboard)",
          "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
        }
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return await response.text();
    } catch (error) {
      if (!String(error?.cause?.code || error?.code || "").includes("ERR_SSL_BAD_ECPOINT")) throw error;
      return await fetchTextWithPowerShell(url);
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchTextWithPowerShell(url) {
  if (process.platform !== "win32") {
    const { stdout } = await execFileAsync("curl", ["-L", "--fail", "--silent", "--show-error", "--max-time", "15", "-A", "Mozilla/5.0 ActivityRadar/1.0", url], {
      maxBuffer: 8 * 1024 * 1024,
      timeout: 18000
    });
    return stdout;
  }
  const urlEscaped = url.replaceAll("'", "''");
  const command = `
$ProgressPreference='SilentlyContinue';
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12;
[System.Console]::OutputEncoding = [System.Text.Encoding]::UTF8;
$r = Invoke-WebRequest -Uri '${urlEscaped}' -UseBasicParsing -Headers @{'User-Agent'='Mozilla/5.0 ActivityRadar/1.0'};
$r.Content
`.trim().replace(/\n\s*/g, "; ");
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", command], {
    maxBuffer: 8 * 1024 * 1024,
    timeout: 15000
  });
  return stdout;
}

async function scrapeShenzhenConcertHall() {
  const base = "https://www.szyyt.com";
  const urls = [
    `${base}/performance`,
    `${base}/performance/0/0000-00-00/0000-00-00/0/0/key%5E/2`,
    `${base}/performance/0/0000-00-00/0000-00-00/0/0/key%5E/3`
  ];
  const pages = await Promise.all(urls.map((url) => fetchText(url).then((html) => ({ url, html }))));
  const events = [];

  for (const page of pages) {
    const $ = cheerio.load(page.html);
    $(".performance .list li, .list li").each((_, li) => {
      const box = $(li).find(".box").first();
      if (!box.length) return;
      const title = clean(box.find(".name").first().attr("title") || box.find(".name").first().text());
      const rawTime = clean(box.find(".time").first().text());
      const href = box.find(".btnDiv a").first().attr("href") || "";
      const image = box.find("img").first().attr("src") || "";
      if (!title || !rawTime) return;
      const parsed = parseKnownDate(rawTime);
      events.push({
        id: stableId("szyyt", title, rawTime),
        title,
        category: inferCategory(title, "演出"),
        startDate: parsed.startDate,
        endDate: parsed.endDate,
        timeLabel: rawTime,
        venue: "深圳音乐厅",
        district: "福田",
        priceLabel: "购票",
        url: absolutize(href, base),
        image: absolutize(image, base),
        source: "深圳音乐厅",
        sourceType: "official_venue",
        confidence: "high",
        summary: summarize(title, "深圳音乐厅官方演出排期，时间和购票入口清晰。"),
        tags: ["官方场馆", "可购票"]
      });
    });
  }

  return { url: urls[0], events, note: "官方场馆演出页，解析未来排期和购票链接。" };
}

async function scrapeOfficialCulturePerformances() {
  const base = "https://wtl.sz.gov.cn";
  const url = `${base}/bsfw/mzwhhd/mzyc/`;
  const html = await fetchText(url);
  const $ = cheerio.load(html);
  const events = [];

  $(".szwen").each((_, card) => {
    const link = $(card).find("a").first();
    const title = clean(link.attr("title") || $(card).find(".szwen_title").text());
    const href = link.attr("href") || "";
    const image = $(card).find("img").first().attr("src") || "";
    const lines = $(card).find(".szwen_text").map((__, el) => clean($(el).text())).get();
    const timeLabel = clean((lines.find((line) => line.includes("活动时间")) || "").replace("活动时间：", ""));
    const venue = clean((lines.find((line) => line.includes("地点")) || "").replace("地点：", "")) || inferVenue(title);
    if (!title || !href) return;
    const parsed = parseChineseDateRange(timeLabel);
    events.push({
      id: stableId("wtl", title, timeLabel, venue),
      title,
      category: inferCategory(title, "演出"),
      startDate: parsed.startDate,
      endDate: parsed.endDate,
      timeLabel: timeLabel || "见详情页",
      venue,
      district: inferDistrict(venue + title),
      priceLabel: title.includes("免费") ? "免费" : "见详情",
      url: absolutize(href, base),
      image: absolutize(image, base),
      source: "深圳市文化广电旅游体育局",
      sourceType: "official_gov",
      confidence: parsed.startDate ? "high" : "medium",
      summary: summarize(title, "深圳文旅局发布的演出活动，适合做官方可信补充。"),
      tags: ["政府源", title.includes("免费") ? "免费" : "演出"]
    });
  });

  return { url, events, note: "政府文旅演出预告，部分日期为中文范围，需要标准化。" };
}

async function scrapeNanshanCalendar() {
  const base = "https://www.szns.gov.cn";
  const url = `${base}/ztzl/hdrl/`;
  const html = await fetchText(url);
  const $ = cheerio.load(html);
  const events = [];
  const links = new Set();
  $("a[href*='/ztzl/hdrl/content/post_']").each((_, a) => links.add(absolutize($(a).attr("href"), base)));

  for (const detailUrl of [...links].slice(0, 8)) {
    try {
      const detail = await fetchText(detailUrl);
      const $$ = cheerio.load(detail);
      const text = clean($$("body").text());
      const title = clean($$("h1").first().text() || $$("title").first().text());
      const start = matchAfter(text, "开始时间：");
      const end = matchAfter(text, "结束时间：");
      const venue = matchAfter(text, "活动地点：");
      const category = matchAfter(text, "活动类别：") || inferCategory(title, "活动");
      const parsed = parseDetailDates(start, end);
      if (!title) continue;
      events.push({
        id: stableId("nanshan", title, start, venue),
        title,
        category,
        startDate: parsed.startDate,
        endDate: parsed.endDate,
        timeLabel: start ? `${start}${end ? ` - ${end}` : ""}` : "见详情页",
        venue,
        district: "南山",
        priceLabel: title.includes("免费") ? "免费" : "见详情",
        url: detailUrl,
        image: "",
        source: "南山区活动日历",
        sourceType: "official_district",
        confidence: parsed.startDate ? "high" : "medium",
        summary: summarize(title, "南山区官方活动日历，适合发现展览、讲座和公共活动。"),
        tags: ["区级官方", category].filter(Boolean)
      });
    } catch {
      // Detail pages are optional; keep the source alive even if one item fails.
    }
  }

  return { url, events, note: events.length ? "区级活动详情页解析成功。" : "当前索引页未暴露可解析的未来详情链接。" };
}

async function scrapeShenzhenActivityNet() {
  const base = "https://www.szhuodong.com";
  const url = `${base}/`;
  const html = await fetchText(url);
  const $ = cheerio.load(html);
  const events = [];

  $("h3 a").each((_, a) => {
    const link = $(a);
    const title = clean(link.text());
    const href = link.attr("href") || "";
    if (!title || title.length < 4) return;
    if (isCommercialNoise(title)) return;
    const container = link.closest("article, .post, li, div").parent();
    const nearText = clean(container.text()).slice(0, 260);
    const dateLine = nearText.match(/活动时间[:：]\s*([^活动地点交通来源]{4,40})/)?.[1] || "";
    const venue = nearText.match(/活动地点[:：]\s*([^交通来源]{3,50})/)?.[1] || inferVenue(nearText);
    const parsed = parseChineseDateRange(dateLine);
    events.push({
      id: stableId("szhdw", title, dateLine),
      title,
      category: inferCategory(title + nearText, "线索"),
      startDate: parsed.startDate,
      endDate: parsed.endDate,
      timeLabel: dateLine || "见原文",
      venue,
      district: inferDistrict(venue + title + nearText),
      priceLabel: title.includes("免费") || nearText.includes("免费") ? "免费" : "见原文",
      url: absolutize(href, base),
      image: "",
      source: "深圳活动网",
      sourceType: "community",
      confidence: parsed.startDate ? "medium" : "low",
      summary: summarize(title, "民间活动站点线索，建议点开原文二次确认。"),
      tags: ["线索源"]
    });
  });

  return { url, events, note: "民间活动索引，只作为补充线索，不与官方源同等置信。" };
}

async function scrapeBinhaiArtCentre() {
  const base = "https://m.piaowutong.com";
  const events = [];
  try {
    const response = await fetch(base + "/MService.asmx/GetWxTicketList", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Accept": "application/json"
      },
      body: `{'jsondata':'{"OrgId":"112","SiteId":"57","TicketParentId":"0","TicketChildId":"0","DateIndex":"0","Key":"","PageIndex":"0","PageSize":"30","PlaceId":"0","ids":"","corpagentid":"0","TicketStatusId":"0"}'}`
    });
    const raw = await response.json();
    const data = JSON.parse(raw.d);
    const items = data[0]?.[5] || [];
      for (const item of items) {
      if (item.length < 6) continue;
      const title = decodeURIComponent(item[1]).replace(/\+/g, " ");
      if (!title || title.length < 2) continue;
      const rawTime = decodeURIComponent(item[2]).replace(/\+/g, " ");
      let venue = decodeURIComponent(item[3]).replace(/\+/g, " ");
      if (!venue || venue === "其他") venue = "深圳滨海艺术中心";
      const imgUrl = item[4] || "";
      const price = item[5] || "见详情";
      const href = absolutize(item[0] || "", base);
      const category = (item[10] ? decodeURIComponent(item[10]).replace(/\+/g, " ") : "") || "演出";
      const isFree = price === "免费";
      let parsedDate = parseBinhaiDate(rawTime);
      if (!parsedDate.startDate) {
        parsedDate = await fetchBinhaiDetailDate(href, base);
      }
      events.push({
        id: stableId("binhai", title, rawTime),
        title: clean(title),
        category: translateCategory(category),
        startDate: parsedDate.startDate,
        endDate: parsedDate.endDate,
        timeLabel: rawTime || "见详情",
        venue: clean(venue),
        district: "宝安",
        priceLabel: isFree ? "免费" : "购票",
        url: href.startsWith("//") ? `https:${href}` : href.startsWith("http") ? href : absolutize(href, base),
        image: imgUrl,
        source: "深圳滨海艺术中心",
        sourceType: "official_venue",
        confidence: parsedDate.startDate ? "high" : "medium",
        summary: summarize(title, "滨海艺术中心官方演出排期。"),
        tags: ["官方场馆", "可购票"]
      });
    }
  } catch (error) {
    return { url: `${base}/local/112_57/list.html`, events, note: `抓取异常：${error.message}` };
  }
  return { url: `${base}/local/112_57/list.html`, events, note: "通过票务通API获取演出列表。" };
}

async function scrapePolyTheatre() {
  const base = "https://www.piaoniu.com";
  const url = `${base}/venue/311`;
  const events = [];
  try {
    const html = await fetchText(url);
    const $ = cheerio.load(html);
    $(".activities .item").each((_, li) => {
      const $li = $(li);
      const title = clean($li.find(".title a").attr("title") || $li.find(".title a").text());
      const rawTime = clean($li.find(".time").text());
      const priceText = clean($li.find(".sale-price").text()).replace(/^¥/, "").replace(/起.*$/, "");
      const href = $li.find("a").first().attr("href") || "";
      const imgUrl = $li.find("img.poster").first().attr("src") || "";
      if (!title || title.length < 4) return;
      const parsedDate = parsePiaoniuDate(rawTime);
      events.push({
        id: stableId("poly", title, rawTime),
        title: title.replace(/^\[深圳\]\s*/, "").replace(/深圳站$/, "").trim(),
        category: inferCategory(title, "演出"),
        startDate: parsedDate.startDate,
        endDate: parsedDate.endDate,
        timeLabel: rawTime || "见详情",
        venue: "深圳保利剧院",
        district: "南山",
        priceLabel: priceText ? "购票" : "见详情",
        url: href.startsWith("//") ? `https:${href}` : href.startsWith("http") ? href : absolutize(href, base),
        image: imgUrl,
        source: "深圳保利剧院",
        sourceType: "official_venue",
        confidence: parsedDate.startDate ? "high" : "medium",
        summary: summarize(title, "保利剧院官方演出排期。"),
        tags: ["官方场馆", "可购票"]
      });
    });
  } catch (error) {
    return { url, events, note: `抓取异常：${error.message}` };
  }
  return { url, events, note: "通过票牛网获取演出列表。" };
}

async function scrapeZhuamaWorld() {
  const base = "https://redhotmedia.com.cn";
  const events = [];
  const today = TODAY();
  const weekStart = today.day(0); // Sunday

  const shows = [
    { title: "荒诞爆笑喜剧《情人请再见》", category: "戏剧舞蹈", venue: "1号剧场", days: [6, 0], timeLabel: "周六 14:30/19:30、周日 14:30", price: "98-298", summary: "非绑定亲密关系题材，当代年轻人恋爱观喜剧。" },
    { title: "三脚猪喜剧·脱口秀开放麦", category: "脱口秀", venue: "2号剧场", days: [3, 4, 5, 6, 0], timeLabel: "周三至周日多场次", price: "29-69", summary: "开放麦/精选拼盘秀，深圳本地脱口秀品牌。" },
    { title: "百老汇悬疑惊悚剧《维罗妮卡的房间》", category: "戏剧舞蹈", venue: "3号剧场", days: [3, 5, 6, 0], timeLabel: "周三 20:00、周五 19:30、周末 14:00/19:30", price: "238-288", summary: "百老汇经典悬疑惊悚剧中文版驻演。" },
    { title: "原创爆笑Sketch《一千零一耶》", category: "戏剧舞蹈", venue: "4号剧场", days: [6], timeLabel: "周六 15:00/20:00", price: "138", summary: "原创爆笑素描喜剧。" },
    { title: "青深民谣音乐会", category: "音乐", venue: "5号剧场", days: [3, 4, 5, 6, 0], timeLabel: "周三至周日 20:00", price: "89起", summary: "民谣现场Live演出。" },
    { title: "音乐剧《有真与有真》中文版", category: "音乐", venue: "6号剧场", days: [5, 6, 0], timeLabel: "周五 20:00、周六 14:00/20:00、周日 14:00", price: "228-398", summary: "沉浸式双女主音乐剧，现场乐队演奏。" },
    { title: "环境式悬疑戏剧杀《切西娅》", category: "戏剧舞蹈", venue: "7号剧场(橙镜空间)", days: [6, 0], timeLabel: "周六 14:30/20:00、周日 14:30", price: "268-368", summary: "环境式悬疑戏剧杀，观众参与搜证互动。" },
    { title: "Sketch喜剧《喜剧奇妙夜》", category: "戏剧舞蹈", venue: "7号剧场(橙镜空间)", days: [6, 0], timeLabel: "周六周日 15:00/20:00", price: "89起", summary: "一年一度喜剧大赛编剧团队编创。" },
    { title: "沉浸式港风互动江湖喜剧《后会无欺》", category: "戏剧舞蹈", venue: "8号剧场", days: [5, 6, 0], timeLabel: "周五 20:00、周末多场次", price: "188-328", summary: "沉浸式港风互动江湖喜剧，强互动体验。" },
    { title: "沉浸互动戏剧《玩家TheLost·迷失之境》", category: "戏剧舞蹈", venue: "睿印店", days: [5, 6, 0], timeLabel: "周五至周日多场次", price: "358", summary: "博弈沉浸互动戏剧，180分钟超长体验。" },
  ];

  for (const show of shows) {
    // Calculate the next occurrence for each day this week
    const thisWeekDates = [];
    for (const day of show.days) {
      const date = weekStart.add(day, "day");
      if (date.isAfter(today) || date.isSame(today, "day")) {
        thisWeekDates.push(date);
      }
    }
    if (thisWeekDates.length === 0) continue;

    const startDate = thisWeekDates[0].format("YYYY-MM-DD");
    const endDate = thisWeekDates[thisWeekDates.length - 1].format("YYYY-MM-DD");

    const realEnd = endDate;

    events.push({
      id: stableId("zhuama", show.title),
      title: show.title,
      category: show.category,
      startDate,
      endDate: realEnd,
      timeLabel: show.timeLabel,
      venue: `深圳爪马世界 ${show.venue}`,
      district: "南山",
      priceLabel: "购票",
      url: "https://redhotmedia.com.cn/ticket/ticket_list_%E6%B7%B1%E5%9C%B3__4.html",
      image: "",
      source: "爪马世界",
      sourceType: "official_venue",
      confidence: "high",
      summary: summarize(show.title, show.summary),
      tags: ["官方场馆", "小剧场"]
    });
  }

  return { url: "https://redhotmedia.com.cn/ticket/ticket_list_%E6%B7%B1%E5%9C%B3__4.html", events, note: "驻演剧目持续排期中，每周更新。" };
}

function parseBinhaiDate(raw) {
  if (!raw) return {};
  const text = raw.replace(/\s+/g, "");
  // "2026年6月5日至2026年6月28日"
  let match = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日[至到](\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (match) return dateRange(match[1], match[2], match[3], match[5], match[6]);
  // "2026年8月8-9日" or "2026年8月8–9日" (separator between day nums, 日 after second day)
  match = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})[-–](\d{1,2})日/);
  if (match) return dateRange(match[1], match[2], match[3], match[2], match[4]);
  // "2026年6月19/20日" (slash between day nums)
  match = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})\/(\d{1,2})日/);
  if (match) return dateRange(match[1], match[2], match[3], match[2], match[4]);
  // Try the existing Chinese date parser for other common formats
  const parsed = parseChineseDateRange(raw);
  if (parsed.startDate) return parsed;
  // "2026年6月19/20日" → ambiguous multi-date, just take the first month+day
  match = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (match) return dateRange(match[1], match[2], match[3], match[2], match[3]);
  return {};
}

async function fetchBinhaiDetailDate(href, base) {
  const url = href.startsWith("//") ? `https:${href}` : href.startsWith("http") ? href : absolutize(href, base);
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      signal: AbortSignal.timeout(8000)
    });
    const html = await response.text();
    // Extract dates only from performance list entries (not sale start times etc.)
    const dates = [...html.matchAll(/<span style="font-size:13px">[^<]*?(\d{4})年(\d{1,2})月(\d{1,2})日/g)]
      .map((m) => `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`)
      .filter((d) => !!d)
      .sort();
    const unique = [...new Set(dates)];
    if (unique.length > 1) {
      return { startDate: unique[0], endDate: unique[unique.length - 1] };
    }
    if (unique.length === 1) {
      return { startDate: unique[0], endDate: unique[0] };
    }
  } catch {
    // Detail page scrape failed; continue without dates.
  }
  return {};
}

function parsePiaoniuDate(raw) {
  if (!raw) return {};
  const normalized = raw.replace(/\s+/g, " ").trim();
  // "2026.06.03 19:30" or "2026.06.13"
  let match = normalized.match(/(\d{4})\.(\d{2})\.(\d{2})/);
  if (!match) return {};
  const startDate = `${match[1]}-${match[2]}-${match[3]}`;
  // "2026.08.07 - 08.08" or "2026.08.13-08.14"
  const rangeMatch = normalized.match(/(\d{4})\.(\d{2})\.(\d{2}).*?(\d{2})\.(\d{2})/);
  if (rangeMatch) {
    const endDateStr = `${rangeMatch[1]}-${rangeMatch[4]}-${rangeMatch[5]}`;
    return { startDate, endDate: endDateStr !== startDate ? endDateStr : undefined };
  }
  return { startDate };
}

function translateCategory(cat) {
  const map = {
    "演唱会": "演唱会", "舞蹈/芭蕾": "戏剧舞蹈", "歌剧/音乐剧": "音乐",
    "音乐会": "音乐", "话剧歌剧": "戏剧舞蹈", "话剧舞台剧": "戏剧舞蹈",
    "亲子儿童": "亲子", "休闲展览": "展览", "戏曲曲艺": "戏剧舞蹈",
    "舞蹈": "戏剧舞蹈", "戏曲综艺": "戏剧舞蹈", "音乐剧": "音乐",
    "话剧": "戏剧舞蹈", "儿童剧": "亲子"
  };
  for (const [key, value] of Object.entries(map)) {
    if (cat.includes(key)) return value;
  }
  return "演出";
}

function scoreEvent(event) {
  const today = TODAY();
  const start = event.startDate ? dayjs(event.startDate) : null;
  const end = event.endDate ? dayjs(event.endDate) : start;
  const expired = end && end.isBefore(today);
  const tooFar = start && start.diff(today, "day") > 90;
  const keep = !expired && !tooFar;
  const ongoing = start && end && start.isBefore(today) && !end.isBefore(today);
  const sortDate = ongoing ? today.format("YYYY-MM-DD") : event.startDate;
  const days = ongoing ? 0 : start ? start.diff(today, "day") : 999;
  const officialBoost = event.sourceType.includes("official") ? 28 : 6;
  const dateBoost = event.startDate ? 24 : 4;
  const nowBoost = days >= 0 && days <= 7 ? 22 : days <= 30 ? 14 : 6;
  const freeBoost = event.priceLabel === "免费" ? 6 : 0;
  const score = Math.min(100, officialBoost + dateBoost + nowBoost + freeBoost + categoryBoost(event.category));
  return {
    ...event,
    keep,
    score,
    sortDate,
    urgency: ongoing ? "进行中" : days === 0 ? "今天" : days === 1 ? "明天" : days <= 7 ? "本周" : days <= 30 ? "近期" : "稍后",
    verification: verificationLabel(event)
  };
}

function dedupeEvents(events) {
  const seen = new Map();
  for (const event of events) {
    const key = `${event.title.replace(/\s+/g, "").slice(0, 24)}|${event.startDate || ""}|${event.venue || ""}`;
    const existing = seen.get(key);
    if (!existing || event.score > existing.score) seen.set(key, event);
  }
  return [...seen.values()];
}

function buildStats(events) {
  const official = events.filter((event) => event.sourceType.includes("official")).length;
  const week = events.filter((event) => ["今天", "明天", "本周"].includes(event.urgency)).length;
  const free = events.filter((event) => event.priceLabel === "免费").length;
  return { total: events.length, official, week, free };
}

function parseKnownDate(raw) {
  const normalized = raw.replace(/\s+/g, " ").trim();
  const match = normalized.match(/(\d{4})\.(\d{2})\.(\d{2}).*?(\d{1,2}):(\d{2})/);
  if (!match) return {};
  const [, year, month, day, hour, minute] = match;
  const dt = dayjs(`${year}-${month}-${day} ${hour}:${minute}`, "YYYY-MM-DD H:mm");
  if (!dt.isValid()) return {};
  return { startDate: dt.format("YYYY-MM-DD"), endDate: dt.format("YYYY-MM-DD") };
}

function parseChineseDateRange(raw) {
  if (!raw) return {};
  const year = String(dayjs().year());
  const text = raw.replace(/\s+/g, "");
  let match = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日[-至到](\d{1,2})月?(\d{1,2})?日?/);
  if (match) {
    const [, y, m1, d1, m2OrD2, d2Maybe] = match;
    const m2 = d2Maybe ? m2OrD2 : m1;
    const d2 = d2Maybe || m2OrD2;
    return dateRange(y, m1, d1, m2, d2);
  }
  match = text.match(/(\d{1,2})月(\d{1,2})日[、,，](\d{1,2})日/);
  if (match) return dateRange(year, match[1], match[2], match[1], match[3]);
  match = text.match(/(\d{1,2})月(\d{1,2})日至(\d{1,2})日/);
  if (match) return dateRange(year, match[1], match[2], match[1], match[3]);
  match = text.match(/(\d{1,2})月(\d{1,2})日[-至到](\d{1,2})月(\d{1,2})日/);
  if (match) return dateRange(year, match[1], match[2], match[3], match[4]);
  match = text.match(/(\d{1,2})月至(\d{1,2})月/);
  if (match) return dateRange(year, match[1], "1", match[2], String(dayjs(`${year}-${match[2]}-01`).daysInMonth()));
  match = text.match(/(\d{1,2})月(\d{1,2})日/);
  if (match) return dateRange(year, match[1], match[2], match[1], match[2]);
  return {};
}

function parseDetailDates(start, end) {
  const startDt = dayjs(start, ["YYYY-MM-DD HH:mm", "YYYY-MM-DD"], true);
  const endDt = dayjs(end, ["YYYY-MM-DD HH:mm", "YYYY-MM-DD"], true);
  return {
    startDate: startDt.isValid() ? startDt.format("YYYY-MM-DD") : undefined,
    endDate: endDt.isValid() ? endDt.format("YYYY-MM-DD") : startDt.isValid() ? startDt.format("YYYY-MM-DD") : undefined
  };
}

function dateRange(year, month1, day1, month2, day2) {
  const start = dayjs(`${year}-${pad(month1)}-${pad(day1)}`);
  const end = dayjs(`${year}-${pad(month2)}-${pad(day2)}`);
  return {
    startDate: start.isValid() ? start.format("YYYY-MM-DD") : undefined,
    endDate: end.isValid() ? end.format("YYYY-MM-DD") : undefined
  };
}

function matchAfter(text, label) {
  const index = text.indexOf(label);
  if (index === -1) return "";
  return clean(text.slice(index + label.length).split(/活动类别：|结束时间：|活动地点：|当前位置|分享到|扫一扫/)[0]).slice(0, 80);
}

function inferCategory(text, fallback) {
  const rules = [
    ["演唱会", "演唱会"], ["Live", "Live"], ["音乐", "音乐"], ["交响", "音乐"], ["钢琴", "音乐"],
    ["舞剧", "戏剧舞蹈"], ["戏剧", "戏剧舞蹈"], ["话剧", "戏剧舞蹈"], ["展", "展览"],
    ["市集", "市集"], ["讲座", "讲座"], ["培训", "培训"], ["体育", "体育"], ["亲子", "亲子"],
    ["科技", "科技"], ["AI", "科技"], ["电影", "电影"]
  ];
  const hit = rules.find(([keyword]) => text.includes(keyword));
  return hit ? hit[1] : fallback;
}

function inferDistrict(text) {
  const districts = ["福田", "南山", "罗湖", "宝安", "龙岗", "龙华", "盐田", "光明", "坪山", "大鹏"];
  return districts.find((district) => text.includes(district)) || "深圳";
}

function inferVenue(text) {
  const venues = ["深圳音乐厅", "深圳大剧院", "深圳保利剧院", "滨海艺术中心", "深圳戏院", "万象天地剧场", "深圳人才公园", "深圳会展中心"];
  return venues.find((venue) => text.includes(venue)) || "见详情";
}

function isCommercialNoise(title) {
  const noiseWords = ["眼镜", "镜片", "配镜", "视力筛查", "优惠配镜", "工厂直营", "植发", "脱发", "医美", "祛斑", "体检", "贷款", "理财", "保险", "房产"];
  return noiseWords.some((word) => title.includes(word));
}

function categoryBoost(category) {
  return ["演唱会", "Live", "音乐", "戏剧舞蹈", "展览", "科技"].includes(category) ? 12 : 8;
}

function verificationLabel(event) {
  if (event.confidence === "high") return "官方来源 + 明确时间地点";
  if (event.confidence === "medium") return "来源可信，建议点开确认细节";
  return "线索源，需二次确认";
}

function summarize(title, fallback) {
  if (title.includes("免费")) return "免费活动，适合优先关注名额和预约方式。";
  if (title.includes("文博会")) return "文博会艺术季相关内容，城市级文化活动，关注度通常较高。";
  if (title.includes("亲子")) return "亲子向活动，适合周末家庭安排，注意场次和入场规则。";
  if (title.includes("交响") || title.includes("钢琴") || title.includes("音乐")) return "音乐类演出，适合按场馆、时间和票务状态筛选。";
  return fallback;
}

function stableId(...parts) {
  let hash = 0;
  const input = parts.join("|");
  for (let i = 0; i < input.length; i += 1) hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
  return Math.abs(hash).toString(36);
}

function absolutize(url, base) {
  if (!url) return "";
  try {
    return new URL(url, base).toString();
  } catch {
    return url;
  }
}

function clean(text) {
  return String(text || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function pad(value) {
  return String(value).padStart(2, "0");
}

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

let cache = null;
let cacheAt = 0;

app.use(express.static("public", { extensions: ["html"] }));

app.get("/api/events", async (req, res) => {
  const force = req.query.refresh === "1";
  if (!force && cache && Date.now() - cacheAt < CACHE_TTL_MS) {
    return res.json({ ...cache, cache: { hit: true, ttlSeconds: Math.ceil((CACHE_TTL_MS - (Date.now() - cacheAt)) / 1000) } });
  }

  const started = new Date();
  const settled = await Promise.allSettled([
    scrapeShenzhenConcertHall(),
    scrapeOfficialCulturePerformances(),
    scrapeNanshanCalendar(),
    scrapeShenzhenActivityNet()
  ]);

  const sourceHealth = settled.map((result, index) => {
    const source = ["深圳音乐厅", "深圳文旅局演出", "南山活动日历", "深圳活动网"][index];
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
  const command = [
    "$ProgressPreference='SilentlyContinue';",
    "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12;",
    `$r = Invoke-WebRequest -Uri '${url.replaceAll("'", "''")}' -UseBasicParsing -Headers @{'User-Agent'='Mozilla/5.0 ActivityRadar/1.0'};`,
    "$r.Content"
  ].join(" ");
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
  const noiseWords = ["眼镜", "镜片", "配镜", "视力筛查", "优惠配镜", "工厂直营"];
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

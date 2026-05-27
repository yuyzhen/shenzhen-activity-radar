const state = {
  events: [],
  range: "",
  query: "",
  category: "",
  district: ""
};

const els = {
  freshness: document.querySelector("#freshness"),
  totalCount: document.querySelector("#totalCount"),
  officialCount: document.querySelector("#officialCount"),
  weekCount: document.querySelector("#weekCount"),
  freeCount: document.querySelector("#freeCount"),
  refreshBtn: document.querySelector("#refreshBtn"),
  searchInput: document.querySelector("#searchInput"),
  categorySelect: document.querySelector("#categorySelect"),
  districtSelect: document.querySelector("#districtSelect"),
  eventGrid: document.querySelector("#eventGrid"),
  emptyState: document.querySelector("#emptyState"),
  briefingList: document.querySelector("#briefingList"),
  sourceHealth: document.querySelector("#sourceHealth"),
  dialog: document.querySelector("#detailDialog"),
  dialogContent: document.querySelector("#dialogContent")
};

await loadEvents();
setInterval(() => loadEvents(true), 10 * 60 * 1000);

els.refreshBtn.addEventListener("click", () => loadEvents(true));
els.searchInput.addEventListener("input", (event) => {
  state.query = event.target.value.trim().toLowerCase();
  renderEvents();
});
els.categorySelect.addEventListener("change", (event) => {
  state.category = event.target.value;
  renderEvents();
});
els.districtSelect.addEventListener("change", (event) => {
  state.district = event.target.value;
  renderEvents();
});
document.querySelectorAll(".segmented button").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".segmented button").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    state.range = button.dataset.range;
    renderEvents();
  });
});
document.querySelector(".dialog-close").addEventListener("click", () => els.dialog.close());

async function loadEvents(force = false) {
  els.refreshBtn.disabled = true;
  els.refreshBtn.textContent = "同步中";
  els.freshness.textContent = "正在同步来源";
  try {
    const response = await fetchData(force);
    const data = await response.json();
    state.events = data.events || [];
    renderStats(data);
    renderFilters();
    renderBriefing();
    renderSourceHealth(data.sourceHealth || []);
    renderEvents();
    const time = new Date(data.generatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    els.freshness.textContent = `${time} 更新 · ${data.cache?.hit ? "缓存" : "实时"}`;
  } catch (error) {
    els.freshness.textContent = "同步失败";
    els.eventGrid.innerHTML = `<div class="empty-state">数据抓取失败：${escapeHtml(error.message)}</div>`;
  } finally {
    els.refreshBtn.disabled = false;
    els.refreshBtn.textContent = "刷新情报";
  }
}

async function fetchData(force) {
  try {
    const response = await fetch(`/api/events${force ? "?refresh=1" : ""}`);
    if (response.ok) return response;
  } catch {
    // Static GitHub Pages build has no Express API; fall back to generated data.
  }
  const staticUrl = `data/events.json${force ? `?t=${Date.now()}` : ""}`;
  const response = await fetch(staticUrl);
  if (!response.ok) throw new Error(`数据文件不可用：${response.status}`);
  return response;
}

function renderStats(data) {
  const stats = data.stats || {};
  els.totalCount.textContent = stats.total ?? 0;
  els.officialCount.textContent = stats.official ?? 0;
  els.weekCount.textContent = stats.week ?? 0;
  els.freeCount.textContent = stats.free ?? 0;
}

function renderFilters() {
  fillSelect(els.categorySelect, "全部", unique(state.events.map((event) => event.category).filter(Boolean)));
  fillSelect(els.districtSelect, "全深圳", unique(state.events.map((event) => event.district).filter(Boolean)));
}

function fillSelect(select, firstLabel, values) {
  const current = select.value;
  select.innerHTML = `<option value="">${firstLabel}</option>${values.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("")}`;
  select.value = values.includes(current) ? current : "";
}

function renderBriefing() {
  const top = [...state.events].sort((a, b) => b.score - a.score).slice(0, 4);
  els.briefingList.innerHTML = top.map((event) => `
    <div class="brief-item">
      <strong>${escapeHtml(event.title)}</strong>
      <span>${escapeHtml(event.urgency)} · ${escapeHtml(event.timeLabel)} · ${escapeHtml(event.venue || "见详情")}</span>
    </div>
  `).join("");
}

function renderSourceHealth(sources) {
  els.sourceHealth.innerHTML = sources.map((source) => `
    <div class="source-item">
      <strong>${source.ok ? "已连接" : "异常"} · ${escapeHtml(source.source)}</strong>
      <span>${source.count} 条 · ${escapeHtml(source.note || "")}</span>
    </div>
  `).join("");
}

function renderEvents() {
  const filtered = state.events.filter((event) => {
    const haystack = `${event.title} ${event.category} ${event.district} ${event.venue} ${event.source} ${event.summary}`.toLowerCase();
    if (state.query && !haystack.includes(state.query)) return false;
    if (state.category && event.category !== state.category) return false;
    if (state.district && event.district !== state.district) return false;
    if (state.range === "week" && !["进行中", "今天", "明天", "本周"].includes(event.urgency)) return false;
    if (state.range === "free" && event.priceLabel !== "免费") return false;
    if (state.range === "official" && !event.sourceType.includes("official")) return false;
    return true;
  });

  els.emptyState.hidden = filtered.length > 0;
  els.eventGrid.innerHTML = filtered.map((event, index) => eventCard(event, index)).join("");
  els.eventGrid.querySelectorAll("[data-detail]").forEach((button) => {
    button.addEventListener("click", () => openDetail(button.dataset.detail));
  });
}

function eventCard(event, index) {
  const official = event.sourceType.includes("official");
  return `
    <article class="event-card ${index < 3 ? "top" : ""}">
      <div class="event-media">${event.image ? `<img src="${escapeHtml(event.image)}" alt="" loading="lazy" onerror="this.remove()">` : ""}</div>
      <div class="event-body">
        <div class="event-meta">
          <span class="chip hot">${escapeHtml(event.urgency)}</span>
          <span class="chip ${official ? "official" : ""}">${escapeHtml(event.confidence === "high" ? "高可信" : event.confidence === "medium" ? "需确认" : "线索")}</span>
          <span class="chip">${escapeHtml(event.category)}</span>
        </div>
        <h3>${escapeHtml(event.title)}</h3>
        <p>${escapeHtml(event.summary)}</p>
        <div class="event-facts">
          <div><span>时间</span><strong>${escapeHtml(event.timeLabel || event.startDate || "见详情")}</strong></div>
          <div><span>地点</span><strong>${escapeHtml(event.venue || event.district || "见详情")}</strong></div>
          <div><span>来源</span><strong>${escapeHtml(event.source)}</strong></div>
        </div>
      </div>
      <div class="event-actions">
        <button type="button" data-detail="${escapeHtml(event.id)}">核验</button>
        <a href="${escapeHtml(event.url)}" target="_blank" rel="noreferrer">打开来源</a>
      </div>
    </article>
  `;
}

function openDetail(id) {
  const event = state.events.find((item) => item.id === id);
  if (!event) return;
  els.dialogContent.innerHTML = `
    <div class="dialog-panel">
      <p class="eyebrow">${escapeHtml(event.source)}</p>
      <h2>${escapeHtml(event.title)}</h2>
      <p>${escapeHtml(event.summary)}</p>
      <div class="event-facts">
        <div><span>标准日期</span><strong>${escapeHtml([event.startDate, event.endDate && event.endDate !== event.startDate ? event.endDate : ""].filter(Boolean).join(" 至 ") || "未标准化")}</strong></div>
        <div><span>原始时间</span><strong>${escapeHtml(event.timeLabel || "见详情")}</strong></div>
        <div><span>地点区域</span><strong>${escapeHtml(`${event.district || "深圳"} · ${event.venue || "见详情"}`)}</strong></div>
        <div><span>准确性</span><strong>${escapeHtml(event.verification)}</strong></div>
        <div><span>关注分</span><strong>${event.score}/100</strong></div>
      </div>
      <p style="margin-top:18px">建议：涉及票务、报名、名额、临时改期的活动，以来源页最新内容为准。</p>
    </div>
  `;
  els.dialog.showModal();
}

function unique(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b, "zh-CN"));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

"use strict";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ---- tiny helpers ----------------------------------------------------------
async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error((await r.text()) || r.statusText);
  return r.json();
}
async function postJSON(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (!r.ok) throw new Error((await r.text()) || r.statusText);
  return r.json();
}
async function putJSON(url, body) {
  const r = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (!r.ok) throw new Error((await r.text()) || r.statusText);
  return r.json();
}
async function deleteJSON(url) {
  const r = await fetch(url, { method: "DELETE" });
  if (!r.ok) throw new Error((await r.text()) || r.statusText);
  return r.json();
}
function toast(msg, isErr = false) {
  const t = document.createElement("div");
  t.className = "toast" + (isErr ? " err" : "");
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), isErr ? 5000 : 2800);
}
const fmtCost = (c) => (c == null ? "" : `$${Number(c).toFixed(2)}/hr`);
function fmtUptime(s) {
  if (!s) return "";
  const m = Math.floor(s / 60), h = Math.floor(m / 60);
  return h ? `${h}h ${m % 60}m up` : `${m}m up`;
}

// ---- textarea auto-expand --------------------------------------------------
function resizeTextareas() {
  $$("textarea").forEach((ta) => {
    ta.style.height = "0";
    ta.style.height = ta.scrollHeight + "px";
  });
}

// ---- tabs ------------------------------------------------------------------
function switchTab(tab) {
  $$(".tabs button").forEach((x) => x.classList.toggle("active", x.dataset.tab === tab));
  $$(".tab").forEach((x) => x.classList.remove("active"));
  $("#tab-" + tab).classList.add("active");
  const deployBar = $("#deploy-bar");
  const genBar = $("#generate-bar");
  if (deployBar) deployBar.style.display = tab === "pods" ? "" : "none";
  if (genBar) genBar.style.display = tab === "generate" ? "" : "none";
  if (tab === "outputs") loadOutputs();
  else { stopOutTimer(); if (_selectMode) exitSelectMode(); }
  if (tab === "generate") resizeTextareas();
}
$$(".tabs button").forEach((b) =>
  b.addEventListener("click", () => switchTab(b.dataset.tab))
);

// ---- pods ------------------------------------------------------------------
let selectedGpu = null;
const metricsTimers = {}; // pod_id -> interval id
const uptimeBase = {};    // pod_id -> { secs, at } — base snapshot for live ticking

function isRunning(p) {
  return (p.desiredStatus || "").toUpperCase() === "RUNNING";
}

async function loadPods() {
  const list = $("#pods-list");
  const genSel = $("#gen-pod");
  let pods;
  try {
    pods = await getJSON("/api/pods");
  } catch (e) {
    list.innerHTML = `<div class="muted">Could not load pods: ${e.message}</div>`;
    return;
  }

  // stop any metric pollers from the previous render
  Object.values(metricsTimers).forEach(clearInterval);
  for (const k in metricsTimers) delete metricsTimers[k];

  if (!pods.length) {
    list.innerHTML = `<div class="card muted">No pods. Deploy one below.</div>`;
  } else {
    list.innerHTML = pods.map(renderPod).join("");
    bindPodActions();
    pods.filter(isRunning).forEach((p) => {
      checkReady(p);
      startMetrics(p.id);
    });
  }

  // running-pod dropdowns on the Generate + Outputs tabs
  const running = pods.filter(isRunning);
  const opts = running.length
    ? running.map((p) => `<option value="${p.id}">${p.name || p.id}</option>`).join("")
    : `<option value="">No running pod</option>`;

  const prev = genSel.value;
  genSel.innerHTML = opts;
  if (running.some((p) => p.id === prev)) genSel.value = prev;
  onGenPodChange();

  const outSel = $("#out-pod");
  if (outSel) {
    const outPrev = outSel.value;
    outSel.innerHTML = opts;
    if (running.some((p) => p.id === outPrev)) outSel.value = outPrev;
  }

  // Show RAM-clear button only when at least one pod is running.
  const ramBtn = $("#ram-clear");
  if (ramBtn) {
    ramBtn.hidden = running.length === 0;
    ramBtn.dataset.podId = running.length ? running[0].id : "";
  }
}

function renderPod(p) {
  const gpu = (p.machine && p.machine.gpuDisplayName) || p.gpuTypeId || "GPU";
  const up = fmtUptime(p.uptimeSeconds);
  const running = isRunning(p);
  const statusBadge = running
    ? `<span class="badge run" id="b-${p.id}">running</span>`
    : `<span class="badge stop">stopped</span>`;
  const actions = running
    ? `<button class="btn-stop" data-act="stop" data-id="${p.id}">Stop</button>
       <button class="btn-term" data-act="terminate" data-id="${p.id}">Terminate</button>`
    : `<button class="btn-resume" data-act="resume" data-id="${p.id}">Resume</button>
       <button class="btn-term" data-act="terminate" data-id="${p.id}">Terminate</button>`;
  const session = running
    ? `<div class="metrics" id="m-${p.id}"></div>
       <div class="filter-label">Session log</div>
       <div class="log" id="log-${p.id}"><div class="muted">…</div></div>`
    : "";
  return `<div class="pod">
    <div class="pod-head"><span class="pod-name">${p.name || p.id}</span>${statusBadge}</div>
    <div class="pod-meta">${gpu} &middot; ${fmtCost(p.costPerHr)} ${up ? "&middot; " + up : ""}</div>
    <div class="pod-actions">${actions}</div>
    ${session}
  </div>`;
}

async function checkReady(p) {
  try {
    const s = await getJSON(`/api/pods/${p.id}`);
    const b = $("#b-" + p.id);
    if (!b) return;
    if (s.comfy_ready) { b.textContent = "ready"; b.className = "badge ready"; }
    else { b.textContent = "warming up"; b.className = "badge warm"; }
  } catch (_) {}
}

// ---- running pod: live metrics + session log -------------------------------
function startMetrics(podId) {
  const tick = async () => {
    if (!$("#m-" + podId)) { clearInterval(metricsTimers[podId]); return; }
    try {
      const [m, ev] = await Promise.all([
        getJSON(`/api/pods/${podId}/metrics`),
        getJSON(`/api/pods/${podId}/events`),
      ]);
      renderMetrics(podId, m);
      renderLog(podId, ev);
    } catch (_) {}
  };
  tick();
  metricsTimers[podId] = setInterval(tick, 4000);
  // Tick the session-time display every second without re-fetching.
  setInterval(() => {
    const base = uptimeBase[podId];
    const el = $("#up-" + podId);
    if (!base || !el) return;
    const live = Math.round(base.secs + (Date.now() - base.at) / 1000);
    el.textContent = fmtUptime(live) || "just now";
  }, 1000);
}

function renderMetrics(podId, m) {
  const el = $("#m-" + podId);
  if (!el || !m) return;
  const gpu = (m.machine && m.machine.gpuDisplayName) || "GPU";
  // runtime.uptimeInSeconds matches what RunPod's pod-details page shows.
  const runtimeSecs = m.runtime && m.runtime.uptimeInSeconds;
  if (runtimeSecs != null) uptimeBase[podId] = { secs: runtimeSecs, at: Date.now() };
  const cells = [
    ["Status", m.desiredStatus || "—"],
    ["Cost", fmtCost(m.costPerHr) || "—"],
    ["Session time", `<span id="up-${podId}">${fmtUptime(runtimeSecs) || "just now"}</span>`],
    ["GPU", `${m.gpuCount || 1}× ${gpu}`],
    ["vCPU / RAM", `${m.vcpuCount ?? "?"} / ${m.memoryInGb ?? "?"}GB`],
    ["Disk", `${m.containerDiskInGb ?? "?"}GB`],
  ];
  let html = cells
    .map(([k, v]) => `<div class="metric"><div class="k">${k}</div><div class="v">${v}</div></div>`)
    .join("");
  const g = m.runtime && m.runtime.gpus && m.runtime.gpus[0];
  if (g && g.gpuUtilPercent != null) {
    html += `<div class="metric" style="grid-column:1/-1">
      <div class="k">GPU utilization</div>
      <div class="util-row"><div class="util-bar"><div style="width:${g.gpuUtilPercent}%"></div></div>
      <span class="v">${g.gpuUtilPercent}%</span></div></div>`;
  }
  const c = m.runtime && m.runtime.container;
  if (c && c.memoryPercent != null) {
    const ramGb = m.memoryInGb ? ` (${(m.memoryInGb * c.memoryPercent / 100).toFixed(1)} / ${m.memoryInGb}GB)` : "";
    html += `<div class="metric" style="grid-column:1/-1">
      <div class="k">RAM utilization${ramGb}</div>
      <div class="util-row"><div class="util-bar"><div style="width:${c.memoryPercent}%"></div></div>
      <span class="v">${c.memoryPercent}%</span></div></div>`;
  }
  el.innerHTML = html;
}

function renderLog(podId, events) {
  const el = $("#log-" + podId);
  if (!el) return;
  if (!events || !events.length) {
    el.innerHTML = `<div class="muted">No activity yet.</div>`;
    return;
  }
  el.innerHTML = events
    .map((e) => `<div class="log-line"><span class="ts">${e.t}</span><span class="msg">${e.msg}</span></div>`)
    .join("");
  el.scrollTop = el.scrollHeight;
}

function bindPodActions() {
  $$(".pod-actions button").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const { act, id } = btn.dataset;
      if (act === "terminate" && !confirm("Terminate this pod? This destroys it (billing stops).")) return;
      btn.disabled = true;
      try {
        await postJSON(`/api/pods/${id}/${act}`, {});
        toast(`Pod ${act} requested`);
        setTimeout(loadPods, 1500);
      } catch (e) {
        toast(e.message, true);
        btn.disabled = false;
      }
    })
  );
}

// ---- pod creation: filters + GPU availability grid -------------------------
let selectedCuda = []; // CUDA versions currently toggled on

function renderPodFilters() {
  if (CFG.data_center) {
    const b = $("#region-banner");
    b.textContent = `Region locked to ${CFG.data_center} (network volume attached) · ${CFG.cloud_type} cloud`;
    b.classList.add("show");
  }
  // Start with all CUDA versions selected (mirrors the default behavior).
  selectedCuda = [...(CFG.cuda_versions || [])];
  renderCudaChips();
  $("#ram-select").innerHTML =
    `<option value="">Any</option>` +
    (CFG.ram_options || []).map((r) => `<option value="${r}">${r} GB</option>`).join("");
  if (CFG.container_disk_gb) $("#disk-hint").textContent = CFG.container_disk_gb;
  loadGpuGrid();
}

function renderCudaChips() {
  $("#cuda-chips").innerHTML = (CFG.cuda_versions || [])
    .map((v) => `<span class="chip toggle${selectedCuda.includes(v) ? " on" : ""}" data-cuda="${v}">${v}</span>`)
    .join("");
  $$("#cuda-chips .chip").forEach((chip) =>
    chip.addEventListener("click", () => {
      const v = chip.dataset.cuda;
      if (selectedCuda.includes(v)) {
        if (selectedCuda.length === 1) return toast("Keep at least one CUDA version", true);
        selectedCuda = selectedCuda.filter((x) => x !== v);
      } else {
        selectedCuda.push(v);
      }
      chip.classList.toggle("on");
      loadGpuGrid();
    })
  );
}

// Build the ?cuda= query fragment from the current selection.
function cudaParam() {
  return selectedCuda.length ? `cuda=${encodeURIComponent(selectedCuda.join(","))}` : "";
}

async function loadGpuGrid() {
  const grid = $("#gpu-grid");
  grid.innerHTML = `<div class="muted">Loading GPUs…</div>`;
  selectedGpu = null;
  $("#start-pod").disabled = true;
  const min = $("#ram-select").value;
  const qs = [min ? `min_memory=${min}` : "", cudaParam()].filter(Boolean).join("&");
  let gpus;
  try {
    gpus = await getJSON("/api/gpu-availability" + (qs ? `?${qs}` : ""));
  } catch (e) {
    grid.innerHTML = `<div class="muted">Could not load GPUs: ${e.message}</div>`;
    return;
  }
  grid.innerHTML = gpus.length
    ? gpus.map(renderGpu).join("")
    : `<div class="muted">No GPUs match.</div>`;

  $$("#gpu-grid .gpu").forEach((card) => {
    if (card.dataset.avail === "1") card.addEventListener("click", () => selectGpu(card));
  });
}

function renderGpu(g) {
  const stockClass = g.available ? (g.stock || "").toLowerCase() : "none";
  const stockLabel = g.available ? g.stock : "N/A";
  const price = g.price != null ? `$${g.price.toFixed(2)}` : "—";
  const specs = g.available
    ? `${g.vram}GB VRAM${g.ram ? ` · ${g.ram}GB RAM` : ""}`
    : "unavailable in region";
  const sub = g.available ? `${g.vcpu} vCPU · ${g.max_gpu_count || 1}× max` : "";
  const detail = g.rating_fallback ? "" : `<div class="gpu-detail">
      <p class="gpu-blurb">${g.blurb || ""}</p>
      ${ratingRow("Performance", g.perf, "good")}
      ${ratingRow("Value", g.value, "warn")}
      <div class="gpu-est">estimated · relative</div>
    </div>`;
  return `<div class="gpu ${g.available ? "" : "unavail"}" data-avail="${g.available ? 1 : 0}"
       data-id="${g.id}" data-label="${g.displayName}" data-ram="${g.ram || ""}">
    <div class="gpu-top">
      <span class="gpu-name">${g.displayName}</span>
      <span class="stock ${stockClass}">${stockLabel}</span>
    </div>
    <div class="gpu-price">${price}<span class="unit">/hr</span></div>
    <div class="gpu-specs">${specs}</div>
    ${sub ? `<div class="gpu-sub">${sub}</div>` : ""}
    ${detail}
  </div>`;
}

function ratingRow(label, score, tone) {
  const n = score || 0;
  let dots = "";
  for (let i = 1; i <= 5; i++) dots += `<span class="dot${i <= n ? " on " + tone : ""}"></span>`;
  return `<div class="rating"><span class="rlabel">${label}</span><span class="dots">${dots}</span></div>`;
}

function selectGpu(card) {
  $$("#gpu-grid .gpu").forEach((c) => c.classList.remove("sel"));
  card.classList.add("sel");
  selectedGpu = { id: card.dataset.id, label: card.dataset.label, ram: card.dataset.ram };
  $("#start-pod").disabled = false;
}

$("#ram-select").addEventListener("change", loadGpuGrid);
$("#refresh-gpus").addEventListener("click", loadGpuGrid);

$("#start-pod").addEventListener("click", async () => {
  if (!selectedGpu) return toast("Select a GPU first", true);
  const btn = $("#start-pod");
  btn.disabled = true;
  btn.textContent = "Checking availability…";

  // Re-validate before deploying — stock can change while the grid sits stale.
  try {
    const min = $("#ram-select").value;
    const qs = [min ? `min_memory=${min}` : "", cudaParam()].filter(Boolean).join("&");
    const gpus = await getJSON("/api/gpu-availability" + (qs ? `?${qs}` : ""));
    const current = gpus.find((g) => g.id === selectedGpu.id);
    if (!current || !current.available) {
      toast(`${selectedGpu.label} is no longer available — grid refreshed`, true);
      loadGpuGrid();
      return;
    }
  } catch (_) {
    // Availability check failed — proceed and let RunPod reject if needed.
  }

  btn.textContent = "Deploying…";
  try {
    await postJSON("/api/pods", {
      gpu_type_id: selectedGpu.id,
      gpu_label: selectedGpu.label,
      min_memory: $("#ram-select").value ? Number($("#ram-select").value) : undefined,
      cuda_versions: selectedCuda.length ? selectedCuda : undefined,
    });
    toast("Pod deploying — it will appear above");
    setTimeout(loadPods, 2000);
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "Deploy selected GPU";
  }
});

// ---- generate: params form -------------------------------------------------
let FIELDS = [];
let CFG = {};

async function loadConfig() {
  const cfg = await getJSON("/api/config");
  CFG = cfg;
  FIELDS = cfg.fields || [];
  renderPodFilters();
  const promptField = FIELDS.find((f) => f.key === "positive");
  $("#prompt-field").innerHTML = promptField ? renderField(promptField) : "";
  $("#params").innerHTML = FIELDS.filter((f) => f.key !== "positive").map(renderField).join("");
  // live value labels for sliders
  $$('input[type="range"]').forEach((r) => {
    const out = $("#val-" + r.dataset.key);
    if (out) r.addEventListener("input", () => (out.textContent = r.value));
  });
  // toggles drive conditional fields
  $$('input[type="checkbox"][data-key]').forEach((c) =>
    c.addEventListener("change", applyConditions)
  );
  applyConditions();
  // auto-expand textareas as content grows
  $$("textarea").forEach((ta) =>
    ta.addEventListener("input", resizeTextareas)
  );
}

function renderField(f) {
  if (f.type === "const") return ""; // applied server-side, not shown

  let inner;
  if (f.type === "toggle") {
    inner = `<label class="toggle"><span>${f.label}</span>
      <input type="checkbox" data-key="${f.key}"${f.default ? " checked" : ""} /></label>`;
  } else if (f.type === "textarea") {
    const ph = f.placeholder ? ` placeholder="${f.placeholder}"` : "";
    inner = `<label>${f.label}
      <textarea data-key="${f.key}"${ph}>${f.default ?? ""}</textarea></label>`;
  } else if (f.type === "select") {
    const opts = (f.choices || [])
      .map((c) => `<option value="${c}"${c === f.default ? " selected" : ""}>${c}</option>`)
      .join("");
    inner = `<label>${f.label}<select data-key="${f.key}">${opts}</select></label>`;
  } else if (f.type === "seed") {
    inner = `<label>${f.label}
      <input type="text" inputmode="numeric" data-key="${f.key}" value="${f.default ?? 0}" /></label>`;
  } else {
    const step = f.step ?? 1;
    const labelRow = f.label
      ? `<div class="field-row"><span>${f.label}</span><span class="val" id="val-${f.key}">${f.default}</span></div>`
      : `<div class="field-row" style="justify-content:flex-end"><span class="val" id="val-${f.key}">${f.default}</span></div>`;
    inner = `<label>${labelRow}
      <input type="range" data-key="${f.key}" min="${f.min}" max="${f.max}"
             step="${step}" value="${f.default}" /></label>`;
  }

  const w = f.when
    ? ` data-when-key="${f.when.key}" data-when-is="${f.when.is}"`
    : "";
  return `<div class="field" data-fkey="${f.key}"${w}>${inner}</div>`;
}

function applyConditions() {
  $$("[data-when-key]").forEach((el) => {
    const tog = document.querySelector(
      `input[type="checkbox"][data-key="${el.dataset.whenKey}"]`
    );
    const on = tog ? tog.checked : true;
    el.style.display = on === (el.dataset.whenIs === "true") ? "" : "none";
  });
}

function collectParams() {
  const out = {};
  $$("[data-key]").forEach((el) => {
    out[el.dataset.key] = el.type === "checkbox" ? el.checked : el.value;
  });
  return out;
}

// ---- generate: pod readiness ----------------------------------------------
async function onGenPodChange() {
  const id = $("#gen-pod").value;
  const status = $("#pod-readiness");
  const btn = $("#generate");
  if (!id) {
    status.textContent = "Start a pod on the Pod tab first.";
    status.className = "status err";
    btn.disabled = true;
    return;
  }
  status.textContent = "Checking ComfyUI…";
  status.className = "status";
  try {
    const s = await getJSON(`/api/pods/${id}`);
    if (s.comfy_ready) {
      status.textContent = "ComfyUI ready ✓";
      status.className = "status ok";
      btn.disabled = false;
    } else {
      status.textContent = "Pod is warming up — try again in a moment.";
      status.className = "status warm";
      btn.disabled = true;
    }
  } catch (e) {
    status.textContent = "Could not reach pod: " + e.message;
    status.className = "status err";
    btn.disabled = true;
  }
}
$("#gen-pod").addEventListener("change", onGenPodChange);

// ---- generate: image preview ----------------------------------------------
$("#image").addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (!f) return;
  $("#image-label").textContent = f.name;
  const img = $("#preview");
  img.src = URL.createObjectURL(f);
  img.hidden = false;
});

// ---- generate: run ---------------------------------------------------------
$("#generate").addEventListener("click", async () => {
  const podId = $("#gen-pod").value;
  const file = $("#image").files[0];
  if (!podId) return toast("No pod selected", true);
  if (!file) return toast("Choose an input image first", true);

  const btn = $("#generate");
  btn.disabled = true;
  btn.textContent = "Submitting…";

  const params = collectParams();
  postJSON("/api/last-params", params).catch(() => {});

  const fd = new FormData();
  fd.append("pod_id", podId);
  fd.append("image", file);
  fd.append("params", JSON.stringify(params));

  try {
    const r = await fetch("/api/generate", { method: "POST", body: fd });
    if (!r.ok) throw new Error((await r.text()) || r.statusText);
    await r.json();
    toast("Generation queued");
    // Jump to Outputs, where the in-flight job now shows live progress.
    const outSel = $("#out-pod");
    if (outSel) outSel.value = podId;
    switchTab("outputs");
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "Generate";
  }
});

// ---- outputs gallery -------------------------------------------------------
let _outPodId = null;
let _outTimer = null;
let _seenDone = new Set(); // jobs we've already dropped into the done list

function stopOutTimer() {
  if (_outTimer) { clearInterval(_outTimer); _outTimer = null; }
}

// ---- bulk selection ---------------------------------------------------------
let _selectMode = false;
let _selected = new Set();

function enterSelectMode() {
  _selectMode = true;
  _selected.clear();
  $("#out-list").classList.add("select-mode");
  $("#bulk-bar").hidden = false;
  _updateBulkBar();
}
function exitSelectMode() {
  _selectMode = false;
  _selected.clear();
  $$("#out-list .out-card.selected").forEach((c) => c.classList.remove("selected"));
  $("#out-list").classList.remove("select-mode");
  $("#bulk-bar").hidden = true;
}
function _toggleSelect(card) {
  const pid = card.dataset.pid;
  if (_selected.has(pid)) { _selected.delete(pid); card.classList.remove("selected"); }
  else                     { _selected.add(pid);    card.classList.add("selected"); }
  _updateBulkBar();
}
function _updateBulkBar() {
  const n = _selected.size;
  $("#bulk-count").textContent = n ? `${n} selected` : "";
  $("#bulk-star").disabled   = n === 0;
  $("#bulk-delete").disabled = n === 0;
}

$("#out-select").addEventListener("click", enterSelectMode);
$("#bulk-cancel").addEventListener("click", exitSelectMode);

$("#bulk-star").addEventListener("click", async () => {
  const btn = $("#bulk-star");
  btn.disabled = true; btn.textContent = "Saving…";
  let done = 0;
  for (const pid of [..._selected]) {
    const card = document.querySelector(`#out-list .out-card[data-pid="${pid}"]`);
    if (!card) continue;
    try {
      await postJSON(`/api/saved/${card.dataset.pod}/${pid}`, {
        filename: card.dataset.file, subfolder: card.dataset.sub, type: card.dataset.ftype,
      });
      const s = card.querySelector(".star-btn");
      if (s) { s.classList.add("starred"); s.textContent = "★"; s.title = "Unstar"; }
      done++;
    } catch (_) {}
  }
  await loadSaved();
  toast(`${done} video${done !== 1 ? "s" : ""} saved ✓`);
  btn.textContent = "★ Save";
  exitSelectMode();
});

$("#bulk-delete").addEventListener("click", async () => {
  const n = _selected.size;
  if (!confirm(`Delete ${n} video${n !== 1 ? "s" : ""}?`)) return;
  const btn = $("#bulk-delete");
  btn.disabled = true; btn.textContent = "Deleting…";
  let done = 0;
  for (const pid of [..._selected]) {
    const card = document.querySelector(`#out-list .out-card[data-pid="${pid}"]`);
    if (!card) continue;
    try {
      await deleteJSON(`/api/pods/${card.dataset.pod}/outputs/${pid}`);
      card.remove(); done++;
    } catch (_) {}
  }
  toast(`${done} video${done !== 1 ? "s" : ""} deleted`);
  btn.textContent = "🗑 Delete";
  exitSelectMode();
});

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function fmtElapsed(sec) {
  sec = Math.max(0, Math.floor(sec));
  const m = Math.floor(sec / 60);
  return m ? `${m}m ${String(sec % 60).padStart(2, "0")}s` : `${sec}s`;
}

function fmtDatetime(ts) {
  if (!ts) return null;
  const d = new Date(ts * 1000);
  return d.toLocaleString([], { month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit" });
}

// Build a /view URL for the uploaded input image (its name may carry a subfolder).
function inputThumbUrl(podId, inputImage) {
  if (!inputImage) return null;
  const i = inputImage.lastIndexOf("/");
  const subfolder = i >= 0 ? inputImage.slice(0, i) : "";
  const filename = i >= 0 ? inputImage.slice(i + 1) : inputImage;
  const q = new URLSearchParams({ filename, subfolder, type: "input" });
  return `/api/pods/${podId}/view?${q}`;
}

async function loadOutputs() {
  const podId = $("#out-pod").value;
  _outPodId = podId;
  _seenDone = new Set();
  stopOutTimer();
  $("#out-active").innerHTML = "";
  loadSaved();
  const list = $("#out-list");
  if (!podId) {
    list.innerHTML = `<div class="card muted">No running pod. Start one on the Pod tab.</div>`;
    return;
  }
  list.innerHTML = `<div class="card muted">Loading outputs…</div>`;
  await loadDone(podId);
  await tickActive();
  _outTimer = setInterval(tickActive, 1000);
}

async function loadDone(podId) {
  const list = $("#out-list");
  let items;
  try {
    items = await getJSON(`/api/pods/${podId}/outputs`);
  } catch (e) {
    list.innerHTML = `<div class="card muted">Could not load outputs: ${esc(e.message)}</div>`;
    return;
  }
  const unsaved = items.filter((it) => !it.is_saved);
  list.innerHTML = unsaved.length
    ? unsaved.map((it) => renderOutput(podId, it)).join("")
    : `<div class="card muted">No videos yet on this pod.</div>`;
}

async function loadSaved() {
  const section = $("#saved-section");
  const list = $("#saved-list");
  let items;
  try { items = await getJSON("/api/saved"); } catch (_) { return; }
  if (!items.length) { section.hidden = true; return; }
  section.hidden = false;
  list.innerHTML = items.map(renderSavedOutput).join("");
}

function renderSavedOutput(it) {
  const url = `/api/saved/file/${encodeURIComponent(it.filename)}`;
  const dt = fmtDatetime(it.completed_at);
  return `<div class="out-card" data-url="${url}" data-name="${esc(it.filename)}"
              data-pid="${esc(it.prompt_id)}">
    <div class="out-cover">
      <video class="cover-img" preload="metadata" muted src="${url}#t=0.1"></video>
      <span class="play-badge">&#9658;</span>
      <video class="tile-video" data-src="${url}" playsinline preload="none" controls></video>
      <button class="zoom-back" title="Zoom back">↙</button>
      <button class="star-btn starred" data-pid="${esc(it.prompt_id)}" title="Unstar">★</button>
    </div>
    <div class="out-cap">
      <div class="out-name-wrap">
        ${dt ? `<span class="out-dt">${dt}</span>` : ""}
        ${it.duration_secs ? `<span class="out-dur">⏱ ${fmtElapsed(it.duration_secs)}</span>` : ""}
      </div>
      <div class="out-actions">
        <button class="info-btn ghost small" data-pid="${esc(it.prompt_id)}" title="Details">ⓘ</button>
        <a class="dl" href="${url}" download="${esc(it.filename)}" title="Download">&#10515;</a>
      </div>
    </div>
  </div>`;
}

function renderOutput(podId, it) {
  const q = new URLSearchParams({
    filename: it.filename, subfolder: it.subfolder || "", type: it.type || "output",
  });
  const url = `/api/pods/${podId}/view?${q}`;
  const thumb = inputThumbUrl(podId, it.input_image);
  const cover = thumb
    ? `<img class="cover-img" src="${thumb}" alt="" loading="lazy" />`
    : `<video class="cover-img" preload="metadata" muted src="${url}#t=0.1"></video>`;
  const dt = fmtDatetime(it.completed_at);
  const starred = it.is_saved;
  return `<div class="out-card" data-url="${url}" data-name="${esc(it.filename)}"
              data-pid="${esc(it.prompt_id)}" data-pod="${esc(podId)}"
              data-file="${esc(it.filename)}" data-sub="${esc(it.subfolder||"")}" data-ftype="${esc(it.type||"output")}">
    <div class="out-cover">
      ${cover}
      <span class="play-badge">&#9658;</span>
      <video class="tile-video" data-src="${url}" playsinline preload="none" controls></video>
      <button class="zoom-back" title="Zoom back">↙</button>
      <span class="sel-check"></span>
      <button class="star-btn${starred ? " starred" : ""}" data-pid="${esc(it.prompt_id)}"
              title="${starred ? "Unstar" : "Save to local"}">${starred ? "★" : "☆"}</button>
    </div>
    <div class="out-cap">
      <div class="out-name-wrap">
        ${dt ? `<span class="out-dt">${dt}</span>` : ""}
        ${it.duration_secs ? `<span class="out-dur">⏱ ${fmtElapsed(it.duration_secs)}</span>` : ""}
      </div>
      <div class="out-actions">
        <button class="info-btn ghost small" data-pid="${esc(it.prompt_id)}" title="Details">ⓘ</button>
        <a class="dl" href="${url}" download="${esc(it.filename)}" title="Download">&#10515;</a>
        <button class="del-btn ghost small" data-pid="${esc(it.prompt_id)}" title="Delete">🗑</button>
      </div>
    </div>
  </div>`;
}

// ---- in-place tile expand / collapse ----------------------------------------
function expandTile(card) {
  const existing = document.querySelector(".out-card.expanded");
  if (existing && existing !== card) collapseTile(existing);
  const video = card.querySelector(".tile-video");
  if (video && !video.src) video.src = video.dataset.src;
  card.classList.add("expanded");
  document.body.style.overflow = "hidden";
  if (video) video.play().catch(() => {});
}
function collapseTile(card) {
  const video = card.querySelector(".tile-video");
  if (video) { video.pause(); }
  card.classList.remove("expanded");
  document.body.style.overflow = "";
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    const expanded = document.querySelector(".out-card.expanded");
    if (expanded) collapseTile(expanded);
  }
});

// ---- generation details popup -----------------------------------------------
async function showDetails(promptId) {
  let params;
  try { params = await getJSON(`/api/params/${promptId}`); }
  catch (_) { toast("No details saved for this generation", true); return; }

  const fields = CFG.fields || [];
  const entries = Object.entries(params);
  // prompt (positive) first, then the rest
  const sorted = [
    ...entries.filter(([k]) => k === "positive"),
    ...entries.filter(([k]) => k !== "positive"),
  ];
  const rows = sorted.map(([key, val]) => {
    const field = fields.find((f) => f.key === key);
    const label = field ? field.label : key.replace(/_/g, " ");
    return `<div class="detail-row">
      <span class="detail-key">${esc(label)}</span>
      <span class="detail-val">${esc(String(val))}</span>
    </div>`;
  }).join("");

  const existing = document.querySelector(".details-overlay");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.className = "details-overlay";
  overlay.innerHTML = `<div class="details-card">
    <div class="details-head">
      <span>Generation Details</span>
      <button class="details-apply ghost small">Apply to Generate</button>
      <button class="details-close">&times;</button>
    </div>
    <div class="details-body">${rows || `<div class="muted">No params recorded.</div>`}</div>
  </div>`;
  overlay.querySelector(".details-apply").addEventListener("click", () => {
    overlay.remove();
    applyParams(params);
    switchTab("generate");
    toast("Params applied ✓");
  });
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay || e.target.closest(".details-close")) overlay.remove();
  });
  document.body.appendChild(overlay);
}

// ---- out-list: tap cover to expand; buttons in cap area are independent -----
$("#out-list").addEventListener("click", async (e) => {
  // in select mode every tap toggles the tile
  if (_selectMode) {
    const card = e.target.closest(".out-card");
    if (card) _toggleSelect(card);
    return;
  }
  // zoom-back (inside expanded cover)
  if (e.target.closest(".zoom-back")) {
    collapseTile(e.target.closest(".out-card"));
    return;
  }
  if (e.target.closest(".dl")) return;
  // delete
  const delBtn = e.target.closest(".del-btn");
  if (delBtn) {
    if (!confirm("Delete this video from history?")) return;
    const card = delBtn.closest(".out-card");
    delBtn.disabled = true;
    try {
      await deleteJSON(`/api/pods/${card.dataset.pod}/outputs/${card.dataset.pid}`);
      card.remove();
      toast("Deleted");
    } catch (err) { toast(err.message, true); delBtn.disabled = false; }
    return;
  }
  // details
  const infoBtn = e.target.closest(".info-btn");
  if (infoBtn) { showDetails(infoBtn.dataset.pid); return; }
  // star
  const starBtn = e.target.closest(".star-btn");
  if (starBtn) {
    const card = starBtn.closest(".out-card");
    const starred = starBtn.classList.contains("starred");
    starBtn.disabled = true;
    try {
      if (starred) {
        await deleteJSON(`/api/saved/${starBtn.dataset.pid}`);
        await loadSaved();
        if (_outPodId) await loadDone(_outPodId);
      } else {
        await postJSON(`/api/saved/${card.dataset.pod}/${starBtn.dataset.pid}`, {
          filename: card.dataset.file, subfolder: card.dataset.sub, type: card.dataset.ftype,
        });
        card.remove();
        await loadSaved();
        toast("Saved ✓");
      }
    } catch (err) { toast(err.message, true); }
    starBtn.disabled = false;
    return;
  }
  // tap cover → expand
  const cover = e.target.closest(".out-cover");
  if (cover) expandTile(cover.closest(".out-card"));
});

// ---- saved-list: tap cover to expand; star to unstar -------------------------
$("#saved-list").addEventListener("click", async (e) => {
  if (e.target.closest(".zoom-back")) {
    collapseTile(e.target.closest(".out-card"));
    return;
  }
  if (e.target.closest(".dl")) return;
  const infoBtn = e.target.closest(".info-btn");
  if (infoBtn) { showDetails(infoBtn.dataset.pid); return; }
  const starBtn = e.target.closest(".star-btn");
  if (starBtn) {
    if (!confirm("Remove from saved?")) return;
    const pid = starBtn.dataset.pid;
    starBtn.disabled = true;
    try {
      await deleteJSON(`/api/saved/${pid}`);
      starBtn.closest(".out-card").remove();
      if (!$("#saved-list .out-card")) $("#saved-section").hidden = true;
      if (_outPodId) await loadDone(_outPodId);
      toast("Removed from saved");
    } catch (err) { toast(err.message, true); starBtn.disabled = false; }
    return;
  }
  const cover = e.target.closest(".out-cover");
  if (cover) expandTile(cover.closest(".out-card"));
});

// ---- outputs: in-flight generations ----------------------------------------
const activeCardId = (pid) => "act-" + pid.replace(/[^a-zA-Z0-9_-]/g, "");

async function tickActive() {
  const podId = _outPodId;
  if (!podId) return;
  let jobs;
  try { jobs = await getJSON(`/api/pods/${podId}/jobs`); }
  catch (_) { return; }

  const live = new Set();
  for (const j of jobs) {
    if (j.status === "done") {
      if (!_seenDone.has(j.prompt_id)) { _seenDone.add(j.prompt_id); loadDone(podId); }
      continue; // the finished clip belongs in the done list below
    }
    if (j.status === "error") {
      if (!_seenDone.has(j.prompt_id)) { _seenDone.add(j.prompt_id); toast("Generation failed", true); }
      continue;
    }
    live.add(j.prompt_id);
    upsertActiveCard(podId, j);
  }

  // Drop cards for jobs no longer running.
  $$("#out-active .out-item").forEach((card) => {
    if (!live.has(card.dataset.pid)) card.remove();
  });
}

function upsertActiveCard(podId, j) {
  let card = document.getElementById(activeCardId(j.prompt_id));
  if (!card) {
    const thumb = inputThumbUrl(podId, j.input_image);
    $("#out-active").insertAdjacentHTML("afterbegin", `
      <div class="out-item active" id="${activeCardId(j.prompt_id)}"
           data-pid="${esc(j.prompt_id)}">
        <div class="active-media">
          <img class="active-img" alt="generating"
               src="${thumb || ""}" data-fallback="${thumb || ""}" />
          <span class="gen-badge">queued</span>
        </div>
        <div class="active-body">
          <div class="active-row">
            <span class="elapsed muted">queued</span>
            <span class="step muted"></span>
          </div>
          <div class="progress-wrap"><div class="progress-bar"></div></div>
          <div class="active-footer">
            <div class="node muted"></div>
            <button class="ghost small stop-btn" data-pid="${esc(j.prompt_id)}" data-pod="${esc(podId)}">✕ Stop</button>
          </div>
        </div>
      </div>`);
    card = document.getElementById(activeCardId(j.prompt_id));
  }

  const started = j.started_at;
  const elapsed = started ? (Date.now() / 1000 - started) : null;
  const badge = card.querySelector(".gen-badge");
  const elapsedEl = card.querySelector(".elapsed");

  if (elapsed !== null) {
    badge.textContent = "generating";
    elapsedEl.textContent = fmtElapsed(elapsed);
    elapsedEl.classList.remove("muted");
  } else {
    badge.textContent = "queued";
    elapsedEl.textContent = "queued";
    elapsedEl.classList.add("muted");
  }

  card.querySelector(".step").textContent =
    elapsed !== null && j.max ? `step ${j.progress} / ${j.max}` : "";
  card.querySelector(".progress-bar").style.width =
    j.max ? Math.round((j.progress / j.max) * 100) + "%" : "0%";
  card.querySelector(".node").textContent =
    elapsed !== null && j.node_title ? `▶ ${j.node_title}` : "";

  // Prefer the live sampling preview; fall back to the input image.
  const img = card.querySelector(".active-img");
  if (j.has_preview) {
    img.src = `/api/preview/${j.prompt_id}?t=${Math.floor(Date.now() / 1000)}`;
  } else if (img.dataset.fallback && img.src !== location.origin + img.dataset.fallback) {
    img.src = img.dataset.fallback;
  }
}

// Stop button on active cards (delegated).
$("#out-active").addEventListener("click", async (e) => {
  const btn = e.target.closest(".stop-btn");
  if (!btn) return;
  if (!confirm("Stop this generation?")) return;
  btn.disabled = true;
  try {
    await postJSON(`/api/pods/${btn.dataset.pod}/cancel/${btn.dataset.pid}`, {});
    toast("Stopped");
  } catch (err) {
    toast(err.message, true);
    btn.disabled = false;
  }
});

$("#out-pod").addEventListener("change", loadOutputs);
$("#out-refresh").addEventListener("click", loadOutputs);

$("#session-toggle").addEventListener("click", () => {
  const list = $("#out-list");
  const active = $("#out-active");
  const chevron = $("#session-toggle .section-chevron");
  const isCollapsed = list.style.display === "none";
  list.style.display = isCollapsed ? "" : "none";
  active.style.display = isCollapsed ? "" : "none";
  chevron.textContent = isCollapsed ? "▾" : "▸";
});

$("#saved-toggle").addEventListener("click", () => {
  const list = $("#saved-list");
  const chevron = $("#saved-toggle .section-chevron");
  const isCollapsed = list.style.display === "none";
  list.style.display = isCollapsed ? "" : "none";
  chevron.textContent = isCollapsed ? "▾" : "▸";
});

// ---- prompt templates ------------------------------------------------------
let _templates = [];

async function loadTemplates() {
  try { _templates = await getJSON("/api/templates"); } catch (_) { _templates = []; }
  renderTemplateSelect();
}

function renderTemplateSelect() {
  const sel = $("#tpl-select");
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = `<option value="">— select a template —</option>` +
    _templates.map((t, i) => `<option value="${i}">${t.name}</option>`).join("");
  if (prev && _templates[Number(prev)]) sel.value = prev;
}

$("#tpl-use").addEventListener("click", () => {
  const sel = $("#tpl-select");
  if (!sel || sel.value === "") return toast("Select a template first", true);
  const tpl = _templates[Number(sel.value)];
  if (!tpl) return;
  const ta = document.querySelector('textarea[data-key="positive"]');
  if (ta) { ta.value = tpl.text; resizeTextareas(); toast("Template loaded"); }
});

$("#tpl-update").addEventListener("click", async () => {
  const sel = $("#tpl-select");
  if (!sel || sel.value === "") return toast("Select a template first", true);
  const ta = document.querySelector('textarea[data-key="positive"]');
  if (!ta || !ta.value.trim()) return toast("Prompt is empty", true);
  const idx = Number(sel.value);
  try {
    _templates = await putJSON(`/api/templates/${idx}`, { text: ta.value.trim() });
    renderTemplateSelect();
    sel.value = String(idx);
    toast(`"${_templates[idx]?.name}" updated`);
  } catch (e) { toast(e.message, true); }
});

$("#tpl-save").addEventListener("click", async () => {
  const ta = document.querySelector('textarea[data-key="positive"]');
  if (!ta || !ta.value.trim()) return toast("Prompt is empty", true);
  const name = window.prompt("Template name:", "My template");
  if (!name) return;
  try {
    _templates = await postJSON("/api/templates", { name, text: ta.value.trim() });
    renderTemplateSelect();
    $("#tpl-select").value = String(_templates.length - 1);
    toast("Template saved");
  } catch (e) { toast(e.message, true); }
});

$("#tpl-del").addEventListener("click", async () => {
  const sel = $("#tpl-select");
  if (!sel || sel.value === "") return toast("Select a template first", true);
  const idx = Number(sel.value);
  if (!confirm(`Delete "${_templates[idx]?.name}"?`)) return;
  try {
    _templates = await deleteJSON(`/api/templates/${idx}`);
    renderTemplateSelect();
    toast("Template deleted");
  } catch (e) { toast(e.message, true); }
});

// ---- param helpers ---------------------------------------------------------
function applyParams(params) {
  Object.entries(params).forEach(([key, val]) => {
    const el = document.querySelector(`[data-key="${key}"]`);
    if (!el) return;
    if (el.type === "checkbox") el.checked = Boolean(val);
    else el.value = val;
    if (el.type === "range") {
      const out = $("#val-" + key);
      if (out) out.textContent = val;
    }
  });
  applyConditions();
  resizeTextareas();
}

// ---- last params -----------------------------------------------------------
async function restoreLastParams() {
  try {
    const saved = await getJSON("/api/last-params");
    if (!saved || !Object.keys(saved).length) return;
    applyParams(saved);
  } catch (_) {}
}

// ---- param presets ---------------------------------------------------------
let _presets = [];

async function loadParamPresets() {
  try { _presets = await getJSON("/api/param-presets"); } catch (_) { _presets = []; }
  renderPresetSelect();
}

function renderPresetSelect() {
  const sel = $("#preset-select");
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = `<option value="">— saved presets —</option>` +
    _presets.map((p, i) => `<option value="${i}">${esc(p.name)}</option>`).join("");
  if (prev && _presets[Number(prev)]) sel.value = prev;
}

$("#preset-apply").addEventListener("click", () => {
  const sel = $("#preset-select");
  if (!sel || sel.value === "") return toast("Select a preset first", true);
  const preset = _presets[Number(sel.value)];
  if (!preset) return;
  applyParams(preset.params);
  toast(`"${preset.name}" applied`);
});

$("#preset-save").addEventListener("click", async () => {
  const name = window.prompt("Preset name:", "My preset");
  if (!name) return;
  try {
    _presets = await postJSON("/api/param-presets", { name, params: collectParams() });
    renderPresetSelect();
    $("#preset-select").value = String(_presets.length - 1);
    toast("Preset saved");
  } catch (e) { toast(e.message, true); }
});

$("#preset-del").addEventListener("click", async () => {
  const sel = $("#preset-select");
  if (!sel || sel.value === "") return toast("Select a preset first", true);
  const idx = Number(sel.value);
  if (!confirm(`Delete "${_presets[idx]?.name}"?`)) return;
  try {
    _presets = await deleteJSON(`/api/param-presets/${idx}`);
    renderPresetSelect();
    toast("Preset deleted");
  } catch (e) { toast(e.message, true); }
});

// ---- balance ---------------------------------------------------------------
async function loadBalance() {
  try {
    const { balance } = await getJSON("/api/balance");
    const el = $("#balance");
    if (!el) return;
    el.textContent = balance != null ? `$${Number(balance).toFixed(2)}` : "—";
    el.className = "balance" + (balance < 2 ? " critical" : balance < 5 ? " low" : "");
  } catch (_) {}
}

// ---- RAM clear -------------------------------------------------------------
$("#ram-clear").addEventListener("click", async () => {
  const btn = $("#ram-clear");
  const podId = btn.dataset.podId;
  if (!podId) return toast("No active pod", true);
  btn.disabled = true;
  btn.textContent = "Clearing…";
  try {
    await postJSON(`/api/pods/${podId}/ram-clear`, {});
    toast("RAM clear queued ✓");
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "🎈 RAM";
  }
});

// ---- boot ------------------------------------------------------------------
$("#refresh").addEventListener("click", loadPods);
(async function init() {
  await loadConfig();
  await Promise.all([loadPods(), loadTemplates(), loadParamPresets(), restoreLastParams()]);
  loadBalance();
  setInterval(loadBalance, 60_000);
})();

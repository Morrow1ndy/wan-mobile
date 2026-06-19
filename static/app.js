"use strict";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ---- auth ------------------------------------------------------------------
// Credentials stored in sessionStorage so they survive page refresh but not
// a browser restart. The server returns plain 401 JSON (no WWW-Authenticate
// header) so the browser never shows its native credential dialog.
let _authHeader = sessionStorage.getItem("wan_auth") || null;
let _loginShowing = false;
let _balanceTimer = null;

class AuthError extends Error { constructor() { super("unauthorized"); } }

async function apiFetch(url, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (_authHeader) headers["Authorization"] = _authHeader;
  const r = await fetch(url, { ...opts, headers });
  if (r.status === 401) {
    _authHeader = null;
    sessionStorage.removeItem("wan_auth");
    showLoginOverlay();
    throw new AuthError();
  }
  return r;
}

function showLoginOverlay() {
  if (_loginShowing) return;
  _loginShowing = true;
  $("#login-overlay").hidden = false;
  $("#login-err").hidden = true;
  setTimeout(() => $("#login-user").focus(), 80);
}

function hideLoginOverlay() {
  _loginShowing = false;
  $("#login-overlay").hidden = true;
}

document.getElementById("login-pass").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("login-btn").click();
});

document.getElementById("login-btn").addEventListener("click", async () => {
  const user = $("#login-user").value.trim();
  const pass = $("#login-pass").value;
  if (!user || !pass) return;
  const btn = $("#login-btn");
  btn.disabled = true; btn.textContent = "Signing in…";
  const header = "Basic " + btoa(user + ":" + pass);
  const r = await fetch("/api/balance", { headers: { Authorization: header } });
  btn.disabled = false; btn.textContent = "Sign in";
  if (r.status === 401) { $("#login-err").hidden = false; return; }
  _authHeader = header;
  sessionStorage.setItem("wan_auth", header);
  // Set httponly cookie so <video src> / <img src> requests also authenticate
  await fetch("/api/auth/cookie", { method: "POST", headers: { Authorization: header } });
  hideLoginOverlay();
  init();
});

// ---- custom confirm / prompt -----------------------------------------------
function showConfirm(msg, { okText = "Confirm", danger = false } = {}) {
  return new Promise((resolve) => {
    $("#confirm-msg").textContent = msg;
    const ok = $("#confirm-ok");
    ok.textContent = okText;
    ok.className = "primary" + (danger ? " danger" : "");
    $("#confirm-overlay").hidden = false;
    const yes = () => { cleanup(); resolve(true); };
    const no  = () => { cleanup(); resolve(false); };
    function cleanup() {
      $("#confirm-overlay").hidden = true;
      ok.onclick = null; $("#confirm-cancel").onclick = null;
      $("#confirm-overlay").onclick = null;
    }
    ok.onclick = yes;
    $("#confirm-cancel").onclick = no;
    $("#confirm-overlay").onclick = (e) => { if (e.target === $("#confirm-overlay")) no(); };
  });
}

function showPrompt(msg, defaultVal = "") {
  return new Promise((resolve) => {
    $("#prompt-msg").textContent = msg;
    const inp = $("#prompt-input");
    inp.value = defaultVal;
    $("#prompt-overlay").hidden = false;
    setTimeout(() => inp.focus(), 80);
    const ok = () => { cleanup(); resolve(inp.value.trim() || null); };
    const no = () => { cleanup(); resolve(null); };
    function cleanup() {
      $("#prompt-overlay").hidden = true;
      $("#prompt-ok").onclick = null; $("#prompt-cancel").onclick = null;
      $("#prompt-overlay").onclick = null; inp.onkeydown = null;
    }
    $("#prompt-ok").onclick = ok;
    $("#prompt-cancel").onclick = no;
    inp.onkeydown = (e) => { if (e.key === "Enter") ok(); if (e.key === "Escape") no(); };
    $("#prompt-overlay").onclick = (e) => { if (e.target === $("#prompt-overlay")) no(); };
  });
}

// ---- tiny helpers ----------------------------------------------------------
async function getJSON(url) {
  const r = await apiFetch(url);
  if (!r.ok) throw new Error((await r.text()) || r.statusText);
  return r.json();
}
async function postJSON(url, body) {
  const r = await apiFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (!r.ok) throw new Error((await r.text()) || r.statusText);
  return r.json();
}
async function putJSON(url, body) {
  const r = await apiFetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (!r.ok) throw new Error((await r.text()) || r.statusText);
  return r.json();
}
async function deleteJSON(url) {
  const r = await apiFetch(url, { method: "DELETE" });
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
// Like Gmail "undo send" — toast with an Undo button that calls onUndo() if
// tapped before the timeout. Useful for reversible server-side actions.
function toastUndo(msg, onUndo, duration = 5000) {
  const t = document.createElement("div");
  t.className = "toast toast-undo";
  t.innerHTML = `<span>${esc(msg)}</span><button class="toast-undo-btn">Undo</button>`;
  document.body.appendChild(t);
  let gone = false;
  const dismiss = () => { if (!gone) { gone = true; t.remove(); } };
  const timer = setTimeout(dismiss, duration);
  t.querySelector(".toast-undo-btn").addEventListener("click", () => {
    clearTimeout(timer); dismiss(); onUndo();
  });
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
  // Always collapse any expanded video tile before switching — if the user
  // navigates away via a tab button instead of ← Back, collapseTile() would
  // never be called and body.overflow stays "hidden", locking page scroll.
  const expanded = document.querySelector(".out-card.expanded");
  if (expanded) collapseTile(expanded);
  $$(".tabs button").forEach((x) => x.classList.toggle("active", x.dataset.tab === tab));
  $$(".tab").forEach((x) => x.classList.remove("active"));
  $("#tab-" + tab).classList.add("active");
  const deployBar = $("#deploy-bar");
  const genBar = $("#generate-bar");
  if (deployBar) deployBar.style.display = tab === "pods" ? "" : "none";
  if (genBar) genBar.style.display = tab === "generate" ? "" : "none";
  if (tab === "outputs") loadOutputs();
  else { stopOutTimer(); if (_selectMode) exitSelectMode(); }
  if (tab === "generate") {
    resizeTextareas();
    // Re-sync workflow tab active states — on iOS touching other elements
    // can make the button look unselected even though the class is still set.
    $$("#workflow-tabs .img-mode-tab").forEach(
      (b) => b.classList.toggle("active", b.dataset.workflow === _selectedWorkflow)
    );
  }
  if (tab === "generate" || tab === "outputs") loadStorage();
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
      if (act === "terminate" && !await showConfirm("Terminate this pod? This destroys it and stops billing.", { okText: "Terminate", danger: true })) return;
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
let _selectedWorkflow = localStorage.getItem("wan_workflow") || "";

// Convert filename to a short display label: "YAW_2.2_GGUF.json" → "GGUF"
function _workflowLabel(filename) {
  return filename.replace(/\.json$/i, "").split("_").pop().toUpperCase();
}

function renderWorkflowTabs(workflows, defaultWorkflow) {
  const container = $("#workflow-tabs");
  if (!container || workflows.length < 2) {
    if (container) container.hidden = true;
    return;
  }
  // Restore saved selection or fall back to default
  if (!_selectedWorkflow || !workflows.includes(_selectedWorkflow)) {
    _selectedWorkflow = defaultWorkflow || workflows[0];
  }
  container.innerHTML = workflows.map((wf) =>
    `<button class="img-mode-tab${wf === _selectedWorkflow ? " active" : ""}"
             data-workflow="${esc(wf)}">${esc(_workflowLabel(wf))}</button>`
  ).join("");
  container.querySelectorAll(".img-mode-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      _selectedWorkflow = btn.dataset.workflow;
      localStorage.setItem("wan_workflow", _selectedWorkflow);
      container.querySelectorAll(".img-mode-tab").forEach(
        (b) => b.classList.toggle("active", b === btn)
      );
    });
  });
}

async function loadConfig() {
  const cfg = await getJSON("/api/config");
  CFG = cfg;
  FIELDS = cfg.fields || [];
  renderWorkflowTabs(cfg.workflows || [], cfg.default_workflow || "");
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
  // 🎲 randomise seed button
  $("#params").addEventListener("click", (e) => {
    const btn = e.target.closest(".seed-rand");
    if (!btn) return;
    const inp = document.querySelector(`input[data-key="${btn.dataset.key}"]`);
    if (inp) inp.value = Math.floor(Math.random() * 2 ** 32);
  });
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
      <div class="seed-row">
        <input type="text" inputmode="numeric" data-key="${f.key}" value="" placeholder="Leave blank (or 0) to randomise each run" />
        <button type="button" class="ghost small seed-rand" data-key="${f.key}" title="Generate a random seed now">🎲</button>
      </div></label>`;
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
  // Explicitly select only form controls — buttons (e.g. the 🎲 seed-rand
  // button) also carry data-key but their .value is "" which would overwrite
  // the real input value and cause a backend 500.
  $$("input[data-key], textarea[data-key], select[data-key]").forEach((el) => {
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

// ---- generate: image upload -------------------------------------------------
let _currentImageFile = null;

$("#image").addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (!f) return;
  _currentImageFile = f;
  $("#image-label").textContent = f.name;
  $("#preview").src = URL.createObjectURL(f);
  $("#img-preview-wrap").hidden = false;
});

// ---- generate: run ---------------------------------------------------------
$("#generate").addEventListener("click", async () => {
  const podId = $("#gen-pod").value;
  const file = _currentImageFile;
  if (!podId) return toast("No pod selected", true);
  if (!file) return toast("Choose an input image first", true);

  const btn = $("#generate");
  btn.disabled = true;
  btn.textContent = "Submitting…";

  captureUndo("before this generation");
  const params = collectParams();
  postJSON("/api/last-params", params).catch(() => {});

  const fd = new FormData();
  fd.append("pod_id", podId);
  fd.append("image", file);
  fd.append("params", JSON.stringify(params));
  fd.append("workflow_file", _selectedWorkflow || "");

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
  $("#out-select").textContent = "Done";
  _updateBulkBar();
}
function exitSelectMode() {
  _selectMode = false;
  _selected.clear();
  $$("#out-list .out-card.selected").forEach((c) => c.classList.remove("selected"));
  $("#out-list").classList.remove("select-mode");
  $("#bulk-bar").hidden = true;
  $("#out-select").textContent = "Select";
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

$("#out-select").addEventListener("click", () => _selectMode ? exitSelectMode() : enterSelectMode());
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
  if (!await showConfirm(`Delete ${n} video${n !== 1 ? "s" : ""}?`, { okText: "Delete", danger: true })) return;
  const btn = $("#bulk-delete");
  btn.disabled = true; btn.textContent = "Deleting…";
  let done = 0;
  for (const pid of [..._selected]) {
    const card = document.querySelector(`#out-list .out-card[data-pid="${pid}"]`);
    if (!card) continue;
    try {
      await deleteJSON(`/api/pods/${card.dataset.pod}/outputs/${pid}`);
      removeCard(card); done++;
    } catch (_) {}
  }
  toast(`${done} video${done !== 1 ? "s" : ""} deleted`);
  btn.textContent = "🗑 Delete";
  exitSelectMode();
});

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// encode each path segment but preserve slashes for {path:path} FastAPI params
const encPath = (p) => String(p ?? "").split("/").map(encodeURIComponent).join("/");
// folder glyph that matches the UI (stroked, currentColor)
const FOLDER_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`;
// play icon: filled triangle, offset 2px right to optically centre inside the circle
const PLAY_SVG = `<svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18" style="margin-left:2px"><path d="M8 5v14l11-7z"/></svg>`;

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
  if (!items.length) { section.hidden = true; loadStorage(); return; }
  section.hidden = false;
  list.innerHTML = items.map(renderSavedOutput).join("");
  loadStorage();
}

function renderSavedOutput(it) {
  const url = `/api/saved/file/${encodeURIComponent(it.filename)}`;
  const dt = fmtDatetime(it.completed_at);
  const dur = it.duration_secs ? fmtElapsed(it.duration_secs) : null;
  return `<div class="out-card" data-url="${url}" data-name="${esc(it.filename)}"
              data-pid="${esc(it.prompt_id)}">
    <div class="out-cover">
      <video class="cover-img" preload="metadata" muted src="${url}#t=0.1"></video>
      <span class="play-badge">${PLAY_SVG}</span>
      <video class="tile-video" data-src="${url}" playsinline preload="none" controls></video>
      <div class="tile-foot">
        ${dur ? `<span class="tile-dur">⏱ ${dur}</span>` : ""}
        ${dt ? `<span class="tile-dt">${dt}</span>` : ""}
      </div>
      <button class="zoom-back">← Back</button>
      <span class="sel-check"></span>
      <button class="star-btn starred" data-pid="${esc(it.prompt_id)}" title="Remove from saved">★</button>
    </div>
    <div class="out-cap">
      <div class="cap-meta">
        ${dt ? `<span class="out-dt">${dt}</span>` : ""}
        ${dur ? `<span class="out-dur">⏱ ${dur}</span>` : ""}
      </div>
      <div class="out-actions">
        <button class="info-btn ghost small" data-pid="${esc(it.prompt_id)}">Details</button>
        <a class="dl" href="${url}" download="${esc(it.filename)}">↓ Save</a>
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
  const dur = it.duration_secs ? fmtElapsed(it.duration_secs) : null;
  const starred = it.is_saved;
  return `<div class="out-card" data-url="${url}" data-name="${esc(it.filename)}"
              data-pid="${esc(it.prompt_id)}" data-pod="${esc(podId)}"
              data-file="${esc(it.filename)}" data-sub="${esc(it.subfolder||"")}" data-ftype="${esc(it.type||"output")}">
    <div class="out-cover">
      ${cover}
      <span class="play-badge">${PLAY_SVG}</span>
      <video class="tile-video" data-src="${url}" playsinline preload="none" controls></video>
      <div class="tile-foot">
        ${dur ? `<span class="tile-dur">⏱ ${dur}</span>` : ""}
        ${dt ? `<span class="tile-dt">${dt}</span>` : ""}
      </div>
      <button class="zoom-back">← Back</button>
      <span class="sel-check"></span>
      <button class="star-btn${starred ? " starred" : ""}" data-pid="${esc(it.prompt_id)}"
              title="${starred ? "Saved" : "Save to cloud"}">${starred ? "★" : "☆"}</button>
    </div>
    <div class="out-cap">
      <div class="cap-meta">
        ${dt ? `<span class="out-dt">${dt}</span>` : ""}
        ${dur ? `<span class="out-dur">⏱ ${dur}</span>` : ""}
      </div>
      <div class="out-actions">
        <button class="info-btn ghost small" data-pid="${esc(it.prompt_id)}">Details</button>
        <a class="dl" href="${url}" download="${esc(it.filename)}">↓ Save</a>
        <button class="del-btn ghost small" data-pid="${esc(it.prompt_id)}">Delete</button>
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
// Always use this to remove an out-card — collapses first if expanded so
// body.overflow is always restored before the node disappears.
function removeCard(card) {
  if (!card) return;
  if (card.classList.contains("expanded")) collapseTile(card);
  card.remove();
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
    const isSeed = key === "_seed";
    const seedNum = isSeed ? Number(val) : 0;
    const display = isSeed && seedNum <= 0 ? "— (not captured)" : esc(String(val));
    const useBtn = isSeed && seedNum > 0
      ? `<button class="ghost small detail-use-seed" data-seed="${seedNum}" style="margin-top:6px;font-size:12px">↑ Use this seed</button>`
      : "";
    return `<div class="detail-row">
      <span class="detail-key">${esc(label)}</span>
      <span class="detail-val">${display}</span>
      ${useBtn}
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
    captureUndo("before applying generation details");
    applyParams(params);
    switchTab("generate");
    toast("Params applied ✓");
  });
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay || e.target.closest(".details-close")) { overlay.remove(); return; }
    const seedBtn = e.target.closest(".detail-use-seed");
    if (seedBtn) {
      overlay.remove();
      const inp = document.querySelector('input[data-key="_seed"]');
      if (inp) inp.value = seedBtn.dataset.seed;
      switchTab("generate");
      toast(`Seed ${seedBtn.dataset.seed} applied`);
    }
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
    if (!await showConfirm("Delete this video from history?", { okText: "Delete", danger: true })) return;
    const card = delBtn.closest(".out-card");
    delBtn.disabled = true;
    try {
      await deleteJSON(`/api/pods/${card.dataset.pod}/outputs/${card.dataset.pid}`);
      removeCard(card);
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
        removeCard(card);
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
  if (_savedSelectMode) {
    const card = e.target.closest(".out-card");
    if (card) _toggleSavedSelect(card);
    return;
  }
  if (e.target.closest(".zoom-back")) {
    collapseTile(e.target.closest(".out-card"));
    return;
  }
  if (e.target.closest(".dl")) return;
  const infoBtn = e.target.closest(".info-btn");
  if (infoBtn) { showDetails(infoBtn.dataset.pid); return; }
  const starBtn = e.target.closest(".star-btn");
  if (starBtn) {
    if (!await showConfirm("Remove this video from saved?", { okText: "Remove", danger: true })) return;
    const pid = starBtn.dataset.pid;
    starBtn.disabled = true;
    try {
      await deleteJSON(`/api/saved/${pid}`);
      removeCard(starBtn.closest(".out-card"));
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

  // Drop cards for jobs no longer tracked by the server.
  // If any cards are removed it means a job finished while the browser was
  // backgrounded and the 10s "recently done" window already expired — the
  // done→removed transition was never caught above, so loadDone() was never
  // called. Refresh the completed list now so the video appears.
  const orphaned = [...$$("#out-active .out-item")].filter(
    (c) => !live.has(c.dataset.pid)
  );
  orphaned.forEach((c) => c.remove());
  if (orphaned.length > 0) loadDone(podId);
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
  if (!await showConfirm("Stop this generation?", { okText: "Stop", danger: true })) return;
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
  captureUndo(`before applying template "${tpl.name}"`);
  if (ta) { ta.value = tpl.text; resizeTextareas(); toast("Template loaded"); }
});

$("#tpl-update").addEventListener("click", async () => {
  const sel = $("#tpl-select");
  if (!sel || sel.value === "") return toast("Select a template first", true);
  const ta = document.querySelector('textarea[data-key="positive"]');
  if (!ta || !ta.value.trim()) return toast("Prompt is empty", true);
  const idx = Number(sel.value);
  const oldText = _templates[idx]?.text;
  const name = _templates[idx]?.name;
  try {
    _templates = await putJSON(`/api/templates/${idx}`, { text: ta.value.trim() });
    renderTemplateSelect();
    sel.value = String(idx);
    toastUndo(`"${name}" updated`, async () => {
      try {
        _templates = await putJSON(`/api/templates/${idx}`, { text: oldText });
        renderTemplateSelect(); sel.value = String(idx);
        toast(`"${name}" reverted`);
      } catch (e) { toast(e.message, true); }
    });
  } catch (e) { toast(e.message, true); }
});

$("#tpl-save").addEventListener("click", async () => {
  const ta = document.querySelector('textarea[data-key="positive"]');
  if (!ta || !ta.value.trim()) return toast("Prompt is empty", true);
  const name = await showPrompt("Template name", "My template");
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
  if (!await showConfirm(`Delete template "${_templates[idx]?.name}"?`, { okText: "Delete", danger: true })) return;
  const deleted = { name: _templates[idx].name, text: _templates[idx].text };
  try {
    _templates = await deleteJSON(`/api/templates/${idx}`);
    renderTemplateSelect();
    toastUndo(`"${deleted.name}" deleted`, async () => {
      try {
        _templates = await postJSON("/api/templates", { name: deleted.name, text: deleted.text });
        renderTemplateSelect();
        toast(`"${deleted.name}" restored`);
      } catch (e) { toast(e.message, true); }
    });
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
  captureUndo(`before applying "${preset.name}"`);
  applyParams(preset.params);
  toast(`"${preset.name}" applied`);
});

$("#preset-save").addEventListener("click", async () => {
  const name = await showPrompt("Preset name", "My preset");
  if (!name) return;
  try {
    _presets = await postJSON("/api/param-presets", { name, params: collectParams() });
    renderPresetSelect();
    $("#preset-select").value = String(_presets.length - 1);
    toast("Preset saved");
  } catch (e) { toast(e.message, true); }
});

$("#preset-update").addEventListener("click", async () => {
  const sel = $("#preset-select");
  if (!sel || sel.value === "") return toast("Select a preset first", true);
  const idx = Number(sel.value);
  const name = _presets[idx]?.name;
  if (!name) return;
  const oldParams = _presets[idx]?.params;
  try {
    _presets = await putJSON(`/api/param-presets/${idx}`, { name, params: collectParams() });
    renderPresetSelect();
    sel.value = String(idx);
    toastUndo(`"${name}" updated`, async () => {
      try {
        _presets = await putJSON(`/api/param-presets/${idx}`, { name, params: oldParams });
        renderPresetSelect(); sel.value = String(idx);
        toast(`"${name}" reverted`);
      } catch (e) { toast(e.message, true); }
    });
  } catch (e) { toast(e.message, true); }
});

$("#preset-del").addEventListener("click", async () => {
  const sel = $("#preset-select");
  if (!sel || sel.value === "") return toast("Select a preset first", true);
  const idx = Number(sel.value);
  if (!await showConfirm(`Delete preset "${_presets[idx]?.name}"?`, { okText: "Delete", danger: true })) return;
  const deleted = { name: _presets[idx].name, params: _presets[idx].params };
  try {
    _presets = await deleteJSON(`/api/param-presets/${idx}`);
    renderPresetSelect();
    toastUndo(`"${deleted.name}" deleted`, async () => {
      try {
        _presets = await postJSON("/api/param-presets", { name: deleted.name, params: deleted.params });
        renderPresetSelect();
        toast(`"${deleted.name}" restored`);
      } catch (e) { toast(e.message, true); }
    });
  } catch (e) { toast(e.message, true); }
});

// ---- undo / revert (prompt + params together) ------------------------------
// Captures state at key automated moments (template use, preset apply,
// details apply, generate). Manual typing is NOT captured — 10 undo steps.
const UNDO_MAX = 10;
let _undoStack = [];

function captureUndo(label) {
  const ta = document.querySelector('textarea[data-key="positive"]');
  _undoStack.unshift({ prompt: ta ? ta.value : "", params: collectParams(), label });
  if (_undoStack.length > UNDO_MAX) _undoStack.pop();
  _updateRevertBtn();
}

function _updateRevertBtn() {
  const btn = $("#revert-btn");
  if (!btn) return;
  if (_undoStack.length) {
    btn.hidden = false;
    btn.textContent = `↩ Undo (${_undoStack.length})`;
  } else {
    btn.hidden = true;
  }
}

function revertState() {
  if (!_undoStack.length) return;
  const { prompt, params, label } = _undoStack.shift();
  const ta = document.querySelector('textarea[data-key="positive"]');
  if (ta) { ta.value = prompt; resizeTextareas(); }
  applyParams(params);
  toast(`Reverted: ${label}`);
  _updateRevertBtn();
}

$("#revert-btn").addEventListener("click", revertState);

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

// ---- image mode tabs --------------------------------------------------------
$$(".img-mode-tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    // Scope to THIS tab row only — $$(".img-mode-tab") is global and would
    // also clear the active class on the workflow selector tabs.
    btn.closest(".img-mode-tabs").querySelectorAll(".img-mode-tab").forEach(
      (b) => b.classList.toggle("active", b === btn)
    );
    const mode = btn.dataset.mode;
    $("#img-upload-panel").hidden = mode !== "upload";
    $("#img-library-panel").hidden = mode !== "library";
    if (mode === "library") loadLibrary(_libPrefix);
  });
});

// ---- image library state ----------------------------------------------------
let _libPrefix = "";
let _libSelectMode = false;
let _libSelected = new Set();
let _savePanelPrefix = "";
let _savedSelectMode = false;
let _savedSelected = new Set();

// ---- library browse ---------------------------------------------------------
async function loadLibrary(prefix) {
  _libPrefix = prefix;
  let data;
  try {
    data = await getJSON(`/api/images/browse?prefix=${encodeURIComponent(prefix)}`);
  } catch (e) {
    toast("Could not load library: " + e.message, true);
    return;
  }
  renderLibBreadcrumb(prefix);
  renderLibContents(data);
  renderLibSelection();
}

function renderLibBreadcrumb(prefix) {
  const el = $("#lib-breadcrumb");
  const parts = prefix ? prefix.split("/").filter(Boolean) : [];
  let built = "";
  let html = `<button class="lib-crumb" data-prefix="">Home</button>`;
  for (const p of parts) {
    built += p + "/";
    html += `<span class="lib-crumb-sep">/</span><button class="lib-crumb" data-prefix="${esc(built)}">${esc(p)}</button>`;
  }
  el.innerHTML = html;
  el.querySelectorAll(".lib-crumb").forEach((b) =>
    b.addEventListener("click", () => { exitLibSelectMode(); loadLibrary(b.dataset.prefix); })
  );
}

function renderLibContents(data) {
  const cont = $("#lib-contents");
  const emptyEl = $("#lib-empty");
  const folders = data.folders || [];
  const files = data.files || [];
  if (!folders.length && !files.length) {
    cont.innerHTML = "";
    emptyEl.hidden = false;
    return;
  }
  emptyEl.hidden = true;
  if (_libSelectMode) cont.classList.add("lib-select-mode");
  cont.innerHTML = [
    ...folders.map((f) => `<div class="lib-folder-tile" data-prefix="${esc(f.path)}">
      <div class="lib-folder-tile-inner">
        <span class="lib-folder-icon">${FOLDER_SVG}</span>
        <span class="lib-folder-name">${esc(f.name)}</span>
      </div>
    </div>`),
    ...files.map((f) => `<div class="lib-file-tile${_libSelected.has(f.path) ? " selected" : ""}" data-path="${esc(f.path)}">
      <img src="/api/images/file/${encPath(f.path)}" alt="${esc(f.name)}" loading="lazy" />
      <button class="lib-use-btn">Use</button>
    </div>`),
  ].join("");
  cont.querySelectorAll(".lib-folder-tile").forEach((tile) =>
    tile.addEventListener("click", () => { exitLibSelectMode(); loadLibrary(tile.dataset.prefix); })
  );
  cont.querySelectorAll(".lib-file-tile").forEach((tile) =>
    tile.addEventListener("click", () => {
      if (_libSelectMode) { toggleLibSelect(tile); return; }
      useLibraryImage(tile.dataset.path);
    })
  );
}

function renderLibSelection() {
  const el = $("#lib-selection");
  const n = _libSelected.size;
  if (_libSelectMode) {
    el.innerHTML = `<span style="font-size:13px;color:var(--muted)">${n} selected</span>
      <div style="flex:1"></div>
      <button id="lib-sel-done" class="ghost small">Done</button>`;
    el.hidden = false;
    el.querySelector("#lib-sel-done").addEventListener("click", exitLibSelectMode);
    const bar = $("#lib-bulk-bar");
    bar.hidden = n === 0;
    $("#lib-bulk-count").textContent = n ? `${n} selected` : "";
    $("#lib-bulk-delete").disabled = n === 0;
  } else {
    el.innerHTML = `<div style="flex:1"></div><button id="lib-sel-btn" class="ghost small">Select</button>`;
    el.hidden = false;
    el.querySelector("#lib-sel-btn").addEventListener("click", enterLibSelectMode);
    $("#lib-bulk-bar").hidden = true;
  }
}

async function useLibraryImage(path) {
  try {
    const r = await fetch(`/api/images/file/${encPath(path)}`);
    if (!r.ok) throw new Error(r.statusText);
    const blob = await r.blob();
    const name = path.split("/").pop();
    _currentImageFile = new File([blob], name, { type: blob.type || "image/jpeg" });
    $("#preview").src = URL.createObjectURL(_currentImageFile);
    $("#img-preview-wrap").hidden = false;
    $$(".img-mode-tab").forEach((b) => b.classList.toggle("active", b.dataset.mode === "upload"));
    $("#img-upload-panel").hidden = false;
    $("#img-library-panel").hidden = true;
    $("#image-label").textContent = name;
    toast("Image selected ✓");
  } catch (e) {
    toast("Could not load image: " + e.message, true);
  }
}

// ---- library select mode ----------------------------------------------------
function enterLibSelectMode() {
  _libSelectMode = true;
  _libSelected.clear();
  $("#lib-contents").classList.add("lib-select-mode");
  renderLibSelection();
}

function exitLibSelectMode() {
  _libSelectMode = false;
  _libSelected.clear();
  $$("#lib-contents .lib-file-tile").forEach((t) => t.classList.remove("selected"));
  $("#lib-contents").classList.remove("lib-select-mode");
  renderLibSelection();
}

function toggleLibSelect(tile) {
  const path = tile.dataset.path;
  if (_libSelected.has(path)) { _libSelected.delete(path); tile.classList.remove("selected"); }
  else                         { _libSelected.add(path);    tile.classList.add("selected"); }
  renderLibSelection();
}

// ---- library bulk delete ----------------------------------------------------
$("#lib-bulk-delete").addEventListener("click", async () => {
  const n = _libSelected.size;
  if (!await showConfirm(`Delete ${n} image${n !== 1 ? "s" : ""}?`, { okText: "Delete", danger: true })) return;
  const btn = $("#lib-bulk-delete");
  btn.disabled = true; btn.textContent = "Deleting…";
  let done = 0;
  for (const path of [..._libSelected]) {
    try {
      const r = await fetch(`/api/images/file/${encPath(path)}`, { method: "DELETE" });
      if (r.ok) done++;
    } catch (_) {}
  }
  toast(`${done} image${done !== 1 ? "s" : ""} deleted`);
  btn.textContent = "🗑 Delete";
  exitLibSelectMode();
  loadLibrary(_libPrefix);
});
$("#lib-bulk-cancel").addEventListener("click", exitLibSelectMode);

// ---- save-to-cloud panel ----------------------------------------------------
$("#img-star-btn").addEventListener("click", () => {
  if (!_currentImageFile) return toast("No image to save", true);
  _savePanelPrefix = "";
  $("#img-save-panel").hidden = false;
  loadSavePanel("");
});

$("#img-save-cancel").addEventListener("click", () => {
  $("#img-save-panel").hidden = true;
});

async function loadSavePanel(prefix) {
  _savePanelPrefix = prefix;
  let data;
  try {
    data = await getJSON(`/api/images/browse?prefix=${encodeURIComponent(prefix)}`);
  } catch (e) {
    toast("Could not load folders: " + e.message, true);
    return;
  }
  renderSaveBreadcrumb(prefix);
  renderSaveFolders(data.folders || []);
}

function renderSaveBreadcrumb(prefix) {
  const el = $("#save-breadcrumb");
  const parts = prefix ? prefix.split("/").filter(Boolean) : [];
  let built = "";
  let html = `<button class="lib-crumb" data-prefix="">Home</button>`;
  for (const p of parts) {
    built += p + "/";
    html += `<span class="lib-crumb-sep">/</span><button class="lib-crumb" data-prefix="${esc(built)}">${esc(p)}</button>`;
  }
  el.innerHTML = html;
  el.querySelectorAll(".lib-crumb").forEach((b) =>
    b.addEventListener("click", () => loadSavePanel(b.dataset.prefix))
  );
}

function renderSaveFolders(folders) {
  const el = $("#save-folder-list");
  if (!folders.length) {
    el.innerHTML = `<div class="muted" style="font-size:13px;padding:8px 0">No subfolders here.</div>`;
    return;
  }
  el.innerHTML = folders.map((f) => `<div class="save-folder-tile" data-prefix="${esc(f.path)}">
    <span class="folder-ic">${FOLDER_SVG}</span><span>${esc(f.name)}</span><span class="folder-arrow">▶</span>
  </div>`).join("");
  el.querySelectorAll(".save-folder-tile").forEach((tile) =>
    tile.addEventListener("click", () => loadSavePanel(tile.dataset.prefix))
  );
}

$("#save-new-folder-btn").addEventListener("click", () => {
  $("#save-new-folder-row").hidden = false;
  $("#save-new-folder-btn").hidden = true;
  $("#save-new-folder-name").value = "";
  $("#save-new-folder-name").focus();
});

$("#save-new-folder-cancel").addEventListener("click", () => {
  $("#save-new-folder-row").hidden = true;
  $("#save-new-folder-btn").hidden = false;
});

$("#save-new-folder-confirm").addEventListener("click", async () => {
  const name = $("#save-new-folder-name").value.trim().replace(/[/\\]/g, "");
  if (!name) return toast("Enter a folder name", true);
  try {
    await postJSON("/api/images/folder", { path: _savePanelPrefix + name + "/" });
    $("#save-new-folder-row").hidden = true;
    $("#save-new-folder-btn").hidden = false;
    toast("Folder created");
    loadSavePanel(_savePanelPrefix);
  } catch (e) { toast(e.message, true); }
});

$("#save-here-btn").addEventListener("click", async () => {
  if (!_currentImageFile) return toast("No image", true);
  const btn = $("#save-here-btn");
  btn.disabled = true; btn.textContent = "Saving…";
  const destPath = _savePanelPrefix + _currentImageFile.name;
  const fd = new FormData();
  fd.append("file", _currentImageFile, _currentImageFile.name);
  fd.append("path", destPath);
  try {
    const r = await fetch("/api/images/save", { method: "POST", body: fd });
    if (!r.ok) throw new Error((await r.text()) || r.statusText);
    toast("Saved to cloud ✓");
    $("#img-save-panel").hidden = true;
    $("#img-star-btn").textContent = "★ Saved";
  } catch (e) { toast(e.message, true); }
  finally { btn.disabled = false; btn.textContent = "Save here"; }
});

// ---- saved videos select mode -----------------------------------------------
function enterSavedSelectMode() {
  _savedSelectMode = true;
  _savedSelected.clear();
  $("#saved-list").classList.add("saved-select-mode");
  $("#saved-bulk-bar").hidden = false;
  $("#saved-select").textContent = "Done";
  _updateSavedBulkBar();
}

function exitSavedSelectMode() {
  _savedSelectMode = false;
  _savedSelected.clear();
  $$("#saved-list .out-card.selected").forEach((c) => c.classList.remove("selected"));
  $("#saved-list").classList.remove("saved-select-mode");
  $("#saved-bulk-bar").hidden = true;
  $("#saved-select").textContent = "Select";
}

function _toggleSavedSelect(card) {
  const pid = card.dataset.pid;
  if (_savedSelected.has(pid)) { _savedSelected.delete(pid); card.classList.remove("selected"); }
  else                          { _savedSelected.add(pid);   card.classList.add("selected"); }
  _updateSavedBulkBar();
}

function _updateSavedBulkBar() {
  const n = _savedSelected.size;
  $("#saved-bulk-count").textContent = n ? `${n} selected` : "";
  $("#saved-bulk-unstar").disabled = n === 0;
}

$("#saved-select").addEventListener("click", () => _savedSelectMode ? exitSavedSelectMode() : enterSavedSelectMode());
$("#saved-bulk-cancel").addEventListener("click", exitSavedSelectMode);

$("#saved-bulk-unstar").addEventListener("click", async () => {
  const n = _savedSelected.size;
  if (!await showConfirm(`Remove ${n} video${n !== 1 ? "s" : ""} from saved?`, { okText: "Remove", danger: true })) return;
  const btn = $("#saved-bulk-unstar");
  btn.disabled = true; btn.textContent = "Removing…";
  let done = 0;
  for (const pid of [..._savedSelected]) {
    try {
      await deleteJSON(`/api/saved/${pid}`);
      removeCard(document.querySelector(`#saved-list .out-card[data-pid="${pid}"]`));
      done++;
    } catch (_) {}
  }
  toast(`${done} video${done !== 1 ? "s" : ""} removed from saved`);
  btn.textContent = "☆ Unstar";
  exitSavedSelectMode();
  if (!$("#saved-list .out-card")) $("#saved-section").hidden = true;
  if (_outPodId) loadDone(_outPodId);
  loadStorage();
});

// ---- Fly.io server RAM (header chip) ---------------------------------------
async function loadFlyRam() {
  const el = $("#fly-ram");
  if (!el) return;
  let m;
  try { m = await getJSON("/api/sysmetrics"); } catch (_) { return; }
  if (m.used == null || !m.total) { el.textContent = "—"; el.className = "ram-chip"; return; }
  const pct = Math.round((m.used / m.total) * 100);
  el.textContent = `RAM ${pct}%`;
  el.title = `Fly.io server RAM · ${fmtBytes(m.used)} / ${fmtBytes(m.total)}`;
  el.className = "ram-chip" + (pct >= 90 ? " crit" : pct >= 75 ? " warn" : "");
}

// Poll only while the tab is visible so an idle phone lets the machine sleep.
let _ramTimer = null;
function startRamPoll() {
  stopRamPoll();
  loadFlyRam();
  _ramTimer = setInterval(loadFlyRam, 5000);
}
function stopRamPoll() {
  if (_ramTimer) { clearInterval(_ramTimer); _ramTimer = null; }
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopRamPoll();
  } else {
    startRamPoll();
    // iOS backgrounds/throttles JS timers. When the user comes back, the
    // generation may have finished without tickActive() ever seeing the
    // done transition. Proactively refresh so the video appears.
    if ($("#tab-outputs").classList.contains("active") && _outPodId) {
      loadDone(_outPodId);
      tickActive();
    }
  }
});

// ---- Fly.io storage meter ---------------------------------------------------
function fmtBytes(n) {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

async function loadStorage() {
  let s;
  try { s = await getJSON("/api/storage"); } catch (_) { return; }
  const pct = s.total ? Math.min(100, (s.used / s.total) * 100) : 0;
  $$(".storage-meter[data-storage]").forEach((meter) => {
    const val = meter.querySelector(".storage-val");
    const fill = meter.querySelector(".storage-fill");
    if (val) val.textContent = `${fmtBytes(s.used)} / ${fmtBytes(s.total)}`;
    if (fill) {
      fill.style.width = pct + "%";
      fill.classList.toggle("crit", pct >= 90);
      fill.classList.toggle("warn", pct >= 75 && pct < 90);
    }
  });
}

// ---- boot ------------------------------------------------------------------
$("#refresh").addEventListener("click", loadPods);

async function init() {
  // Refresh the auth cookie on every page load so browser-native media
  // requests (<video src>, <img src>) can authenticate without JS headers.
  if (_authHeader) {
    fetch("/api/auth/cookie", { method: "POST", headers: { Authorization: _authHeader } })
      .catch(() => {});
  }
  try {
    await loadConfig();
  } catch (e) {
    if (e instanceof AuthError) return; // login overlay is shown; wait for user
    // Config failed for another reason — continue so the UI at least loads
  }
  await Promise.all(
    [loadPods(), loadTemplates(), loadParamPresets(), restoreLastParams()]
      .map((p) => p.catch((e) => { if (!(e instanceof AuthError)) console.warn(e); }))
  );
  loadBalance();
  loadStorage();
  startRamPoll();
  if (!_balanceTimer) _balanceTimer = setInterval(loadBalance, 60_000);
}

init();

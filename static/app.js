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

// ---- tabs ------------------------------------------------------------------
$$(".tabs button").forEach((b) =>
  b.addEventListener("click", () => {
    $$(".tabs button").forEach((x) => x.classList.remove("active"));
    $$(".tab").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    $("#tab-" + b.dataset.tab).classList.add("active");
    const bar = $("#deploy-bar");
    if (bar) bar.style.display = b.dataset.tab === "pods" ? "" : "none";
  })
);

// ---- pods ------------------------------------------------------------------
let selectedGpu = null;
const metricsTimers = {}; // pod_id -> interval id

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

  // running-pod dropdown on the Generate tab
  const running = pods.filter(isRunning);
  const prev = genSel.value;
  genSel.innerHTML = running.length
    ? running.map((p) => `<option value="${p.id}">${p.name || p.id}</option>`).join("")
    : `<option value="">No running pod</option>`;
  if (running.some((p) => p.id === prev)) genSel.value = prev;
  onGenPodChange();
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
}

function renderMetrics(podId, m) {
  const el = $("#m-" + podId);
  if (!el || !m) return;
  const gpu = (m.machine && m.machine.gpuDisplayName) || "GPU";
  const cells = [
    ["Status", m.desiredStatus || "—"],
    ["Cost", fmtCost(m.costPerHr) || "—"],
    ["Uptime", fmtUptime(m.uptimeSeconds) || "just now"],
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
function renderPodFilters() {
  if (CFG.data_center) {
    const b = $("#region-banner");
    b.textContent = `Region locked to ${CFG.data_center} (network volume attached) · ${CFG.cloud_type} cloud`;
    b.classList.add("show");
  }
  $("#cuda-chips").innerHTML = (CFG.cuda_versions || [])
    .map((v) => `<span class="chip">${v}</span>`)
    .join("");
  $("#ram-select").innerHTML =
    `<option value="">Any</option>` +
    (CFG.ram_options || []).map((r) => `<option value="${r}">${r} GB</option>`).join("");
  if (CFG.container_disk_gb) $("#disk-hint").textContent = CFG.container_disk_gb;
  loadGpuGrid();
}

async function loadGpuGrid() {
  const grid = $("#gpu-grid");
  grid.innerHTML = `<div class="muted">Loading GPUs…</div>`;
  selectedGpu = null;
  $("#start-pod").disabled = true;
  const min = $("#ram-select").value;
  let gpus;
  try {
    gpus = await getJSON("/api/gpu-availability" + (min ? `?min_memory=${min}` : ""));
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
  const sub = g.available
    ? `${g.vcpu} vCPU · ${g.ram}GB RAM · ${g.max_gpu_count || 1}× max`
    : "unavailable in region";
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
    <div class="gpu-vram">${g.vram}<span>GB</span></div>
    <div class="gpu-sub">${sub}</div>
    <div class="gpu-price">${price}<span class="unit">/hr</span></div>
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
    const gpus = await getJSON("/api/gpu-availability" + (min ? `?min_memory=${min}` : ""));
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
  $("#params").innerHTML = FIELDS.map(renderField).join("");
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
    inner = `<label>
      <div class="field-row"><span>${f.label}</span>
        <span class="val" id="val-${f.key}">${f.default}</span></div>
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

  const fd = new FormData();
  fd.append("pod_id", podId);
  fd.append("image", file);
  fd.append("params", JSON.stringify(collectParams()));

  try {
    const r = await fetch("/api/generate", { method: "POST", body: fd });
    if (!r.ok) throw new Error((await r.text()) || r.statusText);
    const { prompt_id } = await r.json();
    showResultCard();
    pollStatus(prompt_id);
  } catch (e) {
    toast(e.message, true);
    btn.disabled = false;
    btn.textContent = "Generate";
  }
});

function showResultCard() {
  $("#result-card").hidden = false;
  $("#result-video").hidden = true;
  $("#download").hidden = true;
  $("#progress-bar").style.width = "0%";
  $("#progress-text").textContent = "Queued…";
  $("#result-card").scrollIntoView({ behavior: "smooth" });
}

async function pollStatus(promptId) {
  const bar = $("#progress-bar");
  const text = $("#progress-text");
  const btn = $("#generate");

  const tick = async () => {
    let job;
    try {
      job = await getJSON(`/api/status/${promptId}`);
    } catch (e) {
      text.textContent = "Lost track of job: " + e.message;
      btn.disabled = false; btn.textContent = "Generate";
      return;
    }

    if (job.max) {
      bar.style.width = Math.round((job.progress / job.max) * 100) + "%";
      text.textContent = `Step ${job.progress} / ${job.max}`;
    } else if (job.status === "running") {
      text.textContent = "Working…";
    }

    if (job.status === "done") {
      bar.style.width = "100%";
      if (job.video) {
        const url = `/api/video/${promptId}`;
        const v = $("#result-video");
        v.src = url; v.hidden = false;
        const dl = $("#download");
        dl.href = url; dl.download = job.video.filename || "wan.mp4"; dl.hidden = false;
        text.textContent = "Done ✓";
      } else {
        text.textContent = "Finished, but no video output was found (check OUTPUT_NODE_ID).";
      }
      btn.disabled = false; btn.textContent = "Generate";
      return;
    }
    if (job.status === "error") {
      text.textContent = "Error: " + (typeof job.error === "string" ? job.error : JSON.stringify(job.error));
      btn.disabled = false; btn.textContent = "Generate";
      return;
    }
    setTimeout(tick, 1500);
  };
  tick();
}

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

// ---- boot ------------------------------------------------------------------
$("#refresh").addEventListener("click", loadPods);
(async function init() {
  await loadConfig();
  await loadPods();
  loadBalance();
  setInterval(loadBalance, 60_000);
})();

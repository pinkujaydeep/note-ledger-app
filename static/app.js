const csrfToken = document.querySelector('meta[name="csrf-token"]').content;
const form = document.querySelector("#entry-form");
const canvas = document.querySelector("#sketch-canvas");
const context = canvas.getContext("2d");
const strokes = [];
const entries = [];
let activeStroke = null;
let erasing = false;

const entriesList = document.querySelector("#entries-list");
const emptyState = document.querySelector("#empty-state");
const searchInput = document.querySelector("#entry-search");
const syncStatus = document.querySelector("#sync-status");
const networkStatus = document.querySelector("#network-status");
const themeSelect = document.querySelector("#theme-select");
const saveStatus = document.querySelector("#save-status");
const saveButton = document.querySelector(".save-button");
const canvasPlaceholder = document.querySelector("#canvas-placeholder");
const OFFLINE_QUEUE_KEY = "devops-ledger-offline-queue-v1";
let syncingQueue = false;
let retryTimer = null;
let retryDelay = 5000;

document.querySelector("#today").textContent = new Intl.DateTimeFormat(undefined, {
  year: "numeric", month: "short", day: "2-digit",
}).format(new Date()).toUpperCase();

function setSyncState(label, state) {
  syncStatus.className = `sync-status${state ? ` is-${state}` : ""}`;
  syncStatus.lastChild.textContent = ` ${label}`;
}

function setSaveStatus(message, isError = false) {
  saveStatus.textContent = message;
  saveStatus.classList.toggle("error", isError);
}

function readOfflineQueue() {
  try {
    const stored = JSON.parse(localStorage.getItem(OFFLINE_QUEUE_KEY) || "[]");
    return Array.isArray(stored) ? stored.filter((entry) => entry && typeof entry.id === "string") : [];
  } catch {
    return [];
  }
}

function writeOfflineQueue(queue) {
  try {
    localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue));
  } catch {
    throw new Error("This browser could not store the offline note. Your form is still here; try without the sketch.");
  }
  updateNetworkStatus();
}

function updateNetworkStatus() {
  const pendingCount = readOfflineQueue().length;
  const online = navigator.onLine;
  networkStatus.textContent = online
    ? (pendingCount ? `Online (${pendingCount} Sync${pendingCount === 1 ? "" : "s"} Pending)` : "Online")
    : `Offline (${pendingCount} Sync${pendingCount === 1 ? "" : "s"} Pending)`;
  networkStatus.classList.toggle("is-offline", !online || pendingCount > 0);
  networkStatus.classList.toggle("is-online", online && pendingCount === 0);
}

function applyTheme(theme, persist = false) {
  document.documentElement.dataset.themePreference = theme;
  document.documentElement.dataset.theme = theme === "system"
    ? (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark")
    : theme;
  themeSelect.value = theme;
  if (persist) {
    try {
      localStorage.setItem("devops-ledger-theme", theme);
    } catch {
      setSaveStatus("Theme applies for this visit, but browser storage is unavailable.", true);
    }
  }
  document.querySelector('meta[name="theme-color"]').content = document.documentElement.dataset.theme === "light" ? "#f0f2ec" : "#171a18";
  redrawCanvas();
}

themeSelect.value = document.documentElement.dataset.themePreference || "system";
themeSelect.addEventListener("change", () => applyTheme(themeSelect.value, true));
window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", (event) => {
  if (document.documentElement.dataset.themePreference === "system") {
    document.documentElement.dataset.theme = event.matches ? "light" : "dark";
    document.querySelector('meta[name="theme-color"]').content = event.matches ? "#f0f2ec" : "#171a18";
    redrawCanvas();
  }
});

function createEntryId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (character) => {
    const random = Math.random() * 16 | 0;
    return (character === "x" ? random : (random & 0x3 | 0x8)).toString(16);
  });
}

function enqueueEntry(payload) {
  const queue = readOfflineQueue();
  if (!queue.some((entry) => entry.id === payload.id)) queue.push(payload);
  writeOfflineQueue(queue);
}

function addPendingEntry(payload) {
  const pending = { ...payload, created_at: new Date().toISOString(), pending: true };
  const existingIndex = entries.findIndex((entry) => entry.id === payload.id);
  if (existingIndex >= 0) entries.splice(existingIndex, 1);
  entries.unshift(pending);
  renderEntries();
}

function removeQueuedEntry(id) {
  writeOfflineQueue(readOfflineQueue().filter((entry) => entry.id !== id));
}

function sketchInk() {
  return getComputedStyle(document.documentElement).getPropertyValue("--sketch-ink").trim() || "#d2f28b";
}

function resizeCanvas() {
  const bounds = canvas.getBoundingClientRect();
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.round(bounds.width * ratio));
  canvas.height = Math.max(1, Math.round(bounds.height * ratio));
  context.lineCap = "round";
  context.lineJoin = "round";
  redrawCanvas();
}

function drawStroke(stroke) {
  if (!stroke.points.length) return;
  context.save();
  context.globalCompositeOperation = stroke.erase ? "destination-out" : "source-over";
  context.strokeStyle = sketchInk();
  context.fillStyle = sketchInk();
  if (stroke.points.length === 1) {
    const point = stroke.points[0];
    const pressure = point.pressure || 0.5;
    const radius = (stroke.erase ? 9 : 1.15 + pressure * 1.35) * canvas.width / canvas.getBoundingClientRect().width;
    context.beginPath();
    context.arc(point.x * canvas.width, point.y * canvas.height, radius, 0, Math.PI * 2);
    context.fill();
  } else {
    for (let index = 1; index < stroke.points.length; index += 1) {
      const previous = stroke.points[index - 1];
      const point = stroke.points[index];
      const pressure = (previous.pressure + point.pressure) / 2 || 0.5;
      const width = (stroke.erase ? 18 : 1.2 + pressure * 2.4) * canvas.width / canvas.getBoundingClientRect().width;
      context.lineWidth = width;
      context.beginPath();
      context.moveTo(previous.x * canvas.width, previous.y * canvas.height);
      context.lineTo(point.x * canvas.width, point.y * canvas.height);
      context.stroke();
    }
  }
  context.restore();
}

function drawSegment(stroke, previous, point) {
  const bounds = canvas.getBoundingClientRect();
  const pressure = (previous.pressure + point.pressure) / 2 || 0.5;
  context.save();
  context.globalCompositeOperation = stroke.erase ? "destination-out" : "source-over";
  context.strokeStyle = sketchInk();
  context.lineWidth = (stroke.erase ? 18 : 1.2 + pressure * 2.4) * canvas.width / bounds.width;
  context.lineCap = "round";
  context.beginPath();
  context.moveTo(previous.x * canvas.width, previous.y * canvas.height);
  context.lineTo(point.x * canvas.width, point.y * canvas.height);
  context.stroke();
  context.restore();
}

function redrawCanvas() {
  context.clearRect(0, 0, canvas.width, canvas.height);
  strokes.forEach(drawStroke);
  canvasPlaceholder.hidden = strokes.length > 0;
  document.querySelector("#undo-sketch").disabled = strokes.length === 0;
  document.querySelector("#clear-sketch").disabled = strokes.length === 0;
}

function pointFromEvent(event) {
  const bounds = canvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
    y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
    pressure: event.pressure || 0.5,
  };
}

canvas.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  canvas.setPointerCapture(event.pointerId);
  activeStroke = { erase: erasing, points: [pointFromEvent(event)] };
  strokes.push(activeStroke);
  redrawCanvas();
});

canvas.addEventListener("pointermove", (event) => {
  if (!activeStroke || !canvas.hasPointerCapture(event.pointerId)) return;
  event.preventDefault();
  const samples = event.getCoalescedEvents ? event.getCoalescedEvents() : [event];
  samples.forEach((sample) => {
    const point = pointFromEvent(sample);
    drawSegment(activeStroke, activeStroke.points[activeStroke.points.length - 1], point);
    activeStroke.points.push(point);
  });
});

function finishStroke(event) {
  if (!activeStroke) return;
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  activeStroke = null;
}

canvas.addEventListener("pointerup", finishStroke);
canvas.addEventListener("pointercancel", finishStroke);
window.addEventListener("resize", resizeCanvas);
resizeCanvas();

document.querySelector("#undo-sketch").addEventListener("click", () => {
  strokes.pop();
  redrawCanvas();
});
document.querySelector("#clear-sketch").addEventListener("click", () => {
  strokes.length = 0;
  redrawCanvas();
});
document.querySelector("#eraser-toggle").addEventListener("click", (event) => {
  erasing = !erasing;
  event.currentTarget.setAttribute("aria-pressed", String(erasing));
});

function addDetail(parent, label, value) {
  if (!value) return;
  const detail = document.createElement("section");
  detail.className = "entry-detail";
  const heading = document.createElement("h4");
  heading.textContent = label;
  const text = document.createElement("p");
  text.textContent = value;
  detail.append(heading, text);
  parent.append(detail);
}

function makeEntryCard(entry) {
  const card = document.createElement("article");
  card.className = "entry-card";
  const header = document.createElement("header");
  header.className = "entry-card-head";
  const titleWrap = document.createElement("div");
  const title = document.createElement("h3");
  title.textContent = entry.title;
  const date = document.createElement("time");
  date.className = "entry-date";
  date.textContent = entry.pending ? "PENDING SYNC" : entry.created_at ? new Intl.DateTimeFormat(undefined, {
    year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(new Date(entry.created_at)) : "JUST NOW";
  titleWrap.append(title, date);
  const category = document.createElement("span");
  category.className = "category-tag";
  category.textContent = entry.category;
  header.append(titleWrap, category);

  const content = document.createElement("div");
  content.className = "entry-content";
  addDetail(content, "Bottleneck solved", entry.blueprint_1);
  addDetail(content, "Infrastructure dependencies", entry.blueprint_2);
  addDetail(content, "Blast radius", entry.blueprint_3);

  if (entry.syntax_block) {
    const command = document.createElement("section");
    command.className = "entry-command";
    const commandHead = document.createElement("div");
    commandHead.className = "entry-command-head";
    const label = document.createElement("h4");
    label.className = "entry-command-label";
    label.textContent = "Command & context";
    const copy = document.createElement("button");
    copy.className = "copy-button";
    copy.type = "button";
    copy.textContent = "Copy";
    copy.setAttribute("aria-label", "Copy command block to clipboard");
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(entry.syntax_block);
        copy.textContent = "Copied";
        window.setTimeout(() => { copy.textContent = "Copy"; }, 1400);
      } catch {
        copy.textContent = "Unavailable";
        window.setTimeout(() => { copy.textContent = "Copy"; }, 1800);
      }
    });
    commandHead.append(label, copy);
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.textContent = entry.syntax_block;
    pre.append(code);
    command.append(commandHead, pre);
    content.append(command);
  }

  addDetail(content, "Observed symptom", entry.failure_symptom);
  addDetail(content, "Root cause", entry.failure_root_cause);
  addDetail(content, "Mitigation", entry.failure_mitigation);
  if (typeof entry.sketch_data === "string" && /^data:image\/(?:png|jpeg);base64,/.test(entry.sketch_data)) {
    const sketch = document.createElement("img");
    sketch.className = "entry-sketch";
    sketch.src = entry.sketch_data;
    sketch.alt = `Topology sketch for ${entry.title}`;
    content.append(sketch);
  }
  card.append(header, content);
  return card;
}

function renderEntries() {
  const query = searchInput.value.trim().toLocaleLowerCase();
  const visible = entries.filter((entry) => FIELDS_TO_SEARCH.some((field) =>
    String(entry[field] || "").toLocaleLowerCase().includes(query),
  ));
  entriesList.replaceChildren(...visible.map(makeEntryCard));
  document.querySelector("#entry-count").textContent = String(entries.length).padStart(2, "0");
  document.querySelector("#result-count").textContent = `(${visible.length})`;
  emptyState.hidden = visible.length > 0;
  if (entries.length && !visible.length) {
    emptyState.querySelector("h3").textContent = "No matching notes";
    emptyState.querySelector("p").textContent = "Try another title, category, or keyword.";
  } else {
    emptyState.querySelector("h3").textContent = "No notes yet";
    emptyState.querySelector("p").textContent = "Your first saved thought will show up here.";
  }
}

const FIELDS_TO_SEARCH = [
  "title", "category", "blueprint_1", "blueprint_2", "blueprint_3", "syntax_block",
  "failure_symptom", "failure_root_cause", "failure_mitigation",
];

function scheduleQueueSync() {
  if (!navigator.onLine || retryTimer) return;
  retryTimer = window.setTimeout(() => {
    retryTimer = null;
    syncOfflineQueue();
  }, retryDelay);
  retryDelay = Math.min(retryDelay * 2, 60000);
}

async function syncOfflineQueue() {
  updateNetworkStatus();
  if (!navigator.onLine || syncingQueue) return;
  let queue = readOfflineQueue();
  if (!queue.length) return;
  syncingQueue = true;
  let shouldRetry = true;
  try {
    for (const queuedEntry of queue) {
      let response;
      try {
        response = await fetch("/api/entries", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
          body: JSON.stringify(queuedEntry),
        });
      } catch {
        break;
      }
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        shouldRetry = response.status === 429 || response.status >= 500;
        break;
      }
      if (!data.entry) break;
      try {
        removeQueuedEntry(queuedEntry.id);
      } catch {
        break;
      }
      const existingIndex = entries.findIndex((entry) => entry.id === queuedEntry.id);
      if (existingIndex >= 0) entries.splice(existingIndex, 1);
      entries.unshift(data.entry);
      renderEntries();
      queue = readOfflineQueue();
    }
  } finally {
    syncingQueue = false;
    updateNetworkStatus();
    if (readOfflineQueue().length && shouldRetry) scheduleQueueSync();
    else retryDelay = 5000;
  }
}

async function loadEntries() {
  setSyncState("SYNCING");
  try {
    const response = await fetch("/api/entries", { headers: { Accept: "application/json" } });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "The ledger could not be loaded.");
    entries.splice(0, entries.length, ...data.entries);
    for (const queuedEntry of readOfflineQueue()) {
      if (!entries.some((entry) => entry.id === queuedEntry.id)) {
        entries.push({ ...queuedEntry, created_at: new Date().toISOString(), pending: true });
      }
    }
    renderEntries();
    setSyncState("LIVE", "ready");
  } catch (error) {
    setSyncState("OFFLINE", "error");
    entries.splice(0, entries.length, ...readOfflineQueue().map((entry) => ({
      ...entry, created_at: new Date().toISOString(), pending: true,
    })));
    renderEntries();
    if (!entries.length) {
      emptyState.hidden = false;
      emptyState.querySelector("h3").textContent = "Ledger unavailable";
      emptyState.querySelector("p").textContent = error.message;
    }
  }
}

searchInput.addEventListener("input", renderEntries);
document.addEventListener("keydown", (event) => {
  if (event.key === "/" && !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) {
    event.preventDefault();
    searchInput.focus();
  }
});

function exportSketchAsJpeg() {
  if (!strokes.length) return "";
  const image = document.createElement("canvas");
  image.width = canvas.width;
  image.height = canvas.height;
  const imageContext = image.getContext("2d");
  imageContext.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--canvas-bg").trim() || "#171c18";
  imageContext.fillRect(0, 0, image.width, image.height);
  imageContext.drawImage(canvas, 0, 0);
  return image.toDataURL("image/jpeg", 0.6);
}

function resetEntryForm() {
  form.reset();
  strokes.length = 0;
  redrawCanvas();
}

function saveForLater(payload, message) {
  enqueueEntry(payload);
  addPendingEntry(payload);
  resetEntryForm();
  setSaveStatus(message);
  scheduleQueueSync();
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  saveButton.disabled = true;
  setSaveStatus("Saving to the ledger...");
  const payload = Object.fromEntries(new FormData(form).entries());
  payload.id = createEntryId();
  try {
    payload.sketch_data = exportSketchAsJpeg();
    if (!navigator.onLine) {
      saveForLater(payload, "Saved on this device. It will sync when you're online.");
      return;
    }
    const response = await fetch("/api/entries", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || "The entry could not be saved.");
      error.status = response.status;
      throw error;
    }
    if (!data.entry) {
      const error = new Error("The server response was incomplete; the note was queued for retry.");
      error.status = 503;
      throw error;
    }
    entries.unshift(data.entry);
    renderEntries();
    resetEntryForm();
    setSaveStatus("Note saved.");
    setSyncState("LIVE", "ready");
  } catch (error) {
    const temporaryFailure = !navigator.onLine || error instanceof TypeError || error.status === 429 || error.status >= 500;
    if (temporaryFailure) {
      try {
        saveForLater(payload, "Saved on this device. Sync will retry automatically.");
      } catch (storageError) {
        setSaveStatus(storageError.message, true);
      }
    } else {
      setSaveStatus(error.message, true);
    }
  } finally {
    saveButton.disabled = false;
    updateNetworkStatus();
  }
});

window.addEventListener("offline", updateNetworkStatus);
window.addEventListener("online", () => {
  updateNetworkStatus();
  if (retryTimer) {
    window.clearTimeout(retryTimer);
    retryTimer = null;
  }
  retryDelay = 5000;
  syncOfflineQueue().then(loadEntries);
});

updateNetworkStatus();
loadEntries().then(syncOfflineQueue);
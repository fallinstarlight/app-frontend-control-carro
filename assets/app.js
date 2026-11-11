"use strict";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const DEFAULTS = { apiUrl: `http://${location.hostname || "localhost"}:8000`, vehicleId: 1 };
let settings = { ...DEFAULTS };
try {
  const saved = JSON.parse(localStorage.getItem("indiscipline.connection"));
  if (saved) settings = validateSettings(saved.apiUrl, saved.vehicleId);
} catch { /* An invalid/stale preference must not prevent opening the page. */ }
let commands = [];
let connected = false;
let sending = false;
let stopQueued = false;
let nextDirection = null;
let activeView = "connection";
let epoch = 0;
let pollTimer;
let schema;
let endpoints = [];

function validateSettings(address, id) {
  const url = new URL(address);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error("Use an HTTP or HTTPS API address without credentials, query or fragment.");
  const vehicleId = Number(id);
  if (!Number.isSafeInteger(vehicleId) || vehicleId < 1) throw new Error("Vehicle ID must be a positive integer.");
  return { apiUrl: url.href.replace(/\/$/, ""), vehicleId };
}

function feedback(message, error = false, menu = false) {
  const target = $(menu ? "#menu-feedback" : "#feedback");
  target.textContent = message;
  target.classList.toggle("error", error);
}

async function request(path, { method = "GET", body, connection = settings } = {}) {
  let response;
  try {
    response = await fetch(`${connection.apiUrl}${path}`, {
      method, headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(8000), cache: "no-store",
    });
  } catch (error) {
    const hint = location.protocol === "https:" && connection.apiUrl.startsWith("http:")
      ? " Open this page over HTTP to reach an HTTP API." : " Check the address, Wi-Fi and API server.";
    throw new Error((method === "GET" ? "API unreachable." : "Request outcome unknown; it may have reached the API. Check status before retrying.") + hint);
  }
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) {
    const detail = data?.detail ?? data?.message ?? data?.error ?? data ?? response.statusText;
    throw new Error(`HTTP ${response.status}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  }
  return data;
}

function setConnected(value) {
  connected = value;
  $("#connection-dot").classList.toggle("online", value);
  $("#connection-label").textContent = value ? "API reachable" : "API unavailable";
  refreshButtons();
}

function commandFor(code) {
  return commands.find((c) => c.code === code && Boolean(c.isActive));
}

function refreshButtons() {
  $$("[data-code]").forEach((button) => {
    const code = Number(button.dataset.code);
    // STOP remains available after a polling failure so it can still be attempted.
    button.disabled = code === 0 ? stopQueued : (!connected || sending || !commandFor(code));
    button.title = code !== 0 && !commandFor(code) ? `No active command with code ${code}. Configure it in Menu → Commands.` : "";
  });
}

function displayStatus(status) {
  $("#last-command").textContent = status.commandName ?? "No command";
  $$("[data-code]").forEach((button) => button.classList.toggle("active", Number(button.dataset.code) === status.code));
}

function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

async function pollStatus(currentEpoch = epoch) {
  clearTimeout(pollTimer);
  try {
    const data = await request(`/status/${settings.vehicleId}`);
    if (currentEpoch !== epoch) return;
    displayStatus(data);
    setConnected(true);
    // Recover command discovery too if the server was down when the page opened.
    if (!commands.length) {
      const loaded = await request(`/commands/vehicle/${settings.vehicleId}`);
      if (currentEpoch !== epoch) return;
      commands = loaded;
      refreshButtons();
    }
  } catch (error) {
    if (currentEpoch !== epoch) return;
    // A vehicle may exist without a status row before its first command.
    if (error.message.startsWith("HTTP 404") && commands.length) setConnected(true);
    else { setConnected(false); feedback(error.message, true); }
  } finally {
    if (currentEpoch === epoch) pollTimer = setTimeout(() => pollStatus(currentEpoch), 2000);
  }
}

async function connect() {
  const currentEpoch = ++epoch;
  clearTimeout(pollTimer);
  commands = [];
  schema = undefined;
  setConnected(false);
  $("#api-url").value = settings.apiUrl;
  $("#vehicle-input").value = settings.vehicleId;
  $("#vehicle-name").textContent = `Vehicle ${settings.vehicleId}`;
  displayStatus({});
  feedback("Loading vehicle commands…");
  try {
    const [vehicle, loadedCommands] = await Promise.all([
      request(`/vehicles/${settings.vehicleId}`), request(`/commands/vehicle/${settings.vehicleId}`),
    ]);
    if (currentEpoch !== epoch) return;
    commands = loadedCommands;
    $("#vehicle-name").textContent = vehicle.name;
    setConnected(true);
    const missing = Array.from({ length: 9 }, (_, i) => i).filter((code) => !commandFor(code));
    feedback(missing.length ? `Missing command codes: ${missing.join(", ")}. Open Menu → Commands.` : "Ready to send. Confirm ESP connection in the serial monitor.", Boolean(missing.length));
  } catch (error) { if (currentEpoch === epoch) feedback(error.message, true); }
  if (currentEpoch === epoch) { refreshPrograms(); pollStatus(currentEpoch); }
}

async function sendCommand(code) {
  if (sending) {
    if (code !== 0 && !stopQueued) nextDirection = code;
    if (code === 0) { nextDirection = null; stopQueued = true; refreshButtons(); feedback("STOP queued immediately after the pending request."); }
    return;
  }
  const command = commandFor(code);
  if (!command && code !== 0) return feedback(`No active command with code ${code}.`, true);
  sending = true;
  refreshButtons();
  feedback(code === 0 ? "Sending STOP…" : `Sending ${command.name}…`);
  try {
    await request("/status", { method: "POST", body: {
      vehicleId: settings.vehicleId,
      commandId: command?.commandId ?? null, // Null is a fail-safe stop if no STOP row exists.
      isConnected: true, source: "MANUAL",
    } });
    feedback(code === 0 ? "STOP accepted by API." : `${command.name} accepted by API.`);
    if (code === 7 || code === 8) await new Promise(resolve => setTimeout(resolve, 500));
  } catch (error) { feedback(error.message, true); }
  finally {
    sending = false;
    const pending = stopQueued || code === 7 || code === 8 ? 0 : nextDirection;
    nextDirection = null;
    stopQueued = false;
    refreshButtons();
    if (pending !== null) await sendCommand(pending);
  }
}

// Render API-provided text using textContent, never HTML interpolation.
function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function table(container, headings, rows) {
  container.replaceChildren();
  if (!rows.length) { container.append(node("p", "No records found.", "empty")); return; }
  const result = node("table");
  const head = node("tr");
  headings.forEach((title) => { const th = node("th", title); th.scope = "col"; head.append(th); });
  const thead = node("thead"); thead.append(head); result.append(thead);
  const tbody = node("tbody");
  rows.forEach((row) => {
    const tr = node("tr");
    row.forEach((value) => { const td = node("td"); if (value instanceof Node) td.append(value); else td.textContent = value ?? "—"; tr.append(td); });
    tbody.append(tr);
  });
  result.append(tbody); container.append(result);
}

function actionButton(label, action) {
  const button = node("button", label);
  button.type = "button";
  button.addEventListener("click", () => menuTask(action, button));
  return button;
}

async function menuTask(action, button) {
  if (button) button.disabled = true;
  feedback("Working…", false, true);
  try { await action(); }
  catch (error) { feedback(error.message, true, true); }
  finally { if (button) button.disabled = false; }
}

function confirmAction(title, message) {
  $("#confirm-title").textContent = title;
  $("#confirm-text").textContent = message;
  const dialog = $("#confirm-dialog");
  dialog.returnValue = "cancel";
  dialog.showModal();
  return new Promise((resolve) => dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true }));
}

async function loadHistory() {
  const currentEpoch = epoch;
  const rows = await request(`/history/${settings.vehicleId}`);
  if (currentEpoch !== epoch) return;
  table($("#history-table"), ["ID", "COMMAND", "CODE", "TIME", "SOURCE"], rows.map((r) => [r.historyId, r.commandName, r.code, formatTime(r.timestamp), r.source]));
  feedback(`${rows.length} history records loaded.`, false, true);
}

async function loadCommands() {
  const currentEpoch = epoch;
  const rows = await request(`/commands/vehicle/${settings.vehicleId}`);
  if (currentEpoch !== epoch) return;
  commands = rows;
  refreshButtons();
  table($("#commands-table"), ["ID", "NAME", "CODE", "ACTIVE", "ACTIONS"], commands.map((c) => {
    const actions = node("div");
    actions.append(actionButton("Edit", () => editCommand(c)), actionButton("Delete", async () => {
      if (!await confirmAction("Delete command?", `Delete ${c.name} (#${c.commandId})? This also affects its availability in the controller.`)) return feedback("Deletion cancelled.", false, true);
      await request(`/commands/${c.commandId}`, { method: "DELETE" });
      await loadCommands();
    }));
    return [c.commandId, c.name, c.code, c.isActive ? "Yes" : "No", actions];
  }));
  feedback(`${commands.length} commands loaded.`, false, true);
}

function editCommand(command) {
  $("#command-form").hidden = false;
  $("#command-form-title").textContent = command ? `Edit ${command.name}` : "New command";
  $("#command-id").value = command?.commandId ?? "";
  $("#command-name").value = command?.name ?? "";
  $("#command-code").value = command?.code ?? "";
  $("#command-description").value = command?.description ?? "";
  $("#command-active").checked = command ? Boolean(command.isActive) : true;
  $("#command-active").disabled = !command;
  $("#command-name").focus();
  feedback("", false, true);
}

async function loadDemos() {
  const currentEpoch = epoch;
  const demos = await request(`/demos/vehicle/${settings.vehicleId}`);
  if (currentEpoch !== epoch) return;
  $("#demo-list").replaceChildren();
  if (!demos.length) $("#demo-list").append(node("p", "No demos yet. Add one in All endpoints.", "empty"));
  demos.forEach((demo) => {
    const card = node("article", undefined, "demo-card");
    const description = node("div");
    description.append(node("h3", demo.name), node("p", demo.description || `Demo #${demo.demoId}`));
    const movements = node("div", undefined, "table-container");
    const run = actionButton("Run demo ↗", async () => {
      if (!await confirmAction("Run vehicle demo?", `Run ${demo.name} on vehicle ${settings.vehicleId}? This will move the vehicle. Use the main STOP button or Space to interrupt it.`)) return feedback("Demo cancelled.", false, true);
      await request(`/demos/${demo.demoId}/run`, { method: "POST" });
      $("#menu-dialog").close();
      feedback(`${demo.name} started. STOP interrupts the ESP’s execution.`);
    });
    run.disabled = !demo.isActive;
    const inspect = actionButton("View steps", async () => {
      const rows = await request(`/demos/${demo.demoId}/movements`);
      table(movements, ["ORDER", "COMMAND", "DURATION (ms)", "PAUSE (ms)"], rows.map((m) => [m.sortOrder, m.commandName, m.durationMs, m.pauseMs]));
      feedback(`${rows.length} movements loaded.`, false, true);
    });
    card.append(description, inspect, run, movements); $("#demo-list").append(card);
  });
  feedback(`${demos.length} demos loaded.`, false, true);
}

function resolveSchema(value) {
  if (value?.$ref) return schema.components.schemas[value.$ref.split("/").pop()];
  if (value?.anyOf) return resolveSchema(value.anyOf.find((s) => s.type !== "null") || value.anyOf[0]);
  return value || {};
}

function exampleBody(definition) {
  const resolved = resolveSchema(definition);
  if (Object.hasOwn(resolved, "default")) return resolved.default;
  if (resolved.enum) return resolved.enum[0];
  if (resolved.type === "object") return Object.fromEntries(Object.entries(resolved.properties || {}).map(([key, value]) => {
    if (key === "vehicleId") return [key, settings.vehicleId];
    if (key === "source") return [key, "MANUAL"];
    if (key === "durationMs") return [key, 500];
    return [key, exampleBody(value)];
  }));
  if (resolved.type === "boolean") return true;
  if (["integer", "number"].includes(resolved.type)) return resolved.minimum ?? ((resolved.exclusiveMinimum ?? 0) + 1);
  return "";
}

async function loadEndpoints() {
  if (!schema) schema = await request("/openapi.json");
  endpoints = [];
  Object.entries(schema.paths).forEach(([path, methods]) => Object.entries(methods).forEach(([method, operation]) => {
    if (["get", "post", "put", "delete", "patch"].includes(method)) endpoints.push({ path, method: method.toUpperCase(), ...operation });
  }));
  const select = $("#endpoint-select"); select.replaceChildren();
  endpoints.forEach((endpoint, index) => { const option = node("option", `${endpoint.method} ${endpoint.path} — ${endpoint.summary || ""}`); option.value = index; select.append(option); });
  showEndpoint();
  feedback(`${endpoints.length} endpoints available.`, false, true);
}

function showEndpoint() {
  const endpoint = endpoints[Number($("#endpoint-select").value)];
  if (!endpoint) return;
  $("#endpoint-params").replaceChildren();
  for (const parameter of endpoint.parameters || []) {
    const label = node("label", `${parameter.name} (${parameter.in})`);
    const input = node("input"); input.name = parameter.name; input.dataset.in = parameter.in;
    input.required = parameter.required;
    input.type = ["integer", "number"].includes(parameter.schema?.type) ? "number" : "text";
    if (input.type === "number") { input.step = "1"; input.min = "1"; }
    if (parameter.name === "vehicle_id") input.value = settings.vehicleId;
    label.append(input); $("#endpoint-params").append(label);
  }
  const bodySchema = endpoint.requestBody?.content?.["application/json"]?.schema;
  $("#endpoint-body-label").hidden = !bodySchema;
  $("#endpoint-body").value = bodySchema ? JSON.stringify(exampleBody(bodySchema), null, 2) : "";
  $("#endpoint-description").textContent = endpoint.method === "GET" ? "Read-only request." : "This request changes API data and may control the vehicle. You will review it before sending.";
  $("#endpoint-result").hidden = true;
}

async function showView(view) {
  activeView = view;
  $$(".menu-view").forEach((section) => { section.hidden = section.id !== `view-${view}`; });
  $$("[data-view]").forEach((button) => { if (button.dataset.view === view) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current"); });
  feedback("", false, true);
  const loaders = { history: loadHistory, commands: loadCommands, demos: loadDemos, api: loadEndpoints };
  if (loaders[view]) await menuTask(loaders[view]);
}

$$("[data-code]").forEach((button) => button.addEventListener("click", () => {
  const code = Number(button.dataset.code);
  if (gesture) {
    if (code === 0) releaseStick();
    else feedback("Release the stick before toggling equipment.");
    return;
  }
  sendCommand(code);
}));
$("#open-menu").addEventListener("click", () => { releaseStick(); $("#menu-dialog").showModal(); showView(activeView); });
$(".close-dialog").addEventListener("click", () => $("#menu-dialog").close());
$$("[data-view]").forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));
$("#connection-form").addEventListener("submit", (event) => {
  event.preventDefault();
  menuTask(async () => {
    if (sending) throw new Error("Wait for the pending command before changing connection.");
    settings = validateSettings($("#api-url").value.trim(), $("#vehicle-input").value);
    try { localStorage.setItem("indiscipline.connection", JSON.stringify(settings)); } catch { /* Session still works without storage. */ }
    await connect(); feedback("Connection settings applied.", false, true);
  }, event.submitter);
});
$("#check-health").addEventListener("click", (event) => menuTask(async () => {
  const result = await request("/"); $("#health-result").hidden = false;
  $("#health-result").textContent = JSON.stringify(result, null, 2); feedback("Health request completed.", false, true);
}, event.currentTarget));
$("#refresh-history").addEventListener("click", () => menuTask(loadHistory));
$("#refresh-demos").addEventListener("click", () => menuTask(loadDemos));
$("#new-command").addEventListener("click", () => editCommand());
$("#cancel-command").addEventListener("click", () => { $("#command-form").hidden = true; });
$("#command-form").addEventListener("submit", (event) => {
  event.preventDefault();
  menuTask(async () => {
    const id = $("#command-id").value;
    const body = { name: $("#command-name").value.trim(), code: Number($("#command-code").value), description: $("#command-description").value.trim() || null };
    if (id) body.isActive = $("#command-active").checked; else body.vehicleId = settings.vehicleId;
    if (!body.name) throw new Error("Command name cannot be blank.");
    await request(id ? `/commands/${id}` : "/commands", { method: id ? "PUT" : "POST", body });
    $("#command-form").hidden = true; await loadCommands(); feedback("Command saved.", false, true);
  }, event.submitter);
});
$("#endpoint-select").addEventListener("change", showEndpoint);
$("#endpoint-form").addEventListener("submit", (event) => {
  event.preventDefault();
  menuTask(async () => {
    const endpoint = endpoints[Number($("#endpoint-select").value)];
    if (!endpoint) throw new Error("Select an endpoint first.");
    let path = endpoint.path;
    const query = new URLSearchParams();
    $$("#endpoint-params input").forEach((input) => {
      if (input.dataset.in === "path") path = path.replace(`{${input.name}}`, encodeURIComponent(input.value));
      else if (input.value) query.set(input.name, input.value);
    });
    if (query.size) path += `?${query}`;
    let body;
    if (!$("#endpoint-body-label").hidden) {
      try { body = JSON.parse($("#endpoint-body").value); } catch { throw new Error("Request body must be valid JSON."); }
    }
    if (endpoint.method !== "GET" && !await confirmAction("Send API request?", `${endpoint.method} ${path}\n${body === undefined ? "" : JSON.stringify(body)}`)) return feedback("Request cancelled.", false, true);
    const result = await request(path, { method: endpoint.method, body });
    $("#endpoint-result").hidden = false; $("#endpoint-result").textContent = JSON.stringify(result, null, 2);
    if (endpoint.method !== "GET") await loadCommands();
    feedback("Request completed.", false, true);
  }, event.submitter);
});

async function refreshPrograms() {
  const generation = epoch;
  const select = $("#program");
  const previous = select.value;
  try {
    const demos = await request(`/demos/vehicle/${settings.vehicleId}`);
    if (generation !== epoch) return;
    select.replaceChildren(new Option("Select demo", ""));
    for (const demo of demos.filter(demo => demo.isActive)) {
      select.add(new Option(demo.name, demo.demoId));
    }
    select.value = previous;
  } catch (error) {
    if (generation === epoch) {
      select.replaceChildren(new Option("Demos unavailable", ""));
      select.title = error.message;
    }
  }
}
$("#program").addEventListener("focus", refreshPrograms);
$("#run-program").addEventListener("click", async event => {
  const id = $("#program").value;
  if (!id || sending || gesture) return feedback("Select a demo and release the controls first.");
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await request(`/demos/${id}/run`, {method:"POST"});
    feedback("Demo started.");
  } catch (error) { feedback(error.message, true); }
  finally { button.disabled = false; }
});

let gesture = null;
function releaseStick() {
  if (!gesture) return;
  const { stick, pointer } = gesture;
  gesture = null;
  stick.classList.remove("held");
  stick.style.removeProperty("--x");
  stick.style.removeProperty("--y");
  if (pointer != null && stick.hasPointerCapture(pointer)) stick.releasePointerCapture(pointer);
  sendCommand(0);
}

function moveStick(x, y) {
  const {stick} = gesture;
  if (stick.id === "load") x = 0;
  const distance = Math.hypot(x, y);
  const scale = Math.max(1, distance);
  const radius = stick.clientWidth * 0.31;
  stick.style.setProperty("--x", `${x / scale * radius}px`);
  stick.style.setProperty("--y", `${y / scale * radius}px`);
  if (distance < 0.12) return;
  // Comparing the two projections gives four equal sectors around the cardinal axes.
  const code = stick.id === "load" ? (y < 0 ? 5 : 6)
    : Math.abs(x) >= Math.abs(y) ? (x > 0 ? 4 : 3) : (y < 0 ? 1 : 2);
  if (gesture.code === code) return;
  gesture.code = code;
  sendCommand(commandFor(code) ? code : 0);
}

for (const stick of $$(".stick")) {
  function track(event) {
    const box = stick.getBoundingClientRect();
    moveStick((event.clientX-box.left-box.width/2)/(stick.clientWidth * 0.31),
              (event.clientY-box.top-box.height/2)/(stick.clientWidth * 0.31));
  }
  stick.addEventListener("pointerdown", event => {
    if (event.button !== 0 || gesture || sending || !connected) return;
    gesture = {stick, pointer:event.pointerId};
    stick.setPointerCapture(event.pointerId);
    stick.classList.add("held");
    track(event);
  });
  stick.addEventListener("pointermove", event => {
    if (gesture?.stick === stick && gesture.pointer === event.pointerId) track(event);
  });
  for (const type of ["pointerup","pointercancel","lostpointercapture"]) {
    stick.addEventListener(type, event => {
      if (gesture?.stick === stick && gesture.pointer === event.pointerId) releaseStick();
    });
  }
}
document.addEventListener("keydown", event => {
  if (event.altKey || event.metaKey || event.ctrlKey || document.querySelector("dialog[open]") ||
      event.target.closest("input,textarea,select,button")) return;
  if (event.key === " ") {
    event.preventDefault();
    if (!event.repeat) { if (gesture) releaseStick(); else sendCommand(0); }
    return;
  }
  const direction = {ArrowUp:[0,-1],ArrowDown:[0,1],ArrowLeft:[-1,0],ArrowRight:[1,0],
                     w:[0,-1],s:[0,1],a:[-1,0],d:[1,0]}[event.key];
  if (!direction || !connected || sending || gesture || event.repeat) return;
  const stick = event.target.id === "load" ? $("#load") : $("#drive");
  if (stick.id === "load" && !direction[1]) return;
  event.preventDefault();
  gesture = {stick,key:event.key};
  stick.classList.add("held");
  moveStick(...direction);
});
document.addEventListener("keyup", event => { if (gesture?.key === event.key) releaseStick(); });
document.addEventListener("visibilitychange", () => { if (document.hidden) releaseStick(); });
document.defaultView?.addEventListener("blur", releaseStick);
connect();

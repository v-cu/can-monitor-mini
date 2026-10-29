/*
 * install.js - "Instalacja / Install" tab: firmware from the browser
 * (Web Serial + esptool-js). Two modes:
 *
 *   update (default)  writes otadata + app + the databases. The settings
 *                     partition (NVS: screens, car profiles, settings, serial
 *                     number) is not touched. Before writing, the device is
 *                     read: the partition table must be the same as on the
 *                     site and the running app must be CAN Monitor mini.
 *                     otadata is written too: after a phone (OTA) update the
 *                     device may run from ota_1 and would ignore a new app in
 *                     ota_0 - a blank otadata boots ota_0.
 *   full              erases the whole flash, then writes everything.
 *
 * firmware/manifest.json: files, addresses, sizes, MD5, role of every file
 * (tools/export_web_firmware.py in the firmware project).
 *
 * Safe by design: only an ESP32-S3 with enough flash is accepted (checked
 * before anything is erased or written); eFuses are never touched; the ROM
 * bootloader cannot be overwritten, so an interrupted run is fixed by running
 * it again; every file is verified with MD5 after writing.
 */
(function () {
  "use strict";

  var ESPTOOL_URL = "https://unpkg.com/esptool-js@0.6.1/bundle.js";
  var MANIFEST = "firmware/manifest.json";
  var ESPRESSIF_VID = 0x303a;
  var PT_ADDR = 0x8000, PT_SIZE = 0xC00, OTADATA_ADDR = 0xF000;
  var APP_DESC_MAGIC = 0xABCD5432;
  var FULL_ONLY = { "bootloader": 1, "partition-table": 1 };   /* roles written only from scratch */

  var root = document.getElementById("page-install");
  if (!root) return;

  function t(pl, en) { return '<span lang="pl">' + pl + '</span><span lang="en">' + en + "</span>"; }
  function lang() { return document.documentElement.getAttribute("data-lang") === "en" ? "en" : "pl"; }
  function tx(pl, en) { return lang() === "en" ? en : pl; }
  function kb(n) { return n >= 1048576 ? (n / 1048576).toFixed(2).replace(".", lang() === "pl" ? "," : ".") + " MB" : Math.round(n / 1024) + " kB"; }
  function hex(n) { return "0x" + n.toString(16).toUpperCase(); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  var STAGES = {
    update: [["dl", "Pobranie plików", "Download files"], ["conn", "Połączenie", "Connect"], ["check", "Sprawdzenie urządzenia", "Check the device"],
             ["write", "Zapis i weryfikacja", "Write and verify"], ["boot", "Uruchomienie", "Restart"]],
    full:   [["dl", "Pobranie plików", "Download files"], ["conn", "Połączenie", "Connect"], ["erase", "Czyszczenie całej pamięci", "Erase the whole flash"],
             ["write", "Zapis i weryfikacja", "Write and verify"], ["boot", "Uruchomienie", "Restart"]],
  };

  var supported = "serial" in navigator;
  var mode = "update";

  root.innerHTML =
    '<section class="inst"><div class="wrap">' +
    '<div class="inst-grid">' +
    '<div class="inst-info">' +
    '<div class="label">' + t("Instalacja", "Installation") + "</div>" +
    "<h2>" + t("Firmware prosto z przeglądarki", "Firmware straight from the browser") + "</h2>" +
    '<p class="lead">' + t("Podłącz urządzenie kablem USB-C do komputera i wybierz, co chcesz zrobić. Nie trzeba niczego instalować.",
      "Connect the device to a computer with a USB-C cable and choose what to do. Nothing to install.") + "</p>" +
    '<div class="fw-badge" id="fwBadge">Firmware <b>…</b></div>' +
    '<div class="modes2">' +
    '<div><b>' + t("Aktualizacja", "Update") + "</b><span>" + t("Wgrywa nowy firmware i bazy parametrów. Ekrany, ustawienia, profile aut i numer seryjny zostają.",
      "Writes the new firmware and parameter databases. Screens, settings, car profiles and the serial number stay.") + "</span></div>" +
    '<div><b>' + t("Instalacja od zera", "Install from scratch") + "</b><span>" + t("Czyści całą pamięć i wgrywa wszystko od nowa. Dla nowej płytki albo gdy aktualizacja nie jest możliwa.",
      "Erases the whole memory and writes everything again. For a new board or when an update is not possible.") + "</span></div>" +
    "</div>" +
    "<h3>" + t("Co jest potrzebne", "What you need") + "</h3>" +
    '<ul class="checks">' +
    "<li><span>" + t("<b>Chrome, Edge lub Opera na komputerze</b> (Windows, macOS, Linux). Telefony, Firefox i Safari nie mają dostępu do portu USB ze strony.",
      "<b>Chrome, Edge or Opera on a computer</b> (Windows, macOS, Linux). Phones, Firefox and Safari cannot reach a USB port from a web page.") + "</span></li>" +
    "<li><span>" + t("<b>Kabel USB-C do transmisji danych</b>, nie tylko do ładowania.", "<b>A USB-C data cable</b>, not a charge-only one.") + "</span></li>" +
    "<li><span>" + t("<b>Urządzenie odłączone od auta.</b> Wystarczy zasilanie z USB.", "<b>The device unplugged from the car.</b> USB power is enough.") + "</span></li>" +
    "</ul>" +
    "<h3>" + t("Jak to przebiega", "How it goes") + "</h3>" +
    '<ol class="isteps">' +
    "<li>" + t("Podłącz urządzenie do komputera.", "Connect the device to the computer.") + "</li>" +
    "<li>" + t("Wybierz <b>Aktualizacja</b> albo <b>Instalacja od zera</b> i kliknij przycisk pod paskiem postępu.", "Choose <b>Update</b> or <b>Install from scratch</b> and click the button under the progress bar.") + "</li>" +
    "<li>" + t("Wybierz port <b>USB JTAG/serial debug unit</b> i kliknij <b>Połącz</b>.", "Pick the port <b>USB JTAG/serial debug unit</b> and click <b>Connect</b>.") + "</li>" +
    "<li>" + t("Poczekaj (aktualizacja ok. 1 min, instalacja od zera ok. 2 min) i nie odłączaj kabla.", "Wait (update about 1 min, install from scratch about 2 min) and keep the cable connected.") + "</li>" +
    "<li>" + t("Urządzenie uruchomi się samo z nowym firmware.", "The device restarts by itself with the new firmware.") + "</li>" +
    "</ol>" +
    '<div class="itip">' + t("<b>Bezpiecznie dla urządzenia.</b> Program startowy ESP32-S3 jest w pamięci ROM i nie da się go nadpisać. Jeśli zapis się przerwie, na przykład po odłączeniu kabla, podłącz urządzenie ponownie i powtórz.",
      "<b>Safe for the device.</b> The ESP32-S3 start-up program is in ROM and cannot be overwritten. If writing is interrupted, for example by unplugging the cable, connect the device again and repeat.") + "</div>" +
    "</div>" +

    '<div class="inst-card" id="instCard">' +
    '<div class="seg2" role="radiogroup">' +
    '<button type="button" data-m="update" aria-pressed="true">' + t("Aktualizacja", "Update") + "</button>" +
    '<button type="button" data-m="full" aria-pressed="false">' + t("Instalacja od zera", "From scratch") + "</button>" +
    "</div>" +
    '<ol class="rail" id="rail"></ol>' +
    '<div class="ibig"><b id="iPct">0%</b><span id="iMsg"></span></div>' +
    '<div class="ibar"><i id="iBar"></i></div>' +
    (supported ? "" : '<div class="inote" style="margin:0 0 16px">' + t("Otwórz tę stronę w <b>Chrome</b>, <b>Edge</b> lub <b>Operze</b> na komputerze.", "Open this page in <b>Chrome</b>, <b>Edge</b> or <b>Opera</b> on a computer.") + "</div>") +
    '<div class="inote" id="iWarn" hidden style="margin:0 0 14px">' + t("<b>Instalacja od zera usuwa wszystko z pamięci urządzenia:</b> ekrany, profile aut, ustawienia i numer seryjny.",
      "<b>Install from scratch erases everything in the device memory:</b> screens, car profiles, settings and the serial number.") + "</div>" +
    '<label class="ichk" id="iOkRow" hidden><input type="checkbox" id="iOk"><span>' +
    t("Rozumiem, że wszystkie dane urządzenia zostaną usunięte.", "I understand that all device data will be erased.") + "</span></label>" +
    '<button type="button" class="btn pri ibtn" id="iGo" disabled></button>' +
    '<label class="ichk small"><input type="checkbox" id="iAll"><span>' +
    t("Nie widzę urządzenia na liście – pokaż wszystkie porty", "I don't see the device – show all ports") + "</span></label>" +
    '<details class="ilog"><summary>' + t("Szczegóły (log)", "Details (log)") + '</summary><pre id="iLog"></pre></details>' +
    '<table class="ifiles" id="iFiles"></table>' +
    "</div>" +
    "</div>" +

    '<div class="inst-help">' +
    "<h3>" + t("Gdy coś nie działa", "If something goes wrong") + "</h3>" +
    '<table class="specs">' +
    "<tr><td>" + t("Nie ma portu na liście", "No port in the list") + "</td><td>" + t("Użyj innego kabla (do danych) albo innego gniazda USB w komputerze. Zaznacz <b>pokaż wszystkie porty</b>. W Windows urządzenie widać w Menedżerze urządzeń jako <i>USB JTAG/serial debug unit</i>.",
      "Try another (data) cable or another USB socket. Tick <b>show all ports</b>. On Windows the device shows in Device Manager as <i>USB JTAG/serial debug unit</i>.") + "</td></tr>" +
    "<tr><td>" + t("„Nie można otworzyć portu”", "“Cannot open the port”") + "</td><td>" + t("Port jest zajęty przez inny program (monitor portu, Arduino IDE, ESP-IDF). Zamknij go i spróbuj ponownie.",
      "Another program holds the port (serial monitor, Arduino IDE, ESP-IDF). Close it and try again.") + "</td></tr>" +
    "<tr><td>" + t("Brak połączenia z urządzeniem", "No connection to the device") + "</td><td>" + t("Odłącz kabel na kilka sekund, podłącz ponownie i spróbuj jeszcze raz.",
      "Unplug the cable for a few seconds, plug it back in and try again.") + "</td></tr>" +
    "<tr><td>" + t("„Aktualizacja niemożliwa”", "“Update not possible”") + "</td><td>" + t("Na urządzeniu nie ma firmware CAN Monitor mini albo zmienił się układ pamięci. Użyj <b>Instalacji od zera</b>.",
      "The device has no CAN Monitor mini firmware or the memory layout changed. Use <b>Install from scratch</b>.") + "</td></tr>" +
    "<tr><td>" + t("Przerwany zapis", "Interrupted writing") + "</td><td>" + t("Urządzenie może nie uruchomić się, ale nie jest uszkodzone. Powtórz aktualizację albo instalację od zera.",
      "The device may not start, but it is not damaged. Repeat the update or the install from scratch.") + "</td></tr>" +
    "</table></div>" +
    "</div></section>";

  var el = function (id) { return document.getElementById(id); };
  var iOk = el("iOk"), iGo = el("iGo"), iAll = el("iAll"), iLog = el("iLog"), iBar = el("iBar"), iPct = el("iPct"), iMsg = el("iMsg");
  var manifest = null, busy = false;

  /* ---------------- UI helpers ---------------- */
  function log(s, partial) { iLog.textContent += s + (partial ? "" : "\n"); iLog.scrollTop = iLog.scrollHeight; }
  function msg(pl, en) { iMsg.innerHTML = t(pl, en); }
  function pct(p) {
    p = Math.max(0, Math.min(100, p));
    iBar.style.width = p.toFixed(1) + "%";
    iPct.textContent = Math.floor(p) + "%";
  }
  function stage(id, state) { var li = root.querySelector('#rail li[data-s="' + id + '"]'); if (li) li.className = state || ""; }
  function setCardState(s) { el("instCard").setAttribute("data-state", s); }
  function partsFor(m) { return manifest ? manifest.parts.filter(function (p) { return m === "full" || !FULL_ONLY[p.role]; }) : []; }
  function canGo() { return supported && manifest && !busy && (mode === "update" || iOk.checked); }
  function refreshBtn() { iGo.disabled = !canGo(); }

  function drawRail() {
    el("rail").innerHTML = STAGES[mode].map(function (s, i) {
      return '<li data-s="' + s[0] + '"><i>' + (i + 1) + "</i><span>" + t(s[1], s[2]) + "</span></li>";
    }).join("");
  }

  function drawFiles() {
    if (!manifest) return;
    el("fwBadge").innerHTML = "Firmware <b>" + esc(manifest.version) + "</b> · " + esc(manifest.chip) + " · " + esc(manifest.flash_size) +
      (manifest.date ? ' · <span class="dim">' + esc(manifest.date) + "</span>" : "");
    var use = partsFor(mode);
    el("iFiles").innerHTML = "<tr><th>" + t("Plik", "File") + "</th><th>" + t("Adres", "Address") + "</th><th>" + t("Rozmiar", "Size") + "</th></tr>" +
      manifest.parts.map(function (p) {
        var on = use.indexOf(p) >= 0;
        return '<tr class="' + (on ? "" : "skip") + '"><td>' + esc(p.file) + "</td><td>" + hex(p.offset) + "</td><td>" + (p.size ? kb(p.size) : "") + "</td></tr>";
      }).join("");
  }

  function setMode(m) {
    if (busy) return;
    mode = m;
    root.querySelectorAll(".seg2 button").forEach(function (b) { b.setAttribute("aria-pressed", b.dataset.m === m ? "true" : "false"); });
    el("iWarn").hidden = m !== "full";
    el("iOkRow").hidden = m !== "full";
    iOk.checked = false;
    iGo.innerHTML = m === "full" ? t("Zainstaluj od zera", "Install from scratch") : t("Aktualizuj", "Update");
    drawRail(); drawFiles(); pct(0); setCardState("");
    if (supported) msg(m === "full" ? "Gotowe do instalacji od zera" : "Gotowe do aktualizacji", m === "full" ? "Ready to install from scratch" : "Ready to update");
    else msg("Ta przeglądarka nie obsługuje USB", "This browser has no USB support");
    refreshBtn();
  }
  root.querySelectorAll(".seg2 button").forEach(function (b) { b.addEventListener("click", function () { setMode(b.dataset.m); }); });
  iOk.addEventListener("change", refreshBtn);
  document.querySelectorAll(".lang button").forEach(function (b) { b.addEventListener("click", function () { setTimeout(drawFiles, 0); }); });
  setMode("update");

  fetch(MANIFEST, { cache: "no-store" }).then(function (r) {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }).then(function (m) {
    manifest = m; drawFiles(); refreshBtn();
  }).catch(function (e) {
    el("fwBadge").innerHTML = t("Brak plików firmware na serwerze", "No firmware files on the server");
    log("manifest: " + e);
  });

  /* ---------------- device helpers ---------------- */
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
  function cstr(b, o, n) { var s = ""; for (var i = 0; i < n && b[o + i]; i++) s += String.fromCharCode(b[o + i]); return s; }

  /* used length of a partition table image: entries up to and incl. the MD5 entry */
  function ptUsed(b) {
    for (var i = 0; i + 32 <= b.length; i += 32) {
      if (b[i] === 0xff && b[i + 1] === 0xff) return i;
    }
    return b.length;
  }
  /* app slots from a partition table: ota_0, ota_1 offsets */
  function otaSlots(b) {
    var s = [];
    for (var i = 0; i + 32 <= b.length; i += 32) {
      if (b[i] !== 0xaa || b[i + 1] !== 0x50) break;
      if (b[i + 2] === 0 && b[i + 3] >= 0x10 && b[i + 3] <= 0x1f) s[b[i + 3] - 0x10] = u32(b, i + 4);
    }
    return s;
  }

  /* What is on the device? -> {ok, reason, version} */
  async function probe(loader, ptSite) {
    var pt = await loader.readFlash(PT_ADDR, PT_SIZE);
    if (pt[0] === 0xff && pt[1] === 0xff) return { ok: false, reason: "empty" };
    var n = ptUsed(ptSite);
    for (var i = 0; i < n; i++) if (pt[i] !== ptSite[i]) return { ok: false, reason: "layout" };
    var slots = otaSlots(pt);
    /* otadata: two 32-byte entries, the higher valid sequence number wins; blank -> ota_0 */
    var od = await loader.readFlash(OTADATA_ADDR, 64), best = 0, slot = 0;
    [0, 32].forEach(function (o) { var seq = u32(od, o); if (seq !== 0xffffffff && seq > best) best = seq; });
    if (best) slot = (best - 1) % 2;
    var at = slots[slot] !== undefined ? slots[slot] : slots[0];
    var d = await loader.readFlash(at + 0x20, 0x50);                 /* esp_app_desc_t */
    if (u32(d, 0) !== APP_DESC_MAGIC) return { ok: false, reason: "noapp" };
    var proj = cstr(d, 48, 32), ver = cstr(d, 16, 32);
    log("device: " + proj + " " + ver + " (ota_" + slot + " @" + hex(at) + ")");
    if (manifest.project && proj !== manifest.project) return { ok: false, reason: "foreign", version: proj + " " + ver };
    return { ok: true, version: ver };
  }

  /* ---------------- run ---------------- */
  function warnLeave(e) { e.preventDefault(); e.returnValue = ""; }

  async function fetchParts(list, onProgress) {
    var out = [], done = 0, total = list.reduce(function (a, p) { return a + (p.size || 0); }, 0) || 1;
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      var r = await fetch("firmware/" + p.file, { cache: "no-store" });
      if (!r.ok) throw new Error(tx("Nie udało się pobrać ", "Could not download ") + p.file + " (HTTP " + r.status + ")");
      var data = new Uint8Array(await r.arrayBuffer());
      if (p.size && data.length !== p.size) throw new Error(p.file + ": " + tx("zły rozmiar pliku", "wrong file size"));
      if (p.md5 && md5(data) !== p.md5) throw new Error(p.file + ": " + tx("plik uszkodzony (MD5)", "file corrupted (MD5)"));
      out.push({ data: data, address: p.offset, name: p.file, role: p.role });
      done += data.length;
      onProgress(done / total);
    }
    return out;
  }

  function niceError(e) {
    var s = String(e && e.message || e);
    if (e && e.user) return s;
    if (/open/i.test(s) && /port/i.test(s)) return tx("Nie można otworzyć portu. Zamknij inne programy, które go używają, i spróbuj ponownie.", "Cannot open the port. Close other programs that use it and try again.");
    if (/Failed to connect|timeout|Timeout|sync/i.test(s)) return tx("Brak połączenia z urządzeniem. Odłącz kabel na kilka sekund, podłącz i spróbuj ponownie.", "No connection to the device. Unplug the cable for a few seconds, plug it back and try again.");
    if (/device has been lost|disconnected|NetworkError|break/i.test(s)) return tx("Połączenie zostało przerwane. Podłącz urządzenie i spróbuj ponownie.", "The connection was lost. Connect the device and try again.");
    return s;
  }
  function userError(pl, en) { var e = new Error(tx(pl, en)); e.user = true; return e; }

  async function run() {
    if (!canGo()) return;
    var port;
    try {
      port = await navigator.serial.requestPort(iAll.checked ? {} : { filters: [{ usbVendorId: ESPRESSIF_VID }] });
    } catch (e) {
      return;                                   /* the user closed the port picker */
    }
    var full = mode === "full";
    busy = true; refreshBtn(); iOk.disabled = true;
    root.querySelectorAll(".seg2 button").forEach(function (b) { b.disabled = true; });
    iLog.textContent = ""; drawRail(); pct(0); setCardState("run");
    log("mode: " + (full ? "full install" : "update") + ", firmware " + manifest.version);
    window.addEventListener("beforeunload", warnLeave);
    var transport = null, eraseTimer = null, cur = "dl";
    try {
      /* 1. files first: a download problem must not touch the device */
      stage("dl", "on"); msg("Pobieranie plików…", "Downloading files…");
      var need = partsFor(mode), ptPart = manifest.parts.filter(function (p) { return p.role === "partition-table"; })[0];
      if (!full && ptPart && need.indexOf(ptPart) < 0) need = need.concat([ptPart]);     /* for the comparison only */
      var files = await fetchParts(need, function (f) { pct(5 * f); });
      var ptSite = null;
      if (!full) {
        ptSite = files.filter(function (f) { return f.role === "partition-table"; })[0];
        files = files.filter(function (f) { return !FULL_ONLY[f.role]; });
        if (!ptSite) throw userError("Brak tablicy partycji na serwerze", "No partition table on the server");
        ptSite = ptSite.data;
      }
      log("write: " + files.map(function (f) { return f.name + " @" + hex(f.address); }).join(", "));
      stage("dl", "ok");

      /* 2. connect, check the chip and the flash */
      cur = "conn"; stage("conn", "on"); msg("Łączenie z urządzeniem…", "Connecting to the device…");
      var esptool = await import(ESPTOOL_URL);
      transport = new esptool.Transport(port, false);
      var loader = new esptool.ESPLoader({
        transport: transport, baudrate: 921600,
        terminal: { clean: function () {}, writeLine: function (d) { log(d); }, write: function (d) { log(d, true); } },
      });
      var chip = await loader.main();
      log("chip: " + chip);
      if (!/ESP32-S3/i.test(chip)) throw userError("To nie jest CAN Monitor mini (układ: " + chip + ")", "This is not a CAN Monitor mini (chip: " + chip + ")");
      var fsz = await loader.detectFlashSize();
      log("flash: " + fsz);
      if (!(parseInt(fsz, 10) >= parseInt(manifest.flash_size, 10)))
        throw userError("Za mała pamięć flash: " + fsz + " (potrzeba " + manifest.flash_size + ")", "Flash too small: " + fsz + " (need " + manifest.flash_size + ")");
      stage("conn", "ok"); pct(8);

      if (full) {
        /* 3a. full erase (~20-40 s, no progress from the chip: estimate) */
        cur = "erase"; stage("erase", "on"); msg("Czyszczenie całej pamięci… (do 1 min)", "Erasing the whole memory… (up to 1 min)");
        var t0 = Date.now();
        eraseTimer = setInterval(function () { var s = (Date.now() - t0) / 1000; pct(8 + 22 * (1 - Math.exp(-s / 15))); }, 250);
        await loader.eraseFlash();
        clearInterval(eraseTimer); eraseTimer = null;
        log("erase: " + ((Date.now() - t0) / 1000).toFixed(1) + " s");
        stage("erase", "ok");
      } else {
        /* 3b. is this a CAN Monitor mini with the same memory layout? */
        cur = "check"; stage("check", "on"); msg("Sprawdzanie urządzenia…", "Checking the device…");
        var st = await probe(loader, ptSite);
        if (!st.ok) {
          var why = {
            empty:   ["Urządzenie jest puste.", "The device is empty."],
            noapp:   ["Na urządzeniu nie ma działającego firmware.", "There is no working firmware on the device."],
            foreign: ["Na urządzeniu jest inny firmware (" + st.version + ").", "The device runs other firmware (" + st.version + ")."],
            layout:  ["Nowy firmware ma inny układ pamięci.", "The new firmware has a different memory layout."],
          }[st.reason];
          throw userError("Aktualizacja niemożliwa. " + why[0] + " Użyj „Instalacji od zera”.", "Update not possible. " + why[1] + " Use “Install from scratch”.");
        }
        stage("check", "ok");
        msg("Na urządzeniu: " + st.version + " → " + manifest.version, "On the device: " + st.version + " → " + manifest.version);
      }
      pct(30);

      /* 4. write + MD5 check of every file (only the sectors of each file are erased) */
      cur = "write"; stage("write", "on");
      var sizes = files.map(function (f) { return f.data.length; }), all = sizes.reduce(function (a, b) { return a + b; }, 0);
      var before = function (i) { var s = 0; for (var k = 0; k < i; k++) s += sizes[k]; return s; };
      await loader.writeFlash({
        fileArray: files.map(function (f) { return { data: f.data, address: f.address }; }),
        flashSize: "keep", flashMode: "keep", flashFreq: "keep",
        eraseAll: false, compress: true,
        reportProgress: function (i, written, total) {
          var f = total ? written / total : 0;
          pct(30 + 68 * (before(i) + f * sizes[i]) / all);
          iMsg.innerHTML = t("Zapis ", "Writing ") + "<b>" + esc(files[i].name) + "</b> (" + (i + 1) + "/" + files.length + ")";
        },
        calculateMD5Hash: md5,
      });
      stage("write", "ok"); pct(98);

      /* 5. restart into the new firmware */
      cur = "boot"; stage("boot", "on"); msg("Uruchamianie urządzenia…", "Restarting the device…");
      await loader.after("hard_reset");
      try { await transport.disconnect(); } catch (e) {}
      transport = null;
      stage("boot", "ok"); pct(100); setCardState("ok");
      if (full) msg("Gotowe. Urządzenie uruchamia się z firmware " + manifest.version + " i za chwilę pokaże kod QR.",
                    "Done. The device starts firmware " + manifest.version + " and shows the QR code in a moment.");
      else msg("Gotowe. Urządzenie uruchamia się z firmware " + manifest.version + ". Ustawienia zostały zachowane.",
               "Done. The device starts firmware " + manifest.version + ". The settings were kept.");
    } catch (e) {
      if (eraseTimer) clearInterval(eraseTimer);
      log("ERROR: " + (e && e.stack || e));
      stage(cur, "err"); setCardState("err");
      iMsg.textContent = niceError(e);
      if (transport) { try { await transport.disconnect(); } catch (x) {} }
    } finally {
      busy = false; iOk.disabled = false;
      root.querySelectorAll(".seg2 button").forEach(function (b) { b.disabled = false; });
      refreshBtn();
      window.removeEventListener("beforeunload", warnLeave);
    }
  }
  iGo.addEventListener("click", run);

  /* ---------------- MD5 (verification of the files and of the written data) ---------------- */
  function md5(bytes) {
    var K = new Uint32Array(64), S = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,
      4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
    for (var i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
    var n = bytes.length, total = ((n + 8) >>> 6) + 1, buf = new Uint8Array(total * 64);
    buf.set(bytes); buf[n] = 0x80;
    var bits = n * 8, dv = new DataView(buf.buffer);
    dv.setUint32(total * 64 - 8, bits >>> 0, true);
    dv.setUint32(total * 64 - 4, Math.floor(bits / 4294967296), true);
    var a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476, M = new Uint32Array(16);
    for (var off = 0; off < buf.length; off += 64) {
      for (var j = 0; j < 16; j++) M[j] = dv.getUint32(off + j * 4, true);
      var A = a0, B = b0, C = c0, D = d0;
      for (var k = 0; k < 64; k++) {
        var F, g;
        if (k < 16) { F = (B & C) | (~B & D); g = k; }
        else if (k < 32) { F = (D & B) | (~D & C); g = (5 * k + 1) & 15; }
        else if (k < 48) { F = B ^ C ^ D; g = (3 * k + 5) & 15; }
        else { F = C ^ (B | ~D); g = (7 * k) & 15; }
        F = (F + A + K[k] + M[g]) >>> 0;
        A = D; D = C; C = B;
        B = (B + ((F << S[k]) | (F >>> (32 - S[k])))) >>> 0;
      }
      a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
    }
    var out = "", w = [a0, b0, c0, d0];
    for (var q = 0; q < 4; q++) for (var r = 0; r < 4; r++) out += ("0" + ((w[q] >>> (8 * r)) & 255).toString(16)).slice(-2);
    return out;
  }
})();

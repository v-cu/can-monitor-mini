/*
 * install.js - "Instalacja / Install" tab: flashes the whole firmware from the
 * browser (Web Serial + esptool-js), after a full erase of the flash.
 *
 * firmware/manifest.json lists the files and their flash addresses
 * (made by tools/export_web_firmware.py in the firmware project).
 *
 * Safe by design:
 *  - only an ESP32-S3 with 16 MB flash is accepted (checked BEFORE erasing),
 *  - eFuses are never touched; the ROM bootloader cannot be overwritten, so an
 *    interrupted install is fixed by running it again,
 *  - every file is verified with MD5 after writing.
 */
(function () {
  "use strict";

  var ESPTOOL_URL = "https://unpkg.com/esptool-js@0.6.1/bundle.js";
  var MANIFEST = "firmware/manifest.json";
  var ESPRESSIF_VID = 0x303a;

  var root = document.getElementById("page-install");
  if (!root) return;

  function t(pl, en) { return '<span lang="pl">' + pl + '</span><span lang="en">' + en + "</span>"; }
  function lang() { return document.documentElement.getAttribute("data-lang") === "en" ? "en" : "pl"; }
  function tx(pl, en) { return lang() === "en" ? en : pl; }
  function kb(n) { return n >= 1048576 ? (n / 1048576).toFixed(2).replace(".", lang() === "pl" ? "," : ".") + " MB" : Math.round(n / 1024) + " kB"; }
  function hex(n) { return "0x" + n.toString(16).toUpperCase(); }

  var STAGES = [
    ["dl", "Pobranie plików", "Download files"],
    ["conn", "Połączenie", "Connect"],
    ["erase", "Czyszczenie pamięci", "Erase flash"],
    ["write", "Zapis i weryfikacja", "Write and verify"],
    ["boot", "Uruchomienie", "Restart"],
  ];

  var supported = "serial" in navigator;

  root.innerHTML =
    '<section class="inst"><div class="wrap">' +
    '<div class="inst-grid">' +
    '<div class="inst-info">' +
    '<div class="label">' + t("Instalacja", "Installation") + "</div>" +
    "<h2>" + t("Wgraj firmware prosto z przeglądarki", "Install the firmware straight from the browser") + "</h2>" +
    '<p class="lead">' + t("Podłącz urządzenie kablem USB-C do komputera i kliknij <b>Zainstaluj</b>. Strona wyczyści całą pamięć urządzenia i wgra aktualny firmware razem z bazami parametrów i opisów błędów. Nie trzeba niczego instalować.",
      "Connect the device to a computer with a USB-C cable and click <b>Install</b>. The page erases the whole device memory and writes the current firmware together with the parameter and fault-code databases. Nothing to install.") + "</p>" +
    '<div class="fw-badge" id="fwBadge">Firmware <b>…</b></div>' +
    "<h3>" + t("Co jest potrzebne", "What you need") + "</h3>" +
    '<ul class="checks">' +
    "<li><span>" + t("<b>Chrome, Edge lub Opera na komputerze</b> (Windows, macOS, Linux). Telefony, Firefox i Safari nie mają dostępu do portu USB ze strony.",
      "<b>Chrome, Edge or Opera on a computer</b> (Windows, macOS, Linux). Phones, Firefox and Safari cannot reach a USB port from a web page.") + "</span></li>" +
    "<li><span>" + t("<b>Kabel USB-C do transmisji danych</b>, nie tylko do ładowania.", "<b>A USB-C data cable</b>, not a charge-only one.") + "</span></li>" +
    "<li><span>" + t("<b>Urządzenie odłączone od auta.</b> Do instalacji wystarczy zasilanie z USB.", "<b>The device unplugged from the car.</b> USB power is enough for the install.") + "</span></li>" +
    "</ul>" +
    "<h3>" + t("Jak to przebiega", "How it goes") + "</h3>" +
    '<ol class="isteps">' +
    "<li>" + t("Podłącz urządzenie do komputera.", "Connect the device to the computer.") + "</li>" +
    "<li>" + t("Zaznacz potwierdzenie i kliknij <b>Zainstaluj</b>.", "Tick the confirmation and click <b>Install</b>.") + "</li>" +
    "<li>" + t("Wybierz port <b>USB JTAG/serial debug unit</b> i kliknij <b>Połącz</b>.", "Pick the port <b>USB JTAG/serial debug unit</b> and click <b>Connect</b>.") + "</li>" +
    "<li>" + t("Poczekaj ok. 2 minut i nie odłączaj kabla.", "Wait about 2 minutes and keep the cable connected.") + "</li>" +
    "<li>" + t("Urządzenie uruchomi się samo i pokaże kod QR do połączenia z telefonem.", "The device restarts by itself and shows the QR code for the phone.") + "</li>" +
    "</ol>" +
    '<div class="inote">' + t("<b>Instalacja usuwa wszystko z pamięci urządzenia:</b> ekrany, profile aut i ustawienia. Po instalacji urządzenie startuje jak nowe.",
      "<b>The install erases everything in the device memory:</b> screens, car profiles and settings. Afterwards the device starts like a new one.") + "</div>" +
    '<div class="itip">' + t("<b>Bezpiecznie dla urządzenia.</b> Program startowy ESP32-S3 jest w pamięci ROM i nie da się go nadpisać. Jeśli instalacja się przerwie, na przykład po odłączeniu kabla, podłącz urządzenie ponownie i zainstaluj jeszcze raz.",
      "<b>Safe for the device.</b> The ESP32-S3 start-up program is in ROM and cannot be overwritten. If the install is interrupted, for example by unplugging the cable, connect the device again and repeat the install.") + "</div>" +
    "</div>" +

    '<div class="inst-card" id="instCard">' +
    '<ol class="rail" id="rail">' + STAGES.map(function (s, i) {
      return '<li data-s="' + s[0] + '"><i>' + (i + 1) + "</i><span>" + t(s[1], s[2]) + "</span></li>";
    }).join("") + "</ol>" +
    '<div class="ibig"><b id="iPct">0%</b><span id="iMsg">' + (supported ? t("Gotowe do instalacji", "Ready to install") : t("Ta przeglądarka nie obsługuje USB", "This browser has no USB support")) + "</span></div>" +
    '<div class="ibar"><i id="iBar"></i></div>' +
    (supported ? "" : '<div class="inote" style="margin-top:16px">' + t("Otwórz tę stronę w <b>Chrome</b>, <b>Edge</b> lub <b>Operze</b> na komputerze.", "Open this page in <b>Chrome</b>, <b>Edge</b> or <b>Opera</b> on a computer.") + "</div>") +
    '<label class="ichk"><input type="checkbox" id="iOk"' + (supported ? "" : " disabled") + "><span>" +
    t("Rozumiem, że wszystkie ustawienia urządzenia zostaną usunięte.", "I understand that all device settings will be erased.") + "</span></label>" +
    '<button type="button" class="btn pri ibtn" id="iGo" disabled>' + t("Zainstaluj", "Install") + "</button>" +
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
    "<tr><td>" + t("Brak połączenia z urządzeniem", "No connection to the device") + "</td><td>" + t("Odłącz kabel na kilka sekund, podłącz ponownie i kliknij <b>Zainstaluj</b> jeszcze raz.",
      "Unplug the cable for a few seconds, plug it back in and click <b>Install</b> again.") + "</td></tr>" +
    "<tr><td>" + t("Przerwana instalacja", "Interrupted install") + "</td><td>" + t("Urządzenie może nie uruchomić się, ale nie jest uszkodzone. Powtórz instalację.",
      "The device may not start, but it is not damaged. Run the install again.") + "</td></tr>" +
    "</table></div>" +
    "</div></section>";

  var el = function (id) { return document.getElementById(id); };
  var iOk = el("iOk"), iGo = el("iGo"), iAll = el("iAll"), iLog = el("iLog"), iBar = el("iBar"), iPct = el("iPct"), iMsg = el("iMsg");
  var manifest = null, busy = false;

  /* ---------------- UI helpers ---------------- */
  function log(s, partial) {
    iLog.textContent += s + (partial ? "" : "\n");
    iLog.scrollTop = iLog.scrollHeight;
  }
  function msg(pl, en) { iMsg.innerHTML = t(pl, en); }
  var pctNow = 0;
  function pct(p) {
    pctNow = Math.max(0, Math.min(100, p));
    iBar.style.width = pctNow.toFixed(1) + "%";
    iPct.textContent = Math.floor(pctNow) + "%";
  }
  function stage(id, state) {
    var li = root.querySelector('#rail li[data-s="' + id + '"]');
    if (li) li.className = state || "";
  }
  function resetRail() { STAGES.forEach(function (s) { stage(s[0], ""); }); }
  function setCardState(s) { el("instCard").setAttribute("data-state", s); }

  iOk.addEventListener("change", function () { iGo.disabled = !iOk.checked || busy || !manifest; });

  /* ---------------- manifest ---------------- */
  function showFiles() {
    if (!manifest) return;
    el("fwBadge").innerHTML = "Firmware <b>" + manifest.version + "</b> · " + manifest.chip + " · " + manifest.flash_size +
      (manifest.date ? ' · <span class="dim">' + manifest.date + "</span>" : "");
    var total = 0;
    el("iFiles").innerHTML = "<tr><th>" + t("Plik", "File") + "</th><th>" + t("Adres", "Address") + "</th><th>" + t("Rozmiar", "Size") + "</th></tr>" +
      manifest.parts.map(function (p) { total += p.size || 0; return "<tr><td>" + p.file + "</td><td>" + hex(p.offset) + "</td><td>" + (p.size ? kb(p.size) : "") + "</td></tr>"; }).join("");
  }
  fetch(MANIFEST, { cache: "no-store" }).then(function (r) {
    if (!r.ok) throw new Error(r.status);
    return r.json();
  }).then(function (m) {
    manifest = m;
    showFiles();
    iGo.disabled = !iOk.checked || !supported;
  }).catch(function (e) {
    el("fwBadge").innerHTML = t("Brak plików firmware na serwerze", "No firmware files on the server");
    log("manifest: " + e);
  });
  document.querySelectorAll(".lang button").forEach(function (b) { b.addEventListener("click", function () { setTimeout(showFiles, 0); }); });

  /* ---------------- install ---------------- */
  function warnLeave(e) { e.preventDefault(); e.returnValue = ""; }

  async function fetchParts(onProgress) {
    var out = [], done = 0, total = manifest.parts.reduce(function (a, p) { return a + (p.size || 0); }, 0) || 1;
    for (var i = 0; i < manifest.parts.length; i++) {
      var p = manifest.parts[i];
      var r = await fetch("firmware/" + p.file, { cache: "no-store" });
      if (!r.ok) throw new Error(tx("Nie udało się pobrać ", "Could not download ") + p.file + " (HTTP " + r.status + ")");
      var data = new Uint8Array(await r.arrayBuffer());
      if (p.size && data.length !== p.size) throw new Error(p.file + ": " + tx("zły rozmiar pliku", "wrong file size"));
      if (p.md5 && md5(data) !== p.md5) throw new Error(p.file + ": " + tx("plik uszkodzony (MD5)", "file corrupted (MD5)"));
      out.push({ data: data, address: p.offset, name: p.file });
      done += data.length;
      onProgress(done / total);
    }
    return out;
  }

  function niceError(e) {
    var s = String(e && e.message || e);
    if (/open/i.test(s) && /port/i.test(s)) return tx("Nie można otworzyć portu. Zamknij inne programy, które go używają, i spróbuj ponownie.", "Cannot open the port. Close other programs that use it and try again.");
    if (/Failed to connect|timeout|Timeout|sync/i.test(s)) return tx("Brak połączenia z urządzeniem. Odłącz kabel na kilka sekund, podłącz i spróbuj ponownie.", "No connection to the device. Unplug the cable for a few seconds, plug it back and try again.");
    if (/device has been lost|disconnected|NetworkError|break/i.test(s)) return tx("Połączenie zostało przerwane. Podłącz urządzenie i zainstaluj ponownie.", "The connection was lost. Connect the device and install again.");
    return s;
  }

  async function install() {
    if (busy || !manifest) return;
    var port;
    try {
      port = await navigator.serial.requestPort(iAll.checked ? {} : { filters: [{ usbVendorId: ESPRESSIF_VID }] });
    } catch (e) {
      return;                                   /* the user closed the port picker */
    }
    busy = true; iGo.disabled = true; iOk.disabled = true;
    iLog.textContent = ""; resetRail(); pct(0); setCardState("run");
    window.addEventListener("beforeunload", warnLeave);
    var transport = null, loader = null, eraseTimer = null, cur = "dl";
    try {
      /* 1. files first: a download problem must not leave an erased device */
      stage("dl", "on"); msg("Pobieranie plików…", "Downloading files…");
      var files = await fetchParts(function (f) { pct(5 * f); });
      log("files: " + files.map(function (f) { return f.name + " @" + hex(f.address) + " " + f.data.length + " B"; }).join(", "));
      stage("dl", "ok");

      /* 2. connect, check the chip and the flash */
      cur = "conn"; stage("conn", "on"); msg("Łączenie z urządzeniem…", "Connecting to the device…");
      var esptool = await import(ESPTOOL_URL);
      transport = new esptool.Transport(port, false);
      loader = new esptool.ESPLoader({
        transport: transport, baudrate: 921600,
        terminal: { clean: function () {}, writeLine: function (d) { log(d); }, write: function (d) { log(d, true); } },
      });
      var chip = await loader.main();
      log("chip: " + chip);
      if (!/ESP32-S3/i.test(chip)) throw new Error(tx("To nie jest CAN Monitor mini (układ: ", "This is not a CAN Monitor mini (chip: ") + chip + ")");
      var fsz = await loader.detectFlashSize();
      log("flash: " + fsz);
      var need = parseInt(manifest.flash_size, 10), have = parseInt(fsz, 10);
      if (!(have >= need)) throw new Error(tx("Za mała pamięć flash: ", "Flash too small: ") + fsz + " (" + tx("potrzeba ", "need ") + manifest.flash_size + ")");
      stage("conn", "ok"); pct(8);

      /* 3. full erase (~20-40 s, no progress from the chip: estimate) */
      cur = "erase"; stage("erase", "on"); msg("Czyszczenie całej pamięci… (do 1 min)", "Erasing the whole memory… (up to 1 min)");
      var t0 = Date.now();
      eraseTimer = setInterval(function () { var s = (Date.now() - t0) / 1000; pct(8 + 22 * (1 - Math.exp(-s / 15))); }, 250);
      await loader.eraseFlash();
      clearInterval(eraseTimer); eraseTimer = null;
      log("erase: " + ((Date.now() - t0) / 1000).toFixed(1) + " s");
      stage("erase", "ok"); pct(30);

      /* 4. write + MD5 check of every file */
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
          iMsg.innerHTML = t("Zapis ", "Writing ") + "<b>" + files[i].name + "</b> (" + (i + 1) + "/" + files.length + ")";
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
      msg("Gotowe. Urządzenie uruchamia się z firmware " + manifest.version + " i za chwilę pokaże kod QR.",
          "Done. The device starts firmware " + manifest.version + " and shows the QR code in a moment.");
    } catch (e) {
      if (eraseTimer) clearInterval(eraseTimer);
      log("ERROR: " + (e && e.stack || e));
      stage(cur, "err"); setCardState("err");
      var nice = niceError(e);
      iMsg.textContent = nice;
      if (transport) { try { await transport.disconnect(); } catch (x) {} }
    } finally {
      busy = false; iOk.disabled = false; iGo.disabled = !iOk.checked;
      window.removeEventListener("beforeunload", warnLeave);
    }
  }
  iGo.addEventListener("click", install);

  /* ---------------- MD5 (verification of the written data) ---------------- */
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

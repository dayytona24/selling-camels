/* ==========================================================================
   HQ Encounters — admin console logic.
   Talks to the session-authed JSON API (/admin/api/*). Every mutation carries
   the CSRF token (from the hq_admin_csrf cookie) in an X-CSRF-Token header.
   ========================================================================== */
(function () {
  "use strict";

  // ---- helpers -----------------------------------------------------------
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function esc(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function getCookie(name) {
    var m = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : "";
  }

  var toastEl = $("#toast");
  var toastTimer = null;
  function toast(msg, isError) {
    toastEl.textContent = msg;
    toastEl.className = "toast show" + (isError ? " toast--error" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.className = "toast"; }, 3200);
  }

  // Wrapper: sends the CSRF header, and detects a session-expiry redirect
  // (requireAdminSession redirects to /admin/login, which fetch follows).
  async function api(method, url, body) {
    var opts = { method: method, headers: {} };
    if (method !== "GET") opts.headers["X-CSRF-Token"] = getCookie("hq_admin_csrf");
    if (body) opts.body = body; // FormData; browser sets multipart headers
    var res = await fetch(url, opts);
    if (res.redirected && /\/admin\/login/.test(res.url)) {
      toast("Session expired — reloading…", true);
      setTimeout(function () { location.href = "/admin/login"; }, 900);
      throw new Error("session-expired");
    }
    var data = null;
    try { data = await res.json(); } catch (e) { /* non-JSON */ }
    if (!res.ok) {
      var msg = (data && data.error) || ("Request failed (" + res.status + ")");
      throw new Error(msg);
    }
    return data;
  }

  // ---- tabs --------------------------------------------------------------
  function selectTab(which) {
    var isListings = which === "listings";
    $("#tab-listings").setAttribute("aria-selected", String(isListings));
    $("#tab-gallery").setAttribute("aria-selected", String(!isListings));
    $("#panel-listings").hidden = !isListings;
    $("#panel-gallery").hidden = isListings;
  }
  $("#tab-listings").addEventListener("click", function () { selectTab("listings"); });
  $("#tab-gallery").addEventListener("click", function () { selectTab("gallery"); });

  // ======================================================================
  //  LISTINGS
  // ======================================================================
  var listingsGrid = $("#listings-grid");

  function meta(camel) {
    var bits = [camel.breed, cap(camel.sex)];
    if (camel.ageYears != null) bits.push(camel.ageYears + (camel.ageYears === 1 ? " yr" : " yrs"));
    if (camel.paintColor) bits.push(camel.paintColor);
    return bits.join(" · ");
  }
  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ""; }

  function listingCard(camel) {
    var img = camel.mainImage
      ? '<img src="' + esc(camel.mainImage) + '" alt="' + esc(camel.name) + '" />'
      : '<span aria-hidden="true">HQ</span>';
    var el = document.createElement("article");
    el.className = "admin-card";
    el.innerHTML =
      '<div class="admin-card__media' + (camel.mainImage ? "" : " admin-card__media--empty") + '">' +
        img +
      "</div>" +
      '<div class="admin-card__body">' +
        '<h3 class="admin-card__name">' + esc(camel.name) + "</h3>" +
        '<div class="admin-card__meta">' + esc(meta(camel)) + "</div>" +
        '<div class="admin-card__actions">' +
          '<button class="btn btn--quiet btn--sm" data-edit type="button">Edit</button>' +
          '<button class="btn btn--danger btn--sm" data-delete type="button">Delete</button>' +
        "</div>" +
      "</div>";
    el.querySelector("[data-edit]").addEventListener("click", function () { openModal(camel); });
    el.querySelector("[data-delete]").addEventListener("click", function () { deleteCamel(camel, el); });
    return el;
  }

  async function loadListings() {
    try {
      var camels = await api("GET", "/admin/api/camels");
      listingsGrid.innerHTML = "";
      if (!camels.length) {
        listingsGrid.innerHTML = '<div class="state">No camels yet. Click “Add Camel” to create your first listing.</div>';
        return;
      }
      camels.forEach(function (c) { listingsGrid.appendChild(listingCard(c)); });
    } catch (err) {
      if (err.message === "session-expired") return;
      listingsGrid.innerHTML = '<div class="state">Could not load listings: ' + esc(err.message) + "</div>";
    }
  }

  async function deleteCamel(camel, el) {
    if (!confirm('Delete "' + camel.name + '"? This removes the listing and its photos.')) return;
    el.classList.add("busy");
    try {
      await api("DELETE", "/admin/api/camels/" + encodeURIComponent(camel.id));
      el.remove();
      toast("Listing deleted.");
      if (!listingsGrid.querySelector(".admin-card")) loadListings();
    } catch (err) {
      el.classList.remove("busy");
      if (err.message !== "session-expired") toast(err.message, true);
    }
  }

  // ---- modal (add / edit) -----------------------------------------------
  var backdrop = $("#modal-backdrop");
  var form = $("#camel-form");
  var modalError = $("#modal-error");
  var thumbPreview = $("#thumb-preview");
  var additionalPreview = $("#additional-preview");
  var editingId = null;
  // Existing additional-image URLs kept across an edit (minus any the user removed).
  var keptAdditional = [];

  function setModalError(msg) {
    modalError.hidden = !msg;
    modalError.textContent = msg || "";
  }

  function openModal(camel) {
    editingId = camel ? camel.id : null;
    keptAdditional = camel && camel.additionalImages ? camel.additionalImages.slice() : [];
    $("#modal-title").textContent = camel ? "Edit Camel" : "Add Camel";
    $("#modal-save").textContent = camel ? "Save changes" : "Create camel";
    setModalError("");
    form.reset();
    thumbPreview.innerHTML = "";
    additionalPreview.innerHTML = "";

    if (camel) {
      $("#f-name").value = camel.name || "";
      $("#f-age").value = camel.ageYears != null ? camel.ageYears : "";
      $("#f-sex").value = camel.sex || "male";
      $("#f-paint").value = camel.paintColor || "Paint";
      $("#f-breed").value = camel.breed || "Dromedary";
      $("#f-short").value = camel.shortDescription || "";
      $("#f-long").value = camel.longDescription || "";
      // Thumbnail is optional on edit (keep existing unless a new one is chosen).
      $("#f-mainImage").required = false;
      if (camel.mainImage) {
        thumbPreview.innerHTML = '<img src="' + esc(camel.mainImage) + '" alt="Current thumbnail" />';
      }
      renderKeptAdditional();
    } else {
      $("#f-mainImage").required = true;
    }

    backdrop.classList.add("open");
    document.body.style.overflow = "hidden";
    setTimeout(function () { $("#f-name").focus(); }, 50);
  }

  function closeModal() {
    backdrop.classList.remove("open");
    document.body.style.overflow = "";
    editingId = null;
  }

  // Existing photos kept on edit, each removable.
  function renderKeptAdditional() {
    var existing = additionalPreview.querySelectorAll("[data-kept]");
    existing.forEach(function (n) { n.remove(); });
    keptAdditional.forEach(function (url, i) {
      var item = document.createElement("div");
      item.className = "additional-preview__item";
      item.setAttribute("data-kept", "");
      item.innerHTML = '<img src="' + esc(url) + '" alt="Existing photo" />' +
        '<button type="button" aria-label="Remove photo" title="Remove">&times;</button>';
      item.querySelector("button").addEventListener("click", function () {
        keptAdditional.splice(i, 1);
        renderKeptAdditional();
      });
      additionalPreview.insertBefore(item, additionalPreview.firstChild);
    });
  }

  // Thumbnail preview from a freshly chosen file.
  $("#f-mainImage").addEventListener("change", function (e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    thumbPreview.innerHTML = '<img alt="Selected thumbnail" />';
    thumbPreview.firstChild.src = URL.createObjectURL(file);
  });

  // Newly-chosen additional files preview (kept separate from existing ones).
  $("#f-additional").addEventListener("change", function () {
    var news = additionalPreview.querySelectorAll("[data-new]");
    news.forEach(function (n) { n.remove(); });
    var files = Array.prototype.slice.call(this.files || []);
    files.forEach(function (file) {
      var item = document.createElement("div");
      item.className = "additional-preview__item";
      item.setAttribute("data-new", "");
      item.innerHTML = '<img alt="New photo" />';
      item.firstChild.src = URL.createObjectURL(file);
      additionalPreview.appendChild(item);
    });
  });

  $("#add-camel-btn").addEventListener("click", function () { openModal(null); });
  $("#modal-close").addEventListener("click", closeModal);
  $("#modal-cancel").addEventListener("click", closeModal);
  backdrop.addEventListener("click", function (e) { if (e.target === backdrop) closeModal(); });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && backdrop.classList.contains("open")) closeModal();
  });

  form.addEventListener("submit", async function (e) {
    e.preventDefault();
    setModalError("");

    var mainFile = $("#f-mainImage").files[0];
    if (!editingId && !mainFile) { setModalError("A thumbnail photo is required."); return; }

    var fd = new FormData();
    fd.append("name", $("#f-name").value.trim());
    fd.append("ageYears", $("#f-age").value);
    fd.append("sex", $("#f-sex").value);
    fd.append("paintColor", $("#f-paint").value);
    fd.append("breed", $("#f-breed").value);
    fd.append("shortDescription", $("#f-short").value.trim());
    fd.append("longDescription", $("#f-long").value.trim());
    if (mainFile) fd.append("mainImage", mainFile);

    // Additional images: send kept existing URLs (as strings) first so the
    // server preserves them, then append newly-chosen files.
    keptAdditional.forEach(function (url) { fd.append("additionalImages", url); });
    var newFiles = Array.prototype.slice.call($("#f-additional").files || []);
    newFiles.forEach(function (f) { fd.append("additionalImages", f); });
    // On edit, always send the field (even if empty) so removals take effect.
    if (editingId && keptAdditional.length === 0 && newFiles.length === 0) {
      fd.append("additionalImages", "[]");
    }

    var saveBtn = $("#modal-save");
    saveBtn.classList.add("busy");
    saveBtn.textContent = "Saving…";
    try {
      if (editingId) {
        await api("PUT", "/admin/api/camels/" + encodeURIComponent(editingId), fd);
        toast("Listing updated.");
      } else {
        await api("POST", "/admin/api/camels", fd);
        toast("Listing created.");
      }
      closeModal();
      loadListings();
    } catch (err) {
      if (err.message !== "session-expired") setModalError(err.message);
    } finally {
      saveBtn.classList.remove("busy");
      saveBtn.textContent = editingId ? "Save changes" : "Create camel";
    }
  });

  // ======================================================================
  //  GALLERY
  // ======================================================================
  var galleryGrid = $("#gallery-grid");
  var galleryForm = $("#gallery-form");

  function galleryTile(photo) {
    var el = document.createElement("figure");
    el.className = "gallery-tile";
    el.style.margin = "0";
    el.innerHTML =
      '<img src="' + esc(photo.photoUrl) + '" alt="' + esc(photo.caption || "Gallery photo") + '" />' +
      (photo.caption ? '<figcaption class="gallery-tile__cap">' + esc(photo.caption) + "</figcaption>" : "") +
      '<button class="gallery-tile__del" type="button" aria-label="Delete photo" title="Delete">&times;</button>';
    el.querySelector(".gallery-tile__del").addEventListener("click", function () { deletePhoto(photo, el); });
    return el;
  }

  async function loadGallery() {
    try {
      var photos = await api("GET", "/admin/api/gallery");
      galleryGrid.innerHTML = "";
      if (!photos.length) {
        galleryGrid.innerHTML = '<div class="state">No gallery photos yet. Upload some above.</div>';
        return;
      }
      photos.forEach(function (p) { galleryGrid.appendChild(galleryTile(p)); });
    } catch (err) {
      if (err.message === "session-expired") return;
      galleryGrid.innerHTML = '<div class="state">Could not load gallery: ' + esc(err.message) + "</div>";
    }
  }

  async function deletePhoto(photo, el) {
    if (!confirm("Delete this photo from the gallery?")) return;
    el.classList.add("busy");
    try {
      await api("DELETE", "/admin/api/gallery/" + encodeURIComponent(photo.id));
      el.remove();
      toast("Photo removed.");
      if (!galleryGrid.querySelector(".gallery-tile")) loadGallery();
    } catch (err) {
      el.classList.remove("busy");
      if (err.message !== "session-expired") toast(err.message, true);
    }
  }

  galleryForm.addEventListener("submit", async function (e) {
    e.preventDefault();
    var input = $("#gallery-files");
    var files = Array.prototype.slice.call(input.files || []);
    if (!files.length) { toast("Select at least one photo.", true); return; }

    var fd = new FormData();
    files.forEach(function (f) { fd.append("photos", f); });

    var btn = $("#gallery-upload-btn");
    btn.classList.add("busy");
    btn.textContent = "Uploading…";
    try {
      await api("POST", "/admin/api/gallery", fd);
      toast(files.length === 1 ? "Photo uploaded." : files.length + " photos uploaded.");
      galleryForm.reset();
      loadGallery();
    } catch (err) {
      if (err.message !== "session-expired") toast(err.message, true);
    } finally {
      btn.classList.remove("busy");
      btn.textContent = "Upload";
    }
  });

  // ---- boot --------------------------------------------------------------
  loadListings();
  loadGallery();
})();

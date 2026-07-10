/* ==========================================================================
   HQ Encounters — shared data + UI logic (no build step, plain ES module-lite)
   GitHub Pages is static hosting, so we talk to Supabase REST directly with the
   public anon key. That key is safe to expose: a Postgres RLS policy
   (camels_public_read_active) restricts it to status='active' rows only.
   ========================================================================== */
(function () {
  "use strict";

  var SUPABASE_URL = "https://yygsstlijqddfddzzyke.supabase.co";
  var SUPABASE_ANON_KEY = "sb_publishable_dAEfEp4uFubZsK5wQo69pw_yIc98avq";

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function titleCase(value) {
    if (!value) return "";
    return String(value).charAt(0).toUpperCase() + String(value).slice(1);
  }

  // Convert a DB camel row (+ joined camel_images) into a clean view model.
  function camelFromRow(row) {
    var images = Array.isArray(row.camel_images) ? row.camel_images.slice() : [];
    images.sort(function (a, b) { return (a.sort_order || 0) - (b.sort_order || 0); });
    var ageYears = row.age_years == null ? null : Number(row.age_years);
    return {
      id: row.id,
      name: row.name,
      breed: row.breed,
      sex: row.sex,
      paintColor: row.paint_color || null,
      ageYears: ageYears,
      mainImage: row.main_image || null,
      additionalImages: images.map(function (img) { return img.url; }),
      shortDescription: row.short_description || "",
      longDescription: row.long_description || "",
    };
  }

  // All photos for one camel, main image first, de-duplicated.
  function camelImages(camel) {
    var all = [];
    if (camel.mainImage) all.push(camel.mainImage);
    (camel.additionalImages || []).forEach(function (url) {
      if (url && all.indexOf(url) === -1) all.push(url);
    });
    return all;
  }

  function ageLabel(years) {
    if (years == null) return null;
    return years + (years === 1 ? " Year" : " Years");
  }

  async function fetchActiveCamels() {
    var url = SUPABASE_URL +
      "/rest/v1/camels?select=*,camel_images(url,sort_order)" +
      "&status=eq.active&order=created_at.desc";
    var res = await fetch(url, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + SUPABASE_ANON_KEY },
    });
    if (!res.ok) throw new Error("Request failed (" + res.status + ")");
    var rows = await res.json();
    return rows.map(camelFromRow);
  }

  // Standalone gallery photos (gallery_photos table), read via the anon key.
  // RLS policy gallery_public_read allows anon SELECT of every row.
  async function fetchGalleryPhotos() {
    var url = SUPABASE_URL +
      "/rest/v1/gallery_photos?select=id,photo_url,caption,sort_order,created_at" +
      "&order=sort_order.asc,created_at.desc";
    var res = await fetch(url, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + SUPABASE_ANON_KEY },
    });
    if (!res.ok) throw new Error("Request failed (" + res.status + ")");
    var rows = await res.json();
    return rows.map(function (r) {
      return { photoUrl: r.photo_url, caption: r.caption || "" };
    });
  }

  // ---- Listing card ------------------------------------------------------
  function cardMarkup(camel) {
    var img = camel.mainImage || (camel.additionalImages || [])[0] || "";
    var media = img
      ? '<img src="' + esc(img) + '" alt="' + esc(camel.name) + '" loading="lazy" />'
      : '<span aria-hidden="true">HQ</span>';

    var badges = '<span class="badge badge--type">' + esc(camel.breed) + "</span>";
    if (camel.paintColor) {
      badges += '<span class="badge badge--paint">' + esc(camel.paintColor) + "</span>";
    }
    badges += '<span class="badge">' + esc(titleCase(camel.sex)) + "</span>";
    var age = ageLabel(camel.ageYears);
    if (age) badges += '<span class="badge">' + esc(age) + "</span>";

    return '' +
      '<button class="card__media' + (img ? "" : " card__media--empty") + '" type="button" ' +
        'data-detail aria-label="View details for ' + esc(camel.name) + '">' + media + "</button>" +
      '<div class="card__body">' +
        '<div class="badges">' + badges + "</div>" +
        '<h3 class="card__name">' + esc(camel.name) + "</h3>" +
        '<p class="card__desc">' + esc(camel.shortDescription) + "</p>" +
        '<button class="card__cta" type="button" data-detail>View Details ' +
          '<span class="btn__arrow" aria-hidden="true">&rarr;</span></button>' +
      "</div>";
  }

  function renderCard(camel) {
    var el = document.createElement("article");
    el.className = "card";
    el.innerHTML = cardMarkup(camel);
    el.querySelectorAll("[data-detail]").forEach(function (trigger) {
      trigger.addEventListener("click", function () { openDetail(camel); });
    });
    return el;
  }

  // ---- Lightbox ----------------------------------------------------------
  function createLightbox() {
    var images = [];
    var index = 0;

    var box = document.createElement("div");
    box.className = "lightbox";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-label", "Photo viewer");
    box.innerHTML =
      '<img class="lightbox__img" alt="" />' +
      '<button class="lightbox__btn lightbox__btn--close" aria-label="Close">&times;</button>' +
      '<button class="lightbox__btn lightbox__btn--prev" aria-label="Previous photo">&#8249;</button>' +
      '<button class="lightbox__btn lightbox__btn--next" aria-label="Next photo">&#8250;</button>' +
      '<div class="lightbox__count" aria-live="polite"></div>';
    document.body.appendChild(box);

    var imgEl = box.querySelector(".lightbox__img");
    var countEl = box.querySelector(".lightbox__count");
    var prevBtn = box.querySelector(".lightbox__btn--prev");
    var nextBtn = box.querySelector(".lightbox__btn--next");

    function show() {
      var item = images[index];
      imgEl.src = item.src;
      imgEl.alt = item.alt || "";
      countEl.textContent = images.length > 1 ? (index + 1) + " / " + images.length : "";
      var many = images.length > 1;
      prevBtn.style.display = many ? "" : "none";
      nextBtn.style.display = many ? "" : "none";
    }
    function open(list, start) {
      images = list; index = start || 0;
      show();
      box.classList.add("open");
      document.body.style.overflow = "hidden";
    }
    function close() {
      box.classList.remove("open");
      document.body.style.overflow = "";
    }
    function step(dir) {
      index = (index + dir + images.length) % images.length;
      show();
    }

    box.querySelector(".lightbox__btn--close").addEventListener("click", close);
    prevBtn.addEventListener("click", function (e) { e.stopPropagation(); step(-1); });
    nextBtn.addEventListener("click", function (e) { e.stopPropagation(); step(1); });
    box.addEventListener("click", function (e) { if (e.target === box) close(); });
    document.addEventListener("keydown", function (e) {
      if (!box.classList.contains("open")) return;
      if (e.key === "Escape") close();
      else if (e.key === "ArrowLeft") step(-1);
      else if (e.key === "ArrowRight") step(1);
    });

    return { open: open };
  }

  // ---- Camel detail modal -----------------------------------------------
  // Opened from a listing card. Shows the full (long) description plus every
  // photo for that camel; clicking a photo opens the shared lightbox. Built
  // once, lazily, and reused for every camel.
  var detailModal = null;

  function createDetailModal() {
    var lightbox = createLightbox();

    var box = document.createElement("div");
    box.className = "detail";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-label", "Camel details");
    box.innerHTML =
      '<div class="detail__panel">' +
        '<button class="detail__close" type="button" aria-label="Close">&times;</button>' +
        '<div class="detail__media">' +
          '<button class="detail__hero" type="button" aria-label="View photo full screen"><img alt="" /></button>' +
          '<div class="detail__thumbs"></div>' +
        "</div>" +
        '<div class="detail__info">' +
          '<div class="badges detail__badges"></div>' +
          '<h2 class="detail__name"></h2>' +
          '<p class="detail__desc"></p>' +
          '<a class="btn detail__inquire" href="#contact">Inquire About This Camel ' +
            '<span class="btn__arrow" aria-hidden="true">&rarr;</span></a>' +
        "</div>" +
      "</div>";
    document.body.appendChild(box);

    var heroBtn = box.querySelector(".detail__hero");
    var heroImg = heroBtn.querySelector("img");
    var thumbsEl = box.querySelector(".detail__thumbs");
    var badgesEl = box.querySelector(".detail__badges");
    var nameEl = box.querySelector(".detail__name");
    var descEl = box.querySelector(".detail__desc");
    var inquireBtn = box.querySelector(".detail__inquire");

    var currentPhotos = [];

    function close() {
      box.classList.remove("open");
      document.body.style.overflow = "";
    }

    box.querySelector(".detail__close").addEventListener("click", close);
    box.addEventListener("click", function (e) { if (e.target === box) close(); });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && box.classList.contains("open")) close();
    });
    inquireBtn.addEventListener("click", close);
    heroBtn.addEventListener("click", function () { if (currentPhotos.length) lightbox.open(currentPhotos, 0); });

    function open(camel) {
      var imgs = camelImages(camel);
      currentPhotos = imgs.map(function (src) { return { src: src, alt: camel.name }; });

      // Badges (breed / paint / sex / age), same vocabulary as the card.
      var badges = '<span class="badge badge--type">' + esc(camel.breed) + "</span>";
      if (camel.paintColor) badges += '<span class="badge badge--paint">' + esc(camel.paintColor) + "</span>";
      badges += '<span class="badge">' + esc(titleCase(camel.sex)) + "</span>";
      var age = ageLabel(camel.ageYears);
      if (age) badges += '<span class="badge">' + esc(age) + "</span>";
      badgesEl.innerHTML = badges;

      nameEl.textContent = camel.name;
      descEl.textContent = camel.longDescription || camel.shortDescription || "";

      if (imgs.length) {
        heroImg.src = imgs[0];
        heroImg.alt = camel.name;
        heroBtn.style.display = "";
      } else {
        heroBtn.style.display = "none";
      }

      // Thumbnails for every photo; clicking opens the lightbox at that index.
      thumbsEl.innerHTML = "";
      if (imgs.length > 1) {
        imgs.forEach(function (src, i) {
          var t = document.createElement("button");
          t.className = "detail__thumb";
          t.type = "button";
          t.setAttribute("aria-label", "View photo " + (i + 1));
          t.innerHTML = '<img src="' + esc(src) + '" alt="" loading="lazy" />';
          t.addEventListener("click", function () {
            heroImg.src = src;
            lightbox.open(currentPhotos, i);
          });
          thumbsEl.appendChild(t);
        });
      }

      box.classList.add("open");
      document.body.style.overflow = "hidden";
    }

    return { open: open };
  }

  function openDetail(camel) {
    if (!detailModal) detailModal = createDetailModal();
    detailModal.open(camel);
  }

  window.HQ = {
    esc: esc,
    fetchActiveCamels: fetchActiveCamels,
    fetchGalleryPhotos: fetchGalleryPhotos,
    camelImages: camelImages,
    renderCard: renderCard,
    createLightbox: createLightbox,
    openDetail: openDetail,
  };
})();

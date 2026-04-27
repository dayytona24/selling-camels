const detailShell = document.querySelector("#detailShell");
const params = new URLSearchParams(window.location.search);
const camelId = params.get("id");

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[char]));
}

function renderDetail(camel) {
  const images = [camel.mainImage, ...(camel.additionalImages || [])].filter(Boolean);
  const firstImage = images[0] || "";

  detailShell.innerHTML = `
    <div class="detail-media">
      ${firstImage
        ? `<img id="activeCamelImage" class="detail-main-image" src="${escapeHtml(firstImage)}" alt="${escapeHtml(camel.name)}">`
        : `<div id="activeCamelImage" class="detail-main-image camel-card-placeholder" aria-hidden="true">${escapeHtml(camel.name.charAt(0))}</div>`}
      ${images.length > 1 ? `
        <div class="detail-image-buttons" aria-label="Camel photos">
          ${images.map((image, index) => `
            <button class="detail-image-dot${index === 0 ? " is-active" : ""}" type="button" data-image="${escapeHtml(image)}" aria-label="Show photo ${index + 1}"></button>
          `).join("")}
        </div>
      ` : ""}
    </div>

    <article class="detail-copy">
      <span class="section-label">${escapeHtml(camel.type)}</span>
      <h1>${escapeHtml(camel.name)}</h1>
      <span class="detail-rule"></span>
      <p>${escapeHtml(camel.longDescription)}</p>

      <div class="contact-card detail-contact">
        <h2>Inquire About This Camel</h2>
        <p>Speak directly with HQ Ranch Encounters for pricing, temperament, and transport questions.</p>
        <div class="contact-lines">
          <span>Hqranchcamels@gmail.com</span>
          <span>+1 (918) 706-3161</span>
        </div>
        <div class="contact-buttons">
          <a class="btn btn-primary" href="mailto:Hqranchcamels@gmail.com" target="_blank" rel="noopener">Email Ranch</a>
          <a class="btn btn-secondary" href="tel:+19187063161">Call Ranch</a>
        </div>
      </div>
    </article>
  `;
}

async function loadCamel() {
  if (!camelId) throw new Error("Missing camel id.");
  const response = await fetch("/api/camels");
  if (!response.ok) throw new Error("Unable to load camel details.");

  const camels = await response.json();
  const camel = camels.find((item) => String(item.id) === String(camelId));
  if (!camel) throw new Error("Camel not found.");
  renderDetail(camel);
}

detailShell.addEventListener("click", (event) => {
  const button = event.target.closest("[data-image]");
  if (!button) return;

  const activeImage = document.querySelector("#activeCamelImage");
  if (activeImage?.tagName === "IMG") activeImage.src = button.dataset.image;

  document.querySelectorAll(".detail-image-dot").forEach((dot) => {
    dot.classList.toggle("is-active", dot === button);
  });
});

loadCamel().catch((error) => {
  detailShell.innerHTML = `
    <div class="empty-state">
      <h1>Could not load this camel</h1>
      <p>${escapeHtml(error.message)}</p>
      <a class="btn btn-primary" href="camels.html">Back to Camels</a>
    </div>
  `;
});

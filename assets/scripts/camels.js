const camelGrid = document.querySelector("#camelGrid");
const emptyState = document.querySelector("#emptyState");
const filterPills = document.querySelectorAll(".filter-pill");

let camels = [];
let activeFilter = "all";

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[char]));
}

function visibleCamels() {
  if (activeFilter === "all") return camels;
  return camels.filter((camel) => camel.type === activeFilter);
}

function renderCards() {
  const list = visibleCamels();

  if (!list.length && camels.length) {
    camelGrid.innerHTML = `<p class="form-status" style="grid-column:1/-1;padding:2rem 0;opacity:.7;">No ${escapeHtml(activeFilter)} camels listed right now.</p>`;
    emptyState.hidden = true;
    return;
  }

  emptyState.hidden = list.length > 0;

  camelGrid.innerHTML = list.map((camel) => {
    const imgHtml = camel.mainImage
      ? `<img class="camel-card-image" src="${escapeHtml(camel.mainImage)}" alt="${escapeHtml(camel.name)}" loading="lazy">`
      : `<div class="camel-card-placeholder" aria-hidden="true">${escapeHtml(camel.name?.charAt(0) || "H")}</div>`;

    return `
      <article class="camel-card">
        ${imgHtml}
        <div class="camel-card-copy">
          <span class="camel-tag">${escapeHtml(camel.type)}</span>
          <h2>${escapeHtml(camel.name)}</h2>
          <p>${escapeHtml(camel.shortDescription)}</p>
          <a class="learn-button" href="camel-detail.html?id=${encodeURIComponent(camel.id)}">Learn More &rarr;</a>
        </div>
      </article>
    `;
  }).join("");
}

async function loadCamels() {
  camelGrid.innerHTML = '<p class="form-status" style="grid-column:1/-1;padding:2rem 0;">Loading camel listings...</p>';
  const response = await fetch("/api/camels");
  if (!response.ok) throw new Error("Unable to load camel listings.");
  camels = await response.json();
  renderCards();
}

filterPills.forEach((pill) => {
  pill.addEventListener("click", () => {
    filterPills.forEach((item) => item.classList.remove("filter-pill--active"));
    pill.classList.add("filter-pill--active");
    activeFilter = pill.dataset.filter;
    renderCards();
  });
});

loadCamels().catch(() => {
  camelGrid.innerHTML = "";
  emptyState.hidden = false;
});

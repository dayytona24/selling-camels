const form = document.querySelector("#camelForm");
const camelId = document.querySelector("#camelId");
const formTitle = document.querySelector("#formTitle");
const formStatus = document.querySelector("#formStatus");
const adminList = document.querySelector("#adminList");
const resetButton = document.querySelector("#resetButton");
const keepAdditionalImages = document.querySelector("#keepAdditionalImages");
const mainImagePreview = document.querySelector("#mainImagePreview");
const additionalPreview = document.querySelector("#additionalPreview");

let camels = [];
let keptGallery = [];

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[char]));
}

function setStatus(message) {
  formStatus.textContent = message;
}

function renderPreview(container, images, removable = false) {
  container.innerHTML = images.map((image) => `
    <span class="image-preview">
      <img src="${escapeHtml(image)}" alt="">
      ${removable ? `<button type="button" data-remove-image="${escapeHtml(image)}" aria-label="Remove image">&times;</button>` : ""}
    </span>
  `).join("");
}

function resetForm() {
  form.reset();
  camelId.value = "";
  keptGallery = [];
  keepAdditionalImages.value = "[]";
  mainImagePreview.innerHTML = "";
  additionalPreview.innerHTML = "";
  formTitle.textContent = "Add a Camel";
  setStatus("");
}

function renderList() {
  if (!camels.length) {
    adminList.innerHTML = '<p class="form-status">No camel listings yet.</p>';
    return;
  }

  adminList.innerHTML = camels.map((camel) => `
    <article class="admin-list-item">
      ${camel.mainImage
        ? `<img class="admin-thumb" src="${escapeHtml(camel.mainImage)}" alt="${escapeHtml(camel.name)}">`
        : `<div class="admin-thumb camel-card-placeholder" aria-hidden="true">${escapeHtml(camel.name.charAt(0))}</div>`}
      <div class="admin-item-copy">
        <span class="camel-tag">${escapeHtml(camel.type)}</span>
        <h3>${escapeHtml(camel.name)}</h3>
        <p>${escapeHtml(camel.shortDescription)}</p>
        <div class="admin-actions">
          <button class="text-button" type="button" data-edit-id="${camel.id}">Edit</button>
          <button class="text-button danger-button" type="button" data-delete-id="${camel.id}">Delete</button>
        </div>
      </div>
    </article>
  `).join("");
}

async function loadCamels() {
  const response = await fetch("/api/admin/camels", { credentials: "same-origin" });
  if (!response.ok) throw new Error("Unable to load listings.");
  camels = await response.json();
  renderList();
}

function editCamel(camel) {
  camelId.value = camel.id;
  formTitle.textContent = `Edit ${camel.name}`;
  form.name.value = camel.name;
  form.type.value = camel.type;
  form.shortDescription.value = camel.shortDescription;
  form.longDescription.value = camel.longDescription;
  keptGallery = [...(camel.additionalImages || [])];
  keepAdditionalImages.value = JSON.stringify(keptGallery);
  renderPreview(mainImagePreview, camel.mainImage ? [camel.mainImage] : []);
  renderPreview(additionalPreview, keptGallery, true);
  setStatus("Editing existing listing.");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function deleteCamel(id) {
  const camel = camels.find((item) => String(item.id) === String(id));
  if (!confirm(`Delete ${camel?.name || "this camel"}?`)) return;

  const response = await fetch(`/api/admin/camels/${id}`, {
    method: "DELETE",
    credentials: "same-origin"
  });
  if (!response.ok) throw new Error("Delete failed.");
  if (camelId.value === String(id)) resetForm();
  await loadCamels();
}

async function readErrorMessage(response) {
  const fallback = `Could not save listing. Server returned ${response.status}.`;
  const contentType = response.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    const payload = await response.json().catch(() => ({}));
    return payload.error || fallback;
  }

  const text = await response.text().catch(() => "");
  return text ? `${fallback} ${text.slice(0, 140)}` : fallback;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  setStatus("Saving listing...");

  try {
    const data = new FormData(form);
    data.set("keepAdditionalImages", JSON.stringify(keptGallery));

    const id = camelId.value;
    const endpoint = new URL(id ? `/api/admin/camels/${id}` : "/api/admin/camels", window.location.origin);
    const response = await fetch(endpoint, {
      method: id ? "PUT" : "POST",
      body: data,
      credentials: "same-origin"
    });

    if (!response.ok) {
      setStatus(await readErrorMessage(response));
      return;
    }

    resetForm();
    setStatus("Listing saved.");
    await loadCamels();
  } catch (error) {
    setStatus(`Could not save listing. ${error.message}`);
  }
});

adminList.addEventListener("click", async (event) => {
  const editButton = event.target.closest("[data-edit-id]");
  const deleteButton = event.target.closest("[data-delete-id]");

  if (editButton) {
    const camel = camels.find((item) => String(item.id) === editButton.dataset.editId);
    if (camel) editCamel(camel);
  }

  if (deleteButton) {
    await deleteCamel(deleteButton.dataset.deleteId);
  }
});

additionalPreview.addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove-image]");
  if (!button) return;
  keptGallery = keptGallery.filter((image) => image !== button.dataset.removeImage);
  keepAdditionalImages.value = JSON.stringify(keptGallery);
  renderPreview(additionalPreview, keptGallery, true);
});

resetButton.addEventListener("click", resetForm);

loadCamels().catch(() => {
  adminList.innerHTML = '<p class="form-status">Could not load listings. Check that the server is running.</p>';
});

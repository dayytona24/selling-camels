const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const express = require("express");
const multer = require("multer");

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "camel123";

const rootDir = __dirname;
const dataDir = path.join(rootDir, "data");
const uploadsDir = path.join(rootDir, "uploads");

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(uploadsDir, { recursive: true });

function createDatabase() {
  const projectDbPath = path.join(dataDir, "camels.sqlite");
  const tempDbPath = path.join(os.tmpdir(), "HQ Ranch", "camels.sqlite");
  const appDataDbPath = path.join(
    process.env.LOCALAPPDATA || os.tmpdir(),
    "HQ Ranch",
    "camels.sqlite"
  );

  for (const dbPath of [projectDbPath, appDataDbPath, tempDbPath]) {
    try {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      const database = new DatabaseSync(dbPath);
      database.exec("CREATE TABLE IF NOT EXISTS __healthcheck (ok INTEGER)");
      database.exec("DROP TABLE __healthcheck");
      console.log(`Using camel database: ${dbPath}`);
      return database;
    } catch (error) {
      console.warn(`Could not use database at ${dbPath}: ${error.message}`);
    }
  }

  throw new Error("Unable to open a writable SQLite database.");
}

const db = createDatabase();
db.exec(`
  CREATE TABLE IF NOT EXISTS camels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('Hybrid', 'Dromedary', 'Bactrian')),
    main_image TEXT,
    additional_images TEXT NOT NULL DEFAULT '[]',
    short_description TEXT NOT NULL,
    long_description TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024, files: 12 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      cb(new Error("Only image uploads are supported."));
      return;
    }
    cb(null, true);
  }
});

app.use(express.json());
app.use("/assets", express.static(path.join(rootDir, "assets"), {
  setHeaders(res, filePath) {
    if (filePath.endsWith("admin.js") || filePath.endsWith("camels.js")) {
      res.setHeader("Cache-Control", "no-store");
    }
  }
}));
app.use("/uploads", express.static(uploadsDir));

function requireAdmin(req, res, next) {
  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");

  if (scheme === "Basic" && encoded) {
    const [user, password] = Buffer.from(encoded, "base64").toString("utf8").split(":");
    if (user === ADMIN_USER && password === ADMIN_PASSWORD) {
      return next();
    }
  }

  res.set("WWW-Authenticate", 'Basic realm="HQ Ranch Camel Manager"');
  return res.status(401).send("Authentication required.");
}

function camelFromRecord(row) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    mainImage: row.main_image || "",
    additionalImages: JSON.parse(row.additional_images || "[]"),
    shortDescription: row.short_description,
    longDescription: row.long_description,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function uploadedPath(file) {
  return file ? `/uploads/${file.filename}` : "";
}

function readCamelPayload(req, existingCamel) {
  const body = req.body;
  const name = String(body.name || "").trim();
  const type = String(body.type || "").trim();
  const shortDescription = String(body.shortDescription || "").trim();
  const longDescription = String(body.longDescription || "").trim();

  if (!name || !type || !shortDescription || !longDescription) {
    const error = new Error("Name, type, short description, and long description are required.");
    error.statusCode = 400;
    throw error;
  }

  if (!["Hybrid", "Dromedary", "Bactrian"].includes(type)) {
    const error = new Error("Camel type must be Hybrid, Dromedary, or Bactrian.");
    error.statusCode = 400;
    throw error;
  }

  const mainImageUpload = req.files?.mainImage?.[0];
  const additionalUploads = req.files?.additionalImages || [];
  const existingAdditional = existingCamel?.additionalImages || [];
  let keptAdditional = existingAdditional;

  if (body.keepAdditionalImages) {
    try {
      const parsed = JSON.parse(body.keepAdditionalImages);
      keptAdditional = Array.isArray(parsed) ? parsed.filter(Boolean) : existingAdditional;
    } catch {
      keptAdditional = existingAdditional;
    }
  }

  return {
    name,
    type,
    shortDescription,
    longDescription,
    mainImage: uploadedPath(mainImageUpload) || existingCamel?.mainImage || "",
    additionalImages: [
      ...keptAdditional,
      ...additionalUploads.map(uploadedPath)
    ]
  };
}

app.get("/api/camels", (_req, res, next) => {
  try {
    const rows = db.prepare("SELECT * FROM camels ORDER BY updated_at DESC, created_at DESC").all();
    res.json(rows.map(camelFromRecord));
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/camels", requireAdmin, (_req, res, next) => {
  try {
    const rows = db.prepare("SELECT * FROM camels ORDER BY updated_at DESC, created_at DESC").all();
    res.json(rows.map(camelFromRecord));
  } catch (error) {
    next(error);
  }
});

app.post(
  "/api/admin/camels",
  requireAdmin,
  upload.fields([
    { name: "mainImage", maxCount: 1 },
    { name: "additionalImages", maxCount: 10 }
  ]),
  (req, res, next) => {
    try {
      const camel = readCamelPayload(req);
      const id = crypto.randomUUID();
      db.prepare(`
        INSERT INTO camels (id, name, type, main_image, additional_images, short_description, long_description)
        VALUES (@id, @name, @type, @mainImage, @additionalImages, @shortDescription, @longDescription)
      `).run({
        id,
        ...camel,
        additionalImages: JSON.stringify(camel.additionalImages)
      });

      const row = db.prepare("SELECT * FROM camels WHERE id = ?").get(id);
      res.status(201).json(camelFromRecord(row));
    } catch (error) {
      next(error);
    }
  }
);

app.put(
  "/api/admin/camels/:id",
  requireAdmin,
  upload.fields([
    { name: "mainImage", maxCount: 1 },
    { name: "additionalImages", maxCount: 10 }
  ]),
  (req, res, next) => {
    try {
      const existing = db.prepare("SELECT * FROM camels WHERE id = ?").get(req.params.id);
      if (!existing) {
        res.status(404).json({ error: "Camel not found." });
        return;
      }

      const camel = readCamelPayload(req, camelFromRecord(existing));
      db.prepare(`
        UPDATE camels
        SET name = @name,
            type = @type,
            main_image = @mainImage,
            additional_images = @additionalImages,
            short_description = @shortDescription,
            long_description = @longDescription,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = @id
      `).run({
        id: req.params.id,
        ...camel,
        additionalImages: JSON.stringify(camel.additionalImages)
      });

      const row = db.prepare("SELECT * FROM camels WHERE id = ?").get(req.params.id);
      res.json(camelFromRecord(row));
    } catch (error) {
      next(error);
    }
  }
);

app.delete("/api/admin/camels/:id", requireAdmin, (req, res, next) => {
  try {
    const result = db.prepare("DELETE FROM camels WHERE id = ?").run(req.params.id);
    if (!result.changes) {
      res.status(404).json({ error: "Camel not found." });
      return;
    }

    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get(["/admin", "/admin.html"], requireAdmin, (_req, res) => {
  const html = fs
    .readFileSync(path.join(rootDir, "admin.html"), "utf8")
    .replace("assets/scripts/admin.js?v=3", `assets/scripts/admin.js?v=${Date.now()}`);

  res.set("Cache-Control", "no-store");
  res.type("html").send(html);
});

app.get(["/", "/index.html"], (_req, res) => {
  res.sendFile(path.join(rootDir, "index.html"));
});

app.get("/camels.html", (_req, res) => {
  res.sendFile(path.join(rootDir, "camels.html"));
});

app.get("/camel-detail.html", (_req, res) => {
  res.sendFile(path.join(rootDir, "camel-detail.html"));
});

app.use((error, _req, res, _next) => {
  const status = error.statusCode || 500;
  res.status(status).json({ error: error.message || "Something went wrong." });
});

app.listen(PORT, () => {
  console.log(`HQ Ranch camel listings running at http://localhost:${PORT}`);
  console.log(`Admin login: ${ADMIN_USER} / ${ADMIN_PASSWORD}`);
});

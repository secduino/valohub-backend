/**
 * ValoHub Backend API
 * Render Web Service olarak çalışır
 *
 * Sorumluluklar:
 * - Wishlist CRUD
 * - Bölge + skin eşleşmesi
 * - Worker'lara veri sağlamak
 */

const express = require("express");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");

const app = express();

/**
 * ⚠️ RENDER KRİTİK KURAL
 * PORT MUTLAKA process.env.PORT OLMALI
 * Sabit port YASAK
 */
const PORT = process.env.PORT;

// =====================
// MIDDLEWARE
// =====================
app.use(cors());
app.use(express.json());

// =====================
// IN-MEMORY DATABASE
// (Render Free Tier için)
// =====================
const db = {
  wishlist: new Map(),
  skinSubscriptions: new Map(),
  regions: ["TR", "EU", "NA", "AP", "KR", "BR", "LATAM"],
};

// =====================
// HELPERS
// =====================
function generateAnonUserId() {
  return `anon_${uuidv4().replace(/-/g, "").slice(0, 16)}`;
}

function normalizeRegion(region) {
  const r = (region || "EU").toUpperCase();
  return db.regions.includes(r) ? r : "EU";
}

function generateTopic(region, source, skinId) {
  return `valohub/${region}/${source}/${skinId}`;
}

// =====================
// HEALTH CHECK (RENDER)
// =====================
app.get("/", (req, res) => {
  res.status(200).send("OK");
});

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    users: db.wishlist.size,
    skins: db.skinSubscriptions.size,
    timestamp: new Date().toISOString(),
  });
});

// =====================
// USER
// =====================
app.post("/api/user/register", (req, res) => {
  const region = normalizeRegion(req.body.region);
  const anonUserId = generateAnonUserId();

  db.wishlist.set(anonUserId, {
    region,
    items: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  res.json({ anonUserId, region });
});

app.put("/api/user/:anonUserId/region", (req, res) => {
  const { anonUserId } = req.params;
  const region = normalizeRegion(req.body.region);

  const user = db.wishlist.get(anonUserId);
  if (!user) return res.status(404).json({ error: "User not found" });

  const oldRegion = user.region;
  user.region = region;
  user.updatedAt = new Date().toISOString();

  user.items.forEach((item) => {
    const set = db.skinSubscriptions.get(item.skinId);
    if (!set) return;
    set.delete(`${anonUserId}:${oldRegion}:${item.source}`);
    set.add(`${anonUserId}:${region}:${item.source}`);
  });

  res.json({ region });
});

// =====================
// WISHLIST
// =====================
app.post("/api/wishlist/:anonUserId", (req, res) => {
  const { anonUserId } = req.params;
  const { skinId, skinName, source = "store" } = req.body;

  if (!skinId) {
    return res.status(400).json({ error: "skinId required" });
  }

  let user = db.wishlist.get(anonUserId);
  if (!user) {
    user = {
      region: "EU",
      items: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    db.wishlist.set(anonUserId, user);
  }

  const exists = user.items.some(
    (i) => i.skinId === skinId && i.source === source
  );

  if (!exists) {
    user.items.push({
      skinId,
      skinName: skinName || "Unknown",
      source,
      addedAt: new Date().toISOString(),
    });

    if (!db.skinSubscriptions.has(skinId)) {
      db.skinSubscriptions.set(skinId, new Set());
    }

    db.skinSubscriptions
      .get(skinId)
      .add(`${anonUserId}:${user.region}:${source}`);
  }

  res.json({
    success: true,
    topic: generateTopic(user.region, source, skinId),
  });
});

app.delete("/api/wishlist/:anonUserId/:skinId", (req, res) => {
  const { anonUserId, skinId } = req.params;
  const source = req.query.source || "store";

  const user = db.wishlist.get(anonUserId);
  if (!user) return res.status(404).json({ error: "User not found" });

  user.items = user.items.filter(
    (i) => !(i.skinId === skinId && i.source === source)
  );

  const set = db.skinSubscriptions.get(skinId);
  if (set) {
    set.delete(`${anonUserId}:${user.region}:${source}`);
    if (set.size === 0) db.skinSubscriptions.delete(skinId);
  }

  res.json({ success: true });
});

app.get("/api/wishlist/:anonUserId", (req, res) => {
  const user = db.wishlist.get(req.params.anonUserId);
  if (!user) return res.json({ region: "EU", items: [], topics: [] });

  const topics = user.items.map((i) =>
    generateTopic(user.region, i.source, i.skinId)
  );

  res.json({ region: user.region, items: user.items, topics });
});

// =====================
// WORKER (INTERNAL)
// =====================
function checkWorkerKey(req, res) {
  if (
    process.env.NODE_ENV === "production" &&
    req.headers["x-api-key"] !== process.env.WORKER_API_KEY
  ) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

app.get("/api/internal/subscriptions/:skinId", (req, res) => {
  if (!checkWorkerKey(req, res)) return;

  const subs = db.skinSubscriptions.get(req.params.skinId);
  if (!subs) return res.json({ subscriptions: [] });

  const result = Array.from(subs).map((s) => {
    const [anonUserId, region, source] = s.split(":");
    return {
      anonUserId,
      region,
      source,
      topic: generateTopic(region, source, req.params.skinId),
    };
  });

  res.json({ subscriptions: result });
});

app.get("/api/internal/active-skins", (req, res) => {
  if (!checkWorkerKey(req, res)) return;

  const map = new Map();

  db.skinSubscriptions.forEach((subs, skinId) => {
    subs.forEach((s) => {
      const [, region, source] = s.split(":");
      if (!map.has(skinId)) map.set(skinId, new Set());
      map.get(skinId).add(region);
    });
  });

  const skins = Array.from(map.entries()).map(([skinId, regions]) => ({
    skinId,
    regions: Array.from(regions),
  }));

  res.json({ count: skins.length, skins });
});

// =====================
// START
// =====================
app.listen(PORT, () => {
  console.log(`ValoHub Backend API running on port ${PORT}`);
});

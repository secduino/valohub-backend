/**
 * ValoHub Backend API
 * Render Web Service olarak çalışır
 * 
 * Sorumluluklar:
 * - Wishlist CRUD
 * - Bölge + skin eşleşmesi
 * - Worker'lara veri sağlamak
 */

const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// ============================================
// IN-MEMORY DATABASE (Render Free Tier için)
// Production'da Redis veya PostgreSQL kullanılabilir
// ============================================

const db = {
  // wishlist: Map<anonUserId, WishlistItem[]>
  wishlist: new Map(),
  
  // skinSubscriptions: Map<skinId, Set<{anonUserId, region, source}>>
  // Worker'ın hızlı erişimi için
  skinSubscriptions: new Map(),
  
  // regions: Desteklenen bölgeler
  regions: ['TR', 'EU', 'NA', 'AP', 'KR', 'BR', 'LATAM']
};

// ============================================
// HELPER FUNCTIONS
// ============================================

function generateAnonUserId() {
  return `anon_${uuidv4().replace(/-/g, '').substring(0, 16)}`;
}

function normalizeRegion(region) {
  const upper = (region || 'EU').toUpperCase();
  return db.regions.includes(upper) ? upper : 'EU';
}

function generateTopicName(region, source, skinId) {
  // Format: valohub/{region}/{source}/{skinId}
  // Örnek: valohub/TR/store/prime-vandal-uuid
  return `valohub/${region}/${source}/${skinId}`;
}

// ============================================
// ROUTES
// ============================================

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    wishlistCount: db.wishlist.size,
    subscriptionCount: db.skinSubscriptions.size
  });
});

// ============================================
// ANON USER ROUTES
// ============================================

// Yeni anonim kullanıcı oluştur
app.post('/api/user/register', (req, res) => {
  const { region } = req.body;
  const anonUserId = generateAnonUserId();
  const normalizedRegion = normalizeRegion(region);
  
  db.wishlist.set(anonUserId, {
    region: normalizedRegion,
    items: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  
  res.json({
    success: true,
    anonUserId,
    region: normalizedRegion
  });
});

// Kullanıcı bölgesini güncelle
app.put('/api/user/:anonUserId/region', (req, res) => {
  const { anonUserId } = req.params;
  const { region } = req.body;
  
  const userData = db.wishlist.get(anonUserId);
  if (!userData) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  const oldRegion = userData.region;
  const newRegion = normalizeRegion(region);
  userData.region = newRegion;
  userData.updatedAt = new Date().toISOString();
  
  // Subscription'ları güncelle
  userData.items.forEach(item => {
    // Eski subscription'ı kaldır
    const oldTopic = generateTopicName(oldRegion, item.source, item.skinId);
    const oldSubs = db.skinSubscriptions.get(item.skinId);
    if (oldSubs) {
      oldSubs.delete(`${anonUserId}:${oldRegion}:${item.source}`);
    }
    
    // Yeni subscription ekle
    if (!db.skinSubscriptions.has(item.skinId)) {
      db.skinSubscriptions.set(item.skinId, new Set());
    }
    db.skinSubscriptions.get(item.skinId).add(`${anonUserId}:${newRegion}:${item.source}`);
  });
  
  res.json({
    success: true,
    region: newRegion
  });
});

// ============================================
// WISHLIST ROUTES
// ============================================

// Wishlist'e skin ekle
app.post('/api/wishlist/:anonUserId', (req, res) => {
  const { anonUserId } = req.params;
  const { skinId, skinName, source = 'store' } = req.body;
  
  // source: 'store' | 'night' | 'bundle'
  const validSources = ['store', 'night', 'bundle'];
  const normalizedSource = validSources.includes(source) ? source : 'store';
  
  let userData = db.wishlist.get(anonUserId);
  
  // Kullanıcı yoksa oluştur
  if (!userData) {
    userData = {
      region: 'EU',
      items: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    db.wishlist.set(anonUserId, userData);
  }
  
  // Zaten var mı kontrol et
  const exists = userData.items.some(
    item => item.skinId === skinId && item.source === normalizedSource
  );
  
  if (exists) {
    return res.json({
      success: true,
      message: 'Already in wishlist',
      topic: generateTopicName(userData.region, normalizedSource, skinId)
    });
  }
  
  // Wishlist'e ekle
  const newItem = {
    skinId,
    skinName: skinName || 'Unknown Skin',
    source: normalizedSource,
    addedAt: new Date().toISOString()
  };
  userData.items.push(newItem);
  userData.updatedAt = new Date().toISOString();
  
  // Subscription index'ine ekle
  if (!db.skinSubscriptions.has(skinId)) {
    db.skinSubscriptions.set(skinId, new Set());
  }
  db.skinSubscriptions.get(skinId).add(`${anonUserId}:${userData.region}:${normalizedSource}`);
  
  const topic = generateTopicName(userData.region, normalizedSource, skinId);
  
  res.json({
    success: true,
    item: newItem,
    topic,
    message: `Subscribe to: ${topic}`
  });
});

// Wishlist'ten skin kaldır
app.delete('/api/wishlist/:anonUserId/:skinId', (req, res) => {
  const { anonUserId, skinId } = req.params;
  const { source = 'store' } = req.query;
  
  const userData = db.wishlist.get(anonUserId);
  if (!userData) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  const initialLength = userData.items.length;
  userData.items = userData.items.filter(
    item => !(item.skinId === skinId && item.source === source)
  );
  
  if (userData.items.length === initialLength) {
    return res.json({ success: true, message: 'Item not found in wishlist' });
  }
  
  userData.updatedAt = new Date().toISOString();
  
  // Subscription'dan kaldır
  const subs = db.skinSubscriptions.get(skinId);
  if (subs) {
    subs.delete(`${anonUserId}:${userData.region}:${source}`);
    if (subs.size === 0) {
      db.skinSubscriptions.delete(skinId);
    }
  }
  
  res.json({
    success: true,
    message: 'Removed from wishlist',
    unsubscribeTopic: generateTopicName(userData.region, source, skinId)
  });
});

// Kullanıcının wishlist'ini getir
app.get('/api/wishlist/:anonUserId', (req, res) => {
  const { anonUserId } = req.params;
  
  const userData = db.wishlist.get(anonUserId);
  if (!userData) {
    return res.json({
      region: 'EU',
      items: [],
      topics: []
    });
  }
  
  const topics = userData.items.map(item => 
    generateTopicName(userData.region, item.source, item.skinId)
  );
  
  res.json({
    region: userData.region,
    items: userData.items,
    topics
  });
});

// ============================================
// WORKER ROUTES (Internal API)
// ============================================

// Worker için: Belirli bir skin'i bekleyen kullanıcıları getir
app.get('/api/internal/subscriptions/:skinId', (req, res) => {
  const { skinId } = req.params;
  const apiKey = req.headers['x-api-key'];
  
  // Basit API key kontrolü
  if (apiKey !== process.env.WORKER_API_KEY && process.env.NODE_ENV === 'production') {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const subs = db.skinSubscriptions.get(skinId);
  if (!subs || subs.size === 0) {
    return res.json({ skinId, subscriptions: [] });
  }
  
  // Set'i parse edip array'e çevir
  const subscriptions = Array.from(subs).map(sub => {
    const [anonUserId, region, source] = sub.split(':');
    return {
      anonUserId,
      region,
      source,
      topic: generateTopicName(region, source, skinId)
    };
  });
  
  res.json({ skinId, subscriptions });
});

// Worker için: Tüm aktif skin ID'lerini getir (source bazlı)
app.get('/api/internal/active-skins', (req, res) => {
  const { source } = req.query; // 'store' | 'night' | 'bundle'
  const apiKey = req.headers['x-api-key'];
  
  if (apiKey !== process.env.WORKER_API_KEY && process.env.NODE_ENV === 'production') {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const activeSkins = new Map(); // skinId -> Set<region>
  
  db.skinSubscriptions.forEach((subs, skinId) => {
    subs.forEach(sub => {
      const [, region, itemSource] = sub.split(':');
      if (!source || itemSource === source) {
        if (!activeSkins.has(skinId)) {
          activeSkins.set(skinId, new Set());
        }
        activeSkins.get(skinId).add(region);
      }
    });
  });
  
  const result = [];
  activeSkins.forEach((regions, skinId) => {
    result.push({
      skinId,
      regions: Array.from(regions)
    });
  });
  
  res.json({
    source: source || 'all',
    count: result.length,
    skins: result
  });
});

// Worker için: Bölge bazlı topic listesi
app.get('/api/internal/topics-by-region/:region', (req, res) => {
  const { region } = req.params;
  const { source } = req.query;
  const apiKey = req.headers['x-api-key'];
  
  if (apiKey !== process.env.WORKER_API_KEY && process.env.NODE_ENV === 'production') {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const normalizedRegion = normalizeRegion(region);
  const topics = new Set();
  
  db.skinSubscriptions.forEach((subs, skinId) => {
    subs.forEach(sub => {
      const [, subRegion, itemSource] = sub.split(':');
      if (subRegion === normalizedRegion && (!source || itemSource === source)) {
        topics.add(generateTopicName(normalizedRegion, itemSource, skinId));
      }
    });
  });
  
  res.json({
    region: normalizedRegion,
    source: source || 'all',
    topics: Array.from(topics)
  });
});

// ============================================
// STATS
// ============================================

app.get('/api/stats', (req, res) => {
  let totalItems = 0;
  let sourceStats = { store: 0, night: 0, bundle: 0 };
  let regionStats = {};
  
  db.wishlist.forEach(userData => {
    totalItems += userData.items.length;
    userData.items.forEach(item => {
      sourceStats[item.source] = (sourceStats[item.source] || 0) + 1;
    });
    regionStats[userData.region] = (regionStats[userData.region] || 0) + 1;
  });
  
  res.json({
    users: db.wishlist.size,
    totalWishlistItems: totalItems,
    uniqueSkins: db.skinSubscriptions.size,
    bySource: sourceStats,
    byRegion: regionStats
  });
});

// ============================================
// START SERVER
// ============================================

app.listen(PORT, () => {
  console.log(`ValoHub Backend API running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});

module.exports = app;

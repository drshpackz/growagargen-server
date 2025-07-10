const express = require('express');
const apn = require('apn');
const cors = require('cors');
const fetch = require('node-fetch');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

// Serve static files (for the banner HTML page)
app.use(express.static('public'));

// In-memory storage for demo (replace with real database later)
let users = new Map(); // device_token -> user data
let stockItems = new Map(); // item_name -> quantity
let previousStockItems = new Map(); // For change detection

// Deduplication tracking
let recentNotifications = new Map(); // device_token -> Map(category+items -> timestamp)
const DEDUPLICATION_WINDOW = 5 * 60 * 1000; // 5 minutes (was 30 seconds)

// APNs Provider - will be initialized when we have the key
let apnProvider = null;

// Real API endpoint (same as iOS app)
const STOCK_API_URL = 'https://www.gamersberg.com/api/grow-a-garden/stock';

// Initialize APNs provider
function initializeAPNs() {
  if (!process.env.APNS_KEY_CONTENT) {
    console.log('⚠️ APNs key not configured yet');
    return;
  }

  try {
    apnProvider = new apn.Provider({
      token: {
        key: process.env.APNS_KEY_CONTENT,
        keyId: process.env.APNS_KEY_ID || 'F9J436633X',
        teamId: process.env.APNS_TEAM_ID || '8U376J9B6U',
      },
      production: process.env.APNS_PRODUCTION === 'true'
    });
    console.log('✅ APNs provider initialized successfully');
  } catch (error) {
    console.error('❌ Failed to initialize APNs provider:', error);
  }
}

// Fetch real stock data from the same API as iOS app
async function fetchRealStockData() {
  try {
    console.log('🔄 Fetching real stock data from API...');
    
    const response = await fetch(STOCK_API_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Referer': 'https://www.gamersberg.com/grow-a-garden/stock',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin'
      }
    });

    if (response.status === 401 || response.status === 403) {
      console.log(`⚠️ API returned ${response.status} - keeping existing stock data`);
      // Don't fall back to mock data, keep existing stock to maintain consistency
      if (stockItems.size > 0) {
        console.log(`📦 Preserving existing ${stockItems.size} stock items`);
        return new Map(stockItems); // Return copy of current stock
      } else {
        console.log(`📦 No existing stock, using mock data as last resort`);
        return createMockStockData();
      }
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    console.log('✅ Successfully fetched real stock data');
    return processStockData(data);
    
  } catch (error) {
    console.error('❌ Error fetching real stock data:', error.message);
    
    // Preserve existing stock data instead of falling back to mock
    if (stockItems.size > 0) {
      console.log(`📦 API failed, preserving existing ${stockItems.size} stock items`);
      return new Map(stockItems); // Return copy of current stock
    } else {
      console.log('🔄 No existing stock, using mock data as fallback');
      return createMockStockData();
    }
  }
}

// Process stock data into our format
function processStockData(apiResponse) {
  const processedItems = new Map();
  
  if (!apiResponse.data || !apiResponse.data[0]) {
    console.log('⚠️ Invalid API response structure');
    return processedItems;
  }

  const stockData = apiResponse.data[0];

  // Process seeds
  if (stockData.seeds) {
    for (const [name, quantityString] of Object.entries(stockData.seeds)) {
      const quantity = parseInt(quantityString) || 0;
      processedItems.set(name, { quantity, category: 'seeds' });
    }
  }

  // Process gear
  if (stockData.gear) {
    for (const [name, quantityString] of Object.entries(stockData.gear)) {
      const quantity = parseInt(quantityString) || 0;
      processedItems.set(name, { quantity, category: 'gear' });
    }
  }

  // Process cosmetic
  if (stockData.cosmetic) {
    for (const [name, quantityString] of Object.entries(stockData.cosmetic)) {
      const quantity = parseInt(quantityString) || 0;
      processedItems.set(name, { quantity, category: 'cosmetic' });
    }
  }

  // Process eggs (individual items, skip "Location")
  if (stockData.eggs && Array.isArray(stockData.eggs)) {
    for (const egg of stockData.eggs) {
      if (egg.name && !egg.name.toLowerCase().includes('location')) {
        // Create individual egg items
        for (let i = 0; i < egg.quantity; i++) {
          const eggKey = `${egg.name}_${i + 1}`;
          processedItems.set(eggKey, { quantity: 1, category: 'eggs', originalName: egg.name });
        }
      }
    }
  }

  console.log(`📊 Processed ${processedItems.size} stock items`);
  return processedItems;
}

// Create mock data as fallback
function createMockStockData() {
  const mockItems = new Map();
  
  // Mock seeds data
  const mockSeeds = {
    "Apple": 3, "Avocado": 2, "Bamboo": 8, "Beanstalk": 1, "Blueberry": 7,
    "Burning Bud": 2, "Cacao": 4, "Carrot": 12, "Coconut": 3, "Daffodil": 6
  };
  
  for (const [name, quantity] of Object.entries(mockSeeds)) {
    mockItems.set(name, { quantity, category: 'seeds' });
  }

  console.log('📊 Using mock stock data');
  return mockItems;
}

// Check for stock changes and send notifications
async function checkStockChanges(checkAvailability = false) {
  if (users.size === 0) {
    console.log('📵 No registered users - skipping stock change check');
    return;
  }

  const checkType = checkAvailability ? 'AVAILABILITY' : 'RESTOCK';
  console.log(`🔍 ${checkType} MONITORING DEBUG: Starting stock change check...`);
  console.log(`🔍 ${checkType} MONITORING DEBUG: Previous stock items: ${previousStockItems.size}`);
  console.log(`🔍 ${checkType} MONITORING DEBUG: Current stock items: ${stockItems.size}`);
  console.log(`🔍 ${checkType} MONITORING DEBUG: Time: ${new Date().toISOString()}`);

  // Get user favorites for debugging
  const userFavorites = [];
  for (const [deviceToken, userData] of users) {
    if (userData.favorite_items) {
      console.log(`🔍 ${checkType} MONITORING DEBUG: User ${deviceToken.substring(0, 10)}... has favorites: ${userData.favorite_items.join(', ')}`);
      userFavorites.push(...userData.favorite_items);
    }
  }
  const uniqueFavorites = [...new Set(userFavorites)];
  console.log(`🔍 ${checkType} MONITORING DEBUG: All user favorites: ${uniqueFavorites.join(', ')}`);

  const restockedItems = [];
  const allChanges = [];

  // Compare current stock with previous stock and debug favorites specifically
  for (const favoriteItem of uniqueFavorites) {
    const currentData = stockItems.get(favoriteItem);
    const previousData = previousStockItems.get(favoriteItem);
    
    const currentQuantity = currentData ? currentData.quantity : 0;
    const previousQuantity = previousData ? previousData.quantity : 0;
    
    // Get item rarity for notification filtering
    const rarity = getItemRarity(favoriteItem);
    const rarityInfo = getRarityInfo(rarity);
    
    // Log ALL changes, not just 0→positive
    if (currentQuantity !== previousQuantity) {
      allChanges.push(`${favoriteItem}: ${previousQuantity} → ${currentQuantity}`);
    }
    
    console.log(`🔍 ${checkType} MONITORING DEBUG: ${favoriteItem}: ${previousQuantity} → ${currentQuantity} [${currentData?.category || 'not found'}] [${rarity} ${rarityInfo.emoji}]`);
    
    // NEW LOGIC: Check if item should send notifications (not Common rarity)
    if (!shouldSendNotificationForItem(favoriteItem)) {
      console.log(`🚫 RARITY FILTER: ${favoriteItem} is ${rarity} rarity - no notifications sent`);
      continue;
    }
    
    // MODIFIED LOGIC: Different conditions based on check type
    let shouldNotify = false;
    
    if (checkAvailability) {
      // Availability check: notify if item is currently in stock
      shouldNotify = currentQuantity > 0;
      if (shouldNotify) {
        console.log(`🎯 AVAILABILITY CHECK: ${favoriteItem} is available (${currentQuantity}) - Adding to notification list`);
      }
    } else {
      // Restock check: notify for ANY item in stock (not just quantity changes)
      // This handles the scenario: user buys item, new identical item restocks
      shouldNotify = currentQuantity > 0;
      if (shouldNotify) {
        console.log(`🎯 STOCK AVAILABLE: ${favoriteItem} is in stock (${currentQuantity}) - Adding to notification list`);
      }
    }
    
    if (shouldNotify) {
      const displayName = currentData.originalName || favoriteItem;
      restockedItems.push({ 
        name: displayName, 
        quantity: currentQuantity,
        previousQuantity: previousQuantity,
        rarity: rarity,
        rarityEmoji: rarityInfo.emoji
      });
    } else if (currentQuantity === 0) {
      console.log(`📉 ${checkType} MONITORING DEBUG: ${favoriteItem} went out of stock (${previousQuantity} → 0)`);
    } else if (currentQuantity === previousQuantity && !checkAvailability) {
      console.log(`💤 ${checkType} MONITORING DEBUG: ${favoriteItem} quantity unchanged (${currentQuantity})`);
    } else if (!shouldNotify && checkAvailability) {
      console.log(`📉 ${checkType} MONITORING DEBUG: ${favoriteItem} out of stock (${currentQuantity})`);
    }
  }

  // Log ALL stock changes for debugging
  console.log(`🔍 ${checkType} MONITORING DEBUG: Total favorite item changes detected: ${allChanges.length}`);
  if (allChanges.length > 0) {
    console.log(`🔍 ${checkType} MONITORING DEBUG: Changes: ${allChanges.join(', ')}`);
  } else {
    console.log(`🔍 ${checkType} MONITORING DEBUG: No changes in favorite items - stock API might be returning identical data`);
  }

  // Also check all other items for debugging
  let totalTransitions = 0;
  let anyItemChanges = 0;
  for (const [itemName, currentData] of stockItems) {
    const previousData = previousStockItems.get(itemName);
    const currentQuantity = currentData.quantity;
    const previousQuantity = previousData ? previousData.quantity : 0;

    if (currentQuantity !== previousQuantity) {
      anyItemChanges++;
    }

    if (previousQuantity === 0 && currentQuantity > 0) {
      totalTransitions++;
      if (!uniqueFavorites.includes(itemName)) {
        console.log(`🔔 ${checkType} MONITORING DEBUG: Non-favorite ${itemName} back in stock: ${previousQuantity} → ${currentQuantity}`);
      }
    }
  }

  console.log(`🔍 ${checkType} MONITORING DEBUG: Total items with ANY quantity changes: ${anyItemChanges}`);
  console.log(`🔍 ${checkType} MONITORING DEBUG: Total 0→positive transitions detected: ${totalTransitions}`);
  console.log(`🔍 ${checkType} MONITORING DEBUG: Favorited items that ${checkAvailability ? 'are available' : 'restocked'}: ${restockedItems.length}`);

  if (anyItemChanges === 0 && !checkAvailability) {
    console.log(`⚠️ ${checkType} MONITORING DEBUG: No stock changes detected - API might be returning cached/identical data`);
  }

  if (restockedItems.length > 0) {
    console.log(`📬 Found ${restockedItems.length} ${checkAvailability ? 'available' : 'restocked'} favorited items, sending notifications...`);
    console.log(`📬 ${checkType} MONITORING DEBUG: ${checkAvailability ? 'Available' : 'Restocked'} items: ${restockedItems.map(item => item.name).join(', ')}`);
    await sendStockNotifications(restockedItems);
  } else {
    console.log(`📵 ${checkType} MONITORING DEBUG: No favorited items ${checkAvailability ? 'available' : 'restocked'} - no notifications sent`);
  }
}

// Check if a seed is premium (Devine, Prismatic) and deserves individual notification
function isPremiumSeed(itemName) {
  // List of known premium seeds (Devine and Prismatic)
  const premiumSeeds = [
    // Devine seeds
    'Pepper',
    
    // Prismatic seeds
    'Ember Lily',
    
    // Add more premium seeds here as needed
    // Format: exact item name from the API
  ];
  
  return premiumSeeds.includes(itemName);
}

// Get the premium type for a seed (Devine or Prismatic)
function getPremiumType(itemName) {
  const devineSeeds = ['Pepper'];
  const prismaticSeeds = ['Ember Lily'];
  
  if (devineSeeds.includes(itemName)) {
    return 'Devine';
  } else if (prismaticSeeds.includes(itemName)) {
    return 'Prismatic';
  }
  
  return 'Premium'; // fallback
}

// NEW RARITY CLASSIFICATION SYSTEM
// Get item rarity based on comprehensive classification
function getItemRarity(itemName) {
  // 🌱 Common - NO notifications (always restocks)
  const commonItems = [
    // Seeds that are always in stock
    'Carrot', 'Strawberry',
    // Gear that is always in stock  
    'Watering Can', 'Cleaning Spray', 'Trowel'
  ];
  
  // 🌿 Uncommon
  const uncommonItems = [
    // Seeds
    'Blueberry', 'Orange Tulip',
    // Gear
    'Recall Wrench'
  ];
  
  // 🌸 Rare
  const rareItems = [
    // Seeds
    'Tomato', 'Daffodil',
    // Gear
    'Basic Sprinkler'
  ];
  
  // 🌟 Legendary
  const legendaryItems = [
    // Seeds
    'Watermelon', 'Pumpkin', 'Apple', 'Bamboo',
    // Gear
    'Advanced Sprinkler'
  ];
  
  // 🔥 Mythical
  const mythicalItems = [
    // Seeds
    'Coconut', 'Cactus', 'Dragon Fruit', 'Mango',
    // Gear
    'Godly Sprinkler', 'Magnifying Glass', 'Tanning Mirror'
  ];
  
  // ✨ Divine
  const divineItems = [
    // Seeds
    'Grape', 'Mushroom', 'Pepper', 'Cacao',
    // Gear
    'Master Sprinkler', 'Favorite Tool', 'Harvest Tool', 'Friendship Pot'
  ];
  
  // 🌈 Prismatic
  const prismaticItems = [
    // Seeds only
    'Beanstalk', 'Ember Lily', 'Sugar Apple', 'Burning Bud'
  ];
  
  // Check rarity
  if (commonItems.includes(itemName)) return 'Common';
  if (uncommonItems.includes(itemName)) return 'Uncommon';
  if (rareItems.includes(itemName)) return 'Rare';
  if (legendaryItems.includes(itemName)) return 'Legendary';
  if (mythicalItems.includes(itemName)) return 'Mythical';
  if (divineItems.includes(itemName)) return 'Divine';
  if (prismaticItems.includes(itemName)) return 'Prismatic';
  
  return 'Unknown'; // fallback for unclassified items
}

// Get rarity emoji and info
function getRarityInfo(rarity) {
  const rarityMap = {
    'Common': { emoji: '🌱', shouldNotify: false, tier: 1 },
    'Uncommon': { emoji: '🌿', shouldNotify: true, tier: 2 },
    'Rare': { emoji: '🌸', shouldNotify: true, tier: 3 },
    'Legendary': { emoji: '🌟', shouldNotify: true, tier: 4 },
    'Mythical': { emoji: '🔥', shouldNotify: true, tier: 5 },
    'Divine': { emoji: '✨', shouldNotify: true, tier: 6 },
    'Prismatic': { emoji: '🌈', shouldNotify: true, tier: 7 },
    'Unknown': { emoji: '❓', shouldNotify: true, tier: 0 }
  };
  
  return rarityMap[rarity] || rarityMap['Unknown'];
}

// NEW: Get emoji for specific items
function getItemEmoji(itemName) {
  const name = itemName.toLowerCase();
  
  // Seeds emojis
  const seedEmojis = {
    'bamboo': '🎋',
    'tomato': '🍅',
    'mango': '🥭',
    'cactus': '🌵',
    'apple': '🍎',
    'grape': '🍇',
    'watermelon': '🍉',
    'strawberry': '🍓',
    'pumpkin': '🎃',
    'pepper': '🌶️',
    'mushroom': '🍄',
    'cacao': '🍫',
    'avocado': '🥑',
    'blueberry': '🫐',
    'carrot': '🥕',
    'coconut': '🥥',
    'beanstalk': '🌱',
    'daffodil': '🌼',
    'orange tulip': '🌷',
    'dragon fruit': '🐉',
    'burning bud': '🔥',
    'ember lily': '🔥',
    'sugar apple': '🌺'
  };
  
  // Gear emojis
  const gearEmojis = {
    'watering can': '🪣',
    'trowel': '🔧',
    'magnifying glass': '🔍',
    'cleaning spray': '🧴',
    'recall wrench': '🔧',
    'basic sprinkler': '💦',
    'advanced sprinkler': '💦',
    'godly sprinkler': '💦',
    'master sprinkler': '💦',
    'tanning mirror': '🪞',
    'favorite tool': '⭐',
    'harvest tool': '🛠️',
    'friendship pot': '🍯'
  };
  
  // Check seeds first
  for (const [seed, emoji] of Object.entries(seedEmojis)) {
    if (name.includes(seed)) {
      return emoji;
    }
  }
  
  // Check gear
  for (const [gear, emoji] of Object.entries(gearEmojis)) {
    if (name.includes(gear)) {
      return emoji;
    }
  }
  
  // Check if it's an egg (all eggs get 🥚 + optional second emoji)
  if (name.includes('egg')) {
    let eggEmoji = '🥚';
    
    // Add specific egg emojis
    if (name.includes('bee')) eggEmoji += '🐝';
    else if (name.includes('bug')) eggEmoji += '🐛';
    else if (name.includes('rare') || name.includes('legendary')) eggEmoji += '✨';
    else if (name.includes('paradise') || name.includes('summer')) eggEmoji += '🌟';
    
    return eggEmoji;
  }
  
  // Fallback emojis by category
  const stockData = stockItems.get(itemName);
  if (stockData) {
    if (stockData.category === 'seeds') return '🌱';
    if (stockData.category === 'gear') return '⚙️';
    if (stockData.category === 'eggs') return '🥚';
    if (stockData.category === 'cosmetic') return '🎨';
  }
  
  return '📦'; // Default fallback
}

// NEW: Get category emoji for titles
function getCategoryEmoji(category) {
  const categoryMap = {
    'seeds': '🌱',
    'gear': '⚙️',
    'eggs': '🥚',
    'cosmetic': '🎨'
  };
  
  return categoryMap[category] || '📦';
}

// NEW: Format item with quantity and emoji
function formatItemWithQuantity(item) {
  const emoji = getItemEmoji(item.name);
  const displayName = item.originalName || item.name;
  return `x${item.quantity} ${displayName} ${emoji}`;
}

// NEW: Format list of items with bullet separators
function formatItemList(items, maxItems = 6) {
  const formattedItems = items.map(item => formatItemWithQuantity(item));
  
  if (formattedItems.length <= maxItems) {
    // Show all items
    return formattedItems.join(' • ');
  } else {
    // Show first maxItems, then "& more"
    const visibleItems = formattedItems.slice(0, maxItems);
    const remainingCount = formattedItems.length - maxItems;
    return visibleItems.join(' • ') + ` & ${remainingCount} more`;
  }
}

// Check if item should send notifications (not Common rarity)
function shouldSendNotificationForItem(itemName) {
  const rarity = getItemRarity(itemName);
  const rarityInfo = getRarityInfo(rarity);
  return rarityInfo.shouldNotify;
}

// Send notifications for restocked items
async function sendStockNotifications(restockedItems) {
  if (!apnProvider) {
    console.log('❌ APNs provider not available');
    return;
  }

  console.log(`🔍 DEBUG: Checking notifications for ${restockedItems.length} restocked items`);
  console.log(`🔍 DEBUG: Restocked items:`, restockedItems.map(item => item.name));
  console.log(`🔍 DEBUG: Total registered users: ${users.size}`);

  const notificationsSent = [];

  // Group notifications by user
  for (const [deviceToken, userData] of users) {
    console.log(`🔍 DEBUG: Checking user ${deviceToken.substring(0, 10)}...`);
    console.log(`🔍 DEBUG: User favorites:`, userData.favorite_items);
    console.log(`🔍 DEBUG: Notifications enabled:`, userData.notification_settings?.enabled);
    
    if (!userData.notification_settings?.enabled) {
      console.log(`❌ DEBUG: Notifications disabled for ${deviceToken.substring(0, 10)}...`);
      continue;
    }

    // Find restocked items that user has favorited and add category info
    const userRestockedItems = restockedItems
      .filter(item => userData.favorite_items?.includes(item.name))
      .map(item => {
        // Get category from stockItems
        const stockData = stockItems.get(item.name);
        return {
          ...item,
          category: stockData?.category || 'unknown',
          rarity: getItemRarity(item.name) // Use new rarity system
        };
      });

    console.log(`🔍 DEBUG: User restocked items:`, userRestockedItems.map(item => `${item.name} [${item.category}${item.rarity === 'Common' ? '' : ' - ' + item.rarity}]`));

    if (userRestockedItems.length === 0) {
      console.log(`📵 DEBUG: No matching favorites for ${deviceToken.substring(0, 10)}...`);
      continue;
    }

    // Separate premium seeds from regular items
    const premiumSeeds = userRestockedItems.filter(item => item.rarity === 'Common'); // Changed to Common rarity
    const regularItems = userRestockedItems.filter(item => item.rarity !== 'Common'); // Changed to not Common rarity

    // Send individual notifications for premium seeds
    for (const premiumSeed of premiumSeeds) {
      try {
        await sendPremiumSeedNotification(deviceToken, premiumSeed);
        if (!notificationsSent.includes(deviceToken.substring(0, 10))) {
          notificationsSent.push(deviceToken.substring(0, 10));
        }
      } catch (error) {
        console.error(`❌ Error sending premium seed notification to ${deviceToken.substring(0, 10)}...:`, error);
      }
    }

    // Group regular items by category and send bulk notifications
    const groupedByCategory = regularItems.reduce((groups, item) => {
      const category = item.category;
      if (!groups[category]) {
        groups[category] = [];
      }
      groups[category].push(item);
      return groups;
    }, {});

    console.log(`🔍 DEBUG: Grouped regular items by category:`, Object.keys(groupedByCategory).map(cat => `${cat}: ${groupedByCategory[cat].length} items`));

    // Send separate notification for each category
    for (const [category, categoryItems] of Object.entries(groupedByCategory)) {
      try {
        await sendCategoryNotification(deviceToken, category, categoryItems);
        if (!notificationsSent.includes(deviceToken.substring(0, 10))) {
          notificationsSent.push(deviceToken.substring(0, 10));
        }
      } catch (error) {
        console.error(`❌ Error sending ${category} notification to ${deviceToken.substring(0, 10)}...:`, error);
      }
    }
  }

  if (notificationsSent.length > 0) {
    console.log(`🎉 Successfully sent notifications to ${notificationsSent.length} users`);
  } else {
    console.log(`📵 DEBUG: No notifications sent - no matching users found`);
  }
}

// Determine item category for banner images
function getItemCategory(itemName) {
  const name = itemName.toLowerCase();
  
  // Gear items
  const gearItems = [
    'watering can', 'trowel', 'recall wrench', 'basic sprinkler', 
    'advanced sprinkler', 'godly sprinkler', 'magnifying glass', 
    'tanning mirror', 'master sprinkler', 'cleaning spray', 
    'favorite tool', 'harvest tool', 'friendship pot'
  ];
  
  // Egg items  
  const eggItems = [
    'common egg', 'uncommon egg', 'rare egg', 'legendary egg',
    'bee egg', 'bug egg', 'common summer egg', 'rare summer egg',
    'paradise summer egg', 'summer egg'
  ];
  
  if (gearItems.some(gear => name.includes(gear))) {
    return 'gear';
  } else if (eggItems.some(egg => name.includes(egg))) {
    return 'eggs';
  } else {
    // Default to seeds for all other items
    return 'seeds';
  }
}

// Get user's sound preference
function getUserSoundPreference(deviceToken) {
  const userData = users.get(deviceToken);
  const soundEnabled = userData?.notification_settings?.sound;
  const selectedSound = userData?.notification_settings?.selected_sound;
  
  // If sound is disabled, return null (no sound)
  if (!soundEnabled) {
    return null;
  }
  
  // If custom sound is selected, return it
  if (selectedSound && selectedSound !== 'default') {
    console.log(`🔊 Using custom sound: ${selectedSound}.mp3 for ${deviceToken.substring(0, 10)}...`);
    return `${selectedSound}.mp3`;
  }
  
  // Default to system default sound
  return 'default';
}

// Send notification for a specific category
async function sendCategoryNotification(deviceToken, category, items) {
  // Create deduplication key based on category and items
  const itemNames = items.map(item => item.name).sort().join(',');
  const deduplicationKey = `${category}-${itemNames}`;
  
  // Check for recent duplicate
  const now = Date.now();
  if (!recentNotifications.has(deviceToken)) {
    recentNotifications.set(deviceToken, new Map());
  }
  
  const userNotifications = recentNotifications.get(deviceToken);
  const lastSent = userNotifications.get(deduplicationKey);
  
  if (lastSent && (now - lastSent) < DEDUPLICATION_WINDOW) {
    const timeSince = Math.floor((now - lastSent) / 1000);
    console.log(`🚫 DUPLICATE BLOCKED: ${category} notification for ${deviceToken.substring(0, 10)}... already sent ${timeSince}s ago`);
    return;
  }
  
  // Clean up old entries (older than 2x deduplication window)
  const cutoffTime = now - (DEDUPLICATION_WINDOW * 2);
  for (const [key, timestamp] of userNotifications.entries()) {
    if (timestamp < cutoffTime) {
      userNotifications.delete(key);
    }
  }
  
  // Record this notification
  userNotifications.set(deduplicationKey, now);
  
  const notification = new apn.Notification();
  
  // NEW UX: Get category emoji and create modern title
  const categoryEmoji = getCategoryEmoji(category);
  const categoryName = category.charAt(0).toUpperCase() + category.slice(1);
  
  // NEW UX: Create clean, emoji-enhanced body
  const itemList = formatItemList(items, 6);
  
  notification.alert = {
    title: `${categoryEmoji} ${categoryName} Restocked!`,
    body: `${itemList} are now in stock.`
  };
  
  notification.payload = {
    items: items,
    category: categoryName,
    type: 'category_stock_alert'
  };

  // Professional notification enhancements
  notification.badge = items.length;
  notification.sound = getUserSoundPreference(deviceToken);
  notification.topic = process.env.APNS_BUNDLE_ID || 'drshpackz.GrowAGarden';
  
  // Add thread identifier for grouping related notifications
  notification.threadId = `stock-${categoryName.toLowerCase()}`;
  
  // Add category for potential action buttons (future enhancement)
  notification.category = `STOCK_ALERT_${categoryName.toUpperCase()}`;

  console.log(`📨 NEW UX: Sending ${categoryName} notification to ${deviceToken.substring(0, 10)}... for items: ${items.map(item => item.name).join(', ')}`);
  console.log(`🔍 DEBUG: APNs Environment: ${process.env.APNS_PRODUCTION === 'true' ? 'Production' : 'Development'}`);
  console.log(`🔍 DEBUG: Bundle ID: ${notification.topic}`);
  console.log(`🔍 DEBUG: Device Token: ${deviceToken.substring(0, 20)}...`);

  const result = await apnProvider.send(notification, [deviceToken]);
  
  if (result.sent.length > 0) {
    console.log(`✅ Sent modern ${categoryName} notification to ${deviceToken.substring(0, 10)}... for ${items.length} items`);
    console.log(`✅ APNs Response: Sent successfully to ${result.sent.length} devices`);
  }
  
  if (result.failed.length > 0) {
    console.log(`❌ Failed to send ${categoryName} notification to ${deviceToken.substring(0, 10)}...: ${result.failed[0].error}`);
    console.log(`❌ DEBUG: Full failure result:`, JSON.stringify(result.failed[0], null, 2));
    console.log(`❌ DEBUG: Error status: ${result.failed[0].status}`);
    console.log(`❌ DEBUG: Error response: ${result.failed[0].response}`);
  }
}

// Send notification for a specific premium seed
async function sendPremiumSeedNotification(deviceToken, item) {
  const notification = new apn.Notification();
  const rarity = getItemRarity(item.name);
  const rarityInfo = getRarityInfo(rarity);
  
  // NEW UX: Professional premium notification formatting
  const itemWithEmoji = formatItemWithQuantity(item);
  
  notification.alert = {
    title: `🌈 Ultra-Rare Find!`,
    body: `${itemWithEmoji} is here—super limited!`
  };
  notification.payload = {
    item_name: item.name,
    quantity: item.quantity,
    rarity: rarity,
    category: getItemCategory(item.name),
    type: 'premium_seed_stock_alert'
  };
  
  // Professional notification enhancements
  notification.badge = 1;
  notification.sound = getUserSoundPreference(deviceToken);
  notification.topic = process.env.APNS_BUNDLE_ID || 'drshpackz.GrowAGarden';
  
  // Group premium notifications together
  notification.threadId = `premium-${rarity.toLowerCase()}`;
  notification.category = `PREMIUM_ALERT_${rarity.toUpperCase()}`;

  console.log(`📨 NEW UX: Sending Ultra-Rare notification to ${deviceToken.substring(0, 10)}... for ${item.name}`);

  const result = await apnProvider.send(notification, [deviceToken]);

  if (result.sent.length > 0) {
    console.log(`✅ Sent modern Ultra-Rare notification to ${deviceToken.substring(0, 10)}... for ${item.name}`);
  }
  if (result.failed.length > 0) {
    console.log(`❌ Failed to send Ultra-Rare notification to ${deviceToken.substring(0, 10)}...: ${result.failed[0].error}`);
    console.log(`❌ DEBUG: Full failure result:`, result.failed[0]);
  }
}

// Auto-fetch stock data every 5 minutes
async function startStockMonitoring() {
  console.log('🚀 Starting stock monitoring...');
  
  // Initial fetch
  await updateStockData();
  
  // Set up interval for every 1 minute (changed from 5 minutes for better testing)
  setInterval(async () => {
    await updateStockData();
  }, 1 * 60 * 1000); // 1 minute for testing (was 5 minutes)
}

// Update stock data and check for changes
async function updateStockData() {
  try {
    // Store previous stock for comparison
    previousStockItems = new Map(stockItems);
    
    // Fetch new stock data
    const newStockData = await fetchRealStockData();
    stockItems = newStockData;
    
    // Check for stock changes and send notifications
    await checkStockChanges(); // false = restock mode with modified logic
    
    console.log(`📊 Stock update complete - tracking ${stockItems.size} items`);
    
  } catch (error) {
    console.error('❌ Error updating stock data:', error);
  }
}

// Initialize APNs and start monitoring
initializeAPNs();
setTimeout(startStockMonitoring, 5000); // Start monitoring after 5 seconds

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    apns_ready: !!apnProvider,
    users_count: users.size,
    stock_items: stockItems.size,
    monitoring_active: true,
    api_url: STOCK_API_URL
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    apns_configured: !!apnProvider,
    users: users.size,
    stock_items: stockItems.size
  });
});

// Get current stock data
app.get('/api/stock', (req, res) => {
  const stockArray = Array.from(stockItems.entries()).map(([name, data]) => ({
    name,
    quantity: data.quantity,
    category: data.category
  }));
  
  res.json({
    success: true,
    stock_items: stockArray,
    total_items: stockItems.size,
    last_updated: new Date().toISOString()
  });
});

// Register device endpoint
app.post('/api/register-device', async (req, res) => {
  try {
    const { device_token, platform, app_version, favorite_items, notification_settings } = req.body;
    
    if (!device_token) {
      return res.status(400).json({ success: false, error: 'Device token required' });
    }

    // Store user data
    const userData = {
      device_token,
      platform: platform || 'ios',
      app_version: app_version || '1.0',
      favorite_items: favorite_items || [],
      notification_settings: notification_settings || { enabled: true },
      registered_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    
    users.set(device_token, userData);
    
    console.log(`✅ Registered device: ${device_token.substring(0, 10)}... with ${favorite_items?.length || 0} favorites`);
    
    res.json({ 
      success: true, 
      message: 'Device registered successfully',
      apns_ready: !!apnProvider,
      favorites_count: favorite_items?.length || 0,
      monitoring_active: true
    });
    
  } catch (error) {
    console.error('❌ Registration error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Manual stock update endpoint (for testing)
app.post('/api/stock-update', async (req, res) => {
  try {
    const { items, api_secret } = req.body;
    
    // Simple API secret check
    const expectedSecret = process.env.API_SECRET || 'growagargen-secret-2025';
    if (api_secret !== expectedSecret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    console.log(`📦 Manual stock update for ${items?.length || 0} items`);
    
    if (!items || !Array.isArray(items)) {
      return res.status(400).json({ error: 'Items array required' });
    }
    
    // Store previous stock for comparison
    previousStockItems = new Map(stockItems);
    
    // Update stock items
    for (const item of items) {
      stockItems.set(item.name, { 
        quantity: item.quantity, 
        category: item.category || 'manual' 
      });
    }
    
    // Check for changes and send notifications
    await checkStockChanges();
    
    res.json({ 
      success: true, 
      message: 'Stock updated and notifications sent',
      processed_items: items.length
    });
    
  } catch (error) {
    console.error('❌ Stock update error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Force refresh stock data
app.post('/api/refresh-stock', async (req, res) => {
  try {
    console.log('🔄 Manual stock refresh requested');
    await updateStockData();
    
    res.json({
      success: true,
      message: 'Stock data refreshed',
      stock_items: stockItems.size,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Debug: manually trigger availability check
app.post('/api/check-availability', async (req, res) => {
  try {
    const { api_secret } = req.body;
    
    // Simple API secret check
    const expectedSecret = process.env.API_SECRET || 'growagargen-secret-2025';
    if (api_secret !== expectedSecret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    console.log('🔍 DEBUG: Manually triggering availability check...');
    
    // Use availability check mode - will notify for all items currently in stock
    await checkStockChanges(true);
    
    res.json({
      success: true,
      message: 'Availability check triggered - notifications sent for items currently in stock',
      stock_items: stockItems.size,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Debug availability check error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Debug: manually trigger automatic monitoring check
app.post('/api/debug-automatic-monitoring', async (req, res) => {
  try {
    const { api_secret } = req.body;
    
    // Simple API secret check
    const expectedSecret = process.env.API_SECRET || 'growagargen-secret-2025';
    if (api_secret !== expectedSecret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    console.log('🔍 DEBUG: Manually triggering automatic monitoring system...');
    
    // Simulate the automatic monitoring process
    await updateStockData();
    
    res.json({
      success: true,
      message: 'Automatic monitoring triggered - check server logs for debug output',
      stock_items: stockItems.size,
      previous_stock_items: previousStockItems.size,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Debug automatic monitoring error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Test notification endpoint
app.post('/api/test-notification', async (req, res) => {
  try {
    const { device_token, message, category } = req.body;
    
    if (!apnProvider) {
      return res.status(500).json({ error: 'APNs not configured' });
    }

    if (!device_token) {
      return res.status(400).json({ error: 'Device token required' });
    }

    // Send test notification with NEW UX format
    const notification = new apn.Notification();
    notification.alert = {
      title: '✅ Notification Test',
      body: message || 'This is a test. You\'ll get real alerts like "x15 Bamboo 🎋" when items restock.'
    };
    
    // Simple payload without image URLs
    notification.payload = {
      category: category || 'Seeds',
      type: 'test_notification'
    };
    
    notification.badge = 1;
    notification.sound = getUserSoundPreference(device_token);
    notification.topic = process.env.APNS_BUNDLE_ID || 'drshpackz.GrowAGarden';
    
    // Professional test notification grouping
    notification.threadId = 'test-notifications';
    notification.category = 'TEST_NOTIFICATION';

    const result = await apnProvider.send(notification, [device_token]);
    
    console.log(`📧 NEW UX: Test notification sent to ${device_token.substring(0, 10)}... with example format`);
    console.log(`🔍 DEBUG: APNs Environment: ${process.env.APNS_PRODUCTION === 'true' ? 'Production' : 'Development'}`);
    console.log(`🔍 DEBUG: Bundle ID: ${notification.topic}`);
    console.log(`🔍 DEBUG: Device Token: ${device_token.substring(0, 20)}...`);
    console.log(`🔍 DEBUG: Notification Title: ${notification.alert.title}`);
    console.log(`🔍 DEBUG: Notification Body: ${notification.alert.body}`);
    
    if (result.sent.length > 0) {
      console.log(`✅ APNs confirms: Test notification delivered to ${result.sent.length} devices`);
    }
    
    if (result.failed.length > 0) {
      console.log(`❌ APNs failed to deliver test notification: ${result.failed[0].error}`);
      console.log(`❌ DEBUG: Full test failure result:`, JSON.stringify(result.failed[0], null, 2));
      console.log(`❌ DEBUG: Error status: ${result.failed[0].status}`);
      console.log(`❌ DEBUG: Error response: ${result.failed[0].response}`);
    }
    
    res.json({ 
      success: true, 
      message: 'Test notification sent with new UX format',
      example_format: 'x15 Bamboo 🎋',
      category: category || 'Seeds',
      apns_environment: process.env.APNS_PRODUCTION === 'true' ? 'Production' : 'Development',
      bundle_id: notification.topic,
      result: {
        sent: result.sent.length,
        failed: result.failed.length,
        failed_details: result.failed.length > 0 ? result.failed[0].error : null
      }
    });
    
  } catch (error) {
    console.error('❌ Test notification error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get stats endpoint
app.get('/api/stats', (req, res) => {
  const stats = {
    total_users: users.size,
    stock_items: stockItems.size,
    apns_configured: !!apnProvider,
    monitoring_active: true,
    api_url: STOCK_API_URL,
    server_time: new Date().toISOString()
  };
  
  res.json(stats);
});

// Debug endpoint to show all users and their favorites (for troubleshooting)
app.get('/api/debug-users-favorites', (req, res) => {
  try {
    const usersInfo = [];
    
    for (const [deviceToken, userData] of users) {
      usersInfo.push({
        device_token_preview: deviceToken.substring(0, 10) + '...',
        favorite_items: userData.favorite_items || [],
        favorites_count: (userData.favorite_items || []).length,
        notification_enabled: userData.notification_settings?.enabled || false,
        registered_at: userData.registered_at,
        updated_at: userData.updated_at
      });
    }
    
    res.json({
      total_users: users.size,
      users: usersInfo,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Debug endpoint to check user data
app.get('/api/debug-user/:deviceToken', (req, res) => {
  try {
    const deviceToken = req.params.deviceToken;
    const userData = users.get(deviceToken);
    
    if (!userData) {
      return res.json({
        found: false,
        message: `Device token ${deviceToken.substring(0, 10)}... not found`,
        total_users: users.size
      });
    }
    
    res.json({
      found: true,
      device_token_preview: deviceToken.substring(0, 10) + '...',
      favorite_items: userData.favorite_items || [],
      notification_settings: userData.notification_settings || {},
      registered_at: userData.registered_at,
      updated_at: userData.updated_at
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Clear notification deduplication cache (for testing)
app.post('/api/clear-notification-cache', (req, res) => {
  try {
    const { api_secret } = req.body;
    
    // Simple API secret check
    const expectedSecret = process.env.API_SECRET || 'growagargen-secret-2025';
    if (api_secret !== expectedSecret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    recentNotifications.clear();
    console.log('🧹 Cleared notification deduplication cache');
    
    res.json({
      success: true,
      message: 'Notification deduplication cache cleared',
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Clear cache error:', error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 GAG Stocks server running on port ${PORT}`);
  console.log(`📱 APNs ready: ${!!apnProvider}`);
  console.log(`🔗 Monitoring stock from: ${STOCK_API_URL}`);
  console.log(`🔑 Team ID: ${process.env.APNS_TEAM_ID || '8U376J9B6U'}`);
  console.log(`🆔 Key ID: ${process.env.APNS_KEY_ID || 'F9J436633X'}`);
}); 

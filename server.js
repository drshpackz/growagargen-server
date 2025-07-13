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

// Weather data storage
let weatherData = new Map(); // weather_id -> weather data
let previousWeatherData = new Map(); // For change detection

// Data freshness tracking
let lastStockUpdateTime = null;
let lastWeatherUpdateTime = null;
let lastAPICallTime = null;
let apiCallCount = 0;
let successfulAPICallCount = 0;

// New v2 API endpoints
const STOCK_API_URL = 'https://api.joshlei.com/v2/growagarden/stock';
const WEATHER_API_URL = 'https://api.joshlei.com/v2/growagarden/weather';
const ITEM_INFO_API_URL = 'https://api.joshlei.com/v2/growagarden/info';

// Cache for item info to avoid repeated API calls
let itemInfoCache = new Map(); // item_id -> item_info
const ITEM_INFO_CACHE_DURATION = 60 * 60 * 1000; // 1 hour

// Parse environment variables for always-shown items
function parseAlwaysShownItems() {
  const seedItems = (process.env.SEED_SHOP_ITEM_ID || '').split(',').map(id => id.trim()).filter(id => id);
  const gearItems = (process.env.GEAR_SHOP_ITEM_ID || '').split(',').map(id => id.trim()).filter(id => id);
  const eggItems = (process.env.EGG_SHOP_ITEM_ID || '').split(',').map(id => id.trim()).filter(id => id);
  const cosmeticItems = (process.env.COSMETICS_SHOP_ITEM_ID || '').split(',').map(id => id.trim()).filter(id => id);
  
  return {
    seeds: seedItems,
    gear: gearItems,
    eggs: eggItems,
    cosmetic: cosmeticItems
  };
}

// Fetch always-shown items and add them to processed items if not already present
async function addAlwaysShownItems(processedItems) {
  const alwaysShownItems = parseAlwaysShownItems();
  
  console.log(`📋 Always-shown items configured:`);
  console.log(`   Seeds: ${alwaysShownItems.seeds.length} items (${alwaysShownItems.seeds.join(', ')})`);
  console.log(`   Gear: ${alwaysShownItems.gear.length} items (${alwaysShownItems.gear.join(', ')})`);
  console.log(`   Eggs: ${alwaysShownItems.eggs.length} items (${alwaysShownItems.eggs.join(', ')})`);
  console.log(`   Cosmetic: ${alwaysShownItems.cosmetic.length} items (${alwaysShownItems.cosmetic.join(', ')})`);
  
  // Process each category
  for (const [category, itemIds] of Object.entries(alwaysShownItems)) {
    for (const itemId of itemIds) {
      try {
        // Fetch item info from the API
        const itemInfo = await fetchItemInfo(itemId);
        
        if (!itemInfo) {
          console.log(`⚠️ Could not fetch info for always-shown item: ${itemId}`);
          continue;
        }
        
        // Check if item is already in processed items (from current stock)
        const existingItem = processedItems.get(itemInfo.display_name);
        
        if (existingItem) {
          console.log(`✅ Always-shown item ${itemInfo.display_name} already in stock (qty: ${existingItem.quantity})`);
          continue;
        }
        
        // Add the item with quantity 0 (out of stock but available for favoriting)
        const itemData = {
          quantity: 0,
          category: category,
          itemId: itemInfo.item_id,
          displayName: itemInfo.display_name,
          icon: itemInfo.icon,
          startDate: null,
          endDate: null,
          rarity: itemInfo.rarity || null
        };
        
        // For eggs, also add originalName for compatibility
        if (category === 'eggs') {
          itemData.originalName = itemInfo.display_name;
        }
        
        processedItems.set(itemInfo.display_name, itemData);
        console.log(`📦 Added always-shown item: ${itemInfo.display_name} [${category}] (out of stock, available for favorites)`);
        
      } catch (error) {
        console.error(`❌ Error processing always-shown item ${itemId}:`, error.message);
      }
    }
  }
}

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

// Fetch real stock data from the v2 API
async function fetchRealStockData() {
  try {
    console.log('🔄 Fetching stock data from v2 API...');
    
    // Track API call metrics
    lastAPICallTime = new Date();
    apiCallCount++;
    
    const apiKey = process.env.JSTUDIO_API_KEY;
    if (!apiKey) {
      console.log('⚠️ No API key configured, using mock data');
      return createMockStockData();
    }
    
    const response = await fetch(STOCK_API_URL, {
      headers: {
        'jstudio-key': apiKey,
        'Accept': 'application/json',
        'User-Agent': 'GrowAGarden-StockBot/1.0'
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
    console.log('✅ Successfully fetched v2 stock data');
    
    // Track successful API call
    successfulAPICallCount++;
    lastStockUpdateTime = new Date();
    
    console.log('🔍 Validating image URLs before processing...');
    return await processStockData(data);
    
  } catch (error) {
    console.error('❌ Error fetching v2 stock data:', error.message);
    
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

// Fetch item info from the v2 API
async function fetchItemInfo(itemId) {
  try {
    // Check cache first
    const cached = itemInfoCache.get(itemId);
    if (cached && (Date.now() - cached.lastFetched) < ITEM_INFO_CACHE_DURATION) {
      return cached.data;
    }
    
    const apiKey = process.env.JSTUDIO_API_KEY;
    if (!apiKey) {
      console.log(`⚠️ No API key configured, skipping item info for ${itemId}`);
      return null;
    }
    
    const response = await fetch(`${ITEM_INFO_API_URL}/${itemId}`, {
      headers: {
        'jstudio-key': apiKey,
        'Accept': 'application/json',
        'User-Agent': 'GrowAGarden-StockBot/1.0'
      }
    });

    if (!response.ok) {
      if (response.status === 404) {
        console.log(`📝 Item info not found for: ${itemId}`);
      } else {
        console.log(`⚠️ Item info API returned ${response.status} for ${itemId}`);
      }
      return null;
    }

    const data = await response.json();
    
    // Cache the result
    itemInfoCache.set(itemId, {
      data: data,
      lastFetched: Date.now()
    });
    
    console.log(`📝 Fetched item info for: ${itemId} (rarity: ${data.rarity || 'none'})`);
    return data;
    
  } catch (error) {
    console.error(`❌ Error fetching item info for ${itemId}:`, error.message);
    return null;
  }
}

// Fetch weather data from the v2 API
async function fetchWeatherData() {
  try {
    console.log('🌦️ Fetching weather data from v2 API...');
    
    const apiKey = process.env.JSTUDIO_API_KEY;
    if (!apiKey) {
      console.log('⚠️ No API key configured, skipping weather data');
      return new Map();
    }
    
    const response = await fetch(WEATHER_API_URL, {
      headers: {
        'jstudio-key': apiKey,
        'Accept': 'application/json',
        'User-Agent': 'GrowAGarden-StockBot/1.0'
      }
    });

    if (!response.ok) {
      console.log(`⚠️ Weather API returned ${response.status}, skipping weather data`);
      return new Map();
    }

    const data = await response.json();
    console.log('✅ Successfully fetched weather data');
    
    // Track successful weather update
    lastWeatherUpdateTime = new Date();
    
    console.log('🔍 Validating weather icon URLs...');
    return await processWeatherData(data);
    
  } catch (error) {
    console.error('❌ Error fetching weather data:', error.message);
    return new Map();
  }
}

// Image validation cache to avoid repeated checks
let imageValidationCache = new Map(); // URL -> { isValid: boolean, lastChecked: timestamp }
const IMAGE_CACHE_DURATION = 60 * 60 * 1000; // 1 hour

// Function to validate if an image URL returns a valid image (not 404 or logotype)
async function validateImageURL(imageUrl) {
  if (!imageUrl) return false;
  
  // Check cache first
  const cached = imageValidationCache.get(imageUrl);
  if (cached && (Date.now() - cached.lastChecked) < IMAGE_CACHE_DURATION) {
    return cached.isValid;
  }
  
  try {
    const response = await fetch(imageUrl, { 
      method: 'HEAD',
      timeout: 5000 // 5 second timeout
    });
    
    // Check basic validity
    const isHttpOk = response.ok;
    const isImageType = response.headers.get('content-type')?.startsWith('image/');
    const contentLength = parseInt(response.headers.get('content-length') || '0');
    
    // Reject very small images (likely logotype) - minimum 1KB
    const isValidSize = contentLength > 1024 || contentLength === 0; // 0 means no content-length header
    
    const isValid = isHttpOk && isImageType && isValidSize;
    
    // Cache the result
    imageValidationCache.set(imageUrl, {
      isValid: isValid,
      lastChecked: Date.now()
    });
    
    if (!isValid) {
      const reason = !isHttpOk ? `HTTP ${response.status}` : 
                    !isImageType ? 'not image type' : 
                    !isValidSize ? `too small (${contentLength}b)` : 'unknown';
      console.log(`❌ Invalid image URL: ${imageUrl} (${reason})`);
    }
    
    return isValid;
  } catch (error) {
    console.log(`❌ Error validating image URL ${imageUrl}: ${error.message}`);
    
    // Cache failed validation
    imageValidationCache.set(imageUrl, {
      isValid: false,
      lastChecked: Date.now()
    });
    
    return false;
  }
}

// Process stock data from v2 API into our format
async function processStockData(apiResponse) {
  const processedItems = new Map();
  
  if (!apiResponse) {
    console.log('⚠️ Invalid API response');
    return processedItems; // Return empty map instead of hardcoded catalog
  }

  console.log('🔄 Processing items dynamically from API (no hardcoded lists)...');

  // Process seeds from v2 API
  if (apiResponse.seed_stock && Array.isArray(apiResponse.seed_stock)) {
    for (const item of apiResponse.seed_stock) {
      // Validate image URL before including the item
      const hasValidImage = await validateImageURL(item.icon);
      
      // Fetch item info to get rarity (if available)
      let itemInfo = null;
      if (item.item_id) {
        itemInfo = await fetchItemInfo(item.item_id);
      }
      
      const itemData = {
        quantity: item.quantity || 0,
        category: 'seeds',
        itemId: item.item_id,
        displayName: item.display_name,
        icon: hasValidImage ? item.icon : null, // Only include valid image URLs
        startDate: item.start_date_unix,
        endDate: item.end_date_unix,
        rarity: itemInfo?.rarity || null  // NEW: API-provided rarity
      };
      
      processedItems.set(item.display_name, itemData);
      console.log(`🌱 Processed seed: ${item.display_name} (qty: ${item.quantity}, rarity: ${itemData.rarity || 'unknown'})`);
    }
  }

  // Process gear from v2 API
  if (apiResponse.gear_stock && Array.isArray(apiResponse.gear_stock)) {
    for (const item of apiResponse.gear_stock) {
      // Validate image URL before including the item
      const hasValidImage = await validateImageURL(item.icon);
      
      // Fetch item info to get rarity (if available)
      let itemInfo = null;
      if (item.item_id) {
        itemInfo = await fetchItemInfo(item.item_id);
      }
      
      const itemData = {
        quantity: item.quantity || 0,
        category: 'gear',
        itemId: item.item_id,
        displayName: item.display_name,
        icon: hasValidImage ? item.icon : null, // Only include valid image URLs
        startDate: item.start_date_unix,
        endDate: item.end_date_unix,
        rarity: itemInfo?.rarity || null  // NEW: API-provided rarity
      };
      
      processedItems.set(item.display_name, itemData);
      console.log(`⚙️ Processed gear: ${item.display_name} (qty: ${item.quantity}, rarity: ${itemData.rarity || 'unknown'})`);
    }
  }

  // Process cosmetic from v2 API
  if (apiResponse.cosmetic_stock && Array.isArray(apiResponse.cosmetic_stock)) {
    for (const item of apiResponse.cosmetic_stock) {
      // Validate image URL before including the item
      const hasValidImage = await validateImageURL(item.icon);
      
      // Fetch item info to get rarity (if available)
      let itemInfo = null;
      if (item.item_id) {
        itemInfo = await fetchItemInfo(item.item_id);
      }
      
      const itemData = {
        quantity: item.quantity || 0,
        category: 'cosmetic',
        itemId: item.item_id,
        displayName: item.display_name,
        icon: hasValidImage ? item.icon : null, // Only include valid image URLs
        startDate: item.start_date_unix,
        endDate: item.end_date_unix,
        rarity: itemInfo?.rarity || null  // NEW: API-provided rarity
      };
      
      processedItems.set(item.display_name, itemData);
      console.log(`🎨 Processed cosmetic: ${item.display_name} (qty: ${item.quantity}, rarity: ${itemData.rarity || 'unknown'})`);
    }
  }

  // Process eggs from v2 API - FIXED: Return proper quantities instead of individual items
  if (apiResponse.egg_stock && Array.isArray(apiResponse.egg_stock)) {
    for (const item of apiResponse.egg_stock) {
      if (item.display_name && !item.display_name.toLowerCase().includes('location')) {
        // Validate image URL before including the item
        const hasValidImage = await validateImageURL(item.icon);
        
        // Check if this egg type already exists
        const existingEgg = processedItems.get(item.display_name);
        
        // Fetch item info to get rarity (if available)
        let itemInfo = null;
        if (item.item_id) {
          itemInfo = await fetchItemInfo(item.item_id);
        }
        
        if (existingEgg) {
          // Aggregate quantities for duplicate egg types
          existingEgg.quantity += (item.quantity || 0);
          // Update icon if this instance has a valid image
          if (hasValidImage) {
            existingEgg.icon = item.icon;
          }
          // Update rarity if available
          if (itemInfo?.rarity) {
            existingEgg.rarity = itemInfo.rarity;
          }
          console.log(`🥚 Aggregated ${item.display_name}: ${existingEgg.quantity} total (rarity: ${existingEgg.rarity || 'unknown'})`);
        } else {
          const itemData = {
            quantity: item.quantity || 0,
            category: 'eggs',
            itemId: item.item_id,
            displayName: item.display_name,
            originalName: item.display_name,
            icon: hasValidImage ? item.icon : null, // Only include valid image URLs
            startDate: item.start_date_unix,
            endDate: item.end_date_unix,
            rarity: itemInfo?.rarity || null  // NEW: API-provided rarity
          };
          
          processedItems.set(item.display_name, itemData);
          console.log(`🥚 Processed egg: ${item.display_name} (qty: ${item.quantity}, rarity: ${itemData.rarity || 'unknown'})`);
        }
      }
    }
  }

  console.log(`📊 Processed ${processedItems.size} total items dynamically from API`);
  console.log(`📊 Breakdown: ${Array.from(processedItems.values()).filter(i => i.category === 'seeds').length} seeds, ${Array.from(processedItems.values()).filter(i => i.category === 'gear').length} gear, ${Array.from(processedItems.values()).filter(i => i.category === 'eggs').length} eggs, ${Array.from(processedItems.values()).filter(i => i.category === 'cosmetic').length} cosmetic`);
  
  // Add always-shown items from environment variables (out of stock but available for favoriting)
  await addAlwaysShownItems(processedItems);
  
  const finalCount = processedItems.size;
  console.log(`📊 Final item count: ${finalCount} items (includes always-shown out-of-stock items)`);
  console.log(`📊 Final breakdown: ${Array.from(processedItems.values()).filter(i => i.category === 'seeds').length} seeds, ${Array.from(processedItems.values()).filter(i => i.category === 'gear').length} gear, ${Array.from(processedItems.values()).filter(i => i.category === 'eggs').length} eggs, ${Array.from(processedItems.values()).filter(i => i.category === 'cosmetic').length} cosmetic`);
  
  return processedItems;
}

// Process weather data from v2 API
async function processWeatherData(apiResponse) {
  const processedWeather = new Map();
  
  if (!apiResponse || !apiResponse.weather || !Array.isArray(apiResponse.weather)) {
    console.log('⚠️ No weather data in API response');
    return processedWeather;
  }

  for (const weather of apiResponse.weather) {
    // Validate weather icon URL before including it
    const hasValidIcon = await validateImageURL(weather.icon);
    
    const weatherData = {
      weatherId: weather.weather_id,
      weatherName: weather.weather_name,
      active: weather.active,
      duration: weather.duration,
      startDuration: weather.start_duration_unix,
      endDuration: weather.end_duration_unix,
      icon: hasValidIcon ? weather.icon : null // Only include valid weather icon URLs
    };
    
    processedWeather.set(weather.weather_id, weatherData);
    
    if (!hasValidIcon && weather.icon) {
      console.log(`🚫 Weather icon invalid: ${weather.weather_name} - ${weather.icon}`);
    }
  }

  console.log(`🌦️ Processed ${processedWeather.size} weather events`);
  return processedWeather;
}

// Create mock data as fallback
function createMockStockData() {
  const mockItems = new Map();
  
  // Mock seeds data with some realistic quantities
  const mockSeeds = {
    "Carrot": 12, "Strawberry": 9, "Blueberry": 7, "Orange Tulip": 8, "Tomato": 5, 
    "Corn": 6, "Daffodil": 6, "Watermelon": 6, "Pumpkin": 4, "Apple": 3, 
    "Bamboo": 8, "Coconut": 3, "Cactus": 2, "Dragon Fruit": 1, "Mango": 4, 
    "Grape": 5, "Mushroom": 2, "Pepper": 3, "Cacao": 4, "Beanstalk": 1, 
    "Ember Lily": 2, "Sugar Apple": 3, "Burning Bud": 2, "Avocado": 2
  };
  
  // Mock gear data
  const mockGear = {
    "Watering Can": 4, "Trowel": 2, "Recall Wrench": 1, "Basic Sprinkler": 2, 
    "Advanced Sprinkler": 1, "Godly Sprinkler": 0, "Magnifying Glass": 1, 
    "Tanning Mirror": 0, "Master Sprinkler": 0, "Cleaning Spray": 3, 
    "Favorite Tool": 0, "Harvest Tool": 0, "Friendship Pot": 0
  };
  
  // Mock eggs data
  const mockEggs = {
    "Common Egg": 5, "Uncommon Egg": 3, "Rare Egg": 1, "Legendary Egg": 1, 
    "Bee Egg": 3, "Bug Egg": 2, "Common Summer Egg": 4, "Rare Summer Egg": 1, 
    "Paradise Summer Egg": 0, "Paradise Egg": 1
  };
  
  // Add all seeds (with mock quantities)
  for (const [name, quantity] of Object.entries(mockSeeds)) {
    mockItems.set(name, { 
      quantity, 
      category: 'seeds',
      itemId: null,
      displayName: name,
      icon: null,
      startDate: null,
      endDate: null
    });
  }
  
  // Add all gear (with mock quantities)
  for (const [name, quantity] of Object.entries(mockGear)) {
    mockItems.set(name, { 
      quantity, 
      category: 'gear',
      itemId: null,
      displayName: name,
      icon: null,
      startDate: null,
      endDate: null
    });
  }
  
  // Add all eggs (with mock quantities)
  for (const [name, quantity] of Object.entries(mockEggs)) {
    mockItems.set(name, { 
      quantity, 
      category: 'eggs',
      itemId: null,
      displayName: name,
      originalName: name,
      icon: null,
      startDate: null,
      endDate: null
    });
  }

  console.log(`📊 Mock data created with ${mockItems.size} total items (including out-of-stock)`);
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

// Check for weather changes and send notifications
async function checkWeatherChanges() {
  if (users.size === 0) {
    console.log('📵 No registered users - skipping weather change check');
    return;
  }

  console.log(`🌦️ WEATHER MONITORING DEBUG: Starting weather change check...`);
  console.log(`🌦️ WEATHER MONITORING DEBUG: Previous weather events: ${previousWeatherData.size}`);
  console.log(`🌦️ WEATHER MONITORING DEBUG: Current weather events: ${weatherData.size}`);

  const weatherChanges = [];

  // Compare current weather with previous weather
  for (const [weatherId, currentWeather] of weatherData) {
    const previousWeather = previousWeatherData.get(weatherId);
    
    // Check if weather status changed
    if (!previousWeather || previousWeather.active !== currentWeather.active) {
      const statusChange = {
        weatherId: weatherId,
        weatherName: currentWeather.weatherName,
        isActive: currentWeather.active,
        wasActive: previousWeather ? previousWeather.active : false,
        icon: currentWeather.icon,
        duration: currentWeather.duration
      };
      
      weatherChanges.push(statusChange);
      
      console.log(`🌦️ WEATHER CHANGE: ${currentWeather.weatherName} ${currentWeather.active ? 'started' : 'ended'}`);
    }
  }

  // Check for weather events that ended (no longer in current data)
  for (const [weatherId, previousWeather] of previousWeatherData) {
    if (!weatherData.has(weatherId) && previousWeather.active) {
      const statusChange = {
        weatherId: weatherId,
        weatherName: previousWeather.weatherName,
        isActive: false,
        wasActive: true,
        icon: previousWeather.icon,
        duration: 0
      };
      
      weatherChanges.push(statusChange);
      console.log(`🌦️ WEATHER ENDED: ${previousWeather.weatherName} is no longer active`);
    }
  }

  if (weatherChanges.length > 0) {
    console.log(`🌦️ Found ${weatherChanges.length} weather changes, sending notifications...`);
    await sendWeatherNotifications(weatherChanges);
  } else {
    console.log(`🌦️ No weather changes detected`);
  }
}

// Send notifications for weather changes
async function sendWeatherNotifications(weatherChanges) {
  if (!apnProvider) {
    console.log('❌ APNs provider not available for weather notifications');
    return;
  }

  const notificationsSent = [];

  // Send weather notifications to all users (weather affects everyone)
  for (const [deviceToken, userData] of users) {
    if (!userData.notification_settings?.enabled) {
      console.log(`❌ Notifications disabled for ${deviceToken.substring(0, 10)}...`);
      continue;
    }

    // Group weather changes by active/inactive
    const activeWeather = weatherChanges.filter(w => w.isActive);
    const inactiveWeather = weatherChanges.filter(w => !w.isActive);

    // Send notification for active weather events
    if (activeWeather.length > 0) {
      try {
        await sendWeatherNotification(deviceToken, activeWeather, 'active');
        if (!notificationsSent.includes(deviceToken.substring(0, 10))) {
          notificationsSent.push(deviceToken.substring(0, 10));
        }
      } catch (error) {
        console.error(`❌ Error sending active weather notification to ${deviceToken.substring(0, 10)}...:`, error);
      }
    }

    // Send notification for ended weather events (optional, less important)
    if (inactiveWeather.length > 0) {
      try {
        await sendWeatherNotification(deviceToken, inactiveWeather, 'ended');
        if (!notificationsSent.includes(deviceToken.substring(0, 10))) {
          notificationsSent.push(deviceToken.substring(0, 10));
        }
      } catch (error) {
        console.error(`❌ Error sending ended weather notification to ${deviceToken.substring(0, 10)}...:`, error);
      }
    }
  }

  if (notificationsSent.length > 0) {
    console.log(`🌦️ Successfully sent weather notifications to ${notificationsSent.length} users`);
  } else {
    console.log(`📵 No weather notifications sent`);
  }
}

// Send individual weather notification
async function sendWeatherNotification(deviceToken, weatherEvents, type) {
  const notification = new apn.Notification();
  
  const weatherNames = weatherEvents.map(w => w.weatherName);
  const isActive = type === 'active';
  
  if (weatherEvents.length === 1) {
    // Single weather event
    const weather = weatherEvents[0];
    notification.alert = {
      title: `🌦️ Weather ${isActive ? 'Started' : 'Ended'}!`,
      body: `${weather.weatherName} is ${isActive ? 'now active' : 'no longer active'} in your garden.`
    };
  } else {
    // Multiple weather events
    notification.alert = {
      title: `🌦️ Weather ${isActive ? 'Changes' : 'Updates'}!`,
      body: `${weatherNames.join(', ')} ${isActive ? 'are now active' : 'have ended'} in your garden.`
    };
  }
  
  notification.payload = {
    weather_events: weatherEvents,
    type: `weather_${type}`,
    category: 'weather'
  };
  
  notification.badge = weatherEvents.length;
  notification.sound = getUserSoundPreference(deviceToken);
  notification.topic = process.env.APNS_BUNDLE_ID || 'drshpackz.GrowAGarden';
  
  // Group weather notifications together
  notification.threadId = `weather-${type}`;
  notification.category = `WEATHER_${type.toUpperCase()}`;

  console.log(`🌦️ Sending weather notification to ${deviceToken.substring(0, 10)}... for ${weatherEvents.length} events`);

  const result = await apnProvider.send(notification, [deviceToken]);
  
  if (result.sent.length > 0) {
    console.log(`✅ Sent weather notification to ${deviceToken.substring(0, 10)}...`);
  }
  
  if (result.failed.length > 0) {
    console.log(`❌ Failed to send weather notification to ${deviceToken.substring(0, 10)}...: ${result.failed[0].error}`);
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
  
  // 🆕 NEW: Log unknown items for future classification
  console.log(`⚠️ UNKNOWN ITEM RARITY: '${itemName}' - defaulting to Rare (will send notifications)`);
  console.log(`💡 Consider adding '${itemName}' to appropriate rarity tier in server.js getItemRarity()`);
  
  return 'Rare'; // Default to Rare for new items so they get notifications
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
    'Prismatic': { emoji: '🌈', shouldNotify: true, tier: 7 }
  };
  
  // Default to Rare tier for any unclassified items (new items from game updates)
  return rarityMap[rarity] || rarityMap['Rare'];
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
  
  // Set up interval for every 30 seconds for maximum freshness
  setInterval(async () => {
    await updateStockData();
  }, 30 * 1000); // 30 seconds for maximum freshness
}

// Update stock data and weather data, check for changes
async function updateStockData() {
  try {
    // Store previous data for comparison
    previousStockItems = new Map(stockItems);
    previousWeatherData = new Map(weatherData);
    
    // Fetch new stock and weather data in parallel
    const [newStockData, newWeatherData] = await Promise.all([
      fetchRealStockData(),
      fetchWeatherData()
    ]);
    
    stockItems = newStockData;
    weatherData = newWeatherData;
    
    // Check for stock changes and send notifications
    await checkStockChanges(); // false = restock mode with modified logic
    
    // Check for weather changes and send notifications
    await checkWeatherChanges();
    
    console.log(`📊 Update complete - tracking ${stockItems.size} items, ${weatherData.size} weather events`);
    
  } catch (error) {
    console.error('❌ Error updating stock/weather data:', error);
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
    weather_events: weatherData.size,
    monitoring_active: true,
    api_url: STOCK_API_URL,
    weather_api_url: WEATHER_API_URL
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    apns_configured: !!apnProvider,
    users: users.size,
    stock_items: stockItems.size,
    weather_events: weatherData.size,
    api_version: 'v2'
  });
});

// Get current stock data with v2 API enhancements
app.get('/api/stock', (req, res) => {
  const now = new Date();
  const stockArray = Array.from(stockItems.entries()).map(([name, data]) => ({
    name,
    display_name: data.displayName || name,
    quantity: data.quantity,
    category: data.category,
    item_id: data.itemId,
    icon: data.icon,
    start_date: data.startDate,
    end_date: data.endDate,
    rarity: data.rarity  // NEW: Include API-provided rarity
  }));
  
  res.json({
    success: true,
    stock_items: stockArray,
    total_items: stockItems.size,
    last_updated: now.toISOString(),
    api_version: 'v2',
    timing_data: {
      server_time_utc: now.toISOString(),
      data_freshness: lastStockUpdateTime ? {
        last_update_utc: lastStockUpdateTime.toISOString(),
        seconds_ago: Math.floor((now - lastStockUpdateTime) / 1000),
        freshness_rating: getFreshnessRating(now, lastStockUpdateTime)
      } : null,
      next_update_in_seconds: 30 - (Math.floor((now - (lastAPICallTime || now)) / 1000) % 30)
    }
  });
});

// Get current weather data
app.get('/api/weather', (req, res) => {
  const weatherArray = Array.from(weatherData.entries()).map(([weatherId, data]) => ({
    weather_id: weatherId,
    weather_name: data.weatherName,
    active: data.active,
    duration: data.duration,
    start_duration: data.startDuration,
    end_duration: data.endDuration,
    icon: data.icon
  }));
  
  res.json({
    success: true,
    weather_events: weatherArray,
    total_events: weatherData.size,
    last_updated: new Date().toISOString(),
    api_version: 'v2'
  });
});

// Get combined stock and weather data
app.get('/api/game-data', (req, res) => {
  const stockArray = Array.from(stockItems.entries()).map(([name, data]) => ({
    name,
    display_name: data.displayName || name,
    quantity: data.quantity,
    category: data.category,
    item_id: data.itemId,
    icon: data.icon,
    start_date: data.startDate,
    end_date: data.endDate
  }));
  
  const weatherArray = Array.from(weatherData.entries()).map(([weatherId, data]) => ({
    weather_id: weatherId,
    weather_name: data.weatherName,
    active: data.active,
    duration: data.duration,
    start_duration: data.startDuration,
    end_duration: data.endDuration,
    icon: data.icon
  }));
  
  res.json({
    success: true,
    stock_items: stockArray,
    weather_events: weatherArray,
    totals: {
      stock_items: stockItems.size,
      weather_events: weatherData.size
    },
    last_updated: new Date().toISOString(),
    api_version: 'v2'
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

// Webhook endpoint for real-time updates from joshlei.com API
app.post('/api/webhook/stock-update', async (req, res) => {
  try {
    const { webhook_secret, event_type, data } = req.body;
    
    // Verify webhook secret
    const expectedSecret = process.env.WEBHOOK_SECRET || process.env.API_SECRET || 'growagargen-secret-2025';
    if (webhook_secret !== expectedSecret) {
      return res.status(401).json({ error: 'Unauthorized webhook' });
    }
    
    console.log(`🔥 REAL-TIME WEBHOOK: ${event_type} received`);
    console.log(`🔥 WEBHOOK DATA:`, JSON.stringify(data, null, 2));
    
    // Trigger immediate stock update
    await updateStockData();
    
    res.json({
      success: true,
      message: `Webhook ${event_type} processed successfully`,
      timestamp: new Date().toISOString(),
      processed_immediately: true
    });
    
  } catch (error) {
    console.error('❌ Webhook processing error:', error);
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
    
    let responseData = {
      success: true, 
      message: 'Test notification sent with new UX format',
      example_format: 'x15 Bamboo 🎋',
      category: category || 'Seeds',
      apns_environment: process.env.APNS_PRODUCTION === 'true' ? 'Production' : 'Development',
      bundle_id: notification.topic,
      result: {
        sent: 0,
        failed: 0,
        failed_details: null
      }
    };
    
    if (result && result.sent && result.sent.length > 0) {
      console.log(`✅ APNs confirms: Test notification delivered to ${result.sent.length} devices`);
      responseData.result.sent = result.sent.length;
    }
    
    if (result && result.failed && result.failed.length > 0) {
      console.log(`❌ APNs failed to deliver test notification: ${result.failed[0].error || 'Unknown error'}`);
      console.log(`❌ DEBUG: Full test failure result:`, JSON.stringify(result.failed[0], null, 2));
      if (result.failed[0].status) {
        console.log(`❌ DEBUG: Error status: ${result.failed[0].status}`);
      }
      if (result.failed[0].response) {
        console.log(`❌ DEBUG: Error response: ${result.failed[0].response}`);
      }
      responseData.result.failed = result.failed.length;
      responseData.result.failed_details = result.failed[0].error || 'Unknown APNs error';
    }
    
    res.json(responseData);
    
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
    weather_events: weatherData.size,
    apns_configured: !!apnProvider,
    monitoring_active: true,
    api_version: 'v2',
    api_endpoints: {
      stock: STOCK_API_URL,
      weather: WEATHER_API_URL,
      info: ITEM_INFO_API_URL
    },
    server_time: new Date().toISOString()
  };
  
  res.json(stats);
});

// Data freshness endpoint - shows how fresh the current data is
app.get('/api/data-freshness', (req, res) => {
  const now = new Date();
  
  const freshness = {
    server_time: now.toISOString(),
    monitoring_interval_seconds: 30,
    last_api_call: lastAPICallTime ? {
      timestamp: lastAPICallTime.toISOString(),
      seconds_ago: Math.floor((now - lastAPICallTime) / 1000)
    } : null,
    stock_data: {
      last_update: lastStockUpdateTime ? {
        timestamp: lastStockUpdateTime.toISOString(),
        seconds_ago: Math.floor((now - lastStockUpdateTime) / 1000),
        freshness_rating: getFreshnessRating(now, lastStockUpdateTime)
      } : null,
      items_count: stockItems.size
    },
    weather_data: {
      last_update: lastWeatherUpdateTime ? {
        timestamp: lastWeatherUpdateTime.toISOString(),
        seconds_ago: Math.floor((now - lastWeatherUpdateTime) / 1000),
        freshness_rating: getFreshnessRating(now, lastWeatherUpdateTime)
      } : null,
      events_count: weatherData.size
    },
    api_health: {
      total_calls: apiCallCount,
      successful_calls: successfulAPICallCount,
      success_rate: apiCallCount > 0 ? Math.round((successfulAPICallCount / apiCallCount) * 100) : 0
    }
  };
  
  res.json(freshness);
});

// Helper function to rate data freshness
function getFreshnessRating(now, lastUpdate) {
  if (!lastUpdate) return 'unknown';
  
  const secondsAgo = Math.floor((now - lastUpdate) / 1000);
  
  if (secondsAgo < 30) return 'excellent';
  if (secondsAgo < 60) return 'good';
  if (secondsAgo < 300) return 'fair';
  if (secondsAgo < 600) return 'stale';
  return 'very_stale';
}

// Test weather notification endpoint
app.post('/api/test-weather-notification', async (req, res) => {
  try {
    const { device_token, weather_name, is_active } = req.body;
    
    if (!apnProvider) {
      return res.status(500).json({ error: 'APNs not configured' });
    }

    if (!device_token) {
      return res.status(400).json({ error: 'Device token required' });
    }

    // Create mock weather event for testing
    const mockWeatherEvent = {
      weatherId: 'test_weather',
      weatherName: weather_name || 'Test Weather',
      isActive: is_active !== false,
      wasActive: false,
      icon: 'https://example.com/weather-icon.png',
      duration: 1800 // 30 minutes
    };

    await sendWeatherNotification(device_token, [mockWeatherEvent], mockWeatherEvent.isActive ? 'active' : 'ended');
    
    res.json({
      success: true,
      message: 'Weather test notification sent',
      weather_event: mockWeatherEvent,
      apns_environment: process.env.APNS_PRODUCTION === 'true' ? 'Production' : 'Development'
    });
    
  } catch (error) {
    console.error('❌ Weather test notification error:', error);
    res.status(500).json({ error: error.message });
  }
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

// Clear image validation cache (for testing)
app.post('/api/clear-image-cache', (req, res) => {
  try {
    const { api_secret } = req.body;
    
    // Simple API secret check
    const expectedSecret = process.env.API_SECRET || 'growagargen-secret-2025';
    if (api_secret !== expectedSecret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const previousSize = imageValidationCache.size;
    imageValidationCache.clear();
    console.log(`🧹 Cleared image validation cache (${previousSize} entries)`);
    
    res.json({
      success: true,
      message: `Image validation cache cleared (${previousSize} entries removed)`,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Clear image cache error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Clear item info cache (for testing)
app.post('/api/clear-item-info-cache', (req, res) => {
  try {
    const { api_secret } = req.body;
    
    // Simple API secret check
    const expectedSecret = process.env.API_SECRET || 'growagargen-secret-2025';
    if (api_secret !== expectedSecret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const previousSize = itemInfoCache.size;
    itemInfoCache.clear();
    console.log(`🧹 Cleared item info cache (${previousSize} entries)`);
    
    res.json({
      success: true,
      message: `Item info cache cleared (${previousSize} entries removed)`,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Clear item info cache error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get image validation cache stats
app.get('/api/image-cache-stats', (req, res) => {
  try {
    const stats = {
      total_entries: imageValidationCache.size,
      valid_images: 0,
      invalid_images: 0,
      cache_duration_hours: IMAGE_CACHE_DURATION / (60 * 60 * 1000),
      entries: []
    };
    
    for (const [url, data] of imageValidationCache) {
      if (data.isValid) {
        stats.valid_images++;
      } else {
        stats.invalid_images++;
      }
      
      stats.entries.push({
        url: url,
        is_valid: data.isValid,
        last_checked: new Date(data.lastChecked).toISOString(),
        age_minutes: Math.round((Date.now() - data.lastChecked) / (60 * 1000))
      });
    }
    
    res.json({
      success: true,
      stats: stats,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Image cache stats error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get item info cache stats
app.get('/api/item-info-cache-stats', (req, res) => {
  try {
    const stats = {
      total_entries: itemInfoCache.size,
      cache_duration_hours: ITEM_INFO_CACHE_DURATION / (60 * 60 * 1000),
      entries: []
    };
    
    for (const [itemId, cachedData] of itemInfoCache) {
      stats.entries.push({
        item_id: itemId,
        item_name: cachedData.data?.display_name || 'unknown',
        rarity: cachedData.data?.rarity || null,
        last_fetched: new Date(cachedData.lastFetched).toISOString(),
        age_minutes: Math.round((Date.now() - cachedData.lastFetched) / (60 * 1000))
      });
    }
    
    res.json({
      success: true,
      stats: stats,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Item info cache stats error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Countdown endpoints for shop restock times
app.get('/api/countdown/seeds', (req, res) => {
  try {
    const startTime = process.hrtime.bigint();
    const countdownData = calculateCategoryCountdown('seeds', 5, 'minutes');
    const endTime = process.hrtime.bigint();
    
    console.log(`⏰ Seeds countdown calculated in ${Number(endTime - startTime) / 1000000}ms`);
    res.json(countdownData);
  } catch (error) {
    console.error('❌ Seeds countdown error:', error);
    res.status(500).json({ error: 'Failed to calculate seeds countdown', details: error.message });
  }
});

app.get('/api/countdown/gear', (req, res) => {
  try {
    const startTime = process.hrtime.bigint();
    const countdownData = calculateCategoryCountdown('gear', 5, 'minutes');
    const endTime = process.hrtime.bigint();
    
    console.log(`⏰ Gear countdown calculated in ${Number(endTime - startTime) / 1000000}ms`);
    res.json(countdownData);
  } catch (error) {
    console.error('❌ Gear countdown error:', error);
    res.status(500).json({ error: 'Failed to calculate gear countdown', details: error.message });
  }
});

app.get('/api/countdown/eggs', (req, res) => {
  try {
    const startTime = process.hrtime.bigint();
    const countdownData = calculateCategoryCountdown('eggs', 30, 'minutes');
    const endTime = process.hrtime.bigint();
    
    console.log(`⏰ Eggs countdown calculated in ${Number(endTime - startTime) / 1000000}ms`);
    res.json(countdownData);
  } catch (error) {
    console.error('❌ Eggs countdown error:', error);
    res.status(500).json({ error: 'Failed to calculate eggs countdown', details: error.message });
  }
});

app.get('/api/countdown/cosmetic', (req, res) => {
  try {
    const startTime = process.hrtime.bigint();
    const countdownData = calculateCategoryCountdown('cosmetic', 4, 'hours');
    const endTime = process.hrtime.bigint();
    
    console.log(`⏰ Cosmetics countdown calculated in ${Number(endTime - startTime) / 1000000}ms`);
    res.json(countdownData);
  } catch (error) {
    console.error('❌ Cosmetics countdown error:', error);
    res.status(500).json({ error: 'Failed to calculate cosmetics countdown', details: error.message });
  }
});

// High-performance combined countdown endpoint
app.get('/api/countdown/all', (req, res) => {
  try {
    const startTime = process.hrtime.bigint();
    const utcNow = new Date();
    
    // Calculate all countdowns efficiently in one pass
    const categories = [
      { name: 'seeds', interval: 5, type: 'minutes' },
      { name: 'gear', interval: 5, type: 'minutes' },
      { name: 'eggs', interval: 30, type: 'minutes' },
      { name: 'cosmetic', interval: 4, type: 'hours' }
    ];
    
    const countdowns = {};
    
    for (const category of categories) {
      const categoryData = calculateOptimizedCountdown(utcNow, category.interval, category.type);
      countdowns[category.name] = {
        next_restock_utc: categoryData.nextRestockUTC,
        countdown_minutes: categoryData.minutes,
        countdown_seconds: categoryData.seconds,
        total_seconds: categoryData.totalSeconds,
        interval: category.interval,
        interval_type: category.type
      };
    }
    
    const endTime = process.hrtime.bigint();
    console.log(`⏰ All countdowns calculated in ${Number(endTime - startTime) / 1000000}ms`);
    
    res.json({
      server_time_utc: utcNow.toISOString(),
      countdowns: countdowns,
      calculation_time_ms: Number(endTime - startTime) / 1000000
    });
    
  } catch (error) {
    console.error('❌ Combined countdown error:', error);
    res.status(500).json({ 
      error: 'Failed to calculate countdowns', 
      details: error.message,
      server_time_utc: new Date().toISOString()
    });
  }
});

// High-performance countdown calculation function
function calculateCategoryCountdown(category, interval, type) {
  const utcNow = new Date();
  const categoryData = calculateOptimizedCountdown(utcNow, interval, type);
  
  return {
    category: category,
    next_restock_utc: categoryData.nextRestockUTC,
    countdown_minutes: categoryData.minutes,
    countdown_seconds: categoryData.seconds,
    total_seconds: categoryData.totalSeconds,
    [`interval_${type.slice(0, -1)}`]: interval // interval_minutes or interval_hours
  };
}

// Optimized countdown calculation with minimal overhead
function calculateOptimizedCountdown(utcNow, interval, type) {
  const currentHour = utcNow.getUTCHours();
  const currentMinute = utcNow.getUTCMinutes();
  const currentSecond = utcNow.getUTCSeconds();
  
  let nextRestock;
  
  if (type === 'minutes') {
    // Optimized minute-based calculation
    const totalCurrentMinutes = currentHour * 60 + currentMinute;
    const nextIntervalMinutes = Math.ceil((totalCurrentMinutes + 1) / interval) * interval;
    
    nextRestock = new Date(utcNow);
    if (nextIntervalMinutes >= 1440) { // 24 hours
      nextRestock.setUTCDate(nextRestock.getUTCDate() + 1);
      nextRestock.setUTCHours(0, 0, 0, 0);
    } else {
      nextRestock.setUTCHours(Math.floor(nextIntervalMinutes / 60), nextIntervalMinutes % 60, 0, 0);
    }
  } else if (type === 'hours') {
    // Optimized hour-based calculation
    const nextIntervalHour = Math.ceil((currentHour + 1) / interval) * interval;
    
    nextRestock = new Date(utcNow);
    if (nextIntervalHour >= 24) {
      nextRestock.setUTCDate(nextRestock.getUTCDate() + 1);
      nextRestock.setUTCHours(0, 0, 0, 0);
    } else {
      nextRestock.setUTCHours(nextIntervalHour, 0, 0, 0);
    }
  } else {
    throw new Error(`Unsupported interval type: ${type}`);
  }
  
  const timeUntilRestock = Math.max(0, nextRestock.getTime() - utcNow.getTime());
  const totalSeconds = Math.floor(timeUntilRestock / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  
  return {
    nextRestockUTC: nextRestock.toISOString(),
    minutes: minutes,
    seconds: seconds,
    totalSeconds: totalSeconds
  };
}

// MARK: - Message System Endpoints

// Get app messages (issue alerts and basic announcements)
app.get('/api/messages', (req, res) => {
  try {
    const messages = [];
    
    // Check for issue alert message
    const issueAlert = process.env.issue_alert_message || '';
    if (issueAlert.trim()) {
      messages.push({
        id: 'issue_alert',
        type: 'issue',
        title: 'Service Alert',
        message: issueAlert.trim(),
        severity: 'high',
        icon: 'exclamationmark.triangle.fill',
        color: 'red',
        timestamp: new Date().toISOString()
      });
    }
    
    // Check for basic message
    const basicMessage = process.env.basic_message || '';
    if (basicMessage.trim()) {
      messages.push({
        id: 'basic_announcement',
        type: 'announcement',
        title: 'Announcement',
        message: basicMessage.trim(),
        severity: 'normal',
        icon: 'megaphone.fill',
        color: 'blue',
        timestamp: new Date().toISOString()
      });
    }
    
    console.log(`📢 Messages endpoint called - returning ${messages.length} messages`);
    
    res.json({
      success: true,
      messages: messages,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Error fetching messages:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch messages',
      messages: []
    });
  }
});

// Version check endpoint
app.get('/api/version-check', (req, res) => {
  try {
    const userVersion = req.query.version || req.headers['app-version'] || '1.0';
    
    // Get version settings from environment variables
    const currentVersion = process.env.current_version || '1.2';
    const oldVersions = (process.env.old_versions || '1.0').split(',').map(v => v.trim());
    
    console.log(`📱 Version check: User=${userVersion}, Current=${currentVersion}, Old=${oldVersions.join(',')}`);
    
    // Check if user version is current
    const isCurrentVersion = userVersion === currentVersion;
    const isOldVersion = oldVersions.includes(userVersion);
    const needsUpdate = !isCurrentVersion;
    
    const response = {
      success: true,
      user_version: userVersion,
      current_version: currentVersion,
      is_current: isCurrentVersion,
      is_old_version: isOldVersion,
      needs_update: needsUpdate,
      timestamp: new Date().toISOString()
    };
    
    // Add update message if needed
    if (needsUpdate) {
      response.update_message = {
        id: 'version_update',
        type: 'update',
        title: 'Update Available',
        message: `Please update to the latest version (v.${currentVersion}) for the best experience and latest features.`,
        severity: isOldVersion ? 'high' : 'normal',
        icon: 'arrow.down.circle.fill',
        color: isOldVersion ? 'orange' : 'blue',
        action_text: 'Update Now',
        action_url: 'https://apps.apple.com/app/gag-stocks' // Replace with actual App Store URL when published
      };
    }
    
    res.json(response);
    
  } catch (error) {
    console.error('❌ Error checking version:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to check version',
      user_version: req.query.version || '1.0',
      current_version: '1.2',
      needs_update: false
    });
  }
});

// Test message endpoint (for debugging)
app.post('/api/test-message', (req, res) => {
  try {
    const { type, message } = req.body;
    
    console.log(`🧪 Test message requested: ${type} - ${message}`);
    
    // Create test response
    const testMessage = {
      id: `test_${type}_${Date.now()}`,
      type: type || 'announcement',
      title: type === 'issue' ? 'Test Alert' : 'Test Announcement',
      message: message || 'This is a test message',
      severity: type === 'issue' ? 'high' : 'normal',
      icon: type === 'issue' ? 'exclamationmark.triangle.fill' : 'megaphone.fill',
      color: type === 'issue' ? 'red' : 'blue',
      timestamp: new Date().toISOString()
    };
    
    res.json({
      success: true,
      test_message: testMessage,
      note: 'This is a test message and not from environment variables'
    });
    
  } catch (error) {
    console.error('❌ Error creating test message:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create test message'
    });
  }
});

// Debug endpoint to show always-shown items configuration
app.get('/api/debug-always-shown-items', (req, res) => {
  try {
    const alwaysShownItems = parseAlwaysShownItems();
    
    const response = {
      success: true,
      always_shown_items: alwaysShownItems,
      environment_variables: {
        SEED_SHOP_ITEM_ID: process.env.SEED_SHOP_ITEM_ID || null,
        GEAR_SHOP_ITEM_ID: process.env.GEAR_SHOP_ITEM_ID || null,
        EGG_SHOP_ITEM_ID: process.env.EGG_SHOP_ITEM_ID || null,
        COSMETICS_SHOP_ITEM_ID: process.env.COSMETICS_SHOP_ITEM_ID || null
      },
      total_configured: alwaysShownItems.seeds.length + alwaysShownItems.gear.length + alwaysShownItems.eggs.length + alwaysShownItems.cosmetic.length,
      timestamp: new Date().toISOString()
    };
    
    console.log(`📋 Debug always-shown items requested: ${response.total_configured} items configured`);
    
    res.json(response);
    
  } catch (error) {
    console.error('❌ Error fetching always-shown items debug info:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch always-shown items debug info'
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 GAG Stocks server running on port ${PORT}`);
  console.log(`📱 APNs ready: ${!!apnProvider}`);
  console.log(`🔗 v2 API endpoints:`);
  console.log(`   📦 Stock: ${STOCK_API_URL}`);
  console.log(`   🌦️ Weather: ${WEATHER_API_URL}`);
  console.log(`   ℹ️ Info: ${ITEM_INFO_API_URL}`);
  console.log(`🔑 Team ID: ${process.env.APNS_TEAM_ID || '8U376J9B6U'}`);
  console.log(`🆔 Key ID: ${process.env.APNS_KEY_ID || 'F9J436633X'}`);
  console.log(`🔐 v2 API Key: ${process.env.JSTUDIO_API_KEY ? 'SET' : 'NOT SET'}`);
  
  // Log message system configuration
  const issueAlert = process.env.issue_alert_message || '';
  const basicMessage = process.env.basic_message || '';
  const currentVersion = process.env.current_version || '1.2';
  const oldVersions = process.env.old_versions || '1.0';
  
  console.log(`📢 Message system ready:`);
  console.log(`   Issue alert: ${issueAlert ? 'SET' : 'not set'}`);
  console.log(`   Basic message: ${basicMessage ? 'SET' : 'not set'}`);
  console.log(`   Current version: ${currentVersion}`);
  console.log(`   Old versions: ${oldVersions}`);
  
  console.log(`🎯 v2 Migration Features:`);
  console.log(`   ✅ Dynamic images from API`);
  console.log(`   ✅ Image URL validation (stock + weather icons)`);
  console.log(`   ✅ Weather monitoring & notifications`);
  console.log(`   ✅ Rich item metadata (icons, dates)`);
  console.log(`   ✅ Enhanced stock data structure`);
  console.log(`   ✅ Reduced hardcoded dependencies`);
  console.log(`🖼️ Image validation: Stock items + Weather icons (1hr cache)`);
  
  // Log always-shown items configuration
  const alwaysShownItems = parseAlwaysShownItems();
  console.log(`📋 Always-shown items configuration:`);
  console.log(`   Seeds: ${alwaysShownItems.seeds.length > 0 ? alwaysShownItems.seeds.join(', ') : 'none configured'}`);
  console.log(`   Gear: ${alwaysShownItems.gear.length > 0 ? alwaysShownItems.gear.join(', ') : 'none configured'}`);
  console.log(`   Eggs: ${alwaysShownItems.eggs.length > 0 ? alwaysShownItems.eggs.join(', ') : 'none configured'}`);
  console.log(`   Cosmetic: ${alwaysShownItems.cosmetic.length > 0 ? alwaysShownItems.cosmetic.join(', ') : 'none configured'}`);
  console.log(`   These items will always be shown for favoriting, even when out of stock`);
}); 

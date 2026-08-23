// Lazy-loaded tab module — see ensureTabModule() in index.html.
// Moved out of index.html's inline <script> so it is fetched only when
// this tab is actually opened. Owns its own top-level const/let; reads
// shared globals from index.html, which always runs first.
'use strict';

// ── Shop ──────────────────────────────────────────────────────────────────




function focusPendingHeroShopTarget() {
  if (!pendingHeroShopTarget || activeTab !== 'shop') return false;
  const card = document.querySelector(`[data-hero-item-slug="${pendingHeroShopTarget}"]`);
  if (!card) return false;
  pendingHeroShopTarget = null;
  card.scrollIntoView({ behavior: plinkoReducedMotion() ? 'auto' : 'smooth', block: 'center' });
  card.classList.remove('is-amulet-target');
  void card.offsetWidth;
  card.classList.add('is-amulet-target');
  setTimeout(() => card.classList.remove('is-amulet-target'), 2600);
  return true;
}

function openHeroItemInShop(slug) {
  pendingHeroShopTarget = slug;
  switchTab('shop');
  if (focusPendingHeroShopTarget()) return;
  let attempts = 0;
  const timer = setInterval(() => {
    attempts += 1;
    if (focusPendingHeroShopTarget() || attempts >= 40) clearInterval(timer);
  }, 100);
}


async function loadMyGardenForCosmetics() {
  if (!me?.id) { myGarden = null; myGarden2 = null; secondGardenUnlocked = false; return; }
  const [{ data: gardens }, { data: prof }] = await Promise.all([
    sb.from('gardens').select('*').eq('user_id', me.id),
    sb.from('profiles').select('second_garden_unlocked').eq('id', me.id).maybeSingle(),
  ]);
  const ownGardens = gardens || [];
  myGarden  = ownGardens.find(g => (g.slot_index || 1) === 1) || null;
  myGarden2 = ownGardens.find(g => g.slot_index === 2) || null;
  secondGardenUnlocked = prof?.second_garden_unlocked || false;
}




function heroItemError(error) {
  const msg = error?.message || '';
  if (msg.includes('insufficient')) return 'Za mało coinów.';
  if (msg.includes('item_not_found')) return 'Przedmiot nie jest już dostępny.';
  if (msg.includes('item_not_owned')) return 'Nie posiadasz tego przedmiotu.';
  if (msg.includes('bad_slot')) return 'Nieprawidłowy slot.';
  if (msg.includes('item_not_auctionable')) return 'Tego przedmiotu nie można wystawić na aukcję.';
  if (msg.includes('auction_not_found')) return 'Aukcja nie istnieje.';
  if (msg.includes('auction_not_open')) return 'Aukcja nie jest otwarta.';
  if (msg.includes('auction_not_started')) return 'Aukcja jeszcze się nie zaczęła.';
  if (msg.includes('auction_finished')) return 'Aukcja już się skończyła.';
  if (msg.includes('auction_still_open')) return 'Aukcja jeszcze trwa.';
  if (msg.includes('bid_too_low')) return 'Oferta jest za niska.';
  if (msg.includes('not_authorized')) return 'Tylko admin może tworzyć aukcje.';
  if (msg.includes('edition_sold_out')) return 'Ta edycja jest już wyprzedana.';
  return msg || 'Nie udało się wykonać akcji.';
}

async function refreshMyCoins() {
  if (!me?.id) return;
  const { data, error } = await sb
    .from('profiles')
    .select('coins')
    .eq('id', me.id)
    .maybeSingle();
  if (!error && data?.coins !== undefined) {
    me.coins = data.coins;
    setText(headerCoins, me.coins);
  }
}

async function loadHeroItemCatalog() {
  const { data, error } = await sb
    .from('hero_item_defs')
    .select('*')
    .eq('is_active', true)
    .in('sale_type', ['shop', 'both'])
    .order('price', { ascending: true });
  if (error) {
    console.warn('Hero item catalog unavailable:', error.message);
    heroItemDefs = [];
    return;
  }
  heroItemDefs = data || [];
  // Shared casino-luck buff status (communal — everyone sees the same clock).
  // The view may not exist until casino-luck-item.sql is applied; fail soft.
  const { data: luck, error: luckError } = await sb
    .from('casino_luck_status')
    .select('active_until')
    .maybeSingle();
  casinoLuckGlobalUntil = (!luckError && luck?.active_until) ? luck.active_until : null;
  casinoLuckStatusLoadedAt = Date.now();
  renderCasinoLuckBanners();
}

async function loadHeroAuctionItemDefs() {
  const { data, error } = await sb
    .from('hero_item_defs')
    .select('*')
    .eq('is_active', true)
    .in('sale_type', ['auction', 'both'])
    .order('rarity', { ascending: true });
  if (error) {
    console.warn('Hero auction item defs unavailable:', error.message);
    heroAuctionItemDefs = [];
    return;
  }
  heroAuctionItemDefs = data || [];
}

async function loadHeroAuctions() {
  const { data, error } = await sb
    .from('hero_item_auction_cards')
    .select('*')
    .order('status', { ascending: true })
    .order('ends_at', { ascending: true });
  if (error) {
    console.warn('Hero auctions unavailable:', error.message);
    heroAuctions = [];
    return;
  }
  heroAuctions = data || [];
}


function firstOwnedHeroItem(slug) {
  return myHeroInventory.find(item => item.slug === slug) || null;
}

function heroItemOwnedCount(slug) {
  return myHeroInventory.filter(item => item.slug === slug).length;
}

async function refreshHeroItemSurface() {
  if (activeTab === 'shop') await loadShop();
  else await loadMyHeroInventory();
  await invalidateFarmAssetBreakdown({ reload: true });
  if (farmModalEl && farmHubTab === 'inventory') refreshFarmHub();
}

async function purchaseHeroItem(slug, price, btn) {
  btn.disabled = true;
  btn.textContent = 'Kupuję…';
  const { data, error } = await sb.rpc('purchase_hero_item', { p_item_slug: slug });
  if (error) {
    showToast('❌ ' + heroItemError(error));
    btn.disabled = false;
    btn.textContent = `Kup za ${price.toLocaleString('pl-PL')} 🪙`;
    return;
  }
  if (data?.coins_left !== undefined) {
    me.coins = data.coins_left;
    setText(headerCoins, me.coins);
  }
  showToast(data?.extended ? '✅ Czas działania przedłużony!' : '✅ Przedmiot kupiony!');
  await refreshHeroItemSurface();
}

async function purchaseGardenCertificate(price, btn) {
  btn.disabled = true;
  btn.textContent = 'Kupuję…';
  const { data, error } = await sb.rpc('activate_garden_certificate');
  if (error) {
    const msg = error.message.includes('insufficient')    ? 'Za mało coinów.'
              : error.message.includes('already_unlocked') ? 'Certyfikat już aktywny.'
              : error.message.includes('no_first_garden')  ? 'Najpierw zasadź pierwszą roślinę w Ogródku.'
              : heroItemError(error);
    showToast('❌ ' + msg);
    btn.disabled = false;
    btn.textContent = `Kup za ${price.toLocaleString('pl-PL')} 🪙`;
    return;
  }
  if (data?.coins_left !== undefined) {
    me.coins = data.coins_left;
    setText(headerCoins, me.coins);
  }
  secondGardenUnlocked = true;
  showToast('✅ Certyfikat aktywny! Wróć do Ogródka i zasadź drugi kwiatek.');
  await refreshHeroItemSurface();
}

function auctionTimeLabel(auction) {
  const end = new Date(auction.ends_at);
  if (Number.isNaN(end.getTime())) return '';
  const diff = end.getTime() - Date.now();
  if (auction.status !== 'open') return 'Zakończona: ' + fmtDateTime(auction.ends_at);
  const fmt = new Intl.DateTimeFormat('pl-PL', {
    timeZone: 'Europe/Warsaw', weekday: 'short', day: 'numeric',
    month: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  const exact = fmt.format(end);
  if (diff <= 0) return `Czeka na rozstrzygnięcie (${exact})`;
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  const countdown = h > 0 ? `${h}h ${m}m` : `${Math.max(1, m)}m`;
  return `Koniec za ${countdown} · ${exact}`;
}

async function createHeroAuction(slug, startPrice, durationHours, minIncrement, btn) {
  btn.disabled = true;
  btn.textContent = 'Tworzę…';
  const { error } = await sb.rpc('create_hero_item_auction', {
    p_item_slug: slug,
    p_start_price: startPrice,
    p_duration_hours: durationHours,
    p_min_increment: minIncrement,
  });
  btn.disabled = false;
  btn.textContent = 'Utwórz aukcję';
  if (error) { showToast('❌ ' + heroItemError(error)); return; }
  showToast('✅ Aukcja utworzona!');
  await loadShop();
  await invalidateFarmAssetBreakdown({ reload: true });
}

async function placeHeroAuctionBid(auctionId, amount, btn) {
  btn.disabled = true;
  btn.textContent = 'Licytuję…';
  const { data, error } = await sb.rpc('place_hero_item_bid', {
    p_auction_id: auctionId,
    p_amount: amount,
  });
  if (error) {
    showToast('❌ ' + heroItemError(error));
    btn.disabled = false;
    btn.textContent = 'Licytuj';
    return;
  }
  if (data?.coins_left !== undefined) {
    me.coins = data.coins_left;
    setText(headerCoins, me.coins);
  }
  showToast('✅ Oferta złożona!');
  await loadShop();
}

async function settleHeroAuction(auctionId, btn) {
  btn.disabled = true;
  btn.textContent = 'Rozstrzygam…';
  const { data, error } = await sb.rpc('settle_hero_item_auction', { p_auction_id: auctionId });
  if (error) {
    showToast('❌ ' + heroItemError(error));
    btn.disabled = false;
    btn.textContent = 'Rozstrzygnij';
    return;
  }
  showToast(data?.winner_id === me?.id ? '🏆 Wygrałeś przedmiot!' : '✅ Aukcja rozstrzygnięta.');
  await loadShop();
  await invalidateFarmAssetBreakdown({ reload: true });
}

// ── Marketplace (Targowisko) ───────────────────────────────────────────────

async function loadMarketplaceListings() {
  const { data, error } = await sb
    .from('marketplace_cards')
    .select('*')
    .order('created_at', { ascending: false });
  if (!error && data) marketplaceListings = data;
}

async function createMarketplaceListing(emoji, title, desc, listingType, price, durationHours, minIncrement, btn) {
  btn.disabled = true;
  btn.textContent = 'Wystawiam…';
  const { error } = await sb.rpc('create_marketplace_listing', {
    p_emoji: emoji,
    p_title: title,
    p_description: desc,
    p_listing_type: listingType,
    p_price: price,
    p_duration_hours: durationHours,
    p_min_increment: minIncrement,
  });
  btn.disabled = false;
  btn.textContent = 'Wystaw ogłoszenie';
  if (error) {
    const msg = error.message.includes('bad_title')  ? 'Podaj tytuł.'
              : error.message.includes('bad_price')  ? 'Podaj cenę większą od 0.'
              : error.message;
    showToast('❌ ' + msg);
    return;
  }
  showToast('✅ Ogłoszenie wystawione!');
  const overlay = document.getElementById('ml-overlay');
  hide(overlay);
  loadShop();
}

// Farm item listings (Phase 2): list an owned NFT instance or a fungible plant-card
// duplicate. The item is reserved server-side at create; shares the bid/escrow engine.
const ML_FARM_ERR = {
  not_owner: 'To nie twój przedmiot.', already_listed: 'Ten przedmiot jest już wystawiony.',
  no_duplicate: 'Nie masz wolnego duplikatu tej karty.', nft_not_found: 'Nie znaleziono karty NFT.',
  not_enough_cards: 'Nie masz tylu wolnych duplikatów tej karty.', card_planted: 'Wszystkie kopie tej karty są zasadzone.',
  tile_not_owned: 'To nie jest kupiona działka.', tile_occupied: 'Ta działka nie jest pusta.',
  zen_tile: 'Roślinki z Ogródka nie można wystawić jako działki.', bad_coords: 'Pole poza farmą.',
  bad_price: 'Podaj cenę większą od 0.', use_nft_listing: 'Tę kartę wystaw jako NFT.',
  land_tax_debt: 'Najpierw spłać podatek od działek.',
  territory_cap: 'Masz limit działek — nie możesz kupić kolejnej.',
  territory_over_cap: 'Jesteś ponad limitem działek — sprzedaj nadmiar.',
};
async function createFarmListing(kind, ref, listingType, price, hours, incr, btn, qty = 1) {
  btn.disabled = true; btn.textContent = 'Wystawiam…';
  const fn = kind === 'farm_nft' ? 'create_farm_nft_listing'
           : kind === 'farm_tile' ? 'create_farm_tile_listing'
           : 'create_farm_card_listing';
  const args = kind === 'farm_nft'
    ? { p_instance_id: ref, p_listing_type: listingType, p_price: price, p_duration_hours: hours, p_min_increment: incr }
    : kind === 'farm_tile'
      ? { p_x: Number(ref.x), p_y: Number(ref.y), p_listing_type: listingType, p_price: price, p_duration_hours: hours, p_min_increment: incr }
      : { p_species: ref, p_listing_type: listingType, p_price: price, p_duration_hours: hours, p_min_increment: incr, p_qty: qty };
  const { error } = await sb.rpc(fn, args);
  btn.disabled = false; btn.textContent = 'Wystaw ogłoszenie';
  if (error) {
    const slug = (error.message.match(/[a-z_]+/) || [''])[0];
    showToast('❌ ' + (ML_FARM_ERR[slug] || error.message));
    return;
  }
  showToast(kind === 'farm_tile' ? '✅ Działka wystawiona na Targowisku!' : '✅ Karta wystawiona na Targowisku!');
  hide(document.getElementById('ml-overlay'));
  await ensureFarmData({ force: true });   // refresh owned items (count/instance reserved)
  await invalidateFarmAssetBreakdown({ reload: true });
  if (kind === 'farm_tile') {
    const tile = fmTiles.get(ref.x + ',' + ref.y);
    if (tile) tile.listed = true;
    renderFarmBoard(); renderFarmSelection();
  }
  loadShop();
}

async function buyMarketplaceListing(listingId, price, btn) {
  const listing = marketplaceListings.find(l => l.id === listingId);
  btn.disabled = true;
  btn.textContent = 'Kupuję…';
  const { data, error } = await sb.rpc('buy_marketplace_listing', { p_listing_id: listingId });
  if (error) {
    const msg = error.message.includes('insufficient') ? 'Za mało coinów!'
              : error.message.includes('listing_not_open') ? 'Ogłoszenie już nieaktywne!'
              : error.message.includes('cannot_buy_own') ? 'Nie możesz kupić własnej oferty!'
              : error.message.includes('tile_not_available') ? 'Ta działka nie jest już dostępna.'
              : error.message.includes('tile_occupied') ? 'Ta działka nie jest już pusta.'
              : error.message.includes('tile_not_listed') ? 'Ta działka nie jest już wystawiona.'
              : error.message.includes('land_tax_debt') ? 'Najpierw spłać podatek od działek.'
              : error.message.includes('territory_cap') ? 'Masz limit działek — nie możesz kupić kolejnej.'
              : error.message;
    showToast('❌ ' + msg);
    btn.disabled = false;
    btn.textContent = `Kup za ${price.toLocaleString('pl-PL')} 🪙`;
    return;
  }
  if (data?.coins_left !== undefined) {
    me.coins = data.coins_left;
    setText(headerCoins, me.coins);
  }
  showToast(listing?.item_kind === 'farm_tile' ? '✅ Kupiono działkę w Ogródku!' : '✅ Kupiono! Skontaktuj się ze sprzedającym.');
  await loadShop();
  if (listing?.item_kind?.startsWith('farm_')) {
    await refreshFarmTaxQuote();
    await invalidateFarmAssetBreakdown({ reload: true });
  }
  if (listing?.item_kind === 'farm_tile') await loadFarm();
}

async function placeMarketplaceBid(listingId, amount, btn) {
  btn.disabled = true;
  btn.textContent = 'Licytuję…';
  const { data, error } = await sb.rpc('place_marketplace_bid', {
    p_listing_id: listingId,
    p_amount: amount,
  });
  if (error) {
    const msg = error.message.includes('insufficient')  ? 'Za mało coinów!'
              : error.message.includes('bid_too_low')   ? 'Oferta zbyt niska!'
              : error.message.includes('cannot_bid_own') ? 'Nie możesz licytować własnej oferty!'
              : error.message.includes('auction_finished') ? 'Aukcja zakończona!'
              : error.message.includes('land_tax_debt') ? 'Najpierw spłać podatek od działek.'
              : error.message.includes('territory_cap') ? 'Masz limit działek — nie możesz licytować kolejnej.'
              : error.message;
    showToast('❌ ' + msg);
    btn.disabled = false;
    btn.textContent = 'Licytuj';
    return;
  }
  if (data?.coins_left !== undefined) {
    me.coins = data.coins_left;
    setText(headerCoins, me.coins);
  }
  showToast('✅ Oferta złożona!');
  loadShop();
}

async function settleMarketplaceListing(listingId, btn) {
  const listing = marketplaceListings.find(l => l.id === listingId);
  btn.disabled = true;
  btn.textContent = 'Rozstrzygam…';
  const { data, error } = await sb.rpc('settle_marketplace_listing', { p_listing_id: listingId });
  if (error) {
    const msg = error.message.includes('auction_still_open') ? 'Aukcja jeszcze trwa!'
              : error.message.includes('land_tax_debt') ? 'Zwycięzca musi najpierw spłacić podatek od działek.'
              : error.message.includes('territory_cap') ? 'Zwycięzca ma już limit działek.'
              : error.message;
    showToast('❌ ' + msg);
    btn.disabled = false;
    btn.textContent = 'Rozstrzygnij aukcję';
    return;
  }
  if (data?.status === 'settled') {
    showToast(listing?.item_kind === 'farm_tile'
      ? (data.buyer_id === me?.id ? '🏆 Wygrałeś aukcję działki!' : '✅ Aukcja działki rozstrzygnięta.')
      : (data.buyer_id === me?.id ? '🏆 Wygrałeś aukcję!' : '✅ Aukcja rozstrzygnięta. Sprzedający otrzymał coiny!'));
  } else {
    showToast('✅ Aukcja zakończona bez ofert.');
  }
  await loadShop();
  if (listing?.item_kind?.startsWith('farm_')) {
    await refreshFarmTaxQuote();
    await invalidateFarmAssetBreakdown({ reload: true });
  }
  if (listing?.item_kind === 'farm_tile') await loadFarm();
}

async function cancelMarketplaceListing(listingId, btn) {
  const listing = marketplaceListings.find(l => l.id === listingId);
  btn.disabled = true;
  btn.textContent = 'Anulowanie…';
  const { error } = await sb.rpc('cancel_marketplace_listing', { p_listing_id: listingId });
  if (error) {
    showToast('❌ ' + error.message);
    btn.disabled = false;
    btn.textContent = 'Anuluj ogłoszenie';
    return;
  }
  showToast('✅ Ogłoszenie anulowane.');
  await loadShop();
  if (listing?.item_kind?.startsWith('farm_')) await invalidateFarmAssetBreakdown({ reload: true });
  if (listing?.item_kind === 'farm_tile') await loadFarm();
}

// Marketplace listing card — same polished card language as the lootbox offer.
function buildMarketplaceCard(listing) {
  const isOpen  = listing.status === 'open';
  const isFixed = listing.listing_type === 'fixed';
  const ended   = isOpen && listing.ends_at && new Date(listing.ends_at).getTime() <= Date.now();
  const isSeller = listing.seller_id === me?.id;
  const currentBid = Number(listing.current_bid || 0);
  const nextBid    = Number(listing.next_min_bid || listing.price || 1);
  const mine       = listing.current_bidder_id === me?.id;
  const plnum = n => Number(n || 0).toLocaleString('pl-PL');
  const glowClass = listing.item_kind === 'farm_nft' ? 'glow-nft'
                  : listing.item_kind === 'farm_card' ? 'glow-card'
                  : listing.item_kind === 'farm_tile' ? 'glow-tile'
                  : (isFixed ? 'glow-fixed' : 'glow-auction');

  const card = el('div', { className: 'mlc-card' + (!isOpen ? ' is-closed' : '') });
  card.appendChild(el('div', { className: 'mlc-hero ' + glowClass },
    el('div', { className: 'mlc-glow' }),
    el('div', { className: 'mlc-type' }, isFixed ? '💰 Cena stała' : '🔨 Aukcja'),
    el('div', { className: 'mlc-icon' }, listing.item_kind ? farmIcon(farmListingEmoji(listing)) : (listing.emoji || '🛍️'))));

  const body = el('div', { className: 'mlc-body' });
  const priceVal = isFixed ? Number(listing.price || 0) : (currentBid > 0 ? currentBid : Number(listing.price || 0));
  body.appendChild(el('div', { className: 'mlc-head' },
    el('div', { className: 'mlc-name' }, listing.title),
    el('div', { className: 'mlc-pricetag' }, plnum(priceVal) + ' 🪙')));
  if (listing.item_kind === 'farm_nft') body.appendChild(el('div', { className: 'ml-item-badge nft' }, '💎 Karta NFT #' + listing.nft_serial + '/' + listing.nft_edition + (listing.nft_level > 1 ? ' ' + '⭐'.repeat(listing.nft_level) : '')));
  else if (listing.item_kind === 'farm_card') body.appendChild(el('div', { className: 'ml-item-badge card' }, '🃏 Karta rośliny' + (Number(listing.qty) > 1 ? ' ×' + listing.qty : '') + ' (Ogródek)'));
  else if (listing.item_kind === 'farm_tile') body.appendChild(el('div', { className: 'ml-item-badge tile' }, '🌱 Działka [' + listing.farm_tile_x + ',' + listing.farm_tile_y + ']'));
  body.appendChild(el('div', { className: 'mlc-seller' }, '👤 Wystawia: ' + (listing.seller_nick || '?')));
  if (listing.description) body.appendChild(el('div', { className: 'mlc-desc' }, listing.description));

  const canCancel = isOpen && (isSeller || isAdmin());
  const addCancel = (label, warn) => {
    const b = el('button', { className: 'mlc-cancel' }, label);
    b.addEventListener('click', () => { if (warn && !window.confirm('Anulować aukcję? Aktualny lider otrzyma zwrot monet.')) return; cancelMarketplaceListing(listing.id, b); });
    body.appendChild(b);
  };

  if (isFixed) {
    if (listing.status === 'settled') {
      body.appendChild(el('div', { className: 'mlc-result' + (listing.buyer_id === me?.id ? ' mine' : '') }, '✅ Sprzedano: ' + (listing.buyer_nick || '?')));
    } else if (isOpen) {
      if (isSeller) {
        body.appendChild(el('div', { className: 'mlc-note' }, 'To Twoja oferta'));
      } else {
        const canAfford = me && me.coins >= listing.price;
        const btn = el('button', { className: 'mlc-buy', disabled: !canAfford, title: canAfford ? '' : 'Za mało coinów' },
          el('span', {}, canAfford ? '🛒 Kup' : 'Za mało coinów'),
          canAfford ? el('span', { className: 'mlc-buy-price' }, plnum(listing.price) + ' 🪙') : '');
        btn.addEventListener('click', () => buyMarketplaceListing(listing.id, listing.price, btn));
        body.appendChild(btn);
      }
      if (canCancel) addCancel('Anuluj ogłoszenie', false);
    } else {
      body.appendChild(el('div', { className: 'mlc-note' }, 'Ogłoszenie zakończone.'));
    }
  } else {
    body.appendChild(el('div', { className: 'auction-status mlc-status', 'data-auction-id': listing.id }, auctionTimeLabel(listing)));
    body.appendChild(el('div', { className: 'mlc-lead' },
      currentBid > 0
        ? ('Prowadzi: ' + (listing.current_bidder_nick || listing.buyer_nick || '?') + (mine ? ' (Ty)' : ''))
        : ('Cena startowa: ' + plnum(listing.price) + ' 🪙')));
    const topBidders = listing.top_bidders ? (typeof listing.top_bidders === 'string' ? JSON.parse(listing.top_bidders) : listing.top_bidders) : [];
    if (topBidders.length) {
      const medals = ['🥇', '🥈', '🥉'];
      const ld = el('div', { className: 'auction-top-bidders mlc-top' });
      topBidders.forEach((b, i) => ld.appendChild(el('span', {}, (medals[i] || '·') + ' ' + b.nick + ' · ' + plnum(b.amount) + ' 🪙')));
      body.appendChild(ld);
    }
    if (listing.status === 'settled') {
      body.appendChild(el('div', { className: 'mlc-result' + (listing.buyer_id === me?.id ? ' mine' : '') },
        '🏆 Wygrał: ' + (listing.buyer_nick || '?') + ' za ' + plnum(listing.final_price || currentBid) + ' 🪙'));
    } else if (ended) {
      const btn = el('button', { className: 'mlc-buy' }, el('span', {}, '⚖️ Rozstrzygnij aukcję'));
      btn.addEventListener('click', () => settleMarketplaceListing(listing.id, btn));
      body.appendChild(btn);
    } else if (isOpen) {
      if (isSeller) {
        body.appendChild(el('div', { className: 'mlc-note' }, 'To Twoja aukcja'));
      } else {
        const requiredCoins = mine ? Math.max(1, nextBid - currentBid) : nextBid;
        const input = el('input', { type: 'number', min: String(nextBid), step: '1', value: String(nextBid), className: 'mlc-bid-input' });
        const btn = el('button', { className: 'mlc-buy', disabled: (me?.coins || 0) < requiredCoins, title: (me?.coins || 0) < requiredCoins ? 'Za mało coinów' : '' },
          el('span', {}, (me?.coins || 0) >= requiredCoins ? '🔨 Licytuj' : 'Za mało'));
        btn.addEventListener('click', () => { const amount = Math.max(nextBid, Math.trunc(Number(input.value) || 0)); placeMarketplaceBid(listing.id, amount, btn); });
        body.appendChild(el('div', { className: 'mlc-bid-row' }, input, btn));
        body.appendChild(el('div', { className: 'mlc-bid-hint' },
          mine ? ('Prowadzisz! Dopłacisz tylko ' + plnum(Math.max(1, nextBid - currentBid)) + ' 🪙')
               : ('Koszt: ' + plnum(requiredCoins) + ' 🪙 w depozycie — zwrot, jeśli ktoś przelicytuje')));
      }
      if (canCancel) addCancel('Anuluj aukcję', currentBid > 0);
    } else {
      body.appendChild(el('div', { className: 'mlc-note' }, 'Aukcja zakończona bez zwycięzcy.'));
    }
  }

  card.appendChild(body);
  return card;
}

function renderMarketplaceGrid() {
  const grid = document.getElementById('marketplace-grid');
  if (!grid) return;
  grid.replaceChildren();

  // Show "+ Wystaw" button to every logged-in user
  const btnNew = document.getElementById('btn-new-listing');
  if (btnNew) btnNew.style.display = me ? '' : 'none';

  // Autohide sold/cancelled listings — only active (open) ones are shown here.
  // Full sale history lives behind the "Historia transakcji" button.
  const active = marketplaceListings.filter(l => l.status === 'open');
  if (!active.length) {
    grid.appendChild(el('p', { className: 'shop-empty' },
      'Brak aktywnych ogłoszeń. Bądź pierwszy — wystaw coś na sprzedaż! 🛍️'
    ));
    return;
  }
  active.forEach(listing => grid.appendChild(buildMarketplaceCard(listing)));
}

// ── Buy orders (Zlecenia zakupu) — standing auto-fill offers ───────────────
// The buyer sets a fixed unit price + max qty; any seller with a matching item
// fills part of it instantly (no negotiation). No escrow: fill_buy_order
// checks the buyer's live balance, so a shortfall just fails that one fill.
async function loadBuyOrders() {
  const { data, error } = await sb.from('marketplace_buy_order_cards').select('*').order('created_at', { ascending: false });
  if (!error && data) buyOrders = data;
}

// Open requests (RFQ) — buyer posts no price, sellers propose their own offer
// (price/qty/description) and the buyer manually accepts one.
async function loadMarketplaceRequests() {
  const { data, error } = await sb.from('marketplace_request_cards').select('*').order('created_at', { ascending: false });
  if (!error && data) {
    marketplaceRequests = data.map(r => ({ ...r, offers: typeof r.offers === 'string' ? JSON.parse(r.offers) : (r.offers || []) }));
  }
}

const BO_ERR = {
  bad_item_kind: 'Wybierz co chcesz kupić.', bad_price: 'Podaj cenę większą od 0.', bad_species: 'Wybierz gatunek.',
  use_nft_kind: 'Ta karta to NFT — wybierz „Karta NFT".', use_card_kind: 'To zwykła karta — wybierz „Karta rośliny".',
  order_not_found: 'Zlecenie nie istnieje.', order_not_open: 'Zlecenie już nieaktywne.', cannot_fill_own: 'Nie możesz zrealizować własnego zlecenia.',
  not_enough_remaining: 'Zbyt duża ilość — sprawdź ile jeszcze zostało.', not_enough_cards: 'Nie masz tylu wolnych duplikatów tej karty.',
  nft_not_found: 'Nie znaleziono karty NFT.', not_owner: 'To nie twój przedmiot.', already_listed: 'Ten przedmiot jest już wystawiony na Targowisku.',
  species_mismatch: 'Ta karta NFT to inny gatunek niż w zleceniu.', tile_not_owned: 'To nie jest kupiona działka.',
  zen_tile: 'Roślinki z Ogródka nie można sprzedać jako działki.', tile_occupied: 'Ta działka nie jest pusta.',
  buyer_insufficient_funds: 'Kupujący nie ma już tylu coinów — spróbuj z mniejszą ilością.',
  land_tax_debt: 'Najpierw spłać podatek od działek.', bad_coords: 'Wybierz działkę.', bad_instance: 'Wybierz kartę NFT.',
};
function boErrMsg(error) {
  const slug = (error.message.match(/[a-z_]+/) || [''])[0];
  return BO_ERR[slug] || error.message;
}

async function createBuyOrder(itemKind, species, price, qty, btn) {
  btn.disabled = true; btn.textContent = 'Zlecam…';
  const { error } = await sb.rpc('create_buy_order', {
    p_item_kind: itemKind, p_card_species: itemKind === 'farm_tile' ? null : species,
    p_unit_price: price, p_qty: qty,
  });
  btn.disabled = false; btn.textContent = 'Zleć zakup';
  if (error) { showToast('❌ ' + boErrMsg(error)); return; }
  showToast('✅ Zlecenie wystawione!');
  hide(document.getElementById('bo-overlay'));
  loadShop();
}

async function cancelBuyOrder(orderId, btn) {
  btn.disabled = true; btn.textContent = 'Anulowanie…';
  const { error } = await sb.rpc('cancel_buy_order', { p_order_id: orderId });
  if (error) { showToast('❌ ' + boErrMsg(error)); btn.disabled = false; btn.textContent = 'Anuluj zlecenie'; return; }
  showToast('✅ Zlecenie anulowane.');
  loadShop();
}

async function fillBuyOrder(order, qty, ref, btn) {
  btn.disabled = true; btn.textContent = 'Sprzedaję…';
  const args = { p_order_id: order.id, p_qty: qty };
  if (order.item_kind === 'farm_nft') args.p_instance_id = ref;
  if (order.item_kind === 'farm_tile') { args.p_tile_x = ref.x; args.p_tile_y = ref.y; }
  const { data, error } = await sb.rpc('fill_buy_order', args);
  btn.disabled = false; btn.textContent = 'Sprzedaj';
  if (error) { showToast('❌ ' + boErrMsg(error)); return; }
  // Read the balance back from the server instead of trusting the payload: the
  // caller here is the SELLER, and older deployments of fill_buy_order returned
  // the BUYER's balance in coins_left (see supabase/marketplace-requests.sql).
  await refreshMeCoins();
  showToast('✅ Sprzedano! Otrzymałeś ' + Number(data?.seller_net ?? data?.total ?? 0).toLocaleString('pl-PL') + ' 🪙');
  await ensureFarmData({ force: true });
  if (order.item_kind?.startsWith('farm_')) await invalidateFarmAssetBreakdown({ reload: true });
  loadShop();
  if (order.item_kind === 'farm_tile') await loadFarm();
}

// Seller-side fulfillment control for a buy order card: what to sell depends
// on item_kind (a qty stepper for cards, an instance/tile picker for the rest).
function buildBuyOrderFillControls(order, remaining) {
  const wrap = el('div', { style: 'display:flex;flex-direction:column;gap:6px' });
  if (order.item_kind === 'farm_card') {
    const free = mlFreeCardCount(order.card_species);
    const max = Math.min(free, remaining);
    if (max < 1) {
      wrap.appendChild(el('div', { className: 'mlc-note' }, free < 1 ? 'Nie masz wolnych duplikatów tej karty.' : 'Zlecenie prawie zrealizowane.'));
      return wrap;
    }
    const input = el('input', { type: 'number', min: '1', max: String(max), value: String(max), className: 'mlc-bid-input' });
    const btn = el('button', { className: 'mlc-buy' }, el('span', {}, 'Sprzedaj'));
    btn.addEventListener('click', () => {
      const qty = Math.max(1, Math.min(max, Math.trunc(Number(input.value) || 1)));
      fillBuyOrder(order, qty, null, btn);
    });
    wrap.appendChild(el('div', { className: 'mlc-desc' }, 'Masz ' + free + ' wolnych duplikatów.'));
    wrap.appendChild(el('div', { className: 'mlc-bid-row' }, input, btn));
  } else if (order.item_kind === 'farm_nft') {
    const mine = fmNft.filter(n => n.owner_id === me?.id && !n.listed && n.species === order.card_species);
    if (!mine.length) { wrap.appendChild(el('div', { className: 'mlc-note' }, 'Nie masz wolnej karty NFT tego gatunku.')); return wrap; }
    const sel = el('select', { className: 'nick-select' });
    mine.sort((a, b) => a.serial_no - b.serial_no).forEach(n => {
      sel.append(el('option', { value: n.id }, farmNftEmoji(n) + ' ' + (n.nft_name || n.species) + ' #' + n.serial_no + '/' + n.edition_size + (n.level > 1 ? ' ' + '⭐'.repeat(n.level) : '')));
    });
    const btn = el('button', { className: 'mlc-buy' }, el('span', {}, 'Sprzedaj'));
    btn.addEventListener('click', () => fillBuyOrder(order, 1, sel.value, btn));
    wrap.appendChild(sel);
    wrap.appendChild(btn);
  } else if (order.item_kind === 'farm_tile') {
    const tiles = [];
    fmTiles.forEach((t, key) => {
      if (t.owner_id !== me?.id) return;
      if (t.acquired_via === 'migration' || t.planted_species || t.listed) return;
      const [x, y] = key.split(',').map(Number);
      tiles.push({ x, y, key });
    });
    if (!tiles.length) { wrap.appendChild(el('div', { className: 'mlc-note' }, 'Nie masz pustej działki do sprzedania.')); return wrap; }
    const sel = el('select', { className: 'nick-select' });
    tiles.sort((a, b) => a.y - b.y || a.x - b.x).forEach(t => sel.append(el('option', { value: t.key }, '🌱 Działka [' + t.x + ',' + t.y + ']')));
    const btn = el('button', { className: 'mlc-buy' }, el('span', {}, 'Sprzedaj'));
    btn.addEventListener('click', () => {
      const [x, y] = sel.value.split(',').map(Number);
      fillBuyOrder(order, 1, { x, y }, btn);
    });
    wrap.appendChild(sel);
    wrap.appendChild(btn);
  }
  return wrap;
}

function buildBuyOrderCard(order) {
  const isBuyer = order.buyer_id === me?.id;
  const remaining = Number(order.qty_remaining || 0);
  const closed = order.status !== 'open';
  const plnum = n => Number(n || 0).toLocaleString('pl-PL');
  const icon = order.item_kind === 'farm_tile' ? '🌱' : order.item_kind === 'farm_nft' ? '💎' : (order.card_emoji || '🃏');
  const kindLabel = order.item_kind === 'farm_tile' ? 'Działka Ogródka'
    : order.item_kind === 'farm_nft' ? ('Karta NFT: ' + (order.card_name || order.card_species))
    : ('Karta rośliny: ' + (order.card_name || order.card_species));

  const card = el('div', { className: 'mlc-card' + (closed ? ' is-closed' : '') });
  card.appendChild(el('div', { className: 'mlc-hero glow-fixed' },
    el('div', { className: 'mlc-glow' }),
    el('div', { className: 'mlc-type' }, '📥 Zlecenie zakupu'),
    el('div', { className: 'mlc-icon' }, icon)));

  const body = el('div', { className: 'mlc-body' });
  body.appendChild(el('div', { className: 'mlc-head' },
    el('div', { className: 'mlc-name' }, kindLabel),
    el('div', { className: 'mlc-pricetag' }, plnum(order.unit_price) + ' 🪙/szt.')));
  body.appendChild(el('div', { className: 'mlc-seller' }, '👤 Kupuje: ' + (order.buyer_nick || '?')));
  body.appendChild(el('div', { className: 'mlc-desc' }, 'Pozostało ' + remaining + ' z ' + order.qty_total + ' szt.'));

  if (closed) {
    body.appendChild(el('div', { className: 'mlc-note' }, order.status === 'cancelled' ? 'Zlecenie anulowane.' : 'Zlecenie zrealizowane w całości.'));
  } else if (isBuyer) {
    body.appendChild(el('div', { className: 'mlc-note' }, 'To Twoje zlecenie'));
    const b = el('button', { className: 'mlc-cancel' }, 'Anuluj zlecenie');
    b.addEventListener('click', () => cancelBuyOrder(order.id, b));
    body.appendChild(b);
  } else {
    body.appendChild(buildBuyOrderFillControls(order, remaining));
  }

  card.appendChild(body);
  return card;
}

function renderBuyOrdersGrid() {
  const grid = document.getElementById('buy-orders-grid');
  if (!grid) return;
  grid.replaceChildren();
  const btnNew = document.getElementById('btn-new-buy-order');
  if (btnNew) btnNew.style.display = me ? '' : 'none';
  const active = buyOrders.filter(o => o.status === 'open');
  if (!active.length) {
    grid.appendChild(el('p', { className: 'shop-empty' }, 'Brak aktywnych zleceń zakupu. Zleć pierwsze! 📥'));
    return;
  }
  active.forEach(o => grid.appendChild(buildBuyOrderCard(o)));
}

const REQ_ERR = {
  bad_description: 'Opisz czego szukasz.', request_not_found: 'Zapytanie nie istnieje.', request_not_open: 'Zapytanie już zamknięte.',
  cannot_offer_own: 'Nie możesz zaoferować na własne zapytanie.', bad_price: 'Podaj cenę większą od 0.',
  offer_not_found: 'Oferta nie istnieje.', offer_not_pending: 'Ta oferta nie jest już aktywna.', not_authorized: 'Brak uprawnień.',
  insufficient_coins: 'Za mało coinów!',
};
function reqErrMsg(error) {
  const slug = (error.message.match(/[a-z_]+/) || [''])[0];
  return REQ_ERR[slug] || error.message;
}

async function createMarketplaceRequest(desc, btn) {
  btn.disabled = true; btn.textContent = 'Wystawiam…';
  const { error } = await sb.rpc('create_marketplace_request', { p_description: desc });
  btn.disabled = false; btn.textContent = 'Wystaw zapytanie';
  if (error) { showToast('❌ ' + reqErrMsg(error)); return; }
  showToast('✅ Zapytanie wystawione!');
  hide(document.getElementById('req-overlay'));
  loadShop();
}

async function cancelMarketplaceRequest(requestId, btn) {
  btn.disabled = true; btn.textContent = 'Anulowanie…';
  const { error } = await sb.rpc('cancel_marketplace_request', { p_request_id: requestId });
  if (error) { showToast('❌ ' + reqErrMsg(error)); btn.disabled = false; btn.textContent = 'Anuluj zapytanie'; return; }
  showToast('✅ Zapytanie anulowane.');
  loadShop();
}

async function createRequestOffer(requestId, price, qty, desc, btn) {
  btn.disabled = true; btn.textContent = 'Wysyłam…';
  const { error } = await sb.rpc('create_request_offer', { p_request_id: requestId, p_price: price, p_qty: qty, p_description: desc });
  btn.disabled = false; btn.textContent = 'Wyślij ofertę';
  if (error) { showToast('❌ ' + reqErrMsg(error)); return; }
  showToast('✅ Oferta wysłana!');
  loadShop();
}

async function withdrawRequestOffer(offerId, btn) {
  btn.disabled = true; btn.textContent = 'Wycofywanie…';
  const { error } = await sb.rpc('withdraw_request_offer', { p_offer_id: offerId });
  if (error) { showToast('❌ ' + reqErrMsg(error)); btn.disabled = false; btn.textContent = 'Wycofaj ofertę'; return; }
  showToast('✅ Oferta wycofana.');
  loadShop();
}

async function declineRequestOffer(offerId, btn) {
  btn.disabled = true; btn.textContent = 'Odrzucanie…';
  const { error } = await sb.rpc('decline_request_offer', { p_offer_id: offerId });
  if (error) { showToast('❌ ' + reqErrMsg(error)); btn.disabled = false; btn.textContent = 'Odrzuć'; return; }
  showToast('✅ Oferta odrzucona.');
  loadShop();
}

async function acceptRequestOffer(offerId, btn) {
  btn.disabled = true; btn.textContent = 'Akceptuję…';
  const { data, error } = await sb.rpc('accept_request_offer', { p_offer_id: offerId });
  if (error) { showToast('❌ ' + reqErrMsg(error)); btn.disabled = false; btn.textContent = 'Akceptuj'; return; }
  if (data?.coins_left !== undefined) { me.coins = data.coins_left; setText(headerCoins, me.coins); }
  showToast('✅ Oferta zaakceptowana! Skontaktuj się ze sprzedającym.');
  loadShop();
}

function buildRequestCard(request) {
  const isBuyer = request.buyer_id === me?.id;
  const closed = request.status !== 'open';
  const plnum = n => Number(n || 0).toLocaleString('pl-PL');
  const offers = request.offers || [];
  const myOffer = offers.find(o => o.seller_id === me?.id && o.status === 'pending');

  const card = el('div', { className: 'mlc-card' + (closed ? ' is-closed' : '') });
  card.appendChild(el('div', { className: 'mlc-hero glow-auction' },
    el('div', { className: 'mlc-glow' }),
    el('div', { className: 'mlc-type' }, '❓ Zapytanie'),
    el('div', { className: 'mlc-icon' }, '❓')));

  const body = el('div', { className: 'mlc-body' });
  body.appendChild(el('div', { className: 'mlc-name' }, request.description));
  body.appendChild(el('div', { className: 'mlc-seller' }, '👤 Szuka: ' + (request.buyer_nick || '?')));

  const pending = offers.filter(o => o.status === 'pending');
  if (pending.length) {
    const list = el('div', { className: 'mlc-top' });
    pending.forEach(o => {
      const row = el('div', {}, '💬 ' + (o.seller_nick || '?') + ': ' + plnum(o.price) + ' 🪙' + (o.qty > 1 ? ' ×' + o.qty : '') + (o.description ? ' — ' + o.description : ''));
      if (isBuyer && !closed) {
        const acceptBtn = el('button', { className: 'mlc-cancel', style: 'color:var(--accent);border-color:var(--accent);margin-left:6px' }, 'Akceptuj');
        acceptBtn.addEventListener('click', () => acceptRequestOffer(o.id, acceptBtn));
        const declineBtn = el('button', { className: 'mlc-cancel', style: 'margin-left:6px' }, 'Odrzuć');
        declineBtn.addEventListener('click', () => declineRequestOffer(o.id, declineBtn));
        row.append(acceptBtn, declineBtn);
      }
      list.appendChild(row);
    });
    body.appendChild(list);
  } else if (!closed) {
    body.appendChild(el('div', { className: 'mlc-desc' }, 'Brak ofert jeszcze.'));
  }

  if (closed) {
    const accepted = offers.find(o => o.id === request.accepted_offer_id);
    body.appendChild(el('div', { className: 'mlc-result' }, request.status === 'cancelled' ? 'Zapytanie anulowane.'
      : accepted ? ('✅ Przyjęto ofertę: ' + (accepted.seller_nick || '?') + ' za ' + plnum(accepted.price) + ' 🪙')
      : 'Zapytanie zamknięte.'));
  } else if (isBuyer) {
    const b = el('button', { className: 'mlc-cancel' }, 'Anuluj zapytanie');
    b.addEventListener('click', () => cancelMarketplaceRequest(request.id, b));
    body.appendChild(b);
  } else {
    const priceInput = el('input', { type: 'number', min: '1', value: String(myOffer?.price || 100), className: 'mlc-bid-input' });
    const qtyInput = el('input', { type: 'number', min: '1', value: String(myOffer?.qty || 1), className: 'mlc-bid-input' });
    const descInput = el('input', { type: 'text', placeholder: 'Co oferujesz? (opcjonalnie)', value: myOffer?.description || '', maxlength: '300', style: 'width:100%;margin-top:6px' });
    const btn = el('button', { className: 'mlc-buy' }, el('span', {}, myOffer ? 'Zaktualizuj ofertę' : 'Wyślij ofertę'));
    btn.addEventListener('click', () => {
      const price = Math.max(1, Math.trunc(Number(priceInput.value) || 1));
      const qty = Math.max(1, Math.trunc(Number(qtyInput.value) || 1));
      createRequestOffer(request.id, price, qty, descInput.value.trim(), btn);
    });
    body.appendChild(el('div', { className: 'mlc-bid-row' }, priceInput, qtyInput, btn));
    body.appendChild(descInput);
    if (myOffer) {
      const wb = el('button', { className: 'mlc-cancel', style: 'margin-top:6px' }, 'Wycofaj ofertę');
      wb.addEventListener('click', () => withdrawRequestOffer(myOffer.id, wb));
      body.appendChild(wb);
    }
  }

  card.appendChild(body);
  return card;
}

function renderRequestsGrid() {
  const grid = document.getElementById('requests-grid');
  if (!grid) return;
  grid.replaceChildren();
  const btnNew = document.getElementById('btn-new-request');
  if (btnNew) btnNew.style.display = me ? '' : 'none';
  const active = marketplaceRequests.filter(r => r.status === 'open');
  if (!active.length) {
    grid.appendChild(el('p', { className: 'shop-empty' }, 'Brak aktywnych zapytań. Zapytaj o cokolwiek! ❓'));
    return;
  }
  active.forEach(r => grid.appendChild(buildRequestCard(r)));
}

// Full sale history (all settled listings, any age) in a table: who → whom, price.
async function openMarketplaceHistory() {
  const overlay = el('div', { className: 'modal-overlay', role: 'dialog', 'aria-modal': 'true' });
  const close = () => { overlay.remove(); window.removeEventListener('keydown', esc); };
  const esc = e => { if (e.key === 'Escape') close(); };
  const closeX = el('button', { className: 'btn-close', type: 'button', 'aria-label': 'Zamknij' }, '✕');
  closeX.addEventListener('click', close);
  const body = el('div', {}, el('div', { className: 'loading-center' }, el('div', { className: 'spinner' })));
  const modal = el('div', { className: 'modal ml-history-modal' },
    el('div', { className: 'modal-header' }, el('span', { className: 'modal-title' }, '📜 Historia transakcji'), closeX),
    body);
  overlay.append(modal);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  window.addEventListener('keydown', esc);
  document.body.append(overlay);
  try {
    const { data, error } = await sb.from('marketplace_listings')
      .select('emoji,title,final_price,settled_at,item_kind,seller:profiles!seller_id(nick),buyer:profiles!buyer_id(nick)')
      .eq('status', 'settled').not('buyer_id', 'is', null)
      .order('settled_at', { ascending: false }).limit(200);
    if (error) throw error;
    body.replaceChildren();
    if (!data || !data.length) { body.append(el('div', { className: 'shop-empty' }, 'Brak sprzedanych przedmiotów.')); return; }
    const fmtDate = d => d ? new Date(d).toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit', year: '2-digit' }) : '—';
    const tb = el('tbody', {});
    data.forEach(r => {
      tb.append(el('tr', {},
        el('td', { className: 'mlh-item' }, (r.emoji || '🛍️') + ' ' + (r.title || '—')),
        el('td', {}, r.seller?.nick || '?'),
        el('td', { className: 'mlh-arrow' }, '→'),
        el('td', {}, r.buyer?.nick || '?'),
        el('td', { className: 'mlh-price' }, (r.final_price != null ? r.final_price + ' 🪙' : '—')),
        el('td', { className: 'mlh-when' }, fmtDate(r.settled_at))));
    });
    body.append(el('div', { className: 'ml-history-wrap' },
      el('table', { className: 'ml-history-table' },
        el('thead', {}, el('tr', {},
          el('th', {}, 'Przedmiot / usługa'), el('th', {}, 'Sprzedawca'), el('th', {}, ''),
          el('th', {}, 'Kupujący'), el('th', {}, 'Cena'), el('th', {}, 'Data'))),
        tb)));
  } catch (e) {
    console.error('marketplace history', e);
    body.replaceChildren(el('div', { className: 'shop-empty' }, 'Nie udało się wczytać historii.'));
  }
}

function setupShopCategoryFilters() {
  document.querySelectorAll('[data-shop-target]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-shop-target]').forEach(b => b.classList.toggle('active', b === btn));
      document.getElementById(btn.dataset.shopTarget)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
  // Scroll-spy: highlight the category pill for the section currently nearest the top.
  const sections = [...document.querySelectorAll('#tab-shop .shop-section')];
  if (sections.length && 'IntersectionObserver' in window) {
    const visible = new Set();
    let spyActive = null;
    const refresh = () => {
      let best = null, bestTop = Infinity;
      visible.forEach(id => { const elx = document.getElementById(id); if (!elx) return; const top = elx.getBoundingClientRect().top; if (top < bestTop) { bestTop = top; best = id; } });
      if (best && best !== spyActive) {
        spyActive = best;
        document.querySelectorAll('.shop-category-filter[data-shop-target]').forEach(b => b.classList.toggle('active', b.dataset.shopTarget === best));
      }
    };
    const obs = new IntersectionObserver(entries => {
      entries.forEach(e => { if (e.isIntersecting) visible.add(e.target.id); else visible.delete(e.target.id); });
      refresh();
    }, { rootMargin: '-124px 0px -55% 0px', threshold: 0 });
    sections.forEach(s => obs.observe(s));
  }
}
setupShopCategoryFilters();

// ── Targowisko nav counters ───────────────────────────────────────────────
// A small count on the Targowisko nav entries, so you can see there is
// something worth opening without walking into the Sklep first. It counts
// only OTHER people's open items: your own listing is not an offer you can
// act on, and having it inflate your own badge reads as a permanent "1".



// loadShop() already holds every row the counters need — recount locally
// instead of firing three more requests right after it finishes.
function syncShopNavCountsFromShop() {
  const mine = id => id === me?.id;
  shopNavCounts = {
    marketplace: marketplaceListings.filter(l => l.status === 'open' && !mine(l.seller_id)).length,
    buyOrders: buyOrders.filter(o => o.status === 'open' && !mine(o.buyer_id)).length
             + marketplaceRequests.filter(r => r.status === 'open' && !mine(r.buyer_id)).length,
  };
  renderShopNavCounts();
}

async function loadShop() {
  const grid = document.getElementById('shop-grid');
  grid.replaceChildren(makeSpinner());

  const btnNew = document.getElementById('btn-new-item');
  btnNew.style.display = isAdmin() ? '' : 'none';

  const [{ data: items, error }] = await Promise.all([
    sb
      .from('store_items')
      .select('*, store_purchases(id, buyer_id, purchased_at, profiles!buyer_id(nick))')
      .eq('is_active', true)
      .order('created_at', { ascending: false }),
    loadMyGardenForCosmetics(),
    loadHeroItemCatalog(),
    loadHeroAuctionItemDefs(),
    loadHeroAuctions(),
    loadMyHeroInventory(),
    loadMarketplaceListings(),
    loadBuyOrders(),
    loadMarketplaceRequests(),
    ensureFarmData(),
    refreshMyCoins(),
  ]);

  if (error) { grid.replaceChildren(); grid.append(document.createTextNode('Błąd ładowania sklepu.')); return; }

  grid.replaceChildren();
  if (!items || items.length === 0) {
    grid.append(el('p', { className: 'shop-empty' }, 'Sklep jest pusty. Admin wkrótce doda nagrody! 🎁'));
  } else {
    items.forEach(item => grid.appendChild(buildShopCard(item)));
  }
  renderCosmeticsGrid();
  renderHeroShopGrid();
  requestAnimationFrame(focusPendingHeroShopTarget);
  renderHeroAuctionAdmin();
  renderHeroAuctionGrid();
  renderMarketplaceGrid();
  renderBuyOrdersGrid();
  renderRequestsGrid();
  syncShopNavCountsFromShop();
  loadFarmLootbox();
  loadZappsShop();

  if (auctionTimerInterval) clearInterval(auctionTimerInterval);
  auctionTimerInterval = setInterval(() => {
    if (activeTab !== 'shop') return;
    document.querySelectorAll('.auction-status[data-auction-id]').forEach(div => {
      const id = div.dataset.auctionId;
      const auction = heroAuctions.find(a => a.id === id) || marketplaceListings.find(a => a.id === id);
      if (auction) div.textContent = auctionTimeLabel(auction);
    });
  }, 30000);

  // If we arrived here via a Sklep dropdown link, jump to the requested section.
  if (pendingShopScroll) {
    const target = pendingShopScroll;
    pendingShopScroll = null;
    requestAnimationFrame(() => {
      const fb = document.querySelector(`.shop-category-filter[data-shop-target="${target}"]`);
      if (fb) fb.click();
      else document.getElementById(target)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
}

function buildShopCard(item) {
  const purchases = item.store_purchases || [];
  const slotsLeft = item.max_slots - item.slots_used;
  const soldOut   = slotsLeft <= 0;
  const iMine     = purchases.some(p => p.buyer_id === me?.id);
  const canAfford = me && me.coins >= item.price;

  const emojiMatch = item.title.match(/^\p{Emoji_Presentation}/u);
  const icon  = el('div', { className: 'shop-card-icon'  }, emojiMatch ? emojiMatch[0] : '🎁');
  const title = el('div', { className: 'shop-card-title' }, emojiMatch ? item.title.slice(emojiMatch[0].length).trim() : item.title);
  const desc  = el('div', { className: 'shop-card-desc'  }, item.description);
  const price = el('div', { className: 'shop-card-price' }, item.price.toLocaleString('pl-PL') + ' 🪙');
  const slots = el('div', { className: 'shop-card-slots' },
    soldOut ? 'Wyprzedane 🔒' : `Dostępne: ${slotsLeft} z ${item.max_slots}`
  );

  const card = el('div', { className: 'shop-card' }, icon, title, desc, price, slots);

  if (iMine) {
    card.appendChild(el('div', { className: 'shop-card-bought' }, '✅ Kupiono — Yuriy zapłaci za Ciebie w najbliższy Pizza Friday Ticket!'));
  } else if (soldOut) {
    const who = purchases[0]?.profiles?.nick || '?';
    const when = purchases[0]?.purchased_at
      ? new Date(purchases[0].purchased_at).toLocaleDateString('pl-PL', { day: 'numeric', month: 'long' })
      : '';
    card.appendChild(el('div', { className: 'shop-card-buyer' }, `🍕 Kupił: ${who}${when ? '  ·  ' + when : ''}`));
  } else {
    const btn = el('button', {
      className: 'btn-primary shop-card-btn',
      disabled: !canAfford,
      title: canAfford ? '' : 'Za mało coinów',
    }, canAfford ? `Kup za ${item.price.toLocaleString('pl-PL')} 🪙` : `Potrzebujesz ${item.price.toLocaleString('pl-PL')} 🪙`);
    btn.addEventListener('click', () => purchaseItem(item.id, item.price, btn));
    card.appendChild(btn);
  }

  return card;
}

async function purchaseItem(itemId, price, btn) {
  btn.disabled = true;
  btn.textContent = 'Kupuję…';
  const { data, error } = await sb.rpc('purchase_store_item', { p_item_id: itemId });
  if (error) {
    const msg = error.message.includes('insufficient') ? 'Za mało coinów!'
              : error.message.includes('sold_out')     ? 'Wyprzedane!'
              : error.message;
    showToast('❌ ' + msg);
    btn.disabled = false;
    btn.textContent = `Kup za ${price.toLocaleString('pl-PL')} 🪙`;
    return;
  }
  me.coins = data.coins_left;
  setText(headerCoins, me.coins);
  showToast('✅ Kupiono! Yuriy zapłaci za Ciebie w najbliższy Pizza Friday Ticket 🍕');
  loadShop();
}

// Items new enough to still deserve a pill in the shop grid. Remove a slug
// from here once it stops being news — the badge is the only thing that makes
// a new item findable in a grid people have already learned the shape of.
const SHOP_NEW_SLUGS = new Set(['banker_signet']);

function renderHeroShopGrid() {
  const grid = document.getElementById('hero-shop-grid');
  if (!grid) return;
  grid.replaceChildren();

  if (!heroItemDefs.length) return;

  heroItemDefs.forEach(item => {
    const owned = firstOwnedHeroItem(item.slug);
    const ownedCount = heroItemOwnedCount(item.slug);
    const itemPrice = Number(item.price || 0);
    const itemCanAfford = (me?.coins || 0) >= itemPrice;
    const itemCard = el('div', { className: 'shop-card' });
    itemCard.dataset.heroItemSlug = item.slug;
    itemCard.appendChild(el('div', { className: 'shop-card-icon' }, item.emoji || '🎒'));
    const titleEl = el('div', { className: 'shop-card-title' }, item.name);
    if (SHOP_NEW_SLUGS.has(item.slug)) {
      titleEl.append(' ', el('span', { className: 'nav-new-badge' }, 'Nowość'));
    }
    itemCard.appendChild(titleEl);
    itemCard.appendChild(el('div', { className: 'shop-card-desc' }, item.description || heroItemEffectLabel(item)));
    itemCard.appendChild(el('div', { className: 'shop-card-price' }, itemPrice.toLocaleString('pl-PL') + ' 🪙'));
    itemCard.appendChild(el('div', { className: 'shop-card-meta' },
      `${HERO_ITEM_SLOT_LABELS[item.slot] || item.slot} · ${heroItemEffectLabel(item)}`
    ));
    if (ownedCount > 0) {
      itemCard.appendChild(el('div', { className: 'shop-card-slots' }, `Posiadasz: ${ownedCount}`));
    }

    if (item.slug === 'garden_certificate') {
      if (secondGardenUnlocked || ownedCount > 0) {
        itemCard.appendChild(el('button', { className: 'btn-primary shop-card-btn', disabled: true }, '✅ Aktywny'));
      } else {
        const buyBtn = el('button', {
          className: 'btn-primary shop-card-btn',
          disabled: !itemCanAfford,
          title: itemCanAfford ? '' : 'Za mało coinów',
        }, itemCanAfford ? `Kup za ${itemPrice.toLocaleString('pl-PL')} 🪙` : `Potrzebujesz ${itemPrice.toLocaleString('pl-PL')} 🪙`);
        buyBtn.addEventListener('click', () => purchaseGardenCertificate(itemPrice, buyBtn));
        itemCard.appendChild(buyBtn);
      }
    } else if (item.duration_hours) {
      // Timed item: casino_luck is COMMUNAL — one shared clock for everyone,
      // and buying while active queues +duration onto the shared window.
      const isCommunal = item.effect_type === 'casino_luck';
      const activeUntil = isCommunal ? casinoLuckGlobalUntil : owned?.expires_at;
      if (activeUntil) {
        itemCard.appendChild(el('div', { className: 'shop-card-slots' },
          `⏳ Aktywny${isCommunal ? ' dla wszystkich' : ''} do ${fmtDateTime(activeUntil)} (${heroItemExpiryLabel({ expires_at: activeUntil })})`));
      }
      const days = Math.round(item.duration_hours / 24);
      if (isCommunal) {
        const currentEndMs = Date.parse(activeUntil || '');
        const purchaseBaseMs = Number.isFinite(currentEndMs) && currentEndMs > Date.now() ? currentEndMs : Date.now();
        const purchaseUntil = new Date(purchaseBaseMs + Number(item.duration_hours) * 3600000).toISOString();
        itemCard.appendChild(el('div', { className: 'shop-card-slots' },
          `Kupując teraz: amulet będzie aktywny dla wszystkich do ${fmtDateTime(purchaseUntil)}.`));
      }
      const buyBtn = el('button', {
        className: 'btn-primary shop-card-btn',
        disabled: !itemCanAfford,
        title: itemCanAfford ? '' : 'Za mało coinów',
      }, !itemCanAfford ? `Potrzebujesz ${itemPrice.toLocaleString('pl-PL')} 🪙`
        : activeUntil ? `Przedłuż o ${days} dni za ${itemPrice.toLocaleString('pl-PL')} 🪙`
        : `Kup ${days} dni${isCommunal ? ' dla wszystkich' : ''} za ${itemPrice.toLocaleString('pl-PL')} 🪙`);
      buyBtn.addEventListener('click', () => purchaseHeroItem(item.slug, itemPrice, buyBtn));
      itemCard.appendChild(buyBtn);
    } else if (owned) {
      itemCard.appendChild(el('button', {
        className: 'btn-primary shop-card-btn',
        disabled: true,
      }, '✅ Posiadasz'));
    } else {
      const buyBtn = el('button', {
        className: 'btn-primary shop-card-btn',
        disabled: !itemCanAfford,
        title: itemCanAfford ? '' : 'Za mało coinów',
      }, itemCanAfford ? `Kup za ${itemPrice.toLocaleString('pl-PL')} 🪙` : `Potrzebujesz ${itemPrice.toLocaleString('pl-PL')} 🪙`);
      buyBtn.addEventListener('click', () => purchaseHeroItem(item.slug, itemPrice, buyBtn));
      itemCard.appendChild(buyBtn);
    }
    grid.appendChild(itemCard);
  });
}

function renderHeroAuctionAdmin() {
  const wrap = document.getElementById('hero-auction-admin');
  if (!wrap) return;
  wrap.replaceChildren();
  if (!isAdmin()) return;

  if (!heroAuctionItemDefs.length) {
    wrap.appendChild(el('div', { className: 'shop-card-meta', style: { marginTop: '12px' } },
      'Brak przedmiotów aukcyjnych. Wdróż najnowsze supabase/hero-items.sql.'
    ));
    return;
  }

  const form = el('div', { className: 'auction-admin' });
  const select = el('select', {});
  heroAuctionItemDefs.forEach(item => {
    select.appendChild(el('option', { value: item.slug }, `${item.emoji || '🎒'} ${item.name}${item.edition_size ? ' #' + item.edition_size : ''}`));
  });
  const startInput = el('input', { type: 'number', min: '1', step: '1', value: '1' });
  const durationInput = el('input', { type: 'number', min: '1', max: '720', step: '1', value: '72' });
  const incInput = el('input', { type: 'number', min: '1', step: '1', value: '1' });
  const btn = el('button', { className: 'btn-primary', type: 'button' }, 'Utwórz aukcję');
  btn.addEventListener('click', () => {
    const startPrice = Math.max(1, Math.trunc(Number(startInput.value) || 0));
    const hours = Math.max(1, Math.min(720, Math.trunc(Number(durationInput.value) || 72)));
    const inc = Math.max(1, Math.trunc(Number(incInput.value) || 10));
    createHeroAuction(select.value, startPrice, hours, inc, btn);
  });
  form.append(
    el('label', {}, 'Przedmiot', select),
    el('label', {}, 'Start', startInput),
    el('label', {}, 'Godziny', durationInput),
    el('label', {}, 'Przebicie', incInput),
    btn
  );
  wrap.appendChild(form);
}

function renderHeroAuctionGrid() {
  const grid = document.getElementById('hero-auction-grid');
  if (!grid) return;
  grid.replaceChildren();

  // Won (settled) auctions are hidden — the item is already claimed, no need to
  // keep showing it in Aukcje. Only open/unsettled auctions are listed.
  const visibleAuctions = heroAuctions.filter(a => a.status !== 'settled');

  // Hide the whole section + its category pill/nav entries when there are no
  // active auctions — except for admins, who still need the "create auction" form.
  const show = visibleAuctions.length > 0 || isAdmin();
  const section = document.getElementById('hero-auctions-section');
  if (section) section.style.display = show ? '' : 'none';
  document.querySelectorAll('[data-shop-target="hero-auctions-section"]').forEach(b => { b.style.display = show ? '' : 'none'; });
  if (!show) return;

  if (!visibleAuctions.length) {
    grid.appendChild(el('p', { className: 'shop-empty' }, 'Brak aktywnych aukcji. Admin może wystawić limitowany przedmiot.'));
    return;
  }

  visibleAuctions.forEach(auction => {
    const isOpen = auction.status === 'open';
    const ended = isOpen && new Date(auction.ends_at).getTime() <= Date.now();
    const currentBid = Number(auction.current_bid || 0);
    const nextBid = Number(auction.next_min_bid || auction.start_price || 1);
    const mine = auction.current_bidder_id === me?.id;
    const winnerMine = auction.winner_id === me?.id;
    const card = el('div', { className: 'shop-card' + (!isOpen ? ' auction-ended' : '') });

    card.appendChild(el('div', { className: 'shop-card-icon' }, auction.emoji || '🎒'));
    card.appendChild(el('div', { className: 'shop-card-title' }, auction.name));
    card.appendChild(el('div', { className: 'shop-card-desc' }, auction.description || heroItemEffectLabel(auction)));
    card.appendChild(el('div', { className: 'shop-card-price' },
      currentBid > 0 ? currentBid.toLocaleString('pl-PL') + ' 🪙' : Number(auction.start_price || 0).toLocaleString('pl-PL') + ' 🪙'
    ));
    card.appendChild(el('div', { className: 'shop-card-meta' },
      `${HERO_ITEM_SLOT_LABELS[auction.slot] || auction.slot} · ${heroItemEffectLabel(auction)}`
    ));
    if (auction.edition_size) {
      card.appendChild(el('div', { className: 'shop-card-slots' }, `Limitowana edycja: ${auction.edition_size} szt.`));
    }
    const statusDiv = el('div', { className: 'auction-status', 'data-auction-id': auction.id }, auctionTimeLabel(auction));
    card.appendChild(statusDiv);
    card.appendChild(el('div', { className: 'shop-card-slots' },
      currentBid > 0
        ? `Prowadzi: ${auction.current_bidder_nick || auction.winner_nick || '?'}${mine ? ' (Ty)' : ''}`
        : `Cena startowa: ${Number(auction.start_price || 0).toLocaleString('pl-PL')} 🪙`
    ));

    const topBidders = auction.top_bidders ? (typeof auction.top_bidders === 'string' ? JSON.parse(auction.top_bidders) : auction.top_bidders) : [];
    if (topBidders.length > 0) {
      const medals = ['🥇', '🥈', '🥉'];
      const listDiv = el('div', { className: 'auction-top-bidders' });
      topBidders.forEach((b, i) => {
        listDiv.appendChild(el('span', {}, `${medals[i] || '·'} ${b.nick} · ${Number(b.amount).toLocaleString('pl-PL')} 🪙`));
      });
      card.appendChild(listDiv);
    }

    if (auction.status === 'settled') {
      card.appendChild(el('div', { className: winnerMine ? 'shop-card-bought' : 'shop-card-buyer' },
        `🏆 Wygrał: ${auction.winner_nick || '?'} za ${Number(auction.winning_bid || currentBid || 0).toLocaleString('pl-PL')} 🪙`
      ));
    } else if (ended) {
      const btn = el('button', { className: 'btn-primary shop-card-btn' }, 'Rozstrzygnij aukcję');
      btn.addEventListener('click', () => settleHeroAuction(auction.id, btn));
      card.appendChild(btn);
    } else if (isOpen) {
      const row = el('div', { className: 'auction-bid-row' });
      const requiredCoins = mine ? Math.max(1, nextBid - currentBid) : nextBid;
      const input = el('input', {
        type: 'number',
        min: String(nextBid),
        step: '1',
        value: String(nextBid),
      });
      const btn = el('button', {
        className: 'btn-primary shop-card-btn',
        disabled: (me?.coins || 0) < requiredCoins,
        title: (me?.coins || 0) < requiredCoins ? 'Za mało coinów' : '',
      }, (me?.coins || 0) >= requiredCoins ? 'Licytuj' : 'Za mało');
      btn.addEventListener('click', () => {
        const amount = Math.max(nextBid, Math.trunc(Number(input.value) || 0));
        placeHeroAuctionBid(auction.id, amount, btn);
      });
      row.append(input, btn);
      card.appendChild(row);
      const hintText = mine
        ? `Prowadzisz! Dopłacisz tylko ${Math.max(1, nextBid - currentBid).toLocaleString('pl-PL')} 🪙 (różnicę od Twojej obecnej oferty)`
        : `Koszt: ${requiredCoins.toLocaleString('pl-PL')} 🪙 w depozycie — zwrot automatyczny jeśli ktoś przelicytuje`;
      card.appendChild(el('div', { className: 'auction-bid-hint' }, hintText));
    } else {
      card.appendChild(el('div', { className: 'shop-card-slots' }, 'Aukcja zakończona bez zwycięzcy.'));
    }

    grid.appendChild(card);
  });
}

// Shop realtime
// ── Kup Zappsy (coiny → Zappsy) ─────────────────────────────────────────────
const ZAPPS_POOL_TOTAL = 1500;   // mirror supabase/zapps-shop.sql
const ZAPPS_STATUS = {
  pending:  { cls: 'pending',  label: '⏳ Oczekuje' },
  approved: { cls: 'approved', label: '✅ Zatwierdzone' },
  rejected: { cls: 'rejected', label: '❌ Odrzucone' },
};

function fbZappsDate(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('pl-PL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

async function loadZappsPool() {
  const totalEl = document.getElementById('zapps-pool-total');
  const remEl = document.getElementById('zapps-pool-remaining');
  if (totalEl) totalEl.textContent = ZAPPS_POOL_TOTAL;
  if (!remEl) return;
  try {
    const { data, error } = await sb.rpc('zapps_pool_status');
    if (error || !data) throw new Error(error?.message || 'rpc');
    if (totalEl && data.total != null) totalEl.textContent = data.total;
    remEl.textContent = data.remaining;
  } catch {
    remEl.textContent = '?';
  }
}

async function loadZappsShop() {
  const myList = document.getElementById('zapps-my-list');
  const adminBox = document.getElementById('zapps-admin');
  const adminList = document.getElementById('zapps-admin-list');
  if (!myList) return;
  const canAdmin = isAdmin();

  loadZappsPool();

  const { data, error } = await sb
    .from('zapps_purchase_requests')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) {
    myList.replaceChildren(el('p', { className: 'topup-empty' }, 'Nie udało się wczytać zamówień.'));
    return;
  }
  const rows = data || [];

  // Player's own history (admin sees all rows, so filter to own here).
  const mine = rows.filter(r => me && r.user_id === me.id);
  if (!mine.length) {
    myList.replaceChildren(el('p', { className: 'topup-empty' }, 'Nie masz jeszcze żadnych zamówień.'));
  } else {
    myList.replaceChildren(...mine.map(r => buildZappsRow(r)));
  }

  // Admin console — only admin can see other users' rows (RLS), and we gate UI too.
  if (adminBox) adminBox.classList.toggle('hidden', !canAdmin);
  if (canAdmin && adminList) {
    const pending = rows.filter(r => r.status === 'pending')
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    if (!pending.length) {
      adminList.replaceChildren(el('p', { className: 'topup-empty' }, 'Brak oczekujących zamówień. 🎉'));
    } else {
      adminList.replaceChildren(...pending.map(r => buildZappsRow(r, true)));
    }
  }
}

function buildZappsRow(r, adminView = false) {
  const st = ZAPPS_STATUS[r.status] || ZAPPS_STATUS.pending;
  const meta = [];
  if (adminView) meta.push('👤 ' + (r.nick_snapshot || '?'));
  if (r.contact) meta.push('📇 ' + r.contact);
  meta.push('🕒 ' + fbZappsDate(r.created_at));
  if (r.status !== 'pending' && r.resolved_by) meta.push((r.status === 'approved' ? '✅' : '❌') + ' ' + r.resolved_by);
  if (r.admin_note) meta.push('📝 ' + r.admin_note);

  const row = el('div', { className: 'topup-row' },
    el('div', { className: 'topup-row-main' },
      el('span', { className: 'topup-row-amount' }, r.amount + ' 💎 (−' + r.amount + ' 🪙)'),
      el('span', { className: 'topup-row-meta' }, meta.join(' · ')),
    ),
  );

  if (adminView && r.status === 'pending') {
    const approve = el('button', { className: 'topup-btn approve' }, 'Zatwierdź');
    const reject = el('button', { className: 'topup-btn reject' }, 'Odrzuć');
    approve.addEventListener('click', () => resolveZapps(r, true, [approve, reject]));
    reject.addEventListener('click', () => resolveZapps(r, false, [approve, reject]));
    row.appendChild(el('div', { className: 'topup-actions' }, approve, reject));
  } else {
    row.appendChild(el('span', { className: 'topup-badge ' + st.cls }, st.label));
  }
  return row;
}

async function submitZappsRequest() {
  if (!me) { showToast('❌ Musisz być zalogowany.'); return; }
  const amountEl = document.getElementById('zapps-amount');
  const btn = document.getElementById('btn-zapps-submit');
  const amount = Math.floor(Number(amountEl.value) || 0);
  if (amount < 1) { showToast('❌ Podaj ile Zappsów (min. 1).'); amountEl.focus(); return; }

  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = 'Wysyłam…';
  try {
    const { data, error } = await sb.rpc('request_zapps_purchase', { p_amount: amount });
    if (error || !data?.ok) throw new Error(error?.message || 'rpc');
    showToast('✅ Zamówienie wysłane! Admin zatwierdzi je i przekaże Ci Zappsy.');
    loadZappsShop();
  } catch (err) {
    const msg = String(err.message || '');
    showToast('❌ ' + (msg.includes('too_many_pending') ? 'Masz już 5 oczekujących zamówień.'
      : msg.includes('insufficient_coins') ? 'Nie masz tylu coinów.'
      : msg.includes('pool_exhausted') ? 'Pula Zappsów została wyczerpana.'
      : msg.includes('exceeds_pool') ? 'Tyle Zappsów już nie ma w puli.'
      : msg.includes('amount_too_big') ? 'Za duża ilość.'
      : 'Nie udało się wysłać zamówienia.'));
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

async function resolveZapps(r, approve, btns) {
  if (!isAdmin()) return;
  let note = '';
  if (!approve) note = (prompt('Powód odrzucenia (opcjonalnie):', '') || '').trim();
  if (approve && !confirm('Zatwierdzić zakup ' + r.amount + ' 💎 (−' + r.amount + ' 🪙) dla ' + (r.nick_snapshot || '?') + '?')) return;
  btns.forEach(b => b.disabled = true);
  try {
    const { data, error } = await sb.rpc('resolve_zapps_purchase', { p_id: r.id, p_approve: approve, p_note: note });
    if (error || !data?.ok) throw new Error(error?.message || 'rpc');
    showToast(approve ? '✅ Zatwierdzono i pobrano coiny.' : '❌ Zamówienie odrzucone.');
    refreshMeCoins();
    loadZappsShop();
  } catch (err) {
    const msg = String(err.message || '');
    showToast('❌ ' + (msg.includes('already_resolved') ? 'To zamówienie jest już rozliczone.'
      : msg.includes('insufficient_coins') ? 'Gracz nie ma już tylu coinów.'
      : msg.includes('pool_exhausted') ? 'Pula Zappsów została wyczerpana.'
      : 'Nie udało się rozliczyć.'));
    btns.forEach(b => b.disabled = false);
  }
}

const btnZappsSubmit = document.getElementById('btn-zapps-submit');
if (btnZappsSubmit) btnZappsSubmit.addEventListener('click', submitZappsRequest);


// Shop create-item modal
const siOverlay = document.getElementById('si-overlay');
document.getElementById('btn-new-item').addEventListener('click', () => {
  document.getElementById('si-title').value = '';
  document.getElementById('si-desc').value  = '';
  document.getElementById('si-price').value = '1500';
  document.getElementById('si-slots').value = '1';
  show(siOverlay);
});
document.getElementById('si-close').addEventListener('click', () => hide(siOverlay));
siOverlay.addEventListener('click', e => { if (e.target === siOverlay) hide(siOverlay); });

document.getElementById('si-submit').addEventListener('click', async () => {
  const title = document.getElementById('si-title').value.trim();
  const desc  = document.getElementById('si-desc').value.trim();
  const price = parseInt(document.getElementById('si-price').value, 10);
  const slots = parseInt(document.getElementById('si-slots').value, 10);
  if (!title || !desc || !price || !slots) { showToast('❌ Wypełnij wszystkie pola.'); return; }

  const btn = document.getElementById('si-submit');
  btn.disabled = true; btn.textContent = 'Dodaję…';
  const { error } = await sb.rpc('create_store_item', {
    p_title: title, p_description: desc, p_price: price, p_slots: slots,
  });
  btn.disabled = false; btn.textContent = 'Dodaj nagrodę';
  if (error) { showToast('❌ ' + error.message); return; }
  hide(siOverlay);
  showToast('✅ Nagroda dodana!');
  loadShop();
});

// Marketplace sale-history (always available, even logged out)
document.getElementById('btn-ml-history')?.addEventListener('click', openMarketplaceHistory);

// Marketplace new-listing modal
const mlOverlay = document.getElementById('ml-overlay');
document.getElementById('btn-new-listing').addEventListener('click', () => openMarketplaceListingModal());
function openMarketplaceListingModal(opts = {}) {
  // Reset form
  mlIcon = '🛍️';
  mlListingType = 'fixed';
  document.getElementById('ml-icons').querySelectorAll('.nm-icon-btn').forEach(b => {
    b.classList.toggle('selected', b.textContent === '🛍️');
  });
  document.getElementById('ml-title').value = '';
  document.getElementById('ml-desc').value  = '';
  document.getElementById('ml-price').value = '100';
  document.getElementById('ml-duration').value  = '72';
  document.getElementById('ml-increment').value = '10';
  document.getElementById('ml-price-label').textContent = 'Cena (monet)';
  document.getElementById('ml-auction-opts').style.display = 'none';
  document.getElementById('ml-type-toggle').querySelectorAll('button').forEach(b => {
    b.classList.toggle('active', b.dataset.type === 'fixed');
  });
  mlSetSellKind(opts.kind || 'good', opts.ref || '');
  show(mlOverlay);
}
document.getElementById('ml-close').addEventListener('click', () => hide(mlOverlay));
mlOverlay.addEventListener('click', e => { if (e.target === mlOverlay) hide(mlOverlay); });

// "What are you selling?" — IRL good vs a Farma plant card / NFT / territory.
let mlSellKind = 'good';
function mlSetSellKind(kind, preselect = '') {
  mlSellKind = kind;
  document.getElementById('ml-sell-kind').querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.kind === kind));
  document.getElementById('ml-good-fields').style.display = kind === 'good' ? '' : 'none';
  document.getElementById('ml-item-field').style.display = kind === 'good' ? 'none' : '';
  // Only fungible plant cards can be bundled; NFTs and tiles are always a single unit.
  document.getElementById('ml-qty-field').style.display = kind === 'farm_card' ? '' : 'none';
  document.getElementById('ml-qty').value = '1';
  if (kind !== 'good') mlPopulateItemPicker(kind, preselect);
}
// How many level-1 duplicates of a species the seller can freely list (owned minus
// copies currently keeping a tile planted). Mirrors create_farm_card_listing's guard.
function mlFreeCardCount(species) {
  const owned = fmCollection.find(c => c.species === species)?.count || 0;
  let planted = 0;
  fmTiles.forEach(t => { if (t.owner_id === me?.id && t.planted_species === species) planted++; });
  return Math.max(0, owned - planted);
}
// Clamp the qty picker to how many free duplicates the selected card has.
function mlUpdateQtyMax() {
  if (mlSellKind !== 'farm_card') return;
  const species = document.getElementById('ml-item-select').value;
  const free = species ? mlFreeCardCount(species) : 0;
  const input = document.getElementById('ml-qty');
  const hint = document.getElementById('ml-qty-hint');
  input.max = Math.max(1, free);
  input.disabled = free < 1;
  if ((parseInt(input.value, 10) || 1) > free) input.value = String(Math.max(1, free));
  hint.textContent = free > 1 ? ('Masz ' + free + ' wolnych duplikatów tej karty do sprzedaży (jako jeden pakiet).')
                   : free === 1 ? 'Masz 1 wolny duplikat tej karty.'
                   : 'Brak wolnego duplikatu tej karty.';
}
async function mlPopulateItemPicker(kind, preselect = '') {
  const sel = document.getElementById('ml-item-select');
  const hint = document.getElementById('ml-item-hint');
  const label = document.querySelector('#ml-item-field .field-label');
  if (label) label.textContent = kind === 'farm_tile' ? 'Wybierz działkę z Ogródka' : 'Wybierz przedmiot z Ogródka';
  sel.replaceChildren(el('option', { value: '' }, 'Ładowanie…'));
  await ensureFarmData();
  sel.replaceChildren();
  if (kind === 'farm_nft') {
    const mine = fmNft.filter(n => n.owner_id === me?.id && !n.listed);
    if (!mine.length) { sel.append(el('option', { value: '' }, 'Brak kart NFT')); hint.textContent = 'Zdobądź kartę NFT ze skrzynki, aby ją wystawić.'; return; }
    mine.sort((a, b) => a.species.localeCompare(b.species) || a.serial_no - b.serial_no).forEach(n => {
      const def = fmDefs.get(n.species);
      sel.append(el('option', { value: n.id }, farmNftEmoji(n) + ' ' + (n.nft_name || def?.name || n.species) + ' #' + n.serial_no + '/' + n.edition_size + (n.level > 1 ? ' ' + '⭐'.repeat(n.level) : '')));
    });
    hint.textContent = 'Sprzedajesz konkretny, numerowany egzemplarz NFT.';
  } else if (kind === 'farm_tile') {
    const tiles = [];
    fmTiles.forEach((t, key) => {
      if (t.owner_id !== me?.id) return;
      if (t.acquired_via === 'migration' || t.planted_species || t.listed) return;
      const [x, y] = key.split(',').map(Number);
      tiles.push({ x, y, key, value: Number(t.asset_value || 0) });
    });
    if (!tiles.length) {
      sel.append(el('option', { value: '' }, 'Brak pustych działek'));
      hint.textContent = 'Możesz wystawić tylko pustą, niewystawioną działkę z Farmy.';
      return;
    }
    tiles.sort((a, b) => a.y - b.y || a.x - b.x).forEach(t => {
      sel.append(el('option', { value: t.key }, '🌱 Działka [' + t.x + ',' + t.y + ']' + (t.value ? ' · wartość ' + t.value + ' 🪙' : '')));
    });
    hint.textContent = 'Po wystawieniu na polu pojawi się tabliczka FOR SALE i nie będzie można sadzić do czasu sprzedaży albo anulowania.';
  } else {
    const owned = fmCollection.filter(c => c.count >= 1 && !(fmDefs.get(c.species)?.edition_size != null));
    if (!owned.length) { sel.append(el('option', { value: '' }, 'Brak wolnych duplikatów')); hint.textContent = 'Potrzebujesz co najmniej jednego duplikatu karty (poza NFT).'; return; }
    owned.sort((a, b) => (fmDefs.get(b.species)?.draw_weight || 0) - (fmDefs.get(a.species)?.draw_weight || 0)).forEach(c => {
      const def = fmDefs.get(c.species);
      sel.append(el('option', { value: c.species }, (def?.emoji || '🃏') + ' ' + (def?.name || c.species) + ' (masz ' + c.count + ')'));
    });
    hint.textContent = 'Sprzedajesz duplikaty (poziom 1) jako jeden pakiet. Twój poziom karty zostaje nienaruszony.';
  }
  if (preselect && [...sel.options].some(o => o.value === preselect)) sel.value = preselect;
  mlUpdateQtyMax();
}
document.getElementById('ml-item-select').addEventListener('change', mlUpdateQtyMax);
document.getElementById('ml-sell-kind').addEventListener('click', e => {
  const btn = e.target.closest('button[data-kind]'); if (!btn) return;
  mlSetSellKind(btn.dataset.kind);
});

// Listing type toggle (fixed / auction)
document.getElementById('ml-type-toggle').addEventListener('click', e => {
  const btn = e.target.closest('button[data-type]');
  if (!btn) return;
  mlListingType = btn.dataset.type;
  document.getElementById('ml-type-toggle').querySelectorAll('button').forEach(b => {
    b.classList.toggle('active', b === btn);
  });
  const isAuction = mlListingType === 'auction';
  document.getElementById('ml-auction-opts').style.display = isAuction ? '' : 'none';
  document.getElementById('ml-price-label').textContent = isAuction ? 'Cena wywoławcza (monet)' : 'Cena (monet)';
});

document.getElementById('ml-submit').addEventListener('click', () => {
  const price  = parseInt(document.getElementById('ml-price').value, 10);
  const hours  = parseInt(document.getElementById('ml-duration').value,  10) || 72;
  const incr   = parseInt(document.getElementById('ml-increment').value, 10) || 10;
  if (!price || price < 1) { showToast('❌ Podaj cenę większą od 0.'); return; }
  const btn = document.getElementById('ml-submit');
  if (mlSellKind === 'good') {
    const title = document.getElementById('ml-title').value.trim();
    const desc  = document.getElementById('ml-desc').value.trim();
    if (!title) { showToast('❌ Podaj tytuł ogłoszenia.'); return; }
    createMarketplaceListing(mlIcon, title, desc, mlListingType, price, hours, incr, btn);
  } else {
    const ref = document.getElementById('ml-item-select').value;
    if (!ref) { showToast('❌ Wybierz przedmiot do sprzedaży.'); return; }
    const listingRef = mlSellKind === 'farm_tile'
      ? { x: Number(ref.split(',')[0]), y: Number(ref.split(',')[1]) }
      : ref;
    let qty = 1;
    if (mlSellKind === 'farm_card') {
      qty = parseInt(document.getElementById('ml-qty').value, 10) || 1;
      const free = mlFreeCardCount(ref);
      if (qty < 1) { showToast('❌ Podaj liczbę sztuk większą od 0.'); return; }
      if (qty > free) { showToast('❌ Masz tylko ' + free + ' wolnych duplikatów tej karty.'); return; }
    }
    createFarmListing(mlSellKind, listingRef, mlListingType, price, hours, incr, btn, qty);
  }
});

// ── Buy orders / requests (Zlecenia zakupu) — modal + subtab wiring ────────
document.getElementById('bo-subtabs')?.addEventListener('click', e => {
  const btn = e.target.closest('button[data-bo-target]');
  if (!btn) return;
  document.getElementById('bo-subtabs').querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
  document.getElementById('bo-fixed').style.display = btn.dataset.boTarget === 'bo-fixed' ? '' : 'none';
  document.getElementById('bo-open').style.display  = btn.dataset.boTarget === 'bo-open'  ? '' : 'none';
});

const boOverlay = document.getElementById('bo-overlay');
let boKind = 'farm_card';
function openBuyOrderModal() {
  boKind = 'farm_card';
  document.getElementById('bo-kind').querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.kind === boKind));
  document.getElementById('bo-price').value = '10';
  document.getElementById('bo-qty').value = '10';
  boPopulateSpeciesPicker(boKind);
  show(boOverlay);
}
document.getElementById('btn-new-buy-order')?.addEventListener('click', openBuyOrderModal);
document.getElementById('bo-close')?.addEventListener('click', () => hide(boOverlay));
boOverlay?.addEventListener('click', e => { if (e.target === boOverlay) hide(boOverlay); });
document.getElementById('bo-kind')?.addEventListener('click', e => {
  const btn = e.target.closest('button[data-kind]');
  if (!btn) return;
  boKind = btn.dataset.kind;
  document.getElementById('bo-kind').querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
  boPopulateSpeciesPicker(boKind);
});
// Species picker lists EVERY defined species of the chosen kind (not just owned
// ones) — the buyer wants to acquire cards, so ownership is irrelevant here.
async function boPopulateSpeciesPicker(kind) {
  const field = document.getElementById('bo-species-field');
  const sel = document.getElementById('bo-species');
  const hint = document.getElementById('bo-hint');
  if (kind === 'farm_tile') {
    field.style.display = 'none';
    hint.textContent = 'Kupujesz dowolną pustą działkę Ogródka od innego gracza.';
    return;
  }
  field.style.display = '';
  await ensureFarmData();
  sel.replaceChildren();
  const wantNft = kind === 'farm_nft';
  const defs = [...fmDefs.values()].filter(d => wantNft ? d.edition_size != null : d.edition_size == null);
  if (!defs.length) { sel.append(el('option', { value: '' }, 'Brak gatunków')); return; }
  defs.sort((a, b) => (a.name || '').localeCompare(b.name || '')).forEach(d => {
    sel.append(el('option', { value: d.species }, (d.emoji || (wantNft ? '💎' : '🃏')) + ' ' + d.name));
  });
  hint.textContent = wantNft ? 'Kupisz dowolny numerowany egzemplarz tego gatunku NFT.' : 'Kupisz dowolne duplikaty (poziom 1) tej karty.';
}
document.getElementById('bo-submit')?.addEventListener('click', () => {
  const price = parseInt(document.getElementById('bo-price').value, 10);
  const qty = parseInt(document.getElementById('bo-qty').value, 10);
  const species = document.getElementById('bo-species').value;
  if (!price || price < 1) { showToast('❌ Podaj cenę większą od 0.'); return; }
  if (!qty || qty < 1) { showToast('❌ Podaj liczbę sztuk większą od 0.'); return; }
  if (boKind !== 'farm_tile' && !species) { showToast('❌ Wybierz gatunek.'); return; }
  createBuyOrder(boKind, species, price, qty, document.getElementById('bo-submit'));
});

const reqOverlay = document.getElementById('req-overlay');
document.getElementById('btn-new-request')?.addEventListener('click', () => {
  document.getElementById('req-desc').value = '';
  show(reqOverlay);
});
document.getElementById('req-close')?.addEventListener('click', () => hide(reqOverlay));
reqOverlay?.addEventListener('click', e => { if (e.target === reqOverlay) hide(reqOverlay); });
document.getElementById('req-submit')?.addEventListener('click', () => {
  const desc = document.getElementById('req-desc').value.trim();
  if (!desc) { showToast('❌ Opisz czego szukasz.'); return; }
  createMarketplaceRequest(desc, document.getElementById('req-submit'));
});

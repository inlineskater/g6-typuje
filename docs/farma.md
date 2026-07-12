# Ogródek (Farma) i Skrzynki

Opis logiki z `supabase/farm.sql` (+ `farm-price-history.sql`, `farm-marketplace.sql`, `nft-leveling-rework.sql`, `nft-merge-fixes.sql`) oraz UI w `index.html`. Zakładka w aplikacji nazywa się **🌱 Ogródek**; kod wewnętrznie używa nazwy `farm`.

## Pętla gry

1. Kup działkę (albo postaw ją darmowym voucherem ze skrzynki).
2. Kup skrzynkę w **Sklep → 🎁 Skrzynki** (100 🪙), otwórz ją w **🎒 Mój Majątek** → 3 różne karty roślin.
3. Ulepszaj karty duplikatami + coinami (NFT: łączeniem dwóch egzemplarzy).
4. Zasadź kartę na własnym pustym polu, poczekaj (pełne dni), zbierz plon.
5. Sprzedaj plon NPC, gdy cena jest wysoko — cena faluje jak na „stalk markecie".

Nawigacja: drewniany pasek nad polem ma przyciski **🎒 Mój Majątek / 📖 Katalog / 📈 Cennik / ❓ Jak to działa / 📦 Skrzynki**, wszystkie otwierają jeden modal-hub (`openFarmHub`). Pod polem jest inspektor klikniętego kafelka, a przełącznik **📋 Widok tabeli** pokazuje te same dane jako sortowalną/filtrowalną tabelę.

## Siatka i działki

Plansza ma **13 × 4 = 52 pola**. Typy: wolne (brak wpisu w `farm_tiles`), migracyjne (`acquired_via='migration'` — rośliny zen z dawnego Ogródka, podlewane co 5 h / maks. 3× dziennie, nie da się na nich sadzić upraw), kupione (`purchase`), z vouchera (`lootbox`), z Targowiska (`marketplace`).

Cena kolejnej działki podwaja się (`buy_farm_tile`, BURN `farm_tile_buy`):

```text
cena = min(50000, floor(350 × 2^liczba_posiadanych_pól))   → 350, 700, 1400, 2800…
```

Backend liczy wszystkie pola gracza, także migracyjne. Voucher stawia działkę za 0 🪙, ale podnosi cenę następnych.

### Podatek gruntowy (kataster)

Miękki limit — kupować i sadzić można zawsze, ale nadmiar ponad sprawiedliwy przydział jest opodatkowany. Pola migracyjne nie liczą się do limitu.

```text
limit_gracza    = ceil(normalne_pola_na_planszy / aktywni_gracze_farmy)
podatek_dzienny = 1000 × nadmiar²      (nadmiar = pola_gracza − limit)
odsetki         = 10% długu dziennie
```

Naliczanie: codziennie o **00:00 Europe/Warsaw** za poprzedni dzień (pierwsza płatność 03.07.2026 za 02.07.2026). Podatek ściąga się automatycznie z portfela, a niedopłata staje się długiem. **Tylko niespłacony dług** blokuje kupno działek i nowe sadzenie; dług spłaca się też automatycznie z przychodów ze sprzedaży plonów i farmowych transakcji na Targowisku.

## Skrzynka z nasionami

Jedna skrzynka: **100 🪙** (`buy_farm_lootbox`, BURN `farm_box_buy`), kupowana w Sklepie, otwierana w Moim Majątku (`open_farm_lootbox`). Otwarcie losuje **3 różne** aktywne karty (ważone `draw_weight`; NFT tylko dopóki edycja niewyprzedana — o podaży decyduje licznik `farm_card_defs.minted_count`, więc spalone w fuzjach egzemplarze nie wracają do puli).

Nowy gracz dostaje jednorazowo **3 darmowe skrzynki** (`claim_farm_starter`); dopóki nie ma żadnej ziemi ani vouchera, w tych 3 otwarciach ma **gwarantowany voucher na darmową działkę**. Naturalna szansa vouchera to 7%, dzielona przez 3 za każde posiadane pole/voucher. Analogicznie każde posiadane NFT dzieli wagę kolejnych NFT przez 3 (anti-hoarding).

Bazowe wagi (suma 133, z czego NFT 5):

| Rzadkość | Wagi | Szansa/losowanie |
|---|---:|---:|
| zwykła (🥕 30, 🥔 28, 🍅 24) | 82 | 61.7% |
| rzadka (🌽 13, 🌶️ 12, 🍓 9) | 34 | 25.6% |
| epicka (🎃 5, 🍇 4, 🍍 3) | 12 | 9.0% |
| NFT (🌹 2, 🌻 1, 🪷 1, 🍌 1) | 5 | 3.8% |

Czasy wzrostu/plony bazowe: zwykłe 1 dzień, rzadkie 2 dni, epickie 3–4 dni; dokładne statystyki i aktualne ceny pokazuje w aplikacji **📖 Katalog** (liczone na żywo z `farm_card_defs`/`farm_market`).

### Złota Skrzynia ⭐ (premium)

Druga, droższa skrzynka (`supabase/farm-goldbox.sql`), całkowicie niezależna od zwykłej — osobny licznik `boxes_gold`, osobne RPC (`buy_farm_goldbox`, `open_farm_goldbox`/`open_farm_goldboxes`). Kupowana w Sklepie, otwierana w **🎒 Mój Majątek → 📦 Skrzynki**, tak samo jak zwykła skrzynka.

- Cena: **500 🪙** za sztukę (BURN `farm_goldbox_buy`).
- Otwarcie losuje **5 kart** (zamiast 3), z gwarancją, że przynajmniej jedno trafienie będzie **rzadkie lub lepsze** (rare/epic/legendary), jeśli taka karta jest w ogóle losowalna.
- Szansa na voucher na działkę jest wyższa: baza **0.15** (zamiast 0.07), dzielona tak samo przez posiadane pola/vouchery.
- Waga kolejnych NFT tego samego gatunku maleje szybciej — dzielona przez `2^liczba_posiadanych_NFT` (zamiast przez 3 jak w zwykłej skrzynce).
- Nie bierze udziału w starterowym gwarantowanym voucherze (`claim_farm_starter`) — to tylko dla zwykłych skrzynek.
- W wycenie majątku (Net Worth) każda nieotworzona Złota Skrzynia liczy się jako **500 🪙**.

## Karty roślin i poziomy

Karta to trwały „przepis" — sadzenie jej nie zużywa. Duplikaty służą do ulepszania (`level_up_card`, BURN `card_levelup`):

```text
poziom L → L+1:  2×L duplikatów + 50×L² 🪙     (1→2: 2+50, 2→3: 4+200, 3→4: 6+450…)
plon        = round(bazowy × (1 + (L−1) × 0.5))          (+50%/poziom)
czas_wzrostu = max(24 h, bazowy × 0.92^(L−1))            (−8%/poziom, nigdy < 24 h)
```

Poziom zapisuje się w `planted_level` w momencie sadzenia — ulepszenie w trakcie wzrostu działa dopiero od następnego zasiewu. Limit sadzenia: jednocześnie tyle upraw danego gatunku, ile masz sztuk karty.

Zbiór (`harvest_crop`) mintuje plon do `farm_inventory` jako **partię, która gnije 5 dni po zebraniu** (`farm_rot_cleanup` czyści przeterminowane co noc).

## Sprzedaż plonów — „stalk market"

`sell_crop_to_npc` (MINT `farm_crop_sale`) zdejmuje partie FIFO (najpierw najbliższe zgnicia) i płaci żywą cenę `cur_price` z `farm_market`:

- **Kotwica dnia**: 2× dziennie (00:00 i 12:00 Europe/Warsaw) `roll_farm_prices()` losuje nową kotwicę w przedziale **30–100% ceny maksymalnej** (`base_price` z katalogu; średnio ≈ 57%).
- **Sprzedaż zbija cenę**: jedna transakcja obniża `cur_price` o `min(40%, 0.5% × ilość)`; partia jest rozliczana po średniej ceny przed/po. Podłoga: 30% maksimum.
- **Powrót**: cena odbudowuje się ku kotwicy ~12%/h.

Klient ma wierną replikę tej matematyki w `farmSellQuote` (podgląd przed potwierdzeniem) — **musi zostać w synchronizacji z `sell_crop_to_npc`**. Historię 7 dni na roślinę rysuje zakładka **📈 Cennik** (`farm_price_history`), a publiczny feed 🧾 pokazuje wszystkie sprzedaże.

## Kontrakt tygodnia

`farm-seasonal-contracts.sql` dodaje cotygodniowe kontrakty na jedną istniejącą roślinę. Pierwszy start: **poniedziałek 06.07.2026 00:00 Europe/Warsaw**, **🥕 Marchewka**. Klient pokazuje to w hubie farmy jako **🏆 Wyzwanie**.

Do wyniku liczą się tylko sztuki aktywnej rośliny **zebrane i sprzedane w tym samym tygodniu eventu**. Stare partie można sprzedać normalnie, ale nie dają premii, punktów rankingu ani wkładu do paska.

Event odświeża żywe parametry farmy do pierwszej zaliczonej sprzedaży, potem zamraża je dla uczciwego rankingu:

```text
uczestnicy            = farm_land_tax_participant_count()
fair_cap              = farm_fair_cap()
dni_wzrostu           = max(1, base_grow_minutes / 1440)
cykle_tygodnia        = floor(7 / dni_wzrostu)
sztuk/działkę/tydzień = cykle_tygodnia × base_yield
fair_cap/gracz        = fair_cap × sztuk/działkę/tydzień
pasek                 = ceil_do_25(uczestnicy × fair_cap × sztuk/działkę/tydzień × 0,35)
```

Premia za sztukę celuje w ok. **125% najlepszego zwykłego plonu**, zaokrąglone do 10 🪙/działkę/dzień. Przy obecnym balansie daje target **150 🪙/działkę/dzień**, więc Marchewka dostaje **+31 🪙/szt.**.

Nagrody tygodnia:

- 1. miejsce: **2500 🪙 + losowa karta NFT** z pozostałej podaży (`minted_count`; fallback 10 skrzynek, jeśli NFT się wyprzedały).
- 2. miejsce: **1500 🪙 + 5 skrzynek**.
- 3. miejsce: **1000 🪙 + 2 skrzynki**.
- Jeśli wspólny pasek się zapełni, każdy kontrybutor z **min. 1 sprzedaną sztuką** dostaje **5 skrzynek**.

## Karty NFT (legendarne, numerowane)

Karty z `edition_size` to limitowane NFT: 🌹 Diamentowa Róża (25 szt.), 🌻 Złoty Słonecznik (15), 🪷 Kryształowy Lotos (10), 🍌 Królewski Banan Ae Ae (8 — najrzadszy i najmocniejszy). Wypadają z tej samej skrzynki; przy trafieniu serwer mintuje unikalny numer seryjny + zabawne imię-personę do `farm_nft_instances` (kolejny serial pochodzi z monotonicznego `minted_count`, nie z liczby żywych egzemplarzy).

**Poziom siedzi na egzemplarzu** (`farm_nft_instances.level`), nie na gatunku:

- Ulepszanie przez **fuzję** (`level_up_nft`): dwa egzemplarze tego samego gatunku i poziomu → „bohater" awansuje, „paliwo" jest **spalane na zawsze** (edycja trwale się kurczy). Koszt: 50 × poziom² 🪙. Obie karty muszą być niewystawione i niezasadzone.
- Sadzenie NFT wskazuje konkretny egzemplarz (`plant_crop(..., p_instance_id)`); rośnie według jego poziomu.
- Historia każdego egzemplarza (mint / sprzedaże / fuzje) jest w `farm_nft_transfers` i w eksploratorze edycji (klik w NFT w Katalogu); spalone egzemplarze pokazują 🔥.

Wycena w majątku (Net Worth): NFT = `round(20000 / edycja) × poziom` za egzemplarz; zwykłe karty = 20/50/150 🪙 wg rzadkości; do tego działki wg `asset_value`, skrzynki ×100, vouchery ×350, plony po cenie rynkowej. Wpięte w `economy-stats.sql` i `leaderboard-net-worth-items.sql`.

## Odsprzedaż (Targowisko)

`farm-marketplace.sql` pozwala wystawiać duplikaty kart (sprzedawane jako poziom 1), egzemplarze NFT (poziom podróżuje z kartą) i puste niemigracyjne działki — silnik aukcji/escrow Targowiska, coiny przechodzą kupujący → sprzedający (autospłata podatku z przychodu). Wystawiona działka ma tabliczkę FOR SALE i nie można na niej sadzić.

## Uprawnienia

Klient nie zapisuje tabel farmy bezpośrednio — wszystkie mutacje to RPC `SECURITY DEFINER`: `buy_farm_tile`, `claim_farm_starter`, `buy_farm_lootbox`, `open_farm_lootbox`, `level_up_card`, `level_up_nft`, `plant_crop`, `harvest_crop`, `sell_crop_to_npc`, `pay_farm_land_tax` + funkcje Targowiska. RLS: katalog/pola/rynek/NFT publiczne do odczytu, kolekcja/inwentarz/stan gracza tylko własne wiersze.

## Strojenie balansu

- `farm_card_defs`: `draw_weight` (szanse), `base_grow_minutes`, `base_yield`, `edition_size`.
- `farm_market.base_price`: cena maksymalna (pułap kotwicy).
- Pasma kotwicy (30–100%) w `roll_farm_prices()`; matematyka sprzedaży zduplikowana w `sell_crop_to_npc` + `farmSellQuote`.
- Kontrakty tygodnia: rotacja i start w `farm_seasonal_species_for_week()`, target paska i premia w `ensure_farm_seasonal_event()`, nagrody w `award_farm_seasonal_week()`.
- Cena skrzynki: `FARM_BOX_PRICE` w `index.html` **i** `v_cost` w `buy_farm_lootbox` — zmieniać razem.
- Na żywej bazie używaj `supabase/farm-anti-hoarding.sql` zamiast pełnego `farm.sql` (pełny plik resetuje ceny rynku).

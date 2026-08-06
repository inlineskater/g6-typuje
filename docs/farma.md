# Ogródek (Farma) i Skrzynki

Opis logiki z `supabase/farm.sql` (+ `farm-price-history.sql`, `farm-marketplace.sql`, `nft-leveling-rework.sql`, `nft-merge-fixes.sql`, `farm-static-nft-odds.sql`, `farm-weekly-nft-series.sql`, `farm-nft-series-window.sql`) oraz UI w `index.html`. Zakładka w aplikacji nazywa się **🌱 Ogródek**; kod wewnętrznie używa nazwy `farm`.

## Pętla gry

1. Kup działkę (albo postaw ją darmowym voucherem ze skrzynki).
2. Kup skrzynkę w **Sklep → 🎁 Skrzynki** (100 🪙), otwórz ją w **🎒 Mój Majątek** → 3 różne karty roślin.
3. Ulepszaj karty duplikatami + coinami (NFT: łączeniem dwóch egzemplarzy).
4. Zasadź kartę na własnym pustym polu, poczekaj (pełne dni), zbierz plon.
5. Sprzedaj plon NPC, gdy cena jest wysoko — cena faluje jak na „stalk markecie".

Nawigacja: drewniany pasek nad polem ma przyciski **🎒 Mój Majątek / 📖 Katalog / 📈 Cennik / ❓ Jak to działa / 📦 Skrzynki**, wszystkie otwierają jeden modal-hub (`openFarmHub`). Pod polem jest inspektor klikniętego kafelka, a przełącznik **📋 Widok tabeli** pokazuje te same dane jako sortowalną/filtrowalną tabelę.

## Siatka i działki

Plansza ma **13 × 4 = 52 pola**. Typy: wolne (brak wpisu w `farm_tiles`), migracyjne (`acquired_via='migration'` — rośliny zen z dawnego Ogródka, podlewane co 5 h / maks. 3× dziennie; limit dnia resetuje się o **00:00 Europe/Warsaw**, nie według UTC; nie da się na nich sadzić upraw), kupione (`purchase`), z vouchera (`lootbox`), z Targowiska (`marketplace`).

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

Nowy gracz dostaje jednorazowo **3 darmowe skrzynki** (`claim_farm_starter`); dopóki nie ma żadnej ziemi ani vouchera, w tych 3 otwarciach ma **gwarantowany voucher na darmową działkę**. Naturalna szansa vouchera to 7%, dzielona przez 3 za każde posiadane pole/voucher.

**Szansa na NFT jest stała dla każdego** (`supabase/farm-static-nft-odds.sql`, 17.07.2026) — dawny anti-hoarding (waga dzielona przez `3^posiadane_NFT`) został usunięty; jedynym ograniczeniem podaży jest limit nakładu edycji. Przy okazji wagi wszystkich kart nie-NFT zostały podwojone, więc udział NFT jest o połowę mniejszy niż w pierwotnej tabeli.

Bazowe wagi (suma 262, z czego NFT 6):

| Rzadkość | Wagi | Szansa/losowanie |
|---|---:|---:|
| zwykła (🥕 60, 🥔 56, 🍅 48) | 164 | 62.6% |
| rzadka (🌽 26, 🌶️ 24, 🍓 18) | 68 | 26.0% |
| epicka (🎃 10, 🍇 8, 🍍 6) | 24 | 9.2% |
| NFT (żywe edycje tygodniowe, 1–2 każda) | 6 | 2.3% |

Wiersz NFT jest **zmienny** — to suma wag edycji aktualnie w puli (patrz niżej), a nie stała. Na całą skrzynkę (3 losowania) daje to **≈ 6.9% na dowolne NFT**; aplikacja liczy tę wartość na żywo z `farm_card_defs` (`farmAnyNftChancePct`), więc nie trzeba jej tu aktualizować ręcznie.

Czasy wzrostu/plony bazowe: zwykłe 1 dzień, rzadkie 2 dni, epickie 3–4 dni; dokładne statystyki i aktualne ceny pokazuje w aplikacji **📖 Katalog** (liczone na żywo z `farm_card_defs`/`farm_market`).

### Złota Skrzynia ⭐ (premium) — WYCOFANA ZE SPRZEDAŻY (27.07.2026)

Druga, droższa skrzynka (`supabase/farm-goldbox.sql`), całkowicie niezależna od zwykłej — osobny licznik `boxes_gold`, osobne RPC (`buy_farm_goldbox`, `open_farm_goldbox`/`open_farm_goldboxes`). Otwierana w **🎒 Mój Majątek → 📦 Skrzynki**, tak samo jak zwykła skrzynka.

**Nie da się jej już kupić** (`supabase/farm-goldbox-no-sale.sql`): `buy_farm_goldbox` rzuca `goldbox_not_for_sale` i nie ma grantu dla `authenticated`, a w aplikacji nie ma żadnego przycisku zakupu. Nieotwarte sztuki nadal działają — otwieranie i wycena majątku zostały nietknięte. Poniższe parametry opisują więc już tylko to, co robi otwarcie posiadanej skrzyni:

- Dawna cena: **500 🪙** za sztukę (BURN `farm_goldbox_buy`) — już niedostępna.
- Otwarcie losuje **5 kart** (zamiast 3), z gwarancją, że przynajmniej jedno trafienie będzie **rzadkie lub lepsze** (rare/epic/legendary), jeśli taka karta jest w ogóle losowalna.
- Szansa na voucher na działkę jest wyższa: baza **0.15** (zamiast 0.07), dzielona tak samo przez posiadane pola/vouchery.
- Szansa na NFT jest **stała**, tak samo jak w zwykłej skrzynce — dawne dzielenie wagi przez `2^liczba_posiadanych_NFT` zostało usunięte razem z anti-hoardingiem. Dzięki 5 losowaniom i gwarancji rzadkiej karty wychodzi **≈ 16.4% na dowolne NFT** na skrzynię (dzielnik terytorium przy voucherze został bez zmian).
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

**Każda kwota „ile dostanę" musi iść przez `farmSellQuote`, nigdy przez `ilość × cena`** — ta partia sama zbija cenę, więc naiwny iloczyn zawyża wypłatę (przy 210 szt. o ~20%) i podaje nieosiągalny górny zakres. `farmSellQuote(crop, qty, spotOverride)` przyjmuje opcjonalną cenę hipotetyczną wyłącznie po to, by widełki min–max na popupach liczyły się tym samym wzorem; ścieżka bez `spotOverride` pozostaje dokładnym lustrem `sell_crop_to_npc`.

**Jedna skala dla wszystkich wskaźników ceny: `cur / base_price` („% ceny maks.", pasmo 30–100%)** — tę liczbę drukuje `farmTrendChip`, jej dotyczą progi kolorów (≥80 ▲ / ≤50 ▼) i na niej opierają się paski (`FARM_PRICE_FLOOR_PCT` rysuje podłogę 30% jako zakreskowaną martwą strefę, a wypełnienie biegnie od niej do ceny). Paski normalizowane osobno na `floor→base` pokazywały przy chipie „▼41% maks." wypełnienie 16%, a przy 60% maks. potrafiły dać bursztynowy chip obok czerwonego paska.

**Cena w otwartym popupie musi być odświeżana, nie zamrożona przy otwarciu.** Kotwica przeskakuje 2× dziennie z `pg_cron`, a `loadFarm()` pobiera `farm_market` tylko przy WEJŚCIU w zakładkę; realtime nigdy nie odtwarza zdarzeń przegapionych przy uśpionym gnieździe. Dlatego: `pollFarmMarketPrices()` (co 60 s z `startFarmTimer`, wymuszony na `visibilitychange`) sam się leczy, a popupy rejestrują callback w `fmPriceRefreshHooks`, który odpala `scheduleFarmMarketUiRefresh()`. Bez tego roślina zostawiona otwarta przez 12:00 pokazywała cenę z poprzedniego okna godzinami — i to z tykającym odliczaniem obok, więc wyglądała na żywą (zgłoszone 2026-08-06).

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

Nagrody są rozliczane w poniedziałek dokładnie o **00:00 Europe/Warsaw**. Harmonogram próbuje oba możliwe przesunięcia UTC i wykonuje wypłatę tylko wtedy, gdy lokalna godzina Warszawy wynosi 00, więc zmiana czasu letni/zimowy nie przesuwa wypłaty.

## Karty NFT (legendarne, numerowane)

Karty z `edition_size` to limitowane NFT. Wypadają z tej samej skrzynki; przy trafieniu serwer mintuje unikalny numer seryjny + zabawne imię-personę do `farm_nft_instances` (kolejny serial pochodzi z monotonicznego `minted_count`, nie z liczby żywych egzemplarzy).

Pierwsza czwórka — 🌹 Diamentowa Róża (25 szt.), 🌻 Złoty Słonecznik (15), 🪷 Kryształowy Lotos (10), 🍌 Królewski Banan Ae Ae (8) — jest **w całości wyprzedana** (stan 27.07.2026), więc ze skrzynek lecą już tylko kolekcje tygodniowe opisane niżej. Hybrydy z krzyżowania też mają `edition_size`, ale `draw_weight = 0`, więc nigdy nie wypadają ze skrzynki.

### Kolekcje tygodniowe (okno 3 edycji)

`supabase/farm-weekly-nft-series.sql` + `supabase/farm-nft-series-window.sql`. Co poniedziałek 00:00 Europe/Warsaw startuje nowa limitowana kolekcja (`series_week`, nakład 5–10 sztuk, wszystkie zbierają wspólny plon `seasonal_bloom`). Edycja leci, aż wyczerpie się nakład.

Jedna edycja naraz **nie wytrzymywała własnego tygodnia**: biuro otwiera ~320 zwykłych + ~70 złotych skrzynek tygodniowo, co przy obecnych wagach daje **≈ 14 oczekiwanych trafień NFT** przy nakładzie 8 (Lawenda Prowansalska straciła 4 z 8 numerów w pierwszych 8 godzinach swojego poniedziałku). Po wyprzedaniu wszystkich żywych edycji filtr `minted_count < edition_size` wyrzuca je z puli i skrzynka **po cichu przestaje dawać NFT** — nie ma błędu, `pool_empty` leci dopiero, gdy pula jest pusta całkowicie (niemożliwe, dopóki żyje 9 nielimitowanych roślin), więc gracz dostaje same zwykłe karty za pełną cenę.

Dlatego edycje aktywują się **2 tygodnie wcześniej** (`farm_nft_series_lead_weeks()`, mirror `FARM_NFT_SERIES_LEAD_WEEKS` w `index.html`): w puli krążą zawsze **3 kolekcje** (bieżąca + 2 kolejne), a co poniedziałek dochodzi jedna nowa. Podaż tygodniowa jest ta sama — to wygładzenie, nie inflacja. Funkcje losujące są **nietknięte**: filtrują już `is_active AND draw_weight > 0 AND minted_count < edition_size`, więc wystarczyło poszerzyć horyzont aktywacji (`farm_activate_weekly_nft()` + widok `farm_nft_series_schedule`, oba używają `farm_nft_series_horizon()`). `series_week` nadal oznacza ogłoszoną premierę, a `farm_mint_random_event_nft` (nagroda dla zwycięzcy Wyzwania) nadal preferuje kolekcję bieżącego tygodnia.

Gdyby pula mimo to kiedyś zeszła do zera NFT, aplikacja mówi to wprost zamiast pokazywać ciche „0.00%": `farmNftPoolStatus()`/`farmNftDroughtBanner()`/`farmBoxNftFeatText()` wstawiają bursztynowy baner na obie karty skrzynek i w tabelę szans, a linijka 💎 zmienia się na „brak — wszystkie edycje wyprzedane" wraz z nazwą kolekcji wchodzącej w poniedziałek.

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
- Podaż NFT na tydzień: `edition_size` w rotacji (`farm-weekly-nft-series.sql`) **i** szerokość okna `farm_nft_series_lead_weeks()` / `FARM_NFT_SERIES_LEAD_WEEKS` — zmieniać razem, bo razem decydują, ile numerów jest w puli naraz. Rotację trzymaj zgodną z `NFT_SERIES_ROTATION` w `index.html`.
- Na żywej bazie używaj `supabase/farm-anti-hoarding.sql` zamiast pełnego `farm.sql` (pełny plik resetuje ceny rynku).

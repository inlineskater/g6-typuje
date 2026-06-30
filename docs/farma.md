# Ogródek (Farma) i Skrzynki

Dokument opisuje aktualną logikę z `supabase/farm.sql` oraz UI w `index.html`.

> **Nazewnictwo:** w aplikacji ta funkcja to zakładka **🌱 Ogródek** (wewnętrznie kod nadal używa nazwy „Farma" / `farm`). Stary widok zen jest ukryty z nawigacji, ale jego podlewanie i ozdoby nadal działają na kafelkach migracyjnych w nowym Ogródku. **Certyfikat Drugiego Ogródka** działa bez zmian (odblokowuje drugą roślinę zen, która pokazuje się jako kafelek migracyjny w Ogródku).

## Szybki skrót

Farma łączy dwie rzeczy:

- **Rośliny z Ogródka**: istniejące rośliny użytkowników są pokazane na pierwszych polach farmy. To nadal te same rośliny z Ogródka i mają podlewanie co 5 godzin, maksymalnie 3 razy dziennie.
- **Uprawy z kart**: gracz kupuje działki, otwiera skrzynki z nasionami, zbiera karty roślin, sadzi uprawy na swoich działkach, czeka aż dojrzeją, zbiera plony i sprzedaje je NPC za coiny.

Główna pętla ekonomii:

1. Kup działkę.
2. Kup i otwórz skrzynkę z nasionami.
3. Zdobądź kartę rośliny albo duplikat.
4. Ulepsz kartę duplikatami i coinami.
5. Zasadź roślinę na własnej pustej działce.
6. Po czasie wzrostu zbierz plon.
7. Sprzedaj plon NPC po dynamicznej cenie.

## Gdzie to jest w aplikacji

- `🌱 Ogródek`: widok siatki farmy, wybranej działki, kart roślin oraz plonów.
- W panelu bocznym Ogródka są przyciski: `📖 Katalog roślin`, `❓ Jak to działa`, `🎒 Ekwipunek`, `📦 Skrzynki z nasionami w Sklepie ->`.
- `🛒 Sklep -> 🎁 Skrzynki`: sklep ze skrzynką z nasionami.
- `💼 Portfel`: szybki link `🎒 Ekwipunek Ogródka` otwiera to samo okno ekwipunku.

## Katalog i Ekwipunek

**📖 Katalog roślin** to okno-ściągawka „co można zdobyć". Pokazuje wszystkie aktywne karty z `farm_card_defs` (rośliny + karty NFT) jako **jeden, ujednolicony widok kart** (`farmCatalogCards`/`farmCatalogCard`) — bez przełącznika Tabela/Galeria. Każda karta łączy wizualny wygląd (emoji, kolor rzadkości) z **czytelnie opisanymi statystykami** (etykieta + wartość): Szansa w skrzynce, Czas wzrostu, Plon z 1 zbioru, Cena NPC oraz Twój stan.

Karty są **pogrupowane po rzadkości z nagłówkami** (🌱 Zwykłe → 🌿 Rzadkie → ✨ Epickie → 💎 Karty NFT). Karty NFT zawsze trafiają do **osobnej, wyróżnionej sekcji „💎 Karty NFT"** (z podtytułem wyjaśniającym, że to limitowane, numerowane okazy z tej samej skrzynki) — nie giną już na końcu listy.

Stan karty to: `✅ Masz: poziom L · N szt.` (rośliny) albo `✅ Twoje numery: #…` (NFT), lub `🔒 Jeszcze nie masz` / `— wyprzedane`. Karty NFT pokazują dodatkowo, ile sztuk z edycji zostało (np. `💎 Pozostało: 22 z 25`).

**🎒 Ekwipunek** to zebrane w jednym miejscu zasoby gracza:

- **💎 Karty NFT** — siatka Twoich numerowanych okazów (`#serial / edycja`); sekcja jest **zawsze widoczna** — gdy nie masz jeszcze NFT, pokazuje podpowiedź, że wypadają (rzadko) ze skrzynki za 100 🪙,
- **🃏 Karty roślin** — każda posiadana karta z poziomem, postępem duplikatów i przyciskiem ulepszenia (to samo `level_up_card`),
- **🧺 Plony** — każdy plon z ilością, aktualną ceną i przyciskiem sprzedaży (to samo `sell_crop_to_npc`); na dole łączna szacowana wartość plonów.

Oba okna są dostępne także zanim wejdzie się na zakładkę — dane doczytuje `ensureFarmData()`.

## Siatka farmy i działki

Farma ma aktualnie **13 kolumn x 4 rzędy**, czyli 52 pola.

Typy pól:

- **Brak wpisu w `farm_tiles`**: pole wolne, można je kupić.
- **`acquired_via = 'migration'`**: pole zajęte przez roślinę z Ogródka. Nie da się sadzić tam upraw z kart.
- **`acquired_via = 'purchase'`**: kupiona działka, można sadzić uprawy.
- **`acquired_via = 'lootbox'`**: działka postawiona z darmowego vouchera ze skrzynki.

Cena kupna działki rośnie z liczbą posiadanych pól:

```text
cena = min(50000, floor(350 * 2 ^ liczba_posiadanych_pól))
```

Sekwencja startuje od **350 → 700 → 1400 → 2800 → 5600** coinów i blokuje się na 50000. Backend liczy wszystkie pola gracza w `farm_tiles`, w tym pola migracyjne z Ogródka. Voucher nadal stawia jedną działkę za 0 coinów, ale ta działka podnosi cenę kolejnych.

Kupno działki to spalanie coinów (`farm_tile_buy`).

## Rośliny z Ogródka na farmie

Rośliny z Ogródka są wyświetlane na farmie jako miniaturowe doniczki. To nie są uprawy z kart.

Zasady:

- Podlewanie działa tak jak w Ogródku.
- Cooldown podlewania: **5 godzin**.
- Limit dzienny: **3 podlania dziennie**.
- Na farmie dokładny czas następnego podlewania jest w hoverze oraz w oknie szczegółów po kliknięciu rośliny.
- Dla własnych roślin widoczna jest cienka niebieska linia pod rośliną. Linia pokazuje postęp do następnego podlewania.
- Gdy własna roślina jest gotowa do podlewania, kliknięcie rośliny podlewa ją bezpośrednio.
- Rośliny innych graczy nie pokazują niebieskiej linii i po kliknięciu otwierają tylko szczegóły.

## Skrzynka z nasionami

Aktualnie istnieje jedna skrzynka farmy:

| Skrzynka | Cena | Efekt |
|---|---:|---|
| Skrzynka z nasionami | 100 coinów | Losuje **3 różne karty** roślin |

Kupno skrzynki kosztuje **100 coinów** i spala coiny (`farm_box_buy`). Otwarcie posiadanej skrzynki:

- losuje **3 różne** aktywne karty z `farm_card_defs` (każda inna — losowanie bez powtórzeń w obrębie jednej skrzynki),
- każde z 3 losowań jest ważone efektywną wagą karty i bierze pod uwagę karty z `draw_weight > 0`; NFT wypadają tylko dopóki edycja nie jest wyprzedana,
- dodaje wylosowane karty do kolekcji gracza,
- jeśli gracz ma już daną kartę, zwiększa jej licznik duplikatów (`count`) o 1.

Liczba kart na skrzynkę to stała `v_draws` (=3) w `open_farm_lootbox()`, mirror `FARM_BOX_DRAWS` w `index.html`. Otwarcie skrzynki uruchamia animowane, teatralne „rozpakowanie" (`playFarmPackOpening` — karty wlatują rewersem do góry i odkrywają się po kolei, z poświatą zależną od rzadkości; można też kliknąć kartę, by odkryć ją wcześniej).

## Szanse w skrzynce

Szanse bazowe wynikają z wag `draw_weight`. Pełna bazowa suma wag to **133** (128 zwykłych/rzadkich/epickich + 5 z kart NFT, dopóki edycje się nie wyprzedadzą).

Anti-hoarding: jeśli gracz posiada już NFT, efektywna waga każdej kolejnej karty NFT wynosi `draw_weight / 3 ^ liczba_posiadanych_NFT`. Zwykłe karty nie mają tej kary. Gdy edycja NFT się wyprzeda, jej karta wypada z puli, a suma wag spada.

Szansa na rzadkość w **pojedynczym** losowaniu (skrzynka robi 3 takie losowania bez powtórzeń):

| Rzadkość | Suma wag | Szansa dokładna |
|---|---:|---:|
| common / zwykła | 82 | 61.7% |
| rare / rzadka | 34 | 25.6% |
| epic / epicka | 12 | 9.0% |
| legendary / NFT | 5 | 3.8% |

Darmowa działka ze skrzynki ma bazowo **7%** naturalnej szansy, ale efektywna szansa gracza to `0.07 / 3 ^ (posiadane_działki + posiadane_vouchery)`. Starterowy gwarantowany voucher działa tylko dopóki gracz nie ma jeszcze żadnej działki ani vouchera.

## Wszystkie karty

Pełna lista wszystkich kart w grze (rośliny zwykłe/rzadkie/epickie + karty NFT). Szansa = bazowe trafienie w pojedynczym losowaniu przy pełnej puli wag **133**, przed indywidualną karą za posiadane NFT. W aplikacji ta sama lista jest w **📖 Katalog** jako jeden ujednolicony widok kart, pogrupowany po rzadkości.

### Rośliny zwykłe / rzadkie / epickie

Kolumna „≈ Zysk/doba" (poziom 1) = `plon × cena ÷ dni wzrostu` — bezpośrednie porównanie opłacalności; ta sama wartość jest w aplikacji w Katalogu.

| Karta | Emoji | Rzadkość | Waga | Szansa | Czas wzrostu | Plon | Cena NPC | ≈ Zysk/doba |
|---|---|---|---:|---:|---:|---:|---:|---:|
| Marchewka | 🥕 | zwykła | 30 | 22.6% | 1 dzień | 4 | 12 | 48 |
| Ziemniak | 🥔 | zwykła | 28 | 21.1% | 1 dzień | 5 | 10 | 50 |
| Pomidor | 🍅 | zwykła | 24 | 18.0% | 1 dzień | 6 | 9 | 54 |
| Kukurydza | 🌽 | rzadka | 13 | 9.8% | 2 dni | 12 | 16 | 96 |
| Papryczka | 🌶️ | rzadka | 12 | 9.0% | 2 dni | 11 | 17 | 94 |
| Truskawka | 🍓 | rzadka | 9 | 6.8% | 2 dni | 15 | 13 | 98 |
| Dynia | 🎃 | epicka | 5 | 3.8% | 3 dni | 30 | 20 | 200 |
| Winogrona | 🍇 | epicka | 4 | 3.0% | 3 dni | 35 | 18 | 210 |
| Ananas | 🍍 | epicka | 3 | 2.3% | 4 dni | 45 | 18 | 203 |

### Karty NFT (legendarne, limitowane)

| Karta | Emoji | Edycja | Waga | Szansa* | Czas wzrostu | Plon | Cena NPC | Wartość w majątku |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| Diamentowa Róża | 🌹 | 25 szt. | 2 | 1.5% | 3 dni | 60 | 40 | 800 🪙 |
| Złoty Słonecznik | 🌻 | 15 szt. | 1 | 0.8% | 4 dni | 80 | 55 | 1333 🪙 |
| Kryształowy Lotos | 🪷 | 10 szt. | 1 | 0.8% | 4 dni | 100 | 80 | 2000 🪙 |
| Królewski Banan Ae Ae | 🍌 | 5 szt. | 1 | 0.8% | 4 dni | 120 | 120 | 4000 🪙 |

\* Szansa na NFT obowiązuje dopóki edycja się nie wyprzeda i przed indywidualną karą za posiadane NFT — potem karta znika z puli i suma wag spada. Wartość w majątku liczona jako `round(20000 / edycja)` 🪙 za sztukę.

## Karty i ulepszenia

Karta rośliny jest stałym blueprintem. Sadzenie uprawy **nie zużywa karty**.

Duplikaty z kolejnych skrzynek służą do ulepszania poziomu karty.

Dla poziomu `L`:

```text
wymagane_duplikaty = 2 * L
koszt_coinów = 50 * L^2
```

Przykłady:

| Ulepszenie | Wymagane duplikaty | Koszt |
|---|---:|---:|
| poziom 1 -> 2 | 2 | 50 |
| poziom 2 -> 3 | 4 | 200 |
| poziom 3 -> 4 | 6 | 450 |
| poziom 4 -> 5 | 8 | 800 |

Ulepszenie spala coiny (`card_levelup`) i zużywa wymagane duplikaty.

## Sadzenie, wzrost i zbiór

Sadzenie:

- wymaga własnej kupionej działki,
- wymaga posiadania karty danego gatunku,
- nie zużywa karty,
- zapisuje poziom karty w momencie sadzenia jako `planted_level`.

Jeśli karta zostanie ulepszona po zasadzeniu, już rosnąca uprawa używa starego poziomu. Nowy poziom zadziała przy kolejnym sadzeniu.

Czas wzrostu:

```text
czas_wzrostu = max(24 godziny, bazowy_czas * 0.92^(poziom - 1))
```

Każdy poziom skraca czas wzrostu o około 8% względem poprzedniego poziomu, ale **nigdy poniżej 24 godzin** — plony zbiera się najwyżej raz dziennie. Bazowe czasy to 1 dzień (zwykłe), 2 dni (rzadkie) i 3–4 dni (epickie).

Wzrost liczy się w **prawdziwym czasie zegarowym** (server-owned `ready_at`): postępuje także, gdy gracz zamknie grę lub przełączy kartę — po powrocie roślina jest odpowiednio starsza. To są **pełne dni, nie minuty**. (Uwaga historyczna: na żywej bazie `base_grow_minutes` były przez pewien czas ustawione na wartości testowe rzędu kilku–kilkudziesięciu minut; przywrócono je do wartości projektowych 1440/2880/4320/5760, czyli dni.)

Plon:

```text
plon = round(bazowy_plon * (1 + (poziom - 1) * 0.5))
```

Każdy poziom dodaje około +50% bazowego plonu.

Po zbiorze:

- plon trafia do `farm_inventory`,
- działka staje się pusta,
- można zasadzić kolejną uprawę.

## Sprzedaż plonów

Plony sprzedaje się NPC z panelu `🧺 Plony i sprzedaż`.

Sprzedaż:

- zdejmuje plony z `farm_inventory`,
- mintuje coiny (`farm_crop_sale`),
- używa dynamicznej ceny z `farm_market`.

Cena dynamiczna:

- startuje z ceny bazowej,
- po sprzedaży spada o `0.2% ceny bazowej` za każdą sprzedaną sztukę,
- nigdy nie spada poniżej `30% ceny bazowej`,
- z czasem wraca w stronę ceny bazowej: około `10% różnicy na godzinę`,
- duża sprzedaż w jednej paczce obniża cenę w trakcie tej samej sprzedaży, więc dzielenie sprzedaży na kilka kliknięć nie daje przewagi.

Aktualne ceny bazowe (rebalans „milder" — patrz „Balans ekonomii" niżej):

| Plon | Cena bazowa |
|---|---:|
| Marchewka | 10 |
| Ziemniak | 8 |
| Pomidor | 6 |
| Kukurydza | 12 |
| Papryczka | 13 |
| Truskawka | 10 |
| Dynia | 16 |
| Winogrona | 14 |
| Ananas | 14 |
| Diamentowa Róża | 40 |
| Złoty Słonecznik | 55 |
| Kryształowy Lotos | 80 |
| Królewski Banan Ae Ae | 120 |

## Ekonomia coinów

Spalanie coinów:

- kupno działki: `farm_tile_buy`,
- kupno skrzynki: `farm_box_buy`,
- ulepszenie karty: `card_levelup`.

Mintowanie coinów:

- sprzedaż plonów NPC: `farm_crop_sale`.

## Balans ekonomii

Punkt odniesienia: darmowe **podlewanie** w zen-Ogródku (`water_plant`) daje **10🪙/podlanie** (rośnie do **20🪙** przy serii 6 dni), **3×/dobę** → **30–60🪙/dobę za darmo** (do ~120/dobę z drugą rośliną). Uprawy z kart muszą to przebić, bo wymagają działki (od 350🪙, potem szybko drożej) i skrzynki (100🪙/3 karty).

Na żywej bazie ceny NPC były pierwotnie tak niskie (np. Marchewka 6🪙/dobę), że uprawa commonów nie miała sensu wobec darmowego podlewania. Zastosowano rebalans **„milder"** (ceny w tabeli wyżej), tak by ścieżka common/rare przebijała podlewanie i zwracała działkę w rozsądnym czasie. Przybliżony **Zysk/doba (poz. 1)**: zwykłe ~30, rzadkie ~72–75, epickie ~158–163, NFT 800–2000.

**Skalowanie poziomem:** plon = `round(bazowy_plon × (1 + (poziom-1) × 0.5))`, czyli ×1 / ×1,5 / ×2 / ×2,5 / ×3 dla poziomów 1–5; dodatkowo czas wzrostu spada ~8%/poziom (min. 24 h), więc Zysk/doba rośnie jeszcze szybciej. Przykład: 🍍 Ananas poz. 1 ≈ 158🪙/dobę → poz. 5 ≈ 660🪙/dobę. Te same liczby pokazuje aplikacja w **📖 Katalog** (kolumna „≈ Zysk/doba" + stopka „Ile można na tym zarobić").

## Karty NFT (działają)

Karty z ustawionym `edition_size` to **legendarne NFT** — wyjątkowe, numerowane okazy. Aktualnie w grze (wartość w majątku = `round(20000 / edycja)` 🪙 za sztukę):

| Karta | Emoji | Edycja | Bazowy plon | Wzrost | Cena NPC | Wartość/szt. |
|---|---|---:|---:|---:|---:|---:|
| Diamentowa Róża | 🌹 | 25 sztuk | 60 | 3 dni | 40 | 800 🪙 |
| Złoty Słonecznik | 🌻 | 15 sztuk | 80 | 4 dni | 55 | 1333 🪙 |
| Kryształowy Lotos | 🪷 | 10 sztuk | 100 | 4 dni | 80 | 2000 🪙 |
| Królewski Banan Ae Ae | 🍌 | 5 sztuk | 120 | 4 dni | 120 | 4000 🪙 |

> **Status wdrożenia:** kolekcja NFT (tabela `farm_nft_instances`, definicje 4 kart, mintowanie w `open_farm_lootbox`) **jest wdrożona na żywej bazie** (projekt `rjovhmepanwbdgdkvylr`) — przez pewien czas żywa baza miała starszą wersję farmy bez NFT i z testowymi (minutowymi) czasami wzrostu; zostało to naprawione. Wycena NFT w majątku jest też wpięta w `economy_stats()` oraz `user_assets_value()`/`user_net_worth_breakdown()`. Na świeżym środowisku wystarczy zastosować `supabase/farm.sql` (idempotentny). W aplikacji przewodnik **„💎 Kolekcja NFT"** w oknie „❓ Jak to działa" buduje listę edycji **na żywo** z `farm_card_defs`, więc pokazuje dokładnie te karty, które są aktywne.

Jak działają:

- **wypadają (rzadko) ze zwykłej skrzynki** — mają niskie `draw_weight`; gdy cała edycja się rozejdzie, znikają z puli losowań,
- im więcej NFT gracz już posiada, tym trudniej trafić kolejne: każda posiadana sztuka dzieli efektywną wagę NFT przez 3,
- przy zdobyciu serwer nadaje **unikalny numer seryjny** (np. `#3 / 25`) i zapisuje go w `farm_nft_instances` (publiczny odczyt, `UNIQUE(species, serial_no)`),
- trafiają też do `farm_collection`, więc **można je sadzić i ulepszać** jak zwykłe karty (mocne staty),
- **liczą się do majątku** (Net Worth) — każda sztuka warta `round(20000 / edycja)` 🪙 (rzadsza edycja = więcej),
- swoje numery widać w **🎒 Ekwipunku** (sekcja „💎 Karty NFT"), a podaż i Twoje numery w **📖 Katalogu**.

Odsprzedaż kart NFT, duplikatów kart roślin oraz pustych działek działa przez **Targowisko**. Działka wystawiona na sprzedaż dostaje na planszy małą tabliczkę **FOR SALE** i do czasu sprzedaży albo anulowania nie można na niej sadzić.

## Normalne karty a majątek

Posiadane karty roślin też liczą się do Net Worth, wyceniane po rzadkości: **zwykła 20**, **rzadka 50**, **epicka 150** 🪙 za sztukę (karty NFT są wyceniane osobno, jako instancje — patrz wyżej). Do tego dochodzą: aktualnie posiadane działki według `farm_tiles.asset_value`, coiny wydane na ulepszenia (`card_levelup`) oraz plony w magazynie po aktualnej cenie rynkowej.

## Pomoc w aplikacji

W panelu bocznym Ogródka przycisk **„❓ Jak to działa"** otwiera okno z przewodnikiem dla gracza:

- **🚀 Pierwsze kroki** — ponumerowana ściągawka „co kliknąć najpierw" (kup pole → kup skrzynkę w Sklep → 🎁 Skrzynki → posadź kartę → zbierz → sprzedaj),
- **🃏 Karty i łączenie (poziomy)** — wyjaśnia krok po kroku, czym są duplikaty, jak działa przycisk ⬆ Ulepsz w Ekwipunku, oraz pokazuje **drabinkę kosztów** (poz. 1→2: 2 karty + 50 🪙, 2→3: 4 + 200, 3→4: 6 + 450, 4→5: 8 + 800) i regułę „poziom zapisuje się przy sadzeniu",
- **🌱 Sadzenie i zbiór** — tłumaczy, że wzrost liczy się w prawdziwym czasie (postępuje też offline), trwa pełne dni, a wyższy poziom skraca go o ~8%/poziom, lecz nigdy poniżej 24 h (zbiór raz dziennie),
- **💎 Kolekcja NFT — pełny przewodnik** — buduje **na żywo** z `farm_card_defs` listę aktywnych edycji (nazwa, „tylko N szt.", plon, czas wzrostu, wartość `round(20000/edycja)` 🪙), a obok wyjaśnia numery seryjne, sposób zdobycia (ta sama skrzynka), status „wyprzedane", sadzenie/ulepszanie i gdzie zobaczyć podaż oraz swoje numery,
- pozostałe sekcje mechanik: działki, skrzynki, sprzedaż.

Liczby w pomocy (ceny pól, koszt ulepszenia, czasy wzrostu, szanse w skrzynce) są **wyliczane na żywo** z `fmDefs`/formuł (`farmTilePriceFor`, `2*L` / `50*L²`, `base_grow_minutes`), więc nie rozjeżdżają się z faktyczną grą — nie ma już zaszytych na sztywno wartości `350/700/1400` ani `1/2/3–4 dni`.

Pełna lista kart z cechami jest w **„📖 Katalog roślin"** — jeden ujednolicony widok kart (bez przełącznika), pogrupowany po rzadkości z wyróżnioną sekcją NFT.

## Uprawnienia i bezpieczeństwo

Klient nie zapisuje bezpośrednio do tabel farmy. Mutacje idą przez RPC:

- `buy_farm_tile`,
- `open_farm_lootbox`,
- `level_up_card`,
- `plant_crop`,
- `harvest_crop`,
- `sell_crop_to_npc`.

RLS pozwala:

- publicznie czytać katalog kart, pola farmy i rynek NPC,
- zalogowanemu graczowi czytać własną kolekcję kart i własny inventory,
- zapisy wykonywać tylko przez funkcje `SECURITY DEFINER`.

## Co zmienić przy balansowaniu

Najważniejsze miejsca:

- `farm_card_defs.draw_weight`: szanse w skrzynce.
- `farm_card_defs.base_grow_minutes`: bazowy czas wzrostu.
- `farm_card_defs.base_yield`: bazowy plon.
- `farm_market.base_price`: bazowa cena sprzedaży NPC.
- `FARM_BOX_PRICE` w `index.html`: cena skrzynki w UI.
- Stała `v_cost := 100` w `open_farm_lootbox()`: faktyczna cena skrzynki na backendzie.

Jeśli zmieniasz cenę skrzynki, trzeba zmienić ją jednocześnie w UI i w SQL.

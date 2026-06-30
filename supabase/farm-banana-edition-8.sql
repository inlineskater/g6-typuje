-- Bump the „Ae Ae" banana NFT edition cap from 5 to 8 (+3 mintable slots).
-- Run once against prod; idempotent (re-running is a harmless no-op once applied).
-- Mirrors the edition_size = 8 change already made in farm.sql's card-def seed.
--
-- farm_nft_instances.edition_size is captured at mint time (frozen per-row), so
-- the catalog bump alone would leave already-minted bananas showing "#n/5" while
-- new mints show "#n/8". Updating existing instances too keeps every banana's
-- displayed total + net-worth valuation (round(20000/edition_size*level)) in sync
-- with the new edition size.

UPDATE public.farm_card_defs
   SET edition_size = 8
 WHERE species = 'aeae_banana' AND edition_size <> 8;

UPDATE public.farm_nft_instances
   SET edition_size = 8
 WHERE species = 'aeae_banana' AND edition_size <> 8;

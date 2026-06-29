-- Restore the Admin account to the state captured 2026-06-23T18:58:31.135Z.
-- Run via the same Management API query endpoint to undo the test setup.
BEGIN;
UPDATE public.profiles SET coins = 28 WHERE id = '83a7bf6e-2cd8-43b5-bf2c-6b916877a8aa';
DELETE FROM public.farm_tiles        WHERE owner_id = '83a7bf6e-2cd8-43b5-bf2c-6b916877a8aa';
INSERT INTO public.farm_tiles (x, y, owner_id, acquired_via, acquired_at, planted_species, planted_level, planted_at, ready_at, zen_garden_id) VALUES (9, 3, '83a7bf6e-2cd8-43b5-bf2c-6b916877a8aa', 'purchase', '2026-06-22 20:21:30.182656+00', 'carrot', 1, '2026-06-22 20:21:33.968972+00', '2026-06-23 20:21:33.968972+00', NULL);
DELETE FROM public.farm_collection    WHERE user_id = '83a7bf6e-2cd8-43b5-bf2c-6b916877a8aa';
INSERT INTO public.farm_collection (user_id, species, count, level) VALUES ('83a7bf6e-2cd8-43b5-bf2c-6b916877a8aa', 'carrot', 0, 2);
INSERT INTO public.farm_collection (user_id, species, count, level) VALUES ('83a7bf6e-2cd8-43b5-bf2c-6b916877a8aa', 'tomato', 2, 1);
INSERT INTO public.farm_collection (user_id, species, count, level) VALUES ('83a7bf6e-2cd8-43b5-bf2c-6b916877a8aa', 'chili', 1, 1);
INSERT INTO public.farm_collection (user_id, species, count, level) VALUES ('83a7bf6e-2cd8-43b5-bf2c-6b916877a8aa', 'pumpkin', 1, 1);
DELETE FROM public.farm_inventory     WHERE user_id = '83a7bf6e-2cd8-43b5-bf2c-6b916877a8aa';
-- (none)
DELETE FROM public.farm_nft_instances WHERE owner_id = '83a7bf6e-2cd8-43b5-bf2c-6b916877a8aa';
-- (none)
-- farm_user_state was new in this change; admin had no prior row.
DELETE FROM public.farm_user_state    WHERE user_id = '83a7bf6e-2cd8-43b5-bf2c-6b916877a8aa';
COMMIT;

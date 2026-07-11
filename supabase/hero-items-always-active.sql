-- Special items (formerly "hero items") no longer require equipping — owning
-- one is enough for its effect to apply. Run after supabase/hero-items.sql
-- (and supabase/new-auction-items.sql, if not already applied). Idempotent.
--
-- Removes the equip/unequip step entirely: drops hero_equipment and the
-- equip_hero_item/unequip_hero_item RPCs, and repoints every consumer at
-- ownership (hero_item_instances.owner_id) instead of equipped state.
-- Edge Functions (getStrongestHeroEffect in whack-boss-action, bug-jumper-
-- action, flappy-pants-action, snake-action, invoice-horde-action,
-- var-patrol-action, egg-catch-action, roulette-action, slots-action,
-- poker-action) and award_daily_interest() must be deployed/redefined to
-- match — this file only covers the SQL side.

DROP FUNCTION IF EXISTS public.equip_hero_item(uuid);
DROP FUNCTION IF EXISTS public.unequip_hero_item(text);

-- my_hero_inventory: drop the "equipped" column. CREATE OR REPLACE VIEW can't
-- remove a trailing column, so this needs a real DROP + CREATE (re-grant after).
-- ⚠️ SUPERSEDED by supabase/casino-luck-item.sql (adds duration_hours/expires_at
-- and hides expired timed instances) — re-run that file after this one.
DROP VIEW IF EXISTS public.my_hero_inventory;
CREATE VIEW public.my_hero_inventory WITH (security_invoker = true) AS
SELECT
  i.id AS instance_id,
  i.owner_id,
  i.created_at,
  i.acquired_from,
  i.origin_label,
  i.serial_no,
  i.edition_size AS instance_edition_size,
  d.id AS item_def_id,
  d.slug,
  d.name,
  d.emoji,
  d.slot,
  d.price,
  d.rarity,
  d.description,
  d.effect_game,
  d.effect_type,
  d.effect_value,
  d.sale_type,
  d.visual_effect
FROM public.hero_item_instances i
JOIN public.hero_item_defs d ON d.id = i.item_def_id
WHERE i.owner_id = auth.uid();

GRANT SELECT ON public.my_hero_inventory TO authenticated;

-- hero_score_bonus used to read equipped items via public_hero_equipment;
-- now reads ownership directly, since public_hero_equipment is being dropped.
-- ⚠️ SUPERSEDED by supabase/casino-luck-item.sql (ignores expired timed items).
CREATE OR REPLACE VIEW public.hero_score_bonus AS
SELECT i.owner_id AS user_id, MAX(d.effect_value)::integer AS bonus
FROM public.hero_item_instances i
JOIN public.hero_item_defs d ON d.id = i.item_def_id
WHERE d.effect_type = 'score_bonus'
  AND d.is_active = true
GROUP BY i.owner_id;

-- public_hero_equipment had no remaining purpose once the tavern (its only
-- display surface) and equip/unequip (its only writer) were removed.
DROP VIEW IF EXISTS public.public_hero_equipment;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime DROP TABLE public.hero_equipment;
EXCEPTION
  WHEN undefined_object THEN NULL;
END $$;

DROP TABLE IF EXISTS public.hero_equipment;

-- award_daily_interest(): pay every OWNER of an interest_ring, not just
-- whoever has it equipped (mirrors new-auction-items.sql's version, minus
-- the hero_equipment join).
CREATE OR REPLACE FUNCTION public.award_daily_interest()
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_award_date date := (now() AT TIME ZONE 'Europe/Warsaw')::date;
  v_count integer := 0;
  v_total integer := 0;
BEGIN
  WITH eligible AS (
    SELECT
      p.id AS user_id,
      hii.id AS item_instance_id,
      GREATEST(1, FLOOR(p.coins * 0.02)::integer) AS amount
    FROM public.profiles p
    JOIN public.hero_item_instances hii ON hii.owner_id = p.id
    JOIN public.hero_item_defs hid ON hid.id = hii.item_def_id
    WHERE hid.slug = 'interest_ring'
      AND hid.is_active = true
  ),
  inserted AS (
    INSERT INTO public.hero_daily_interest_awards (award_date, user_id, item_instance_id, amount)
    SELECT v_award_date, user_id, item_instance_id, amount
    FROM eligible
    ON CONFLICT DO NOTHING
    RETURNING user_id, item_instance_id, amount
  ),
  credited AS (
    UPDATE public.profiles p
       SET coins = p.coins + i.amount
      FROM inserted i
     WHERE p.id = i.user_id
     RETURNING i.user_id, i.item_instance_id, i.amount
  )
  SELECT COUNT(*)::integer, COALESCE(SUM(amount), 0)::integer
    INTO v_count, v_total
  FROM credited;

  IF to_regclass('public.coin_transactions') IS NOT NULL THEN
    INSERT INTO public.coin_transactions (user_id, delta, reason, meta)
    SELECT
      a.user_id,
      a.amount,
      'daily_interest',
      jsonb_build_object('item_instance_id', a.item_instance_id, 'award_date', v_award_date)
    FROM public.hero_daily_interest_awards a
    WHERE a.award_date = v_award_date
      AND a.logged_at IS NULL;

    UPDATE public.hero_daily_interest_awards
       SET logged_at = now()
     WHERE award_date = v_award_date
       AND logged_at IS NULL;
  END IF;

  RETURN json_build_object('ok', true, 'award_date', v_award_date, 'awards_created', v_count, 'coins_awarded', v_total);
END;
$$;

REVOKE ALL ON FUNCTION public.award_daily_interest() FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';

-- ============================================================
-- Petzker · RPC для атомарных операций с балансом
-- Выполни в Supabase → SQL Editor (один раз)
-- ============================================================

-- 1) Атомарно добавить очки + запись в game_sessions
CREATE OR REPLACE FUNCTION public.increment_score(
  p_telegram_user_id text,
  p_name text,
  p_points integer,
  p_game_id text DEFAULT NULL,
  p_meta jsonb DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_total integer;
BEGIN
  IF p_points IS NULL OR p_points = 0 THEN
    SELECT COALESCE(total_score, 0) INTO v_new_total
    FROM player_ratings
    WHERE telegram_user_id = p_telegram_user_id;
    RETURN COALESCE(v_new_total, 0);
  END IF;

  INSERT INTO player_ratings AS pr (
    telegram_user_id, name, total_score, games_played, updated_at
  ) VALUES (
    p_telegram_user_id,
    COALESCE(NULLIF(p_name, ''), 'Игрок'),
    GREATEST(p_points, 0),
    CASE WHEN p_points > 0 THEN 1 ELSE 0 END,
    now()
  )
  ON CONFLICT (telegram_user_id) DO UPDATE SET
    total_score  = pr.total_score + p_points,
    games_played = pr.games_played + CASE WHEN p_points > 0 THEN 1 ELSE 0 END,
    name         = COALESCE(NULLIF(EXCLUDED.name, ''), pr.name),
    updated_at   = now()
  RETURNING total_score INTO v_new_total;

  IF p_points > 0 AND p_game_id IS NOT NULL THEN
    BEGIN
      INSERT INTO game_sessions (
        telegram_user_id, name, game_id, score, meta, played_at
      ) VALUES (
        p_telegram_user_id,
        COALESCE(NULLIF(p_name, ''), 'Игрок'),
        p_game_id,
        p_points,
        CASE WHEN p_meta IS NULL THEN NULL ELSE p_meta::text END,
        now()
      );
    EXCEPTION WHEN OTHERS THEN
      -- история не критична: баланс уже обновлён
      NULL;
    END;
  END IF;

  RETURN v_new_total;
END;
$$;

-- 2) Атомарно списать очки (для ставок). Возвращает новый баланс или -1 если недостаточно
CREATE OR REPLACE FUNCTION public.deduct_score(
  p_telegram_user_id text,
  p_amount integer
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_total integer;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN -1;
  END IF;

  UPDATE player_ratings
  SET
    total_score = total_score - p_amount,
    updated_at  = now()
  WHERE telegram_user_id = p_telegram_user_id
    AND total_score >= p_amount
  RETURNING total_score INTO v_new_total;

  IF NOT FOUND THEN
    RETURN -1;
  END IF;

  RETURN v_new_total;
END;
$$;

-- 3) Установить баланс (для слотов/казино после спина). Возвращает новый баланс
CREATE OR REPLACE FUNCTION public.set_score(
  p_telegram_user_id text,
  p_name text,
  p_total integer
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_total integer;
BEGIN
  v_new_total := GREATEST(COALESCE(p_total, 0), 0);

  INSERT INTO player_ratings AS pr (
    telegram_user_id, name, total_score, games_played, updated_at
  ) VALUES (
    p_telegram_user_id,
    COALESCE(NULLIF(p_name, ''), 'Игрок'),
    v_new_total,
    0,
    now()
  )
  ON CONFLICT (telegram_user_id) DO UPDATE SET
    total_score = v_new_total,
    name        = COALESCE(NULLIF(EXCLUDED.name, ''), pr.name),
    updated_at  = now()
  RETURNING total_score INTO v_new_total;

  RETURN v_new_total;
END;
$$;

-- Права для anon / authenticated (Telegram WebApp ходит с anon key)
GRANT EXECUTE ON FUNCTION public.increment_score(text, text, integer, text, jsonb) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.deduct_score(text, integer) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_score(text, text, integer) TO anon, authenticated;

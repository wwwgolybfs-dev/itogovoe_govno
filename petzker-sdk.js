/**
 * Petzker Game SDK v2
 * Синхронизация очков между мини-играми и основным приложением.
 * Предпочитает RPC (increment_score / deduct_score / set_score) — 1 запрос вместо 3.
 * Подключение: <script src="../petzker-sdk.js"></script>
 */
(function (global) {
  'use strict';

  const SUPABASE_URL = 'https://heubrattlnikielnfheg.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhldWJyYXR0bG5pa2llbG5maGVnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ5NzYyMjcsImV4cCI6MjEwMDU1MjIyN30._lRs77YnsILFN_Ru4uR2wDWQFtAlazZh8UaaKa7fsnM';

  let _sb = null;
  function getSb() {
    if (_sb) return _sb;
    if (typeof supabase !== 'undefined') {
      try { _sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY); } catch (e) {}
    }
    return _sb;
  }

  function resolvePlayer() {
    const p = new URLSearchParams(location.search);
    const uid = p.get('uid');
    const name = p.get('name');
    if (uid) return { id: uid, name: name || ('User ' + uid) };
    try {
      const tg = window.Telegram && window.Telegram.WebApp;
      const u = tg && tg.initDataUnsafe && tg.initDataUnsafe.user;
      if (u && u.id) {
        return {
          id: String(u.id),
          name: [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || u.username || ('User ' + u.id)
        };
      }
    } catch (e) {}
    return null;
  }

  function notifyParent(payload) {
    try {
      window.parent.postMessage(Object.assign({ type: 'petzker-score' }, payload), '*');
    } catch (e) {}
  }

  /**
   * Добавляет очки. 1 RPC-запрос (fallback: select+upsert+insert).
   * @returns {Promise<number|null>} новый total_score или null
   */
  async function reportScore(gameId, points, meta) {
    const player = resolvePlayer();
    const pts = Number(points) || 0;
    if (pts === 0) return null;

    notifyParent({
      gameId: gameId || null,
      points: pts,
      playerId: player ? player.id : null,
      playerName: player ? player.name : 'Гость',
      meta: meta || {}
    });

    const sb = getSb();
    if (!sb || !player) return null;

    try {
      const { data, error } = await sb.rpc('increment_score', {
        p_telegram_user_id: player.id,
        p_name: player.name,
        p_points: pts,
        p_game_id: gameId || null,
        p_meta: meta || null
      });
      if (!error && data != null) return Number(data);
    } catch (e) {}

    // Fallback без RPC
    try {
      const { data: existing } = await sb
        .from('player_ratings')
        .select('total_score, games_played')
        .eq('telegram_user_id', player.id)
        .maybeSingle();

      const newTotal = (existing ? existing.total_score : 0) + pts;
      const newGames = (existing ? existing.games_played : 0) + (pts > 0 ? 1 : 0);

      await sb.from('player_ratings').upsert({
        telegram_user_id: player.id,
        name: player.name,
        total_score: newTotal,
        games_played: newGames,
        updated_at: new Date().toISOString()
      }, { onConflict: 'telegram_user_id' });

      if (pts > 0 && gameId) {
        await sb.from('game_sessions').insert([{
          telegram_user_id: player.id,
          name: player.name,
          game_id: gameId,
          score: pts,
          meta: meta ? JSON.stringify(meta) : null,
          played_at: new Date().toISOString()
        }]);
      }
      return newTotal;
    } catch (e) {
      console.error('[PetzkerSDK] reportScore error:', e);
      return null;
    }
  }

  async function getBalance(playerId) {
    const sb = getSb();
    const id = playerId || (resolvePlayer() && resolvePlayer().id);
    if (!sb || !id) return 0;
    try {
      const { data } = await sb
        .from('player_ratings')
        .select('total_score')
        .eq('telegram_user_id', id)
        .maybeSingle();
      return data ? (data.total_score || 0) : 0;
    } catch (e) { return 0; }
  }

  /**
   * Списывает очки. RPC deduct_score → 1 запрос.
   * @returns {Promise<number|false>} новый баланс или false
   */
  async function deductBalance(playerId, amount) {
    const sb = getSb();
    const id = playerId || (resolvePlayer() && resolvePlayer().id);
    const amt = Number(amount) || 0;
    if (!sb || !id || amt <= 0) return false;

    try {
      const { data, error } = await sb.rpc('deduct_score', {
        p_telegram_user_id: id,
        p_amount: amt
      });
      if (!error && data != null && Number(data) >= 0) {
        const neu = Number(data);
        notifyParent({ gameId: null, points: -amt, playerId: id, playerName: null, meta: { kind: 'deduct' }, newBalance: neu });
        return neu;
      }
      if (!error && Number(data) === -1) return false;
    } catch (e) {}

    // Fallback
    try {
      const { data } = await sb
        .from('player_ratings')
        .select('total_score')
        .eq('telegram_user_id', id)
        .maybeSingle();
      if (!data || data.total_score < amt) return false;
      const neu = data.total_score - amt;
      await sb.from('player_ratings').update({
        total_score: neu,
        updated_at: new Date().toISOString()
      }).eq('telegram_user_id', id);
      notifyParent({ gameId: null, points: -amt, playerId: id, playerName: null, meta: { kind: 'deduct' }, newBalance: neu });
      return neu;
    } catch (e) { return false; }
  }

  /**
   * Установить абсолютный баланс (слоты и т.п.).
   * @returns {Promise<number|null>}
   */
  async function setBalance(playerId, total, name) {
    const sb = getSb();
    const id = playerId || (resolvePlayer() && resolvePlayer().id);
    const player = resolvePlayer();
    if (!sb || !id) return null;
    const val = Math.max(0, Math.floor(Number(total) || 0));

    try {
      const { data, error } = await sb.rpc('set_score', {
        p_telegram_user_id: id,
        p_name: name || (player && player.name) || 'Игрок',
        p_total: val
      });
      if (!error && data != null) {
        notifyParent({ gameId: null, points: 0, playerId: id, playerName: name || null, meta: { kind: 'set' }, newBalance: Number(data) });
        return Number(data);
      }
    } catch (e) {}

    try {
      await sb.from('player_ratings').upsert({
        telegram_user_id: id,
        name: name || (player && player.name) || 'Игрок',
        total_score: val,
        updated_at: new Date().toISOString()
      }, { onConflict: 'telegram_user_id' });
      notifyParent({ gameId: null, points: 0, playerId: id, playerName: name || null, meta: { kind: 'set' }, newBalance: val });
      return val;
    } catch (e) {
      console.error('[PetzkerSDK] setBalance error:', e);
      return null;
    }
  }

  global.PetzkerSDK = {
    resolvePlayer,
    reportScore,
    getBalance,
    deductBalance,
    setBalance,
    getSb
  };
})(window);

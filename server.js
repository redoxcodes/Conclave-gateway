import 'dotenv/config';
import express from 'express';
import { TwitterApi } from 'twitter-api-v2';
import { Redis } from '@upstash/redis';
import { Telegraf } from 'telegraf';

const {
  X_CLIENT_ID,
  X_CLIENT_SECRET,
  X_CALLBACK_URL,
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_BOT_USERNAME,
  PUBLIC_BASE_URL,
  PORT = 3000,
} = process.env;

const redis = new Redis({
  url: UPSTASH_REDIS_REST_URL,
  token: UPSTASH_REDIS_REST_TOKEN,
});

const twitterClient = new TwitterApi({
  clientId: X_CLIENT_ID,
  clientSecret: X_CLIENT_SECRET,
});

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
const app = express();

// ---------- Telegram bot ----------

bot.start(async (ctx) => {
  const payload = ctx.startPayload; // text after /start

  // Case 1: user just verified via X, redirected back with verified_<tgId>
  if (payload && payload.startsWith('verified_')) {
    const tgId = payload.replace('verified_', '');
    const record = await redis.get(`verified:${tgId}`);
    if (record) {
      return ctx.reply(`✅ You're verified as @${record.username} on X. Welcome!`);
    }
    return ctx.reply('⚠️ Verification not found yet. Try tapping the link again.');
  }

  // Case 2: fresh /start — send them the verify link
  const authUrl = `${PUBLIC_BASE_URL}/auth/x/start?tg_id=${ctx.from.id}`;
  return ctx.reply(
    'Welcome! Verify your X account to continue.',
    {
      reply_markup: {
        inline_keyboard: [[{ text: 'Verify with X', url: authUrl }]],
      },
    }
  );
});

bot.launch();

// ---------- OAuth routes ----------

app.get('/auth/x/start', async (req, res) => {
  const tgId = req.query.tg_id;
  if (!tgId) return res.status(400).send('Missing tg_id');

  const { url, codeVerifier, state } = twitterClient.generateOAuth2AuthLink(
    X_CALLBACK_URL,
    { scope: ['tweet.read', 'users.read'] }
  );

  // Stash the PKCE verifier + tg_id for 10 minutes, keyed by state
  await redis.set(`oauth:${state}`, { codeVerifier, tgId }, { ex: 600 });

  res.redirect(url);
});

app.get('/auth/x/callback', async (req, res) => {
  const { state, code } = req.query;
  if (!state || !code) return res.status(400).send('Missing state or code');

  const stored = await redis.get(`oauth:${state}`);
  if (!stored) return res.status(400).send('Session expired, please try again.');

  const { codeVerifier, tgId } = stored;

  try {
    const { client: loggedClient } = await twitterClient.loginWithOAuth2({
      code,
      codeVerifier,
      redirectUri: X_CALLBACK_URL,
    });

    const { data: user } = await loggedClient.v2.me();

    await redis.set(`verified:${tgId}`, {
      x_user_id: user.id,
      username: user.username,
      verifiedAt: Date.now(),
    });
    await redis.del(`oauth:${state}`);

    res.redirect(`https://t.me/${TELEGRAM_BOT_USERNAME}?start=verified_${tgId}`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Verification failed. Please try again.');
  }
});

app.get('/', (req, res) => res.send('X verify bot is running.'));

app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

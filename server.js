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
  TELEGRAM_GROUP_ID,
  ADMIN_USER_IDS,
  CRON_SECRET,
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

const ADMIN_IDS = (ADMIN_USER_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const isAdmin = (tgId) => ADMIN_IDS.includes(String(tgId));

const normalize = (h) => h.trim().replace(/^@/, '').toLowerCase();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Redis helpers ----------

async function getActiveList() {
  const list = await redis.get('active_list');
  return new Set(list || []);
}

async function saveActiveList(handles) {
  await redis.set('active_list', [...handles]);
}

async function addMember(tgId) {
  await redis.sadd('members', String(tgId));
}

async function getMembers() {
  return (await redis.smembers('members')) || [];
}

// When we mint an invite link we remember who it was for, so that when
// someone joins with it we can check they are that person and not a
// friend the link was forwarded to.
async function rememberInvite(inviteLink, tgId, handle) {
  await redis.set(
    `invite:${inviteLink}`,
    { tgId: String(tgId), handle },
    { ex: 3600 }
  );
}

async function lookupInvite(inviteLink) {
  return await redis.get(`invite:${inviteLink}`);
}

// ---------- Core: remove anyone not on the active list ----------

async function kickMember(tgId, handle) {
  await bot.telegram.banChatMember(TELEGRAM_GROUP_ID, Number(tgId));

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await bot.telegram.unbanChatMember(TELEGRAM_GROUP_ID, Number(tgId), {
        only_if_banned: true,
      });
      return true;
    } catch (err) {
      console.error(
        `Unban attempt ${attempt} failed for ${tgId} (@${handle}):`,
        err.message
      );
      await sleep(1000 * attempt);
    }
  }

  console.error(
    `STILL BANNED: ${tgId} (@${handle}) — unban failed 3 times. ` +
    `Unban manually in group settings or they cannot rejoin.`
  );
  return false;
}

async function runCheck() {
  const activeList = await getActiveList();
  if (activeList.size === 0) {
    return { skipped: true, reason: 'No active list saved yet.' };
  }

  const members = await getMembers();
  const removed = [];
  const stuckBanned = [];
  let checked = 0;

  for (const tgId of members) {
    const record = await redis.get(`verified:${tgId}`);
    if (!record) continue;

    checked++;
    const handle = normalize(record.username);

    if (!activeList.has(handle)) {
      try {
        const unbanned = await kickMember(tgId, handle);
        removed.push(handle);
        if (!unbanned) stuckBanned.push(handle);
      } catch (err) {
        console.error(`Could not remove ${tgId} (@${handle}):`, err.message);
      }
      await sleep(350);
    }
  }

  return { skipped: false, checked, removed, stuckBanned };
}

async function notifyAdmins(text) {
  for (const adminId of ADMIN_IDS) {
    try {
      await bot.telegram.sendMessage(adminId, text);
    } catch (err) {
      console.error('Could not notify admin:', err.message);
    }
  }
}

// ---------- Telegram bot ----------

bot.start(async (ctx) => {
  const payload = ctx.startPayload;

  if (payload && payload.startsWith('verified_')) {
    const tgId = payload.replace('verified_', '');
    const record = await redis.get(`verified:${tgId}`);

    if (!record) {
      return ctx.reply('⚠️ Verification not found yet. Try tapping the link again.');
    }

    const handle = normalize(record.username);
    const activeList = await getActiveList();

    if (!activeList.has(handle)) {
      return ctx.reply(
        `✅ Verified as @${record.username}.\n\n` +
        `❌ But that account isn't on the current subscriber list, ` +
        `so I can't let you in yet.\n\n` +
        `If you just subscribed, give it a moment and try /start again.`
      );
    }

    try {
      // Link dies after one use OR after 3 minutes, whichever comes first.
      const expiresAt = Math.floor(Date.now() / 1000) + 180;

      const invite = await bot.telegram.createChatInviteLink(TELEGRAM_GROUP_ID, {
        member_limit: 1,
        expire_date: expiresAt,
        name: `invite-${handle}`.slice(0, 32),
      });

      await addMember(tgId);
      await rememberInvite(invite.invite_link, tgId, handle);

      return ctx.reply(
        `✅ Verified as @${record.username} — you're on the list!\n\n` +
        `⏱ Join within 3 minutes — this link expires after that, ` +
        `and only works once. Don't share it.\n\n` +
        `${invite.invite_link}\n\n` +
        `If it expires, just send /start again for a fresh one.`
      );
    } catch (err) {
      console.error('Invite link failed:', err.message);
      return ctx.reply(
        '✅ Verified, but I could not create your invite link. ' +
        'Please contact the admin.'
      );
    }
  }

  const authUrl = `${PUBLIC_BASE_URL}/auth/x/start?tg_id=${ctx.from.id}`;
  return ctx.reply('Welcome! Verify your X account to continue.', {
    reply_markup: {
      inline_keyboard: [[{ text: 'Verify with X', url: authUrl }]],
    },
  });
});

// ---------- Admin commands ----------

bot.command('setlist', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('Not authorized.');

  const lines = ctx.message.text.split('\n').slice(1).filter((l) => l.trim());
  if (lines.length === 0) {
    return ctx.reply(
      'Send it like this:\n\n/setlist\nhandle1\nhandle2\nhandle3'
    );
  }

  const handles = new Set(lines.map(normalize));
  await saveActiveList(handles);

  await ctx.reply(`List saved: ${handles.size} handles. Running check now...`);

  const result = await runCheck();
  if (result.skipped) return ctx.reply(result.reason);

  let msg =
    `Check complete.\n` +
    `Checked: ${result.checked} verified members\n` +
    `Removed: ${result.removed.length}`;
  if (result.removed.length) {
    msg += '\n\nRemoved: ' + result.removed.map((h) => '@' + h).join(', ');
  }
  if (result.stuckBanned && result.stuckBanned.length) {
    msg +=
      '\n\n⚠️ Could not unban these — they cannot rejoin until you ' +
      'unban them manually in group settings:\n' +
      result.stuckBanned.map((h) => '@' + h).join(', ');
  }
  return ctx.reply(msg);
});

bot.command('status', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('Not authorized.');

  const activeList = await getActiveList();
  const members = await getMembers();

  return ctx.reply(
    `Verified members: ${members.length}\n` +
    `Active list: ${activeList.size} handles`
  );
});

bot.command('showlist', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('Not authorized.');

  const activeList = await getActiveList();
  if (activeList.size === 0) return ctx.reply('No list saved yet.');

  return ctx.reply(
    `Current list (${activeList.size}):\n` +
    [...activeList].map((h) => '@' + h).join('\n')
  );
});

bot.command('myid', (ctx) => ctx.reply(`Your Telegram ID: ${ctx.from.id}`));

// ---------- Gatecrasher check ----------
//
// An invite link is single-use, but nothing stops a subscriber forwarding
// it to a friend who uses it first. So we check that whoever walked
// through the door is the person the link was minted for.

bot.on('chat_member', async (ctx) => {
  try {
    const update = ctx.chatMember;
    if (String(update.chat.id) !== String(TELEGRAM_GROUP_ID)) return;

    const wasIn = ['member', 'administrator', 'creator'].includes(
      update.old_chat_member.status
    );
    const isIn = ['member', 'administrator', 'creator'].includes(
      update.new_chat_member.status
    );

    if (wasIn || !isIn) return;

    const joiner = update.new_chat_member.user;
    const joinerId = String(joiner.id);

    if (isAdmin(joinerId)) return;
    if (joiner.is_bot) return;

    const usedLink = update.invite_link && update.invite_link.invite_link;

    if (!usedLink) {
      console.error(`Kicking ${joinerId}: joined without a bot invite link.`);
      await kickMember(joinerId, joiner.username || joinerId);
      await notifyAdmins(
        `🚫 Removed ${joiner.first_name || joinerId}` +
        (joiner.username ? ` (@${joiner.username})` : '') +
        ` — joined without going through verification.`
      );
      return;
    }

    const record = await lookupInvite(usedLink);

    if (!record) {
      console.error(`Kicking ${joinerId}: unrecognised invite link.`);
      await kickMember(joinerId, joiner.username || joinerId);
      await notifyAdmins(
        `🚫 Removed ${joiner.first_name || joinerId}` +
        (joiner.username ? ` (@${joiner.username})` : '') +
        ` — used an invite link I don't recognise.`
      );
      return;
    }

    if (record.tgId !== joinerId) {
      console.error(
        `Kicking ${joinerId}: used a link issued to ${record.tgId} (@${record.handle}).`
      );
      await kickMember(joinerId, joiner.username || joinerId);
      await notifyAdmins(
        `🚫 Removed ${joiner.first_name || joinerId}` +
        (joiner.username ? ` (@${joiner.username})` : '') +
        ` — used a link that was issued to @${record.handle}.\n\n` +
        `That link was forwarded. You may want to check on @${record.handle}.`
      );
      return;
    }

    await redis.del(`invite:${usedLink}`);
  } catch (err) {
    console.error('chat_member handler failed:', err.message);
  }
});

// allowed_updates must include chat_member — Telegram does not send it
// by default, so without this the gatecrasher check never fires.
bot.launch({
  allowedUpdates: [
    'message',
    'callback_query',
    'chat_member',
    'my_chat_member',
  ],
});

// ---------- OAuth routes ----------

app.get('/auth/x/start', async (req, res) => {
  const tgId = req.query.tg_id;
  if (!tgId) return res.status(400).send('Missing tg_id');

  const { url, codeVerifier, state } = twitterClient.generateOAuth2AuthLink(
    X_CALLBACK_URL,
    { scope: ['tweet.read', 'users.read'] }
  );

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

// ---------- Cron endpoint (the daily check) ----------

app.get('/cron/daily-check', async (req, res) => {
  if (req.query.key !== CRON_SECRET) {
    return res.status(403).send('Forbidden');
  }

  const result = await runCheck();

  if (result.skipped) {
    console.log('Daily check skipped:', result.reason);
    return res.send('Skipped: ' + result.reason);
  }

  console.log(`Daily check: checked ${result.checked}, removed ${result.removed.length}`);

  if (result.removed.length) {
    let msg =
      `Daily check complete.\n` +
      `Checked: ${result.checked}\n` +
      `Removed: ${result.removed.length}\n\n` +
      'Removed: ' + result.removed.map((h) => '@' + h).join(', ');

    if (result.stuckBanned && result.stuckBanned.length) {
      msg +=
        '\n\n⚠️ Could not unban these — they cannot rejoin until you ' +
        'unban them manually in group settings:\n' +
        result.stuckBanned.map((h) => '@' + h).join(', ');
    }

    await notifyAdmins(msg);
  }

  res.send(`OK — checked ${result.checked}, removed ${result.removed.length}`);
});

// ---------- Keepalive ----------

app.get('/ping', (req, res) => res.send('pong'));

app.get('/', (req, res) => res.send('X verify bot is running.'));

app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

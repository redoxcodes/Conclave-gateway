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
  TELEGRAM_GROUP_ID,      // NEW: your group's chat id, e.g. -1001234567890
  ADMIN_USER_IDS,         // NEW: your TG user id(s), comma separated
  CRON_SECRET,            // NEW: any long random string you invent
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

// Strip @ and lowercase so "@BigMike" and "bigmike" are treated the same.
const normalize = (h) => h.trim().replace(/^@/, '').toLowerCase();

// Small pause so Telegram doesn't rate-limit us during big removals.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Redis helpers ----------

// The current active subscriber list. Overwritten each time you /setlist.
async function getActiveList() {
  const list = await redis.get('active_list');
  return new Set(list || []);
}

async function saveActiveList(handles) {
  await redis.set('active_list', [...handles]);
}

// We keep a set of every tg_id that has verified, so the daily check
// knows who to loop through.
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
    { ex: 3600 } // an hour is plenty; the link itself dies in 3 minutes
  );
}

async function lookupInvite(inviteLink) {
  return await redis.get(`invite:${inviteLink}`);
}

// ---------- Core: remove anyone not on the active list ----------

// Kick = ban then immediately unban, so they can rejoin later if they
// resubscribe. If that unban fails they stay banned and can never get
// back in, so retry a few times before giving up.
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
    if (!record) continue; // never finished verifying — ignore

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

// ---------- Telegram bot ----------

bot.start(async (ctx) => {
  const payload = ctx.startPayload;

  // Case 1: they just came back from verifying with X
  if (payload && payload.startsWith('verified_')) {
    const tgId = payload.replace('verified_', '');
    const record = await redis.get(`verified:${tgId}`);

    if (!record) {
      return ctx.reply('⚠️ Verification not found yet. Try tapping the link again.');
    }

    // The OAuth callback only knows their X handle. Now that they're back
    // in Telegram we can see their TG username too, so store it for /whois.
    if (String(ctx.from.id) === String(tgId)) {
      record.tg_username = ctx.from.username || null;
      record.tg_name = ctx.from.first_name || null;
      await redis.set(`verified:${tgId}`, record);
    }

    const handle = normalize(record.username);
    const activeList = await getActiveList();

    // Gate: are they actually on your subscriber list?
    if (!activeList.has(handle)) {
      return ctx.reply(
        `✅ Verified as @${record.username}.\n\n` +
        `❌ But that account isn't on the current subscriber list, ` +
        `so I can't let you in yet.\n\n` +
        `Subscribe here to gain access:\n` +
        `https://x.com/atitty\n\n` +
        `If you just subscribed, give it a moment and try /start again.`
      );
    }

    // They're on the list — give them a one-time invite link.
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
        `${invite.invite_link}`
      );
    } catch (err) {
      console.error('Invite link failed:', err.message);
      return ctx.reply(
        '✅ Verified, but I could not create your invite link. ' +
        'Please contact the admin.'
      );
    }
  }

  // Case 2: fresh /start — send them off to verify
  const authUrl = `${PUBLIC_BASE_URL}/auth/x/start?tg_id=${ctx.from.id}`;
  return ctx.reply(
    'Welcome to The Conclave.\n\n' +
    'Access is for X subscribers only. Verify your X account below.\n\n' +
    'Not subscribed yet? Subscribe here first:\n' +
    'https://x.com/atitty',
    {
      reply_markup: {
        inline_keyboard: [[{ text: 'Verify with X', url: authUrl }]],
      },
    }
  );
});

// ---------- Admin commands ----------

// /setlist
// handle1
// handle2
// handle3
//
// Overwrites the saved list, then runs a check immediately.
bot.command('setlist', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('Not authorized.');

  const lines = ctx.message.text.split('\n').slice(1).filter((l) => l.trim());
  if (lines.length === 0) {
    return ctx.reply(
      'Send it like this:\n\n/setlist\nhandle1\nhandle2\nhandle3'
    );
  }

  const handles = new Set(lines.map(normalize));

  // Check the damage before doing it.
  const wouldRemove = await previewRemovals(handles);

  if (wouldRemove.length > BULK_REMOVAL_THRESHOLD) {
    pendingSetlist.set(String(ctx.from.id), handles);
    return ctx.reply(
      `⚠️ Hold on — this would remove ${wouldRemove.length} people:\n\n` +
      wouldRemove.map((h) => '@' + h).join(', ') +
      `\n\nNew list has ${handles.size} handles.\n\n` +
      `If that's right, send /confirm. Otherwise /cancel.`
    );
  }

  return applySetlist(ctx, handles);
});

bot.command('confirm', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('Not authorized.');

  const handles = pendingSetlist.get(String(ctx.from.id));
  if (!handles) return ctx.reply('Nothing waiting for confirmation.');

  pendingSetlist.delete(String(ctx.from.id));
  return applySetlist(ctx, handles);
});

bot.command('cancel', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('Not authorized.');

  if (pendingSetlist.delete(String(ctx.from.id))) {
    return ctx.reply('Cancelled. List unchanged.');
  }
  return ctx.reply('Nothing to cancel.');
});

// Add one handle without touching the rest of the list.
bot.command('addsub', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('Not authorized.');

  const arg = ctx.message.text.split(' ')[1];
  if (!arg) return ctx.reply('Usage: /addsub their_x_handle');

  const handle = normalize(arg);
  const activeList = await getActiveList();

  if (activeList.has(handle)) {
    return ctx.reply(`@${handle} is already on the list.`);
  }

  activeList.add(handle);
  await saveActiveList(activeList);

  return ctx.reply(
    `✅ Added @${handle}.\nList is now ${activeList.size} handles.\n\n` +
    `They can send /start to the bot to get in.`
  );
});

// Remove one handle, and kick them if they're in the group.
bot.command('removesub', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('Not authorized.');

  const arg = ctx.message.text.split(' ')[1];
  if (!arg) return ctx.reply('Usage: /removesub their_x_handle');

  const handle = normalize(arg);
  const activeList = await getActiveList();

  if (!activeList.has(handle)) {
    return ctx.reply(`@${handle} isn't on the list.`);
  }

  activeList.delete(handle);
  await saveActiveList(activeList);

  await ctx.reply(
    `Removed @${handle} from the list (${activeList.size} left). Checking group...`
  );

  const result = await runCheck();
  if (result.skipped) return ctx.reply(result.reason);

  if (result.removed.length) {
    return ctx.reply(
      `✅ Kicked from the group: ` +
      result.removed.map((h) => '@' + h).join(', ')
    );
  }
  return ctx.reply(`@${handle} wasn't in the group, so nothing to kick.`);
});

// Find someone by either their X handle or their Telegram username.
// Returns { record, matchedBy } or null.
async function findMember(query) {
  const q = normalize(query);
  const members = await getMembers();

  let tgMatch = null;

  for (const tgId of members) {
    const record = await redis.get(`verified:${tgId}`);
    if (!record) continue;

    // X handle is the primary key, so prefer it.
    if (normalize(record.username) === q) {
      return { record: { tgId, ...record }, matchedBy: 'x' };
    }

    // Remember a Telegram match but keep looking for an X one.
    if (record.tg_username && normalize(record.tg_username) === q) {
      tgMatch = { record: { tgId, ...record }, matchedBy: 'telegram' };
    }
  }

  return tgMatch;
}

// Renders the Telegram side of a lookup: username if we have one,
// otherwise the numeric id (which always works in a tg:// link).
function telegramLine(record) {
  if (record.tg_username) {
    return `Telegram: @${esc(record.tg_username)}`;
  }
  if (record.tg_name) {
    return `Telegram: ${esc(record.tg_name)} (no username set)\nID: ${record.tgId}`;
  }
  return `Telegram ID: ${record.tgId} (no username on record)`;
}

// Build the lookup result for either entry point.
async function formatWhois(query) {
  const q = normalize(query);
  const activeList = await getActiveList();
  const found = await findMember(q);

  // Nothing at all under that name.
  if (!found) {
    const onList = activeList.has(q);
    let msg = `🔍 @${esc(q)}\n\n`;
    msg += onList
      ? `✅ On the subscriber list\n❌ Has never verified with the bot\n\n` +
        `Tell them to send /start to the bot.`
      : `❌ Not on the subscriber list\n❌ Has never verified with the bot\n\n` +
        `Nothing on record under that name — as an X handle or a Telegram one.`;
    return msg;
  }

  const r = found.record;
  const xHandle = normalize(r.username);
  const onList = activeList.has(xHandle);

  let msg = `🔍 @${esc(xHandle)}`;
  if (found.matchedBy === 'telegram') {
    msg += `\n<i>(found via Telegram @${esc(r.tg_username)})</i>`;
  }
  msg += `\n\n`;

  msg += onList ? `✅ On the subscriber list\n` : `❌ Not on the subscriber list\n`;
  msg += `✅ Verified\n`;
  msg += `${telegramLine(r)}\n`;
  msg += `Verified on ${new Date(r.verifiedAt).toDateString()}\n\n`;

  if (onList) {
    msg += `They should have access. If not, check Removed Users in group settings.`;
  } else {
    msg += `Verified but not on the list. Use /addsub ${esc(xHandle)} if they've subscribed.`;
  }

  return msg;
}

// Look someone up — for when a member says they can't get in.
bot.command('whois', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('Not authorized.');

  const arg = ctx.message.text.split(' ')[1];
  if (!arg) {
    return ctx.reply(
      'Usage: /whois handle\n\n' +
      'Works with either their X handle or their Telegram username.'
    );
  }

  return ctx.reply(await formatWhois(arg), { parse_mode: 'HTML' });
});

// Back up the list, in case the database is ever wiped.
bot.command('export', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('Not authorized.');

  const activeList = await getActiveList();
  if (activeList.size === 0) return ctx.reply('No list saved yet.');

  // Formatted so you can paste it straight back into /setlist.
  return sendLong(ctx, `/setlist\n` + [...activeList].join('\n'));
});

// /status — quick health check
// Remove several handles at once. Unlike /setlist, this only takes away
// the handles you paste — everyone else on the list stays.
bot.command('removelist', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('Not authorized.');

  const lines = ctx.message.text.split('\n').slice(1).filter((l) => l.trim());
  if (lines.length === 0) {
    return ctx.reply(
      'Send it like this:\n\n/removelist\nhandle1\nhandle2\nhandle3\n\n' +
      'Only these come off the list. Everyone else stays.'
    );
  }

  return applyRemoveList(ctx, lines.map(normalize));
});

async function applyRemoveList(ctx, toRemove) {
  const activeList = await getActiveList();

  const removed = [];
  const notFound = [];

  for (const handle of toRemove) {
    if (activeList.has(handle)) {
      activeList.delete(handle);
      removed.push(handle);
    } else {
      notFound.push(handle);
    }
  }

  if (removed.length === 0) {
    return ctx.reply(
      `None of those were on the list.\n\n` +
      `Not found: ${notFound.map((h) => '@' + h).join(', ')}`,
      adminPanel()
    );
  }

  await saveActiveList(activeList);

  await ctx.reply(
    `Took ${removed.length} off the list (${activeList.size} left). ` +
    `Checking the group...`
  );

  const result = await runCheck();

  let msg = `✅ Removed from the list:\n` + removed.map((h) => '@' + h).join(', ');

  if (notFound.length) {
    msg += `\n\n⚠️ Weren't on the list anyway:\n` +
           notFound.map((h) => '@' + h).join(', ');
  }

  if (!result.skipped && result.removed.length) {
    msg += `\n\n👢 Kicked from the group:\n` +
           result.removed.map((h) => '@' + h).join(', ');
  } else if (!result.skipped) {
    msg += `\n\nNone of them were in the group, so nothing to kick.`;
  }

  if (!result.skipped && result.stuckBanned && result.stuckBanned.length) {
    msg += `\n\n⚠️ Could not unban these — they cannot rejoin until you ` +
           `unban them manually:\n` +
           result.stuckBanned.map((h) => '@' + h).join(', ');
  }

  return ctx.reply(msg, adminPanel());
}

// Everyone who has verified through the bot, with their X handle.
async function buildVerifiedList() {
  const members = await getMembers();
  const activeList = await getActiveList();
  const out = [];

  for (const tgId of members) {
    const record = await redis.get(`verified:${tgId}`);
    if (!record) continue;

    const handle = normalize(record.username);
    out.push({
      handle,
      tgId,
      onList: activeList.has(handle),
    });
  }

  out.sort((a, b) => a.handle.localeCompare(b.handle));
  return out;
}

bot.command('verified', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('Not authorized.');
  return sendLong(ctx, await formatVerified(), { parse_mode: 'HTML' });
});

async function formatVerified() {
  const list = await buildVerifiedList();

  if (list.length === 0) {
    return 'Nobody has verified through the bot yet.';
  }

  let msg = `✅ <b>Verified through the bot</b> (${list.length})\n\n`;
  msg += list
    .map((m) => (m.onList ? '✅ @' : '⚠️ @') + esc(m.handle))
    .join('\n');

  const offList = list.filter((m) => !m.onList).length;
  if (offList) {
    msg += `\n\n⚠️ = verified but no longer on the subscriber list (${offList})`;
  }

  return msg;
}

bot.command('status', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('Not authorized.');

  const activeList = await getActiveList();
  const members = await getMembers();

  return ctx.reply(
    `Verified members: ${members.length}\n` +
    `Active list: ${activeList.size} handles`
  );
});

// /showlist — see what's currently saved
bot.command('showlist', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('Not authorized.');

  const activeList = await getActiveList();
  if (activeList.size === 0) return ctx.reply('No list saved yet.');

  return sendLong(
    ctx,
    `Current list (${activeList.size}):\n` +
    [...activeList].map((h) => '@' + h).join('\n')
  );
});

// /myid — tells you your Telegram user id (useful for setting ADMIN_USER_IDS)
// ---------- Ascension commands ----------

// Per-person cooldown so people can't spam the check.
const levelCheckCooldown = new Map();

// Members check their own standing. ASCENSION topic only.
bot.command(['level', 'lvl', 'xp'], async (ctx) => {
  const isDm = ctx.chat.type === 'private';
  const isOurGroup = String(ctx.chat.id) === String(TELEGRAM_GROUP_ID);

  // Works in the bot's DM, or in the ASCENSION topic. Nowhere else.
  if (!isDm) {
    if (!isOurGroup) return;
    if (!inAscensionTopic(ctx)) return; // wrong topic — stay silent
  }

  const userId = String(ctx.from.id);
  const now = Date.now();
  const thread = ctx.message.message_thread_id;
  const threadOpt = thread ? { message_thread_id: thread } : {};

  const lastCheck = levelCheckCooldown.get(userId) || 0;
  const waited = now - lastCheck;

  if (waited < LEVEL_CHECK_COOLDOWN_MS) {
    const secondsLeft = Math.ceil((LEVEL_CHECK_COOLDOWN_MS - waited) / 1000);
    return ctx.reply(`⏳ Wait ${secondsLeft}s before checking again.`, threadOpt);
  }

  levelCheckCooldown.set(userId, now);

  const record = await getXpRecord(userId);
  const info = levelFromXp(record.xp);
  const title = rankTitle(info.level);

  if (info.maxed) {
    return ctx.reply(
      `🔺 <b>${title}</b>\n` +
      `Lvl ${info.level} — MAX\n` +
      `██████████\n\n` +
      `${record.xp} XP. You've reached the top.`,
      { parse_mode: 'HTML', ...threadOpt }
    );
  }

  const filled = Math.round((info.xpIntoLevel / info.xpNeeded) * 10);
  const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);

  return ctx.reply(
    `🔺 <b>${title}</b>\n` +
    `Lvl ${info.level}\n` +
    `${bar}  ${info.xpIntoLevel}/${info.xpNeeded}\n\n` +
    `${info.remaining} XP to Lvl ${info.level + 1}.`,
    { parse_mode: 'HTML', ...threadOpt }
  );
});

// Admin only — the board itself is pinned for everyone.
bot.command(['leaderboard', 'top'], async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  const rows = await buildLeaderboard();
  const thread = ctx.message.message_thread_id;

  return ctx.reply(formatLeaderboard(rows), {
    parse_mode: 'HTML',
    ...(thread ? { message_thread_id: thread } : {}),
  });
});

// Admin only. Fills in Telegram usernames for people who verified before
// we started storing them. Asks Telegram for each one, so it's slow.
bot.command('backfillnames', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('Not authorized.');

  const members = await getMembers();
  if (members.length === 0) return ctx.reply('Nobody has verified yet.');

  await ctx.reply(
    `Looking up ${members.length} members... this takes a moment.`
  );

  let filled = 0;
  let alreadyHad = 0;
  let failed = 0;

  for (const tgId of members) {
    const record = await redis.get(`verified:${tgId}`);
    if (!record) continue;

    if (record.tg_username) {
      alreadyHad++;
      continue;
    }

    try {
      const member = await bot.telegram.getChatMember(
        TELEGRAM_GROUP_ID,
        Number(tgId)
      );
      record.tg_username = member.user.username || null;
      record.tg_name = member.user.first_name || null;
      await redis.set(`verified:${tgId}`, record);
      if (record.tg_username) filled++;
    } catch (err) {
      // Usually means they left the group, so Telegram won't tell us.
      failed++;
    }

    await sleep(150); // stay under rate limits
  }

  return ctx.reply(
    `✅ Done.\n\n` +
    `Filled in: ${filled}\n` +
    `Already had one: ${alreadyHad}\n` +
    `Couldn't look up: ${failed} (likely left the group)`
  );
});

// Admin only, run ONCE after the curve was rescaled.
// Multiplies everyone's existing XP so nobody drops a rank.
bot.command('rescale', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('Not authorized.');

  // Guard: running this twice would inflate everyone.
  const alreadyDone = await redis.get('xp_rescaled');
  if (alreadyDone) {
    return ctx.reply(
      `⚠️ Already rescaled on ${alreadyDone}.\n\n` +
      `Running it again would inflate everyone's XP. Refusing.`
    );
  }

  const ids = (await redis.smembers('xp_users')) || [];
  if (ids.length === 0) {
    return ctx.reply('Nobody has any XP yet — nothing to rescale.');
  }

  await ctx.reply(`Rescaling ${ids.length} members by ${RESCALE_FACTOR}x...`);

  const changes = [];
  let touched = 0;

  for (const id of ids) {
    const record = await getXpRecord(id);
    if (!record.xp) continue;

    const before = levelFromXp(record.xp).level;
    record.xp = Math.round(record.xp * RESCALE_FACTOR);
    await saveXpRecord(id, record);
    const after = levelFromXp(record.xp).level;

    touched++;
    if (before !== after) {
      changes.push(`${esc(record.name || id)}: Lvl ${before} → ${after}`);
    }
  }

  await redis.set('xp_rescaled', new Date().toISOString());

  let msg = `✅ Rescaled ${touched} members.\n\n`;
  msg += changes.length
    ? `Levels that shifted:\n${changes.join('\n')}`
    : `Everyone kept the level they had. 👍`;

  await refreshPinnedBoard().catch(() => {});

  return ctx.reply(msg, { parse_mode: 'HTML' });
});

// Admin only — post and pin the board in the ASCENSION topic.
// Run this once; after that it refreshes itself on every rank-up.
bot.command('pinboard', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('Not authorized.');
  if (String(ctx.chat.id) !== String(TELEGRAM_GROUP_ID)) {
    return ctx.reply('Run this inside the group, in the ASCENSION topic.');
  }

  const thread = ctx.message.message_thread_id;
  const rows = await buildLeaderboard();

  try {
    const sent = await ctx.reply(formatLeaderboard(rows), {
      parse_mode: 'HTML',
      ...(thread ? { message_thread_id: thread } : {}),
    });

    await ctx.telegram.pinChatMessage(TELEGRAM_GROUP_ID, sent.message_id, {
      disable_notification: true,
    });

    await redis.set('ascension_pin', String(sent.message_id));

    return ctx.reply(
      '✅ Board pinned. It will update itself whenever someone ranks up.',
      thread ? { message_thread_id: thread } : {}
    );
  } catch (err) {
    console.error('pinboard failed:', err.message);
    return ctx.reply(
      `Could not pin: ${err.message}\n\n` +
      `Check the bot has "Pin Messages" permission.`,
      thread ? { message_thread_id: thread } : {}
    );
  }
});

bot.command('myid', (ctx) => ctx.reply(`Your Telegram ID: ${ctx.from.id}`));

// ---------- Admin panel ----------
//
// /admin brings up a button panel. Non-admins get refused and never see
// it, so the panel stays invisible to subscribers.

// Tracks admins mid-flow, e.g. "waiting for a handle to add".
// In memory only — a restart just clears it, which is fine.
const awaitingInput = new Map();

function adminPanel() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '📊 Status', callback_data: 'a:status' },
          { text: '👀 Show list', callback_data: 'a:showlist' },
        ],
        [
          { text: '✅ Verified members', callback_data: 'a:verified' },
        ],
        [
          { text: '➕ Add sub', callback_data: 'a:addsub' },
          { text: '➖ Remove sub', callback_data: 'a:removesub' },
        ],
        [
          { text: '🔍 Look someone up', callback_data: 'a:whois' },
        ],
        [
          { text: '🔄 Run check now', callback_data: 'a:runcheck' },
        ],
        [
          { text: '📋 Set full list', callback_data: 'a:setlist' },
        ],
        [
          { text: '🗑 Remove several', callback_data: 'a:removelist' },
        ],
        [
          { text: '💾 Export list', callback_data: 'a:export' },
        ],
      ],
    },
  };
}

bot.command('admin', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('Not authorized.');

  awaitingInput.delete(String(ctx.from.id));

  return ctx.reply(
    '⚙️ *Conclave Admin*\n\nPick something below.',
    { parse_mode: 'Markdown', ...adminPanel() }
  );
});

bot.on('callback_query', async (ctx) => {
  const userId = String(ctx.from.id);

  if (!isAdmin(userId)) {
    return safeAnswer(ctx, 'Not authorized.');
  }

  const action = ctx.callbackQuery.data;
  if (!action || !action.startsWith('a:')) return safeAnswer(ctx);

  const what = action.slice(2);

  try {
    switch (what) {
      case 'status': {
        await safeAnswer(ctx);
        const activeList = await getActiveList();
        const members = await getMembers();
        return ctx.reply(
          `📊 Verified members: ${members.length}\n` +
          `📋 Active list: ${activeList.size} handles`,
          adminPanel()
        );
      }

      case 'verified': {
        await safeAnswer(ctx);
        return sendLong(ctx, await formatVerified(), {
          parse_mode: 'HTML',
          ...adminPanel(),
        });
      }

      case 'showlist': {
        await safeAnswer(ctx);
        const activeList = await getActiveList();
        if (activeList.size === 0) {
          return ctx.reply('No list saved yet.', adminPanel());
        }
        return sendLong(
          ctx,
          `📋 Current list (${activeList.size}):\n` +
          [...activeList].map((h) => '@' + h).join('\n'),
          adminPanel()
        );
      }

      case 'export': {
        await safeAnswer(ctx);
        const activeList = await getActiveList();
        if (activeList.size === 0) {
          return ctx.reply('No list saved yet.', adminPanel());
        }
        return sendLong(ctx, `/setlist\n` + [...activeList].join('\n'));
      }

      case 'addsub': {
        await safeAnswer(ctx);
        awaitingInput.set(userId, 'addsub');
        return ctx.reply(
          '➕ Send me the X handle to add.\n\n(or /cancel to stop)'
        );
      }

      case 'removesub': {
        await safeAnswer(ctx);
        awaitingInput.set(userId, 'removesub');
        return ctx.reply(
          '➖ Send me the X handle to remove.\n\n(or /cancel to stop)'
        );
      }

      case 'whois': {
        await safeAnswer(ctx);
        awaitingInput.set(userId, 'whois');
        return ctx.reply(
          '🔍 Send me a handle to look up.\n\n' +
          'Works with their X handle or their Telegram username.\n\n' +
          '(or /cancel to stop)'
        );
      }

      case 'setlist': {
        await safeAnswer(ctx);
        awaitingInput.set(userId, 'setlist');
        const current = await getActiveList();
        return ctx.reply(
          `📋 Send me the full list — one X handle per line.\n\n` +
          `⚠️ This REPLACES the current list (${current.size} handles). ` +
          `Paste everyone, not just new people.\n\n` +
          `(or /cancel to stop)`
        );
      }

      case 'removelist': {
        await safeAnswer(ctx);
        awaitingInput.set(userId, 'removelist');
        return ctx.reply(
          `🗑 Send me the handles to remove — one per line.\n\n` +
          `Only these come off the list. Everyone else stays.\n\n` +
          `(or /cancel to stop)`
        );
      }

      case 'runcheck': {
        await safeAnswer(ctx, 'Running...');
        const result = await runCheck();
        if (result.skipped) return ctx.reply(result.reason, adminPanel());

        let msg =
          `🔄 Check complete.\n` +
          `Checked: ${result.checked}\n` +
          `Removed: ${result.removed.length}`;
        if (result.removed.length) {
          msg += '\n\nRemoved: ' + result.removed.map((h) => '@' + h).join(', ');
        }
        return ctx.reply(msg, adminPanel());
      }

      default:
        return safeAnswer(ctx);
    }
  } catch (err) {
    console.error('Panel action failed:', err.message);
    await safeAnswer(ctx, 'Something went wrong.');
    return ctx.reply(`Error: ${err.message}`, adminPanel());
  }
});

// Catches the handle an admin sends after tapping a panel button.
bot.on('text', async (ctx, next) => {
  const userId = String(ctx.from.id);
  const waitingFor = awaitingInput.get(userId);

  // Not mid-flow, or it's a command — let the normal handlers deal with it.
  if (!waitingFor) return next();
  if (ctx.message.text.startsWith('/')) {
    awaitingInput.delete(userId);
    return next();
  }

  awaitingInput.delete(userId);

  // The full-list paste is multi-line, so handle it before we normalise
  // the message as a single handle.
  if (waitingFor === 'setlist') {
    const lines = ctx.message.text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    if (lines.length === 0) {
      return ctx.reply('Nothing there. Nothing changed.', adminPanel());
    }

    const handles = new Set(lines.map(normalize));
    const wouldRemove = await previewRemovals(handles);

    if (wouldRemove.length > BULK_REMOVAL_THRESHOLD) {
      pendingSetlist.set(userId, handles);
      return ctx.reply(
        `⚠️ Hold on — this would remove ${wouldRemove.length} people:\n\n` +
        wouldRemove.map((h) => '@' + h).join(', ') +
        `\n\nNew list has ${handles.size} handles.\n\n` +
        `If that's right, send /confirm. Otherwise /cancel.`
      );
    }

    await applySetlist(ctx, handles);
    return ctx.reply('Done.', adminPanel());
  }

  if (waitingFor === 'removelist') {
    const lines = ctx.message.text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    if (lines.length === 0) {
      return ctx.reply('Nothing there. Nothing changed.', adminPanel());
    }

    return applyRemoveList(ctx, lines.map(normalize));
  }

  const handle = normalize(ctx.message.text);

  if (waitingFor === 'addsub') {
    const activeList = await getActiveList();
    if (activeList.has(handle)) {
      return ctx.reply(`@${handle} is already on the list.`, adminPanel());
    }
    activeList.add(handle);
    await saveActiveList(activeList);
    return ctx.reply(
      `✅ Added @${handle}.\nList is now ${activeList.size} handles.`,
      adminPanel()
    );
  }

  if (waitingFor === 'removesub') {
    const activeList = await getActiveList();
    if (!activeList.has(handle)) {
      return ctx.reply(`@${handle} isn't on the list.`, adminPanel());
    }
    activeList.delete(handle);
    await saveActiveList(activeList);

    await ctx.reply(
      `Removed @${handle} from the list (${activeList.size} left). Checking group...`
    );

    const result = await runCheck();
    if (result.skipped) return ctx.reply(result.reason, adminPanel());

    if (result.removed.length) {
      return ctx.reply(
        `✅ Kicked: ` + result.removed.map((h) => '@' + h).join(', '),
        adminPanel()
      );
    }
    return ctx.reply(
      `@${handle} wasn't in the group, so nothing to kick.`,
      adminPanel()
    );
  }

  if (waitingFor === 'whois') {
    return ctx.reply(await formatWhois(handle), {
      parse_mode: 'HTML',
      ...adminPanel(),
    });
  }

  return next();
});

// Award XP for chatting in the group.
bot.on('message', async (ctx, next) => {
  try {
    const msg = ctx.message;

    if (String(msg.chat.id) !== String(TELEGRAM_GROUP_ID)) return next();
    if (ctx.from.is_bot) return next();

    // Service messages and commands don't earn XP.
    if (msg.new_chat_members || msg.left_chat_member) return next();
    if (msg.text && msg.text.startsWith('/')) return next();

    const name = ctx.from.first_name || ctx.from.username || String(ctx.from.id);
    const newLevel = await awardXp(ctx.from.id, name);

    if (newLevel) {
      const mention = ctx.from.username ? '@' + ctx.from.username : name;
      const title = rankTitle(newLevel);

      const sent = await ctx.reply(
        `🔺 ${esc(mention)} just ascended to <b>Lvl ${newLevel} — ${title}</b>`,
        {
          parse_mode: 'HTML',
          ...(msg.message_thread_id
            ? { message_thread_id: msg.message_thread_id }
            : {}),
        }
      );

      // Keep the pinned board current.
      refreshPinnedBoard().catch(() => {});

      // Tidy it away so the chat doesn't fill with these.
      setTimeout(async () => {
        try {
          await ctx.telegram.deleteMessage(msg.chat.id, sent.message_id);
        } catch (err) {
          console.error('Could not delete rank-up notice:', err.message);
        }
      }, RANKUP_DELETE_AFTER_MS);
    }
  } catch (err) {
    console.error('XP handler failed:', err.message);
  }

  return next();
});

// Telegram posts "X joined the group" / "X was removed" notices. They
// pile up fast with a gatekeeper bot, so we delete them after a moment.
bot.on('message', async (ctx, next) => {
  const msg = ctx.message;

  const isServiceMessage =
    msg.new_chat_members ||
    msg.left_chat_member ||
    msg.new_chat_title ||
    msg.new_chat_photo ||
    msg.pinned_message;

  if (!isServiceMessage) return next();
  if (String(msg.chat.id) !== String(TELEGRAM_GROUP_ID)) return next();

  setTimeout(async () => {
    try {
      await ctx.telegram.deleteMessage(msg.chat.id, msg.message_id);
    } catch (err) {
      // Usually means it was already gone, or the bot lacks Delete rights.
      console.error('Could not delete service message:', err.message);
    }
  }, 10000);

  return next();
});

// ---------- Ascension (levels) ----------
//
// XP per message, with a cooldown so spamming doesn't farm levels.
// Level 1 is quick; the climb to Conclave Lord is deliberately brutal.

const XP_PER_MESSAGE = 5;
const XP_COOLDOWN_MS = 60 * 1000;          // one award per minute, per person
const LEVEL_CHECK_COOLDOWN_MS = 50 * 1000; // /level rate limit, per person
const RANKUP_DELETE_AFTER_MS = 15 * 1000;  // tidy up the announcement

// The ASCENSION topic. Level commands only work in here.
const ASCENSION_TOPIC_ID = process.env.ASCENSION_TOPIC_ID || '';

// Cumulative XP needed to REACH each level. Easy start, steep finish.
const LEVEL_THRESHOLDS = [
  0,      // level 0
  75,     // 1
  345,    // 2
  855,    // 3
  1605,   // 4
  2640,   // 5
  3945,   // 6
  5550,   // 7
  7470,   // 8
  9675,   // 9
  12225,  // 10
  15075,  // 11
  18300,  // 12
  21825,  // 13
  25725,  // 14
  30000,  // 15 — Conclave Lord
];

// When the curve was rescaled, everyone's existing XP was multiplied by
// this so nobody lost a rank they'd already earned. Used by /rescale.
const RESCALE_FACTOR = 1.5;

const MAX_LEVEL = LEVEL_THRESHOLDS.length - 1;

// Display names can contain characters that break Telegram's parser
// (underscores, asterisks, angle brackets). Escape them for HTML mode.
function esc(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function rankTitle(level) {
  if (level >= 15) return 'Conclave Lord';
  if (level >= 13) return 'Archon';
  if (level >= 10) return 'Elder';
  if (level >= 7) return 'Adept';
  if (level >= 4) return 'Acolyte';
  if (level >= 1) return 'Initiate';
  return 'Unranked';
}

function levelFromXp(xp) {
  let level = 0;
  for (let i = MAX_LEVEL; i >= 0; i--) {
    if (xp >= LEVEL_THRESHOLDS[i]) {
      level = i;
      break;
    }
  }

  if (level >= MAX_LEVEL) {
    return {
      level: MAX_LEVEL,
      maxed: true,
      xpIntoLevel: 0,
      xpNeeded: 0,
      remaining: 0,
    };
  }

  const floorXp = LEVEL_THRESHOLDS[level];
  const nextXp = LEVEL_THRESHOLDS[level + 1];

  return {
    level,
    maxed: false,
    xpIntoLevel: xp - floorXp,
    xpNeeded: nextXp - floorXp,
    remaining: nextXp - xp,
  };
}

async function getXpRecord(tgId) {
  const record = await redis.get(`xp:${tgId}`);
  return record || { xp: 0, lastAward: 0, name: null };
}

async function saveXpRecord(tgId, record) {
  await redis.set(`xp:${tgId}`, record);
  await redis.sadd('xp_users', String(tgId));
}

// Award XP for a message. Returns the new level if they ranked up.
async function awardXp(tgId, displayName) {
  const now = Date.now();
  const record = await getXpRecord(tgId);

  if (now - (record.lastAward || 0) < XP_COOLDOWN_MS) return null;

  const before = levelFromXp(record.xp).level;

  record.xp += XP_PER_MESSAGE;
  record.lastAward = now;
  record.name = displayName;
  await saveXpRecord(tgId, record);

  const after = levelFromXp(record.xp).level;
  return after > before ? after : null;
}

// True if this message is in the ASCENSION topic.
function inAscensionTopic(ctx) {
  if (!ASCENSION_TOPIC_ID) return true;
  const thread = ctx.message && ctx.message.message_thread_id;
  return String(thread || '') === String(ASCENSION_TOPIC_ID);
}

// Build the top 15 board.
async function buildLeaderboard() {
  const ids = (await redis.smembers('xp_users')) || [];
  const rows = [];

  for (const id of ids) {
    const record = await getXpRecord(id);
    if (!record.xp) continue;
    const { level } = levelFromXp(record.xp);
    rows.push({ name: record.name || id, xp: record.xp, level });
  }

  rows.sort((a, b) => b.xp - a.xp);
  return rows.slice(0, 15);
}

function formatLeaderboard(rows) {
  if (rows.length === 0) {
    return '🔺 <b>ASCENSION</b>\n\nNobody has earned XP yet.';
  }

  const medals = ['🥇', '🥈', '🥉'];
  const body = rows
    .map((r, i) => {
      const pos = medals[i] || `${String(i + 1).padStart(2, ' ')}.`;
      return `${pos} ${esc(r.name)} — ${rankTitle(r.level)} (Lvl ${r.level})`;
    })
    .join('\n');

  return (
    `🔺 <b>ASCENSION — Top 15</b>\n\n${body}\n\n` +
    `<i>Updated ${esc(new Date().toUTCString())}</i>`
  );
}

// The pinned board lives at a message id we remember.
async function refreshPinnedBoard() {
  const pinnedId = await redis.get('ascension_pin');
  if (!pinnedId) return;

  const rows = await buildLeaderboard();

  try {
    await bot.telegram.editMessageText(
      TELEGRAM_GROUP_ID,
      Number(pinnedId),
      undefined,
      formatLeaderboard(rows),
      { parse_mode: 'HTML' }
    );
  } catch (err) {
    // "message is not modified" is normal when nothing changed.
    if (!err.message.includes('not modified')) {
      console.error('Could not refresh pinned board:', err.message);
    }
  }
}

// ---------- Gatecrasher check ----------
//
// Fires whenever someone joins. An invite link is single-use, but nothing
// stops a subscriber forwarding it to a friend who uses it first. So we
// check that whoever walked through the door is the person the link was
// minted for, and remove them if not.

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

    // Only care about someone newly joining.
    if (wasIn || !isIn) return;

    const joiner = update.new_chat_member.user;
    const joinerId = String(joiner.id);

    // Admins and the bot itself are exempt.
    if (isAdmin(joinerId)) return;
    if (joiner.is_bot) return;

    const usedLink = update.invite_link && update.invite_link.invite_link;

    // Joined without a bot-issued link at all (e.g. the group's primary
    // link, or added by another member) — they never verified.
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

    // Link we don't recognise — treat as untrusted.
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

    // The link was issued to someone else — this is a forwarded link.
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

    // Correct person, correct link — let them stay. The link is consumed
    // now, so drop the record.
    await redis.del(`invite:${usedLink}`);
  } catch (err) {
    console.error('chat_member handler failed:', err.message);
  }
});

// If a /setlist would remove more than this many people at once, ask for
// confirmation first. Guards against a paste error emptying the group.
const BULK_REMOVAL_THRESHOLD = 5;

// Pending confirmations, keyed by admin id. In memory, short-lived.
const pendingSetlist = new Map();

// Who would be removed if this became the active list? Read-only.
async function previewRemovals(newList) {
  const members = await getMembers();
  const wouldGo = [];

  for (const tgId of members) {
    const record = await redis.get(`verified:${tgId}`);
    if (!record) continue;
    const handle = normalize(record.username);
    if (!newList.has(handle)) wouldGo.push(handle);
  }

  return wouldGo;
}

async function applySetlist(ctx, handles) {
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
}

// Telegram caps messages at 4096 characters. With a few hundred handles
// we blow past that, so split long replies into several messages.
const TG_LIMIT = 3800; // leave headroom for formatting

async function sendLong(ctx, text, extra = {}) {
  if (text.length <= TG_LIMIT) {
    return ctx.reply(text, extra);
  }

  const lines = text.split('\n');
  const chunks = [];
  let current = '';

  for (const line of lines) {
    if ((current + line + '\n').length > TG_LIMIT) {
      if (current) chunks.push(current);
      current = '';
    }
    current += line + '\n';
  }
  if (current.trim()) chunks.push(current);

  // Only the last chunk carries the keyboard, so we don't get one per part.
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const label = chunks.length > 1 ? `(${i + 1}/${chunks.length})\n` : '';
    await ctx.reply(label + chunks[i], isLast ? extra : {});
    await sleep(300);
  }
}

// Answering a callback fails if the query has already expired. That's
// harmless, but an unhandled throw here kills the process.
async function safeAnswer(ctx, text) {
  try {
    await ctx.answerCbQuery(text);
  } catch (err) {
    // Query expired — nothing to do.
  }
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

// allowed_updates must include chat_member — Telegram does not send it
// by default, so without this the gatecrasher check never fires.
// A single failed reply used to take the whole process down, which meant
// the bot went dead until Render restarted it. Catch everything instead.
bot.catch((err, ctx) => {
  console.error(`Bot error on ${ctx.updateType}:`, err.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason && reason.message ? reason.message : reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.message);
});

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
//
// An external free cron service (cron-job.org) calls this once a day.
// The secret in the URL stops randoms from triggering it.

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

  // Tell the admin(s) what happened, but only if someone was removed.
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
// The free cron service also pings this every 10 min so Render
// doesn't put the app to sleep.

app.get('/ping', (req, res) => res.send('pong'));

app.get('/', (req, res) => res.send('X verify bot is running.'));

app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

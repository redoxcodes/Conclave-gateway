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

// Look someone up — for when a member says they can't get in.
bot.command('whois', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('Not authorized.');

  const arg = ctx.message.text.split(' ')[1];
  if (!arg) return ctx.reply('Usage: /whois their_x_handle');

  const handle = normalize(arg);
  const activeList = await getActiveList();
  const onList = activeList.has(handle);

  const members = await getMembers();
  let verifiedAs = null;

  for (const tgId of members) {
    const record = await redis.get(`verified:${tgId}`);
    if (record && normalize(record.username) === handle) {
      verifiedAs = { tgId, ...record };
      break;
    }
  }

  let msg = `@${handle}\n\n`;
  msg += onList ? `✅ On the subscriber list\n` : `❌ Not on the subscriber list\n`;

  if (verifiedAs) {
    msg += `✅ Verified (Telegram ID ${verifiedAs.tgId})\n`;
    msg += `Verified on ${new Date(verifiedAs.verifiedAt).toDateString()}\n`;
  } else {
    msg += `❌ Has never verified with the bot\n`;
  }

  msg += `\n`;
  if (onList && verifiedAs) {
    msg += `They should have access. If they don't, check they aren't in ` +
           `Removed Users in group settings.`;
  } else if (onList && !verifiedAs) {
    msg += `On the list but hasn't verified — tell them to send /start to the bot.`;
  } else if (!onList && verifiedAs) {
    msg += `Verified but not on the list. Use /addsub ${handle} if they've subscribed.`;
  } else {
    msg += `Nothing on record for them at all.`;
  }

  return ctx.reply(msg);
});

// Back up the list, in case the database is ever wiped.
bot.command('export', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('Not authorized.');

  const activeList = await getActiveList();
  if (activeList.size === 0) return ctx.reply('No list saved yet.');

  // Formatted so you can paste it straight back into /setlist.
  return ctx.reply(`/setlist\n` + [...activeList].join('\n'));
});

// /status — quick health check
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

  return ctx.reply(
    `Current list (${activeList.size}):\n` +
    [...activeList].map((h) => '@' + h).join('\n')
  );
});

// /myid — tells you your Telegram user id (useful for setting ADMIN_USER_IDS)
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
    return ctx.answerCbQuery('Not authorized.', { show_alert: true });
  }

  const action = ctx.callbackQuery.data;
  if (!action || !action.startsWith('a:')) return ctx.answerCbQuery();

  const what = action.slice(2);

  try {
    switch (what) {
      case 'status': {
        await ctx.answerCbQuery();
        const activeList = await getActiveList();
        const members = await getMembers();
        return ctx.reply(
          `📊 Verified members: ${members.length}\n` +
          `📋 Active list: ${activeList.size} handles`,
          adminPanel()
        );
      }

      case 'showlist': {
        await ctx.answerCbQuery();
        const activeList = await getActiveList();
        if (activeList.size === 0) {
          return ctx.reply('No list saved yet.', adminPanel());
        }
        return ctx.reply(
          `📋 Current list (${activeList.size}):\n` +
          [...activeList].map((h) => '@' + h).join('\n'),
          adminPanel()
        );
      }

      case 'export': {
        await ctx.answerCbQuery();
        const activeList = await getActiveList();
        if (activeList.size === 0) {
          return ctx.reply('No list saved yet.', adminPanel());
        }
        return ctx.reply(`/setlist\n` + [...activeList].join('\n'));
      }

      case 'addsub': {
        await ctx.answerCbQuery();
        awaitingInput.set(userId, 'addsub');
        return ctx.reply(
          '➕ Send me the X handle to add.\n\n(or /cancel to stop)'
        );
      }

      case 'removesub': {
        await ctx.answerCbQuery();
        awaitingInput.set(userId, 'removesub');
        return ctx.reply(
          '➖ Send me the X handle to remove.\n\n(or /cancel to stop)'
        );
      }

      case 'whois': {
        await ctx.answerCbQuery();
        awaitingInput.set(userId, 'whois');
        return ctx.reply(
          '🔍 Send me the X handle to look up.\n\n(or /cancel to stop)'
        );
      }

      case 'runcheck': {
        await ctx.answerCbQuery('Running...');
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
        return ctx.answerCbQuery();
    }
  } catch (err) {
    console.error('Panel action failed:', err.message);
    await ctx.answerCbQuery('Something went wrong.');
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
    const activeList = await getActiveList();
    const onList = activeList.has(handle);

    const members = await getMembers();
    let verifiedAs = null;

    for (const tgId of members) {
      const record = await redis.get(`verified:${tgId}`);
      if (record && normalize(record.username) === handle) {
        verifiedAs = { tgId, ...record };
        break;
      }
    }

    let msg = `🔍 @${handle}\n\n`;
    msg += onList ? `✅ On the subscriber list\n` : `❌ Not on the subscriber list\n`;

    if (verifiedAs) {
      msg += `✅ Verified (Telegram ID ${verifiedAs.tgId})\n`;
      msg += `Verified on ${new Date(verifiedAs.verifiedAt).toDateString()}\n`;
    } else {
      msg += `❌ Has never verified with the bot\n`;
    }

    msg += `\n`;
    if (onList && verifiedAs) {
      msg += `They should have access. If not, check Removed Users in group settings.`;
    } else if (onList && !verifiedAs) {
      msg += `On the list but hasn't verified — tell them to send /start to the bot.`;
    } else if (!onList && verifiedAs) {
      msg += `Verified but not on the list. Add them if they've subscribed.`;
    } else {
      msg += `Nothing on record for them at all.`;
    }

    return ctx.reply(msg, adminPanel());
  }

  return next();
});

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

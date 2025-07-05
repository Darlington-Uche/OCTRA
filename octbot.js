const express = require('express');
const axios = require('axios');
const { Telegraf, Markup } = require('telegraf');
const NodeCache = require('node-cache');

const bot = new Telegraf(process.env.BOT_TOKEN);
const app = express();
const webhookurl = `${process.env.BOT_SERVER}/telegram-webhook`;

// Cache for frequently accessed data
const cache = new NodeCache({ stdTTL: 60, checkperiod: 120 });

// Optimized webhook setup
bot.telegram.setWebhook(webhookurl).catch(console.error);
app.use(express.json({ limit: '10kb' }));
app.use(bot.webhookCallback('/telegram-webhook'));

// Health check endpoint
app.get('/', (req, res) => {
  res.send('Hello! i am alive and Active 🤔');
});

// Server configuration with failover
const SERVERS = [
  process.env.SERVER, 
  process.env.SERVER_2,
  process.env.SERVER_3,
  process.env.SERVER_4 
].filter(Boolean);

// Optimized server selection with caching
async function getOptimalServer() {
  const cacheKey = 'optimal-server';
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const results = await Promise.allSettled(
      SERVERS.map(url => 
        axios.get(`${url}/server-status`, { timeout: 2000 })
          .then(res => ({ url, load: res.data.activeRequests || Infinity }))
      )
    );

    const validResults = results
      .filter(r => r.status === 'fulfilled' && r.value.load !== Infinity)
      .map(r => r.value);

    if (validResults.length === 0) return SERVERS[0];

    validResults.sort((a, b) => a.load - b.load);
    const bestServer = validResults[0].url;
    cache.set(cacheKey, bestServer, 30); // Cache for 30 seconds
    return bestServer;
  } catch (err) {
    console.error('Server selection error:', err);
    return SERVERS[0];
  }
}

// Optimized API caller with retry logic
async function callAPI(endpoint, method = 'get', data = {}) {
  const maxRetries = 2;
  let lastError;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const baseURL = await getOptimalServer();
      const config = {
        method,
        url: `${baseURL}${endpoint}`,
        timeout: 5000,
        headers: { 'Content-Type': 'application/json' }
      };

      method.toLowerCase() === 'get' ? (config.params = data) : (config.data = data);

      const response = await axios(config);
      return response.data;
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries - 1) await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
    }
  }

  console.error('API Error:', {
    endpoint,
    error: lastError.response?.data || lastError.message
  });
  return { error: 'Octra Error' };
}

// Session management with TTL
const sessions = new NodeCache({ stdTTL: 1800, deleteOnExpire: true });

// Start command - optimized with caching
bot.command('keys', async (ctx) => {
  const userId = ctx.from.id;
  const cacheKey = `keys-${userId}`;
  
  try {
    const cached = cache.get(cacheKey);
    const keys = cached || await callAPI(`/get-keys/${userId}`);
    if (!keys) return ctx.reply('❌ Failed to retrieve keys. Please try again.');

    if (!cached) cache.set(cacheKey, keys, 60);

    const warningMsg = await ctx.reply('⚠️ These credentials will be deleted in 1 minute.');
    const msg1 = await ctx.replyWithHTML(
      `<b>Your Wallet Credentials</b>\n\n<b>Address:</b> <code>${keys.address}</code>\n<b>Mnemonic:</b> <code>${keys.mnemonic}</code>\n\n⚠️ <b>Keep this information SECURE!</b>`
    );
    const msg2 = await ctx.reply('🔐 Private key will be sent in the next message...');
    const msg3 = await ctx.reply(`Private Key: ${keys.privateKey}`);

    setTimeout(async () => {
      try {
        await Promise.all([
          ctx.deleteMessage(warningMsg.message_id),
          ctx.deleteMessage(msg1.message_id),
          ctx.deleteMessage(msg2.message_id),
          ctx.deleteMessage(msg3.message_id)
        ]);
      } catch (err) {
        console.error('Failed to delete messages:', err.message);
      }
    }, 60000);
  } catch (err) {
    console.error('Keys command error:', err);
    ctx.reply('❌ An error occurred. Please try again.');
  }
});

// Optimized start command
bot.start(async (ctx) => {
  const userId = String(ctx.from.id);
  const username = ctx.from.username || ctx.from.first_name;
  
  // Always update username in the background
  callAPI('/update-username', 'post', { userId, username }).catch(console.error);

  // Check or create wallet
  const walletResponse = await callAPI('/create-wallet', 'post', {
    userId,
    username
  });

  if (!walletResponse || walletResponse.error) {
    return ctx.reply('❌ Failed to access your wallet. Please try again.');
  }

  // Fetch balance
  const balanceInfo = await callAPI(`/get-balance/${walletResponse.address}`);

    const welcomeMessage = walletResponse.exists
      ? `👋 Welcome back, <b>${username}</b>!`
      : `🎉 Welcome, <b>${username}</b>! Your new Octra wallet is ready!`;

    await ctx.replyWithHTML(
      `${welcomeMessage}\n\n🔐 Your Octra Address:\n<code>${walletResponse.address}</code>\n\n` +
      `💰 Balance: <b>${balanceInfo?.balance || 0} OCT</b>\n\n` +
      `👉 Join our <a href="https://chat.whatsapp.com/FREEb4qOVqKD38IAfA0wUA">WhatsApp Group</a>\n\n` +
      `Made by @Darlington_W3\n\n\n---Server 10453$__ ✅`,
      Markup.inlineKeyboard([
        [
          Markup.button.callback('💸 Send OCT', 'send_octra'),
          Markup.button.callback('📜 Transactions', 'tx_history')
        ],
        [
          Markup.button.callback('🔑 Switch Wallet', 'switch_wallet'),
          Markup.button.callback('🆘 Support', 'support')
        ],
        [
          Markup.button.callback('💫Auto Transaction', 'premium')
        ]
      ])
    );
  } catch (err) {
    console.error('Start command error:', err);
    ctx.reply('❌ Failed to initialize wallet. Please try again.');
  }
});

// Handle switch wallet button
bot.action('switch_wallet', async (ctx) => {
  await ctx.editMessageText(
    '🔑 <b>Switch Wallet</b>\n\n' +
    'To switch to a different wallet, please send me your private key.\n\n' +
    '⚠️ <b>Warning:</b> This will replace your current wallet credentials.\n' +
    'The bot will not store your private key after the switch is complete.',
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🚫 Cancel', 'main_menu')]
      ])
    }
  );

  // Set session state
  const userId = ctx.from.id;
  sessions.set(userId, { step: 'await_private_key' });
});

// Handle switch confirmation
bot.action('confirm_switch', async (ctx) => {
  const userId = ctx.from.id;
  const session = sessions.get(userId);

  if (!session?.privateKey) {
    return ctx.editMessageText('❌ No private key found in session');
  }

  // Show processing message
  await ctx.editMessageText('⏳ Processing wallet switch...');

  // Call your API to switch wallets
  const result = await callAPI('/switch-wallet', 'post', {
    userId,
    privateKey: session.privateKey
  });

  if (result?.success) {
    await ctx.editMessageText(
      '✅ <b>Wallet Successfully Switched!</b>\n\n' +
      `New address: <code>${result.address}</code>\n\n` +
      'Please make sure to securely store your private key.',
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🏠 Main Menu', 'main_menu')]
        ])
      }
    );
  } else {
    await ctx.editMessageText(
      '❌ Failed to switch wallets:\n' +
      (result?.error || 'Unknown error'),
      Markup.inlineKeyboard([
        [Markup.button.callback('🏠 Main Menu', 'main_menu')]
      ])
    );
  }

  // Clear session
  sessions.del(userId);
});

bot.action('cancel_switch', async (ctx) => {
  const userId = ctx.from.id;
  sessions.del(userId);

  await ctx.deleteMessage();
  await ctx.replyWithHTML(
    '🔐 Wallet switch cancelled.',
    Markup.inlineKeyboard([
      [Markup.button.callback('🏠 Main Menu', 'main_menu')]
    ])
  );
});

// Send OCT flow
bot.action('send_octra', async (ctx) => {
  const userId = ctx.from.id;

  // Get wallet info
  const wallet = await callAPI(`/get-user-info/${userId}`);
  if (!wallet) {
    return ctx.reply('❌ Failed to load your wallet. Please try again.');
  }

  // Initialize session
  sessions.set(userId, { 
    step: 'await_address',
    walletAddress: wallet.address 
  });

  await ctx.editMessageText(
    `✉️ <b>Send Octra</b>\n\n` +
    `Enter the recipient address:\n\n` +
    `My address: <code>${wallet.address}</code>\n\n` +
    `You can send Here <code>oct4M33BxGEUXSdUDLgt9tpZx64NYwd5Fkw6QMV3Pei7hGa</code>`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🚫 Cancel', 'cancel_tx')]
      ])
    }
  );
});

// Transaction amount step
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const session = sessions.get(userId);

  if (!session) return;

  if (session.step === 'await_address') {
    // Validate address format
    if (!ctx.message.text.startsWith('oct')) {
      return ctx.reply('❌ Invalid Octra address format. Must start with "oct"');
    }

    session.recipient = ctx.message.text;
    session.step = 'await_amount';
    sessions.set(userId, session);

    // Get current balance
    const balanceInfo = await callAPI(`/get-balance/${session.walletAddress}`);
    const balance = balanceInfo?.balance || 0;

    await ctx.replyWithHTML(
      `💵 Enter amount to send (Your balance: ${balance} OCT)`,
      Markup.inlineKeyboard([
        [Markup.button.callback('🚫 Cancel', 'cancel_tx')]
      ])
    );
    await ctx.deleteMessage();
  }
  else if (session.step === 'await_private_key') {
    const privateKey = ctx.message.text.trim();
    const userId = ctx.from.id;

    // Basic validation
    if (!privateKey || privateKey.length < 30) {
      return ctx.reply('❌ Invalid private key format. Please try again.');
    }

    // Store private key in session for confirmation
    sessions.set(userId, { ...session, privateKey });

    // Show confirmation
    await ctx.replyWithHTML(
      '⚠️ <b>Confirm Wallet Switch</b>\n\n' +
      'You are about to replace your current wallet with a new one.\n\n' +
      'This action cannot be undone!',
      Markup.inlineKeyboard([
        [
          Markup.button.callback('✅ Confirm Switch', 'confirm_switch'),
          Markup.button.callback('🚫 Cancel', 'cancel_switch')
        ]
      ])
    );

    // Delete the private key message for security
    await ctx.deleteMessage();
  }
  else if (session.step === 'await_amount') {
    const amount = parseFloat(ctx.message.text);

    if (isNaN(amount) || amount <= 0) {
      return ctx.reply('❌ Please enter a valid positive number');
    }

    // Get current balance
    const balanceInfo = await callAPI(`/get-balance/${session.walletAddress}`);
    const balance = balanceInfo?.balance || 0;

    if (amount > balance) {
      return ctx.reply(`❌ Insufficient balance (You have ${balance} OCT)`);
    }

    session.amount = amount;
    session.step = 'confirm';
    sessions.set(userId, session);

    await ctx.replyWithHTML(
      `🔍 <b>Confirm Transaction</b>\n\n` +
      `To: <code>${session.recipient}</code>\n` +
      `Amount: <b>${amount} OCT</b>\n\n` +
      `Network fee: 0.001 OCT`,
      Markup.inlineKeyboard([
        [
          Markup.button.callback('✅ Confirm', 'confirm_tx'),
          Markup.button.callback('🚫 Cancel', 'cancel_tx')
        ]
      ])
    );

    await ctx.deleteMessage();
  }
});

// Confirm transaction
bot.action('confirm_tx', async (ctx) => {
  const userId = ctx.from.id;
  const session = sessions.get(userId);

  if (!session || session.step !== 'confirm') return;

  await ctx.editMessageText(
    `⏳ Processing your transaction...`,
    Markup.inlineKeyboard([])
  );

  // Call API to send transaction
  const txResult = await callAPI('/send-tx', 'post', {
    userId,
    recipient: session.recipient,
    amount: session.amount
  });

  if (txResult?.success) {
    // Get sender info to extract username
    const senderInfo = await callAPI(`/get-user-info/${userId}`);
    const senderUsername = senderInfo?.username || 'Unknown';

    // Get recipient info using recipient address
    const allWallets = await callAPI('/wallets');
    const recipientWallet = allWallets?.wallets?.find(w => w.address === session.recipient);

    if (recipientWallet?.userId) {
      const receiverUserId = recipientWallet.userId;
      await bot.telegram.sendMessage(
        receiverUserId,
        `✅ You just received <b>${session.amount.toFixed(4)} OCT</b>\nFrom: @${senderUsername}`,
        { parse_mode: 'HTML' }
      ).catch(console.error);
    }

    await ctx.editMessageText(
      `✅ <b>Transaction Successful!</b>\n\n` +
      `Amount: <b>${session.amount} OCT</b>\n` +
      `To: <code>${session.recipient}</code>\n\n` +
      `View on explorer:\n${txResult.explorerUrl}\n\n\n` +
      `Un-official❕ https://t.me/octra_bot`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🏠 Main Menu', 'main_menu')]
        ])
      }
    );
  } else {
    await ctx.editMessageText(
      `❌ Transaction failed!\n\n` +
      `Error: ${txResult?.error || 'Unknown error'}`,
      Markup.inlineKeyboard([
        [Markup.button.callback('🏠 Main Menu', 'main_menu')]
      ])
    );
  }

  sessions.del(userId);
});

// Cancel transaction
bot.action('cancel_tx', async (ctx) => {
  const userId = ctx.from.id;
  sessions.del(userId);

  await ctx.editMessageText(
    '❌ Transaction cancelled',
    Markup.inlineKeyboard([
      [Markup.button.callback('🏠 Main Menu', 'main_menu')]
    ])
  );
});

// Main menu callback
bot.action('main_menu', async (ctx) => {
  const userId = ctx.from.id;
  await ctx.deleteMessage();

  // Get updated balance
  const wallet = await callAPI(`/get-user-info/${userId}`);
  const balanceInfo = await callAPI(`/get-balance/${wallet.address}`);

  await ctx.replyWithHTML(
    `👋 Welcome back!\n\n` +
    `🔐 Your Octra Address:\n<code>${wallet.address}</code>\n\n` +
    `👉 Join our <a href="https://chat.whatsapp.com/FREEb4qOVqKD38IAfA0wUA">WhatsApp Group</a>\n\n` +
    `💰 Your balance: <b>${balanceInfo?.balance || 0} OCT</b>`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback('💸 Send OCT', 'send_octra'),
        Markup.button.callback('📜 Transactions', 'tx_history')
      ],
      [
        Markup.button.callback('🆘 Support', 'support'),
        Markup.button.callback('⭐ Premium', 'premium')
      ]
    ])
  );
});

// Transaction history
bot.action('tx_history', async (ctx) => {
  try {
    const userId = String(ctx.from.id);
    await ctx.answerCbQuery('Fetching transactions...');

    // Get wallet address
    const wallet = await callAPI(`/get-user-info/${userId}`);
    if (!wallet?.address) {
      return ctx.reply('❌ Wallet address not found');
    }

    // Get transactions
    const txData = await callAPI(`/get-transactions/${wallet.address}`);

    if (!txData?.transactions?.length) {
      return ctx.replyWithHTML(
        `📜 <b>Transaction History</b>\n\n` +
        `No transactions found for:\n<code>${wallet.address}</code>`
      );
    }

    // Format transactions for display
    const formattedTxs = txData.transactions.map((tx, i) => {
      const direction = tx.type === 'in' ? '⬇️ IN' : '⬆️ OUT';
      const amount = tx.amount.toFixed(6);
      const time = tx.timestamp?.toLocaleString() || 'Pending';

      return (
        `\n${i+1}. ${direction} ${amount} OCT\n` +
        `   ${tx.counterparty || 'Unknown'}\n` +
        `   ${time} (${tx.status})`
      );
    });

    await ctx.replyWithHTML(
      `📜 <b>Transaction History</b>\n\n` +
      `Address: <code>${wallet.address}</code>\n\n` +
      `${formattedTxs.join('\n')}\n\n` +
      `<a href="https://octrascan.io/address/${wallet.address}">View on explorer</a>`,
      {
        disable_web_page_preview: true,
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Refresh', 'tx_history')],
          [Markup.button.callback('🏠 Menu', 'main_menu')]
        ])
      }
    );

  } catch (error) {
    console.error('TX History Error:', error);
    await ctx.reply('❌ Failed to load transactions. Please try again later.');
  }
});

// Other menu buttons (placeholders)
bot.action(['support', 'premium'], async (ctx) => {
  await ctx.answerCbQuery('🚧 Feature coming soon!');
});

// Error handling
bot.catch((err) => {
  console.error('Bot error:', err);
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
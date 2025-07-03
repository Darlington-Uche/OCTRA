const express = require('express');
const axios = require('axios');
const { Telegraf, Markup } = require('telegraf');

const bot = new Telegraf(process.env.BOT_TOKEN); // make sure BOT_TOKEN is set
const app = express();
const webhookurl = `${process.env.BOT_SERVER}/telegram-webhook`;

// This sets the webhook Telegram will call
bot.telegram.setWebhook(webhookurl);

// This tells Express how to handle webhook requests from Telegram
app.use(bot.webhookCallback('/telegram-webhook'));

// Optional: base route to confirm server is live
app.get('/', (req, res) => {
  res.send('Hello! i am alive and Active 🤔');
});

// Start the server
app.listen(3000, () => {
  console.log('Server 10100101010010');
});
const LOCAL_SERVER_URL = process.env.SERVER; // Your local server URL

// Session storage for transaction flow
const sessions = {};

// Update the callAPI function to better handle errors
async function callAPI(endpoint, method = 'get', data = {}) {
  try {
    const config = {
      method,
      url: `${LOCAL_SERVER_URL}${endpoint}`,
      headers: {
        'Content-Type': 'application/json'
      }
    };

    if (method.toLowerCase() === 'get') {
      config.params = data;
    } else {
      config.data = data;
    }

    const response = await axios(config);
    return response.data;
  } catch (error) {
    console.error('API Error:', {
      endpoint,
      error: error.response?.data || error.message,
      requestData: data
    });
    return { error: error.response?.data?.error || 'API request failed' };
  }
}
bot.command('keys', async (ctx) => {
  const userId = ctx.from.id;

  // Fetch the keys
  const keys = await callAPI(`/get-keys/${userId}`);

  if (!keys) {
    return ctx.reply('❌ Failed to retrieve keys. Please try again.');
  }

  // Notify about auto-deletion
  const warningMsg = await ctx.reply('⚠️ These credentials will be deleted in 1 minute.');

  // Send the sensitive information and collect message IDs
  const msg1 = await ctx.replyWithHTML(
    `<b>Your Wallet Credentials</b>\n\n` +
    `<b>Address:</b> <code>${keys.address}</code>\n` +
    `<b>Mnemonic:</b> <code>${keys.mnemonic}</code>\n\n` +
    `⚠️ <b>Keep this information SECURE!</b>`,
    { parse_mode: 'HTML' }
  );

  const msg2 = await ctx.reply('🔐 Private key will be sent in the next message...');
  const msg3 = await ctx.reply(`Private Key: ${keys.privateKey}`);

  // Schedule deletion after 60 seconds
  setTimeout(async () => {
    try {
      await ctx.deleteMessage(warningMsg.message_id);
      await ctx.deleteMessage(msg1.message_id);
      await ctx.deleteMessage(msg2.message_id);
      await ctx.deleteMessage(msg3.message_id);
    } catch (err) {
      console.error('❌ Failed to delete one or more messages:', err.message);
    }
  }, 60000); // 60 seconds
});

// Start command - Updated to check for existing wallet
bot.start(async (ctx) => {
  const userId = String(ctx.from.id);
  const username = ctx.from.username || ctx.from.first_name;
  
  // Check if wallet exists first
  const walletResponse = await callAPI('/create-wallet', 'post', { userId });
  
  if (!walletResponse || walletResponse.error) {
    return ctx.reply('❌ Failed to access your wallet. Please try again.');
  }

  // Get balance
  const balanceInfo = await callAPI(`/get-balance/${walletResponse.address}`);
  
  const welcomeMessage = walletResponse.exists ?
    `👋 Welcome back, <b>${username}</b>!` :
    `🎉 Welcome, <b>${username}</b>! Your new Octra wallet is ready!`;
  
  await ctx.replyWithHTML(
    `${welcomeMessage}\n\n` +
    `🔐 Your Octra Address:\n<code>${walletResponse.address}</code>\n\n` +
    `💰 Balance: <b>${balanceInfo?.balance || 0} OCT</b>\n\n` +
    `👉 Join our <a href="https://chat.whatsapp.com/FREEb4qOVqKD38IAfA0wUA">WhatsApp Group</a>\n\n` +
    `Made by @Darlington_W3`,
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
  sessions[userId] = { step: 'await_private_key' };
});

  // Handle switch confirmation
bot.action(/confirm_switch:(.+)/, async (ctx) => {
  const privateKey = ctx.match[1];
  const userId = ctx.from.id;
  
  // Show processing message
  await ctx.editMessageText('⏳ Processing wallet switch...');
  
  // Call your API to switch wallets
  const result = await callAPI('/switch-wallet', 'post', {
    userId,
    privateKey
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
  delete sessions[userId];
});

// Handle switch cancellation
bot.action('cancel_switch', async (ctx) => {
  const userId = ctx.from.id;
  delete sessions[userId];
  
  await ctx.editMessageText(
    '🔐 Wallet switch cancelled.',
    Markup.inlineKeyboard([
      [Markup.button.callback('🏠 Main Menu', 'main_menu')]
    ])
  );
});

  // Delete the private key message for security
  await ctx.deleteMessage();
}
// Send OCT flow
bot.action('send_octra', async (ctx) => {
  const userId = ctx.from.id;
  
  // Get wallet info
  const wallet = await callAPI(`/get-user-info/${userId}`);
  if (!wallet) {
    return ctx.reply('❌ Failed to load your wallet. Please try again.');
  }

  // Initialize session
  sessions[userId] = { 
    step: 'await_address',
    walletAddress: wallet.address 
  };
  
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
  const session = sessions[userId];
  
  if (!session) return;
  
  if (session.step === 'await_address') {
    // Validate address format
    if (!ctx.message.text.startsWith('oct')) {
      return ctx.reply('❌ Invalid Octra address format. Must start with "oct"');
    }
    
    session.recipient = ctx.message.text;
    session.step = 'await_amount';
    
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
  
  // Basic validation (adjust according to your blockchain's private key format)
  if (!privateKey || privateKey.length < 30) {
    return ctx.reply('❌ Invalid private key format. Please try again.');
  }
  
  // Show confirmation
  await ctx.replyWithHTML(
    '⚠️ <b>Confirm Wallet Switch</b>\n\n' +
    'You are about to replace your current wallet with a new one.\n\n' +
    'This action cannot be undone!',
    Markup.inlineKeyboard([
      [
        Markup.button.callback('✅ Confirm Switch', `confirm_switch:${privateKey}`),
        Markup.button.callback('🚫 Cancel', 'cancel_switch')
      ]
    ])
  );
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
  const session = sessions[userId];
  
  if (!session || session.step !== 'confirm') return;
  
  // Show processing message
  await ctx.editMessageText(
    `⏳ Processing your transaction...`,
    Markup.inlineKeyboard([])
  );
  
  // Send transaction via backend
  const txResult = await callAPI('/send-tx', 'post', {
    userId,
    recipient: session.recipient,
    amount: session.amount
  });
  
  if (txResult?.success) {
    await ctx.editMessageText(
      `✅ <b>Transaction Successful!</b>\n\n` +
      `Amount: <b>${session.amount} OCT</b>\n` +
      `To: <code>${session.recipient}</code>\n\n` +
      `View on explorer:\n` +
      `${txResult.explorerUrl}`,
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
  
  // Clear session
  delete sessions[userId];
});

// Cancel transaction
bot.action('cancel_tx', async (ctx) => {
  const userId = ctx.from.id;
  delete sessions[userId];
  
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
    `🔐 Your Octra Address:\n<code>${walletResponse.address}</code>\n\n` +
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
bot.action(['x', 'support', 'premium'], async (ctx) => {
  await ctx.answerCbQuery('🚧 Feature coming soon!');
});

// Error handling
bot.catch((err) => {
  console.error('Bot error:', err);
});


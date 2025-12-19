require('dotenv').config();
const { Telegraf, Markup, session } = require('telegraf');
const mongoose = require('mongoose');
const Task = require('./models/Task');
const User = require('./models/User');
const Withdrawal = require('./models/Withdrawal');
const Web3 = require('web3');
const BigNumber = require('bignumber.js');

// Handlers
const startHandler = require('./handlers/startHandler');
const taskHandler = require('./handlers/taskHandler');
const profileHandler = require('./handlers/profileHandler');
const referralHandler = require('./handlers/referralHandler');
const { handleWithdraw, confirmWithdraw, cancelWithdraw } = require('./handlers/withdrawHandler');
const historyHandler = require('./handlers/historyHandler');
const admin = require('./admin/admin');
const { verifyCaptcha } = require('./utils/captcha');
const { formatWithUSD } = require('./utils/helpers');

// Initialize Web3 for BSC
const web3 = new Web3(new Web3.providers.HttpProvider(process.env.BSC_RPC_URL));
const USDT_CONTRACT_ABI = [
  // Minimal ABI for ERC20 transfer & balanceOf
  {
    constant: true,
    inputs: [{ name: "_owner", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "balance", type: "uint256" }],
    type: "function",
  },
  {
    constant: false,
    inputs: [
      { name: "_to", type: "address" },
      { name: "_value", type: "uint256" }
    ],
    name: "transfer",
    outputs: [{ name: "", type: "bool" }],
    type: "function"
  }
];
const usdtContract = new web3.eth.Contract(
  USDT_CONTRACT_ABI,
  process.env.USDT_CONTRACT_ADDRESS
);

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// Admin IDs
let adminIds = [];
if (process.env.ADMIN_IDS) {
  adminIds = process.env.ADMIN_IDS.split(',').map(id => id.trim());
}

// User cache
const userCache = new Map();

// Session
bot.use(session({
  defaultSession: () => ({
    verified: { channel_1: false, channel_2: false, group: false },
    profileStep: null,
    referralId: null,
    isAdmin: false,
    captchaSolved: false,
    awaitingPassword: false,
    currentTask: null,
    twitterProof: null,
    adminAction: null,
    editingTask: null,
    newTask: null,
    verificationData: null,
    lastActivity: Date.now()
  })
}));

// Cache tasks
let cachedTasks = [];
async function cacheTasks() {
  try {
    cachedTasks = await Task.find({ active: true }).lean();
    console.log(`✅ Cached ${cachedTasks.length} active tasks`);
  } catch (error) {
    console.error('❌ Task caching error:', error);
  }
}

// User middleware
bot.use(async (ctx, next) => {
  if (!ctx.from) return await next();
  const userId = ctx.from.id.toString();
  const cacheKey = `user_${userId}`;

  if (userCache.has(cacheKey)) {
    const cachedUser = userCache.get(cacheKey);
    if (Date.now() - cachedUser.timestamp < 30000) {
      ctx.user = cachedUser.data;
      return await next();
    }
  }

  // MongoDB check
  if (mongoose.connection.readyState !== 1) {
    ctx.user = { telegramId: ctx.from.id, username: ctx.from.username, balance: 0, profileCompleted: false, completedTasks: [] };
    return await next();
  }

  ctx.user = await User.findOneAndUpdate(
    { telegramId: ctx.from.id },
    { $set: { lastActive: new Date() } },
    { upsert: true, new: true, lean: true }
  );
  userCache.set(cacheKey, { data: ctx.user, timestamp: Date.now() });
  await next();
});

// BSC Wallet validation
function isValidBSCAddress(address) {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

// Profile step for wallet
bot.on('text', async (ctx, next) => {
  try {
    if (ctx.session.profileStep === 'wallet') {
      const walletAddress = ctx.message.text.trim();
      if (!isValidBSCAddress(walletAddress)) {
        return await ctx.reply(
          '⚠️ Enter a valid BSC/USDT wallet (0x...)\nExample: 0x742d35Cc6634C893292Ce8bB6239C002Ad8e6b59'
        );
      }
      ctx.user.walletAddress = walletAddress;
      ctx.user.profileCompleted = true;
      await User.findByIdAndUpdate(ctx.user._id, { walletAddress, profileCompleted: true });
      delete ctx.session.profileStep;
      await ctx.reply('✅ Wallet saved successfully!');
      return await startHandler.showMainMenu(ctx);
    }
    await next();
  } catch (err) {
    console.error('Wallet text handler error:', err);
    await ctx.reply('❌ Error processing wallet.');
  }
});

// Withdraw handler (BEP20)
async function sendUSDT(toAddress, amount) {
  const fromAddress = web3.eth.accounts.privateKeyToAccount(process.env.USDT_WALLET_PRIVATE_KEY).address;
  const decimals = 18; // USDT decimals on BSC (usually 18)
  const value = new BigNumber(amount).multipliedBy(new BigNumber(10).pow(decimals)).toString();

  const tx = {
    from: fromAddress,
    to: process.env.USDT_CONTRACT_ADDRESS,
    data: usdtContract.methods.transfer(toAddress, value).encodeABI(),
    gas: 100000
  };

  const signedTx = await web3.eth.accounts.signTransaction(tx, process.env.USDT_WALLET_PRIVATE_KEY);
  const receipt = await web3.eth.sendSignedTransaction(signedTx.rawTransaction);
  return receipt.transactionHash;
}

// Withdraw command
bot.command('withdraw', async (ctx) => {
  if (!ctx.user.profileCompleted || !ctx.user.walletAddress) {
    ctx.session.profileStep = 'wallet';
    return ctx.reply('⚠️ Please set your BSC/USDT wallet first:');
  }

  try {
    const balance = ctx.user.balance;
    if (balance < process.env.MIN_WITHDRAW) return ctx.reply(`❌ Minimum withdraw: ${process.env.MIN_WITHDRAW} MCJ`);

    // Send USDT
    const txHash = await sendUSDT(ctx.user.walletAddress, balance);
    
    await User.findByIdAndUpdate(ctx.user._id, { balance: 0 });
    await ctx.reply(`✅ Withdrawal successful!\nTX: ${txHash}`);
  } catch (err) {
    console.error('Withdraw error:', err);
    await ctx.reply('❌ Withdrawal failed. Please try again later.');
  }
});

// Start / Menu / Handlers (remain unchanged)
bot.command('start', startHandler.handleStart);
bot.hears('💰 Balance', async (ctx) => {
  await ctx.reply(`💰 Balance: ${ctx.user.balance} ${process.env.CURRENCY_NAME}`);
});
bot.hears('📋 Tasks', async (ctx) => {
  await taskHandler.showTasks(ctx, cachedTasks);
});
bot.hears('👤 Profile', async (ctx) => await profileHandler.showProfile(ctx));
bot.hears('📢 Referral', async (ctx) => await referralHandler.showReferral(ctx));
bot.hears('📜 History', async (ctx) => await historyHandler.showHistory(ctx));

// Connect to MongoDB
async function connectToMongoDB() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB');
    await cacheTasks();
    setInterval(cacheTasks, 5 * 60 * 1000);
  } catch (err) {
    console.error('❌ MongoDB connection error:', err);
    process.exit(1);
  }
}

// Start bot
async function startBot() {
  await connectToMongoDB();
  await bot.launch();
  console.log('🤖 Bot started');
}

// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// Start application
startBot();
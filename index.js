require('dotenv').config();

const { Telegraf, Markup, session } = require('telegraf');
const mongoose = require('mongoose');
const Web3 = require('web3');
const BigNumber = require('bignumber.js');

// Models
const Task = require('./models/Task');
const User = require('./models/User');
const Withdrawal = require('./models/Withdrawal');

// Handlers
const startHandler = require('./handlers/startHandler');
const taskHandler = require('./handlers/taskHandler');
const profileHandler = require('./handlers/profileHandler');
const referralHandler = require('./handlers/referralHandler');
const historyHandler = require('./handlers/historyHandler');

// Utils
const { formatWithUSD } = require('./utils/helpers');

// ================= WEB3 INIT =================
const web3 = new Web3(process.env.BSC_RPC_URL);

const USDT_CONTRACT_ABI = [
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

// ================= BOT INIT =================
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// ================= SESSION =================
bot.use(session({
  defaultSession: () => ({
    profileStep: null,
    lastActivity: Date.now()
  })
}));

// ================= DB CONNECT =================
async function connectToMongoDB() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ MongoDB connected');
  } catch (err) {
    console.error('❌ MongoDB error:', err);
    process.exit(1);
  }
}

// ================= USER MIDDLEWARE =================
bot.use(async (ctx, next) => {
  if (!ctx.from) return next();

  let user = await User.findOne({ telegramId: ctx.from.id });
  if (!user) {
    user = await User.create({
      telegramId: ctx.from.id,
      username: ctx.from.username,
      balance: 0,
      profileCompleted: false
    });
  }

  ctx.user = user;
  return next();
});

// ================= WALLET VALIDATION =================
function isValidBSCAddress(address) {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

// ================= WALLET INPUT =================
bot.on('text', async (ctx, next) => {
  if (ctx.session.profileStep === 'wallet') {
    const wallet = ctx.message.text.trim();

    if (!isValidBSCAddress(wallet)) {
      return ctx.reply('❌ Invalid BSC wallet\nExample: 0x...');
    }

    await User.findByIdAndUpdate(ctx.user._id, {
      walletAddress: wallet,
      profileCompleted: true
    });

    ctx.session.profileStep = null;
    return ctx.reply('✅ Wallet saved successfully');
  }

  return next();
});

// ================= SEND USDT =================
async function sendUSDT(to, amount) {
  const account = web3.eth.accounts.privateKeyToAccount(
    process.env.USDT_WALLET_PRIVATE_KEY
  );

  const decimals = 18;
  const value = new BigNumber(amount)
    .multipliedBy(new BigNumber(10).pow(decimals))
    .toString();

  const tx = {
    from: account.address,
    to: process.env.USDT_CONTRACT_ADDRESS,
    gas: 100000,
    data: usdtContract.methods.transfer(to, value).encodeABI()
  };

  const signed = await account.signTransaction(tx);
  const receipt = await web3.eth.sendSignedTransaction(signed.rawTransaction);

  return receipt.transactionHash;
}

// ================= COMMANDS =================
bot.command('start', startHandler.handleStart);

bot.command('withdraw', async (ctx) => {
  if (!ctx.user.profileCompleted || !ctx.user.walletAddress) {
    ctx.session.profileStep = 'wallet';
    return ctx.reply('⚠️ Enter your BSC wallet address:');
  }

  if (ctx.user.balance < Number(process.env.MIN_WITHDRAW)) {
    return ctx.reply(`❌ Minimum withdraw ${process.env.MIN_WITHDRAW}`);
  }

  try {
    const tx = await sendUSDT(ctx.user.walletAddress, ctx.user.balance);
    await User.findByIdAndUpdate(ctx.user._id, { balance: 0 });

    await ctx.reply(`✅ Withdraw successful\nTX:\n${tx}`);
  } catch (err) {
    console.error(err);
    ctx.reply('❌ Withdraw failed');
  }
});

bot.hears('💰 Balance', async (ctx) => {
  ctx.reply(`💰 Balance: ${ctx.user.balance}`);
});

bot.hears('📋 Tasks', (ctx) => taskHandler.showTasks(ctx));
bot.hears('👤 Profile', (ctx) => profileHandler.showProfile(ctx));
bot.hears('📢 Referral', (ctx) => referralHandler.showReferral(ctx));
bot.hears('📜 History', (ctx) => historyHandler.showHistory(ctx));

// ================= START BOT =================
(async () => {
  await connectToMongoDB();
  await bot.launch();
  console.log('🤖 Bot started');
})();

process.once('SIGINT', () => bot.stop());
process.once('SIGTERM', () => bot.stop());
